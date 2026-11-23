import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath } from './org-path'
import type { ReservationSources } from '../composables/reservation-form'

/**
 * `api/src/invoicing/controllers/reservation.controller.ts`, `/org/:orgId/invoicing/reservations`: a client's
 * reservation of an article, on stock or on what a supplier order brings (RES-, #203). Every change goes through
 * `services/biz/reservation-ops.service.ts`; a refusal carries its `code` and what it is about
 * (`composables/reservation-errors.ts` says it).
 */
const BASE = '/invoicing/reservations'

/** A reservation as the routes answer it (the repository's record). */
export interface Reservation {
  _id: string
  reservationNumber: string
  status: 'active' | 'fulfilled' | 'cancelled'
  contactId: string
  internalOrderId?: string
  internalOrderLineId?: string
  requestedDeliveryDate?: string
  source: 'stock' | 'order'
  warehouseId: string
  orderId?: string
  groupId?: string
  lineId?: string
  allocationId?: string
  expectedDate?: string
  productId?: string
  quantity: number
  invoicedQuantity: number
  dispatchedQuantity: number
  invoiceIds: string[]
  cancelReason?: 'manual' | 'preempted' | 'internal_order_cancelled' | 'external_order_cancelled' | 'released'
  notes?: string
  /** The cancelled reservation this one repeats. */
  repeatOf?: string
}

/** One read (`GET /:id`): the reservation with the names its page shows (`enrich`). */
export interface ReservationRow extends Reservation {
  number: string
  contactName: string
  warehouseName: string
  productName?: string
  productSku?: string
  productUnit?: string
  /** What a release can still free: quantity − max(invoiced, dispatched). */
  releasable: number
  orderNumber?: string
  internalOrderNumber?: string
  priority?: string
  late: boolean
  shortage: boolean
}

/** Another reservation the page links to: the one this repeats, its repeat, the one it was taken from. */
export interface ReservationRef { _id: string; reservationNumber: string; status: string; quantity: number }

/** Where the reservation sits (FR-28.45): its supply, its client order and line, the invoices that take it. */
export interface ReservationDetail {
  order: { _id: string; orderNumber: string; status: string; expectedDate: string | null; supplierId: string | null; supplierName: string } | null
  allocation: {
    _id: string; warehouseId: string; warehouseName: string; quantity: number; receivedQuantity: number
    lineDescription: string; lineQuantity: number
  } | null
  internalOrder: { _id: string; orderNumber: string; status: string; priority: string; requestedDeliveryDate: string | null } | null
  internalOrderLine: {
    _id: string; description: string; unit: string; quantity: number
    reservedQuantity: number; invoicedQuantity: number; deliveredQuantity: number
  } | null
  invoices: Array<{
    _id: string; invoiceNumber: string; status: string; type: string; direction: string
    issueDate: string | null; currency: string; total: number
    /** How much of this reservation the invoice takes. */
    quantity: number
  }>
  repeatOf: ReservationRef | null
  repeatedAs: ReservationRef | null
  preemptedFrom: ReservationRef | null
  preemptedTo: Array<ReservationRef & { internalOrderId: string | null; internalOrderNumber: string | null; createdAt: string }>
  /** Who did what in its history, by user id. */
  users: Record<string, string>
  /** The supply it hangs on and every reservation on that supply. */
  supply: unknown
}

/** A missing reservation is a 404. */
export async function getReservation(id: string): Promise<{ reservation: ReservationRow; detail: ReservationDetail }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${id}`))
  return data
}

/** Where an article can be reserved from: stock per warehouse, supplier orders' allocations, the client's open lines. */
export async function getReservationSources(params: { productId: string; contactId?: string }): Promise<ReservationSources> {
  const { data } = await httpClient.get(orgPath(`${BASE}/sources`), { params })
  return data
}

/** The source of a reservation: a warehouse's stock, or an allocation of a supplier order's line. */
export type ReservationSource =
  | { source: 'stock'; warehouseId: string }
  | { source: 'order'; orderId: string; groupId: string; lineId: string; allocationId: string }

/** What the create's and the repeat's schemas take of a source: each field optional, named by `source`. */
export interface ReservationSourceBody {
  source?: 'stock' | 'order'
  warehouseId?: string
  orderId?: string
  groupId?: string
  lineId?: string
  allocationId?: string
}

/** The body of `POST /`, as its schema declares it. */
export interface ReservationCreateBody extends ReservationSourceBody {
  source: 'stock' | 'order'
  productId: string
  quantity: number
  contactId?: string
  internalOrderId?: string
  internalOrderLineId?: string
  notes?: string
}

export async function createReservation(body: ReservationCreateBody): Promise<{ reservation: Reservation }> {
  const { data } = await httpClient.post(orgPath(BASE), body)
  return data
}

/** The body of `POST /:id/repeat`, as its schema declares it: what the repeat changes; `{}` repeats it as it was. */
export interface ReservationRepeatBody extends ReservationSourceBody {
  quantity?: number
  contactId?: string
  internalOrderId?: string
  internalOrderLineId?: string
}

/**
 * „Резервирай отново": a cancelled reservation, reserved again. `created` is false when another request had already
 * repeated it: `reservation` is that copy.
 */
export async function repeatReservation(id: string, body: ReservationRepeatBody): Promise<{ reservation: Reservation; created: boolean }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/repeat`), body)
  return data
}

/** A new quantity in place: a raise is checked like a new reservation, a cut not under what is invoiced or dispatched. */
export async function updateReservation(id: string, body: { quantity?: number; contactId?: string }): Promise<{ reservation: Reservation }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/update`), body)
  return data
}

/** Releases `quantity` of it, or all of it (it is cancelled then). */
export async function cancelReservation(id: string, body: { quantity?: number; reason?: 'manual' | 'released' }): Promise<{ reservation: Reservation }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/cancel`), body)
  return data
}

/** The body of `POST /:id/preempt`, as its schema declares it: the client order's line that takes the goods. */
export interface PreemptBody {
  internalOrderId: string
  internalOrderLineId: string
  quantity?: number
}

/** Another client's reservation gives up `quantity` to this order's line, which reserves it. */
export async function preemptReservation(id: string, body: PreemptBody): Promise<{ source: Reservation; created: Reservation }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/preempt`), body)
  return data
}
