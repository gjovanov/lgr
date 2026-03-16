import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestWarehouse } from '../helpers/factories'
import { checkCrossWarehouseAvailability, createTransferMovements, confirmTransferMovements } from 'services/biz/stock-transfer.service'
import { StockLevel, StockMovement } from 'db/models'

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

describe('Cross-Warehouse Stock Transfer', () => {
  it('should return sufficient when stock is available at target warehouse', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const wh = await createTestWarehouse(org._id)

    await StockLevel.create({ orgId: org._id, productId: product._id, warehouseId: wh._id, quantity: 100, reservedQuantity: 0, availableQuantity: 100, avgCost: 5 })

    const result = await checkCrossWarehouseAvailability(String(org._id), [
      { productId: String(product._id), warehouseId: String(wh._id), quantity: 50 },
    ])

    expect(result.sufficient).toBe(true)
    expect(result.shortfalls).toHaveLength(0)
    expect(result.proposals).toHaveLength(0)
  })

  it('should propose transfer when target warehouse has insufficient stock', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, { name: 'Widget' })
    const whA = await createTestWarehouse(org._id, { name: 'Warehouse A', code: 'WH-A' })
    const whB = await createTestWarehouse(org._id, { name: 'Warehouse B', code: 'WH-B' })

    await StockLevel.create({ orgId: org._id, productId: product._id, warehouseId: whA._id, quantity: 20, reservedQuantity: 0, availableQuantity: 20, avgCost: 5 })
    await StockLevel.create({ orgId: org._id, productId: product._id, warehouseId: whB._id, quantity: 80, reservedQuantity: 0, availableQuantity: 80, avgCost: 5 })

    const result = await checkCrossWarehouseAvailability(String(org._id), [
      { productId: String(product._id), warehouseId: String(whA._id), quantity: 50 },
    ])

    expect(result.sufficient).toBe(false)
    expect(result.shortfalls).toHaveLength(1)
    expect(result.shortfalls[0].deficit).toBe(30)
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0].sources).toHaveLength(1)
    expect(result.proposals[0].sources[0].fromWarehouseId).toBe(String(whB._id))
    expect(result.proposals[0].sources[0].transferQuantity).toBe(30)
    expect(result.proposals[0].deficit).toBe(0)
    expect(result.allResolvable).toBe(true)
  })

  it('should propose from multiple warehouses when needed', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, { name: 'Widget' })
    const whTarget = await createTestWarehouse(org._id, { name: 'Target', code: 'T' })
    const whA = await createTestWarehouse(org._id, { name: 'Source A', code: 'SA' })
    const whB = await createTestWarehouse(org._id, { name: 'Source B', code: 'SB' })

    await StockLevel.create({ orgId: org._id, productId: product._id, warehouseId: whTarget._id, quantity: 0, reservedQuantity: 0, availableQuantity: 0, avgCost: 5 })
    await StockLevel.create({ orgId: org._id, productId: product._id, warehouseId: whA._id, quantity: 30, reservedQuantity: 0, availableQuantity: 30, avgCost: 5 })
    await StockLevel.create({ orgId: org._id, productId: product._id, warehouseId: whB._id, quantity: 40, reservedQuantity: 0, availableQuantity: 40, avgCost: 5 })

    const result = await checkCrossWarehouseAvailability(String(org._id), [
      { productId: String(product._id), warehouseId: String(whTarget._id), quantity: 60 },
    ])

    expect(result.proposals[0].sources).toHaveLength(2)
    expect(result.proposals[0].totalTransfer).toBe(60)
    expect(result.proposals[0].deficit).toBe(0)
    expect(result.allResolvable).toBe(true)
  })

  it('should report unresolvable when total stock is insufficient', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const wh = await createTestWarehouse(org._id)

    await StockLevel.create({ orgId: org._id, productId: product._id, warehouseId: wh._id, quantity: 10, reservedQuantity: 0, availableQuantity: 10, avgCost: 5 })

    const result = await checkCrossWarehouseAvailability(String(org._id), [
      { productId: String(product._id), warehouseId: String(wh._id), quantity: 50 },
    ])

    expect(result.sufficient).toBe(false)
    expect(result.allResolvable).toBe(false)
    expect(result.proposals[0].deficit).toBeGreaterThan(0)
  })

  it('should create draft transfer movements for proposals', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, { name: 'Transfer Widget' })
    const whFrom = await createTestWarehouse(org._id, { name: 'Source', code: 'SRC' })
    const whTo = await createTestWarehouse(org._id, { name: 'Dest', code: 'DST' })

    const proposals = [{
      productId: String(product._id),
      productName: 'Transfer Widget',
      toWarehouseId: String(whTo._id),
      toWarehouseName: 'Dest',
      sources: [{
        fromWarehouseId: String(whFrom._id),
        fromWarehouseName: 'Source',
        available: 100,
        transferQuantity: 30,
      }],
      totalTransfer: 30,
      deficit: 0,
    }]

    const transferIds = await createTransferMovements(String(org._id), proposals, String(org._id))

    expect(transferIds).toHaveLength(1)

    const movement = await StockMovement.findById(transferIds[0]).lean()
    expect(movement).not.toBeNull()
    expect(movement!.type).toBe('transfer')
    expect(movement!.status).toBe('draft')
    expect(String(movement!.fromWarehouseId)).toBe(String(whFrom._id))
    expect(String(movement!.toWarehouseId)).toBe(String(whTo._id))
    expect(movement!.lines[0].quantity).toBe(30)
  })

  it('should return ALL available warehouses for user selection, not just greedy picks', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id, { name: 'Choice Widget' })
    const whTarget = await createTestWarehouse(org._id, { name: 'Target', code: 'TGT' })
    const whA = await createTestWarehouse(org._id, { name: 'Warehouse A', code: 'WA' })
    const whB = await createTestWarehouse(org._id, { name: 'Warehouse B', code: 'WB' })
    const whC = await createTestWarehouse(org._id, { name: 'Warehouse C', code: 'WC' })

    // Target has 0, A has 50, B has 30, C has 20 — need 40
    await StockLevel.create({ orgId: org._id, productId: product._id, warehouseId: whTarget._id, quantity: 0, reservedQuantity: 0, availableQuantity: 0, avgCost: 5 })
    await StockLevel.create({ orgId: org._id, productId: product._id, warehouseId: whA._id, quantity: 50, reservedQuantity: 0, availableQuantity: 50, avgCost: 5 })
    await StockLevel.create({ orgId: org._id, productId: product._id, warehouseId: whB._id, quantity: 30, reservedQuantity: 0, availableQuantity: 30, avgCost: 5 })
    await StockLevel.create({ orgId: org._id, productId: product._id, warehouseId: whC._id, quantity: 20, reservedQuantity: 0, availableQuantity: 20, avgCost: 5 })

    const result = await checkCrossWarehouseAvailability(String(org._id), [
      { productId: String(product._id), warehouseId: String(whTarget._id), quantity: 40 },
    ])

    // Should return ALL 3 source warehouses, not just the 1 needed by greedy
    expect(result.proposals).toHaveLength(1)
    expect(result.proposals[0].sources).toHaveLength(3)

    // Greedy pre-fills: A gets 40 (from 50), B and C get 0
    const sourceA = result.proposals[0].sources.find((s: any) => s.fromWarehouseId === String(whA._id))
    const sourceB = result.proposals[0].sources.find((s: any) => s.fromWarehouseId === String(whB._id))
    const sourceC = result.proposals[0].sources.find((s: any) => s.fromWarehouseId === String(whC._id))

    expect(sourceA!.transferQuantity).toBe(40) // greedy picks from largest
    expect(sourceA!.available).toBe(50)
    expect(sourceB!.transferQuantity).toBe(0)  // not needed by greedy, but shown for user choice
    expect(sourceB!.available).toBe(30)
    expect(sourceC!.transferQuantity).toBe(0)
    expect(sourceC!.available).toBe(20)

    // User could instead choose: B=30, C=10 (leaving A untouched)
    // The frontend allows editing transferQuantity per source
  })

  it('should skip lines without productId or warehouseId', async () => {
    const org = await createTestOrg()

    const result = await checkCrossWarehouseAvailability(String(org._id), [
      { productId: '', warehouseId: '', quantity: 10 },
      { productId: 'abc', warehouseId: '', quantity: 10 },
    ])

    expect(result.sufficient).toBe(true)
    expect(result.shortfalls).toHaveLength(0)
  })
})
