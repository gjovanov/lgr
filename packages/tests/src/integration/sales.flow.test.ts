import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestContact, createTestProduct } from '../helpers/factories'
import { getRepos } from 'services/context'
import { getNextNumber } from 'services/biz/sequence.service'
import {
  sendQuotation,
  confirmSalesOrder,
  createInvoiceFromSO,
  cancelSalesOrder,
  markSalesOrderDone,
} from 'services/biz/sales.service'
import { eventBus } from 'services/events/event-bus'
import type { Types } from 'mongoose'

let repos: ReturnType<typeof getRepos>

beforeAll(async () => {
  await setupTestDB()
  repos = getRepos()
})

afterAll(async () => {
  await teardownTestDB()
})

beforeEach(async () => {
  await clearCollections()
  eventBus.removeAllListeners() // Clean all event types
})

async function createTestSalesOrder(
  orgId: Types.ObjectId,
  partnerId: Types.ObjectId,
  product: { id: string; name: string },
  overrides: any = {},
) {
  const name = await getNextNumber(String(orgId), 'SO')
  return repos.salesOrders.create({
    orgId: String(orgId),
    name,
    state: 'draft',
    partnerId: String(partnerId),
    currency: 'EUR',
    exchangeRate: 1,
    lines: [
      {
        productId: product.id,
        name: product.name,
        quantity: 10,
        uom: 'pcs',
        priceUnit: 100,
        discount: 0,
        taxRate: 20,
        taxAmount: 200,
        priceSubtotal: 1000,
        priceTotal: 1200,
        qtyDelivered: 0,
        qtyInvoiced: 0,
      },
    ],
    amountUntaxed: 1000,
    amountTax: 200,
    amountTotal: 1200,
    invoiceStatus: 'nothing',
    deliveryStatus: 'pending',
    invoiceIds: [],
    movementIds: [],
    requireSignature: false,
    requirePayment: false,
    userId: String(orgId), // placeholder
    createdBy: String(orgId), // placeholder
    ...overrides,
  } as any)
}

describe('Sales Order Lifecycle', () => {
  it('should create a sales order with computed totals', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const order = await createTestSalesOrder(org._id, contact._id, {
      id: String(product._id),
      name: product.name,
    })

    expect(order.name).toMatch(/^SO-\d{4}-\d{5}$/)
    expect(order.state).toBe('draft')
    expect(order.amountTotal).toBe(1200)
    expect(order.lines).toHaveLength(1)
    expect(order.invoiceStatus).toBe('nothing')
    expect(order.deliveryStatus).toBe('pending')
  })

  it('should send a quotation (draft -> sent)', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const order = await createTestSalesOrder(org._id, contact._id, {
      id: String(product._id),
      name: product.name,
    })

    const sent = await sendQuotation(order.id, String(org._id), repos)
    expect(sent.state).toBe('sent')
    expect(sent.sentAt).toBeTruthy()
  })

  it('should confirm a sales order (draft -> confirmed)', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const order = await createTestSalesOrder(org._id, contact._id, {
      id: String(product._id),
      name: product.name,
    })

    const confirmed = await confirmSalesOrder(order.id, String(org._id), repos)
    expect(confirmed.state).toBe('confirmed')
    expect(confirmed.confirmedAt).toBeTruthy()
    expect(confirmed.dateOrder).toBeTruthy()
  })

  it('should confirm a sent quotation (sent -> confirmed)', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const order = await createTestSalesOrder(org._id, contact._id, {
      id: String(product._id),
      name: product.name,
    })

    await sendQuotation(order.id, String(org._id), repos)
    const confirmed = await confirmSalesOrder(order.id, String(org._id), repos)
    expect(confirmed.state).toBe('confirmed')
  })

  it('should emit sales.order.confirmed event on confirm', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const order = await createTestSalesOrder(org._id, contact._id, {
      id: String(product._id),
      name: product.name,
    })

    let emittedEvent: any = null
    eventBus.on('sales.order.confirmed', async (payload) => {
      emittedEvent = payload
    })

    await confirmSalesOrder(order.id, String(org._id), repos)

    expect(emittedEvent).not.toBeNull()
    expect(emittedEvent.salesOrderId).toBe(order.id)
    expect(emittedEvent.orgId).toBe(String(org._id))
    expect(emittedEvent.lines).toHaveLength(1)
    expect(emittedEvent.contactId).toBe(String(contact._id))
  })

  it('should reject confirm on order with no lines', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const name = await getNextNumber(String(org._id), 'SO')
    const order = await repos.salesOrders.create({
      orgId: String(org._id),
      name,
      state: 'draft',
      partnerId: String(contact._id),
      currency: 'EUR',
      exchangeRate: 1,
      lines: [],
      amountUntaxed: 0,
      amountTax: 0,
      amountTotal: 0,
      invoiceStatus: 'nothing',
      deliveryStatus: 'pending',
      invoiceIds: [],
      movementIds: [],
      requireSignature: false,
      requirePayment: false,
      userId: String(org._id),
      createdBy: String(org._id),
    } as any)

    await expect(confirmSalesOrder(order.id, String(org._id), repos)).rejects.toThrow(/Guard rejected/)
  })

  it('should create invoice from confirmed order', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const order = await createTestSalesOrder(org._id, contact._id, {
      id: String(product._id),
      name: product.name,
    })
    await confirmSalesOrder(order.id, String(org._id), repos)

    const invoiced = await createInvoiceFromSO(order.id, String(org._id), repos)
    expect(invoiced.invoiceIds).toHaveLength(1)
    expect(invoiced.invoiceStatus).toBe('invoiced')

    // Verify the invoice was created
    const invoice = await repos.invoices.findById(invoiced.invoiceIds[0])
    expect(invoice).toBeTruthy()
    expect(invoice!.direction).toBe('outgoing')
    expect(invoice!.type).toBe('invoice')
    expect(invoice!.contactId).toBe(String(contact._id))
    expect(invoice!.reference).toBe(order.name)
    expect(invoice!.lines).toHaveLength(1)
    expect(invoice!.lines[0].quantity).toBe(10)
  })

  it('should reject invoice on draft order', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const order = await createTestSalesOrder(org._id, contact._id, {
      id: String(product._id),
      name: product.name,
    })

    await expect(createInvoiceFromSO(order.id, String(org._id), repos)).rejects.toThrow(/Can only invoice confirmed/)
  })

  it('should cancel a draft order', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const order = await createTestSalesOrder(org._id, contact._id, {
      id: String(product._id),
      name: product.name,
    })

    const cancelled = await cancelSalesOrder(order.id, String(org._id), repos)
    expect(cancelled.state).toBe('cancelled')
  })

  it('should cancel a sent order', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const order = await createTestSalesOrder(org._id, contact._id, {
      id: String(product._id),
      name: product.name,
    })
    await sendQuotation(order.id, String(org._id), repos)

    const cancelled = await cancelSalesOrder(order.id, String(org._id), repos)
    expect(cancelled.state).toBe('cancelled')
  })

  it('should reject cancel on invoiced order', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const order = await createTestSalesOrder(org._id, contact._id, {
      id: String(product._id),
      name: product.name,
    })
    await confirmSalesOrder(order.id, String(org._id), repos)
    await createInvoiceFromSO(order.id, String(org._id), repos)

    await expect(cancelSalesOrder(order.id, String(org._id), repos)).rejects.toThrow(/Cannot/)
  })

  it('should complete the full lifecycle: draft -> sent -> confirmed -> invoiced', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const order = await createTestSalesOrder(org._id, contact._id, {
      id: String(product._id),
      name: product.name,
    })

    // Step 1: Send
    const sent = await sendQuotation(order.id, String(org._id), repos)
    expect(sent.state).toBe('sent')

    // Step 2: Confirm
    const confirmed = await confirmSalesOrder(order.id, String(org._id), repos)
    expect(confirmed.state).toBe('confirmed')

    // Step 3: Invoice
    const invoiced = await createInvoiceFromSO(order.id, String(org._id), repos)
    expect(invoiced.state).toBe('invoiced')
    expect(invoiced.invoiceIds).toHaveLength(1)
  })

  it('marks a fully invoiced order as done', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const order = await createTestSalesOrder(org._id, contact._id, {
      id: String(product._id),
      name: product.name,
    })
    await confirmSalesOrder(order.id, String(org._id), repos)
    await createInvoiceFromSO(order.id, String(org._id), repos)

    // Simulate full delivery by updating deliveryStatus directly
    await repos.salesOrders.update(order.id, { deliveryStatus: 'full' } as any)

    const done = await markSalesOrderDone(order.id, String(org._id), repos)
    expect(done.state).toBe('done')
  })

  it('rejects done on invoiced order without full delivery', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const order = await createTestSalesOrder(org._id, contact._id, {
      id: String(product._id),
      name: product.name,
    })
    await confirmSalesOrder(order.id, String(org._id), repos)
    await createInvoiceFromSO(order.id, String(org._id), repos)
    // deliveryStatus is still 'pending'

    expect(markSalesOrderDone(order.id, String(org._id), repos)).rejects.toThrow(/Guard rejected/)
  })

  it('cancels a confirmed order', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const order = await createTestSalesOrder(org._id, contact._id, {
      id: String(product._id),
      name: product.name,
    })
    await confirmSalesOrder(order.id, String(org._id), repos)

    const cancelled = await cancelSalesOrder(order.id, String(org._id), repos)
    expect(cancelled.state).toBe('cancelled')
  })

  it('creates invoice with correct financial totals', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const order = await createTestSalesOrder(org._id, contact._id, {
      id: String(product._id),
      name: product.name,
    })
    await confirmSalesOrder(order.id, String(org._id), repos)
    const invoiced = await createInvoiceFromSO(order.id, String(org._id), repos)

    const invoice = await repos.invoices.findById(invoiced.invoiceIds[0])
    expect(invoice).toBeTruthy()
    // 10 qty × 100 price = 1000 subtotal, 20% tax = 200, total = 1200
    expect(invoice!.subtotal).toBe(1000)
    expect(invoice!.taxTotal).toBe(200)
    expect(invoice!.total).toBe(1200)
    expect(invoice!.amountDue).toBe(1200)
  })

  it('throws for non-existent order', async () => {
    expect(confirmSalesOrder('000000000000000000000099', '000000000000000000000001', repos)).rejects.toThrow(/not found/)
  })
})

describe('Sales Order State Machine Guards', () => {
  it('should reject invalid transition: sent -> invoiced', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const order = await createTestSalesOrder(org._id, contact._id, {
      id: String(product._id),
      name: product.name,
    })
    await sendQuotation(order.id, String(org._id), repos)

    await expect(createInvoiceFromSO(order.id, String(org._id), repos)).rejects.toThrow()
  })

  it('should reject double confirm', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const order = await createTestSalesOrder(org._id, contact._id, {
      id: String(product._id),
      name: product.name,
    })
    await confirmSalesOrder(order.id, String(org._id), repos)

    await expect(confirmSalesOrder(order.id, String(org._id), repos)).rejects.toThrow(/Cannot/)
  })

  it('should reject cancel on cancelled order', async () => {
    const org = await createTestOrg()
    const contact = await createTestContact(org._id)
    const product = await createTestProduct(org._id)
    const order = await createTestSalesOrder(org._id, contact._id, {
      id: String(product._id),
      name: product.name,
    })
    await cancelSalesOrder(order.id, String(org._id), repos)

    await expect(cancelSalesOrder(order.id, String(org._id), repos)).rejects.toThrow(/Cannot/)
  })
})
