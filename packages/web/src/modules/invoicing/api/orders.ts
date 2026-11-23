import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath, type Done } from './org-path'
import type { InvoiceDocument } from './documents'
import type { Reservation } from './reservations'

/**
 * `api/src/invoicing/controllers/order.controller.ts`, `/org/:orgId/invoicing/orders`: the supplier order (ORDO).
 * A role without the cost figures is answered every order without its expected prices (FR-27.11.C.1). A refused
 * reservation change carries its `code` (`composables/reservation-errors.ts` says it).
 */
const BASE = '/invoicing/orders'

/** Where a line's goods go, and how many: the clients reserve on these. */
export interface OrderAllocation {
  _id: string
  warehouseId: string
  quantity: number
  receivedQuantity: number
}

export interface OrderLine {
  _id: string
  productId?: string
  description: string
  sku?: string
  quantity: number
  unit: string
  /** Left out for a role without the cost figures. */
  expectedUnitPrice?: number
  taxRate?: number
  receivedQuantity: number
  allocations: OrderAllocation[]
}

/** One supplier's part of the order. */
export interface SupplierGroup {
  _id: string
  supplierId: string
  reference?: string
  notes?: string
  lines: OrderLine[]
}

/** A supplier order as the routes answer it (the stored order). */
export interface SupplierOrder {
  _id: string
  orderNumber: string
  status: 'draft' | 'sent' | 'partially_received' | 'received' | 'completed' | 'cancelled'
  issueDate: string
  expectedDate?: string
  currency?: string
  exchangeRate?: number
  notes?: string
  terms?: string
  tags?: string[]
  supplierGroups: SupplierGroup[]
  createdAt: string
}

/** A row of the list: the order, with what its grid shows. */
export interface SupplierOrderRow extends SupplierOrder {
  number: string
  supplierNames: string[]
  orderedQuantity: number
  receivedQuantity: number
  reservationClientCount: number
}

export interface OrderListParams {
  status?: string
  page?: number
  size?: number
  sortBy?: string
  sortOrder?: 'asc' | 'desc'
}

export async function listOrders(params: OrderListParams): Promise<{ orders: SupplierOrderRow[]; total: number; page: number; size: number }> {
  const { data } = await httpClient.get(orgPath(BASE), { params })
  return data
}

/** An invoice against an order, as its read names it. */
export interface OrderInvoiceRef {
  invoiceNumber: string
  type: string
  direction: string
  status: string
  total: number
  currency: string
  issueDate: string
  contactId?: string
}

/** The one read: the order, its reservations (first-class RES- documents), and the names its form shows. */
export interface SupplierOrderRead {
  order: SupplierOrder
  reservations: Reservation[]
  lookup: {
    contacts: Record<string, string>
    warehouses: Record<string, string>
    products: Record<string, { name: string; sku?: string; unit?: string }>
    /** The client orders its reservations are for. */
    internalOrders: Record<string, { orderNumber: string; status: string }>
    invoices: Record<string, OrderInvoiceRef>
  }
}

/** A missing order is a 404. */
export async function getOrder(id: string): Promise<SupplierOrderRead> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${id}`))
  return data
}

/** A client's reservation the order form staged, saved with the order in one transaction (#203). */
export interface ReservationChanges {
  create?: Array<{
    allocationId?: string
    /** Names a NEW allocation (its `clientKey`) before it has an id. */
    allocationKey?: string
    contactId?: string
    quantity: number
    internalOrderId?: string
    internalOrderLineId?: string
    notes?: string
    repeatOf?: string
  }>
  update?: Array<{ id: string; quantity?: number; contactId?: string }>
  cancel?: Array<{ id: string }>
}

/** The body of `POST /` and `PUT /:id`, as their schema (`orderBody`) declares it. */
export interface SupplierOrderBody {
  issueDate: string
  expectedDate?: string
  currency?: string
  exchangeRate?: number
  notes?: string
  terms?: string
  tags?: string[]
  supplierGroups: Array<{
    _id?: string
    supplierId: string
    reference?: string
    notes?: string
    lines: Array<{
      _id?: string
      productId?: string
      description: string
      sku?: string
      quantity: number
      unit?: string
      expectedUnitPrice?: number
      taxRate?: number
      /** `clientKey` names a new allocation, so a staged reservation can point at it. */
      allocations?: Array<{ _id?: string; clientKey?: string; warehouseId: string; quantity: number }>
    }>
  }>
  reservationChanges?: ReservationChanges
}

/**
 * Creates the order. FR-29.13: `headers` carries the attempt's `Idempotency-Key`, so a double click or a save repeated
 * after a timeout gets back the order the first request made (`replayed`).
 */
export async function createOrder(body: SupplierOrderBody, headers: Record<string, string>): Promise<{ order: SupplierOrder; replayed?: true }> {
  const { data } = await httpClient.post(orgPath(BASE), body, { headers })
  return data
}

export async function updateOrder(id: string, body: SupplierOrderBody): Promise<{ order: SupplierOrder }> {
  const { data } = await httpClient.put(orgPath(`${BASE}/${id}`), body)
  return data
}

/** FR-22.36: an invoice for one client's reservations on the order, as far as the order has delivered (`waiting`). */
export interface Conversion {
  invoice: InvoiceDocument
  /** What stays reserved on supplier orders that have not delivered yet. */
  waiting: Array<{ orderNumber?: string; quantity: number }>
}

export async function convertOrderFor(id: string, body: { contactId: string }): Promise<Conversion> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/convert`), body)
  return data
}

/** A sheet of one supplier group, as a file: the supplier's, or the internal one. */
export async function exportOrderGroup(id: string, params: { groupId?: string; variant: 'supplier' | 'internal'; format: 'xlsx' | 'pdf'; locale: string }): Promise<Blob> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${id}/export`), { params, responseType: 'blob' })
  return data
}

/** The number a new order would take, the counter untouched. */
export async function peekNextOrderNumber(): Promise<{ next: string; counter: number; prefix: string }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/peek-next`))
  return data
}

/** A draft only. */
export async function deleteOrder(id: string): Promise<Done> {
  const { data } = await httpClient.delete(orgPath(`${BASE}/${id}`))
  return data
}

/**
 * An order-wide action, sent no body: `send` (a draft), `cancel` (its clients' reservations lose their supply, and the
 * client orders they were for are named in `affectedInternalOrders`), `complete`.
 */
export async function runOrderAction(id: string, action: 'send' | 'cancel' | 'complete'): Promise<{ order: SupplierOrder; affectedInternalOrders?: Array<{ id: string; orderNumber: string }> }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/${action}`))
  return data
}

/**
 * The routes the two order forms' base (`composables/order-form/useOrderFormBase`) calls, the same in shape for a
 * supplier order and a client order: the next number, Delete, and an order-wide action. Each form hands its own.
 */
export interface OrderRoutes {
  peekNext(): Promise<{ next: string }>
  remove(id: string): Promise<Done>
  /** `action` is one the order's controller takes (its `runOrderAction`): the form names it. */
  act(id: string, action: string): Promise<object>
}

export const supplierOrderRoutes: OrderRoutes = { peekNext: peekNextOrderNumber, remove: deleteOrder, act: runOrderAction }
