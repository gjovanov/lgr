import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestProduct, createTestWarehouse, createTestStockLevel, createTestStockMovement, createTestInventoryCount, createTestPriceList } from '../helpers/factories'
import { StockLevel, StockMovement, Product, Warehouse, InventoryCount, PriceList } from 'db/models'
import { Types } from 'mongoose'
import { adjustStock, confirmMovement, getStockValuation } from 'services/biz/warehouse.service'
import { paginateQuery } from 'services/utils/pagination'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('Warehouse Flow', () => {
  it('should adjust stock and create stock level if not exists', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    await adjustStock(String(org._id), String(product._id), String(warehouse._id), 50, 25)

    const level = await StockLevel.findOne({
      orgId: org._id,
      productId: product._id,
      warehouseId: warehouse._id,
    })

    expect(level).toBeDefined()
    expect(level!.quantity).toBe(50)
    expect(level!.availableQuantity).toBe(50)
    expect(level!.avgCost).toBe(25)
  })

  it('should calculate weighted average cost on stock addition', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    // Initial stock: 100 units at 50 EUR
    await adjustStock(String(org._id), String(product._id), String(warehouse._id), 100, 50)
    // Add 50 units at 80 EUR
    await adjustStock(String(org._id), String(product._id), String(warehouse._id), 50, 80)

    const level = await StockLevel.findOne({
      orgId: org._id,
      productId: product._id,
      warehouseId: warehouse._id,
    })

    expect(level!.quantity).toBe(150)
    // Weighted avg: (100*50 + 50*80) / 150 = 9000/150 = 60
    expect(level!.avgCost).toBeCloseTo(60)
  })

  it('should confirm a stock receipt movement', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    const movement = await StockMovement.create({
      orgId: org._id,
      movementNumber: 'SM-001',
      type: 'receipt',
      status: 'draft',
      date: new Date(),
      toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 200, unitCost: 30, totalCost: 6000 }],
      totalAmount: 6000,
      createdBy: user._id,
    })

    const confirmed = await confirmMovement(String(movement._id))
    expect(confirmed.status).toBe('completed')

    const level = await StockLevel.findOne({
      orgId: org._id,
      productId: product._id,
      warehouseId: warehouse._id,
    })
    expect(level!.quantity).toBe(200)
    expect(level!.avgCost).toBe(30)
  })

  it('should confirm a transfer between warehouses', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const product = await createTestProduct(org._id)
    const whSource = await createTestWarehouse(org._id, { name: 'Source WH', code: 'WH-SRC' })
    const whDest = await createTestWarehouse(org._id, { name: 'Dest WH', code: 'WH-DST' })

    // Pre-fill source warehouse
    await createTestStockLevel(org._id, product._id, whSource._id, { quantity: 100, availableQuantity: 100, avgCost: 40 })

    const movement = await StockMovement.create({
      orgId: org._id,
      movementNumber: 'SM-002',
      type: 'transfer',
      status: 'draft',
      date: new Date(),
      fromWarehouseId: whSource._id,
      toWarehouseId: whDest._id,
      lines: [{ productId: product._id, quantity: 30, unitCost: 40, totalCost: 1200 }],
      totalAmount: 1200,
      createdBy: user._id,
    })

    await confirmMovement(String(movement._id))

    const srcLevel = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: whSource._id })
    const dstLevel = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: whDest._id })

    expect(srcLevel!.quantity).toBe(70)
    expect(dstLevel!.quantity).toBe(30)
  })

  it('should generate stock valuation across warehouses', async () => {
    const org = await createTestOrg()
    const productA = await createTestProduct(org._id, { name: 'Widget A' })
    const productB = await createTestProduct(org._id, { name: 'Widget B' })
    const wh1 = await createTestWarehouse(org._id, { name: 'WH1', code: 'WH1' })
    const wh2 = await createTestWarehouse(org._id, { name: 'WH2', code: 'WH2' })

    await createTestStockLevel(org._id, productA._id, wh1._id, { quantity: 100, availableQuantity: 100, avgCost: 10 })
    await createTestStockLevel(org._id, productA._id, wh2._id, { quantity: 50, availableQuantity: 50, avgCost: 12 })
    await createTestStockLevel(org._id, productB._id, wh1._id, { quantity: 200, availableQuantity: 200, avgCost: 5 })

    const valuation = await getStockValuation(String(org._id))

    expect(valuation.items).toHaveLength(2)
    // Product A: 100*10 + 50*12 = 1600
    // Product B: 200*5 = 1000
    expect(valuation.totalValue).toBe(2600)

    const itemA = valuation.items.find(i => i.name === 'Widget A')
    expect(itemA!.totalQty).toBe(150)
    expect(itemA!.totalValue).toBe(1600)
  })

  it('should reject confirming a non-draft movement', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    const movement = await StockMovement.create({
      orgId: org._id,
      movementNumber: 'SM-003',
      type: 'receipt',
      status: 'completed',
      date: new Date(),
      toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 10, unitCost: 5, totalCost: 50 }],
      totalAmount: 50,
      createdBy: user._id,
    })

    await expect(confirmMovement(String(movement._id))).rejects.toThrow('Only draft movements can be confirmed')
  })
})

describe('Warehouse Pagination', () => {
  it('should paginate products', async () => {
    const org = await createTestOrg()
    for (let i = 0; i < 15; i++) {
      await createTestProduct(org._id, { name: `Product ${String(i).padStart(2, '0')}`, sku: `SKU-${Date.now()}-${i}` })
    }
    const p0 = await paginateQuery(Product, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)
    expect(p0.totalPages).toBe(2)

    const p1 = await paginateQuery(Product, { orgId: org._id }, { page: '1' })
    expect(p1.items).toHaveLength(5)

    const all = await paginateQuery(Product, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate products with sort', async () => {
    const org = await createTestOrg()
    await createTestProduct(org._id, { name: 'Charlie', sku: 'SKU-C' })
    await createTestProduct(org._id, { name: 'Alice', sku: 'SKU-A' })
    await createTestProduct(org._id, { name: 'Bob', sku: 'SKU-B' })

    const sorted = await paginateQuery(Product, { orgId: org._id }, { sortBy: 'name', sortOrder: 'asc' })
    expect(sorted.items[0].name).toBe('Alice')
    expect(sorted.items[1].name).toBe('Bob')
    expect(sorted.items[2].name).toBe('Charlie')
  })

  it('should paginate warehouses', async () => {
    const org = await createTestOrg()
    for (let i = 0; i < 15; i++) {
      await createTestWarehouse(org._id, { name: `WH ${String(i).padStart(2, '0')}`, code: `WH-${Date.now()}-${i}` })
    }
    const p0 = await paginateQuery(Warehouse, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(Warehouse, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate stock movements', async () => {
    const org = await createTestOrg()
    for (let i = 0; i < 15; i++) {
      await createTestStockMovement(org._id, { movementNumber: `SM-${String(i).padStart(3, '0')}` })
    }
    const p0 = await paginateQuery(StockMovement, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(StockMovement, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate stock levels', async () => {
    const org = await createTestOrg()
    const warehouse = await createTestWarehouse(org._id)
    for (let i = 0; i < 15; i++) {
      const product = await createTestProduct(org._id, { sku: `SL-SKU-${Date.now()}-${i}` })
      await createTestStockLevel(org._id, product._id, warehouse._id, { quantity: i * 10 })
    }
    const p0 = await paginateQuery(StockLevel, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(StockLevel, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate inventory counts', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const warehouse = await createTestWarehouse(org._id)
    for (let i = 0; i < 15; i++) {
      await createTestInventoryCount(org._id, warehouse._id, user._id, { countNumber: `IC-${String(i).padStart(3, '0')}` })
    }
    const p0 = await paginateQuery(InventoryCount, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(InventoryCount, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate price lists', async () => {
    const org = await createTestOrg()
    for (let i = 0; i < 15; i++) {
      await createTestPriceList(org._id, { name: `Price List ${String(i).padStart(2, '0')}` })
    }
    const p0 = await paginateQuery(PriceList, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(PriceList, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })
})
