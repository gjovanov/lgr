/**
 * One day of regal-pz till sales, read from PlusMinus's POS receipt tables over its `/mobile` API
 * (`posDocuments(object, from, to, "", "receipts")`; the local puller writes `posReceipts_<YYYYMMDD>.json`)
 * and aggregated per article into the same `TillAggregate` the regal-sf path builds
 * (`map-plusminus-till.ts`), so the importer's product matching, line building and POST are shared
 * (`scripts/import-cash-register-sales-api.ts`).
 *
 * What a receipt is, as READ from the live server on 2026-11-02 and checked against everything LGR
 * already held: the 19 booked October days (every article's quantity and net value, 1 123 article-days,
 * no mismatch), the month-aggregate control for the three days that were missing (all 185 articles), and
 * the till's own cash-box closings (22 of 22 daily card totals, to the cent):
 *
 *   - The list holds two kinds of entry. `header.doc === "КБ"` is a cash receipt and carries `lines`.
 *     `"ПЛ"` is a payment taken at the till against an INVOICE (`header.invoice` names it) and has no
 *     lines: money, not a sale of goods, so it is skipped here.
 *   - A receipt belongs to the day in `header.closedOn` ("YYYYMMDD:HHMMSSmmm", store time).
 *   - `lines[].sum` is the NET list value. `sumWithVat` is the gross at a cent-rounded unit price, so it
 *     cannot be divided back to the net.
 *   - A receipt-level percentage discount (`discountType "1"`, `discount` = percent) applies to every line:
 *     the value the sales-analysis report shows is `sum × (1 − discount / 100)`.
 *   - A return (`status "return"`) already carries NEGATIVE quantities and sums, while its `header.sum`
 *     is positive. The sign is never flipped again.
 *   - An article that nets to zero (a same-day return cancelling a sale) is not in the report, so it is
 *     not a line here either.
 *   - On every receipt |header.sum| = Σ lines.sumWithVat − totalDiscountSum. That is the integrity check:
 *     a receipt with a missing line fails it.
 *
 * Anything outside that (another document type, status, discount type or VAT rate, a receipt that does
 * not add up) throws instead of being guessed: the importer would otherwise book wrong revenue silently.
 */
import type { TillAggregate, TillRow } from './map-plusminus-till.js'

export interface PosReceiptLine {
  item?: unknown
  name?: unknown
  quantity?: unknown
  sum?: unknown
  sumWithVat?: unknown
  [key: string]: unknown
}

export interface PosReceipt {
  num?: string
  date?: string
  header?: Record<string, unknown>
  lines?: PosReceiptLine[]
}

/** The VAT rate the importer books every till line at (`VAT_RATE` in the importer); another rate is refused. */
const SUPPORTED_VAT = '20'
/** One cent of rounding on a receipt's gross figures. */
const GROSS_TOLERANCE = 0.011

const num = (v: unknown): number => {
  const n = Number(String(v ?? '').replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}
/** Half away from zero, immune to the binary representation of x.xx5 (and never returns -0). */
const round2 = (v: number) => Math.sign(v) * Math.round((Math.abs(v) + 1e-9) * 100) / 100 + 0
const round3 = (v: number) => Math.round(v * 1000) / 1000 + 0
const stripGroup = (s: unknown) => String(s ?? '').replace(/^[^:]{1,30}:/, '').trim()

/** The till day ('YYYY-MM-DD') a receipt was CLOSED on, or null when it was never closed. */
export function posReceiptDay(r: PosReceipt): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?::|$)/.exec(String(r.header?.closedOn ?? ''))
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/**
 * Aggregates one day's POS receipts into one row per article, net value after discounts. `day`
 * ('YYYY-MM-DD'), when given, must be the close day of every receipt: a batch that mixes days is the
 * caller's mistake and is refused.
 */
export function aggregatePosDay(receipts: PosReceipt[], day?: string): TillAggregate {
  const byName = new Map<string, { qty: number; value: number }>()
  const vatRates = new Set<string>()
  let totalValueGross = 0

  for (const r of receipts) {
    const h = r.header ?? {}
    const id = String(h.docNumber ?? r.num ?? '?')
    const doc = String(h.doc ?? '')
    if (doc === 'ПЛ') continue
    if (doc !== 'КБ') throw new Error(`unexpected document in a POS batch: header.doc="${doc}" (receipt ${id}); only КБ (cash receipt) and ПЛ (invoice payment) are known`)

    const status = String(h.status ?? '')
    if (status !== 'complete' && status !== 'return') throw new Error(`unexpected receipt status "${status}" (receipt ${id}); only complete and return are known`)

    const closed = posReceiptDay(r)
    if (!closed) throw new Error(`receipt ${id} has no closedOn: not a finished sale`)
    if (day && closed !== day) throw new Error(`receipt ${id} was closed on ${closed}, not ${day}: wrong batch`)
    vatRates.add(String(h.vatPercent ?? ''))

    const discountType = String(h.discountType ?? '')
    const discountPct = num(h.discount)
    if (discountType !== '' && discountType !== '1') throw new Error(`unknown discount type "${discountType}" (receipt ${id}); only 1 (percent) is known`)
    if (discountType === '' && discountPct !== 0) throw new Error(`receipt ${id} has a discount of ${discountPct} but no discountType`)
    const factor = discountType === '1' ? 1 - discountPct / 100 : 1

    let listGross = 0
    for (const l of r.lines ?? []) {
      const name = String(l.name ?? '').trim() || stripGroup(l.item)
      if (!name) continue
      listGross += num(l.sumWithVat)
      const row = byName.get(name) ?? { qty: 0, value: 0 }
      row.qty += num(l.quantity)
      row.value += num(l.sum) * factor // absent → 0 (a giveaway), never guessed from price × quantity
      byName.set(name, row)
    }

    const paid = num(h.sum)
    const expected = Math.abs(listGross) - Math.abs(num(h.totalDiscountSum))
    if (Math.abs(expected - paid) > GROSS_TOLERANCE) {
      throw new Error(`receipt ${id} does not add up: header.sum ${paid} vs Σ lines.sumWithVat − totalDiscountSum = ${round2(expected)}; a line is missing or the receipt changed`)
    }
    totalValueGross += (status === 'return' ? -1 : 1) * paid
  }

  if (vatRates.size > 1) throw new Error(`mixed VAT rates in one day's POS batch: ${[...vatRates].join(', ')}`)
  if (vatRates.size === 1 && !vatRates.has(SUPPORTED_VAT)) throw new Error(`VAT rate ${[...vatRates][0]}% in a POS batch; the importer books every till line at ${SUPPORTED_VAT}%`)

  const rows: TillRow[] = []
  for (const [name, r] of byName) {
    const qty = round3(r.qty)
    const value = round2(r.value)
    if (qty === 0 && value === 0) continue
    rows.push({ name, qty, value })
  }
  return {
    rows,
    totalQty: round3(rows.reduce((s, r) => s + r.qty, 0)),
    totalValueNet: round2(rows.reduce((s, r) => s + r.value, 0)),
    totalValueGross: round2(totalValueGross),
  }
}
