import {
  MAX_DOCS_PER_MAIL, MAX_SELECTION, isValidRecipient,
  type DocEmailAnswer, type DocEmailBlock, type DocEmailItem, type DocEmailPreviewAnswer, type DocEmailPreviewRow,
} from 'config/doc-email'
import { Org, StockMovement } from 'db/models'
import { stockMovementI18n } from 'reporting/stock-movement.i18n'
import { grantOf, type AccessCaller } from 'services/biz/access/evaluate'
import { docEmailHtml, docEmailSubject, type MailedDocument } from 'services/biz/doc-email/body'
import { emailDocuments, type EmailableDocument } from 'services/biz/doc-email/engine'
import {
  OBJECT_ID, auditMailed, distinct, distinctItems, docEmailResults, failedRender, iso, notConfigured, partnersOf, recentlyMailed,
  refuse, tooLarge, unknownRow,
  type DocEmailReply, type DocEmailRow,
} from 'services/biz/doc-email/request'
import { mailConfigured } from 'services/biz/email.service'
import { renderStockMovementPdf } from 'services/biz/stock-movement-document.service'
import { mayEmailMovements, movementEmailSkip } from './movement-email-guards.js'

/**
 * The movements list's ticked movements, by e-mail (2026-11-16): the warehouse side of `config/doc-email`, kind
 * `movement`, behind `POST warehouse/movement/email/preview` and `POST warehouse/movement/email`.
 *
 * Each movement goes as its printed sheet (`renderStockMovementPdf`, what its Print button downloads): to its
 * contact, or all to one address, which is how a transfer reaches the people of the other site. The sheet carries no
 * price, so the note states no total either.
 *
 * This file knows the movements: it loads them inside the org and holds each to the session
 * (`movement-email-guards.ts`, the same rule for the preview and the mail). The mail is `services/biz/doc-email`'s,
 * and the refusals of a whole request are `services/biz/doc-email/request.ts`'s, as for every kind.
 *
 * ⚠ One refusal of a MOVEMENT is one row of the answer, never the request's status. A movement keeps no send
 * history of its own: its `EmailLog` rows and audit entries are the record.
 */

/** What an `EmailLog` row and an audit entry call a movement, as its other audit entries do. */
export const MOVEMENT_ENTITY = 'stock_movement'

type Caller = AccessCaller & { id: string }

/** What prints a movement. Named so a test can mail without a browser: a render is a fresh Chrome. */
export const movementEmailRenderers = {
  movement: renderStockMovementPdf,
}

const MOVEMENT_FIELDS = { movementNumber: 1, type: 1, status: 1, date: 1, contactId: 1 }

/** The movements the ids name in this org, by id. An id that is no id names none (and is never cast). */
async function movementsById(orgId: string, ids: readonly string[]): Promise<Map<string, any>> {
  const valid = ids.filter(id => OBJECT_ID.test(id))
  const docs: any[] = valid.length ? await StockMovement.find({ orgId, _id: { $in: valid } } as any, MOVEMENT_FIELDS).lean().exec() : []
  return new Map(docs.map(d => [String(d._id), d]))
}

/**
 * What the dialog opens on: each ticked movement with its contact and, when it will not go, why. Writes nothing.
 * An id that is not this org's, names nothing, or is asked by a session that reads no movements is one and the same row.
 */
export async function previewMovementEmail(input: {
  orgId: string
  user: Caller
  ids: readonly unknown[]
}): Promise<DocEmailReply<DocEmailPreviewAnswer>> {
  const { orgId, user } = input
  const grant = grantOf(user)
  if (!mayEmailMovements(grant)) return refuse(403, 'Forbidden')
  const ids = distinct(input.ids)
  if (!ids.length) return refuse(400, 'Choose at least one document')
  if (ids.length > MAX_SELECTION) return tooLarge(MAX_SELECTION, 'One selection')

  const byId = await movementsById(orgId, ids)
  const partners = await partnersOf(orgId, [...byId.values()].map(m => m.contactId))
  const documents = ids.map((id): DocEmailPreviewRow => {
    const movement = byId.get(id.toLowerCase())
    const blocked = movementEmailSkip({ grant, movement }) as DocEmailBlock | null
    if (!movement || blocked === 'not_found') return unknownRow(id)
    const partner = movement.contactId ? partners.get(String(movement.contactId)) : undefined
    return {
      id,
      number: String(movement.movementNumber ?? ''),
      docType: String(movement.type ?? ''),
      date: iso(movement.date),
      status: movement.status,
      ...(partner ? { partner } : {}),
      ...(blocked ? { blocked } : {}),
    }
  })
  return { status: 200, body: { documents } }
}

/** A movement on its way into a mail: what the engine sends, and what the covering note says of it. */
interface MailDoc extends EmailableDocument {
  mailed: MailedDocument
}

interface MailContext {
  orgId: string
  user: Caller
  to: string
  locale: string
}

async function movementRows(ctx: MailContext, ids: readonly string[]): Promise<DocEmailRow<MailDoc>[]> {
  const grant = grantOf(ctx.user)
  const [byId, recent] = await Promise.all([movementsById(ctx.orgId, ids), recentlyMailed(ctx, MOVEMENT_ENTITY, ids)])
  const justSent = new Set(recent.map(r => String(r.entityId)))
  const words = stockMovementI18n(ctx.locale).type
  return ids.map((asked): DocEmailRow<MailDoc> => {
    const item = { id: asked }
    const id = asked.toLowerCase()
    const movement = byId.get(id)
    const skip = movementEmailSkip({ grant, movement, recentSend: justSent.has(id) })
    // Unknown, foreign and unread are one answer: the number is not said either.
    if (!movement || skip === 'not_found') return { item, number: '', skip: 'not_found' }
    const number = String(movement.movementNumber ?? '')
    if (skip) return { item, number, skip }
    return {
      item,
      number,
      document: {
        entityType: MOVEMENT_ENTITY,
        entityId: id,
        number,
        // The movement's type as the screens and the sheet name it; one not listed is said as it is stored.
        mailed: { title: words[String(movement.type)] ?? String(movement.type ?? ''), number, date: movement.date },
        // The sheet the movement's Print button downloads, so the attachment is the printed document.
        render: async () => {
          const r = await movementEmailRenderers.movement(ctx.orgId, id, { locale: ctx.locale })
          return r.ok ? { ok: true, buffer: r.buffer, filename: r.filename } : failedRender(r)
        },
      },
    }
  })
}

/**
 * Up to ten movements to ONE address, in as few mails as fit (`services/biz/doc-email`). The dialog asks once per
 * recipient, and once more per ten movements.
 *
 * Answers 200 with a row per movement: `sent`, `queued` (an organization's own server: the mail waits for
 * lgrai.app), `skipped` with the rule that left it out, or `failed` with why. The request is refused only when the
 * session mails no movement (403), the address is none or the list is empty (400), the list is over ten (422
 * `selection_too_large`), or this server cannot mail (503 `not_configured`, before anything is printed).
 */
export async function emailMovements(input: {
  orgId: string
  user: Caller
  to: unknown
  items: readonly DocEmailItem[]
  subject?: string
  message?: string
  locale?: string
}): Promise<DocEmailReply<DocEmailAnswer>> {
  const { orgId, user } = input
  if (!mayEmailMovements(grantOf(user))) return refuse(403, 'Forbidden')
  const to = String(input.to ?? '').trim()
  if (!isValidRecipient(to)) return refuse(400, 'A valid recipient email is required')
  // A movement is one sheet: an item is its id and nothing else, each once.
  const ids = distinctItems(input.items.map(i => ({ id: String(i?.id ?? '') }))).map(i => i.id)
  if (!ids.length) return refuse(400, 'Choose at least one document')
  if (ids.length > MAX_DOCS_PER_MAIL) return tooLarge(MAX_DOCS_PER_MAIL, 'One request')
  // Before a single PDF is printed: ten renders for a mail that cannot leave is ten seconds of nothing.
  if (!mailConfigured()) return notConfigured()

  const locale = String(input.locale || 'en')
  const [org, rows] = await Promise.all([
    Org.findById(orgId, { name: 1, email: 1 }).lean().exec() as Promise<any>,
    movementRows({ orgId, user, to, locale }, ids),
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
    html: docs => docEmailHtml({ documents: docs.map(d => d.mailed), orgName, message, locale }),
  })
  // Unreachable while `mailConfigured()` stands; kept so a mail service that changes its mind is never a 200.
  if (outcome.notConfigured && !outcome.mails) return notConfigured()

  auditMailed({ orgId, userId: user.id, module: 'warehouse' }, outcome)
  return { status: 200, body: { to, mails: outcome.mails, queued: outcome.queued, results: docEmailResults(rows, outcome) } }
}
