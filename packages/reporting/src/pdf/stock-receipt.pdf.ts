import { markdownToPdf, escHtml as esc, fmtDate, currencyMark, flattenHtml } from './base.pdf.js'
import { logoImgTag, LOGO_CSS } from './logo.js'
import { productCredit } from '../product-credit.js'
import { stockReceiptI18n } from '../stock-receipt.i18n.js'
import { unitLabel } from '../unit.i18n.js'

/**
 * „Стокова разписка" — the goods a supplier bill booked into stock, printed from the bill.
 *
 * One section per receipt movement the bill booked (a bill whose lines go to two warehouses books
 * two), each on its own page: the title, the movement's number and date, its warehouse, the bill
 * it came with — OUR bill, by its number and date — the received lines with their prices, the
 * value before VAT and the two signature lines. There is no supplier block and no supplier invoice
 * number on it: it records what came into which warehouse, not who invoiced it.
 *
 * Its own CSS, as the companion documents have theirs (`companion-doc.pdf.ts`); the invoice
 * layout (`invoice.pdf.ts`) is frozen and is not shared.
 */

export interface StockReceiptLine {
  name: string
  /** The canonical unit code (`pcs`); printed as the locale's abbreviation. */
  unit?: string
  quantity: number
  /** What the goods were booked at — the bill's own unit price, on a bill that received them. */
  unitPrice: number
}

export interface StockReceiptSection {
  /** The receipt movement's number (SM-…). */
  number: string
  /** The day the goods were booked. */
  date: Date | string
  warehouse: string
  lines: StockReceiptLine[]
}

export interface StockReceiptData {
  sections: StockReceiptSection[]
  /** The bill the goods came with: OUR number and date. A draft's number is marked as such. */
  bill: { number: string; date: Date | string; draft?: boolean }
  /** The bill's currency: what the prices and the total are in. */
  currency: string
  /** The issuing org's letterhead logo; falls back to the bundled asset when absent. */
  logo?: string
  /** Bottom-of-page issuer line above the rule, as on the invoice and the companion forms. */
  footerText?: string
  locale?: string
}

function round2(v: number): number {
  return Math.round((Number(v) || 0) * 100) / 100
}

/** Quantities print without trailing zeros ("16", "2.5"), as on the invoice form. */
function fmtQty(q: unknown): string {
  const n = Number(q ?? 0)
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)))
}

/**
 * A unit price to four decimals, never fewer than two: a fastener's 0.0472 is not 0.05, and the
 * receipt carries the price the goods were booked at (the product list's `formatUnitPrice` rule).
 */
function fmtPrice(v: unknown): string {
  const s = (Number(v) || 0).toFixed(4)
  return s.replace(/(\.\d\d)(\d*?)0+$/, '$1$2')
}

function fmtMoney(v: unknown): string {
  return round2(Number(v)).toFixed(2)
}

/** The value of one line as printed: quantity × price, to the cent. The total adds these. */
function lineAmount(l: StockReceiptLine): number {
  return round2(Number(l.quantity || 0) * Number(l.unitPrice || 0))
}

/**
 * md-to-pdf renders through github-markdown-css, which boxes tables in borders, stripes rows and
 * caps the body width. Everything below therefore resets those defaults explicitly rather than
 * relying on the cascade.
 */
const CSS = `
  ${LOGO_CSS}
  body { font-family: "DejaVu Sans", "Liberation Sans", Arial, sans-serif; font-size: 9.5pt;
    color: #000; max-width: none; padding: 0 0 14mm 0; margin: 0; }
  table { border-collapse: collapse; border: 0; display: table; width: 100%; margin: 0; }
  table tr, table tbody tr, table tbody tr:nth-child(2n) { background: transparent; border: 0; }
  table td, table th { border: 0; }
  table.top-bar { margin-bottom: 14px; }
  /* The spacer and the meta cell are equal, so the title sits centred on the page. */
  table.top-bar td.side-cell { width: 27%; }
  table.top-bar td.title-cell { text-align: center; vertical-align: top; width: 46%; }
  table.top-bar td.meta-cell { vertical-align: top; width: 27%; }
  h1.doc-title { font-size: 15pt; font-weight: 700; margin: 0; letter-spacing: .3px; line-height: 1.25; }
  table.meta { font-size: 9pt; width: auto; margin-left: auto; }
  table.meta td { padding: 0 0 1px 0; white-space: nowrap; }
  table.meta td.k { text-align: right; padding-right: 10px; }
  table.meta td.v { text-align: right; font-weight: 700; }
  table.info { margin-bottom: 14px; font-size: 9pt; width: auto; }
  table.info td { padding: 1px 0; vertical-align: top; }
  table.info td.k { padding-right: 10px; white-space: nowrap; }
  table.info td.v { font-weight: 700; }
  table.lines { font-size: 9pt; }
  table.lines thead th { border-bottom: 1px solid #000; border-top: 1px solid #000;
    padding: 4px 6px; font-weight: 700; background: #f2f2f2; }
  table.lines tbody td { padding: 3px 6px; vertical-align: top; }
  table.lines tbody tr:last-child td { border-bottom: 1px solid #000; }
  table.lines .c-no { width: 6%; }
  table.lines .c-unit { width: 10%; text-align: center; }
  table.lines .c-qty { width: 13%; text-align: right; }
  table.lines .c-price { width: 13%; text-align: right; }
  table.lines .c-amount { width: 14%; text-align: right; }
  /* Boxed total, in the visual language of the printed invoice's totals block. */
  table.totals { margin-top: 10px; font-size: 9pt; page-break-inside: avoid; }
  table.totals td.spacer { width: 52%; }
  table.totals td.box-cell { width: 48%; }
  .totals-box { border: 1px solid #000; border-radius: 6px; padding: 5px 14px 6px 12px;
    margin-right: 1px; }
  table.tbox td { padding: 0 0 1px 0; }
  table.tbox td.tk { text-align: left; padding-right: 10px; font-size: 9.5pt; font-weight: 700; }
  table.tbox td.tv { text-align: right; white-space: nowrap; font-weight: 700; font-size: 13pt;
    line-height: 1.25; }
  table.signatures { margin-top: 34px; font-size: 9pt; page-break-inside: avoid; }
  table.signatures td { width: 50%; vertical-align: top; padding: 2px 0 0 0; }
  table.signatures td.sig-line { padding-top: 16px; }
  .sig-rule { display: inline-block; min-width: 200px; border-bottom: 1px dotted #000; }
  /* Each receipt is a document of its own: it starts on a fresh page. */
  .section-break { page-break-before: always; break-before: page; }
  /* Chrome repeats fixed-position boxes on every printed page; body padding reserves the space. */
  .page-foot { position: fixed; left: 0; right: 0; bottom: 0; border-top: 1px solid #000;
    padding-top: 3px; font-size: 7.5pt; color: #000; display: flex; justify-content: space-between; gap: 8px; }
  .page-foot .credit { white-space: nowrap; }
`

/**
 * Build the page body. Exported so the layout can be asserted (and previewed) without launching
 * Chromium; `generateStockReceiptPDF` is the only production caller.
 */
export function buildStockReceiptHtml(data: StockReceiptData): { html: string; css: string } {
  const i18n = stockReceiptI18n(data.locale)
  const L = i18n.label
  const H = i18n.header
  const cur = currencyMark(data.currency)
  const logoImg = logoImgTag(data.logo)

  const billRef = `№ ${esc(data.bill.number)} ${esc(L.of)} ${fmtDate(data.bill.date)}${data.bill.draft ? ` (${esc(L.draft)})` : ''}`

  const section = (s: StockReceiptSection) => {
    const rows = s.lines.map((l, i) => `
      <tr>
        <td class="c-no">${i + 1}</td>
        <td>${esc(l.name)}</td>
        <td class="c-unit">${esc(unitLabel(l.unit, data.locale))}</td>
        <td class="c-qty">${fmtQty(l.quantity)}</td>
        <td class="c-price">${fmtPrice(l.unitPrice)}</td>
        <td class="c-amount">${fmtMoney(lineAmount(l))}</td>
      </tr>`).join('')
    const total = round2(s.lines.reduce((sum, l) => sum + lineAmount(l), 0))
    return `
      ${logoImg ? `<div class="logo-bar">${logoImg}</div>` : ''}
      <table class="top-bar">
        <tr>
          <td class="side-cell"></td>
          <td class="title-cell"><h1 class="doc-title">${esc(i18n.title)}</h1></td>
          <td class="meta-cell">
            <table class="meta">
              <tr><td class="k">${esc(L.number)}:</td><td class="v">${esc(s.number)}</td></tr>
              <tr><td class="k">${esc(L.date)}:</td><td class="v">${fmtDate(s.date)}</td></tr>
            </table>
          </td>
        </tr>
      </table>
      <table class="info">
        <tr><td class="k">${esc(L.warehouse)}:</td><td class="v">${esc(s.warehouse)}</td></tr>
        <tr><td class="k">${esc(L.bill)}:</td><td class="v">${billRef}</td></tr>
      </table>
      <table class="lines">
        <thead>
          <tr>
            <th class="c-no">${esc(H.lineNo)}</th>
            <th>${esc(H.name)}</th>
            <th class="c-unit">${esc(H.unit)}</th>
            <th class="c-qty">${esc(H.quantity)}</th>
            <th class="c-price">${esc(H.unitPrice)}</th>
            <th class="c-amount">${esc(H.amount)}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      <table class="totals">
        <tr>
          <td class="spacer"></td>
          <td class="box-cell">
            <div class="totals-box">
              <table class="tbox">
                <tr><td class="tk">${esc(L.total)}:</td><td class="tv">${fmtMoney(total)} ${esc(cur)}</td></tr>
              </table>
            </div>
          </td>
        </tr>
      </table>
      <table class="signatures">
        <tr>
          <td>${esc(L.handedOverBy)}:</td>
          <td>${esc(L.receivedBy)}:</td>
        </tr>
        <tr>
          <td class="sig-line">${esc(L.signature)}: <span class="sig-rule"></span></td>
          <td class="sig-line">${esc(L.signature)}: <span class="sig-rule"></span></td>
        </tr>
      </table>`
  }

  const html = `
${data.sections.map(section).join('\n<div class="section-break"></div>\n')}
<div class="page-foot"><span>${esc(data.footerText || '')}</span><span class="credit">${esc(productCredit(data.locale))}</span></div>
`

  return { html: flattenHtml(html), css: CSS }
}

/** Render the receipts of `buildStockReceiptHtml` to an A4 PDF, one receipt per page (or more). */
export async function generateStockReceiptPDF(data: StockReceiptData): Promise<Buffer | undefined> {
  const { html, css } = buildStockReceiptHtml(data)
  return markdownToPdf(html, {
    css,
    margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
    // The form paints its own `.page-foot` (issuer line + software credit).
    defaultFooter: false,
  })
}
