import { seesCosts } from 'config/access'
import {
  MAX_DOCS_PER_MAIL, MAX_SELECTION, isValidRecipient,
  type DocEmailAnswer, type DocEmailBlock, type DocEmailItem, type DocEmailPreviewAnswer, type DocEmailPreviewRow,
} from 'config/doc-email'
import { InternalOrder, Invoice, Order, Org } from 'db/models'
import { docTitleFor, exportI18n } from 'reporting/i18n'
import { orderSheetI18n } from 'reporting/order-sheet.i18n'
import { customerOrderDocName } from 'reporting/pdf/customer-order.pdf'
import { generateOrderSheetPDF } from 'reporting/pdf/order-sheet.pdf'
import { grantOf, type AccessCaller } from 'services/biz/access/evaluate'
import { buildEmailHtml, docEmailHtml, docEmailSubject, type MailedDocument } from 'services/biz/doc-email/body'
import { emailDocuments, type EmailableDocument } from 'services/biz/doc-email/engine'
import {
  OBJECT_ID, auditMailed, distinct, distinctItems, docEmailResults, failedRender, iso, notConfigured, partnersOf, recentlyMailed,
  refuse, tooLarge, unknownRow,
  type DocEmailReply, type DocEmailRow,
} from 'services/biz/doc-email/request'
import { mailConfigured } from 'services/biz/email.service'
import {
  internalOrderEmailAccess, internalOrderEmailSkip, invoiceEmailSkip, mayEmailInternalOrders, mayEmailInvoices, mayEmailOrders, orderEmailAccess,
  orderEmailSkip,
} from './email-guards.js'
import { renderInternalOrderPdf } from './internal-order-pdf.js'
import { renderInvoicePdf } from './invoice-pdf.js'
import { buildOrderSheetCtx, withoutExpectedPrices } from './order-sheet.js'

/**
 * The ticked documents of a list, by e-mail (2026-11-16): the invoicing side of `config/doc-email`.
 *
 * Three kinds, behind `POST invoicing/export/email/preview` and `POST invoicing/export/email`:
 *   - `invoice`:        any document of the invoice collection (sales documents, proformas, offers, bills, the till's);
 *   - `order`:          a supplier order, one sheet per supplier GROUP, the supplier variant its Export button downloads;
 *   - `internal-order`: a customer order (`InternalOrder`, ORDI-), the one sheet its Print button downloads.
 *
 * This file knows the documents: it loads them inside the org, holds each to the session (`lib/email-guards.ts`,
 * the same rule for the preview and the mail), prints through the code the export routes print with, and records
 * what a mailed document owes (an invoice's send history, an audit entry). The mail itself is
 * `services/biz/doc-email`'s, which knows no kind; what every kind's two routes share (the refusals of a whole
 * request, the double-click reading, the answer's rows) is `services/biz/doc-email/request.ts`.
 *
 * ⚠ One refusal of a DOCUMENT is one row of the answer, never the request's status: the answer is 200 with a draft
 * `skipped` beside nine `sent`. The request itself is refused only for what is true of all of it.
 */

export const DOC_EMAIL_KINDS = ['invoice', 'order', 'internal-order'] as const
export type DocEmailKind = (typeof DOC_EMAIL_KINDS)[number]

/** What an `EmailLog` row and an audit entry call a customer order, as its other audit entries do. */
export const INTERNAL_ORDER_ENTITY = 'internal_order'

type Caller = AccessCaller & { id: string }

export type { DocEmailRefusal, DocEmailReply } from 'services/biz/doc-email/request'

/**
 * What prints a document. Named so a test can mail without a browser: a render is a fresh Chrome, and the suite's
 * questions are about who gets which file, not about the file.
 */
export const docEmailRenderers = {
  invoice: renderInvoicePdf,
  orderSheet: generateOrderSheetPDF,
  internalOrder: renderInternalOrderPdf,
}

/** May this session e-mail any document of the kind at all: the request's 403. */
export function mayEmailKind(kind: DocEmailKind, user: AccessCaller | null | undefined): boolean {
  if (kind === 'internal-order') return mayEmailInternalOrders(internalOrderEmailAccess(user))
  return kind === 'order' ? mayEmailOrders(orderEmailAccess(user)) : mayEmailInvoices(grantOf(user))
}

// ── the invoice collection ────────────────────────────────────────────────────

const INVOICE_FIELDS = { invoiceNumber: 1, type: 1, direction: 1, status: 1, issueDate: 1, contactId: 1, total: 1, currency: 1 }

/** The invoices the ids name in this org, by id. An id that is no id names none (and is never cast). */
async function invoicesById(orgId: string, ids: readonly string[]): Promise<Map<string, any>> {
  const valid = ids.filter(id => OBJECT_ID.test(id))
  const docs: any[] = valid.length ? await Invoice.find({ orgId, _id: { $in: valid } } as any, INVOICE_FIELDS).lean().exec() : []
  return new Map(docs.map(d => [String(d._id), d]))
}

/** What the dialog calls it: a supplier's invoice is a `bill`, everything else its own type. */
function invoiceDocType(invoice: any): string {
  return invoice.type === 'invoice' && invoice.direction === 'incoming' ? 'bill' : String(invoice.type ?? '')
}

async function previewInvoices(orgId: string, user: Caller, ids: string[]): Promise<DocEmailPreviewRow[]> {
  const grant = grantOf(user)
  const byId = await invoicesById(orgId, ids)
  const partners = await partnersOf(orgId, [...byId.values()].map(d => d.contactId))
  return ids.map((id): DocEmailPreviewRow => {
    const invoice = byId.get(id.toLowerCase())
    const blocked = invoiceEmailSkip({ grant, invoice }) as DocEmailBlock | null
    if (!invoice || blocked === 'not_found') return unknownRow(id)
    const partner = invoice.contactId ? partners.get(String(invoice.contactId)) : undefined
    return {
      id,
      number: String(invoice.invoiceNumber ?? ''),
      docType: invoiceDocType(invoice),
      date: iso(invoice.issueDate),
      status: invoice.status,
      ...(partner ? { partner } : {}),
      ...(blocked ? { blocked } : {}),
    }
  })
}

// ── supplier orders ───────────────────────────────────────────────────────────

async function ordersById(orgId: string, ids: readonly string[]): Promise<Map<string, any>> {
  const valid = ids.filter(id => OBJECT_ID.test(id))
  const docs: any[] = valid.length ? await Order.find({ orgId, _id: { $in: valid } } as any).lean().exec() : []
  return new Map(docs.map(d => [String(d._id), d]))
}

/**
 * The file a supplier group's sheet travels as: the order's number, and the group's place in the order when the
 * order has several (each supplier is mailed its own sheet, and two of them may go to one address).
 */
function orderSheetName(order: any, group: any): string {
  const groups: any[] = order.supplierGroups || []
  const at = groups.findIndex(g => String(g._id) === String(group._id))
  return groups.length > 1 ? `${order.orderNumber}-${at + 1}.pdf` : `${order.orderNumber}.pdf`
}

async function previewOrders(orgId: string, user: Caller, ids: string[]): Promise<DocEmailPreviewRow[]> {
  const access = orderEmailAccess(user)
  const byId = await ordersById(orgId, ids)
  const partners = await partnersOf(orgId, [...byId.values()].flatMap(o => (o.supplierGroups || []).map((g: any) => g.supplierId)))
  return ids.flatMap((id): DocEmailPreviewRow[] => {
    const order = byId.get(id.toLowerCase())
    const groups: any[] = order?.supplierGroups || []
    if (!order || !groups.length) return [unknownRow(id)]
    return groups.map((group): DocEmailPreviewRow => {
      const blocked = orderEmailSkip({ access, order, group }) as DocEmailBlock | null
      const partner = partners.get(String(group.supplierId))
      return {
        id,
        groupId: String(group._id),
        number: String(order.orderNumber ?? ''),
        docType: 'order',
        date: iso(order.issueDate),
        status: order.status,
        ...(partner ? { partner } : {}),
        ...(blocked ? { blocked } : {}),
      }
    })
  })
}

// ── customer orders ───────────────────────────────────────────────────────────

const INTERNAL_ORDER_FIELDS = { orderNumber: 1, status: 1, issueDate: 1, contactId: 1 }

/** The customer orders the ids name in this org, by id. An id that is no id names none (and is never cast). */
async function internalOrdersById(orgId: string, ids: readonly string[]): Promise<Map<string, any>> {
  const valid = ids.filter(id => OBJECT_ID.test(id))
  const docs: any[] = valid.length ? await InternalOrder.find({ orgId, _id: { $in: valid } } as any, INTERNAL_ORDER_FIELDS).lean().exec() : []
  return new Map(docs.map(d => [String(d._id), d]))
}

/** A customer order is one row: it has one sheet, for the client who placed it. */
async function previewInternalOrders(orgId: string, user: Caller, ids: string[]): Promise<DocEmailPreviewRow[]> {
  const access = internalOrderEmailAccess(user)
  const byId = await internalOrdersById(orgId, ids)
  const partners = await partnersOf(orgId, [...byId.values()].map(o => o.contactId))
  return ids.map((id): DocEmailPreviewRow => {
    const order = byId.get(id.toLowerCase())
    const blocked = internalOrderEmailSkip({ access, order }) as DocEmailBlock | null
    if (!order || blocked === 'not_found') return unknownRow(id)
    const partner = order.contactId ? partners.get(String(order.contactId)) : undefined
    return {
      id,
      number: String(order.orderNumber ?? ''),
      docType: INTERNAL_ORDER_ENTITY,
      date: iso(order.issueDate),
      status: order.status,
      ...(partner ? { partner } : {}),
      ...(blocked ? { blocked } : {}),
    }
  })
}

// ── the preview ───────────────────────────────────────────────────────────────

/** A kind's own reading of the ticked ids. One per kind: a kind without it does not compile. */
const PREVIEW_ROWS: Record<DocEmailKind, (orgId: string, user: Caller, ids: string[]) => Promise<DocEmailPreviewRow[]>> = {
  invoice: previewInvoices,
  order: previewOrders,
  'internal-order': previewInternalOrders,
}

/**
 * What the dialog opens on: each ticked document with its partner and, when it will not go, why. Writes nothing.
 * An id that is not this org's, names nothing, or names a kind the session does not read is one and the same row.
 */
export async function previewDocEmail(input: {
  orgId: string
  user: Caller
  kind: DocEmailKind
  ids: readonly unknown[]
}): Promise<DocEmailReply<DocEmailPreviewAnswer>> {
  const { orgId, user, kind } = input
  if (!mayEmailKind(kind, user)) return refuse(403, 'Forbidden')
  const ids = distinct(input.ids)
  if (!ids.length) return refuse(400, 'Choose at least one document')
  if (ids.length > MAX_SELECTION) return tooLarge(MAX_SELECTION, 'One selection')
  const documents = await PREVIEW_ROWS[kind](orgId, user, ids)
  return { status: 200, body: { documents } }
}

// ── the mail ──────────────────────────────────────────────────────────────────

/** A document on its way into a mail: what the engine sends, and what the covering note says of it. */
interface MailDoc extends EmailableDocument {
  item: DocEmailItem
  mailed: MailedDocument
  /** A document of the invoice collection, as `buildEmailHtml` words a mail of one. */
  invoice?: any
}

/** One item asked for: a document to mail, or why it is left out. */
type Row = DocEmailRow<MailDoc>

interface MailContext {
  orgId: string
  user: Caller
  to: string
  locale: string
  columns?: string[]
}

async function invoiceRows(ctx: MailContext, items: DocEmailItem[]): Promise<Row[]> {
  const grant = grantOf(ctx.user)
  const ids = items.map(i => i.id)
  const [byId, recent] = await Promise.all([invoicesById(ctx.orgId, ids), recentlyMailed(ctx, 'invoice', ids)])
  const justSent = new Set(recent.map(r => String(r.entityId)))
  return items.map((item): Row => {
    const id = item.id.toLowerCase()
    const invoice = byId.get(id)
    const skip = invoiceEmailSkip({ grant, invoice, recentSend: justSent.has(id) })
    // Unknown, foreign and unread are one answer: the number is not said either.
    if (!invoice || skip === 'not_found') return { item, number: '', skip: 'not_found' }
    const number = String(invoice.invoiceNumber ?? '')
    if (skip) return { item, number, skip }
    return {
      item,
      number,
      document: {
        item,
        entityType: 'invoice',
        entityId: id,
        number,
        invoice,
        mailed: {
          // A mail of this one document names it as the single route does; a list of several, by its own word.
          title: docTitleFor(invoice.type, invoice.direction, ctx.locale),
          listTitle: (exportI18n(ctx.locale).docType as Record<string, string | undefined>)[String(invoice.type)],
          number,
          date: invoice.issueDate,
          total: `${Number(invoice.total || 0).toFixed(2)} ${invoice.currency || ''}`.trim(),
        },
        // The same assembly Print and the single route use, so the attachment is the printed document.
        render: async () => {
          const r = await docEmailRenderers.invoice(ctx.orgId, id, { locale: ctx.locale, columns: ctx.columns })
          return r.ok ? { ok: true, buffer: r.buffer, filename: r.filename } : failedRender(r)
        },
      },
    }
  })
}

async function orderRows(ctx: MailContext, items: DocEmailItem[]): Promise<Row[]> {
  const access = orderEmailAccess(ctx.user)
  const ids = distinct(items.map(i => i.id))
  const [byId, recent] = await Promise.all([ordersById(ctx.orgId, ids), recentlyMailed(ctx, 'order', ids)])
  // An order's log rows name the ORDER; which of its sheets a row was is the row's file.
  const justSent = new Set(recent.flatMap(r => (r.attachmentNames || []).map((name: string) => `${r.entityId}|${name}`)))
  // FR-27.11.C.1: a role without the cost figures gets no expected (purchase) price, as from the export route.
  const costs = seesCosts(grantOf(ctx.user))
  return items.map((item): Row => {
    const id = item.id.toLowerCase()
    const stored = byId.get(id)
    const order = stored && !costs ? withoutExpectedPrices(stored) : stored
    const group = item.groupId ? (order?.supplierGroups || []).find((g: any) => String(g._id) === String(item.groupId)) : undefined
    const filename = order && group ? orderSheetName(order, group) : ''
    const skip = orderEmailSkip({ access, order, group, recentSend: justSent.has(`${id}|${filename}`) })
    if (!order || !group || skip === 'not_found') return { item, number: '', skip: skip ?? 'not_found' }
    const number = String(order.orderNumber ?? '')
    if (skip) return { item, number, skip }
    return {
      item,
      number,
      document: {
        item,
        entityType: 'order',
        entityId: id,
        number,
        mailed: { title: orderSheetI18n(ctx.locale).titleSupplier, number, date: order.issueDate },
        // The supplier variant of the sheet, from the builder the order's Export button prints with.
        render: async () => {
          const sheet = await buildOrderSheetCtx({ orgId: ctx.orgId, order, group, variant: 'supplier', locale: ctx.locale })
          const buffer = await docEmailRenderers.orderSheet(sheet, 'supplier')
          return buffer ? { ok: true, buffer, filename } : { ok: false, message: 'PDF renderer unavailable' }
        },
      },
    }
  })
}

async function internalOrderRows(ctx: MailContext, items: DocEmailItem[]): Promise<Row[]> {
  const access = internalOrderEmailAccess(ctx.user)
  const ids = items.map(i => i.id)
  const [byId, recent] = await Promise.all([internalOrdersById(ctx.orgId, ids), recentlyMailed(ctx, INTERNAL_ORDER_ENTITY, ids)])
  const justSent = new Set(recent.map(r => String(r.entityId)))
  return items.map((item): Row => {
    const id = item.id.toLowerCase()
    const order = byId.get(id)
    const skip = internalOrderEmailSkip({ access, order, recentSend: justSent.has(id) })
    // Unknown and foreign are one answer: the number is not said either.
    if (!order || skip === 'not_found') return { item, number: '', skip: skip ?? 'not_found' }
    const number = String(order.orderNumber ?? '')
    if (skip) return { item, number, skip }
    return {
      item,
      number,
      document: {
        item,
        entityType: INTERNAL_ORDER_ENTITY,
        entityId: id,
        number,
        // Named as its sheet's title names it, so a cancelled order's mail says so before it is opened. No total:
        // the sheet states none (a line's price is an indication until the order's invoice).
        mailed: { title: customerOrderDocName(order.status, ctx.locale), number, date: order.issueDate },
        // The sheet the order's Print button downloads, so the attachment is the printed document.
        render: async () => {
          const r = await docEmailRenderers.internalOrder(ctx.orgId, id, { locale: ctx.locale })
          return r.ok ? { ok: true, buffer: r.buffer, filename: r.filename } : failedRender(r)
        },
      },
    }
  })
}

/** A kind's own reading of the items asked for. One per kind: a kind without it does not compile. */
const MAIL_ROWS: Record<DocEmailKind, (ctx: MailContext, items: DocEmailItem[]) => Promise<Row[]>> = {
  invoice: invoiceRows,
  order: orderRows,
  'internal-order': internalOrderRows,
}

/**
 * Up to ten documents to ONE address, in as few mails as fit (`services/biz/doc-email`). The dialog asks once per
 * recipient, and once more per ten documents.
 *
 * Answers 200 with a row per document: `sent`, `queued` (an organization's own server: the mail waits for
 * lgrai.app), `skipped` with the rule that left it out, or `failed` with why. The request is refused only when the
 * session may mail no document of the kind (403), the address is none or the list is empty (400), the list is over
 * ten (422 `selection_too_large`), or this server cannot mail (503 `not_configured`, before anything is printed).
 */
export async function sendDocEmail(input: {
  orgId: string
  user: Caller
  kind: DocEmailKind
  to: unknown
  items: readonly DocEmailItem[]
  subject?: string
  message?: string
  locale?: string
  /** An invoice's printed line columns, already checked by the caller. */
  columns?: string[]
}): Promise<DocEmailReply<DocEmailAnswer>> {
  const { orgId, user, kind } = input
  if (!mayEmailKind(kind, user)) return refuse(403, 'Forbidden')
  const to = String(input.to ?? '').trim()
  if (!isValidRecipient(to)) return refuse(400, 'A valid recipient email is required')
  // A customer order is one sheet: an item is its id, and a group named beside it is not read.
  const items = distinctItems(kind === 'internal-order' ? input.items.map(i => ({ id: i?.id })) : input.items)
  if (!items.length) return refuse(400, 'Choose at least one document')
  if (items.length > MAX_DOCS_PER_MAIL) return tooLarge(MAX_DOCS_PER_MAIL, 'One request')
  // Before a single PDF is printed: ten renders for a mail that cannot leave is ten seconds of nothing.
  if (!mailConfigured()) return notConfigured()

  const locale = String(input.locale || 'en')
  const ctx: MailContext = { orgId, user, to, locale, columns: input.columns }
  const [org, rows] = await Promise.all([
    Org.findById(orgId, { name: 1, email: 1 }).lean().exec() as Promise<any>,
    MAIL_ROWS[kind](ctx, items),
  ])
  const orgName = String(org?.name || '')
  const subject = String(input.subject ?? '').trim().slice(0, 200)
  const message = input.message?.trim() ? input.message : undefined

  const outcome = await emailDocuments<MailDoc>({
    orgId,
    userId: user.id,
    to,
    // A reply reaches the org, not the mailer's sender address. A master's mail gets it from the relay (FR-20.59).
    replyTo: isValidRecipient(org?.email) ? String(org.email).trim() : undefined,
    documents: rows.flatMap(r => (r.document ? [r.document] : [])),
    subject: docs => subject || docEmailSubject({ documents: docs.map(d => d.mailed), orgName, locale }),
    html: (docs) => {
      const [only] = docs
      // A mail of one invoice reads as the single route's does.
      return docs.length === 1 && only?.invoice
        ? buildEmailHtml({ title: only.mailed.title, invoice: only.invoice, orgName, message, locale })
        : docEmailHtml({ documents: docs.map(d => d.mailed), orgName, message, locale })
    },
  })
  // Unreachable while `mailConfigured()` stands; kept so a mail service that changes its mind is never a 200.
  if (outcome.notConfigured && !outcome.mails) return notConfigured()

  const results = docEmailResults(rows, outcome)

  // Only a mail that LEFT updates a document's send history. A queued invoice's is the outbox worker's, when
  // lgrai.app has sent it (`relay/outbox-worker.ts`).
  const sentInvoices = outcome.results.filter(r => r.status === 'sent' && r.document.entityType === 'invoice').map(r => r.document.entityId)
  if (sentInvoices.length) {
    await Invoice.updateMany(
      { orgId, _id: { $in: sentInvoices } } as any,
      { $addToSet: { emailedTo: to }, $set: { lastEmailedAt: new Date() } },
    )
  }
  auditMailed({ orgId, userId: user.id, module: 'invoicing' }, outcome)

  return { status: 200, body: { to, mails: outcome.mails, queued: outcome.queued, results } }
}
