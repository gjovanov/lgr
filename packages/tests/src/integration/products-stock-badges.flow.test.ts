import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestWarehouse, createTestStockLevel } from '../helpers/factories'
import { Product, StockLevel } from 'db/models'

beforeAll(async () => { await setupTestDB() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

/**
 * Backs the products-grid warehouse filter + per-warehouse quantity badges.
 * Exercises the exact query semantics the warehouse controllers use:
 *   - product list `?warehouseId=` → products holding stock (quantity > 0) in that warehouse
 *   - stock-level `/by-products?productIds=` → per-warehouse stock grouped by product
 */
describe('Products warehouse filter (product list ?warehouseId=)', () => {
  it('restricts to products with quantity > 0 in the selected warehouse', async () => {
    const org = await createTestOrg()
    const wh1 = await createTestWarehouse(org._id, { name: 'WH1', code: 'WH1' })
    const wh2 = await createTestWarehouse(org._id, { name: 'WH2', code: 'WH2' })
    const p1 = await createTestProduct(org._id, { name: 'In WH1', sku: `SKU-1-${Date.now()}` })
    const p2 = await createTestProduct(org._id, { name: 'In WH2 only', sku: `SKU-2-${Date.now()}` })
    const p3 = await createTestProduct(org._id, { name: 'Depleted in WH1', sku: `SKU-3-${Date.now()}` })

    await createTestStockLevel(org._id, p1._id, wh1._id, { quantity: 120, availableQuantity: 120 })
    await createTestStockLevel(org._id, p2._id, wh2._id, { quantity: 40, availableQuantity: 40 })
    await createTestStockLevel(org._id, p3._id, wh1._id, { quantity: 0, availableQuantity: 0 }) // zero → excluded

    // Controller step: stock rows with qty>0 in wh1 → productIds → product filter { id: { $in } }.
    const stock = await StockLevel.find({ orgId: org._id, warehouseId: wh1._id, quantity: { $gt: 0 } })
    const productIds = stock.map((s) => s.productId)
    const products = await Product.find({ orgId: org._id, _id: { $in: productIds } })

    const names = products.map((p) => p.name).sort()
    expect(names).toEqual(['In WH1'])
    expect(names).not.toContain('In WH2 only')
    expect(names).not.toContain('Depleted in WH1')
  })

  it('returns no products when the warehouse holds none', async () => {
    const org = await createTestOrg()
    const wh1 = await createTestWarehouse(org._id, { name: 'WH1', code: 'WH1' })
    const emptyWh = await createTestWarehouse(org._id, { name: 'Empty', code: 'WH-E' })
    const p1 = await createTestProduct(org._id, { sku: `SKU-A-${Date.now()}` })
    await createTestStockLevel(org._id, p1._id, wh1._id, { quantity: 10, availableQuantity: 10 })

    const stock = await StockLevel.find({ orgId: org._id, warehouseId: emptyWh._id, quantity: { $gt: 0 } })
    const products = await Product.find({ orgId: org._id, _id: { $in: stock.map((s) => s.productId) } })
    expect(products).toHaveLength(0)
  })
})

describe('Stock badges (/by-products grouping)', () => {
  it('groups per-warehouse stock by product', async () => {
    const org = await createTestOrg()
    const wh1 = await createTestWarehouse(org._id, { name: 'WH1', code: 'WH1' })
    const wh2 = await createTestWarehouse(org._id, { name: 'WH2', code: 'WH2' })
    const p1 = await createTestProduct(org._id, { name: 'Multi-WH', sku: `SKU-M-${Date.now()}` })
    const p2 = await createTestProduct(org._id, { name: 'Single-WH', sku: `SKU-S-${Date.now()}` })

    await createTestStockLevel(org._id, p1._id, wh1._id, { quantity: 100, availableQuantity: 90 })
    await createTestStockLevel(org._id, p1._id, wh2._id, { quantity: 50, availableQuantity: 50 })
    await createTestStockLevel(org._id, p2._id, wh1._id, { quantity: 200, availableQuantity: 200 })

    const ids = [String(p1._id), String(p2._id)]
    const rows = await StockLevel.find({ orgId: org._id, productId: { $in: ids } })
    const warehouses = await createWarehouseMap(org._id)

    const stock: Record<string, { warehouseName: string; quantity: number }[]> = {}
    for (const s of rows) {
      const key = String(s.productId)
      ;(stock[key] ||= []).push({ warehouseName: warehouses.get(String(s.warehouseId)) || '', quantity: s.quantity })
    }

    expect(stock[String(p1._id)]).toHaveLength(2)
    expect(stock[String(p2._id)]).toHaveLength(1)
    const p1Total = stock[String(p1._id)].reduce((a, b) => a + b.quantity, 0)
    expect(p1Total).toBe(150)
    expect(stock[String(p2._id)][0].quantity).toBe(200)
    expect(stock[String(p1._id)].map((b) => b.warehouseName).sort()).toEqual(['WH1', 'WH2'])
  })
})

async function createWarehouseMap(orgId: any): Promise<Map<string, string>> {
  const { Warehouse } = await import('db/models')
  const whs = await Warehouse.find({ orgId })
  return new Map(whs.map((w: any) => [String(w._id), w.name]))
}
