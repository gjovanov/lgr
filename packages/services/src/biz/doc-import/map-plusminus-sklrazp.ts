/**
 * A складова разписка (store-to-store transfer OUT), pulled per-DOCUMENT via PlusMinus's own
 * `/mobile` API (`sklrazp_*.json`, `header.doc === "СР"` on regal-pz — NOT the same code as
 * regal-sf's till, which is a per-org collision already documented in orgs.ts) → the exact
 * `{number,date,destination,total,lines}` shape `transfer-stock.ts` already consumes. This does
 * not re-implement its product-matching or movement-booking; the caller feeds this straight to
 * that script (`{transfers:[...]}`), which already loops multiple transfers per run, dedups by
 * `sklrazp:<number>`, and cross-checks Σvalue against the document total.
 *
 * Confirmed on 3 real regal-pz docs (2026-10-28/29): every line is a POSITIVE quantity — a
 * transfer always moves stock OUT, never back in. A negative quantity on a transfer would be an
 * unverified shape (a reversal?) this has not seen, so it is refused rather than guessed into
 * either direction.
 */
import { stripPartnerPrefix } from './map-plusminus-invoice.js'
import type { PlusMinusDocument } from './map-plusminus-invoice.js'
import { lineItemName } from './map-plusminus-line.js'

export interface SklrazpLine {
  name: string
  qty: number
  value: number
}

export interface SklrazpMapped {
  number: string
  date: string
  destination?: string
  total: number
  lines: SklrazpLine[]
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function mapSklrazpDoc(doc: PlusMinusDocument): SklrazpMapped {
  const h: any = doc.header || {}
  // header.docNumber only — doc.num is a different, internal transaction sequence and must never
  // leak into the idempotency marker (see map-plusminus-stokrazp.ts for the same guard).
  const number = String(h.docNumber ?? '').trim()
  if (!number) throw new Error('sklrazp document has no header.docNumber')
  const rawDate = String(h.docDate ?? doc.date ?? '')
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(rawDate)
  if (!m) throw new Error(`sklrazp ${number}: unparseable docDate "${rawDate}"`)
  const date = `${m[1]}-${m[2]}-${m[3]}`

  const lines: SklrazpLine[] = []
  for (const l of (doc.lines || []) as any[]) {
    const name = lineItemName(l) // the stock item, not the display alias — see map-plusminus-line.ts
    if (!name) continue
    const qty = num(l.quantity)
    if (qty === 0) continue
    if (qty < 0) throw new Error(`sklrazp ${number}: line "${name}" has a negative quantity (${qty}) — unverified shape, refusing rather than guessing the direction`)
    lines.push({ name, qty, value: Math.abs(num(l.sum)) })
  }
  if (!lines.length) throw new Error(`sklrazp ${number}: no lines with a nonzero quantity`)

  return { number, date, destination: stripPartnerPrefix(h.partner), total: Math.abs(num(h.sum)), lines }
}
