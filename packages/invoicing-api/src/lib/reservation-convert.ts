import { getRepos } from 'services/context'
import { resolvePrice } from 'services/biz/pricing.service'
import { loadAllocationSupply } from 'services/biz/reservation.service'
import { Org } from 'db/models'
import { getNextDraftInvoiceNumber } from '../controllers/invoice.controller.js'

/**
 * Shared reservation→invoice conversion builder.
 *
 * Both convert endpoints (external order per-client, internal order) turn a set of open
 * reservations into ONE draft sales invoice: planConversion decides what can be invoiced
 * now, then one line per reservation, priced through the resolution chain (falling back to
 * the order's expected price when the product is gone), components-first rounding
 * (Bulgarian fiscal style), draft numbering with a retry loop on ORDI/ORDO-independent
 * counter collisions.
 */

const round2 = (n: number) => Math.round(n * 100) / 100
const num = (v: any) => Number(v) || 0
/** Quantities land on a document: keep subtraction residue (0.3 − 0.1) off it. */
const qty = (n: number) => Math.round(n * 1e6) / 1e6

export interface ConversionItem {
  productId: string
  description: string
  quantity: number
  unit: string
  taxRate?: number
  /** Used when resolvePrice fails (product deleted since the order was written). */
  fallbackPrice?: number
  warehouseId?: string
  orderRef: {
    orderId?: string
    groupId?: string
    lineId?: string
    allocationId?: string
    reservationId?: string
    internalOrderId?: string
    internalOrderLineId?: string
  }
}

export interface ConversionMeta {
  currency?: string
  exchangeRate?: number
  /** Shown in the invoice's reference field (the source order number). */
  reference?: string
  /** statusHistory reason, e.g. `converted_from_order ORDO-2026-00001`. */
  statusReason: string
  orderId?: string
  internalOrderId?: string
}

export class ConversionError extends Error {
  constructor(public statusCode: number, message: string, public details?: Record<string, unknown>) {
    super(message)
  }

  /** The response body: the message, plus what a UI needs to say it in the user's language. */
  body(): Record<string, unknown> {
    return { message: this.message, ...this.details }
  }
}

export interface ConversionPlan {
  /** The reservations to invoice now, each with the quantity it can take. */
  ready: Array<{ res: any; quantity: number }>
  /** What stays reserved because its supplier order has not delivered it yet. */
  waiting: Array<{ reservationId: string; reservationNumber: string; orderId: string; orderNumber?: string; quantity: number }>
}

/**
 * What of these open reservations can be invoiced now (FR-22.5).
 *
 * A stock reservation: everything it has not invoiced yet — the goods are on the shelf and held.
 * A reservation on a supplier order: only what its allocation has received and not dispatched
 * (the cap its stock hold has), less what live drafts already take of it. The rest stays
 * reserved for a later invoice. Reservations on one allocation share it in the order given
 * (the callers pass the oldest first).
 *
 * Issue enforces the same cap on its own (loadReservationBudgets), so a hand-edited draft
 * cannot dispatch goods that have not arrived either; this keeps Convert from writing a draft
 * Issue would refuse. Throws 400 (`noneOpen`) when nothing is open at all, and 422
 * `awaiting_receipt` when all of it waits on supplier orders: an empty draft helps nobody
 * (FR-22 §5.5).
 */
export async function planConversion(orgId: string, resDocs: any[], noneOpen: string): Promise<ConversionPlan> {
  const open = resDocs
    .map((res) => ({ res, quantity: qty(num(res.quantity) - num(res.invoicedQuantity)) }))
    .filter((p) => p.quantity > 0)
  if (!open.length) throw new ConversionError(400, noneOpen)

  const supply = await loadAllocationSupply(orgId, open.filter((p) => p.res.source === 'order').map((p) => p.res))
  const left = new Map<string, number>()
  const plan: ConversionPlan = { ready: [], waiting: [] }
  for (const { res, quantity } of open) {
    let now = quantity
    if (res.source === 'order') {
      const alloc = res.allocationId ? String(res.allocationId) : ''
      const s = supply.get(alloc)
      if (!left.has(alloc)) left.set(alloc, qty(Math.max(0, (s?.physical || 0) - (s?.claimed || 0))))
      now = Math.min(quantity, left.get(alloc)!)
      left.set(alloc, qty(left.get(alloc)! - now))
      if (now < quantity) {
        plan.waiting.push({
          reservationId: String(res._id),
          reservationNumber: res.reservationNumber,
          orderId: String(res.orderId),
          orderNumber: s?.orderNumber,
          quantity: qty(quantity - now),
        })
      }
    }
    if (now > 0) plan.ready.push({ res, quantity: now })
  }

  if (!plan.ready.length) {
    const orders = [...new Set(plan.waiting.map((w) => w.orderNumber).filter(Boolean))] as string[]
    const quantity = plan.waiting.reduce((s, w) => s + w.quantity, 0)
    throw new ConversionError(
      422,
      `Nothing to invoice yet: the reserved goods (${quantity}) have not arrived from ${orders.join(', ') || 'their supplier orders'}`,
      { code: 'awaiting_receipt', orders, quantity },
    )
  }
  return plan
}

export async function buildConversionInvoice(
  orgId: string,
  userId: string,
  contact: any,
  items: ConversionItem[],
  meta: ConversionMeta,
): Promise<any> {
  const r = getRepos()
  const org: any = await Org.findById(orgId).lean().exec()
  const defaultVat = org?.settings?.taxConfig?.defaultVatRate ?? 20
  const contactId = String(contact._id)

  let subtotal = 0
  let taxTotal = 0
  const lines: any[] = []
  for (const item of items) {
    let unitPrice = item.fallbackPrice || 0
    let priceExplanation: any[] | undefined
    try {
      const resolution = await resolvePrice(orgId, item.productId, contactId, item.quantity)
      unitPrice = resolution.finalPrice
      priceExplanation = resolution.steps
    } catch {
      /* product gone — keep the fallback price */
    }
    const taxRate = item.taxRate ?? defaultVat
    const net = item.quantity * unitPrice
    const taxAmount = net * (taxRate / 100)
    subtotal += net
    taxTotal += taxAmount
    lines.push({
      productId: item.productId,
      description: item.description,
      quantity: item.quantity,
      unit: item.unit || 'pcs',
      unitPrice,
      discount: 0,
      taxRate,
      taxAmount: round2(taxAmount),
      lineTotal: round2(net + taxAmount),
      warehouseId: item.warehouseId,
      priceExplanation,
      orderRef: item.orderRef,
    })
  }
  // Components-first rounding (Bulgarian fiscal style): total = round2(sub) + round2(tax).
  const total = round2(round2(subtotal) + round2(taxTotal))

  const billing = (contact.addresses || []).find((a: any) => a.isDefault) || (contact.addresses || [])[0]
  const dueDate = new Date()
  dueDate.setMonth(dueDate.getMonth() + 1)

  let invoice: any
  let lastErr: any
  for (let attempt = 0; attempt < 3; attempt++) {
    const invoiceNumber = await getNextDraftInvoiceNumber(orgId, 'outgoing', 'invoice')
    try {
      invoice = await r.invoices.create({
        orgId,
        type: 'invoice',
        direction: 'outgoing',
        status: 'draft',
        statusHistory: [{ status: 'draft', changedAt: new Date(), changedBy: userId, reason: meta.statusReason }],
        invoiceNumber,
        numberHistory: [{ number: invoiceNumber, allocatedAt: new Date(), status: 'draft' }],
        contactId,
        issueDate: new Date(),
        dueDate,
        currency: meta.currency || 'EUR',
        exchangeRate: meta.exchangeRate || 1,
        reference: meta.reference,
        lines,
        subtotal: round2(subtotal),
        discountTotal: 0,
        taxTotal: round2(taxTotal),
        total,
        totalBase: round2(total * (meta.exchangeRate || 1)),
        amountPaid: 0,
        amountDue: total,
        billingAddress: billing
          ? { street: billing.street || '-', city: billing.city || '-', state: billing.state, postalCode: billing.postalCode || '-', country: billing.country || '-' }
          : { street: '-', city: '-', postalCode: '-', country: '-' },
        orderId: meta.orderId,
        internalOrderId: meta.internalOrderId,
        createdBy: userId,
      } as any)
      break
    } catch (e: any) {
      lastErr = e
      if (e?.code !== 'DUPLICATE' && e?.code !== 11000) throw e
    }
  }
  if (!invoice) {
    throw new ConversionError(409, `Could not allocate invoice number: ${lastErr?.message || 'duplicate'}`)
  }
  return invoice
}
