/**
 * Issuing a document, and the stock check in front of it (FR-22.17) — the part with no Vue in it.
 *
 * The sales list's „Изпрати" was the only way to issue: it read the document, asked
 * `/stock-availability/check` for its stocked lines and, when a warehouse was short, offered
 * cross-warehouse transfers before `/send`. The document form issues too now, so the requests live
 * here: `useDocumentIssue` drives them for the list and the form alike, and the integration tests
 * drive the very same functions against the real routes. For every document the list issues it is
 * the list's code moved, not rewritten (FR-22 §5.1).
 */
import { isQuoteType } from 'config/constants'

/** What these functions need of an HTTP client: axios's `get` and `post`. */
export interface IssueClient {
  get(url: string): Promise<{ data: any }>
  post(url: string, body?: any, config?: { headers?: Record<string, string> }): Promise<{ data: any }>
}

export interface StockCheckLine {
  productId: string
  warehouseId: string
  quantity: number
  reservationId?: string
}

/** `/stock-availability/check`'s answer. */
export interface StockCheck {
  sufficient: boolean
  shortfalls: any[]
  proposals: any[]
  allResolvable: boolean
}

/** The lines the availability check is given: product + warehouse lines, each with its reservation. */
export function stockCheckLines(lines: any[] | undefined): StockCheckLine[] {
  // Reservation-backed lines consume their own hold — send the ref so the pre-flight doesn't
  // report the client's reserved stock as a shortfall.
  return (lines || [])
    .filter((l: any) => l.productId && l.warehouseId)
    .map((l: any) => ({ productId: l.productId, warehouseId: l.warehouseId, quantity: l.quantity, reservationId: l.orderRef?.reservationId || undefined }))
}

/**
 * Whether issuing the document is checked for stock first: when issuing it DISPATCHES, i.e. an
 * outgoing invoice or debit note. A quote (a proforma, an offer) moves no stock (FR-22.22). An
 * outgoing credit note is a return that brings the goods back in, and the server checks only
 * dispatches. Checking a credit note here could hold back a return of an article that has sold
 * out, which is when returns come.
 */
export function checksStockOnIssue(doc: { direction?: string; type?: string; stockSource?: { marker?: string } | null }): boolean {
  // A document that takes its goods from another (a stock note, a cash sale: `stockSource`) dispatches none, so
  // there is nothing to check, and no transfer to offer for goods that have already left.
  if (doc.stockSource?.marker) return false
  return doc.direction === 'outgoing' && !isQuoteType(doc.type) && doc.type !== 'credit_note'
}

/** A stock note an invoice may be for (FR-22.61b), as the question and the link picker list it. */
export interface OverlappingDispatch {
  id: string
  number: string
  date: string
  lineCount: number
  /** Units over its lines. No value: a note's amounts are costs. */
  quantity: number
  /** It names no customer, and takes the invoice's. */
  noCustomer?: boolean
  /** Its notes, when it names no customer: all there is to tell whose goods they were. */
  notes?: string
}

/**
 * FR-22.61b: the server's question before a sales invoice dispatches goods a stock note already delivered.
 * `POST /invoices/:id/send` answers 409 `dispatch_overlap`; the refusal is on the server so that no door skips it.
 * A form asks first (`GET /invoicing/sales/:id/dispatch-overlap`): an invoice about to be linked takes no stock, so
 * nothing about its stock should be asked, or a transfer offered, before this is answered.
 */
export interface DispatchOverlap {
  invoiceId: string
  /** The invoice's lines that say something. */
  typedLines: number
  notes: OverlappingDispatch[]
  /** The invoice names no customer, and neither do these notes: a link has to be told who. */
  needsCustomer?: boolean
}

/** Whether issuing this document can meet the question: a draft sales invoice whose goods no document has moved. */
export function asksAboutDispatches(doc: { direction?: string; type?: string; status?: string; stockSource?: { marker?: string } | null }): boolean {
  return doc.direction === 'outgoing' && doc.type === 'invoice' && (doc.status ?? 'draft') === 'draft' && !doc.stockSource?.marker
}

/** The question in this refusal of `/send`, or null when `e` is any other failure. */
export function dispatchOverlapOf(e: any, invoiceId: string): DispatchOverlap | null {
  const body = e?.response?.data
  if (e?.response?.status !== 409 || body?.code !== 'dispatch_overlap') return null
  return { invoiceId, typedLines: Number(body.typedLines) || 0, notes: body.notes || [], needsCustomer: !!body.needsCustomer }
}

/**
 * What is ticked for the person: the one note that names the invoice's customer, among however many name nobody.
 * One that names nobody is theirs to choose, even alone: it may be anybody's goods, and an invoice linked to it
 * moves no stock, so a wrong tick loses the real dispatch (the receipts' rule, `preselectedReceipts`).
 */
export function preselectedDispatches(rows: Array<{ id: string; noCustomer?: boolean }>): string[] {
  const named = rows.filter(r => !r.noCustomer)
  return named.length === 1 ? [named[0].id] : []
}

/**
 * Whether issuing asks the person to confirm the payment method first (owner, 2026-11-12): an outgoing invoice, whose
 * method decides what is booked and, at a till, what prints (FR-23: cash prints a fiscal receipt at the counter). The
 * question is asked of the document AS STORED, after the form has saved it: the method it will be issued with.
 */
export function confirmsPaymentOnIssue(doc: { direction?: string; type?: string }): boolean {
  return doc.direction === 'outgoing' && doc.type === 'invoice'
}

/** FR-22.14: the message names the document that was issued — a credit note is not „Фактурата". */
export const ISSUED_KEY: Record<string, string> = {
  invoice: 'invoicing.invoiceSent',
  credit_note: 'invoicing.creditNoteIssued',
  debit_note: 'invoicing.debitNoteIssued',
  proforma: 'invoicing.proformaIssued',
  offer: 'invoicing.offerIssued',
}

/**
 * FR-23: what the person reads when a document was issued and something about its receipt went wrong,
 * and whether the Pay action is the way on. One that printed through an error did print: nothing is left to
 * pay, and only the device can say more. One in doubt comes here as `unknown`: nothing was booked for it, the
 * reason says so, and Pay is no way on: it waits for a person to settle it. A cash-on-delivery invoice owes the
 * courier's money, not a payment at the counter: its receipt prints on its own, and Pay would record
 * money nobody brought. A document that changed under its issue printed nothing, and says so in words.
 * A refund that stopped after a part printed says how much went back: that money left the drawer, and
 * "nothing was refunded" beside it has a person hand it over again. A part held in doubt stops Refund too.
 */
export function issuedReceiptNotice(issued: { receiptError?: string; receiptCode?: string; paymentMethod?: string; type?: string; refunded?: number; receipt?: { state?: string } } | null | undefined): { key: string; takesPayment: boolean } | null {
  if (!issued?.receiptError) return null
  if (Number(issued.refunded) > 0) return { key: 'cashRegister.receipt.issuedPartlyRefunded', takesPayment: issued.receipt?.state !== 'unknown' }
  if (issued.receiptCode === 'issue_tender_moved') {
    if (issued.type === 'credit_note') return { key: 'cashRegister.receipt.issuedChangedRefund', takesPayment: true }
    return issued.paymentMethod === 'cash_on_delivery'
      ? { key: 'cashRegister.receipt.issuedChangedDelivery', takesPayment: false }
      : { key: 'cashRegister.receipt.issuedChanged', takesPayment: true }
  }
  if (issued.receipt?.state === 'unknown' || issued.receipt?.state === 'printed') return { key: 'cashRegister.receipt.issuedUnknown', takesPayment: false }
  if (issued.paymentMethod === 'cash_on_delivery') return { key: 'cashRegister.receipt.issuedNoReceipt', takesPayment: false }
  // R2: its storno did not print. Nothing went back, and the Refund action gives it.
  if (issued.type === 'credit_note') return { key: 'cashRegister.receipt.issuedNotRefunded', takesPayment: true }
  return { key: 'cashRegister.receipt.issuedNotPaid', takesPayment: true }
}

/**
 * What the cash-sale form asks of its session's device. Where LGR prints there is nothing to choose: the sale prints, and
 * the device says how. An org where it prints nothing keeps what it had, which is nothing unless the person asks.
 */
export function joinedSaleReceipt(o: { sessionOpen: boolean; prints: boolean; chosen: '' | 'fiscal' }): { receipt?: 'fiscal' } {
  if (!o.sessionOpen) return {}
  return o.prints || o.chosen ? { receipt: 'fiscal' } : {}
}

/** Ask whether the warehouses hold what `lines` take. */
export async function checkStock(client: IssueClient, orgUrl: string, lines: StockCheckLine[]): Promise<StockCheck> {
  const { data } = await client.post(`${orgUrl}/invoicing/stock-availability/check`, { lines })
  return data
}

/**
 * What issuing document `id` starts from: the document as stored, and — when issuing it takes
 * stock and a warehouse is short — the availability answer to offer transfers from. `check` is
 * null when nothing needed asking or everything is there.
 *
 * `overlap` (FR-22.61b) comes before either: the stock notes this invoice may be for. With one, nothing about the
 * stock is asked yet, because the answer decides whether the invoice takes any. `acknowledgeOverlap` says the
 * person has answered „other goods", so the question is not put again.
 */
export async function prepareIssue(
  client: IssueClient,
  orgUrl: string,
  id: string,
  opts: { acknowledgeOverlap?: boolean } = {},
): Promise<{ invoice: any; check: StockCheck | null; overlap: DispatchOverlap | null }> {
  // First fetch full invoice to get lines with warehouseId
  const { data } = await client.get(`${orgUrl}/invoices/${id}`)
  const invoice = data.invoice
  if (!opts.acknowledgeOverlap && asksAboutDispatches(invoice)) {
    try {
      const { data: asked } = await client.get(`${orgUrl}/invoicing/sales/${id}/dispatch-overlap`)
      if (asked?.overlap?.notes?.length) return { invoice, check: null, overlap: { invoiceId: id, ...asked.overlap } }
    } catch {
      // Not answered here: `/send` asks the same question, and its refusal opens the same dialog.
    }
  }
  const lines = stockCheckLines(invoice.lines)
  if (!lines.length || !checksStockOnIssue(invoice)) return { invoice, check: null, overlap: null }
  const check = await checkStock(client, orgUrl, lines)
  return { invoice, check: check.sufficient ? null : check, overlap: null }
}

/** An article whose quantity on an invoice is not what its stock notes delivered (FR-22.62). */
export interface QuantityDifference {
  productId: string
  name: string
  dispatched: number
  invoiced: number
}

export type LinkDispatchesResult =
  /** Linked. `linesWritten`: the notes' lines took the place of what was typed, so the person reads them before issuing. */
  | { linked: true; linesWritten: boolean }
  /** Not linked: the invoice says something other than the notes delivered. `replaceLines` is the person's consent. */
  | { linked: false; differs: QuantityDifference[] }

/**
 * FR-22.62: link draft invoice `id` to stock notes. An invoice whose stock lines already say what the notes
 * delivered keeps every line; one that differs is not linked until `replaceLines` says the notes' lines may take
 * their place. Any other refusal is thrown, as the server answered it.
 */
export async function linkDispatches(
  client: IssueClient,
  orgUrl: string,
  id: string,
  body: { movementIds: string[]; replaceLines?: boolean; contactId?: string },
): Promise<LinkDispatchesResult> {
  try {
    const { data } = await client.post(`${orgUrl}/invoicing/sales/${id}/link-dispatches`, body)
    return { linked: true, linesWritten: !!data?.linesWritten }
  } catch (e: any) {
    const refusal = e?.response?.data
    if (e?.response?.status === 422 && refusal?.code === 'invoice_lines_differ') return { linked: false, differs: refusal.lines || [] }
    throw e
  }
}

/** The transfer movements a confirmed transfer dialog asks for; the document confirms them as it is issued. */
export async function createTransfers(client: IssueClient, orgUrl: string, proposals: any[]): Promise<string[]> {
  const { data } = await client.post(`${orgUrl}/invoicing/stock-availability/create-transfers`, { proposals })
  return data.transferIds
}

/** Issue document `id` — `/send`, with the transfers it waits for when there are any. */
export async function sendIssue(
  client: IssueClient,
  orgUrl: string,
  id: string,
  body: { pendingTransferIds?: string[]; acknowledgeOverlap?: boolean } = {},
  headers: Record<string, string> = {},
): Promise<any> {
  const { data } = await client.post(`${orgUrl}/invoices/${id}/send`, body, { headers })
  // FR-23: issued, and its receipt did not print. The issue stands; the caller says so.
  return data?.receiptError
    ? { ...data.invoice, receiptError: data.receiptError, receiptCode: data.receiptCode, receipt: data.receipt, refunded: data.refunded, stornos: data.stornos }
    : data?.invoice
}
