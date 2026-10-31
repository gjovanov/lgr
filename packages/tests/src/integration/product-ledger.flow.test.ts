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

  it('should carry the balance on either side of each movement', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id)

    const mv1 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m1 = await StockMovement.create({
      orgId: org._id, movementNumber: mv1, type: 'receipt', status: 'draft',
      date: new Date('2026-01-01'), toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 100, unitCost: 5, totalCost: 500 }],
      totalAmount: 500, createdBy: user._id,
    })
    await confirmMovement(String(m1._id))

    const mv2 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m2 = await StockMovement.create({
      orgId: org._id, movementNumber: mv2, type: 'dispatch', status: 'draft',
      date: new Date('2026-01-15'), fromWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 30, unitCost: 5, totalCost: 150 }],
      totalAmount: 150, createdBy: user._id,
    })
    await confirmMovement(String(m2._id))

    const result = await getProductLedger(String(org._id), String(product._id))

    // Opening balance of the very first movement is zero, and each row's end is the next
    // row's start, so the column reads as a continuous balance.
    expect(result.entries[0].startQty).toBe(0)
    expect(result.entries[0].endQty).toBe(100)
    expect(result.entries[1].startQty).toBe(100)
    expect(result.entries[1].endQty).toBe(70)

    for (const e of result.entries) {
      expect(e.endQty).toBe(e.startQty + e.quantityChange)
      // endQty supersedes runningQty in the UI; they must not drift apart.
      expect(e.endQty).toBe(e.runningQty)
    }
  })

  it('keeps the balance absolute when the event-type filter hides neighbouring rows', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id)

    const mv1 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m1 = await StockMovement.create({
      orgId: org._id, movementNumber: mv1, type: 'receipt', status: 'draft',
      date: new Date('2026-01-01'), toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 100, unitCost: 5, totalCost: 500 }],
      totalAmount: 500, createdBy: user._id,
    })
    await confirmMovement(String(m1._id))

    const mv2 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m2 = await StockMovement.create({
      orgId: org._id, movementNumber: mv2, type: 'dispatch', status: 'draft',
      date: new Date('2026-01-15'), fromWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 30, unitCost: 5, totalCost: 150 }],
      totalAmount: 150, createdBy: user._id,
    })
    await confirmMovement(String(m2._id))

    const result = await getProductLedger(String(org._id), String(product._id), {
      eventTypes: ['dispatched'],
    })

    expect(result.entries).toHaveLength(1)
    // The hidden receipt still counts towards the opening balance of the dispatch.
    expect(result.entries[0].startQty).toBe(100)
    expect(result.entries[0].endQty).toBe(70)
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

  it('treats a from-side adjustment (write-off) as a REDUCTION in the ledger, matching the stock engine', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id, { name: 'Main Warehouse' })
    const user = await createTestUser(org._id)

    // Opening receipt (positive balance)
    const mv1 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m1 = await StockMovement.create({
      orgId: org._id, movementNumber: mv1, type: 'receipt', status: 'draft',
      date: new Date('2026-01-01'), toWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 100, unitCost: 5, totalCost: 500 }],
      totalAmount: 500, createdBy: user._id,
    })
    await confirmMovement(String(m1._id))

    // book-corrections-style write-off: fromWarehouseId + POSITIVE absolute quantity.
    // The stock engine reduces by 30 (100 → 70); the ledger must show the same sign, not +30.
    const mv2 = await stockMovementDao.getNextMovementNumber(String(org._id))
    const m2 = await StockMovement.create({
      orgId: org._id, movementNumber: mv2, type: 'adjustment', status: 'draft',
      date: new Date('2026-01-15'), fromWarehouseId: warehouse._id,
      lines: [{ productId: product._id, quantity: 30, unitCost: 5, totalCost: 150 }],
      totalAmount: 150, createdBy: user._id,
    })
    await confirmMovement(String(m2._id))

    const result = await getProductLedger(String(org._id), String(product._id))
    expect(result.entries).toHaveLength(2)
    expect(result.entries[1].eventType).toBe('adjusted')
    expect(result.entries[1].quantityChange).toBe(-30)
    expect(result.entries[1].runningQty).toBe(70)
    expect(result.summary.totalOut).toBe(30)
  })
})

/**
 * The ledger sorts by any of its columns — every filtered row, before it is paged — and its
 * filters (period, contact, event type) hide rows without moving the balance: each row's start
 * and end quantity is the stock on either side of it.
 */
describe('Product Ledger — sorting, and filters that keep the balance absolute', () => {
  /**
   * Five movements, chronologically (start → end):
   *   r1 01-05 receipt  +100 @5  Corp A      0 → 100
   *   r2 02-10 dispatch  −30     Corp B    100 →  70
   *   r3 02-20 dispatch   −5     (invoice to Corp B)  70 → 65
   *   r4 03-01 receipt   +40 @6  —          65 → 105
   *   r5 03-15 15:30Z dispatch −12 Corp A  105 →  93
   */
  async function seedLedger() {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    const user = await createTestUser(org._id)
    const contactA = await createTestContact(org._id, { companyName: 'Corp A' })
    const contactB = await createTestContact(org._id, { companyName: 'Corp B' })
    const invoiceB = await createTestInvoice(org._id, contactB._id)

    const book = async (f: { type: 'receipt' | 'dispatch'; date: string; qty: number; unitCost?: number; contactId?: any; invoiceId?: any }) => {
      const unitCost = f.unitCost ?? 5
      const m = await StockMovement.create({
        orgId: org._id, movementNumber: await stockMovementDao.getNextMovementNumber(String(org._id)),
        type: f.type, status: 'draft', date: new Date(f.date),
        ...(f.type === 'receipt' ? { toWarehouseId: warehouse._id } : { fromWarehouseId: warehouse._id }),
        ...(f.contactId ? { contactId: f.contactId } : {}),
        ...(f.invoiceId ? { invoiceId: f.invoiceId } : {}),
        lines: [{ productId: product._id, quantity: f.qty, unitCost, totalCost: f.qty * unitCost }],
        totalAmount: f.qty * unitCost, createdBy: user._id,
      })
      await confirmMovement(String(m._id))
      return m.movementNumber as string
    }
    const r1 = await book({ type: 'receipt', date: '2026-01-05', qty: 100, contactId: contactA._id })
    const r2 = await book({ type: 'dispatch', date: '2026-02-10', qty: 30, contactId: contactB._id })
    const r3 = await book({ type: 'dispatch', date: '2026-02-20', qty: 5, invoiceId: invoiceB._id })
    const r4 = await book({ type: 'receipt', date: '2026-03-01', qty: 40, unitCost: 6 })
    const r5 = await book({ type: 'dispatch', date: '2026-03-15T15:30:00Z', qty: 12, contactId: contactA._id })

    const ledger = (opts: Parameters<typeof getProductLedger>[2] = {}) => getProductLedger(String(org._id), String(product._id), opts)
    return { r: [r1, r2, r3, r4, r5], contactA, contactB, ledger }
  }

  const refs = (res: Awaited<ReturnType<typeof getProductLedger>>) => res.entries.map(e => e.documentRef)
  const balances = (res: Awaited<ReturnType<typeof getProductLedger>>) => res.entries.map(e => [e.startQty, e.endQty])

  it('sorts every row before paging, each row keeping its own balance', async () => {
    const { r, ledger } = await seedLedger()

    const pages = await Promise.all([0, 1, 2].map(page => ledger({ sortBy: 'quantityChange', sortOrder: 'desc', page, size: 2 })))
    expect(pages.map(refs)).toEqual([[r[0], r[3]], [r[2], r[4]], [r[1]]])
    expect(pages.flatMap(balances)).toEqual([[0, 100], [65, 105], [70, 65], [105, 93], [100, 70]])
    expect(pages.every(p => p.total === 5 && p.totalPages === 3)).toBe(true)

    expect(refs(await ledger({ sortBy: 'quantityChange', sortOrder: 'asc', size: 0 }))).toEqual([r[1], r[4], r[2], r[3], r[0]])
    expect(refs(await ledger({ sortBy: 'endQty', sortOrder: 'asc', size: 0 }))).toEqual([r[2], r[1], r[4], r[0], r[3]])
  })

  it('sorts by date both ways, and falls back to booking order for no or an unknown column', async () => {
    const { r, ledger } = await seedLedger()
    expect(refs(await ledger({ sortBy: 'date', sortOrder: 'desc', size: 0 }))).toEqual([...r].reverse())
    expect(refs(await ledger({ sortBy: 'date', sortOrder: 'asc', size: 0 }))).toEqual(r)
    expect(refs(await ledger({ size: 0 }))).toEqual(r)
    expect(refs(await ledger({ sortBy: 'lines.0.quantity', sortOrder: 'desc', size: 0 }))).toEqual(r)
  })

  it('sorts text columns with the empty ones last, in either direction', async () => {
    const { r, ledger } = await seedLedger()
    // Corp A: r1, r5 · Corp B: r2, r3 (its invoice's customer) · none: r4
    expect(refs(await ledger({ sortBy: 'contactName', sortOrder: 'asc', size: 0 }))).toEqual([r[0], r[4], r[1], r[2], r[3]])
    expect(refs(await ledger({ sortBy: 'contactName', sortOrder: 'desc', size: 0 }))).toEqual([r[1], r[2], r[0], r[4], r[3]])
    // Document numbers compare as numbers inside the text: SM-…-00010 after SM-…-00009.
    expect(refs(await ledger({ sortBy: 'documentRef', sortOrder: 'desc', size: 0 }))).toEqual([...r].reverse())
  })

  it('sorts within the filters, and the summary does not depend on the order', async () => {
    const { r, ledger } = await seedLedger()
    const res = await ledger({ eventTypes: ['dispatched'], sortBy: 'endQty', sortOrder: 'asc', size: 0 })
    expect(refs(res)).toEqual([r[2], r[1], r[4]])
    expect(balances(res)).toEqual([[70, 65], [100, 70], [105, 93]])

    const unsorted = await ledger({ eventTypes: ['dispatched'], size: 0 })
    expect(res.summary).toEqual(unsorted.summary)
    expect(res.summary.totalOut).toBe(47)
  })

  it('a period hides the rows outside it, not the stock held before it', async () => {
    const { r, ledger } = await seedLedger()
    const feb = await ledger({ dateFrom: '2026-02-01', dateTo: '2026-02-28', size: 0 })
    expect(refs(feb)).toEqual([r[1], r[2]])
    expect(balances(feb)).toEqual([[100, 70], [70, 65]])
    expect(feb.summary.totalOut).toBe(35)
  })

  it('a period runs to the end of its last day', async () => {
    const { r, ledger } = await seedLedger()
    const day = await ledger({ dateFrom: '2026-03-15', dateTo: '2026-03-15', size: 0 })
    expect(refs(day)).toEqual([r[4]])
    expect(balances(day)).toEqual([[105, 93]])
  })

  it('a contact shows its rows — its invoices\' too — at the real balance', async () => {
    const { r, contactB, ledger } = await seedLedger()
    const res = await ledger({ contactId: String(contactB._id), sortBy: 'quantityChange', sortOrder: 'asc', size: 0 })
    expect(refs(res)).toEqual([r[1], r[2]])
    expect(balances(res)).toEqual([[100, 70], [70, 65]])
  })
})
