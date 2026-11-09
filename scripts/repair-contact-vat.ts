#!/usr/bin/env bun
/**
 * Give a branch contact the VAT number the filed sales register names it by, where it holds none or a
 * malformed one, and VIES confirms it. See `scripts/lib/contact-vat.ts` for exactly what it changes.
 *
 *   bun scripts/repair-contact-vat.ts --books regal-acc --period 202608,202609
 *       the dry run: how many filed rows differ in partner, how many contacts it would change, and why the
 *       rest are left alone. Counts only. It asks VIES about each number it would set.
 *   bun scripts/repair-contact-vat.ts --books regal-acc --period 202608,202609 --execute --expect <contacts> \
 *       [--backup <file.ndjson>] [--reason "<text>"]
 *
 * It refuses to write without `--expect` equal to the dry run's count, and on any node that is not the
 * books org's or a branch's home (FR-20, P0b-6). Before the first write every contact it will touch goes to
 * an NDJSON backup. Each write is conditional on the VAT number the plan read, and each is read back. The
 * audit row is the branch's, under its owner.
 */
import { appendFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { Contact, Org } from '../packages/db/src/models/index.js'
import { assertScriptHome } from './lib/home-guard.js'
import { applyContactVatFromRegister, planContactVatFromRegister } from './lib/contact-vat.js'

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
const booksSlug = args.books ? String(args.books) : ''
const periods = String(args.period || '').split(',').map(p => p.trim()).filter(Boolean)
const execute = !!args.execute
const reason = String(args.reason || 'the VAT number the filed sales register names this contact by, confirmed by VIES; scripts/repair-contact-vat.ts')

if (!booksSlug || !periods.length) { console.error('Required: --books <slug> --period <YYYYMM>[,<YYYYMM>]. See the header.'); process.exit(2) }

// Documents only: building indexes is the app's (scripts/lib/require-indexes.ts).
await connectDB({ readOnly: true })
try {
  const books: any = await Org.findOne({ slug: booksSlug }).lean()
  if (!books) { console.error(`Org "${booksSlug}" not found`); process.exit(1) }
  await assertScriptHome(books._id, booksSlug)
  console.log(`Books ${booksSlug}, ${periods.join(' + ')} — ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)

  const { plans, counts } = await planContactVatFromRegister(books._id, periods)
  for (const [k, n] of Object.entries(counts).sort(([a], [b]) => a.localeCompare(b))) console.log(`${String(n).padStart(6)}  ${k}`)
  console.log(`${String(plans.length).padStart(6)}  contacts to give their VAT number`)

  if (!execute) {
    console.log(`\nDry-run — nothing written. Re-run with --execute --expect ${plans.length}.`)
  } else {
    if (Number(args.expect) !== plans.length) {
      console.error(`Refused: --expect must be ${plans.length} (the dry run's count).`)
      process.exit(2)
    }
    const owners = new Map<string, string>()
    for (const orgId of new Set(plans.map(p => p.orgId))) {
      const org: any = await Org.findOne({ _id: orgId }).select('slug ownerId').lean()
      await assertScriptHome(org._id, org.slug)
      if (!org.ownerId) { console.error(`Refused: ${org.slug} has no owner to record the change under.`); process.exit(2) }
      owners.set(orgId, String(org.ownerId))
    }
    const backup = String(args.backup || join(tmpdir(), `repair-contact-vat-${booksSlug}-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`))
    writeFileSync(backup, `${JSON.stringify({ kind: 'header', script: 'repair-contact-vat', books: booksSlug, periods, at: new Date(), reason })}\n`)
    for (const p of plans) appendFileSync(backup, `${JSON.stringify({ collection: 'contacts', doc: await Contact.findById(p.id).lean().exec() })}\n`)
    console.log(`\nBackup: ${backup}`)

    let done = 0, failed = 0
    for (const p of plans) {
      const wrote = await applyContactVatFromRegister(p, owners.get(p.orgId), reason)
      const after: any = await Contact.findById(p.id).select('vatNumber').lean().exec()
      if (wrote && after?.vatNumber === p.vatNumber) done++
      else { failed++; console.log(`✗ FAILED contact ${p.id}: ${wrote ? 'written, but reads back otherwise' : 'changed since the plan, left alone'}`) }
    }
    console.log(`\nContacts given their VAT number: ${done} of ${plans.length} | failed: ${failed}`)
    if (failed) process.exitCode = 1
  }
} finally {
  await disconnectDB()
}
