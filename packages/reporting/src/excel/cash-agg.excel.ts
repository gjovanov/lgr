import {
  createWorkbook, finalizeWorkbook, styleHeaderBand, styleDataCells,
  NUM_FMT, alignFor, numOrBlank, type CellType,
} from './base.excel.js'
import { exportI18n, type ExportLocale } from '../i18n.js'

/**
 * FR-03 (#10): aggregated cash-register export — one row per PRODUCT across the period,
 * document headers deliberately absent. Sections are per-currency: summing across
 * currencies would be a wrong number, so each currency gets its own block + totals.
 */

export interface CashAggRow {
  productName: string
  sku?: string
  unit?: string
  totalQuantity: number
  avgUnitPrice: number
  netTotal: number
  taxTotal: number
  grossTotal: number
}

export interface CashAggSection {
  currency: string
  rows: CashAggRow[]
}

export interface CashAggOptions {
  title: string
  sections: CashAggSection[]
  /** Allow-listed column keys (UI catalog CASH_AGG_COLUMNS). Omit = all. */
  columns?: string[]
  locale?: ExportLocale | string
}

interface AggColumnDef {
  headerKey: keyof ReturnType<typeof exportI18n>['header']
  key: string
  width: number
  type?: CellType
  value: (r: CashAggRow) => any
}

// Keyed by the UI catalog's export keys (CASH_AGG_COLUMNS in useExportColumns.ts).
export const CASH_AGG_COLUMN_DEFS: Record<string, AggColumnDef> = {
  productName:  { headerKey: 'product',   key: 'productName',  width: 46, value: r => r.productName },
  sku:          { headerKey: 'sku',       key: 'sku',          width: 18, value: r => r.sku || '' },
  unit:         { headerKey: 'unit',      key: 'unit',         width: 9,  value: r => r.unit || '' },
  totalQuantity:{ headerKey: 'quantity',  key: 'totalQuantity',width: 12, type: 'quantity', value: r => numOrBlank(r.totalQuantity) },
  avgUnitPrice: { headerKey: 'unitPrice', key: 'avgUnitPrice', width: 13, type: 'money',    value: r => numOrBlank(r.avgUnitPrice) },
  netTotal:     { headerKey: 'subtotal',  key: 'netTotal',     width: 14, type: 'money',    value: r => numOrBlank(r.netTotal) },
  taxTotal:     { headerKey: 'taxTotal',  key: 'taxTotal',     width: 13, type: 'money',    value: r => numOrBlank(r.taxTotal) },
  grossTotal:   { headerKey: 'total',     key: 'grossTotal',   width: 15, type: 'money',    value: r => numOrBlank(r.grossTotal) },
}

export const CASH_AGG_KEYS = Object.keys(CASH_AGG_COLUMN_DEFS)
const SUM_KEYS = ['totalQuantity', 'netTotal', 'taxTotal', 'grossTotal'] as const

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export function pickAggColumns(requested?: string[]): AggColumnDef[] {
  const keys = requested?.length ? requested.filter(k => CASH_AGG_COLUMN_DEFS[k]) : CASH_AGG_KEYS
  return keys.map(k => CASH_AGG_COLUMN_DEFS[k])
}

export function sectionTotals(rows: CashAggRow[]): Record<(typeof SUM_KEYS)[number], number> {
  const t = { totalQuantity: 0, netTotal: 0, taxTotal: 0, grossTotal: 0 }
  for (const r of rows) for (const k of SUM_KEYS) t[k] += Number(r[k]) || 0
  for (const k of SUM_KEYS) t[k] = round2(t[k])
  return t
}

export async function generateCashAggXLSX(opts: CashAggOptions): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const i18n = exportI18n(opts.locale)
  const defs = pickAggColumns(opts.columns)

  const worksheet = workbook.addWorksheet(opts.title.substring(0, 30), {
    views: [{ state: 'frozen', ySplit: 1 }],
  })

  worksheet.columns = defs.map(d => ({
    header: i18n.header[d.headerKey],
    key: d.key,
    width: d.width,
    style: {
      numFmt: NUM_FMT[d.type ?? 'text'],
      alignment: { horizontal: alignFor(d.type), vertical: 'middle' as const },
    },
  })) as any

  const headerRow = worksheet.getRow(1)
  styleHeaderBand(headerRow, defs.length)
  headerRow.commit()

  const multiCurrency = opts.sections.length > 1
  let dataRows = 0

  for (const section of opts.sections) {
    if (multiCurrency) {
      const r = worksheet.addRow({ [defs[0].key]: section.currency })
      r.getCell(1).font = { bold: true }
      r.commit()
    }
    for (const row of section.rows) {
      const cells: Record<string, any> = {}
      for (const d of defs) cells[d.key] = d.value(row)
      const r = worksheet.addRow(cells)
      dataRows++
      styleDataCells(r, defs.map(d => d.type), dataRows % 2 === 0)
      r.commit()
    }

    // Per-section totals line (the only currency-safe aggregate).
    const totals = sectionTotals(section.rows)
    const sumSet = new Set<string>(SUM_KEYS)
    const labelDef = defs.find(d => !sumSet.has(d.key)) ?? defs[0]
    const values: Record<string, any> = {}
    values[labelDef.key] = multiCurrency ? `${i18n.footer.totalLabel} ${section.currency}` : i18n.footer.totalLabel
    for (const d of defs) if (sumSet.has(d.key)) values[d.key] = totals[d.key as (typeof SUM_KEYS)[number]]
    const r = worksheet.addRow(values)
    for (let c = 1; c <= defs.length; c++) {
      r.getCell(c).font = { bold: true }
      r.getCell(c).border = { top: { style: 'thin', color: { argb: 'FF808080' } } }
    }
    r.getCell(defs.indexOf(labelDef) + 1).alignment = { horizontal: 'left', vertical: 'middle' }
    r.commit()
  }

  worksheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}
