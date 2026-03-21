import type { RepositoryRegistry } from 'dal'
import type { ISalesOrder } from 'dal/entities'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'
import { getNextNumber } from './sequence.service.js'
import { eventBus } from '../events/event-bus.js'
import { StateMachine } from '../mixins/state-machine.js'

// ── Sales Order State Machine ──

const salesOrderSM = new StateMachine({
  name: 'SalesOrder',
  states: ['draft', 'sent', 'confirmed', 'invoiced', 'done', 'cancelled'] as const,
  initial: 'draft',
  transitions: {
    send: { from: 'draft', to: 'sent' },
    confirm: { from: ['draft', 'sent'], to: 'confirmed', guard: (so) => so.lines?.length > 0 },
    invoice: { from: 'confirmed', to: 'invoiced' },
    done: { from: 'invoiced', to: 'done', guard: (so) => so.deliveryStatus === 'full' },
    cancel: { from: ['draft', 'sent', 'confirmed'], to: 'cancelled' },
  },
})

// ── Computed Fields ──

function computeInvoiceStatus(lines: any[]): string {
  if (!lines || lines.length === 0) return 'nothing'
  const allInvoiced = lines.every((l: any) => l.qtyInvoiced >= l.quantity)
  if (allInvoiced) return 'invoiced'
  const anyInvoiced = lines.some((l: any) => l.qtyInvoiced > 0)
  if (anyInvoiced) return 'upselling'
  return 'to_invoice'
}

function computeDeliveryStatus(lines: any[]): string {
  if (!lines || lines.length === 0) return 'pending'
  const allDelivered = lines.every((l: any) => l.qtyDelivered >= l.quantity)
  if (allDelivered) return 'full'
  const anyDelivered = lines.some((l: any) => l.qtyDelivered > 0)
  if (anyDelivered) return 'partial'
  return 'pending'
}

// ── Service Functions ──

/**
 * Send a quotation (draft → sent).
 */
export async function sendQuotation(orderId: string, orgId: string, repos?: RepositoryRegistry): Promise<ISalesOrder> {
  const r = repos ?? getRepos()
  const order = await r.salesOrders.findOne({ id: orderId, orgId } as any)
  if (!order) throw new Error('Sales order not found')

  const newState = await salesOrderSM.transition({ state: order.state as any, lines: order.lines }, 'send')

  // Atomic update with state precondition
  const updated = await r.salesOrders.findOneAndUpdate(
    { id: orderId, orgId, state: order.state } as any,
    { state: newState, sentAt: new Date() } as any,
  )
  if (!updated) throw new Error(`Concurrent modification: ${order.name} state changed`)

  logger.info({ orderId, name: order.name }, 'Quotation sent')
  return updated
}

/**
 * Confirm a sales order (draft/sent → confirmed).
 * Emits sales.order.confirmed event for cross-module handling (stock dispatch).
 */
export async function confirmSalesOrder(orderId: string, orgId: string, repos?: RepositoryRegistry): Promise<ISalesOrder> {
  const r = repos ?? getRepos()
  const order = await r.salesOrders.findOne({ id: orderId, orgId } as any)
  if (!order) throw new Error('Sales order not found')

  const newState = await salesOrderSM.transition({ state: order.state as any, lines: order.lines }, 'confirm')

  // Atomic update with state precondition
  const updated = await r.salesOrders.findOneAndUpdate(
    { id: orderId, orgId, state: order.state } as any,
    { state: newState, dateOrder: new Date(), confirmedAt: new Date() } as any,
  )
  if (!updated) throw new Error(`Concurrent modification: ${order.name} state changed`)

  // Emit event for warehouse (stock dispatch) and other subscribers
  eventBus.emit('sales.order.confirmed', {
    salesOrderId: orderId,
    orgId: order.orgId,
    lines: order.lines.map((l) => ({
      productId: l.productId || '',
      quantity: l.quantity,
      warehouseId: l.warehouseId,
      unitPrice: l.priceUnit,
    })),
    contactId: order.partnerId,
    userId: order.userId,
  })

  logger.info({ orderId, name: order.name }, 'Sales order confirmed')
  return updated
}

/**
 * Create an invoice from a confirmed sales order.
 * Creates an outgoing invoice with lines mapped from SO lines.
 */
export async function createInvoiceFromSO(orderId: string, orgId: string, repos?: RepositoryRegistry): Promise<ISalesOrder> {
  const r = repos ?? getRepos()
  const order = await r.salesOrders.findOne({ id: orderId, orgId } as any)
  if (!order) throw new Error('Sales order not found')
  if (order.state !== 'confirmed' && order.state !== 'invoiced') {
    throw new Error('Can only invoice confirmed orders')
  }

  // Find lines that need invoicing, tracking by index
  const toInvoiceIndices = new Set<number>()
  const toInvoice = order.lines
    .map((l, idx) => ({ ...l, _idx: idx }))
    .filter((l) => {
      if ((l.qtyInvoiced || 0) < l.quantity) {
        toInvoiceIndices.add(l._idx)
        return true
      }
      return false
    })
  if (toInvoice.length === 0) throw new Error('Nothing to invoice')

  // Get contact for billing address
  const contact = await r.contacts.findById(order.partnerId)
  const billingAddress = contact?.addresses?.find((a: any) => a.type === 'billing' || a.isDefault) || contact?.addresses?.[0]

  // Generate invoice number
  const invoiceNumber = await getNextNumber(order.orgId, 'INV')

  // Map invoice lines with proper amount computation
  const mappedLines = toInvoice.map((l) => {
    const invoiceQty = l.quantity - (l.qtyInvoiced || 0)
    const subtotal = invoiceQty * l.priceUnit * (1 - (l.discount || 0) / 100)
    const taxAmt = subtotal * (l.taxRate || 0) / 100
    return {
      productId: l.productId,
      description: l.name,
      quantity: invoiceQty,
      unit: l.uom,
      unitPrice: l.priceUnit,
      discount: l.discount || 0,
      taxRate: l.taxRate || 0,
      taxAmount: Math.round(taxAmt * 100) / 100,
      lineTotal: Math.round((subtotal + taxAmt) * 100) / 100,
      warehouseId: l.warehouseId,
      priceExplanation: l.priceExplanation,
    }
  })

  // Compute invoice-level totals
  const invoiceSubtotal = mappedLines.reduce((s, l) => s + (l.quantity * l.unitPrice * (1 - l.discount / 100)), 0)
  const invoiceTaxTotal = mappedLines.reduce((s, l) => s + l.taxAmount, 0)
  const invoiceTotal = invoiceSubtotal + invoiceTaxTotal

  // Create invoice
  const invoice = await r.invoices.create({
    orgId: order.orgId,
    invoiceNumber,
    type: 'invoice',
    direction: 'outgoing',
    status: 'draft',
    contactId: order.partnerId,
    issueDate: new Date(),
    dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
    currency: order.currency,
    exchangeRate: order.exchangeRate,
    lines: mappedLines,
    billingAddress: billingAddress ? {
      street: billingAddress.street || '',
      city: billingAddress.city || '',
      state: billingAddress.state,
      postalCode: billingAddress.postalCode || '',
      country: billingAddress.country || '',
    } : { street: '', city: '', postalCode: '', country: '' },
    subtotal: Math.round(invoiceSubtotal * 100) / 100,
    discountTotal: 0,
    taxTotal: Math.round(invoiceTaxTotal * 100) / 100,
    total: Math.round(invoiceTotal * 100) / 100,
    totalBase: Math.round(invoiceSubtotal * 100) / 100,
    amountPaid: 0,
    amountDue: Math.round(invoiceTotal * 100) / 100,
    payments: [],
    attachments: [],
    createdBy: order.userId,
    reference: order.name,
  } as any)

  // Update SO: mark lines as invoiced using indices, add invoice reference
  const updatedLines = order.lines.map((l, idx) => {
    if (toInvoiceIndices.has(idx)) {
      return { ...l, qtyInvoiced: l.quantity }
    }
    return l
  })

  const newInvoiceStatus = computeInvoiceStatus(updatedLines)
  const newState = newInvoiceStatus === 'invoiced' ? 'invoiced' : order.state

  try {
    const updated = await r.salesOrders.update(orderId, {
      lines: updatedLines,
      invoiceIds: [...(order.invoiceIds || []), invoice.id],
      invoiceStatus: newInvoiceStatus,
      state: newState,
    } as any)
    if (!updated) throw new Error('Failed to update sales order')

    logger.info({ orderId, invoiceId: invoice.id, name: order.name }, 'Invoice created from sales order')
    return updated
  } catch (err) {
    // Compensating action: remove orphaned invoice
    try { await r.invoices.delete(invoice.id) } catch {}
    throw err
  }
}

/**
 * Cancel a sales order.
 */
export async function cancelSalesOrder(orderId: string, orgId: string, repos?: RepositoryRegistry): Promise<ISalesOrder> {
  const r = repos ?? getRepos()
  const order = await r.salesOrders.findOne({ id: orderId, orgId } as any)
  if (!order) throw new Error('Sales order not found')

  const newState = await salesOrderSM.transition({ state: order.state as any, lines: order.lines }, 'cancel')

  // Atomic update with state precondition
  const updated = await r.salesOrders.findOneAndUpdate(
    { id: orderId, orgId, state: order.state } as any,
    { state: newState } as any,
  )
  if (!updated) throw new Error(`Concurrent modification: ${order.name} state changed`)

  logger.info({ orderId, name: order.name }, 'Sales order cancelled')
  return updated
}

/**
 * Mark a fully invoiced and delivered order as done.
 */
export async function markSalesOrderDone(orderId: string, orgId: string, repos?: RepositoryRegistry): Promise<ISalesOrder> {
  const r = repos ?? getRepos()
  const order = await r.salesOrders.findOne({ id: orderId, orgId } as any)
  if (!order) throw new Error('Sales order not found')

  const newState = await salesOrderSM.transition({ state: order.state as any, lines: order.lines, deliveryStatus: order.deliveryStatus }, 'done')

  // Atomic update with state precondition
  const updated = await r.salesOrders.findOneAndUpdate(
    { id: orderId, orgId, state: order.state } as any,
    { state: newState } as any,
  )
  if (!updated) throw new Error(`Concurrent modification: ${order.name} state changed`)

  logger.info({ orderId, name: order.name }, 'Sales order marked as done')
  return updated
}
