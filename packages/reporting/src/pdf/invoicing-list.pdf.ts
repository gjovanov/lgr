import { markdownToPdf, buildHeader } from './base.pdf.js'
import type { InvoiceExportRow, ExportMode } from '../excel/invoicing-list.excel.js'
import { computeAggregates } from '../excel/invoicing-list.excel.js'
import { exportI18n, statusLabel, type ExportLocale } from '../i18n.js'

interface ListOptions {
  title: string
  orgName: string
  mode: ExportMode
  rows: InvoiceExportRow[]
  columns?: string[]
  locale?: ExportLocale | string
}

type LineRow = NonNullable<InvoiceExportRow['lines']>[number]

interface PdfColumnDef {
  key: string
  headerKey: keyof ReturnType<typeof exportI18n>['header']
  align?: 'left' | 'right'
  modes: ExportMode[]
  /** Header-level columns use `(row)`; line-level use `(row, line, idx)`. */
  cell: (row: InvoiceExportRow, line: LineRow | undefined, lineNo: number | undefined, locale: string | undefined) => string
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
  number:       { key: 'number',       headerKey: 'number',       modes: ['compact','detailed'], cell: (r) => esc(r.invoiceNumber) },
  issueDate:    { key: 'issueDate',    headerKey: 'issueDate',    modes: ['compact','detailed'], cell: (r) => esc(new Date(r.issueDate).toISOString().split('T')[0]) },
  dueDate:      { key: 'dueDate',      headerKey: 'dueDate',      modes: ['compact'],            cell: (r) => esc(new Date(r.dueDate).toISOString().split('T')[0]) },
  contactName:  { key: 'contactName',  headerKey: 'contactName',  modes: ['compact','detailed'], cell: (r) => esc(r.contactName) },
  contactTaxId: { key: 'contactTaxId', headerKey: 'contactTaxId', modes: ['compact'],            cell: (r) => esc(r.contactTaxId) },
  status:       { key: 'status',       headerKey: 'status',       modes: ['compact','detailed'], cell: (r, _l, _i, locale) => esc(statusLabel(r.status, locale)) },
  currency:     { key: 'currency',     headerKey: 'currency',     modes: ['compact','detailed'], cell: (r) => esc(r.currency) },
  subtotal:     { key: 'subtotal',     headerKey: 'subtotal',     align: 'right', modes: ['compact'], cell: (r) => num(r.subtotal) },
  taxTotal:     { key: 'taxTotal',     headerKey: 'taxTotal',     align: 'right', modes: ['compact'], cell: (r) => num(r.taxTotal) },
  total:        { key: 'total',        headerKey: 'total',        align: 'right', modes: ['compact','detailed'], cell: (r) => num(r.total) },
  amountPaid:   { key: 'amountPaid',   headerKey: 'amountPaid',   align: 'right', modes: ['compact'], cell: (r) => num(r.amountPaid) },
  amountDue:    { key: 'amountDue',    headerKey: 'amountDue',    align: 'right', modes: ['compact'], cell: (r) => num(r.amountDue) },
  reference:    { key: 'reference',    headerKey: 'reference',    modes: ['compact'],            cell: (r) => esc(r.reference) },
  // Line-level (detailed)
  lineNo:       { key: 'lineNo',       headerKey: 'lineNo',       modes: ['detailed'], cell: (_r, _l, i) => String(i ?? 0) },
  description:  { key: 'description',  headerKey: 'description',  modes: ['detailed'], cell: (_r, l) => esc(l?.description) },
  quantity:     { key: 'quantity',     headerKey: 'quantity',     align: 'right', modes: ['detailed'], cell: (_r, l) => num(l?.quantity, 2) },
  unit:         { key: 'unit',         headerKey: 'unit',         modes: ['detailed'], cell: (_r, l) => esc(l?.unit) },
  unitPrice:    { key: 'unitPrice',    headerKey: 'unitPrice',    align: 'right', modes: ['detailed'], cell: (_r, l) => num(l?.unitPrice) },
  discount:     { key: 'discount',     headerKey: 'discount',     align: 'right', modes: ['detailed'], cell: (_r, l) => num(l?.discount) },
  taxRate:      { key: 'taxRate',      headerKey: 'taxRate',      align: 'right', modes: ['detailed'], cell: (_r, l) => num(l?.taxRate, 2) },
  lineTotal:    { key: 'lineTotal',    headerKey: 'lineTotal',    align: 'right', modes: ['detailed'], cell: (_r, l) => num(l?.lineTotal) },
}

const DEFAULT_COLUMNS: Record<ExportMode, string[]> = {
  compact: ['number','issueDate','contactName','status','currency','total','amountPaid','amountDue'],
  detailed: ['lineNo','description','quantity','unit','unitPrice','taxRate','lineTotal'],
}

function pickColumns(mode: ExportMode, requested?: string[]): PdfColumnDef[] {
  const keys = requested?.length ? requested : DEFAULT_COLUMNS[mode]
  return keys.filter(k => COLUMN_DEFS[k] && COLUMN_DEFS[k].modes.includes(mode)).map(k => COLUMN_DEFS[k])
}

function renderHeaderRow(defs: PdfColumnDef[], i18n: ReturnType<typeof exportI18n>): string {
  return `| ${defs.map(d => i18n.header[d.headerKey]).join(' | ')} |\n`
}

function renderAlignmentRow(defs: PdfColumnDef[]): string {
  return `|${defs.map(d => d.align === 'right' ? '---:' : '---').join('|')}|\n`
}

export async function generateInvoicingListPDF(opts: ListOptions): Promise<Buffer | undefined> {
  const i18n = exportI18n(opts.locale)
  let md = buildHeader(opts.title, opts.orgName)
  md += `**Rows:** ${opts.rows.length}\n\n`
  md += `---\n\n`

  if (opts.mode === 'compact') {
    const defs = pickColumns('compact', opts.columns)
    md += renderHeaderRow(defs, i18n)
    md += renderAlignmentRow(defs)
    for (const r of opts.rows) {
      md += `| ${defs.map(d => d.cell(r, undefined, undefined, opts.locale)).join(' | ')} |\n`
    }

    // Aggregate summary
    if (opts.rows.length > 0) {
      const agg = computeAggregates(opts.rows)
      md += `\n---\n\n## ${i18n.footer.totalsLabel}\n\n`
      if (agg.mixedCurrency) {
        md += `_${i18n.footer.mixedCurrency}_\n\n`
      } else {
        md += `- **${i18n.footer.totalLabel}** ${num(agg.total)} ${agg.currency ?? ''}\n`
        for (const [m, label] of Object.entries(i18n.paymentMethod)) {
          const sum = agg.byMethod[m as keyof typeof agg.byMethod] || 0
          if (sum > 0) md += `- **${i18n.footer.totalByMethod(label)}** ${num(sum)} ${agg.currency ?? ''}\n`
        }
      }
    }
  } else {
    const headerKeys = (opts.columns?.length
      ? opts.columns.filter(k => COLUMN_DEFS[k] && COLUMN_DEFS[k].modes.includes('compact'))
      : ['issueDate','contactName','status','total'])
    const headerDefs = headerKeys.map(k => COLUMN_DEFS[k]).filter(Boolean)

    const lineDefs = pickColumns('detailed', opts.columns)

    for (const r of opts.rows) {
      md += `## ${esc(r.invoiceNumber)}\n\n`
      for (const d of headerDefs) md += `- **${i18n.header[d.headerKey]}:** ${d.cell(r, undefined, undefined, opts.locale)}\n`
      md += `\n`

      if (r.lines && r.lines.length && lineDefs.length) {
        md += renderHeaderRow(lineDefs, i18n)
        md += renderAlignmentRow(lineDefs)
        r.lines.forEach((line, i) => {
          md += `| ${lineDefs.map(d => d.cell(r, line, i + 1, opts.locale)).join(' | ')} |\n`
        })
        md += `\n`
      }
      md += `---\n\n`
    }
  }

  return markdownToPdf(md)
}
