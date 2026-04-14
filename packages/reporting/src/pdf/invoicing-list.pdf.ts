import { markdownToPdf, buildHeader } from './base.pdf.js'
import type { InvoiceExportRow, ExportMode } from '../excel/invoicing-list.excel.js'

interface ListOptions {
  title: string
  orgName: string
  mode: ExportMode
  rows: InvoiceExportRow[]
  columns?: string[]
}

type LineRow = NonNullable<InvoiceExportRow['lines']>[number]

interface PdfColumnDef {
  key: string
  header: string
  align?: 'left' | 'right'
  modes: ExportMode[]
  /** Header-level columns use `(row)`; line-level use `(row, line, idx)`. */
  cell: (row: InvoiceExportRow, line?: LineRow, lineNo?: number) => string
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

// Kept in lockstep with COLUMN_DEFS in invoicing-list.excel.ts and the UI catalog.
const COLUMN_DEFS: Record<string, PdfColumnDef> = {
  number:       { key: 'number',       header: '#',           modes: ['compact','detailed'], cell: (r) => esc(r.invoiceNumber) },
  issueDate:    { key: 'issueDate',    header: 'Date',        modes: ['compact','detailed'], cell: (r) => esc(new Date(r.issueDate).toISOString().split('T')[0]) },
  dueDate:      { key: 'dueDate',      header: 'Due',         modes: ['compact'],            cell: (r) => esc(new Date(r.dueDate).toISOString().split('T')[0]) },
  contactName:  { key: 'contactName',  header: 'Contact',     modes: ['compact','detailed'], cell: (r) => esc(r.contactName) },
  contactTaxId: { key: 'contactTaxId', header: 'Tax ID',      modes: ['compact'],            cell: (r) => esc(r.contactTaxId) },
  status:       { key: 'status',       header: 'Status',      modes: ['compact','detailed'], cell: (r) => esc(r.status) },
  currency:     { key: 'currency',     header: 'Currency',    modes: ['compact','detailed'], cell: (r) => esc(r.currency) },
  subtotal:     { key: 'subtotal',     header: 'Subtotal',    align: 'right', modes: ['compact'], cell: (r) => num(r.subtotal) },
  taxTotal:     { key: 'taxTotal',     header: 'Tax',         align: 'right', modes: ['compact'], cell: (r) => num(r.taxTotal) },
  total:        { key: 'total',        header: 'Total',       align: 'right', modes: ['compact','detailed'], cell: (r) => num(r.total) },
  amountPaid:   { key: 'amountPaid',   header: 'Paid',        align: 'right', modes: ['compact'], cell: (r) => num(r.amountPaid) },
  amountDue:    { key: 'amountDue',    header: 'Due',         align: 'right', modes: ['compact'], cell: (r) => num(r.amountDue) },
  reference:    { key: 'reference',    header: 'Ref',         modes: ['compact'],            cell: (r) => esc(r.reference) },
  // Line-level (detailed)
  lineNo:       { key: 'lineNo',       header: '#',           modes: ['detailed'], cell: (_r, _l, i) => String(i ?? 0) },
  description:  { key: 'description',  header: 'Description', modes: ['detailed'], cell: (_r, l) => esc(l?.description) },
  quantity:     { key: 'quantity',     header: 'Qty', align: 'right', modes: ['detailed'], cell: (_r, l) => num(l?.quantity, 2) },
  unit:         { key: 'unit',         header: 'Unit',        modes: ['detailed'], cell: (_r, l) => esc(l?.unit) },
  unitPrice:    { key: 'unitPrice',    header: 'Price', align: 'right', modes: ['detailed'], cell: (_r, l) => num(l?.unitPrice) },
  discount:     { key: 'discount',     header: 'Disc%', align: 'right', modes: ['detailed'], cell: (_r, l) => num(l?.discount) },
  taxRate:      { key: 'taxRate',      header: 'Tax%',  align: 'right', modes: ['detailed'], cell: (_r, l) => num(l?.taxRate, 2) },
  lineTotal:    { key: 'lineTotal',    header: 'Line Total', align: 'right', modes: ['detailed'], cell: (_r, l) => num(l?.lineTotal) },
}

const DEFAULT_COLUMNS: Record<ExportMode, string[]> = {
  compact: ['number','issueDate','contactName','status','currency','total','amountPaid','amountDue'],
  detailed: ['lineNo','description','quantity','unit','unitPrice','taxRate','lineTotal'],
}

function pickColumns(mode: ExportMode, requested?: string[]): PdfColumnDef[] {
  const keys = requested?.length ? requested : DEFAULT_COLUMNS[mode]
  return keys.filter(k => COLUMN_DEFS[k] && COLUMN_DEFS[k].modes.includes(mode)).map(k => COLUMN_DEFS[k])
}

function renderHeaderRow(defs: PdfColumnDef[]): string {
  return `| ${defs.map(d => d.header).join(' | ')} |\n`
}

function renderAlignmentRow(defs: PdfColumnDef[]): string {
  return `|${defs.map(d => d.align === 'right' ? '---:' : '---').join('|')}|\n`
}

export async function generateInvoicingListPDF(opts: ListOptions): Promise<Buffer | undefined> {
  let md = buildHeader(opts.title, opts.orgName)
  md += `**Rows:** ${opts.rows.length}\n\n`
  md += `---\n\n`

  if (opts.mode === 'compact') {
    const defs = pickColumns('compact', opts.columns)
    md += renderHeaderRow(defs)
    md += renderAlignmentRow(defs)
    for (const r of opts.rows) {
      md += `| ${defs.map(d => d.cell(r)).join(' | ')} |\n`
    }
  } else {
    const headerKeys = (opts.columns?.length
      ? opts.columns.filter(k => COLUMN_DEFS[k] && COLUMN_DEFS[k].modes.includes('compact'))
      : ['issueDate','contactName','status','total'])
    const headerDefs = headerKeys.map(k => COLUMN_DEFS[k]).filter(Boolean)

    const lineDefs = pickColumns('detailed', opts.columns)

    for (const r of opts.rows) {
      md += `## ${esc(r.invoiceNumber)}\n\n`
      for (const d of headerDefs) md += `- **${d.header}:** ${d.cell(r)}\n`
      md += `\n`

      if (r.lines && r.lines.length && lineDefs.length) {
        md += renderHeaderRow(lineDefs)
        md += renderAlignmentRow(lineDefs)
        r.lines.forEach((line, i) => {
          md += `| ${lineDefs.map(d => d.cell(r, line, i + 1)).join(' | ')} |\n`
        })
        md += `\n`
      }
      md += `---\n\n`
    }
  }

  return markdownToPdf(md)
}
