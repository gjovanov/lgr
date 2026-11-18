import { orderLineQuery } from '../order-tree/links'
import type { ReservationRow } from '../order-tree/types'
import type { OrderPriority } from '../../api/internal-orders'

/**
 * The customer order (ORDI) as its form holds it, and as its PUT/POST carries it and its GET returns it: plain
 * functions, moved out of `InternalOrderFormView` (FR-32.23).
 */

/** A line as the user edits it. What the server derives for it lives in `lineFigures`, not here. */
export interface LineRow {
  _id?: string
  productId?: string
  description: string
  sku?: string
  quantity: number
  unit: string
  expectedUnitPrice?: number
  /** The price was chosen for this order (a pick or a typed figure): its invoice charges it. `true` or absent. */
  pricePinned?: boolean
  taxRate?: number
}

/** A saved line's figures, derived by the server from its reservations and invoices. */
export interface LineFigures {
  reserved: number
  /** Of `reserved`, what waits on a supplier order not sent yet (FR-22.44). */
  onUnsentOrder: number
  invoiced: number
  delivered: number
}
export const NO_FIGURES: LineFigures = { reserved: 0, onUnsentOrder: 0, invoiced: 0, delivered: 0 }

export interface CustomerOrderForm {
  contactId: string
  issueDate: string
  requestedDeliveryDate: string
  priority: string
  warehouseId: string | undefined
  currency: string
  exchangeRate: number
  notes: string
  terms: string
  tags: string[]
  lines: LineRow[]
}

export function emptyLine(): LineRow { return { description: '', quantity: 0, unit: 'pcs' } }

/** Each saved line's figures, by line id, as GET /internal-orders/:id answers them. */
export function figuresByLine(lines: any[] | undefined): Record<string, LineFigures> {
  return Object.fromEntries((lines || []).map((l: any) => [String(l._id), {
    reserved: Number(l.reservedQuantity) || 0,
    onUnsentOrder: Number(l.onUnsentOrderQuantity) || 0,
    invoiced: Number(l.invoicedQuantity) || 0,
    delivered: Number(l.deliveredQuantity) || 0,
  }]))
}

/** The lines as the order's GET returns them, as the form holds them. */
export function customerLinesFrom(lines: any[] | undefined): LineRow[] {
  return (lines || []).map((l: any) => ({
    _id: l._id,
    productId: l.productId ? String(l.productId) : undefined,
    description: l.description || '',
    sku: l.sku,
    quantity: l.quantity || 0,
    unit: l.unit || 'pcs',
    expectedUnitPrice: l.expectedUnitPrice,
    // `true` or absent, never `false`: the unsaved-changes check compares the lines as JSON.
    pricePinned: l.pricePinned === true ? true : undefined,
    taxRate: l.taxRate,
  }))
}

/** The order's body: a line with no article is left out. */
export function customerOrderBody(form: CustomerOrderForm) {
  return {
    contactId: form.contactId,
    issueDate: form.issueDate,
    requestedDeliveryDate: form.requestedDeliveryDate,
    // The form's select offers the four the schema names.
    priority: form.priority as OrderPriority,
    warehouseId: form.warehouseId || undefined,
    currency: form.currency,
    exchangeRate: form.exchangeRate || 1,
    notes: form.notes || undefined,
    terms: form.terms || undefined,
    tags: form.tags,
    lines: form.lines
      .filter((l) => l.productId)
      .map((l) => ({
        ...(l._id ? { _id: l._id } : {}),
        productId: l.productId!,
        description: l.description,
        sku: l.sku || undefined,
        quantity: Number(l.quantity) || 0,
        unit: l.unit || 'pcs',
        expectedUnitPrice: l.expectedUnitPrice !== undefined && l.expectedUnitPrice !== null ? Number(l.expectedUnitPrice) : undefined,
        // Always said, either way: a save that does not say keeps the stored pin (the rule for callers older than it).
        pricePinned: l.pricePinned === true,
        taxRate: l.taxRate,
      })),
  }
}

/** FR-22.44: covered on stock (`full`), or partly only by a supplier order not sent yet (`ordered`). */
export function coverageColor(c: string): string { return ({ none: 'error', partial: 'warning', ordered: 'info', full: 'success' } as Record<string, string>)[c] || 'grey' }

/** FR-28.46: the supplier order opens on the line (and the warehouse) a reservation is on, not at the top of the document. */
export function orderLink(res: any) {
  return res.orderId ? { name: 'invoicing.orders.edit', params: { id: String(res.orderId) }, query: orderLineQuery(res) } : undefined
}
export function rowOrderLink(row: ReservationRow) {
  return row.source === 'order' && row.orderId
    ? { name: 'invoicing.orders.edit', params: { id: row.orderId }, query: orderLineQuery({ lineId: row.orderLineId, allocationId: row.allocationId }) }
    : undefined
}
