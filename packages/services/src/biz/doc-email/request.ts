import {
  RESEND_WINDOW_MS,
  type DocEmailItem, type DocEmailPartner, type DocEmailPreviewRow, type DocEmailResult, type DocEmailSkip,
} from 'config/doc-email'
import { Contact, EmailLog } from 'db/models'
import { createAuditEntry } from '../audit-log.service.js'
import type { EmailDocumentsOutcome, EmailableDocument, RenderedDocument } from './engine.js'

/**
 * What the two routes of every KIND share (2026-11-16): the refusals of a whole request, as the one dialog reads
 * them, and the small readings a kind's own loading needs.
 *
 * A kind brings its documents, its rules and a `render` per document (`api/src/invoicing/lib/doc-email.ts`: the invoice
 * collection and supplier orders; `api/src/warehouse/lib/movement-email.ts`: stock movements). The mail itself is
 * `./engine.ts`'s, which knows no kind. What is here is what would otherwise be written once per kind, and then
 * differ: a refusal's code and words, which the dialog reads, and what "the same document to the same address" is.
 */

export interface DocEmailRefusal {
  message: string
  code?: 'selection_too_large' | 'not_configured'
  /** With `selection_too_large`: how many the route takes. */
  max?: number
}

export type DocEmailReply<T> =
  | { status: 200; body: T }
  | { status: 400 | 403 | 422 | 503; body: DocEmailRefusal }

export const OBJECT_ID = /^[0-9a-f]{24}$/i

export function refuse(status: 400 | 403, message: string): DocEmailReply<never> {
  return { status, body: { message } }
}

export function tooLarge(max: number, what: string): DocEmailReply<never> {
  return { status: 422, body: { code: 'selection_too_large', max, message: `${what} takes at most ${max} documents` } }
}

export function notConfigured(): DocEmailReply<never> {
  return { status: 503, body: { code: 'not_configured', message: 'Email is not configured on this server' } }
}

export function iso(date: unknown): string | undefined {
  if (!date) return undefined
  const d = new Date(date as any)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/** The ids asked for, once each, in the order asked. */
export function distinct(ids: readonly unknown[]): string[] {
  return [...new Set(ids.map(id => String(id ?? '').trim()).filter(Boolean))]
}

/** An item names one document: an id and, for an order, its group. Each once, in the order asked. */
export function distinctItems(items: readonly DocEmailItem[]): DocEmailItem[] {
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

/** A document's customer, supplier or contact, as the dialog addresses it. */
export async function partnersOf(orgId: string, contactIds: readonly unknown[]): Promise<Map<string, DocEmailPartner>> {
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
export function unknownRow(id: string): DocEmailPreviewRow {
  return { id, number: '', docType: '', blocked: 'not_found' }
}

/** The documents of an entity type that went, or wait, to this address inside the double-click window. */
export async function recentlyMailed(mail: { orgId: string; to: string }, entityType: string, ids: readonly string[]): Promise<any[]> {
  const valid = ids.filter(id => OBJECT_ID.test(id))
  if (!valid.length) return []
  // A FAILED attempt is no block: the failure is why the person asks again. One still QUEUED on a master is.
  return EmailLog.find({
    orgId: mail.orgId, entityType, entityId: { $in: valid }, to: mail.to, status: { $in: ['sent', 'queued'] },
    createdAt: { $gte: new Date(Date.now() - RESEND_WINDOW_MS) },
  } as any, { entityId: 1, attachmentNames: 1 }).lean().exec()
}

/** A print that answered a refusal, as the engine takes one. */
export function failedRender(r: { message: string; detail?: string }): RenderedDocument {
  return { ok: false, message: r.detail ? `${r.message} (${r.detail})` : r.message }
}

/** One item asked for: a document to mail, or why it is left out. */
export interface DocEmailRow<D extends EmailableDocument> {
  item: DocEmailItem
  number: string
  skip?: DocEmailSkip
  document?: D
}

/** The answer's rows, in the order asked: what the engine did with each document, or the rule that left it out. */
export function docEmailResults<D extends EmailableDocument>(rows: readonly DocEmailRow<D>[], outcome: EmailDocumentsOutcome<D>): DocEmailResult[] {
  const outcomes = new Map(outcome.results.map(r => [r.document, r]))
  return rows.map((row): DocEmailResult => {
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
}

/** An audit entry (`action: 'email'`) for every document that went or was queued; none for one that failed. */
export function auditMailed<D extends EmailableDocument>(who: { orgId: string; userId: string; module: string }, outcome: EmailDocumentsOutcome<D>): void {
  for (const done of outcome.results) {
    if (done.status === 'failed') continue
    createAuditEntry({
      orgId: who.orgId,
      userId: who.userId,
      action: 'email',
      module: who.module,
      entityType: done.document.entityType,
      entityId: done.document.entityId,
      entityName: done.document.number,
    })
  }
}
