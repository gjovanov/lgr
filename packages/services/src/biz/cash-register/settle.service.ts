/**
 * FR-23 — the settle door: a person looked at the device, and says whether a document nothing could
 * prove printed. One door and one set of rights (`STORNO_ROLES`) for everything held in doubt:
 * `POST /cash-register/documents/:id/settle`.
 *
 *   - **A payment's receipt.** Printed: its session counts it and its payment is recorded. Not printed:
 *     it is voided with its number and УНП, and its amount goes back to the invoice.
 *   - **A storno.** Printed: the rest of the storno runs, with no device: the refund, the stock. Not
 *     printed: it is voided with its number and УНП, and its sale is given back.
 *
 * ⚠ What they said is durable from the claim on, and the claim leaves a lease: a document is found by
 * its lapsing until `completedAt`. A settle that stops before the money is booked is finished by the
 * next touch, or by its session's close, with no device. Unsetting the lease left a receipt nothing
 * could find, with its hold on the invoice and its session unable to close.
 *
 * ⚠ Nothing is final while the device holds a receipt open, and a person cannot see that from its
 * journal. The next document clears it: voided if it took no money, and finished in cash if it did,
 * which prints it. Settled "not printed" first, that is a fiscal receipt nobody booked, and the next
 * press prints a second. So where the device can be asked it is, in its turn, and refused until it is
 * cleared (`RECEIPT_OPEN_ON_DEVICE`). A device that is not here, or cannot say, leaves it to the person.
 *
 * R2's `payment_storno` joins `FINISHES`, and needs nothing else here.
 */
import { Invoice } from 'db/models'
import { recordAuditEntry } from '../audit-log.service.js'
import { LEASE_MS, takeLease } from '../hot-path-key.js'
import { runReceiptSteps } from './payment-receipt.service.js'
import { PAYMENT_RECEIPT } from './pos-union.js'
import type { RegisterPrinter } from './printer.js'
import { RegisterRefusal, runStornoSteps, type RegisterContext } from './register.service.js'

const oid = (v: unknown) => new Invoice.base.Types.ObjectId(String(v))

/** What finishes each kind of document once a person has said, with no device. */
const FINISHES: Record<string, (c: RegisterContext, id: string) => Promise<any>> = {
  [PAYMENT_RECEIPT]: (c, id) => runReceiptSteps(c, id),
  cash_storno: runStornoSteps,
}

/** The types the door takes. */
export const SETTLEABLE_TYPES = Object.keys(FINISHES)

/** The device holds a receipt open: what it does next decides what is true. */
export const RECEIPT_OPEN_ON_DEVICE = {
  code: 'receipt_open_on_device',
  message: 'A receipt is still open on the fiscal device, so nothing is final yet. Print an X report on the device page, which clears it, then look at the device again: whatever printed then, printed.',
} as const

/** Whose words these are, in the words the message has to use. */
const NAMES: Record<string, string> = { [PAYMENT_RECEIPT]: 'receipt', cash_storno: 'storno' }

/**
 * What a person says about a document in doubt. Answers what it became, or null when it is not in
 * doubt. What they said, and who said it, stays on the document and in the audit trail.
 */
export async function settleInDoubt(c: RegisterContext, id: string, printed: boolean, device?: RegisterPrinter | null): Promise<any | null> {
  const now = new Date()
  const doc: any = await Invoice.findOne({ _id: oid(id), orgId: oid(c.orgId), type: { $in: SETTLEABLE_TYPES } }, { type: 1, 'register.fiscal.inDoubt': 1 }).lean().exec()
  if (!doc) return null
  if (device && doc.register?.fiscal?.inDoubt) {
    const open = await device.operation(async () => device.receiptOpen?.()).catch(() => undefined)
    if (open === true) throw new RegisterRefusal(409, { ...RECEIPT_OPEN_ON_DEVICE })
  }
  const receiptError = `A person who checked the device settled this ${NAMES[doc.type]} as not printed.`
  const claimed: any = await Invoice.findOneAndUpdate(
    { _id: doc._id, orgId: oid(c.orgId), 'register.fiscal.inDoubt': true, completedAt: { $exists: false }, status: { $ne: 'voided' } },
    {
      $set: {
        'register.settled': { printed, by: oid(c.user.id), at: now },
        leaseUntil: new Date(now.getTime() + LEASE_MS),
        ...(printed
          ? { 'register.fiscal.state': 'printed', 'register.fiscal.printedAt': now, 'register.printedAt': now }
          : { 'register.fiscal.state': 'failed', 'register.fiscal.error': receiptError, 'register.receiptError': receiptError }),
      },
      $unset: { 'register.fiscal.inDoubt': 1, ...(printed ? { 'register.receiptError': 1 } : {}) },
    },
    { new: true },
  ).lean().exec()
  if (!claimed) return resumeSettled(c, doc, printed)
  await recordAuditEntry({
    orgId: c.orgId, userId: c.user.id, operatorCode: c.user.operatorCode, action: 'settle_receipt', module: c.audit.module,
    entityType: c.audit.entityType, entityId: String(claimed._id), entityName: claimed.invoiceNumber, unpNumber: claimed.register?.unp,
    changes: [{ field: 'printed', oldValue: 'unknown', newValue: printed ? 'yes' : 'no' }],
  })
  return FINISHES[claimed.type](c, String(claimed._id))
}

/**
 * A second `/settle` of one that stopped halfway. What was said first stands: the same answer finishes
 * it once its lease has lapsed, and the opposite is refused. Null when there is nothing to finish, or
 * the first still holds it.
 */
async function resumeSettled(c: RegisterContext, doc: any, printed: boolean): Promise<any | null> {
  const stopped: any = await Invoice.findOne({
    _id: doc._id, orgId: oid(c.orgId), 'register.settled': { $exists: true }, completedAt: { $exists: false },
  }).lean().exec()
  if (!stopped) return null
  if (stopped.register.settled.printed !== printed) {
    throw new RegisterRefusal(409, {
      code: 'receipt_already_settled',
      message: `This ${NAMES[stopped.type]} was already settled as ${stopped.register.settled.printed ? 'printed' : 'not printed'}, and that stands.`,
    })
  }
  if (!(await takeLease(Invoice, c.orgId, stopped._id))) return null
  return FINISHES[stopped.type](c, String(stopped._id))
}
