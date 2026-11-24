import { FiscalRoute, deviceFromAuthorSession, deviceFromCounter, deviceFromDeadReceipt } from 'fiscal/fiscal-route'
import { can, grantOf } from 'services/biz/access/evaluate'
import { DOC_KINDS, kindOfDocument, partitionFilter, readableDirection, readsKind, writesKind } from 'config/access'
import { chooseListSort } from 'config/list-sorts'
import { listProjection } from 'config/list-rows'
import { withVisibleTrails } from 'services/biz/access/price-trails'
import { Elysia, t } from 'elysia'
import { AnObject } from 'services/http/body-schemas'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { reverseInvoiceStockMovement, stockBookingRefusal } from 'services/biz/invoicing.service'
import { issueDocument, IssueLostError, IssueStockError } from 'services/biz/issue-document.service'
import { syncOrderForInvoice } from 'services/biz/reservation.service'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { eventBus } from 'services/events/event-bus'
import { inTransaction } from 'services/biz/transaction'
import { enqueuePosting } from 'services/biz/postings/posting.service'
import { getNextNumber, getCurrentNumber } from 'services/biz/sequence.service'
import { getInvoiceSummary } from 'services/biz/invoice-summary.service'
import { sequenceDefFor, resolveSequencePrefix, type SequenceGroup } from 'services/biz/sequence-registry'
import { Invoice } from 'db/models'
import { finishInterruptedDocuments } from '../lib/cash-register-till.js'
import { keyedReceipt, prepareIssueReceipt, prepareReceipt, printReceipt, receiptOutcome, settleKeyedReceipt } from '../lib/counter-receipt.js'
import { prepareRefund, refund } from '../lib/counter-refund.js'
import { paymentReceiptAnswer, paymentRefundAnswer } from '../lib/counter-payment.js'
import { counterAtIssue } from '../lib/counter-issue.js'
import { cashSaleTill } from '../lib/cash-register-sale.js'
import { assertHomeIsHere } from 'db/home/home'
import { fitsDue, isBeingVoided, issueLeaseFree, notBeingVoided, paymentPipeline, unclaimedDraft } from 'services/biz/invoice-payment'
import {
  DELIVERY_RECEIPT_OWED, DOCUMENT_CLAIMED, freezeRefusal, freezeUnderNotes, inDoubtRefusal, owesDeliveryReceipt,
  paymentRefusal, receiptFacts, receiptInDoubt,
} from 'services/biz/cash-register/payment-receipt.service'
import { isImmutableRegisterDocument, REGISTER_DOCUMENT_IMMUTABLE } from 'services/biz/cash-register/immutability'
import { readIdempotencyKey, requestHash, IdempotencyError, LEASE_MS } from 'services/biz/hot-path-key'
import {
  CashSaleInvoiceError, createInvoiceForCashSale, getCashSaleInvoicing, cashSaleCandidates, attachInvoiceToCashSale,
} from 'services/biz/cash-sale-invoice.service'
import { RegisterRefusal } from 'services/biz/cash-register/register.service'
import { applyLinkedBillPrices, isReceiptLinked, linkedReceiptsOf, receiptsOverlapping, releaseReceiptLinks } from 'services/biz/receipt-bill.service'
import { isDispatchLinked, linkedDispatchesOf, releaseDispatchLinks } from 'services/biz/dispatch-invoice.service'
import { PAYMENT_STORNO } from 'services/biz/cash-register/pos-union'
import { billStockReceipts, isSupplierBill } from 'services/biz/bill-stock-receipt.service'
import { answered, type Status } from 'services/biz/document/refused'
import { ISSUE_IN_PROGRESS, draftTaken, rawOf, whoHolds } from 'services/biz/document/document-claims'
import {
  auditOverlapAcknowledged, orderLinkRefusal, receiptOverlapRefusal, round2, statusEntry, stockFailureAnswer,
} from 'services/biz/document/document-checks'
import { listFilter, listRows, synthesizeStatusHistory, withLineArticles } from 'services/biz/document/document-list'
import { createDocument } from 'services/biz/document/create-document.service'
import { updateDocument } from 'services/biz/document/update-document.service'
import { sendDocument } from 'services/biz/document/send-document.service'
import { convertQuote } from 'services/biz/document/convert-quote.service'

/**
 * FR-32.21 (#797): the routes of a document. A handler reads its request, says who may, calls a service and answers
 * what it says. Creating, updating and issuing a document are `services/biz/document` (`createDocument`,
 * `updateDocument`, `sendDocument` around `issueDocument`), with what reaches the device beside the till
 * (`../lib/cash-register-sale`, `../lib/counter-issue`). `unit/invoice-handler-size.test.ts` holds every handler here
 * to 80 lines.
 */

// The checks a document is made against, and the list's payment-method filter, live in services; these names are
// still imported from here.
export { validateRelatedInvoiceRef, validateReservationLineRefs } from 'services/biz/document/document-checks'
export { buildPaymentMethodFilter, onlyRegisterTypes } from 'services/biz/document/document-list'

const reused = (status: Status, e: IdempotencyError) => status(e.statusCode, { code: e.code, message: e.message })
/** A refusal of the invoice-for-a-cash-sale rules (#171), as a route answers it. */
const refused = (status: Status, e: CashSaleInvoiceError) => status(e.statusCode, { code: e.code, message: e.message, ...(e.details || {}) })

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
  sequenceKeyFor,
  prefixFor,
  draftSequenceKeyFor,
  draftPrefixFor,
  resolveDisplayPrefix,
  peekNextInvoiceNumber,
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
 * The field to sort documents on, given the key of the grid column the user clicked. The grids'
 * № column is `number`, which the list adds to each row only after the query: Mongo sorted on a
 * field no document has, so the rows stayed as found in both directions (FR-22.10). The stored
 * field is `invoiceNumber`. The list exports take the grid's sort too, so they map it the same way.
 */
export function invoiceSortField(sortBy: unknown): string {
  if (sortBy === 'number') return 'invoiceNumber'
  return typeof sortBy === 'string' && sortBy ? sortBy : 'createdAt'
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

// ── A payment (FR-20.37, FR-23) ─────────────────────────────────────────────────────────────

interface PaymentBody {
  date: string
  amount: number
  method: string
  reference?: string
  bankAccountId?: string
}

/** The payment this key already recorded: the invoice comes back, the payment is not added again. */
async function replayPayment(status: Status, orgId: string, id: string, doc: any, key: string | undefined, hash: string | undefined) {
  const prior = (doc?.payments || []).find((p: any) => p.clientKey === key)
  if (!prior) return null
  if (prior.requestHash !== hash) {
    return status(422, { code: 'idempotency_key_reused', message: 'This Idempotency-Key was already used for a different request' })
  }
  return { invoice: await getRepos().invoices.findOne({ id, orgId } as any) }
}

/**
 * The payment where nothing prints: its row, written by one atomic pipeline update with the journal entry it owes,
 * then its audit row and its event.
 */
async function recordPayment(
  status: Status,
  c: { orgId: string; id: string; user: any; body: PaymentBody; key?: string; hash?: string; invoice: any },
) {
  const { orgId, id, user, body, key, hash, invoice } = c
  const { ObjectId } = (Invoice.base as any).Types
  const oid = (v: string) => new ObjectId(v)
  // Its own id, so that its journal entry finds this row and no other (`payment.recorded`).
  const paymentId = new ObjectId()
  const row = {
    _id: paymentId,
    date: new Date(body.date),
    amount: body.amount,
    method: body.method,
    ...(body.reference !== undefined ? { reference: body.reference } : {}),
    ...(key ? { clientKey: key, requestHash: hash } : {}),
  }
  // FR-20.4: a raw driver write, which the Mongoose write guard cannot see — so it asks first.
  await assertHomeIsHere(orgId)
  const pipeline = paymentPipeline(row, { at: new Date(), by: String(user.id) })
  // FR-29.15: the payment and the journal entry it owes are stored in one transaction.
  const after = await inTransaction(async session => {
    const doc = await Invoice.collection.findOneAndUpdate(
      {
        _id: oid(id), orgId: oid(orgId),
        status: { $nin: ['voided', 'cancelled', 'paid'] },
        // The key, when sent, is part of the filter: a second request with it matches nothing.
        ...(key ? { 'payments.clientKey': { $ne: key } } : {}),
        ...fitsDue(body.amount),
      },
      pipeline as any,
      { returnDocument: 'after', session },
    )
    if (doc) await enqueuePosting(orgId, { event: 'payment.recorded', invoiceId: id, paymentId: String(paymentId), userId: user.id }, { session })
    return doc
  })
  if (!after) {
    // A concurrent request with this key won, the invoice became paid/voided meanwhile, or
    // another payment took what was left of it.
    const current: any = await Invoice.findOne({ _id: id, orgId }).lean().exec()
    if (key) {
      const replayed = await replayPayment(status, orgId, id, current, key, hash)
      if (replayed) return replayed
    }
    const lost = await paymentRefusal(orgId, current, body.amount)
    return lost ? status(lost.statusCode, lost.body) : status(400, { message: 'Cannot record payment on this invoice' })
  }
  const updated = await getRepos().invoices.findOne({ id, orgId } as any)

  createAuditEntry({ orgId, userId: user.id, action: 'record_payment', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: invoice?.invoiceNumber })

  // Emit for cross-module journal entry creation
  eventBus.emit('payment.recorded', {
    invoiceId: id,
    orgId,
    userId: user.id,
    amount: body.amount,
    method: body.method,
    date: body.date,
    paymentId: String(paymentId),
  })

  return { invoice: updated }
}

export const invoiceController = new Elysia({ prefix: '/org/:orgId/invoices' })
  .use(AppAuthService)
  // FR-27.11.C.6: every answer of this controller (create, read, list, send, void, pay…) names no price level the
  // role does not see in a line's stored trail.
  .onAfterHandle(({ response, user }: any) => withVisibleTrails(grantOf(user), response))
  // FR-24.50: the routes that reach a fiscal device say which; one held on another pod runs there.
  .use(FiscalRoute)
  /**
   * FR-27.6 (FR-26.6 `purchases`, as data): sales documents, proforma and bills share `/invoices`, and only a
   * document's `direction` and `type` tell them apart (`kindOfDocument`), so no route rule can say this. Every by-id
   * route answers 404 for a document of a kind the session does not read, as for an unknown id, and 403 for a write
   * on a kind it does not write (deleting needs the kind's `delete`).
   *
   * A session that reads and writes every kind (every legacy one but an `areas` list without `purchases`) costs no
   * query.
   */
  .onBeforeHandle(async ({ params, user, status, request }: any) => {
    if (!user) return
    const grant = grantOf(user)
    if (grant.all) return
    const id = params?.id
    if (typeof id !== 'string' || !/^[0-9a-f]{24}$/i.test(id)) return
    const method = String(request?.method ?? 'GET').toUpperCase()
    const reading = method === 'GET' || method === 'HEAD'
    const action = method === 'DELETE' ? 'delete' : 'edit'
    if (partitionFilter(grant) === null && (reading || DOC_KINDS.every(k => writesKind(grant, k, action)))) return
    const doc = await Invoice.findOne({ _id: id, orgId: params.orgId }, { direction: 1, type: 1 }).lean().exec()
    if (!doc) return
    const kind = kindOfDocument(doc as any)
    if (!readsKind(grant, kind)) return status(404, { message: 'Invoice not found' })
    if (!reading && !writesKind(grant, kind, action)) {
      const feature = kind === 'sales' ? 'sales-docs' : kind
      return status(403, { code: 'capability_required', capabilities: [`${feature}.${action}`], message: 'This kind of document is read-only for your role.' })
    }
  })
  .get('/', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    // The list's query, within the kinds the role reads (`services/biz/document/document-list`).
    const filter = await listFilter(orgId, query, user)

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    // FR-30.2: a sort the list declares (`config/list-sorts`: the № column is `invoiceNumber`), else the newest first.
    const sort = chooseListSort('invoices', query.sortBy, query.sortOrder)

    // FR-30.7: `fields=list` (the grids) answers rows, without the lines; without it, the whole document as before.
    const result = await r.invoices.findAll(filter, { page, size, sort: { [sort.field]: sort.order } }, { select: listProjection('invoices', query.fields) })

    const invoices = await listRows(orgId, result.items)
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
    // An issued number: the same reading as the allocation, a continuous series included.
    if (!wantDraft) return peekNextInvoiceNumber(orgId, direction, t)

    const year = new Date().getFullYear()
    const key = draftSequenceKeyFor(t, direction) || sequenceKeyFor(t, direction)
    const prefix = draftPrefixFor(t, direction) || prefixFor(t, direction)
    const counter = await getCurrentNumber(orgId, key, year)
    const display = await resolveDisplayPrefix(orgId, prefix, key)
    const seq = String(counter + 1).padStart(5, '0')
    return { next: `${display}-${year}-${seq}`, counter, prefix: display }
  }, { isSignIn: true })
  // KPI summary for list pages. Accepts the SAME scope filters as the list
  // (type/types/direction/contactId/tags/dates) so the cards reflect the active view.
  // Delegates to getInvoiceSummary (shared with the Portal dashboard).
  // Cloud-only (Mongo aggregation); desktop-ui does not request it.
  .get('/summary', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    // #493 item 2 (FR-27 D-8): the totals strip is a capability. A Seller and a Sales Consultant have none: hidden
    // is not enough, the figures stay on the server.
    if (!can(user, ['sales-docs.totals', 'bills.totals'])) {
      return status(403, { code: 'capability_required', capabilities: ['sales-docs.totals'], message: 'The totals are not part of your role.' })
    }
    // FR-27.6: the side the role reads (null, neither: the route rule lets no such session in).
    const side = readableDirection(grantOf(user as any))
    const summary = await getInvoiceSummary(orgId, (side ? { ...query, direction: side } : query) as any)
    return { summary }
  }, { isSignIn: true })
  .post(
    '/',
    async ({ params: { orgId }, body, user, status, headers }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      // #155: a retried create with its Idempotency-Key returns the document it made. Hashed
      // before anything below rewrites the body.
      let key: string | undefined
      try {
        key = readIdempotencyKey(headers)
      } catch (e: any) {
        return status(e.statusCode, { code: e.code, message: e.message })
      }
      const hash = key ? requestHash('invoice.create', body) : undefined
      // FR-27.6 (FR-26.6): a document of a kind the role makes, and, without `orders`, linked to none.
      const grant = grantOf(user as any)
      const kind = kindOfDocument(body as any)
      if (kind === 'bills' && !readsKind(grant, 'bills')) {
        return status(403, { code: 'area_required', area: 'purchases', message: 'Incoming documents are not part of your role.' })
      }
      if (!writesKind(grant, kind, 'create')) {
        const feature = kind === 'sales' ? 'sales-docs' : kind
        return status(403, { code: 'capability_required', capabilities: [`${feature}.create`], message: 'This kind of document is not one your role makes.' })
      }
      const unlinked = orderLinkRefusal(user, body)
      if (unlinked) return status(403, unlinked)

      // The key's replay, the licence, the checks, the number and the write (`createDocument`); a cash sale's
      // session and device beside the till (`cashSaleTill`).
      return answered(status, await createDocument({ orgId, user, body, key, hash }, cashSaleTill()))
    },
    {
      isSignIn: true, fiscalDevice: deviceFromAuthorSession,
      body: t.Object({
        type: t.Union([
          t.Literal('invoice'),
          t.Literal('proforma'),
          t.Literal('offer'),
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
            type: t.Union([t.Literal('base'), t.Literal('category'), t.Literal('tag'), t.Literal('contact'), t.Literal('tier'), t.Literal('override'), t.Literal('customer')]),
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
        // FR-21.24: transfers the cash-sale form created for stock its warehouse lacks
        // (`/stock-availability/create-transfers`), confirmed before the sale dispatches.
        // Undeclared, Elysia's normalize dropped it and the sale failed for want of stock.
        pendingTransferIds: t.Optional(t.Array(t.String())),
        // FR-21.31: a cash sale that joins its author's open session prints on that session's device, where LGR
        // prints whether it asks or not, and elsewhere when it asks. Either value asks, and the device says which
        // it prints (`decideSaleMode`).
        receipt: t.Optional(t.Union([t.Literal('fiscal'), t.Literal('text')])),
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
        productUpdates: t.Optional(t.Array(AnObject)),
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
      contact = await r.contacts.findByIdInOrg(String(invoice.contactId), orgId)
    }
    // FR-30.10: each line names its article, so the form reads no article per line to show it (30 reads for 30 lines).
    const lines = await withLineArticles(orgId, invoice.lines)

    return {
      invoice: {
        ...invoice,
        ...(lines ? { lines } : {}),
        // FR-22.31: a bill made from goods receipts links them, and its form compares its prices
        // with what they were received at.
        ...(isReceiptLinked(invoice) ? { receipts: await linkedReceiptsOf(orgId, invoice) } : {}),
        // FR-22.61: an invoice made from stock notes links them, and its form holds its quantities to theirs.
        ...(isDispatchLinked(invoice) ? { dispatches: await linkedDispatchesOf(orgId, invoice) } : {}),
        // The goods receipts a supplier bill booked — what its „Складова разписка" prints; the
        // form offers the print only when there are some.
        ...(isSupplierBill(invoice) ? { stockMovements: await billStockReceipts(orgId, invoice) } : {}),
        // FR-23: the receipts that paid it, and what they leave to do.
        ...await receiptFacts(orgId, invoice),
        statusHistory: synthesizeStatusHistory(invoice),
        contactId: contact ? { _id: contact.id, id: contact.id, companyName: (contact as any).companyName, firstName: (contact as any).firstName, lastName: (contact as any).lastName, email: (contact as any).email } : invoice.contactId,
      },
    }
  }, { isSignIn: true })
  .put(
    '/:id',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      // FR-23: a receipt whose request died is finished (on its device) before an edit that moves printed money is
      // refused for it (`updateDocument`).
      const finishInterrupted = () => finishInterruptedDocuments(orgId, user, id)
      return answered(status, await updateDocument({ orgId, id, user, body, finishInterrupted }))
    },
    {
      isSignIn: true, fiscalDevice: deviceFromDeadReceipt,
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
            type: t.Union([t.Literal('base'), t.Literal('category'), t.Literal('tag'), t.Literal('contact'), t.Literal('tier'), t.Literal('override'), t.Literal('customer')]),
            label: t.String(),
            price: t.Number(),
          }))),
          // Order linkage: round-tripped by the form so edits of conversion invoices /
          // ORDO-linked bills keep their reservation/receipt references.
          orderRef: t.Optional(orderRefBody),
          sourceText: t.Optional(t.String()),
          // #171: round-tripped on an invoice for a cash sale; stripped on any other document.
          cashSaleLineId: t.Optional(t.String()),
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
        productUpdates: t.Optional(t.Array(AnObject)),
      }),
    },
  )
  .delete('/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const existing = await r.invoices.findOne({ id, orgId } as any)
    if (!existing) return status(404, { message: 'Invoice not found' })
    if (isImmutableRegisterDocument(existing as any)) return status(409, { ...REGISTER_DOCUMENT_IMMUTABLE })
    if (existing.status !== 'draft') return status(400, { message: 'Can only delete draft invoices' })

    // ⚠ The claim first, which nothing writes past, then the receipts, then the delete. A draft bill made
    // from goods receipts gives them back before it goes, because it is the only record of the supplier
    // it wrote on them, and a crash after the delete would leave that on the receipt with nothing to take
    // it off again (FR-22.31). And it must not give them back unless it goes: a delete that lost to
    // an issue under way left a bill issued with its receipts released. A claim that a crash leaves
    // behind lapses, and pressing again finishes it.
    const claimedAt = new Date()
    const claimed = await Invoice.findOneAndUpdate(
      { _id: id, orgId, ...unclaimedDraft(claimedAt) },
      { $set: { voidingUntil: new Date(claimedAt.getTime() + LEASE_MS) } },
    ).exec()
    if (!claimed) return draftTaken(status, orgId, id)
    try {
      await releaseReceiptLinks(orgId, existing, user.id)
      // FR-22.61: a draft invoice made from stock notes gives them back the same way, and for the same reason.
      await releaseDispatchLinks(orgId, existing, user.id)
    } catch (e) {
      await Invoice.updateOne({ _id: id, orgId }, { $set: { voidingUntil: null } }).exec()
      throw e
    }
    await r.invoices.deleteInOrg(id, orgId)

    // Deleting a draft conversion invoice re-opens the order reservations it consumed.
    await syncOrderForInvoice(orgId, existing, user.id)

    createAuditEntry({ orgId, userId: user.id, action: 'delete', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: (existing as any)?.invoiceNumber })

    return { message: 'Invoice deleted' }
  }, { isSignIn: true })
  .post('/:id/send', async ({ params: { orgId, id }, body, user, status, headers }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    let key: string | undefined
    try {
      key = readIdempotencyKey(headers)
    } catch (e: any) {
      return status(e.statusCode, { code: e.code, message: e.message })
    }
    const hash = key ? requestHash(`invoice.send:${id}`, body ?? {}) : undefined

    // The issue (`sendDocument`, around FR-29.8's `issueDocument`); its receipt on the device of whoever issues it
    // (`counterAtIssue`, FR-23).
    const counter = counterAtIssue(orgId, id, user, key, hash)
    return answered(status, await sendDocument({ orgId, id, user, body, key, hash, counter }))
  }, {
    isSignIn: true,
    fiscalDevice: deviceFromCounter,
    // FR-32.18: what an issue may say, and nothing it must (the Issue button sends none). `acknowledgeOverlap` takes any
    // value: only `true` answers the overlap question, and anything else is asked again (409 `receipt_overlap` /
    // `dispatch_overlap`), as it was before the route had a schema. A 422 there would change an answer FR-32.27 keeps.
    // No `additionalProperties`: nothing else is read, and a schema that keeps undeclared fields is the body-as-document
    // controllers' (`unit/server-owned.test.ts`).
    body: t.Optional(t.Object({
      pendingTransferIds: t.Optional(t.Array(t.String())),
      acknowledgeOverlap: t.Optional(t.Unknown()),
    })),
  })
  .post('/:id/receive', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const invoice = await r.invoices.findOne({ id, orgId } as any)
    if (!invoice) return status(404, { message: 'Invoice not found' })
    if (invoice.direction !== 'incoming') return status(400, { message: 'Only incoming invoices can be received' })
    if (invoice.status !== 'draft') return status(400, { code: 'bill_not_draft', message: 'Invoice is not in draft status' })
    if (isBeingVoided(invoice as any)) return status(409, { ...DOCUMENT_CLAIMED })

    // Before the number is drawn: a bill refused here is the draft it was. Booking it would refuse
    // the same thing after the bill was written as received, with no stock and no way back. A bill
    // that cannot book at all is told so before it is asked what to do about its goods.
    const unbookable = await stockBookingRefusal(invoice as any)
    if (unbookable) return status(422, { ...unbookable })
    const overlap = await receiptsOverlapping(orgId, invoice)
    if (overlap && !body?.acknowledgeOverlap) return status(409, receiptOverlapRefusal(invoice, overlap))

    const draftNumber = (invoice as any).invoiceNumber
    /**
     * ⚠ One Receive at a time. Two can both pass the check above, and each would book the goods and draw
     * a number. Exactly one takes the bill's issue lease here (`/send`'s), and the other books nothing; an
     * issue under way on `/send` holds the draft as well, and so does a void's or a delete's claim
     * (`unclaimedDraft`; a lease that lapsed is a crash, and holds nothing).
     *
     * FR-29.10: the bill leaves draft in the transaction that books its goods and draws its number
     * (`issueDocument`). It used to be written as received first and booked after, so a booking that
     * failed left a received bill with none or part of its stock, and no route could retry it. Now it is
     * the draft it was, with its draft number and no number drawn, and Receive works again.
     */
    const now = new Date()
    const leaseUntil = new Date(now.getTime() + LEASE_MS)
    const taken = await Invoice.findOneAndUpdate(
      { _id: id, orgId, ...unclaimedDraft(now) },
      { $set: { issue: { leaseUntil } } },
    ).exec()
    if (!taken) {
      if (isBeingVoided(await Invoice.findOne({ _id: id, orgId }, { voidingUntil: 1 }).lean().exec() as any)) return status(409, { ...DOCUMENT_CLAIMED })
      return status(409, { code: 'bill_not_draft', message: `${draftNumber} is no longer a draft: another request is receiving or issuing it` })
    }
    let issued: Awaited<ReturnType<typeof issueDocument>>
    try {
      issued = await issueDocument({
        orgId, invoice, userId: user.id, status: 'received',
        heldBy: { 'issue.leaseUntil': leaseUntil },
        fields: { 'issue.leaseUntil': null, 'issue.completedAt': new Date() },
      })
    } catch (e: any) {
      await Invoice.updateOne({ _id: id, orgId, status: 'draft', 'issue.leaseUntil': leaseUntil }, { $unset: { issue: 1 } }).exec()
      if (e instanceof IssueStockError) {
        const answer = stockFailureAnswer(e, null)
        if (answer) return status(answer[0], answer[1])
        throw e.failure
      }
      if (e instanceof IssueLostError) {
        if (isBeingVoided(await Invoice.findOne({ _id: id, orgId }, { voidingUntil: 1 }).lean().exec() as any)) return status(409, { ...DOCUMENT_CLAIMED })
        return status(409, { code: 'bill_not_draft', message: `${draftNumber} is no longer a draft: another request is receiving or issuing it` })
      }
      throw e
    }
    const { invoice: updated, issuedNumber } = issued

    // ORD-linked bills: book the receipt onto the order (receivedQuantity, status, holds).
    await syncOrderForInvoice(orgId, updated || invoice, user.id)

    // A bill made from goods receipts moved nothing just now (its `stockSource`); it carries the
    // supplier's prices forward to the next receipts instead (FR-22 D-2).
    await applyLinkedBillPrices(orgId, updated || invoice, user.id)

    createAuditEntry({ orgId, userId: user.id, action: 'receive', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: issuedNumber, changes: { invoiceNumber: { from: draftNumber, to: issuedNumber } } })
    if (overlap) auditOverlapAcknowledged(orgId, user.id, id, issuedNumber, overlap)

    return { invoice: updated }
  }, {
    isSignIn: true,
    // Optional: every caller before FR-22.31c sends none, and a bill with no overlap needs none.
    body: t.Optional(t.Object({ acknowledgeOverlap: t.Optional(t.Boolean()) })),
  })
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
      /** The tender of this request: in cents, as a fiscal receipt has no others, dated as it prints. */
      const tenderOf = () => ({ method: body.method, amount: round2(body.amount), date: new Date(), ...(body.reference ? { reference: body.reference } : {}) })

      let invoice = await r.invoices.findOne({ id, orgId } as any)
      if (!invoice) return status(404, { message: 'Invoice not found' })
      if (key) {
        // A receipt holds the key of the payment it took.
        const receipt = await keyedReceipt(orgId, key)
        if (receipt) {
          try {
            if (receipt.type === PAYMENT_STORNO) return await paymentRefundAnswer(status, orgId, id, await refund(orgId, user, await rawOf(id, orgId), tenderOf(), null, { key, hash: hash! }))
            return await paymentReceiptAnswer(status, orgId, id, await settleKeyedReceipt(orgId, user, receipt, hash!))
          } catch (e: any) {
            if (e instanceof RegisterRefusal) return status(e.statusCode, e.body)
            throw e
          }
        }
        const replayed = await replayPayment(status, orgId, id, invoice, key, hash)
        if (replayed) return replayed
      }
      // FR-23: what a request that died left on this document comes first: its receipt may have
      // printed, and then this money is already taken.
      if (await finishInterruptedDocuments(orgId, user, id)) invoice = (await r.invoices.findOne({ id, orgId } as any))!
      const refused = await paymentRefusal(orgId, invoice, body.amount)
      if (refused) return status(refused.statusCode, refused.body)
      // FR-23 §2.2: the courier's money does not go past a receipt that never printed, or the sale
      // ends with none, or with part of one.
      if (body.method === 'cash_on_delivery' && await owesDeliveryReceipt(orgId, invoice)) return status(409, { ...DELIVERY_RECEIPT_OWED })

      // FR-23 §2.2: cash or card at the counter prints, and the receipt records the payment. Refused
      // here when it cannot, with nothing written.
      try {
        // In cents: a fiscal receipt has no others. Its date is the print's, which dates it in its
        // turn on the device: the device, the session and the row say one day.
        const tender = tenderOf()
        if (invoice.type === 'credit_note') {
          // R2: a refund in cash or by card prints a storno of a receipt that paid its invoice.
          const note = await rawOf(id, orgId)
          const preparedRefund = await prepareRefund(orgId, user, note, tender, false)
          if (preparedRefund) return await paymentRefundAnswer(status, orgId, id, await refund(orgId, user, note, tender, preparedRefund, key ? { key, hash: hash! } : undefined))
        }
        const prepared = await prepareReceipt(orgId, user, invoice, tender, false)
        if (prepared) {
          const doc = await Invoice.findOne({ _id: id, orgId }).lean().exec()
          return await paymentReceiptAnswer(status, orgId, id, await printReceipt(orgId, prepared, doc, key ? { key, hash: hash! } : undefined))
        }
      } catch (e: any) {
        if (e instanceof RegisterRefusal) return status(e.statusCode, e.body)
        throw e
      }

      return recordPayment(status, { orgId, id, user, body, key, hash, invoice })
    },
    {
      isSignIn: true, fiscalDevice: deviceFromCounter,
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
  // FR-23: the receipt of a cash-on-delivery invoice, when issuing it did not print one. The money
  // is the courier's: there is no payment to take again, and Pay would record money nobody brought.
  .post('/:id/receipt', async ({ params: { orgId, id }, user, status, headers }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    let key: string | undefined
    try {
      key = readIdempotencyKey(headers)
    } catch (e: any) {
      return status(e.statusCode, { code: e.code, message: e.message })
    }
    const hash = key ? requestHash(`invoice.receipt:${id}`, {}) : undefined
    const answer = async (receipt: any) => {
      if (receipt.register?.fiscal?.inDoubt) return status(409, inDoubtRefusal(receipt))
      if (receipt.register?.fiscal?.state === 'failed') {
        return status(503, { code: 'fiscal_error', receiptId: String(receipt._id), message: `The receipt was not printed: ${receipt.register.receiptError}` })
      }
      return { invoice: await r.invoices.findOne({ id, orgId } as any), ...receiptOutcome(receipt) }
    }

    if (!(await r.invoices.findOne({ id, orgId } as any))) return status(404, { message: 'Invoice not found' })
    try {
      const replay = key ? await keyedReceipt(orgId, key) : null
      if (replay) return await answer(await settleKeyedReceipt(orgId, user, replay, hash!))

      // What a request that died left comes first: its receipt may have printed.
      await finishInterruptedDocuments(orgId, user, id)
      const doc: any = await Invoice.findOne({ _id: id, orgId }).lean().exec()
      // ⚠ Right after the issue's write this owes a receipt, and the issue is about to print it. A delivery
      // receipt pays nothing and lets go of its hold, so nothing the issue reads next would tell.
      if (doc?.issue?.leaseUntil && new Date(doc.issue.leaseUntil).getTime() >= Date.now()) return status(409, ISSUE_IN_PROGRESS)
      const prepared = (await owesDeliveryReceipt(orgId, doc)) ? await prepareIssueReceipt(orgId, user, doc) : null
      if (!prepared) {
        const doubt = await receiptInDoubt(orgId, id)
        return status(409, doubt ? inDoubtRefusal(doubt) : { code: 'no_receipt_owed', message: 'This document has no receipt left to print.' })
      }

      return await answer(await printReceipt(orgId, prepared, doc, key ? { key, hash: hash! } : undefined))
    } catch (e: any) {
      if (e instanceof RegisterRefusal) return status(e.statusCode, e.body)
      throw e
    }
  }, { isSignIn: true, fiscalDevice: deviceFromCounter })
  .post('/:id/void', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const invoice = await r.invoices.findOne({ id, orgId } as any)
    if (!invoice) return status(404, { message: 'Invoice not found' })
    if (isImmutableRegisterDocument(invoice as any)) return status(409, { ...REGISTER_DOCUMENT_IMMUTABLE })
    // FR-23 §2.7: the receipt stands, so the document it paid does.
    await finishInterruptedDocuments(orgId, user, id)
    const frozen = await freezeRefusal(orgId, id) ?? await freezeUnderNotes(orgId, invoice)
    if (frozen) return status(409, frozen)
    // #171: an invoice for a cash sale is born paid, but the money is the cash sale's, so voiding
    // it gives nothing back — it only releases the sale's quantities for a new invoice.
    const voidable = (invoice as any).cashSaleRef?.cashSaleId ? ['draft', 'paid'] : ['draft', 'sent', 'received']
    if (!voidable.includes(invoice.status))
      return status(400, { message: 'Can only void draft, sent, or received invoices' })

    // ⚠ FR-23: claimed before the stock moves, against the hold a receipt takes before it prints and
    // against an issue under way. Of a void and a payment at once one gives way, by any method, and
    // of a void and an issue: read and then written, a voided answer came back on a document that
    // ended paid with a fiscal receipt on it. `fitsDue` and `/send` honour this claim.
    const now = new Date()
    const claimed = await Invoice.findOneAndUpdate(
      { _id: id, orgId, status: invoice.status, 'receiptHolds.0': { $exists: false }, $and: [issueLeaseFree(now), notBeingVoided(now)] },
      { $set: { voidingUntil: new Date(now.getTime() + LEASE_MS) } },
    ).exec()
    if (!claimed) return whoHolds(status, orgId, id)
    const release = () => Invoice.updateOne({ _id: id, orgId }, { $set: { voidingUntil: null } }).exec()
    // A receipt written before the claim that had not taken its hold yet will now be refused one.
    const late = await freezeRefusal(orgId, id) ?? await freezeUnderNotes(orgId, invoice)
    if (late) {
      await release()
      return status(409, late)
    }

    try {
      // ORD-linked bill voids reverse the very stock whose receipt backs the reservation
      // holds — allow the reversal and let the order sync re-balance afterwards.
      await reverseInvoiceStockMovement(invoice, user.id, undefined, (invoice as any).orderId ? { allowNegative: true } : undefined)
    } catch (e: any) {
      await release()
      return status(400, { message: e.message })
    }

    const history = [...((invoice as any).statusHistory || []), statusEntry('voided', invoice.status, user.id)]
    const updated = await r.invoices.updateInOrg(id, orgId, { status: 'voided', voidedAt: new Date(), voidingUntil: null, statusHistory: history } as any)

    await syncOrderForInvoice(orgId, updated || invoice, user.id)
    // FR-22 §5.3: a voided bill made from goods receipts gives them back — they can be billed
    // again. Nothing moved above (its `stockSource` stops the reversal) and nothing moves here.
    await releaseReceiptLinks(orgId, invoice, user.id)
    // FR-22.61: so does a voided invoice made from stock notes. Its notes can be invoiced again.
    await releaseDispatchLinks(orgId, invoice, user.id)

    createAuditEntry({ orgId, userId: user.id, action: 'void', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: (invoice as any)?.invoiceNumber })

    return { invoice: updated }
  }, { isSignIn: true, fiscalDevice: deviceFromDeadReceipt })
  // ── #171: an invoice for a cash sale („фактура към касова продажба") ──
  // What a cash sale still has to invoice, and the invoices it already has.
  .get('/:id/to-invoice', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return { invoicing: await getCashSaleInvoicing(orgId, id) }
    } catch (e: any) {
      if (e instanceof CashSaleInvoiceError) return refused(status, e)
      throw e
    }
  }, { isSignIn: true })
  // Issue the invoice (or keep a draft). No stock, no journal entry, born paid: see the service.
  .post(
    '/:id/to-invoice',
    async ({ params: { orgId, id }, body, user, status, headers }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      let key: string | undefined
      try {
        key = readIdempotencyKey(headers)
      } catch (e: any) {
        return status(e.statusCode, { code: e.code, message: e.message })
      }
      const hash = key ? requestHash(`invoice.toInvoice:${id}`, body) : undefined
      try {
        return { invoice: await createInvoiceForCashSale(orgId, user, id, body, { key, hash }) }
      } catch (e: any) {
        if (e instanceof CashSaleInvoiceError) return refused(status, e)
        if (e instanceof IdempotencyError) return reused(status, e)
        throw e
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        contactId: t.String(),
        issueDate: t.Optional(t.String()),
        lines: t.Optional(t.Array(t.Object({ lineId: t.String(), quantity: t.Number() }))),
        issue: t.Optional(t.Boolean()),
        notes: t.Optional(t.String()),
        printNote: t.Optional(t.String({ maxLength: 300 })),
        locale: t.Optional(t.String()),
      }),
    },
  )
  // ── FR-21 §11: an invoice entered before its till sale arrived, attached to that sale ──
  // The cash sales of the invoice's day that sold every line of it and have room for them.
  .get('/:id/cash-sale-candidates', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    try {
      return await cashSaleCandidates(orgId, id)
    } catch (e: any) {
      if (e instanceof CashSaleInvoiceError) return refused(status, e)
      throw e
    }
  }, { isSignIn: true })
  // Take back its dispatch and make it the invoice for that cash sale: see the service.
  .post(
    '/:id/attach-to-cash-sale',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      // FR-23 §2.7: its receipt took this money; a cash sale cannot be what paid it.
      const frozen = await freezeRefusal(orgId, id)
      if (frozen) return status(409, frozen)
      try {
        return { invoice: await attachInvoiceToCashSale(orgId, user, id, body.cashSaleId) }
      } catch (e: any) {
        if (e instanceof CashSaleInvoiceError) return refused(status, e)
        throw e
      }
    },
    { isSignIn: true, body: t.Object({ cashSaleId: t.String() }) },
  )
  // FR-22.22: a quote becomes the next document, once: a proforma an invoice, an offer a proforma or an invoice
  // (`target`). A draft under its own draft number, taken once even for two presses at once (`convertQuote`).
  .post('/:id/convert', async ({ params: { orgId, id }, body, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    return answered(status, await convertQuote(orgId, id, user, body?.target))
  }, {
    isSignIn: true,
    // Optional: a proforma's convert, and every caller before the offer, sends none.
    body: t.Optional(t.Object({ target: t.Optional(t.Union([t.Literal('invoice'), t.Literal('proforma')])) })),
  })
