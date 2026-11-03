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
 *     A number a person typed is corrected at this door too, until something cites it.
 *
 * ⚠ What they said is durable from the claim on, and the claim leaves a lease: a document is found by
 * its lapsing until `completedAt`. A settle that stops before the money is booked is finished by the
 * next touch, or by its session's close, with no device. Unsetting the lease left a receipt nothing
 * could find, with its hold on the invoice and its session unable to close.
 *
 * ⚠ A person's word is taken only for what only a person can know: what the device can still change, or
 * can answer, it is asked first. Nothing is final while it holds a receipt open, and a person cannot see
 * that from its journal. The next document clears it: voided if it took no money, and finished in cash if
 * it did, which prints it. Settled "not printed" first, that is a fiscal receipt nobody booked, and the
 * next press prints a second. So for a fiscal document the door goes to the device the document printed
 * on, by its number (`settleDevice`, in the till):
 *  - **Active and here:** asked, in its turn. Open: `RECEIPT_OPEN_ON_DEVICE`. Busy: 409 `device_busy`. A read
 *    that failed is no answer: `RECEIPT_DEVICE_AWAY`. Only a driver with no way to ask (no `isReceiptOpen`:
 *    Tremol, Datecs) leaves it to the person.
 *  - **Active and not here:** `RECEIPT_DEVICE_AWAY`, both answers, nothing written. A half-printed slip with
 *    no money on the device reads as printed, and the next clear voids it, so "printed" waits too.
 *  - **No row, or deactivated:** the person's word stands. That is the way out for a device gone for good,
 *    so nothing is stuck.
 * A text document is none of this: the device holds no money on one.
 *
 * **A refund's storno** (R2). Printed: its session gives the money back and the refund is recorded on
 * its credit note. Not printed: it is voided with its number and УНП, and its hold and its claim on the
 * receipt it cites go back. It runs a receipt's steps.
 *
 * ⚠ A storno cites a number, so a receipt that printed can bring one too, off the slip: a credit note's
 * refund cites it. With none it stands as printed, and that refund goes by bank, until one is brought: a fiscal
 * receipt that stands printed with no number, settled so or with its 71h read failed, may be given one later at
 * this door. One it brought is held to all a sale's is, and corrected the same way, until a refund's storno
 * cites it. It turns a bank refund into a storno on the device, which is what the law wants. A sale settled
 * printed already needs a number, so this is a receipt's only.
 */
import { AuditLog, Invoice } from 'db/models'
import { recordAuditEntry } from '../audit-log.service.js'
import { LEASE_MS, takeLease } from '../hot-path-key.js'
import { saleInDoubt, saleInDoubtFilter, saleProgress } from './in-doubt.js'
import { runReceiptSteps } from './payment-receipt.service.js'
import { PAYMENT_RECEIPT, PAYMENT_STORNO } from './pos-union.js'
import type { RegisterPrinter } from './printer.js'
import { RegisterRefusal, finishSale, runStornoSteps, type RegisterContext } from './register.service.js'

const oid = (v: unknown) => new Invoice.base.Types.ObjectId(String(v))

/** What finishes each kind of document once a person has said, with no device. */
const FINISHES: Record<string, (c: RegisterContext, id: string) => Promise<any>> = {
  [PAYMENT_RECEIPT]: (c, id) => runReceiptSteps(c, id),
  [PAYMENT_STORNO]: (c, id) => runReceiptSteps(c, id),
  cash_storno: runStornoSteps,
  cash_sale: finishSale,
}

/** The types the door takes. */
export const SETTLEABLE_TYPES = Object.keys(FINISHES)

/** The device holds a receipt open: what it does next decides what is true. */
export const RECEIPT_OPEN_ON_DEVICE = {
  code: 'receipt_open_on_device',
  message: 'A receipt is still open on the fiscal device, so nothing is final yet. Print an X report on the device page, which clears it, then look at the device again: whatever printed then, printed.',
} as const

/** The device holds what decides this and is not there to say: connect it, or say it is gone for good. */
export const RECEIPT_DEVICE_AWAY = {
  code: 'receipt_device_away',
  message: 'The fiscal device this document printed on is not answering, and what it holds decides this. Nothing was changed. Connect it, then look at it again. A device gone for good is deactivated on its page, after which your word stands.',
} as const

/** Another document holds the device right now. It was not asked. */
export const SETTLE_DEVICE_BUSY = {
  code: 'device_busy',
  message: 'The fiscal device is busy with another document, so it could not be asked. Nothing was changed. Try again in a moment.',
} as const

/** Somebody is finishing this sale right now. A person can say once that is done. */
const SALE_BEING_FINISHED = {
  code: 'sale_in_progress',
  message: 'This sale is still being rung up. Nothing was changed. Wait for it to finish, then try again.',
} as const

/**
 * How long the door waits for the device's turn, and for its answer. ⚠ Well under the 30 s a request is cut
 * at (`idleTimeout`): someone is looking at this page. A Z can hold the device for minutes, and they hear
 * busy and press again. A device switched off with its tab still open takes a driver 90 s to give up on, and
 * an answer past the cut reaches nobody, so the person would never read what to do about it.
 */
const ASK_WAIT_MS = 10_000
const ASK_ANSWER_MS = 20_000

/** Whose words these are, in the words the message has to use. */
const NAMES: Record<string, string> = { [PAYMENT_RECEIPT]: 'receipt', [PAYMENT_STORNO]: 'storno', cash_storno: 'storno', cash_sale: 'sale' }

/**
 * What a person says about a document in doubt. `receiptNumber`: off the slip, for a sale that printed, and for a
 * receipt when they have it. `confirmNumber`: the slip says this number, whatever it collides with (`typedReceiptNumber`).
 */
export interface SettleAnswer {
  printed: boolean
  receiptNumber?: string
  confirmNumber?: boolean
}

/** A number as typed, and, when a person confirmed it, what it collided with: what the trail has to say. */
interface TypedNumber {
  number: string
  confirmedOver?: string
}

/**
 * How far either side of a document another one's number counts as taken: a device's numbers repeat only
 * when its fiscal memory is replaced, and it then counts from one again under the same device number. A
 * refusal against that older series would leave a real sale nothing could settle.
 */
const TAKEN_WITHIN_MS = 31 * 86_400_000

/**
 * The number a storno of this document will cite, as the person typed it off the slip. A misread is a
 * legal citation on a fiscal storno, and a device that refuses it refuses every storno of that sale.
 *  - Digits, or the driver refuses the storno.
 *  - Not above the device's last number, read in the turn the open flag was read in. Nothing a device has
 *    not reached is on a slip. A device that cannot say skips this, and so does one whose counter has gone
 *    back since this document read it: its fiscal memory was replaced, and it speaks for another series.
 *  - Not one the same device gave another document around then: another session's too, because two on one
 *    device is normal. As a number, because a device pads it and a person does not.
 *
 * ⚠ No lower bound. `getLastReceiptNumber` and the stored number are both 71h, but nobody has held a real
 * slip against 71h, and if the slip's series is the fiscal one it runs below the device's document counter.
 * A lower bound there would refuse a real sale with no way out.
 *
 * ⚠ So the last two are questions, never a wall: both rest on the same unproved series. If the slip's series is
 * the fiscal one, its numbers are ones the document counter passed days ago, usually under another receipt,
 * and a real slip would read as taken with nothing to lift it but a false citation. The answer names what it
 * collided with, and the same request with `confirmNumber`, on the door's own rights, goes through and is on
 * the trail. Digits are never confirmable: the driver refuses the storno. Nor is a number a storno cites.
 *
 * It asks nothing of the document's type, so a receipt's number off its slip is read the same way (R2).
 */
async function typedReceiptNumber(doc: any, typed: string | undefined, lastOnDevice: number | undefined, confirmed: boolean | undefined): Promise<TypedNumber> {
  const number = String(typed ?? '').trim()
  if (!/^\d{1,10}$/.test(number)) {
    throw new RegisterRefusal(422, {
      code: 'receipt_number_required',
      message: doc.type === 'cash_sale'
        ? 'A sale that printed needs its receipt number off the slip, in digits: its storno cites it.'
        : 'A receipt number is the digits off the slip. Leave it out if you do not have it: the receipt stands as printed, and a refund of it goes by bank.',
    })
  }
  const counterBefore = doc.register?.fiscal?.counterBefore
  const sameSeries = !(typeof counterBefore === 'number' && lastOnDevice !== undefined && counterBefore > lastOnDevice)
  const collisions: string[] = []
  if (lastOnDevice !== undefined && sameSeries && Number(number) > lastOnDevice) {
    if (!confirmed) {
      throw new RegisterRefusal(422, {
        code: 'receipt_number_off_device',
        last: lastOnDevice,
        message: `Receipt number ${number} is above the last number this device has given (${lastOnDevice}). Check the slip. If it says this number, send it again with confirmNumber.`,
      })
    }
    collisions.push(`above the device's last number, ${lastOnDevice}`)
  }
  const deviceNumber = doc.register?.fiscalDeviceNumber
  const answer = (): TypedNumber => ({ number, ...(collisions.length ? { confirmedOver: collisions.join('; ') } : {}) })
  if (!deviceNumber) return answer()
  const around = new Date(doc.createdAt ?? Date.now()).getTime()
  const taken: any = await Invoice.findOne({
    orgId: doc.orgId, _id: { $ne: doc._id }, 'register.fiscalDeviceNumber': deviceNumber,
    // As a number. The field holds digits as a string, and which padding a real slip prints is not known.
    'register.fiscalReceiptNumber': { $regex: `^0*${Number(number)}$` },
    createdAt: { $gte: new Date(around - TAKEN_WITHIN_MS), $lte: new Date(around + TAKEN_WITHIN_MS) },
  }, { invoiceNumber: 1 }).lean().exec()
  if (taken) {
    if (!confirmed) {
      throw new RegisterRefusal(422, {
        code: 'receipt_number_taken',
        document: taken.invoiceNumber,
        message: `Receipt number ${number} on this device is ${taken.invoiceNumber}'s. Check the slip. If it says this number, send it again with confirmNumber.`,
      })
    }
    collisions.push(`${taken.invoiceNumber}'s number on this device`)
  }
  return answer()
}

/** A storno cites this number, or an invoice for the sale carries it, so it is a legal citation now. */
const RECEIPT_NUMBER_CITED = {
  code: 'receipt_number_cited',
  message: 'A storno or an invoice cites this receipt number, so it stands.',
} as const

/**
 * Whether a storno stands on this document's number: its claim, of either kind. A refund's storno holds its
 * claim from before it prints until it is voided (`takeBudget`, `giveBackBudget`), on a sale as on a receipt.
 */
const stornoCites = (reg: any) => reg?.stornoState === 'full' || reg?.stornoState === 'partial' || !!reg?.refundClaims?.length

/**
 * A number typed off a slip, corrected by the door and the rights that took it, under the same checks. All
 * three places it is stored are rewritten and the trail says old to new. Once a storno cites it, it stands:
 * what a storno's claim writes is in the correction's filter (`stornoCites`), so of a correction and a claim
 * one gives way. A storno voided since cites nothing: it gave its claim back, and a refused number is why one
 * is corrected. An invoice for a sale carries the number too (`cashSaleRef.receiptNumber`), printed, so it
 * counts as citing. A receipt's invoice does not: it reads the receipt's number as it prints.
 *
 * A receipt with none yet is given one the same way. What a person said goes on the document as a settle's does,
 * and it printed when it tried to, the moment its storno cites.
 */
async function correctReceiptNumber(c: RegisterContext, doc: any, typed: string | undefined, lastOnDevice: number | undefined, confirmed: boolean | undefined): Promise<any | null> {
  const old: string | undefined = doc.register.settled?.receiptNumber
  const cited = stornoCites(doc.register)
    || await Invoice.exists({ orgId: doc.orgId, 'cashSaleRef.cashSaleId': doc._id, status: { $nin: ['voided', 'cancelled'] } }).exec()
  if (cited) throw new RegisterRefusal(409, { ...RECEIPT_NUMBER_CITED })
  const { number, confirmedOver } = await typedReceiptNumber(doc, typed, lastOnDevice, confirmed)
  if (number === old) return doc
  const corrected: any = await Invoice.findOneAndUpdate(
    {
      _id: doc._id, orgId: doc.orgId, 'register.stornoState': { $nin: ['full', 'partial'] }, 'register.refundClaims.0': { $exists: false },
      ...(old ? { 'register.settled.receiptNumber': old } : { 'register.fiscalReceiptNumber': null }),
    },
    {
      $set: {
        'register.settled.receiptNumber': number, 'register.fiscal.receiptNo': number, 'register.fiscalReceiptNumber': number,
        ...(doc.register.settled ? {} : { 'register.settled.printed': true, 'register.settled.by': oid(c.user.id), 'register.settled.at': new Date() }),
        ...(!old && doc.register.fiscal?.attemptedAt ? { 'register.printedAt': doc.register.fiscal.attemptedAt } : {}),
        ...(confirmedOver ? { 'register.settled.confirmedOver': confirmedOver } : {}),
      },
      ...(confirmedOver ? {} : { $unset: { 'register.settled.confirmedOver': 1 } }),
    },
    { new: true },
  ).lean().exec()
  if (!corrected) {
    const now: any = await Invoice.findOne({ _id: doc._id, orgId: doc.orgId }, { 'register.stornoState': 1, 'register.refundClaims': 1 }).lean().exec()
    if (stornoCites(now?.register)) throw new RegisterRefusal(409, { ...RECEIPT_NUMBER_CITED })
    return null
  }
  await recordAuditEntry({
    orgId: c.orgId, userId: c.user.id, operatorCode: c.user.operatorCode,
    action: 'correct_receipt_number', module: c.audit.module, entityType: c.audit.entityType,
    entityId: String(doc._id), entityName: doc.invoiceNumber, unpNumber: doc.register?.unp,
    changes: [
      { field: 'receiptNumber', oldValue: old ?? null, newValue: number },
      ...(confirmedOver ? [{ field: 'confirmedOver', oldValue: null, newValue: confirmedOver }] : []),
    ],
  })
  return corrected
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
      ...(settled.confirmedOver ? [{ field: 'confirmedOver', oldValue: null, newValue: settled.confirmedOver }] : []),
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
 * What the door asks of a device that is here, in its turn: whether anything it holds can still change the
 * answer, which refuses. Answers its last number when `wantsLast`, read in the same turn; undefined when it
 * cannot say.
 */
async function askDevice(device: RegisterPrinter, wantsLast: boolean): Promise<number | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const asked = device.operation(async () => {
    if ((await device.receiptOpen?.()) === true) throw new RegisterRefusal(409, { ...RECEIPT_OPEN_ON_DEVICE })
    return wantsLast ? device.lastReceiptNumber() : undefined
  }, { waitMs: ASK_WAIT_MS })
  // It may outlive the wait, and whatever it says then is nobody's to hear.
  asked.catch(() => undefined)
  try {
    return await Promise.race([
      asked,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('The device did not answer in time')), ASK_ANSWER_MS) }),
    ])
  } catch (e: any) {
    if (e instanceof RegisterRefusal) throw e
    // ⚠ Not left to the person. A driver that cannot say answers `undefined` above, and this one could
    // and did not: read as "cannot say", a dropped line was what let a real receipt be settled away.
    throw new RegisterRefusal(409, e?.code === 'device_busy' ? { ...SETTLE_DEVICE_BUSY } : { ...RECEIPT_DEVICE_AWAY })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * What a person says about a document in doubt. Answers what it became, or null when it is not in
 * doubt. What they said, and who said it, stays on the document and in the audit trail. `deviceOf` finds
 * the device that has to be asked first, and may refuse (`settleDevice`); null when the word stands.
 */
export async function settleInDoubt(c: RegisterContext, id: string, answer: SettleAnswer, deviceOf?: (doc: any) => Promise<RegisterPrinter | null>): Promise<any | null> {
  const now = new Date()
  const { printed } = answer
  const doc: any = await Invoice.findOne({ _id: oid(id), orgId: oid(c.orgId), type: { $in: SETTLEABLE_TYPES } }).lean().exec()
  if (!doc) return null
  const isSale = doc.type === 'cash_sale'
  const inDoubt = isSale ? saleInDoubt(doc, now.getTime()) : !!doc.register?.fiscal?.inDoubt
  // A sale must say. A fiscal receipt may: without it the refund of a credit note has nothing to cite.
  const fiscalReceipt = doc.type === PAYMENT_RECEIPT && doc.register?.fiscal?.mode !== 'text'
  // #454: a fiscal storno settled as printed may bring its number off the slip too. Without it SUPTO 18.4
  // lists the storno with a blank Fiscal Receipt #. It is the storno's own number: nothing cites it.
  const fiscalStorno = (doc.type === PAYMENT_STORNO || doc.type === 'cash_storno') && doc.register?.fiscal?.mode !== 'text'
  const brought = (fiscalReceipt || fiscalStorno) && !!String(answer.receiptNumber ?? '').trim()
  // A number a person typed, typed again, or a receipt's first: the one thing this door takes on a document no longer in doubt.
  const numberless = fiscalReceipt && doc.register?.fiscal?.state === 'printed' && !doc.register?.fiscalReceiptNumber
  const corrects = (isSale || fiscalReceipt) && printed && !inDoubt && (!!doc.register?.settled?.receiptNumber || numberless) && answer.receiptNumber !== undefined
  let lastOnDevice: number | undefined
  if (inDoubt || corrects) {
    const device = await deviceOf?.(doc)
    if (device) lastOnDevice = await askDevice(device, (isSale || brought) && printed)
  }
  if (corrects) {
    const corrected = await correctReceiptNumber(c, doc, answer.receiptNumber, lastOnDevice, answer.confirmNumber)
    // One whose settle stopped halfway is told the new number, and the same answer finishes it below.
    if (!corrected || corrected.completedAt) return corrected
    return resumeSettled(c, corrected, printed)
  }
  const typed = (isSale || brought) && printed && inDoubt ? await typedReceiptNumber(doc, answer.receiptNumber, lastOnDevice, answer.confirmNumber) : undefined
  const receiptNumber = typed?.number
  const receiptError = `A person who checked the device settled this ${NAMES[doc.type]} as not printed.`
  // ⚠ A sale read as not in doubt can be by now: its number was never asked for, so it is not claimed.
  const claimed: any = isSale && printed && !receiptNumber ? null : await Invoice.findOneAndUpdate(
    {
      _id: doc._id, orgId: oid(c.orgId), status: { $ne: 'voided' },
      ...(isSale ? saleInDoubtFilter(now) : { 'register.fiscal.inDoubt': true, completedAt: { $exists: false } }),
    },
    {
      $set: {
        'register.settled': { printed, by: oid(c.user.id), at: now, ...(receiptNumber ? { receiptNumber } : {}), ...(typed?.confirmedOver ? { confirmedOver: typed.confirmedOver } : {}) },
        // A finished sale has nothing left to find it by, and nothing left to do.
        ...(doc.completedAt ? {} : { leaseUntil: new Date(now.getTime() + LEASE_MS) }),
        ...(printed
          // ⚠ What has its number printed when it tried to, which is what a device's last number is read
          // against, and the moment a storno of it cites.
          ? { 'register.fiscal.state': 'printed', 'register.fiscal.printedAt': now, 'register.printedAt': ((isSale || receiptNumber) && doc.register?.fiscal?.attemptedAt) || now }
          : { 'register.fiscal.state': 'failed', 'register.fiscal.error': receiptError, 'register.receiptError': receiptError }),
        ...(receiptNumber ? { 'register.fiscal.receiptNo': receiptNumber, 'register.fiscalReceiptNumber': receiptNumber } : {}),
      },
      $unset: { 'register.fiscal.inDoubt': 1, ...(printed ? { 'register.receiptError': 1 } : {}) },
    },
    { new: true },
  ).lean().exec()
  if (!claimed) {
    const resumed = await resumeSettled(c, doc, printed)
    if (resumed) return resumed
    // Whoever holds its lease is finishing it: not "nothing to settle", because in a moment there is.
    const stands: any = isSale ? await Invoice.findOne({ _id: doc._id, orgId: oid(c.orgId) }).lean().exec() : null
    if (saleProgress(stands) === 'live') throw new RegisterRefusal(409, { ...SALE_BEING_FINISHED })
    return null
  }
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
