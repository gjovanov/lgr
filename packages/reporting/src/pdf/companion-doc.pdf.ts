import { markdownToPdf } from './base.pdf.js'
import { logoImgTag, LOGO_CSS } from './logo.js'
import { productCredit } from '../product-credit.js'
import { companionDocI18n, type CompanionDocKind } from '../companion-doc.i18n.js'
import { unitLabel } from '../unit.i18n.js'

export interface CompanionParty {
  name: string
  city?: string
  address?: string
  taxId?: string
}

export interface CompanionLine {
  name: string
  unit?: string
  quantity: number
  /** Certificate: the certificate reference for the item. Protocol: the remark column. */
  note?: string
}

export interface CompanionSourceDoc {
  label: string
  number: string
  date: Date | string
}

export interface CompanionDocData {
  kind: CompanionDocKind
  number: string
  date: Date | string
  recipient: CompanionParty
  supplier: CompanionParty
  lines: CompanionLine[]
  sourceDocs: CompanionSourceDoc[]
  additionalInfo?: string
  /** "Съставил" — author name, optionally followed by the fiscal operator code. */
  preparedBy?: string
  /** The issuing org's letterhead logo; falls back to the bundled asset when absent. */
  logo?: string
  /** Bottom-of-page line above the rule — the issuing org's contact details. Where the legacy
   * forms printed the ПЛЮС МИНУС product line, LGR prints who actually issued the document. */
  footerText?: string
  locale?: string
}

/** Bulgarian short date, matching the legacy forms: 07.08.2026. */
function fmtDate(d: Date | string): string {
  const date = d instanceof Date ? d : new Date(d)
  if (Number.isNaN(date.getTime())) return ''
  const dd = String(date.getDate()).padStart(2, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  return `${dd}.${mm}.${date.getFullYear()}`
}

/** Quantities print bare on the certificate and with 3 decimals on the protocol. */
function fmtQty(q: number, decimals: number): string {
  return Number(q || 0).toFixed(decimals)
}

function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * md-to-pdf renders through github-markdown-css, which boxes tables in borders, stripes rows
 * and caps the body width. Everything below therefore resets those defaults explicitly rather
 * than relying on the cascade.
 */
const CSS = `
  ${LOGO_CSS}
  body { font-family: "DejaVu Sans", "Liberation Sans", Arial, sans-serif; font-size: 9.5pt;
    color: #000; max-width: none; padding: 0 0 14mm 0; margin: 0; }
  table { border-collapse: collapse; border: 0; display: table; width: 100%; margin: 0; }
  table tr, table tbody tr, table tbody tr:nth-child(2n) { background: transparent; border: 0; }
  table td, table th { border: 0; }
  table.top-bar { margin-bottom: 16px; }
  table.top-bar td.title-cell { text-align: center; vertical-align: top; width: 70%; }
  table.top-bar td.meta-cell { vertical-align: top; width: 30%; }
  h1.doc-title { font-size: 15pt; font-weight: 700; margin: 0; letter-spacing: .3px; line-height: 1.25; }
  table.meta { font-size: 9pt; width: auto; margin-left: auto; }
  table.meta td { padding: 0 0 1px 0; white-space: nowrap; }
  table.meta td.k { text-align: right; padding-right: 10px; }
  table.meta td.v { text-align: right; font-weight: 700; }
  table.parties { margin-bottom: 14px; font-size: 9pt; }
  table.parties td { padding: 2px 0; vertical-align: top; }
  table.parties td.k { width: 13%; padding-left: 4px; }
  table.parties td.v { width: 31%; }
  table.parties td.gap { width: 6%; }
  table.parties tr.band td { background: #ebebeb; font-weight: 700; padding: 3px 0; }
  table.parties tr.band td.gap { background: transparent; }
  table.lines { font-size: 9pt; }
  table.lines thead th { border-bottom: 1px solid #000; border-top: 1px solid #000;
    padding: 4px 6px; font-weight: 700; background: #f2f2f2; }
  table.lines tbody td { padding: 3px 6px; vertical-align: top; }
  table.lines tbody tr:last-child td { border-bottom: 1px solid #000; }
  table.lines .c-no { width: 6%; }
  /* Wide enough for the spelled-out „Мярка" / „Количество" headings (#127) without wrapping. */
  table.lines .c-unit { width: 11%; text-align: center; }
  table.lines .c-qty { width: 15%; text-align: right; }
  table.lines .c-note { width: 18%; }
  /* Boxed document total, in the visual language of the printed invoice's totals block. */
  table.totals { margin-top: 10px; font-size: 9pt; page-break-inside: avoid; }
  table.totals td.spacer { width: 58%; }
  table.totals td.box-cell { width: 42%; }
  .totals-box { border: 1px solid #000; border-radius: 6px; padding: 5px 14px 6px 12px;
    margin-right: 1px; }
  table.tbox td { padding: 0 0 1px 0; }
  table.tbox td.tk { text-align: left; padding-right: 10px; font-size: 9.5pt; font-weight: 700; }
  table.tbox td.tv { text-align: right; white-space: nowrap; font-weight: 700; font-size: 13pt;
    line-height: 1.25; }
  p.legal { margin: 14px 0 0 0; text-align: justify; font-size: 8.5pt; line-height: 1.35; }
  .block { margin-top: 12px; font-size: 8.5pt; }
  .block p { margin: 0; }
  table.signatures { margin-top: 34px; font-size: 9pt; }
  table.signatures td { vertical-align: top; padding-top: 2px; }
  table.signatures td.sig-mark { padding-top: 16px; padding-left: 26px; }
  .sig-name { text-align: center; margin-top: 2px; }
  .sig-rule { display: inline-block; min-width: 230px; border-bottom: 1px dotted #000; }
  /* Chrome repeats fixed-position boxes on every printed page, giving the legacy forms'
     page-foot rule + issuer line without a headerTemplate. body padding reserves its space. */
  .page-foot { position: fixed; left: 0; right: 0; bottom: 0; border-top: 1px solid #000;
    padding-top: 3px; font-size: 7.5pt; color: #000; display: flex; justify-content: space-between; gap: 8px; }
  .page-foot .credit { white-space: nowrap; }
`

/**
 * marked treats a 4-space-indented line as a code block and a blank line as the end of an HTML
 * block, so the whole document must reach it flush-left and gap-free — otherwise the markup
 * prints as literal source. Collapsing the template's own indentation here keeps the builders
 * above readable.
 */
function flattenHtml(html: string): string {
  return html
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .join('\n')
}

/**
 * Build the page body. Exported so the layout can be asserted (and previewed) without
 * launching Chromium; `generateCompanionDocPDF` is the only production caller.
 */
export function buildCompanionHtml(data: CompanionDocData): { html: string; css: string } {
  const i18n = companionDocI18n(data.locale)
  const L = i18n.label
  const H = i18n.header
  const isCertificate = data.kind === 'certificate'

  // Both kinds spell the unit and quantity headings out (#127); only the last column and the
  // quantity precision still differ between them.
  const noteHeader = isCertificate ? H.certificate : H.remark
  const qtyDecimals = isCertificate ? 0 : 3

  // Parties block as on the statutory invoice form: the two names on a shaded band, their
  // details in the rows beneath, with a gutter column keeping the pair apart.
  const partyRow = (key: string, left?: string, right?: string) => `
    <tr>
      <td class="k">${esc(key)}</td><td class="v">${esc(left || '')}</td>
      <td class="gap"></td>
      <td class="k">${esc(key)}</td><td class="v">${esc(right || '')}</td>
    </tr>`

  const parties = `
    <table class="parties">
      <tr class="band">
        <td class="k">${esc(L.recipient)}</td><td class="v">${esc(data.recipient.name)}</td>
        <td class="gap"></td>
        <td class="k">${esc(L.supplier)}</td><td class="v">${esc(data.supplier.name)}</td>
      </tr>
      ${partyRow(L.city, data.recipient.city, data.supplier.city)}
      ${partyRow(L.address, data.recipient.address, data.supplier.address)}
      ${partyRow(L.taxId, data.recipient.taxId, data.supplier.taxId)}
    </table>`

  const rows = data.lines.map((l, i) => `
      <tr>
        <td class="c-no">${i + 1}</td>
        <td>${esc(l.name)}</td>
        <td class="c-unit">${esc(unitLabel(l.unit, data.locale))}</td>
        <td class="c-qty">${fmtQty(l.quantity, qtyDecimals)}</td>
        <td class="c-note">${esc(l.note || '')}</td>
      </tr>`).join('')

  const table = `
    <table class="lines">
      <thead>
        <tr>
          <th class="c-no">${esc(H.lineNo)}</th>
          <th>${esc(H.name)}</th>
          <th class="c-unit">${esc(H.unit)}</th>
          <th class="c-qty">${esc(H.quantity)}</th>
          <th class="c-note">${esc(noteHeader)}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`

  // Total quantity handed over, boxed at the right in the visual language of the printed
  // invoice's totals block. Both companion kinds carry it; these documents state what was
  // delivered, never what it cost — there are no prices anywhere on them.
  const totalQty = data.lines.reduce((s, l) => s + Number(l.quantity || 0), 0)
  const totalBox = data.lines.length ? `
    <table class="totals">
      <tr>
        <td class="spacer"></td>
        <td class="box-cell">
          <div class="totals-box">
            <table class="tbox">
              <tr><td class="tk">${esc(i18n.total)}:</td><td class="tv">${fmtQty(totalQty, qtyDecimals)}</td></tr>
            </table>
          </div>
        </td>
      </tr>
    </table>` : ''

  const docRefs = data.sourceDocs
    .map(d => `<p class="doc-ref">-${esc(d.label)} № ${esc(d.number)} ${esc(data.locale === 'bg' ? 'от' : '/')} ${fmtDate(d.date)}</p>`)
    .join('')

  // The certificate is signed only by its author; the protocol is countersigned by the receiver.
  const signatures = isCertificate
    ? `<table class="signatures">
         <tr>
           <td style="width:52%"></td>
           <td style="width:14%">${esc(L.preparedBy)}:</td>
           <td><span class="sig-rule"></span>
             ${data.preparedBy ? `<div class="sig-name">/${esc(data.preparedBy)}/</div>` : ''}
           </td>
         </tr>
       </table>`
    : `<table class="signatures">
         <tr>
           <td style="width:50%">${esc(L.receivedBy)}:</td>
           <td>${esc(L.preparedBy)}: ${esc(data.preparedBy || '')}</td>
         </tr>
         <tr>
           <td class="sig-mark">${esc(L.signature)}</td>
           <td class="sig-mark">${esc(L.signature)}</td>
         </tr>
       </table>`

  // Letterhead on its own line above the title, as on the invoice form and the list report.
  const logoImg = logoImgTag(data.logo)
  const topBar = `
    ${logoImg ? `<div class="logo-bar">${logoImg}</div>` : ''}
    <table class="top-bar">
      <tr>
        <td class="title-cell"><h1 class="doc-title">${esc(i18n.title[data.kind])}</h1></td>
        <td class="meta-cell">
          <table class="meta">
            <tr><td class="k">${esc(L.number)}:</td><td class="v">${esc(data.number)}</td></tr>
            <tr><td class="k">${esc(L.date)}:</td><td class="v">${fmtDate(data.date)}</td></tr>
          </table>
        </td>
      </tr>
    </table>`

  const html = `
${topBar}
${parties}
${table}
${totalBox}
<p class="legal">${esc(i18n.body[data.kind])}</p>
<div class="block">
  <p>${esc(L.docList[data.kind])}</p>
  ${docRefs}
</div>
<div class="block">
  <p>${esc(L.additionalInfo)} ${esc(data.additionalInfo || '')}</p>
</div>
${signatures}
<div class="page-foot"><span>${esc(data.footerText || '')}</span><span class="credit">${esc(productCredit(data.locale))}</span></div>
`

  return { html: flattenHtml(html), css: CSS }
}

/**
 * Render one of the two companion documents (Декларация за съответствие / Приемо-предавателен
 * протокол) as a fixed-form A4 page. Layout mirrors the legacy PlusMinus forms these replace:
 * letterhead logo, centred title with number/date at the right, a two-column recipient-vs-
 * supplier block, the line table, the legal paragraph, the source-document reference and the
 * signature lines.
 */
export async function generateCompanionDocPDF(data: CompanionDocData): Promise<Buffer | undefined> {
  const { html, css } = buildCompanionHtml(data)
  return markdownToPdf(html, {
    css,
    margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
    // The form paints its own `.page-foot` (issuer line + software credit).
    defaultFooter: false,
  })
}
