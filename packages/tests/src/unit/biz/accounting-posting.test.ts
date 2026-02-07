import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../../setup'
import {
  postJournalEntry,
  voidJournalEntry,
  getTrialBalance,
  getProfitLoss,
} from 'services/biz/accounting.service'
import { Account, JournalEntry } from 'db/models'
import {
  createTestOrg,
  createTestUser,
  createTestAccount,
  createTestFiscalYear,
  createTestFiscalPeriod,
  createTestJournalEntry,
} from '../../helpers/factories'
import { mongoose } from 'db/connection'
const { Types } = mongoose

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

// ---------------------------------------------------------------------------
// postJournalEntry
// ---------------------------------------------------------------------------
describe('postJournalEntry', () => {
  it('should post a balanced draft journal entry (draft -> posted)', async () => {
    const org = await createTestOrg({ slug: 'post-je-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const cashAccount = await createTestAccount(org._id, { code: '1000', name: 'Cash', type: 'asset', subType: 'current_asset' })
    const revenueAccount = await createTestAccount(org._id, { code: '4000', name: 'Sales Revenue', type: 'revenue', subType: 'operating_revenue' })

    const entry = await createTestJournalEntry(org._id, fp._id, user._id, {
      lines: [
        { accountId: cashAccount._id, debit: 500, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 500, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 500, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 500 },
      ],
      totalDebit: 500,
      totalCredit: 500,
    })

    const posted = await postJournalEntry(String(entry._id), String(user._id))
    expect(posted.status).toBe('posted')
  })

  it('should increase asset account balance on debit (debit-normal type)', async () => {
    const org = await createTestOrg({ slug: 'asset-debit-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const cashAccount = await createTestAccount(org._id, { code: '1010', name: 'Cash', type: 'asset', subType: 'current_asset', balance: 0 })
    const equityAccount = await createTestAccount(org._id, { code: '3000', name: 'Owner Equity', type: 'equity', subType: 'owner_equity' })

    const entry = await createTestJournalEntry(org._id, fp._id, user._id, {
      lines: [
        { accountId: cashAccount._id, debit: 1000, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 1000, baseCredit: 0 },
        { accountId: equityAccount._id, debit: 0, credit: 1000, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 1000 },
      ],
      totalDebit: 1000,
      totalCredit: 1000,
    })

    await postJournalEntry(String(entry._id), String(user._id))
    const updated = await Account.findById(cashAccount._id)
    expect(updated!.balance).toBe(1000) // debit-normal: +baseDebit - baseCredit = 1000
  })

  it('should increase liability account balance on credit (credit-normal type)', async () => {
    const org = await createTestOrg({ slug: 'liability-credit-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const expenseAccount = await createTestAccount(org._id, { code: '5010', name: 'Office Supplies', type: 'expense', subType: 'operating_expense' })
    const apAccount = await createTestAccount(org._id, { code: '2000', name: 'Accounts Payable', type: 'liability', subType: 'current_liability', balance: 0 })

    const entry = await createTestJournalEntry(org._id, fp._id, user._id, {
      lines: [
        { accountId: expenseAccount._id, debit: 200, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 200, baseCredit: 0 },
        { accountId: apAccount._id, debit: 0, credit: 200, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 200 },
      ],
      totalDebit: 200,
      totalCredit: 200,
    })

    await postJournalEntry(String(entry._id), String(user._id))
    const updated = await Account.findById(apAccount._id)
    expect(updated!.balance).toBe(200) // credit-normal: +baseCredit - baseDebit = 200
  })

  it('should update equity account balance correctly (credit-normal)', async () => {
    const org = await createTestOrg({ slug: 'equity-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const cashAccount = await createTestAccount(org._id, { code: '1020', name: 'Cash', type: 'asset', subType: 'current_asset' })
    const equityAccount = await createTestAccount(org._id, { code: '3010', name: 'Capital', type: 'equity', subType: 'owner_equity', balance: 0 })

    const entry = await createTestJournalEntry(org._id, fp._id, user._id, {
      lines: [
        { accountId: cashAccount._id, debit: 5000, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 5000, baseCredit: 0 },
        { accountId: equityAccount._id, debit: 0, credit: 5000, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 5000 },
      ],
      totalDebit: 5000,
      totalCredit: 5000,
    })

    await postJournalEntry(String(entry._id), String(user._id))
    const updated = await Account.findById(equityAccount._id)
    expect(updated!.balance).toBe(5000)
  })

  it('should update revenue account balance correctly (credit-normal)', async () => {
    const org = await createTestOrg({ slug: 'revenue-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const arAccount = await createTestAccount(org._id, { code: '1100', name: 'Accounts Receivable', type: 'asset', subType: 'current_asset' })
    const revenueAccount = await createTestAccount(org._id, { code: '4010', name: 'Service Revenue', type: 'revenue', subType: 'operating_revenue', balance: 0 })

    const entry = await createTestJournalEntry(org._id, fp._id, user._id, {
      lines: [
        { accountId: arAccount._id, debit: 3000, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 3000, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 3000, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 3000 },
      ],
      totalDebit: 3000,
      totalCredit: 3000,
    })

    await postJournalEntry(String(entry._id), String(user._id))
    const updated = await Account.findById(revenueAccount._id)
    expect(updated!.balance).toBe(3000) // credit-normal: +baseCredit - baseDebit = 3000
  })

  it('should update expense account balance correctly (debit-normal)', async () => {
    const org = await createTestOrg({ slug: 'expense-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const expenseAccount = await createTestAccount(org._id, { code: '5020', name: 'Rent Expense', type: 'expense', subType: 'operating_expense', balance: 0 })
    const cashAccount = await createTestAccount(org._id, { code: '1030', name: 'Cash', type: 'asset', subType: 'current_asset' })

    const entry = await createTestJournalEntry(org._id, fp._id, user._id, {
      lines: [
        { accountId: expenseAccount._id, debit: 1500, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 1500, baseCredit: 0 },
        { accountId: cashAccount._id, debit: 0, credit: 1500, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 1500 },
      ],
      totalDebit: 1500,
      totalCredit: 1500,
    })

    await postJournalEntry(String(entry._id), String(user._id))
    const updated = await Account.findById(expenseAccount._id)
    expect(updated!.balance).toBe(1500) // debit-normal: +baseDebit - baseCredit = 1500
  })

  it('should reject an unbalanced entry (tolerance > 0.01)', async () => {
    const org = await createTestOrg({ slug: 'unbalanced-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const cashAccount = await createTestAccount(org._id, { code: '1040', name: 'Cash', type: 'asset', subType: 'current_asset' })
    const revenueAccount = await createTestAccount(org._id, { code: '4020', name: 'Revenue', type: 'revenue', subType: 'operating_revenue' })

    const entry = await createTestJournalEntry(org._id, fp._id, user._id, {
      lines: [
        { accountId: cashAccount._id, debit: 1000, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 1000, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 999, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 999 },
      ],
      totalDebit: 1000,
      totalCredit: 999,
    })

    await expect(postJournalEntry(String(entry._id), String(user._id))).rejects.toThrow('Total debits must equal total credits')
  })

  it('should accept an entry within rounding tolerance (<= 0.01)', async () => {
    const org = await createTestOrg({ slug: 'tolerance-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const cashAccount = await createTestAccount(org._id, { code: '1050', name: 'Cash', type: 'asset', subType: 'current_asset' })
    const revenueAccount = await createTestAccount(org._id, { code: '4030', name: 'Revenue', type: 'revenue', subType: 'operating_revenue' })

    const entry = await createTestJournalEntry(org._id, fp._id, user._id, {
      lines: [
        { accountId: cashAccount._id, debit: 100, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 100, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 100.005, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 100.005 },
      ],
      totalDebit: 100,
      totalCredit: 100.005,
    })

    const posted = await postJournalEntry(String(entry._id), String(user._id))
    expect(posted.status).toBe('posted')
  })

  it('should reject an already-posted entry', async () => {
    const org = await createTestOrg({ slug: 'already-posted-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const cashAccount = await createTestAccount(org._id, { code: '1060', name: 'Cash', type: 'asset', subType: 'current_asset' })
    const revenueAccount = await createTestAccount(org._id, { code: '4040', name: 'Revenue', type: 'revenue', subType: 'operating_revenue' })

    const entry = await createTestJournalEntry(org._id, fp._id, user._id, {
      status: 'posted',
      lines: [
        { accountId: cashAccount._id, debit: 100, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 100, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 100, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 100 },
      ],
      totalDebit: 100,
      totalCredit: 100,
    })

    await expect(postJournalEntry(String(entry._id), String(user._id))).rejects.toThrow('Only draft entries can be posted')
  })

  it('should reject a voided entry', async () => {
    const org = await createTestOrg({ slug: 'voided-post-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const cashAccount = await createTestAccount(org._id, { code: '1070', name: 'Cash', type: 'asset', subType: 'current_asset' })
    const revenueAccount = await createTestAccount(org._id, { code: '4050', name: 'Revenue', type: 'revenue', subType: 'operating_revenue' })

    const entry = await createTestJournalEntry(org._id, fp._id, user._id, {
      status: 'voided',
      lines: [
        { accountId: cashAccount._id, debit: 100, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 100, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 100, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 100 },
      ],
      totalDebit: 100,
      totalCredit: 100,
    })

    await expect(postJournalEntry(String(entry._id), String(user._id))).rejects.toThrow('Only draft entries can be posted')
  })

  it('should set postedBy and postedAt fields', async () => {
    const org = await createTestOrg({ slug: 'posted-fields-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const cashAccount = await createTestAccount(org._id, { code: '1080', name: 'Cash', type: 'asset', subType: 'current_asset' })
    const revenueAccount = await createTestAccount(org._id, { code: '4060', name: 'Revenue', type: 'revenue', subType: 'operating_revenue' })

    const beforePost = new Date()
    const entry = await createTestJournalEntry(org._id, fp._id, user._id, {
      lines: [
        { accountId: cashAccount._id, debit: 250, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 250, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 250, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 250 },
      ],
      totalDebit: 250,
      totalCredit: 250,
    })

    const posted = await postJournalEntry(String(entry._id), String(user._id))
    expect(String(posted.postedBy)).toBe(String(user._id))
    expect(posted.postedAt).toBeDefined()
    expect(posted.postedAt!.getTime()).toBeGreaterThanOrEqual(beforePost.getTime())
  })

  it('should handle multi-line entries with multiple accounts', async () => {
    const org = await createTestOrg({ slug: 'multi-line-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const cashAccount = await createTestAccount(org._id, { code: '1090', name: 'Cash', type: 'asset', subType: 'current_asset', balance: 0 })
    const arAccount = await createTestAccount(org._id, { code: '1200', name: 'AR', type: 'asset', subType: 'current_asset', balance: 0 })
    const revenueAccount = await createTestAccount(org._id, { code: '4070', name: 'Revenue', type: 'revenue', subType: 'operating_revenue', balance: 0 })
    const taxAccount = await createTestAccount(org._id, { code: '2100', name: 'Tax Payable', type: 'liability', subType: 'current_liability', balance: 0 })

    const entry = await createTestJournalEntry(org._id, fp._id, user._id, {
      lines: [
        { accountId: cashAccount._id, debit: 300, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 300, baseCredit: 0 },
        { accountId: arAccount._id, debit: 700, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 700, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 900, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 900 },
        { accountId: taxAccount._id, debit: 0, credit: 100, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 100 },
      ],
      totalDebit: 1000,
      totalCredit: 1000,
    })

    await postJournalEntry(String(entry._id), String(user._id))

    const cashUpdated = await Account.findById(cashAccount._id)
    const arUpdated = await Account.findById(arAccount._id)
    const revenueUpdated = await Account.findById(revenueAccount._id)
    const taxUpdated = await Account.findById(taxAccount._id)

    expect(cashUpdated!.balance).toBe(300)   // debit-normal: +300
    expect(arUpdated!.balance).toBe(700)     // debit-normal: +700
    expect(revenueUpdated!.balance).toBe(900) // credit-normal: +900
    expect(taxUpdated!.balance).toBe(100)    // credit-normal: +100
  })

  it('should throw when entry does not exist', async () => {
    const fakeId = new Types.ObjectId()
    await expect(postJournalEntry(String(fakeId), String(fakeId))).rejects.toThrow('Journal entry not found')
  })
})

// ---------------------------------------------------------------------------
// voidJournalEntry
// ---------------------------------------------------------------------------
describe('voidJournalEntry', () => {
  it('should void a posted entry (posted -> voided)', async () => {
    const org = await createTestOrg({ slug: 'void-je-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const cashAccount = await createTestAccount(org._id, { code: '1300', name: 'Cash', type: 'asset', subType: 'current_asset' })
    const revenueAccount = await createTestAccount(org._id, { code: '4100', name: 'Revenue', type: 'revenue', subType: 'operating_revenue' })

    const entry = await createTestJournalEntry(org._id, fp._id, user._id, {
      lines: [
        { accountId: cashAccount._id, debit: 600, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 600, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 600, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 600 },
      ],
      totalDebit: 600,
      totalCredit: 600,
    })

    await postJournalEntry(String(entry._id), String(user._id))
    const voided = await voidJournalEntry(String(entry._id))
    expect(voided.status).toBe('voided')
  })

  it('should reverse all account balance adjustments', async () => {
    const org = await createTestOrg({ slug: 'void-reverse-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const cashAccount = await createTestAccount(org._id, { code: '1310', name: 'Cash', type: 'asset', subType: 'current_asset', balance: 0 })
    const revenueAccount = await createTestAccount(org._id, { code: '4110', name: 'Revenue', type: 'revenue', subType: 'operating_revenue', balance: 0 })

    const entry = await createTestJournalEntry(org._id, fp._id, user._id, {
      lines: [
        { accountId: cashAccount._id, debit: 800, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 800, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 800, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 800 },
      ],
      totalDebit: 800,
      totalCredit: 800,
    })

    await postJournalEntry(String(entry._id), String(user._id))

    // Verify balances after posting
    let cash = await Account.findById(cashAccount._id)
    let revenue = await Account.findById(revenueAccount._id)
    expect(cash!.balance).toBe(800)
    expect(revenue!.balance).toBe(800)

    // Void and verify balances are reversed
    await voidJournalEntry(String(entry._id))
    cash = await Account.findById(cashAccount._id)
    revenue = await Account.findById(revenueAccount._id)
    expect(cash!.balance).toBe(0)
    expect(revenue!.balance).toBe(0)
  })

  it('should reject voiding a draft entry', async () => {
    const org = await createTestOrg({ slug: 'void-draft-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const entry = await createTestJournalEntry(org._id, fp._id, user._id)
    await expect(voidJournalEntry(String(entry._id))).rejects.toThrow('Only posted entries can be voided')
  })

  it('should reject voiding an already-voided entry', async () => {
    const org = await createTestOrg({ slug: 'void-voided-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const cashAccount = await createTestAccount(org._id, { code: '1320', name: 'Cash', type: 'asset', subType: 'current_asset' })
    const revenueAccount = await createTestAccount(org._id, { code: '4120', name: 'Revenue', type: 'revenue', subType: 'operating_revenue' })

    const entry = await createTestJournalEntry(org._id, fp._id, user._id, {
      lines: [
        { accountId: cashAccount._id, debit: 100, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 100, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 100, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 100 },
      ],
      totalDebit: 100,
      totalCredit: 100,
    })

    await postJournalEntry(String(entry._id), String(user._id))
    await voidJournalEntry(String(entry._id))
    await expect(voidJournalEntry(String(entry._id))).rejects.toThrow('Only posted entries can be voided')
  })
})

// ---------------------------------------------------------------------------
// getTrialBalance
// ---------------------------------------------------------------------------
describe('getTrialBalance', () => {
  it('should return debit/credit per account from posted entries', async () => {
    const org = await createTestOrg({ slug: 'tb-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const cashAccount = await createTestAccount(org._id, { code: '1400', name: 'Cash', type: 'asset', subType: 'current_asset' })
    const revenueAccount = await createTestAccount(org._id, { code: '4200', name: 'Revenue', type: 'revenue', subType: 'operating_revenue' })

    const entry = await createTestJournalEntry(org._id, fp._id, user._id, {
      lines: [
        { accountId: cashAccount._id, debit: 2000, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 2000, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 2000, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 2000 },
      ],
      totalDebit: 2000,
      totalCredit: 2000,
    })
    await postJournalEntry(String(entry._id), String(user._id))

    const rows = await getTrialBalance(String(org._id))
    expect(rows.length).toBe(2)

    const cashRow = rows.find((r) => r.code === '1400')
    const revenueRow = rows.find((r) => r.code === '4200')

    expect(cashRow).toBeDefined()
    expect(cashRow!.debit).toBe(2000)
    expect(cashRow!.credit).toBe(0)

    expect(revenueRow).toBeDefined()
    expect(revenueRow!.debit).toBe(0)
    expect(revenueRow!.credit).toBe(2000)
  })

  it('should return balanced result (total debits == total credits)', async () => {
    const org = await createTestOrg({ slug: 'tb-balanced-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const cashAccount = await createTestAccount(org._id, { code: '1410', name: 'Cash', type: 'asset', subType: 'current_asset' })
    const expenseAccount = await createTestAccount(org._id, { code: '5100', name: 'Expense', type: 'expense', subType: 'operating_expense' })
    const revenueAccount = await createTestAccount(org._id, { code: '4210', name: 'Revenue', type: 'revenue', subType: 'operating_revenue' })
    const apAccount = await createTestAccount(org._id, { code: '2010', name: 'AP', type: 'liability', subType: 'current_liability' })

    // Entry 1: Cash debit / Revenue credit
    const e1 = await createTestJournalEntry(org._id, fp._id, user._id, {
      entryNumber: `JE-TB-1-${Date.now()}`,
      lines: [
        { accountId: cashAccount._id, debit: 1000, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 1000, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 1000, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 1000 },
      ],
      totalDebit: 1000,
      totalCredit: 1000,
    })
    await postJournalEntry(String(e1._id), String(user._id))

    // Entry 2: Expense debit / AP credit
    const e2 = await createTestJournalEntry(org._id, fp._id, user._id, {
      entryNumber: `JE-TB-2-${Date.now()}`,
      lines: [
        { accountId: expenseAccount._id, debit: 400, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 400, baseCredit: 0 },
        { accountId: apAccount._id, debit: 0, credit: 400, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 400 },
      ],
      totalDebit: 400,
      totalCredit: 400,
    })
    await postJournalEntry(String(e2._id), String(user._id))

    const rows = await getTrialBalance(String(org._id))
    const totalDebit = rows.reduce((sum, r) => sum + r.debit, 0)
    const totalCredit = rows.reduce((sum, r) => sum + r.credit, 0)
    expect(totalDebit).toBe(totalCredit)
  })

  it('should filter by fiscal period when provided', async () => {
    const org = await createTestOrg({ slug: 'tb-period-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)

    const fp1 = await createTestFiscalPeriod(org._id, fy._id, { name: 'January', number: 1, startDate: new Date('2025-01-01'), endDate: new Date('2025-01-31') })
    const fp2 = await createTestFiscalPeriod(org._id, fy._id, { name: 'February', number: 2, startDate: new Date('2025-02-01'), endDate: new Date('2025-02-28') })

    const cashAccount = await createTestAccount(org._id, { code: '1420', name: 'Cash', type: 'asset', subType: 'current_asset' })
    const revenueAccount = await createTestAccount(org._id, { code: '4220', name: 'Revenue', type: 'revenue', subType: 'operating_revenue' })

    // Entry in period 1
    const e1 = await createTestJournalEntry(org._id, fp1._id, user._id, {
      entryNumber: `JE-P1-${Date.now()}`,
      lines: [
        { accountId: cashAccount._id, debit: 500, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 500, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 500, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 500 },
      ],
      totalDebit: 500,
      totalCredit: 500,
    })
    await postJournalEntry(String(e1._id), String(user._id))

    // Entry in period 2
    const e2 = await createTestJournalEntry(org._id, fp2._id, user._id, {
      entryNumber: `JE-P2-${Date.now()}`,
      lines: [
        { accountId: cashAccount._id, debit: 300, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 300, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 300, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 300 },
      ],
      totalDebit: 300,
      totalCredit: 300,
    })
    await postJournalEntry(String(e2._id), String(user._id))

    // Filter by period 1 only
    const rows = await getTrialBalance(String(org._id), String(fp1._id))
    const cashRow = rows.find((r) => r.code === '1420')
    expect(cashRow).toBeDefined()
    expect(cashRow!.debit).toBe(500) // Only period 1 amount
  })

  it('should return empty result when no posted entries', async () => {
    const org = await createTestOrg({ slug: 'tb-empty-org' })
    const rows = await getTrialBalance(String(org._id))
    expect(rows).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// getProfitLoss
// ---------------------------------------------------------------------------
describe('getProfitLoss', () => {
  it('should separate revenue and expense accounts', async () => {
    const org = await createTestOrg({ slug: 'pl-separate-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const cashAccount = await createTestAccount(org._id, { code: '1500', name: 'Cash', type: 'asset', subType: 'current_asset' })
    const revenueAccount = await createTestAccount(org._id, { code: '4300', name: 'Sales', type: 'revenue', subType: 'operating_revenue' })
    const expenseAccount = await createTestAccount(org._id, { code: '5200', name: 'Rent', type: 'expense', subType: 'operating_expense' })

    // Revenue entry
    const e1 = await createTestJournalEntry(org._id, fp._id, user._id, {
      entryNumber: `JE-PL1-${Date.now()}`,
      date: new Date('2025-01-15'),
      lines: [
        { accountId: cashAccount._id, debit: 5000, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 5000, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 5000, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 5000 },
      ],
      totalDebit: 5000,
      totalCredit: 5000,
    })
    await postJournalEntry(String(e1._id), String(user._id))

    // Expense entry
    const e2 = await createTestJournalEntry(org._id, fp._id, user._id, {
      entryNumber: `JE-PL2-${Date.now()}`,
      date: new Date('2025-01-20'),
      lines: [
        { accountId: expenseAccount._id, debit: 2000, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 2000, baseCredit: 0 },
        { accountId: cashAccount._id, debit: 0, credit: 2000, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 2000 },
      ],
      totalDebit: 2000,
      totalCredit: 2000,
    })
    await postJournalEntry(String(e2._id), String(user._id))

    const pl = await getProfitLoss(String(org._id), new Date('2025-01-01'), new Date('2025-01-31'))
    expect(pl.revenue.length).toBe(1)
    expect(pl.expenses.length).toBe(1)
    expect(pl.revenue[0].account).toContain('Sales')
    expect(pl.expenses[0].account).toContain('Rent')
  })

  it('should calculate totalRevenue, totalExpenses, netIncome correctly', async () => {
    const org = await createTestOrg({ slug: 'pl-calc-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const cashAccount = await createTestAccount(org._id, { code: '1510', name: 'Cash', type: 'asset', subType: 'current_asset' })
    const revenueAccount = await createTestAccount(org._id, { code: '4310', name: 'Sales', type: 'revenue', subType: 'operating_revenue' })
    const expenseAccount = await createTestAccount(org._id, { code: '5210', name: 'Wages', type: 'expense', subType: 'operating_expense' })

    // Revenue: 10000
    const e1 = await createTestJournalEntry(org._id, fp._id, user._id, {
      entryNumber: `JE-CALC1-${Date.now()}`,
      date: new Date('2025-01-10'),
      lines: [
        { accountId: cashAccount._id, debit: 10000, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 10000, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 10000, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 10000 },
      ],
      totalDebit: 10000,
      totalCredit: 10000,
    })
    await postJournalEntry(String(e1._id), String(user._id))

    // Expense: 3500
    const e2 = await createTestJournalEntry(org._id, fp._id, user._id, {
      entryNumber: `JE-CALC2-${Date.now()}`,
      date: new Date('2025-01-25'),
      lines: [
        { accountId: expenseAccount._id, debit: 3500, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 3500, baseCredit: 0 },
        { accountId: cashAccount._id, debit: 0, credit: 3500, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 3500 },
      ],
      totalDebit: 3500,
      totalCredit: 3500,
    })
    await postJournalEntry(String(e2._id), String(user._id))

    const pl = await getProfitLoss(String(org._id), new Date('2025-01-01'), new Date('2025-01-31'))
    expect(pl.totalRevenue).toBe(10000)
    expect(pl.totalExpenses).toBe(3500)
    expect(pl.netIncome).toBe(6500)
  })

  it('should filter entries by date range', async () => {
    const org = await createTestOrg({ slug: 'pl-date-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const cashAccount = await createTestAccount(org._id, { code: '1520', name: 'Cash', type: 'asset', subType: 'current_asset' })
    const revenueAccount = await createTestAccount(org._id, { code: '4320', name: 'Sales', type: 'revenue', subType: 'operating_revenue' })

    // In-range entry (January)
    const e1 = await createTestJournalEntry(org._id, fp._id, user._id, {
      entryNumber: `JE-DATE1-${Date.now()}`,
      date: new Date('2025-01-15'),
      lines: [
        { accountId: cashAccount._id, debit: 1000, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 1000, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 1000, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 1000 },
      ],
      totalDebit: 1000,
      totalCredit: 1000,
    })
    await postJournalEntry(String(e1._id), String(user._id))

    // Out-of-range entry (March)
    const e2 = await createTestJournalEntry(org._id, fp._id, user._id, {
      entryNumber: `JE-DATE2-${Date.now()}`,
      date: new Date('2025-03-15'),
      lines: [
        { accountId: cashAccount._id, debit: 2000, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 2000, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 2000, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 2000 },
      ],
      totalDebit: 2000,
      totalCredit: 2000,
    })
    await postJournalEntry(String(e2._id), String(user._id))

    // Only January
    const pl = await getProfitLoss(String(org._id), new Date('2025-01-01'), new Date('2025-01-31'))
    expect(pl.totalRevenue).toBe(1000) // Only the in-range entry
  })

  it('should use credit-debit for revenue and -(credit-debit) for expenses', async () => {
    const org = await createTestOrg({ slug: 'pl-formula-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const cashAccount = await createTestAccount(org._id, { code: '1530', name: 'Cash', type: 'asset', subType: 'current_asset' })
    const revenueAccount = await createTestAccount(org._id, { code: '4330', name: 'Revenue', type: 'revenue', subType: 'operating_revenue' })
    const expenseAccount = await createTestAccount(org._id, { code: '5220', name: 'Utilities', type: 'expense', subType: 'operating_expense' })

    // Revenue: credit 3000, debit 0 -> revenue amount = 3000 - 0 = 3000
    const e1 = await createTestJournalEntry(org._id, fp._id, user._id, {
      entryNumber: `JE-FRM1-${Date.now()}`,
      date: new Date('2025-01-10'),
      lines: [
        { accountId: cashAccount._id, debit: 3000, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 3000, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 3000, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 3000 },
      ],
      totalDebit: 3000,
      totalCredit: 3000,
    })
    await postJournalEntry(String(e1._id), String(user._id))

    // Expense: debit 1200, credit 0 -> credit - debit = -1200, expense amount = -(-1200) = 1200
    const e2 = await createTestJournalEntry(org._id, fp._id, user._id, {
      entryNumber: `JE-FRM2-${Date.now()}`,
      date: new Date('2025-01-20'),
      lines: [
        { accountId: expenseAccount._id, debit: 1200, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 1200, baseCredit: 0 },
        { accountId: cashAccount._id, debit: 0, credit: 1200, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 1200 },
      ],
      totalDebit: 1200,
      totalCredit: 1200,
    })
    await postJournalEntry(String(e2._id), String(user._id))

    const pl = await getProfitLoss(String(org._id), new Date('2025-01-01'), new Date('2025-01-31'))

    // Revenue uses credit - debit pattern (stored directly)
    expect(pl.revenue[0].amount).toBe(3000)
    // Expenses use -(credit - debit) pattern (negated)
    expect(pl.expenses[0].amount).toBe(1200)
  })

  it('should exclude non-posted entries', async () => {
    const org = await createTestOrg({ slug: 'pl-draft-org' })
    const user = await createTestUser(org._id)
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)

    const cashAccount = await createTestAccount(org._id, { code: '1540', name: 'Cash', type: 'asset', subType: 'current_asset' })
    const revenueAccount = await createTestAccount(org._id, { code: '4340', name: 'Revenue', type: 'revenue', subType: 'operating_revenue' })

    // Posted entry
    const e1 = await createTestJournalEntry(org._id, fp._id, user._id, {
      entryNumber: `JE-NP1-${Date.now()}`,
      date: new Date('2025-01-10'),
      lines: [
        { accountId: cashAccount._id, debit: 500, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 500, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 500, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 500 },
      ],
      totalDebit: 500,
      totalCredit: 500,
    })
    await postJournalEntry(String(e1._id), String(user._id))

    // Draft entry (should be excluded)
    await createTestJournalEntry(org._id, fp._id, user._id, {
      entryNumber: `JE-NP2-${Date.now()}`,
      date: new Date('2025-01-20'),
      status: 'draft',
      lines: [
        { accountId: cashAccount._id, debit: 9999, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 9999, baseCredit: 0 },
        { accountId: revenueAccount._id, debit: 0, credit: 9999, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 9999 },
      ],
      totalDebit: 9999,
      totalCredit: 9999,
    })

    const pl = await getProfitLoss(String(org._id), new Date('2025-01-01'), new Date('2025-01-31'))
    expect(pl.totalRevenue).toBe(500) // Only the posted entry
  })

  it('should return zero values when no entries in date range', async () => {
    const org = await createTestOrg({ slug: 'pl-empty-org' })
    await createTestAccount(org._id, { code: '4350', name: 'Revenue', type: 'revenue', subType: 'operating_revenue' })

    const pl = await getProfitLoss(String(org._id), new Date('2025-06-01'), new Date('2025-06-30'))
    expect(pl.totalRevenue).toBe(0)
    expect(pl.totalExpenses).toBe(0)
    expect(pl.netIncome).toBe(0)
    // Revenue account exists but has 0 amount (no entries in range)
    expect(pl.revenue).toHaveLength(1)
    expect(pl.revenue[0].amount).toBe(0)
    expect(pl.expenses).toEqual([])
  })
})
