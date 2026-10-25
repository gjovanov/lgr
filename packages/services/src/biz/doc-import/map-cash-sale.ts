/**
 * A day's cash-register takings → ONE cash-sale document.
 *
 * The source is an aggregate export: there is no per-receipt document and no counterparty. Its
 * `Стойност` column is NET; 20% VAT goes on top. Because the export carries no document number of
 * its own, the idempotency key is synthesised as `salesAnalysis:<date>` and stored in `reference` —
 * one CSR per day, re-runs are a no-op.
 *
 * TWO exports carry that same day, and this mapper serves both: the `salesAnalysis` XLSX
 * (АРТИКУЛИ report — Артикул/Количество/Стойност) and a „Складови операции" export filtered to
 * „Операция: Продажби" (Име/Мярка/Количество/Цена/Стойност). Only the name, quantity and net value
 * are needed from either, so the parameter asks for exactly that rather than one whole result
 * shape — two mappers for one business document would drift.
 *
 * ⚠ The reference stays `salesAnalysis:<date>` whichever export produced it. It names the DAY, not
 * the file, and that is the point: the same takings arriving in the other format must collide with
 * what is already booked. Re-keying it per format would orphan the duplicate guard on every cash
 * sale already in the ledger.
 *
 * Ported from `scripts/import-cash-register-sales.ts`.
 */
import { normalizeUomBg } from '../uom.utils.js'
import { matchProductsExact } from './matching.js'
import { round2, round4, type SalesAnalysisRow } from './xlsx.js'
import type { LineDiagnostic, MappedInvoice, MappedInvoiceLine } from './types.js'

/** The legacy books keep cash-register takings in EUR at the fixed BGN peg. */
export const EXCHANGE_RATE_BGN = 1.95583
const VAT_RATE = 20

export interface MapCashSaleOptions {
  /** Business day the export covers — also the idempotency key. */
  date: string
  /** Warehouse matched lines dispatch from. */
  warehouseId?: string
  preparedBy?: string
  placeOfTransaction?: string
}

export interface MapCashSaleResult {
  mapped: MappedInvoice
  perLine: LineDiagnostic[]
  warnings: string[]
}

/** `salesAnalysis:<date>` — what makes re-importing a day a no-op. */
export function cashSaleReference(date: string): string {
  return `salesAnalysis:${date}`
}

export async function mapCashSaleExport(
  orgId: string,
  parsed: { rows: SalesAnalysisRow[] },
  opts: MapCashSaleOptions,
): Promise<MapCashSaleResult> {
  const warnings: string[] = []
  const rows = parsed.rows

  const matches = await matchProductsExact(orgId, rows.map(r => r.name))

  const lines: MappedInvoiceLine[] = []
  const perLine: LineDiagnostic[] = []
  rows.forEach((r, i) => {
    const m = matches[i]
    // The export gives a net line VALUE, not a unit price — derive the price so
    // qty × unitPrice reproduces it.
    const unitPrice = r.qty !== 0 ? round4(r.value / r.qty) : r.value
    const taxAmount = round2((r.value * VAT_RATE) / 100)
    lines.push({
      productId: m?.productId,
      description: r.name,
      quantity: r.qty,
      unit: normalizeUomBg(m?.unit),
      unitPrice,
      discount: 0,
      taxRate: VAT_RATE,
      taxAmount,
      // GROSS, as on every document the UI creates (FR-21.5): the FR-03 aggregated export and the
      // product ledger read `lineTotal − taxAmount` as the net. It was the net here until FR-21,
      // so an imported day exported its net as "gross".
      lineTotal: round2(r.value + taxAmount),
      // Only matched lines can move stock; free-text lines still count toward the totals.
      warehouseId: m ? opts.warehouseId : undefined,
      sourceText: r.name,
    })
    perLine.push({ sourceText: r.name, matched: !!m, productId: m?.productId, matchedBy: m?.matchedBy ?? null })
  })

  const unmatched = perLine.filter(p => !p.matched).length
  if (unmatched) {
    warnings.push(`${unmatched} of ${rows.length} item(s) have no catalog match — they import as free-text and will not move stock`)
  }

  // The net, from the export's values: the lines carry gross.
  const subtotal = round2(rows.reduce((s, r) => s + r.value, 0))
  const taxTotal = round2((subtotal * VAT_RATE) / 100)
  const total = round2(subtotal + taxTotal)

  const mapped: MappedInvoice = {
    type: 'cash_sale',
    direction: 'outgoing',
    // A cash sale has no counterparty.
    contactId: undefined,
    reference: cashSaleReference(opts.date),
    issueDate: opts.date,
    dueDate: opts.date,
    currency: 'EUR',
    exchangeRate: EXCHANGE_RATE_BGN,
    paymentMethod: 'cash',
    notes: `Дневни продажби каса — ${opts.date}`,
    preparedBy: opts.preparedBy,
    placeOfTransaction: opts.placeOfTransaction,
    lines,
    subtotal,
    taxTotal,
    total,
    tags: ['cash-register-import'],
  }

  return { mapped, perLine, warnings }
}
