import { inDoubtRefusal } from 'services/biz/cash-register/payment-receipt.service'
import { documentOf } from 'services/biz/document/document-claims'
import type { Status } from 'services/biz/document/refused'
import { receiptOutcome } from './counter-receipt.js'
import { refundOutcome, refundedBy } from './counter-refund.js'

/**
 * FR-23: what `POST /invoices/:id/payments` answers when its money went through the counter. Moved whole from the
 * route (FR-32.21, #797), which passes its `status`.
 */

/** What a payment that printed answers, and one whose receipt failed: nothing was recorded. */
export async function paymentReceiptAnswer(status: Status, orgId: string, id: string, receipt: any) {
  if (receipt.register?.fiscal?.inDoubt) return status(409, inDoubtRefusal(receipt))
  if (receipt.register?.fiscal?.state === 'failed') {
    return status(503, {
      code: 'fiscal_error',
      receiptId: String(receipt._id),
      message: `The receipt was not printed, so no payment was recorded: ${receipt.register.receiptError}`,
    })
  }
  return { invoice: await documentOf(orgId, id), ...receiptOutcome(receipt) }
}

/**
 * R2: what a refund answers. All it printed stands; a part that did not stops the rest, and the
 * answer says how much went back. Nothing printed answers as a receipt that did not.
 */
export async function paymentRefundAnswer(status: Status, orgId: string, id: string, stornos: any[]) {
  const last = stornos.at(-1)
  if (!last) return { invoice: await documentOf(orgId, id) }
  const refunded = refundedBy(stornos)
  if (last.register?.fiscal?.inDoubt) return status(409, { ...inDoubtRefusal(last), refunded })
  if (last.register?.fiscal?.state === 'failed') {
    return status(503, {
      code: 'fiscal_error',
      receiptId: String(last._id),
      refunded,
      message: `The storno was not printed, so this part of the refund was not recorded: ${last.register.receiptError}`,
    })
  }
  return { invoice: await documentOf(orgId, id), ...receiptOutcome(last), stornos: refundOutcome(stornos) }
}
