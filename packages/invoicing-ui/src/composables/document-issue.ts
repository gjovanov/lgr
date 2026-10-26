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
 * outgoing invoice or debit note. A proforma is an offer and moves no stock (FR-22.22). An
 * outgoing credit note is a return that brings the goods back in, and the server checks only
 * dispatches. Checking a credit note here could hold back a return of an article that has sold
 * out, which is when returns come.
 */
export function checksStockOnIssue(doc: { direction?: string; type?: string }): boolean {
  return doc.direction === 'outgoing' && doc.type !== 'proforma' && doc.type !== 'credit_note'
}

/** FR-22.14: the message names the document that was issued — a credit note is not „Фактурата". */
export const ISSUED_KEY: Record<string, string> = {
  invoice: 'invoicing.invoiceSent',
  credit_note: 'invoicing.creditNoteIssued',
  debit_note: 'invoicing.debitNoteIssued',
  proforma: 'invoicing.proformaIssued',
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
 */
export async function prepareIssue(client: IssueClient, orgUrl: string, id: string): Promise<{ invoice: any; check: StockCheck | null }> {
  // First fetch full invoice to get lines with warehouseId
  const { data } = await client.get(`${orgUrl}/invoices/${id}`)
  const invoice = data.invoice
  const lines = stockCheckLines(invoice.lines)
  if (!lines.length || !checksStockOnIssue(invoice)) return { invoice, check: null }
  const check = await checkStock(client, orgUrl, lines)
  return { invoice, check: check.sufficient ? null : check }
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
  body: { pendingTransferIds?: string[] } = {},
  headers: Record<string, string> = {},
): Promise<any> {
  const { data } = await client.post(`${orgUrl}/invoices/${id}/send`, body, { headers })
  return data?.invoice
}
