import { isQuoteType } from 'config/constants'
import { Invoice } from 'db/models'
import { getRepos } from '../../context.js'
import { eventBus } from '../../events/event-bus.js'
import { createAuditEntry } from '../audit-log.service.js'
import { syncCashSettlement } from '../cash-settlement.service.js'
import { DOCUMENT_CHANGED, type ReceiptTender } from '../cash-register/payment-receipt.service.js'
import { RegisterRefusal } from '../cash-register/register.service.js'
import { issueFieldsFor } from '../cash-sale-invoice.service.js'
import { dispatchesOverlapping } from '../dispatch-invoice.service.js'
import { LEASE_MS, WAIT_MS } from '../hot-path-key.js'
import { issuableRefusal } from '../invoice-numbering.service.js'
import { unclaimedDraft } from '../invoice-payment.js'
import { issueDocument, IssueLostError, IssueStockError } from '../issue-document.service.js'
import { applyLinkedBillPrices, receiptsOverlapping } from '../receipt-bill.service.js'
import { syncOrderForInvoice } from '../reservation.service.js'
import { PendingTransferError, confirmTransferMovements, discardPendingTransfers } from '../stock-transfer.service.js'
import { ISSUE_IN_PROGRESS, holderOf, ruleSettles } from './document-claims.js'
import { auditDispatchOverlapAcknowledged, auditOverlapAcknowledged, dispatchOverlapRefusal, receiptOverlapRefusal, stockFailureAnswer } from './document-checks.js'
import { refuse } from './refused.js'

/**
 * FR-32.21 (#797): issuing a draft, `POST /invoices/:id/send`. Around `issueDocument` (FR-29.8: the stock, the number
 * and the status in one transaction) sit what the route always did: the key and its replay, the questions a bill and
 * an invoice are asked first, the claim, the transfers, and what follows the issue.
 *
 * ⚠ FR-23: a document paid at the counter prints as it is issued, in the session of whoever issues it. Printing
 * reaches the device, which `services` does not: those steps are the API's, handed in as an `IssueCounter`
 * (`invoicing-api/src/lib/counter-issue.ts`), and this calls them where the route did.
 */

/** What the counter takes at this issue: a receipt's or a refund's tender, decided before the claim. */
export interface CounterAtIssue {
  tender: ReceiptTender
}

/** The steps of an issue that reach the device. Each answers as the route does. */
export interface IssueCounter {
  /** FR-23 §2.3: what this issue prints, or null when it prints nothing. Throws a `RegisterRefusal` when it cannot. */
  prepare(invoice: any): Promise<CounterAtIssue | null>
  /** FR-23 §2.4: the receipt (or the refund), now that the document has the number it names. */
  print(prepared: CounterAtIssue): Promise<unknown>
  /** A retry of an issue that went through: its receipt comes back, printed once. */
  replayIssued(): Promise<unknown>
}

export interface SendRequest {
  orgId: string
  id: string
  user: any
  /** `{ pendingTransferIds?, acknowledgeOverlap? }`, or nothing (the Issue button sends none). */
  body: any
  key?: string
  hash?: string
  counter: IssueCounter
}

/** Issue a draft. The answer is `{ invoice, … }`, or a `Refused` with the route's status and body. */
export async function sendDocument(req: SendRequest): Promise<unknown> {
  const { orgId, id, user, body, key, hash, counter: atCounter } = req
  const r = getRepos()

  /**
   * The issue this key already made, or the one still running under it: the issued document
   * comes back, never a second dispatch or a second number. Null when the holder's lease
   * lapsed (a crash) — the caller then takes the claim over and finishes the issue.
   */
  const replayIssue = async (): Promise<any> => {
    const deadline = Date.now() + WAIT_MS
    for (;;) {
      const doc: any = await Invoice.findOne({ _id: id, orgId }).lean().exec()
      if (!doc || doc.issue?.clientKey !== key) return null
      if (doc.issue.requestHash !== hash) {
        return refuse(422, { code: 'idempotency_key_reused', message: 'This Idempotency-Key was already used for a different request' })
      }
      if (doc.status !== 'draft') return atCounter.replayIssued()
      if (!doc.issue.leaseUntil || new Date(doc.issue.leaseUntil).getTime() < Date.now()) return null
      if (Date.now() >= deadline) {
        return refuse(409, { code: 'idempotency_in_progress', message: 'This document is still being issued — retry with the same Idempotency-Key.' })
      }
      await new Promise(res => setTimeout(res, 150))
    }
  }

  const invoice: any = await r.invoices.findOne({ id, orgId })
  if (!invoice) return refuse(404, { message: 'Invoice not found' })
  if (key && invoice.issue?.clientKey === key) {
    const replayed = await replayIssue()
    if (replayed) return replayed
  }
  /**
   * The dialog draws up the transfers before it issues, and each retry from it draws new ones, so what a
   * request that will not issue leaves in draft stays in the movements list, and moves goods if somebody
   * confirms it. ⚠ Only on a refusal that means this request will not issue. Never on `issue_in_progress`,
   * where the holder may confirm those same ids, nor on a bill's overlap question, whose answer sends them again,
   * nor any id the document already carries: that one was confirmed for it.
   */
  const discardAsked = () => {
    const carried = (invoice.pendingTransferIds ?? []).map(String)
    const asked = body?.pendingTransferIds
    return discardPendingTransfers(orgId, Array.isArray(asked) ? asked.filter((t: unknown) => !carried.includes(String(t))) : asked)
  }

  if (invoice.status !== 'draft') {
    await discardAsked()
    return refuse(400, { message: 'Invoice is not in draft status' })
  }

  // FR-20.81 (P3-6d): no issued number while the series waits for a lost site's last numbers.
  // Refused here, before the claim and the dispatch, never at the allocation after them.
  const frozen = await issuableRefusal(orgId, invoice.direction as string, invoice.type as string)
  if (frozen) {
    await discardAsked()
    return refuse(409, { code: frozen.code, message: frozen.message })
  }

  // A bill issued here books its goods as `/receive` does, so it answers the same question first.
  const overlap = await receiptsOverlapping(orgId, invoice)
  // `/send`'s schema takes any value here, so this reads the answer itself: only the answer counts as one.
  if (overlap && body?.acknowledgeOverlap !== true) return refuse(409, receiptOverlapRefusal(invoice, overlap))
  // FR-22.61b: the mirror question, of a sales invoice typed for goods a stock note already delivered. Asked here,
  // before the tender, the claim and the dispatch: a refusal leaves the draft as it was.
  const noteOverlap = await dispatchesOverlapping(orgId, invoice)
  if (noteOverlap && body?.acknowledgeOverlap !== true) {
    // ⚠ Unlike the bill's question, this one is answered by starting the issue again: an invoice linked to the
    // note takes no stock at all, and one issued anyway is checked for stock afresh. So the transfers this request
    // drew up are not sent again, and would stay in draft for somebody to confirm.
    await discardAsked()
    return refuse(409, dispatchOverlapRefusal(invoice, noteOverlap))
  }

  // FR-23 §2.3: a document paid at the counter prints, in the open session of whoever issues it.
  // No session, no device: refused here, with no number drawn, no stock moved, no claim taken. R2: a
  // credit note the same way, with no receipt to storno or more than it still holds on top.
  let counter: CounterAtIssue | null
  try {
    counter = await atCounter.prepare(invoice)
  } catch (e: any) {
    if (!(e instanceof RegisterRefusal)) throw e
    await discardAsked()
    return refuse(e.statusCode, e.body)
  }

  /**
   * ⚠ CLAIM the draft before anything moves. Two Issue clicks (or a retry) used to both pass
   * the `draft` check above, so both dispatched the stock, both drew an issued number and both
   * posted a journal entry. Exactly one request holds this claim; a crashed holder's lease
   * lapses and the next Issue finishes what it started.
   *
   * ⚠ And a compare-and-set on what it read: the tender, the stock and the receipt below are decided
   * from that read, so a draft edited between the read and this claim is refused with nothing moved
   * and no number drawn. From the claim on `unclaimedDraft` refuses the edit instead.
   */
  const now = new Date()
  const claimed: any = await Invoice.findOneAndUpdate(
    { _id: id, orgId, updatedAt: invoice.updatedAt ?? null, ...unclaimedDraft(now) },
    { $set: { issue: { clientKey: key, requestHash: hash, leaseUntil: new Date(now.getTime() + LEASE_MS) } } },
    { new: true },
  ).exec()
  if (!claimed) {
    if (key) {
      const replayed = await replayIssue()
      if (replayed) return replayed
    }
    const held = await holderOf(orgId, id, doc => (doc?.status === 'draft' ? { ...DOCUMENT_CHANGED } : ISSUE_IN_PROGRESS))
    if (held !== ISSUE_IN_PROGRESS) await discardAsked()
    return refuse(409, held)
  }
  /** Give the draft back — a failed issue must not leave it claimed. */
  const release = () => Invoice.updateOne({ _id: id, orgId, status: 'draft' }, { $unset: { issue: 1 } }).exec()

  // #171: a draft invoice for a cash sale is issued paid — the cash sale took its money — and
  // posts nothing: no stock (its `stockSource` stops the dispatch below), no journal entry.
  const forCashSale = !!invoice.cashSaleRef?.cashSaleId
  const newStatus = forCashSale ? 'paid' : invoice.direction === 'incoming' ? 'received' : 'sent'

  // Confirm pending transfer movements before dispatch (cross-warehouse transfers)
  const pendingTransferIds = body?.pendingTransferIds as string[] | undefined
  if (pendingTransferIds?.length && !invoice.pendingTransferIds?.length) {
    try {
      await confirmTransferMovements(orgId, pendingTransferIds, { forDocumentId: String(id) })
    } catch (e: any) {
      await release()
      // #454: this request will not issue, so what it did not confirm stays a draft nobody will. A transfer it
      // did confirm is a real movement and stays (`discardPendingTransfers` touches drafts only).
      await discardAsked()
      if (e instanceof PendingTransferError) return refuse(e.statusCode, { code: e.code, message: e.message })
      return refuse(400, { message: `Transfer confirmation failed: ${e.message}` })
    }
  }

  // FR-29.8: the stock, the issued number and the status in one transaction (`issueDocument`). What an earlier
  // attempt left is finished there: a completed movement of this document stands, a draft one is booked afresh,
  // never skipped (FR-29.9). The number is drawn last, so an issue that fails draws none (FR-29.11).
  const updateData: any = { 'issue.completedAt': new Date() }
  // ⚠ FR-23: what will print keeps its claim past this write, because nothing else stands on the document
  // until its receipt does: an edit in that gap rang one amount and booked another. The counter's `print` lets
  // go of it. What prints nothing, an invoice for a cash sale and a quote among them, is done here.
  if (counter) updateData['issue.tender'] = { method: counter.tender.method, amount: counter.tender.amount }
  else updateData['issue.leaseUntil'] = null
  if (pendingTransferIds?.length) updateData.pendingTransferIds = pendingTransferIds
  if (forCashSale) Object.assign(updateData, await issueFieldsFor(orgId, invoice))
  // FR-23: in the issue's own write, so whatever happens to its receipt the fact stands.
  if (counter?.tender.method === 'cash_on_delivery') updateData.deliveryReceiptOwed = true
  let issued: Awaited<ReturnType<typeof issueDocument>>
  try {
    issued = await issueDocument({
      orgId, invoice, userId: user.id, status: newStatus,
      heldBy: { 'issue.leaseUntil': claimed.issue?.leaseUntil },
      fields: updateData,
      // FR-29.15: what the `invoice.posted` below owes, stored with the issue.
      owesPosting: !forCashSale && !isQuoteType(invoice.type),
    })
  } catch (e: any) {
    await release()
    if (e instanceof IssueStockError) {
      const [code, answer] = stockFailureAnswer(e, 400)!
      return refuse(code, answer)
    }
    // The lease lapsed under a long issue and another request took the draft: it is theirs to finish.
    if (e instanceof IssueLostError) return refuse(409, await holderOf(orgId, id, () => ({ ...DOCUMENT_CHANGED })))
    throw e
  }
  const { invoice: updated, issuedNumber, draftNumber } = issued

  // ORD-linked documents: re-derive the order's reservation/receipt state
  // (dispatch consumes holds; incoming bills book receipts).
  await syncOrderForInvoice(orgId, updated || invoice, user.id)
  // A bill made from goods receipts, issued here rather than by `/receive` (FR-22 D-2).
  if (invoice.direction === 'incoming') await applyLinkedBillPrices(orgId, updated || invoice, user.id)

  createAuditEntry({ orgId, userId: user.id, action: 'send', module: 'invoicing', entityType: 'invoice', entityId: id, entityName: issuedNumber, changes: { draftNumber: { from: draftNumber, to: null }, invoiceNumber: { from: draftNumber, to: issuedNumber } } })
  if (overlap) auditOverlapAcknowledged(orgId, user.id, id, issuedNumber, overlap)
  if (noteOverlap) auditDispatchOverlapAcknowledged(orgId, user.id, id, issuedNumber, noteOverlap)

  // The sale's revenue belongs to its cash sale: an invoice for one posts no second entry.
  if (forCashSale) return { invoice: updated }
  // An issued quote — a proforma or an offer — is no sale (FR-22.22): no receivable, no revenue,
  // nothing paid. The invoice it is converted into posts when that invoice is issued.
  if (isQuoteType(invoice.type)) return { invoice: updated }

  // Emit for cross-module journal entry creation
  eventBus.emit('invoice.posted', {
    invoiceId: id,
    orgId,
    userId: user.id,
    direction: invoice.direction,
    total: invoice.total,
    contactId: invoice.contactId as string,
  })

  // FR-23 §2.4: where LGR prints, the receipt and its payment are the settlement. Not in
  // `syncCashSettlement`: the import conversion comes through there, and never prints.
  if (counter) return atCounter.print(counter)

  // A cash invoice is paid the moment it is issued — no separate "record payment" step. ⚠ Where LGR prints
  // nothing got here to settle but what an edit made cash since this request read it, with no receipt.
  const settlement = await syncCashSettlement(orgId, id, user.id, { settles: await ruleSettles(orgId, updated ?? invoice, true) })
  if (settlement.action !== 'none') return { invoice: await r.invoices.findOne({ id, orgId }) }

  return { invoice: updated }
}
