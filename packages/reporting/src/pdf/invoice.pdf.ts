import type { IInvoice, IOrg, IContact } from 'db/models'
import { markdownToPdf, buildHeader } from './base.pdf.js'

export async function generateInvoicePDF(
  invoice: IInvoice,
  org: IOrg,
  contact: IContact,
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

  // Line items table
  md += `## Line Items\n\n`
  md += `| # | Description | Qty | Unit | Unit Price | Discount | Tax | Total |\n`
  md += `|---|-------------|-----|------|-----------|----------|-----|-------|\n`

  invoice.lines.forEach((line, i) => {
    md += `| ${i + 1} | ${line.description} | ${line.quantity} | ${line.unit} | ${line.unitPrice.toFixed(2)} | ${line.discount.toFixed(2)} | ${line.taxRate}% | ${line.lineTotal.toFixed(2)} |\n`
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
