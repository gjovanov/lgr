/**
 * A day's regal-sf till sales, pulled per-TRANSACTION via PlusMinus's own `/mobile` API
 * (`storeOperations_*.json`, `header.doc === "СР"`) → the same `{name, qty, value}` day-aggregate
 * shape `scripts/import-cash-register-sales.ts` already builds from the `salesAnalysis_*.xlsx`
 * export (АРТИКУЛИ report). One LGR cash-sale document is still one DAY, same as the xlsx path —
 * this only replaces where the day's `Row[]` comes from, so the existing matching/line-building/
 * POST logic downstream needs no change.
 *
 * Confirmed against the 77 records pulled for regal-sf 2026-10-26/27 (`pull-api-sf-test`):
 *   - `line.sum` is NET (pre-VAT); `line.sumWithVat` is gross. `header.vatPercent` was `"20"` on
 *     all 77 — a different rate is refused rather than silently averaged in.
 *   - `header.doc` is `"СР"` (Продажби) on every till-sale record — `aggregateTillDay` refuses a
 *     document that isn't, mirroring the xlsx path's "Операция: Продажби" filter.
 *   - One line in 200 carried no `sum`/`price`/`sumWithVat` at all (`storeOperations_21472.json`,
 *     num `00000099`, "ВИНТ - САВОПР. - 4.2Х45 - DIN 7504 N", qty 20) — the transaction's own
 *     `header.sum` was fully accounted for by its OTHER line, so this one sold at net value 0 (a
 *     giveaway, not a data error). Treated as value 0 rather than thrown out, so the 20 units
 *     still count toward quantity/stock.
 *
 * Cross-check: there is no single "Общо" row to compare against the way the xlsx export has one,
 * so the invariant is checked the other way round — the sum of every transaction's own
 * `header.sum` (gross) against the aggregated net rows grossed up at the day's one VAT rate.
 * Measured drift on the real 10-26/10-27 batches was 0.0253 / -0.0103 on totals of ~1000/~490 —
 * ordinary per-transaction rounding, not a structural problem — so the tolerance below is set
 * generously above that rather than at it.
 */
import type { PlusMinusDocument } from './map-plusminus-invoice.js'

export interface TillRow {
  name: string
  qty: number
  value: number
}

export interface TillAggregate {
  rows: TillRow[]
  totalQty: number
  totalValueNet: number
  totalValueGross: number
}

const num = (v: unknown): number => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}
const round2 = (v: number) => Math.round(v * 100) / 100

/** Absolute EUR tolerance for the gross-vs-net cross-check — see header comment for the measured drift this is set above. */
const CROSS_CHECK_TOLERANCE = 0.5

/**
 * Aggregates one day's till-sale transactions into one row per product, net value — matching the
 * `salesAnalysis` xlsx's АРТИКУЛИ report shape exactly. Throws on a non-uniform VAT rate, a
 * document that isn't a Продажби (СР) sale, or a gross/net mismatch beyond ordinary rounding —
 * those indicate the caller fed it the wrong batch rather than something this function should
 * guess its way past.
 */
export function aggregateTillDay(docs: PlusMinusDocument[]): TillAggregate {
  if (!docs.length) return { rows: [], totalQty: 0, totalValueNet: 0, totalValueGross: 0 }

  const nonSale = docs.find(d => d.header?.doc && d.header.doc !== 'СР')
  if (nonSale) throw new Error(`non-sale document in till batch: header.doc="${nonSale.header.doc}" (num ${nonSale.num})`)

  const vatRates = new Set(docs.map(d => String(d.header?.vatPercent ?? d.header?.vatRate ?? '')))
  if (vatRates.size > 1) throw new Error(`mixed VAT rates in one day's till batch: ${[...vatRates].join(', ')}`)
  const vatRate = num([...vatRates][0]) || 20

  const byName = new Map<string, TillRow>()
  let totalValueGross = 0
  for (const doc of docs) {
    totalValueGross += num(doc.header?.sum)
    for (const l of doc.lines || []) {
      const name = String(l.name || l.item || '').trim()
      if (!name) continue
      const row = byName.get(name) ?? { name, qty: 0, value: 0 }
      row.qty += num(l.quantity)
      row.value += num(l.sum) // absent → 0 (a zero-price line), never guessed from price×qty
      byName.set(name, row)
    }
  }

  const rows = [...byName.values()].map(r => ({ name: r.name, qty: round2(r.qty), value: round2(r.value) }))
  const totalQty = round2(rows.reduce((s, r) => s + r.qty, 0))
  const totalValueNet = round2(rows.reduce((s, r) => s + r.value, 0))
  totalValueGross = round2(totalValueGross)

  const impliedGross = round2(totalValueNet * (1 + vatRate / 100))
  const drift = Math.abs(totalValueGross - impliedGross)
  if (drift > CROSS_CHECK_TOLERANCE) {
    throw new Error(
      `Cross-check FAILED: header.sum total ${totalValueGross} vs net rows ×${1 + vatRate / 100} = ${impliedGross} `
      + `(drift ${round2(drift)} > ${CROSS_CHECK_TOLERANCE}) — missing or extra documents in this batch? Aborting.`,
    )
  }

  return { rows, totalQty, totalValueNet, totalValueGross }
}
