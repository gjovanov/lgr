import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg,
  createTestUser,
  createTestProduct,
  createTestWarehouse,
  createTestStockLevel,
  createTestContact,
  createTestInvoice,
} from '../helpers/factories'
import { CostLayer, StockLevel, StockMovement } from 'db/models'
import {
  createInvoiceStockMovement,
  reverseInvoiceStockMovement,
  validateStockAvailability,
} from 'services/biz/invoicing.service'

beforeAll(async () => {
  await setupTestDB()
})
afterAll(async () => {
  await teardownTestDB()
})
afterEach(async () => {
  await clearCollections()
})

// Bun/Windows: expect(p).rejects deadlocks when the rejection follows MongoDB driver
// I/O (see Known Issues) — capture via try/catch instead.
async function captureRejection<T>(p: Promise<T>): Promise<Error | null> {
  try {
    await p
    return null
  } catch (e: any) {
    return e
  }
}

describe('Stock Availability Validation', () => {
  it('should reject dispatch when stock is insufficient', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    await createTestStockLevel(org._id, product._id, warehouse._id, {
      quantity: 5,
      availableQuantity: 5,
      avgCost: 10,
    })

    const err = await captureRejection(
      validateStockAvailability(String(org._id), [
        { productId: String(product._id), warehouseId: String(warehouse._id), quantity: 10 },
      ]),
    )
    expect(String(err?.message)).toMatch(/Insufficient stock/)
  })

  it('should allow dispatch when stock is sufficient', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    await createTestStockLevel(org._id, product._id, warehouse._id, {
      quantity: 100,
      availableQuantity: 100,
      avgCost: 10,
    })

    // Plain await (not .resolves) — the async matchers deadlock after driver I/O on Bun/Windows.
    await validateStockAvailability(String(org._id), [
      { productId: String(product._id), warehouseId: String(warehouse._id), quantity: 50 },
    ])
  })

  it('should reject when no stock level exists for product+warehouse', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    // No stock level created

    const err = await captureRejection(
      validateStockAvailability(String(org._id), [
        { productId: String(product._id), warehouseId: String(warehouse._id), quantity: 1 },
      ]),
    )
    expect(String(err?.message)).toMatch(/Insufficient stock/)
  })

  it('should skip lines without productId or warehouseId', async () => {
    const org = await createTestOrg()

    // Lines missing productId/warehouseId should be skipped silently
    await validateStockAvailability(String(org._id), [
      { quantity: 10 },
      { productId: 'some-id', quantity: 5 },
      { warehouseId: 'some-id', quantity: 5 },
    ])
  })

  it('should report all insufficient products in error message', async () => {
    const org = await createTestOrg()
    const productA = await createTestProduct(org._id, { name: 'Product A' })
    const productB = await createTestProduct(org._id, { name: 'Product B' })
    const warehouse = await createTestWarehouse(org._id, { name: 'Main WH' })
    await createTestStockLevel(org._id, productA._id, warehouse._id, { quantity: 2, availableQuantity: 2, avgCost: 10 })
    await createTestStockLevel(org._id, productB._id, warehouse._id, { quantity: 3, availableQuantity: 3, avgCost: 20 })

    try {
      await validateStockAvailability(String(org._id), [
        { productId: String(productA._id), warehouseId: String(warehouse._id), quantity: 10 },
        { productId: String(productB._id), warehouseId: String(warehouse._id), quantity: 20 },
      ])
      expect(true).toBe(false) // Should not reach here
    } catch (e: any) {
      expect(e.message).toContain('Product A')
      expect(e.message).toContain('Product B')
      expect(e.message).toContain('Main WH')
      expect(e.message).toContain('available 2')
      expect(e.message).toContain('requested 10')
      expect(e.message).toContain('available 3')
      expect(e.message).toContain('requested 20')
    }
  })

  it('should allow exact stock match (quantity equals available)', async () => {
    const org = await createTestOrg()
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    await createTestStockLevel(org._id, product._id, warehouse._id, {
      quantity: 10,
      availableQuantity: 10,
      avgCost: 5,
    })

    await validateStockAvailability(String(org._id), [
      { productId: String(product._id), warehouseId: String(warehouse._id), quantity: 10 },
    ])
  })
})

describe('Invoice Stock Movement — Dispatch Validation', () => {
  it('should reject outgoing invoice send when stock is insufficient', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id, { name: 'Bolt M20' })
    const warehouse = await createTestWarehouse(org._id, { name: 'Pazardzhik' })
    await createTestStockLevel(org._id, product._id, warehouse._id, {
      quantity: 5,
      availableQuantity: 5,
      avgCost: 10,
    })

    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'outgoing',
      type: 'invoice',
      status: 'draft',
      lines: [
        {
          productId: String(product._id),
          warehouseId: String(warehouse._id),
          description: 'Bolt M20',
          quantity: 20,
          unit: 'pcs',
          unitPrice: 15,
          discount: 0,
          taxRate: 18,
          taxAmount: 54,
          lineTotal: 354,
        },
      ],
    })

    const err = await captureRejection(createInvoiceStockMovement(invoice, String(user._id)))
    expect(String(err?.message)).toMatch(/Insufficient stock/)

    // Verify no stock movement was created
    const movements = await StockMovement.find({ orgId: org._id })
    expect(movements.length).toBe(0)

    // Verify stock level unchanged
    const level = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id })
    expect(level!.quantity).toBe(5)
  })

  it('should allow outgoing invoice when stock is sufficient and create dispatch', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    await createTestStockLevel(org._id, product._id, warehouse._id, {
      quantity: 100,
      availableQuantity: 100,
      avgCost: 10,
    })

    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'outgoing',
      type: 'invoice',
      lines: [
        {
          productId: String(product._id),
          warehouseId: String(warehouse._id),
          description: 'Test Product',
          quantity: 30,
          unit: 'pcs',
          unitPrice: 15,
          discount: 0,
          taxRate: 18,
          taxAmount: 81,
          lineTotal: 531,
        },
      ],
    })

    await createInvoiceStockMovement(invoice, String(user._id))

    // Verify stock decreased
    const level = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id })
    expect(level!.quantity).toBe(70)

    // Verify dispatch movement created
    const movements = await StockMovement.find({ orgId: org._id })
    expect(movements.length).toBe(1)
    expect(movements[0].type).toBe('dispatch')
    expect(movements[0].status).toBe('completed')
  })

  it('should allow incoming invoice (receipt) without stock validation', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    // No stock level exists — receipt should still work

    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'incoming',
      type: 'invoice',
      lines: [
        {
          productId: String(product._id),
          warehouseId: String(warehouse._id),
          description: 'Purchased goods',
          quantity: 50,
          unit: 'pcs',
          unitPrice: 8,
          discount: 0,
          taxRate: 18,
          taxAmount: 72,
          lineTotal: 472,
        },
      ],
    })

    await createInvoiceStockMovement(invoice, String(user._id))

    // Verify stock level created with the received quantity
    const level = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id })
    expect(level!.quantity).toBe(50)
  })

  it('should reject cash sale (outgoing) when stock is insufficient', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id, { name: 'Limited Item' })
    const warehouse = await createTestWarehouse(org._id, { name: 'Shop' })
    await createTestStockLevel(org._id, product._id, warehouse._id, {
      quantity: 3,
      availableQuantity: 3,
      avgCost: 25,
    })

    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'outgoing',
      type: 'cash_sale',
      status: 'paid',
      lines: [
        {
          productId: String(product._id),
          warehouseId: String(warehouse._id),
          description: 'Limited Item',
          quantity: 5,
          unit: 'pcs',
          unitPrice: 50,
          discount: 0,
          taxRate: 18,
          taxAmount: 45,
          lineTotal: 295,
        },
      ],
    })

    const err = await captureRejection(createInvoiceStockMovement(invoice, String(user._id)))
    expect(String(err?.message)).toMatch(/Insufficient stock/)

    // Stock unchanged
    const level = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id })
    expect(level!.quantity).toBe(3)
  })

  it('should allow credit note (return) without stock validation', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    // No stock — return should add stock

    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'outgoing',
      type: 'credit_note',
      lines: [
        {
          productId: String(product._id),
          warehouseId: String(warehouse._id),
          description: 'Returned item',
          quantity: 10,
          unit: 'pcs',
          unitPrice: 20,
          discount: 0,
          taxRate: 18,
          taxAmount: 36,
          lineTotal: 236,
        },
      ],
    })

    await createInvoiceStockMovement(invoice, String(user._id))

    // Stock should be created with returned quantity
    const level = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id })
    expect(level!.quantity).toBe(10)

    const movements = await StockMovement.find({ orgId: org._id })
    expect(movements[0].type).toBe('return')
  })
})

describe('Reverse Stock Movement — Void Validation', () => {
  it('should reject voiding incoming invoice when stock has already been dispatched', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id, { name: 'Received Product' })
    const warehouse = await createTestWarehouse(org._id, { name: 'Central WH' })

    // Receive 50 units
    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'incoming',
      type: 'invoice',
      lines: [
        {
          productId: String(product._id),
          warehouseId: String(warehouse._id),
          description: 'Received Product',
          quantity: 50,
          unit: 'pcs',
          unitPrice: 10,
          discount: 0,
          taxRate: 18,
          taxAmount: 90,
          lineTotal: 590,
        },
      ],
    })

    await createInvoiceStockMovement(invoice, String(user._id))

    // Simulate that 40 units have been dispatched elsewhere
    const level = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id })
    await StockLevel.updateOne({ _id: level!._id }, { quantity: 10, availableQuantity: 10 })

    // Voiding the receipt would dispatch 50 units, but only 10 available
    const err = await captureRejection(reverseInvoiceStockMovement(invoice, String(user._id)))
    expect(String(err?.message)).toMatch(/Insufficient stock/)
  })

  it('should allow voiding outgoing invoice (receipt reversal, no stock check needed)', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    await createTestStockLevel(org._id, product._id, warehouse._id, {
      quantity: 100,
      availableQuantity: 100,
      avgCost: 10,
    })

    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'outgoing',
      type: 'invoice',
      lines: [
        {
          productId: String(product._id),
          warehouseId: String(warehouse._id),
          description: 'Sold item',
          quantity: 20,
          unit: 'pcs',
          unitPrice: 15,
          discount: 0,
          taxRate: 18,
          taxAmount: 54,
          lineTotal: 354,
        },
      ],
    })

    // Send: dispatch 20 → stock = 80
    await createInvoiceStockMovement(invoice, String(user._id))
    let level = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id })
    expect(level!.quantity).toBe(80)

    // Void: receipt reversal 20 → stock = 100
    await reverseInvoiceStockMovement(invoice, String(user._id))
    level = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id })
    expect(level!.quantity).toBe(100)
  })

  // #276: a void put the goods back at the SALE price. Under WAC that moved avgCost towards the
  // selling price; under FIFO the restored layers AND a new one at the sale price held them twice.
  for (const costingMethod of ['wac', 'fifo'] as const) {
    it(`voiding a sale restocks at the cost the goods left at, not at the sale price (${costingMethod}, #276)`, async () => {
      const org = await createTestOrg()
      const user = await createTestUser(org._id)
      const contact = await createTestContact(org._id)
      const product = await createTestProduct(org._id, { costingMethod } as any)
      const warehouse = await createTestWarehouse(org._id)
      const line = (quantity: number, unitPrice: number) => ({
        productId: String(product._id), warehouseId: String(warehouse._id), description: 'Bolt',
        quantity, unit: 'pcs', unitPrice, discount: 0, taxRate: 0, taxAmount: 0, lineTotal: quantity * unitPrice,
      })
      // Receive 10 @ 10 (a bill books a receipt, and the receipt opens the FIFO layer).
      const bill = await createTestInvoice(org._id, contact._id, { direction: 'incoming', type: 'invoice', status: 'received', lines: [line(10, 10)] })
      await createInvoiceStockMovement(bill, String(user._id))
      // Sell 1 @ 15, then void it.
      const sale = await createTestInvoice(org._id, contact._id, { direction: 'outgoing', type: 'invoice', status: 'sent', lines: [line(1, 15)] })
      await createInvoiceStockMovement(sale, String(user._id))
      await reverseInvoiceStockMovement(sale, String(user._id))

      const level: any = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id }).lean()
      expect(level.quantity).toBe(10)
      expect(level.avgCost).toBeCloseTo(10, 6)
      const receipt: any = await StockMovement.findOne({ orgId: org._id, invoiceId: sale._id, type: 'receipt' }).lean()
      expect(receipt.lines[0].unitCost).toBeCloseTo(10, 6)
      if (costingMethod === 'fifo') {
        const layers: any[] = await CostLayer.find({ orgId: org._id, productId: product._id, warehouseId: warehouse._id }).lean()
        expect(layers.reduce((s, l) => s + l.remainingQuantity, 0)).toBe(10)
        expect(layers.every(l => l.unitCost === 10)).toBe(true)
      }
    })
  }

  it('voiding a draft that booked nothing puts nothing back (found 2026-10-26: +1,257 phantom units)', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const warehouse = await createTestWarehouse(org._id)
    await createTestStockLevel(org._id, product._id, warehouse._id, { quantity: 10, availableQuantity: 10, avgCost: 10 })

    // A draft moves no stock: it dispatches when it is issued.
    const draft = await createTestInvoice(org._id, contact._id, {
      direction: 'outgoing',
      type: 'invoice',
      status: 'draft',
      lines: [{
        productId: String(product._id), warehouseId: String(warehouse._id), description: 'Never left',
        quantity: 4, unit: 'pcs', unitPrice: 15, discount: 0, taxRate: 20, taxAmount: 12, lineTotal: 72,
      }],
    })

    await reverseInvoiceStockMovement(draft, String(user._id))

    const level = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id })
    expect(level!.quantity).toBe(10)
    expect(await StockMovement.countDocuments({ orgId: org._id, invoiceId: draft._id })).toBe(0)
  })

  it('should validate stock when voiding credit note (return → dispatch reversal)', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id, { name: 'Returned Item' })
    const warehouse = await createTestWarehouse(org._id, { name: 'Returns WH' })

    // Credit note return: adds 10 units
    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'outgoing',
      type: 'credit_note',
      lines: [
        {
          productId: String(product._id),
          warehouseId: String(warehouse._id),
          description: 'Returned Item',
          quantity: 10,
          unit: 'pcs',
          unitPrice: 20,
          discount: 0,
          taxRate: 18,
          taxAmount: 36,
          lineTotal: 236,
        },
      ],
    })

    await createInvoiceStockMovement(invoice, String(user._id))

    // Simulate: 8 of the 10 returned units were already sold
    const level = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouse._id })
    await StockLevel.updateOne({ _id: level!._id }, { quantity: 2, availableQuantity: 2 })

    // Voiding the credit note would dispatch 10 units (reversing the return), but only 2 available
    const err = await captureRejection(reverseInvoiceStockMovement(invoice, String(user._id)))
    expect(String(err?.message)).toMatch(/Insufficient stock/)
  })
})

describe('Multi-Warehouse Stock Validation', () => {
  it('should validate per-warehouse independently', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id, { name: 'Multi-WH Product' })
    const warehouseA = await createTestWarehouse(org._id, { name: 'Warehouse A', code: 'WH-A' })
    const warehouseB = await createTestWarehouse(org._id, { name: 'Warehouse B', code: 'WH-B' })
    await createTestStockLevel(org._id, product._id, warehouseA._id, { quantity: 100, availableQuantity: 100, avgCost: 10 })
    await createTestStockLevel(org._id, product._id, warehouseB._id, { quantity: 5, availableQuantity: 5, avgCost: 10 })

    // WH-A has enough (50 requested), WH-B does NOT (20 requested but only 5 available)
    const invoice = await createTestInvoice(org._id, contact._id, {
      direction: 'outgoing',
      type: 'invoice',
      lines: [
        {
          productId: String(product._id),
          warehouseId: String(warehouseA._id),
          description: 'Multi-WH Product',
          quantity: 50,
          unit: 'pcs',
          unitPrice: 15,
          discount: 0,
          taxRate: 18,
          taxAmount: 135,
          lineTotal: 885,
        },
        {
          productId: String(product._id),
          warehouseId: String(warehouseB._id),
          description: 'Multi-WH Product',
          quantity: 20,
          unit: 'pcs',
          unitPrice: 15,
          discount: 0,
          taxRate: 18,
          taxAmount: 54,
          lineTotal: 354,
        },
      ],
    })

    try {
      await createInvoiceStockMovement(invoice, String(user._id))
      expect(true).toBe(false) // should not reach
    } catch (e: any) {
      // Error should reference WH-B (by name or ID) with correct quantities
      expect(e.message).toContain('available 5')
      expect(e.message).toContain('requested 20')
      // WH-A (100 available, 50 requested) should NOT appear in the error
      expect(e.message).not.toContain('available 100')
    }

    // Verify no movements were created (validation is pre-check)
    const movements = await StockMovement.find({ orgId: org._id })
    expect(movements.length).toBe(0)

    // Both stock levels should be unchanged
    const levelA = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouseA._id })
    const levelB = await StockLevel.findOne({ orgId: org._id, productId: product._id, warehouseId: warehouseB._id })
    expect(levelA!.quantity).toBe(100)
    expect(levelB!.quantity).toBe(5)
  })
})
