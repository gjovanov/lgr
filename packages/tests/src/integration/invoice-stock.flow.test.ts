import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg,
  createTestUser,
  createTestContact,
  createTestInvoice,
  createTestProduct,
  createTestWarehouse,
  createTestStockLevel,
} from '../helpers/factories'
import { Invoice, StockMovement, StockLevel } from 'db/models'
import { createInvoiceStockMovement, reverseInvoiceStockMovement } from 'services/biz/invoicing.service'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('Invoice Stock Movement Flow', () => {
  it('should create a dispatch movement when outgoing invoice is sent', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    await createTestStockLevel(org._id, product._id, warehouse._id, {
      quantity: 100,
      availableQuantity: 100,
      avgCost: 50,
    })

    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'outgoing',
      invoiceNumber: 'INV-STOCK-001',
      lines: [{
        productId: product._id,
        description: 'Test Product',
        quantity: 10,
        unit: 'pcs',
        unitPrice: 50,
        discount: 0,
        taxRate: 18,
        taxAmount: 90,
        lineTotal: 590,
        warehouseId: warehouse._id,
      }],
    })

    await createInvoiceStockMovement(invoice, String(user._id))

    const movements = await StockMovement.find({ orgId: org._id, invoiceId: invoice._id })
    expect(movements).toHaveLength(1)
    expect(movements[0].type).toBe('dispatch')
    expect(String(movements[0].fromWarehouseId)).toBe(String(warehouse._id))

    const level = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id })
    expect(level!.quantity).toBe(90) // 100 - 10
  })

  it('should create a receipt movement when incoming purchase invoice is received', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id, { name: 'Rozi Test', sku: `ROZI-${Date.now()}` })
    const warehouse = await createTestWarehouse(org._id)

    // No initial stock level — receiving should create it
    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'incoming',
      invoiceNumber: `BILL-RECV-${Date.now()}`,
      lines: [{
        productId: product._id,
        description: 'Rozi Test',
        quantity: 50,
        unit: 'pcs',
        unitPrice: 10,
        discount: 0,
        taxRate: 18,
        taxAmount: 90,
        lineTotal: 590,
        warehouseId: warehouse._id,
      }],
    })

    // Simulate receiving the purchase invoice
    await createInvoiceStockMovement(invoice, String(user._id))

    // Verify stock movement created as receipt
    const movements = await StockMovement.find({ orgId: org._id, invoiceId: invoice._id })
    expect(movements).toHaveLength(1)
    expect(movements[0].type).toBe('receipt')
    expect(String(movements[0].toWarehouseId)).toBe(String(warehouse._id))
    expect(movements[0].status).toBe('completed')

    // Verify stock level was created/updated
    const level = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id })
    expect(level).toBeDefined()
    expect(level!.quantity).toBe(50)

    // Verify the movement appears in product-related queries
    const productMovements = await StockMovement.find({ 'lines.productId': product._id })
    expect(productMovements).toHaveLength(1)
  })

  it('should create a receipt movement when incoming invoice is sent', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'incoming',
      invoiceNumber: 'BILL-STOCK-001',
      lines: [{
        productId: product._id,
        description: 'Purchased Product',
        quantity: 20,
        unit: 'pcs',
        unitPrice: 30,
        discount: 0,
        taxRate: 18,
        taxAmount: 108,
        lineTotal: 708,
        warehouseId: warehouse._id,
      }],
    })

    await createInvoiceStockMovement(invoice, String(user._id))

    const movements = await StockMovement.find({ orgId: org._id, invoiceId: invoice._id })
    expect(movements).toHaveLength(1)
    expect(movements[0].type).toBe('receipt')
    expect(String(movements[0].toWarehouseId)).toBe(String(warehouse._id))

    const level = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id })
    expect(level!.quantity).toBe(20)
  })

  it('should create reverse movement when invoice is voided', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    await createTestStockLevel(org._id, product._id, warehouse._id, {
      quantity: 100,
      availableQuantity: 100,
      avgCost: 50,
    })

    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'outgoing',
      invoiceNumber: 'INV-STOCK-002',
      lines: [{
        productId: product._id,
        description: 'Test Product',
        quantity: 10,
        unit: 'pcs',
        unitPrice: 50,
        discount: 0,
        taxRate: 18,
        taxAmount: 90,
        lineTotal: 590,
        warehouseId: warehouse._id,
      }],
    })

    // Send invoice (dispatch)
    await createInvoiceStockMovement(invoice, String(user._id))
    let level = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id })
    expect(level!.quantity).toBe(90)

    // Void invoice (reverse: receipt)
    await reverseInvoiceStockMovement(invoice, String(user._id))
    level = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id })
    expect(level!.quantity).toBe(100)

    const movements = await StockMovement.find({ orgId: org._id, invoiceId: invoice._id })
    expect(movements).toHaveLength(2)
    const types = movements.map(m => m.type).sort()
    expect(types).toEqual(['dispatch', 'receipt'])
  })

  it('should skip stock movement for lines without productId or warehouseId', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)

    const invoice = await createTestInvoice(org._id, contact._id, {
      invoiceNumber: 'INV-STOCK-003',
      lines: [{
        description: 'Consulting Service',
        quantity: 10,
        unit: 'hrs',
        unitPrice: 100,
        discount: 0,
        taxRate: 18,
        taxAmount: 180,
        lineTotal: 1180,
        // No productId or warehouseId
      }],
    })

    await createInvoiceStockMovement(invoice, String(user._id))

    const movements = await StockMovement.find({ orgId: org._id, invoiceId: invoice._id })
    expect(movements).toHaveLength(0)
  })

  it('should group lines by warehouseId into separate movements', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product1 = await createTestProduct(org._id, { name: 'Product A', sku: `SKU-A-${Date.now()}` })
    const product2 = await createTestProduct(org._id, { name: 'Product B', sku: `SKU-B-${Date.now()}` })
    const warehouseA = await createTestWarehouse(org._id, { name: 'WH-A', code: `WH-A-${Date.now()}` })
    const warehouseB = await createTestWarehouse(org._id, { name: 'WH-B', code: `WH-B-${Date.now()}` })

    await createTestStockLevel(org._id, product1._id, warehouseA._id, { quantity: 50, availableQuantity: 50, avgCost: 10 })
    await createTestStockLevel(org._id, product2._id, warehouseA._id, { quantity: 50, availableQuantity: 50, avgCost: 10 })
    await createTestStockLevel(org._id, product1._id, warehouseB._id, { quantity: 50, availableQuantity: 50, avgCost: 10 })

    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'outgoing',
      invoiceNumber: 'INV-STOCK-004',
      lines: [
        { productId: product1._id, description: 'P1 from A', quantity: 5, unit: 'pcs', unitPrice: 10, discount: 0, taxRate: 0, taxAmount: 0, lineTotal: 50, warehouseId: warehouseA._id },
        { productId: product2._id, description: 'P2 from A', quantity: 3, unit: 'pcs', unitPrice: 10, discount: 0, taxRate: 0, taxAmount: 0, lineTotal: 30, warehouseId: warehouseA._id },
        { productId: product1._id, description: 'P1 from B', quantity: 2, unit: 'pcs', unitPrice: 10, discount: 0, taxRate: 0, taxAmount: 0, lineTotal: 20, warehouseId: warehouseB._id },
      ],
    })

    await createInvoiceStockMovement(invoice, String(user._id))

    const movements = await StockMovement.find({ orgId: org._id, invoiceId: invoice._id })
    expect(movements).toHaveLength(2) // One per warehouse
  })

  it('should create return movement for credit note with product lines', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)

    const creditNote = await createTestInvoice(org._id, contact._id, {
      type: 'credit_note',
      direction: 'outgoing',
      invoiceNumber: 'CN-STOCK-001',
      lines: [{
        productId: product._id,
        description: 'Returned Product',
        quantity: 5,
        unit: 'pcs',
        unitPrice: 50,
        discount: 0,
        taxRate: 18,
        taxAmount: 45,
        lineTotal: 295,
        warehouseId: warehouse._id,
      }],
    })

    await createInvoiceStockMovement(creditNote, String(user._id))

    const movements = await StockMovement.find({ orgId: org._id, invoiceId: creditNote._id })
    expect(movements).toHaveLength(1)
    expect(movements[0].type).toBe('return')
  })
})
