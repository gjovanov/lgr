import { seesCosts } from 'config/access'
import {
  MAX_DOCS_PER_MAIL, MAX_SELECTION, isValidRecipient,
  type DocEmailAnswer, type DocEmailBlock, type DocEmailItem, type DocEmailPartner, type DocEmailPreviewAnswer,
  type DocEmailPreviewRow, type DocEmailResult, type DocEmailSkip,
} from 'config/doc-email'
import { Contact, EmailLog, Invoice, Order, Org } from 'db/models'
import { docTitleFor, exportI18n } from 'reporting/i18n'
import { orderSheetI18n } from 'reporting/order-sheet.i18n'
import { generateOrderSheetPDF } from 'reporting/pdf/order-sheet.pdf'
import { grantOf, type AccessCaller } from 'services/biz/access/evaluate'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { buildEmailHtml, docEmailHtml, docEmailSubject, type MailedDocument } from 'services/biz/doc-email/body'
import { emailDocuments, type EmailableDocument, type RenderedDocument } from 'services/biz/doc-email/engine'
import { mailConfigured } from 'services/biz/email.service'
import {
  RESEND_WINDOW_MS, invoiceEmailSkip, mayEmailInvoices, mayEmailOrders, orderEmailAccess, orderEmailSkip,
} from './email-guards.js'
import { renderInvoicePdf } from './invoice-pdf.js'
import { buildOrderSheetCtx, withoutExpectedPrices } from './order-sheet.js'

/**
 * The ticked documents of a list, by e-mail (2026-11-16): the invoicing side of `config/doc-email`.
 *
 * Two kinds, behind `POST invoicing/export/email/preview` and `POST invoicing/export/email`:
 *   - `invoice`: any document of the invoice collection (sales documents, proformas, offers, bills, the till's);
 *   - `order`:   a supplier order, one sheet per supplier GROUP, the supplier variant its Export button downloads.
 *
 * This file knows the documents: it loads them inside the org, holds each to the session (`lib/email-guards.ts`,
 * the same rule for the preview and the mail), prints through the code the export routes print with, and records
 * what a mailed document owes (an invoice's send history, an audit entry). The mail itself is
 * `services/biz/doc-email`'s, which knows no kind.
 *
 * ⚠ One refusal of a DOCUMENT is one row of the answer, never the request's status: the answer is 200 with a draft
 * `skipped` beside nine `sent`. The request itself is refused only for what is true of all of it.
 */

export const DOC_EMAIL_KINDS = ['invoice', 'order'] as const
export type DocEmailKind = (typeof DOC_EMAIL_KINDS)[number]

type Caller = AccessCaller & { id: string }

export interface DocEmailRefusal {
  message: string
  code?: 'selection_too_large' | 'not_configured'
  /** With `selection_too_large`: how many the route takes. */
  max?: number
}

export type DocEmailReply<T> =
  | { status: 200; body: T }
  | { status: 400 | 403 | 422 | 503; body: DocEmailRefusal }

/**
 * What prints a document. Named so a test can mail without a browser: a render is a fresh Chrome, and the suite's
 * questions are about who gets which file, not about the file.
 */
export const docEmailRenderers = {
  invoice: renderInvoicePdf,
  orderSheet: generateOrderSheetPDF,
}

const OBJECT_ID = /^[0-9a-f]{24}$/i

function refuse(status: 400 | 403, message: string): DocEmailReply<never> {
  return { status, body: { message } }
}

function tooLarge(max: number, what: string): DocEmailReply<never> {
  return { status: 422, body: { code: 'selection_too_large', max, message: `${what} takes at most ${max} documents` } }
}

function notConfigured(): DocEmailReply<never> {
  return { status: 503, body: { code: 'not_configured', message: 'Email is not configured on this server' } }
}

/** May this session e-mail any document of the kind at all: the request's 403. */
export function mayEmailKind(kind: DocEmailKind, user: AccessCaller | null | undefined): boolean {
  return kind === 'order' ? mayEmailOrders(orderEmailAccess(user)) : mayEmailInvoices(grantOf(user))
}

function iso(date: unknown): string | undefined {
  if (!date) return undefined
  const d = new Date(date as any)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/** The ids asked for, once each, in the order asked. */
function distinct(ids: readonly unknown[]): string[] {
  return [...new Set(ids.map(id => String(id ?? '').trim()).filter(Boolean))]
}

/** A document's customer or supplier, as the dialog addresses it. */
async function partnersOf(orgId: string, contactIds: readonly unknown[]): Promise<Map<string, DocEmailPartner>> {
  const ids = distinct(contactIds).filter(id => OBJECT_ID.test(id))
  const contacts: any[] = ids.length
    ? await Contact.find({ orgId, _id: { $in: ids } } as any, { companyName: 1, firstName: 1, lastName: 1, email: 1 }).lean().exec()
    : []
  return new Map(contacts.map((c) => {
    const email = String(c.email ?? '').trim()
    const name = c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ') || ''
    return [String(c._id), { id: String(c._id), name, ...(email ? { email } : {}) }]
  }))
}

/** A row that says nothing but that it does not go: see `DocEmailPreviewRow`. */
function unknownRow(id: string): DocEmailPreviewRow {
  return { id, number: '', docType: '', blocked: 'not_found' }
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

// ── the preview ───────────────────────────────────────────────────────────────

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
  const documents = kind === 'order' ? await previewOrders(orgId, user, ids) : await previewInvoices(orgId, user, ids)
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
interface Row {
  item: DocEmailItem
  number: string
  skip?: DocEmailSkip
  document?: MailDoc
}

interface MailContext {
  orgId: string
  user: Caller
  to: string
  locale: string
  columns?: string[]
}

/** The documents of the kind that went, or wait, to this address inside the double-click window. */
async function recentlyMailed(ctx: MailContext, entityType: string, ids: readonly string[]): Promise<any[]> {
  const valid = ids.filter(id => OBJECT_ID.test(id))
  if (!valid.length) return []
  // A FAILED attempt is no block: the failure is why the person asks again. One still QUEUED on a master is.
  return EmailLog.find({
    orgId: ctx.orgId, entityType, entityId: { $in: valid }, to: ctx.to, status: { $in: ['sent', 'queued'] },
    createdAt: { $gte: new Date(Date.now() - RESEND_WINDOW_MS) },
  } as any, { entityId: 1, attachmentNames: 1 }).lean().exec()
}

function failedRender(r: { message: string; detail?: string }): RenderedDocument {
  return { ok: false, message: r.detail ? `${r.message} (${r.detail})` : r.message }
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

/** An item names one document: an id and, for an order, its group. Each once, in the order asked. */
function distinctItems(items: readonly DocEmailItem[]): DocEmailItem[] {
  const seen = new Set<string>()
  const out: DocEmailItem[] = []
  for (const raw of items) {
    const id = String(raw?.id ?? '').trim()
    const groupId = String(raw?.groupId ?? '').trim()
    const key = `${id.toLowerCase()}:${groupId.toLowerCase()}`
    if (!id || seen.has(key)) continue
    seen.add(key)
    out.push({ id, ...(groupId ? { groupId } : {}) })
  }
  return out
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
  const items = distinctItems(input.items)
  if (!items.length) return refuse(400, 'Choose at least one document')
  if (items.length > MAX_DOCS_PER_MAIL) return tooLarge(MAX_DOCS_PER_MAIL, 'One request')
  // Before a single PDF is printed: ten renders for a mail that cannot leave is ten seconds of nothing.
  if (!mailConfigured()) return notConfigured()

  const locale = String(input.locale || 'en')
  const ctx: MailContext = { orgId, user, to, locale, columns: input.columns }
  const [org, rows] = await Promise.all([
    Org.findById(orgId, { name: 1, email: 1 }).lean().exec() as Promise<any>,
    kind === 'order' ? orderRows(ctx, items) : invoiceRows(ctx, items),
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

  const outcomes = new Map(outcome.results.map(r => [r.document, r]))
  const results: DocEmailResult[] = rows.map((row): DocEmailResult => {
    const base = { id: row.item.id, ...(row.item.groupId ? { groupId: row.item.groupId } : {}), number: row.number }
    const done = row.document ? outcomes.get(row.document) : undefined
    if (!done) return { ...base, status: 'skipped', reason: row.skip ?? 'not_found' }
    return {
      ...base,
      status: done.status,
      ...(done.reason ? { reason: done.reason } : {}),
      ...(done.message ? { message: done.message } : {}),
    }
  })

  // Only a mail that LEFT updates a document's send history. A queued invoice's is the outbox worker's, when
  // lgrai.app has sent it (`relay/outbox-worker.ts`).
  const sentInvoices = outcome.results.filter(r => r.status === 'sent' && r.document.entityType === 'invoice').map(r => r.document.entityId)
  if (sentInvoices.length) {
    await Invoice.updateMany(
      { orgId, _id: { $in: sentInvoices } } as any,
      { $addToSet: { emailedTo: to }, $set: { lastEmailedAt: new Date() } },
    )
  }
  for (const done of outcome.results) {
    if (done.status === 'failed') continue
    createAuditEntry({
      orgId,
      userId: user.id,
      action: 'email',
      module: 'invoicing',
      entityType: done.document.entityType,
      entityId: done.document.entityId,
      entityName: done.document.number,
    })
  }

  return { status: 200, body: { to, mails: outcome.mails, queued: outcome.queued, results } }
}
