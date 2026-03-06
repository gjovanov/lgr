import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import type { RepositoryRegistry } from 'dal'
import { setupMongoRepos, setupSQLiteRepos, teardownMongo, teardownSQLite, createTestOrg } from '../helpers/dal-test-setup'

const backends: [string, () => Promise<RepositoryRegistry>, () => Promise<void>][] = [
  ['mongo', setupMongoRepos, teardownMongo],
  ['sqlite', setupSQLiteRepos, teardownSQLite],
]

for (const [name, setup, cleanup] of backends) {
  describe(`InventoryCount Repository [${name}]`, () => {
    let repos: RepositoryRegistry
    let orgId: string
    let warehouseId: string
    let productId: string

    beforeAll(async () => {
      repos = await setup()
    })

    beforeEach(async () => {
      await cleanup()
      orgId = await createTestOrg(repos)

      const warehouse = await repos.warehouses.create({
        orgId,
        name: 'Count Warehouse',
        code: 'WH-CNT',
        type: 'warehouse',
        isActive: true,
      } as any)
      warehouseId = warehouse.id

      const product = await repos.products.create({
        orgId,
        name: 'Count Product',
        sku: `SKU-CNT-${Date.now()}`,
        type: 'goods',
        category: 'general',
        unit: 'pcs',
        purchasePrice: 10,
        sellingPrice: 25,
        taxRate: 18,
        trackInventory: true,
        isActive: true,
        customPrices: [],
        variants: [],
      } as any)
      productId = product.id
    })

    afterAll(async () => {
      // cleanup handled by process exit
    })

    function makeCount(overrides: Record<string, any> = {}) {
      return {
        orgId,
        countNumber: `IC-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        warehouseId,
        date: new Date('2025-06-01'),
        status: 'in_progress',
        type: 'full',
        lines: [
          {
            productId,
            systemQuantity: 100,
            countedQuantity: 98,
            variance: -2,
            varianceCost: -20,
            notes: 'Minor discrepancy',
          },
        ],
        createdBy: orgId,
        ...overrides,
      } as any
    }

    test('creates inventory count with lines and retrieves them', async () => {
      const ic = await repos.inventoryCounts.create(makeCount())

      expect(ic.id).toBeDefined()
      expect(ic.lines).toHaveLength(1)
      expect(ic.lines[0].systemQuantity).toBe(100)
      expect(ic.lines[0].countedQuantity).toBe(98)
      expect(ic.lines[0].variance).toBe(-2)

      const found = await repos.inventoryCounts.findById(ic.id)
      expect(found).not.toBeNull()
      expect(found!.lines).toHaveLength(1)
      expect(found!.lines[0].productId).toBe(productId)
    })

    test('creates count with multiple lines', async () => {
      const product2 = await repos.products.create({
        orgId,
        name: 'Count Product 2',
        sku: `SKU-CNT2-${Date.now()}`,
        type: 'goods',
        category: 'general',
        unit: 'pcs',
        purchasePrice: 5,
        sellingPrice: 15,
        taxRate: 18,
        trackInventory: true,
        isActive: true,
        customPrices: [],
        variants: [],
      } as any)

      const ic = await repos.inventoryCounts.create(makeCount({
        lines: [
          { productId, systemQuantity: 100, countedQuantity: 98, variance: -2, varianceCost: -20 },
          { productId: product2.id, systemQuantity: 50, countedQuantity: 55, variance: 5, varianceCost: 25 },
        ],
      }))

      expect(ic.lines).toHaveLength(2)
      expect(ic.lines[0].variance).toBe(-2)
      expect(ic.lines[1].variance).toBe(5)
    })

    test('update replaces lines', async () => {
      const ic = await repos.inventoryCounts.create(makeCount())

      const updated = await repos.inventoryCounts.update(ic.id, {
        lines: [
          { productId, systemQuantity: 100, countedQuantity: 100, variance: 0, varianceCost: 0 },
        ],
        status: 'completed',
      } as any)

      expect(updated!.lines).toHaveLength(1)
      expect(updated!.lines[0].variance).toBe(0)
      expect(updated!.status).toBe('completed')
    })

    test('delete cascades to lines', async () => {
      const ic = await repos.inventoryCounts.create(makeCount())

      expect(await repos.inventoryCounts.delete(ic.id)).toBe(true)
      expect(await repos.inventoryCounts.findById(ic.id)).toBeNull()
    })

    test('findMany by status with hydrated lines', async () => {
      await repos.inventoryCounts.create(makeCount({ countNumber: 'IC-IP1', status: 'in_progress' }))
      await repos.inventoryCounts.create(makeCount({ countNumber: 'IC-IP2', status: 'in_progress' }))
      await repos.inventoryCounts.create(makeCount({ countNumber: 'IC-C1', status: 'completed' }))

      const inProgress = await repos.inventoryCounts.findMany({ orgId, status: 'in_progress' })
      expect(inProgress).toHaveLength(2)
      for (const ic of inProgress) {
        expect(ic.status).toBe('in_progress')
        expect(ic.lines).toHaveLength(1)
      }
    })

    test('findAll with pagination', async () => {
      for (let i = 0; i < 3; i++) {
        await repos.inventoryCounts.create(makeCount({ countNumber: `IC-P${i}` }))
      }

      const page = await repos.inventoryCounts.findAll({ orgId }, { page: 0, size: 2, sort: { createdAt: -1 } })
      expect(page.items).toHaveLength(2)
      expect(page.total).toBe(3)
      expect(page.items[0].lines).toHaveLength(1)
    })
  })
}
