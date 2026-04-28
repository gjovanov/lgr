import { createWorkbook, finalizeWorkbook, formatCurrency, formatDate } from './base.excel.js'
import type { InvoiceExportRow, ExportMode } from './invoicing-list.excel.js'
import { exportI18n, statusLabel, type ExportLocale } from '../i18n.js'

type HeaderKey = keyof ReturnType<typeof exportI18n>['header']

const SINGLE_HEADER_COLUMNS: { key: string; headerKey: HeaderKey; value: (r: InvoiceExportRow, locale?: string) => any }[] = [
  { key: 'number',       headerKey: 'number',       value: (r) => r.invoiceNumber },
  { key: 'issueDate',    headerKey: 'issueDate',    value: (r) => formatDate(new Date(r.issueDate)) },
  { key: 'dueDate',      headerKey: 'dueDate',      value: (r) => formatDate(new Date(r.dueDate)) },
  { key: 'contactName',  headerKey: 'contactName',  value: (r) => r.contactName || '' },
  { key: 'contactTaxId', headerKey: 'contactTaxId', value: (r) => r.contactTaxId || '' },
  { key: 'status',       headerKey: 'status',       value: (r, locale) => statusLabel(r.status, locale) },
  { key: 'currency',     headerKey: 'currency',     value: (r) => r.currency },
  { key: 'reference',    headerKey: 'reference',    value: (r) => r.reference || '' },
  { key: 'subtotal',     headerKey: 'subtotal',     value: (r) => r.subtotal != null ? formatCurrency(r.subtotal) : '' },
  { key: 'taxTotal',     headerKey: 'taxTotal',     value: (r) => r.taxTotal != null ? formatCurrency(r.taxTotal) : '' },
  { key: 'total',        headerKey: 'total',        value: (r) => formatCurrency(r.total) },
  { key: 'amountPaid',   headerKey: 'amountPaid',   value: (r) => r.amountPaid != null ? formatCurrency(r.amountPaid) : '' },
  { key: 'amountDue',    headerKey: 'amountDue',    value: (r) => r.amountDue != null ? formatCurrency(r.amountDue) : '' },
]

const SINGLE_LINE_COLUMNS: { key: string; headerKey: HeaderKey; value: (l: any, i: number) => any }[] = [
  { key: 'lineNo',      headerKey: 'lineNo',       value: (_l, i) => i + 1 },
  { key: 'description', headerKey: 'description',  value: (l) => l.description },
  { key: 'quantity',    headerKey: 'quantity',     value: (l) => l.quantity },
  { key: 'unit',        headerKey: 'unit',         value: (l) => l.unit || '' },
  { key: 'unitPrice',   headerKey: 'unitPrice',    value: (l) => formatCurrency(l.unitPrice || 0) },
  { key: 'discount',    headerKey: 'discount',     value: (l) => l.discount != null ? l.discount : '' },
  { key: 'taxRate',     headerKey: 'taxRate',      value: (l) => l.taxRate != null ? l.taxRate : '' },
  { key: 'lineTotal',   headerKey: 'lineTotal',    value: (l) => formatCurrency(l.lineTotal || 0) },
]

/**
 * Export a single invoicing document to XLSX with header rows + line items.
 * When `columns` is provided, only matching keys are rendered (omit = full default).
 */
export async function generateInvoicingSingleXLSX(
  row: InvoiceExportRow,
  mode: ExportMode = 'detailed',
  columns?: string[],
  locale?: ExportLocale | string,
): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const i18n = exportI18n(locale)
  const worksheet = workbook.addWorksheet(i18n.docTitle.documents)

  const allowHeader = columns?.length ? new Set(columns) : null
  const allowLine = columns?.length ? new Set(columns) : null

  // Header block (key-value pairs)
  for (const col of SINGLE_HEADER_COLUMNS) {
    if (allowHeader && !allowHeader.has(col.key)) continue
    const value = col.value(row, locale)
    if (value === '' || value === null || value === undefined) continue
    worksheet.addRow([`${i18n.header[col.headerKey]}:`, value]).commit()
  }
  worksheet.addRow([]).commit()

  if (mode === 'detailed' && row.lines && row.lines.length) {
    const lineDefs = SINGLE_LINE_COLUMNS.filter(c => !allowLine || allowLine.has(c.key))
    if (lineDefs.length) {
      const headerRow = worksheet.addRow(lineDefs.map(c => i18n.header[c.headerKey]))
      headerRow.font = { bold: true }
      headerRow.commit()
      row.lines.forEach((line, i) => {
        worksheet.addRow(lineDefs.map(c => c.value(line, i))).commit()
      })
      worksheet.addRow([]).commit()
    }
  }

  if (row.notes) {
    worksheet.addRow([`Notes:`, row.notes]).commit()
  }

  worksheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}
