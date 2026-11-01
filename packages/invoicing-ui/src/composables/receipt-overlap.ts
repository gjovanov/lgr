/**
 * FR-22.31c: the server's question before a bill books its goods a second time.
 *
 * `POST /invoices/:id/receive` answers 409 `receipt_overlap` when an unclaimed goods receipt may be
 * the same delivery. The refusal is on the server so that no door skips it. Both doors that receive
 * a bill (the form and the list) turn it into `ReceiptOverlapDialog`, which offers the two ways out.
 */

export interface OverlappingReceipt {
  id: string
  number: string
  date: string
  lineCount: number
  total: number
  noSupplier?: boolean
  notes?: string
}

export interface ReceiptOverlap {
  billId: string
  /** The bill's lines a link would replace. */
  typedLines: number
  receipts: OverlappingReceipt[]
}

/**
 * What is ticked for the person: the one receipt that names the bill's supplier, among however many
 * name nobody. One that names nobody is theirs to choose, even alone: it may be another store's
 * goods, and a bill linked to it moves no stock, so a wrong tick loses the real delivery.
 */
export function preselectedReceipts(rows: Array<{ id: string; noSupplier?: boolean }>): string[] {
  const named = rows.filter(r => !r.noSupplier)
  return named.length === 1 ? [named[0].id] : []
}

/** The question in this refusal, or null when `e` is any other failure. */
export function receiptOverlapOf(e: any, billId: string): ReceiptOverlap | null {
  const body = e?.response?.data
  if (e?.response?.status !== 409 || body?.code !== 'receipt_overlap') return null
  return { billId, typedLines: Number(body.typedLines) || 0, receipts: body.receipts || [] }
}
