import { httpClient } from 'ui-shared/composables/useHttpClient'
import { orgPath, type Done, type ListPage } from './org-path'

/**
 * `api/src/invoicing/controllers/invoice.controller.ts`, `/org/:orgId/invoices`: every document of the sales and the
 * purchase side (invoices, notes, cash sales, proformas, offers, bills). Issuing one (`/:id/send`) and the stock check
 * in front of it are `./issue`.
 *
 * ⚠ A route that reaches a fiscal device (a payment, a receipt, a cash sale's invoice) is sent with the attempt's
 * `Idempotency-Key` (`headers`): a repeated request is answered with what the first one did (#155, FR-23).
 */
const BASE = '/invoices'

export type DocumentDirection = 'outgoing' | 'incoming'
type Headers = Record<string, string>

/** A step of a line's price, as the pricing chain wrote it (`IPriceStep`). */
export interface PriceStep {
  type: string
  label: string
  price: number
}

/** A line's links to an order and a reservation (conversion invoices, ORDO-linked bills). */
export interface LineOrderRef {
  orderId?: string
  groupId?: string
  lineId?: string
  allocationId?: string
  reservationId?: string
  internalOrderId?: string
  internalOrderLineId?: string
}

/** A line of a document, as the routes answer it. */
export interface DocumentLine {
  _id?: string
  productId?: string
  description?: string
  quantity: number
  unit?: string
  unitPrice: number
  discount?: number
  taxRate?: number
  taxAmount?: number
  lineTotal?: number
  accountId?: string
  warehouseId?: string
  priceExplanation?: PriceStep[]
  orderRef?: LineOrderRef
  sourceText?: string
  cashSaleLineId?: string
  /** FR-30.10: the one read (`GET /:id`) names each line's article. */
  productName?: string
}

export interface BillingAddress {
  street?: string
  city?: string
  state?: string
  postalCode?: string
  country?: string
}

/** A document as the routes answer it (the repository's entity). */
export interface InvoiceDocument {
  _id: string
  id: string
  type: string
  direction: DocumentDirection
  status: string
  /** Its draft number until it is issued. */
  invoiceNumber: string
  contactId?: string
  issueDate: string
  dueDate?: string
  currency: string
  exchangeRate?: number
  /** A bill's supplier invoice number. */
  reference?: string
  relatedInvoiceId?: string
  paymentMethod?: string
  lines: DocumentLine[]
  subtotal: number
  discountTotal?: number
  taxAmount?: number
  total: number
  amountPaid?: number
  amountDue?: number
  notes?: string
  terms?: string
  footer?: string
  reason?: string
  printNote?: string
  companionNote?: string
  preparedBy?: string
  placeOfTransaction?: string
  tags?: string[]
  billingAddress?: BillingAddress
  /** A bill made from goods receipts (FR-22.31), an invoice from stock notes (FR-22.61): it moves no stock itself. */
  stockSource?: { marker?: string } | null
}

/**
 * A row of the list (`listRows`): the document (without its lines when the list asks for `fields=list`), with the
 * names and numbers its grid shows.
 */
export interface DocumentRow extends Omit<InvoiceDocument, 'lines'> {
  lines?: DocumentLine[]
  /** `invoiceNumber`, as the grids' № column reads it. */
  number: string
  contactName: string
  contactEmail: string
  convertedInvoiceNumber: string
  convertedInvoiceType: string
  proformaNumber: string
  offerNumber: string
  relatedInvoiceNumber: string
}

/** The contact as the one read names it, when it exists; else the stored id. */
export interface DocumentContact {
  _id: string
  id: string
  companyName?: string
  firstName?: string
  lastName?: string
  email?: string
}

/** The one read (`GET /:id`): the document, its contact named, and what its form shows of what it is linked to. */
export interface DocumentDetail extends Omit<InvoiceDocument, 'contactId'> {
  contactId?: DocumentContact | string
  /** FR-23: the fiscal receipts that moved its money, a receipt still owed, and one nothing can prove. */
  paymentReceipts: Array<{ id: string; number: string; amount: number; state?: string }>
  receiptToPrint: boolean
  receiptInDoubt: { id: string; number: string } | null
  /** The goods receipts a bill was made from (FR-22.31), the stock notes an invoice was (FR-22.61), what a bill booked. */
  receipts?: unknown[]
  dispatches?: unknown[]
  stockMovements?: unknown[]
}

export interface DocumentListParams {
  type?: string
  direction?: DocumentDirection
  /** Statuses, comma-separated. */
  status?: string
  contactId?: string
  search?: string
  page?: number
  size?: number
}

export async function listDocuments(params: DocumentListParams, signal?: AbortSignal): Promise<ListPage & { invoices: DocumentRow[] }> {
  const { data } = await httpClient.get(orgPath(BASE), { params, signal })
  return data
}

/** The number a new document would take, the counter untouched (`status: 'draft'`: its draft number). */
export async function peekNextDocumentNumber(params: { type?: string; direction?: string; status?: string }): Promise<{ next: string; counter: number; prefix: string }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/peek-next`), { params })
  return data
}

/** The list's tiles (`services/biz/invoice-summary.service.ts#InvoiceSummary`). A 403 for a role without the totals. */
export interface DocumentSummary {
  outstanding: { amount: number; count: number }
  overdue: { amount: number; count: number }
  paid30d: { amount: number; count: number }
  drafts: { count: number }
}

export interface DocumentSummaryParams {
  type?: string
  direction?: DocumentDirection
  tags?: string
  startDate?: string
  endDate?: string
}

export async function getDocumentSummary(params: DocumentSummaryParams): Promise<{ summary: DocumentSummary }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/summary`), { params })
  return data
}

/** A missing document, or one of a kind the role does not read, is a 404. */
export async function getDocument(id: string): Promise<{ invoice: DocumentDetail }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${id}`))
  return data
}

/** The body of `POST /` and `PUT /:id`, as the create's schema declares it (the update's takes the same fields). */
export interface DocumentBody {
  type: 'invoice' | 'proforma' | 'offer' | 'credit_note' | 'debit_note' | 'cash_sale'
  direction: DocumentDirection
  contactId?: string
  issueDate: string
  dueDate?: string
  currency: string
  exchangeRate?: number
  reference?: string
  relatedInvoiceId?: string
  lines: Array<Omit<DocumentLine, '_id' | 'productName'>>
  subtotal: number
  discountTotal?: number
  taxTotal?: number
  taxAmount?: number
  total: number
  totalBase?: number
  paymentMethod?: string
  preparedBy?: string
  placeOfTransaction?: string
  notes?: string
  terms?: string
  footer?: string
  reason?: string
  printNote?: string
  companionNote?: string
  tags?: string[]
  billingAddress?: BillingAddress
  /** Purchase bills only: what the lines change on their products, applied with the save. */
  productUpdates?: Record<string, unknown>[]
  /** A cash sale's: the transfers it waits for, and a receipt on the joined session's device (FR-21.31). */
  pendingTransferIds?: string[]
  receipt?: 'fiscal' | 'text'
}

/**
 * Creates the document. A cash sale is issued as it is made, and may print: `headers` carries the attempt's key, so a
 * repeated save answers the document the first one made.
 */
export async function createDocument(body: DocumentBody, headers: Headers): Promise<{ invoice: InvoiceDocument }> {
  const { data } = await httpClient.post(orgPath(BASE), body, { headers })
  return data
}

export async function updateDocument(id: string, body: Partial<DocumentBody>): Promise<{ invoice: InvoiceDocument }> {
  const { data } = await httpClient.put(orgPath(`${BASE}/${id}`), body)
  return data
}

/** A draft only. */
export async function deleteDocument(id: string): Promise<Done> {
  const { data } = await httpClient.delete(orgPath(`${BASE}/${id}`))
  return data
}

/**
 * Receives a draft bill: it takes its issued number and books its goods. `acknowledgeOverlap` answers the question a
 * 409 `receipt_overlap` put (FR-22.31c); a bill with no overlap is sent no body.
 */
export async function receiveBill(id: string, body?: { acknowledgeOverlap: true }): Promise<{ invoice: InvoiceDocument }> {
  const { data } = body ? await httpClient.post(orgPath(`${BASE}/${id}/receive`), body) : await httpClient.post(orgPath(`${BASE}/${id}/receive`))
  return data
}

/** A draft, or an issued document whose money nothing froze. */
export async function voidDocument(id: string): Promise<{ invoice: InvoiceDocument }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/void`))
  return data
}

/** FR-22.22: a quote becomes the next document, a draft. A proforma's convert is sent no body. */
export async function convertQuote(id: string, body?: { target: 'invoice' | 'proforma' }): Promise<{ invoice: InvoiceDocument }> {
  const { data } = body ? await httpClient.post(orgPath(`${BASE}/${id}/convert`), body) : await httpClient.post(orgPath(`${BASE}/${id}/convert`))
  return data
}

// ── Money that reaches a fiscal device (FR-23) ──────────────────────────────────────────────

/** A fiscal receipt the request printed (`receiptOutcome`). */
export interface PrintedReceipt {
  id: string
  number: string
  state?: string
  unp?: string
  receiptNumber?: string
}

/**
 * What a payment, or a delivery receipt, answers: the document, and the receipt that printed for it. `receiptError`:
 * the device did not confirm the print; the payment stands, and someone checks it. `stornos`: a refund printed them.
 */
export interface ReceiptAnswer {
  invoice: InvoiceDocument
  receipt?: PrintedReceipt
  receiptError?: string
  stornos?: Array<{ id: string; number: string }>
}

/** The body of `POST /:id/payments`, as its schema declares it. */
export interface PaymentBody {
  date: string
  amount: number
  method: 'cash' | 'bank_transfer' | 'card' | 'cash_on_delivery' | 'other'
  reference?: string
  bankAccountId?: string
}

export async function recordPayment(id: string, body: PaymentBody, headers: Headers): Promise<ReceiptAnswer> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/payments`), body, { headers })
  return data
}

/** The receipt of a cash-on-delivery invoice, when issuing it did not print one. Sent an empty body. */
export async function printDeliveryReceipt(id: string, headers: Headers): Promise<ReceiptAnswer> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${id}/receipt`), {}, { headers })
  return data
}

// ── #171: an invoice for a cash sale ────────────────────────────────────────────────────────

/** `services/biz/cash-sale-invoice.service.ts#CashSaleInvoicingState`. Dates are ISO text on the wire. */
export interface CashSaleInvoicing {
  cashSale: {
    id: string; number: string; issueDate: string; status: string; contactId: string | null
    currency: string; total: number; paymentMethod: string
  }
  /** Invoiced whole only: the sale names a customer. */
  wholeOnly: boolean
  lines: Array<{
    lineId: string; productId: string | null; description: string; unit: string
    quantity: number; returned: number; invoiced: number; remaining: number
    unitPrice: number; discount: number; taxRate: number
  }>
  invoices: Array<{ id: string; number: string; status: string; contactId: string | null; total: number; issueDate: string }>
  state: 'none' | 'partial' | 'full'
  canInvoice: boolean
  reason?: string
  remainingTotals: { subtotal: number; discountTotal: number; taxTotal: number; total: number }
}

export async function getCashSaleInvoicing(cashSaleId: string): Promise<{ invoicing: CashSaleInvoicing }> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${cashSaleId}/to-invoice`))
  return data
}

/** The body of `POST /:id/to-invoice`, as its schema declares it. A sale to a named customer is sent no lines. */
export interface CashSaleInvoiceBody {
  contactId: string
  issueDate?: string
  lines?: Array<{ lineId: string; quantity: number }>
  issue?: boolean
  notes?: string
  printNote?: string
  locale?: string
}

export async function invoiceCashSale(cashSaleId: string, body: CashSaleInvoiceBody, headers: Headers): Promise<{ invoice: InvoiceDocument }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${cashSaleId}/to-invoice`), body, { headers })
  return data
}

/** `services/biz/cash-sale-invoice.service.ts#CashSaleCandidates`: the cash sales an invoice may be attached to. */
export interface CashSaleCandidates {
  eligible: boolean
  code?: string
  reason?: string
  day: string
  considered: number
  candidates: Array<{
    id: string; number: string; issueDate: string; total: number; currency: string
    origin: string | null; contactId: string | null; state: 'none' | 'partial' | 'full'
  }>
}

export async function getCashSaleCandidates(invoiceId: string): Promise<CashSaleCandidates> {
  const { data } = await httpClient.get(orgPath(`${BASE}/${invoiceId}/cash-sale-candidates`))
  return data
}

/** FR-21 §11: an invoice entered before its till sale arrived becomes that sale's invoice. */
export async function attachToCashSale(invoiceId: string, body: { cashSaleId: string }): Promise<{ invoice: InvoiceDocument }> {
  const { data } = await httpClient.post(orgPath(`${BASE}/${invoiceId}/attach-to-cash-sale`), body)
  return data
}
