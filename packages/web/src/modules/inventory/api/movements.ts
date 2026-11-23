import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath, type ListPage } from './org-path'

/** `api/src/warehouse/controllers/movement.controller.ts`, `/org/:orgId/warehouse/movement`. */
const BASE = '/warehouse/movement'

/** The kinds `POST /`'s schema accepts. */
export type MovementType = 'receipt' | 'dispatch' | 'transfer' | 'adjustment' | 'return' | 'production_in' | 'production_out'

/** A line as the routes answer it. A role without the cost figures gets no cost (FR-27.11.C.1). */
export interface MovementLine {
  productId: string
  quantity: number
  unitCost?: number
  totalCost?: number
  batchNumber?: string
  serialNumbers?: string[]
  /** A receipt booked with its product update: what it changed on the article (`gr-product-update.ts`). */
  productUpdate?: Record<string, unknown>
  priceTiers?: Record<string, unknown>[]
  /** The one read (`GET /:id`) adds the article's name and SKU. */
  productName?: string
  productSku?: string
}

/** A document a movement is held by, or the one that stops it being billed or invoiced (FR-22.31, FR-22.61). */
export interface MovementDocumentRef { id: string; number: string }
export interface MovementRefusalRef { code: string; number?: string }

/** A movement as the routes answer it (the repository's entity). */
export interface StockMovement {
  _id: string
  id: string
  movementNumber: string
  type: MovementType
  status: 'draft' | 'confirmed' | 'completed' | 'cancelled'
  date: string
  fromWarehouseId?: string
  toWarehouseId?: string
  /** ⚠ A booked movement names an external side here: its stock fields name only the warehouses whose stock it moved. */
  externalFromWarehouseId?: string
  externalToWarehouseId?: string
  contactId?: string
  invoiceId?: string
  inventoryCountId?: string
  lines: MovementLine[]
  /** Left out for a role without the cost figures (FR-27.11.C.2). */
  totalAmount?: number
  reference?: string
  notes?: string
}

/**
 * The one read (`GET /:id`): the movement, its number as `number` too, which side is external, and whether a bill or
 * a sales invoice may be made from it (only for a session that reads those documents).
 */
export interface StockMovementDetail extends StockMovement {
  number: string
  fromExternal: boolean
  toExternal: boolean
  billable?: boolean
  needsSupplier?: boolean
  notBillable?: MovementRefusalRef
  bill?: MovementDocumentRef
  invoiceable?: boolean
  needsCustomer?: boolean
  notInvoiceable?: MovementRefusalRef
  sale?: MovementDocumentRef
}

/** A line as the form sends it. */
export interface MovementLineBody {
  productId: string
  quantity: number
  unitCost: number
  totalCost: number
}

/** The body of `POST /`, as its schema declares it (the fields the form sends). */
export interface MovementCreateBody {
  type: MovementType
  date: string
  fromWarehouseId?: string
  toWarehouseId?: string
  contactId?: string
  notes?: string
  totalAmount: number
  lines: MovementLineBody[]
}

/**
 * The body of `POST /with-update`: a receipt, with what its lines change on their articles. The changes are objects
 * the server checks (`AnObject`; `ui-shared/composables/gr-product-update.ts#buildProductUpdates` makes them).
 */
export interface ReceiptWithUpdateBody extends Omit<MovementCreateBody, 'type'> {
  type: 'receipt'
  productUpdates?: Record<string, unknown>[]
}

/**
 * The body of `PUT /:id` (a draft). No `type`: it is fixed at the create. `null` clears a warehouse or the partner;
 * left out, the draft keeps the one it has.
 */
export interface MovementUpdateBody {
  date?: string
  fromWarehouseId?: string | null
  toWarehouseId?: string | null
  contactId?: string | null
  notes?: string
  totalAmount?: number
  lines?: MovementLineBody[]
  /** Receipts only: applied with the edit, in one transaction. */
  productUpdates?: Record<string, unknown>[]
}

/** What a create answers: the movement (`/with-update` answers its id and number only), and whether it was a replay. */
export interface MovementCreated {
  stockMovement: Pick<StockMovement, '_id'> & Partial<StockMovement>
  replayed?: boolean
  updatedProductIds?: string[]
}

export interface MovementListParams {
  productId?: string
  page?: number
  /** The route's own page is 10; 0 is every movement. */
  size?: number
}

export async function listMovements(params: MovementListParams): Promise<ListPage & { stockMovements: StockMovement[] }> {
  const { data } = await httpClient.get(orgPath(BASE), { params })
  return data
}

export async function getMovement(id: string): Promise<{ stockMovement: StockMovementDetail }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${id}`))
  return data
}

/**
 * Creates a draft. `headers` carries the attempt's `Idempotency-Key` (FR-29.13): a repeated request is answered with
 * the movement the first one made.
 */
export async function createMovement(body: MovementCreateBody, headers?: Record<string, string>): Promise<MovementCreated> {
  const { data } = await httpClient.post(orgPath(BASE), body, { headers })
  return data
}

/** Creates a receipt and applies its product updates in one transaction. `headers` as for `createMovement`. */
export async function createReceiptWithUpdate(body: ReceiptWithUpdateBody, headers?: Record<string, string>): Promise<MovementCreated> {
  const { data } = await httpClient.post(orgPath(`${BASE}/with-update`), body, { headers })
  return data
}

/** Edits a draft; a booked movement is refused (400). */
export async function updateMovement(id: string, body: MovementUpdateBody): Promise<{ stockMovement: StockMovement }> {
  const { data } = await httpClient.put(orgPath(`${BASE}/${id}`), body)
  return data
}

/**
 * Books a draft. `createCount` (FR-04, #11): confirming a manual adjustment also makes its completed inventory count.
 * Only the UI asks for it; imports and skills that confirm through the API stay count-free.
 */
export async function confirmMovement(id: string, body: { createCount?: boolean }): Promise<{ stockMovement: StockMovement }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/confirm`), body)
  return data
}

/** Deletes a draft; the API names what holds one it refuses. */
export async function deleteMovement(id: string): Promise<{ message: string }> {
  const { data } = await httpClient.delete(orgPath(`${BASE}/${id}`))
  return data
}
