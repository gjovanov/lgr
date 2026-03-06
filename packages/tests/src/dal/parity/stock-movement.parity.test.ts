import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import type { RepositoryRegistry } from 'dal'
import { setupMongoRepos, setupSQLiteRepos, teardownMongo, teardownSQLite, createTestOrg } from '../helpers/dal-test-setup'

const backends: [string, () => Promise<RepositoryRegistry>, () => Promise<void>][] = [
  ['mongo', setupMongoRepos, teardownMongo],
  ['sqlite', setupSQLiteRepos, teardownSQLite],
]

for (const [name, setup, cleanup] of backends) {
  describe(`StockMovement Repository [${name}]`, () => {
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
        name: 'Main Warehouse',
        code: 'WH-01',
        type: 'warehouse',
        isActive: true,
      } as any)
      warehouseId = warehouse.id

      const product = await repos.products.create({
        orgId,
        name: 'Test Product',
        sku: `SKU-${Date.now()}`,
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

    function makeMovement(overrides: Record<string, any> = {}) {
      return {
        orgId,
        movementNumber: `MOV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        type: 'receipt',
        status: 'draft',
        toWarehouseId: warehouseId,
        date: new Date('2025-03-01'),
        totalAmount: 2000,
        lines: [
          {
            productId,
            quantity: 100,
            unitCost: 10,
            totalCost: 1000,
          },
          {
            productId,
            quantity: 50,
            unitCost: 20,
            totalCost: 1000,
          },
        ],
        notes: 'Test movement',
        createdBy: orgId,
        ...overrides,
      } as any
    }

    test('creates movement with lines and retrieves them', async () => {
      const movement = await repos.stockMovements.create(makeMovement())

      expect(movement.id).toBeDefined()
      expect(movement.lines).toHaveLength(2)
      expect(movement.lines[0].quantity).toBe(100)
      expect(movement.lines[0].unitCost).toBe(10)
      expect(movement.lines[1].quantity).toBe(50)

      const found = await repos.stockMovements.findById(movement.id)
      expect(found).not.toBeNull()
      expect(found!.lines).toHaveLength(2)
      expect(found!.lines[0].productId).toBe(productId)
    })

    test('update replaces lines', async () => {
      const movement = await repos.stockMovements.create(makeMovement())

      const updated = await repos.stockMovements.update(movement.id, {
        lines: [
          { productId, quantity: 200, unitCost: 15, totalCost: 3000 },
        ],
        status: 'confirmed',
      } as any)

      expect(updated!.lines).toHaveLength(1)
      expect(updated!.lines[0].quantity).toBe(200)
      expect(updated!.status).toBe('confirmed')
    })

    test('delete removes movement and lines', async () => {
      const movement = await repos.stockMovements.create(makeMovement())

      expect(await repos.stockMovements.delete(movement.id)).toBe(true)
      expect(await repos.stockMovements.findById(movement.id)).toBeNull()
    })

    test('findMany by type', async () => {
      await repos.stockMovements.create(makeMovement({ movementNumber: 'MOV-R1', type: 'receipt' }))
      await repos.stockMovements.create(makeMovement({ movementNumber: 'MOV-I1', type: 'dispatch' }))
      await repos.stockMovements.create(makeMovement({ movementNumber: 'MOV-R2', type: 'receipt' }))

      const receipts = await repos.stockMovements.findMany({ orgId, type: 'receipt' })
      expect(receipts).toHaveLength(2)
      for (const m of receipts) {
        expect(m.type).toBe('receipt')
        expect(m.lines).toHaveLength(2) // lines hydrated
      }
    })

    test('findAll with pagination includes lines', async () => {
      for (let i = 0; i < 3; i++) {
        await repos.stockMovements.create(makeMovement({ movementNumber: `MOV-P${i}` }))
      }

      const page = await repos.stockMovements.findAll({ orgId }, { page: 0, size: 2, sort: { createdAt: -1 } })
      expect(page.items).toHaveLength(2)
      expect(page.total).toBe(3)
      expect(page.items[0].lines).toHaveLength(2)
    })
  })
}
