import { markdownToPdf, buildHeader } from './base.pdf.js'
import type { InvoiceExportRow, ExportMode } from '../excel/invoicing-list.excel.js'

interface ListOptions {
  title: string
  orgName: string
  mode: ExportMode
  rows: InvoiceExportRow[]
}

function esc(s: string | number | undefined | null): string {
  if (s === null || s === undefined) return ''
  const str = String(s)
  return str.replace(/\|/g, '\\|').replace(/\n/g, ' ')
}

function num(n: number | undefined | null, digits = 2): string {
  if (n === null || n === undefined) return ''
  return Number(n).toFixed(digits)
}

export async function generateInvoicingListPDF(opts: ListOptions): Promise<Buffer | undefined> {
  let md = buildHeader(opts.title, opts.orgName)
  md += `**Rows:** ${opts.rows.length}\n\n`
  md += `---\n\n`

  if (opts.mode === 'compact') {
    md += `| # | Date | Contact | Status | Currency | Total | Paid | Due |\n`
    md += `|---|------|---------|--------|----------|------:|-----:|----:|\n`
    for (const r of opts.rows) {
      md += `| ${esc(r.invoiceNumber)} | ${esc(new Date(r.issueDate).toISOString().split('T')[0])} | ${esc(r.contactName)} | ${esc(r.status)} | ${esc(r.currency)} | ${num(r.total)} | ${num(r.amountPaid)} | ${num(r.amountDue)} |\n`
    }
  } else {
    for (const r of opts.rows) {
      md += `## ${esc(r.invoiceNumber)}\n\n`
      md += `- **Date:** ${esc(new Date(r.issueDate).toISOString().split('T')[0])}\n`
      md += `- **Contact:** ${esc(r.contactName)}\n`
      md += `- **Status:** ${esc(r.status)}\n`
      md += `- **Total:** ${num(r.total)} ${esc(r.currency)}\n\n`

      if (r.lines && r.lines.length) {
        md += `| # | Description | Qty | Unit | Price | Tax% | Line Total |\n`
        md += `|---|-------------|----:|------|------:|-----:|-----------:|\n`
        r.lines.forEach((line, i) => {
          md += `| ${i + 1} | ${esc(line.description)} | ${num(line.quantity, 2)} | ${esc(line.unit)} | ${num(line.unitPrice)} | ${num(line.taxRate, 2)} | ${num(line.lineTotal)} |\n`
        })
        md += `\n`
      }
      md += `---\n\n`
    }
  }

  return markdownToPdf(md)
}
