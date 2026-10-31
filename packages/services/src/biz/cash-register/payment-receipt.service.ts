/**
 * FR-23 R1 — the fiscal receipt of a payment on an invoice or a debit note (`payment_receipt`).
 *
 * The invoice is the sale (Q-1): it moved the stock and posted the revenue, as it always did. The
 * receipt is the money: a document of the register, in the register's number series (D-5), printed
 * on the device of the issuing user's open session (D-13). It moves no stock and posts no revenue.
 * Its cash is in that drawer, so the session counts it; `payment.recorded` on the invoice posts it,
 * so the session's close does not.
 *
 * The steps are the till's (#155), resumable, each recorded on the document:
 *
 *   hold the amount → number → УНП → print once → session totals → payment → complete → audit
 *
 * **The hold.** The amount is held on the invoice before anything else is drawn, in one atomic
 * update with the check that it fits (`receiptHolds`), so of two payments at once one gives way with
 * no number lost, and a payment by bank recorded while the device prints cannot take the same money.
 * A failed hold removes the document: nothing reached a device or a drawer.
 *
 * **After the print** (D-4, one failure rule). Printed: the payment row, linked to the receipt, then
 * `payment.recorded`. Failed: the receipt is voided with its number and УНП (18.5 lists it), no
 * payment is recorded, and the invoice stays as it was; the next attempt is a new receipt. Nothing
 * is rolled back and no number is lost. **Unknown** (an interrupted print the device cannot confirm)
 * stands as the till's sale does: never printed again, the money recorded, the doubt shown
 * (`receiptError`) and the journal's fiscal state saying so. A second receipt for one payment is the
 * failure print-once exists to prevent, and the customer's money is in the drawer either way.
 *
 * **Cash on delivery** prints at issue, in the device's slot for it, and pays nothing: the courier
 * still owes the invoice. No later payment prints again, because every cent of it has its receipt.
 *
 * ⚠ What prints is decided at the doors, by a person issuing or paying at the counter
 * (`invoice.controller.ts`), never in `syncCashSettlement`, which the import conversion calls too.
 * An imported document never prints: another system printed its receipt.
 */
import { Invoice } from 'db/models'
import { assertHomeIsHere } from 'db/home/home'
import { createAuditEntry } from '../audit-log.service.js'
import { eventBus } from '../../events/event-bus.js'
import { logger } from '../../logger/logger.js'
import { generateUNP } from '../sequence.service.js'
import { LEASE_MS } from '../hot-path-key.js'
import { fitsDue, outstandingOf, overpays, paymentPipeline, type PaymentRow } from '../invoice-payment.js'
import { PAYMENT_RECEIPT } from './pos-union.js'
import type { RegisterPrinter } from './printer.js'
import type { ReceiptBody } from './receipt-lines.js'
import {
  RegisterRefusal, applySessionTotals, isPendingNumber, numberPending, printSaleStep, rollBack, saleIncrements, setRegister,
  type RegisterContext, type RegisterSession, type RegisterUser,
} from './register.service.js'

type ObjectId = InstanceType<typeof Invoice.base.Types.ObjectId>
const oid = (v: unknown): ObjectId => new Invoice.base.Types.ObjectId(String(v))
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

/** §2.7: a printed receipt cannot change, so what it printed cannot either. */
export const FISCALLY_PAID = {
  code: 'fiscally_paid',
  message: 'A fiscal receipt has printed for this document, so its total can no longer change and it cannot be voided. Correct it with a credit or a debit note.',
} as const

/** The payment methods a receipt prints for at the counter (owner, Q-2). */
const COUNTER_METHODS = ['cash', 'card']

/** Written by something other than a person at the counter: another system printed its receipt. */
export function isImportedDocument(doc: any): boolean {
  return !!doc?.importedFrom?.kind || doc?.statusHistory?.[0]?.reason === 'ocr_import' || (doc?.tags || []).includes('ocr-import')
}

/**
 * Whether taking `method` on this document prints a receipt (§2.2): an outgoing invoice or debit
 * note, not one issued for a cash sale, whose money that sale's receipt took, and not an imported
 * one. Cash on delivery prints only as the invoice is issued; the money the courier brings later
 * was on that receipt. Bank transfer and `other` print nothing.
 */
export function printsAtCounter(doc: any, method: string | undefined, atIssue: boolean): boolean {
  if (doc?.direction !== 'outgoing' || (doc?.type !== 'invoice' && doc?.type !== 'debit_note')) return false
  if (doc.cashSaleRef?.cashSaleId || isImportedDocument(doc)) return false
  if (method === 'cash_on_delivery') return atIssue && doc.type === 'invoice'
  return COUNTER_METHODS.includes(String(method))
}

const liveReceipts = (orgId: unknown, documentId: unknown) => ({
  orgId: oid(orgId), type: PAYMENT_RECEIPT, 'register.paidInvoiceId': oid(documentId), status: { $ne: 'voided' },
})

/** The receipts of a document that printed, are printing or may have printed, oldest first. */
export async function receiptsOf(orgId: string, documentId: string): Promise<any[]> {
  return Invoice.find(liveReceipts(orgId, documentId)).sort({ _id: 1 }).lean().exec()
}

/** §2.7: whether the document's total is the receipts' now. A failed receipt printed nothing. */
export async function isFiscallyPaid(orgId: string, documentId: string): Promise<boolean> {
  return !!(await Invoice.exists(liveReceipts(orgId, documentId)).exec())
}

/** What the invoice PDF lists: the receipts that paid it. */
export async function paidByReceipts(orgId: string, documentId: string): Promise<Array<{ number: string; unp?: string; receiptNumber?: string; date?: Date }>> {
  const docs = await receiptsOf(orgId, documentId)
  return docs
    .filter(d => d.register?.fiscal?.state === 'printed' || d.register?.fiscal?.state === 'unknown')
    .map(d => ({
      number: d.invoiceNumber,
      ...(d.register?.unp ? { unp: d.register.unp } : {}),
      ...(d.register?.fiscalReceiptNumber ? { receiptNumber: d.register.fiscalReceiptNumber } : {}),
      date: d.issueDate,
    }))
}

export interface ReceiptTender {
  method: string
  amount: number
  date: Date
  reference?: string
}

export interface PaymentReceiptInput {
  invoice: any
  body: ReceiptBody
  tender: ReceiptTender
  session: RegisterSession
  user: RegisterUser
  printer: RegisterPrinter
}

/** The receipt's document: what the device is about to print, under its session. */
export function paymentReceiptDocument(input: PaymentReceiptInput): Record<string, any> {
  const { invoice, body, tender, session, user, printer } = input
  const now = new Date()
  const exchangeRate = Number(invoice.exchangeRate) || 1
  return {
    orgId: invoice.orgId,
    type: PAYMENT_RECEIPT,
    direction: 'outgoing',
    status: 'paid',
    statusHistory: [{ status: 'paid', changedAt: now, changedBy: oid(user.id), reason: 'payment_receipt' }],
    ...(invoice.contactId ? { contactId: invoice.contactId } : {}),
    // The moment of the payment, as a till document's is.
    issueDate: now,
    dueDate: now,
    currency: invoice.currency,
    exchangeRate,
    lines: body.lines,
    subtotal: body.subtotal,
    discountTotal: body.discountTotal,
    taxTotal: body.taxTotal,
    total: body.total,
    totalBase: round2(body.total * exchangeRate),
    amountPaid: body.total,
    amountDue: 0,
    paidAt: now,
    payments: [{ date: tender.date, method: tender.method, amount: body.total, ...(tender.reference ? { reference: tender.reference } : {}) }],
    paymentMethod: tender.method,
    billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
    attachments: [],
    // Unkeyed too: a receipt nobody finished is found by this lapsing (`interruptedReceipts`).
    leaseUntil: new Date(now.getTime() + LEASE_MS),
    register: {
      // The drawer's document, like a back-office sale that joined its session (FR-21.31).
      origin: 'pos',
      joinedFrom: 'backoffice',
      sessionId: oid(session.id),
      warehouseId: oid(session.warehouseId),
      cashierId: oid(user.id),
      fiscalDeviceNumber: printer.deviceNumber,
      ...(user.operatorCode ? { operatorCode: user.operatorCode } : {}),
      isFiscal: true,
      fiscal: { state: 'pending', mode: 'fiscal' },
      changeDue: 0,
      paidInvoiceId: invoice._id,
      paidInvoiceNumber: invoice.invoiceNumber,
      ...(body.receiptText ? { receiptText: body.receiptText } : {}),
    },
    createdBy: oid(user.id),
  }
}

/** Hold the receipt's amount on its invoice, atomically. False when it does not fit. */
async function holdAmount(doc: any): Promise<boolean> {
  const invoiceId = doc.register.paidInvoiceId
  const amount = Number(doc.total) || 0
  const held = await Invoice.findOneAndUpdate(
    {
      _id: invoiceId, orgId: doc.orgId, status: { $nin: ['draft', 'voided', 'cancelled', 'paid'] },
      'receiptHolds.receiptId': { $ne: doc._id }, ...fitsDue(amount),
    },
    { $push: { receiptHolds: { receiptId: doc._id, amount } } },
    { new: true },
  ).lean().exec()
  return !!held || !!(await Invoice.exists({ _id: invoiceId, orgId: doc.orgId, 'receiptHolds.receiptId': doc._id }).exec())
}

async function releaseHold(doc: any): Promise<void> {
  await Invoice.updateOne(
    { _id: doc.register.paidInvoiceId, orgId: doc.orgId },
    { $pull: { receiptHolds: { receiptId: doc._id } } },
  ).exec()
}

/** Why a hold was refused, as the payment's route answers it. */
async function holdRefusal(doc: any): Promise<RegisterRefusal> {
  const invoice: any = await Invoice.findOne({ _id: doc.register.paidInvoiceId, orgId: doc.orgId }, { total: 1, amountPaid: 1, status: 1 }).lean().exec()
  const amount = Number(doc.total) || 0
  if (!invoice || ['voided', 'cancelled', 'paid'].includes(invoice.status) || overpays(invoice, amount)) {
    const outstanding = invoice ? outstandingOf(invoice) : 0
    return new RegisterRefusal(422, {
      code: 'overpayment',
      outstanding,
      message: `Payment ${round2(amount)} is more than the ${outstanding} still due on this document`,
    })
  }
  return new RegisterRefusal(409, { code: 'payment_in_progress', message: 'Another payment on this document is printing. Wait for it to finish, then try again.' })
}

/** Record the money the receipt took, once, and let go of its hold. */
async function recordPayment(c: RegisterContext, doc: any): Promise<void> {
  const tendered = doc.payments[0]
  const invoiceId = doc.register.paidInvoiceId
  // A courier owes this one: the invoice stays due until the money arrives (§2.2).
  if (tendered.method === 'cash_on_delivery') return releaseHold(doc)

  const row: PaymentRow = {
    date: tendered.date,
    amount: tendered.amount,
    method: tendered.method,
    ...(tendered.reference ? { reference: tendered.reference } : {}),
    origin: PAYMENT_RECEIPT,
    receiptId: doc._id,
    // What a keyed retry of the payment finds, as it finds any other (`replayPayment`).
    ...(doc.clientKey ? { clientKey: doc.clientKey, requestHash: doc.requestHash } : {}),
  }
  // FR-20.4: a raw driver write, which the Mongoose write guard cannot see — so it asks first.
  await assertHomeIsHere(String(doc.orgId))
  const after = await Invoice.collection.findOneAndUpdate(
    // No check that it fits: it printed. The hold kept the room for it.
    { _id: invoiceId, orgId: doc.orgId, 'payments.receiptId': { $ne: doc._id } } as any,
    paymentPipeline(row, { at: new Date(), by: c.user.id, releases: doc._id }) as any,
    { returnDocument: 'after' },
  )
  if (!after) return releaseHold(doc) // Recorded by the attempt this one resumes.

  createAuditEntry({
    orgId: c.orgId, userId: c.user.id, action: 'record_payment', module: 'invoicing', entityType: 'invoice',
    entityId: String(invoiceId), entityName: doc.register.paidInvoiceNumber,
    changes: [{ field: 'receipt', oldValue: null, newValue: doc.invoiceNumber }],
  })
  // The same event a hand-recorded payment emits: the ledger entry, when the org keeps one.
  eventBus.emit('payment.recorded', {
    invoiceId: String(invoiceId), orgId: c.orgId, userId: c.user.id,
    amount: tendered.amount, method: tendered.method, date: new Date(tendered.date).toISOString(), receiptId: String(doc._id),
  })
}

/**
 * A receipt that did not print: the amount goes back to the invoice and no payment is recorded.
 * Numbered, it stays a voided document, its number and УНП accounted for (SUPTO 18.5); one that
 * never got as far as a number leaves nothing behind.
 */
async function giveUp(c: RegisterContext, doc: any): Promise<any> {
  await releaseHold(doc)
  if (isPendingNumber(doc.invoiceNumber)) {
    await rollBack(doc)
    return { ...doc, status: 'voided', completedAt: new Date() }
  }
  const now = new Date()
  const voided: any = await Invoice.findOneAndUpdate(
    { _id: doc._id, completedAt: { $exists: false } },
    {
      $set: { status: 'voided', 'register.cancelledAt': now, completedAt: now },
      $push: { statusHistory: { status: 'voided', fromStatus: 'paid', changedAt: now, changedBy: oid(c.user.id), reason: 'receipt_not_printed' } },
      $unset: { leaseUntil: 1 },
    },
    { new: true },
  ).lean().exec()
  return voided ?? Invoice.findById(doc._id).lean().exec()
}

/** Run whatever the receipt has not done yet, then mark it complete. */
export async function runReceiptSteps(c: RegisterContext, id: string): Promise<any> {
  let doc: any = await Invoice.findOne({ _id: oid(id), orgId: oid(c.orgId), type: PAYMENT_RECEIPT }).lean().exec()
  if (!doc) throw new RegisterRefusal(404, { message: 'Receipt not found' })

  // The money before the number: a receipt that gives way here draws none.
  if (isPendingNumber(doc.invoiceNumber) && doc.register?.fiscal?.state === 'pending') {
    if (!(await holdAmount(doc))) {
      const refusal = await holdRefusal(doc)
      await rollBack(doc)
      throw refusal
    }
    const numbered = await numberPending(c.orgId, doc)
    if (!numbered) {
      await releaseHold(doc)
      await rollBack(doc)
      throw new RegisterRefusal(409, { message: 'Could not allocate the cash-register number after 3 attempts' })
    }
    doc = numbered
  }

  if (c.printer && doc.register?.fiscal?.state === 'pending' && !doc.register?.unp) {
    doc = await setRegister(doc._id, { unp: await generateUNP(c.orgId, c.printer.deviceNumber, (c.user.operatorCode ?? doc.register?.operatorCode) as string) })
  }
  if (doc.register?.fiscal?.state === 'pending') {
    if (c.printer) {
      doc = await c.printer.operation(() => printSaleStep(c, doc))
    } else if (doc.register?.fiscal?.attemptedAt) {
      doc = await printSaleStep(c, doc)
    } else {
      // It never reached the device, so it certainly did not print.
      const receiptError = 'The fiscal device is no longer connected, so the receipt was not printed.'
      doc = await setRegister(doc._id, { 'fiscal.state': 'failed', 'fiscal.error': receiptError, receiptError })
    }
  }

  if (doc.register?.fiscal?.state === 'failed') return giveUp(c, doc)

  // Printed, or it may have: the money stands from here on (D-4).
  const sessionId = doc.register?.sessionId ? String(doc.register.sessionId) : undefined
  if (sessionId && !doc.register?.sessionTotalsApplied) {
    await applySessionTotals(doc, sessionId, saleIncrements(doc))
    doc = await Invoice.findById(doc._id).lean().exec()
  }
  await recordPayment(c, doc)

  const done: any = await Invoice.findOneAndUpdate(
    { _id: doc._id, completedAt: { $exists: false } },
    { $set: { completedAt: new Date() }, $unset: { leaseUntil: 1 } },
    { new: true },
  ).lean().exec()
  if (done) {
    createAuditEntry({
      orgId: c.orgId, userId: c.user.id, operatorCode: c.user.operatorCode, action: 'create', module: c.audit.module,
      entityType: c.audit.entityType, entityId: String(done._id), entityName: done.invoiceNumber, unpNumber: done.register?.unp,
    })
  }
  return done ?? Invoice.findById(doc._id).lean().exec()
}

/** The receipts of a document nobody finished: their request died, and their lease has lapsed. */
export async function interruptedReceipts(orgId: string, documentId: string): Promise<any[]> {
  return Invoice.find({
    orgId: oid(orgId), type: PAYMENT_RECEIPT, 'register.paidInvoiceId': oid(documentId),
    completedAt: { $exists: false }, leaseUntil: { $lt: new Date() },
  }).sort({ _id: 1 }).lean().exec()
}

/**
 * Finish a receipt whose request died, for the next person who pays on the document. Its hold must
 * not outlive it, and a payment that printed must not be taken again.
 *
 * Unlike a keyed retry, which is the same customer's same request, this one prints nothing: the
 * customer at the counter now may be paying another amount, another way. What the device says
 * decides. It never started, or its counter did not move: it did not print, and it is given up.
 * Exactly one more: it printed, and is recorded (`printOnce`). Anything else stands as unknown.
 */
export async function finishInterruptedReceipt(c: RegisterContext, doc: any): Promise<any> {
  const fiscal = doc.register?.fiscal
  if (fiscal?.state === 'pending') {
    const before = fiscal.counterBefore
    const now = fiscal.attemptedAt && c.printer ? await c.printer.lastReceiptNumber().catch(() => undefined) : undefined
    if (!fiscal.attemptedAt || (before !== undefined && before !== null && now === before)) {
      logger.warn({ documentId: String(doc._id) }, 'Interrupted payment receipt did not print — given up')
      const receiptError = 'The payment was interrupted before its receipt printed.'
      await setRegister(doc._id, { 'fiscal.state': 'failed', 'fiscal.error': receiptError, receiptError })
    }
  }
  return runReceiptSteps(c, String(doc._id))
}
