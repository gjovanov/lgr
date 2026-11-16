import { markdownToPdf, mdText } from './base.pdf.js'
import { customerOrderI18n, type CustomerOrderCtx, type CustomerOrderI18n, type CustomerOrderParty } from '../customer-order.i18n.js'
import { unitLabel } from '../unit.i18n.js'

/**
 * The customer order's sheet (`InternalOrder`, ORDI-): what the client is handed or sent. One
 * page of markdown, in the family of the supplier order's sheet (`order-sheet.pdf.ts`).
 *
 * ⚠ It prints NO price, amount or total, and takes no option that would. A line's
 * `expectedUnitPrice` is an indication unless the line is pinned, and the order's invoice may
 * charge the client's own price of the day it is made: any figure here would be read as agreed.
 * It follows that no role needs anything taken out of it either.
 */

/** The order's notes are printed up to this many characters. */
export const CUSTOMER_ORDER_NOTE_MAX = 500

/** The statuses of an order the client has had confirmed: `confirmed` and everything after it. */
const CONFIRMED = new Set(['confirmed', 'partially_delivered', 'delivered', 'completed'])

/** The title says where the order stands. A status this does not know is not called a confirmation. */
function titleOf(status: string, t: CustomerOrderI18n): string {
  if (CONFIRMED.has(status)) return t.titleConfirmation
  return status === 'cancelled' ? t.titleCancelled : t.titleDraft
}

/**
 * What running text calls the sheet (a mail's subject, its covering note): its title for where the
 * order stands, in sentence case. The title is a heading („ПОТВЪРЖДЕНИЕ НА ПОРЪЧКА"); a subject
 * line in capitals shouts.
 *
 * ⚠ The words are the title's own, lowered after the first letter. That is right for the titles of
 * an order a client is SENT (a confirmed one and everything after it, a cancelled one) in all four
 * languages, and `unit/customer-order-sheet.test.ts` holds each. It is not for a draft's (German
 * writes „Entwurf" with a capital), and a draft is never sent.
 */
export function customerOrderDocName(status: unknown, locale?: string): string {
  const [first = '', ...rest] = Array.from(titleOf(String(status || 'draft'), customerOrderI18n(locale)))
  return first + rest.join('').toLowerCase()
}

/**
 * A stored value as literal text on ONE markdown line: the renderer's own rule for typed text
 * (`mdText`), which every markdown-built form prints through.
 */
const plain = mdText

/** dd.mm.yyyy of the calendar day a date was stored as (UTC, the day the screens show). '' for none. */
function day(value: unknown): string {
  if (!value) return ''
  const d = value instanceof Date ? value : new Date(value as any)
  if (Number.isNaN(d.getTime())) return ''
  const two = (n: number) => String(n).padStart(2, '0')
  return `${two(d.getUTCDate())}.${two(d.getUTCMonth() + 1)}.${d.getUTCFullYear()}`
}

/** Quantities print without trailing zeros ("16", "2.5"), as on the invoice form. */
function qty(value: unknown): string {
  const n = Number(value) || 0
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(3)))
}

/** The first `max` characters, and a mark that there was more. */
function cut(value: unknown, max: number): string {
  const chars = Array.from(String(value ?? '').trim())
  return chars.length > max ? `${chars.slice(0, max).join('').trimEnd()}…` : chars.join('')
}

/** A code up to this long is kept on one line. */
const CODE_ONE_LINE_MAX = 24

/**
 * An article's code. A browser may break a line after a hyphen, and „ABC-" over „00001" reads as
 * two codes, so a code of ordinary length stays on one line. A longer one wraps as text does:
 * held on one line it would push the table off the page.
 */
function codeCell(value: unknown): string {
  const text = plain(value)
  return text && Array.from(String(value ?? '').trim()).length <= CODE_ONE_LINE_MAX ? `<span class="one-line">${text}</span>` : text
}

function party(p: CustomerOrderParty | undefined, t: CustomerOrderI18n): string {
  const labelled = (label: string, value: unknown) => (String(value ?? '').trim() ? `${label}: ${plain(value)}` : '')
  return [
    plain(p?.name),
    labelled(t.taxId, p?.taxId),
    labelled(t.vatId, p?.vatId),
    labelled(t.email, p?.email),
    labelled(t.phone, p?.phone),
  ].filter(Boolean).join('<br>')
}

/** The sheet as markdown. Exported so the layout is tested without a browser. */
export function buildCustomerOrderMarkdown(ctx: CustomerOrderCtx): string {
  const t = customerOrderI18n(ctx.locale)
  const order = ctx.order || {}
  const status = String(order.status || 'draft')
  const lines: any[] = order.lines || []

  // A draft's DRF- number goes when the order is confirmed, so the page does not show it: a client
  // holding the printout would hold a number no order has (the documents' rule, FR-22.18). The
  // title says it is a draft.
  const head = [
    status !== 'draft' && order.orderNumber ? `**${t.orderNo}** ${plain(order.orderNumber)}` : '',
    day(order.issueDate) ? `**${t.date}:** ${day(order.issueDate)}` : '',
    day(order.requestedDeliveryDate) ? `**${t.requestedDate}:** ${day(order.requestedDeliveryDate)}` : '',
  ].filter(Boolean)

  const rows = lines.map((line, i) => {
    const product = line?.productId ? ctx.productInfo?.[String(line.productId)] : undefined
    return `| ${i + 1} | ${plain(line?.description || product?.name)} | ${codeCell(line?.sku || product?.sku)} | ${qty(line?.quantity)} | ${plain(unitLabel(line?.unit || product?.unit, ctx.locale))} |`
  })

  const notes = cut(order.notes, CUSTOMER_ORDER_NOTE_MAX)
  const terms = String(order.terms ?? '').trim()

  // Blocks, a blank line between each: a paragraph directly above the rule would become a heading.
  const blocks = [
    `# ${titleOf(status, t)}`,
    // Two trailing spaces: a line break inside the one paragraph.
    head.map((l) => `${l}  `).join('\n'),
    [`| ${t.supplier} | ${t.customer} |`, '|---|---|', `| ${party(ctx.org, t)} | ${party(ctx.customer, t)} |`].join('\n'),
    [`| № | ${t.product} | ${t.sku} | ${t.qty} | ${t.unit} |`, '|---|---|---|---:|---|', ...rows].join('\n'),
    notes ? `**${t.notes}:** ${plain(notes)}` : '',
    terms ? `**${t.terms}:** ${plain(terms)}` : '',
    '---',
    `*${t.generated}: ${day(ctx.generatedAt ?? new Date())}*`,
  ]
  return `${blocks.filter(Boolean).join('\n\n')}\n`
}

/** On top of the plain markdown page: `codeCell`'s one line. */
const SHEET_CSS = '.one-line { white-space: nowrap; }'

export async function generateCustomerOrderPDF(ctx: CustomerOrderCtx): Promise<Buffer | undefined> {
  return markdownToPdf(buildCustomerOrderMarkdown(ctx), { locale: ctx.locale, css: SHEET_CSS })
}
