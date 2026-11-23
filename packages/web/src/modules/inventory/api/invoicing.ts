import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath } from './org-path'

/**
 * The invoicing routes the inventory screens call: a bill or a sales invoice made from a movement, and an article's
 * supply. Each refusal is an answer with its `code` (and the document that holds the movement, when one does), which
 * the screen reads from the error.
 */

/** A document the server made, as the repository answers it. The screen goes on to it in invoicing. */
export interface MadeDocument {
  _id: string
  id: string
  invoiceNumber?: string
}

/** `invoicing-api/src/controllers/receipt-bill.controller.ts`, `POST /bills/from-receipt`, as its schema declares it. */
export interface BillFromReceiptBody {
  movementIds: string[]
  /** The supplier of a receipt that names none (FR-22.31a). */
  contactId?: string
}

/** `invoicing-api/src/controllers/dispatch-invoice.controller.ts`, `POST /sales/from-dispatch`, as its schema declares it. */
export interface SaleFromDispatchBody {
  movementIds: string[]
  /** „Словом" is written in this language, as the invoice form writes it. */
  locale?: string
  /** The customer of a dispatch that names none (FR-22.61a). */
  contactId?: string
}

/** FR-22.31: the supplier's bill for receipts, a draft, linked, so it moves no stock. */
export async function billFromReceipt(body: BillFromReceiptBody): Promise<{ invoice: MadeDocument }> {
  const { data } = await httpClient.post(orgPath('/invoicing/bills/from-receipt'), body)
  return data
}

/** FR-22.61: the customer's invoice for dispatches, a draft, linked, each line at that customer's price. */
export async function saleFromDispatch(body: SaleFromDispatchBody): Promise<{ invoice: MadeDocument }> {
  const { data } = await httpClient.post(orgPath('/invoicing/sales/from-dispatch'), body)
  return data
}

/** #203: an article's figures in one warehouse. */
export interface SupplyWarehouse {
  warehouseId: string
  warehouseName: string
  onHand: number
  reserved: number
  available: number
  incoming: number
  reservedIncoming: number
  planned: number
  expectedDate: string | null
}

/** What is ordered from a supplier and not yet received. */
export interface SupplyIncoming {
  orderId: string
  orderNumber: string
  status: string
  planned: boolean
  supplierId: string
  supplierName: string
  expectedDate: string | null
  warehouseId: string
  warehouseName: string
  ordered: number
  received: number
  outstanding: number
  reservedIncoming: number
  clients: Array<{ contactId: string; name: string; quantity: number }>
}

/** A client's reservation of the article. */
export interface SupplyReservation {
  id: string
  number: string
  status: string
  source: 'stock' | 'order'
  contactId: string
  contactName: string
  warehouseId: string
  warehouseName: string
  orderId: string | null
  orderNumber: string | null
  internalOrderId: string | null
  internalOrderNumber: string | null
  quantity: number
  invoiced: number
  dispatched: number
  open: number
  expectedDate: string | null
}

/** `services/biz/product-supply.service.ts#ProductSupply`. A role that reads no orders gets the warehouses only. */
export interface ProductSupply {
  warehouses: SupplyWarehouse[]
  incoming: SupplyIncoming[]
  reservations: SupplyReservation[]
}

/** `invoicing-api/src/controllers/product-supply.controller.ts`, `GET /invoicing/product-supply/:productId`. */
export async function getProductSupply(productId: string): Promise<{ supply: ProductSupply }> {
  const { data } = await httpClient.get(orgPath(`/invoicing/product-supply/${productId}`))
  return data
}
