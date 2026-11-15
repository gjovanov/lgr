import { markdownToPdf, escHtml as esc, fmtDate, flattenHtml } from './base.pdf.js'
import { logoImgTag, LOGO_CSS } from './logo.js'
import { GRID_CELL_PADDING_X, GRID_FIT_CLASS, LINE_GRID_CSS } from './line-grid.js'
import { pageMargin } from './page-margins.js'
import { productCredit } from '../product-credit.js'
import { stockMovementI18n, stockMovementTitleKind } from '../stock-movement.i18n.js'
import { unitLabel } from '../unit.i18n.js'

/**
 * A stock movement as a printed document: what moved, from which warehouse to which, on which day.
 *
 * It goes with the goods, and on a transfer to the people on the other side: a warehouse that is
 * another site's is marked „(външен)", because nothing was booked on it here. The title follows the
 * type: a receipt is a „Стокова разписка", a transfer a „Складова разписка", and any other type
 * prints under a general title with a row that names the type as the screens do.
 *
 * ⚠ No price and no total, on purpose. A movement's `unitCost` is a cost figure (on a dispatch born
 * of a sale, the sale price) that not every role may see, and this sheet leaves the org. The bill's
 * „Складова разписка" (`stock-receipt.pdf.ts`) is the sheet that carries a price, and it asks which.
 *
 * Its own CSS, as every document form has (`stock-receipt.pdf.ts`, `companion-doc.pdf.ts`). What
 * the forms share is the page's side margins (`page-margins.ts`), the line grid's edges, column
 * sizing and gutter (`line-grid.ts`), the logo and the page foot.
 */

/** The note is cut at this many characters: it is a remark on the sheet, not a second page. */
export const STOCK_MOVEMENT_NOTE_MAX = 500

export interface StockMovementLine {
  name: string
  /** The canonical unit code (`pcs`); printed as the locale's abbreviation. */
  unit?: string
  quantity: number
}

export interface StockMovementWarehouse {
  name: string
  /** Another site's warehouse: its stock is not kept, and was not changed, here. */
  external?: boolean
}

export interface StockMovementData {
  /** The movement's number (SM-…). */
  number: string
  date: Date | string
  /** `receipt`, `transfer`, `dispatch`, …: what the title and the type row are drawn from. */
  type: string
  /** Not booked yet: said beside the number. */
  draft?: boolean
  from?: StockMovementWarehouse | null
  to?: StockMovementWarehouse | null
  /** The supplier, the customer or whoever else the movement names. */
  partner?: string
  /** The source document the movement was booked from. */
  reference?: string
  note?: string
  lines: StockMovementLine[]
  /** The issuing org's letterhead logo; falls back to the bundled asset when absent. */
  logo?: string
  /** Bottom-of-page issuer line above the rule, as on the invoice and the companion forms. */
  footerText?: string
  locale?: string
}

/** Quantities print without trailing zeros ("16", "2.5"), as on the invoice form. */
function fmtQty(q: unknown): string {
  const n = Number(q ?? 0)
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)))
}

/** The note as it prints: trimmed, and cut where it would start to run the sheet. */
export function stockMovementNote(note: unknown): string {
  const text = String(note ?? '').trim()
  return text.length > STOCK_MOVEMENT_NOTE_MAX ? `${text.slice(0, STOCK_MOVEMENT_NOTE_MAX).trimEnd()}…` : text
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
  /* A note is prose: it wraps, at normal weight. */
  table.info td.v.note { font-weight: 400; }
  table.lines { font-size: 9pt; }
  table.lines thead th { border-bottom: 1px solid #000; border-top: 1px solid #000;
    padding: 4px ${GRID_CELL_PADDING_X}; font-weight: 700; background: #f2f2f2; }
  table.lines tbody td { padding: 3px ${GRID_CELL_PADDING_X}; vertical-align: top; }
  table.lines tbody tr:last-child td { border-bottom: 1px solid #000; }
  ${LINE_GRID_CSS}
  /* Every column but the name is fitted to its contents (line-grid.ts); the heading over the
     line numbers sits flush left with them. */
  table.lines .c-no { text-align: left; }
  table.lines .c-unit { text-align: center; }
  table.lines .c-qty { text-align: right; }
  table.signatures { margin-top: 34px; font-size: 9pt; page-break-inside: avoid; }
  table.signatures td { width: 50%; vertical-align: top; padding: 2px 0 0 0; }
  table.signatures td.sig-line { padding-top: 16px; }
  .sig-rule { display: inline-block; min-width: 200px; border-bottom: 1px dotted #000; }
  /* Chrome repeats fixed-position boxes on every printed page; body padding reserves the space. */
  .page-foot { position: fixed; left: 0; right: 0; bottom: 0; border-top: 1px solid #000;
    padding-top: 3px; font-size: 7.5pt; color: #000; display: flex; justify-content: space-between; gap: 8px; }
  .page-foot .credit { white-space: nowrap; }
`

/**
 * Build the page body. Exported so the layout can be asserted (and previewed) without launching
 * Chromium; `generateStockMovementPDF` is the only production caller.
 */
export function buildStockMovementHtml(data: StockMovementData): { html: string; css: string } {
  const i18n = stockMovementI18n(data.locale)
  const L = i18n.label
  const H = i18n.header
  const logoImg = logoImgTag(data.logo)
  const kind = stockMovementTitleKind(data.type)

  const warehouse = (w?: StockMovementWarehouse | null) =>
    w?.name ? `${esc(String(w.name).replace(/\s+/g, ' ').trim())}${w.external ? ` (${esc(L.external)})` : ''}` : ''
  const info = (label: string, value: string, cls = '') =>
    value ? `<tr><td class="k">${esc(label)}:</td><td class="v${cls ? ` ${cls}` : ''}">${value}</td></tr>` : ''
  /** One line of text: the page is handed to a Markdown renderer, where a line break inside a cell ends the table. */
  const oneLine = (v: unknown) => esc(String(v ?? '').replace(/\s+/g, ' ').trim())
  // The note keeps the line breaks it was typed with, as breaks: never as new lines in the page's source.
  const note = stockMovementNote(data.note).split(/\r?\n/).map(l => esc(l.trim())).filter(Boolean).join('<br>')

  const infoRows = [
    // The general title does not say what kind of movement this is: the row does.
    kind === 'other' ? info(L.type, oneLine(i18n.type[data.type] || data.type)) : '',
    info(L.fromWarehouse, warehouse(data.from)),
    info(L.toWarehouse, warehouse(data.to)),
    info(L.partner, oneLine(data.partner)),
    info(L.reference, oneLine(data.reference)),
    info(L.note, note, 'note'),
  ].join('')

  const fit = GRID_FIT_CLASS
  const rows = data.lines.map((l, i) => `
      <tr>
        <td class="c-no ${fit}">${i + 1}</td>
        <td>${oneLine(l.name)}</td>
        <td class="c-unit ${fit}">${esc(unitLabel(l.unit, data.locale))}</td>
        <td class="c-qty ${fit}">${fmtQty(l.quantity)}</td>
      </tr>`).join('')

  const html = `
      ${logoImg ? `<div class="logo-bar">${logoImg}</div>` : ''}
      <table class="top-bar">
        <tr>
          <td class="side-cell"></td>
          <td class="title-cell"><h1 class="doc-title">${esc(i18n.title[kind])}</h1></td>
          <td class="meta-cell">
            <table class="meta">
              <tr><td class="k">${esc(L.number)}:</td><td class="v">${esc(data.number)}${data.draft ? ` (${esc(L.draft)})` : ''}</td></tr>
              <tr><td class="k">${esc(L.date)}:</td><td class="v">${fmtDate(data.date)}</td></tr>
            </table>
          </td>
        </tr>
      </table>
      ${infoRows ? `<table class="info">${infoRows}</table>` : ''}
      <table class="lines">
        <thead>
          <tr>
            <th class="c-no ${fit}">${esc(H.lineNo)}</th>
            <th>${esc(H.name)}</th>
            <th class="c-unit ${fit}">${esc(H.unit)}</th>
            <th class="c-qty ${fit}">${esc(H.quantity)}</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
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
      </table>
<div class="page-foot"><span>${esc(data.footerText || '')}</span><span class="credit">${esc(productCredit(data.locale))}</span></div>
`

  return { html: flattenHtml(html), css: CSS }
}

/** The movement's page: its own top and bottom, the shared sides (page-margins.ts). */
export const STOCK_MOVEMENT_MARGIN = pageMargin('14mm', '14mm')

/** Render the movement of `buildStockMovementHtml` to an A4 PDF. */
export async function generateStockMovementPDF(data: StockMovementData): Promise<Buffer | undefined> {
  const { html, css } = buildStockMovementHtml(data)
  return markdownToPdf(html, {
    css,
    margin: STOCK_MOVEMENT_MARGIN,
    // The form paints its own `.page-foot` (issuer line + software credit).
    defaultFooter: false,
  })
}
