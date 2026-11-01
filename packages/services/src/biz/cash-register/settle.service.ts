/**
 * FR-23 — the settle door: a person looked at the device, and says whether a document nothing could
 * prove printed. One door and one set of rights (`STORNO_ROLES`) for everything held in doubt:
 * `POST /cash-register/documents/:id/settle`.
 *
 *   - **A payment's receipt.** Printed: its session counts it and its payment is recorded. Not printed:
 *     it is voided with its number and УНП, and its amount goes back to the invoice.
 *   - **A storno.** Printed: the rest of the storno runs, with no device: the refund, the stock. Not
 *     printed: it is voided with its number and УНП, and its sale is given back.
 *   - **A till sale** (`saleInDoubt`). Its money stands either way, so this only says what its storno
 *     does. Printed needs the number off the slip, because a storno cites it and every driver refuses one
 *     with no digits to cite. Not printed makes it `failed`, whose storno prints nothing, which is true.
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
import { AuditLog, Invoice } from 'db/models'
import { recordAuditEntry } from '../audit-log.service.js'
import { LEASE_MS, takeLease } from '../hot-path-key.js'
import { saleInDoubt, saleInDoubtFilter } from './in-doubt.js'
import { runReceiptSteps } from './payment-receipt.service.js'
import { PAYMENT_RECEIPT } from './pos-union.js'
import type { RegisterPrinter } from './printer.js'
import { RegisterRefusal, runSaleSteps, runStornoSteps, type RegisterContext } from './register.service.js'

const oid = (v: unknown) => new Invoice.base.Types.ObjectId(String(v))

/** What finishes each kind of document once a person has said, with no device. */
const FINISHES: Record<string, (c: RegisterContext, id: string) => Promise<any>> = {
  [PAYMENT_RECEIPT]: (c, id) => runReceiptSteps(c, id),
  cash_storno: runStornoSteps,
  // The till's rule: its own check ran before the print, and after it the dispatch must not fail.
  cash_sale: (c, id) => runSaleSteps({ ...c, allowNegative: true }, id),
}

/** The types the door takes. */
export const SETTLEABLE_TYPES = Object.keys(FINISHES)

/** The device holds a receipt open: what it does next decides what is true. */
export const RECEIPT_OPEN_ON_DEVICE = {
  code: 'receipt_open_on_device',
  message: 'A receipt is still open on the fiscal device, so nothing is final yet. Print an X report on the device page, which clears it, then look at the device again: whatever printed then, printed.',
} as const

/** Whose words these are, in the words the message has to use. */
const NAMES: Record<string, string> = { [PAYMENT_RECEIPT]: 'receipt', cash_storno: 'storno', cash_sale: 'sale' }

/** What a person says about a document in doubt. `receiptNumber`: off the slip, for a sale that printed. */
export interface SettleAnswer {
  printed: boolean
  receiptNumber?: string
}

/**
 * The number a storno of this sale will cite, as the person typed it. Digits, or the driver refuses the
 * storno; and not one this session's device already gave another document, which is a slip misread. ⚠ Only
 * in its session: a device whose fiscal memory was replaced counts from one again under the same
 * number, and a refusal here would leave a real sale nothing could settle.
 */
async function saleReceiptNumber(doc: any, typed: string | undefined): Promise<string> {
  const number = String(typed ?? '').trim()
  if (!/^\d{1,10}$/.test(number)) {
    throw new RegisterRefusal(422, {
      code: 'receipt_number_required',
      message: 'A sale that printed needs its receipt number off the slip, in digits: its storno cites it.',
    })
  }
  const taken: any = await Invoice.findOne({
    orgId: doc.orgId, _id: { $ne: doc._id }, 'register.sessionId': doc.register?.sessionId, 'register.fiscalDeviceNumber': doc.register?.fiscalDeviceNumber,
    'register.fiscalReceiptNumber': { $in: [number, number.padStart(7, '0'), String(Number(number))] },
  }, { invoiceNumber: 1 }).lean().exec()
  if (taken) {
    throw new RegisterRefusal(422, {
      code: 'receipt_number_taken',
      document: taken.invoiceNumber,
      message: `Receipt number ${number} on this device is ${taken.invoiceNumber}'s. Check the slip.`,
    })
  }
  return number
}

/** The trail of what a person said: on the settle itself, and on what finishes one that stopped. */
function auditSettlement(c: RegisterContext, doc: any): Promise<boolean> {
  const { settled } = doc.register
  return recordAuditEntry({
    // Whoever said it, which is not whoever finishes it.
    orgId: c.orgId, userId: String(settled.by), operatorCode: String(settled.by) === c.user.id ? c.user.operatorCode : undefined,
    action: 'settle_receipt', module: c.audit.module, entityType: c.audit.entityType,
    entityId: String(doc._id), entityName: doc.invoiceNumber, unpNumber: doc.register?.unp,
    changes: [
      { field: 'printed', oldValue: 'unknown', newValue: settled.printed ? 'yes' : 'no' },
      ...(settled.receiptNumber ? [{ field: 'receiptNumber', oldValue: null, newValue: settled.receiptNumber }] : []),
    ],
  })
}

/**
 * A settle stopped between its claim and its audit row: whatever finishes it writes the row. What was
 * said must be on the trail however it ended. One a crash stopped after the row has it already.
 */
export async function auditStoppedSettlement(c: RegisterContext, doc: any): Promise<void> {
  if (!doc.register?.settled) return
  const written = await AuditLog.exists({ orgId: oid(c.orgId), entityId: doc._id, action: 'settle_receipt' }).exec()
  if (!written) await auditSettlement(c, doc)
}

/**
 * What a person says about a document in doubt. Answers what it became, or null when it is not in
 * doubt. What they said, and who said it, stays on the document and in the audit trail.
 */
export async function settleInDoubt(c: RegisterContext, id: string, answer: SettleAnswer, device?: RegisterPrinter | null): Promise<any | null> {
  const now = new Date()
  const { printed } = answer
  const doc: any = await Invoice.findOne({ _id: oid(id), orgId: oid(c.orgId), type: { $in: SETTLEABLE_TYPES } }).lean().exec()
  if (!doc) return null
  const isSale = doc.type === 'cash_sale'
  const inDoubt = isSale ? saleInDoubt(doc, now.getTime()) : !!doc.register?.fiscal?.inDoubt
  if (device && inDoubt) {
    const open = await device.operation(async () => device.receiptOpen?.()).catch(() => undefined)
    if (open === true) throw new RegisterRefusal(409, { ...RECEIPT_OPEN_ON_DEVICE })
  }
  const receiptNumber = isSale && printed && inDoubt ? await saleReceiptNumber(doc, answer.receiptNumber) : undefined
  const receiptError = `A person who checked the device settled this ${NAMES[doc.type]} as not printed.`
  // ⚠ A sale read as not in doubt can be by now: its number was never asked for, so it is not claimed.
  const claimed: any = isSale && printed && !receiptNumber ? null : await Invoice.findOneAndUpdate(
    {
      _id: doc._id, orgId: oid(c.orgId), status: { $ne: 'voided' },
      ...(isSale ? saleInDoubtFilter(now) : { 'register.fiscal.inDoubt': true, completedAt: { $exists: false } }),
    },
    {
      $set: {
        'register.settled': { printed, by: oid(c.user.id), at: now, ...(receiptNumber ? { receiptNumber } : {}) },
        // A finished sale has nothing left to find it by, and nothing left to do.
        ...(doc.completedAt ? {} : { leaseUntil: new Date(now.getTime() + LEASE_MS) }),
        ...(printed
          // ⚠ A sale printed when it tried to, which is what a device's last number is read against.
          ? { 'register.fiscal.state': 'printed', 'register.fiscal.printedAt': now, 'register.printedAt': (isSale && doc.register?.fiscal?.attemptedAt) || now }
          : { 'register.fiscal.state': 'failed', 'register.fiscal.error': receiptError, 'register.receiptError': receiptError }),
        ...(receiptNumber ? { 'register.fiscal.receiptNo': receiptNumber, 'register.fiscalReceiptNumber': receiptNumber } : {}),
      },
      $unset: { 'register.fiscal.inDoubt': 1, ...(printed ? { 'register.receiptError': 1 } : {}) },
    },
    { new: true },
  ).lean().exec()
  if (!claimed) return resumeSettled(c, doc, printed)
  await auditSettlement(c, claimed)
  if (claimed.completedAt) return claimed
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
  await auditStoppedSettlement(c, stopped)
  return FINISHES[stopped.type](c, String(stopped._id))
}
