import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { Account, FiscalYear, FiscalPeriod, JournalEntry, Org, User } from 'db/models'
import { postJournalEntry, getTrialBalance, getProfitLoss } from 'services/biz/accounting.service'
import type { IAccount, IFiscalPeriod } from 'db/models'

let orgId: string
let userId: string
let periodId: string
let period2Id: string

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

interface ReportingData {
  org: any
  user: any
  cash: IAccount
  ar: IAccount
  revenue: IAccount
  expense: IAccount
  ap: IAccount
  period: IFiscalPeriod
  period2: IFiscalPeriod
}

async function setupReportingData(): Promise<ReportingData> {
  const org = await Org.create({
    name: 'Reporting Test Org',
    slug: 'reporting-test',
    settings: {
      baseCurrency: 'EUR',
      fiscalYearStart: 1,
      dateFormat: 'DD.MM.YYYY',
      timezone: 'UTC',
      locale: 'en',
      taxConfig: { vatEnabled: false, defaultVatRate: 0, vatRates: [], taxIdLabel: '' },
      payroll: { payFrequency: 'monthly', socialSecurityRate: 0, healthInsuranceRate: 0, pensionRate: 0 },
      modules: ['accounting'],
    },
    subscription: { plan: 'free', maxUsers: 5 },
  })
  orgId = String(org._id)

  const user = await User.create({
    email: 'report@test.com',
    username: 'reporter',
    password: 'x',
    firstName: 'Report',
    lastName: 'User',
    role: 'admin',
    orgId: org._id,
    isActive: true,
    permissions: [],
  })
  userId = String(user._id)

  const fy = await FiscalYear.create({
    orgId: org._id,
    name: 'FY 2025',
    startDate: new Date('2025-01-01'),
    endDate: new Date('2025-12-31'),
    status: 'open',
  })

  const period = await FiscalPeriod.create({
    orgId: org._id,
    fiscalYearId: fy._id,
    name: 'January',
    number: 1,
    startDate: new Date('2025-01-01'),
    endDate: new Date('2025-01-31'),
    status: 'open',
  })
  periodId = String(period._id)

  const period2 = await FiscalPeriod.create({
    orgId: org._id,
    fiscalYearId: fy._id,
    name: 'February',
    number: 2,
    startDate: new Date('2025-02-01'),
    endDate: new Date('2025-02-28'),
    status: 'open',
  })
  period2Id = String(period2._id)

  const cash = await Account.create({
    orgId: org._id,
    code: '1000',
    name: 'Cash',
    type: 'asset',
    subType: 'current_asset',
    balance: 0,
  })

  const ar = await Account.create({
    orgId: org._id,
    code: '1200',
    name: 'Accounts Receivable',
    type: 'asset',
    subType: 'current_asset',
    balance: 0,
  })

  const revenue = await Account.create({
    orgId: org._id,
    code: '4000',
    name: 'Sales Revenue',
    type: 'revenue',
    subType: 'operating_revenue',
    balance: 0,
  })

  const expense = await Account.create({
    orgId: org._id,
    code: '6000',
    name: 'Operating Expense',
    type: 'expense',
    subType: 'operating_expense',
    balance: 0,
  })

  const ap = await Account.create({
    orgId: org._id,
    code: '2000',
    name: 'Accounts Payable',
    type: 'liability',
    subType: 'current_liability',
    balance: 0,
  })

  return { org, user, cash, ar, revenue, expense, ap, period, period2 }
}

async function createAndPostEntry(opts: {
  entryNumber: string
  date: Date
  fiscalPeriodId: string
  description: string
  lines: { accountId: any; debit: number; credit: number }[]
  status?: string
}) {
  const totalDebit = opts.lines.reduce((sum, l) => sum + l.debit, 0)
  const totalCredit = opts.lines.reduce((sum, l) => sum + l.credit, 0)

  const entry = await JournalEntry.create({
    orgId,
    entryNumber: opts.entryNumber,
    date: opts.date,
    fiscalPeriodId: opts.fiscalPeriodId,
    description: opts.description,
    type: 'standard',
    status: opts.status || 'draft',
    lines: opts.lines.map((l) => ({
      accountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      currency: 'EUR',
      exchangeRate: 1,
      baseDebit: l.debit,
      baseCredit: l.credit,
    })),
    totalDebit,
    totalCredit,
    createdBy: userId,
  })

  if (opts.status && opts.status !== 'draft') {
    // Already created as posted/voided, no need to post
    return entry
  }

  return postJournalEntry(String(entry._id), userId)
}

describe('Reporting Flow', () => {
  // --- Trial Balance ---

  it('should produce a trial balance with debits equal to credits across multiple posted entries', async () => {
    const { cash, ar, revenue, expense, ap } = await setupReportingData()

    // Entry 1: Cash sale - debit Cash 5000, credit Revenue 5000
    await createAndPostEntry({
      entryNumber: 'JE-2025-00001',
      date: new Date('2025-01-10'),
      fiscalPeriodId: periodId,
      description: 'Cash sale',
      lines: [
        { accountId: cash._id, debit: 5000, credit: 0 },
        { accountId: revenue._id, debit: 0, credit: 5000 },
      ],
    })

    // Entry 2: Purchase on credit - debit Expense 2000, credit AP 2000
    await createAndPostEntry({
      entryNumber: 'JE-2025-00002',
      date: new Date('2025-01-15'),
      fiscalPeriodId: periodId,
      description: 'Office supplies on credit',
      lines: [
        { accountId: expense._id, debit: 2000, credit: 0 },
        { accountId: ap._id, debit: 0, credit: 2000 },
      ],
    })

    // Entry 3: Credit sale - debit AR 3000, credit Revenue 3000
    await createAndPostEntry({
      entryNumber: 'JE-2025-00003',
      date: new Date('2025-01-20'),
      fiscalPeriodId: periodId,
      description: 'Credit sale',
      lines: [
        { accountId: ar._id, debit: 3000, credit: 0 },
        { accountId: revenue._id, debit: 0, credit: 3000 },
      ],
    })

    const tb = await getTrialBalance(orgId)
    expect(tb.length).toBe(5) // cash, ar, revenue, expense, ap => all have activity

    const totalDebit = tb.reduce((sum, r) => sum + r.debit, 0)
    const totalCredit = tb.reduce((sum, r) => sum + r.credit, 0)
    expect(totalDebit).toBe(totalCredit)
  })

  it('should filter trial balance by fiscal period', async () => {
    const { cash, revenue } = await setupReportingData()

    // Entry in January period
    await createAndPostEntry({
      entryNumber: 'JE-2025-00001',
      date: new Date('2025-01-15'),
      fiscalPeriodId: periodId,
      description: 'January sale',
      lines: [
        { accountId: cash._id, debit: 4000, credit: 0 },
        { accountId: revenue._id, debit: 0, credit: 4000 },
      ],
    })

    // Entry in February period
    await createAndPostEntry({
      entryNumber: 'JE-2025-00002',
      date: new Date('2025-02-10'),
      fiscalPeriodId: period2Id,
      description: 'February sale',
      lines: [
        { accountId: cash._id, debit: 6000, credit: 0 },
        { accountId: revenue._id, debit: 0, credit: 6000 },
      ],
    })

    // Filter by January only
    const tbJan = await getTrialBalance(orgId, periodId)
    const janDebit = tbJan.reduce((sum, r) => sum + r.debit, 0)
    expect(janDebit).toBe(4000)

    // Filter by February only
    const tbFeb = await getTrialBalance(orgId, period2Id)
    const febDebit = tbFeb.reduce((sum, r) => sum + r.debit, 0)
    expect(febDebit).toBe(6000)

    // Unfiltered should include both periods
    const tbAll = await getTrialBalance(orgId)
    const allDebit = tbAll.reduce((sum, r) => sum + r.debit, 0)
    expect(allDebit).toBe(10000)
  })

  it('should return empty trial balance for org with no posted entries', async () => {
    await setupReportingData()

    const tb = await getTrialBalance(orgId)
    expect(tb.length).toBe(0)
  })

  // --- Profit & Loss ---

  it('should separate revenue and expense accounts correctly in P&L', async () => {
    const { cash, revenue, expense } = await setupReportingData()

    // Revenue entry
    await createAndPostEntry({
      entryNumber: 'JE-2025-00001',
      date: new Date('2025-01-10'),
      fiscalPeriodId: periodId,
      description: 'Service revenue',
      lines: [
        { accountId: cash._id, debit: 8000, credit: 0 },
        { accountId: revenue._id, debit: 0, credit: 8000 },
      ],
    })

    // Expense entry
    await createAndPostEntry({
      entryNumber: 'JE-2025-00002',
      date: new Date('2025-01-15'),
      fiscalPeriodId: periodId,
      description: 'Rent expense',
      lines: [
        { accountId: expense._id, debit: 3000, credit: 0 },
        { accountId: cash._id, debit: 0, credit: 3000 },
      ],
    })

    const pl = await getProfitLoss(orgId, new Date('2025-01-01'), new Date('2025-01-31'))

    expect(pl.revenue.length).toBe(1)
    expect(pl.expenses.length).toBe(1)
    expect(pl.revenue[0].account).toContain('Sales Revenue')
    expect(pl.expenses[0].account).toContain('Operating Expense')
  })

  it('should calculate netIncome as totalRevenue minus totalExpenses', async () => {
    const { cash, revenue, expense } = await setupReportingData()

    await createAndPostEntry({
      entryNumber: 'JE-2025-00001',
      date: new Date('2025-01-10'),
      fiscalPeriodId: periodId,
      description: 'Sales',
      lines: [
        { accountId: cash._id, debit: 10000, credit: 0 },
        { accountId: revenue._id, debit: 0, credit: 10000 },
      ],
    })

    await createAndPostEntry({
      entryNumber: 'JE-2025-00002',
      date: new Date('2025-01-20'),
      fiscalPeriodId: periodId,
      description: 'Expenses',
      lines: [
        { accountId: expense._id, debit: 4000, credit: 0 },
        { accountId: cash._id, debit: 0, credit: 4000 },
      ],
    })

    const pl = await getProfitLoss(orgId, new Date('2025-01-01'), new Date('2025-01-31'))

    expect(pl.totalRevenue).toBe(10000)
    expect(pl.totalExpenses).toBe(4000)
    expect(pl.netIncome).toBe(6000)
  })

  it('should filter P&L by date range and only include entries within range', async () => {
    const { cash, revenue } = await setupReportingData()

    // January entry
    await createAndPostEntry({
      entryNumber: 'JE-2025-00001',
      date: new Date('2025-01-15'),
      fiscalPeriodId: periodId,
      description: 'January sale',
      lines: [
        { accountId: cash._id, debit: 5000, credit: 0 },
        { accountId: revenue._id, debit: 0, credit: 5000 },
      ],
    })

    // February entry
    await createAndPostEntry({
      entryNumber: 'JE-2025-00002',
      date: new Date('2025-02-10'),
      fiscalPeriodId: period2Id,
      description: 'February sale',
      lines: [
        { accountId: cash._id, debit: 7000, credit: 0 },
        { accountId: revenue._id, debit: 0, credit: 7000 },
      ],
    })

    // P&L for January only
    const plJan = await getProfitLoss(orgId, new Date('2025-01-01'), new Date('2025-01-31'))
    expect(plJan.totalRevenue).toBe(5000)

    // P&L for February only
    const plFeb = await getProfitLoss(orgId, new Date('2025-02-01'), new Date('2025-02-28'))
    expect(plFeb.totalRevenue).toBe(7000)

    // P&L for full Q1 includes both
    const plQ1 = await getProfitLoss(orgId, new Date('2025-01-01'), new Date('2025-03-31'))
    expect(plQ1.totalRevenue).toBe(12000)
  })

  it('should exclude non-posted (draft) entries from P&L', async () => {
    const { cash, revenue } = await setupReportingData()

    // Posted entry
    await createAndPostEntry({
      entryNumber: 'JE-2025-00001',
      date: new Date('2025-01-10'),
      fiscalPeriodId: periodId,
      description: 'Posted sale',
      lines: [
        { accountId: cash._id, debit: 5000, credit: 0 },
        { accountId: revenue._id, debit: 0, credit: 5000 },
      ],
    })

    // Draft entry - created directly without posting
    await JournalEntry.create({
      orgId,
      entryNumber: 'JE-2025-00002',
      date: new Date('2025-01-15'),
      fiscalPeriodId: periodId,
      description: 'Draft sale - should be excluded',
      type: 'standard',
      status: 'draft',
      lines: [
        { accountId: cash._id, debit: 9000, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 9000, baseCredit: 0 },
        { accountId: revenue._id, debit: 0, credit: 9000, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 9000 },
      ],
      totalDebit: 9000,
      totalCredit: 9000,
      createdBy: userId,
    })

    const pl = await getProfitLoss(orgId, new Date('2025-01-01'), new Date('2025-01-31'))

    // Only the posted 5000 should appear, not the draft 9000
    expect(pl.totalRevenue).toBe(5000)
  })

  it('should accumulate balances correctly when multiple entries affect the same account', async () => {
    const { cash, ar, revenue, expense } = await setupReportingData()

    // Three revenue entries hitting the same Revenue account
    await createAndPostEntry({
      entryNumber: 'JE-2025-00001',
      date: new Date('2025-01-05'),
      fiscalPeriodId: periodId,
      description: 'Sale 1',
      lines: [
        { accountId: cash._id, debit: 3000, credit: 0 },
        { accountId: revenue._id, debit: 0, credit: 3000 },
      ],
    })

    await createAndPostEntry({
      entryNumber: 'JE-2025-00002',
      date: new Date('2025-01-12'),
      fiscalPeriodId: periodId,
      description: 'Sale 2',
      lines: [
        { accountId: ar._id, debit: 2000, credit: 0 },
        { accountId: revenue._id, debit: 0, credit: 2000 },
      ],
    })

    await createAndPostEntry({
      entryNumber: 'JE-2025-00003',
      date: new Date('2025-01-20'),
      fiscalPeriodId: periodId,
      description: 'Sale 3',
      lines: [
        { accountId: cash._id, debit: 1500, credit: 0 },
        { accountId: revenue._id, debit: 0, credit: 1500 },
      ],
    })

    // Two expense entries hitting the same Expense account
    await createAndPostEntry({
      entryNumber: 'JE-2025-00004',
      date: new Date('2025-01-08'),
      fiscalPeriodId: periodId,
      description: 'Expense 1',
      lines: [
        { accountId: expense._id, debit: 1000, credit: 0 },
        { accountId: cash._id, debit: 0, credit: 1000 },
      ],
    })

    await createAndPostEntry({
      entryNumber: 'JE-2025-00005',
      date: new Date('2025-01-22'),
      fiscalPeriodId: periodId,
      description: 'Expense 2',
      lines: [
        { accountId: expense._id, debit: 500, credit: 0 },
        { accountId: cash._id, debit: 0, credit: 500 },
      ],
    })

    // Trial balance: verify cumulative balances
    const tb = await getTrialBalance(orgId)

    const cashRow = tb.find((r) => r.code === '1000')!
    const arRow = tb.find((r) => r.code === '1200')!
    const revenueRow = tb.find((r) => r.code === '4000')!
    const expenseRow = tb.find((r) => r.code === '6000')!

    // Cash: 3000 + 1500 debit, 1000 + 500 credit => net 3000 debit
    expect(cashRow.debit).toBe(3000)
    expect(cashRow.credit).toBe(0)

    // AR: 2000 debit, 0 credit => net 2000 debit
    expect(arRow.debit).toBe(2000)
    expect(arRow.credit).toBe(0)

    // Revenue: 0 debit, 3000 + 2000 + 1500 = 6500 credit => net 6500 credit
    expect(revenueRow.debit).toBe(0)
    expect(revenueRow.credit).toBe(6500)

    // Expense: 1000 + 500 = 1500 debit, 0 credit => net 1500 debit
    expect(expenseRow.debit).toBe(1500)
    expect(expenseRow.credit).toBe(0)

    // Verify total debits == total credits
    const totalDebit = tb.reduce((sum, r) => sum + r.debit, 0)
    const totalCredit = tb.reduce((sum, r) => sum + r.credit, 0)
    expect(totalDebit).toBe(totalCredit)

    // P&L: verify cumulative amounts
    const pl = await getProfitLoss(orgId, new Date('2025-01-01'), new Date('2025-01-31'))
    expect(pl.totalRevenue).toBe(6500)
    expect(pl.totalExpenses).toBe(1500)
    expect(pl.netIncome).toBe(5000)
  })
})
