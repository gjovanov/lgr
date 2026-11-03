import type { RepositoryRegistry } from 'dal'
import type { IAccount, IJournalEntry } from 'dal/entities'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'
import { fiscalRangeContains, fiscalRangeFilter } from '../utils/fiscal-range.js'

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

export function computeFiscalYearRange(date: Date, fiscalYearStart: number) {
  const month = date.getMonth() + 1 // 1-based
  const year = date.getFullYear()
  const startYear = month >= fiscalYearStart ? year : year - 1
  const startDate = new Date(startYear, fiscalYearStart - 1, 1)
  const endDate = new Date(startYear + 1, fiscalYearStart - 1, 0) // last day of month before next FY start
  const name = fiscalYearStart === 1 ? `FY ${startYear}` : `FY ${startYear}/${startYear + 1}`
  return { startDate, endDate, name }
}

export function generateMonthlyPeriods(
  fiscalYearId: string,
  orgId: string,
  fyStartDate: Date,
) {
  const periods = []
  for (let i = 0; i < 12; i++) {
    const periodMonth = fyStartDate.getMonth() + i
    const periodYear = fyStartDate.getFullYear() + Math.floor(periodMonth / 12)
    const normalizedMonth = periodMonth % 12
    const startDate = new Date(periodYear, normalizedMonth, 1)
    const endDate = new Date(periodYear, normalizedMonth + 1, 0) // last day of month
    periods.push({
      orgId,
      fiscalYearId,
      name: MONTH_NAMES[normalizedMonth],
      number: i + 1,
      startDate,
      endDate,
      status: 'open',
    })
  }
  return periods
}

export async function ensureFiscalPeriod(orgId: string, date: Date, repos?: RepositoryRegistry): Promise<string> {
  const r = repos ?? getRepos()

  // 1. Check if a fiscal period already exists for this date
  const existing = await r.fiscalPeriods.findOne({ orgId, ...fiscalRangeFilter(date) } as any)
  if (existing) return existing.id

  // 2. Look up org's fiscalYearStart setting
  const org = await r.orgs.findById(orgId)
  if (!org) throw new Error(`Org ${orgId} not found`)
  const fiscalYearStart = (org as any).settings?.fiscalYearStart || 1

  // 3. Compute fiscal year boundaries
  const { startDate, endDate, name } = computeFiscalYearRange(date, fiscalYearStart)

  // 4. Find or create fiscal year
  let fiscalYear = await r.fiscalYears.findOne({ orgId, startDate, endDate } as any)
  if (!fiscalYear) {
    fiscalYear = await r.fiscalYears.create({ orgId, name, startDate, endDate, status: 'open' } as any)
  }

  // 5. Generate and insert all 12 monthly periods
  const periods = generateMonthlyPeriods(fiscalYear.id, orgId, startDate)
  const inserted = await r.fiscalPeriods.createMany(periods as any)

  // 6. Find and return the period that matches the original date
  const matching = inserted.find((p) => fiscalRangeContains(p, date))
  if (!matching) throw new Error(`Failed to find matching period for date ${date.toISOString()}`)
  return matching.id
}

/** The entry is not in a state to do this, or names what it cannot: a person can be told why. */
export class JournalEntryRefusedError extends Error {}

const round2 = (n: number) => Math.round(n * 100) / 100 || 0

const isDebitNormal = (accountType: string) => ['asset', 'expense'].includes(accountType)

/** The entry's accounts, in its own org: a line can name another org's account, and must not reach it. */
async function accountsOf(entry: IJournalEntry, r: RepositoryRegistry): Promise<Map<string, IAccount>> {
  const ids = [...new Set(entry.lines.map(l => l.accountId))]
  const accounts = await r.accounts.findMany({ orgId: entry.orgId, id: { $in: ids } } as any)
  return new Map(accounts.map(a => [a.id, a]))
}

/**
 * What an entry's lines do to its accounts' balances: ONE amount per account, however many lines
 * name it. A sales document puts a line on the revenue account for every goods group it sold.
 *
 * ⚠ Until FR-25 each line wrote "the balance as loaded before the loop, plus this line", so only
 * the last line on an account counted.
 */
function balanceEffects(entry: IJournalEntry, accounts: Map<string, IAccount>): Record<string, number> {
  const effects: Record<string, number> = {}
  for (const line of entry.lines) {
    const account = accounts.get(line.accountId)
    if (!account) continue
    const amount = isDebitNormal(account.type) ? line.baseDebit - line.baseCredit : line.baseCredit - line.baseDebit
    effects[line.accountId] = (effects[line.accountId] ?? 0) + amount
  }
  for (const id of Object.keys(effects)) effects[id] = round2(effects[id])
  return effects
}

export async function postJournalEntry(entryId: string, userId: string, repos?: RepositoryRegistry): Promise<IJournalEntry> {
  const r = repos ?? getRepos()
  const entry = await r.journalEntries.findById(entryId)
  if (!entry) throw new Error('Journal entry not found')
  if (entry.status !== 'draft') throw new JournalEntryRefusedError('Only draft entries can be posted')

  // Validate debits equal credits
  if (Math.abs(entry.totalDebit - entry.totalCredit) > 0.01) {
    throw new JournalEntryRefusedError('Total debits must equal total credits')
  }

  const accounts = await accountsOf(entry, r)
  for (const line of entry.lines) {
    if (!accounts.has(line.accountId)) throw new JournalEntryRefusedError(`Account ${line.accountId} not found`)
  }

  // Claimed before the balances move: of two posts at once, one moves them and the other is refused.
  const updated = await r.journalEntries.updateInOrg(entryId, entry.orgId, {
    status: 'posted',
    postedBy: userId,
    postedAt: new Date(),
  } as any, { status: 'draft' })
  if (!updated) throw new JournalEntryRefusedError('Only draft entries can be posted')

  await r.accounts.adjustBalances(entry.orgId, balanceEffects(entry, accounts))

  logger.info({ entryId, entryNumber: entry.entryNumber }, 'Journal entry posted')
  return updated
}

export async function voidJournalEntry(entryId: string, repos?: RepositoryRegistry): Promise<IJournalEntry> {
  const r = repos ?? getRepos()
  const entry = await r.journalEntries.findById(entryId)
  if (!entry) throw new Error('Journal entry not found')
  if (entry.status !== 'posted') throw new JournalEntryRefusedError('Only posted entries can be voided')

  const effects = balanceEffects(entry, await accountsOf(entry, r))

  const updated = await r.journalEntries.updateInOrg(entryId, entry.orgId, { status: 'voided' } as any, { status: 'posted' })
  if (!updated) throw new JournalEntryRefusedError('Only posted entries can be voided')

  await r.accounts.adjustBalances(entry.orgId, Object.fromEntries(Object.entries(effects).map(([id, amount]) => [id, -amount])))

  logger.info({ entryId, entryNumber: entry.entryNumber }, 'Journal entry voided')
  return updated
}

export interface TrialBalanceRow {
  accountId: string
  code: string
  name: string
  type: string
  debit: number
  credit: number
}

/** Which posted entries a trial balance covers: all of them, when nothing narrows it. */
export interface TrialBalanceScope {
  fiscalYearId?: string
  fiscalPeriodId?: string
  /** The last moment that counts. */
  asOf?: Date
}

/**
 * The fiscal periods a scope names, or undefined when it names none.
 *
 * An entry belongs to a year through its period, so a year is its periods, read in this org: another
 * org's year has none here and the report comes back empty. A period outside the named year is no
 * period at all.
 */
async function periodsInScope(orgId: string, scope: TrialBalanceScope, r: RepositoryRegistry): Promise<string[] | undefined> {
  if (!scope.fiscalYearId) return scope.fiscalPeriodId ? [scope.fiscalPeriodId] : undefined
  const periods = await r.fiscalPeriods.findMany({ orgId, fiscalYearId: scope.fiscalYearId } as any)
  const ids = periods.map(p => p.id)
  return scope.fiscalPeriodId ? ids.filter(id => id === scope.fiscalPeriodId) : ids
}

export async function getTrialBalance(orgId: string, scope: TrialBalanceScope = {}, repos?: RepositoryRegistry): Promise<TrialBalanceRow[]> {
  const r = repos ?? getRepos()
  const accountTotals = new Map((await r.journalEntries.sumPostedLines({
    orgId,
    fiscalPeriodIds: await periodsInScope(orgId, scope, r),
    to: scope.asOf,
  })).map(t => [t.accountId, t]))

  const accounts = await r.accounts.findMany({ orgId }, { code: 1 })
  const rows: TrialBalanceRow[] = []

  for (const account of accounts) {
    const totals = accountTotals.get(account.id)
    if (!totals) continue

    const net = round2(totals.debit - totals.credit)
    rows.push({
      accountId: account.id,
      code: account.code,
      name: account.name,
      type: account.type,
      debit: net > 0 ? net : 0,
      credit: net < 0 ? -net : 0,
    })
  }

  return rows
}

export interface ProfitLossRow {
  account: string
  /** Net, on the account's own side: what the totals add up. */
  amount: number
  /** The turnover on each side, as the books show it. */
  debit: number
  credit: number
}

export interface ProfitLossData {
  revenue: ProfitLossRow[]
  expenses: ProfitLossRow[]
  totalRevenue: number
  totalExpenses: number
  netIncome: number
}

/**
 * ⚠ `amount` nets the two sides, and that is all it does. A debit on a revenue account is not
 * reclassified: in books that keep cost of sales on the revenue account (`D702 K304`) it is a cost,
 * and that account's `amount` is the margin; in another org the same debit reverses a sale. Nothing
 * here can tell which, so each row carries both sides for the reader who can.
 */
export async function getProfitLoss(orgId: string, startDate: Date, endDate: Date, repos?: RepositoryRegistry): Promise<ProfitLossData> {
  const r = repos ?? getRepos()
  const accountTotals = new Map((await r.journalEntries.sumPostedLines({ orgId, from: startDate, to: endDate })).map(t => [t.accountId, t]))

  const accounts = await r.accounts.findMany({ orgId, type: { $in: ['revenue', 'expense'] } }, { code: 1 })
  const revenue: ProfitLossRow[] = []
  const expenses: ProfitLossRow[] = []

  for (const account of accounts) {
    const debit = round2(accountTotals.get(account.id)?.debit ?? 0)
    const credit = round2(accountTotals.get(account.id)?.credit ?? 0)
    const label = `${account.code} - ${account.name}`
    if (account.type === 'revenue') {
      revenue.push({ account: label, amount: round2(credit - debit), debit, credit })
    } else {
      expenses.push({ account: label, amount: round2(debit - credit), debit, credit })
    }
  }

  const totalRevenue = round2(revenue.reduce((sum, r) => sum + r.amount, 0))
  const totalExpenses = round2(expenses.reduce((sum, e) => sum + e.amount, 0))

  return { revenue, expenses, totalRevenue, totalExpenses, netIncome: round2(totalRevenue - totalExpenses) }
}

export interface BalanceSheetRow {
  account: string
  balance: number
  /** The row that is no account: what revenue and expenses add up to while nothing has closed them. */
  unclosedResult?: boolean
}

export interface BalanceSheetData {
  assets: BalanceSheetRow[]
  liabilities: BalanceSheetRow[]
  equity: BalanceSheetRow[]
  totalAssets: number
  totalLiabilities: number
  totalEquity: number
  totalLiabilitiesAndEquity: number
}

/**
 * The balance sheet as of a moment, read from posted entries. `Account.balance` is a cache with no
 * date, and an auto-posted entry never touches it, so it cannot say what the books say.
 *
 * Two things a plain sum per account would get wrong:
 * - **An account can run on both sides.** On a customers account one partner owes us and another
 *   has paid in advance; netting them hides a receivable and a liability. So a partner on the far
 *   side of an asset or liability account shows on the other side of the sheet, under the same
 *   account. Lines that name no partner stay on the account's own side, whatever their sign.
 * - **Revenue and expenses have to go somewhere.** Until a closing entry moves them to equity, what
 *   they add up to is a row of its own in equity, or the two sides differ by exactly that.
 */
export async function getBalanceSheet(orgId: string, asOf: Date = new Date(), repos?: RepositoryRegistry): Promise<BalanceSheetData> {
  const r = repos ?? getRepos()
  const [totals, accounts] = await Promise.all([
    r.journalEntries.sumPostedLines({ orgId, to: asOf, byContact: true }),
    r.accounts.findMany({ orgId }, { code: 1 }),
  ])
  const typeOf = new Map(accounts.map(a => [a.id, a.type]))

  const ownSide = new Map<string, number>()
  const farSide = new Map<string, number>()
  for (const t of totals) {
    const type = typeOf.get(t.accountId)
    if (!type) continue
    const net = isDebitNormal(type) ? t.debit - t.credit : t.credit - t.debit
    const crosses = t.contactId && net < 0 && (type === 'asset' || type === 'liability')
    if (crosses) farSide.set(t.accountId, (farSide.get(t.accountId) ?? 0) - net)
    else ownSide.set(t.accountId, (ownSide.get(t.accountId) ?? 0) + net)
  }

  const assets: BalanceSheetRow[] = []
  const liabilities: BalanceSheetRow[] = []
  const equity: BalanceSheetRow[] = []
  let result = 0
  for (const account of accounts) {
    const own = round2(ownSide.get(account.id) ?? 0)
    const far = round2(farSide.get(account.id) ?? 0)
    const label = `${account.code} - ${account.name}`
    if (account.type === 'revenue') result += own
    else if (account.type === 'expense') result -= own
    // A deactivated account still holds what is on it: dropping the row would unbalance the sheet.
    else if (account.isActive || own) {
      const section = account.type === 'asset' ? assets : account.type === 'liability' ? liabilities : equity
      section.push({ account: label, balance: own })
    }
    if (far) (account.type === 'asset' ? liabilities : assets).push({ account: label, balance: far })
  }

  result = round2(result)
  if (result) equity.push({ account: 'Unclosed result', balance: result, unclosedResult: true })

  const total = (rows: BalanceSheetRow[]) => round2(rows.reduce((sum, row) => sum + row.balance, 0))
  const totalLiabilities = total(liabilities)
  const totalEquity = total(equity)

  return {
    assets,
    liabilities,
    equity,
    totalAssets: total(assets),
    totalLiabilities,
    totalEquity,
    totalLiabilitiesAndEquity: round2(totalLiabilities + totalEquity),
  }
}
