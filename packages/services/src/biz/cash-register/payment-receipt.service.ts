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
 * **After the print** (D-4, one failure rule), decided in the document's turn on the device, where the
 * counter is ours (`print-verdict.ts`). Printed: the payment row, linked to the receipt, then
 * `payment.recorded`. Failed, which means PROVED to have left nothing: the receipt is voided with its
 * number and УНП (18.5 lists it), no payment is recorded, and the invoice stays as it was; the next
 * attempt is a new receipt. Nothing is rolled back and no number is lost. **Unknown** (a print that
 * threw once the device may have taken the money or closed the receipt) stands as the till's sale
 * does: never printed again, the money recorded, the doubt shown (`receiptError`) and the journal's
 * fiscal state saying so. A second receipt for one payment is the failure print-once exists to
 * prevent, and the customer's money is in the drawer either way.
 *
 * **A request that died** is another matter: nobody is at the counter, nothing held the device since,
 * and on a shared device a counter that moved proves nothing about this receipt. It is given up only
 * when it never reached the device, or the device confirms it idle with its counter unmoved. Anything
 * else books no money and prints nothing: it stays held, `unknown` and `inDoubt`, until a person who
 * looked at the device settles it (`settleReceipt`).
 *
 * **Cash on delivery** prints at issue, in the device's slot for it, and pays nothing: the courier
 * still owes the invoice. No later payment prints again, because that receipt took all that was owed.
 * If that print fails there is no payment to take again, so the receipt prints on its own
 * (`owesDeliveryReceipt`).
 *
 * ⚠ What prints is decided at the doors, by a person issuing or paying at the counter
 * (`invoice.controller.ts`), never in `syncCashSettlement`, which the import conversion calls too.
 * An imported document never prints: another system printed its receipt.
 */
import { Invoice, POSSession } from 'db/models'
import { assertHomeIsHere } from 'db/home/home'
import { createAuditEntry, recordAuditEntry } from '../audit-log.service.js'
import { eventBus } from '../../events/event-bus.js'
import { logger } from '../../logger/logger.js'
import { generateUNP } from '../sequence.service.js'
import { LEASE_MS, takeLease } from '../hot-path-key.js'
import { fitsDue, heldOn, isBeingVoided, outstandingOf, overpays, paymentPipeline, type PaymentRow } from '../invoice-payment.js'
import { printsHere } from '../sale-counting.js'
import { SETTLED_ON_ISSUE } from '../cash-settlement.service.js'
import { receiptTookMoney } from './counting.js'
import { toPosTransaction } from './mapping.js'
import { PAYMENT_RECEIPT } from './pos-union.js'
import { provedNotPrinted } from './print-verdict.js'
import type { RegisterPrinter } from './printer.js'
import type { ReceiptBody } from './receipt-lines.js'
import {
  RegisterRefusal, applySessionTotals, holdInDoubt, inTurn, isPendingNumber, numberPending, printSaleStep, readDevice, rollBack,
  saleIncrements, setRegister, type RegisterContext, type RegisterSession, type RegisterUser,
} from './register.service.js'

type ObjectId = InstanceType<typeof Invoice.base.Types.ObjectId>
const oid = (v: unknown): ObjectId => new Invoice.base.Types.ObjectId(String(v))
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

/** §2.7: a printed receipt cannot change, so what it printed cannot either. */
const FISCALLY_PAID = {
  code: 'fiscally_paid',
  message: 'A fiscal receipt has printed for this document, so its total can no longer change and it cannot be voided. Correct it with a credit or a debit note.',
} as const

/** The payment methods a receipt prints for at the counter (owner, Q-2): those taken as a document is issued. */
const COUNTER_METHODS = Object.keys(SETTLED_ON_ISSUE)

/**
 * A document §2.2 means by imported: written by the Files app, the conversion or the API import
 * skills, whose receipt another system printed. They all come through `persistInvoiceDraft`.
 *
 * ⚠ Only its first status entry says so. It is written once, by the import, and neither a copy nor a
 * person can give it to a document. The `ocr-import` tag does not do: "Копирай" carries it, and a
 * user can type it. Nor does `importedFrom`: that is LGR moving its own document between its nodes,
 * and such a document prints like any other.
 */
export function isImportedDocument(doc: any): boolean {
  return doc?.statusHistory?.[0]?.reason === 'ocr_import'
}

/**
 * Whether taking `method` on this document prints a receipt (§2.2): an outgoing invoice or debit
 * note, not one issued for a cash sale, whose money that sale's receipt took, not an imported one,
 * and not the re-issue of a number issued twice, whose money was taken under the number it replaces.
 * Cash on delivery prints only as the invoice is issued, or again when that print failed
 * (`owesDeliveryReceipt`); the money the courier brings later was on that receipt. Bank transfer and
 * `other` print nothing.
 */
export function printsAtCounter(doc: any, method: string | undefined, atIssue: boolean): boolean {
  if (doc?.direction !== 'outgoing' || (doc?.type !== 'invoice' && doc?.type !== 'debit_note')) return false
  if (doc.cashSaleRef?.cashSaleId || isImportedDocument(doc)) return false
  if (doc.stockSource?.detectedBy === 'number_clash') return false
  if (method === 'cash_on_delivery') return atIssue && doc.type === 'invoice'
  return COUNTER_METHODS.includes(String(method))
}

/** The statuses a payment that prints can land on: an issued document with money still to take. */
const PAYABLE = ['sent', 'overdue', 'partially_paid']

/**
 * Which methods print a receipt on each of `docs`, as `/payments` will decide it: what the payment
 * dialog reads, on the form and on a list row, so it never has a copy of a rule it cannot evaluate.
 * The dialog said a print was coming and locked the date on a document that printed nothing, and let
 * an unannounced receipt silently re-date a payment on one that did. Only documents with an answer are
 * in the map. One read for the whole page.
 */
export async function printsOnPayment(orgId: string, docs: any[]): Promise<Map<string, string[]>> {
  const idOf = (d: any) => String(d._id ?? d.id)
  const out = new Map<string, string[]>()
  const candidates = docs.filter(d => PAYABLE.includes(d.status) && printsAtCounter(d, 'cash', false))
  if (!candidates.length || !(await printsHere(orgId))) return out
  // Its delivery receipt took all that was owed: no payment on it prints.
  const delivered = new Set((await Invoice.distinct('register.paidInvoiceId', {
    orgId: oid(orgId), type: PAYMENT_RECEIPT, paymentMethod: 'cash_on_delivery', status: { $ne: 'voided' },
    'register.paidInvoiceId': { $in: candidates.map(d => oid(idOf(d))) },
  }).exec()).map(String))
  for (const d of candidates) {
    if (!delivered.has(idOf(d))) out.set(idOf(d), COUNTER_METHODS.filter(m => printsAtCounter(d, m, false)))
  }
  return out
}

const liveReceipts = (orgId: unknown, documentId: unknown) => ({
  orgId: oid(orgId), type: PAYMENT_RECEIPT, 'register.paidInvoiceId': oid(documentId), status: { $ne: 'voided' },
})

/** The receipts of a document that printed, are printing or may have printed, oldest first. */
export async function receiptsOf(orgId: string, documentId: string): Promise<any[]> {
  return Invoice.find(liveReceipts(orgId, documentId)).sort({ _id: 1 }).lean().exec()
}

/** Another receipt of this document holds the money right now. */
export const PAYMENT_IN_PROGRESS = {
  code: 'payment_in_progress',
  message: 'Another payment on this document is printing. Wait for it to finish, then try again.',
} as const

/** A void or an attach to a cash sale holds the document's money (`voidingUntil`). */
export const DOCUMENT_CLAIMED = {
  code: 'document_claimed',
  message: 'This document is being voided or attached to a cash sale right now. Try again in a moment.',
} as const

/** An edit that moves its total, and a payment that came in since the edit read it. */
export const DOCUMENT_CHANGED = {
  code: 'document_changed',
  message: 'A payment was recorded on this document while you edited it. Open it again.',
} as const

/** The courier's money, on an invoice whose receipt has not printed. */
export const DELIVERY_RECEIPT_OWED = {
  code: 'delivery_receipt_owed',
  message: 'This cash-on-delivery invoice has no fiscal receipt: its print failed. Print the receipt first.',
} as const

/** The receipt of this document that a person has to settle, if there is one. */
export async function receiptInDoubt(orgId: string, documentId: string): Promise<any | null> {
  return Invoice.findOne({ ...liveReceipts(orgId, documentId), 'register.fiscal.inDoubt': true }, { invoiceNumber: 1 }).sort({ _id: 1 }).lean().exec()
}

/** The refusal of what cannot go on until a receipt is settled. */
export const inDoubtRefusal = (receipt: any) => ({
  code: 'receipt_in_doubt',
  receipt: { id: String(receipt._id), number: receipt.invoiceNumber },
  message: `Nothing can prove whether receipt ${receipt.invoiceNumber} printed, so its money is neither booked nor free. Check the device, then settle it in the cash-register journal.`,
})

/**
 * §2.7: whether the document's total is the receipts' now, with the reason that applies: a receipt in
 * doubt has a way out the freeze does not. A failed receipt printed nothing.
 */
export async function freezeRefusal(orgId: string, documentId: string): Promise<Record<string, unknown> | null> {
  const live: any[] = await Invoice.find(liveReceipts(orgId, documentId), { invoiceNumber: 1, 'register.fiscal.inDoubt': 1 }).sort({ _id: 1 }).lean().exec()
  const doubt = live.find(r => r.register?.fiscal?.inDoubt)
  if (doubt) return inDoubtRefusal(doubt)
  return live.length ? { ...FISCALLY_PAID } : null
}

/**
 * A cash-on-delivery invoice with no receipt, whose print failed as it was issued. The courier owes
 * the money, so there is no payment to take again, and one recorded by hand would leave the sale with
 * no receipt or part of one: the receipt prints on its own (`POST /invoices/:id/receipt`), for what
 * is still owed, and nothing recorded on delivery goes past it.
 *
 * ⚠ Whether it owes one is a fact the issue wrote (`deliveryReceiptOwed`), never read from whether a
 * print was tried. An issue can leave no receipt document at all: its hold refused and rolled back, a
 * number that could not be drawn, a process that died before the insert. Read as "never tried", such
 * an invoice could not print one, and the courier's money went through with no receipt. An invoice
 * issued before LGR printed, or where it does not, carries no such fact and owes none.
 */
export async function owesDeliveryReceipt(orgId: string, doc: any): Promise<boolean> {
  if (!mayOweDeliveryReceipt(doc)) return false
  const live = await Invoice.exists({ ...liveReceipts(orgId, doc._id ?? doc.id), paymentMethod: 'cash_on_delivery' }).exec()
  return !live && printsHere(orgId)
}

/** What the document alone says about it: the rest is whether one printed, and whether LGR still prints. */
const mayOweDeliveryReceipt = (doc: any) => !!doc?.deliveryReceiptOwed && doc.paymentMethod === 'cash_on_delivery'
  && PAYABLE.includes(doc.status) && printsAtCounter(doc, doc.paymentMethod, true)

/** What a document's receipts are read for. A receipt printed whole holds the invoice's lines. */
const RECEIPT_FIELDS = { type: 1, status: 1, invoiceNumber: 1, paymentMethod: 1, issueDate: 1, register: 1 }

/** What the form and the PDF say of a document's receipts, of those that took money on it. */
function paidBy(receipts: any[]): Array<{ number: string; method?: string; unp?: string; receiptNumber?: string; date?: Date }> {
  return receipts
    .filter(d => receiptTookMoney(toPosTransaction(d) as any))
    .map(d => ({
      number: d.invoiceNumber,
      method: d.paymentMethod,
      ...(d.register?.unp ? { unp: d.register.unp } : {}),
      ...(d.register?.fiscalReceiptNumber ? { receiptNumber: d.register.fiscalReceiptNumber } : {}),
      date: d.issueDate,
    }))
}

/** What the invoice PDF lists: the receipts that paid it. */
export async function paidByReceipts(orgId: string, documentId: string): Promise<ReturnType<typeof paidBy>> {
  return paidBy(await Invoice.find(liveReceipts(orgId, documentId), RECEIPT_FIELDS).sort({ _id: 1 }).lean().exec())
}

/**
 * All the form asks about a document's receipts, from one read. A document no receipt can land on
 * pays for none: a bill, a proforma, a cash sale, every other document anyone opens.
 */
export async function receiptFacts(orgId: string, doc: any) {
  if (!printsAtCounter(doc, 'cash', false)) return { paymentReceipts: [], receiptToPrint: false, receiptInDoubt: null, printsOnPayment: [] as string[] }
  const [live, prints]: [any[], boolean] = await Promise.all([
    Invoice.find(liveReceipts(orgId, doc._id ?? doc.id), RECEIPT_FIELDS).sort({ _id: 1 }).lean().exec(),
    printsHere(orgId),
  ])
  const doubt = live.find(r => r.register?.fiscal?.inDoubt)
  const delivered = live.some(r => r.paymentMethod === 'cash_on_delivery')
  return {
    paymentReceipts: paidBy(live),
    receiptToPrint: prints && !delivered && mayOweDeliveryReceipt(doc),
    receiptInDoubt: doubt ? { id: String(doubt._id), number: doubt.invoiceNumber as string } : null,
    printsOnPayment: prints && !delivered && PAYABLE.includes(doc.status) ? COUNTER_METHODS.filter(m => printsAtCounter(doc, m, false)) : [],
  }
}

export interface ReceiptTender {
  method: string
  amount: number
  date: Date
  reference?: string
}

interface PaymentReceiptInput {
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
    // Until it prints, which dates it (`datedAsItPrints`).
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

/**
 * Hold the receipt's amount on its invoice, atomically. False when it does not fit, or a claim stands
 * on the invoice (`fitsDue`): of a void and a payment at once, one gives way.
 */
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

/**
 * Why this document takes no payment of `amount` now, or null when it does. One answer for one
 * condition, whichever door lost the race: the route's check, its atomic update, or a receipt's hold.
 * An overpayment is nothing anyone posts on purpose: the dialog offers the outstanding amount, the
 * settlement rule takes exactly the total, and no import records payments through this route. An
 * amount above what is owed was a typing slip that left the document paid with a negative amount due.
 */
export async function paymentRefusal(orgId: string, doc: any, amount: number): Promise<RegisterRefusal | null> {
  if (!doc || ['voided', 'cancelled', 'paid'].includes(doc.status)) return new RegisterRefusal(400, { message: 'Cannot record payment on this invoice' })
  if (isBeingVoided(doc)) return new RegisterRefusal(409, { ...DOCUMENT_CLAIMED })
  if (overpays(doc, amount)) {
    const outstanding = outstandingOf(doc)
    return new RegisterRefusal(422, { code: 'overpayment', outstanding, message: `Payment ${round2(amount)} is more than the ${outstanding} still due on this document` })
  }
  // It would fit, but a receipt is taking that money: printing right now, or held for a person.
  if (overpays({ total: doc.total, amountPaid: (Number(doc.amountPaid) || 0) + heldOn(doc) }, amount)) {
    const doubt = await receiptInDoubt(orgId, String(doc._id ?? doc.id))
    return new RegisterRefusal(409, doubt ? inDoubtRefusal(doubt) : { ...PAYMENT_IN_PROGRESS })
  }
  return null
}

/**
 * Record the money the receipt took, once, and let go of its hold. ⚠ Never for a voided receipt: what
 * was given up has no money to book, whoever comes back to it.
 */
export async function recordPayment(c: RegisterContext, doc: any): Promise<void> {
  if ((await Invoice.findById(doc._id, { status: 1 }).lean().exec() as any)?.status === 'voided') return
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

/** The print, in the receipt's turn. What cannot print: failed if it never reached the device, else in doubt. */
async function printReceiptStep(c: RegisterContext, doc: any): Promise<any> {
  const couldNot = (reason: string) => (doc.register?.fiscal?.attemptedAt
    ? holdInDoubt(doc)
    : setRegister(doc._id, { 'fiscal.state': 'failed', 'fiscal.error': reason, receiptError: reason }))
  if (!c.printer) return couldNot('The fiscal device is no longer connected, so the receipt was not printed.')
  try {
    return await inTurn(c.printer, doc, async (fresh) => {
      // In the turn, so that a close finds this receipt or this receipt finds the close: money that
      // lands after the day was counted is in no session's drawer (`pos.controller.ts`, the close).
      const open = await POSSession.exists({ _id: fresh.register?.sessionId, status: 'open' }).exec()
      if (!open) return couldNot('The session closed before this receipt could print.')
      return printSaleStep(c, fresh)
    })
  } catch (e: any) {
    if (e?.code !== 'device_busy') throw e
    return couldNot(e.message)
  }
}

/**
 * Run whatever the receipt has not done yet, then mark it complete. `neverPrint`: what finishes a
 * request that died, which leaves a receipt that was not decided exactly as it found it.
 */
export async function runReceiptSteps(c: RegisterContext, id: string, opts: { neverPrint?: boolean } = {}): Promise<any> {
  let doc: any = await Invoice.findOne({ _id: oid(id), orgId: oid(c.orgId), type: PAYMENT_RECEIPT }).lean().exec()
  if (!doc) throw new RegisterRefusal(404, { message: 'Receipt not found' })
  if (doc.status === 'voided') return doc
  if (opts.neverPrint && doc.register?.fiscal?.state === 'pending') return doc

  // The money before the number: a receipt that gives way here draws none.
  if (isPendingNumber(doc.invoiceNumber) && doc.register?.fiscal?.state === 'pending') {
    if (!(await holdAmount(doc))) {
      const invoice: any = await Invoice.findOne({ _id: doc.register.paidInvoiceId, orgId: doc.orgId }).lean().exec()
      const refusal = await paymentRefusal(String(doc.orgId), invoice, Number(doc.total) || 0)
      await rollBack(doc)
      throw refusal ?? new RegisterRefusal(409, { ...PAYMENT_IN_PROGRESS })
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
  if (doc.register?.fiscal?.state === 'pending') doc = await printReceiptStep(c, doc)
  // Given up, or a person's to settle: nothing more happens to it here.
  if (doc.status === 'voided' || doc.register?.fiscal?.inDoubt) return doc
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

/**
 * The receipts nobody finished, of a document or of a session: their request died, and their lease
 * has lapsed. One held for a person is not among them: there is nothing left to work out.
 */
export async function interruptedReceipts(orgId: string, where: { documentId?: string; sessionId?: string }): Promise<any[]> {
  return Invoice.find({
    orgId: oid(orgId), type: PAYMENT_RECEIPT,
    ...(where.documentId ? { 'register.paidInvoiceId': oid(where.documentId) } : {}),
    ...(where.sessionId ? { 'register.sessionId': oid(where.sessionId) } : {}),
    completedAt: { $exists: false }, leaseUntil: { $lt: new Date() }, 'register.fiscal.inDoubt': { $ne: true },
  }).sort({ _id: 1 }).lean().exec()
}

/** A close refused over its unfinished receipts, naming them. */
export function unfinishedRefusal(receipts: any[]) {
  const named = receipts.map(r => ({
    id: String(r._id),
    number: isPendingNumber(r.invoiceNumber) ? null : r.invoiceNumber,
    invoice: r.register?.paidInvoiceNumber,
    inDoubt: !!r.register?.fiscal?.inDoubt,
  }))
  const list = named.map(r => r.number ?? `for ${r.invoice}`).join(', ')
  return {
    code: 'receipts_unfinished',
    receipts: named,
    message: `Receipts ${list} are not finished, so this session cannot close. Wait for one that is printing, and settle one in doubt in the cash-register journal.`,
  }
}

/** The session's receipts that are not finished, whatever they are waiting for. */
export async function unfinishedReceipts(orgId: string, sessionId: string): Promise<any[]> {
  return Invoice.find(
    { orgId: oid(orgId), type: PAYMENT_RECEIPT, 'register.sessionId': oid(sessionId), completedAt: { $exists: false } },
    { invoiceNumber: 1, 'register.fiscal': 1, 'register.paidInvoiceNumber': 1 },
  ).sort({ _id: 1 }).lean().exec()
}

/**
 * Finish a receipt whose request died, for the next person to touch its document, or for the close of
 * its session. Its hold must not outlive it, and a payment that printed must not be taken again.
 *
 * ⚠ It NEVER prints: the customer at the counter now may be paying another amount, another way. And
 * it books nothing it cannot prove. The next touch can be days later, on a device other documents
 * print on, so a counter that moved says nothing about this receipt. What proves anything, read in
 * the device's turn:
 *  - it never reached the device: it did not print;
 *  - the counter did not move and nothing is open: no document closed since it started, and none is
 *    going to. It did not print.
 * Those are given up. Anything else, no device to ask included, stays held for a person.
 *
 * Past that point the print was decided by the request that died (printed, or unknown with the
 * device's answer lost), and only the money is left to record.
 */
export async function finishInterruptedReceipt(c: RegisterContext, doc: any): Promise<any> {
  const decide = async (fresh: any) => {
    const fiscal = fresh.register?.fiscal
    const neverPrinted = !fiscal?.attemptedAt
      || (!!c.printer && provedNotPrinted({ before: fiscal.counterBefore, ...(await readDevice(c.printer)) }))
    if (!neverPrinted) {
      logger.warn({ documentId: String(fresh._id) }, 'Interrupted payment receipt cannot be proved either way — held for a person')
      return holdInDoubt(fresh)
    }
    logger.warn({ documentId: String(fresh._id) }, 'Interrupted payment receipt did not print — given up')
    const receiptError = 'The payment was interrupted before its receipt printed.'
    return setRegister(fresh._id, { 'fiscal.state': 'failed', 'fiscal.error': receiptError, receiptError })
  }
  if (doc.register?.fiscal?.state === 'pending') {
    if (c.printer) await inTurn(c.printer, doc, decide)
    else await decide(doc)
  }
  return runReceiptSteps(c, String(doc._id), { neverPrint: true })
}

/**
 * A person looked at the device and says whether a receipt in doubt printed. Printed: its session
 * counts it and its payment is recorded. Not printed: it is voided with its number and УНП, and its
 * amount goes back to the invoice. Answers null when it is not in doubt. What they said, and who said
 * it, stays on the document and in the audit trail.
 *
 * ⚠ What they said is durable from the claim on, and the claim leaves a lease: a receipt is found by
 * its lapsing until `completedAt`. A settle that stops before the money is booked is finished by the
 * next touch of its document, or by its session's close, with no device. Unsetting the lease left a
 * receipt nothing could find, with its hold on the invoice and its session unable to close.
 */
export async function settleReceipt(c: RegisterContext, receiptId: string, printed: boolean): Promise<any | null> {
  const now = new Date()
  const receiptError = 'A person who checked the device settled this receipt as not printed.'
  const claimed: any = await Invoice.findOneAndUpdate(
    { _id: oid(receiptId), orgId: oid(c.orgId), type: PAYMENT_RECEIPT, 'register.fiscal.inDoubt': true, completedAt: { $exists: false }, status: { $ne: 'voided' } },
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
  if (!claimed) return resumeSettled(c, receiptId, printed)
  await recordAuditEntry({
    orgId: c.orgId, userId: c.user.id, operatorCode: c.user.operatorCode, action: 'settle_receipt', module: c.audit.module,
    entityType: c.audit.entityType, entityId: String(claimed._id), entityName: claimed.invoiceNumber, unpNumber: claimed.register?.unp,
    changes: [{ field: 'printed', oldValue: 'unknown', newValue: printed ? 'yes' : 'no' }],
  })
  return runReceiptSteps(c, String(claimed._id))
}

/**
 * A second `/settle` of one that stopped halfway. What was said first stands: the same answer finishes
 * it once its lease has lapsed, and the opposite is refused. Null when there is nothing to finish, or
 * the first still holds it.
 */
async function resumeSettled(c: RegisterContext, receiptId: string, printed: boolean): Promise<any | null> {
  const stopped: any = await Invoice.findOne({
    _id: oid(receiptId), orgId: oid(c.orgId), type: PAYMENT_RECEIPT, 'register.settled': { $exists: true }, completedAt: { $exists: false },
  }).lean().exec()
  if (!stopped) return null
  if (stopped.register.settled.printed !== printed) {
    throw new RegisterRefusal(409, {
      code: 'receipt_already_settled',
      message: `This receipt was already settled as ${stopped.register.settled.printed ? 'printed' : 'not printed'}, and that stands.`,
    })
  }
  if (!(await takeLease(Invoice, c.orgId, stopped._id))) return null
  return runReceiptSteps(c, String(stopped._id))
}
