import {
  createWorkbook, finalizeWorkbook, styleHeaderBand, styleDataCells,
  NUM_FMT, alignFor, numOrBlank, toExcelDate, type CellType,
} from './base.excel.js'
import { exportI18n, statusLabel, paymentMethodLabel, type ExportLocale } from '../i18n.js'

export type ExportMode = 'compact' | 'detailed'

export type PaymentMethod = 'cash' | 'bank_transfer' | 'card' | 'check' | 'other'

export interface InvoiceExportRow {
  invoiceNumber: string
  type?: string
  direction?: string
  status: string
  issueDate: Date | string
  dueDate: Date | string
  contactName?: string
  contactTaxId?: string
  currency: string
  subtotal?: number
  taxTotal?: number
  total: number
  amountPaid?: number
  amountDue?: number
  reference?: string
  notes?: string
  /** Sum of applied payments grouped by method. Keys absent when no payment of that method. */
  paymentsByMethod?: Partial<Record<PaymentMethod, number>>
  /** Canonical method(s) used by this document, comma-joined when a document mixes methods. */
  paymentMethod?: string
  lines?: Array<{
    description: string
    quantity: number
    unit?: string
    unitPrice: number
    discount?: number
    taxRate?: number
    lineTotal: number
  }>
}

interface ListOptions {
  title: string
  mode: ExportMode
  rows: InvoiceExportRow[]
  /** Allow-listed column keys to include. Omit = include all default columns for the mode. */
  columns?: string[]
  /** Locale for headers, status, and footer labels. Defaults to 'en'. */
  locale?: ExportLocale | string
}

/**
 * Catalog of every renderable column, keyed by the stable export key used by the UI
 * catalog in `ui-shared/composables/useExportColumns.ts`. Fields:
 *  - header: human-readable column title
 *  - key: ExcelJS column key (also serves as row-object key)
 *  - width: preferred width
 *  - modes: in which export mode(s) this column is selectable
 *  - value(row | line, row): value for the cell
 *
 * Keep both this catalog and `useExportColumns.ts` in sync with the controller's
 * ALLOWED_COLUMN_KEYS set.
 */
type RowCellCtx = { row: InvoiceExportRow; line?: InvoiceExportRow['lines'] extends Array<infer L> ? L : any; lineNo?: number; locale?: string }

interface ColumnDef {
  /** Header lookup key into ExportI18n.header */
  headerKey: keyof ReturnType<typeof exportI18n>['header']
  key: string
  width: number
  modes: ExportMode[]
  type?: CellType
  value: (ctx: RowCellCtx) => any
}

const COLUMN_DEFS: Record<string, ColumnDef> = {
  number:       { headerKey: 'number',       key: 'invoiceNumber', width: 20, modes: ['compact','detailed'], value: ({ row }) => row.invoiceNumber },
  issueDate:    { headerKey: 'issueDate',    key: 'issueDate',     width: 13, modes: ['compact','detailed'], type: 'date',     value: ({ row }) => toExcelDate(row.issueDate) },
  dueDate:      { headerKey: 'dueDate',      key: 'dueDate',       width: 13, modes: ['compact'],            type: 'date',     value: ({ row }) => toExcelDate(row.dueDate) },
  contactName:  { headerKey: 'contactName',  key: 'contactName',   width: 34, modes: ['compact','detailed'], value: ({ row }) => row.contactName || '' },
  contactTaxId: { headerKey: 'contactTaxId', key: 'contactTaxId',  width: 16, modes: ['compact'],            value: ({ row }) => row.contactTaxId || '' },
  status:       { headerKey: 'status',       key: 'status',        width: 16, modes: ['compact','detailed'], value: ({ row, locale }) => statusLabel(row.status, locale) },
  currency:     { headerKey: 'currency',     key: 'currency',      width: 9,  modes: ['compact','detailed'], value: ({ row }) => row.currency },
  subtotal:     { headerKey: 'subtotal',     key: 'subtotal',      width: 14, modes: ['compact'],            type: 'money',    value: ({ row }) => numOrBlank(row.subtotal) },
  taxTotal:     { headerKey: 'taxTotal',     key: 'taxTotal',      width: 13, modes: ['compact'],            type: 'money',    value: ({ row }) => numOrBlank(row.taxTotal) },
  total:        { headerKey: 'total',        key: 'total',         width: 15, modes: ['compact','detailed'], type: 'money',    value: ({ row }) => numOrBlank(row.total) },
  amountPaid:   { headerKey: 'amountPaid',   key: 'amountPaid',    width: 14, modes: ['compact'],            type: 'money',    value: ({ row }) => numOrBlank(row.amountPaid) },
  amountDue:    { headerKey: 'amountDue',    key: 'amountDue',     width: 14, modes: ['compact'],            type: 'money',    value: ({ row }) => numOrBlank(row.amountDue) },
  reference:    { headerKey: 'reference',    key: 'reference',     width: 20, modes: ['compact'],            value: ({ row }) => row.reference || '' },
  paymentMethod:{ headerKey: 'paymentMethod',key: 'paymentMethod', width: 18, modes: ['compact'],            value: ({ row, locale }) => paymentMethodLabel(row.paymentMethod, locale) },
  // Line-level (detailed only)
  lineNo:       { headerKey: 'lineNo',       key: 'lineNo',        width: 7,  modes: ['detailed'],           type: 'int',      value: ({ lineNo }) => lineNo ?? 0 },
  description:  { headerKey: 'description',  key: 'description',   width: 42, modes: ['detailed'],           value: ({ line }) => line?.description ?? '' },
  quantity:     { headerKey: 'quantity',     key: 'quantity',      width: 10, modes: ['detailed'],           type: 'quantity', value: ({ line }) => numOrBlank(line?.quantity) },
  unit:         { headerKey: 'unit',         key: 'unit',          width: 9,  modes: ['detailed'],           value: ({ line }) => line?.unit || '' },
  unitPrice:    { headerKey: 'unitPrice',    key: 'unitPrice',     width: 13, modes: ['detailed'],           type: 'money',    value: ({ line }) => numOrBlank(line?.unitPrice) },
  discount:     { headerKey: 'discount',     key: 'discount',      width: 11, modes: ['detailed'],           type: 'percent',  value: ({ line }) => numOrBlank(line?.discount) },
  taxRate:      { headerKey: 'taxRate',      key: 'taxRate',       width: 10, modes: ['detailed'],           type: 'percent',  value: ({ line }) => numOrBlank(line?.taxRate) },
  lineTotal:    { headerKey: 'lineTotal',    key: 'lineTotal',     width: 14, modes: ['detailed'],           type: 'money',    value: ({ line }) => numOrBlank(line?.lineTotal) },
}

/** Default column selection per mode when the caller does not specify `columns`. */
const DEFAULT_COLUMNS: Record<ExportMode, string[]> = {
  compact: ['number','issueDate','dueDate','contactName','contactTaxId','status','currency','subtotal','taxTotal','total','amountPaid','amountDue','reference','paymentMethod'],
  detailed: ['number','issueDate','contactName','status','currency','lineNo','description','quantity','unit','unitPrice','discount','taxRate','lineTotal','total'],
}

function pickColumns(mode: ExportMode, requested?: string[]): string[] {
  const all = requested?.length ? requested : DEFAULT_COLUMNS[mode]
  // Keep only columns that are defined AND applicable to this mode.
  return all.filter(k => COLUMN_DEFS[k] && COLUMN_DEFS[k].modes.includes(mode))
}

/**
 * Export a list of invoicing documents (invoices / proformas / credit notes / etc.) to XLSX.
 *
 * compact  — one row per document, summary columns only.
 * detailed — one row per line item per document (flat join).
 */

/**
 * The money columns that carry a column sum on the totals line — net amount, VAT, document
 * total and the settlement pair — as on the legacy journal report.
 */
export const MONEY_COLUMN_KEYS = ['subtotal', 'taxTotal', 'total', 'amountPaid', 'amountDue'] as const
export type MoneyColumnKey = typeof MONEY_COLUMN_KEYS[number]

/** Settle an accumulated amount back onto the cent it represents. */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100
}

/**
 * Compute aggregate totals over `rows`:
 *  - a sum per money column (subtotal / taxTotal / total / amountPaid / amountDue)
 *  - grand Total (or null if mixed currencies → avoids silent wrong sums)
 *  - per-payment-method sums (cash/bank/card/check/other)
 */
export function computeAggregates(rows: InvoiceExportRow[]): {
  total: number | null
  columns: Record<MoneyColumnKey, number>
  currency: string | null
  byMethod: Partial<Record<PaymentMethod, number>>
  mixedCurrency: boolean
} {
  const columns = Object.fromEntries(MONEY_COLUMN_KEYS.map(k => [k, 0])) as Record<MoneyColumnKey, number>
  if (rows.length === 0) return { total: 0, columns, currency: null, byMethod: {}, mixedCurrency: false }

  const currencies = new Set(rows.map(r => r.currency))
  const mixed = currencies.size > 1
  const currency = mixed ? null : [...currencies][0]

  const byMethod: Partial<Record<PaymentMethod, number>> = {}
  for (const r of rows) {
    for (const k of MONEY_COLUMN_KEYS) columns[k] += Number(r[k]) || 0
    const pm = r.paymentsByMethod || {}
    for (const m of Object.keys(pm) as PaymentMethod[]) {
      byMethod[m] = (byMethod[m] || 0) + (pm[m] || 0)
    }
  }
  // Accumulating cents in binary leaves noise (837.4200000000001) that would be written into
  // the workbook cell itself, so each sum is settled back onto the cent it represents.
  for (const k of MONEY_COLUMN_KEYS) columns[k] = round2(columns[k])
  for (const m of Object.keys(byMethod) as PaymentMethod[]) byMethod[m] = round2(byMethod[m] as number)

  return { total: mixed ? null : columns.total, columns, currency, byMethod, mixedCurrency: mixed }
}

/** A1-style column letter, for the auto-filter range. */
function colLetter(index: number): string {
  let n = index + 1
  let out = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    out = String.fromCharCode(65 + rem) + out
    n = Math.floor((n - 1) / 26)
  }
  return out
}

export async function generateInvoicingListXLSX(opts: ListOptions): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()

  const i18n = exportI18n(opts.locale)
  const selected = pickColumns(opts.mode, opts.columns)
  const defs = selected.map(k => COLUMN_DEFS[k])

  // Header stays on row 1 (no title banner) so the sheet can be filtered and re-imported.
  const worksheet = workbook.addWorksheet(opts.title.substring(0, 30), {
    views: [{ state: 'frozen', ySplit: 1 }],
    autoFilter: `A1:${colLetter(defs.length - 1)}1`,
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

  let dataRows = 0

  if (opts.mode === 'compact') {
    for (const row of opts.rows) {
      const cells: Record<string, any> = {}
      for (const d of defs) cells[d.key] = d.value({ row, locale: opts.locale })
      const r = worksheet.addRow(cells)
      dataRows++
      styleDataCells(r, defs.map(d => d.type), dataRows % 2 === 0)
      r.commit()
    }

    // Aggregate block — compact mode only. Skipped if no money column is rendered
    // or there are no rows.
    const moneyDefs = defs.filter(d => (MONEY_COLUMN_KEYS as readonly string[]).includes(d.key))
    if (opts.rows.length > 0 && moneyDefs.length) {
      const agg = computeAggregates(opts.rows)
      // The label goes in the first non-money column — usually the widest, its neighbours are
      // empty so a long label can spill, and it never sits under an amount header.
      const labelDef = defs.find(d => !moneyDefs.includes(d)) ?? defs[0]
      const labelCol = defs.indexOf(labelDef) + 1
      const totalCol = defs.findIndex(d => d.key === 'total') + 1

      worksheet.addRow({}).commit()

      /** The per-method rows pair a left label with one amount under the Total column. */
      const addMethodRow = (label: string, amount: number | string) => {
        const values: Record<string, any> = {}
        values[labelDef.key] = label
        if (totalCol) values.total = amount
        const r = worksheet.addRow(values)
        r.getCell(labelCol).alignment = { horizontal: 'left', vertical: 'middle' }
        if (totalCol) {
          const amountCell = r.getCell(totalCol)
          amountCell.numFmt = typeof amount === 'number' ? NUM_FMT.money : undefined
          amountCell.alignment = { horizontal: typeof amount === 'number' ? 'right' : 'left', vertical: 'middle' }
        }
        r.commit()
      }

      /** The closing line: every rendered money column carries its own column sum. */
      const addGrandRow = () => {
        const values: Record<string, any> = {}
        values[labelDef.key] = i18n.footer.totalLabel
        for (const d of moneyDefs) values[d.key] = agg.columns[d.key as MoneyColumnKey]
        const r = worksheet.addRow(values)
        r.getCell(labelCol).font = { bold: true }
        r.getCell(labelCol).alignment = { horizontal: 'left', vertical: 'middle' }
        for (const d of moneyDefs) {
          const cell = r.getCell(defs.indexOf(d) + 1)
          cell.font = { bold: true }
          cell.numFmt = NUM_FMT.money
          cell.alignment = { horizontal: 'right', vertical: 'middle' }
        }
        // Rule above the grand total, drawn across the table so it reads as a summary line.
        for (let c = 1; c <= defs.length; c++) {
          r.getCell(c).border = { top: { style: 'thin', color: { argb: 'FF808080' } } }
        }
        r.commit()
      }

      if (agg.mixedCurrency) {
        // Summing across currencies would be a wrong number, so the line says so instead.
        const values: Record<string, any> = {}
        values[labelDef.key] = i18n.footer.totalsLabel
        if (totalCol) values.total = i18n.footer.mixedCurrency
        const r = worksheet.addRow(values)
        r.getCell(labelCol).font = { bold: true }
        for (let c = 1; c <= defs.length; c++) {
          r.getCell(c).border = { top: { style: 'thin', color: { argb: 'FF808080' } } }
        }
        r.commit()
      } else {
        for (const method of Object.keys(i18n.paymentMethod) as PaymentMethod[]) {
          const sum = agg.byMethod[method] || 0
          if (sum <= 0) continue
          addMethodRow(i18n.footer.totalByMethod(i18n.paymentMethod[method]), sum)
        }
        addGrandRow()
      }
    }
  } else {
    // Shade by document, not by line, so a document's lines read as one block.
    opts.rows.forEach((row, docIndex) => {
      const lines = row.lines && row.lines.length ? row.lines : [{
        description: i18n.footer.noLines, quantity: 0, unitPrice: 0, lineTotal: row.total,
      } as any]
      lines.forEach((line, i) => {
        const cells: Record<string, any> = {}
        for (const d of defs) cells[d.key] = d.value({ row, line, lineNo: i + 1, locale: opts.locale })
        const r = worksheet.addRow(cells)
        styleDataCells(r, defs.map(d => d.type), docIndex % 2 === 1)
        r.commit()
      })
    })
  }

  worksheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}
