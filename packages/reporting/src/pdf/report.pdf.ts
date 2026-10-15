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
  /**
   * The column whose total is the report's bottom line (`meta.grandTotalKey`). The derived box
   * gives it the closing rule and ends on it. Unset, that is the last money column.
   */
  grandKey?: string
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

/**
 * Weight a heading's longest word needs per character.
 *
 * The weights are relative, and a numeric column's base of 10 comfortably holds a formatted
 * amount of about seven digits — so one heading character is worth a little over one unit.
 * 1.5 is that, rounded up: it leaves the short headings (ДДС, Общо, Дата) on their base and
 * only widens the columns whose heading is the longest thing in them.
 */
const WEIGHT_PER_HEADER_CHAR = 1.5

/** The same, for a VALUE: body type is larger than the dense head, but digits are narrower. */
const WEIGHT_PER_VALUE_CHAR = 1.35

/** Cell padding, in weight. Both floors add it so the text is not measured edge to edge. */
const WEIGHT_PADDING = 1.5

/**
 * Rows sampled when measuring a column's widest value. Formatting every cell of a
 * 5 000-row export twice to lay the table out is not worth it; a sample plus the totals row
 * (which holds sums, so normally the widest figures of all) settles the width in practice,
 * and the cost of being wrong is a clipped cell, not a broken page.
 */
const WIDTH_SAMPLE_ROWS = 400

/** Longest unbreakable run in a heading — headings wrap at spaces, so this is what must fit. */
function longestWord(header: string): number {
  return header.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 0)
}

/** Longest rendered value in a column, over a sample of the rows plus the totals row. */
function longestValue(col: ReportPdfColumn, opts: ReportPdfOptions): number {
  const rows = opts.rows
  const step = Math.max(1, Math.ceil(rows.length / WIDTH_SAMPLE_ROWS))
  let longest = 0
  for (let i = 0; i < rows.length; i += step) {
    const len = format(rows[i][col.key], col.type, opts.locale).length
    if (len > longest) longest = len
  }
  const total = opts.totals?.[col.key]
  if (total !== undefined) {
    longest = Math.max(longest, format(total, col.type, opts.locale).length)
  }
  return longest
}

/**
 * Turn the columns' weights into percentages that always add up to 100.
 *
 * A column is never narrower than the wider of (a) its heading's longest word and (b) its
 * widest value. Under `table-layout: fixed` neither can reflow out of the way: a heading that
 * does not fit used to be broken mid-word, and now that it is not, it would be clipped; a
 * value that does not fit is clipped (`nowrap`) or wraps mid-number. Both were visible on the
 * Bulgarian sales register — „Платени" is wider than any amount beneath it, while the grand
 * total „12 451,36" is wider than the „Общо" above it.
 */
function widths(cols: ReportPdfColumn[], opts: ReportPdfOptions): string[] {
  const weights = cols.map(c => {
    if (c.weight !== undefined) return c.weight
    // A date and a number are known-width values, so they take a floor from their content
    // rather than the free-text default — in a wide register that default was crowding out
    // the columns that actually needed the room.
    const sized = isNumeric(c.type) || c.type === 'date'
    const base = sized ? 10 : 18
    const headerFloor = longestWord(c.header) * WEIGHT_PER_HEADER_CHAR + WEIGHT_PADDING
    const valueFloor = sized ? longestValue(c, opts) * WEIGHT_PER_VALUE_CHAR + WEIGHT_PADDING : 0
    return Math.max(base, headerFloor, valueFloor)
  })
  const sum = weights.reduce((a, b) => a + b, 0) || 1
  return weights.map(w => `${((w / sum) * 100).toFixed(2)}%`)
}

/**
 * Beyond this many columns the headings, not the values, decide how wide the table wants to
 * be, and the head switches to the tighter `dense` treatment. Ten columns is where an A4
 * landscape page stops having room for a two-word Bulgarian heading at 8.5pt.
 */
const DENSE_COLUMN_COUNT = 10

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

  // The report's bottom line gets the closing rule. A column the report names takes it, and
  // closes the box wherever it sits in the table. Otherwise it is the last money column, which
  // is right only while the table ends on its total: the document registers end on their
  // method columns, and printed „Платени по банка" as their bottom line until they named `total`.
  const named = opts.grandKey ? totalled.find(c => c.key === opts.grandKey) : undefined
  const grandKey = named?.key ?? [...totalled].reverse().find(c => c.type === 'money')?.key

  const lines = totalled.map(c => ({
    label: c.header,
    // Only money carries the currency; a quantity total is a count of things.
    value: format(totals[c.key], c.type, opts.locale) + (c.type === 'money' ? suffix : ''),
    grand: c.key === grandKey,
  }))
  return named ? [...lines.filter(l => !l.grand), ...lines.filter(l => l.grand)] : lines
}

/**
 * Build the document body. Exported so the layout can be asserted without launching
 * Chromium — the same contract `buildListHtml` / `buildCashAggHtml` offer.
 */
export function buildReportHtml(opts: ReportPdfOptions): { html: string; css: string; landscape: boolean } {
  const cols = opts.columns
  const w = widths(cols, opts)
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
          // `nowrap` as in the body: a sum is the widest figure in its column and was wrapping
          // mid-number („12 451,3" / „6") when it outgrew a heading-sized column.
          const cls = `a-${isNumeric(c.type) ? 'right' : 'left'}${isNumeric(c.type) ? ' nowrap' : ''}`
          if (i === 0) return `<td class="${cls}">${esc(opts.totalsLabel || 'Total')}</td>`
          const t = opts.totals![c.key]
          return `<td class="${cls}">${t === undefined ? '' : esc(format(t, c.type, opts.locale))}</td>`
        })
        .join('')}</tr>`
    : ''

  const dense = cols.length > DENSE_COLUMN_COUNT
  const table = opts.rows.length
    ? `<table class="lines${dense ? ' dense' : ''}">${head}<tbody>${body}${totalsRow}</tbody></table>`
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
