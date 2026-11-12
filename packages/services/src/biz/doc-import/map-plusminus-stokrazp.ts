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
 *     to negative ones (a correction taking stock back out) — `stokrazp_3000619618`.
 *   - regal-sf has whole documents that are ENTIRELY negative (a return to the supplier) with an
 *     ORDINARY partner name, no "КОРЕКЦИЯ" text anywhere — `stokrazp_2222639216` (partner
 *     "ПРИМЕРЕН ДОСТАВЧИК", all 4 lines negative). Any text-based "is this a correction" check would have
 *     missed this one outright, which is why there isn't one: every line is grouped by its own
 *     qty sign, never by a label on the document.
 * Both halves of one document share the SAME idempotency marker (`stokrazp:<docNumber>`) — they
 * are two bookings of one source document, not a receipt plus an unrelated write-off.
 *
 * Price fields are per-ORG, not fixed: regal-sf's tier slots arrive as `price0`/`price9`, regal-pz's
 * as `price1`/`price2` — observed on the SAME pull. Every `price<N>` key maps to tier "Цена N"
 * generically (no hardcoded slot count); `wholesalePrice` → "Цена на едро"; `retailPrice` → the
 * base selling price; the bare `price` → cost (what `receive-new-products.ts` calls `cost`).
 *
 * ⚠ A разписка repeats the prices on the PlusMinus item card, typos included: "0172" where 0.172
 * was meant (`Number` reads 172), a decimal point one place off in either direction. A sale price
 * that far from the rest of its line is reported in `priceWarnings` and NOT mapped, so the product
 * keeps what it has. See `PRICE_TYPO_FACTOR`.
 */
import type { PlusMinusDocument } from './map-plusminus-invoice.js'
import { lineItemName } from './map-plusminus-line.js'
import { partnerOf, type PartnerName } from './supplier-name.js'

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

/** A price on a receipt line that sits `PRICE_TYPO_FACTOR` times or more from the rest of its line. */
export interface StokrazpPriceWarning {
  name: string
  /** The PlusMinus field: `price` (the delivery price), `retailPrice`, `wholesalePrice` or `price<N>`. */
  field: string
  /** As PlusMinus sent it, e.g. "0172". */
  raw: string
  value: number
  /** The median of the line's prices, or its delivery price when the line has only two. */
  reference: number
  /** value / reference: above 1 the price is too high, below 1 too low. */
  ratio: number
  /** true: not mapped, so nothing writes it. false: mapped as before and only reported, either
   *  because it is the delivery price (the receipt's unit cost) or because the line has only two
   *  prices and nothing says which of them is wrong. */
  held: boolean
  /**
   * The value is not a number at all ("1.741.5700", "1,74"): it reads as no price, so nothing writes it, and without this
   * it was silently missing from the run (the delivery price of such a line is booked as a unit cost of 0). `value`,
   * `reference` and `ratio` mean nothing then.
   */
  malformed?: boolean
  /**
   * What a malformed value PROBABLY meant, when it is one of the two shapes the cards show: one decimal point too many
   * (the second is dropped) or a decimal comma. Only ever listed for the store to check, never written.
   */
  suggested?: number
}

export interface StokrazpMapped {
  docNumber: string
  date: string
  /** `header.partner` as PlusMinus sent it (`ПАРТНЬОРИ:…` prefix included): what the movement's notes carry. */
  partner?: string
  /**
   * Who the partner is, for finding the supplier (FR-28.12): its bare name when it names a supplier, `correction` for
   * the КОРЕКЦИЯ placeholder (nobody's name), `nobody` when the document has none. Resolving it to a contact is the
   * caller's: `matching.ts#matchSupplierByName`, or the API's contact list for a script.
   */
  supplier: PartnerName
  /** Positive-qty lines — feed to `receive-new-products.ts` as `{receipt,date,supplier,items}`. */
  receiptItems: StokrazpItem[]
  /**
   * Lines with no quantity that carry prices (`qty: 0`). PlusMinus issues a price-only разписка for
   * exactly this: to restate what an article sells for. They go to the same script, which reprices
   * and receives nothing. A price is written only where the document has one.
   */
  priceOnlyItems: StokrazpItem[]
  /** Negative-qty lines (qty/value already made positive) — book as a direct `adjustment`
   *  movement, marker `stokrazp:<docNumber>` (NOT `sklisk:` — this is the other half of a
   *  receipt, not a write-off document). */
  adjustmentLines: StokrazpAdjustmentLine[]
  /** Prices read as typos on the PlusMinus item card. The store should correct these cards. */
  priceWarnings: StokrazpPriceWarning[]
}

/**
 * How many times above or below the median of its own line a price may sit before it is read as
 * a typo on the item card. On the 2026-07..11 pulls (regal-pz 3,253 lines, regal-sf 1,477) nearly
 * every value this far out was a leading-zero or decimal-point typo, while the tiers priced low on
 * purpose (regal-sf's `Цена 9`, about a third of retail) stay well inside it. A held price that was
 * right after all costs only an update: the product keeps its current price, and the run says so.
 */
export const PRICE_TYPO_FACTOR = 5

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const isPriceField = (key: string) => key === 'price' || key === 'retailPrice' || key === 'wholesalePrice' || /^price\d{1,2}$/.test(key)

/**
 * A price as PlusMinus typed it. A number is a number ("0.0165", ".064"). Anything else is malformed and reads as NO price;
 * the two shapes the item cards show get a proposed meaning, which is advice and nothing more:
 * "1.741.5700" (an extra decimal point; the second is dropped: 1.74157) and "1,74" (a decimal comma).
 */
export function parsePrice(raw: unknown): { value: number; malformed: boolean; suggested?: number } {
  const s = String(raw ?? '').trim()
  if (!s) return { value: 0, malformed: false }
  const n = Number(s)
  if (Number.isFinite(n)) return { value: n, malformed: false }
  const dots = /^(\d+\.\d+)\.(\d+)$/.exec(s)
  if (dots) return { value: 0, malformed: true, suggested: Number(`${dots[1]}${dots[2]}`) }
  const comma = /^(\d+),(\d+)$/.exec(s)
  if (comma) return { value: 0, malformed: true, suggested: Number(`${comma[1]}.${comma[2]}`) }
  return { value: 0, malformed: true }
}

/** The line's prices that sit `PRICE_TYPO_FACTOR` times or more from the rest of it, and those that are no number. */
function priceTypos(line: Record<string, unknown>, name: string): StokrazpPriceWarning[] {
  const all = Object.entries(line)
    .filter(([key]) => isPriceField(key))
    .map(([field, raw]) => ({ field, raw: String(raw), ...parsePrice(raw) }))
    .filter(p => p.raw.trim() !== '')
  const prices = all.filter(p => !p.malformed && p.value > 0)
  const cost = prices.find(p => p.field === 'price')?.value ?? 0
  // Two prices have no majority, and either can be the typo: one regal-sf card sells at 24 times
  // its delivery price, and the wrong one is the delivery price. So a pair is only reported,
  // measured against the delivery price, and still written.
  const majority = prices.length >= 3
  const reference = majority ? median(prices.map(p => p.value)) : prices.length === 2 ? cost : 0
  const typos: StokrazpPriceWarning[] = reference > 0
    ? prices
      .filter(p => p.value >= reference * PRICE_TYPO_FACTOR || p.value * PRICE_TYPO_FACTOR <= reference)
      .map(p => ({ name, field: p.field, raw: p.raw, value: p.value, reference, ratio: p.value / reference, held: majority && p.field !== 'price' }))
    : []
  // A value that is no number reads as no price: say so (the delivery price of the line is then booked as a unit cost of 0).
  const malformed: StokrazpPriceWarning[] = all.filter(p => p.malformed).map(p => ({
    name, field: p.field, raw: p.raw, value: 0, reference: reference > 0 ? reference : median(prices.map(x => x.value)) || 0, ratio: NaN,
    held: p.field !== 'price', malformed: true, ...(p.suggested !== undefined ? { suggested: p.suggested } : {}),
  }))
  return [...typos, ...malformed]
}

/** Same mapping `receive-new-products.ts`/`receive-stock.ts` use for PlusMinus's `measure` codes. */
const UNIT_MAP: Record<string, string> = { 'БР': 'pcs', 'БР.': 'pcs', 'М': 'm', 'КГ': 'kg', 'Л': 'l', 'ЧФ': 'pair', 'К-Т': 'set', 'ОП': 'pack' }
const normalizeUnit = (measure: unknown): string => {
  const raw = String(measure ?? '').trim()
  return raw ? (UNIT_MAP[raw.toUpperCase()] || raw) : 'pcs'
}

/** Every `price<N>` key on a line → tier "Цена N", whatever N's are actually present, but a held one. */
function extractTiers(line: Record<string, unknown>, held: Set<string>): Record<string, number> | undefined {
  const tiers: Record<string, number> = {}
  for (const [key, v] of Object.entries(line)) {
    const m = /^price(\d{1,2})$/.exec(key)
    if (m && !held.has(key)) {
      const price = num(v)
      if (price > 0) tiers[`Цена ${m[1]}`] = price
    }
  }
  const wholesale = held.has('wholesalePrice') ? 0 : num(line.wholesalePrice)
  if (wholesale > 0) tiers['Цена на едро'] = wholesale
  return Object.keys(tiers).length ? tiers : undefined
}

export function mapStokrazpDoc(doc: PlusMinusDocument): StokrazpMapped {
  const h: any = doc.header || {}
  // header.docNumber only — doc.num is a different, internal transaction sequence (e.g. "00000005"
  // vs docNumber "2222639233") and must never leak into the idempotency marker.
  const docNumber = String(h.docNumber ?? '').trim()
  if (!docNumber) throw new Error('stokrazp document has no header.docNumber')
  const rawDate = String(h.docDate ?? doc.date ?? '')
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(rawDate)
  if (!m) throw new Error(`stokrazp ${docNumber}: unparseable docDate "${rawDate}"`)
  const date = `${m[1]}-${m[2]}-${m[3]}`

  const receiptItems: StokrazpItem[] = []
  const priceOnlyItems: StokrazpItem[] = []
  const adjustmentLines: StokrazpAdjustmentLine[] = []
  const priceWarnings: StokrazpPriceWarning[] = []

  for (const l of (doc.lines || []) as any[]) {
    const name = lineItemName(l) // the stock item, not the display alias — see map-plusminus-line.ts
    if (!name) continue
    const qty = num(l.quantity)

    if (qty >= 0) {
      const typos = priceTypos(l, name)
      priceWarnings.push(...typos)
      const held = new Set(typos.filter(t => t.held).map(t => t.field))
      const cost = num(l.price)
      const selling = held.has('retailPrice') ? 0 : num(l.retailPrice)
      const tiers = extractTiers(l, held)
      if (qty === 0 && !(selling > 0) && !tiers) continue
      ;(qty > 0 ? receiptItems : priceOnlyItems).push({
        name, qty, unit: normalizeUnit(l.measure), cost,
        ...(selling > 0 ? { selling } : {}),
        ...(tiers ? { tiers } : {}),
      })
    } else {
      adjustmentLines.push({ name, qty: Math.abs(qty), value: Math.abs(num(l.sum)) })
    }
  }

  return { docNumber, date, partner: h.partner ? String(h.partner) : undefined, supplier: partnerOf(h.partner), receiptItems, priceOnlyItems, adjustmentLines, priceWarnings }
}
