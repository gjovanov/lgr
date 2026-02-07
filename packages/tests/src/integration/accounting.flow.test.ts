import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { Account, FiscalYear, FiscalPeriod, JournalEntry, Org, User } from 'db/models'
import { postJournalEntry, getTrialBalance } from 'services/biz/accounting.service'

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
