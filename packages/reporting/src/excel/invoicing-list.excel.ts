import { createWorkbook, finalizeWorkbook, styleHeaderRow, formatCurrency, formatDate } from './base.excel.js'

export type ExportMode = 'compact' | 'detailed'

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
}

/**
 * Export a list of invoicing documents (invoices / proformas / credit notes / etc.) to XLSX.
 *
 * compact  — one row per document, summary columns only.
 * detailed — one row per line item per document (flat join).
 */
export async function generateInvoicingListXLSX(opts: ListOptions): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const worksheet = workbook.addWorksheet(opts.title.substring(0, 30))

  if (opts.mode === 'compact') {
    worksheet.columns = [
      { header: 'Number', key: 'invoiceNumber', width: 20 },
      { header: 'Issue Date', key: 'issueDate', width: 14 },
      { header: 'Due Date', key: 'dueDate', width: 14 },
      { header: 'Contact', key: 'contactName', width: 32 },
      { header: 'Tax ID', key: 'contactTaxId', width: 16 },
      { header: 'Status', key: 'status', width: 14 },
      { header: 'Currency', key: 'currency', width: 10 },
      { header: 'Subtotal', key: 'subtotal', width: 14 },
      { header: 'Tax', key: 'taxTotal', width: 14 },
      { header: 'Total', key: 'total', width: 16 },
      { header: 'Paid', key: 'amountPaid', width: 14 },
      { header: 'Due', key: 'amountDue', width: 14 },
      { header: 'Reference', key: 'reference', width: 20 },
    ]
    styleHeaderRow(worksheet, 13)

    for (const r of opts.rows) {
      worksheet.addRow({
        invoiceNumber: r.invoiceNumber,
        issueDate: formatDate(new Date(r.issueDate)),
        dueDate: formatDate(new Date(r.dueDate)),
        contactName: r.contactName || '',
        contactTaxId: r.contactTaxId || '',
        status: r.status,
        currency: r.currency,
        subtotal: r.subtotal != null ? formatCurrency(r.subtotal) : '',
        taxTotal: r.taxTotal != null ? formatCurrency(r.taxTotal) : '',
        total: formatCurrency(r.total),
        amountPaid: r.amountPaid != null ? formatCurrency(r.amountPaid) : '',
        amountDue: r.amountDue != null ? formatCurrency(r.amountDue) : '',
        reference: r.reference || '',
      }).commit()
    }
  } else {
    // detailed: one row per line item
    worksheet.columns = [
      { header: 'Number', key: 'invoiceNumber', width: 20 },
      { header: 'Issue Date', key: 'issueDate', width: 14 },
      { header: 'Contact', key: 'contactName', width: 28 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Currency', key: 'currency', width: 10 },
      { header: 'Line #', key: 'lineNo', width: 8 },
      { header: 'Description', key: 'description', width: 40 },
      { header: 'Qty', key: 'quantity', width: 10 },
      { header: 'Unit', key: 'unit', width: 8 },
      { header: 'Unit Price', key: 'unitPrice', width: 14 },
      { header: 'Discount %', key: 'discount', width: 12 },
      { header: 'Tax %', key: 'taxRate', width: 10 },
      { header: 'Line Total', key: 'lineTotal', width: 14 },
      { header: 'Doc Total', key: 'total', width: 14 },
    ]
    styleHeaderRow(worksheet, 14)

    for (const r of opts.rows) {
      const lines = r.lines && r.lines.length ? r.lines : [{
        description: '(no lines)', quantity: 0, unitPrice: 0, lineTotal: r.total,
      }]
      lines.forEach((line, i) => {
        worksheet.addRow({
          invoiceNumber: r.invoiceNumber,
          issueDate: formatDate(new Date(r.issueDate)),
          contactName: r.contactName || '',
          status: r.status,
          currency: r.currency,
          lineNo: i + 1,
          description: line.description,
          quantity: line.quantity,
          unit: line.unit || '',
          unitPrice: formatCurrency(line.unitPrice || 0),
          discount: line.discount != null ? line.discount : '',
          taxRate: line.taxRate != null ? line.taxRate : '',
          lineTotal: formatCurrency(line.lineTotal || 0),
          total: formatCurrency(r.total),
        }).commit()
      })
    }
  }

  worksheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}
