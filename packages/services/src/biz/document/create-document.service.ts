import { Invoice } from 'db/models'
import { getRepos } from '../../context.js'
import { createAuditEntry } from '../audit-log.service.js'
import { documentAmounts } from '../document-amounts.js'
import { IdempotencyError, LEASE_MS, assertSameRequest, isDuplicateKey, takeLease, waitForCompletion } from '../hot-path-key.js'
import { getNextDraftInvoiceNumber, getNextInvoiceNumber } from '../invoice-numbering.service.js'
import { createInvoiceWithProductUpdates } from '../invoice-with-update.service.js'
import { licenceGate } from '../licence/master-licence.service.js'
import { GRValidationError } from '../product-update.service.js'
import { syncOrderForInvoice } from '../reservation.service.js'
import { typedPriceRefusal, withArticleUnits } from '../sales-lines.js'
import { PendingTransferError, checkPendingTransfers, discardPendingTransfers } from '../stock-transfer.service.js'
import { upsertTags } from '../tag.service.js'
import { foreignCurrencyRefusal, statusEntry, validateRelatedInvoiceRef, validateReservationLineRefs } from './document-checks.js'
import { refuse } from './refused.js'

/**
 * FR-32.21 (#797): creating a document, `POST /invoices`. The route reads the key, says which kinds the session
 * makes, and hands the rest here: the replay of a keyed create, the checks, the number and the write.
 *
 * ⚠ A cash sale is a cash-register document (FR-21 D-4): it joins its author's drawer and prints on its device, and
 * `services` does not reach a device. Its part is the API's, handed in as a `CashSaleTill`
 * (`api/src/invoicing/lib/cash-register-sale.ts`); everything before it, and every other type, is here.
 */

// ── Idempotent create (FR-20.37, #155) ──────────────────────────────────────────────────────

export interface CreateCtx {
  orgId: string
  user: any
  isCashSale: boolean
  skipStockMovement: boolean
  allowNegativeStock: boolean
  /** FR-21.31: the author's open session, which a back-office cash sale joins. */
  joined?: any | null
  /** Whether a joined sale prints on its session's device, which says how; absent, it prints nothing. */
  receipt?: 'fiscal' | 'text'
}

/** A cash sale as this service leaves it to the till: checked, with its amounts, before its session is asked. */
export interface CashSaleRequest {
  createCtx: CreateCtx
  body: any
  lines: any[]
  dueDate: unknown
  exchangeRate: number
  taxTotal: number
  totalBase: number
  pendingTransferIds?: string[]
  /** #454: the transfers the form drew up for this sale go, when the sale is refused. */
  discardRequested: () => Promise<unknown>
  key?: string
  hash?: string
}

/** The cash-register part of a create, which reaches the device (the API's). Each answers as the route does. */
export interface CashSaleTill {
  /** A new cash sale, from its session and device on. */
  create(sale: CashSaleRequest): Promise<unknown>
  /** A keyed cash sale a crash interrupted, finished by the cash-register service. */
  resume(existing: any, hash: string, c: CreateCtx): Promise<unknown>
}

export interface CreateRequest {
  orgId: string
  user: any
  body: any
  key?: string
  hash?: string
}

/**
 * Finish a keyed create a crash interrupted: derive its order counters and mark it complete.
 * (A cash sale is finished by the cash-register service instead, see `settleCreate`.)
 */
async function finishCreate(c: CreateCtx, id: string) {
  const r = getRepos()
  const invoice: any = await r.invoices.findOne({ id, orgId: c.orgId })
  await syncOrderForInvoice(c.orgId, invoice, c.user.id)
  const done = await Invoice.findOneAndUpdate(
    { _id: id, orgId: c.orgId, completedAt: { $exists: false } },
    { $set: { completedAt: new Date() }, $unset: { leaseUntil: 1 } },
  ).exec()
  if (done) createAuditEntry({ orgId: c.orgId, userId: c.user.id, action: 'create', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: invoice.invoiceNumber })
  return { invoice: await r.invoices.findOne({ id, orgId: c.orgId }) }
}

/** A create whose key is already on a document: replay it, finish it, or wait for it. */
async function settleCreate(existing: any, hash: string, c: CreateCtx, till: CashSaleTill) {
  try {
    assertSameRequest(existing.requestHash, hash)
  } catch (e: any) {
    if (e instanceof IdempotencyError) return refuse(e.statusCode, { code: e.code, message: e.message })
    throw e
  }
  const id = String(existing._id)
  const replay = async () => ({ invoice: await getRepos().invoices.findOne({ id, orgId: c.orgId }) })
  // Documents created before this field existed, or by a request that finished, are complete.
  if (existing.completedAt || !existing.leaseUntil) return replay()
  if (existing.type === 'cash_sale') return till.resume(existing, hash, c)
  for (let round = 0; round < 2; round++) {
    if (await takeLease(Invoice, c.orgId, existing._id)) return finishCreate(c, id)
    const { doc, leaseLapsed } = await waitForCompletion(Invoice, c.orgId, existing._id)
    if (doc?.completedAt) return replay()
    if (!doc || !leaseLapsed) break
  }
  return refuse(409, { code: 'idempotency_in_progress', message: 'This document is still being created — retry with the same Idempotency-Key.' })
}

/**
 * Create a document: the body as the route's schema took it, from a session that may make its kind. The answer is
 * `{ invoice }`, or a `Refused` with the route's status and body.
 */
export async function createDocument(req: CreateRequest, till: CashSaleTill): Promise<unknown> {
  const { orgId, user, body, key, hash } = req
  const r = getRepos()
  const createCtx: CreateCtx = {
    orgId,
    user,
    isCashSale: body.type === 'cash_sale',
    skipStockMovement: body.skipStockMovement === true,
    allowNegativeStock: body.allowNegativeStock === true,
  }
  if (key) {
    const existing = await Invoice.findOne({ orgId, clientKey: key }).lean().exec()
    // FR-21.10: a key a till sale holds is found here too. A POS row's key travelled with it
    // into its document (0008/0009), and a different request with it is answered 422.
    if (existing) return settleCreate(existing, hash!, createCtx, till)
  }

  // FR-20.55: on a master whose licence has run out, no new invoice, proforma or cash sale. A
  // credit or debit note, an incoming bill, and the retry of a create that already happened (just
  // above) go through. Asked here, with the body, because the auth plugins never read one.
  const unlicensed = await licenceGate('POST', '/api/org/:orgId/invoices', orgId, body)
  if (unlicensed) return refuse(402, unlicensed)

  // Sanitize empty string IDs to undefined
  if (!body.contactId) body.contactId = undefined

  // #171: only `POST /:id/to-invoice` makes an invoice for a cash sale — the link carries
  // the rules that keep the sale from counting twice, so a plain create never sets it.
  delete body.cashSaleRef
  delete body.taxEventDate
  for (const l of body.lines || []) delete l.cashSaleLineId
  // `stockSource` makes a document move no stock at all. Only the paths that establish what
  // already moved the goods write it — the cash-sale invoice, the import's stock-note match,
  // `/invoicing/bills/from-receipt` — never a client (FR-22.31).
  delete body.stockSource

  // Inline product-master updates ride alongside the bill in one Mongo transaction.
  // Purchase bills only; not reachable from desktop/SQLite (desktop-ui has no bills form).
  const productUpdates: any[] | undefined = body.productUpdates
  delete body.productUpdates
  const withProductUpdates = Array.isArray(productUpdates) && productUpdates.length > 0
  if (withProductUpdates && !(body.type === 'invoice' && body.direction === 'incoming')) {
    return refuse(422, { message: 'productUpdates is only supported for purchase bills' })
  }
  if (withProductUpdates) {
    const refusal = await foreignCurrencyRefusal(orgId, body.currency)
    if (refusal) return refuse(422, refusal)
  }

  // Reservation-consuming lines: sales invoices only, capped at the reserved quantity.
  const refErr = await validateReservationLineRefs(orgId, { type: body.type, direction: body.direction, lines: body.lines })
  if (refErr) return refuse(422, { message: refErr })

  // Credit/debit notes must reference the issued invoice they correct (same side + contact).
  const relErr = await validateRelatedInvoiceRef(orgId, {
    type: body.type,
    direction: body.direction,
    contactId: body.contactId,
    relatedInvoiceId: body.relatedInvoiceId,
  })
  if (relErr) return refuse(422, { message: relErr })

  // #724: an outgoing article line's unit is its article's (the form locks it there); a note keeps the unit its
  // invoice sold the article in. Before the amounts, which carry the lines into the document.
  body.lines = await withArticleUnits(orgId, body.direction, body.lines, undefined, { relatedInvoiceId: body.relatedInvoiceId })

  // Compute defaults for fields the form may not provide
  const { lines, taxTotal, totalBase } = documentAmounts(body)
  const exchangeRate = body.exchangeRate || 1
  const dueDate = body.dueDate || body.issueDate

  const isCashSale = body.type === 'cash_sale'
  const initialStatus = isCashSale ? 'paid' : 'draft'
  // Import-time stock controls (cash sales only) — behavioral flags, not doc fields.
  const skipStockMovement = body.skipStockMovement === true
  delete body.skipStockMovement
  delete body.allowNegativeStock
  // FR-21.24: the transfers a cash sale asked for, confirmed before it dispatches. On the document
  // under their own name until they are: `pendingTransferIds` there means "already confirmed".
  const pendingTransferIds = isCashSale && !skipStockMovement ? body.pendingTransferIds as string[] | undefined : undefined
  delete body.pendingTransferIds
  /**
   * #454: the form drew these transfers up for this sale, and a sale refused before it is written never
   * confirms them. Left in draft they stay in the movements list, and move goods if somebody confirms
   * them. The next press draws up its own. ⚠ Only on a refusal, which is a definitive answer: never
   * re-sent with the same body (`ui-shared/composables/idempotency#isOutcomeUnknown`).
   */
  const discardRequested = () => discardPendingTransfers(orgId, pendingTransferIds, { createdBy: user.id })
  // #724 (FR-27 `sales-docs.manual-price`): a line price this session's role may not type is refused, before
  // anything is written or numbered. A definitive answer, so the transfers drawn up for it go (#454).
  const typed = await typedPriceRefusal(orgId, user, { direction: body.direction, contactId: body.contactId, relatedInvoiceId: body.relatedInvoiceId, lines: body.lines })
  if (typed) {
    await discardRequested()
    return refuse(403, typed)
  }
  if (pendingTransferIds?.length) {
    // Checked before the insert, so a refused list draws no CS number.
    try {
      await checkPendingTransfers(orgId, pendingTransferIds)
    } catch (e: any) {
      if (e instanceof PendingTransferError) {
        await discardRequested()
        return refuse(e.statusCode, { code: e.code, message: e.message })
      }
      throw e
    }
  }

  // FR-21 (D-4): a cash sale is a cash-register document, written by the one service. It keeps
  // this route's contract — the payload, the answer, the key — and leaves by the service's
  // failure rule: no device and no drawer here, so a failure before it completes removes it.
  if (isCashSale) {
    return till.create({ createCtx, body, lines, dueDate, exchangeRate, taxTotal, totalBase, pendingTransferIds, discardRequested, key, hash })
  }

  // Allocate + create with retry on duplicate-key. A collision indicates the sequence
  // counter drifted (e.g. legacy data) — the reconcile-on-allocate path inside
  // getNextInvoiceNumber catches up, so a retry usually succeeds on the 2nd attempt.
  // Drafts use a separate per-type DRAFT_* counter.
  let invoice: any
  let invoiceNumber = ''
  let lastErr: any
  let updatedProductIds: string[] = []
  for (let attempt = 0; attempt < 3; attempt++) {
    const draftNum = await getNextDraftInvoiceNumber(orgId, body.direction, body.type)
    // Every type but a cash sale (above) is created a draft, under a draft number.
    invoiceNumber = draftNum || (await getNextInvoiceNumber(orgId, body.direction, body.type))
    try {
      const docFields: any = {
        ...body,
        lines,
        dueDate,
        invoiceNumber,
        orgId,
        direction: body.direction,
        status: initialStatus,
        statusHistory: [statusEntry(initialStatus, undefined, user.id, 'created')],
        numberHistory: [{ number: invoiceNumber, allocatedAt: new Date(), status: initialStatus }],
        taxTotal,
        totalBase,
        billingAddress: body.billingAddress || { street: '-', city: '-', postalCode: '-', country: '-' },
        amountPaid: 0,
        amountDue: body.total,
        ...(key ? { clientKey: key, requestHash: hash, leaseUntil: new Date(Date.now() + LEASE_MS) } : {}),
        createdBy: user.id,
      }
      if (withProductUpdates) {
        const res = await createInvoiceWithProductUpdates(docFields, productUpdates!)
        updatedProductIds = res.updatedProductIds
        invoice = await r.invoices.findOne({ id: res.invoiceId, orgId })
      } else {
        invoice = await r.invoices.create(docFields)
      }
      break
    } catch (e: any) {
      lastErr = e
      if (e instanceof GRValidationError) return refuse(422, { message: e.message })
      // A racing duplicate of this keyed request won the insert: answer as it does.
      // (The DAL's DuplicateError names the index's fields in its message.)
      if (key && (isDuplicateKey(e) || /clientKey/.test(String(e?.message ?? '')))) {
        const existing = await Invoice.findOne({ orgId, clientKey: key }).lean().exec()
        if (existing) return settleCreate(existing, hash!, createCtx, till)
      }
      if (e?.code !== 'DUPLICATE') throw e
      // Duplicate on (orgId, invoiceNumber) — reconcile bumps the counter; retry.
    }
  }
  if (!invoice) {
    return refuse(409, { message: `Could not allocate invoice number after 3 attempts: ${lastErr?.message || 'duplicate'}` })
  }
  await upsertTags(orgId, 'invoice', body.tags)

  createAuditEntry({ orgId, userId: user.id, action: 'create', module: 'invoicing', entityType: 'invoice', entityId: invoice.id, entityName: invoice.invoiceNumber })

  // Audit: one entry per product-master update, correlated to the bill.
  for (const pid of updatedProductIds) {
    createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'warehouse', entityType: 'product', entityId: pid, correlationId: invoice.id })
  }

  // Order/reservation-linked creates (API imports, conversion round-trips) derive
  // their counters immediately.
  await syncOrderForInvoice(orgId, invoice, user.id)

  if (key) {
    await Invoice.updateOne({ _id: invoice.id, orgId }, { $set: { completedAt: new Date() }, $unset: { leaseUntil: 1 } }).exec()
  }
  return { invoice }
}
