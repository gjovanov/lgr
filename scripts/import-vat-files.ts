/**
 * FR-25 R2: the filed VAT months, into an org, as filed.
 *
 *   bun run scripts/import-vat-files.ts --org <slug> --dir <nap/vat dir>             # dry run
 *   bun run scripts/import-vat-files.ts --org <slug> --dir <nap/vat dir> --execute
 *
 * Reads `<dir>/<yyyymm>/<eik>/{DEKLAR,PRODAGBI,POKUPKI,VIES}.txt`, and stores each month as a `filed`
 * `TaxReturn` with its rows frozen. Dry run by default, and it proves everything before it writes
 * anything:
 *   - every month regenerates byte for byte (the gate, `compare-vat-files.ts`), or nothing is written;
 *   - every month names this org's VAT or tax number, or nothing is written. The accountant's PC holds
 *     other companies' books.
 *
 * Idempotent per period: a month whose files are unchanged is left alone, and one that differs, a
 * re-filing, replaces that month's rows in one transaction. A month filed from LGR is never replaced.
 *
 * ⚠ Prints months and counts, never an amount, a partner or a document number. The files stay
 * where they are: a month's bytes come back from its rows (`vat-return.service.ts`).
 *
 * Connects with `autoIndex: false, autoCreate: false`, so a dry run from a branch builds nothing on
 * prod. `--execute` requires the indexes that make it safe, which only the deployed app builds. Deploy
 * first, then `bun run migrate`, then this.
 */
import { config } from '../packages/config/src/index.js'
import { disconnectDB, mongoose } from '../packages/db/src/connection.js'
import { Org, TaxReturn, VatRegisterEntry } from '../packages/db/src/models/index.js'
import { VatFileError } from '../packages/services/src/biz/vat-files/codec.js'
import {
  VatReturnRefused, applyVatImport, planVatImport, type VatImportPlan,
} from '../packages/services/src/biz/vat-files/vat-return.service.js'
import { assertScriptHome } from './lib/home-guard.js'
import { readVatDir } from './lib/vat-dir.js'

const args = process.argv.slice(2)
const value = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined)
const EXECUTE = args.includes('--execute')
const SLUG = value('--org')
const DIR = value('--dir')

async function requireUniqueIndexes() {
  const names = async (c: { indexes(): Promise<any[]> }) =>
    (await c.indexes().catch(() => [])).filter(i => i.unique).map(i => String(i.name))
  const missing = [
    !(await names(VatRegisterEntry.collection)).includes('vat_row_frozen_unique') && 'vatregisterentries {orgId, ledger, period, side, rowNo}',
    !(await names(TaxReturn.collection)).includes('tax_return_period_unique') && 'taxreturns {orgId, kind, periodCode, supersedesId}',
  ].filter(Boolean)
  if (missing.length) {
    throw new Error(`refusing to write: unique index missing (${missing.join('; ')}). Deploy the release that carries these models first; the app builds them when it starts.`)
  }
}

async function main() {
  if (!SLUG || !DIR) {
    console.error('Usage: bun run scripts/import-vat-files.ts --org <slug> --dir <nap/vat dir> [--execute]')
    process.exit(2)
  }
  const months = readVatDir(DIR)
  if (!months.length) {
    console.error('No filed months under that folder (<dir>/<yyyymm>/<eik>/DEKLAR.txt).')
    process.exit(2)
  }

  // A dry run must not write, and Mongoose does by default: leave collections and indexes to the app.
  await mongoose.connect(config.mongodb.uri, { autoIndex: false, autoCreate: false })
  const org = await Org.findOne({ slug: SLUG }).select('slug vatNumber taxNumber').lean()
  if (!org) throw new Error(`org "${SLUG}" not found`)
  await assertScriptHome(org._id, SLUG)

  const plans: VatImportPlan[] = []
  let refused = 0
  for (const month of months) {
    try {
      const plan = await planVatImport(org, month.files)
      plans.push(plan)
      console.log(`${plan.period}  ${plan.action}  sales ${plan.sales}, purchases ${plan.purchases}`)
    } catch (e) {
      refused++
      // Both kinds name a field, a record or a count, never a value. Anything else stays out of the output.
      const known = e instanceof VatReturnRefused || e instanceof VatFileError
      console.log(`${month.period}  refused: ${known ? (e as Error).message : 'unexpected error'}`)
    }
  }
  const count = (action: VatImportPlan['action']) => plans.filter(p => p.action === action).length
  console.log(`\n${months.length} months: ${count('new')} new, ${count('replace')} to replace, ${count('unchanged')} unchanged, ${refused} refused.`)
  if (refused) {
    console.log('Nothing was written.')
    return 1
  }
  if (!EXECUTE) {
    console.log('Dry run: nothing was written. --execute to write.')
    return 0
  }
  await requireUniqueIndexes()
  for (const plan of plans) {
    await applyVatImport(String(org._id), plan)
    if (plan.action !== 'unchanged') console.log(`${plan.period}  written`)
  }
  return 0
}

main()
  .then(async code => { await disconnectDB(); process.exit(code) })
  .catch(async e => {
    console.error(e instanceof Error ? e.message : 'unexpected error')
    await disconnectDB().catch(() => {})
    process.exit(1)
  })
