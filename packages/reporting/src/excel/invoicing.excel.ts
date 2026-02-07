import type { IInvoice } from 'db/models'
import { createWorkbook, finalizeWorkbook, styleHeaderRow, formatCurrency, formatDate } from './base.excel.js'

export async function generateInvoiceListXLSX(invoices: IInvoice[]): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const worksheet = workbook.addWorksheet('Invoices')

  worksheet.columns = [
    { header: 'Invoice #', key: 'invoiceNumber', width: 18 },
    { header: 'Date', key: 'issueDate', width: 14 },
    { header: 'Due Date', key: 'dueDate', width: 14 },
    { header: 'Contact', key: 'contactId', width: 30 },
    { header: 'Direction', key: 'direction', width: 12 },
    { header: 'Currency', key: 'currency', width: 10 },
    { header: 'Total', key: 'total', width: 18 },
    { header: 'Status', key: 'status', width: 14 },
    { header: 'Amount Due', key: 'amountDue', width: 18 },
  ]

  styleHeaderRow(worksheet, 9)

  for (const invoice of invoices) {
    worksheet.addRow({
      invoiceNumber: invoice.invoiceNumber,
      issueDate: formatDate(invoice.issueDate),
      dueDate: formatDate(invoice.dueDate),
      contactId: String(invoice.contactId),
      direction: invoice.direction,
      currency: invoice.currency,
      total: formatCurrency(invoice.total),
      status: invoice.status,
      amountDue: formatCurrency(invoice.amountDue),
    }).commit()
  }

  worksheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}

export async function generateAgedReceivablesXLSX(invoices: IInvoice[]): Promise<Buffer> {
  const { workbook, tmpFile } = await createWorkbook()
  const worksheet = workbook.addWorksheet('Aged Receivables')

  worksheet.columns = [
    { header: 'Invoice #', key: 'invoiceNumber', width: 18 },
    { header: 'Contact', key: 'contactId', width: 30 },
    { header: 'Issue Date', key: 'issueDate', width: 14 },
    { header: 'Due Date', key: 'dueDate', width: 14 },
    { header: 'Total', key: 'total', width: 16 },
    { header: 'Current', key: 'current', width: 16 },
    { header: '1-30 Days', key: 'days30', width: 16 },
    { header: '31-60 Days', key: 'days60', width: 16 },
    { header: '61-90 Days', key: 'days90', width: 16 },
    { header: '120+ Days', key: 'days120', width: 16 },
  ]

  styleHeaderRow(worksheet, 10)

  const now = new Date()
  let totalCurrent = 0
  let total30 = 0
  let total60 = 0
  let total90 = 0
  let total120 = 0

  for (const invoice of invoices) {
    if (invoice.amountDue <= 0) continue

    const daysOverdue = Math.floor((now.getTime() - invoice.dueDate.getTime()) / (1000 * 60 * 60 * 24))
    const amount = invoice.amountDue

    let current = 0
    let days30 = 0
    let days60 = 0
    let days90 = 0
    let days120 = 0

    if (daysOverdue <= 0) {
      current = amount
      totalCurrent += amount
    } else if (daysOverdue <= 30) {
      days30 = amount
      total30 += amount
    } else if (daysOverdue <= 60) {
      days60 = amount
      total60 += amount
    } else if (daysOverdue <= 90) {
      days90 = amount
      total90 += amount
    } else {
      days120 = amount
      total120 += amount
    }

    worksheet.addRow({
      invoiceNumber: invoice.invoiceNumber,
      contactId: String(invoice.contactId),
      issueDate: formatDate(invoice.issueDate),
      dueDate: formatDate(invoice.dueDate),
      total: formatCurrency(invoice.total),
      current: current > 0 ? formatCurrency(current) : '',
      days30: days30 > 0 ? formatCurrency(days30) : '',
      days60: days60 > 0 ? formatCurrency(days60) : '',
      days90: days90 > 0 ? formatCurrency(days90) : '',
      days120: days120 > 0 ? formatCurrency(days120) : '',
    }).commit()
  }

  // Totals row
  const totalsRow = worksheet.addRow({
    invoiceNumber: '',
    contactId: 'TOTALS',
    issueDate: '',
    dueDate: '',
    total: formatCurrency(totalCurrent + total30 + total60 + total90 + total120),
    current: formatCurrency(totalCurrent),
    days30: formatCurrency(total30),
    days60: formatCurrency(total60),
    days90: formatCurrency(total90),
    days120: formatCurrency(total120),
  })
  totalsRow.font = { bold: true }
  totalsRow.commit()

  worksheet.commit()
  return finalizeWorkbook(workbook, tmpFile)
}
