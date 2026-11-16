/**
 * FR-25 §5's gate, cell by cell: what was imported against what PlusMinus itself prints for the same
 * period. Each function answers with counts and account numbers, and never with an amount or a
 * partner: the answer is what reaches a public PR.
 *
 * Import-pure: the file's parsers and the books' rows go in, a verdict comes out.
 */
import type {
  ParsedAnalyticRow,
  ParsedJournal,
  ParsedMainBookAccount,
  ParsedSyntheticRow,
  TrialBalanceCells,
} from './plusminus-exports.js'
import type { AnalyticBalanceRow, BalanceColumns, MainBookAccount, TrialBalanceRow } from './books-ledger.js'

export interface Verdict {
  rows: number
  cells: number
  differingCells: number
  differingRows: number
  /** Rows on one side only. Their cells are counted as differing. */
  missingRows: number
  /** Accounts that differ, by number. Empty for analytics: a path can name a partner. */
  accounts: string[]
}

/** Half a cent and a hair: the file rounds to the cent, and an amount can sit exactly between two. */
const MONEY_TOLERANCE = 0.0051
const QUANTITY_TOLERANCE = 0.00051

const MONEY: (keyof BalanceColumns)[] = ['openingDebit', 'openingCredit', 'turnoverDebit', 'turnoverCredit', 'closingDebit', 'closingCredit']
const QUANTITY = ['openingQuantity', 'turnoverDebitQuantity', 'turnoverCreditQuantity', 'closingQuantity'] as const

class Tally {
  readonly verdict: Verdict = { rows: 0, cells: 0, differingCells: 0, differingRows: 0, missingRows: 0, accounts: [] }

  /** A row's cells, pairwise. A row missing from one side is zero there: one that nets to nothing is no difference. */
  row(label: string | undefined, pairs: readonly (readonly [number, number, number])[], missing = false): void {
    let differs = 0
    for (const [ours, theirs, tolerance] of pairs) {
      this.verdict.cells++
      if (Math.abs(ours - theirs) > tolerance) differs++
    }
    this.verdict.rows++
    if (missing && differs) this.verdict.missingRows++
    if (!differs) return
    this.verdict.differingCells += differs
    this.verdict.differingRows++
    if (label) this.verdict.accounts.push(label)
  }
}

const moneyPairs = (ours: Partial<BalanceColumns> | undefined, theirs: Partial<TrialBalanceCells> | undefined) =>
  MONEY.map(key => [ours?.[key] ?? 0, theirs?.[key] ?? 0, MONEY_TOLERANCE] as const)

export function compareTrialBalance(file: readonly ParsedSyntheticRow[], books: readonly TrialBalanceRow[]): Verdict {
  const tally = new Tally()
  const ours = new Map(books.map(r => [r.code, r]))
  const theirs = new Map(file.map(r => [r.code, r]))
  for (const code of [...new Set([...ours.keys(), ...theirs.keys()])].sort()) {
    tally.row(code, moneyPairs(ours.get(code), theirs.get(code)), !ours.has(code) || !theirs.has(code))
  }
  return tally.verdict
}

/**
 * `quantities: false` for a file of a root kept without them (КЛИЕНТИ, ДОСТАВЧИЦИ): it states none, while
 * the books carry an operation's quantity on both of its analytics.
 */
export function compareAnalyticTrialBalance(
  file: readonly ParsedAnalyticRow[],
  books: readonly AnalyticBalanceRow[],
  { quantities = true }: { quantities?: boolean } = {},
): Verdict {
  const tally = new Tally()
  const ours = new Map(books.map(r => [r.path, r]))
  const theirs = new Map(file.map(r => [r.path, r]))
  for (const path of new Set([...ours.keys(), ...theirs.keys()])) {
    const mine = ours.get(path)
    const file = theirs.get(path)
    tally.row(undefined, [
      ...moneyPairs(mine, file),
      ...(quantities ? QUANTITY.map(key => [mine?.[key] ?? 0, file?.[key] ?? 0, QUANTITY_TOLERANCE] as const) : []),
    ], !mine || !file)
  }
  return tally.verdict
}

export function compareMainBook(file: readonly ParsedMainBookAccount[], books: readonly MainBookAccount[]): Verdict {
  const tally = new Tally()
  const ours = new Map(books.map(a => [a.code, a]))
  const theirs = new Map(file.map(a => [a.code, a]))
  for (const code of [...new Set([...ours.keys(), ...theirs.keys()])].sort()) {
    const mine = ours.get(code)
    const fileAccount = theirs.get(code)
    tally.row(code, moneyPairs(mine, fileAccount), !mine || !fileAccount)

    const myCounters = new Map(mine?.counters.map(c => [c.code, c]))
    const fileCounters = new Map(fileAccount?.counters.map(c => [c.code, c]))
    for (const counter of new Set([...myCounters.keys(), ...fileCounters.keys()])) {
      const a = myCounters.get(counter)
      const b = fileCounters.get(counter)
      tally.row(code, [[a?.debit ?? 0, b?.debit ?? 0, MONEY_TOLERANCE], [a?.credit ?? 0, b?.credit ?? 0, MONEY_TOLERANCE]], !a || !b)
    }
  }
  tally.verdict.accounts = [...new Set(tally.verdict.accounts)]
  return tally.verdict
}

// ── A split's books, added up (FR-25 R7) ───────────────────────────────────────────────────────────

/**
 * The legal entity's columns from its orgs' shares. Turnovers add per side, as booked. A balance is a
 * net on the side of its sign, so it is the NETS that add: a share owed 100 and a share that owes 30
 * are a company owed 70, not a row with 100 on one side and 30 on the other, which is how the
 * accountant's print, one company, shows it.
 */
function sumColumns(rows: readonly Partial<BalanceColumns>[]): BalanceColumns {
  let opening = 0
  let turnoverDebit = 0
  let turnoverCredit = 0
  let closing = 0
  for (const r of rows) {
    opening += (r.openingDebit ?? 0) - (r.openingCredit ?? 0)
    turnoverDebit += r.turnoverDebit ?? 0
    turnoverCredit += r.turnoverCredit ?? 0
    closing += (r.closingDebit ?? 0) - (r.closingCredit ?? 0)
  }
  const tidy = (n: number) => Math.round(n * 1e8) / 1e8 || 0
  return {
    openingDebit: tidy(Math.max(opening, 0)),
    openingCredit: tidy(Math.max(-opening, 0)),
    turnoverDebit: tidy(turnoverDebit),
    turnoverCredit: tidy(turnoverCredit),
    closingDebit: tidy(Math.max(closing, 0)),
    closingCredit: tidy(Math.max(-closing, 0)),
  }
}

function groupBy<T>(parts: readonly (readonly T[])[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const rows of parts) {
    for (const row of rows) {
      const k = key(row)
      const held = out.get(k)
      if (held) held.push(row)
      else out.set(k, [row])
    }
  }
  return out
}

/** Оборотна ведомост of the group: each account's shares added, by code. */
export function sumTrialBalances(parts: readonly (readonly TrialBalanceRow[])[]): TrialBalanceRow[] {
  return [...groupBy(parts, r => r.code)].map(([code, rows]) => ({ accountId: rows[0].accountId, code, name: rows[0].name, ...sumColumns(rows) }))
    .sort((a, b) => a.code.localeCompare(b.code))
}

/** The analytic one: each path's shares added, quantities too. A path is the same analytic in every org of a split. */
export function sumAnalyticTrialBalances(parts: readonly (readonly AnalyticBalanceRow[])[]): AnalyticBalanceRow[] {
  const tidy = (n: number) => Math.round(n * 1e8) / 1e8 || 0
  return [...groupBy(parts, r => r.path)].map(([path, rows]) => {
    const unit = rows.find(r => r.unit)?.unit
    const sum = (key: 'openingQuantity' | 'turnoverDebitQuantity' | 'turnoverCreditQuantity' | 'closingQuantity') => tidy(rows.reduce((n, r) => n + (r[key] ?? 0), 0))
    return {
      analyticId: rows[0].analyticId,
      path,
      ...(unit ? { unit } : {}),
      ...sumColumns(rows),
      openingQuantity: sum('openingQuantity'),
      turnoverDebitQuantity: sum('turnoverDebitQuantity'),
      turnoverCreditQuantity: sum('turnoverCreditQuantity'),
      closingQuantity: sum('closingQuantity'),
    }
  }).sort((a, b) => a.path.localeCompare(b.path, 'bg'))
}

/** Главна книга of the group: each account's shares, and each correspondent's turnovers, added. */
export function sumMainBooks(parts: readonly (readonly MainBookAccount[])[]): MainBookAccount[] {
  const tidy = (n: number) => Math.round(n * 1e8) / 1e8 || 0
  return [...groupBy(parts, a => a.code)].map(([code, accounts]) => {
    const counters = [...groupBy(accounts.map(a => a.counters), c => c.code)].map(([counter, rows]) => ({
      code: counter,
      name: rows[0].name,
      debit: tidy(rows.reduce((n, c) => n + c.debit, 0)),
      credit: tidy(rows.reduce((n, c) => n + c.credit, 0)),
    })).sort((a, b) => a.code.localeCompare(b.code))
    return { accountId: accounts[0].accountId, code, name: accounts[0].name, ...sumColumns(accounts), counters }
  }).sort((a, b) => a.code.localeCompare(b.code))
}

/** The turnovers a journal file adds up to: what a period with no trial balance is proven against. */
export function turnoversOfJournal(journal: Pick<ParsedJournal, 'documents'>) {
  const accounts = new Map<string, { debit: number; credit: number }>()
  const analytics = new Map<string, { debit: number; credit: number; quantityDebit: number; quantityCredit: number }>()
  const onAccount = (code: string, side: 'debit' | 'credit', amount: number) => {
    const row = accounts.get(code) ?? { debit: 0, credit: 0 }
    row[side] += amount
    accounts.set(code, row)
  }
  const onAnalytic = (path: string | undefined, side: 'debit' | 'credit', amount: number, qty: number) => {
    if (!path) return
    const row = analytics.get(path) ?? { debit: 0, credit: 0, quantityDebit: 0, quantityCredit: 0 }
    row[side] += amount
    row[side === 'debit' ? 'quantityDebit' : 'quantityCredit'] += qty
    analytics.set(path, row)
  }
  for (const doc of journal.documents) {
    for (const op of doc.ops) {
      onAccount(op.d, 'debit', op.amount)
      onAccount(op.k, 'credit', op.amount)
      onAnalytic(op.ad, 'debit', op.amount, op.qty ?? 0)
      onAnalytic(op.ak, 'credit', op.amount, op.qty ?? 0)
    }
  }
  return { accounts, analytics }
}

/** A journal file's turnovers against the books', per account. */
export function compareJournalAccounts(journal: Pick<ParsedJournal, 'documents'>, books: readonly TrialBalanceRow[]): Verdict {
  const tally = new Tally()
  const { accounts } = turnoversOfJournal(journal)
  const ours = new Map(books.map(r => [r.code, r]))
  for (const code of [...new Set([...ours.keys(), ...accounts.keys()])].sort()) {
    const mine = ours.get(code)
    const file = accounts.get(code)
    tally.row(code, [
      [mine?.turnoverDebit ?? 0, file?.debit ?? 0, MONEY_TOLERANCE],
      [mine?.turnoverCredit ?? 0, file?.credit ?? 0, MONEY_TOLERANCE],
    ], !mine || !file)
  }
  return tally.verdict
}

/** A journal file's turnovers against the books', per analytic, quantities included. */
export function compareJournalAnalytics(journal: Pick<ParsedJournal, 'documents'>, books: readonly AnalyticBalanceRow[]): Verdict {
  const tally = new Tally()
  const { analytics } = turnoversOfJournal(journal)
  const ours = new Map(books.map(r => [r.path, r]))
  for (const path of new Set([...ours.keys(), ...analytics.keys()])) {
    const mine = ours.get(path)
    const file = analytics.get(path)
    tally.row(undefined, [
      [mine?.turnoverDebit ?? 0, file?.debit ?? 0, MONEY_TOLERANCE],
      [mine?.turnoverCredit ?? 0, file?.credit ?? 0, MONEY_TOLERANCE],
      [mine?.turnoverDebitQuantity ?? 0, file?.quantityDebit ?? 0, QUANTITY_TOLERANCE],
      [mine?.turnoverCreditQuantity ?? 0, file?.quantityCredit ?? 0, QUANTITY_TOLERANCE],
    ], !mine || !file)
  }
  return tally.verdict
}
