import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import type { RepositoryRegistry } from 'dal'
import { DuplicateError } from 'dal'
import { setupMongoRepos, setupSQLiteRepos, teardownMongo, teardownSQLite, createTestOrg } from '../helpers/dal-test-setup'

const backends: [string, () => Promise<RepositoryRegistry>, () => Promise<void>][] = [
  ['mongo', setupMongoRepos, teardownMongo],
  ['sqlite', setupSQLiteRepos, teardownSQLite],
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
      // cleanup handled by process exit
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

      await expect(
        repos.accounts.create({
          orgId,
          code: '7000',
          name: 'Duplicate',
          type: 'asset',
          subType: 'current_asset',
          isSystem: false,
          isActive: true,
          balance: 0,
        }),
      ).rejects.toThrow()
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
