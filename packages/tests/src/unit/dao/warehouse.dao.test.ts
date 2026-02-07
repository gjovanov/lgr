import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../../setup'
import { productDao } from 'services/dao/warehouse/product.dao'
import { warehouseDao } from 'services/dao/warehouse/warehouse.dao'
import { stockLevelDao } from 'services/dao/warehouse/stock-level.dao'
import { stockMovementDao } from 'services/dao/warehouse/stock-movement.dao'
import {
  createTestOrg,
  createTestProduct,
  createTestWarehouse,
  createTestStockLevel,
  createTestStockMovement,
} from '../../helpers/factories'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('ProductDao', () => {
  it('should find product by SKU', async () => {
    const org = await createTestOrg({ slug: 'product-sku-org' })
    await createTestProduct(org._id, { sku: 'WIDGET-001', name: 'Blue Widget' })

    const found = await productDao.findBySku(String(org._id), 'WIDGET-001')
    expect(found).toBeDefined()
    expect(found!.sku).toBe('WIDGET-001')
    expect(found!.name).toBe('Blue Widget')
  })

  it('should return null for non-existent SKU', async () => {
    const org = await createTestOrg({ slug: 'product-nosku-org' })

    const found = await productDao.findBySku(String(org._id), 'DOES-NOT-EXIST')
    expect(found).toBeNull()
  })

  it('should find products by category', async () => {
    const org = await createTestOrg({ slug: 'product-cat-org' })
    await createTestProduct(org._id, { sku: 'ELEC-001', category: 'Electronics' })
    await createTestProduct(org._id, { sku: 'ELEC-002', category: 'Electronics' })
    await createTestProduct(org._id, { sku: 'FURN-001', category: 'Furniture' })

    const electronics = await productDao.findByCategory(String(org._id), 'Electronics')
    expect(electronics).toHaveLength(2)
    expect(electronics.every((p) => p.category === 'Electronics')).toBe(true)
  })

  it('should return empty array for category with no products', async () => {
    const org = await createTestOrg({ slug: 'product-emptycat-org' })

    const results = await productDao.findByCategory(String(org._id), 'NonExistent')
    expect(results).toHaveLength(0)
  })
})

describe('WarehouseDao', () => {
  it('should find the default warehouse', async () => {
    const org = await createTestOrg({ slug: 'wh-default-org' })
    await createTestWarehouse(org._id, { name: 'Main', code: 'WH-MAIN', isDefault: true })
    await createTestWarehouse(org._id, { name: 'Secondary', code: 'WH-SEC', isDefault: false })

    const defaultWh = await warehouseDao.findDefault(String(org._id))
    expect(defaultWh).toBeDefined()
    expect(defaultWh!.name).toBe('Main')
    expect(defaultWh!.isDefault).toBe(true)
  })

  it('should return null when no default warehouse exists', async () => {
    const org = await createTestOrg({ slug: 'wh-nodefault-org' })
    await createTestWarehouse(org._id, { isDefault: false })

    const defaultWh = await warehouseDao.findDefault(String(org._id))
    expect(defaultWh).toBeNull()
  })

  it('should find only active warehouses', async () => {
    const org = await createTestOrg({ slug: 'wh-active-org' })
    await createTestWarehouse(org._id, { name: 'Active 1', code: 'WH-A1', isActive: true })
    await createTestWarehouse(org._id, { name: 'Active 2', code: 'WH-A2', isActive: true })
    await createTestWarehouse(org._id, { name: 'Inactive', code: 'WH-I1', isActive: false })

    const active = await warehouseDao.findActive(String(org._id))
    expect(active).toHaveLength(2)
    expect(active.every((w) => w.isActive)).toBe(true)
  })
})

describe('StockLevelDao', () => {
  it('should find stock levels by product across warehouses', async () => {
    const org = await createTestOrg({ slug: 'sl-product-org' })
    const product = await createTestProduct(org._id, { sku: 'SL-PROD' })
    const wh1 = await createTestWarehouse(org._id, { code: 'SL-WH1' })
    const wh2 = await createTestWarehouse(org._id, { code: 'SL-WH2' })
    await createTestStockLevel(org._id, product._id, wh1._id, { quantity: 50 })
    await createTestStockLevel(org._id, product._id, wh2._id, { quantity: 30 })

    const levels = await stockLevelDao.findByProduct(String(org._id), String(product._id))
    expect(levels).toHaveLength(2)
    const quantities = levels.map((sl) => sl.quantity).sort((a, b) => a - b)
    expect(quantities).toEqual([30, 50])
  })

  it('should find stock levels by warehouse for all products', async () => {
    const org = await createTestOrg({ slug: 'sl-warehouse-org' })
    const product1 = await createTestProduct(org._id, { sku: 'SL-P1' })
    const product2 = await createTestProduct(org._id, { sku: 'SL-P2' })
    const wh = await createTestWarehouse(org._id, { code: 'SL-WH-ALL' })
    await createTestStockLevel(org._id, product1._id, wh._id, { quantity: 100 })
    await createTestStockLevel(org._id, product2._id, wh._id, { quantity: 200 })

    const levels = await stockLevelDao.findByWarehouse(String(org._id), String(wh._id))
    expect(levels).toHaveLength(2)
  })

  it('should find stock level by product and warehouse', async () => {
    const org = await createTestOrg({ slug: 'sl-prodwh-org' })
    const product = await createTestProduct(org._id, { sku: 'SL-PW' })
    const wh = await createTestWarehouse(org._id, { code: 'SL-WH-PW' })
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: 75, avgCost: 12 })

    const level = await stockLevelDao.findByProductAndWarehouse(
      String(org._id),
      String(product._id),
      String(wh._id),
    )
    expect(level).toBeDefined()
    expect(level!.quantity).toBe(75)
    expect(level!.avgCost).toBe(12)
  })

  it('should create stock level via adjustQuantity when none exists', async () => {
    const org = await createTestOrg({ slug: 'sl-adjust-org' })
    const product = await createTestProduct(org._id, { sku: 'SL-ADJ' })
    const wh = await createTestWarehouse(org._id, { code: 'SL-WH-ADJ' })

    const level = await stockLevelDao.adjustQuantity(
      String(org._id),
      String(product._id),
      String(wh._id),
      25,
      10,
    )
    expect(level).toBeDefined()
    expect(level.quantity).toBe(25)
    expect(level.availableQuantity).toBe(25)
    expect(level.reservedQuantity).toBe(0)
    expect(level.avgCost).toBe(10)

    // Adjust again on the same product+warehouse -- should update, not create
    const updated = await stockLevelDao.adjustQuantity(
      String(org._id),
      String(product._id),
      String(wh._id),
      15,
      20,
    )
    expect(updated.quantity).toBe(40) // 25 + 15
    expect(updated.availableQuantity).toBe(40)
  })
})

describe('StockMovementDao', () => {
  it('should find movements by type', async () => {
    const org = await createTestOrg({ slug: 'sm-type-org' })
    await createTestStockMovement(org._id, { movementNumber: 'SM-R1', type: 'receipt' })
    await createTestStockMovement(org._id, { movementNumber: 'SM-R2', type: 'receipt' })
    await createTestStockMovement(org._id, { movementNumber: 'SM-T1', type: 'transfer' })

    const receipts = await stockMovementDao.findByType(String(org._id), 'receipt')
    expect(receipts).toHaveLength(2)
    expect(receipts.every((m) => m.type === 'receipt')).toBe(true)
  })

  it('should find movements by product in lines', async () => {
    const org = await createTestOrg({ slug: 'sm-prod-org' })
    const product = await createTestProduct(org._id, { sku: 'SM-PROD' })
    await createTestStockMovement(org._id, {
      movementNumber: 'SM-LP1',
      type: 'receipt',
      lines: [{ productId: product._id, quantity: 10, unitCost: 5, totalCost: 50 }] as any,
    })
    await createTestStockMovement(org._id, { movementNumber: 'SM-LP2', type: 'receipt', lines: [] })

    const movements = await stockMovementDao.findByProduct(String(org._id), String(product._id))
    expect(movements).toHaveLength(1)
    expect(movements[0].movementNumber).toBe('SM-LP1')
  })

  it('should auto-increment movement number in SM-YYYY-NNNNN format', async () => {
    const org = await createTestOrg({ slug: 'sm-autonum-org' })
    const year = new Date().getFullYear()
    const prefix = `SM-${year}-`

    // No existing movements -- first number should be 00001
    const first = await stockMovementDao.getNextMovementNumber(String(org._id))
    expect(first).toBe(`${prefix}00001`)

    // Create a movement with that number, then get next
    await createTestStockMovement(org._id, { movementNumber: first })
    const second = await stockMovementDao.getNextMovementNumber(String(org._id))
    expect(second).toBe(`${prefix}00002`)
  })
})

describe('Multi-tenancy isolation', () => {
  it('should not leak products between orgs', async () => {
    const org1 = await createTestOrg({ slug: 'iso-wh-org1' })
    const org2 = await createTestOrg({ slug: 'iso-wh-org2' })

    await createTestProduct(org1._id, { sku: 'ISO-SKU', name: 'Org1 Product', category: 'Shared' })
    await createTestProduct(org2._id, { sku: 'ISO-SKU', name: 'Org2 Product', category: 'Shared' })

    // Same SKU, different orgs
    const fromOrg1 = await productDao.findBySku(String(org1._id), 'ISO-SKU')
    const fromOrg2 = await productDao.findBySku(String(org2._id), 'ISO-SKU')

    expect(fromOrg1).toBeDefined()
    expect(fromOrg2).toBeDefined()
    expect(fromOrg1!.name).toBe('Org1 Product')
    expect(fromOrg2!.name).toBe('Org2 Product')

    // Category query should be scoped to org
    const org1Cat = await productDao.findByCategory(String(org1._id), 'Shared')
    const org2Cat = await productDao.findByCategory(String(org2._id), 'Shared')
    expect(org1Cat).toHaveLength(1)
    expect(org2Cat).toHaveLength(1)

    // Cross-org query returns null
    const crossCheck = await productDao.findBySku(String(org2._id), 'NON-EXISTENT-IN-ORG2')
    expect(crossCheck).toBeNull()
  })
})
