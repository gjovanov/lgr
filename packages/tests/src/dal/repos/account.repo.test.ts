import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { captureRejection, expectRejection } from '../../helpers/capture-rejection'
import type { RepositoryRegistry } from 'dal'
import { DuplicateError } from 'dal'
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
  describe(`Account Repository [${name}]`, () => {
    let repos: RepositoryRegistry
    let orgId: string

    beforeAll(async () => {
      repos = await setup()
    })

    beforeEach(async () => {
      await cleanup()
      orgId = await createTestOrg(repos)
    })

    afterAll(async () => {
      // ⚠ "cleanup handled by process exit" was what this said, and it was false:
      // `mongodb-memory-server` removes its data directory inside `stop()`, not on exit, so every
      // run left ~302 MB in %TEMP%. `releaseMongoRepos` refcounts, so the server survives until
      // the last of these nine suites is done with it.
      await releaseMongoRepos()
    })

    test('creates an account and retrieves it by ID', async () => {
      const account = await repos.accounts.create({
        orgId,
        code: '1000',
        name: 'Cash',
        type: 'asset',
        subType: 'current_asset',
        isSystem: false,
        isActive: true,
        balance: 0,
      })

      expect(account.id).toBeDefined()
      expect(account.code).toBe('1000')
      expect(account.name).toBe('Cash')
      expect(account.type).toBe('asset')
      expect(account.orgId).toBe(orgId)
      expect(account.createdAt).toBeInstanceOf(Date)

      const found = await repos.accounts.findById(account.id)
      expect(found).not.toBeNull()
      expect(found!.id).toBe(account.id)
      expect(found!.code).toBe('1000')
    })

    test('findOne by orgId and code', async () => {
      await repos.accounts.create({
        orgId,
        code: '2000',
        name: 'Bank',
        type: 'asset',
        subType: 'current_asset',
        isSystem: false,
        isActive: true,
        balance: 5000,
      })

      const found = await repos.accounts.findOne({ orgId, code: '2000' })
      expect(found).not.toBeNull()
      expect(found!.name).toBe('Bank')
      expect(found!.balance).toBe(5000)
    })

    test('findAll with pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await repos.accounts.create({
          orgId,
          code: `${3000 + i}`,
          name: `Account ${i}`,
          type: 'expense',
          subType: 'operating_expense',
          isSystem: false,
          isActive: true,
          balance: 0,
        })
      }

      const page1 = await repos.accounts.findAll({ orgId }, { page: 0, size: 2, sort: { code: 1 } })
      expect(page1.items).toHaveLength(2)
      expect(page1.total).toBe(5)
      expect(page1.totalPages).toBe(3)
      expect(page1.page).toBe(0)

      const page2 = await repos.accounts.findAll({ orgId }, { page: 1, size: 2, sort: { code: 1 } })
      expect(page2.items).toHaveLength(2)
      expect(page2.page).toBe(1)

      // No overlap
      expect(page1.items[0].id).not.toBe(page2.items[0].id)
    })

    test('findAll with size=0 returns all', async () => {
      for (let i = 0; i < 3; i++) {
        await repos.accounts.create({
          orgId,
          code: `${4000 + i}`,
          name: `All ${i}`,
          type: 'revenue',
          subType: 'operating_revenue',
          isSystem: false,
          isActive: true,
          balance: 0,
        })
      }

      const result = await repos.accounts.findAll({ orgId }, { page: 0, size: 0 })
      expect(result.items).toHaveLength(3)
      expect(result.total).toBe(3)
      expect(result.totalPages).toBe(1)
    })

    test('update modifies fields', async () => {
      const account = await repos.accounts.create({
        orgId,
        code: '5000',
        name: 'Old Name',
        type: 'liability',
        subType: 'current_liability',
        isSystem: false,
        isActive: true,
        balance: 100,
      })

      const updated = await repos.accounts.update(account.id, { name: 'New Name', balance: 200 })
      expect(updated).not.toBeNull()
      expect(updated!.name).toBe('New Name')
      expect(updated!.balance).toBe(200)
      expect(updated!.code).toBe('5000') // unchanged

      // Verify via findById
      const found = await repos.accounts.findById(account.id)
      expect(found!.name).toBe('New Name')
    })

    describe('adjustBalances', () => {
      const anAccount = (org: string, code: string, balance = 0) => repos.accounts.create({
        orgId: org, code, name: `Account ${code}`, type: 'asset', subType: 'current_asset', isSystem: false, isActive: true, balance,
      })
      const balanceOf = async (id: string) => (await repos.accounts.findById(id))!.balance

      test('adds each signed amount to its account', async () => {
        const up = await anAccount(orgId, 'A1', 100)
        const down = await anAccount(orgId, 'A2', 100)
        const still = await anAccount(orgId, 'A3', 100)

        await repos.accounts.adjustBalances(orgId, { [up.id]: 25, [down.id]: -40, [still.id]: 0 })

        expect(await balanceOf(up.id)).toBe(125)
        expect(await balanceOf(down.id)).toBe(60)
        expect(await balanceOf(still.id)).toBe(100)
      })

      test('adjustments that land at once all count', async () => {
        const account = await anAccount(orgId, 'A4')

        await Promise.all(Array.from({ length: 25 }, () => repos.accounts.adjustBalances(orgId, { [account.id]: 10 })))

        expect(await balanceOf(account.id)).toBe(250)
      })

      test('keeps to the cent, however the amounts add up in binary', async () => {
        const account = await anAccount(orgId, 'A5')

        await repos.accounts.adjustBalances(orgId, { [account.id]: 0.1 })
        await repos.accounts.adjustBalances(orgId, { [account.id]: 0.2 })

        expect(await balanceOf(account.id)).toBe(0.3)
      })

      test('never touches another org\'s account, even when it is named', async () => {
        const theirs = await anAccount(await createTestOrg(repos), 'B1', 100)

        await repos.accounts.adjustBalances(orgId, { [theirs.id]: 50 })

        expect(await balanceOf(theirs.id)).toBe(100)
      })

      test('nothing to adjust is no write and no error', async () => {
        await repos.accounts.adjustBalances(orgId, {})
      })
    })

    test('delete removes the entity', async () => {
      const account = await repos.accounts.create({
        orgId,
        code: '6000',
        name: 'Delete Me',
        type: 'asset',
        subType: 'current_asset',
        isSystem: false,
        isActive: true,
        balance: 0,
      })

      const deleted = await repos.accounts.delete(account.id)
      expect(deleted).toBe(true)

      const found = await repos.accounts.findById(account.id)
      expect(found).toBeNull()
    })

    test('delete returns false for non-existent ID', async () => {
      const deleted = await repos.accounts.delete(crypto.randomUUID())
      expect(deleted).toBe(false)
    })

    test('enforces unique orgId + code constraint', async () => {
      await repos.accounts.create({
        orgId,
        code: '7000',
        name: 'First',
        type: 'asset',
        subType: 'current_asset',
        isSystem: false,
        isActive: true,
        balance: 0,
      })

      expectRejection(await captureRejection(repos.accounts.create({
          orgId,
          code: '7000',
          name: 'Duplicate',
          type: 'asset',
          subType: 'current_asset',
          isSystem: false,
          isActive: true,
          balance: 0,
        })))
    })

    test('count returns correct number', async () => {
      for (let i = 0; i < 3; i++) {
        await repos.accounts.create({
          orgId,
          code: `${8000 + i}`,
          name: `Count ${i}`,
          type: 'expense',
          subType: 'operating_expense',
          isSystem: false,
          isActive: true,
          balance: 0,
        })
      }

      const count = await repos.accounts.count({ orgId })
      expect(count).toBe(3)

      const filtered = await repos.accounts.count({ orgId, type: 'expense' })
      expect(filtered).toBe(3)
    })

    test('filter with $in operator', async () => {
      const a1 = await repos.accounts.create({ orgId, code: '9001', name: 'A1', type: 'asset', subType: 'current_asset', isSystem: false, isActive: true, balance: 0 })
      const a2 = await repos.accounts.create({ orgId, code: '9002', name: 'A2', type: 'liability', subType: 'current_liability', isSystem: false, isActive: true, balance: 0 })
      await repos.accounts.create({ orgId, code: '9003', name: 'A3', type: 'equity', subType: 'owner_equity', isSystem: false, isActive: true, balance: 0 })

      const result = await repos.accounts.findMany({ orgId, type: { $in: ['asset', 'liability'] } })
      expect(result).toHaveLength(2)
      const types = result.map(a => a.type).sort()
      expect(types).toEqual(['asset', 'liability'])
    })

    test('createMany batch insert', async () => {
      const items = [
        { orgId, code: '9101', name: 'B1', type: 'asset', subType: 'current_asset', isSystem: false, isActive: true, balance: 0 },
        { orgId, code: '9102', name: 'B2', type: 'asset', subType: 'current_asset', isSystem: false, isActive: true, balance: 0 },
        { orgId, code: '9103', name: 'B3', type: 'asset', subType: 'current_asset', isSystem: false, isActive: true, balance: 0 },
      ]

      const created = await repos.accounts.createMany(items)
      expect(created).toHaveLength(3)
      expect(created[0].code).toBe('9101')
      expect(created[2].code).toBe('9103')
    })
  })
}
