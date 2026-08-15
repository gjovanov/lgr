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
import { Invoice, Reservation } from 'db/models'
import { createInvoiceWithProductUpdates, updateInvoiceWithProductUpdates, InvoicePostedError } from 'services/biz/invoice-with-update.service'
import { GRValidationError } from 'services/biz/product-update.service'

// Prefix rendered on the invoice number. `invoice` resolves dynamically by direction.
const TYPE_PREFIX: Record<string, string> = {
  cash_sale: 'CS',
  proforma: 'PRF',
  credit_note: 'CRN',
  debit_note: 'DBN',
}

// Issued sequence counter key. INV/CRN/DBN share a single counter (SALES_DOC) so the sequence
// interleaves across those three types. PRF, CS, BILL get their own counters.
export function sequenceKeyFor(type: string, direction: string): string {
  if (type === 'proforma') return 'PROFORMA'
  if (type === 'cash_sale') return 'CASH_SALE'
  if (type === 'invoice' && direction === 'incoming') return 'BILL'
  // invoice/outgoing, credit_note, debit_note → shared
  return 'SALES_DOC'
}

export function prefixFor(type: string, direction: string): string {
  if (type === 'invoice') return direction === 'incoming' ? 'BILL' : 'INV'
  return TYPE_PREFIX[type] || 'INV'
}

// Draft sequences are PER-TYPE (not shared) so each draft series has its own clean counter.
// Cash sales never have a draft state — they go straight to issued.
function draftSequenceKeyFor(type: string, direction: string): string | null {
  if (type === 'cash_sale') return null
  if (type === 'invoice') return direction === 'incoming' ? 'DRAFT_BILL' : 'DRAFT_INV'
  if (type === 'proforma') return 'DRAFT_PRF'
  if (type === 'credit_note') return 'DRAFT_CN'
  if (type === 'debit_note') return 'DRAFT_DN'
  return null
}

function draftPrefixFor(type: string, direction: string): string | null {
  if (type === 'cash_sale') return null
  if (type === 'invoice') return direction === 'incoming' ? 'DRF-BILL' : 'DRF-INV'
  if (type === 'proforma') return 'DRF-PRF'
  if (type === 'credit_note') return 'DRF-CN'
  if (type === 'debit_note') return 'DRF-DN'
  return null
}

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

// Prefixes that share a single counter under `SALES_DOC`. Numbering must interleave across
// these types so that if INV is at 10 the next CRN is 11, not 3.
const SALES_DOC_PREFIXES = ['INV', 'CRN', 'DBN'] as const

/**
 * Scan existing invoices that share the given sequence key and return the highest trailing
 * numeric suffix already in use for `year`. Used to bootstrap `lastNumber` when legacy rows
 * (seeds, pre-refactor per-prefix counters) have numbers above the current sequence value.
 */
async function currentMaxSuffix(orgId: string, key: string, year: number): Promise<number> {
  const prefixes =
    key === 'SALES_DOC' ? SALES_DOC_PREFIXES :
    key === 'PROFORMA' ? ['PRF'] :
    key === 'CASH_SALE' ? ['CS'] :
    key === 'BILL' ? ['BILL'] : []
  if (!prefixes.length) return 0

  const re = new RegExp(`^(?:${prefixes.join('|')})-${year}-(\\d+)$`)
  const docs = await Invoice
    .find({ orgId, invoiceNumber: { $regex: re } } as any, { invoiceNumber: 1 })
    .lean()
    .exec()
  let max = 0
  for (const d of docs) {
    const m = (d as any).invoiceNumber?.match(re)
    if (m) {
      const n = Number(m[1])
      if (n > max) max = n
    }
  }
  return max
}

/**
 * Display-prefix override resolution. The configuration UI stores overrides under the
 * COUNTER key ("CASH_SALE", "SALES_DOC", "DRAFT_INV", …) while allocation historically
 * looked them up under the type prefix ("CS", "INV", "DRF-INV") — check both, type
 * prefix winning, so overrides work regardless of which key carries them.
 */
export async function resolveDisplayPrefix(orgId: string, typePrefix: string, counterKey: string | null): Promise<string> {
  const byType = await getDisplayPrefix(orgId, typePrefix)
  if (byType !== typePrefix) return byType
  if (counterKey) {
    const byKey = await getDisplayPrefix(orgId, counterKey)
    if (byKey !== counterKey) return byKey
  }
  return typePrefix
}

export async function getNextInvoiceNumber(orgId: string, direction: string, type?: string): Promise<string> {
  const t = type || 'invoice'
  const key = sequenceKeyFor(t, direction)
  const prefix = prefixFor(t, direction)
  const year = new Date().getFullYear()

  // Reconcile: ensure the shared counter has caught up with any pre-existing numbers in the
  // same prefix group (fixes legacy data where the per-prefix counter pre-dated SALES_DOC,
  // or where seeds inserted invoiceNumbers directly without bumping a counter).
  const minValue = await currentMaxSuffix(orgId, key, year)
  if (minValue > 0) await ensureSequenceAtLeast(orgId, key, year, minValue)

  // Atomic $inc. Shared key → shared counter. The counter value is formatted with the
  // type-specific prefix (SALES_DOC=11 → "INV-2026-00011" or "CRN-2026-00011" etc.).
  const numberFromService = await getNextNumber(orgId, key, 5, year)
  const seqPart = numberFromService.split('-').pop()!
  const display = await resolveDisplayPrefix(orgId, prefix, key)
  return `${display}-${year}-${seqPart}`
}

/**
 * Allocate the next DRAFT-* number for documents in draft state. Per-type counters
 * (no SALES_DOC sharing on the draft side). Cash sales never use this — they're
 * issued immediately.
 */
export async function getNextDraftInvoiceNumber(orgId: string, direction: string, type?: string): Promise<string | null> {
  const t = type || 'invoice'
  const draftKey = draftSequenceKeyFor(t, direction)
  const draftPrefix = draftPrefixFor(t, direction)
  if (!draftKey || !draftPrefix) return null
  const year = new Date().getFullYear()
  const numberFromService = await getNextNumber(orgId, draftKey, 5, year)
  const seqPart = numberFromService.split('-').pop()!
  const display = await resolveDisplayPrefix(orgId, draftPrefix, draftKey)
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
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

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
      for (let attempt = 0; attempt < 3; attempt++) {
        if (initialStatus === 'draft') {
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
          if (e?.code !== 'DUPLICATE') throw e
          // Duplicate on (orgId, invoiceNumber) — reconcile bumps the counter; retry.
        }
      }
      if (!invoice) {
        return status(409, { message: `Could not allocate invoice number after 3 attempts: ${lastErr?.message || 'duplicate'}` })
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

      // Issued invoices remain editable until they're posted to the general ledger.
      // Once a JournalEntry references the invoice, edits would silently corrupt accounting,
      // so block them and surface a clear remediation path (void + reissue / credit note).
      if (existing.status !== 'draft') {
        const { JournalEntry } = await import('db/models')
        const postedJe = await JournalEntry.findOne({
          orgId,
          sourceModule: 'invoicing',
          sourceId: id,
          status: 'posted',
        } as any).lean().exec()
        if (postedJe) {
          return status(409, {
            message: 'This invoice has been posted to the general ledger. Issue a credit note or void to correct it.',
          })
        }
      }

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
          if (e instanceof InvoicePostedError) return status(409, { message: e.message })
          if (e instanceof GRValidationError) return status(422, { message: e.message })
          throw e
        }
        updated = await r.invoices.findOne({ id, orgId } as any)
        for (const pid of updatedProductIds) {
          createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'warehouse', entityType: 'product', entityId: pid, correlationId: id })
        }
      } else {
        updated = await r.invoices.update(id, body as any)
      }

      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: (updated as any)?.invoiceNumber || (existing as any)?.invoiceNumber, changes: diffChanges(existing as any, updated as any) })

      // Quantity edits on ORD-linked documents shift the derived reservation/receipt state.
      await syncOrderForInvoice(orgId, updated || existing, user.id)

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

    await r.invoices.delete(id)

    // Deleting a draft conversion invoice re-opens the order reservations it consumed.
    await syncOrderForInvoice(orgId, existing, user.id)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: (existing as any)?.invoiceNumber })

    return { message: 'Invoice deleted' }
  }, { isSignIn: true })
  .post('/:id/send', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const invoice = await r.invoices.findOne({ id, orgId } as any)
    if (!invoice) return status(404, { message: 'Invoice not found' })
    if (invoice.status !== 'draft') return status(400, { message: 'Invoice is not in draft status' })

    const newStatus = invoice.direction === 'incoming' ? 'received' : 'sent'

    // Confirm pending transfer movements before dispatch (cross-warehouse transfers)
    const pendingTransferIds = (body as any)?.pendingTransferIds as string[] | undefined
    if (pendingTransferIds?.length) {
      const { confirmTransferMovements } = await import('services/biz/stock-transfer.service')
      try {
        await confirmTransferMovements(pendingTransferIds)
      } catch (e: any) {
        return status(400, { message: `Transfer confirmation failed: ${e.message}` })
      }
    }

    try {
      await createInvoiceStockMovement(invoice, user.id)
    } catch (e: any) {
      return status(400, { message: e.message })
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
    }
    if (pendingTransferIds?.length) updateData.pendingTransferIds = pendingTransferIds
    const updated = await r.invoices.update(id, updateData)

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
    const updated = await r.invoices.update(id, {
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
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      const invoice = await r.invoices.findOne({ id, orgId } as any)
      if (!invoice) return status(404, { message: 'Invoice not found' })
      if (['voided', 'cancelled', 'paid'].includes(invoice.status))
        return status(400, { message: 'Cannot record payment on this invoice' })

      const payments = [...(invoice.payments || []), {
        date: new Date(body.date),
        amount: body.amount,
        method: body.method,
        reference: body.reference,
      }]

      const amountPaid = (invoice.amountPaid || 0) + body.amount
      const amountDue = invoice.total - amountPaid
      const newStatus = amountDue <= 0 ? 'paid' : 'partially_paid'
      const paidAt = amountDue <= 0 ? new Date() : invoice.paidAt

      const history = newStatus !== invoice.status
        ? [...((invoice as any).statusHistory || []), statusEntry(newStatus, invoice.status, user.id, `payment ${body.amount} ${body.method}`)]
        : ((invoice as any).statusHistory || [])

      const updated = await r.invoices.update(id, {
        payments,
        amountPaid,
        amountDue,
        status: newStatus,
        paidAt,
        statusHistory: history,
      } as any)

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
          t.Literal('check'),
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
    const updated = await r.invoices.update(id, { status: 'voided', voidedAt: new Date(), statusHistory: history } as any)

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
