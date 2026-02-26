import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../../setup'
import { accountDao } from 'services/dao/accounting/account.dao'
import { journalEntryDao } from 'services/dao/accounting/journal-entry.dao'
import { fiscalYearDao } from 'services/dao/accounting/fiscal-year.dao'
import { fiscalPeriodDao } from 'services/dao/accounting/fiscal-period.dao'
import { fixedAssetDao } from 'services/dao/accounting/fixed-asset.dao'
import { bankAccountDao } from 'services/dao/accounting/bank-account.dao'
import { mongoose } from 'db/connection'
const { Types } = mongoose
import {
  createTestOrg,
  createTestAccount,
  createTestJournalEntry,
  createTestFiscalYear,
  createTestFiscalPeriod,
  createTestFixedAsset,
  createTestBankAccount,
} from '../../helpers/factories'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('AccountDao', () => {
  it('should create an account and find it by ID', async () => {
    const org = await createTestOrg({ slug: 'acct-create-org' })
    const account = await createTestAccount(org._id, {
      code: '1000',
      name: 'Cash',
      type: 'asset',
    })

    expect(account).toBeDefined()
    expect(account._id).toBeDefined()

    const found = await accountDao.findById(String(account._id))
    expect(found).toBeDefined()
    expect(found!.code).toBe('1000')
    expect(found!.name).toBe('Cash')
  })

  it('should find account by code', async () => {
    const org = await createTestOrg({ slug: 'acct-code-org' })
    await createTestAccount(org._id, { code: '2000', name: 'Accounts Payable', type: 'liability' })

    const found = await accountDao.findByCode(String(org._id), '2000')
    expect(found).toBeDefined()
    expect(found!.code).toBe('2000')
    expect(found!.name).toBe('Accounts Payable')
  })

  it('should find accounts by type', async () => {
    const org = await createTestOrg({ slug: 'acct-type-org' })
    await createTestAccount(org._id, { code: '1010', name: 'Cash', type: 'asset' })
    await createTestAccount(org._id, { code: '1020', name: 'Bank', type: 'asset' })
    await createTestAccount(org._id, { code: '4000', name: 'Revenue', type: 'revenue' })

    const assets = await accountDao.findByType(String(org._id), 'asset')
    expect(assets).toHaveLength(2)
    expect(assets.every((a) => a.type === 'asset')).toBe(true)
  })

  it('should find child accounts by parentId', async () => {
    const org = await createTestOrg({ slug: 'acct-children-org' })
    const parent = await createTestAccount(org._id, { code: '1000', name: 'Assets', type: 'asset' })
    await createTestAccount(org._id, { code: '1010', name: 'Cash', type: 'asset', parentId: parent._id })
    await createTestAccount(org._id, { code: '1020', name: 'Bank', type: 'asset', parentId: parent._id })
    await createTestAccount(org._id, { code: '2000', name: 'Liabilities', type: 'liability' })

    const children = await accountDao.findChildren(String(org._id), String(parent._id))
    expect(children).toHaveLength(2)
    expect(children.map((c) => c.code).sort()).toEqual(['1010', '1020'])
  })

  it('should find all accounts as a tree sorted by code', async () => {
    const org = await createTestOrg({ slug: 'acct-tree-org' })
    await createTestAccount(org._id, { code: '3000', name: 'Equity', type: 'equity' })
    await createTestAccount(org._id, { code: '1000', name: 'Assets', type: 'asset' })
    await createTestAccount(org._id, { code: '2000', name: 'Liabilities', type: 'liability' })

    const tree = await accountDao.findTree(String(org._id))
    expect(tree).toHaveLength(3)
    expect(tree[0].code).toBe('1000')
    expect(tree[1].code).toBe('2000')
    expect(tree[2].code).toBe('3000')
  })
})

describe('JournalEntryDao', () => {
  it('should find entries by date range', async () => {
    const org = await createTestOrg({ slug: 'je-daterange-org' })
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)
    const userId = new Types.ObjectId()

    await createTestJournalEntry(org._id, fp._id, userId, {
      entryNumber: 'JE-DR-001',
      date: new Date('2025-03-15'),
    })
    await createTestJournalEntry(org._id, fp._id, userId, {
      entryNumber: 'JE-DR-002',
      date: new Date('2025-06-15'),
    })
    await createTestJournalEntry(org._id, fp._id, userId, {
      entryNumber: 'JE-DR-003',
      date: new Date('2025-09-15'),
    })

    const results = await journalEntryDao.findByDateRange(
      String(org._id),
      new Date('2025-01-01'),
      new Date('2025-06-30'),
    )
    expect(results).toHaveLength(2)
    expect(results.map((e) => e.entryNumber).sort()).toEqual(['JE-DR-001', 'JE-DR-002'])
  })

  it('should find entries by status', async () => {
    const org = await createTestOrg({ slug: 'je-status-org' })
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)
    const userId = new Types.ObjectId()

    await createTestJournalEntry(org._id, fp._id, userId, {
      entryNumber: 'JE-S-001',
      status: 'draft',
    })
    await createTestJournalEntry(org._id, fp._id, userId, {
      entryNumber: 'JE-S-002',
      status: 'posted',
    })
    await createTestJournalEntry(org._id, fp._id, userId, {
      entryNumber: 'JE-S-003',
      status: 'draft',
    })

    const drafts = await journalEntryDao.findByStatus(String(org._id), 'draft')
    expect(drafts).toHaveLength(2)
    expect(drafts.every((e) => e.status === 'draft')).toBe(true)

    const posted = await journalEntryDao.findByStatus(String(org._id), 'posted')
    expect(posted).toHaveLength(1)
    expect(posted[0].entryNumber).toBe('JE-S-002')
  })

  it('should find entries by account in lines', async () => {
    const org = await createTestOrg({ slug: 'je-account-org' })
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)
    const userId = new Types.ObjectId()
    const targetAccountId = new Types.ObjectId()
    const otherAccountId = new Types.ObjectId()

    await createTestJournalEntry(org._id, fp._id, userId, {
      entryNumber: 'JE-A-001',
      lines: [
        { accountId: targetAccountId, debit: 500, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 500, baseCredit: 0 },
        { accountId: otherAccountId, debit: 0, credit: 500, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 500 },
      ],
    })
    await createTestJournalEntry(org._id, fp._id, userId, {
      entryNumber: 'JE-A-002',
      lines: [
        { accountId: otherAccountId, debit: 300, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 300, baseCredit: 0 },
        { accountId: new Types.ObjectId(), debit: 0, credit: 300, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 300 },
      ],
    })

    const results = await journalEntryDao.findByAccount(String(org._id), String(targetAccountId))
    expect(results).toHaveLength(1)
    expect(results[0].entryNumber).toBe('JE-A-001')
  })

  it('should find entries by fiscal period', async () => {
    const org = await createTestOrg({ slug: 'je-period-org' })
    const fy = await createTestFiscalYear(org._id)
    const fp1 = await createTestFiscalPeriod(org._id, fy._id, {
      name: 'January',
      number: 1,
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-31'),
    })
    const fp2 = await createTestFiscalPeriod(org._id, fy._id, {
      name: 'February',
      number: 2,
      startDate: new Date('2025-02-01'),
      endDate: new Date('2025-02-28'),
    })
    const userId = new Types.ObjectId()

    await createTestJournalEntry(org._id, fp1._id, userId, { entryNumber: 'JE-P-001' })
    await createTestJournalEntry(org._id, fp1._id, userId, { entryNumber: 'JE-P-002' })
    await createTestJournalEntry(org._id, fp2._id, userId, { entryNumber: 'JE-P-003' })

    const fp1Entries = await journalEntryDao.findByPeriod(String(org._id), String(fp1._id))
    expect(fp1Entries).toHaveLength(2)

    const fp2Entries = await journalEntryDao.findByPeriod(String(org._id), String(fp2._id))
    expect(fp2Entries).toHaveLength(1)
    expect(fp2Entries[0].entryNumber).toBe('JE-P-003')
  })

  it('should auto-increment entry number via getNextEntryNumber', async () => {
    const org = await createTestOrg({ slug: 'je-autonum-org' })
    const fy = await createTestFiscalYear(org._id)
    const fp = await createTestFiscalPeriod(org._id, fy._id)
    const userId = new Types.ObjectId()
    const year = new Date().getFullYear()

    const first = await journalEntryDao.getNextEntryNumber(String(org._id))
    expect(first).toBe(`JE-${year}-00001`)

    await createTestJournalEntry(org._id, fp._id, userId, {
      entryNumber: `JE-${year}-00001`,
    })

    const second = await journalEntryDao.getNextEntryNumber(String(org._id))
    expect(second).toBe(`JE-${year}-00002`)
  })
})

describe('FiscalYearDao', () => {
  it('should find the current open fiscal year', async () => {
    const org = await createTestOrg({ slug: 'fy-current-org' })
    await createTestFiscalYear(org._id, {
      name: 'FY 2024',
      startDate: new Date('2024-01-01'),
      endDate: new Date('2024-12-31'),
      status: 'closed',
    })
    await createTestFiscalYear(org._id, {
      name: 'FY 2025',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-12-31'),
      status: 'open',
    })

    const current = await fiscalYearDao.findCurrent(String(org._id))
    expect(current).toBeDefined()
    expect(current!.name).toBe('FY 2025')
    expect(current!.status).toBe('open')
  })

  it('should find fiscal year containing a given date', async () => {
    const org = await createTestOrg({ slug: 'fy-daterange-org' })
    await createTestFiscalYear(org._id, {
      name: 'FY 2024',
      startDate: new Date('2024-01-01'),
      endDate: new Date('2024-12-31'),
      status: 'closed',
    })
    await createTestFiscalYear(org._id, {
      name: 'FY 2025',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-12-31'),
      status: 'open',
    })

    const found = await fiscalYearDao.findByDateRange(String(org._id), new Date('2024-06-15'))
    expect(found).toBeDefined()
    expect(found!.name).toBe('FY 2024')
  })

  it('should return null when no fiscal year matches', async () => {
    const org = await createTestOrg({ slug: 'fy-null-org' })
    await createTestFiscalYear(org._id, {
      name: 'FY 2025',
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-12-31'),
    })

    const found = await fiscalYearDao.findByDateRange(String(org._id), new Date('2023-06-15'))
    expect(found).toBeNull()
  })
})

describe('FixedAssetDao', () => {
  it('should find fixed assets by category', async () => {
    const org = await createTestOrg({ slug: 'fa-category-org' })
    await createTestFixedAsset(org._id, { code: 'FA-001', name: 'Laptop', category: 'Equipment' })
    await createTestFixedAsset(org._id, { code: 'FA-002', name: 'Desk', category: 'Furniture' })
    await createTestFixedAsset(org._id, { code: 'FA-003', name: 'Printer', category: 'Equipment' })

    const equipment = await fixedAssetDao.findByCategory(String(org._id), 'Equipment')
    expect(equipment).toHaveLength(2)
    expect(equipment.every((a) => a.category === 'Equipment')).toBe(true)

    const furniture = await fixedAssetDao.findByCategory(String(org._id), 'Furniture')
    expect(furniture).toHaveLength(1)
    expect(furniture[0].name).toBe('Desk')
  })

  it('should find only active fixed assets', async () => {
    const org = await createTestOrg({ slug: 'fa-active-org' })
    await createTestFixedAsset(org._id, { code: 'FA-010', name: 'Active Laptop', status: 'active' })
    await createTestFixedAsset(org._id, { code: 'FA-011', name: 'Disposed Desk', status: 'disposed' })
    await createTestFixedAsset(org._id, { code: 'FA-012', name: 'Active Server', status: 'active' })

    const active = await fixedAssetDao.findActive(String(org._id))
    expect(active).toHaveLength(2)
    expect(active.every((a) => a.status === 'active')).toBe(true)
  })

  it('should return empty array when no assets match category', async () => {
    const org = await createTestOrg({ slug: 'fa-empty-org' })
    await createTestFixedAsset(org._id, { code: 'FA-020', category: 'Equipment' })

    const vehicles = await fixedAssetDao.findByCategory(String(org._id), 'Vehicle')
    expect(vehicles).toHaveLength(0)
  })
})

describe('BankAccountDao', () => {
  it('should find the default bank account', async () => {
    const org = await createTestOrg({ slug: 'ba-default-org' })
    await createTestBankAccount(org._id, { name: 'Primary Account', isDefault: true })
    await createTestBankAccount(org._id, { name: 'Secondary Account', isDefault: false })

    const defaultAccount = await bankAccountDao.findDefault(String(org._id))
    expect(defaultAccount).toBeDefined()
    expect(defaultAccount!.name).toBe('Primary Account')
    expect(defaultAccount!.isDefault).toBe(true)
  })

  it('should find active bank accounts', async () => {
    const org = await createTestOrg({ slug: 'ba-active-org' })
    await createTestBankAccount(org._id, { name: 'Active 1', isActive: true })
    await createTestBankAccount(org._id, { name: 'Active 2', isActive: true })
    await createTestBankAccount(org._id, { name: 'Closed', isActive: false })

    const active = await bankAccountDao.findActive(String(org._id))
    expect(active).toHaveLength(2)
    expect(active.every((a) => a.isActive)).toBe(true)
  })

  it('should return null when no default bank account exists', async () => {
    const org = await createTestOrg({ slug: 'ba-nodefault-org' })
    await createTestBankAccount(org._id, { name: 'Non-default', isDefault: false })

    const defaultAccount = await bankAccountDao.findDefault(String(org._id))
    expect(defaultAccount).toBeNull()
  })
})

describe('FiscalPeriodDao', () => {
  it('should find period by date when date falls within range', async () => {
    const org = await createTestOrg({ slug: 'fpd-bydate-org' })
    const fy = await createTestFiscalYear(org._id)
    await createTestFiscalPeriod(org._id, fy._id, {
      name: 'January',
      number: 1,
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-31'),
    })
    await createTestFiscalPeriod(org._id, fy._id, {
      name: 'February',
      number: 2,
      startDate: new Date('2025-02-01'),
      endDate: new Date('2025-02-28'),
    })

    const found = await fiscalPeriodDao.findByDate(String(org._id), new Date('2025-02-15'))
    expect(found).toBeDefined()
    expect(found!.name).toBe('February')
    expect(found!.number).toBe(2)
  })

  it('should return null when date is outside any period', async () => {
    const org = await createTestOrg({ slug: 'fpd-null-org' })
    const fy = await createTestFiscalYear(org._id)
    await createTestFiscalPeriod(org._id, fy._id, {
      name: 'January',
      number: 1,
      startDate: new Date('2025-01-01'),
      endDate: new Date('2025-01-31'),
    })

    const found = await fiscalPeriodDao.findByDate(String(org._id), new Date('2025-06-15'))
    expect(found).toBeNull()
  })
})

describe('Multi-tenancy isolation', () => {
  it('should not leak accounts between organizations', async () => {
    const org1 = await createTestOrg({ slug: 'isolation-acct-org-1' })
    const org2 = await createTestOrg({ slug: 'isolation-acct-org-2' })

    await createTestAccount(org1._id, { code: '1000', name: 'Org1 Cash', type: 'asset' })
    await createTestAccount(org1._id, { code: '2000', name: 'Org1 Payable', type: 'liability' })
    await createTestAccount(org2._id, { code: '1000', name: 'Org2 Cash', type: 'asset' })

    const org1Tree = await accountDao.findTree(String(org1._id))
    const org2Tree = await accountDao.findTree(String(org2._id))

    expect(org1Tree).toHaveLength(2)
    expect(org2Tree).toHaveLength(1)

    // Account from org1 should not appear in org2 queries
    const crossCheck = await accountDao.findByCode(String(org2._id), '2000')
    expect(crossCheck).toBeNull()
  })
})
