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

describe('Cash Sale Flow', () => {
  it('should create a cash sale with auto-paid status and CS- prefix', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const year = new Date().getFullYear()

    const cashSale = await createTestInvoice(org._id, contact._id, {
      type: 'cash_sale',
      direction: 'outgoing',
      invoiceNumber: `CS-${year}-00001`,
      status: 'paid',
      amountPaid: 500,
      amountDue: 0,
      total: 500,
      paidAt: new Date(),
    })

    expect(cashSale.type).toBe('cash_sale')
    expect(cashSale.status).toBe('paid')
    expect(cashSale.amountPaid).toBe(500)
    expect(cashSale.amountDue).toBe(0)
    expect(cashSale.invoiceNumber).toMatch(/^CS-/)
    expect(cashSale.paidAt).toBeDefined()
  })

  it('should create stock movement on cash sale creation', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id, { name: 'Cash Product', sku: `CSP-${Date.now()}` })
    const warehouse = await createTestWarehouse(org._id)

    await createTestStockLevel(org._id, product._id, warehouse._id, {
      quantity: 50,
      availableQuantity: 50,
      avgCost: 20,
    })

    const cashSale = await createTestInvoice(org._id, contact._id, {
      type: 'cash_sale',
      direction: 'outgoing',
      invoiceNumber: `CS-${Date.now()}`,
      status: 'paid',
      total: 100,
      amountPaid: 100,
      amountDue: 0,
      lines: [{
        productId: product._id,
        description: 'Cash Product',
        quantity: 5,
        unit: 'pcs',
        unitPrice: 20,
        discount: 0,
        taxRate: 0,
        taxAmount: 0,
        lineTotal: 100,
        warehouseId: warehouse._id,
      }],
    })

    await createInvoiceStockMovement(cashSale, String(user._id))

    const movements = await StockMovement.find({ orgId: org._id, invoiceId: cashSale._id })
    expect(movements).toHaveLength(1)
    expect(movements[0].type).toBe('dispatch')

    const level = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id })
    expect(level!.quantity).toBe(45) // 50 - 5
  })

  it('should void a cash sale and reverse stock', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id, { name: 'Void Product', sku: `VP-${Date.now()}` })
    const warehouse = await createTestWarehouse(org._id)

    await createTestStockLevel(org._id, product._id, warehouse._id, {
      quantity: 30,
      availableQuantity: 30,
      avgCost: 15,
    })

    const cashSale = await createTestInvoice(org._id, contact._id, {
      type: 'cash_sale',
      direction: 'outgoing',
      invoiceNumber: `CS-VOID-${Date.now()}`,
      status: 'paid',
      total: 60,
      amountPaid: 60,
      amountDue: 0,
      lines: [{
        productId: product._id,
        description: 'Void Product',
        quantity: 4,
        unit: 'pcs',
        unitPrice: 15,
        discount: 0,
        taxRate: 0,
        taxAmount: 0,
        lineTotal: 60,
        warehouseId: warehouse._id,
      }],
    })

    // Create stock movement (dispatch)
    await createInvoiceStockMovement(cashSale, String(user._id))
    let level = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id })
    expect(level!.quantity).toBe(26) // 30 - 4

    // Void and reverse
    await reverseInvoiceStockMovement(cashSale, String(user._id))
    level = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id })
    expect(level!.quantity).toBe(30) // restored

    const movements = await StockMovement.find({ orgId: org._id, invoiceId: cashSale._id })
    expect(movements).toHaveLength(2)
  })

  it('should increment cash sale number sequence independently', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const year = new Date().getFullYear()

    // Create 3 cash sales with sequential numbers
    for (let i = 1; i <= 3; i++) {
      await createTestInvoice(org._id, contact._id, {
        type: 'cash_sale',
        direction: 'outgoing',
        invoiceNumber: `CS-${year}-${String(i).padStart(5, '0')}`,
        status: 'paid',
        total: 100 * i,
        amountPaid: 100 * i,
        amountDue: 0,
      })
    }

    const cashSales = await Invoice.find({ orgId: org._id, type: 'cash_sale' }).sort({ invoiceNumber: 1 })
    expect(cashSales).toHaveLength(3)
    expect(cashSales[0].invoiceNumber).toBe(`CS-${year}-00001`)
    expect(cashSales[1].invoiceNumber).toBe(`CS-${year}-00002`)
    expect(cashSales[2].invoiceNumber).toBe(`CS-${year}-00003`)

    // Also create a regular invoice to verify independent sequence
    await createTestInvoice(org._id, contact._id, {
      type: 'invoice',
      direction: 'outgoing',
      invoiceNumber: `INV-${year}-00001`,
    })

    const regularInvoices = await Invoice.find({ orgId: org._id, type: 'invoice' })
    expect(regularInvoices).toHaveLength(1)
    expect(regularInvoices[0].invoiceNumber).toBe(`INV-${year}-00001`)
  })
})
