import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { Account, FiscalYear, FiscalPeriod, JournalEntry, Org, User, BankAccount, ExchangeRate, FixedAsset, BankReconciliation, TaxReturn } from 'db/models'
import { postJournalEntry, getTrialBalance } from 'services/biz/accounting.service'
import { createTestOrg, createTestUser, createTestAccount, createTestJournalEntry, createTestFiscalYear, createTestFiscalPeriod, createTestBankAccount, createTestExchangeRate, createTestFixedAsset, createTestBankReconciliation, createTestTaxReturn } from '../helpers/factories'
import { paginateQuery } from 'services/utils/pagination'

let orgId: string
let userId: string
let periodId: string
let cashAccountId: string
let revenueAccountId: string

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

async function setupAccounting() {
  const org = await Org.create({
    name: 'Test', slug: 'test',
    settings: { baseCurrency: 'EUR', fiscalYearStart: 1, dateFormat: 'DD.MM.YYYY', timezone: 'UTC', locale: 'en', taxConfig: { vatEnabled: false, defaultVatRate: 0, vatRates: [], taxIdLabel: '' }, payroll: { payFrequency: 'monthly', socialSecurityRate: 0, healthInsuranceRate: 0, pensionRate: 0 }, modules: ['accounting'] },
    subscription: { plan: 'free', maxUsers: 5 },
  })
  orgId = String(org._id)

  const user = await User.create({ email: 'a@test.com', username: 'a', password: 'x', firstName: 'A', lastName: 'B', role: 'admin', orgId: org._id, isActive: true, permissions: [] })
  userId = String(user._id)

  const fy = await FiscalYear.create({ orgId: org._id, name: 'FY', startDate: new Date('2025-01-01'), endDate: new Date('2025-12-31'), status: 'open' })
  const period = await FiscalPeriod.create({ orgId: org._id, fiscalYearId: fy._id, name: 'Jan', number: 1, startDate: new Date('2025-01-01'), endDate: new Date('2025-01-31'), status: 'open' })
  periodId = String(period._id)

  const cash = await Account.create({ orgId: org._id, code: '1000', name: 'Cash', type: 'asset', subType: 'current_asset', balance: 0 })
  const revenue = await Account.create({ orgId: org._id, code: '4000', name: 'Revenue', type: 'revenue', subType: 'operating_revenue', balance: 0 })
  const expense = await Account.create({ orgId: org._id, code: '6000', name: 'Expense', type: 'expense', subType: 'operating_expense', balance: 0 })

  cashAccountId = String(cash._id)
  revenueAccountId = String(revenue._id)

  return { org, user, cash, revenue, expense, period }
}

describe('Accounting Flow', () => {
  it('should create and post a journal entry', async () => {
    const { cash, revenue } = await setupAccounting()

    const entry = await JournalEntry.create({
      orgId,
      entryNumber: 'JE-2025-00001',
      date: new Date('2025-01-15'),
      fiscalPeriodId: periodId,
      description: 'Cash sale',
      type: 'standard',
      status: 'draft',
      lines: [
        { accountId: cash._id, debit: 1000, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 1000, baseCredit: 0 },
        { accountId: revenue._id, debit: 0, credit: 1000, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 1000 },
      ],
      totalDebit: 1000,
      totalCredit: 1000,
      createdBy: userId,
    })

    expect(entry.status).toBe('draft')

    const posted = await postJournalEntry(String(entry._id), userId)
    expect(posted.status).toBe('posted')
    expect(posted.postedAt).toBeDefined()

    // Check account balances
    const updatedCash = await Account.findById(cash._id)
    const updatedRevenue = await Account.findById(revenue._id)
    expect(updatedCash!.balance).toBe(1000) // Asset: debit increases
    expect(updatedRevenue!.balance).toBe(1000) // Revenue: credit increases
  })

  it('should generate a trial balance', async () => {
    const { cash, revenue } = await setupAccounting()

    await JournalEntry.create({
      orgId, entryNumber: 'JE-2025-00001', date: new Date('2025-01-15'),
      fiscalPeriodId: periodId, description: 'Sale', type: 'standard', status: 'posted',
      lines: [
        { accountId: cash._id, debit: 5000, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 5000, baseCredit: 0 },
        { accountId: revenue._id, debit: 0, credit: 5000, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 5000 },
      ],
      totalDebit: 5000, totalCredit: 5000, createdBy: userId,
    })

    const tb = await getTrialBalance(orgId)
    expect(tb.length).toBe(2)

    const totalDebit = tb.reduce((sum, r) => sum + r.debit, 0)
    const totalCredit = tb.reduce((sum, r) => sum + r.credit, 0)
    expect(totalDebit).toBe(totalCredit) // Trial balance must balance
  })

  it('should reject unbalanced journal entries on post', async () => {
    const { cash, revenue } = await setupAccounting()

    const entry = await JournalEntry.create({
      orgId, entryNumber: 'JE-2025-00001', date: new Date('2025-01-15'),
      fiscalPeriodId: periodId, description: 'Bad entry', type: 'standard', status: 'draft',
      lines: [
        { accountId: cash._id, debit: 1000, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 1000, baseCredit: 0 },
        { accountId: revenue._id, debit: 0, credit: 500, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 500 },
      ],
      totalDebit: 1000, totalCredit: 500, createdBy: userId,
    })

    await expect(postJournalEntry(String(entry._id), userId)).rejects.toThrow('Total debits must equal total credits')
  })
})

describe('Accounting Pagination', () => {
  it('should paginate accounts', async () => {
    const org = await createTestOrg()
    for (let i = 0; i < 15; i++) {
      await createTestAccount(org._id, { code: `${1000 + i}`, name: `Account ${String(i).padStart(2, '0')}` })
    }
    const p0 = await paginateQuery(Account, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)
    expect(p0.totalPages).toBe(2)

    const p1 = await paginateQuery(Account, { orgId: org._id }, { page: '1' })
    expect(p1.items).toHaveLength(5)

    const all = await paginateQuery(Account, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate accounts with sort', async () => {
    const org = await createTestOrg()
    await createTestAccount(org._id, { code: '3000', name: 'Equity' })
    await createTestAccount(org._id, { code: '1000', name: 'Assets' })
    await createTestAccount(org._id, { code: '2000', name: 'Debt' })

    const sorted = await paginateQuery(Account, { orgId: org._id }, { sortBy: 'code', sortOrder: 'asc' })
    expect(sorted.items[0].code).toBe('1000')
    expect(sorted.items[1].code).toBe('2000')
    expect(sorted.items[2].code).toBe('3000')
  })

  it('should paginate journal entries', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)
    for (let i = 0; i < 15; i++) {
      await createTestJournalEntry(org._id, fp._id, user._id, { entryNumber: `JE-${String(i).padStart(3, '0')}` })
    }
    const p0 = await paginateQuery(JournalEntry, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(JournalEntry, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate bank accounts', async () => {
    const org = await createTestOrg()
    for (let i = 0; i < 15; i++) {
      await createTestBankAccount(org._id, { name: `Bank ${String(i).padStart(2, '0')}` })
    }
    const p0 = await paginateQuery(BankAccount, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(BankAccount, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate exchange rates', async () => {
    const org = await createTestOrg()
    for (let i = 0; i < 15; i++) {
      await createTestExchangeRate(org._id, { rate: 0.9 + i * 0.01, date: new Date(2025, 0, i + 1) })
    }
    const p0 = await paginateQuery(ExchangeRate, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(ExchangeRate, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate fixed assets', async () => {
    const org = await createTestOrg()
    for (let i = 0; i < 15; i++) {
      await createTestFixedAsset(org._id, { code: `FA-${String(i).padStart(3, '0')}`, name: `Asset ${i}` })
    }
    const p0 = await paginateQuery(FixedAsset, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(FixedAsset, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate fiscal years', async () => {
    const org = await createTestOrg()
    for (let i = 0; i < 15; i++) {
      await createTestFiscalYear(org._id, {
        name: `FY ${2010 + i}`,
        startDate: new Date(`${2010 + i}-01-01`),
        endDate: new Date(`${2010 + i}-12-31`),
      })
    }
    const p0 = await paginateQuery(FiscalYear, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(FiscalYear, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate fiscal periods', async () => {
    const org = await createTestOrg()
    const fy = await createTestFiscalYear(org._id)
    for (let i = 0; i < 15; i++) {
      await createTestFiscalPeriod(org._id, fy._id, { name: `Period ${i + 1}`, number: i + 1 })
    }
    const p0 = await paginateQuery(FiscalPeriod, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(FiscalPeriod, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate bank reconciliations', async () => {
    const org = await createTestOrg()
    const bankAccount = await createTestBankAccount(org._id)
    for (let i = 0; i < 15; i++) {
      await createTestBankReconciliation(org._id, bankAccount._id, { statementDate: new Date(2025, 0, i + 1) })
    }
    const p0 = await paginateQuery(BankReconciliation, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(BankReconciliation, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate tax returns', async () => {
    const org = await createTestOrg()
    for (let i = 0; i < 15; i++) {
      await createTestTaxReturn(org._id, {
        period: { from: new Date(2025, i % 12, 1), to: new Date(2025, (i % 12) + 1, 0) },
      })
    }
    const p0 = await paginateQuery(TaxReturn, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(TaxReturn, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })
})
