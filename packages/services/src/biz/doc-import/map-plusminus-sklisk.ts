/**
 * An искане за отпускане на материали (internal write-off: consumed / damaged / lost), pulled
 * per-DOCUMENT via PlusMinus's own `/mobile` API (`sklisk_*.json`, `header.doc === "СИ"`) → the exact
 * `{number,date,reason,total,lines}` shape `adjust-stock.ts` already consumes. The sibling of
 * `map-plusminus-sklrazp.ts`: a transfer leaves for another store, a write-off leaves for nowhere —
 * both only ever take stock OUT, so a negative quantity is refused rather than guessed.
 *
 * `value` is only the Σ cross-check against the header total (the cost booked is the product's own
 * average cost), and it must follow PlusMinus's OWN `sum`, line by line, because that is what the
 * header total was added up from. Seen on the real regal-pz pulls (2026-11-01, 7 documents): a line
 * with a decimal-COMMA price (`"0,8"`) and NO `sum` — and the header total (83.43) is exactly the
 * sum of the OTHER lines, i.e. PlusMinus itself counts that line as zero. Deriving 0.8 from
 * price × quantity looked helpful and pushed Σvalue 0.8 over the total, tripping the ±0.5 guard.
 * So: a missing or unreadable `sum` is 0, never a guess. (The quantity still counts — it is the
 * quantity that leaves the shelf.)
 */
import type { PlusMinusDocument } from './map-plusminus-invoice.js'
import { lineItemName } from './map-plusminus-line.js'

export interface SkliskLine {
  name: string
  qty: number
  value: number
}

export interface SkliskMapped {
  number: string
  date: string
  total: number
  lines: SkliskLine[]
}

/** PlusMinus amounts are strings and sometimes carry a decimal comma. */
const decimal = (v: unknown): number => {
  if (v === undefined || v === null || v === '') return NaN
  const n = Number(String(v).trim().replace(',', '.'))
  return Number.isFinite(n) ? n : NaN
}
const orZero = (n: number) => (Number.isFinite(n) ? n : 0)

export function mapSkliskDoc(doc: PlusMinusDocument): SkliskMapped {
  const h: any = doc.header || {}
  // header.docNumber only — doc.num is a different, internal transaction sequence and must never
  // leak into the idempotency marker (see map-plusminus-stokrazp.ts for the same guard).
  const number = String(h.docNumber ?? '').trim()
  if (!number) throw new Error('sklisk document has no header.docNumber')
  const rawDate = String(h.docDate ?? doc.date ?? '')
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(rawDate)
  if (!m) throw new Error(`sklisk ${number}: unparseable docDate "${rawDate}"`)
  const date = `${m[1]}-${m[2]}-${m[3]}`

  const lines: SkliskLine[] = []
  for (const l of (doc.lines || []) as any[]) {
    const name = lineItemName(l) // the stock item, not the display alias — see map-plusminus-line.ts
    if (!name) continue
    const qty = orZero(decimal(l.quantity))
    if (qty === 0) continue
    if (qty < 0) throw new Error(`sklisk ${number}: line "${name}" has a negative quantity (${qty}) — unverified shape, refusing rather than guessing the direction`)
    lines.push({ name, qty, value: Math.abs(orZero(decimal(l.sum))) })
  }
  if (!lines.length) throw new Error(`sklisk ${number}: no lines with a nonzero quantity`)

  return { number, date, total: Math.abs(orZero(decimal(h.sum))), lines }
}
