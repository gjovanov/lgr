import { markdownToPdf, escHtml as esc, fmtDate, flattenHtml } from './base.pdf.js'
import type { InvoiceExportRow, ExportMode } from '../excel/invoicing-list.excel.js'
import { computeAggregates, summaryLines, MONEY_COLUMN_KEYS, type MoneyColumnKey } from '../excel/invoicing-list.excel.js'
import { exportI18n, statusLabel, paymentMethodLabel, type ExportLocale } from '../i18n.js'
import { logoImgTag, LOGO_CSS } from './logo.js'
import { productCredit } from '../product-credit.js'

interface ListOptions {
  title: string
  orgName: string
  mode: ExportMode
  rows: InvoiceExportRow[]
  columns?: string[]
  locale?: ExportLocale | string
  /** Reporting period shown in the header block, when the caller filtered by date. */
  period?: { from?: string | Date; to?: string | Date }
  /** The org's letterhead logo; falls back to the bundled asset when absent or unusable. */
  logo?: string
  /** Issuer line printed in the page foot (org name / contacts). */
  footerText?: string
}

type LineRow = NonNullable<InvoiceExportRow['lines']>[number]

interface PdfColumnDef {
  key: string
  headerKey: keyof ReturnType<typeof exportI18n>['header']
  align?: 'left' | 'right'
  /** Relative column width. Actual percentages are computed from the picked set, so any
   *  column selection fills the page instead of squeezing the text columns to nothing. */
  weight: number
  /** Values that must never wrap (dates, numbers, codes). */
  nowrap?: boolean
  modes: ExportMode[]
  /** Header-level columns use `(row)`; line-level use `(row, line, idx)`. */
  cell: (row: InvoiceExportRow, line: LineRow | undefined, lineNo: number | undefined, locale: string | undefined) => string
}

/** BCP-47 tag for number formatting; the export locales are two-letter codes. */
const NUMBER_LOCALE: Record<string, string> = { en: 'en-US', bg: 'bg-BG', de: 'de-DE', mk: 'mk-MK' }

/**
 * Grouped, two-decimal amount in the reader's locale ("1 234,56" / "1,234.56"). Falls back to
 * a plain fixed-point string if the runtime lacks the locale data.
 */
function money(n: number | undefined | null, locale?: string): string {
  if (n === null || n === undefined) return ''
  const value = Number(n)
  if (Number.isNaN(value)) return ''
  const tag = NUMBER_LOCALE[(locale || 'en').toLowerCase().split('-')[0]] || 'en-US'
  try {
    return new Intl.NumberFormat(tag, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)
  } catch {
    return value.toFixed(2)
  }
}

/** Quantities print without trailing zeros ("16", "2.5"), as on the invoice form. */
function qty(v: number | undefined | null): string {
  if (v === null || v === undefined) return ''
  const n = Number(v)
  if (Number.isNaN(n)) return ''
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)))
}

// Kept in lockstep with COLUMN_DEFS in invoicing-list.excel.ts and the UI catalog.
const COLUMN_DEFS: Record<string, PdfColumnDef> = {
  // Draft numbers ("DRF-INV-2026-00006") are long enough to overrun a nowrap cell and print
  // over the next column, so this one wraps instead.
  number:       { key: 'number',       headerKey: 'number',       weight: 16, modes: ['compact','detailed'], cell: (r) => esc(r.invoiceNumber) },
  issueDate:    { key: 'issueDate',    headerKey: 'issueDate',    weight: 10, nowrap: true, modes: ['compact','detailed'], cell: (r) => fmtDate(r.issueDate) },
  dueDate:      { key: 'dueDate',      headerKey: 'dueDate',      weight: 10, nowrap: true, modes: ['compact'],            cell: (r) => fmtDate(r.dueDate) },
  contactName:  { key: 'contactName',  headerKey: 'contactName',  weight: 25, modes: ['compact','detailed'], cell: (r) => esc(r.contactName) },
  contactTaxId: { key: 'contactTaxId', headerKey: 'contactTaxId', weight: 12, nowrap: true, modes: ['compact'],            cell: (r) => esc(r.contactTaxId) },
  status:       { key: 'status',       headerKey: 'status',       weight: 13, modes: ['compact','detailed'], cell: (r, _l, _i, locale) => esc(statusLabel(r.status, locale)) },
  currency:     { key: 'currency',     headerKey: 'currency',     weight: 9,  nowrap: true, modes: ['compact','detailed'], cell: (r) => esc(r.currency) },
  subtotal:     { key: 'subtotal',     headerKey: 'subtotal',     weight: 11, nowrap: true, align: 'right', modes: ['compact'], cell: (r, _l, _i, locale) => money(r.subtotal, locale) },
  taxTotal:     { key: 'taxTotal',     headerKey: 'taxTotal',     weight: 10, nowrap: true, align: 'right', modes: ['compact'], cell: (r, _l, _i, locale) => money(r.taxTotal, locale) },
  total:        { key: 'total',        headerKey: 'total',        weight: 11, nowrap: true, align: 'right', modes: ['compact','detailed'], cell: (r, _l, _i, locale) => money(r.total, locale) },
  amountPaid:   { key: 'amountPaid',   headerKey: 'amountPaid',   weight: 10, nowrap: true, align: 'right', modes: ['compact'], cell: (r, _l, _i, locale) => money(r.amountPaid, locale) },
  amountDue:    { key: 'amountDue',    headerKey: 'amountDue',    weight: 10, nowrap: true, align: 'right', modes: ['compact'], cell: (r, _l, _i, locale) => money(r.amountDue, locale) },
  reference:    { key: 'reference',    headerKey: 'reference',    weight: 12, modes: ['compact'],            cell: (r) => esc(r.reference) },
  paymentMethod:{ key: 'paymentMethod',headerKey: 'paymentMethod',weight: 12, modes: ['compact'],            cell: (r, _l, _i, locale) => esc(paymentMethodLabel(r.paymentMethod, locale)) },
  // Line-level (detailed)
  lineNo:       { key: 'lineNo',       headerKey: 'lineNo',       weight: 4,  nowrap: true, modes: ['detailed'], cell: (_r, _l, i) => String(i ?? 0) },
  description:  { key: 'description',  headerKey: 'description',  weight: 30, modes: ['detailed'], cell: (_r, l) => esc(l?.description) },
  quantity:     { key: 'quantity',     headerKey: 'quantity',     weight: 8,  nowrap: true, align: 'right', modes: ['detailed'], cell: (_r, l) => qty(l?.quantity) },
  unit:         { key: 'unit',         headerKey: 'unit',         weight: 6,  nowrap: true, modes: ['detailed'], cell: (_r, l) => esc(l?.unit) },
  unitPrice:    { key: 'unitPrice',    headerKey: 'unitPrice',    weight: 10, nowrap: true, align: 'right', modes: ['detailed'], cell: (_r, l, _i, locale) => money(l?.unitPrice, locale) },
  discount:     { key: 'discount',     headerKey: 'discount',     weight: 9,  nowrap: true, align: 'right', modes: ['detailed'], cell: (_r, l, _i, locale) => (l?.discount ? money(l.discount, locale) : '') },
  taxRate:      { key: 'taxRate',      headerKey: 'taxRate',      weight: 9,  nowrap: true, align: 'right', modes: ['detailed'], cell: (_r, l) => (l?.taxRate == null ? '' : `${l.taxRate}%`) },
  lineTotal:    { key: 'lineTotal',    headerKey: 'lineTotal',    weight: 11, nowrap: true, align: 'right', modes: ['detailed'], cell: (_r, l, _i, locale) => money(l?.lineTotal, locale) },
}

const DEFAULT_COLUMNS: Record<ExportMode, string[]> = {
  compact: ['number','issueDate','contactName','status','currency','subtotal','taxTotal','total','amountPaid','amountDue'],
  detailed: ['lineNo','description','quantity','unit','unitPrice','taxRate','lineTotal'],
}

/** Line-item columns; in detailed mode these are the only ones the line table may render. */
const LINE_LEVEL = new Set(['lineNo','description','quantity','unit','unitPrice','discount','taxRate','lineTotal'])

function pickColumns(mode: ExportMode, requested?: string[]): PdfColumnDef[] {
  const applicable = (keys: string[]) => keys
    .filter(k => COLUMN_DEFS[k] && COLUMN_DEFS[k].modes.includes(mode))
    // Document-level columns belong to the heading band in detailed mode, never to the line table.
    .filter(k => (mode === 'detailed' ? LINE_LEVEL.has(k) : !LINE_LEVEL.has(k)))

  const picked = applicable(requested?.length ? requested : DEFAULT_COLUMNS[mode])
  // A selection with nothing printable for this table still has to produce a usable document.
  const keys = picked.length ? picked : applicable(DEFAULT_COLUMNS[mode])
  return keys.map(k => COLUMN_DEFS[k])
}

/**
 * Styled after the statutory invoice form (`invoice.pdf.ts`): DejaVu at 8.5pt, a shaded
 * heading band with hairline rules top and bottom, tight row padding and a boxed totals
 * block. The list-only additions are the repeating table head and the zebra rows, which a
 * multi-page document list needs to stay readable.
 */
const CSS = `
  ${LOGO_CSS}
  body { font-family: "DejaVu Sans", "Liberation Sans", Arial, sans-serif; font-size: 8.5pt;
    color: #000; max-width: none; padding: 0; margin: 0; }
  table { border-collapse: collapse; border: 0; display: table; width: 100%; margin: 0; }
  table tr, table tbody tr, table tbody tr:nth-child(2n) { background: transparent; border: 0; }
  table td, table th { border: 0; }
  /* The meta block floats out of the flow at the right edge so the title is centred on the
     page itself, not on the space the meta block leaves over. */
  div.top-bar { position: relative; margin-bottom: 12px; min-height: 34px; }
  div.top-bar .title-block { text-align: center; }
  div.top-bar table.meta { position: absolute; top: 0; right: 0; }
  h1.doc-title { font-size: 15pt; font-weight: 700; margin: 0; line-height: 1.2; }
  .org-name { font-size: 10pt; font-weight: 700; margin-top: 3px; }
  table.meta { font-size: 8.5pt; width: auto; margin-left: auto; }
  table.meta td { padding: 0 0 1px 0; white-space: nowrap; }
  table.meta td.k { text-align: right; padding-right: 10px; }
  table.meta td.v { text-align: right; font-weight: 700; }
  table.lines { font-size: 8.5pt; table-layout: fixed; }
  table.lines thead { display: table-header-group; }
  table.lines thead th { border-top: 1px solid #000; border-bottom: 1px solid #000;
    padding: 4px 5px; font-weight: 700; background: #ebebeb;
    overflow-wrap: break-word; word-break: break-word; }
  table.lines tbody td { padding: 2.5px 5px; vertical-align: top;
    overflow-wrap: break-word; word-break: break-word; }
  /* A value wider than its (fixed) column is clipped rather than printed over its neighbour. */
  table.lines td.nowrap, table.lines th.nowrap { overflow: hidden; text-overflow: ellipsis; }
  table.lines tbody tr:nth-child(even) td { background: #f6f6f6; }
  table.lines tbody tr:last-child td { border-bottom: 1px solid #000; }
  table.lines tbody tr.grand-row td { background: #ebebeb; font-weight: 700;
    border-top: 1px solid #000; }
  /* Summary box, in the visual language of the printed invoice's totals block. */
  table.summary { margin-top: 10px; font-size: 8.5pt; page-break-inside: avoid; }
  table.summary td.spacer { width: 58%; }
  table.summary td.box-cell { width: 42%; }
  /* Right inset as on the printed invoice: the border stays off the page's clip edge and the
     amounts do not print against it. */
  .totals-box { border: 1px solid #000; border-radius: 6px; padding: 5px 14px 6px 12px;
    margin-right: 1px; }
  table.tbox td { padding: 0 0 1px 0; }
  table.tbox td.tk { text-align: left; padding-right: 10px; }
  table.tbox td.tv { text-align: right; white-space: nowrap; font-weight: 700; }
  /* Hairlines group the box: net/VAT, then the settlement split, then the overall total. */
  table.tbox tr.split-head td { border-top: 1px solid #b0b0b0; padding-top: 3px; }
  table.tbox tr.grand td { border-top: 1px solid #000; padding-top: 3px; font-weight: 700;
    line-height: 1.25; vertical-align: bottom; }
  table.tbox tr.grand td.tk { font-size: 9.5pt; }
  table.tbox tr.grand td.tv { font-size: 13pt; }
  table.totals { margin-top: 8px; font-size: 8.5pt; page-break-inside: avoid; }
  table.totals td { padding: 1px 0; }
  table.totals td.spacer { width: 60%; }
  table.totals td.tk { text-align: left; width: 25%; padding-left: 6px; }
  table.totals td.tv { text-align: right; width: 15%; white-space: nowrap; padding-right: 6px; }
  table.totals tr.grand td { font-weight: 700; border-top: 1px solid #000; padding-top: 3px; }
  p.empty-note { margin: 14px 0 0 0; font-size: 9pt; font-style: italic; }
  p.mixed-note { margin: 6px 0 0 0; font-size: 8pt; font-style: italic; }
  .doc-block { page-break-inside: avoid; margin-bottom: 12px; }
  table.doc-head { margin-bottom: 3px; }
  table.doc-head td { padding: 3px 6px; background: #ebebeb; border-top: 1px solid #000;
    border-bottom: 1px solid #000; }
  table.doc-head td.d-num { font-weight: 700; width: 20%; }
  table.doc-head td.d-meta { font-size: 8pt; }
  table.doc-head td.d-total { text-align: right; font-weight: 700; width: 18%; white-space: nowrap; }
  p.no-lines { margin: 2px 0 0 6px; font-size: 8pt; font-style: italic; }
  .a-left { text-align: left; }
  .a-right { text-align: right; }
  td.nowrap, th.nowrap { white-space: nowrap; }
`

/** Turn the picked columns' weights into percentages that always add up to 100. */
function widths(defs: PdfColumnDef[]): string[] {
  const sum = defs.reduce((acc, d) => acc + d.weight, 0) || 1
  return defs.map(d => `${((d.weight / sum) * 100).toFixed(2)}%`)
}

function headRow(defs: PdfColumnDef[], i18n: ReturnType<typeof exportI18n>): string {
  const w = widths(defs)
  const cells = defs.map((d, i) =>
    `<th class="a-${d.align === 'right' ? 'right' : 'left'}" style="width:${w[i]}">${esc(i18n.header[d.headerKey])}</th>`,
  ).join('')
  return `<thead><tr>${cells}</tr></thead>`
}

function bodyRow(defs: PdfColumnDef[], row: InvoiceExportRow, line: LineRow | undefined, lineNo: number | undefined, locale?: string): string {
  const cells = defs.map(d => {
    const cls = `a-${d.align === 'right' ? 'right' : 'left'}${d.nowrap ? ' nowrap' : ''}`
    return `<td class="${cls}">${d.cell(row, line, lineNo, locale)}</td>`
  }).join('')
  return `<tr>${cells}</tr>`
}

/**
 * Closing row of the compact table: every rendered money column carries its own column sum,
 * under its own heading, the way the legacy journal report closes with its ОБЩО line.
 */
function grandRow(defs: PdfColumnDef[], rows: InvoiceExportRow[], i18n: ReturnType<typeof exportI18n>, locale?: string): string {
  const moneyKeys = new Set<string>(MONEY_COLUMN_KEYS)
  if (!rows.length || !defs.some(d => moneyKeys.has(d.key))) return ''
  const agg = computeAggregates(rows)
  const labelIndex = Math.max(0, defs.findIndex(d => !moneyKeys.has(d.key)))

  const cells = defs.map((d, i) => {
    if (moneyKeys.has(d.key)) {
      // Across currencies the sums would be meaningless, so the columns stay blank.
      const value = agg.mixedCurrency ? '' : money(agg.columns[d.key as MoneyColumnKey], locale)
      return `<td class="a-right nowrap">${value}</td>`
    }
    return `<td class="a-left">${i === labelIndex ? esc(i18n.footer.totalLabel) : ''}</td>`
  }).join('')
  return `<tr class="grand-row">${cells}</tr>`
}

/**
 * Boxed period summary — net, VAT, the split by payment method, and gross for the whole
 * report, named and styled as the printed invoice names and styles its own totals block. The
 * figures come from `summaryLines`, which the workbook export prints as well, so the two
 * reports can never state different numbers for the same period.
 */
function summaryBox(rows: InvoiceExportRow[], i18n: ReturnType<typeof exportI18n>, locale?: string): string {
  const lines = summaryLines(rows, i18n, locale)
  // Empty across mixed currencies too: adding those would be a wrong number, and the note
  // under the table says so instead.
  if (!lines.length) return ''
  const cur = computeAggregates(rows).currency ?? ''
  const amount = (v: number) => `${money(v, locale)} ${esc(cur)}`

  const rows_ = lines.map((line, i) => {
    // A rule above the first method separates the settlement split from the net/VAT pair.
    const cls = line.kind === 'grand' ? 'grand' : (line.kind === 'method' && lines[i - 1]?.kind !== 'method' ? 'split-head' : '')
    return `<tr class="${cls}"><td class="tk">${esc(line.label)}</td><td class="tv">${amount(line.amount)}</td></tr>`
  }).join('')

  return `
    <table class="summary">
      <tr>
        <td class="spacer"></td>
        <td class="box-cell">
          <div class="totals-box">
            <table class="tbox">${rows_}</table>
          </div>
        </td>
      </tr>
    </table>`
}

/**
 * Stands in for the summary box when the rows span several currencies: adding those amounts
 * together would produce a number that means nothing, so the report says so instead.
 */
function mixedCurrencyNote(rows: InvoiceExportRow[], i18n: ReturnType<typeof exportI18n>): string {
  if (!rows.length || !computeAggregates(rows).mixedCurrency) return ''
  return `<p class="mixed-note">${esc(i18n.footer.mixedCurrency)}</p>`
}

function periodText(period: ListOptions['period']): string {
  if (!period) return ''
  const from = fmtDate(period.from as any)
  const to = fmtDate(period.to as any)
  if (from && to) return `${from} – ${to}`
  return from || to || ''
}

/**
 * Page foot: issuer line on the left, the software credit in the middle and page x / y on the
 * right. Puppeteer renders the footer template in its own document, so the styling has to be
 * inline.
 */
function footerTemplate(text: string, locale?: string): string {
  return `<div style="width:100%;font-family:'DejaVu Sans',Arial,sans-serif;font-size:7pt;color:#000;padding:0 12mm;display:flex;justify-content:space-between;gap:8px;border-top:1px solid #000;padding-top:3px;">
    <span>${esc(text)}</span>
    <span style="white-space:nowrap">${esc(productCredit(locale))}</span>
    <span style="white-space:nowrap"><span class="pageNumber"></span> / <span class="totalPages"></span></span>
  </div>`
}

/**
 * Build the document body. Exported so the layout can be asserted (and previewed) without
 * launching Chromium; `generateInvoicingListPDF` is the only production caller.
 */
export function buildListHtml(opts: ListOptions): { html: string; css: string; landscape: boolean } {
  const i18n = exportI18n(opts.locale)
  const locale = opts.locale
  const period = periodText(opts.period)

  const metaRows = [
    period ? `<tr><td class="k">${esc(i18n.meta.period)}:</td><td class="v">${esc(period)}</td></tr>` : '',
    `<tr><td class="k">${esc(i18n.meta.generated)}:</td><td class="v">${fmtDate(new Date())}</td></tr>`,
    `<tr><td class="k">${esc(i18n.meta.rows)}:</td><td class="v">${opts.rows.length}</td></tr>`,
  ].join('')

  const logoImg = logoImgTag(opts.logo)
  const topBar = `
    ${logoImg ? `<div class="logo-bar">${logoImg}</div>` : ''}
    <div class="top-bar">
      <div class="title-block">
        <h1 class="doc-title">${esc(opts.title)}</h1>
        <div class="org-name">${esc(opts.orgName)}</div>
      </div>
      <table class="meta">${metaRows}</table>
    </div>`

  let body = ''
  let landscape = false

  if (opts.mode === 'compact') {
    const defs = pickColumns('compact', opts.columns)
    // Wide column sets stop fitting an A4 portrait page around seven columns.
    landscape = defs.length > 7
    body = opts.rows.length
      ? `<table class="lines">${headRow(defs, i18n)}<tbody>${
          opts.rows.map(r => bodyRow(defs, r, undefined, undefined, locale)).join('')
        }${grandRow(defs, opts.rows, i18n, locale)}</tbody></table>${
          summaryBox(opts.rows, i18n, locale)
        }${mixedCurrencyNote(opts.rows, i18n)}`
      : `<p class="empty-note">${esc(i18n.footer.noLines)}</p>`
  } else {
    // Document heading band: the compact-mode columns the caller selected, minus the number
    // (already the heading) and the total (printed at the right of the band).
    const headKeys = (opts.columns?.length
      ? opts.columns.filter(k => COLUMN_DEFS[k]?.modes.includes('compact') && !LINE_LEVEL.has(k))
      : ['issueDate', 'contactName', 'status'])
      .filter(k => k !== 'number' && k !== 'total')
    const headDefs = headKeys.map(k => COLUMN_DEFS[k]).filter(Boolean)
    const lineDefs = pickColumns('detailed', opts.columns)

    body = opts.rows.map(r => {
      const meta = headDefs
        .map(d => `${esc(i18n.header[d.headerKey])}: ${d.cell(r, undefined, undefined, locale)}`)
        .filter(Boolean)
        .join(' &nbsp;·&nbsp; ')
      const head = `
        <table class="doc-head">
          <tr>
            <td class="d-num">${esc(r.invoiceNumber)}</td>
            <td class="d-meta">${meta}</td>
            <td class="d-total">${money(r.total, locale)} ${esc(r.currency || '')}</td>
          </tr>
        </table>`
      const lines = r.lines?.length && lineDefs.length
        ? `<table class="lines">${headRow(lineDefs, i18n)}<tbody>${
            r.lines.map((line, i) => bodyRow(lineDefs, r, line, i + 1, locale)).join('')
          }</tbody></table>`
        : `<p class="no-lines">${esc(i18n.footer.noLines)}</p>`
      return `<div class="doc-block">${head}${lines}</div>`
    }).join('')

    if (!opts.rows.length) body = `<p class="empty-note">${esc(i18n.footer.noLines)}</p>`
    else body += summaryBox(opts.rows, i18n, locale) + mixedCurrencyNote(opts.rows, i18n)
  }

  return { html: flattenHtml(`${topBar}\n${body}`), css: CSS, landscape }
}

/**
 * Render a list of invoicing documents as PDF, in the visual language of the printed invoice.
 *
 * compact  — one table, one row per document, with a totals block underneath.
 * detailed — one block per document (heading band + its line table), then the grand totals.
 */
export async function generateInvoicingListPDF(opts: ListOptions): Promise<Buffer | undefined> {
  const { html, css, landscape } = buildListHtml(opts)
  const footText = opts.footerText || `${opts.orgName} · ${opts.title}`

  return markdownToPdf(html, {
    css,
    landscape,
    margin: { top: '12mm', bottom: '16mm', left: '12mm', right: '12mm' },
    footerHtml: footerTemplate(footText, opts.locale),
  })
}
