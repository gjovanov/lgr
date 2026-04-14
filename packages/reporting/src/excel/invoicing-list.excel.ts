import { createWorkbook, finalizeWorkbook, styleHeaderRow, formatCurrency, formatDate } from './base.excel.js'

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
type RowCellCtx = { row: InvoiceExportRow; line?: InvoiceExportRow['lines'] extends Array<infer L> ? L : any; lineNo?: number }
interface ColumnDef {
  header: string
  key: string
  width: number
  modes: ExportMode[]
  value: (ctx: RowCellCtx) => any
}

const COLUMN_DEFS: Record<string, ColumnDef> = {
  number:       { header: 'Number',      key: 'invoiceNumber', width: 20, modes: ['compact','detailed'], value: ({ row }) => row.invoiceNumber },
  issueDate:    { header: 'Issue Date',  key: 'issueDate',     width: 14, modes: ['compact','detailed'], value: ({ row }) => formatDate(new Date(row.issueDate)) },
  dueDate:      { header: 'Due Date',    key: 'dueDate',       width: 14, modes: ['compact'],            value: ({ row }) => formatDate(new Date(row.dueDate)) },
  contactName:  { header: 'Contact',     key: 'contactName',   width: 32, modes: ['compact','detailed'], value: ({ row }) => row.contactName || '' },
  contactTaxId: { header: 'Tax ID',      key: 'contactTaxId',  width: 16, modes: ['compact'],            value: ({ row }) => row.contactTaxId || '' },
  status:       { header: 'Status',      key: 'status',        width: 14, modes: ['compact','detailed'], value: ({ row }) => row.status },
  currency:     { header: 'Currency',    key: 'currency',      width: 10, modes: ['compact','detailed'], value: ({ row }) => row.currency },
  subtotal:     { header: 'Subtotal',    key: 'subtotal',      width: 14, modes: ['compact'],            value: ({ row }) => row.subtotal != null ? formatCurrency(row.subtotal) : '' },
  taxTotal:     { header: 'Tax',         key: 'taxTotal',      width: 14, modes: ['compact'],            value: ({ row }) => row.taxTotal != null ? formatCurrency(row.taxTotal) : '' },
  total:        { header: 'Total',       key: 'total',         width: 16, modes: ['compact','detailed'], value: ({ row }) => formatCurrency(row.total) },
  amountPaid:   { header: 'Paid',        key: 'amountPaid',    width: 14, modes: ['compact'],            value: ({ row }) => row.amountPaid != null ? formatCurrency(row.amountPaid) : '' },
  amountDue:    { header: 'Due',         key: 'amountDue',     width: 14, modes: ['compact'],            value: ({ row }) => row.amountDue != null ? formatCurrency(row.amountDue) : '' },
  reference:    { header: 'Reference',   key: 'reference',     width: 20, modes: ['compact'],            value: ({ row }) => row.reference || '' },
  // Line-level (detailed only)
  lineNo:       { header: 'Line #',      key: 'lineNo',        width: 8,  modes: ['detailed'],           value: ({ lineNo }) => lineNo ?? 0 },
  description:  { header: 'Description', key: 'description',   width: 40, modes: ['detailed'],           value: ({ line }) => line?.description ?? '' },
  quantity:     { header: 'Qty',         key: 'quantity',      width: 10, modes: ['detailed'],           value: ({ line }) => line?.quantity ?? 0 },
  unit:         { header: 'Unit',        key: 'unit',          width: 8,  modes: ['detailed'],           value: ({ line }) => line?.unit || '' },
  unitPrice:    { header: 'Unit Price',  key: 'unitPrice',     width: 14, modes: ['detailed'],           value: ({ line }) => formatCurrency(line?.unitPrice || 0) },
  discount:     { header: 'Discount %',  key: 'discount',      width: 12, modes: ['detailed'],           value: ({ line }) => (line?.discount != null ? line.discount : '') },
  taxRate:      { header: 'Tax %',       key: 'taxRate',       width: 10, modes: ['detailed'],           value: ({ line }) => (line?.taxRate != null ? line.taxRate : '') },
  lineTotal:    { header: 'Line Total',  key: 'lineTotal',     width: 14, modes: ['detailed'],           value: ({ line }) => formatCurrency(line?.lineTotal || 0) },
}

/** Default column selection per mode when the caller does not specify `columns`. */
const DEFAULT_COLUMNS: Record<ExportMode, string[]> = {
  compact: ['number','issueDate','dueDate','contactName','contactTaxId','status','currency','subtotal','taxTotal','total','amountPaid','amountDue','reference'],
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
const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'Cash',
  bank_transfer: 'Bank',
  card: 'Card',
  check: 'Check',
  other: 'Other',
}

/**
 * Compute aggregate totals over `rows`:
 *  - grand Total (or null if mixed currencies → avoids silent wrong sums)
 *  - per-payment-method sums (cash/bank/card/check/other)
 */
export function computeAggregates(rows: InvoiceExportRow[]): {
  total: number | null
  currency: string | null
  byMethod: Partial<Record<PaymentMethod, number>>
  mixedCurrency: boolean
} {
  if (rows.length === 0) return { total: 0, currency: null, byMethod: {}, mixedCurrency: false }

  const currencies = new Set(rows.map(r => r.currency))
  const mixed = currencies.size > 1
  const currency = mixed ? null : [...currencies][0]

  let total = 0
  const byMethod: Partial<Record<PaymentMethod, number>> = {}
  for (const r of rows) {
    total += Number(r.total) || 0
    const pm = r.paymentsByMethod || {}
    for (const m of Object.keys(pm) as PaymentMethod[]) {
      byMethod[m] = (byMethod[m] || 0) + (pm[m] || 0)
    }
  }
  return { total: mixed ? null : total, currency, byMethod, mixedCurrency: mixed }
}

export async function generateInvoicingListXLSX(opts: ListOptions): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const worksheet = workbook.addWorksheet(opts.title.substring(0, 30))

  const selected = pickColumns(opts.mode, opts.columns)
  const defs = selected.map(k => COLUMN_DEFS[k])

  worksheet.columns = defs.map(d => ({ header: d.header, key: d.key, width: d.width }))
  styleHeaderRow(worksheet, defs.length)

  if (opts.mode === 'compact') {
    for (const row of opts.rows) {
      const cells: Record<string, any> = {}
      for (const d of defs) cells[d.key] = d.value({ row })
      worksheet.addRow(cells).commit()
    }

    // Aggregate block — compact mode only. Skipped if totals column isn't rendered
    // or there are no rows.
    if (opts.rows.length > 0 && defs.some(d => d.key === 'total')) {
      const agg = computeAggregates(opts.rows)
      const labelIdx = Math.max(0, defs.findIndex(d => d.key === 'total') - 1)
      const labelKey = defs[labelIdx]?.key || defs[0].key
      const totalKey = 'total'

      worksheet.addRow({}).commit()

      if (agg.mixedCurrency) {
        const warnRow: Record<string, any> = {}
        warnRow[labelKey] = 'Totals:'
        warnRow[totalKey] = 'mixed currencies — no aggregate'
        const r = worksheet.addRow(warnRow)
        r.font = { bold: true, italic: true }
        r.commit()
      } else {
        const totalRow: Record<string, any> = {}
        totalRow[labelKey] = 'Total:'
        totalRow[totalKey] = formatCurrency(agg.total ?? 0)
        const r1 = worksheet.addRow(totalRow)
        r1.font = { bold: true }
        r1.commit()

        for (const method of Object.keys(METHOD_LABELS) as PaymentMethod[]) {
          const sum = agg.byMethod[method] || 0
          if (sum <= 0) continue
          const row: Record<string, any> = {}
          row[labelKey] = `Total ${METHOD_LABELS[method]}:`
          row[totalKey] = formatCurrency(sum)
          worksheet.addRow(row).commit()
        }
      }
    }
  } else {
    for (const row of opts.rows) {
      const lines = row.lines && row.lines.length ? row.lines : [{
        description: '(no lines)', quantity: 0, unitPrice: 0, lineTotal: row.total,
      } as any]
      lines.forEach((line, i) => {
        const cells: Record<string, any> = {}
        for (const d of defs) cells[d.key] = d.value({ row, line, lineNo: i + 1 })
        worksheet.addRow(cells).commit()
      })
    }
  }

  worksheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}
