import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import type { RepositoryRegistry } from 'dal'
import { setupMongoRepos, setupSQLiteRepos, teardownMongo, teardownSQLite, createTestOrg } from '../helpers/dal-test-setup'

const backends: [string, () => Promise<RepositoryRegistry>, () => Promise<void>][] = [
  ['mongo', setupMongoRepos, teardownMongo],
  ['sqlite', setupSQLiteRepos, teardownSQLite],
]

for (const [name, setup, cleanup] of backends) {
  describe(`Warehouse Repository [${name}]`, () => {
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

    function makeWarehouse(overrides: Record<string, any> = {}) {
      return {
        orgId,
        name: 'Main Warehouse',
        code: `WH-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'warehouse',
        isDefault: false,
        isActive: true,
        ...overrides,
      } as any
    }

    test('creates warehouse and retrieves it', async () => {
      const wh = await repos.warehouses.create(makeWarehouse({ name: 'Central' }))

      expect(wh.id).toBeDefined()
      expect(wh.name).toBe('Central')
      expect(wh.type).toBe('warehouse')
      expect(wh.isActive).toBe(true)

      const found = await repos.warehouses.findById(wh.id)
      expect(found).not.toBeNull()
      expect(found!.name).toBe('Central')
      expect(found!.code).toBe(wh.code)
    })

    test('update modifies fields', async () => {
      const wh = await repos.warehouses.create(makeWarehouse())

      const updated = await repos.warehouses.update(wh.id, {
        name: 'Updated Warehouse',
        isDefault: true,
      } as any)

      expect(updated!.name).toBe('Updated Warehouse')
      expect(updated!.isDefault).toBe(true)
      expect(updated!.type).toBe('warehouse') // unchanged
    })

    test('unique code per org', async () => {
      const code = `UNIQUE-${Date.now()}`
      await repos.warehouses.create(makeWarehouse({ code }))

      await expect(
        repos.warehouses.create(makeWarehouse({ code })),
      ).rejects.toThrow()
    })

    test('findMany by type', async () => {
      await repos.warehouses.create(makeWarehouse({ code: 'W1', type: 'warehouse' }))
      await repos.warehouses.create(makeWarehouse({ code: 'S1', type: 'store' }))
      await repos.warehouses.create(makeWarehouse({ code: 'W2', type: 'warehouse' }))

      const warehouses = await repos.warehouses.findMany({ orgId, type: 'warehouse' })
      expect(warehouses).toHaveLength(2)
    })

    test('findAll with pagination', async () => {
      for (let i = 0; i < 4; i++) {
        await repos.warehouses.create(makeWarehouse({ code: `PG-${i}`, name: `Warehouse ${i}` }))
      }

      const page = await repos.warehouses.findAll({ orgId }, { page: 0, size: 2, sort: { code: 1 } })
      expect(page.items).toHaveLength(2)
      expect(page.total).toBe(4)
      expect(page.totalPages).toBe(2)
    })

    test('delete removes warehouse', async () => {
      const wh = await repos.warehouses.create(makeWarehouse())

      expect(await repos.warehouses.delete(wh.id)).toBe(true)
      expect(await repos.warehouses.findById(wh.id)).toBeNull()
    })

    test('count by active status', async () => {
      await repos.warehouses.create(makeWarehouse({ code: 'A1', isActive: true }))
      await repos.warehouses.create(makeWarehouse({ code: 'A2', isActive: true }))
      await repos.warehouses.create(makeWarehouse({ code: 'I1', isActive: false }))

      const activeCount = await repos.warehouses.count({ orgId, isActive: true })
      expect(activeCount).toBe(2)
    })
  })
}
