/**
 * FR-25 §5's gate: what was imported against what PlusMinus itself prints, cell by cell. It prints
 * "equal", or how many cells differ and on which accounts, and never an amount or a partner, so its
 * output can go in a public PR. Exits 1 when anything differs.
 *
 * With the books split over a group (FR-25 R7) the legal entity's ledger is the SUM of its orgs: name
 * every org of the group with a repeated --org. Each is read through its own routes and the reads are
 * added up here (`compare.ts#sumTrialBalances`…), balances as nets, so no request reads across orgs.
 *
 * Usage:
 *   bun run scripts/compare-accounting-books.ts --org <slug> \
 *     --trial-balance <trialBalance_….xlsx> --main-book <mainbook_….xlsx> --journal <journalReport_….xlsx>
 *   bun run scripts/compare-accounting-books.ts --org <home slug> --org <store slug> --trial-balance …
 *
 * Options:
 *   --org <slug>            (required, repeat for a split) the books org, or every org of the split
 *   --api <url>             API base (default: https://lgrai.app)
 *   --trial-balance <file>  a trial balance, synthetic or analytic, period as exported (repeat)
 *   --main-book <file>      a main book (repeat)
 *   --journal <file>        a journal export: its own turnovers, per account and per analytic, for a
 *                           period PlusMinus printed no trial balance of (repeat)
 *
 * Credentials (env): LGR_TOKEN (one org only: a token names one), or LGR_USERNAME + LGR_PASSWORD, a
 * person or service account with a membership in every org named.
 */
import { basename } from 'node:path'
import { readSheet } from './lib/plusminus-sheet.js'
import { LgrApiError, signIn, type LgrSession } from './lib/lgr-api.js'
import {
  ExportRefused,
  assertWholeJournal,
  parseJournalExport,
  parseMainBookExport,
  parseTrialBalanceExport,
} from '../packages/services/src/biz/accounting-books/plusminus-exports.js'
import {
  compareAnalyticTrialBalance,
  compareJournalAccounts,
  compareJournalAnalytics,
  compareMainBook,
  compareTrialBalance,
  sumAnalyticTrialBalances,
  sumMainBooks,
  sumTrialBalances,
  type Verdict,
} from '../packages/services/src/biz/accounting-books/compare.js'
import type { AnalyticBalanceRow, MainBookAccount, TrialBalanceRow } from '../packages/services/src/biz/accounting-books/books-ledger.js'

interface Args {
  orgs: string[]
  api: string
  trialBalances: string[]
  mainBooks: string[]
  journals: string[]
}

function parseArgs(argv: string[]): Args {
  const o: Args = { orgs: [], api: 'https://lgrai.app', trialBalances: [], mainBooks: [], journals: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--org') o.orgs.push(argv[++i])
    else if (a === '--api') o.api = argv[++i].replace(/\/$/, '')
    else if (a === '--trial-balance') o.trialBalances.push(argv[++i])
    else if (a === '--main-book') o.mainBooks.push(argv[++i])
    else if (a === '--journal') o.journals.push(argv[++i])
    else {
      console.error(`Unknown option: ${a}`)
      process.exit(2)
    }
  }
  return o
}

const args = parseArgs(process.argv.slice(2))
if (!args.orgs.length || args.orgs.some(o => !o) || !(args.trialBalances.length + args.mainBooks.length + args.journals.length)) {
  console.error('Required: --org <slug> (repeat for a split) and at least one file. See the header.')
  process.exit(2)
}
if (new Set(args.orgs).size !== args.orgs.length) {
  console.error('An org is named twice: its share would be added twice.')
  process.exit(2)
}
if (args.orgs.length > 1 && process.env.LGR_TOKEN) {
  console.error('LGR_TOKEN names one org: for a split, sign in with LGR_USERNAME + LGR_PASSWORD.')
  process.exit(2)
}

let anyDiffers = false

function report(what: string, v: Verdict): void {
  if (!v.differingCells) {
    console.log(`${what}: ${v.rows} rows, ${v.cells} cells: equal`)
    return
  }
  anyDiffers = true
  const missing = v.missingRows ? `, ${v.missingRows} of them on one side only` : ''
  const accounts = v.accounts.length ? ` (accounts ${v.accounts.join(', ')})` : ''
  console.log(`${what}: ${v.rows} rows, ${v.cells} cells: ${v.differingCells} cells differ, on ${v.differingRows} rows${missing}${accounts}`)
}

/** Amounts are compared in one currency, or the verdict is noise. */
function assertCurrency(file: string, said: string | undefined, books: string): void {
  if (said && said !== books) throw new ExportRefused('wrong_currency', `${basename(file)} is in ${said}, and the books of its period read in ${books}: export it in ${books}.`)
}

const query = (p: { from: string; to: string }, root?: string) =>
  `?from=${p.from}&to=${p.to}${root ? `&root=${encodeURIComponent(root)}` : ''}`

/**
 * The legal entity's answer to a read: one org's as it is, or every org's of a split, added up. The
 * orgs of one ledger read a period in one currency (a share reads from the home's opening, as the home
 * does); orgs that do not are not one ledger, and nothing is compared.
 */
async function readBooks<T>(sessions: LgrSession[], path: string, rowsOf: (answer: any) => T[], sum: (parts: T[][]) => T[]): Promise<{ currency: string; rows: T[] }> {
  const answers: any[] = []
  for (const session of sessions) answers.push(await session.get(path))
  const currencies = [...new Set(answers.map(a => a.currency))]
  if (currencies.length > 1) throw new ExportRefused('currency_differs', `The orgs read ${path.split('?')[0]} in ${currencies.join(' and ')}: their books are not one ledger.`)
  return { currency: currencies[0], rows: answers.length === 1 ? rowsOf(answers[0]) : sum(answers.map(rowsOf)) }
}

const trialBalanceOf = (sessions: LgrSession[], q: string) =>
  readBooks<TrialBalanceRow>(sessions, `/accounting/books/trial-balance${q}`, a => a.rows, sumTrialBalances)
const analyticTrialBalanceOf = (sessions: LgrSession[], q: string) =>
  readBooks<AnalyticBalanceRow>(sessions, `/accounting/books/analytic-trial-balance${q}`, a => a.rows, sumAnalyticTrialBalances)
const mainBookOf = (sessions: LgrSession[], q: string) =>
  readBooks<MainBookAccount>(sessions, `/accounting/books/main-book${q}`, a => a.accounts, sumMainBooks)

async function compareTrialBalanceFile(sessions: LgrSession[], file: string): Promise<void> {
  const tb = parseTrialBalanceExport(await readSheet(file))
  if (tb.filters.length) throw new ExportRefused('filtered_export', `${basename(file)} is filtered.`)
  const label = `${basename(file)} ${tb.period.from}..${tb.period.to}`
  if (tb.kind === 'synthetic') {
    const books = await trialBalanceOf(sessions, query(tb.period))
    assertCurrency(file, tb.currency, books.currency)
    report(`${label} trial balance`, compareTrialBalance(tb.rows, books.rows))
  } else {
    const books = await analyticTrialBalanceOf(sessions, query(tb.period, tb.root))
    assertCurrency(file, tb.currency, books.currency)
    report(`${label} analytic trial balance, ${tb.root ?? 'all roots'}`, compareAnalyticTrialBalance(tb.rows, books.rows, { quantities: tb.quantities }))
  }
}

async function compareMainBookFile(sessions: LgrSession[], file: string): Promise<void> {
  const book = parseMainBookExport(await readSheet(file))
  if (book.filters.length) throw new ExportRefused('filtered_export', `${basename(file)} is filtered.`)
  const ours = await mainBookOf(sessions, query(book.period))
  assertCurrency(file, book.currency, ours.currency)
  report(`${basename(file)} ${book.period.from}..${book.period.to} main book`, compareMainBook(book.accounts, ours.rows))
}

async function compareJournalFile(sessions: LgrSession[], file: string): Promise<void> {
  const journal = parseJournalExport(await readSheet(file))
  assertWholeJournal(journal)
  const label = `${basename(file)} ${journal.period.from}..${journal.period.to}`
  const accounts = await trialBalanceOf(sessions, query(journal.period))
  const analytics = await analyticTrialBalanceOf(sessions, query(journal.period))
  assertCurrency(file, journal.currency, accounts.currency)
  report(`${label} turnovers per account`, compareJournalAccounts(journal, accounts.rows))
  report(`${label} turnovers per analytic`, compareJournalAnalytics(journal, analytics.rows))
}

try {
  const sessions: LgrSession[] = []
  for (const org of args.orgs) sessions.push(await signIn(args.api, org))
  if (sessions.length > 1) console.log(`The books of ${args.orgs.join(' + ')}, added up: one legal entity's ledger.`)
  for (const file of args.trialBalances) await compareTrialBalanceFile(sessions, file)
  for (const file of args.mainBooks) await compareMainBookFile(sessions, file)
  for (const file of args.journals) await compareJournalFile(sessions, file)
} catch (e) {
  if (e instanceof ExportRefused || e instanceof LgrApiError) {
    console.error(e.message)
    process.exit(2)
  }
  throw e
}
process.exit(anyDiffers ? 1 : 0)
