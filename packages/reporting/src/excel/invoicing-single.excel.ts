import { createWorkbook, finalizeWorkbook, formatCurrency, formatDate } from './base.excel.js'
import type { InvoiceExportRow, ExportMode } from './invoicing-list.excel.js'

const SINGLE_HEADER_COLUMNS = [
  { key: 'number',       label: 'Number',     value: (r: InvoiceExportRow) => r.invoiceNumber },
  { key: 'issueDate',    label: 'Issue Date', value: (r: InvoiceExportRow) => formatDate(new Date(r.issueDate)) },
  { key: 'dueDate',      label: 'Due Date',   value: (r: InvoiceExportRow) => formatDate(new Date(r.dueDate)) },
  { key: 'contactName',  label: 'Contact',    value: (r: InvoiceExportRow) => r.contactName || '' },
  { key: 'contactTaxId', label: 'Tax ID',     value: (r: InvoiceExportRow) => r.contactTaxId || '' },
  { key: 'status',       label: 'Status',     value: (r: InvoiceExportRow) => r.status },
  { key: 'currency',     label: 'Currency',   value: (r: InvoiceExportRow) => r.currency },
  { key: 'reference',    label: 'Reference',  value: (r: InvoiceExportRow) => r.reference || '' },
  { key: 'subtotal',     label: 'Subtotal',   value: (r: InvoiceExportRow) => r.subtotal != null ? formatCurrency(r.subtotal) : '' },
  { key: 'taxTotal',     label: 'Tax Total',  value: (r: InvoiceExportRow) => r.taxTotal != null ? formatCurrency(r.taxTotal) : '' },
  { key: 'total',        label: 'Total',      value: (r: InvoiceExportRow) => formatCurrency(r.total) },
  { key: 'amountPaid',   label: 'Amount Paid', value: (r: InvoiceExportRow) => r.amountPaid != null ? formatCurrency(r.amountPaid) : '' },
  { key: 'amountDue',    label: 'Amount Due', value: (r: InvoiceExportRow) => r.amountDue != null ? formatCurrency(r.amountDue) : '' },
]

const SINGLE_LINE_COLUMNS = [
  { key: 'lineNo',      label: '#',           value: (_l: any, i: number) => i + 1 },
  { key: 'description', label: 'Description', value: (l: any) => l.description },
  { key: 'quantity',    label: 'Qty',         value: (l: any) => l.quantity },
  { key: 'unit',        label: 'Unit',        value: (l: any) => l.unit || '' },
  { key: 'unitPrice',   label: 'Unit Price',  value: (l: any) => formatCurrency(l.unitPrice || 0) },
  { key: 'discount',    label: 'Discount %',  value: (l: any) => l.discount != null ? l.discount : '' },
  { key: 'taxRate',     label: 'Tax %',       value: (l: any) => l.taxRate != null ? l.taxRate : '' },
  { key: 'lineTotal',   label: 'Line Total',  value: (l: any) => formatCurrency(l.lineTotal || 0) },
]

/**
 * Export a single invoicing document to XLSX with header rows + line items.
 * When `columns` is provided, only matching keys are rendered (omit = full default).
 */
export async function generateInvoicingSingleXLSX(
  row: InvoiceExportRow,
  mode: ExportMode = 'detailed',
  columns?: string[],
): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const worksheet = workbook.addWorksheet('Document')

  const allowHeader = columns?.length ? new Set(columns) : null
  const allowLine = columns?.length ? new Set(columns) : null

  // Header block (key-value pairs)
  for (const col of SINGLE_HEADER_COLUMNS) {
    if (allowHeader && !allowHeader.has(col.key)) continue
    const value = col.value(row)
    if (value === '' || value === null || value === undefined) continue
    worksheet.addRow([`${col.label}:`, value]).commit()
  }
  worksheet.addRow([]).commit()

  if (mode === 'detailed' && row.lines && row.lines.length) {
    const lineDefs = SINGLE_LINE_COLUMNS.filter(c => !allowLine || allowLine.has(c.key))
    if (lineDefs.length) {
      const headerRow = worksheet.addRow(lineDefs.map(c => c.label))
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
