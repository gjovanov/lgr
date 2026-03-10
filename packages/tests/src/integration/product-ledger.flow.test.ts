import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestProduct, createTestWarehouse, createTestUser, createTestContact, createTestInvoice } from '../helpers/factories'
import { StockMovement, Invoice } from 'db/models'
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

  it('should paginate results and preserve running totals', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id)

    // Create 5 receipt movements
    for (let i = 0; i < 5; i++) {
      const mvNum = await stockMovementDao.getNextMovementNumber(String(org._id))
      const m = await StockMovement.create({
        orgId: org._id, movementNumber: mvNum, type: 'receipt', status: 'draft',
        date: new Date(`2026-01-${String(i + 1).padStart(2, '0')}`), toWarehouseId: warehouse._id,
        lines: [{ productId: product._id, quantity: 10, unitCost: 5, totalCost: 50 }],
        totalAmount: 50, createdBy: user._id,
      })
      await confirmMovement(String(m._id))
    }

    // Page 0, size 2
    const page0 = await getProductLedger(String(org._id), String(product._id), { page: 0, size: 2 })
    expect(page0.entries).toHaveLength(2)
    expect(page0.total).toBe(5)
    expect(page0.totalPages).toBe(3)
    expect(page0.entries[0].runningQty).toBe(10)
    expect(page0.entries[1].runningQty).toBe(20)

    // Page 1, size 2 — running totals should be absolute (not reset)
    const page1 = await getProductLedger(String(org._id), String(product._id), { page: 1, size: 2 })
    expect(page1.entries).toHaveLength(2)
    expect(page1.entries[0].runningQty).toBe(30)
    expect(page1.entries[1].runningQty).toBe(40)

    // Summary should be the same regardless of page
    expect(page0.summary.currentQty).toBe(50)
    expect(page1.summary.currentQty).toBe(50)
  })

  it('should filter by event type while preserving running totals', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id)

    // Receipt
    const mv1 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m1 = await StockMovement.create({
      orgId: org._id, movementNumber: mv1, type: 'receipt', status: 'draft',
      date: new Date('2026-01-01'), toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 100, unitCost: 5, totalCost: 500 }],
      totalAmount: 500, createdBy: user._id,
    })
    await confirmMovement(String(m1._id))

    // Dispatch
    const mv2 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m2 = await StockMovement.create({
      orgId: org._id, movementNumber: mv2, type: 'dispatch', status: 'draft',
      date: new Date('2026-01-15'), fromWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 30, unitCost: 5, totalCost: 150 }],
      totalAmount: 150, createdBy: user._id,
    })
    await confirmMovement(String(m2._id))

    // Filter by 'received' only
    const result = await getProductLedger(String(org._id), String(product._id), { eventTypes: ['received'] })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].eventType).toBe('received')
    // Running qty is from full dataset computation
    expect(result.entries[0].runningQty).toBe(100)

    // Filter by 'dispatched' only
    const result2 = await getProductLedger(String(org._id), String(product._id), { eventTypes: ['dispatched'] })
    expect(result2.entries).toHaveLength(1)
    expect(result2.entries[0].eventType).toBe('dispatched')
    expect(result2.entries[0].runningQty).toBe(70) // absolute running total
  })

  it('should include contact info from movement and fallback to invoice contact', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id, { companyName: 'Test Corp' })
    const invoice = await createTestInvoice(org._id, contact._id)

    // Movement with contactId set directly
    const mv1 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m1 = await StockMovement.create({
      orgId: org._id, movementNumber: mv1, type: 'dispatch', status: 'draft',
      date: new Date('2026-01-01'), fromWarehouseId: warehouse._id,
      contactId: contact._id,
      lines: [{ productId: product._id, quantity: 10, unitCost: 5, totalCost: 50 }],
      totalAmount: 50, createdBy: user._id,
    })
    await confirmMovement(String(m1._id))

    // Movement linked to invoice (contactId not set on movement, fallback to invoice contact)
    const mv2 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m2 = await StockMovement.create({
      orgId: org._id, movementNumber: mv2, type: 'dispatch', status: 'draft',
      date: new Date('2026-01-02'), fromWarehouseId: warehouse._id,
      invoiceId: invoice._id,
      lines: [{ productId: product._id, quantity: 5, unitCost: 5, totalCost: 25 }],
      totalAmount: 25, createdBy: user._id,
    })
    await confirmMovement(String(m2._id))

    const result = await getProductLedger(String(org._id), String(product._id))
    expect(result.entries).toHaveLength(2)
    // Direct contact
    expect(result.entries[0].contactName).toBe('Test Corp')
    expect(result.entries[0].contactId).toBe(String(contact._id))
    // Fallback from invoice
    expect(result.entries[1].contactName).toBe('Test Corp')
    expect(result.entries[1].contactId).toBe(String(contact._id))
  })

  it('should filter by contactId', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id)
    const contactA = await createTestContact(org._id, { companyName: 'Corp A' })
    const contactB = await createTestContact(org._id, { companyName: 'Corp B' })

    // Movement for contact A
    const mv1 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m1 = await StockMovement.create({
      orgId: org._id, movementNumber: mv1, type: 'dispatch', status: 'draft',
      date: new Date('2026-01-01'), fromWarehouseId: warehouse._id,
      contactId: contactA._id,
      lines: [{ productId: product._id, quantity: 10, unitCost: 5, totalCost: 50 }],
      totalAmount: 50, createdBy: user._id,
    })
    await confirmMovement(String(m1._id))

    // Movement for contact B
    const mv2 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m2 = await StockMovement.create({
      orgId: org._id, movementNumber: mv2, type: 'dispatch', status: 'draft',
      date: new Date('2026-01-02'), fromWarehouseId: warehouse._id,
      contactId: contactB._id,
      lines: [{ productId: product._id, quantity: 5, unitCost: 5, totalCost: 25 }],
      totalAmount: 25, createdBy: user._id,
    })
    await confirmMovement(String(m2._id))

    // Filter by contact A
    const result = await getProductLedger(String(org._id), String(product._id), { contactId: String(contactA._id) })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].contactName).toBe('Corp A')
  })

  it('should compute sales summary from invoices', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)

    // Cash register sale invoice
    await Invoice.create({
      orgId: org._id, invoiceNumber: 'CS-2026-00001', type: 'cash_sale', direction: 'outgoing',
      status: 'paid', contactId: contact._id, issueDate: new Date(), dueDate: new Date(),
      currency: 'EUR', exchangeRate: 1,
      lines: [{ productId: product._id, description: 'Test', quantity: 5, unit: 'pcs', unitPrice: 20, discount: 0, taxRate: 18, taxAmount: 18, lineTotal: 100, warehouseId: warehouse._id }],
      subtotal: 100, discountTotal: 0, taxTotal: 18, total: 118, totalBase: 118,
      amountPaid: 118, amountDue: 0,
      billingAddress: { street: 'S', city: 'C', postalCode: '1000', country: 'MK' },
      createdBy: user._id,
    })

    // Regular invoice
    await Invoice.create({
      orgId: org._id, invoiceNumber: 'INV-2026-00001', type: 'invoice', direction: 'outgoing',
      status: 'sent', contactId: contact._id, issueDate: new Date(), dueDate: new Date(),
      currency: 'EUR', exchangeRate: 1,
      lines: [{ productId: product._id, description: 'Test', quantity: 10, unit: 'pcs', unitPrice: 30, discount: 0, taxRate: 18, taxAmount: 54, lineTotal: 300, warehouseId: warehouse._id }],
      subtotal: 300, discountTotal: 0, taxTotal: 54, total: 354, totalBase: 354,
      amountPaid: 0, amountDue: 354,
      billingAddress: { street: 'S', city: 'C', postalCode: '1000', country: 'MK' },
      createdBy: user._id,
    })

    // Draft invoice (should NOT be included)
    await Invoice.create({
      orgId: org._id, invoiceNumber: 'INV-2026-00002', type: 'invoice', direction: 'outgoing',
      status: 'draft', contactId: contact._id, issueDate: new Date(), dueDate: new Date(),
      currency: 'EUR', exchangeRate: 1,
      lines: [{ productId: product._id, description: 'Test', quantity: 50, unit: 'pcs', unitPrice: 10, discount: 0, taxRate: 18, taxAmount: 90, lineTotal: 500 }],
      subtotal: 500, discountTotal: 0, taxTotal: 90, total: 590, totalBase: 590,
      amountPaid: 0, amountDue: 590,
      billingAddress: { street: 'S', city: 'C', postalCode: '1000', country: 'MK' },
      createdBy: user._id,
    })

    const result = await getProductLedger(String(org._id), String(product._id))
    expect(result.summary.totalCashRegisterSales).toBe(100)
    expect(result.summary.totalInvoiceSales).toBe(300)
    expect(result.summary.totalSales).toBe(400)
  })

  it('should resolve warehouse for adjustment movements (inventory count fix)', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id, { name: 'Main Warehouse' })
    const user = await createTestUser(org._id)

    // Create adjustment with toWarehouseId only (like inventory count generates)
    const mvNum = await stockMovementDao.getNextMovementNumber(String(org._id))
    const movement = await StockMovement.create({
      orgId: org._id, movementNumber: mvNum, type: 'adjustment', status: 'draft',
      date: new Date(), toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 50, unitCost: 0, totalCost: 0 }],
      totalAmount: 0, createdBy: user._id,
    })
    await confirmMovement(String(movement._id))

    const result = await getProductLedger(String(org._id), String(product._id))
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].eventType).toBe('adjusted')
    expect(result.entries[0].warehouseId).toBe(String(warehouse._id))
    expect(result.entries[0].warehouseName).toBe('Main Warehouse')
    expect(result.entries[0].quantityChange).toBe(50)
  })
})
