import type { IInvoice, IOrg, IContact } from 'db/models'
import { markdownToPdf, escHtml as esc, fmtDate, currencyMark, flattenHtml } from './base.pdf.js'
import { invoiceDocI18n, invoiceDocTitle, AMOUNT_IN_WORDS_RE } from '../invoice-doc.i18n.js'
import { productCredit } from '../product-credit.js'
import { logoImgTag, LOGO_CSS } from './logo.js'

/**
 * Line-item columns, keyed to the shared export catalog (ui-shared useExportColumns
 * + invoice-export.controller ALLOWED_COLUMN_KEYS). When `columns` is supplied the
 * table renders only the selected line columns (so e.g. unchecking Discount in the
 * print dialog actually drops the column); when omitted, the statutory set renders.
 */
type LineColKey = 'lineNo' | 'description' | 'unit' | 'quantity' | 'unitPrice' | 'discount' | 'taxRate' | 'lineTotal'

interface LineCol {
  key: LineColKey
  /** Column width as a percentage of the table; the description column absorbs the rest. */
  width?: string
  align: 'left' | 'center' | 'right'
  cell: (line: any, i: number) => string
}

const LINE_COLS: LineCol[] = [
  { key: 'lineNo', width: '5%', align: 'left', cell: (_l, i) => String(i + 1) },
  { key: 'description', align: 'left', cell: (l) => String(l.description ?? '') },
  { key: 'unit', width: '8%', align: 'center', cell: (l) => String(l.unit ?? '') },
  { key: 'quantity', width: '9%', align: 'right', cell: (l) => trimQty(l.quantity) },
  { key: 'unitPrice', width: '11%', align: 'right', cell: (l) => money(l.unitPrice) },
  { key: 'discount', width: '8%', align: 'right', cell: (l) => (Number(l.discount) ? money(l.discount) : '') },
  { key: 'taxRate', width: '8%', align: 'right', cell: (l) => (l.taxRate == null ? '' : `${l.taxRate}%`) },
  { key: 'lineTotal', width: '12%', align: 'right', cell: (l) => money(l.lineTotal) },
]

/** The legacy form's column set — used when the caller does not pick columns explicitly. */
const DEFAULT_COLS: LineColKey[] = ['lineNo', 'description', 'unit', 'quantity', 'unitPrice', 'discount', 'lineTotal']

function money(v: unknown): string {
  return Number(v ?? 0).toFixed(2)
}

/** Quantities print without trailing zeros ("16", "2.5") as on the legacy form. */
function trimQty(q: unknown): string {
  const n = Number(q ?? 0)
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)))
}

function contactName(contact: any): string {
  return contact?.companyName || [contact?.firstName, contact?.lastName].filter(Boolean).join(' ') || ''
}

function pickAddress(entity: any, fallback?: any) {
  const addr = entity?.addresses?.find((a: any) => a.isDefault) || entity?.addresses?.[0] || fallback
  return {
    city: addr?.city || '',
    street: [addr?.street, addr?.street2].filter(Boolean).join(' '),
  }
}

/**
 * Split the notes into the amount-in-words line ("Словом : …") and everything else. The
 * printed form shows the words beside the totals and any remaining note underneath, and the
 * ", Данъчна основа X.XX €" tail is dropped because the totals block already states it.
 *
 * The tail is cut structurally — at the first comma after the label — rather than by matching
 * its wording: the line is written in whatever language the user's UI was in when the document
 * was saved, which need not be the language it is printed in, and the two vocabularies differ
 * anyway ("Tax base" when written vs "Taxable amount" on the form). Spelled amounts carry no
 * comma of their own in any supported language, so the first one always opens the tail.
 */
function splitNotes(notes: string | undefined): { words: string; rest: string } {
  if (!notes) return { words: '', rest: '' }
  const lines = String(notes).split('\n')
  const idx = lines.findIndex(l => AMOUNT_IN_WORDS_RE.test(l))
  if (idx === -1) return { words: '', rest: notes.trim() }
  let words = lines[idx].trim()
  const tail = words.indexOf(',')
  // Only a tail that states a figure is the tax-base cross-check; anything else is prose.
  if (tail !== -1 && /\d/.test(words.slice(tail))) words = words.slice(0, tail).trimEnd()
  const rest = lines.filter((_, i) => i !== idx).join('\n').trim()
  return { words, rest }
}

const CSS = `
  ${LOGO_CSS}
  body { font-family: "DejaVu Sans", "Liberation Sans", Arial, sans-serif; font-size: 9pt;
    color: #000; max-width: none; padding: 0 0 14mm 0; margin: 0; }
  table { border-collapse: collapse; border: 0; display: table; width: 100%; margin: 0; }
  table tr, table tbody tr, table tbody tr:nth-child(2n) { background: transparent; border: 0; }
  table td, table th { border: 0; }
  table.top-bar { margin-bottom: 14px; }
  /* Left spacer and meta cell are equal, so the title column sits centred on the page. */
  table.top-bar td.side-cell { width: 27%; }
  table.top-bar td.title-cell { text-align: center; vertical-align: top; width: 46%; }
  table.top-bar td.meta-cell { vertical-align: top; width: 27%; }
  h1.doc-title { font-size: 16pt; font-weight: 700; margin: 0; line-height: 1.2; }
  .copy-mark { font-size: 11pt; font-weight: 700; margin-top: 2px; }
  table.meta { font-size: 8.5pt; width: auto; margin-left: auto; }
  table.meta td { padding: 0 0 1px 0; white-space: nowrap; }
  table.meta td.k { text-align: right; padding-right: 10px; }
  table.meta td.v { text-align: right; font-weight: 700; }
  /* Per-print free text: its own row under the title and the number block, full width, with
     the typed line breaks kept. Absent when nothing was typed, so the header closes up. */
  .head-note { margin: 0 0 12px 0; font-size: 8.5pt; line-height: 1.35;
    white-space: pre-wrap; overflow-wrap: break-word; }
  table.parties { margin-bottom: 16px; font-size: 8.5pt; }
  table.parties td { padding: 2px 0; vertical-align: top; }
  table.parties td.k { width: 11%; padding-left: 4px; }
  table.parties td.v { width: 33%; }
  table.parties td.gap { width: 6%; }
  table.parties tr.band td { background: #ebebeb; font-weight: 700; padding: 3px 0; }
  table.parties tr.band td.gap { background: transparent; }
  table.lines { font-size: 8.5pt; }
  table.lines thead th { border-bottom: 1px solid #000; border-top: 1px solid #000;
    padding: 4px 6px; font-weight: 700; background: #ebebeb; }
  table.lines tbody td { padding: 2.5px 6px; vertical-align: top; }
  table.lines tbody tr:last-child td { border-bottom: 1px solid #000; }
  table.lines td.desc { padding-left: 14px; }
  table.totals { margin-top: 8px; font-size: 8.5pt; }
  table.totals td { padding: 0 0 1px 0; }
  table.totals td.words { vertical-align: top; width: 52%; padding-left: 6px; padding-top: 4px; }
  table.totals td.box-cell { width: 48%; vertical-align: top; }
  /* The 1px right margin keeps the border off the page's clip edge — sitting exactly on it,
     Chromium shaves the stroke on some renders. The wider right padding stops the amounts
     (the 13pt total above all) from printing right against that border. */
  .totals-box { border: 1px solid #000; border-radius: 6px; padding: 5px 14px 6px 12px;
    margin-right: 1px; }
  table.tbox td { padding: 0 0 1px 0; }
  table.tbox td.tk { text-align: left; padding-right: 10px; }
  table.tbox td.tv { text-align: right; white-space: nowrap; font-weight: 700; }
  /* The amount due is the figure the reader looks for — it carries the block. */
  table.tbox tr.grand td { padding-top: 3px; font-weight: 700; line-height: 1.25; vertical-align: bottom; }
  table.tbox tr.grand td.tk { font-size: 9.5pt; }
  table.tbox tr.grand td.tv { font-size: 13pt; }
  .copy-break { page-break-before: always; break-before: page; }
  table.meta-row { margin-top: 14px; font-size: 8.5pt; }
  /* Padding is written out in full: the renderer's own table style otherwise leaves a left
     inset that pushes these rows out of line with the rest of the form. */
  table.meta-row td { padding: 6px 0 0 0; }
  table.banks { margin-top: 8px; font-size: 8.5pt; }
  table.banks td { padding: 1px 0; vertical-align: top; }
  table.banks td.b-name { width: 30%; }
  table.banks td.b-bic { width: 20%; }
  p.notice { margin: 12px 0 0 0; text-align: justify; font-size: 8pt; line-height: 1.35; }
  p.note-rest { margin: 6px 0 0 0; font-size: 8pt; }
  table.signatures { margin-top: 22px; font-size: 8.5pt; }
  table.signatures td { width: 50%; padding: 2px 0 0 0; vertical-align: top; }
  table.signatures td.sig-line { padding: 12px 0 0 0; }
  p.stamp-note { margin: 18px 0 0 0; font-size: 8pt; }
  .page-foot { position: fixed; left: 0; right: 0; bottom: 0; border-top: 1px solid #000;
    padding-top: 3px; font-size: 7.5pt; display: flex; justify-content: space-between; gap: 8px; }
  .page-foot .credit { white-space: nowrap; }
`

export interface InvoicePdfOptions {
  locale?: string
  /**
   * Print marker under the title. When set, exactly one copy is rendered with that marker;
   * when omitted, sales invoices render the ОРИГИНАЛ + КОПИЕ pair and every other document
   * type renders a single ОРИГИНАЛ.
   */
  copyMark?: 'original' | 'copy'
  /** Page-foot issuer line. */
  footerText?: string
  /**
   * Free text for this print run, shown under the number/date block. Supplied per print
   * rather than stored on the document, so an empty value simply prints nothing — the
   * header closes up as if the field did not exist.
   */
  headerNote?: string
}

/** Longest header note the form will print; beyond this it would crowd the parties band. */
export const HEADER_NOTE_MAX = 300

/**
 * The invoicing document as the Bulgarian statutory invoice form: logo and centred title with
 * number/date/УНП at the right, shaded ПОЛУЧАТЕЛ / ДОСТАВЧИК bands, the priced line table,
 * the boxed tax-base/ДДС/total block beside the amount in words, payment and bank details, the
 * two statutory notices and the signature lines. Sales invoices carry a second, КОПИЕ-marked
 * copy on a fresh page.
 *
 * Exported apart from the PDF call so the layout can be rendered and inspected without a
 * Chromium round-trip.
 */
export function buildInvoiceHtml(
  invoice: IInvoice,
  org: IOrg,
  contact: IContact,
  columns?: string[],
  options?: InvoicePdfOptions,
): { html: string; css: string } {
  const locale = options?.locale
  const i18n = invoiceDocI18n(locale)
  const L = i18n.label
  const H = i18n.header
  const inv = invoice as any
  const cur = currencyMark(inv.currency)

  // ── Title + number/date/УНП ──
  const metaRows = [
    `<tr><td class="k">${esc(L.number)}:</td><td class="v">${esc(inv.invoiceNumber)}</td></tr>`,
    `<tr><td class="k">${esc(L.date)}:</td><td class="v">${fmtDate(inv.issueDate)}</td></tr>`,
    // УНП is only present on fiscally-registered sales; the line is omitted otherwise rather
    // than printed empty, since an invented number would be a compliance defect.
    inv.unpNumber ? `<tr><td class="k">${esc(L.unp)} :</td><td class="v">${esc(inv.unpNumber)}</td></tr>` : '',
  ].join('')

  // Whitespace-only text is no text: it must not open an empty block under the meta rows.
  const note = String(options?.headerNote ?? '').trim().slice(0, HEADER_NOTE_MAX)
  const noteBlock = note ? `<div class="head-note">${esc(note)}</div>` : ''

  const logoImg = logoImgTag((org as any)?.logo)
  // The letterhead takes a line of its own; the title and the number/date block share the next.
  // A `null` marker prints the unmarked copy — the line is kept, so both copies lay out alike.
  const topBar = (mark: string | null) => `
    ${logoImg ? `<div class="logo-bar">${logoImg}</div>` : ''}
    <table class="top-bar">
      <tr>
        <td class="side-cell"></td>
        <td class="title-cell">
          <h1 class="doc-title">${esc(invoiceDocTitle(inv.type, inv.direction, locale))}</h1>
          <div class="copy-mark">${mark ? esc(mark) : '&nbsp;'}</div>
        </td>
        <td class="meta-cell"><table class="meta">${metaRows}</table></td>
      </tr>
    </table>`

  // ── Parties. On an incoming bill the counterparty is the supplier, so the two columns swap. ──
  const orgAddr = pickAddress(org)
  const contactAddr = pickAddress(contact, inv.billingAddress)
  const orgParty = {
    name: (org as any)?.name || '',
    city: orgAddr.city,
    street: orgAddr.street,
    taxId: (org as any)?.taxNumber || '',
    vatId: (org as any)?.vatNumber || '',
  }
  const contactParty = {
    name: contactName(contact),
    city: contactAddr.city,
    street: contactAddr.street,
    taxId: (contact as any)?.taxId || '',
    vatId: (contact as any)?.vatNumber || '',
  }
  const [recipient, supplier] = inv.direction === 'incoming'
    ? [orgParty, contactParty]
    : [contactParty, orgParty]

  const partyRow = (key: string, left: string, right: string) => `
    <tr>
      <td class="k">${esc(key)}</td><td class="v">${esc(left)}</td>
      <td class="gap"></td>
      <td class="k">${esc(key)}</td><td class="v">${esc(right)}</td>
    </tr>`

  const parties = `
    <table class="parties">
      <tr class="band">
        <td class="k">${esc(L.recipient)}</td><td class="v">${esc(recipient.name)}</td>
        <td class="gap"></td>
        <td class="k">${esc(L.supplier)}</td><td class="v">${esc(supplier.name)}</td>
      </tr>
      ${partyRow(L.city, recipient.city, supplier.city)}
      ${partyRow(L.address, recipient.street, supplier.street)}
      ${partyRow(L.taxId, recipient.taxId, supplier.taxId)}
      ${partyRow(L.vatId, recipient.vatId, supplier.vatId)}
    </table>`

  // ── Line table ──
  const wanted = new Set(columns?.length ? columns : DEFAULT_COLS)
  const picked = LINE_COLS.filter(c => wanted.has(c.key))
  // A column selection that leaves nothing printable still has to produce a usable document.
  const cols = picked.length ? picked : LINE_COLS.filter(c => c.key === 'description' || c.key === 'lineTotal')

  const headCells = cols.map(c => {
    const w = c.width ? ` style="width:${c.width}"` : ''
    // The legacy form centres the Име heading over its left-aligned values.
    const align = c.key === 'description' ? 'center' : c.align
    return `<th class="a-${align}"${w}>${esc(H[c.key])}</th>`
  }).join('')

  const bodyRows = (inv.lines || []).map((line: any, i: number) => {
    const cells = cols.map(c => {
      const cls = c.key === 'description' ? `a-${c.align} desc` : `a-${c.align}`
      return `<td class="${cls}">${esc(c.cell(line, i))}</td>`
    }).join('')
    return `<tr>${cells}</tr>`
  }).join('')

  const table = `
    <table class="lines">
      <thead><tr>${headCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>`

  // ── Totals beside the amount in words ──
  const { words, rest } = splitNotes(inv.notes)
  // Named as on screen ("Tax Total (20%)"), and only when one rate covers the whole document.
  const vatRateLabel = (() => {
    const rates = [...new Set((inv.lines || []).map((l: any) => Number(l.taxRate || 0)))]
    return rates.length === 1 ? `${L.taxTotal} (${rates[0]}%)` : L.taxTotal
  })()
  const totals = `
    <table class="totals">
      <tr>
        <td class="words">${words ? esc(words) : ''}</td>
        <td class="box-cell">
          <div class="totals-box">
            <table class="tbox">
              <tr>
                <td class="tk">${esc(L.subtotal)}</td><td class="tv">${money(inv.subtotal)} ${esc(cur)}</td>
              </tr>
              <tr><td class="tk">${esc(vatRateLabel)}</td><td class="tv">${money(inv.taxTotal)} ${esc(cur)}</td></tr>
              <tr class="grand"><td class="tk">${esc(L.total)}</td><td class="tv">${money(inv.total)} ${esc(cur)}</td></tr>
            </table>
          </div>
        </td>
      </tr>
    </table>
    ${rest ? `<p class="note-rest">${esc(rest)}</p>` : ''}`

  // ── Tax event / place / payment ──
  const payMethod = (i18n.paymentMethod as Record<string, string>)[inv.paymentMethod || ''] || ''
  const metaRow = `
    <table class="meta-row">
      <tr>
        <td>${esc(L.taxEventDate)}: ${fmtDate(inv.issueDate)}</td>
        <td>${inv.placeOfTransaction ? `${esc(L.placeOfTransaction)}: ${esc(inv.placeOfTransaction)}` : ''}</td>
        <td style="text-align:right">${payMethod ? `${esc(L.payment)}: ${esc(payMethod)}` : ''}</td>
      </tr>
    </table>`

  // Bank details are only meaningful when we are the one being paid.
  const bankList: any[] = inv.direction === 'incoming' ? [] : ((org as any)?.bankDetails || [])
  const banks = bankList.length
    ? `<table class="banks">${bankList.map(b => `
        <tr>
          <td class="b-name">${esc(L.bank)}: ${esc(b.bankName || '')}</td>
          <td class="b-bic">${b.swift ? `${esc(L.bic)}: ${esc(b.swift)}` : ''}</td>
          <td>${b.iban ? `${esc(L.iban)}: ${esc(b.iban)}` : (b.accountNumber ? esc(b.accountNumber) : '')}</td>
        </tr>`).join('')}</table>`
    : ''

  const signatures = `
    <table class="signatures">
      <tr>
        <td>${esc(L.receivedBy)}:</td>
        <td>${esc(L.preparedBy)}: ${esc(inv.preparedBy || '')}</td>
      </tr>
      <tr>
        <td class="sig-line">${esc(L.signature)}:</td>
        <td class="sig-line">${esc(L.signature)}:</td>
      </tr>
    </table>`

  /** One printed copy of the document, differing only in the marker under the title. */
  const copy = (mark: string | null) => `
${topBar(mark)}
${noteBlock}
${parties}
${table}
${totals}
${metaRow}
${banks}
<p class="notice">${esc(i18n.notice.gdpr)}</p>
${signatures}
<p class="stamp-note">${esc(i18n.notice.stamp)}</p>
`

  // A sales invoice is handed out in two copies — the ОРИГИНАЛ for the customer and an
  // unmarked one for the issuer — so the PDF carries both, the second starting on a fresh
  // page. Callers that ask for a specific marker (a reprint of one copy) get that single copy.
  const isSalesInvoice = (inv.type || 'invoice') === 'invoice' && inv.direction !== 'incoming'
  const body = options?.copyMark
    ? copy(options.copyMark === 'copy' ? i18n.copyMark.copy : i18n.copyMark.original)
    : isSalesInvoice
      ? `${copy(i18n.copyMark.original)}\n<div class="copy-break"></div>\n${copy(null)}`
      : copy(i18n.copyMark.original)

  const html = `
${body}
<div class="page-foot"><span>${esc(options?.footerText || '')}</span><span class="credit">${esc(productCredit(locale))}</span></div>
`

  return {
    html: flattenHtml(html),
    css: `${CSS}\n  .a-left { text-align: left; }\n  .a-center { text-align: center; }\n  .a-right { text-align: right; }\n`,
  }
}

/** Render the form of `buildInvoiceHtml` to an A4 PDF. */
export async function generateInvoicePDF(
  invoice: IInvoice,
  org: IOrg,
  contact: IContact,
  columns?: string[],
  options?: InvoicePdfOptions,
): Promise<Buffer | undefined> {
  const { html, css } = buildInvoiceHtml(invoice, org, contact, columns, options)
  return markdownToPdf(html, {
    css,
    // Tighter at the top so the letterhead starts near the sheet edge, as on the legacy form.
    margin: { top: '8mm', bottom: '14mm', left: '12mm', right: '12mm' },
    // The form paints its own `.page-foot` (issuer line + software credit).
    defaultFooter: false,
  })
}
