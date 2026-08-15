import { getRepos } from 'services/context'
import { resolvePrice } from 'services/biz/pricing.service'
import { Org } from 'db/models'
import { getNextDraftInvoiceNumber } from '../controllers/invoice.controller.js'

/**
 * Shared reservation→invoice conversion builder.
 *
 * Both convert endpoints (external order per-client, internal order) turn a set of open
 * reservations into ONE draft sales invoice: one line per reservation, priced through
 * the resolution chain (falling back to the order's expected price when the product is
 * gone), components-first rounding (Bulgarian fiscal style), draft numbering with a
 * retry loop on ORDI/ORDO-independent counter collisions.
 */

const round2 = (n: number) => Math.round(n * 100) / 100

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
  constructor(public statusCode: number, message: string) {
    super(message)
  }
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
