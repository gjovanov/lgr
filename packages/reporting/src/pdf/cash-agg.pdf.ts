import { markdownToPdf, escHtml as esc, fmtDate, flattenHtml } from './base.pdf.js'
import { exportI18n } from '../i18n.js'
import { logoImgTag, LOGO_CSS } from './logo.js'
import { productCredit } from '../product-credit.js'
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

const CSS = `
  ${LOGO_CSS}
  body { font-family: "DejaVu Sans", "Liberation Sans", Arial, sans-serif; font-size: 8.5pt;
    color: #000; max-width: none; padding: 0; margin: 0; }
  table { border-collapse: collapse; border: 0; display: table; width: 100%; margin: 0; }
  table tr, table tbody tr, table tbody tr:nth-child(2n) { background: transparent; border: 0; }
  table td, table th { border: 0; }
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
  table.lines tbody tr:nth-child(even) td { background: #f6f6f6; }
  table.lines tbody tr:last-child td { border-bottom: 1px solid #000; }
  table.lines tbody tr.grand-row td { background: #ebebeb; font-weight: 700;
    border-top: 1px solid #000; }
  table.lines tbody tr.currency-row td { font-weight: 700; padding-top: 6px; }
  p.empty-note { margin: 14px 0 0 0; font-size: 9pt; font-style: italic; }
  .a-left { text-align: left; }
  .a-right { text-align: right; }
  td.nowrap, th.nowrap { white-space: nowrap; }
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

function periodText(period: PdfOptions['period']): string {
  if (!period) return ''
  const from = fmtDate(period.from as any)
  const to = fmtDate(period.to as any)
  if (from && to) return `${from} – ${to}`
  return from || to || ''
}

function footerTemplate(text: string, locale?: string): string {
  return `<div style="width:100%;font-family:'DejaVu Sans',Arial,sans-serif;font-size:7pt;color:#000;padding:0 12mm;display:flex;justify-content:space-between;gap:8px;border-top:1px solid #000;padding-top:3px;">
    <span>${esc(text)}</span>
    <span style="white-space:nowrap">${esc(productCredit(locale))}</span>
    <span style="white-space:nowrap"><span class="pageNumber"></span> / <span class="totalPages"></span></span>
  </div>`
}

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
  const metaRows = [
    period ? `<tr><td class="k">${esc(i18n.meta.period)}:</td><td class="v">${esc(period)}</td></tr>` : '',
    `<tr><td class="k">${esc(i18n.meta.generated)}:</td><td class="v">${fmtDate(new Date())}</td></tr>`,
    `<tr><td class="k">${esc(i18n.meta.rows)}:</td><td class="v">${rowCount}</td></tr>`,
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
    margin: { top: '12mm', bottom: '16mm', left: '12mm', right: '12mm' },
    footerHtml: footerTemplate(footText, opts.locale as string | undefined),
  })
}
