/**
 * FR-25 §5: a company's books from PlusMinus's exports into its books org, as booked. Reads the files
 * here and sends them to the API a month at a time, in order: chart, analytics, opening, journal,
 * finish. Each step prints what it would change, and writes only with `--execute`.
 *
 * ⚠ Exports are refused rather than guessed at (`services/biz/accounting-books/plusminus-exports.ts`):
 * a filtered journal looks like a whole one, and a re-import replaces whole months.
 *
 * ⚠ Prove a re-import with a dry rerun, never a live one: `unchanged` equal to `entries` is the proof.
 *
 * Usage:
 *   bun run scripts/import-accounting-books.ts --org <slug> --chart <chartOfAccounts.xlsx>                  # dry run
 *   bun run scripts/import-accounting-books.ts --org <slug> \
 *     --chart <chartOfAccounts.xlsx> --analytics <ap_СТОКИ_….json> --analytics <ap_КЛИЕНТИ_….json> \
 *     --opening <chartOfAccounts.xlsx> --opening-analytics <trialBalance_….xlsx>=304 \
 *     --journal <journalReport_….xlsx> --finish --execute
 *
 * Options:
 *   --org <slug>                 (required) the books org
 *   --api <url>                  API base (default: https://lgrai.app)
 *   --chart <file>               the chart
 *   --analytics <file>           an `ap_*.json` (repeat). `ap_ПЕРСОНАЛ` is refused
 *   --opening <file>             the year's opening balances: a chart, or a synthetic trial balance
 *   --opening-analytics <f>=<a>  an analytic trial balance, and the account its rows are on (repeat)
 *   --journal <file>             a journal export (repeat). Whole, in one currency
 *   --finish                     rebuild `Account.balance` at the end
 *   --execute                    write (default: dry run)
 *
 * Credentials (env): LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD.
 */
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { readSheet } from './lib/plusminus-sheet.js'
import { LgrApiError, signIn, type LgrSession } from './lib/lgr-api.js'
import {
  ExportRefused,
  assertWholeJournal,
  documentsByMonth,
  parseAnalyticsFile,
  parseChartExport,
  parseJournalExport,
  parseTrialBalanceExport,
  type AnalyticItem,
} from '../packages/services/src/biz/accounting-books/plusminus-exports.js'
import { monthsBetween } from '../packages/services/src/biz/accounting-books/registry.js'
import type { OpeningAnalyticLine, OpeningLine } from '../packages/services/src/biz/accounting-books/import.types.js'

interface Args {
  org?: string
  api: string
  chart?: string
  analytics: string[]
  opening?: string
  openingAnalytics: { file: string; account: string }[]
  journals: string[]
  finish: boolean
  execute: boolean
}

function parseArgs(argv: string[]): Args {
  const o: Args = { api: 'https://lgrai.app', analytics: [], openingAnalytics: [], journals: [], finish: false, execute: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--org') o.org = argv[++i]
    else if (a === '--api') o.api = argv[++i].replace(/\/$/, '')
    else if (a === '--chart') o.chart = argv[++i]
    else if (a === '--analytics') o.analytics.push(argv[++i])
    else if (a === '--opening') o.opening = argv[++i]
    else if (a === '--opening-analytics') {
      const value = String(argv[++i] ?? '')
      const at = value.lastIndexOf('=')
      if (at < 0) fail('--opening-analytics takes <file>=<account>.')
      o.openingAnalytics.push({ file: value.slice(0, at), account: value.slice(at + 1) })
    } else if (a === '--journal') o.journals.push(argv[++i])
    else if (a === '--finish') o.finish = true
    else if (a === '--execute') o.execute = true
    else if (a === '--dry-run') o.execute = false
    else fail(`Unknown option: ${a}`)
  }
  return o
}

function fail(message: string): never {
  console.error(message)
  process.exit(2)
}

const args = parseArgs(process.argv.slice(2))
if (!args.org) fail('Required: --org <slug>. See the header.')
const dryRun = !args.execute

/** Every file says whose it is, and they must agree before the server is asked. */
let eik: string | undefined
function noteEik(file: string, found: string | undefined): string {
  if (!found) fail(`${basename(file)} does not say whose books it is (ЕИК).`)
  if (eik && eik !== found) fail(`${basename(file)} is another company's than the files before it.`)
  eik = found
  return found
}

/** An `ap_*.json` holds no ЕИК of its own: it is in the file's name. */
const eikOfAnalyticsFile = (file: string) => /_(\d{9,13})\.json$/.exec(basename(file))?.[1]

function show(step: string, answer: any): void {
  const { dryRun: _dry, byDocType: _types, junk, ...rest } = answer
  console.log(`${step}: ${JSON.stringify(rest)}`)
  if (junk?.length) console.log(`  dropped from the chart: ${junk.map((j: any) => `${j.code} (${j.reason})`).join(', ')}`)
}

async function importChart(session: LgrSession): Promise<void> {
  const chart = parseChartExport(await readSheet(args.chart!))
  show('chart', await session.post('/accounting/import/chart', {
    eik: noteEik(args.chart!, chart.eik),
    dryRun,
    accounts: chart.rows.map(r => ({ code: r.code, name: r.name })),
  }))
}

async function importAnalytics(session: LgrSession): Promise<void> {
  const items: AnalyticItem[] = []
  for (const file of args.analytics) {
    noteEik(file, eikOfAnalyticsFile(file))
    items.push(...parseAnalyticsFile(readFileSync(file)))
  }
  show('analytics', await session.post('/accounting/import/analytics', { eik, dryRun, items }))
}

const yearOfOpening = (from: string) => {
  if (!from.endsWith('-01-01')) fail('An opening is read from a period that starts on 1 January.')
  return Number(from.slice(0, 4))
}

async function importOpening(session: LgrSession): Promise<void> {
  const matrix = await readSheet(args.opening!)
  let year: number
  let accounts: OpeningLine[]
  try {
    const chart = parseChartExport(matrix)
    noteEik(args.opening!, chart.eik)
    // Turnovers carried into the year: none in any chart seen, and no entry here could hold them.
    if (chart.rows.some(r => r.openingTurnoverDebit || r.openingTurnoverCredit)) fail(`${basename(args.opening!)} carries opening turnovers: this import books balances only.`)
    year = chart.year
    accounts = chart.rows.map(r => ({ code: r.code, debit: r.openingDebit, credit: r.openingCredit }))
  } catch (e) {
    if (!(e instanceof ExportRefused)) throw e
    const tb = parseTrialBalanceExport(matrix)
    if (tb.kind !== 'synthetic') fail('--opening takes a chart or a synthetic trial balance.')
    noteEik(args.opening!, tb.eik)
    year = yearOfOpening(tb.period.from)
    accounts = tb.rows.map(r => ({ code: r.code, debit: r.openingDebit, credit: r.openingCredit }))
  }

  const analytics: OpeningAnalyticLine[] = []
  for (const { file, account } of args.openingAnalytics) {
    const tb = parseTrialBalanceExport(await readSheet(file))
    if (tb.kind !== 'analytic') fail(`${basename(file)} is not an analytic trial balance.`)
    noteEik(file, tb.eik)
    if (yearOfOpening(tb.period.from) !== year) fail(`${basename(file)} is of another year than the opening.`)
    for (const r of tb.rows) {
      if (!r.openingDebit && !r.openingCredit && !r.openingQuantity) continue
      analytics.push({ code: account, path: r.path, debit: r.openingDebit, credit: r.openingCredit, ...(r.openingQuantity ? { quantity: r.openingQuantity } : {}) })
    }
  }

  show(`opening ${year}`, await session.post('/accounting/import/opening', {
    eik,
    dryRun,
    year,
    accounts: accounts.filter(a => a.debit || a.credit),
    ...(analytics.length ? { analytics } : {}),
  }))
}

async function importJournal(session: LgrSession, file: string): Promise<void> {
  const journal = parseJournalExport(await readSheet(file))
  assertWholeJournal(journal)
  noteEik(file, journal.eik)
  console.log(`${basename(file)}: ${journal.counts.documents} documents, ${journal.counts.operations} operations, ${journal.period.from} to ${journal.period.to}`)
  for (const w of journal.withoutHeader) {
    console.log(`  ${w.at}: ${w.docType} ${w.docNumber} of ${w.date} is an operation with no document in PlusMinus. Imported as a document of its own; ask the accountant.`)
  }

  const byMonth = documentsByMonth(journal.documents)
  const totals = { entries: 0, operations: 0, balanced: 0, new: 0, changed: 0, gone: 0, unchanged: 0, settles: 0 }
  // Every month of the period, the empty ones too: an empty month in the file empties it in the books.
  for (const month of monthsBetween(journal.period.from, journal.period.to)) {
    const answer = await session.post('/accounting/import/journal', {
      eik,
      dryRun,
      month,
      coverage: journal.period,
      documents: byMonth.get(month) ?? [],
    })
    show(`journal ${month}`, answer)
    for (const key of Object.keys(totals) as (keyof typeof totals)[]) totals[key] += answer[key] ?? 0
    if (answer.unknownDocTypes?.length) console.log(`  document types the registry does not know: ${JSON.stringify(answer.unknownDocTypes)}`)
  }
  console.log(`journal total: ${JSON.stringify(totals)}`)
  if (totals.balanced !== totals.entries) fail(`${totals.entries - totals.balanced} entries do not balance.`)
}

try {
  const session = await signIn(args.api, args.org!)
  console.log(dryRun ? 'Dry run: nothing is written. Add --execute.' : 'Writing.')
  if (args.chart) await importChart(session)
  if (args.analytics.length) await importAnalytics(session)
  if (args.opening) await importOpening(session)
  for (const file of args.journals) await importJournal(session, file)
  if (args.finish) {
    if (!eik) fail('--finish needs a file that says whose books they are, in the same run.')
    show('finish', await session.post('/accounting/import/finish', { eik, dryRun }))
  }
} catch (e) {
  if (e instanceof ExportRefused) fail(`Refused (${e.code}): ${e.message}`)
  if (e instanceof LgrApiError) fail(e.message)
  throw e
}
