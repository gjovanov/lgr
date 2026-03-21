import type { RepositoryRegistry } from 'dal'
import type { IPurchaseOrder } from 'dal/entities'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'
import { getNextNumber } from './sequence.service.js'
import { eventBus } from '../events/event-bus.js'
import { StateMachine } from '../mixins/state-machine.js'

// ── Purchase Order State Machine ──

const purchaseOrderSM = new StateMachine({
  name: 'PurchaseOrder',
  states: ['draft', 'sent', 'to_approve', 'confirmed', 'received', 'billed', 'done', 'cancelled'] as const,
  initial: 'draft',
  transitions: {
    send: { from: 'draft', to: 'sent' },
    request_approval: { from: ['draft', 'sent'], to: 'to_approve', guard: (po) => po.lines?.length > 0 },
    approve: { from: 'to_approve', to: 'confirmed' },
    confirm: { from: ['draft', 'sent'], to: 'confirmed', guard: (po) => po.lines?.length > 0 },
    receive: { from: 'confirmed', to: 'received' },
    bill: { from: ['confirmed', 'received'], to: 'billed' },
    done: { from: 'billed', to: 'done' },
    cancel: { from: ['draft', 'sent', 'to_approve', 'confirmed'], to: 'cancelled' },
    reject: { from: 'to_approve', to: 'draft' },
  },
})

// ── Computed Fields ──

function computeReceiptStatus(lines: any[]): string {
  if (!lines || lines.length === 0) return 'pending'
  const allReceived = lines.every((l: any) => (l.qtyReceived || 0) >= l.quantity)
  if (allReceived) return 'full'
  const anyReceived = lines.some((l: any) => (l.qtyReceived || 0) > 0)
  if (anyReceived) return 'partial'
  return 'pending'
}

function computeInvoiceStatus(lines: any[]): string {
  if (!lines || lines.length === 0) return 'nothing'
  const allBilled = lines.every((l: any) => (l.qtyBilled || 0) >= l.quantity)
  if (allBilled) return 'billed'
  const anyBilled = lines.some((l: any) => (l.qtyBilled || 0) > 0)
  if (anyBilled) return 'to_bill'
  return 'nothing'
}

// ── Service Functions ──

/**
 * Send an RFQ to vendor (draft → sent).
 */
export async function sendRFQ(orderId: string, orgId: string, repos?: RepositoryRegistry): Promise<IPurchaseOrder> {
  const r = repos ?? getRepos()
  const order = await r.purchaseOrders.findOne({ id: orderId, orgId } as any)
  if (!order) throw new Error('Purchase order not found')

  const newState = await purchaseOrderSM.transition({ state: order.state as any, lines: order.lines }, 'send')

  // Atomic update with state precondition
  const updated = await r.purchaseOrders.findOneAndUpdate(
    { id: orderId, orgId, state: order.state } as any,
    { state: newState, sentAt: new Date() } as any,
  )
  if (!updated) throw new Error(`Concurrent modification: ${order.name} state changed`)

  logger.info({ orderId, name: order.name }, 'RFQ sent to vendor')
  return updated
}

/**
 * Request approval for a purchase order (draft/sent → to_approve).
 * Used when PO amount exceeds auto-approval threshold.
 */
export async function requestApproval(orderId: string, orgId: string, repos?: RepositoryRegistry): Promise<IPurchaseOrder> {
  const r = repos ?? getRepos()
  const order = await r.purchaseOrders.findOne({ id: orderId, orgId } as any)
  if (!order) throw new Error('Purchase order not found')

  const newState = await purchaseOrderSM.transition({ state: order.state as any, lines: order.lines }, 'request_approval')

  // Atomic update with state precondition
  const updated = await r.purchaseOrders.findOneAndUpdate(
    { id: orderId, orgId, state: order.state } as any,
    { state: newState, approvalStatus: 'pending' } as any,
  )
  if (!updated) throw new Error(`Concurrent modification: ${order.name} state changed`)

  // Emit approval event
  eventBus.emit('approval.requested', {
    entityType: 'purchase_order',
    entityId: orderId,
    orgId: order.orgId,
    requesterId: order.userId,
  })

  logger.info({ orderId, name: order.name }, 'Purchase order approval requested')
  return updated
}

/**
 * Approve a purchase order (to_approve → confirmed).
 */
export async function approvePurchaseOrder(orderId: string, orgId: string, approvedBy: string, repos?: RepositoryRegistry): Promise<IPurchaseOrder> {
  const r = repos ?? getRepos()
  const order = await r.purchaseOrders.findOne({ id: orderId, orgId } as any)
  if (!order) throw new Error('Purchase order not found')

  const newState = await purchaseOrderSM.transition({ state: order.state as any, lines: order.lines }, 'approve')

  // Atomic update with state precondition
  const updated = await r.purchaseOrders.findOneAndUpdate(
    { id: orderId, orgId, state: order.state } as any,
    {
      state: newState,
      approvalStatus: 'approved',
      approvedBy,
      dateApproved: new Date(),
      confirmedAt: new Date(),
    } as any,
  )
  if (!updated) throw new Error(`Concurrent modification: ${order.name} state changed`)

  // Emit confirmation event (same as direct confirm — triggers warehouse receipt)
  eventBus.emit('purchase.order.confirmed', {
    purchaseOrderId: orderId,
    orgId: order.orgId,
    lines: order.lines.map((l) => ({
      productId: l.productId || '',
      quantity: l.quantity,
      warehouseId: l.warehouseId,
      unitCost: l.priceUnit,
    })),
    vendorId: order.vendorId,
    userId: order.userId,
    expectedDate: order.datePlanned ? new Date(order.datePlanned) : undefined,
  })

  eventBus.emit('approval.decided', {
    entityType: 'purchase_order',
    entityId: orderId,
    orgId: order.orgId,
    decision: 'approved',
    decidedBy: approvedBy,
  })

  logger.info({ orderId, name: order.name, approvedBy }, 'Purchase order approved')
  return updated
}

/**
 * Reject a purchase order (to_approve → draft).
 */
export async function rejectPurchaseOrder(orderId: string, orgId: string, rejectedBy: string, repos?: RepositoryRegistry): Promise<IPurchaseOrder> {
  const r = repos ?? getRepos()
  const order = await r.purchaseOrders.findOne({ id: orderId, orgId } as any)
  if (!order) throw new Error('Purchase order not found')

  const newState = await purchaseOrderSM.transition({ state: order.state as any, lines: order.lines }, 'reject')

  // Atomic update with state precondition
  const updated = await r.purchaseOrders.findOneAndUpdate(
    { id: orderId, orgId, state: order.state } as any,
    { state: newState, approvalStatus: 'rejected' } as any,
  )
  if (!updated) throw new Error(`Concurrent modification: ${order.name} state changed`)

  eventBus.emit('approval.decided', {
    entityType: 'purchase_order',
    entityId: orderId,
    orgId: order.orgId,
    decision: 'rejected',
    decidedBy: rejectedBy,
  })

  logger.info({ orderId, name: order.name, rejectedBy }, 'Purchase order rejected')
  return updated
}

/**
 * Confirm a purchase order directly (draft/sent → confirmed).
 * Emits purchase.order.confirmed event for warehouse (receipt movement).
 */
export async function confirmPurchaseOrder(orderId: string, orgId: string, repos?: RepositoryRegistry): Promise<IPurchaseOrder> {
  const r = repos ?? getRepos()
  const order = await r.purchaseOrders.findOne({ id: orderId, orgId } as any)
  if (!order) throw new Error('Purchase order not found')

  const newState = await purchaseOrderSM.transition({ state: order.state as any, lines: order.lines }, 'confirm')

  // Atomic update with state precondition
  const updated = await r.purchaseOrders.findOneAndUpdate(
    { id: orderId, orgId, state: order.state } as any,
    { state: newState, dateOrder: new Date(), confirmedAt: new Date() } as any,
  )
  if (!updated) throw new Error(`Concurrent modification: ${order.name} state changed`)

  // Emit event for warehouse (stock receipt)
  eventBus.emit('purchase.order.confirmed', {
    purchaseOrderId: orderId,
    orgId: order.orgId,
    lines: order.lines.map((l) => ({
      productId: l.productId || '',
      quantity: l.quantity,
      warehouseId: l.warehouseId,
      unitCost: l.priceUnit,
    })),
    vendorId: order.vendorId,
    userId: order.userId,
    expectedDate: order.datePlanned ? new Date(order.datePlanned) : undefined,
  })

  logger.info({ orderId, name: order.name }, 'Purchase order confirmed')
  return updated
}

/**
 * Record receipt of goods (updates line qtyReceived).
 */
export async function recordReceipt(
  orderId: string,
  orgId: string,
  receivedLines: { productId: string; qtyReceived: number }[],
  repos?: RepositoryRegistry,
): Promise<IPurchaseOrder> {
  const r = repos ?? getRepos()
  const order = await r.purchaseOrders.findOne({ id: orderId, orgId } as any)
  if (!order) throw new Error('Purchase order not found')
  if (!['confirmed', 'received'].includes(order.state)) {
    throw new Error('Can only record receipt on confirmed orders')
  }

  // Update line quantities
  const updatedLines = order.lines.map((l) => {
    const received = receivedLines.find((rl) => rl.productId === l.productId)
    if (received) {
      const newQtyReceived = (l.qtyReceived || 0) + received.qtyReceived
      return { ...l, qtyReceived: Math.min(newQtyReceived, l.quantity) }
    }
    return l
  })

  const receiptStatus = computeReceiptStatus(updatedLines)
  const newState = receiptStatus === 'full' ? 'received' : order.state

  // Atomic update with state precondition
  const updated = await r.purchaseOrders.findOneAndUpdate(
    { id: orderId, orgId: order.orgId, state: order.state } as any,
    { lines: updatedLines, receiptStatus, state: newState } as any,
  )
  if (!updated) throw new Error(`Concurrent modification: ${order.name} state changed`)

  logger.info({ orderId, name: order.name, receiptStatus }, 'Receipt recorded on purchase order')
  return updated
}

/**
 * Create a vendor bill (incoming invoice) from a purchase order.
 */
export async function createBillFromPO(orderId: string, orgId: string, repos?: RepositoryRegistry): Promise<IPurchaseOrder> {
  const r = repos ?? getRepos()
  const order = await r.purchaseOrders.findOne({ id: orderId, orgId } as any)
  if (!order) throw new Error('Purchase order not found')
  if (!['confirmed', 'received'].includes(order.state)) {
    throw new Error('Can only create bills for confirmed/received orders')
  }

  // Find lines that need billing, tracking by index
  const toBillIndices = new Set<number>()
  const toBill = order.lines
    .map((l, idx) => ({ ...l, _idx: idx }))
    .filter((l) => {
      if ((l.qtyBilled || 0) < (l.qtyReceived || l.quantity)) {
        toBillIndices.add(l._idx)
        return true
      }
      return false
    })
  if (toBill.length === 0) throw new Error('Nothing to bill')

  // Get vendor for billing address
  const vendor = await r.contacts.findById(order.vendorId)
  const billingAddress = vendor?.addresses?.find((a: any) => a.type === 'billing' || a.isDefault) || vendor?.addresses?.[0]

  // Generate bill number
  const billNumber = await getNextNumber(order.orgId, 'BILL')

  // Map bill lines with proper amount computation
  const mappedLines = toBill.map((l) => {
    const billQty = (l.qtyReceived || l.quantity) - (l.qtyBilled || 0)
    const subtotal = billQty * l.priceUnit * (1 - (l.discount || 0) / 100)
    const taxAmt = subtotal * (l.taxRate || 0) / 100
    return {
      productId: l.productId,
      description: l.name,
      quantity: billQty,
      unit: l.uom,
      unitPrice: l.priceUnit,
      discount: l.discount || 0,
      taxRate: l.taxRate || 0,
      taxAmount: Math.round(taxAmt * 100) / 100,
      lineTotal: Math.round((subtotal + taxAmt) * 100) / 100,
      warehouseId: l.warehouseId,
    }
  })

  // Compute invoice-level totals
  const invoiceSubtotal = mappedLines.reduce((s, l) => s + (l.quantity * l.unitPrice * (1 - l.discount / 100)), 0)
  const invoiceTaxTotal = mappedLines.reduce((s, l) => s + l.taxAmount, 0)
  const invoiceTotal = invoiceSubtotal + invoiceTaxTotal

  // Create incoming invoice (vendor bill)
  const bill = await r.invoices.create({
    orgId: order.orgId,
    invoiceNumber: billNumber,
    type: 'invoice',
    direction: 'incoming',
    status: 'draft',
    contactId: order.vendorId,
    issueDate: new Date(),
    dueDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
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

  // Update PO: mark lines as billed using indices
  const updatedLines = order.lines.map((l, idx) => {
    if (toBillIndices.has(idx)) {
      return { ...l, qtyBilled: l.qtyReceived || l.quantity }
    }
    return l
  })

  const newInvoiceStatus = computeInvoiceStatus(updatedLines)
  const newState = newInvoiceStatus === 'billed' ? 'billed' : order.state

  try {
    const updated = await r.purchaseOrders.update(orderId, {
      lines: updatedLines,
      invoiceIds: [...(order.invoiceIds || []), bill.id],
      invoiceStatus: newInvoiceStatus,
      state: newState,
    } as any)
    if (!updated) throw new Error('Failed to update purchase order')

    logger.info({ orderId, billId: bill.id, name: order.name }, 'Vendor bill created from purchase order')
    return updated
  } catch (err) {
    // Compensating action: remove orphaned invoice
    try { await r.invoices.delete(bill.id) } catch {}
    throw err
  }
}

/**
 * Cancel a purchase order.
 */
export async function cancelPurchaseOrder(orderId: string, orgId: string, repos?: RepositoryRegistry): Promise<IPurchaseOrder> {
  const r = repos ?? getRepos()
  const order = await r.purchaseOrders.findOne({ id: orderId, orgId } as any)
  if (!order) throw new Error('Purchase order not found')

  const newState = await purchaseOrderSM.transition({ state: order.state as any, lines: order.lines }, 'cancel')

  // Atomic update with state precondition
  const updated = await r.purchaseOrders.findOneAndUpdate(
    { id: orderId, orgId, state: order.state } as any,
    { state: newState } as any,
  )
  if (!updated) throw new Error(`Concurrent modification: ${order.name} state changed`)

  logger.info({ orderId, name: order.name }, 'Purchase order cancelled')
  return updated
}

/**
 * Check reorder rules and auto-create POs.
 * Called by background job (every 15 min).
 */
export async function checkReorderRules(orgId: string, repos?: RepositoryRegistry): Promise<number> {
  const r = repos ?? getRepos()
  const rules = await r.reorderRules.findMany({ orgId, isActive: true } as any)
  if (rules.length === 0) return 0

  // Batch fetch stock levels
  const productIds = rules.map((rule) => rule.productId)
  const stockLevels = await r.stockLevels.findMany({
    orgId,
    productId: { $in: productIds },
  } as any)
  const stockMap = new Map<string, number>()
  for (const sl of stockLevels) {
    const key = `${sl.productId}-${sl.warehouseId}`
    stockMap.set(key, (stockMap.get(key) || 0) + (sl.quantity || 0))
  }

  // First pass: determine which rules will trigger
  const triggeredRules: typeof rules = []
  for (const rule of rules) {
    const key = `${rule.productId}-${rule.warehouseId}`
    const currentQty = stockMap.get(key) || 0
    if (currentQty <= rule.minQty) {
      let orderQty = rule.maxQty - currentQty
      if (rule.multipleQty && rule.multipleQty > 0) {
        orderQty = Math.ceil(orderQty / rule.multipleQty) * rule.multipleQty
      }
      if (orderQty > 0 && rule.vendorId) {
        triggeredRules.push(rule)
      }
    }
  }

  if (triggeredRules.length === 0) return 0

  // Batch-fetch products for all triggered rules
  const triggeredProductIds = [...new Set(triggeredRules.map((r) => r.productId))]
  const products = await r.products.findMany({
    orgId,
    id: { $in: triggeredProductIds },
  } as any)
  const productMap = new Map(products.map((p: any) => [p.id, p]))

  let created = 0
  for (const rule of triggeredRules) {
    const key = `${rule.productId}-${rule.warehouseId}`
    const currentQty = stockMap.get(key) || 0
    let orderQty = rule.maxQty - currentQty
    if (rule.multipleQty && rule.multipleQty > 0) {
      orderQty = Math.ceil(orderQty / rule.multipleQty) * rule.multipleQty
    }

    if (orderQty > 0 && rule.vendorId) {
        const product = productMap.get(rule.productId)
        if (!product) continue

        // Check for existing open PO for this product+vendor
        const existingPO = await r.purchaseOrders.findOne({
          orgId,
          vendorId: rule.vendorId,
          state: { $in: ['draft', 'sent', 'to_approve', 'confirmed'] },
          'lines.productId': rule.productId,
        } as any)
        if (existingPO) {
          logger.debug({ productId: rule.productId }, 'Open PO already exists — skipping reorder')
          continue
        }

        const poName = await getNextNumber(orgId, 'PO')
        await r.purchaseOrders.create({
          orgId,
          name: poName,
          state: 'draft',
          vendorId: rule.vendorId,
          datePlanned: new Date(Date.now() + rule.leadTimeDays * 24 * 60 * 60 * 1000),
          currency: 'EUR',
          exchangeRate: 1,
          lines: [{
            productId: rule.productId,
            name: product.name || product.sku || 'Product',
            quantity: orderQty,
            uom: product.unitOfMeasure || 'pcs',
            priceUnit: product.costPrice || 0,
            taxRate: 0,
            taxAmount: 0,
            priceSubtotal: orderQty * (product.costPrice || 0),
            priceTotal: orderQty * (product.costPrice || 0),
            qtyReceived: 0,
            qtyBilled: 0,
            warehouseId: rule.warehouseId,
          }],
          amountUntaxed: orderQty * (product.costPrice || 0),
          amountTax: 0,
          amountTotal: orderQty * (product.costPrice || 0),
          receiptStatus: 'pending',
          invoiceStatus: 'nothing',
          invoiceIds: [],
          movementIds: [],
          userId: '000000000000000000000000', // System-generated
          createdBy: '000000000000000000000000', // System-generated
        } as any)

        await r.reorderRules.update(rule.id, { lastTriggeredAt: new Date() } as any)
        created++
        logger.info({ productId: rule.productId, orderQty, poName }, 'Auto-created PO from reorder rule')
      }
  }

  return created
}
