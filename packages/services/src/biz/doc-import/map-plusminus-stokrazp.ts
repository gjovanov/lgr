/**
 * A стокова разписка (goods receipt), pulled per-DOCUMENT via PlusMinus's own `/mobile` API
 * (`stokrazp_*.json`, `header.doc === "СТ"`) → the two shapes the existing, already-proven CLI
 * tools consume — `receive-new-products.ts`'s `{receipt,date,supplier,items}` for the lines that
 * ADD stock, and a parallel `{name,qty,value}` list for the lines that REMOVE it. This is the
 * JSON-API sibling of the hand-fed items file those scripts already take; it does not re-implement
 * their product-matching, tier-building or movement-booking — the caller is expected to drive
 * `receive-new-products.ts`/a direct adjustment call with what this produces.
 *
 * ⚠ The sign lives on the LINE, not the document. Confirmed two ways on the real 2026-10-27..29
 * pull (16 regal-pz + 45 regal-sf docs):
 *   - regal-pz's "2000 КОРЕКЦИЯ" partner carries a MIX: one positive line (a genuine receipt) next
 *     to negative ones (a correction taking stock back out) — `stokrazp_3000016618`.
 *   - regal-sf has whole documents that are ENTIRELY negative (a return to the supplier) with an
 *     ORDINARY partner name, no "КОРЕКЦИЯ" text anywhere — `stokrazp_2222036216` (partner
 *     "ДЕЧКО", all 4 lines negative). Any text-based "is this a correction" check would have
 *     missed this one outright, which is why there isn't one: every line is grouped by its own
 *     qty sign, never by a label on the document.
 * Both halves of one document share the SAME idempotency marker (`stokrazp:<docNumber>`) — they
 * are two bookings of one source document, not a receipt plus an unrelated write-off.
 *
 * Price fields are per-ORG, not fixed: regal-sf's tier slots arrive as `price0`/`price9`, regal-pz's
 * as `price1`/`price2` — observed on the SAME pull. Every `price<N>` key maps to tier "Цена N"
 * generically (no hardcoded slot count); `wholesalePrice` → "Цена на едро"; `retailPrice` → the
 * base selling price; the bare `price` → cost (what `receive-new-products.ts` calls `cost`).
 */
import type { PlusMinusDocument } from './map-plusminus-invoice.js'

export interface StokrazpItem {
  name: string
  qty: number
  unit: string
  cost: number
  selling?: number
  tiers?: Record<string, number>
}

export interface StokrazpAdjustmentLine {
  name: string
  qty: number
  value: number
}

export interface StokrazpMapped {
  docNumber: string
  date: string
  partner?: string
  /** Positive-qty lines — feed to `receive-new-products.ts` as `{receipt,date,supplier,items}`. */
  receiptItems: StokrazpItem[]
  /** Negative-qty lines (qty/value already made positive) — book as a direct `adjustment`
   *  movement, marker `stokrazp:<docNumber>` (NOT `sklisk:` — this is the other half of a
   *  receipt, not a write-off document). */
  adjustmentLines: StokrazpAdjustmentLine[]
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** Same mapping `receive-new-products.ts`/`receive-stock.ts` use for PlusMinus's `measure` codes. */
const UNIT_MAP: Record<string, string> = { 'БР': 'pcs', 'БР.': 'pcs', 'М': 'm', 'КГ': 'kg', 'Л': 'l', 'ЧФ': 'pair', 'К-Т': 'set', 'ОП': 'pack' }
const normalizeUnit = (measure: unknown): string => {
  const raw = String(measure ?? '').trim()
  return raw ? (UNIT_MAP[raw.toUpperCase()] || raw) : 'pcs'
}

/** Every `price<N>` key on a line → tier "Цена N", whatever N's are actually present. */
function extractTiers(line: Record<string, unknown>): Record<string, number> | undefined {
  const tiers: Record<string, number> = {}
  for (const [key, v] of Object.entries(line)) {
    const m = /^price(\d{1,2})$/.exec(key)
    if (m) {
      const price = num(v)
      if (price > 0) tiers[`Цена ${m[1]}`] = price
    }
  }
  const wholesale = num(line.wholesalePrice)
  if (wholesale > 0) tiers['Цена на едро'] = wholesale
  return Object.keys(tiers).length ? tiers : undefined
}

export function mapStokrazpDoc(doc: PlusMinusDocument): StokrazpMapped {
  const h: any = doc.header || {}
  // header.docNumber only — doc.num is a different, internal transaction sequence (e.g. "00000005"
  // vs docNumber "2222036233") and must never leak into the idempotency marker.
  const docNumber = String(h.docNumber ?? '').trim()
  if (!docNumber) throw new Error('stokrazp document has no header.docNumber')
  const rawDate = String(h.docDate ?? doc.date ?? '')
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(rawDate)
  if (!m) throw new Error(`stokrazp ${docNumber}: unparseable docDate "${rawDate}"`)
  const date = `${m[1]}-${m[2]}-${m[3]}`

  const receiptItems: StokrazpItem[] = []
  const adjustmentLines: StokrazpAdjustmentLine[] = []

  for (const l of (doc.lines || []) as any[]) {
    const name = String(l.name || l.item || '').trim()
    if (!name) continue
    const qty = num(l.quantity)
    if (qty === 0) continue

    if (qty > 0) {
      const cost = num(l.price)
      const selling = num(l.retailPrice)
      receiptItems.push({
        name, qty, unit: normalizeUnit(l.measure), cost,
        ...(selling > 0 ? { selling } : {}),
        ...(extractTiers(l) ? { tiers: extractTiers(l) } : {}),
      })
    } else {
      adjustmentLines.push({ name, qty: Math.abs(qty), value: Math.abs(num(l.sum)) })
    }
  }

  return { docNumber, date, partner: h.partner ? String(h.partner) : undefined, receiptItems, adjustmentLines }
}
