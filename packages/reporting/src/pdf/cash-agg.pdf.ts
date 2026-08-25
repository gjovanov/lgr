import { markdownToPdf, escHtml as esc, fmtDate, flattenHtml } from './base.pdf.js'
import { exportI18n } from '../i18n.js'
import {
  HOUSE_CSS,
  HOUSE_MARGIN,
  buildMetaRows,
  buildTopBar,
  footerTemplate,
  periodText,
} from './house-style.js'
import {
  pickAggColumns,
  sectionTotals,
  type CashAggOptions,
  type CashAggRow,
} from '../excel/cash-agg.excel.js'

/**
 * FR-03 (#10): PDF twin of the aggregated cash-register export. Same visual language as
 * invoicing-list.pdf (DejaVu 8.5pt, shaded head band, zebra rows, bold totals line).
 */

interface PdfOptions extends CashAggOptions {
  orgName: string
  period?: { from?: string | Date; to?: string | Date }
  logo?: string
  footerText?: string
}

const NUMBER_LOCALE: Record<string, string> = { en: 'en-US', bg: 'bg-BG', de: 'de-DE', mk: 'mk-MK' }

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

function qty(v: number | undefined | null): string {
  if (v === null || v === undefined) return ''
  const n = Number(v)
  if (Number.isNaN(n)) return ''
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)))
}

// Shared look lives in `house-style.ts`; only the per-currency section row is local.
const CSS = `${HOUSE_CSS}
  table.lines tbody tr.currency-row td { font-weight: 700; padding-top: 6px; }
`

const RIGHT_KEYS = new Set(['totalQuantity', 'avgUnitPrice', 'netTotal', 'taxTotal', 'grossTotal'])
const SUM_KEYS = new Set(['totalQuantity', 'netTotal', 'taxTotal', 'grossTotal'])
const WIDTHS: Record<string, number> = {
  productName: 40, sku: 14, unit: 7, totalQuantity: 9, avgUnitPrice: 10, netTotal: 10, taxTotal: 9, grossTotal: 11,
}

function cellValue(key: string, r: CashAggRow, locale?: string): string {
  switch (key) {
    case 'productName': return esc(r.productName)
    case 'sku': return esc(r.sku || '')
    case 'unit': return esc(r.unit || '')
    case 'totalQuantity': return qty(r.totalQuantity)
    case 'avgUnitPrice': return money(r.avgUnitPrice, locale)
    case 'netTotal': return money(r.netTotal, locale)
    case 'taxTotal': return money(r.taxTotal, locale)
    case 'grossTotal': return money(r.grossTotal, locale)
    default: return ''
  }
}

// `footerTemplate` and `periodText` moved to house-style.ts — they were byte-identical
// copies of the invoicing-list ones.

/** Exported so the layout can be asserted without launching Chromium. */
export function buildCashAggHtml(opts: PdfOptions): { html: string; css: string } {
  const i18n = exportI18n(opts.locale)
  const locale = opts.locale as string | undefined
  const defs = pickAggColumns(opts.columns)
  const keys = defs.map(d => d.key)
  const totalWeight = keys.reduce((s, k) => s + (WIDTHS[k] || 10), 0) || 1
  const widths = keys.map(k => `${(((WIDTHS[k] || 10) / totalWeight) * 100).toFixed(2)}%`)

  const period = periodText(opts.period)
  const rowCount = opts.sections.reduce((s, sec) => s + sec.rows.length, 0)
  const metaRows = buildMetaRows([
    period ? { label: i18n.meta.period, value: period } : null,
    { label: i18n.meta.generated, value: fmtDate(new Date()) },
    { label: i18n.meta.rows, value: rowCount },
  ])

  const topBar = buildTopBar({ title: opts.title, orgName: opts.orgName, logo: opts.logo, metaRows })

  const head = `<thead><tr>${defs.map((d, i) =>
    `<th class="a-${RIGHT_KEYS.has(d.key) ? 'right' : 'left'}" style="width:${widths[i]}">${esc(i18n.header[d.headerKey])}</th>`,
  ).join('')}</tr></thead>`

  const multiCurrency = opts.sections.length > 1
  const bodyRows = opts.sections.map(section => {
    const currencyRow = multiCurrency
      ? `<tr class="currency-row"><td class="a-left" colspan="${keys.length}">${esc(section.currency)}</td></tr>`
      : ''
    const rows = section.rows.map(r =>
      `<tr>${keys.map(k => `<td class="a-${RIGHT_KEYS.has(k) ? 'right nowrap' : 'left'}">${cellValue(k, r, locale)}</td>`).join('')}</tr>`,
    ).join('')
    const totals = sectionTotals(section.rows)
    const labelIdx = Math.max(0, keys.findIndex(k => !SUM_KEYS.has(k)))
    const totalLabel = multiCurrency ? `${i18n.footer.totalLabel} ${section.currency}` : i18n.footer.totalLabel
    const grand = `<tr class="grand-row">${keys.map((k, i) => {
      if (SUM_KEYS.has(k)) {
        const v = k === 'totalQuantity' ? qty((totals as any)[k]) : money((totals as any)[k], locale)
        return `<td class="a-right nowrap">${v}</td>`
      }
      return `<td class="a-left">${i === labelIdx ? esc(totalLabel) : ''}</td>`
    }).join('')}</tr>`
    return currencyRow + rows + grand
  }).join('')

  const body = rowCount
    ? `<table class="lines">${head}<tbody>${bodyRows}</tbody></table>`
    : `<p class="empty-note">${esc(i18n.footer.noLines)}</p>`

  return { html: flattenHtml(`${topBar}\n${body}`), css: CSS }
}

export async function generateCashAggPDF(opts: PdfOptions): Promise<Buffer | undefined> {
  const { html, css } = buildCashAggHtml(opts)
  const footText = opts.footerText || `${opts.orgName} · ${opts.title}`
  return markdownToPdf(html, {
    css,
    margin: HOUSE_MARGIN,
    footerHtml: footerTemplate(footText, opts.locale as string | undefined),
  })
}
