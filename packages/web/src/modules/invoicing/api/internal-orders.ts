import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath, type Done } from './org-path'
import type { Conversion, OrderInvoiceRef, OrderRoutes, SupplierOrder } from './orders'
import type { Reservation } from './reservations'

/**
 * `api/src/invoicing/controllers/internal-order.controller.ts`, `/org/:orgId/invoicing/internal-orders`: the client's
 * order (ORDI). A refused reservation change carries its `code` (`composables/reservation-errors.ts` says it).
 */
const BASE = '/invoicing/internal-orders'

export type OrderPriority = 'low' | 'normal' | 'high' | 'urgent'

/** A line as the one read answers it: with what is reserved, invoiced and delivered of it. */
export interface InternalOrderLine {
  _id: string
  productId: string
  description: string
  sku?: string
  quantity: number
  unit: string
  expectedUnitPrice?: number
  /** The price was chosen for this order: its invoice charges it. */
  pricePinned?: boolean
  taxRate?: number
  notes?: string
  reservedQuantity: number
  invoicedQuantity: number
  deliveredQuantity: number
  /** Of what is reserved, what waits on a supplier order not sent yet (FR-22.44). Derived on read. */
  onUnsentOrderQuantity?: number
}

/** A client order as the routes answer it (the stored order). */
export interface InternalOrder {
  _id: string
  orderNumber: string
  status: string
  contactId: string
  issueDate: string
  requestedDeliveryDate: string
  priority: OrderPriority
  warehouseId?: string
  currency: string
  exchangeRate: number
  lines: InternalOrderLine[]
  notes?: string
  terms?: string
  tags?: string[]
}

/** The one read: the order with its coverage, its reservations, and the names its form shows. */
export interface InternalOrderRead {
  internalOrder: InternalOrder & { reservationCoverage: string; shortQuantity: number }
  reservations: Reservation[]
  lookup: {
    contacts: Record<string, string>
    warehouses: Record<string, string>
    products: Record<string, { name: string; sku?: string; unit?: string }>
    /** The supplier orders its reservations wait on. */
    orders: Record<string, { orderNumber: string; status: string; expectedDate?: string }>
    invoices: Record<string, OrderInvoiceRef>
  }
}

/** A missing order is a 404. */
export async function getInternalOrder(id: string): Promise<InternalOrderRead> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${id}`))
  return data
}

/** The body of `POST /` and `PUT /:id`, as their schema (`orderBody`) declares it. */
export interface InternalOrderBody {
  contactId: string
  issueDate: string
  requestedDeliveryDate: string
  priority?: OrderPriority
  warehouseId?: string
  currency?: string
  exchangeRate?: number
  notes?: string
  terms?: string
  tags?: string[]
  lines: Array<{
    _id?: string
    productId: string
    description: string
    sku?: string
    quantity: number
    unit?: string
    expectedUnitPrice?: number
    /** Always said: a save that does not say keeps the stored pin. */
    pricePinned?: boolean
    taxRate?: number
    notes?: string
  }>
}

/** Creates the order. FR-29.13: `headers` carries the attempt's `Idempotency-Key` (`replayed` on a repeat). */
export async function createInternalOrder(body: InternalOrderBody, headers: Record<string, string>): Promise<{ internalOrder: InternalOrder; replayed?: true }> {
  const { data } = await httpClient.post(orgPath(BASE), body, { headers })
  return data
}

export async function updateInternalOrder(id: string, body: InternalOrderBody): Promise<{ internalOrder: InternalOrder }> {
  const { data } = await httpClient.put(orgPath(`${BASE}/${id}`), body)
  return data
}

export async function peekNextInternalOrderNumber(): Promise<{ next: string; counter: number; prefix: string }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/peek-next`))
  return data
}

/** A draft only. */
export async function deleteInternalOrder(id: string): Promise<Done> {
  const { data } = await httpClient.delete(orgPath(`${BASE}/${id}`))
  return data
}

/** An order-wide action, sent no body: `confirm` (a draft), `complete`, `cancel` (its reservations go). */
export async function runInternalOrderAction(id: string, action: 'confirm' | 'complete' | 'cancel'): Promise<{ internalOrder: InternalOrder }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/${action}`))
  return data
}

export const customerOrderRoutes: OrderRoutes = { peekNext: peekNextInternalOrderNumber, remove: deleteInternalOrder, act: runInternalOrderAction }

/** FR-22.35: the draft invoice for what can be dispatched now; what waits on supplier orders is `waiting`. Sent no body. */
export async function convertInternalOrder(id: string): Promise<Conversion> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/convert`))
  return data
}

/** FR-22.43: reserves what stock covers; what it could not is named per line (`short`). `{}`: every line. */
export async function reserveAvailable(id: string, body: { lineIds?: string[] }): Promise<{ created: Reservation[]; short: Array<{ lineId: string; productId: string; missing: number }> }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/reserve-available`), body)
  return data
}

/** How a short line could be covered: free stock, then unreserved incoming, then other clients' reservations. */
export interface LineSuggestions {
  lineId: string
  productId: string
  quantity: number
  reservedQuantity: number
  openQuantity: number
  freeStock: Array<{ warehouseId: string; available: number }>
  incoming: Array<{
    orderId: string; orderNumber: string; orderStatus: string; groupId: string; lineId: string; allocationId: string
    warehouseId: string; unreserved: number; expectedDate?: string; late: boolean
  }>
  incomingTotal: number
  preemptable: Array<{
    reservationId: string; reservationNumber: string; contactId: string; internalOrderId?: string; internalOrderNumber?: string
    requestedDeliveryDate?: string; priority?: string; source: string; warehouseId: string; orderNumber?: string; releasable: number
  }>
  preemptableTotal: number
  /** The supplier the article was last bought from, or ordered from. */
  supplierHint?: { supplierId: string; orderNumber?: string; source?: 'recorded' | 'purchase' | 'order' }
}

export async function getInternalOrderSuggestions(id: string): Promise<{
  lines: LineSuggestions[]
  lookup: { warehouses: Record<string, string>; contacts: Record<string, string>; products: Record<string, { name: string; sku?: string }> }
}> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${id}/suggestions`))
  return data
}

/** The body of `POST /:id/generate-external`, as its schema declares it: into a new supplier order, or a draft's. */
export interface GenerateExternalBody {
  orderId?: string
  lines: Array<{ internalOrderLineId: string; quantity: number; supplierId: string; warehouseId?: string }>
}

/** The supplier order the short lines went to, and the reservations made on it. */
export async function generateExternalOrder(id: string, body: GenerateExternalBody): Promise<{ order: SupplierOrder; reservations: Reservation[] }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/generate-external`), body)
  return data
}
