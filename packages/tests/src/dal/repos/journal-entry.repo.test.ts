import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import type { RepositoryRegistry } from 'dal'
import { setupMongoRepos, teardownMongo, createTestOrg, releaseMongoRepos } from '../helpers/dal-test-setup'

/**
 * ⚠ One backend. This file used to run every body below against Mongo AND SQLite, which is what
 * "parity" named. `dal-sqlite` was the desktop's local mode and is gone (FR-14.34), so the loop is
 * kept — it is what makes these tests exercise the `dal` INTERFACE rather than `dal-mongo`
 * directly, and it is where a second backend would go back in. The bodies are untouched.
 */
const backends: [string, () => Promise<RepositoryRegistry>, () => Promise<void>][] = [
  ['mongo', setupMongoRepos, teardownMongo],
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
        orgId, code: '1010', name: 'Cash',
        type: 'asset', subType: 'current_asset', isSystem: false, isActive: true, balance: 0,
      } as any)
      accountId1 = acc1.id

      const acc2 = await repos.accounts.create({
        orgId, code: '7010', name: 'Revenue',
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
      // ⚠ "cleanup handled by process exit" was what this said, and it was false:
      // `mongodb-memory-server` removes its data directory inside `stop()`, not on exit, so every
      // run left ~302 MB in %TEMP%. `releaseMongoRepos` refcounts, so the server survives until
      // the last of these nine suites is done with it.
      await releaseMongoRepos()
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

    describe('sumPostedLines', () => {
      /** A balanced entry: debit `amount` on one account, credit it on the other. */
      function posted(amount: number, overrides: Record<string, any> = {}) {
        const { debitAccount = accountId1, creditAccount = accountId2, ...rest } = overrides
        return makeEntry({
          entryNumber: `JE-${Math.random().toString(36).slice(2, 10)}`,
          status: 'posted',
          lines: [
            { accountId: debitAccount, debit: amount, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: amount, baseCredit: 0 },
            { accountId: creditAccount, debit: 0, credit: amount, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: amount },
          ],
          totalDebit: amount,
          totalCredit: amount,
          ...rest,
        })
      }

      const byAccount = (rows: { accountId: string; debit: number; credit: number }[]) =>
        Object.fromEntries(rows.map(r => [r.accountId, { debit: r.debit, credit: r.credit }]))

      test('adds up every line of every posted entry, per account, on each side', async () => {
        await repos.journalEntries.create(posted(100))
        await repos.journalEntries.create(posted(30))
        // Two lines on one account in one entry, and an account running on both sides.
        await repos.journalEntries.create(makeEntry({
          entryNumber: 'JE-MANY',
          status: 'posted',
          lines: [
            { accountId: accountId1, debit: 5, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 5, baseCredit: 0 },
            { accountId: accountId1, debit: 7, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 7, baseCredit: 0 },
            { accountId: accountId2, debit: 0, credit: 12, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 12 },
            { accountId: accountId2, debit: 2, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 2, baseCredit: 0 },
            { accountId: accountId1, debit: 0, credit: 2, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 2 },
          ],
          totalDebit: 14,
          totalCredit: 14,
        }))

        const rows = await repos.journalEntries.sumPostedLines({ orgId })
        expect(byAccount(rows)).toEqual({
          [accountId1]: { debit: 142, credit: 2 },
          [accountId2]: { debit: 2, credit: 142 },
        })
      })

      test('reads the base amounts, not the document currency', async () => {
        await repos.journalEntries.create(makeEntry({
          entryNumber: 'JE-FX',
          status: 'posted',
          lines: [
            { accountId: accountId1, debit: 100, credit: 0, currency: 'USD', exchangeRate: 0.9, baseDebit: 90, baseCredit: 0 },
            { accountId: accountId2, debit: 0, credit: 100, currency: 'USD', exchangeRate: 0.9, baseDebit: 0, baseCredit: 90 },
          ],
          totalDebit: 100,
          totalCredit: 100,
        }))

        const rows = await repos.journalEntries.sumPostedLines({ orgId })
        expect(byAccount(rows)[accountId1]).toEqual({ debit: 90, credit: 0 })
      })

      test('counts a posted entry only: not a draft, not a voided one', async () => {
        await repos.journalEntries.create(posted(100))
        await repos.journalEntries.create(posted(40, { status: 'draft' }))
        await repos.journalEntries.create(posted(50, { status: 'voided' }))

        const rows = await repos.journalEntries.sumPostedLines({ orgId })
        expect(byAccount(rows)[accountId1]).toEqual({ debit: 100, credit: 0 })
      })

      test('never reads another org', async () => {
        await repos.journalEntries.create(posted(100))
        const otherOrg = await createTestOrg(repos)
        await repos.journalEntries.create(posted(999, { orgId: otherOrg }))

        const rows = await repos.journalEntries.sumPostedLines({ orgId })
        expect(byAccount(rows)[accountId1]).toEqual({ debit: 100, credit: 0 })
        expect(await repos.journalEntries.sumPostedLines({ orgId: await createTestOrg(repos) })).toEqual([])
      })

      test('windows on the entry date, both ends inclusive', async () => {
        await repos.journalEntries.create(posted(1, { date: new Date('2025-01-10T00:00:00Z') }))
        await repos.journalEntries.create(posted(2, { date: new Date('2025-01-20T00:00:00Z') }))
        await repos.journalEntries.create(posted(4, { date: new Date('2025-01-30T00:00:00Z') }))

        const sum = async (query: { from?: Date; to?: Date }) =>
          byAccount(await repos.journalEntries.sumPostedLines({ orgId, ...query }))[accountId1]?.debit

        expect(await sum({})).toBe(7)
        expect(await sum({ from: new Date('2025-01-20T00:00:00Z') })).toBe(6)
        expect(await sum({ to: new Date('2025-01-20T00:00:00Z') })).toBe(3)
        expect(await sum({ from: new Date('2025-01-15T00:00:00Z'), to: new Date('2025-01-25T00:00:00Z') })).toBe(2)
        expect(await sum({ to: new Date('2025-01-09T00:00:00Z') })).toBeUndefined()
      })

      test('windows on fiscal periods, and no period at all means no rows, not every row', async () => {
        const fy = await repos.fiscalYears.findOne({ orgId } as any)
        const february = await repos.fiscalPeriods.create({
          orgId, fiscalYearId: fy!.id, name: 'February', number: 2,
          startDate: new Date('2025-02-01'), endDate: new Date('2025-02-28'), status: 'open',
        } as any)
        await repos.journalEntries.create(posted(10))
        await repos.journalEntries.create(posted(20, { fiscalPeriodId: february.id }))

        const sum = async (fiscalPeriodIds: string[]) =>
          byAccount(await repos.journalEntries.sumPostedLines({ orgId, fiscalPeriodIds }))[accountId1]?.debit

        expect(await sum([fiscalPeriodId])).toBe(10)
        expect(await sum([february.id])).toBe(20)
        expect(await sum([fiscalPeriodId, february.id])).toBe(30)
        expect(await sum([])).toBeUndefined()
        // What a query string can put here: refused by matching nothing, never a 500.
        expect(await sum(['not-an-id'])).toBeUndefined()
      })

      test('byContact keeps each partner apart, and lines without one together', async () => {
        const contactA = '0123456789abcdef01234567'
        const contactB = '0123456789abcdef01234568'
        await repos.journalEntries.create(makeEntry({
          entryNumber: 'JE-PARTNERS',
          status: 'posted',
          lines: [
            { accountId: accountId1, debit: 100, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 100, baseCredit: 0, contactId: contactA },
            { accountId: accountId1, debit: 0, credit: 30, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 30, contactId: contactB },
            { accountId: accountId1, debit: 5, credit: 0, currency: 'EUR', exchangeRate: 1, baseDebit: 5, baseCredit: 0 },
            { accountId: accountId2, debit: 0, credit: 75, currency: 'EUR', exchangeRate: 1, baseDebit: 0, baseCredit: 75 },
          ],
          totalDebit: 105,
          totalCredit: 105,
        }))

        const rows = await repos.journalEntries.sumPostedLines({ orgId, byContact: true })
        const onCash = rows.filter(r => r.accountId === accountId1)
        expect(onCash.find(r => r.contactId === contactA)).toMatchObject({ debit: 100, credit: 0 })
        expect(onCash.find(r => r.contactId === contactB)).toMatchObject({ debit: 0, credit: 30 })
        expect(onCash.find(r => !r.contactId)).toMatchObject({ debit: 5, credit: 0 })
        expect(rows.filter(r => r.accountId === accountId2)).toHaveLength(1)

        // Without it, one row per account and no contact on it.
        const merged = await repos.journalEntries.sumPostedLines({ orgId })
        expect(byAccount(merged)[accountId1]).toEqual({ debit: 105, credit: 30 })
        expect(merged.every(r => r.contactId === undefined)).toBe(true)
      })
    })
  })
}
