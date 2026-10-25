import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { createInvoiceStockMovement, reverseInvoiceStockMovement, validateStockAvailability } from 'services/biz/invoicing.service'
import { syncOrderForInvoice } from 'services/biz/reservation.service'
import { createAuditEntry, diffChanges } from 'services/biz/audit-log.service'
import { buildSearchFilter } from 'services/biz/search.utils'
import { upsertTags } from 'services/biz/tag.service'
import { eventBus } from 'services/events/event-bus'
import { getNextNumber, ensureSequenceAtLeast, getDisplayPrefix, getCurrentNumber } from 'services/biz/sequence.service'
import { getInvoiceSummary } from 'services/biz/invoice-summary.service'
import { sequenceDefFor, resolveSequencePrefix, type SequenceGroup } from 'services/biz/sequence-registry'
import { Invoice, Reservation, StockMovement } from 'db/models'
import { assertHomeIsHere } from 'db/home/home'
import { licenceGate } from 'services/biz/licence/master-licence.service'
import { createInvoiceWithProductUpdates, updateInvoiceWithProductUpdates } from 'services/biz/invoice-with-update.service'
import { GRValidationError } from 'services/biz/product-update.service'
import { syncCashSettlement } from 'services/biz/cash-settlement.service'
import {
  readIdempotencyKey, requestHash, assertSameRequest, isDuplicateKey, takeLease, waitForCompletion,
  IdempotencyError, LEASE_MS, WAIT_MS,
} from 'services/biz/hot-path-key'
import { logger } from 'services/logger'

// ── Idempotent create, issue and payment (FR-20.37, #155) ───────────────────────────────────

type Status = (code: number, body: Record<string, unknown>) => any

/**
 * The number a keyed cash sale holds between its insert and its real number. Never a valid
 * prefix, so it cannot collide with an allocated number; unique per key, so it cannot collide
 * with another pending sale.
 */
const PENDING_NUMBER = '~pending:'

interface CreateCtx {
  orgId: string
  user: any
  isCashSale: boolean
  skipStockMovement: boolean
  allowNegativeStock: boolean
  pendingTransferIds?: string[]
}

const reused = (status: Status, e: IdempotencyError) => status(e.statusCode, { code: e.code, message: e.message })

/**
 * Give a keyed cash sale its real CS number (it was inserted under `PENDING_NUMBER`).
 * Retries a number the counter handed out twice, as the unkeyed path does. Null after three.
 */
async function numberPendingCashSale(orgId: string, id: string, userId: string): Promise<any | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const number = await getNextInvoiceNumber(orgId, 'outgoing', 'cash_sale')
    try {
      // No match = already numbered (a resumed request got there first); either way it is done.
      await Invoice.updateOne(
        { _id: id, orgId, invoiceNumber: { $regex: `^${PENDING_NUMBER}` } },
        { $set: { invoiceNumber: number, numberHistory: [{ number, allocatedAt: new Date(), status: 'paid' }] } },
      ).exec()
      return getRepos().invoices.findOne({ id, orgId } as any)
    } catch (e: any) {
      if (e?.code !== 11000) throw e
      logger.warn({ orgId, id, number, attempt }, 'Cash sale number already taken, retrying')
    }
  }
  return null
}

/**
 * Finish a keyed create a crash interrupted: number a pending cash sale, move its stock if it
 * has not moved, derive order counters, mark it complete. Each step checks before acting.
 * Answers like the route: the document, or the cash sale's rollback error.
 */
async function finishCreate(c: CreateCtx, id: string, status: Status) {
  const r = getRepos()
  let invoice: any = await r.invoices.findOne({ id, orgId: c.orgId } as any)
  if (c.isCashSale && String(invoice.invoiceNumber).startsWith(PENDING_NUMBER)) {
    invoice = await numberPendingCashSale(c.orgId, id, c.user.id)
    if (!invoice) {
      await r.invoices.deleteInOrg(id, c.orgId)
      return status(409, { message: 'Could not allocate the cash sale number after 3 attempts' })
    }
  }
  if (c.isCashSale && !c.skipStockMovement) {
    if (c.pendingTransferIds?.length && !invoice.pendingTransferIds?.length) {
      const { confirmTransferMovements } = await import('services/biz/stock-transfer.service')
      try {
        await confirmTransferMovements(c.pendingTransferIds)
        await r.invoices.updateInOrg(id, c.orgId, { pendingTransferIds: c.pendingTransferIds } as any)
      } catch (e: any) {
        await r.invoices.deleteInOrg(id, c.orgId)
        return status(400, { message: `Transfer confirmation failed: ${e.message}` })
      }
    }
    const moved = await StockMovement.exists({ orgId: c.orgId, invoiceId: id }).exec()
    if (!moved) {
      try {
        await createInvoiceStockMovement(invoice, c.user.id, undefined, c.allowNegativeStock ? { allowNegative: true } : undefined)
      } catch (e: any) {
        await r.invoices.deleteInOrg(id, c.orgId)
        return status(400, { message: e.message })
      }
    }
  }
  await syncOrderForInvoice(c.orgId, invoice, c.user.id)
  const done = await Invoice.findOneAndUpdate(
    { _id: id, orgId: c.orgId, completedAt: { $exists: false } },
    { $set: { completedAt: new Date() }, $unset: { leaseUntil: 1 } },
  ).exec()
  if (done) createAuditEntry({ orgId: c.orgId, userId: c.user.id, action: 'create', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: invoice.invoiceNumber })
  return { invoice: await r.invoices.findOne({ id, orgId: c.orgId } as any) }
}

/** A create whose key is already on a document: replay it, finish it, or wait for it. */
async function settleCreate(existing: any, hash: string, c: CreateCtx, status: Status) {
  try {
    assertSameRequest(existing.requestHash, hash)
  } catch (e: any) {
    if (e instanceof IdempotencyError) return reused(status, e)
    throw e
  }
  const id = String(existing._id)
  const replay = async () => ({ invoice: await getRepos().invoices.findOne({ id, orgId: c.orgId } as any) })
  // Documents created before this field existed, or by a request that finished, are complete.
  if (existing.completedAt || !existing.leaseUntil) return replay()
  for (let round = 0; round < 2; round++) {
    if (await takeLease(Invoice, c.orgId, existing._id)) return finishCreate(c, id, status)
    const { doc, leaseLapsed } = await waitForCompletion(Invoice, c.orgId, existing._id)
    if (doc?.completedAt) return replay()
    if (!doc || !leaseLapsed) break
  }
  return status(409, { code: 'idempotency_in_progress', message: 'This document is still being created — retry with the same Idempotency-Key.' })
}

// Numbering (sequence keys, display prefixes, allocation) lives in services so the
// doc-import engine can use it without importing from a controller. Re-exported here
// because several controllers and libs already import these names from this module.
export {
  TYPE_PREFIX,
  SALES_DOC_PREFIXES,
  sequenceKeyFor,
  prefixFor,
  draftSequenceKeyFor,
  draftPrefixFor,
  currentMaxSuffix,
  resolveDisplayPrefix,
  getNextInvoiceNumber,
  getNextDraftInvoiceNumber,
} from 'services/biz/invoice-numbering.service'
import {
  TYPE_PREFIX,
  sequenceKeyFor,
  prefixFor,
  draftSequenceKeyFor,
  draftPrefixFor,
  currentMaxSuffix,
  resolveDisplayPrefix,
  getNextInvoiceNumber,
  getNextDraftInvoiceNumber,
} from 'services/biz/invoice-numbering.service'

// Order/reservation back-references a line may carry (all optional: bills carry the
// ORDO supply refs, conversion invoices additionally the RES + ORDI demand refs, and
// stock-source reservation lines carry only reservationId + the demand refs).
const orderRefBody = t.Object({
  orderId: t.Optional(t.String()),
  groupId: t.Optional(t.String()),
  lineId: t.Optional(t.String()),
  allocationId: t.Optional(t.String()),
  reservationId: t.Optional(t.String()),
  internalOrderId: t.Optional(t.String()),
  internalOrderLineId: t.Optional(t.String()),
})

/**
 * Guard for reservation-consuming lines: only outgoing SALES invoices may reference a
 * reservation (bills book receipts via allocations; converted proformas would
 * double-count), and the total live invoiced quantity per reservation must stay within
 * the reserved quantity. Returns an error message, or null when the payload is fine.
 */
export async function validateReservationLineRefs(
  orgId: string,
  payload: { type?: string; direction?: string; lines?: any[] },
  excludeInvoiceId?: string,
): Promise<string | null> {
  const withRes = (payload.lines || []).filter((l: any) => l.orderRef?.reservationId || l.orderRef?.internalOrderId || l.orderRef?.internalOrderLineId)
  if (!withRes.length) return null
  const direction = payload.type === 'cash_sale' ? 'outgoing' : payload.direction
  if (direction === 'incoming') {
    return 'Purchase documents cannot reference reservations — bills book receipts via order allocations'
  }
  if (payload.type && payload.type !== 'invoice') {
    return 'Only sales invoices can consume reservations'
  }

  const byRes = new Map<string, number>()
  for (const l of withRes) {
    if (!l.orderRef?.reservationId) continue
    const rid = String(l.orderRef.reservationId)
    byRes.set(rid, (byRes.get(rid) || 0) + (Number(l.quantity) || 0))
  }
  if (!byRes.size) return null

  const resDocs = await Reservation.find(
    { orgId, _id: { $in: [...byRes.keys()] } } as any,
    { reservationNumber: 1, quantity: 1, status: 1 },
  ).lean().exec()
  const found = new Map(resDocs.map((r: any) => [String(r._id), r]))

  const others = await Invoice.find(
    {
      orgId,
      direction: 'outgoing',
      type: 'invoice',
      status: { $nin: ['voided', 'cancelled'] },
      ...(excludeInvoiceId ? { _id: { $ne: excludeInvoiceId } } : {}),
      'lines.orderRef.reservationId': { $in: [...byRes.keys()] },
    } as any,
    { lines: 1 },
  ).lean().exec()
  const otherByRes = new Map<string, number>()
  for (const inv of others) {
    for (const line of (inv as any).lines || []) {
      const rid = line.orderRef?.reservationId ? String(line.orderRef.reservationId) : ''
      if (!rid || !byRes.has(rid)) continue
      otherByRes.set(rid, (otherByRes.get(rid) || 0) + (Number(line.quantity) || 0))
    }
  }

  for (const [rid, qty] of byRes) {
    const res: any = found.get(rid)
    if (!res) return `Reservation ${rid} not found`
    if (res.status === 'cancelled') return `Reservation ${res.reservationNumber} is cancelled`
    const already = otherByRes.get(rid) || 0
    if (qty + already > (res.quantity || 0) + 1e-9) {
      return `Reservation ${res.reservationNumber}: invoiced quantity ${qty + already} exceeds reserved ${res.quantity} (remaining: ${Math.max(0, (res.quantity || 0) - already)})`
    }
  }
  return null
}

/**
 * Credit/debit notes must reference the issued invoice they correct (FR-01). Validates the
 * effective (post-update) type/direction/contact/relatedInvoiceId combination and returns an
 * error message, or null when the document is fine. Non-note types never fail this check.
 */
export async function validateRelatedInvoiceRef(
  orgId: string,
  doc: { type?: string; direction?: string; contactId?: string | null; relatedInvoiceId?: string | null },
): Promise<string | null> {
  if (doc.type !== 'credit_note' && doc.type !== 'debit_note') return null
  const kind = doc.type === 'credit_note' ? 'credit' : 'debit'
  if (!doc.relatedInvoiceId) return `Related invoice is required for ${kind} notes`

  const r = getRepos()
  const related: any = await r.invoices.findOne({ id: doc.relatedInvoiceId, orgId } as any)
  if (!related) return 'Related invoice not found'
  if (related.type !== 'invoice') {
    return `Related document ${related.invoiceNumber} is not an invoice — ${kind} notes must reference an invoice`
  }
  if (doc.direction && related.direction !== doc.direction) {
    return `Related invoice ${related.invoiceNumber} is a ${related.direction === 'incoming' ? 'purchase' : 'sales'} document — pick one from the same side`
  }
  if (['draft', 'voided', 'cancelled'].includes(related.status)) {
    return `Related invoice ${related.invoiceNumber} is ${related.status} — only issued invoices can be corrected`
  }
  if (doc.contactId && related.contactId && String(related.contactId) !== String(doc.contactId)) {
    return `Related invoice ${related.invoiceNumber} belongs to a different contact`
  }
  return null
}

function statusEntry(toStatus: string, fromStatus?: string, userId?: string, reason?: string) {
  return {
    status: toStatus,
    fromStatus,
    changedAt: new Date(),
    changedBy: userId,
    reason,
  }
}

// Produce a viewable history when legacy rows have no statusHistory yet, using
// the known status-change timestamps (createdAt, sentAt, paidAt). Read-only synthesis —
// does not persist.
function synthesizeStatusHistory(invoice: any): any[] {
  if (Array.isArray(invoice.statusHistory) && invoice.statusHistory.length > 0) {
    return invoice.statusHistory
  }
  const entries: any[] = []
  if (invoice.createdAt) {
    entries.push({ status: 'draft', changedAt: invoice.createdAt, reason: 'created (reconstructed)' })
  }
  if (invoice.sentAt) {
    const sentStatus = invoice.direction === 'incoming' ? 'received' : 'sent'
    entries.push({ status: sentStatus, fromStatus: 'draft', changedAt: invoice.sentAt, reason: 'reconstructed' })
  }
  if (invoice.paidAt && invoice.status === 'paid') {
    entries.push({ status: 'paid', changedAt: invoice.paidAt, reason: 'reconstructed' })
  }
  if (invoice.status && !entries.find(e => e.status === invoice.status)) {
    entries.push({ status: invoice.status, changedAt: invoice.updatedAt || invoice.createdAt, reason: 'reconstructed' })
  }
  return entries
}


const PAYMENT_METHODS = ['cash', 'bank_transfer', 'card', 'cash_on_delivery', 'other']

/**
 * Filter documents by payment method. A document matches when any of its recorded
 * payments (`payments[].method`) uses one of the requested methods, or — for documents
 * carrying only the header-level method (unpaid / imported docs) — when `paymentMethod` does.
 * Accepts "cash,card" or an array. Returns null when nothing valid was requested.
 */
export function buildPaymentMethodFilter(raw: string | string[]): Record<string, any> | null {
  const list = (Array.isArray(raw) ? raw : String(raw).split(','))
    .map(s => String(s).trim())
    .filter(s => PAYMENT_METHODS.includes(s))
  if (!list.length) return null
  return { $or: [{ 'payments.method': { $in: list } }, { paymentMethod: { $in: list } }] }
}

/** Companion documents printed alongside a sales document, each with its own counter. */
export type CompanionDocKind = 'certificate' | 'ppprotocol'

// Counter key + display prefix come from the sequences registry; only the invoice field
// each companion number is written to is specific to this module.
const COMPANION_SEQUENCE: Record<CompanionDocKind, { group: SequenceGroup; field: string }> = {
  certificate: { group: 'certificate', field: 'certificateNumber' },
  ppprotocol: { group: 'pp_protocol', field: 'ppProtocolNumber' },
}

export function companionNumberField(kind: CompanionDocKind): string {
  return COMPANION_SEQUENCE[kind].field
}

/**
 * Allocate the next Декларация за съответствие / Приемо-предавателен протокол number.
 * These counters are independent of the invoice series — the companion document carries its
 * own running number, as it does in the legacy system.
 */
export async function getNextCompanionNumber(orgId: string, kind: CompanionDocKind): Promise<string> {
  const { group } = COMPANION_SEQUENCE[kind]
  const key = sequenceDefFor(group, 'issued')!.prefix
  const year = new Date().getFullYear()
  const numberFromService = await getNextNumber(orgId, key, 5, year)
  const seqPart = numberFromService.split('-').pop()!
  const display = await resolveSequencePrefix(orgId, group, 'issued')
  return `${display}-${year}-${seqPart}`
}

export const invoiceController = new Elysia({ prefix: '/org/:orgId/invoices' })
  .use(AppAuthService)
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.search) {
      // Two-stage search: search invoices by their fields + contacts by name
      const searchStr = query.search as string
      const invoiceFilter = buildSearchFilter(searchStr, ['invoiceNumber', 'notes', 'reference'])
      // Also find contacts matching the search
      const contactFilter = buildSearchFilter(searchStr, ['companyName', 'firstName', 'lastName'], {
        lowered: {
          companyName: 'companyNameLower',
          firstName: 'firstNameLower',
          lastName: 'lastNameLower',
        },
      })
      const matchingContacts = await r.contacts.findMany({ orgId, ...contactFilter } as any)
      const contactIds = matchingContacts.map((c: any) => c.id || c._id)

      if (contactIds.length > 0 && invoiceFilter.$or) {
        // Combine: invoice fields match OR contactId in matching contacts
        filter.$or = [...invoiceFilter.$or, { contactId: { $in: contactIds } }]
      } else if (contactIds.length > 0 && invoiceFilter.$and) {
        filter.$or = [invoiceFilter, { contactId: { $in: contactIds } }]
      } else {
        Object.assign(filter, invoiceFilter)
      }
    }
    if (query.type) filter.type = query.type
    // `types` (comma-separated) supports the Reporting Outgoing tab → invoice + credit_note + debit_note in one query.
    if (query.types) {
      const list = String(query.types).split(',').map(s => s.trim()).filter(Boolean)
      if (list.length === 1) filter.type = list[0]
      else if (list.length > 1) filter.type = { $in: list }
    }
    if (query.direction) filter.direction = query.direction
    if (query.status) {
      const list = String(query.status).split(',').map(s => s.trim()).filter(Boolean)
      if (list.length === 1) filter.status = list[0]
      else if (list.length > 1) filter.status = { $in: list }
    }
    if (query.contactId) filter.contactId = query.contactId
    if (query.tags) {
      const tagList = Array.isArray(query.tags) ? query.tags : (query.tags as string).split(',')
      filter.tags = { $in: tagList }
    }
    if (query.paymentMethod) {
      const cond = buildPaymentMethodFilter(query.paymentMethod as string | string[])
      // $and, not $or — the search branch above may already own filter.$or.
      if (cond) (filter.$and ||= []).push(cond)
    }
    if (query.startDate || query.endDate) {
      filter.issueDate = {}
      if (query.startDate) filter.issueDate.$gte = new Date(query.startDate as string)
      if (query.endDate) filter.issueDate.$lte = new Date(query.endDate as string)
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.invoices.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })

    // Manual batch lookups to replace .populate()
    const contactIds = new Set<string>()
    const relatedInvoiceIds = new Set<string>()
    for (const item of result.items) {
      if (item.contactId) contactIds.add(item.contactId)
      if ((item as any).convertedInvoiceId) relatedInvoiceIds.add((item as any).convertedInvoiceId)
      if ((item as any).proformaId) relatedInvoiceIds.add((item as any).proformaId)
      if ((item as any).relatedInvoiceId) relatedInvoiceIds.add((item as any).relatedInvoiceId)
    }

    const [contacts, relatedInvoices] = await Promise.all([
      contactIds.size > 0 ? r.contacts.findMany({ id: { $in: [...contactIds] } } as any) : [],
      relatedInvoiceIds.size > 0 ? r.invoices.findMany({ id: { $in: [...relatedInvoiceIds] } } as any) : [],
    ])

    const contactMap = new Map(contacts.map(c => [c.id, c]))
    const invoiceMap = new Map(relatedInvoices.map(i => [i.id, i]))

    const invoices = result.items.map((item: any) => {
      const contact = item.contactId ? contactMap.get(item.contactId) : null
      const convertedInv = item.convertedInvoiceId ? invoiceMap.get(item.convertedInvoiceId) : null
      const proformaInv = item.proformaId ? invoiceMap.get(item.proformaId) : null
      const relatedInv = item.relatedInvoiceId ? invoiceMap.get(item.relatedInvoiceId) : null
      return {
        ...item,
        number: item.invoiceNumber,
        contactName: contact
          ? ((contact as any).companyName || [(contact as any).firstName, (contact as any).lastName].filter(Boolean).join(' ') || '')
          : '',
        // FR-10 (#19): the list-row "send by email" action prefills the recipient from here,
        // so opening the dialog costs no extra round trip. The contacts are already loaded.
        contactEmail: contact ? ((contact as any).email || '') : '',
        convertedInvoiceNumber: convertedInv?.invoiceNumber || '',
        proformaNumber: proformaInv?.invoiceNumber || '',
        relatedInvoiceNumber: relatedInv?.invoiceNumber || '',
        statusHistory: synthesizeStatusHistory(item),
      }
    })
    const { items: _raw, ...pagination } = result
    return { invoices, ...pagination }
  }, { isSignIn: true })
  // Preview the next invoice number for a doc type without incrementing the counter.
  // Used by form views to show "INV-2026-00019" instead of an "auto-assign" placeholder.
  // Reads-only: combines current counter value + 1 + display-prefix override.
  .get('/peek-next', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const t = (query.type as string) || 'invoice'
    const direction = (query.direction as string) || 'outgoing'
    const wantDraft = (query.status as string) === 'draft' && t !== 'cash_sale'
    const year = new Date().getFullYear()

    let key: string
    let prefix: string
    if (wantDraft) {
      key = draftSequenceKeyFor(t, direction) || sequenceKeyFor(t, direction)
      prefix = draftPrefixFor(t, direction) || prefixFor(t, direction)
    } else {
      key = sequenceKeyFor(t, direction)
      prefix = prefixFor(t, direction)
    }

    // For SALES_DOC keep the reconciliation behaviour aligned with allocate-time.
    const minValue = !wantDraft ? await currentMaxSuffix(orgId, key, year) : 0
    const counter = await getCurrentNumber(orgId, key, year)
    const next = Math.max(counter, minValue) + 1
    const display = await resolveDisplayPrefix(orgId, prefix, key)
    const seq = String(next).padStart(5, '0')
    return { next: `${display}-${year}-${seq}`, counter, prefix: display }
  }, { isSignIn: true })
  // KPI summary for list pages. Accepts the SAME scope filters as the list
  // (type/types/direction/contactId/tags/dates) so the cards reflect the active view.
  // Delegates to getInvoiceSummary (shared with the Portal dashboard).
  // Cloud-only (Mongo aggregation); desktop-ui does not request it.
  .get('/summary', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const summary = await getInvoiceSummary(orgId, query as any)
    return { summary }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status, headers }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      // #155: a retried create with its Idempotency-Key returns the document it made. Hashed
      // before anything below rewrites the body.
      let key: string | undefined
      try {
        key = readIdempotencyKey(headers)
      } catch (e: any) {
        return status(e.statusCode, { code: e.code, message: e.message })
      }
      const hash = key ? requestHash('invoice.create', body) : undefined
      const createCtx: CreateCtx = {
        orgId,
        user,
        isCashSale: body.type === 'cash_sale',
        skipStockMovement: (body as any).skipStockMovement === true,
        allowNegativeStock: (body as any).allowNegativeStock === true,
        pendingTransferIds: (body as any).pendingTransferIds,
      }
      if (key) {
        const existing = await Invoice.findOne({ orgId, clientKey: key }).lean().exec()
        if (existing) return settleCreate(existing, hash!, createCtx, status)
      }

      // FR-20.55: on a master whose licence has run out, no new invoice, proforma or cash sale. A
      // credit or debit note, an incoming bill, and the retry of a create that already happened (just
      // above) go through. Asked here, with the body, because the auth plugins never read one.
      const unlicensed = await licenceGate('POST', '/api/org/:orgId/invoices', orgId, body)
      if (unlicensed) return status(402, unlicensed)

      // Sanitize empty string IDs to undefined
      if (!body.contactId) body.contactId = undefined

      // Inline product-master updates ride alongside the bill in one Mongo transaction.
      // Purchase bills only; not reachable from desktop/SQLite (desktop-ui has no bills form).
      const productUpdates = (body as any).productUpdates as any[] | undefined
      delete (body as any).productUpdates
      const withProductUpdates = Array.isArray(productUpdates) && productUpdates.length > 0
      if (withProductUpdates && !(body.type === 'invoice' && body.direction === 'incoming')) {
        return status(422, { message: 'productUpdates is only supported for purchase bills' })
      }

      // Reservation-consuming lines: sales invoices only, capped at the reserved quantity.
      const refErr = await validateReservationLineRefs(orgId, { type: body.type, direction: body.direction, lines: body.lines })
      if (refErr) return status(422, { message: refErr })

      // Credit/debit notes must reference the issued invoice they correct (same side + contact).
      const relErr = await validateRelatedInvoiceRef(orgId, {
        type: body.type,
        direction: body.direction,
        contactId: body.contactId,
        relatedInvoiceId: body.relatedInvoiceId,
      })
      if (relErr) return status(422, { message: relErr })

      // Compute defaults for fields the form may not provide
      const lines = (body.lines || []).map((l: any) => {
        const subtotal = l.quantity * l.unitPrice
        const disc = subtotal * ((l.discount || 0) / 100)
        const taxAmt = (subtotal - disc) * ((l.taxRate || 0) / 100)
        return {
          ...l,
          unit: l.unit || 'pcs',
          description: l.description || '',
          taxAmount: l.taxAmount ?? taxAmt,
          lineTotal: l.lineTotal ?? (subtotal - disc + taxAmt),
        }
      })

      const taxTotal = body.taxTotal ?? body.taxAmount ?? lines.reduce((s: number, l: any) => s + (l.taxAmount || 0), 0)
      const exchangeRate = body.exchangeRate || 1
      const dueDate = body.dueDate || body.issueDate

      const isCashSale = body.type === 'cash_sale'
      const initialStatus = isCashSale ? 'paid' : 'draft'
      // Import-time stock controls (cash sales only) — behavioral flags, not doc fields.
      const skipStockMovement = (body as any).skipStockMovement === true
      const allowNegativeStock = (body as any).allowNegativeStock === true
      delete (body as any).skipStockMovement
      delete (body as any).allowNegativeStock

      // Allocate + create with retry on duplicate-key. A collision indicates the sequence
      // counter drifted (e.g. legacy data) — the reconcile-on-allocate path inside
      // getNextInvoiceNumber catches up, so a retry usually succeeds on the 2nd attempt.
      // Drafts use a separate per-type DRAFT_* counter; cash sales skip drafts entirely.
      let invoice: any
      let invoiceNumber = ''
      let lastErr: any
      let updatedProductIds: string[] = []
      /**
       * ⚠ A keyed cash sale is INSERTED before its number is drawn, under a placeholder.
       * Its CS number is a legal sequence: allocated first, every losing duplicate of a racing
       * retry would burn one and leave a gap. Only the request whose insert wins numbers it.
       * (Other types draw only DRAFT numbers here, whose gaps mean nothing.)
       */
      const keyedCashSale = !!key && isCashSale && !withProductUpdates
      for (let attempt = 0; attempt < 3; attempt++) {
        if (keyedCashSale) {
          invoiceNumber = `${PENDING_NUMBER}${key}`
        } else if (initialStatus === 'draft') {
          const draftNum = await getNextDraftInvoiceNumber(orgId, body.direction, body.type)
          // Cash sales never reach here (initialStatus='paid'); other types always get a draft prefix.
          invoiceNumber = draftNum || (await getNextInvoiceNumber(orgId, body.direction, body.type))
        } else {
          invoiceNumber = await getNextInvoiceNumber(orgId, body.direction, body.type)
        }
        try {
          const docFields = {
            ...body,
            lines,
            dueDate,
            invoiceNumber,
            orgId,
            direction: isCashSale ? 'outgoing' : body.direction,
            status: initialStatus,
            statusHistory: [statusEntry(initialStatus, undefined, user.id, isCashSale ? 'cash_sale_created' : 'created')],
            numberHistory: [{ number: invoiceNumber, allocatedAt: new Date(), status: initialStatus }],
            taxTotal,
            totalBase: body.totalBase ?? +(body.total * exchangeRate).toFixed(2),
            billingAddress: body.billingAddress || { street: '-', city: '-', postalCode: '-', country: '-' },
            amountPaid: isCashSale ? body.total : 0,
            amountDue: isCashSale ? 0 : body.total,
            paidAt: isCashSale ? new Date() : undefined,
            ...(key ? { clientKey: key, requestHash: hash, leaseUntil: new Date(Date.now() + LEASE_MS) } : {}),
            createdBy: user.id,
          }
          if (withProductUpdates) {
            const res = await createInvoiceWithProductUpdates(docFields as any, productUpdates!)
            updatedProductIds = res.updatedProductIds
            invoice = await r.invoices.findOne({ id: res.invoiceId, orgId } as any)
          } else {
            invoice = await r.invoices.create(docFields as any)
          }
          break
        } catch (e: any) {
          lastErr = e
          if (e instanceof GRValidationError) return status(422, { message: e.message })
          // A racing duplicate of this keyed request won the insert: answer as it does.
          // (The DAL's DuplicateError names the index's fields in its message. A keyed cash
          // sale's placeholder number is unique per key, so a duplicate on EITHER index means
          // the same request already exists — Mongo may report the number's index first.)
          if (key && (isDuplicateKey(e) || /clientKey/.test(String(e?.message ?? '')) || (keyedCashSale && e?.code === 'DUPLICATE'))) {
            const existing = await Invoice.findOne({ orgId, clientKey: key }).lean().exec()
            if (existing) return settleCreate(existing, hash!, createCtx, status)
          }
          if (e?.code !== 'DUPLICATE') throw e
          // Duplicate on (orgId, invoiceNumber) — reconcile bumps the counter; retry.
        }
      }
      if (!invoice) {
        return status(409, { message: `Could not allocate invoice number after 3 attempts: ${lastErr?.message || 'duplicate'}` })
      }
      if (keyedCashSale) {
        const numbered = await numberPendingCashSale(orgId, invoice.id, user.id)
        if (!numbered) {
          await r.invoices.delete(invoice.id)
          return status(409, { message: 'Could not allocate the cash sale number after 3 attempts' })
        }
        invoice = numbered
      }
      await upsertTags(orgId, 'invoice', body.tags)

      createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'invoicing', entityType: 'invoice', entityId: invoice.id, entityName: (invoice as any).invoiceNumber })

      // Audit: one entry per product-master update, correlated to the bill.
      for (const pid of updatedProductIds) {
        createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'warehouse', entityType: 'product', entityId: pid, correlationId: invoice.id })
      }

      // Cash sales trigger stock movement immediately (unless the import opted out)
      if (isCashSale && !skipStockMovement) {
        // Confirm pending transfers first (cross-warehouse)
        const pendingTransferIds = (body as any).pendingTransferIds as string[] | undefined
        if (pendingTransferIds?.length) {
          const { confirmTransferMovements } = await import('services/biz/stock-transfer.service')
          try {
            await confirmTransferMovements(pendingTransferIds)
            await r.invoices.update(invoice.id, { pendingTransferIds } as any)
          } catch (e: any) {
            await r.invoices.delete(invoice.id)
            return status(400, { message: `Transfer confirmation failed: ${e.message}` })
          }
        }

        try {
          await createInvoiceStockMovement(invoice, user.id, undefined, allowNegativeStock ? { allowNegative: true } : undefined)
        } catch (e: any) {
          // Roll back the cash sale if stock validation fails
          await r.invoices.delete(invoice.id)
          return status(400, { message: e.message })
        }
      }

      // Order/reservation-linked creates (API imports, conversion round-trips) derive
      // their counters immediately. Placed AFTER the cash-sale movement/rollback block
      // so a rolled-back cash sale never leaves counters pointing at a deleted doc.
      await syncOrderForInvoice(orgId, invoice, user.id)

      if (key) {
        await Invoice.updateOne({ _id: invoice.id, orgId }, { $set: { completedAt: new Date() }, $unset: { leaseUntil: 1 } }).exec()
      }
      return { invoice }
    },
    {
      isSignIn: true,
      body: t.Object({
        type: t.Union([
          t.Literal('invoice'),
          t.Literal('proforma'),
          t.Literal('credit_note'),
          t.Literal('debit_note'),
          t.Literal('cash_sale'),
        ]),
        direction: t.Union([t.Literal('outgoing'), t.Literal('incoming')]),
        contactId: t.Optional(t.String()),
        issueDate: t.String(),
        dueDate: t.Optional(t.String()),
        currency: t.String(),
        exchangeRate: t.Optional(t.Number()),
        reference: t.Optional(t.String()),
        relatedInvoiceId: t.Optional(t.String()),
        // Order linkage: lets API clients create bills against an ORDO / conversion
        // invoices against an ORDI (the UI import and conversion flows set these
        // server-side).
        orderId: t.Optional(t.String()),
        orderGroupId: t.Optional(t.String()),
        internalOrderId: t.Optional(t.String()),
        footer: t.Optional(t.String()),
        lines: t.Array(t.Object({
          productId: t.Optional(t.String()),
          product: t.Optional(t.String()),
          description: t.Optional(t.String()),
          quantity: t.Number(),
          unit: t.Optional(t.String()),
          unitPrice: t.Number(),
          discount: t.Optional(t.Number()),
          taxRate: t.Optional(t.Number()),
          taxAmount: t.Optional(t.Number()),
          lineTotal: t.Optional(t.Number()),
          accountId: t.Optional(t.String()),
          warehouseId: t.Optional(t.String()),
          priceExplanation: t.Optional(t.Array(t.Object({
            type: t.Union([t.Literal('base'), t.Literal('category'), t.Literal('tag'), t.Literal('contact'), t.Literal('tier'), t.Literal('override')]),
            label: t.String(),
            price: t.Number(),
          }))),
          // Order linkage: round-tripped by the form so edits of conversion invoices /
          // ORDO-linked bills keep their reservation/receipt references.
          orderRef: t.Optional(orderRefBody),
          sourceText: t.Optional(t.String()),
        })),
        subtotal: t.Number(),
        discountTotal: t.Optional(t.Number()),
        taxTotal: t.Optional(t.Number()),
        taxAmount: t.Optional(t.Number()),
        total: t.Number(),
        totalBase: t.Optional(t.Number()),
        paymentMethod: t.Optional(t.String()),
        preparedBy: t.Optional(t.String()),
        placeOfTransaction: t.Optional(t.String()),
        // Cash-sale imports: skip the automatic dispatch (inventory baseline already
        // reflects the sales) / tolerate negative stock while migrating.
        skipStockMovement: t.Optional(t.Boolean()),
        allowNegativeStock: t.Optional(t.Boolean()),
        notes: t.Optional(t.String()),
        // Free text printed under the number block of the form; stored with the document.
        printNote: t.Optional(t.String()),
        // Free text printed in the companion documents' "additional information" block.
        companionNote: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
        terms: t.Optional(t.String()),
        billingAddress: t.Optional(t.Object({
          street: t.Optional(t.String()),
          city: t.Optional(t.String()),
          state: t.Optional(t.String()),
          postalCode: t.Optional(t.String()),
          country: t.Optional(t.String()),
        })),
        shippingAddress: t.Optional(t.Object({
          street: t.Optional(t.String()),
          city: t.Optional(t.String()),
          state: t.Optional(t.String()),
          postalCode: t.Optional(t.String()),
          country: t.Optional(t.String()),
        })),
        // Purchase bills only: inline product-master updates applied atomically with the bill.
        productUpdates: t.Optional(t.Array(t.Any())),
      }),
    },
  )
  .get('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const invoice = await r.invoices.findOne({ id, orgId } as any)
    if (!invoice) return status(404, { message: 'Invoice not found' })

    // Manual lookup for contact
    let contact = null
    if (invoice.contactId) {
      contact = await r.contacts.findById(invoice.contactId)
    }

    return {
      invoice: {
        ...invoice,
        statusHistory: synthesizeStatusHistory(invoice),
        contactId: contact ? { _id: contact.id, id: contact.id, companyName: (contact as any).companyName, firstName: (contact as any).firstName, lastName: (contact as any).lastName, email: (contact as any).email } : invoice.contactId,
      },
    }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      // Sanitize empty string IDs to undefined
      if (!body.contactId) body.contactId = undefined

      const existing = await r.invoices.findOne({ id, orgId } as any)
      if (!existing) return status(404, { message: 'Invoice not found' })

      // Inline product-master updates (purchase bills only) — extracted before the $set below.
      const productUpdates = (body as any).productUpdates as any[] | undefined
      delete (body as any).productUpdates

      // ⚠ Every document is editable in every status, including after it has been posted to
      // the general ledger. There used to be a 409 here when a posted JournalEntry referenced
      // the invoice, with void/credit-note as the remediation; it was removed deliberately.
      //
      // The consequence is NOT cosmetic and is not handled anywhere downstream: the
      // JournalEntry keeps the amounts it was posted with, so an edit to totals, lines, tax
      // or dates leaves the ledger disagreeing with the document it was derived from. Trial
      // balance, P&L and balance sheet all read the JE, not the invoice — they will report
      // the pre-edit figures with nothing marking them stale. Repost is a manual act.
      //
      // Requested with that trade-off stated and chosen; see the commit for the decision.
      // If accounting integrity is wanted back, the fix is to re-post on edit (void the old
      // JE + post a new one), not to restore the block — the block only moved the problem to
      // whoever needed to correct a document.

      // Reservation-consuming lines: sales invoices only, capped at the reserved quantity
      // across all live invoices (this document's previous version excluded).
      if (body.lines) {
        const refErr = await validateReservationLineRefs(
          orgId,
          { type: existing.type, direction: (existing as any).direction, lines: body.lines },
          id,
        )
        if (refErr) return status(422, { message: refErr })
      }

      // Credit/debit notes must keep a valid related-invoice reference. Validate the
      // EFFECTIVE values (body wins, existing fills the gaps) so a partial PUT can't
      // silently clear or corrupt the link.
      const relErr = await validateRelatedInvoiceRef(orgId, {
        type: existing.type,
        direction: (existing as any).direction,
        contactId: body.contactId !== undefined ? body.contactId : (existing as any).contactId,
        relatedInvoiceId: body.relatedInvoiceId !== undefined ? body.relatedInvoiceId : (existing as any).relatedInvoiceId,
      })
      if (relErr) return status(422, { message: relErr })

      // Keep the canonical number/status fields owned by the controller — never let edits
      // overwrite them through the body schema (defence in depth: schema already excludes them).
      delete (body as any).invoiceNumber
      delete (body as any).status
      delete (body as any).draftNumber
      delete (body as any).numberHistory

      let updated: any
      if (Array.isArray(productUpdates) && productUpdates.length > 0) {
        if (!(existing.type === 'invoice' && (existing as any).direction === 'incoming')) {
          return status(422, { message: 'productUpdates is only supported for purchase bills' })
        }
        // Bill $set + product bulk-update in one transaction; no stock movement here
        // (bills touch stock only via /receive). Not reachable from desktop/SQLite.
        let updatedProductIds: string[] = []
        try {
          const res = await updateInvoiceWithProductUpdates({ orgId, invoiceId: id, update: body as any, productUpdates })
          updatedProductIds = res.updatedProductIds
        } catch (e: any) {
          if (e instanceof GRValidationError) return status(422, { message: e.message })
          throw e
        }
        updated = await r.invoices.findOne({ id, orgId } as any)
        for (const pid of updatedProductIds) {
          createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'warehouse', entityType: 'product', entityId: pid, correlationId: id })
        }
      } else {
        updated = await r.invoices.updateInOrg(id, orgId, body as any)
      }

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: (updated as any)?.invoiceNumber || (existing as any)?.invoiceNumber, changes: diffChanges(existing as any, updated as any) })

      // Quantity edits on ORD-linked documents shift the derived reservation/receipt state.
      await syncOrderForInvoice(orgId, updated || existing, user.id)

      // An issued invoice edited to cash (or its total changed while cash) is paid; one edited
      // away from cash gives back the payment that rule recorded. Drafts are untouched.
      const settlement = await syncCashSettlement(orgId, id, user.id)
      if (settlement.action !== 'none') updated = await r.invoices.findOne({ id, orgId } as any)

      return { invoice: updated }
    },
    {
      isSignIn: true,
      body: t.Object({
        contactId: t.Optional(t.String()),
        issueDate: t.Optional(t.String()),
        dueDate: t.Optional(t.String()),
        currency: t.Optional(t.String()),
        exchangeRate: t.Optional(t.Number()),
        reference: t.Optional(t.String()),
        relatedInvoiceId: t.Optional(t.String()),
        orderId: t.Optional(t.String()),
        orderGroupId: t.Optional(t.String()),
        internalOrderId: t.Optional(t.String()),
        footer: t.Optional(t.String()),
        lines: t.Optional(t.Array(t.Object({
          productId: t.Optional(t.String()),
          product: t.Optional(t.String()),
          description: t.Optional(t.String()),
          quantity: t.Number(),
          unit: t.Optional(t.String()),
          unitPrice: t.Number(),
          discount: t.Optional(t.Number()),
          taxRate: t.Optional(t.Number()),
          taxAmount: t.Optional(t.Number()),
          lineTotal: t.Optional(t.Number()),
          warehouseId: t.Optional(t.String()),
          priceExplanation: t.Optional(t.Array(t.Object({
            type: t.Union([t.Literal('base'), t.Literal('category'), t.Literal('tag'), t.Literal('contact'), t.Literal('tier'), t.Literal('override')]),
            label: t.String(),
            price: t.Number(),
          }))),
          // Order linkage: round-tripped by the form so edits of conversion invoices /
          // ORDO-linked bills keep their reservation/receipt references.
          orderRef: t.Optional(orderRefBody),
          sourceText: t.Optional(t.String()),
        }))),
        subtotal: t.Optional(t.Number()),
        discountTotal: t.Optional(t.Number()),
        taxTotal: t.Optional(t.Number()),
        taxAmount: t.Optional(t.Number()),
        total: t.Optional(t.Number()),
        totalBase: t.Optional(t.Number()),
        amountDue: t.Optional(t.Number()),
        paymentMethod: t.Optional(t.String()),
        preparedBy: t.Optional(t.String()),
        placeOfTransaction: t.Optional(t.String()),
        billingAddress: t.Optional(t.Object({
          street: t.Optional(t.String()),
          city: t.Optional(t.String()),
          state: t.Optional(t.String()),
          postalCode: t.Optional(t.String()),
          country: t.Optional(t.String()),
        })),
        notes: t.Optional(t.String()),
        printNote: t.Optional(t.String()),
        // Free text printed in the companion documents' "additional information" block.
        companionNote: t.Optional(t.String()),
        tags: t.Optional(t.Array(t.String())),
        terms: t.Optional(t.String()),
        // Purchase bills only: inline product-master updates applied atomically with the edit.
        productUpdates: t.Optional(t.Array(t.Any())),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const existing = await r.invoices.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Invoice not found' })
    if (existing.status !== 'draft') return status(400, { message: 'Can only delete draft invoices' })

    await r.invoices.deleteInOrg(id, orgId)

    // Deleting a draft conversion invoice re-opens the order reservations it consumed.
    await syncOrderForInvoice(orgId, existing, user.id)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: (existing as any)?.invoiceNumber })

    return { message: 'Invoice deleted' }
  }, { isSignIn: true })
  .post('/:id/send', async ({ params: { orgId, id }, body, user, status, headers }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    let key: string | undefined
    try {
      key = readIdempotencyKey(headers)
    } catch (e: any) {
      return status(e.statusCode, { code: e.code, message: e.message })
    }
    const hash = key ? requestHash(`invoice.send:${id}`, body ?? {}) : undefined

    /**
     * The issue this key already made, or the one still running under it: the issued document
     * comes back, never a second dispatch or a second number. Null when the holder's lease
     * lapsed (a crash) — the caller then takes the claim over and finishes the issue.
     */
    const replayIssue = async (): Promise<any> => {
      const deadline = Date.now() + WAIT_MS
      for (;;) {
        const doc = await Invoice.findOne({ _id: id, orgId }).lean().exec() as any
        if (!doc || doc.issue?.clientKey !== key) return null
        if (doc.issue.requestHash !== hash) {
          return status(422, { code: 'idempotency_key_reused', message: 'This Idempotency-Key was already used for a different request' })
        }
        if (doc.status !== 'draft') return { invoice: await r.invoices.findOne({ id, orgId } as any) }
        if (!doc.issue.leaseUntil || new Date(doc.issue.leaseUntil).getTime() < Date.now()) return null
        if (Date.now() >= deadline) {
          return status(409, { code: 'idempotency_in_progress', message: 'This document is still being issued — retry with the same Idempotency-Key.' })
        }
        await new Promise(res => setTimeout(res, 150))
      }
    }

    const invoice = await r.invoices.findOne({ id, orgId } as any)
    if (!invoice) return status(404, { message: 'Invoice not found' })
    if (key && (invoice as any).issue?.clientKey === key) {
      const replayed = await replayIssue()
      if (replayed) return replayed
    }
    if (invoice.status !== 'draft') return status(400, { message: 'Invoice is not in draft status' })

    /**
     * ⚠ CLAIM the draft before anything moves. Two Issue clicks (or a retry) used to both pass
     * the `draft` check above, so both dispatched the stock, both drew an issued number and both
     * posted a journal entry. Exactly one request holds this claim; a crashed holder's lease
     * lapses and the next Issue finishes what it started.
     */
    const now = new Date()
    const claimed = await Invoice.findOneAndUpdate(
      {
        _id: id, orgId, status: 'draft',
        $or: [{ 'issue.leaseUntil': { $exists: false } }, { 'issue.leaseUntil': null }, { 'issue.leaseUntil': { $lt: now } }],
      },
      { $set: { issue: { clientKey: key, requestHash: hash, leaseUntil: new Date(now.getTime() + LEASE_MS) } } },
      { new: true },
    ).exec()
    if (!claimed) {
      if (key) {
        const replayed = await replayIssue()
        if (replayed) return replayed
      }
      return status(409, { code: 'issue_in_progress', message: 'This document is already being issued' })
    }
    /** Give the draft back — a failed issue must not leave it claimed. */
    const release = () => Invoice.updateOne({ _id: id, orgId, status: 'draft' }, { $unset: { issue: 1 } }).exec()

    const newStatus = invoice.direction === 'incoming' ? 'received' : 'sent'

    // Confirm pending transfer movements before dispatch (cross-warehouse transfers)
    const pendingTransferIds = (body as any)?.pendingTransferIds as string[] | undefined
    if (pendingTransferIds?.length && !(invoice as any).pendingTransferIds?.length) {
      const { confirmTransferMovements } = await import('services/biz/stock-transfer.service')
      try {
        await confirmTransferMovements(pendingTransferIds)
      } catch (e: any) {
        await release()
        return status(400, { message: `Transfer confirmation failed: ${e.message}` })
      }
    }

    // A crashed issue may already have dispatched: its movement carries this invoice's id.
    if (!(await StockMovement.exists({ orgId, invoiceId: id }).exec())) {
      try {
        await createInvoiceStockMovement(invoice, user.id)
      } catch (e: any) {
        await release()
        return status(400, { message: e.message })
      }
    }

    // Allocate the issued invoice number from the type-appropriate counter and replace the
    // draft number on the document. Persist the previous draft number for audit history.
    const draftNumber = (invoice as any).invoiceNumber
    const issuedNumber = await getNextInvoiceNumber(orgId, invoice.direction as string, invoice.type as string)

    const history = [...((invoice as any).statusHistory || []), statusEntry(newStatus, invoice.status, user.id)]
    const numberHistory = [
      ...((invoice as any).numberHistory || []),
      { number: issuedNumber, allocatedAt: new Date(), status: newStatus },
    ]
    const updateData: any = {
      status: newStatus,
      sentAt: new Date(),
      statusHistory: history,
      invoiceNumber: issuedNumber,
      draftNumber,
      numberHistory,
      'issue.completedAt': new Date(),
      'issue.leaseUntil': null,
    }
    if (pendingTransferIds?.length) updateData.pendingTransferIds = pendingTransferIds
    const updated = await r.invoices.updateInOrg(id, orgId, updateData)

    // ORD-linked documents: re-derive the order's reservation/receipt state
    // (dispatch consumes holds; incoming bills book receipts).
    await syncOrderForInvoice(orgId, updated || invoice, user.id)

    createAuditEntry({ orgId, userId: user.id, action: 'send', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: issuedNumber, changes: { draftNumber: { from: draftNumber, to: null }, invoiceNumber: { from: draftNumber, to: issuedNumber } } })

    // Emit for cross-module journal entry creation
    eventBus.emit('invoice.posted', {
      invoiceId: id,
      orgId,
      userId: user.id,
      direction: invoice.direction,
      total: invoice.total,
      contactId: invoice.contactId as string,
    })

    // A cash invoice is paid the moment it is issued — no separate "record payment" step.
    const settlement = await syncCashSettlement(orgId, id, user.id)
    if (settlement.action !== 'none') return { invoice: await r.invoices.findOne({ id, orgId } as any) }

    return { invoice: updated }
  }, { isSignIn: true })
  .post('/:id/receive', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const invoice = await r.invoices.findOne({ id, orgId } as any)
    if (!invoice) return status(404, { message: 'Invoice not found' })
    if (invoice.direction !== 'incoming') return status(400, { message: 'Only incoming invoices can be received' })
    if (invoice.status !== 'draft') return status(400, { message: 'Invoice is not in draft status' })

    // Allocate the issued BILL-* number, preserve the prior draft number for audit history.
    const draftNumber = (invoice as any).invoiceNumber
    const issuedNumber = await getNextInvoiceNumber(orgId, 'incoming', invoice.type as string)
    const history = [...((invoice as any).statusHistory || []), statusEntry('received', invoice.status, user.id)]
    const numberHistory = [
      ...((invoice as any).numberHistory || []),
      { number: issuedNumber, allocatedAt: new Date(), status: 'received' },
    ]
    const updated = await r.invoices.updateInOrg(id, orgId, {
      status: 'received',
      sentAt: new Date(),
      statusHistory: history,
      invoiceNumber: issuedNumber,
      draftNumber,
      numberHistory,
    } as any)

    await createInvoiceStockMovement(updated || invoice, user.id)

    // ORD-linked bills: book the receipt onto the order (receivedQuantity, status, holds).
    await syncOrderForInvoice(orgId, updated || invoice, user.id)

    createAuditEntry({ orgId, userId: user.id, action: 'receive', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: issuedNumber, changes: { invoiceNumber: { from: draftNumber, to: issuedNumber } } })

    return { invoice: updated }
  }, { isSignIn: true })
  .post(
    '/:id/payments',
    async ({ params: { orgId, id }, body, user, status, headers }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      let key: string | undefined
      try {
        key = readIdempotencyKey(headers)
      } catch (e: any) {
        return status(e.statusCode, { code: e.code, message: e.message })
      }
      const hash = key ? requestHash(`invoice.payment:${id}`, body) : undefined
      /** The payment this key already recorded: the invoice comes back, the payment is not added again. */
      const replayPayment = async (doc: any) => {
        const prior = (doc?.payments || []).find((p: any) => p.clientKey === key)
        if (!prior) return null
        if (prior.requestHash !== hash) {
          return status(422, { code: 'idempotency_key_reused', message: 'This Idempotency-Key was already used for a different request' })
        }
        return { invoice: await r.invoices.findOne({ id, orgId } as any) }
      }

      const invoice = await r.invoices.findOne({ id, orgId } as any)
      if (!invoice) return status(404, { message: 'Invoice not found' })
      if (key) {
        const replayed = await replayPayment(invoice)
        if (replayed) return replayed
      }
      if (['voided', 'cancelled', 'paid'].includes(invoice.status))
        return status(400, { message: 'Cannot record payment on this invoice' })

      /**
       * ⚠ ONE atomic update: append the payment, add it to `amountPaid`, and derive
       * `amountDue`, `status`, `paidAt` and the status history from the RESULT, inside the
       * database. Read-modify-write here lost a payment whenever two were recorded at once (each
       * wrote back the array it had read), and let a retried request pay twice. The key, when
       * sent, is part of the filter: a second request with it matches nothing.
       */
      const { ObjectId } = (Invoice.base as any).Types
      const oid = (v: string) => new ObjectId(v)
      const at = new Date()
      const payment = {
        // Mongoose gives array subdocuments an _id; a raw update has to do it itself.
        _id: new ObjectId(),
        date: new Date(body.date),
        amount: body.amount,
        method: body.method,
        ...(body.reference !== undefined ? { reference: body.reference } : {}),
        ...(key ? { clientKey: key, requestHash: hash } : {}),
      }
      // FR-20.4: a raw driver write, which the Mongoose write guard cannot see — so it asks first.
      await assertHomeIsHere(orgId)
      const after = await Invoice.collection.findOneAndUpdate(
        {
          _id: oid(id), orgId: oid(orgId),
          status: { $nin: ['voided', 'cancelled', 'paid'] },
          ...(key ? { 'payments.clientKey': { $ne: key } } : {}),
        },
        [
          {
            $set: {
              _priorStatus: '$status',
              // $literal: a reference typed as "$…" is text, not a field path.
              payments: { $concatArrays: [{ $ifNull: ['$payments', []] }, [{ $literal: payment }]] },
              amountPaid: { $add: [{ $ifNull: ['$amountPaid', 0] }, body.amount] },
            },
          },
          { $set: { amountDue: { $subtract: ['$total', '$amountPaid'] } } },
          { $set: { status: { $cond: [{ $lte: ['$amountDue', 0] }, 'paid', 'partially_paid'] } } },
          {
            $set: {
              paidAt: { $cond: [{ $lte: ['$amountDue', 0] }, at, '$paidAt'] },
              statusHistory: {
                $cond: [
                  { $ne: ['$status', '$_priorStatus'] },
                  {
                    $concatArrays: [
                      { $ifNull: ['$statusHistory', []] },
                      [{
                        status: '$status',
                        fromStatus: '$_priorStatus',
                        changedAt: at,
                        changedBy: oid(String(user.id)),
                        reason: { $literal: `payment ${body.amount} ${body.method}` },
                      }],
                    ],
                  },
                  '$statusHistory',
                ],
              },
              updatedAt: at,
            },
          },
          { $unset: '_priorStatus' },
        ],
        { returnDocument: 'after' },
      )
      if (!after) {
        // A concurrent request with this key won, or the invoice became paid/voided meanwhile.
        const current = await Invoice.findOne({ _id: id, orgId }).lean().exec()
        if (key) {
          const replayed = await replayPayment(current)
          if (replayed) return replayed
        }
        return status(400, { message: 'Cannot record payment on this invoice' })
      }
      const updated = await r.invoices.findOne({ id, orgId } as any)

      createAuditEntry({ orgId, userId: user.id, action: 'record_payment', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: (invoice as any)?.invoiceNumber })

      // Emit for cross-module journal entry creation
      eventBus.emit('payment.recorded', {
        invoiceId: id,
        orgId,
        userId: user.id,
        amount: body.amount,
        method: body.method,
        date: body.date,
      })

      return { invoice: updated }
    },
    {
      isSignIn: true,
      body: t.Object({
        date: t.String(),
        amount: t.Number({ minimum: 0.01 }),
        method: t.Union([
          t.Literal('cash'),
          t.Literal('bank_transfer'),
          t.Literal('card'),
          t.Literal('cash_on_delivery'),
          t.Literal('other'),
        ]),
        reference: t.Optional(t.String()),
        bankAccountId: t.Optional(t.String()),
      }),
    },
  )
  .post('/:id/void', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const invoice = await r.invoices.findOne({ id, orgId } as any)
    if (!invoice) return status(404, { message: 'Invoice not found' })
    if (!['draft', 'sent', 'received'].includes(invoice.status))
      return status(400, { message: 'Can only void draft, sent, or received invoices' })

    try {
      // ORD-linked bill voids reverse the very stock whose receipt backs the reservation
      // holds — allow the reversal and let the order sync re-balance afterwards.
      await reverseInvoiceStockMovement(invoice, user.id, undefined, (invoice as any).orderId ? { allowNegative: true } : undefined)
    } catch (e: any) {
      return status(400, { message: e.message })
    }

    const history = [...((invoice as any).statusHistory || []), statusEntry('voided', invoice.status, user.id)]
    const updated = await r.invoices.updateInOrg(id, orgId, { status: 'voided', voidedAt: new Date(), statusHistory: history } as any)

    await syncOrderForInvoice(orgId, updated || invoice, user.id)

    createAuditEntry({ orgId, userId: user.id, action: 'void', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: (invoice as any)?.invoiceNumber })

    return { invoice: updated }
  }, { isSignIn: true })
  .post('/:id/convert', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const proforma = await r.invoices.findOne({ id, orgId } as any)
    if (!proforma) return status(404, { message: 'Invoice not found' })
    if (proforma.type !== 'proforma')
      return status(400, { message: 'Only proforma invoices can be converted' })
    if (proforma.status === 'converted')
      return status(400, { message: 'Proforma is already converted' })

    // Auto-generate invoice number
    const invoiceNumber = await getNextInvoiceNumber(orgId, proforma.direction)

    const invoice = await r.invoices.create({
      orgId,
      type: 'invoice',
      direction: proforma.direction,
      contactId: proforma.contactId,
      invoiceNumber,
      issueDate: new Date(),
      dueDate: proforma.dueDate,
      currency: proforma.currency,
      exchangeRate: proforma.exchangeRate,
      reference: proforma.reference,
      lines: proforma.lines,
      subtotal: proforma.subtotal,
      discountTotal: proforma.discountTotal,
      taxTotal: proforma.taxTotal,
      total: proforma.total,
      totalBase: proforma.totalBase,
      amountDue: proforma.total,
      notes: proforma.notes,
      terms: proforma.terms,
      footer: proforma.footer,
      billingAddress: proforma.billingAddress,
      shippingAddress: proforma.shippingAddress,
      proformaId: proforma.id,
      status: 'draft',
      statusHistory: [statusEntry('draft', undefined, user.id, `converted_from_proforma ${proforma.invoiceNumber}`)],
      createdBy: user.id,
    } as any)

    const proformaHistory = [
      ...((proforma as any).statusHistory || []),
      statusEntry('converted', proforma.status, user.id, `converted_to ${invoice.invoiceNumber}`),
    ]
    await r.invoices.update(proforma.id, {
      status: 'converted',
      convertedInvoiceId: invoice.id,
      statusHistory: proformaHistory,
    } as any)

    // The new sales invoice may have inherited order/reservation refs from the proforma
    // lines — derive counters (the converted proforma itself never counts: reservation
    // aggregation is scoped to type 'invoice').
    await syncOrderForInvoice(orgId, invoice, user.id)

    return { invoice }
  }, { isSignIn: true })
