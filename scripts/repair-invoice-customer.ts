#!/usr/bin/env bun
/**
 * Move an outgoing invoice to the customer it prints, where LGR linked it to another contact. See
 * `scripts/lib/invoice-customer.ts` for exactly what it changes and what it leaves.
 *
 *   bun scripts/repair-invoice-customer.ts --org regal-pz [--printed <file.json>]
 *       the dry run: how many documents, how many it would move, how many contacts it would create, and why
 *       the rest are left alone. Counts only.
 *   bun scripts/repair-invoice-customer.ts --org regal-pz [--printed <file.json>] --execute --expect <invoices> \
 *       --expect-contacts <created contacts> [--backup <file.ndjson>] [--as <userId>] [--reason "<text>"]
 *
 * What an invoice prints comes from the PDF it was committed from. `--printed` adds documents whose original
 * LGR does not hold, typed into LGR from another program's invoice: a JSON list of
 * `{ invoiceNumber, customer: { name, company_id, vat_id, address, city } }`. ⚠ It names real customers: keep it
 * outside the repo.
 *
 * It refuses to write without `--expect` and `--expect-contacts` equal to the dry run's counts, and on any node
 * that is not the org's home (FR-20, P0b-6). Before the first write every invoice it will touch goes to an
 * NDJSON backup. Each write is conditional on what the plan read, and each result is read back.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Contact, Invoice, Org } from '../packages/db/src/models/index.js'
import { assertScriptHome } from './lib/home-guard.js'
import { applyInvoiceCustomer, contactsToCreate, createContact, planInvoiceCustomers, type PrintedDocument } from './lib/invoice-customer.js'

function parseArgs(argv: string[]) {
  const o: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const key = argv[i].slice(2)
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { o[key] = next; i++ } else { o[key] = true }
  }
  return o
}

const args = parseArgs(process.argv.slice(2))
const orgSlug = args.org ? String(args.org) : ''
const execute = !!args.execute
const reason = String(args.reason || 'linked to the customer the invoice prints, in place of another contact; scripts/repair-invoice-customer.ts')
const printed: PrintedDocument[] = args.printed ? JSON.parse(readFileSync(String(args.printed), 'utf8')) : []

if (!orgSlug) { console.error('Required: --org <slug>. See the header.'); process.exit(2) }

await connectDB()
try {
  const org: any = await Org.findOne({ slug: orgSlug }).lean()
  if (!org) { console.error(`Org "${orgSlug}" not found`); process.exit(1) }
  await assertScriptHome(org._id, orgSlug)
  console.log(`Org ${orgSlug} — ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)

  const { plans, counts } = await planInvoiceCustomers(org._id, printed)
  for (const [k, n] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) console.log(`${String(n).padStart(6)}  ${k}`)
  const creates = contactsToCreate(plans)
  console.log(`${String(creates.size).padStart(6)}  contacts to create`)

  if (!execute) {
    console.log(`\nDry-run — nothing written. Re-run with --execute --expect ${plans.length} --expect-contacts ${creates.size}.`)
  } else {
    if (Number(args.expect) !== plans.length || Number(args['expect-contacts']) !== creates.size) {
      console.error(`Refused: --expect must be ${plans.length} and --expect-contacts ${creates.size} (the dry run's counts).`)
      process.exit(2)
    }
    const by = String(args.as || org.ownerId || '')
    if (!by) { console.error('Refused: no user to record the change under (--as <userId>, or an org owner).'); process.exit(2) }
    const backup = String(args.backup || join(tmpdir(), `repair-invoice-customer-${orgSlug}-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`))
    writeFileSync(backup, `${JSON.stringify({ kind: 'header', script: 'repair-invoice-customer', org: orgSlug, at: new Date(), reason })}\n`)
    for (const p of plans) appendFileSync(backup, `${JSON.stringify({ collection: 'invoices', doc: await Invoice.findOne({ _id: p.id, type: { $exists: true } }).lean().exec() })}\n`)
    console.log(`\nBackup: ${backup}`)

    const created = new Map<string, string>()
    for (const [number, c] of creates) {
      const id = await createContact(org._id, c, by, reason)
      created.set(number, id)
      appendFileSync(backup, `${JSON.stringify({ collection: 'contacts', created: id })}\n`)
    }
    let done = 0, failed = 0
    for (const p of plans) {
      const targetId = 'contactId' in p.target ? p.target.contactId : created.get(p.target.create.taxId!)!
      const wrote = await applyInvoiceCustomer(org._id, p, targetId, by, reason)
      const after: any = await Invoice.findOne({ _id: p.id, type: { $exists: true } }).select('contactId billingAddress').lean().exec()
      const ok = wrote && String(after?.contactId) === targetId && after?.billingAddress?.street === p.billingAddress.street
      if (ok) done++
      else { failed++; console.log(`✗ FAILED ${p.invoiceNumber}: ${wrote ? 'written, but reads back otherwise' : 'changed since the plan, left alone'}`) }
    }
    const contactsBack = await Contact.countDocuments({ orgId: org._id, _id: { $in: [...created.values()] } })
    console.log(`\nInvoices moved: ${done} of ${plans.length} | contacts created: ${contactsBack} of ${creates.size} | failed: ${failed}`)
    if (failed || contactsBack !== creates.size) process.exitCode = 1
  }
} finally {
  await disconnectDB()
}
