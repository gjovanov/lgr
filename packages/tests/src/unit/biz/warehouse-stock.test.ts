import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../../setup'
import {
  createTestOrg,
  createTestProduct,
  createTestWarehouse,
  createTestStockLevel,
  createTestStockMovement,
} from '../../helpers/factories'
import { adjustStock, confirmMovement, getStockValuation } from 'services/biz/warehouse.service'
import { StockLevel, StockMovement } from 'db/models'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('adjustStock', () => {
  it('should create a new StockLevel if none exists', async () => {
    const org = await createTestOrg({ slug: 'adjust-new' })
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    await adjustStock(String(org._id), String(product._id), String(warehouse._id), 10, 25)

    const level = await StockLevel.findOne({
      orgId: org._id,
      productId: product._id,
      warehouseId: warehouse._id,
    })
    expect(level).toBeDefined()
    expect(level!.quantity).toBe(10)
    expect(level!.avgCost).toBe(25)
    expect(level!.availableQuantity).toBe(10)
    expect(level!.reservedQuantity).toBe(0)
  })

  it('should update existing StockLevel quantity', async () => {
    const org = await createTestOrg({ slug: 'adjust-existing' })
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    await createTestStockLevel(org._id, product._id, warehouse._id, {
      quantity: 50,
      availableQuantity: 50,
      avgCost: 20,
    })

    await adjustStock(String(org._id), String(product._id), String(warehouse._id), 30, 30)

    const level = await StockLevel.findOne({
      orgId: org._id,
      productId: product._id,
      warehouseId: warehouse._id,
    })
    expect(level!.quantity).toBe(80)
  })

  it('should calculate weighted average cost correctly', async () => {
    const org = await createTestOrg({ slug: 'adjust-wavg' })
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    await createTestStockLevel(org._id, product._id, warehouse._id, {
      quantity: 100,
      availableQuantity: 100,
      avgCost: 10,
    })

    // newAvgCost = (100 * 10 + 50 * 20) / (100 + 50) = (1000 + 1000) / 150 = 2000 / 150 ~ 13.33
    await adjustStock(String(org._id), String(product._id), String(warehouse._id), 50, 20)

    const level = await StockLevel.findOne({
      orgId: org._id,
      productId: product._id,
      warehouseId: warehouse._id,
    })
    const expectedAvg = (100 * 10 + 50 * 20) / (100 + 50)
    expect(level!.avgCost).toBeCloseTo(expectedAvg, 2)
    expect(level!.quantity).toBe(150)
  })

  it('should handle negative adjustment (quantity decrease)', async () => {
    const org = await createTestOrg({ slug: 'adjust-neg' })
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    await createTestStockLevel(org._id, product._id, warehouse._id, {
      quantity: 100,
      availableQuantity: 100,
      avgCost: 15,
    })

    await adjustStock(String(org._id), String(product._id), String(warehouse._id), -30, 15)

    const level = await StockLevel.findOne({
      orgId: org._id,
      productId: product._id,
      warehouseId: warehouse._id,
    })
    expect(level!.quantity).toBe(70)
    // avgCost should remain unchanged for negative adjustments (quantity <= 0 branch)
    expect(level!.avgCost).toBe(15)
  })

  it('should update availableQuantity as quantity minus reservedQuantity', async () => {
    const org = await createTestOrg({ slug: 'adjust-avail' })
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    await createTestStockLevel(org._id, product._id, warehouse._id, {
      quantity: 80,
      reservedQuantity: 20,
      availableQuantity: 60,
      avgCost: 10,
    })

    await adjustStock(String(org._id), String(product._id), String(warehouse._id), 40, 10)

    const level = await StockLevel.findOne({
      orgId: org._id,
      productId: product._id,
      warehouseId: warehouse._id,
    })
    expect(level!.quantity).toBe(120)
    expect(level!.reservedQuantity).toBe(20)
    expect(level!.availableQuantity).toBe(100) // 120 - 20
  })

  it('should handle zero initial stock with positive adjustment', async () => {
    const org = await createTestOrg({ slug: 'adjust-zero' })
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    await createTestStockLevel(org._id, product._id, warehouse._id, {
      quantity: 0,
      availableQuantity: 0,
      avgCost: 0,
    })

    // When qty is 0, the branch `quantity > 0 && stockLevel.quantity > 0` is false,
    // but `quantity > 0` is true so avgCost = unitCost
    await adjustStock(String(org._id), String(product._id), String(warehouse._id), 25, 40)

    const level = await StockLevel.findOne({
      orgId: org._id,
      productId: product._id,
      warehouseId: warehouse._id,
    })
    expect(level!.quantity).toBe(25)
    expect(level!.avgCost).toBe(40)
    expect(level!.availableQuantity).toBe(25)
  })
})

describe('confirmMovement', () => {
  it('should confirm a draft movement and set status to completed', async () => {
    const org = await createTestOrg({ slug: 'confirm-draft' })
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    const movement = await createTestStockMovement(org._id, {
      type: 'receipt',
      status: 'draft',
      toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 10, unitCost: 5, totalCost: 50 }],
      totalAmount: 50,
    })

    const result = await confirmMovement(String(movement._id))

    expect(result.status).toBe('completed')
  })

  it('should decrease source warehouse stock for each line', async () => {
    const org = await createTestOrg({ slug: 'confirm-src-dec' })
    const fromWarehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    await createTestStockLevel(org._id, product._id, fromWarehouse._id, {
      quantity: 100,
      availableQuantity: 100,
      avgCost: 10,
    })

    const movement = await createTestStockMovement(org._id, {
      type: 'dispatch',
      status: 'draft',
      fromWarehouseId: fromWarehouse._id,
      lines: [{ productId: product._id, quantity: 30, unitCost: 10, totalCost: 300 }],
      totalAmount: 300,
    })

    await confirmMovement(String(movement._id))

    const level = await StockLevel.findOne({
      orgId: org._id,
      productId: product._id,
      warehouseId: fromWarehouse._id,
    })
    expect(level!.quantity).toBe(70)
  })

  it('should increase destination warehouse stock for each line', async () => {
    const org = await createTestOrg({ slug: 'confirm-dst-inc' })
    const toWarehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    const movement = await createTestStockMovement(org._id, {
      type: 'receipt',
      status: 'draft',
      toWarehouseId: toWarehouse._id,
      lines: [{ productId: product._id, quantity: 50, unitCost: 8, totalCost: 400 }],
      totalAmount: 400,
    })

    await confirmMovement(String(movement._id))

    const level = await StockLevel.findOne({
      orgId: org._id,
      productId: product._id,
      warehouseId: toWarehouse._id,
    })
    expect(level).toBeDefined()
    expect(level!.quantity).toBe(50)
    expect(level!.avgCost).toBe(8)
  })

  it('should handle receipt (only toWarehouseId, no fromWarehouseId)', async () => {
    const org = await createTestOrg({ slug: 'confirm-receipt' })
    const toWarehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    const movement = await createTestStockMovement(org._id, {
      type: 'receipt',
      status: 'draft',
      toWarehouseId: toWarehouse._id,
      // no fromWarehouseId
      lines: [{ productId: product._id, quantity: 20, unitCost: 12, totalCost: 240 }],
      totalAmount: 240,
    })

    await confirmMovement(String(movement._id))

    const toLevel = await StockLevel.findOne({
      orgId: org._id,
      productId: product._id,
      warehouseId: toWarehouse._id,
    })
    expect(toLevel).toBeDefined()
    expect(toLevel!.quantity).toBe(20)

    // No source warehouse stock should exist
    const allLevels = await StockLevel.find({ orgId: org._id })
    expect(allLevels).toHaveLength(1)
  })

  it('should handle dispatch (only fromWarehouseId, no toWarehouseId)', async () => {
    const org = await createTestOrg({ slug: 'confirm-dispatch' })
    const fromWarehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    await createTestStockLevel(org._id, product._id, fromWarehouse._id, {
      quantity: 60,
      availableQuantity: 60,
      avgCost: 15,
    })

    const movement = await createTestStockMovement(org._id, {
      type: 'dispatch',
      status: 'draft',
      fromWarehouseId: fromWarehouse._id,
      // no toWarehouseId
      lines: [{ productId: product._id, quantity: 25, unitCost: 15, totalCost: 375 }],
      totalAmount: 375,
    })

    await confirmMovement(String(movement._id))

    const fromLevel = await StockLevel.findOne({
      orgId: org._id,
      productId: product._id,
      warehouseId: fromWarehouse._id,
    })
    expect(fromLevel!.quantity).toBe(35)

    // No destination warehouse stock should be created
    const allLevels = await StockLevel.find({ orgId: org._id })
    expect(allLevels).toHaveLength(1)
  })

  it('should handle transfer (both fromWarehouseId and toWarehouseId)', async () => {
    const org = await createTestOrg({ slug: 'confirm-transfer' })
    const fromWarehouse = await createTestWarehouse(org._id)
    const toWarehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    await createTestStockLevel(org._id, product._id, fromWarehouse._id, {
      quantity: 80,
      availableQuantity: 80,
      avgCost: 10,
    })

    const movement = await createTestStockMovement(org._id, {
      type: 'transfer',
      status: 'draft',
      fromWarehouseId: fromWarehouse._id,
      toWarehouseId: toWarehouse._id,
      lines: [{ productId: product._id, quantity: 30, unitCost: 10, totalCost: 300 }],
      totalAmount: 300,
    })

    await confirmMovement(String(movement._id))

    const fromLevel = await StockLevel.findOne({
      orgId: org._id,
      productId: product._id,
      warehouseId: fromWarehouse._id,
    })
    const toLevel = await StockLevel.findOne({
      orgId: org._id,
      productId: product._id,
      warehouseId: toWarehouse._id,
    })

    expect(fromLevel!.quantity).toBe(50)
    expect(toLevel!.quantity).toBe(30)
    expect(toLevel!.avgCost).toBe(10)
  })

  it('should process multiple lines correctly', async () => {
    const org = await createTestOrg({ slug: 'confirm-multi' })
    const toWarehouse = await createTestWarehouse(org._id)
    const productA = await createTestProduct(org._id, { name: 'Product A' })
    const productB = await createTestProduct(org._id, { name: 'Product B' })

    const movement = await createTestStockMovement(org._id, {
      type: 'receipt',
      status: 'draft',
      toWarehouseId: toWarehouse._id,
      lines: [
        { productId: productA._id, quantity: 10, unitCost: 5, totalCost: 50 },
        { productId: productB._id, quantity: 20, unitCost: 8, totalCost: 160 },
      ],
      totalAmount: 210,
    })

    await confirmMovement(String(movement._id))

    const levelA = await StockLevel.findOne({
      orgId: org._id,
      productId: productA._id,
      warehouseId: toWarehouse._id,
    })
    const levelB = await StockLevel.findOne({
      orgId: org._id,
      productId: productB._id,
      warehouseId: toWarehouse._id,
    })

    expect(levelA!.quantity).toBe(10)
    expect(levelA!.avgCost).toBe(5)
    expect(levelB!.quantity).toBe(20)
    expect(levelB!.avgCost).toBe(8)
  })

  it('should reject confirming a non-draft movement', async () => {
    const org = await createTestOrg({ slug: 'confirm-nondraft' })
    const warehouse = await createTestWarehouse(org._id)
    const product = await createTestProduct(org._id)

    const movement = await createTestStockMovement(org._id, {
      type: 'receipt',
      status: 'completed',
      toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 10, unitCost: 5, totalCost: 50 }],
      totalAmount: 50,
    })

    await expect(confirmMovement(String(movement._id))).rejects.toThrow(
      'Only draft movements can be confirmed',
    )
  })
})

describe('getStockValuation', () => {
  it('should return stock valuation items aggregated by product', async () => {
    const org = await createTestOrg({ slug: 'valuation-agg' })
    const product = await createTestProduct(org._id, { name: 'Widget' })
    const warehouse = await createTestWarehouse(org._id)

    await createTestStockLevel(org._id, product._id, warehouse._id, {
      quantity: 50,
      availableQuantity: 50,
      avgCost: 10,
    })

    const result = await getStockValuation(String(org._id))

    expect(result.items).toHaveLength(1)
    expect(result.items[0].name).toBe('Widget')
    expect(result.items[0].totalQty).toBe(50)
    expect(result.items[0].avgCost).toBe(10)
    expect(result.items[0].productId).toBe(String(product._id))
  })

  it('should calculate totalValue as sum of qty * avgCost', async () => {
    const org = await createTestOrg({ slug: 'valuation-total' })
    const productA = await createTestProduct(org._id, { name: 'A' })
    const productB = await createTestProduct(org._id, { name: 'B' })
    const warehouse = await createTestWarehouse(org._id)

    await createTestStockLevel(org._id, productA._id, warehouse._id, {
      quantity: 10,
      availableQuantity: 10,
      avgCost: 100,
    })
    await createTestStockLevel(org._id, productB._id, warehouse._id, {
      quantity: 20,
      availableQuantity: 20,
      avgCost: 50,
    })

    const result = await getStockValuation(String(org._id))

    // 10*100 + 20*50 = 1000 + 1000 = 2000
    expect(result.totalValue).toBe(2000)
    expect(result.items).toHaveLength(2)
  })

  it('should aggregate across multiple warehouses for the same product', async () => {
    const org = await createTestOrg({ slug: 'valuation-multi-wh' })
    const product = await createTestProduct(org._id, { name: 'Multi WH Product' })
    const wh1 = await createTestWarehouse(org._id)
    const wh2 = await createTestWarehouse(org._id)

    await createTestStockLevel(org._id, product._id, wh1._id, {
      quantity: 40,
      availableQuantity: 40,
      avgCost: 10,
    })
    await createTestStockLevel(org._id, product._id, wh2._id, {
      quantity: 60,
      availableQuantity: 60,
      avgCost: 20,
    })

    const result = await getStockValuation(String(org._id))

    expect(result.items).toHaveLength(1)
    expect(result.items[0].totalQty).toBe(100) // 40 + 60
    // totalValue = 40*10 + 60*20 = 400 + 1200 = 1600
    expect(result.items[0].totalValue).toBe(1600)
    // avgCost = 1600 / 100 = 16
    expect(result.items[0].avgCost).toBe(16)
    expect(result.totalValue).toBe(1600)
  })

  it('should return empty items for no stock', async () => {
    const org = await createTestOrg({ slug: 'valuation-empty' })

    const result = await getStockValuation(String(org._id))

    expect(result.items).toHaveLength(0)
    expect(result.totalValue).toBe(0)
  })
})
