/**
 * The house style for every printed LIST/REPORT PDF — one source of truth for the look the
 * document exports established.
 *
 * `invoicing-list.pdf.ts` and `cash-agg.pdf.ts` had grown byte-identical copies of this CSS,
 * of `footerTemplate` and of `periodText`, and the FR-06 report renderer arrived with a third,
 * *different* look (grey grid, 8pt, no meta block). Three copies of a house style is three
 * chances to drift, and the drift had already started. They all import from here now.
 *
 * NOT covered here: the per-document forms (invoice, companion docs). Those are fixed-layout
 * facsimiles of printed paperwork with their own CSS, deliberately.
 *
 * Anything a caller needs beyond this — a totals box, per-currency section rows — is appended
 * to `HOUSE_CSS` by that caller, so the shared part stays shared.
 */

import { escHtml as esc, fmtDate } from './base.pdf.js'
import { LOGO_CSS, logoImgTag } from './logo.js'
import { productCredit } from '../product-credit.js'

/**
 * Shared stylesheet. Extracted verbatim from the two list exports, so their rendering is
 * unchanged — the CSS comments moved with the rules they explain.
 */
export const HOUSE_CSS = `
  ${LOGO_CSS}
  body { font-family: "DejaVu Sans", "Liberation Sans", Arial, sans-serif; font-size: 8.5pt;
    color: #000; max-width: none; padding: 0; margin: 0; }
  table { border-collapse: collapse; border: 0; display: table; width: 100%; margin: 0; }
  table tr, table tbody tr, table tbody tr:nth-child(2n) { background: transparent; border: 0; }
  table td, table th { border: 0; }
  /* The meta block floats out of the flow at the right edge so the title is centred on the
     page itself, not on the space the meta block leaves over. */
  div.top-bar { position: relative; margin-bottom: 12px; min-height: 34px; }
  /* A meta block with filter lines runs past the title; give the table real clearance. */
  div.top-bar.top-bar--tall { margin-bottom: 18px; }
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
  p.empty-note { margin: 14px 0 0 0; font-size: 9pt; font-style: italic; }
  .a-left { text-align: left; }
  .a-right { text-align: right; }
  td.nowrap, th.nowrap { white-space: nowrap; }
  /* Totals box, in the visual language of the printed invoice's totals block. */
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
`

/** Page margins every list/report export prints with. */
export const HOUSE_MARGIN = { top: '12mm', bottom: '16mm', left: '12mm', right: '12mm' }

export interface PeriodLike {
  from?: string | Date
  to?: string | Date
}

/** "01.08.2026 – 31.12.2026", or just one side, or nothing. */
export function periodText(period: PeriodLike | undefined): string {
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
export function footerTemplate(text: string, locale?: string): string {
  return `<div style="width:100%;font-family:'DejaVu Sans',Arial,sans-serif;font-size:7pt;color:#000;padding:0 12mm;display:flex;justify-content:space-between;gap:8px;border-top:1px solid #000;padding-top:3px;">
    <span>${esc(text)}</span>
    <span style="white-space:nowrap">${esc(productCredit(locale))}</span>
    <span style="white-space:nowrap"><span class="pageNumber"></span> / <span class="totalPages"></span></span>
  </div>`
}

export interface MetaRow {
  label: string
  value: string | number
}

/** The right-hand key/value block: period, generated-at, row count, and anything extra. */
export function buildMetaRows(rows: (MetaRow | null | undefined | false)[]): string {
  return rows
    .filter((r): r is MetaRow => !!r)
    .map(r => `<tr><td class="k">${esc(r.label)}:</td><td class="v">${esc(r.value)}</td></tr>`)
    .join('')
}

export interface TopBarOptions {
  title: string
  orgName: string
  /** Org letterhead; falls back to the bundled asset inside `logoImgTag`. */
  logo?: unknown
  /** Pre-rendered meta rows from `buildMetaRows`. */
  metaRows?: string
}

export interface TotalsBoxLine {
  label: string
  /** Already formatted — the box does no number formatting of its own. */
  value: string
  /** The closing line: heavier rule, larger type. */
  grand?: boolean
  /** Opens a group with a hairline above it. */
  separator?: boolean
}

/**
 * The bordered totals block every printed document closes with, right-aligned under the
 * table. Shared so a report closes the same way an invoice list does.
 */
export function buildTotalsBox(lines: TotalsBoxLine[]): string {
  if (!lines.length) return ''
  const rows = lines.map(l => {
    const cls = l.grand ? 'grand' : l.separator ? 'split-head' : ''
    return `<tr class="${cls}"><td class="tk">${esc(l.label)}</td><td class="tv">${esc(l.value)}</td></tr>`
  }).join('')

  return `
    <table class="summary">
      <tr>
        <td class="spacer"></td>
        <td class="box-cell">
          <div class="totals-box">
            <table class="tbox">${rows}</table>
          </div>
        </td>
      </tr>
    </table>`
}

/**
 * Height of one meta row at 8.5pt, plus padding. Measured against the rendered output rather
 * than derived: the meta block is absolutely positioned (below), so this is the only thing
 * keeping it off the table.
 */
const META_ROW_PX = 15

/**
 * The meta block is absolutely positioned, so it contributes nothing to its container's
 * height — with the usual three rows that is invisible, because the title block is taller.
 * A report that adds filter lines overflows and prints over the table header, so the
 * container is given an explicit floor once the meta block is the taller of the two.
 */
function metaRowCount(metaRows: string): number {
  return (metaRows.match(/<tr[\s>]/g) || []).length
}

/** Letterhead + centred title/org + the floating meta block. */
export function buildTopBar(opts: TopBarOptions): string {
  const logoImg = logoImgTag(opts.logo)
  const metaRows = opts.metaRows || ''
  const rows = metaRowCount(metaRows)
  // Below 4 rows the title block is the taller of the two and already sets the height —
  // those documents (every existing export) are left exactly as they were. Above it, the
  // absolutely-positioned meta block would otherwise print over the table head, so the
  // container gets an explicit floor plus a wider gap beneath it.
  const tall = rows > 3
  const style = tall ? ` style="min-height:${rows * META_ROW_PX + 10}px"` : ''
  return `
    ${logoImg ? `<div class="logo-bar">${logoImg}</div>` : ''}
    <div class="top-bar${tall ? ' top-bar--tall' : ''}"${style}>
      <div class="title-block">
        <h1 class="doc-title">${esc(opts.title)}</h1>
        <div class="org-name">${esc(opts.orgName)}</div>
      </div>
      <table class="meta">${metaRows}</table>
    </div>`
}
