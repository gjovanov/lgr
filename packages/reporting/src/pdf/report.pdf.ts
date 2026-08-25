/**
 * FR-06 (#14) — the generic report PDF.
 *
 * Companion to `excel/report.excel.ts`: one renderer for every registry-driven report, fed
 * the `{columns, rows, totals}` its handler produced. Column headers arrive already
 * localized — the registry names columns by i18n key and only the UI's message catalogue
 * resolves those.
 *
 * The look is the shared house style (`house-style.ts`) — the same letterhead, centred
 * title, floating meta block, banded table and page foot the document exports print. A
 * report and an invoice list should be recognisably the same product; this file used to have
 * its own grey-grid style, which they were not.
 */

import { markdownToPdf, escHtml as esc, flattenHtml } from './base.pdf.js'
import {
  HOUSE_CSS,
  HOUSE_MARGIN,
  buildMetaRows,
  buildTopBar,
  buildTotalsBox,
  footerTemplate,
  periodText,
  type MetaRow,
  type TotalsBoxLine,
} from './house-style.js'

export type ReportCellType = 'text' | 'money' | 'quantity' | 'int' | 'percent' | 'date'

export interface ReportPdfColumn {
  key: string
  /** Already localized by the caller. */
  header: string
  type?: ReportCellType
  /** Relative width; actual percentages are computed over the picked set. */
  weight?: number
}

export interface ReportPdfOptions {
  title: string
  orgName: string
  columns: ReportPdfColumn[]
  rows: Record<string, any>[]
  totals?: Record<string, number>
  totalsLabel?: string
  period?: { from?: string; to?: string }
  locale?: string
  /** The org's letterhead logo; falls back to the bundled asset. */
  logo?: unknown
  /** Issuer line printed in the page foot. */
  footerText?: string
  /** Localized labels for the meta block, so this module needs no i18n table of its own. */
  labels?: { period?: string; generated?: string; rows?: string; noRows?: string }
  /** Extra meta lines a report wants in the header block (operation, warehouse, filters…). */
  extraMeta?: MetaRow[]
  /**
   * Explicit closing-box lines (already formatted). When omitted, the box is derived from
   * `totals` + the column headers, so every report closes with one without extra work.
   */
  summaryLines?: TotalsBoxLine[]
  /** Appended to the amounts in the derived box, when the report is single-currency. */
  currency?: string
  /** Printed instead of the box when the rows span several currencies. */
  mixedCurrencyNote?: string
}

const NUMBER_LOCALE: Record<string, string> = { en: 'en-US', bg: 'bg-BG', de: 'de-DE', mk: 'mk-MK' }

function localeTag(locale?: string): string {
  return NUMBER_LOCALE[(locale || 'en').toLowerCase().split('-')[0]] || 'en-US'
}

function money(n: unknown, locale?: string): string {
  if (n === null || n === undefined || n === '') return ''
  const v = Number(n)
  if (Number.isNaN(v)) return ''
  try {
    return new Intl.NumberFormat(localeTag(locale), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(v)
  } catch {
    return v.toFixed(2)
  }
}

/** Quantities print without trailing zeros ("16", "2.5"), as on the printed forms. */
function qty(n: unknown): string {
  if (n === null || n === undefined || n === '') return ''
  const v = Number(n)
  if (Number.isNaN(v)) return ''
  return Number.isInteger(v) ? String(v) : String(Number(v.toFixed(3)))
}

function day(v: unknown): string {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(String(v))
  if (Number.isNaN(d.getTime())) return ''
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`
}

function format(value: unknown, type: ReportCellType | undefined, locale?: string): string {
  switch (type) {
    case 'money': return money(value, locale)
    case 'quantity': return qty(value)
    case 'int': return value === null || value === undefined || value === '' ? '' : String(Math.round(Number(value) || 0))
    case 'percent': return value === null || value === undefined || value === '' ? '' : `${qty(value)}%`
    case 'date': return day(value)
    default: return String(value ?? '')
  }
}

function isNumeric(type: ReportCellType | undefined): boolean {
  return type === 'money' || type === 'quantity' || type === 'int' || type === 'percent'
}

/** Turn the columns' weights into percentages that always add up to 100. */
function widths(cols: ReportPdfColumn[]): string[] {
  const weights = cols.map(c => c.weight ?? (isNumeric(c.type) ? 10 : 18))
  const sum = weights.reduce((a, b) => a + b, 0) || 1
  return weights.map(w => `${((w / sum) * 100).toFixed(2)}%`)
}

/**
 * The closing box's lines.
 *
 * A caller that knows better (sales history, with its cash/card reconciliation) passes
 * `summaryLines` outright. Otherwise the box is derived from the report's own totals, using
 * each column's already-localized header as the label — so every report closes with the same
 * bordered block as the document exports, without each handler having to say so.
 *
 * Mixed currencies produce NO box: adding those amounts would be a number that means
 * nothing. The note under the table says so instead, exactly as the list export does.
 */
function summaryFor(opts: ReportPdfOptions): TotalsBoxLine[] {
  if (opts.summaryLines) return opts.summaryLines
  if (opts.mixedCurrencyNote) return []

  const totals = opts.totals
  if (!totals || !Object.keys(totals).length) return []

  const suffix = opts.currency ? ` ${opts.currency}` : ''
  const totalled = opts.columns.filter(c => totals[c.key] !== undefined)

  // The last money column is the report's bottom line — it gets the closing rule.
  const grandKey = [...totalled].reverse().find(c => c.type === 'money')?.key

  return totalled.map(c => ({
    label: c.header,
    // Only money carries the currency; a quantity total is a count of things.
    value: format(totals[c.key], c.type, opts.locale) + (c.type === 'money' ? suffix : ''),
    grand: c.key === grandKey,
  }))
}

/**
 * Build the document body. Exported so the layout can be asserted without launching
 * Chromium — the same contract `buildListHtml` / `buildCashAggHtml` offer.
 */
export function buildReportHtml(opts: ReportPdfOptions): { html: string; css: string; landscape: boolean } {
  const cols = opts.columns
  const w = widths(cols)
  const L = opts.labels || {}

  const metaRows = buildMetaRows([
    periodText(opts.period) ? { label: L.period || 'Period', value: periodText(opts.period) } : null,
    { label: L.generated || 'Generated', value: day(new Date()) },
    { label: L.rows || 'Rows', value: opts.rows.length },
    ...(opts.extraMeta || []),
  ])

  const topBar = buildTopBar({
    title: opts.title,
    orgName: opts.orgName,
    logo: opts.logo,
    metaRows,
  })

  const head = `<thead><tr>${cols
    .map((c, i) => `<th class="a-${isNumeric(c.type) ? 'right' : 'left'}" style="width:${w[i]}">${esc(c.header)}</th>`)
    .join('')}</tr></thead>`

  const body = opts.rows
    .map(row => `<tr>${cols
      .map(c => {
        const cls = `a-${isNumeric(c.type) ? 'right' : 'left'}${isNumeric(c.type) || c.type === 'date' ? ' nowrap' : ''}`
        return `<td class="${cls}">${esc(format(row[c.key], c.type, opts.locale))}</td>`
      })
      .join('')}</tr>`)
    .join('')

  // Closing band: every column that has a total carries it under its own heading, the way
  // the list export's ОБЩО row closes.
  const totalsRow = opts.totals && Object.keys(opts.totals).length
    ? `<tr class="grand-row">${cols
        .map((c, i) => {
          const cls = `a-${isNumeric(c.type) ? 'right' : 'left'}`
          if (i === 0) return `<td class="${cls}">${esc(opts.totalsLabel || 'Total')}</td>`
          const t = opts.totals![c.key]
          return `<td class="${cls}">${t === undefined ? '' : esc(format(t, c.type, opts.locale))}</td>`
        })
        .join('')}</tr>`
    : ''

  const table = opts.rows.length
    ? `<table class="lines">${head}<tbody>${body}${totalsRow}</tbody></table>`
    : `<p class="empty-note">${esc(L.noRows || 'No rows for the selected filters.')}</p>`

  const box = opts.rows.length ? buildTotalsBox(summaryFor(opts)) : ''
  const mixedNote = opts.mixedCurrencyNote
    ? `<p class="mixed-note">${esc(opts.mixedCurrencyNote)}</p>`
    : ''

  return {
    html: flattenHtml(`${topBar}\n${table}${box}${mixedNote}`),
    css: HOUSE_CSS,
    // Wide column sets stop fitting an A4 portrait page around seven columns — the same
    // threshold the list export uses.
    landscape: cols.length > 7,
  }
}

export async function generateReportPdf(opts: ReportPdfOptions): Promise<Buffer | undefined> {
  const { html, css, landscape } = buildReportHtml(opts)
  const footText = opts.footerText || `${opts.orgName} · ${opts.title}`

  return markdownToPdf(html, {
    css,
    landscape,
    margin: HOUSE_MARGIN,
    footerHtml: footerTemplate(footText, opts.locale),
  })
}
