import { Account, JournalEntry, FiscalPeriod, type IAccount, type IJournalEntry } from 'db/models'
import { logger } from '../logger/logger.js'

export async function postJournalEntry(entryId: string, userId: string): Promise<IJournalEntry> {
  const entry = await JournalEntry.findById(entryId)
  if (!entry) throw new Error('Journal entry not found')
  if (entry.status !== 'draft') throw new Error('Only draft entries can be posted')

  // Validate debits equal credits
  if (Math.abs(entry.totalDebit - entry.totalCredit) > 0.01) {
    throw new Error('Total debits must equal total credits')
  }

  // Update account balances
  for (const line of entry.lines) {
    const account = await Account.findById(line.accountId)
    if (!account) throw new Error(`Account ${line.accountId} not found`)

    const isDebitNormal = ['asset', 'expense'].includes(account.type)
    const adjustment = isDebitNormal
      ? line.baseDebit - line.baseCredit
      : line.baseCredit - line.baseDebit

    account.balance += adjustment
    await account.save()
  }

  entry.status = 'posted'
  entry.postedBy = userId as any
  entry.postedAt = new Date()
  await entry.save()

  logger.info({ entryId, entryNumber: entry.entryNumber }, 'Journal entry posted')
  return entry
}

export async function voidJournalEntry(entryId: string): Promise<IJournalEntry> {
  const entry = await JournalEntry.findById(entryId)
  if (!entry) throw new Error('Journal entry not found')
  if (entry.status !== 'posted') throw new Error('Only posted entries can be voided')

  // Reverse account balances
  for (const line of entry.lines) {
    const account = await Account.findById(line.accountId)
    if (!account) continue

    const isDebitNormal = ['asset', 'expense'].includes(account.type)
    const reversal = isDebitNormal
      ? -(line.baseDebit - line.baseCredit)
      : -(line.baseCredit - line.baseDebit)

    account.balance += reversal
    await account.save()
  }

  entry.status = 'voided'
  await entry.save()

  logger.info({ entryId, entryNumber: entry.entryNumber }, 'Journal entry voided')
  return entry
}

export interface TrialBalanceRow {
  accountId: string
  code: string
  name: string
  type: string
  debit: number
  credit: number
}

export async function getTrialBalance(orgId: string, periodId?: string): Promise<TrialBalanceRow[]> {
  const filter: any = { orgId, status: 'posted' }
  if (periodId) filter.fiscalPeriodId = periodId

  const entries = await JournalEntry.find(filter).exec()
  const accountTotals = new Map<string, { debit: number; credit: number }>()

  for (const entry of entries) {
    for (const line of entry.lines) {
      const key = String(line.accountId)
      const current = accountTotals.get(key) || { debit: 0, credit: 0 }
      current.debit += line.baseDebit
      current.credit += line.baseCredit
      accountTotals.set(key, current)
    }
  }

  const accounts = await Account.find({ orgId }).sort({ code: 1 }).exec()
  const rows: TrialBalanceRow[] = []

  for (const account of accounts) {
    const totals = accountTotals.get(String(account._id))
    if (!totals) continue

    const net = totals.debit - totals.credit
    rows.push({
      accountId: String(account._id),
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

export async function getProfitLoss(orgId: string, startDate: Date, endDate: Date): Promise<ProfitLossData> {
  const entries = await JournalEntry.find({
    orgId,
    status: 'posted',
    date: { $gte: startDate, $lte: endDate },
  }).exec()

  const accountTotals = new Map<string, number>()
  for (const entry of entries) {
    for (const line of entry.lines) {
      const key = String(line.accountId)
      const current = accountTotals.get(key) || 0
      accountTotals.set(key, current + line.baseCredit - line.baseDebit)
    }
  }

  const accounts = await Account.find({ orgId, type: { $in: ['revenue', 'expense'] } }).exec()
  const revenue: { account: string; amount: number }[] = []
  const expenses: { account: string; amount: number }[] = []

  for (const account of accounts) {
    const amount = accountTotals.get(String(account._id)) || 0
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
