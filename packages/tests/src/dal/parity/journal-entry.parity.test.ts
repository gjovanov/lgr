import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import type { RepositoryRegistry } from 'dal'
import { setupMongoRepos, setupSQLiteRepos, teardownMongo, teardownSQLite, createTestOrg } from '../helpers/dal-test-setup'

const backends: [string, () => Promise<RepositoryRegistry>, () => Promise<void>][] = [
  ['mongo', setupMongoRepos, teardownMongo],
  ['sqlite', setupSQLiteRepos, teardownSQLite],
]

for (const [name, setup, cleanup] of backends) {
  describe(`JournalEntry Repository [${name}]`, () => {
    let repos: RepositoryRegistry
    let orgId: string
    let accountId1: string
    let accountId2: string
    let fiscalPeriodId: string

    beforeAll(async () => {
      repos = await setup()
    })

    beforeEach(async () => {
      await cleanup()
      orgId = await createTestOrg(repos)

      // Create two accounts for debit/credit lines
      const acc1 = await repos.accounts.create({
        orgId, code: `${1000 + Math.floor(Math.random() * 8000)}`, name: 'Cash',
        type: 'asset', subType: 'current_asset', isSystem: false, isActive: true, balance: 0,
      } as any)
      accountId1 = acc1.id

      const acc2 = await repos.accounts.create({
        orgId, code: `${1000 + Math.floor(Math.random() * 8000)}`, name: 'Revenue',
        type: 'revenue', subType: 'operating_revenue', isSystem: false, isActive: true, balance: 0,
      } as any)
      accountId2 = acc2.id

      // Create fiscal year + period
      const fy = await repos.fiscalYears.create({
        orgId, name: '2025', startDate: new Date('2025-01-01'), endDate: new Date('2025-12-31'), status: 'open',
      } as any)

      const fp = await repos.fiscalPeriods.create({
        orgId, fiscalYearId: fy.id, name: 'January', number: 1,
        startDate: new Date('2025-01-01'), endDate: new Date('2025-01-31'), status: 'open',
      } as any)
      fiscalPeriodId = fp.id
    })

    afterAll(async () => {
      // cleanup handled by process exit
    })

    function makeEntry(overrides: Record<string, any> = {}) {
      return {
        orgId,
        entryNumber: `JE-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        date: new Date('2025-01-15'),
        fiscalPeriodId,
        description: 'Test journal entry',
        type: 'standard',
        status: 'draft',
        lines: [
          {
            accountId: accountId1,
            description: 'Cash debit',
            debit: 1000,
            credit: 0,
            currency: 'EUR',
            exchangeRate: 1,
            baseDebit: 1000,
            baseCredit: 0,
          },
          {
            accountId: accountId2,
            description: 'Revenue credit',
            debit: 0,
            credit: 1000,
            currency: 'EUR',
            exchangeRate: 1,
            baseDebit: 0,
            baseCredit: 1000,
          },
        ],
        totalDebit: 1000,
        totalCredit: 1000,
        attachments: [],
        createdBy: orgId,
        ...overrides,
      } as any
    }

    test('creates journal entry with balanced lines', async () => {
      const je = await repos.journalEntries.create(makeEntry())

      expect(je.id).toBeDefined()
      expect(je.lines).toHaveLength(2)
      expect(je.lines[0].debit).toBe(1000)
      expect(je.lines[0].credit).toBe(0)
      expect(je.lines[1].debit).toBe(0)
      expect(je.lines[1].credit).toBe(1000)
      expect(je.totalDebit).toBe(1000)
      expect(je.totalCredit).toBe(1000)

      const found = await repos.journalEntries.findById(je.id)
      expect(found).not.toBeNull()
      expect(found!.lines).toHaveLength(2)
      expect(found!.lines[0].accountId).toBe(accountId1)
      expect(found!.lines[1].accountId).toBe(accountId2)
    })

    test('update replaces lines', async () => {
      const je = await repos.journalEntries.create(makeEntry())

      const updated = await repos.journalEntries.update(je.id, {
        lines: [
          {
            accountId: accountId1, description: 'Updated debit',
            debit: 2000, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 2000, baseCredit: 0,
          },
          {
            accountId: accountId2, description: 'Updated credit',
            debit: 0, credit: 2000, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 2000,
          },
        ],
        totalDebit: 2000,
        totalCredit: 2000,
      } as any)

      expect(updated!.lines).toHaveLength(2)
      expect(updated!.lines[0].debit).toBe(2000)
      expect(updated!.totalDebit).toBe(2000)
    })

    test('update status without touching lines', async () => {
      const je = await repos.journalEntries.create(makeEntry())

      const updated = await repos.journalEntries.update(je.id, {
        status: 'posted',
        postedBy: orgId,
        postedAt: new Date('2025-01-16'),
      } as any)

      expect(updated!.status).toBe('posted')
      expect(updated!.lines).toHaveLength(2) // lines preserved
    })

    test('delete cascades to lines', async () => {
      const je = await repos.journalEntries.create(makeEntry())
      expect(await repos.journalEntries.delete(je.id)).toBe(true)
      expect(await repos.journalEntries.findById(je.id)).toBeNull()
    })

    test('findMany by status with hydrated lines', async () => {
      await repos.journalEntries.create(makeEntry({ entryNumber: 'JE-D1', status: 'draft' }))
      await repos.journalEntries.create(makeEntry({ entryNumber: 'JE-D2', status: 'draft' }))
      await repos.journalEntries.create(makeEntry({ entryNumber: 'JE-P1', status: 'posted' }))

      const drafts = await repos.journalEntries.findMany({ orgId, status: 'draft' })
      expect(drafts).toHaveLength(2)
      for (const je of drafts) {
        expect(je.status).toBe('draft')
        expect(je.lines).toHaveLength(2)
      }
    })

    test('count by fiscal period', async () => {
      await repos.journalEntries.create(makeEntry({ entryNumber: 'JE-C1' }))
      await repos.journalEntries.create(makeEntry({ entryNumber: 'JE-C2' }))

      const count = await repos.journalEntries.count({ orgId, fiscalPeriodId })
      expect(count).toBe(2)
    })
  })
}
