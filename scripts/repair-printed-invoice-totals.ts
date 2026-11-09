#!/usr/bin/env bun
/**
 * #485's repair: put the VAT and sum due an imported invoice PRINTS back on the invoice LGR stored, where the
 * import took the sum of its lines' rounded VAT instead, and fill the VAT number of a customer whose own
 * invoices print it. See `scripts/lib/printed-totals.ts` for exactly what each changes and what it leaves.
 *
 *   bun scripts/repair-printed-invoice-totals.ts --org regal-pz
 *       the dry run: how many committed invoice PDFs, how many invoices and contacts it would change, and why
 *       the rest are left alone. Counts only.
 *   bun scripts/repair-printed-invoice-totals.ts --org regal-pz --execute --expect <invoices> --expect-contacts <contacts> \
 *       [--backup <file.ndjson>] [--as <userId>] [--reason "<text>"]
 *
 * It refuses to write without `--expect` and `--expect-contacts` equal to the dry run's counts, and on any node
 * that is not the org's home (FR-20, P0b-6). Before the first write every document it will touch goes to an
 * NDJSON backup. Each write is conditional on what the plan read, and each result is read back.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Contact, Invoice, Org } from '../packages/db/src/models/index.js'
import { assertScriptHome } from './lib/home-guard.js'
import { applyContactVat, applyPrintedTotals, planContactVat, planPrintedTotals } from './lib/printed-totals.js'

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
const reason = String(args.reason || 'the VAT and sum due the invoice prints, in place of the sum of its lines\' rounded VAT (#485); scripts/repair-printed-invoice-totals.ts')
const cents = (v: unknown) => Math.round((Number(v) || 0) * 100)

if (!orgSlug) { console.error('Required: --org <slug>. See the header.'); process.exit(2) }

// Documents only: building indexes is the app's (scripts/lib/require-indexes.ts).
await connectDB({ readOnly: true })
try {
  const org: any = await Org.findOne({ slug: orgSlug }).lean()
  if (!org) { console.error(`Org "${orgSlug}" not found`); process.exit(1) }
  await assertScriptHome(org._id, orgSlug)
  console.log(`Org ${orgSlug} — ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)

  const { plans, counts } = await planPrintedTotals(org._id)
  for (const [k, n] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) console.log(`${String(n).padStart(6)}  ${k}`)
  const contacts = await planContactVat(org._id)
  console.log(`${String(contacts.length).padStart(6)}  contacts to give the VAT number their invoices print (${contacts.reduce((s, c) => s + c.invoices, 0)} invoices)`)

  if (!execute) {
    console.log(`\nDry-run — nothing written. Re-run with --execute --expect ${plans.length} --expect-contacts ${contacts.length}.`)
  } else {
    if (Number(args.expect) !== plans.length || Number(args['expect-contacts']) !== contacts.length) {
      console.error(`Refused: --expect must be ${plans.length} and --expect-contacts ${contacts.length} (the dry run's counts).`)
      process.exit(2)
    }
    const by = String(args.as || org.ownerId || '')
    if (!by) { console.error('Refused: no user to record the change under (--as <userId>, or an org owner).'); process.exit(2) }
    const backup = String(args.backup || join(tmpdir(), `repair-printed-totals-${orgSlug}-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`))
    writeFileSync(backup, `${JSON.stringify({ kind: 'header', script: 'repair-printed-invoice-totals', org: orgSlug, at: new Date(), reason })}\n`)
    for (const p of plans) appendFileSync(backup, `${JSON.stringify({ collection: 'invoices', doc: await Invoice.findById(p.id).lean().exec() })}\n`)
    for (const c of contacts) appendFileSync(backup, `${JSON.stringify({ collection: 'contacts', doc: await Contact.findById(c.id).lean().exec() })}\n`)
    console.log(`\nBackup: ${backup}`)

    let done = 0, failed = 0
    for (const p of plans) {
      const wrote = await applyPrintedTotals(org._id, p, by, reason)
      const after: any = await Invoice.findById(p.id).lean().exec()
      const ok = wrote && cents(after?.taxTotal) === cents(p.after.taxTotal) && cents(after?.total) === cents(p.after.total) &&
        cents(after?.amountDue) === cents(p.after.amountDue) && cents(after?.amountPaid) === cents(p.after.amountPaid) &&
        (p.category === 'unpaid' || cents(after?.payments?.[0]?.amount) === cents(p.after.payment))
      if (ok) done++
      else { failed++; console.log(`✗ FAILED ${p.invoiceNumber}: ${wrote ? 'written, but reads back otherwise' : 'changed since the plan, left alone'}`) }
    }
    let contactsDone = 0
    for (const c of contacts) {
      const wrote = await applyContactVat(org._id, c, by, reason)
      const after: any = await Contact.findById(c.id).lean().exec()
      if (wrote && after?.vatNumber === c.vatNumber) contactsDone++
      else { failed++; console.log(`✗ FAILED contact ${c.id}: ${wrote ? 'written, but reads back otherwise' : 'has a VAT number by now, left alone'}`) }
    }
    console.log(`\nInvoices repaired: ${done} of ${plans.length} | contacts given their VAT number: ${contactsDone} of ${contacts.length} | failed: ${failed}`)
    if (failed) process.exitCode = 1
  }
} finally {
  await disconnectDB()
}
