/**
 * "Have these goods already left on a складова разписка?"
 *
 * In PlusMinus a складова разписка can be CONVERTED into a фактура: the invoice inherits the note's
 * lines, quantities and prices, and PlusMinus writes a comment saying where it came from. The stock
 * left the warehouse on the разписка — the invoice is the paperwork that follows it, not a second
 * shipment.
 *
 * The PDF export drops that comment, so nothing in the document says so. Booking the invoice's
 * dispatch therefore takes the same goods out twice. That is not hypothetical: INV-3000100974
 * (БеПро ЕАД, 2026-09-08) dispatched all 50 lines of складова разписка 0000012713 a second time and
 * put 47 products out by exactly the note's quantity.
 *
 * What is left to recognise it by is the shipment itself, so the test is deliberately narrow —
 * **the same partner, and the same products in the same quantities, all of them**:
 *
 *   - the note names its partner in the „Партньор" column and the invoice names the same contact;
 *   - every invoice line resolves to a product (an unmatched line means we cannot compare, so we
 *     do not guess);
 *   - the two product→quantity maps are equal, in both directions — a subset is not a conversion;
 *   - the note is dated on or before the invoice and inside `WINDOW_DAYS`;
 *   - no invoice is linked to that note yet;
 *   - exactly one note matches. Two candidates mean we cannot tell which, so neither is used.
 *
 * Every one of those is a reason to say NO. A miss books a duplicate dispatch, which the daily
 * snapshot comparison surfaces the next morning; a false hit silently leaves stock in LGR that is
 * no longer on the shelf, which nothing catches. So this errs towards not recognising.
 */
import { Invoice, StockMovement } from 'db/models'
import { logger } from '../../logger/logger.js'
import type { MappedInvoice } from './types.js'

/** How far back a разписка may sit behind the invoice it was converted into. */
const WINDOW_DAYS = 60

/** Movement types a разписка/искане books — what a conversion's stock could have left on. */
const NOTE_TYPES = ['transfer', 'adjustment']

export interface StockNoteConversion {
  /** The idempotency marker of the source note, e.g. `sklrazp:0000012713`. */
  marker: string
  /** Its document number alone, for display. */
  docNumber: string
  movementIds: string[]
  movementNumbers: string[]
  /** Total units the note moved — what the invoice would otherwise dispatch a second time. */
  quantity: number
}

/** The marker sits inside the notes as `Прехвърляне — 2026-09-01 (sklrazp:0000012713)`, so the
 *  document number stops at the closing bracket — `\S+` would carry it into the key. */
const MARKER = /\b(sklrazp|sklisk):([^\s)]+)/

/** Product → total quantity, or null when a line carries stock but no product to attribute it to. */
function demand(lines: Array<{ productId?: string; quantity?: number }>): Map<string, number> | null {
  const out = new Map<string, number>()
  for (const l of lines) {
    const q = Number(l.quantity || 0)
    if (!q) continue
    if (!l.productId) return null
    const id = String(l.productId)
    out.set(id, (out.get(id) || 0) + q)
  }
  return out.size ? out : null
}

function sameShipment(a: Map<string, number>, b: Map<string, number>): boolean {
  if (a.size !== b.size) return false
  for (const [id, q] of a) {
    const other = b.get(id)
    if (other === undefined || Math.abs(other - q) > 0.001) return false
  }
  return true
}

export async function findStockNoteConversion(
  orgId: string,
  mapped: MappedInvoice,
): Promise<StockNoteConversion | null> {
  // Only a real outgoing sales invoice can be one. Credit notes, proformas and cash sales are
  // not what PlusMinus converts, and an incoming bill moves stock the other way.
  if (mapped.direction !== 'outgoing' || mapped.type !== 'invoice') return null
  if (!mapped.contactId) return null

  const want = demand(mapped.lines)
  if (!want) return null

  const issued = mapped.issueDate ? new Date(mapped.issueDate) : new Date()
  const from = new Date(issued.getTime() - WINDOW_DAYS * 86_400_000)
  // One day's grace: a note issued on the invoice's own day may carry a later clock time.
  const to = new Date(issued.getTime() + 86_400_000)

  const rows: any[] = await StockMovement.find(
    {
      orgId,
      contactId: mapped.contactId,
      type: { $in: NOTE_TYPES },
      status: 'completed',
      date: { $gte: from, $lte: to },
    } as any,
    { movementNumber: 1, notes: 1, lines: 1, invoiceId: 1, fromWarehouseId: 1 },
  ).limit(200).lean()

  // A note can book more than one movement — a КОРЕКЦИЯ splits by sign, and a later reconcile
  // adds the lines a first parse missed — so the unit of comparison is the DOCUMENT, not the row.
  const byNote = new Map<string, any[]>()
  for (const m of rows) {
    const marker = MARKER.exec(String(m.notes || ''))
    if (!marker) continue
    const key = `${marker[1]}:${marker[2]}`
    if (!byNote.has(key)) byNote.set(key, [])
    byNote.get(key)!.push(m)
  }

  const hits: StockNoteConversion[] = []
  for (const [marker, movements] of byNote) {
    // Already accounted for by some other invoice.
    if (movements.some(m => m.invoiceId)) continue
    const moved = new Map<string, number>()
    for (const m of movements) {
      for (const l of m.lines || []) {
        const id = String(l.productId)
        moved.set(id, (moved.get(id) || 0) + Number(l.quantity || 0))
      }
    }
    if (!sameShipment(want, moved)) continue
    hits.push({
      marker,
      docNumber: marker.split(':')[1],
      movementIds: movements.map(m => String(m._id)),
      movementNumbers: movements.map(m => m.movementNumber),
      quantity: [...moved.values()].reduce((s, q) => s + q, 0),
    })
  }

  if (hits.length > 1) {
    logger.warn(
      { orgId, reference: mapped.reference, candidates: hits.map(h => h.marker) },
      'doc-import: more than one stock note matches this invoice — not treating it as a conversion',
    )
    return null
  }
  return hits[0] ?? null
}

/** The sentence the review step and the audit trail show for a detected conversion. */
export function conversionWarning(hit: StockNoteConversion): string {
  return `издадена по складова разписка ${hit.docNumber} (${hit.movementNumbers.join(', ')}) — стоката вече е изписана, документът няма да движи наличности`
}

/**
 * Record the relation on both sides.
 *
 * The invoice gets `stockSource`, which is what makes it move no stock — see the guard in
 * `createInvoiceStockMovement`. The note's movements get `invoiceId`, which claims them (a second
 * invoice can no longer match the same note) and is also what FR-11.10's "sales with no stock
 * document" check `$lookup`s on, so a converted invoice stops reading as one.
 */
export async function linkStockSource(orgId: string, invoiceId: string, hit: StockNoteConversion): Promise<void> {
  await Invoice.updateOne(
    { _id: invoiceId, orgId } as any,
    { $set: { stockSource: { marker: hit.marker, docNumber: hit.docNumber, movementIds: hit.movementIds, detectedBy: 'lines', linkedAt: new Date() } } },
  )
  await StockMovement.updateMany(
    { _id: { $in: hit.movementIds }, orgId } as any,
    { $set: { invoiceId } },
  )
  logger.info({ orgId, invoiceId, marker: hit.marker, movements: hit.movementNumbers }, 'doc-import: invoice linked to the stock note it was converted from')
}
