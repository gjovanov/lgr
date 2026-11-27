import { cashSaleLineAmounts } from 'config/line-amounts'
import { Invoice } from 'db/models'
import { getRepos } from '../../context.js'
import { grantOf } from '../access/evaluate.js'
import { keepStoredTrails } from '../access/price-trails.js'
import { createAuditEntry, diffChanges } from '../audit-log.service.js'
import { CashSaleInvoiceError, checkInvoiceForCashSaleEdit, liveInvoiceNumbersFor } from '../cash-sale-invoice.service.js'
import { settlesOnIssue, syncCashSettlement } from '../cash-settlement.service.js'
import { isImmutableRegisterDocument, REGISTER_DOCUMENT_IMMUTABLE } from '../cash-register/immutability.js'
import { DOCUMENT_CHANGED, DOCUMENT_CLAIMED, freezeRefusal, owedByMovingToDelivery } from '../cash-register/payment-receipt.service.js'
import { movesPrintedMoney } from '../cash-register/receipt-lines.js'
import { originOf } from '../cash-register/register.service.js'
import { DispatchInvoiceError, checkLinkedInvoiceEdit, isDispatchLinked } from '../dispatch-invoice.service.js'
import { editedAmounts } from '../document-amounts.js'
import { InvoiceWriteLost, updateInvoiceWithProductUpdates } from '../invoice-with-update.service.js'
import { dueFollowsTotal, heldOn, isBeingVoided, issueLeaseFree, notBeingVoided, unclaimedDraft } from '../invoice-payment.js'
import { GRValidationError } from '../product-update.service.js'
import { ReceiptBillError, checkLinkedBillEdit, isReceiptLinked } from '../receipt-bill.service.js'
import { syncOrderForInvoice } from '../reservation.service.js'
import { typedPriceRefusal, withArticleUnits } from '../sales-lines.js'
import { ISSUE_IN_PROGRESS, draftTaken, receiptPrinting, ruleSettles } from './document-claims.js'
import { correctsAnother, foreignCurrencyRefusal, orderLinkRefusal, round2, validateRelatedInvoiceRef, validateReservationLineRefs } from './document-checks.js'
import { refuse } from './refused.js'

/**
 * FR-32.21 (#797): updating a document, `PUT /invoices/:id`. Moved whole from the route: what an edit may change, the
 * write that holds against a receipt, a payment, an issue or a void under way, and what follows it (the order, the
 * cash rule, what is due).
 */
export interface UpdateRequest {
  orgId: string
  id: string
  user: any
  /** The body as the route's schema took it. Rewritten here as the route rewrote it. */
  body: any
  /**
   * FR-23: what a request that died left on this document (a receipt whose request died), finished before an edit
   * that moves printed money is refused for it. The till's (`api/src/invoicing` `finishInterruptedDocuments`): it reaches
   * the device, which `services` does not.
   */
  finishInterrupted: () => Promise<unknown>
}

/** Update a document. The answer is `{ invoice }`, or a `Refused` with the route's status and body. */
export async function updateDocument(req: UpdateRequest): Promise<unknown> {
  const { orgId, id, user, body } = req
  const r = getRepos()

  // Sanitize empty string IDs to undefined
  if (!body.contactId) body.contactId = undefined

  const existing: any = await r.invoices.findOne({ id, orgId })
  if (!existing) return refuse(404, { message: 'Invoice not found' })
  // FR-21.11: a till document or a storno is corrected by a storno, never edited.
  if (isImmutableRegisterDocument(existing)) return refuse(409, { ...REGISTER_DOCUMENT_IMMUTABLE })
  // FR-26.6: the order links it has are kept; without `orders` none is added or changed.
  const unlinked = orderLinkRefusal(user, body, existing)
  if (unlinked) return refuse(403, unlinked)
  // #724: a line price this session's role may not type is refused (FR-27 `sales-docs.manual-price`; the
  // document's own lines are not this save's figures), and an outgoing article line's unit is its article's.
  if (Array.isArray(body.lines)) {
    const typed = await typedPriceRefusal(orgId, user, {
      direction: existing.direction,
      contactId: body.contactId !== undefined ? body.contactId : existing.contactId,
      relatedInvoiceId: body.relatedInvoiceId !== undefined ? body.relatedInvoiceId : existing.relatedInvoiceId,
      lines: body.lines,
    }, { stored: existing.lines, excludeId: id })
    if (typed) return refuse(403, typed)
    body.lines = await withArticleUnits(orgId, existing.direction, body.lines, existing.lines, {
      relatedInvoiceId: body.relatedInvoiceId !== undefined ? body.relatedInvoiceId : existing.relatedInvoiceId,
    })
  }
  // ⚠ What is due is derived, never taken (#454): from the total and what was paid, below, or
  // from the sale for an invoice for one. A client's figure was written as sent whenever the
  // total stayed put. Dropped HERE, before anything below derives its own. Still accepted by
  // the schema, so an older form that sends it is not refused.
  delete body.amountDue
  // What the request leaves out, as `POST` derives it, and every write below carries it. ⚠ Before the
  // freeze reads the request: a total only derived here still moves what a receipt printed. An
  // invoice for a cash sale takes all of it from the sale, below.
  // #573: a cash sale's line amounts are the server's, as when it was made. An imported day keeps its file's.
  // FR-27.11.C.4: a role shown a redacted trail does not overwrite the stored one on a line it did not reprice.
  if (Array.isArray(body.lines)) body.lines = keepStoredTrails(grantOf(user), body.lines, existing.lines)
  if (existing.type === 'cash_sale' && body.lines && originOf(existing) !== 'import') {
    body.lines = body.lines.map((l: any) => ({ ...l, ...cashSaleLineAmounts(l) }))
  }
  if (!existing.cashSaleRef?.cashSaleId) Object.assign(body, editedAmounts(existing, body))
  // FR-23 §2.7: a printed receipt cannot change, so what it printed cannot either. Anything else
  // on the document stays editable, as on every other.
  const movesMoney = existing.direction === 'outgoing' && existing.status !== 'draft' && (movesPrintedMoney(existing, body) || correctsAnother(existing, body))
  if (movesMoney) {
    // A receipt whose request died is no reason to refuse, if it never printed.
    await req.finishInterrupted()
    const frozen = await freezeRefusal(orgId, id)
    if (frozen) return refuse(409, frozen)
  }

  // Inline product-master updates (purchase bills only) — extracted before the $set below.
  const productUpdates: any[] | undefined = body.productUpdates
  delete body.productUpdates

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
      { type: existing.type, direction: existing.direction, lines: body.lines },
      id,
    )
    if (refErr) return refuse(422, { message: refErr })
  }

  // Credit/debit notes must keep a valid related-invoice reference. Validate the
  // EFFECTIVE values (body wins, existing fills the gaps) so a partial PUT can't
  // silently clear or corrupt the link.
  const relErr = await validateRelatedInvoiceRef(orgId, {
    type: existing.type,
    direction: existing.direction,
    contactId: body.contactId !== undefined ? body.contactId : existing.contactId,
    relatedInvoiceId: body.relatedInvoiceId !== undefined ? body.relatedInvoiceId : existing.relatedInvoiceId,
  })
  if (relErr) return refuse(422, { message: relErr })

  // #171: an invoice issued for a cash sale keeps the sale's lines, prices and payment — the
  // service says what an edit may still change and recomputes the rest. Any other document
  // cannot gain the link through an edit.
  if (existing.cashSaleRef?.cashSaleId) {
    try {
      Object.assign(body, await checkInvoiceForCashSaleEdit(orgId, existing, body))
    } catch (e: any) {
      if (e instanceof CashSaleInvoiceError) return refuse(e.statusCode, { code: e.code, message: e.message, ...(e.details || {}) })
      throw e
    }
  } else {
    delete body.cashSaleRef
    delete body.taxEventDate
    for (const l of body.lines || []) delete l.cashSaleLineId
  }
  // An edit can neither give a document a stock source nor take one away (see POST).
  delete body.stockSource
  // FR-22.31 (D-2): a bill made from goods receipts bills what they received, whole.
  if (isReceiptLinked(existing)) {
    try {
      await checkLinkedBillEdit(orgId, existing, body)
    } catch (e: any) {
      if (e instanceof ReceiptBillError) return refuse(e.statusCode, { code: e.code, message: e.message, ...(e.details || {}) })
      throw e
    }
  }
  // FR-22.61: an invoice made from stock notes invoices what they delivered, whole.
  if (isDispatchLinked(existing)) {
    try {
      await checkLinkedInvoiceEdit(orgId, existing, body)
    } catch (e: any) {
      if (e instanceof DispatchInvoiceError) return refuse(e.statusCode, { code: e.code, message: e.message, ...(e.details || {}) })
      throw e
    }
  }
  // A cash sale's line ids are what its invoices point at, and a PUT of `lines` replaces them.
  if (existing.type === 'cash_sale' && body.lines !== undefined) {
    const invoiced = await liveInvoiceNumbersFor(orgId, id)
    if (invoiced.length) {
      return refuse(409, {
        code: 'cash_sale_invoiced',
        message: `${existing.invoiceNumber} is invoiced by ${invoiced.join(', ')} — void those invoices before changing its lines`,
      })
    }
  }

  // Keep the canonical number/status fields owned by the controller — never let edits
  // overwrite them through the body schema (defence in depth: schema already excludes them).
  delete body.invoiceNumber
  delete body.status
  delete body.draftNumber
  delete body.numberHistory
  if (body.paymentMethod === 'cash_on_delivery' && await owedByMovingToDelivery(orgId, existing)) {
    body.deliveryReceiptOwed = true
  }

  let updated: any
  if (Array.isArray(productUpdates) && productUpdates.length > 0) {
    if (!(existing.type === 'invoice' && existing.direction === 'incoming')) {
      return refuse(422, { message: 'productUpdates is only supported for purchase bills' })
    }
    // A bill made from goods receipts updates no product: its receipts brought the goods in at
    // their costs, and receiving the bill carries its prices forward (FR-22 D-2,
    // `applyLinkedBillPrices`). Its form offers no product update; this refuses an older one.
    if (isReceiptLinked(existing)) {
      return refuse(422, {
        code: 'receipt_linked_bill',
        message: `${existing.invoiceNumber} is made from goods receipts (${existing.stockSource?.docNumber}) — it updates no product`,
      })
    }
    const refusal = await foreignCurrencyRefusal(orgId, body.currency ?? existing.currency)
    if (refusal) return refuse(422, refusal)
    // Bill $set + product bulk-update in one transaction; no stock movement here
    // (bills touch stock only via /receive). Not reachable from desktop/SQLite.
    let updatedProductIds: string[] = []
    try {
      const res = await updateInvoiceWithProductUpdates({
        orgId, invoiceId: id, update: body, productUpdates, ...(existing.status === 'draft' ? { where: unclaimedDraft() } : {}),
      })
      updatedProductIds = res.updatedProductIds
    } catch (e: any) {
      if (e instanceof GRValidationError) return refuse(422, { message: e.message })
      if (e instanceof InvoiceWriteLost) return draftTaken(refuse, orgId, id)
      throw e
    }
    updated = await r.invoices.findOne({ id, orgId })
    for (const pid of updatedProductIds) {
      createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'warehouse', entityType: 'product', entityId: pid, correlationId: id })
    }
  } else if (existing.status === 'draft') {
    updated = await r.invoices.updateInOrg(id, orgId, body, unclaimedDraft())
    if (!updated) return draftTaken(refuse, orgId, id)
  } else if (movesMoney) {
    // ⚠ The read above is a check, and this is what makes it hold. A receipt that took its hold
    // since prints the old total, and one that finished since has paid it, and both would leave
    // the document disagreeing with the device. A payment fits the total it reads, so the other
    // order is safe: of an edit and a payment one gives way. ⚠ And an issue still holds its claim
    // here, past its own write: nothing stands on this document until its receipt does, and an
    // edit in that gap printed 36 for a receipt of 24.
    const writing = new Date()
    updated = await r.invoices.updateInOrg(id, orgId, body, {
      'receiptHolds.0': { $exists: false }, amountPaid: existing.amountPaid ?? null, $and: [issueLeaseFree(writing), notBeingVoided(writing)],
    })
    if (!updated) {
      const frozen = await freezeRefusal(orgId, id)
      if (frozen) return refuse(409, frozen)
      const now: any = await Invoice.findOne({ _id: id, orgId }, { receiptHolds: 1, voidingUntil: 1, 'issue.leaseUntil': 1 }).lean().exec()
      if (heldOn(now) > 0) return receiptPrinting(refuse, orgId, id)
      if (now?.issue?.leaseUntil && new Date(now.issue.leaseUntil).getTime() >= Date.now()) return refuse(409, ISSUE_IN_PROGRESS)
      return refuse(409, { ...(isBeingVoided(now) ? DOCUMENT_CLAIMED : DOCUMENT_CHANGED) })
    }
  } else {
    updated = await r.invoices.updateInOrg(id, orgId, body)
  }

  createAuditEntry({ orgId, userId: user.id, action: 'update', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: updated?.invoiceNumber || existing?.invoiceNumber, changes: diffChanges(existing, updated) })

  // Quantity edits on ORD-linked documents shift the derived reservation/receipt state.
  await syncOrderForInvoice(orgId, updated || existing, user.id)

  // An issued invoice edited to cash (or its total changed while cash) is paid; one edited
  // away from cash gives back the payment that rule recorded. A credit note the same, its
  // refund. Drafts are untouched.
  // ⚠ FR-23: where LGR prints the rule does not settle. That money goes through the payment
  // action, which prints, and an edit must not take it silently. An imported document never
  // prints, so the rule stays its own.
  let settled = false
  if (settlesOnIssue(existing) && existing.status !== 'draft') {
    const settlement = await syncCashSettlement(orgId, id, user.id, { settles: await ruleSettles(orgId, updated ?? existing) })
    settled = settlement.action !== 'none'
    if (settled) updated = await r.invoices.findOne({ id, orgId })
  }
  // Whatever that rule left alone: a debit note, a bill, a draft, a document paid by bank. A cash sale owes
  // nothing, and an invoice for one is the service's above.
  const owes = existing.type !== 'cash_sale' && !existing.cashSaleRef?.cashSaleId
  if (!settled && owes && updated && round2(updated.total) !== round2(existing.total)) {
    const due: any = dueFollowsTotal({ at: new Date(), by: String(user.id) })
    await Invoice.updateOne({ _id: id, orgId }, due).exec()
    updated = await r.invoices.findOne({ id, orgId })
  }

  return { invoice: updated }
}
