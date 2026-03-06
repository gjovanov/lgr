import type { RepositoryRegistry } from 'dal'
import type { IJournalEntry } from 'dal/entities'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'

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
  const existing = await r.fiscalPeriods.findOne({
    orgId,
    startDate: { $lte: date },
    endDate: { $gte: date },
  } as any)
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
  const matching = inserted.find(
    (p) => p.startDate <= date && p.endDate >= date,
  )
  if (!matching) throw new Error(`Failed to find matching period for date ${date.toISOString()}`)
  return matching.id
}

export async function postJournalEntry(entryId: string, userId: string, repos?: RepositoryRegistry): Promise<IJournalEntry> {
  const r = repos ?? getRepos()
  const entry = await r.journalEntries.findById(entryId)
  if (!entry) throw new Error('Journal entry not found')
  if (entry.status !== 'draft') throw new Error('Only draft entries can be posted')

  // Validate debits equal credits
  if (Math.abs(entry.totalDebit - entry.totalCredit) > 0.01) {
    throw new Error('Total debits must equal total credits')
  }

  // Update account balances
  for (const line of entry.lines) {
    const account = await r.accounts.findById(line.accountId)
    if (!account) throw new Error(`Account ${line.accountId} not found`)

    const isDebitNormal = ['asset', 'expense'].includes(account.type)
    const adjustment = isDebitNormal
      ? line.baseDebit - line.baseCredit
      : line.baseCredit - line.baseDebit

    await r.accounts.update(account.id, {
      balance: account.balance + adjustment,
    } as any)
  }

  const updated = await r.journalEntries.update(entryId, {
    status: 'posted',
    postedBy: userId,
    postedAt: new Date(),
  } as any)
  if (!updated) throw new Error('Failed to update journal entry status')

  logger.info({ entryId, entryNumber: entry.entryNumber }, 'Journal entry posted')
  return updated
}

export async function voidJournalEntry(entryId: string, repos?: RepositoryRegistry): Promise<IJournalEntry> {
  const r = repos ?? getRepos()
  const entry = await r.journalEntries.findById(entryId)
  if (!entry) throw new Error('Journal entry not found')
  if (entry.status !== 'posted') throw new Error('Only posted entries can be voided')

  // Reverse account balances
  for (const line of entry.lines) {
    const account = await r.accounts.findById(line.accountId)
    if (!account) continue

    const isDebitNormal = ['asset', 'expense'].includes(account.type)
    const reversal = isDebitNormal
      ? -(line.baseDebit - line.baseCredit)
      : -(line.baseCredit - line.baseDebit)

    await r.accounts.update(account.id, {
      balance: account.balance + reversal,
    } as any)
  }

  const updated = await r.journalEntries.update(entryId, { status: 'voided' } as any)
  if (!updated) throw new Error('Failed to void journal entry')

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

export async function getTrialBalance(orgId: string, periodId?: string, repos?: RepositoryRegistry): Promise<TrialBalanceRow[]> {
  const r = repos ?? getRepos()
  const filter: any = { orgId, status: 'posted' }
  if (periodId) filter.fiscalPeriodId = periodId

  const entries = await r.journalEntries.findMany(filter)
  const accountTotals = new Map<string, { debit: number; credit: number }>()

  for (const entry of entries) {
    for (const line of entry.lines) {
      const key = line.accountId
      const current = accountTotals.get(key) || { debit: 0, credit: 0 }
      current.debit += line.baseDebit
      current.credit += line.baseCredit
      accountTotals.set(key, current)
    }
  }

  const accounts = await r.accounts.findMany({ orgId }, { code: 1 })
  const rows: TrialBalanceRow[] = []

  for (const account of accounts) {
    const totals = accountTotals.get(account.id)
    if (!totals) continue

    const net = totals.debit - totals.credit
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

export interface ProfitLossData {
  revenue: { account: string; amount: number }[]
  expenses: { account: string; amount: number }[]
  totalRevenue: number
  totalExpenses: number
  netIncome: number
}

export async function getProfitLoss(orgId: string, startDate: Date, endDate: Date, repos?: RepositoryRegistry): Promise<ProfitLossData> {
  const r = repos ?? getRepos()
  const entries = await r.journalEntries.findMany({
    orgId,
    status: 'posted',
    date: { $gte: startDate, $lte: endDate },
  } as any)

  const accountTotals = new Map<string, number>()
  for (const entry of entries) {
    for (const line of entry.lines) {
      const key = line.accountId
      const current = accountTotals.get(key) || 0
      accountTotals.set(key, current + line.baseCredit - line.baseDebit)
    }
  }

  const accounts = await r.accounts.findMany({ orgId, type: { $in: ['revenue', 'expense'] } })
  const revenue: { account: string; amount: number }[] = []
  const expenses: { account: string; amount: number }[] = []

  for (const account of accounts) {
    const amount = accountTotals.get(account.id) || 0
    if (account.type === 'revenue') {
      revenue.push({ account: `${account.code} - ${account.name}`, amount })
    } else {
      expenses.push({ account: `${account.code} - ${account.name}`, amount: -amount })
    }
  }

  const totalRevenue = revenue.reduce((sum, r) => sum + r.amount, 0)
  const totalExpenses = expenses.reduce((sum, e) => sum + e.amount, 0)

  return { revenue, expenses, totalRevenue, totalExpenses, netIncome: totalRevenue - totalExpenses }
}
