/**
 * Bring an org's earlier sales numbers to the year-less form: `INV-2026-3000004106` → `INV-3000004106`.
 *
 * An org that numbers its sales series without a year (the sequences page's "No year") issues `INV-<ten digits>`
 * from then on, the form a number brought in from another system already has. The documents it issued BEFORE the
 * choice keep the year in theirs, so its invoice list reads two ways. This run brings those along. The running
 * number never changes: only the year goes. What is changed and what is left alone:
 * packages/services/src/biz/yearless-numbers.ts.
 *
 * Usage (one org per run; dry run unless --execute):
 *   bun run scripts/drop-year-from-sales-numbers.ts --org <slug>
 *   bun run scripts/drop-year-from-sales-numbers.ts --org <slug> --execute --backup <file.ndjson>
 *   bun run scripts/drop-year-from-sales-numbers.ts --org <slug> --restore <file.ndjson>            # dry run
 *   bun run scripts/drop-year-from-sales-numbers.ts --org <slug> --restore <file.ndjson> --execute
 *
 * Options:
 *   --org <slug>       (required) the org. Its sales series must already be numbered without a year.
 *   --execute          write (default: count only)
 *   --backup <file>    (required with --execute) where the before-values go, one NDJSON line per document: _id, the
 *                      number before and after, the number history before. Must not exist yet.
 *   --restore <file>   put a backup's numbers back. A document that no longer holds the run's number keeps what it has.
 *   --list             print every number the run changes or leaves (default: a few of each)
 *
 * A second run finds nothing to change. No audit-log rows are written: each document's `numberHistory` names the
 * number it had and the one it has, and the backup file is the record of the run.
 */
import { connectDB, disconnectDB } from '../packages/db/src/connection.js'
import { assertScriptHome } from './lib/home-guard.js'
import { Org } from '../packages/db/src/models/index.js'
import { applyYearlessNumbers, planYearlessNumbers, restoreYearNumbers } from '../packages/services/src/biz/yearless-numbers.js'

function parseArgs(argv: string[]) {
  const o: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const next = argv[i + 1]
    if (next && !next.startsWith('--')) { o[a.slice(2)] = next; i++ } else { o[a.slice(2)] = true }
  }
  return o
}

const args = parseArgs(process.argv.slice(2))
const orgSlug = typeof args.org === 'string' ? args.org : ''
const execute = args.execute === true
const backupPath = typeof args.backup === 'string' ? args.backup : ''
const restorePath = typeof args.restore === 'string' ? args.restore : ''
const listAll = args.list === true

if (!orgSlug) { console.error('Required: --org <slug>. See the header for the options.'); process.exit(2) }
if (restorePath && backupPath) { console.error('--restore and --backup do not go together.'); process.exit(2) }
if (execute && !restorePath && !backupPath) { console.error('--execute needs --backup <file>: the before-values are saved before anything is written.'); process.exit(2) }

const started = Date.now()
// Documents only: building indexes is the app's (scripts/lib/require-indexes.ts).
await connectDB({ readOnly: true })
let code = 0
try {
  const org: any = await Org.findOne({ slug: orgSlug }).lean()
  if (!org) throw new Error(`org "${orgSlug}" not found`)
  await assertScriptHome(org._id, orgSlug)
  const orgId = String(org._id)

  if (restorePath) {
    console.log(`Restore | org ${orgSlug} | ${execute ? 'EXECUTE' : 'DRY RUN'} | from ${restorePath}`)
    const r = await restoreYearNumbers(orgId, restorePath, { execute })
    console.log(`  backup lines                    : ${r.lines}`)
    console.log(`  ${execute ? 'restored     ' : 'would restore'}                   : ${r.restored}`)
    console.log(`  skipped (changed since the run) : ${r.skipped}`)
  } else {
    console.log(`Sales numbers without the year | org ${orgSlug} | ${execute ? `EXECUTE, backup → ${backupPath}` : 'DRY RUN'}`)
    const plan = await planYearlessNumbers(orgId)
    const byStatus: Record<string, number> = {}
    for (const r of plan.rename) byStatus[r.status] = (byStatus[r.status] || 0) + 1
    const byReason: Record<string, number> = {}
    for (const l of plan.left) byReason[l.reason] = (byReason[l.reason] || 0) + 1
    console.log(`  ${execute ? 'to change' : 'would change'}                 : ${plan.rename.length}${plan.rename.length ? `  (${Object.entries(byStatus).map(([s, n]) => `${s} ${n}`).join(', ')})` : ''}`)
    if (plan.rename.length) console.log(`     from ${plan.rename[0].from} to ${plan.rename.at(-1)!.from}`)
    console.log(`  left as they are             : ${plan.left.length}${plan.left.length ? `  (${Object.entries(byReason).map(([s, n]) => `${s} ${n}`).join(', ')})` : ''}`)
    console.log(`  quoted in text, stays as written: ${plan.quoted.stockMovements} stock movement(s), ${plan.quoted.journalEntries} journal entr${plan.quoted.journalEntries === 1 ? 'y' : 'ies'}`)
    const show = <T>(rows: T[]) => (listAll ? rows : rows.slice(0, 5))
    for (const r of show(plan.rename)) console.log(`    ${r.from} → ${r.to}  (${r.status})`)
    if (!listAll && plan.rename.length > 5) console.log(`    … and ${plan.rename.length - 5} more (--list prints all)`)
    for (const l of show(plan.left)) console.log(`    left: ${l.number}  (${l.reason})`)
    if (!listAll && plan.left.length > 5) console.log(`    … and ${plan.left.length - 5} more left (--list prints all)`)
    if (execute) {
      const w = await applyYearlessNumbers(orgId, plan, { backupPath })
      console.log(`  written                      : ${w.written}${w.raced ? `  ⚠ ${w.raced} not written: changed by someone else meanwhile, run again` : ''}`)
    } else {
      console.log('Dry run: nothing was written. Add --execute --backup <file> to write.')
    }
  }
  console.log(`Done in ${((Date.now() - started) / 1000).toFixed(1)} s.`)
} catch (e: any) {
  console.error(`Failed: ${e?.message ?? e}`)
  code = 1
} finally {
  await disconnectDB()
}
process.exit(code)
