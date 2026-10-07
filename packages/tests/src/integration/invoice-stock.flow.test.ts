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
import { captureRejection } from '../helpers/capture-rejection'
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

/**
 * A line that claims a quantity but names no product.
 *
 * It moves nothing while its money still counts, and it is silent — ten of them across the two
 * regal orgs invoiced 3,413 units that never left the warehouse (INV-3000101246 alone 3,000 ×
 * „ГАЙКА М6 - DIN 985 - A2-Gleitmo"; regal-sf 400 on 2026-10-06 and 4 more on 10-07). Every one
 * came from an import line that failed to match the catalog.
 *
 * It refuses only when the line carries `sourceText`, i.e. it came from a document the import
 * read and could not resolve. A product-less line typed by hand is a different thing — a
 * service-only invoice is legitimate and must still book nothing without failing, which the
 * existing test "should skip stock movement for lines without productId or warehouseId" pins.
 * The tests below cover both sides of that line.
 */
describe('a line with a quantity but no product', () => {
  const line = (over: Record<string, any>) => ({
    description: 'x', quantity: 1, unit: 'pcs', unitPrice: 10, discount: 0,
    taxRate: 20, taxAmount: 2, lineTotal: 12, ...over,
  })

  it('refuses to book, naming the lines, instead of issuing a document that moves nothing', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    await createTestStockLevel(org._id, product._id, warehouse._id, { quantity: 100, availableQuantity: 100, avgCost: 5 })

    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'outgoing',
      invoiceNumber: 'INV-FREETEXT-1',
      lines: [
        line({ productId: product._id, quantity: 10, warehouseId: warehouse._id }),
        line({ quantity: 200, description: 'Имбус М4х55 - DIN912 12.9 Bl', sourceText: 'Имбус М4х55 - DIN912 12.9 Bl' }),
      ],
    })

    const err = await captureRejection(createInvoiceStockMovement(invoice, String(user._id)))
    expect(err).toBeTruthy()
    expect(String(err.message)).toContain('no product')
    expect(String(err.message)).toContain('INV-FREETEXT-1')
    expect(String(err.message)).toContain('Имбус М4х55')

    // and nothing was booked — the refusal is before any movement is written
    expect(await StockMovement.countDocuments({ orgId: org._id, invoiceId: invoice._id })).toBe(0)
    const sl: any = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id }).lean()
    expect(sl.quantity).toBe(100)
  })

  it('still books a SERVICE line, which is a product that tracks no inventory', async () => {
    // The exemption that makes the refusal safe: a service keeps its productId, so it is never
    // product-less. If this breaks, the guard is blocking legitimate documents.
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const goods = await createTestProduct(org._id, { sku: 'G-1' } as any)
    const service = await createTestProduct(org._id, { sku: 'SVC-1', type: 'service', trackInventory: false } as any)
    const warehouse = await createTestWarehouse(org._id)
    await createTestStockLevel(org._id, goods._id, warehouse._id, { quantity: 100, availableQuantity: 100, avgCost: 5 })

    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'outgoing',
      invoiceNumber: 'INV-FREETEXT-2',
      lines: [
        line({ productId: goods._id, quantity: 10, warehouseId: warehouse._id }),
        line({ productId: service._id, quantity: 1, description: 'Комисионна' }),
      ],
    })

    await createInvoiceStockMovement(invoice, String(user._id))
    const mv: any[] = await StockMovement.find({ orgId: org._id, invoiceId: invoice._id }).lean()
    expect(mv.length).toBe(1)
    expect(mv[0].lines.length).toBe(1)          // the goods only
    const sl: any = await StockLevel.findOne({ orgId: org._id, productId: goods._id, warehouseId: warehouse._id }).lean()
    expect(sl.quantity).toBe(90)
  })

  it('ignores a quantity-0 line, which claims no goods', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    await createTestStockLevel(org._id, product._id, warehouse._id, { quantity: 100, availableQuantity: 100, avgCost: 5 })

    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'outgoing',
      invoiceNumber: 'INV-FREETEXT-3',
      lines: [
        line({ productId: product._id, quantity: 10, warehouseId: warehouse._id }),
        line({ quantity: 0, unitPrice: 0, lineTotal: 0, taxAmount: 0, description: '— доставка —', sourceText: '— доставка —' }),
      ],
    })

    await createInvoiceStockMovement(invoice, String(user._id))
    const sl: any = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id }).lean()
    expect(sl.quantity).toBe(90)
  })

  it('does NOT block the reverse path, so a document already carrying one can still be voided', async () => {
    // The ten existing documents must stay correctable. `reverseInvoiceStockMovement` has no
    // equivalent guard on purpose.
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    await createTestStockLevel(org._id, product._id, warehouse._id, { quantity: 100, availableQuantity: 100, avgCost: 5 })

    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'outgoing',
      invoiceNumber: 'INV-FREETEXT-4',
      lines: [
        line({ productId: product._id, quantity: 10, warehouseId: warehouse._id }),
        line({ quantity: 200, description: 'never matched', sourceText: 'never matched' }),
      ],
    })

    await reverseInvoiceStockMovement(invoice as any, String(user._id))
    const sl: any = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id }).lean()
    expect(sl.quantity).toBe(110)   // the 10 came back; the product-less line is simply not reversed
  })

  it('does NOT refuse a product-less line that was typed, not imported', async () => {
    // The boundary: no sourceText means nobody read this off a document, so it is a service or a
    // note and the long-standing skip behaviour stands. Narrowing the guard to sourceText is the
    // whole reason a service-only invoice still works.
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    await createTestStockLevel(org._id, product._id, warehouse._id, { quantity: 100, availableQuantity: 100, avgCost: 5 })

    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'outgoing',
      invoiceNumber: 'INV-FREETEXT-5',
      lines: [
        line({ productId: product._id, quantity: 10, warehouseId: warehouse._id }),
        line({ quantity: 10, unit: 'hrs', description: 'Consulting Service' }),   // no sourceText
      ],
    })

    await createInvoiceStockMovement(invoice, String(user._id))
    const sl: any = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id }).lean()
    expect(sl.quantity).toBe(90)
  })
})
