/**
 * "Did the till already sell this invoice?"
 *
 * A counter shop rings a sale on the till and prints a фактура for the same sale when the customer
 * asks for one. The day's till export is the aggregate of those till documents, so it ALREADY
 * carries that sale — and booking the invoice's dispatch as well takes the same goods out twice.
 *
 * That is not hypothetical. regal-sf's first day in LGR (2026-10-01) had three such invoices —
 * INV-2000128350, INV-2000128365 and INV-2000128367, seventeen lines between them — and every one
 * of those lines came out of stock twice. Two products were driven negative. PlusMinus's own
 * snapshot settled it: for all seventeen, `snapshot − LGR` equalled the invoice quantity exactly,
 * so PlusMinus had deducted once.
 *
 * ⚠ THIS ONLY WARNS. It must never suppress the dispatch by itself, and the reason is the shape of
 * the evidence rather than a lack of nerve:
 *
 *   - Containment is not proof. An invoice whose lines all appear in the till at sufficient
 *     quantity may still be a genuinely separate sale — the till simply sold at least as much of
 *     every one of those articles that day, which for one or two fast-moving lines is ordinary.
 *   - The only reliable arbiter is the day's stock snapshot, and that does not exist at import
 *     time. It arrives with the next export.
 *   - The two errors are not symmetric. A missed overlap books a duplicate dispatch, which the
 *     daily snapshot comparison surfaces the next morning. A false hit silently leaves stock in
 *     LGR that is no longer on the shelf, and NOTHING catches that. The same asymmetry is why
 *     `findStockNoteConversion` errs towards not recognising.
 *
 * So the test is narrow, it reports, and a person decides. `cashSaleReference` keys the day, so
 * this works whichever export carried the till — the АРТИКУЛИ `salesAnalysis` that regal-pz sends
 * or the „Складови операции / Операция: Продажби" one that regal-sf sends.
 */
import { Invoice } from 'db/models'
import type { MappedInvoice } from './types.js'
import { cashSaleReference } from './map-cash-sale.js'

/** Product id → the total quantity that day's till sold of it. */
export type TillDemand = Map<string, number>

export interface TillDay {
  demand: TillDemand
  /** The cash sale already in the ledger, when there is one; null while it is still only a file. */
  docNumber: string | null
  reference: string
}

export interface TillOverlap {
  reference: string
  docNumber: string | null
  /** How many invoice lines the till covers — always every line, or there is no hit. */
  lines: number
  quantity: number
}

/** The day's till as already booked. Returns null when the day has no cash sale in the ledger. */
export async function loadCommittedTillDay(orgId: string, date: string): Promise<TillDay | null> {
  const reference = cashSaleReference(date)
  const cs: any = await Invoice.findOne({ orgId, reference, type: 'cash_sale' } as any)
    .select('invoiceNumber lines')
    .lean()
  if (!cs) return null
  const demand: TillDemand = new Map()
  for (const l of cs.lines || []) {
    if (!l.productId) continue
    const id = String(l.productId)
    demand.set(id, (demand.get(id) || 0) + Number(l.quantity || 0))
  }
  return { demand, docNumber: String(cs.invoiceNumber), reference }
}

/**
 * Is every line of this invoice covered by the till's own quantities?
 *
 * A line carrying no product means the two cannot be compared at all, so the answer is no rather
 * than a guess — exactly as for the разписка→фактура test.
 */
export function findTillOverlap(mapped: MappedInvoice, till: TillDay): TillOverlap | null {
  // Only an outgoing sales invoice can duplicate a till sale. A bill, a cash sale itself, or a
  // credit note is a different document with a different direction.
  if (mapped.type !== 'invoice' || mapped.direction !== 'outgoing') return null
  if (!till.demand.size) return null

  const lines = (mapped.lines || []).filter(l => Number(l.quantity || 0) !== 0)
  if (!lines.length) return null

  let quantity = 0
  for (const l of lines) {
    if (!l.productId) return null
    const q = Number(l.quantity || 0)
    const sold = till.demand.get(String(l.productId))
    if (sold === undefined || sold + 0.001 < q) return null
    quantity += q
  }
  return { reference: till.reference, docNumber: till.docNumber, lines: lines.length, quantity }
}

/**
 * The operator-facing message.
 *
 * It carries "VERIFY before committing", which is what the Files review treats as blocking: the
 * document drops out of the recommended set and someone has to look at it.
 */
export function tillOverlapWarning(hit: TillOverlap): string {
  const where = hit.docNumber ? `${hit.docNumber} (${hit.reference})` : `the day's till export (${hit.reference})`
  return `all ${hit.lines} line(s) of this invoice — ${hit.quantity} unit(s) — are covered by ${where}. `
    + `If this invoice is the paperwork for a sale the till already rang, booking it dispatches the same goods a second time. `
    + `VERIFY before committing; if it is the same sale, commit with stock adjustment off.`
}
