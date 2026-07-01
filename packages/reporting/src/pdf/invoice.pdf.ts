import type { IInvoice, IOrg, IContact } from 'db/models'
import { markdownToPdf, buildHeader } from './base.pdf.js'

/**
 * Line-item columns, keyed to the shared export catalog (ui-shared useExportColumns
 * + invoice-export.controller ALLOWED_COLUMN_KEYS). When `columns` is supplied the
 * table renders only the selected line columns (so e.g. unchecking Discount in the
 * print dialog actually drops the column); when omitted, all columns render.
 */
const LINE_COLS: { key: string; header: string; cell: (line: any, i: number) => string }[] = [
  { key: 'lineNo', header: '#', cell: (_l, i) => String(i + 1) },
  { key: 'description', header: 'Description', cell: (l) => String(l.description ?? '') },
  { key: 'quantity', header: 'Qty', cell: (l) => String(l.quantity ?? '') },
  { key: 'unit', header: 'Unit', cell: (l) => String(l.unit ?? '') },
  { key: 'unitPrice', header: 'Unit Price', cell: (l) => Number(l.unitPrice ?? 0).toFixed(2) },
  { key: 'discount', header: 'Discount', cell: (l) => Number(l.discount ?? 0).toFixed(2) },
  { key: 'taxRate', header: 'Tax', cell: (l) => `${l.taxRate ?? 0}%` },
  { key: 'lineTotal', header: 'Total', cell: (l) => Number(l.lineTotal ?? 0).toFixed(2) },
]

export async function generateInvoicePDF(
  invoice: IInvoice,
  org: IOrg,
  contact: IContact,
  columns?: string[],
): Promise<Buffer | undefined> {
  let md = buildHeader(
    invoice.type === 'credit_note' ? 'Credit Note' : 'Invoice',
    org.name,
  )

  // Invoice details
  md += `**Invoice Number:** ${invoice.invoiceNumber}\n\n`
  md += `**Date:** ${invoice.issueDate.toLocaleDateString()}\n\n`
  md += `**Due Date:** ${invoice.dueDate.toLocaleDateString()}\n\n`
  md += `**Status:** ${invoice.status}\n\n`
  md += `**Currency:** ${invoice.currency}\n\n`

  md += `---\n\n`

  // Billing / Shipping
  md += `## Bill To\n\n`
  if (contact.companyName) md += `**${contact.companyName}**\n\n`
  if (contact.firstName || contact.lastName) {
    md += `${contact.firstName || ''} ${contact.lastName || ''}\n\n`
  }
  if (invoice.billingAddress) {
    const addr = invoice.billingAddress
    md += `${addr.street}\n\n`
    md += `${addr.city}${addr.state ? ', ' + addr.state : ''} ${addr.postalCode}\n\n`
    md += `${addr.country}\n\n`
  }
  if (contact.email) md += `Email: ${contact.email}\n\n`
  if (contact.taxId) md += `Tax ID: ${contact.taxId}\n\n`

  if (invoice.shippingAddress) {
    md += `## Ship To\n\n`
    const addr = invoice.shippingAddress
    md += `${addr.street}\n\n`
    md += `${addr.city}${addr.state ? ', ' + addr.state : ''} ${addr.postalCode}\n\n`
    md += `${addr.country}\n\n`
  }

  md += `---\n\n`

  // Line items table — honor the selected columns (falls back to all when none given)
  const cols = columns?.length
    ? LINE_COLS.filter((c) => columns.includes(c.key))
    : LINE_COLS
  const lineCols = cols.length ? cols : LINE_COLS.filter((c) => c.key === 'description' || c.key === 'lineTotal')

  md += `## Line Items\n\n`
  md += `| ${lineCols.map((c) => c.header).join(' | ')} |\n`
  md += `|${lineCols.map(() => '---').join('|')}|\n`

  invoice.lines.forEach((line, i) => {
    md += `| ${lineCols.map((c) => c.cell(line, i)).join(' | ')} |\n`
  })

  md += `\n---\n\n`

  // Totals
  md += `## Summary\n\n`
  md += `| | Amount |\n`
  md += `|---|-------:|\n`
  md += `| Subtotal | ${invoice.subtotal.toFixed(2)} |\n`
  if (invoice.discountTotal > 0) {
    md += `| Discount | -${invoice.discountTotal.toFixed(2)} |\n`
  }
  md += `| Tax | ${invoice.taxTotal.toFixed(2)} |\n`
  md += `| **Total** | **${invoice.total.toFixed(2)} ${invoice.currency}** |\n`
  if (invoice.amountPaid > 0) {
    md += `| Amount Paid | ${invoice.amountPaid.toFixed(2)} |\n`
    md += `| **Amount Due** | **${invoice.amountDue.toFixed(2)} ${invoice.currency}** |\n`
  }

  // Payment terms
  if (invoice.terms) {
    md += `\n---\n\n## Payment Terms\n\n${invoice.terms}\n\n`
  }

  if (invoice.notes) {
    md += `## Notes\n\n${invoice.notes}\n\n`
  }

  if (invoice.footer) {
    md += `---\n\n*${invoice.footer}*\n`
  }

  return markdownToPdf(md)
}
