import { Invoice } from 'db/models'
import { getRepos } from 'services/context'
import { owesDeliveryReceipt } from 'services/biz/cash-register/payment-receipt.service'
import { PAYMENT_STORNO } from 'services/biz/cash-register/pos-union'
import { RegisterRefusal } from 'services/biz/cash-register/register.service'
import { rawOf } from 'services/biz/document/document-claims'
import { refuse } from 'services/biz/document/refused'
import type { IssueCounter } from 'services/biz/document/send-document.service'
import { outstandingOf } from 'services/biz/invoice-payment'
import { keyedReceipt, prepareIssueReceipt, printReceipt, receiptOutcome, settleKeyedReceipt, type PreparedReceipt } from './counter-receipt.js'
import { issueTender, prepareIssueRefund, refund, refundOutcome, refundedBy, type PreparedRefund } from './counter-refund.js'

/**
 * FR-32.21 (#797): the steps of `POST /invoices/:id/send` that reach the device, which
 * `services/biz/document#sendDocument` calls where the route did (FR-23: a document paid at the counter prints as it is
 * issued). Moved whole from the route.
 */

/**
 * FR-23: what the issue decided to take is no longer what the document owes or how it says it is paid. A
 * receipt printed from the document as it stands rang 36 for a customer who handed over 24.
 */
function tenderMoved(doc: any, tender: { method?: string; amount?: number }): boolean {
  return Math.abs(outstandingOf(doc) - (Number(tender.amount) || 0)) >= 0.005 || doc.paymentMethod !== tender.method
}

/** The document changed under its issue, so nothing prints. A person takes what it says now. */
function nothingPrinted(doc: any): { receiptError?: string; receiptCode?: string } {
  // Paid since: nothing is left to take, and nothing to say about it.
  if (outstandingOf(doc) <= 0) return {}
  return {
    receiptCode: 'issue_tender_moved',
    receiptError: doc.type === 'credit_note'
      ? 'This credit note changed while it was being issued, so its refund stopped, and what did not print did not go back. It stands issued: give that with Refund.'
      : doc.paymentMethod === 'cash_on_delivery'
        ? 'This document changed while it was being issued, so no receipt printed. It stands issued and unpaid: print its receipt on its page.'
        : 'This document changed while it was being issued, so no receipt printed and nothing was paid. It stands issued and unpaid: take the payment with Pay.',
  }
}

/**
 * The same of a refund at issue, part of which may have gone back: what the issue decided, less what its
 * stornos gave. ⚠ Between two stornos nothing holds the note, and on a retry nothing holds it at all. A
 * printed storno freezes its total, so only the method and money taken by hand can move by then, but a second
 * part in another method than the first is a refund nobody asked for.
 */
function refundMoved(note: any, stornos: any[]): boolean {
  const tender = note.issue?.tender
  return !!tender && tenderMoved(note, { method: tender.method, amount: (Number(tender.amount) || 0) - refundedBy(stornos) })
}

/**
 * A refusal that answers for the key: the client keeps or drops its key by it, so it is never turned
 * into a 200 with a `receiptError`, as a refusal of the receipt is once the document is issued.
 */
const answersForTheKey = (e: RegisterRefusal) => e.body.code === 'idempotency_in_progress' || e.body.code === 'idempotency_key_reused'

/** The counter of one `/send` request: its document, its session's user, and its key. */
export function counterAtIssue(orgId: string, id: string, user: any, key?: string, hash?: string): IssueCounter {
  const r = getRepos()

  /** The issued document, with what its receipt came to (FR-23). */
  const withReceipt = async (receipt: any) => ({ invoice: await r.invoices.findOne({ id, orgId }), ...receiptOutcome(receipt) })
  /** The same of a refund: its last storno says what became of it, and all of them are named. */
  const withStornos = async (stornos: any[]) => (stornos.length
    ? { ...await withReceipt(stornos.at(-1)), stornos: refundOutcome(stornos), refunded: refundedBy(stornos) }
    : { invoice: await r.invoices.findOne({ id, orgId }) })
  /** Refused once it was issued. What a refund's earlier parts did stands, and the refusal says so (`refund`). */
  const refusedAfterIssue = async (e: RegisterRefusal) => ({
    invoice: await r.invoices.findOne({ id, orgId }),
    receiptError: e.message,
    ...(e.body.stornos ? { refunded: e.body.refunded, stornos: e.body.stornos } : {}),
  })
  /** What an issue's refund answers. What printed stands, and it says when the rest stopped because the note moved. */
  const withIssuedRefund = async (stornos: any[]) => {
    const now = await rawOf(id, orgId)
    return { ...await withStornos(stornos), ...(refundMoved(now, stornos) ? nothingPrinted(now) : {}) }
  }
  /** Whether an issue's refund may print its next part. */
  const stillAsIssued = async (stornos: any[]) => !refundMoved(await rawOf(id, orgId), stornos)
  /**
   * FR-23 §2.4: the receipt, now that the document has the number it names. Issued is issued: a
   * failure here leaves it issued and unpaid, says why, and the Pay button takes the money.
   *
   * ⚠ The last word before the device. A lapsed lease or a retry holds no claim, and an edit of the
   * method holds none at all, so what the issue decided is checked against the document as it stands:
   * moved, nothing prints. The issue's claim goes here, whichever way this ended; a crash lets it lapse.
   */
  const printAtIssue = async (prepared: PreparedReceipt | PreparedRefund) => {
    try {
      const doc: any = await Invoice.findOne({ _id: id, orgId }).lean().exec()
      if (tenderMoved(doc, doc.issue?.tender ?? prepared.tender)) {
        return { invoice: await r.invoices.findOne({ id, orgId }), ...nothingPrinted(doc) }
      }
      // ⚠ And a lapsed lease let the page's press through: what `prepared` read of the receipts is from before
      // the claim, and a second delivery receipt books the sale on the device twice.
      if (prepared.tender.method === 'cash_on_delivery' && !(await owesDeliveryReceipt(orgId, doc))) {
        return { invoice: await r.invoices.findOne({ id, orgId }) }
      }
      const keyed = key ? { key, hash: hash! } : undefined
      // R2: a credit note gives back what the issue decided, on as many stornos as it draws on.
      if (doc.type === 'credit_note') return await withIssuedRefund(await refund(orgId, user, doc, prepared.tender, prepared as PreparedRefund, keyed, stillAsIssued))
      return await withReceipt(await printReceipt(orgId, prepared as PreparedReceipt, doc, keyed))
    } catch (e: any) {
      if (!(e instanceof RegisterRefusal)) throw e
      if (answersForTheKey(e)) return refuse(e.statusCode, e.body)
      return await refusedAfterIssue(e)
    } finally {
      await Invoice.updateOne({ _id: id, orgId }, { $set: { 'issue.leaseUntil': null } }).exec()
        .catch(() => /* a failure here must not answer for a receipt that printed: the lease lapses by itself */ undefined)
    }
  }
  /**
   * A retry of an issue that went through: its receipt comes back, printed once, and one the first
   * attempt never finished, or never started, is finished here. ⚠ For what the issue decided, not for
   * what the document says by now: the customer handed over what it said then.
   */
  const replayIssued = async () => {
    try {
      const doc: any = await Invoice.findOne({ _id: id, orgId }).lean().exec()
      const receipt = key ? await keyedReceipt(orgId, key) : null
      // A refund goes on from whichever of its stornos the first attempt reached, for what the issue
      // decided, whatever has gone back since.
      if (receipt?.type === PAYMENT_STORNO) return await withIssuedRefund(await refund(orgId, user, doc, { ...issueTender(doc), amount: doc.issue?.tender?.amount ?? doc.total }, null, { key: key!, hash: hash! }, stillAsIssued))
      if (receipt) return await withReceipt(await settleKeyedReceipt(orgId, user, receipt, hash!))
      if (doc.issue?.tender && tenderMoved(doc, doc.issue.tender)) {
        return { invoice: await r.invoices.findOne({ id, orgId }), ...nothingPrinted(doc) }
      }
      const prepared = doc.type === 'credit_note' ? await prepareIssueRefund(orgId, user, doc) : await prepareIssueReceipt(orgId, user, doc)
      if (prepared) return await printAtIssue(prepared)
    } catch (e: any) {
      if (!(e instanceof RegisterRefusal)) throw e
      if (answersForTheKey(e)) return refuse(e.statusCode, e.body)
      return refusedAfterIssue(e)
    }
    return { invoice: await r.invoices.findOne({ id, orgId }) }
  }

  return {
    // R2: a credit note's refund is decided from the note as stored; anything else's receipt from the document as read.
    prepare: async invoice => (invoice.type === 'credit_note' ? prepareIssueRefund(orgId, user, await rawOf(id, orgId)) : prepareIssueReceipt(orgId, user, invoice)),
    print: prepared => printAtIssue(prepared as PreparedReceipt | PreparedRefund),
    replayIssued,
  }
}
