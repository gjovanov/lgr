import { createWorkbook, finalizeWorkbook, styleHeaderRow, formatCurrency, formatDate } from './base.excel.js'
import type { InvoiceExportRow, ExportMode } from './invoicing-list.excel.js'

/**
 * Export a single invoicing document to XLSX with header rows + line items.
 */
export async function generateInvoicingSingleXLSX(
  row: InvoiceExportRow,
  mode: ExportMode = 'detailed',
): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const worksheet = workbook.addWorksheet('Document')

  // Header block
  worksheet.addRow([`Number:`, row.invoiceNumber]).commit()
  worksheet.addRow([`Issue Date:`, formatDate(new Date(row.issueDate))]).commit()
  worksheet.addRow([`Due Date:`, formatDate(new Date(row.dueDate))]).commit()
  worksheet.addRow([`Contact:`, row.contactName || '']).commit()
  if (row.contactTaxId) worksheet.addRow([`Tax ID:`, row.contactTaxId]).commit()
  worksheet.addRow([`Status:`, row.status]).commit()
  worksheet.addRow([`Currency:`, row.currency]).commit()
  if (row.reference) worksheet.addRow([`Reference:`, row.reference]).commit()
  worksheet.addRow([]).commit()

  if (mode === 'detailed' && row.lines && row.lines.length) {
    // Line items table
    const headerRow = worksheet.addRow(['#', 'Description', 'Qty', 'Unit', 'Unit Price', 'Discount %', 'Tax %', 'Line Total'])
    headerRow.font = { bold: true }
    headerRow.commit()

    row.lines.forEach((line, i) => {
      worksheet.addRow([
        i + 1,
        line.description,
        line.quantity,
        line.unit || '',
        formatCurrency(line.unitPrice || 0),
        line.discount != null ? line.discount : '',
        line.taxRate != null ? line.taxRate : '',
        formatCurrency(line.lineTotal || 0),
      ]).commit()
    })
    worksheet.addRow([]).commit()
  }

  // Totals block
  if (row.subtotal != null) worksheet.addRow([`Subtotal:`, formatCurrency(row.subtotal)]).commit()
  if (row.taxTotal != null) worksheet.addRow([`Tax Total:`, formatCurrency(row.taxTotal)]).commit()
  worksheet.addRow([`Total:`, formatCurrency(row.total)]).commit()
  if (row.amountPaid != null) worksheet.addRow([`Amount Paid:`, formatCurrency(row.amountPaid)]).commit()
  if (row.amountDue != null) worksheet.addRow([`Amount Due:`, formatCurrency(row.amountDue)]).commit()

  if (row.notes) {
    worksheet.addRow([]).commit()
    worksheet.addRow([`Notes:`, row.notes]).commit()
  }

  worksheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}
