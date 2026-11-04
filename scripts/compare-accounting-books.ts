/**
 * FR-25 §5's gate: what was imported against what PlusMinus itself prints, cell by cell. It prints
 * "equal", or how many cells differ and on which accounts, and never an amount or a partner, so its
 * output can go in a public PR. Exits 1 when anything differs.
 *
 * Usage:
 *   bun run scripts/compare-accounting-books.ts --org <slug> \
 *     --trial-balance <trialBalance_….xlsx> --main-book <mainbook_….xlsx> --journal <journalReport_….xlsx>
 *
 * Options:
 *   --org <slug>            (required) the books org
 *   --api <url>             API base (default: https://lgrai.app)
 *   --trial-balance <file>  a trial balance, synthetic or analytic, period as exported (repeat)
 *   --main-book <file>      a main book (repeat)
 *   --journal <file>        a journal export: its own turnovers, per account and per analytic, for a
 *                           period PlusMinus printed no trial balance of (repeat)
 *
 * Credentials (env): LGR_TOKEN, or LGR_USERNAME + LGR_PASSWORD.
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
  type Verdict,
} from '../packages/services/src/biz/accounting-books/compare.js'

interface Args {
  org?: string
  api: string
  trialBalances: string[]
  mainBooks: string[]
  journals: string[]
}

function parseArgs(argv: string[]): Args {
  const o: Args = { api: 'https://lgrai.app', trialBalances: [], mainBooks: [], journals: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--org') o.org = argv[++i]
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
if (!args.org || !(args.trialBalances.length + args.mainBooks.length + args.journals.length)) {
  console.error('Required: --org <slug> and at least one file. See the header.')
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

async function compareTrialBalanceFile(session: LgrSession, file: string): Promise<void> {
  const tb = parseTrialBalanceExport(await readSheet(file))
  if (tb.filters.length) throw new ExportRefused('filtered_export', `${basename(file)} is filtered.`)
  const label = `${basename(file)} ${tb.period.from}..${tb.period.to}`
  if (tb.kind === 'synthetic') {
    const books = await session.get(`/accounting/books/trial-balance${query(tb.period)}`)
    assertCurrency(file, tb.currency, books.currency)
    report(`${label} trial balance`, compareTrialBalance(tb.rows, books.rows))
  } else {
    const books = await session.get(`/accounting/books/analytic-trial-balance${query(tb.period, tb.root)}`)
    assertCurrency(file, tb.currency, books.currency)
    report(`${label} analytic trial balance, ${tb.root ?? 'all roots'}`, compareAnalyticTrialBalance(tb.rows, books.rows, { quantities: tb.quantities }))
  }
}

async function compareMainBookFile(session: LgrSession, file: string): Promise<void> {
  const book = parseMainBookExport(await readSheet(file))
  if (book.filters.length) throw new ExportRefused('filtered_export', `${basename(file)} is filtered.`)
  const ours = await session.get(`/accounting/books/main-book${query(book.period)}`)
  assertCurrency(file, book.currency, ours.currency)
  report(`${basename(file)} ${book.period.from}..${book.period.to} main book`, compareMainBook(book.accounts, ours.accounts))
}

async function compareJournalFile(session: LgrSession, file: string): Promise<void> {
  const journal = parseJournalExport(await readSheet(file))
  assertWholeJournal(journal)
  const label = `${basename(file)} ${journal.period.from}..${journal.period.to}`
  const accounts = await session.get(`/accounting/books/trial-balance${query(journal.period)}`)
  const analytics = await session.get(`/accounting/books/analytic-trial-balance${query(journal.period)}`)
  assertCurrency(file, journal.currency, accounts.currency)
  report(`${label} turnovers per account`, compareJournalAccounts(journal, accounts.rows))
  report(`${label} turnovers per analytic`, compareJournalAnalytics(journal, analytics.rows))
}

try {
  const session = await signIn(args.api, args.org)
  for (const file of args.trialBalances) await compareTrialBalanceFile(session, file)
  for (const file of args.mainBooks) await compareMainBookFile(session, file)
  for (const file of args.journals) await compareJournalFile(session, file)
} catch (e) {
  if (e instanceof ExportRefused || e instanceof LgrApiError) {
    console.error(e.message)
    process.exit(2)
  }
  throw e
}
process.exit(anyDiffers ? 1 : 0)
