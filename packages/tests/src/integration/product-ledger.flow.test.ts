import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestWarehouse, createTestUser, createTestContact, createTestInvoice } from '../helpers/factories'
import { StockMovement } from 'db/models'
import { confirmMovement } from 'services/biz/warehouse.service'
import { stockMovementDao } from 'services/dao/warehouse/stock-movement.dao'
import { getProductLedger } from 'services/biz/product-ledger.service'

beforeAll(async () => { await setupTestDB() })
afterAll(async () => { await teardownTestDB() })
afterEach(async () => { await clearCollections() })

describe('Product Ledger', () => {
  it('should return empty ledger for product with no movements', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)

    const result = await getProductLedger(String(org._id), String(product._id))

    expect(result.entries).toHaveLength(0)
    expect(result.total).toBe(0)
    expect(result.summary.currentQty).toBe(0)
    expect(result.summary.currentValue).toBe(0)
  })

  it('should show receipt as positive quantity change', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id)

    const mvNum = await stockMovementDao.getNextMovementNumber(String(org._id))
    const movement = await StockMovement.create({
      orgId: org._id, movementNumber: mvNum, type: 'receipt', status: 'draft',
      date: new Date(), toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 100, unitCost: 5, totalCost: 500 }],
      totalAmount: 500, createdBy: user._id,
    })
    await confirmMovement(String(movement._id))

    const result = await getProductLedger(String(org._id), String(product._id))

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].eventType).toBe('received')
    expect(result.entries[0].quantityChange).toBe(100)
    expect(result.entries[0].runningQty).toBe(100)
    expect(result.entries[0].runningValue).toBe(500)
    expect(result.summary.totalIn).toBe(100)
    expect(result.summary.totalOut).toBe(0)
    expect(result.summary.currentQty).toBe(100)
  })

  it('should show dispatch as negative quantity change', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id)

    // First receipt
    const mv1 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m1 = await StockMovement.create({
      orgId: org._id, movementNumber: mv1, type: 'receipt', status: 'draft',
      date: new Date('2026-01-01'), toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 100, unitCost: 5, totalCost: 500 }],
      totalAmount: 500, createdBy: user._id,
    })
    await confirmMovement(String(m1._id))

    // Then dispatch
    const mv2 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m2 = await StockMovement.create({
      orgId: org._id, movementNumber: mv2, type: 'dispatch', status: 'draft',
      date: new Date('2026-01-15'), fromWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 30, unitCost: 5, totalCost: 150 }],
      totalAmount: 150, createdBy: user._id,
    })
    await confirmMovement(String(m2._id))

    const result = await getProductLedger(String(org._id), String(product._id))

    expect(result.entries).toHaveLength(2)
    expect(result.entries[0].eventType).toBe('received')
    expect(result.entries[0].quantityChange).toBe(100)
    expect(result.entries[1].eventType).toBe('dispatched')
    expect(result.entries[1].quantityChange).toBe(-30)
    expect(result.entries[1].runningQty).toBe(70)
    expect(result.summary.totalIn).toBe(100)
    expect(result.summary.totalOut).toBe(30)
    expect(result.summary.currentQty).toBe(70)
  })

  it('should show transfer as two rows (out and in)', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const whA = await createTestWarehouse(org._id, { name: 'WH-A' })
    const whB = await createTestWarehouse(org._id, { name: 'WH-B' })
    const user = await createTestUser(org._id)

    // Receipt into WH-A
    const mv1 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m1 = await StockMovement.create({
      orgId: org._id, movementNumber: mv1, type: 'receipt', status: 'draft',
      date: new Date('2026-01-01'), toWarehouseId: whA._id,
      lines: [{ productId: product._id, quantity: 100, unitCost: 10, totalCost: 1000 }],
      totalAmount: 1000, createdBy: user._id,
    })
    await confirmMovement(String(m1._id))

    // Transfer from WH-A to WH-B
    const mv2 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m2 = await StockMovement.create({
      orgId: org._id, movementNumber: mv2, type: 'transfer', status: 'draft',
      date: new Date('2026-01-10'), fromWarehouseId: whA._id, toWarehouseId: whB._id,
      lines: [{ productId: product._id, quantity: 40, unitCost: 10, totalCost: 400 }],
      totalAmount: 400, createdBy: user._id,
    })
    await confirmMovement(String(m2._id))

    const result = await getProductLedger(String(org._id), String(product._id))

    // Should have 3 entries: receipt, transfer_out, transfer_in
    expect(result.entries).toHaveLength(3)
    expect(result.entries[0].eventType).toBe('received')
    expect(result.entries[1].eventType).toBe('transferred_out')
    expect(result.entries[1].quantityChange).toBe(-40)
    expect(result.entries[2].eventType).toBe('transferred_in')
    expect(result.entries[2].quantityChange).toBe(40)
    // Running qty: 100, 60, 100 (net zero for transfers across all warehouses)
    expect(result.entries[2].runningQty).toBe(100)
  })

  it('should filter transfer rows by warehouse', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const whA = await createTestWarehouse(org._id, { name: 'WH-A' })
    const whB = await createTestWarehouse(org._id, { name: 'WH-B' })
    const user = await createTestUser(org._id)

    // Receipt into WH-A
    const mv1 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m1 = await StockMovement.create({
      orgId: org._id, movementNumber: mv1, type: 'receipt', status: 'draft',
      date: new Date('2026-01-01'), toWarehouseId: whA._id,
      lines: [{ productId: product._id, quantity: 100, unitCost: 10, totalCost: 1000 }],
      totalAmount: 1000, createdBy: user._id,
    })
    await confirmMovement(String(m1._id))

    // Transfer from WH-A to WH-B
    const mv2 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m2 = await StockMovement.create({
      orgId: org._id, movementNumber: mv2, type: 'transfer', status: 'draft',
      date: new Date('2026-01-10'), fromWarehouseId: whA._id, toWarehouseId: whB._id,
      lines: [{ productId: product._id, quantity: 40, unitCost: 10, totalCost: 400 }],
      totalAmount: 400, createdBy: user._id,
    })
    await confirmMovement(String(m2._id))

    // Filter by WH-A: should see receipt + transferred_out
    const resultA = await getProductLedger(String(org._id), String(product._id), { warehouseId: String(whA._id) })
    expect(resultA.entries).toHaveLength(2)
    expect(resultA.entries[0].eventType).toBe('received')
    expect(resultA.entries[1].eventType).toBe('transferred_out')
    expect(resultA.summary.currentQty).toBe(60)

    // Filter by WH-B: should see only transferred_in
    const resultB = await getProductLedger(String(org._id), String(product._id), { warehouseId: String(whB._id) })
    expect(resultB.entries).toHaveLength(1)
    expect(resultB.entries[0].eventType).toBe('transferred_in')
    expect(resultB.summary.currentQty).toBe(40)
  })

  it('should filter by date range', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id)

    // Receipt in January
    const mv1 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m1 = await StockMovement.create({
      orgId: org._id, movementNumber: mv1, type: 'receipt', status: 'draft',
      date: new Date('2026-01-15'), toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 100, unitCost: 5, totalCost: 500 }],
      totalAmount: 500, createdBy: user._id,
    })
    await confirmMovement(String(m1._id))

    // Dispatch in March
    const mv2 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m2 = await StockMovement.create({
      orgId: org._id, movementNumber: mv2, type: 'dispatch', status: 'draft',
      date: new Date('2026-03-10'), fromWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 20, unitCost: 5, totalCost: 100 }],
      totalAmount: 100, createdBy: user._id,
    })
    await confirmMovement(String(m2._id))

    // Filter: only February — should return empty
    const resultFeb = await getProductLedger(String(org._id), String(product._id), {
      dateFrom: '2026-02-01', dateTo: '2026-02-28',
    })
    expect(resultFeb.entries).toHaveLength(0)

    // Filter: Jan-Feb — should return only the receipt
    const resultJanFeb = await getProductLedger(String(org._id), String(product._id), {
      dateFrom: '2026-01-01', dateTo: '2026-02-28',
    })
    expect(resultJanFeb.entries).toHaveLength(1)
    expect(resultJanFeb.entries[0].eventType).toBe('received')
  })

  it('should compute correct running value', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id)

    // Receipt: 50 units at 10 each
    const mv1 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m1 = await StockMovement.create({
      orgId: org._id, movementNumber: mv1, type: 'receipt', status: 'draft',
      date: new Date('2026-01-01'), toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 50, unitCost: 10, totalCost: 500 }],
      totalAmount: 500, createdBy: user._id,
    })
    await confirmMovement(String(m1._id))

    // Receipt: 30 units at 15 each
    const mv2 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m2 = await StockMovement.create({
      orgId: org._id, movementNumber: mv2, type: 'receipt', status: 'draft',
      date: new Date('2026-01-05'), toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 30, unitCost: 15, totalCost: 450 }],
      totalAmount: 450, createdBy: user._id,
    })
    await confirmMovement(String(m2._id))

    const result = await getProductLedger(String(org._id), String(product._id))

    expect(result.entries).toHaveLength(2)
    expect(result.entries[0].runningQty).toBe(50)
    expect(result.entries[0].runningValue).toBe(500)
    expect(result.entries[1].runningQty).toBe(80)
    expect(result.entries[1].runningValue).toBe(950) // 500 + 450
    expect(result.summary.currentQty).toBe(80)
    expect(result.summary.currentValue).toBe(950)
  })

  it('should include invoice number for invoice-triggered movements', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const invoice = await createTestInvoice(org._id, contact._id)

    // Create movement linked to invoice
    const mvNum = await stockMovementDao.getNextMovementNumber(String(org._id))
    const movement = await StockMovement.create({
      orgId: org._id, movementNumber: mvNum, type: 'dispatch', status: 'draft',
      date: new Date(), fromWarehouseId: warehouse._id, invoiceId: invoice._id,
      lines: [{ productId: product._id, quantity: 10, unitCost: 5, totalCost: 50 }],
      totalAmount: 50, createdBy: user._id,
    })
    await confirmMovement(String(movement._id))

    const result = await getProductLedger(String(org._id), String(product._id))

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].invoiceNumber).toBe(invoice.invoiceNumber)
    expect(result.entries[0].eventType).toBe('dispatched')
  })
})
