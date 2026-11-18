import { Invoice, Org, Reservation } from 'db/models'
import { getRepos } from '../../context.js'
import { seesOrders } from '../access/partition.js'
import { createAuditEntry } from '../audit-log.service.js'
import type { DispatchOverlap } from '../dispatch-invoice.service.js'
import type { IssueStockError } from '../issue-document.service.js'
import type { ReceiptOverlap } from '../receipt-bill.service.js'
import { MovementClaimedError, StockBookingRefusedError } from '../warehouse.service.js'

/**
 * FR-32.21 (#797): what a document is checked against before it is written, and the answers the issue routes share.
 * Moved whole from `invoice.controller.ts`, which re-exports the two validators its importers name.
 */

export const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

export function statusEntry(toStatus: string, fromStatus?: string, userId?: string, reason?: string) {
  return {
    status: toStatus,
    fromStatus,
    changedAt: new Date(),
    changedBy: userId,
    reason,
  }
}

/**
 * Why a bill in `currency` may not update its products, or null when it may. A product's prices
 * are kept in the org's currency and nothing here converts, so a USD price would land on it as if
 * it were EUR. Refused, not dropped: the form offers no update on such a bill, so a client that
 * sends one should hear about it.
 */
export async function foreignCurrencyRefusal(orgId: string, currency: string | undefined) {
  if (!currency) return null
  const org: any = await Org.findById(orgId, { 'settings.baseCurrency': 1 }).lean().exec()
  const base = org?.settings?.baseCurrency
  if (!base || currency === base) return null
  return { code: 'foreign_currency_bill', message: `A bill in ${currency} updates no product: product prices are kept in ${base}` }
}

/**
 * Guard for reservation-consuming lines: only outgoing SALES invoices may reference a
 * reservation (bills book receipts via allocations; converted proformas would
 * double-count), and the total live invoiced quantity per reservation must stay within
 * the reserved quantity. Returns an error message, or null when the payload is fine.
 */
export async function validateReservationLineRefs(
  orgId: string,
  payload: { type?: string; direction?: string; lines?: any[] },
  excludeInvoiceId?: string,
): Promise<string | null> {
  const withRes = (payload.lines || []).filter((l: any) => l.orderRef?.reservationId || l.orderRef?.internalOrderId || l.orderRef?.internalOrderLineId)
  if (!withRes.length) return null
  const direction = payload.type === 'cash_sale' ? 'outgoing' : payload.direction
  if (direction === 'incoming') {
    return 'Purchase documents cannot reference reservations — bills book receipts via order allocations'
  }
  if (payload.type && payload.type !== 'invoice') {
    return 'Only sales invoices can consume reservations'
  }

  const byRes = new Map<string, number>()
  for (const l of withRes) {
    if (!l.orderRef?.reservationId) continue
    const rid = String(l.orderRef.reservationId)
    byRes.set(rid, (byRes.get(rid) || 0) + (Number(l.quantity) || 0))
  }
  if (!byRes.size) return null

  const resDocs = await Reservation.find(
    { orgId, _id: { $in: [...byRes.keys()] } },
    { reservationNumber: 1, quantity: 1, status: 1 },
  ).lean().exec()
  const found = new Map(resDocs.map((r: any) => [String(r._id), r]))

  const others: any[] = await Invoice.find(
    {
      orgId,
      direction: 'outgoing',
      type: 'invoice',
      status: { $nin: ['voided', 'cancelled'] },
      ...(excludeInvoiceId ? { _id: { $ne: excludeInvoiceId } } : {}),
      'lines.orderRef.reservationId': { $in: [...byRes.keys()] },
    },
    { lines: 1 },
  ).lean().exec()
  const otherByRes = new Map<string, number>()
  for (const inv of others) {
    for (const line of inv.lines || []) {
      const rid = line.orderRef?.reservationId ? String(line.orderRef.reservationId) : ''
      if (!rid || !byRes.has(rid)) continue
      otherByRes.set(rid, (otherByRes.get(rid) || 0) + (Number(line.quantity) || 0))
    }
  }

  for (const [rid, qty] of byRes) {
    const res: any = found.get(rid)
    if (!res) return `Reservation ${rid} not found`
    if (res.status === 'cancelled') return `Reservation ${res.reservationNumber} is cancelled`
    const already = otherByRes.get(rid) || 0
    if (qty + already > (res.quantity || 0) + 1e-9) {
      return `Reservation ${res.reservationNumber}: invoiced quantity ${qty + already} exceeds reserved ${res.quantity} (remaining: ${Math.max(0, (res.quantity || 0) - already)})`
    }
  }
  return null
}

/**
 * Credit/debit notes must reference the issued invoice they correct (FR-01). Validates the
 * effective (post-update) type/direction/contact/relatedInvoiceId combination and returns an
 * error message, or null when the document is fine. Non-note types never fail this check.
 */
export async function validateRelatedInvoiceRef(
  orgId: string,
  doc: { type?: string; direction?: string; contactId?: string | null; relatedInvoiceId?: string | null },
): Promise<string | null> {
  if (doc.type !== 'credit_note' && doc.type !== 'debit_note') return null
  const kind = doc.type === 'credit_note' ? 'credit' : 'debit'
  if (!doc.relatedInvoiceId) return `Related invoice is required for ${kind} notes`

  const r = getRepos()
  const related: any = await r.invoices.findOne({ id: doc.relatedInvoiceId, orgId })
  if (!related) return 'Related invoice not found'
  if (related.type !== 'invoice') {
    return `Related document ${related.invoiceNumber} is not an invoice — ${kind} notes must reference an invoice`
  }
  if (doc.direction && related.direction !== doc.direction) {
    return `Related invoice ${related.invoiceNumber} is a ${related.direction === 'incoming' ? 'purchase' : 'sales'} document — pick one from the same side`
  }
  if (['draft', 'voided', 'cancelled'].includes(related.status)) {
    return `Related invoice ${related.invoiceNumber} is ${related.status} — only issued invoices can be corrected`
  }
  if (doc.contactId && related.contactId && String(related.contactId) !== String(doc.contactId)) {
    return `Related invoice ${related.invoiceNumber} belongs to a different contact`
  }
  return null
}

/**
 * How an issue whose booking failed is answered (FR-29.8, FR-29.32): a cost-layer refusal as the 422
 * with its code and names (FR-29.6), a movement being confirmed from the list as its 409, anything
 * else as `/send` always answered a booking that failed. `/receive` passes `null` for that last one:
 * it never caught one, and the error goes on to the handler as before.
 */
export function stockFailureAnswer(e: IssueStockError, otherwise: number | null): [number, Record<string, unknown>] | null {
  const failure = e.failure
  if (failure instanceof StockBookingRefusedError) return [422, failure.toBody()]
  if (failure instanceof MovementClaimedError) return [409, { code: failure.code, message: failure.message }]
  return otherwise === null ? null : [otherwise, { message: failure?.message ?? String(failure) }]
}

/**
 * FR-22.31c: the receipts an unlinked bill may be for. The answer to it is `{ acknowledgeOverlap:
 * true }`, or linking the bill to one of them; the UI offers both (`ReceiptOverlapDialog.vue`).
 */
export function receiptOverlapRefusal(bill: any, overlap: ReceiptOverlap) {
  const numbers = overlap.receipts.map(r => r.number).join(', ')
  return {
    code: 'receipt_overlap',
    message: `${bill.invoiceNumber} may be for goods already in stock (${numbers}): link it to the delivery, or receive it anyway`,
    ...overlap,
  }
}

/** Someone was shown these receipts and booked the goods again anyway: that stays on the record. */
export function auditOverlapAcknowledged(orgId: string, userId: string, id: string, number: string, overlap: ReceiptOverlap) {
  createAuditEntry({
    orgId, userId, action: 'receive_overlap_acknowledged', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: number,
    changes: [{ field: 'receipts', oldValue: null, newValue: overlap.receipts.map(r => r.number).join(', ') }],
  })
}

/**
 * FR-22.61b: the stock notes an unlinked sales invoice may be for. The answer to it is `{ acknowledgeOverlap:
 * true }`, or linking the invoice to one of them; the UI offers both (`DispatchOverlapDialog.vue`).
 */
export function dispatchOverlapRefusal(invoice: any, overlap: DispatchOverlap) {
  const numbers = overlap.notes.map(n => n.number).join(', ')
  return {
    code: 'dispatch_overlap',
    message: `${invoice.invoiceNumber} may be for goods that already left stock (${numbers}): link it to the stock note, or issue it anyway`,
    ...overlap,
  }
}

/** Someone was shown these stock notes and dispatched the goods again anyway: that stays on the record. */
export function auditDispatchOverlapAcknowledged(orgId: string, userId: string, id: string, number: string, overlap: DispatchOverlap) {
  createAuditEntry({
    orgId, userId, action: 'issue_overlap_acknowledged', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: number,
    changes: [{ field: 'stockNotes', oldValue: null, newValue: overlap.notes.map(n => n.number).join(', ') }],
  })
}

/** FR-26.6: a document's order links, head and lines, as comparable keys. */
const ORDER_HEAD_FIELDS = ['orderId', 'orderGroupId', 'internalOrderId'] as const
function lineOrderKey(ref: Record<string, unknown> | null | undefined): string {
  if (!ref) return ''
  const parts = Object.entries(ref).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => `${k}=${String(v)}`).sort()
  return parts.join('&')
}

const ORDERS_REFUSED = { code: 'area_required', area: 'orders', message: 'Orders and reservations are not part of your role: this document may not be linked to one.' } as const

/**
 * FR-26.6 `orders` (FR-27.6: `seesOrders`, the area on the legacy model, the orders capabilities on a role): may a
 * session without them write these order links? A create may carry none. An edit may keep the ones the document has
 * (the form round-trips `orderRef` verbatim, so an invoice converted from an order saves unchanged) and may add or
 * change none.
 */
export function orderLinkRefusal(user: any, body: any, existing?: any): typeof ORDERS_REFUSED | null {
  if (seesOrders(user)) return null
  for (const f of ORDER_HEAD_FIELDS) {
    if (body?.[f] === undefined) continue
    if (String(body[f] || '') !== String(existing?.[f] || '')) return ORDERS_REFUSED
  }
  if (Array.isArray(body?.lines)) {
    const kept = new Set(((existing?.lines ?? []) as any[]).map(l => lineOrderKey(l.orderRef)).filter(Boolean))
    for (const l of body.lines) {
      const k = lineOrderKey(l?.orderRef)
      if (k && !kept.has(k)) return ORDERS_REFUSED
    }
  }
  return null
}

/**
 * FR-23 §2.7: a credit note moved to correct another invoice. Its stornos cite the receipts of the one it
 * corrects now, so once one stands this moves with its money: the device's storno would cite a receipt of
 * an invoice the note no longer names.
 */
export const correctsAnother = (doc: any, edit: any) =>
  doc.type === 'credit_note' && edit.relatedInvoiceId !== undefined && String(edit.relatedInvoiceId ?? '') !== String(doc.relatedInvoiceId ?? '')
