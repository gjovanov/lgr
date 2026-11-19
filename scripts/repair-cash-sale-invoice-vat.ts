#!/usr/bin/env bun
/**
 * FR-25 R3: give an invoice issued for a cash sale the VAT and sum due it PRINTS, where the import took the sum of its
 * lines' rounded VAT (#485), and move its mirrored till payment with the total. The rules, and what is left alone, are
 * `scripts/lib/cash-sale-invoice-vat.ts`.
 *
 *   bun scripts/repair-cash-sale-invoice-vat.ts --org <slug>
 *       the dry run. Counts only, no names, numbers or amounts: the committed invoice PDFs, how many invoices it would
 *       repair, and why the rest are left alone.
 *   bun scripts/repair-cash-sale-invoice-vat.ts --org <slug> --execute --expect <invoices> [--out <dir>]
 *       writes. Refused unless `--expect` is the dry run's count. Before the first write it writes a manifest into
 *       `--out` (default: <temp>/repair-cash-sale-invoice-vat/, outside the checkout): every invoice, its figures before
 *       and after. It holds document numbers and amounts: keep it private, and delete it once the run is accepted.
 *   bun scripts/repair-cash-sale-invoice-vat.ts --org <slug> --undo <manifest> [--execute]
 *       takes a run back where nothing changed since: an invoice that still reads as the run left it gets its figures
 *       back. A dry run without `--execute`.
 *
 * It writes only on the org's home (FR-20, P0b-6), connects without building indexes (#546), refuses to write without
 * the unique indexes of what it writes, and leaves one audit row a run, the script's own. Idempotent: a second run finds
 * nothing to repair. It never writes a journal entry, a VAT register row or a tax return.
 */
import { readFileSync } from 'node:fs'
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { AuditLog, Invoice } from '../packages/db/src/models/index.js'
import { assertScriptHome } from './lib/home-guard.js'
import { requireUniqueIndexes } from './lib/require-indexes.js'
import { RepairError, orgBySlug, parseArgs, writeManifest } from './lib/repair-run.js'
import { applyCashSaleVat, manifestOf, parseManifest, planCashSaleVat, undoCashSaleVat } from './lib/cash-sale-invoice-vat.js'

const args = parseArgs(process.argv.slice(2))
const slug = typeof args.org === 'string' ? args.org : ''
const execute = !!args.execute
const undoFile = typeof args.undo === 'string' ? args.undo : ''
const row = (n: number, label: string) => console.log(`${String(n).padStart(7)}  ${label}`)

if (!slug || args.undo === true || args.out === true || args.expect === true) {
  console.error('Required: --org <slug>. --undo names its manifest, --out a folder, --expect the dry run\'s invoices. See the header.')
  process.exit(2)
}

async function repair(org: { id: string }): Promise<number> {
  const survey = await planCashSaleVat(org.id)
  console.log(`Org ${slug} — ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)
  for (const [k, n] of Object.entries(survey.counts).sort(([a], [b]) => a.localeCompare(b))) row(n, k)
  const n = survey.plans.length

  if (!execute) {
    console.log(`\nDry run — nothing written. Re-run with --execute --expect ${n}.`)
    return 0
  }
  if (args.expect === undefined || Number(args.expect) !== n) {
    console.error(`\nRefused: --expect must be ${n} (the dry run's invoices). Nothing was written.`)
    return 2
  }
  if (!n) {
    console.log('\nNothing to repair.')
    return 0
  }
  const file = writeManifest(manifestOf(survey, slug), typeof args.out === 'string' ? args.out : undefined)
  console.log(`\nManifest (holds document numbers and amounts: keep it private): ${file}`)

  const result = await applyCashSaleVat(survey)
  for (const f of result.failed) console.log(`✗ ${f}`)
  console.log(`\nRepaired: ${result.repaired} of ${n} invoices`)
  return result.failed.length ? 1 : 0
}

async function undo(org: { id: string }): Promise<number> {
  const manifest = parseManifest(readFileSync(undoFile, 'utf8'), org.id)
  console.log(`Org ${slug}, undo of the run of ${manifest.at} — ${execute ? 'EXECUTE' : 'DRY-RUN'}\n`)
  const n = await undoCashSaleVat(manifest, execute)
  row(n.invoices, 'invoices in the manifest')
  row(n.back, execute ? 'given their figures back' : 'to give their figures back')
  row(n.changed, 'changed since the run; left alone')
  if (!execute) console.log('\nDry run — nothing written. Re-run with --undo <the same manifest> --execute.')
  return 0
}

await connectDB({ readOnly: true })
let code = 1
try {
  const org = await orgBySlug(slug)
  await assertScriptHome(org.id, slug)
  // Documents only: building indexes is the app's (scripts/lib/require-indexes.ts).
  if (execute) await requireUniqueIndexes([Invoice, AuditLog])
  code = undoFile ? await undo(org) : await repair(org)
} catch (e) {
  if (!(e instanceof RepairError)) throw e
  console.error(`Refused (${e.code}): ${e.message}`)
  code = 2
} finally {
  await disconnectDB()
}
process.exit(code)
