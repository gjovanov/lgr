/**
 * FR-21 D-4 — one write path for every cash-register document.
 *
 * A sale rung up at the till is a cash-register document (`Invoice`, `cash_sale`, with the
 * `register` block of D-3), and so is its storno (`cash_storno`, D-2). Both are written here.
 *
 * The steps are #155's resumable steps, moved off `POSTransaction` onto the document:
 *
 *   claim the key → insert (under `~pending:<key>` when keyed) → number → УНП → print once →
 *   session totals → stock → complete → audit
 *
 * Each step records on the document that it ran, so a retry after a crash, or a duplicate request
 * with the same `Idempotency-Key`, runs only what is missing.
 *
 * ⚠ ONE failure rule (D-4). Until the sale has reached the fiscal device (a receipt pending, printed
 * or unknown) or the drawer (the session's totals applied), a failure removes the document: the back
 * office's and the import's behaviour. From then on nothing is undone. The failure is recorded on the
 * document (`register.stockError`, `register.receiptError`) and shown: the till's behaviour. A
 * receipt that printed cannot be taken back, and neither can the money in the drawer.
 *
 * ⚠ A print runs in the document's turn on the device (`printer.operation`), from the counter read to
 * the close. That is what makes the counter evidence, and why what a print that threw left behind is
 * decided there (`print-verdict.ts`).
 *
 * ⚠ `unknown` means a person must look at the device: nothing reads it as `failed`, and nothing reads
 * it as `printed`. A sale's money stands either way (D-4). A storno's and a payment's wait on the answer
 * (`HELD_WHEN_UNPROVED`), and a person gives it at the journal's settle door (`settle.service.ts`).
 *
 * What only a door knows is handed in: the fiscal device (a `RegisterPrinter`, which the till builds
 * from `fiscal/*` — `services` must not import it), the session the sale rings into, the request's
 * key, and the user.
 */
import { Invoice, POSSession, StockMovement } from 'db/models'
import { roundCents } from 'config/pos-totals'
import { getRepos } from '../../context.js'
import { logger } from '../../logger/logger.js'
import { createAuditEntry } from '../audit-log.service.js'
import { generateUNP } from '../sequence.service.js'
import { getNextInvoiceNumber, issuableRefusal } from '../invoice-numbering.service.js'
import { createInvoiceStockMovement, createNumberedMovement, reverseInvoiceStockMovement } from '../invoicing.service.js'
import { confirmMovement } from '../warehouse.service.js'
import { IdempotencyError, LEASE_MS, assertSameRequest, keepLease, takeLease, waitForCompletion } from '../hot-path-key.js'
import { exchangeRateFor, fromPosTransaction } from './mapping.js'
import { unitsOf } from './copy.js'
import type { RegisterPrinter } from './printer.js'
import { saleInDoubt } from './in-doubt.js'
import { provedNotPrinted, verdictOfFailedPrint } from './print-verdict.js'
import { PENDING_NUMBER, isPendingNumber } from './pending-number.js'

export { PENDING_NUMBER, isPendingNumber }

/**
 * #279: a sale that rings into no session (the back office, the import) is numbered only AFTER its
 * stock moved. It reaches neither a device nor a drawer, so a refused dispatch removes it, and a
 * number drawn before that refusal was lost: a gap in CS, a legal sequence SUPTO audits. A sale with
 * a session is numbered first: its receipt needs the number, and once its drawer has the money a
 * stock failure is recorded on it, never rolled back (D-4), so it leaves no gap.
 */
const numbersAfterStock = (doc: any) => doc?.type === 'cash_sale' && !doc?.register?.sessionId
/** A receipt waits the same way, for the hold on its invoice (FR-23): one that gives way draws none. */
const numbersLater = (doc: any) => numbersAfterStock(doc) || doc?.type === 'payment_receipt'

type ObjectId = InstanceType<typeof Invoice.base.Types.ObjectId>
const oid = (v: unknown): ObjectId => new Invoice.base.Types.ObjectId(String(v))
/** A fresh id: a storno's, chosen before its insert so the sale's claim can name it. */
export const newDocumentId = (): ObjectId => new Invoice.base.Types.ObjectId()
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

// ── What a door brings ───────────────────────────────────────────────────────

export type RegisterOrigin = 'pos' | 'backoffice' | 'import'

/** Who rings the sale up: the signed-in user, as the session token names them. */
export interface RegisterUser {
  id: string
  firstName?: string
  lastName?: string
  /** The operator code every УНП names (`DDDDDDDD-OOOO-NNNNNNN`). */
  operatorCode?: string
}

/** The session a sale rings into: its drawer takes the money, its close posts the revenue. */
export interface RegisterSession {
  id: string
  warehouseId: string
  cashierId?: string
  currency?: string
}

/** What a door needs to run a document's steps, on the first attempt or on a resume. */
export interface RegisterContext {
  orgId: string
  user: RegisterUser
  session?: RegisterSession | null
  /** The fiscal device the receipt prints on: the till's, when one is connected. */
  printer?: RegisterPrinter | null
  /** Book the dispatch even below zero: the till (whose own check runs before the print), an import. */
  allowNegative?: boolean
  /** Move no stock at all: an import whose goods another document already moved. */
  skipStock?: boolean
  /**
   * A door's own work around the dispatch, under the same failure rule: the back office confirms
   * the transfers a sale asked for before it dispatches (FR-21.24), and re-derives the order a
   * sale consumes once it has. Both run again on a resume, so each must be safe to repeat.
   */
  beforeStock?: (doc: any) => Promise<void>
  afterStock?: (doc: any) => Promise<void>
  /** How the audit trail names the document: the till's `pos_transaction`, the back office's `invoice`. */
  audit: { module: string; entityType: string }
}

/** A request the service refused, as the route answers it. */
export class RegisterRefusal extends Error {
  constructor(public statusCode: number, public body: Record<string, unknown>) {
    super(String(body.message ?? body.code ?? 'refused'))
    this.name = 'RegisterRefusal'
  }
}

// ── The till's documents ─────────────────────────────────────────────────────

/** A line of the till's request: net prices, net line value, as `PosTerminalView` sends it. */
export interface TillLine {
  productId: string
  name: string
  quantity: number
  unitPrice: number
  discount?: number
  taxRate?: number
  taxAmount?: number
  lineTotal: number
  priceExplanation?: unknown[]
}

export interface TillSaleInput {
  orgId: string
  user: RegisterUser
  session: RegisterSession
  /** The org's base currency, for `exchangeRate`. */
  baseCurrency?: string
  customerId?: string
  lines: TillLine[]
  /** The server's own totals (`validateTotals`), never the client's. */
  totals: { subtotal: number; discountTotal: number; taxTotal: number; total: number; changeDue: number }
  /** What the customer handed over, per method. */
  payments: { method: string; amount: number; reference?: string }[]
  /** The device the receipt prints on, and how: a fiscal receipt, or text (`nonFiscal`). */
  printer: RegisterPrinter | null
  nonFiscal: boolean
}

/**
 * The document a till sale becomes: the copy of the POS row the till would have written (D-1). One
 * mapping for the copy migration and for new sales, so every reader that still speaks POS rows
 * reads a new sale exactly as it reads a copied one, and an R1 binary rolled back to reads both as
 * the rows it wrote.
 */
export async function tillSaleDocument(input: TillSaleInput): Promise<Record<string, any>> {
  const now = new Date()
  const { session, totals, printer, nonFiscal, user } = input
  const currency = session.currency || input.baseCurrency || 'EUR'
  if (exchangeRateFor(currency, input.baseCurrency) === null) {
    throw new RegisterRefusal(422, {
      code: 'currency_unmapped',
      message: `The session's currency ${currency} has no fixed rate to the organization's ${input.baseCurrency}`,
    })
  }
  const row = {
    _id: newDocumentId(),
    orgId: oid(input.orgId),
    sessionId: oid(session.id),
    transactionNumber: '',
    type: 'sale',
    status: 'completed',
    ...(input.customerId ? { customerId: oid(input.customerId) } : {}),
    lines: input.lines.map(l => ({ ...l, productId: oid(l.productId) })),
    subtotal: totals.subtotal,
    discountTotal: totals.discountTotal,
    taxTotal: totals.taxTotal,
    total: totals.total,
    payments: input.payments,
    changeDue: totals.changeDue,
    ...(printer ? { fiscalDeviceNumber: printer.deviceNumber } : {}),
    isFiscal: !!printer && !nonFiscal,
    fiscal: printer ? { state: 'pending', mode: nonFiscal ? 'text' : 'fiscal' } : { state: 'none' },
    createdBy: oid(user.id),
    createdAt: now,
    updatedAt: now,
  }
  const units = await unitsOf(input.orgId, input.lines)
  const doc = fromPosTransaction(
    row,
    { currency, warehouseId: oid(session.warehouseId), ...(session.cashierId ? { cashierId: oid(session.cashierId) } : {}) },
    { baseCurrency: input.baseCurrency, unitOf: productId => units.get(String(productId)) },
  )
  // A sale, not a copy: no legacy block, the times of its own insert, and the operator signed in.
  delete doc.register.legacy
  delete doc.createdAt
  delete doc.updatedAt
  doc.statusHistory = [{ status: 'paid', changedAt: now, changedBy: oid(user.id), reason: 'cash_register_sale' }]
  if (user.operatorCode) doc.register.operatorCode = user.operatorCode
  return doc
}

// ── The steps ────────────────────────────────────────────────────────────────

/**
 * Set fields of the register block, returning the document after the write. ⚠ A voided document takes
 * none: whatever comes back to it (a print that outlived its lease) reads it as it stands.
 */
export async function setRegister(id: unknown, set: Record<string, unknown>): Promise<any> {
  const $set = Object.fromEntries(Object.entries(set).map(([k, v]) => [`register.${k}`, v]))
  const written = await Invoice.findOneAndUpdate({ _id: id, status: { $ne: 'voided' } }, { $set }, { new: true }).lean().exec()
  return written ?? Invoice.findById(id).lean().exec()
}

/**
 * The documents whose money waits on what the device did: a request that died and cannot be proved is
 * held for a person, never booked and never printed again. R2's `payment_storno` joins this list.
 */
const HELD_WHEN_UNPROVED = ['payment_receipt', 'cash_storno']

/**
 * Hold a document that nothing can prove (FR-23): `unknown`, booking no money and printing nothing, a
 * receipt's amount still held on its invoice and a storno's claim still on its sale, until a person
 * settles it (`settleInDoubt`). Its lease goes, so it no longer reads as a request that died.
 */
export async function holdInDoubt(doc: any): Promise<any> {
  const held = await Invoice.findOneAndUpdate(
    { _id: doc._id, status: { $ne: 'voided' }, completedAt: { $exists: false } },
    { $set: { 'register.fiscal.state': 'unknown', 'register.fiscal.inDoubt': true, 'register.receiptError': IN_DOUBT }, $unset: { leaseUntil: 1 } },
    { new: true },
  ).lean().exec()
  return held ?? Invoice.findById(doc._id).lean().exec()
}

/** What cannot print at all: `failed` if it never reached the device, otherwise nothing can prove it and it is held. */
export function couldNotPrint(doc: any, reason: string): Promise<any> {
  return doc.register?.fiscal?.attemptedAt
    ? holdInDoubt(doc)
    : setRegister(doc._id, { 'fiscal.state': 'failed', 'fiscal.error': reason, receiptError: reason })
}

/**
 * A document whose request died, still `pending`, for the next person to touch it. ⚠ It NEVER prints:
 * whoever is at the counter now is doing something else. What proves anything, read in the device's
 * turn: it never reached the device, or the counter did not move and nothing is open. Those did not
 * print. Anything else, no device to ask included, is held for a person.
 */
export async function decideInterrupted(c: RegisterContext, doc: any, receiptError: string): Promise<void> {
  if (doc.register?.fiscal?.state !== 'pending') return
  const decide = async (fresh: any) => {
    const fiscal = fresh.register?.fiscal
    const neverPrinted = !fiscal?.attemptedAt
      || (!!c.printer && provedNotPrinted({ before: fiscal.counterBefore, ...(await readDevice(c.printer)) }))
    if (!neverPrinted) {
      logger.warn({ documentId: String(fresh._id), type: fresh.type }, 'Interrupted fiscal document cannot be proved either way — held for a person')
      return holdInDoubt(fresh)
    }
    logger.warn({ documentId: String(fresh._id), type: fresh.type }, 'Interrupted fiscal document did not print')
    return setRegister(fresh._id, { 'fiscal.state': 'failed', 'fiscal.error': receiptError, receiptError })
  }
  if (c.printer) await inTurn(c.printer, doc, decide)
  else await decide(doc)
}

/**
 * Give a keyed document its real number: it was inserted under `PENDING_NUMBER`. A number the
 * counter handed out twice is retried, as an unkeyed insert does. Null after three.
 */
export async function numberPending(orgId: string, doc: any): Promise<any | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const number = await getNextInvoiceNumber(orgId, 'outgoing', doc.type)
    try {
      // No match: already numbered (a resumed request got there first). Either way it is done.
      const numbered = await Invoice.findOneAndUpdate(
        { _id: doc._id, orgId, invoiceNumber: { $regex: `^${PENDING_NUMBER}` } },
        { $set: { invoiceNumber: number, numberHistory: [{ number, allocatedAt: new Date(), status: doc.status }] } },
        { new: true },
      ).lean().exec()
      return numbered ?? Invoice.findOne({ _id: doc._id, orgId }).lean().exec()
    } catch (e: any) {
      if (e?.code !== 11000) throw e
      logger.warn({ orgId, id: String(doc._id), number, attempt }, 'Cash-register number already taken, retrying')
    }
  }
  return null
}

/**
 * A fiscal document, printed at most once. `print` talks to the device and returns the receipt
 * number; this wraps it in the counter check and records the outcome on the document. Throws only
 * what `print` throws.
 *
 * - **First attempt:** store `attemptedAt` and the device's last document number, then print. If the
 *   print throws, what it left behind is decided here, in the turn (`afterFailedPrint`).
 * - **An interrupted attempt** (`attemptedAt` set, still `pending`): ask the device again, in a turn
 *   that is not the one the counter was read in. Nothing closed and nothing open → it did not print;
 *   print it (`provedNotPrinted`). ⚠ Anything else is never printed again, a counter moved by exactly
 *   one included: on a shared device that may be another document's receipt, and booked as this
 *   one's it hands a customer someone else's number, or refunds a storno the device never saw. A
 *   second fiscal receipt for one sale is the failure this exists to prevent, so the document goes
 *   `unknown` and the cashier checks the device. A payment's receipt and a storno are held for a person
 *   instead (`holdInDoubt`), because here the reading decides whether money is booked.
 */
async function printOnce(printer: RegisterPrinter, doc: any, print: () => Promise<string>): Promise<any> {
  const fiscal = doc.register?.fiscal || {}
  if (fiscal.attemptedAt) {
    const before = fiscal.counterBefore
    const { now, open } = await readDevice(printer)
    if (!provedNotPrinted({ before, now, open })) {
      logger.warn({ documentId: String(doc._id), before, now, open }, 'Interrupted fiscal receipt: device cannot confirm it — not reprinting')
      if (HELD_WHEN_UNPROVED.includes(doc.type)) return holdInDoubt(doc)
      return setRegister(doc._id, {
        'fiscal.state': 'unknown',
        receiptError: 'The receipt was interrupted and the device cannot confirm whether it printed. Check the device; do not ring the sale up again.',
      })
    }
    // Nothing closed and nothing open: it never printed. Print it.
  }

  // What an earlier document left open goes first, in this turn: closing it moves the counter, and
  // that is no print of this document. It touches nothing of this one, so it comes before the record.
  try {
    await printer.clearLeftovers?.()
  } catch (e: any) {
    return afterFailedPrint(printer, doc, undefined, Object.assign(e, { printStage: 'opening' }))
  }
  // The counter goes on the record BEFORE this document touches the device.
  const counterBefore = await printer.lastReceiptNumber().catch(() => undefined)
  await setRegister(doc._id, { 'fiscal.attemptedAt': new Date(), 'fiscal.counterBefore': counterBefore })
  await datedAsItPrints(doc)
  let receiptNo: string
  try {
    receiptNo = await print()
  } catch (e: any) {
    return afterFailedPrint(printer, doc, counterBefore, e)
  }
  return recordPrinted(doc, receiptNo)
}

/**
 * A payment's receipt says the moment it prints, whatever it said when it was written: it may have
 * waited its turn past midnight, or come back with its key the next morning, and the device, the
 * session and the row say one day. A till sale is written as it prints.
 */
async function datedAsItPrints(doc: any): Promise<void> {
  if (doc.type !== 'payment_receipt') return
  const now = new Date()
  await Invoice.updateOne({ _id: doc._id }, { $set: { issueDate: now, dueDate: now, paidAt: now, 'payments.0.date': now } }).exec()
}

/** What the device says now, as far as it can. */
export async function readDevice(printer: RegisterPrinter): Promise<{ now?: number; open?: boolean }> {
  const now = await printer.lastReceiptNumber().catch(() => undefined)
  const open = await printer.receiptOpen?.().catch(() => undefined)
  return { now, open }
}

/** What a receipt in doubt says: nothing was booked, and who does what next. */
const IN_DOUBT = 'The receipt was interrupted and nothing can prove whether it printed, so nothing was booked. Check the device, then settle it in the cash-register journal.'

/**
 * The receipt printed. ⚠ Its number only when the device gave one: a Tremol closes before it can be
 * asked, and 'unknown' stored as a number printed on an invoice as „ФБ № unknown". `warning`: it
 * printed through an error, and that stays on the document and in the answer.
 */
function recordPrinted(doc: any, receiptNo: string | undefined, warning?: { error: string; receiptError: string }): Promise<any> {
  const known = receiptNo && receiptNo !== 'unknown' ? String(receiptNo) : undefined
  return setRegister(doc._id, {
    'fiscal.state': 'printed', 'fiscal.printedAt': new Date(), printedAt: new Date(),
    ...(known ? { 'fiscal.receiptNo': known, fiscalReceiptNumber: known } : {}),
    ...(warning ? { 'fiscal.error': warning.error, receiptError: warning.receiptError } : {}),
  })
}

/**
 * A print threw. Still in the document's turn: get the receipt off the device, then read what is left
 * (`print-verdict.ts`). A receipt that may be real is never voided and never printed again.
 */
async function afterFailedPrint(printer: RegisterPrinter, doc: any, before: number | undefined, e: any): Promise<any> {
  // The driver would not send it. The device never saw it and is as it was, so nothing is abandoned,
  // nothing is read, and a healthy device is not marked in error.
  if (e?.printStage === 'refused') {
    logger.warn({ documentId: String(doc._id), error: e?.message }, 'Fiscal receipt refused before anything was sent')
    return setRegister(doc._id, { 'fiscal.state': 'failed', 'fiscal.error': e?.message, receiptError: e?.message })
  }
  const abandoned = await printer.abandonReceipt().catch(() => undefined)
  const { now, open } = await readDevice(printer)
  const verdict = verdictOfFailedPrint({ stage: e?.printStage, before, now, open, abandoned })
  logger.error({ documentId: String(doc._id), unp: doc.register?.unp, error: e?.message, stage: e?.printStage, before, now, open, verdict }, 'Fiscal receipt printing FAILED')
  // ⚠ `printed` stands, and the failure is not dropped: a driver that finishes a part-paid receipt
  // tenders the rest in cash, whatever LGR recorded, so the device's day may not read as the document.
  if (verdict === 'printed') {
    return recordPrinted(doc, String(now).padStart(7, '0'), {
      error: e?.message,
      receiptError: `The receipt printed, but the device reported a problem, so its payment types may differ from this document's. Check the device: ${e?.message}`,
    })
  }
  await printer.failed().catch(() => {})
  if (verdict === 'failed') return setRegister(doc._id, { 'fiscal.state': 'failed', 'fiscal.error': e?.message, receiptError: e?.message })
  return setRegister(doc._id, {
    'fiscal.state': 'unknown', 'fiscal.error': e?.message,
    receiptError: `The receipt may have printed, so it will not be printed again. Check the device: ${e?.message}`,
  })
}

/**
 * `step`, in the document's turn on the device, on the document as it stands when the turn comes: it
 * may have been given up, or finished by a retry, while it waited. Its lease is renewed throughout.
 */
export async function inTurn(printer: RegisterPrinter, doc: any, step: (fresh: any) => Promise<any>): Promise<any> {
  const stop = keepLease(Invoice, doc._id)
  try {
    return await printer.operation(async () => {
      const fresh: any = await Invoice.findById(doc._id).lean().exec()
      if (!fresh || fresh.status === 'voided' || fresh.register?.fiscal?.state !== 'pending') return fresh ?? doc
      return step(fresh)
    })
  } finally {
    stop()
  }
}

/** A device that never came free printed nothing. A resume could not ask it, so that one is unknown. */
async function printInTurn(printer: RegisterPrinter, doc: any, step: (fresh: any) => Promise<any>): Promise<any> {
  try {
    return await inTurn(printer, doc, step)
  } catch (e: any) {
    if (e?.code !== 'device_busy') throw e
    const state = doc.register?.fiscal?.attemptedAt ? 'unknown' : 'failed'
    return setRegister(doc._id, { 'fiscal.state': state, 'fiscal.error': e.message, receiptError: e.message })
  }
}

/** The sale's receipt: fiscal or text, at most once. */
export async function printSaleStep(c: RegisterContext, doc: any): Promise<any> {
  const printer = c.printer
  if (!printer) {
    return setRegister(doc._id, { 'fiscal.state': 'unknown', receiptError: 'The fiscal device is no longer connected — check whether the receipt printed.' })
  }
  if (doc.register?.fiscal?.mode === 'text') {
    if (!printer.printsText) {
      // A payment's receipt prints text because the device said so, and nobody has a switch for that.
      const receiptError = doc.type === 'payment_receipt'
        ? 'This fiscal device is not fiscalized and cannot print a text receipt, so the receipt was not printed.'
        : 'This fiscal device cannot print non-fiscal receipts — switch "Non-fiscal" off to issue a fiscal receipt.'
      return setRegister(doc._id, { 'fiscal.state': 'failed', 'fiscal.error': receiptError, receiptError })
    }
    // A text receipt has no legal weight: an interrupted one is simply printed again.
    await setRegister(doc._id, { 'fiscal.attemptedAt': new Date() })
    await datedAsItPrints(doc)
    try {
      await printer.printText(doc)
      await printer.reached()
      logger.info({ documentId: String(doc._id), number: doc.invoiceNumber }, 'Receipt printed (non-fiscal text mode)')
      return setRegister(doc._id, { 'fiscal.state': 'printed', 'fiscal.printedAt': new Date(), printedAt: new Date() })
    } catch (e: any) {
      await printer.abandonText().catch(() => {})
      logger.error({ documentId: String(doc._id), error: e?.message }, 'Receipt printing FAILED')
      await printer.failed().catch(() => {})
      return setRegister(doc._id, { 'fiscal.state': 'failed', 'fiscal.error': e?.message, receiptError: e?.message })
    }
  }
  return printOnce(printer, doc, async () => {
    const receiptNo = await printer.printSale(doc)
    await printer.reached()
    logger.info({ documentId: String(doc._id), unp: doc.register?.unp, receiptNo }, 'Fiscal receipt printed')
    return receiptNo
  })
}

/**
 * The session's money per bucket. Cash on delivery has its own: the courier collects it, so it is
 * never in the drawer, the close expects it without counting it, and it must not raise expected cash.
 */
interface SessionBuckets { cash: number; card: number; other: number; cashOnDelivery: number }
const bucketOf = (method: string): keyof SessionBuckets =>
  (method === 'cash' ? 'cash' : method === 'card' ? 'card' : method === 'cash_on_delivery' ? 'cashOnDelivery' : 'other')

/** What a document handed over per close bucket, as the request sent it: tendered, not kept. */
function tenderedBuckets(doc: any): SessionBuckets {
  const out: SessionBuckets = { cash: 0, card: 0, other: 0, cashOnDelivery: 0 }
  for (const p of doc.payments || []) out[bucketOf(p.method)] += Number(p.tendered ?? p.amount) || 0
  return out
}

/**
 * #145: how much of a storno's refund leaves each close bucket.
 *
 * With explicit refund `payments` (how the operator actually pays it back), those are summed.
 * Without them it mirrors the ORIGINAL sale: what it put in each bucket comes back out of it —
 * card and other as paid, cash as tendered minus the change it handed back, which is the very
 * amount the sale added to `totalCash`. Never negative.
 */
export function stornoRefundBuckets(
  payments: { method: string; amount: number }[] | undefined,
  original: { payments?: { method: string; amount: number }[]; changeDue?: number },
): SessionBuckets {
  const out: SessionBuckets = { cash: 0, card: 0, other: 0, cashOnDelivery: 0 }
  const source = payments?.length ? payments : original.payments || []
  for (const p of source) out[bucketOf(p.method)] += Number(p.amount) || 0
  if (!payments?.length) out.cash -= Number(original.changeDue) || 0
  return {
    cash: Math.max(0, round2(out.cash)),
    card: Math.max(0, round2(out.card)),
    other: Math.max(0, round2(out.other)),
    cashOnDelivery: Math.max(0, round2(out.cashOnDelivery)),
  }
}

/**
 * The session's accumulators — claimed and applied in one Mongo transaction, so never twice.
 *
 * ⚠ Never on a closed session: its report and its close are final, and money arriving there would be
 * posted a second time (the close counted the drawer that held it as cash over). The document stays
 * unclaimed, and the money is on the payment that follows, in no session.
 */
export async function applySessionTotals(doc: any, sessionId: string, inc: Record<string, number>): Promise<void> {
  const s = await Invoice.startSession()
  try {
    await s.withTransaction(async () => {
      const claimed = await Invoice.findOneAndUpdate(
        { _id: doc._id, 'register.sessionTotalsApplied': { $ne: true } },
        { $set: { 'register.sessionTotalsApplied': true } },
        { session: s },
      ).exec()
      if (!claimed) return
      const moved = await POSSession.updateOne({ _id: oid(sessionId), status: { $ne: 'closed' } }, { $inc: inc }, { session: s }).exec()
      if (moved.matchedCount) return
      logger.error({ documentId: String(doc._id), sessionId }, 'Money for a closed session: not added to it')
      await Invoice.updateOne({ _id: doc._id }, { $unset: { 'register.sessionTotalsApplied': 1 } }, { session: s }).exec()
    })
  } finally {
    await s.endSession()
  }
}

/** A sale's increments: the same buckets, and the same rule, the close screen reconciles. */
export function saleIncrements(doc: any): Record<string, number> {
  const t = tenderedBuckets(doc)
  const inc: Record<string, number> = { transactionCount: 1, totalSales: Number(doc.total) || 0 }
  // Change goes back out of the drawer in cash, so the drawer keeps what was tendered in cash
  // minus the change. Adding the tendered amount made the close expect money the till had already
  // handed back.
  const cashKept = roundCents(t.cash - (Number(doc.register?.changeDue) || 0))
  if (cashKept) inc.totalCash = cashKept
  if (t.card) inc.totalCard = t.card
  // FR-9.2: mobile/voucher were accepted per transaction but never summed.
  if (t.other) inc.totalOther = t.other
  if (t.cashOnDelivery) inc.totalCashOnDelivery = t.cashOnDelivery
  return inc
}

/** The document as `createInvoiceStockMovement` reads an invoice: an entity, with `id`. */
// A sale numbered after its stock (#279) still holds its placeholder here: the stock path's messages
// quote `invoiceNumber || id`, so they name the id rather than `~pending:…`.
const asInvoiceEntity = (doc: any) => ({
  ...doc, id: String(doc._id), orgId: String(doc.orgId),
  invoiceNumber: isPendingNumber(doc.invoiceNumber) ? '' : doc.invoiceNumber,
})

/**
 * The sale's dispatch, through the invoice path (D-7): the movement carries `invoiceId`, so FR-07
 * shows the sale's number and FR-11.10 sees a sale that moved nothing. A crash after the movement
 * was created finds it again by that id, and confirms it if it never was.
 */
async function moveSaleStock(c: RegisterContext, doc: any): Promise<string | undefined> {
  const r = getRepos()
  let moved: any[] = await StockMovement.find({ orgId: doc.orgId, invoiceId: doc._id, type: 'dispatch' }).lean().exec()
  // A copied sale an older release had dispatched under its note, before it recorded the movement.
  if (!moved.length && doc.register?.legacy?.transactionNumber) {
    const legacy: any = await StockMovement.findOne({ orgId: doc.orgId, type: 'dispatch', notes: `POS sale ${doc.register.legacy.transactionNumber}` }).lean().exec()
    if (legacy) {
      await StockMovement.updateOne({ _id: legacy._id, invoiceId: { $exists: false } }, { $set: { invoiceId: doc._id } }).exec()
      moved = [legacy]
    }
  }
  if (moved.length) {
    for (const m of moved) if (m.status === 'draft') await confirmMovement(String(m._id), r)
    return String(moved[0]._id)
  }
  await createInvoiceStockMovement(asInvoiceEntity(doc) as any, c.user.id, r, c.allowNegative ? { allowNegative: true } : undefined)
  const created: any = await StockMovement.findOne({ orgId: doc.orgId, invoiceId: doc._id, type: 'dispatch' }, { _id: 1 }).lean().exec()
  return created ? String(created._id) : undefined
}

/**
 * Whether a failure can still take the sale back (D-4): not once a receipt may have printed, nor
 * once the drawer has counted the money.
 */
function reachedDeviceOrDrawer(doc: any): boolean {
  const state = doc.register?.fiscal?.state
  return !!doc.register?.sessionTotalsApplied || state === 'pending' || state === 'printed' || state === 'unknown'
}

/** Remove a sale that failed before it reached the device or the drawer. */
export async function rollBack(doc: any): Promise<void> {
  await Invoice.deleteOne({ _id: doc._id, orgId: doc.orgId }).exec()
}

/**
 * Run whatever the sale has not done yet, then mark it complete. Refuses — after removing the
 * document — only what failed before the sale reached the device or the drawer.
 */
export async function runSaleSteps(c: RegisterContext, id: string): Promise<any> {
  let doc: any = await Invoice.findOne({ _id: oid(id), orgId: oid(c.orgId) }).lean().exec()
  if (!doc) throw new RegisterRefusal(404, { message: 'Cash-register document not found' })

  if (isPendingNumber(doc.invoiceNumber) && !numbersAfterStock(doc)) {
    const numbered = await numberPending(c.orgId, doc)
    if (!numbered) {
      await rollBack(doc)
      throw new RegisterRefusal(409, { message: 'Could not allocate the cash-register number after 3 attempts' })
    }
    doc = numbered
  }

  // The УНП is drawn AFTER the document exists, so of several requests racing on one key, only the
  // one whose insert won ever draws one.
  if (c.printer && doc.register?.fiscal?.mode === 'fiscal' && !doc.register?.unp) {
    doc = await setRegister(doc._id, { unp: await generateUNP(c.orgId, c.printer.deviceNumber, c.user.operatorCode as string) })
  }
  // One fiscal operation from the first command to the last, so a graceful stop cannot land
  // between "open receipt" and "close receipt" (FR-20.23).
  if (doc.register?.fiscal?.state === 'pending') {
    doc = c.printer ? await printInTurn(c.printer, doc, fresh => printSaleStep(c, fresh)) : await printSaleStep(c, doc)
  }

  const sessionId = doc.register?.sessionId ? String(doc.register.sessionId) : c.session?.id
  if (sessionId && !doc.register?.sessionTotalsApplied) {
    await applySessionTotals(doc, sessionId, saleIncrements(doc))
    doc = await Invoice.findById(doc._id).lean().exec()
  }

  if (!c.skipStock && !doc.register?.movementId && !doc.register?.stockError) {
    try {
      if (c.beforeStock) {
        await c.beforeStock(doc)
        doc = await Invoice.findById(doc._id).lean().exec()
      }
      const movementId = await moveSaleStock(c, doc)
      if (movementId) doc = await setRegister(doc._id, { movementId: oid(movementId) })
    } catch (e: any) {
      if (!reachedDeviceOrDrawer(doc)) {
        await rollBack(doc)
        if (e instanceof RegisterRefusal) throw e
        // Only a refusal of our own carries its status and code (a `PendingTransferError`, …): a
        // driver error's numeric code (E11000) and its raw message are no answer for a client.
        const own = typeof e?.code === 'string' && Number.isInteger(e?.statusCode) && e.statusCode >= 400 && e.statusCode < 500
        throw new RegisterRefusal(own ? e.statusCode : 400, own ? { code: e.code, message: e?.message } : { message: e?.message })
      }
      logger.error({ documentId: String(doc._id), error: e?.message }, 'Cash-register stock movement failed')
      doc = await setRegister(doc._id, { stockError: e?.message })
    }
  }

  // #279: a sessionless sale draws its number now that its stock is settled. Should the counter fail
  // three times (it hands a number out twice), the sale is undone as any failure before a device or a
  // drawer is (D-4): its dispatch reversed, the document removed. No number was lost.
  if (isPendingNumber(doc.invoiceNumber)) {
    const numbered = await numberPending(c.orgId, doc)
    if (!numbered) {
      if (doc.register?.movementId) await reverseInvoiceStockMovement(asInvoiceEntity(doc) as any, c.user.id, getRepos(), { allowNegative: true })
      await rollBack(doc)
      throw new RegisterRefusal(409, { message: 'Could not allocate the cash-register number after 3 attempts' })
    }
    doc = numbered
  }
  // Derived state only (the order counters a sale consumes), re-derived by every later write of
  // the order: a failure here must not leave a sale that moved its goods unfinished and unaudited.
  if (c.afterStock) {
    await c.afterStock(doc).catch((e: any) => logger.error({ documentId: String(doc._id), error: e?.message }, 'Cash-register afterStock failed'))
  }

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

/** The outcome of an insert: the new document, or the one a concurrent request with the key made. */
export type InsertOutcome = { inserted: any } | { existing: any }

/**
 * Insert a new cash-register document: under its key's placeholder when keyed, otherwise under
 * its number. A number the counter handed out twice is retried, as `POST /invoices` does.
 */
export async function insertRegisterDocument(
  orgId: string,
  document: Record<string, any>,
  keyed?: { key: string; hash: string },
): Promise<InsertOutcome> {
  // FR-20.81: refused before the insert, never at the number after it (a storno's caller gives its
  // claim back on any throw from here).
  const frozen = await issuableRefusal(orgId, 'outgoing', document.type)
  if (frozen) throw new RegisterRefusal(409, { code: frozen.code, message: frozen.message })
  let lastErr: any
  for (let attempt = 0; attempt < 3; attempt++) {
    // A keyed document waits under its key; a sessionless cash sale under its own id (#279), and
    // `runSaleSteps` numbers it after its stock.
    const number = keyed
      ? `${PENDING_NUMBER}${keyed.key}`
      : numbersLater(document) ? `${PENDING_NUMBER}doc:${String(document._id ?? (document._id = newDocumentId()))}` : await getNextInvoiceNumber(orgId, 'outgoing', document.type)
    const fields = {
      ...document,
      issueDate: document.issueDate ?? new Date(),
      dueDate: document.dueDate ?? document.issueDate ?? new Date(),
      invoiceNumber: number,
      numberHistory: [{ number, allocatedAt: new Date(), status: document.status }],
      ...(keyed ? { clientKey: keyed.key, requestHash: keyed.hash, leaseUntil: new Date(Date.now() + LEASE_MS) } : {}),
    }
    try {
      return { inserted: (await Invoice.create(fields)).toObject() }
    } catch (e: any) {
      lastErr = e
      if (e?.code !== 11000) throw e
      if (keyed) {
        // A racing duplicate of this keyed request won the insert. (Its placeholder number is unique
        // per key too, so a duplicate on EITHER index means the same request.)
        const existing = await Invoice.findOne({ orgId, clientKey: keyed.key }).lean().exec()
        if (existing) return { existing }
        throw e
      }
      logger.warn({ orgId, number, attempt }, 'Cash-register number already taken, retrying')
    }
  }
  throw new RegisterRefusal(409, { message: `Could not allocate the cash-register number after 3 attempts: ${lastErr?.message || 'duplicate'}` })
}

// ── Keyed retries ────────────────────────────────────────────────────────────

/**
 * A request whose key is already on a document: replay it, finish it, or wait for whoever is
 * finishing it. Never starts the sale a second time. Returns the document to answer with.
 *
 * `context` builds what resuming needs (the device, the session); it runs only when this request
 * takes the work over, and may refuse.
 */
export async function settleKeyedDocument(
  existing: any,
  hash: string,
  context: () => Promise<RegisterContext>,
  run: (c: RegisterContext, id: string) => Promise<any>,
): Promise<any> {
  try {
    assertSameRequest(existing.requestHash, hash)
  } catch (e: any) {
    if (e instanceof IdempotencyError) throw new RegisterRefusal(e.statusCode, { code: e.code, message: e.message })
    throw e
  }
  const orgId = String(existing.orgId)
  // Held for a person: nothing is left for a retry to do, and it takes no lease it would only leave behind.
  if (existing.completedAt || existing.register?.fiscal?.inDoubt) return existing
  for (let round = 0; round < 2; round++) {
    if (await takeLease(Invoice, orgId, existing._id)) return run(await context(), String(existing._id))
    const { doc, leaseLapsed } = await waitForCompletion(Invoice, orgId, existing._id)
    if (doc?.completedAt) return doc
    if (!leaseLapsed) break
  }
  throw new RegisterRefusal(409, { code: 'idempotency_in_progress', message: 'This request is still being processed — retry with the same Idempotency-Key.' })
}

// ── Storno (D-2, §3.5) ───────────────────────────────────────────────────────

/** Why a sale cannot be stornoed, or null when it can. */
export async function stornoRefusal(original: any): Promise<RegisterRefusal | null> {
  if (!original) return new RegisterRefusal(404, { message: 'Original transaction not found' })
  if (original.type === 'cash_storno') return new RegisterRefusal(400, { message: 'Cannot storno a storno transaction' })
  if (original.type !== 'cash_sale') return new RegisterRefusal(404, { message: 'Original transaction not found' })
  if (original.status !== 'paid') return new RegisterRefusal(400, { code: 'storno_not_paid', message: 'Only a completed sale can be stornoed' })
  if (original.register?.stornoState === 'full') {
    const held = await stornoInDoubtOf(original)
    return held ? new RegisterRefusal(409, stornoInDoubtRefusal(held)) : new RegisterRefusal(400, { message: 'Original transaction is already cancelled' })
  }
  // ⚠ Read as not printed it refunds with no storno on the device, which #281 forbids: a person says
  // first. Still `pending` it may be printing right now, and that is no sale to reverse either.
  if (saleInDoubt(original) || (original.register?.isFiscal && original.register?.fiscal?.state === 'pending')) {
    return new RegisterRefusal(409, {
      code: 'sale_receipt_in_doubt',
      receipt: { id: String(original._id), number: original.invoiceNumber },
      message: `Nothing can prove whether the receipt of sale ${original.invoiceNumber} printed, so a storno cannot say what it reverses. Nothing was reversed. Check the device, then settle it on its page in the cash-register journal.`,
    })
  }
  if (originOf(original) === 'import') {
    return new RegisterRefusal(409, {
      code: 'storno_imported_day',
      message: 'An imported till day is corrected by importing it again, not by a storno.',
    })
  }
  return invoicedRefusal(original)
}

/** The storno of this sale that a person has to settle, if there is one. The sale names its stornos. */
async function stornoInDoubtOf(original: any): Promise<any | null> {
  const ids = original.register?.stornoedBy ?? []
  if (!ids.length) return null
  return Invoice.findOne({ _id: { $in: ids }, orgId: original.orgId, type: 'cash_storno', 'register.fiscal.inDoubt': true }, { invoiceNumber: 1 }).lean().exec()
}

/**
 * What a storno that may have printed answers, the first time and every time after it: nothing was
 * reversed, a person looks at the device, and pressing again would print a second fiscal storno. A
 * 503 `fiscal_error` said "not printed", which nobody knows.
 */
export const stornoInDoubtRefusal = (storno: any) => ({
  code: 'storno_in_doubt',
  receipt: { id: String(storno._id), number: storno.invoiceNumber },
  message: `Storno ${storno.invoiceNumber} may have printed, and nothing was reversed. Check the device, then settle it on its page in the cash-register journal. Do not press storno again.`,
})

/**
 * D-14: a quantity is corrected once. An invoiced sale is corrected through its invoice (a credit
 * note returns the goods and counts negative); a storno on top would return them twice. An invoice
 * still being claimed (a `~pending:` draft) counts too.
 *
 * ⚠ Asked again AFTER `claimForStorno`: the invoice path writes its claim and then reads the sale's
 * `stornoState`, and the storno writes its claim and then reads the invoices. Of the two racing, at
 * least one sees the other. Read only before the claim, both could pass.
 */
export async function invoicedRefusal(original: any): Promise<RegisterRefusal | null> {
  const invoiced = await Invoice.exists({ orgId: original.orgId, 'cashSaleRef.cashSaleId': original._id, status: { $nin: ['voided', 'cancelled'] } }).exec()
  if (!invoiced) return null
  return new RegisterRefusal(409, {
    code: 'cash_sale_invoiced',
    message: 'An invoice was issued for this sale. Correct it with a credit note to that invoice, not a storno.',
  })
}

/** Where a cash sale came from, for documents written before `register.origin` existed. */
export function originOf(doc: any): RegisterOrigin {
  if (doc?.register?.origin) return doc.register.origin
  if ((doc?.tags || []).includes('cash-register-import') || /^salesAnalysis:/.test(doc?.reference || '')) return 'import'
  return 'backoffice'
}

/**
 * Whether the sale's receipt was a fiscal one, which its storno must reverse on the device. A device
 * that gave no number (a Tremol, which is busy printing when it could be asked) still printed one.
 */
export function printedFiscally(original: any): boolean {
  return !!original.register?.isFiscal && (!!original.register?.fiscalReceiptNumber || original.register?.fiscal?.state === 'printed')
}

export interface StornoInput {
  orgId: string
  user: RegisterUser
  original: any
  reason: string
  /** How the refund is paid back. Absent: as the sale was paid. */
  payments?: { method: string; amount: number; reference?: string }[]
  /** The session the refund leaves; a till sale's storno needs one in its own warehouse. */
  session: RegisterSession | null
  /** Whether a storno receipt prints: the sale's was fiscal and the device is there. */
  printsReceipt: boolean
  printer: RegisterPrinter | null
}

/** The storno document of a sale: positive amounts, the sign is the type (D-2). */
export function stornoDocument(input: StornoInput): Record<string, any> {
  const { original, session, user, printer, printsReceipt } = input
  const reg = original.register || {}
  const now = new Date()
  // The refund as the operator pays it back, or as the sale was paid: what it KEPT per method (the
  // change it handed back stays handed back). A back-office sale may carry no payment rows; its
  // header method then names the whole total, as the journal reads it.
  const paid = input.payments?.length
    ? input.payments
    : original.payments?.length
      ? original.payments
      : [{ method: original.paymentMethod || 'cash', amount: original.total }]
  const refund = paid.map((p: any) => ({ date: now, method: p.method, amount: round2(p.amount), ...(p.reference ? { reference: p.reference } : {}) }))
  const methods = [...new Set(refund.map((p: any) => p.method))]
  const warehouseId = session?.warehouseId ?? reg.warehouseId ?? (original.lines || []).find((l: any) => l.warehouseId)?.warehouseId
  return {
    orgId: original.orgId,
    type: 'cash_storno',
    direction: 'outgoing',
    status: 'paid',
    statusHistory: [{ status: 'paid', changedAt: now, changedBy: oid(user.id), reason: 'cash_register_storno' }],
    contactId: original.contactId,
    issueDate: now,
    dueDate: now,
    currency: original.currency,
    exchangeRate: original.exchangeRate,
    lines: (original.lines || []).map(({ _id, cashSaleLineId, ...l }: any) => l),
    subtotal: original.subtotal,
    discountTotal: original.discountTotal || 0,
    taxTotal: original.taxTotal || 0,
    total: original.total,
    totalBase: original.totalBase,
    amountPaid: original.total,
    amountDue: 0,
    paidAt: now,
    payments: refund,
    ...(methods.length === 1 ? { paymentMethod: methods[0] } : {}),
    relatedInvoiceId: original._id,
    // Unkeyed too: a storno nobody finished is found by this lapsing (`interruptedDocuments`).
    leaseUntil: new Date(now.getTime() + LEASE_MS),
    billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
    attachments: [],
    register: {
      origin: originOf(original) === 'pos' ? 'pos' : 'backoffice',
      ...(session ? { sessionId: oid(session.id) } : {}),
      ...(warehouseId ? { warehouseId: oid(warehouseId) } : {}),
      cashierId: session?.cashierId ? oid(session.cashierId) : oid(user.id),
      ...(printsReceipt && printer ? { fiscalDeviceNumber: printer.deviceNumber } : {}),
      ...(user.operatorCode ? { operatorCode: user.operatorCode } : {}),
      isFiscal: printsReceipt,
      fiscal: printsReceipt ? { state: 'pending', mode: 'fiscal' } : { state: 'none' },
      changeDue: 0,
      storno: {
        originalId: original._id,
        ...(reg.unp ? { originalUnp: reg.unp } : {}),
        ...(reg.fiscalReceiptNumber ? { originalReceiptNumber: reg.fiscalReceiptNumber } : {}),
        // The moment of the sale, which the storno receipt cites, as the till always printed it.
        originalDate: original.createdAt ?? original.issueDate,
        reason: input.reason,
      },
    },
    createdBy: oid(user.id),
  }
}

/**
 * Claim the sale for its storno, atomically. Read-then-write let two clicks (or two tills) both pass
 * an "is it stornoed?" check and refund the same sale twice. Exactly one caller wins this update.
 *
 * ⚠ The claim has no lease and nothing lapses it. Only `releaseStornoClaim` gives the sale back, and only
 * for a storno proved not to have printed, or settled so by a person. The lease on the storno document
 * says who is working on that document, and takes nothing over from the sale.
 */
export async function claimForStorno(original: any, stornoId: ObjectId): Promise<boolean> {
  const claimed = await Invoice.findOneAndUpdate(
    { _id: original._id, orgId: original.orgId, type: 'cash_sale', status: 'paid', 'register.stornoState': { $ne: 'full' } },
    { $set: { 'register.stornoState': 'full', 'register.cancelledAt': new Date() }, $push: { 'register.stornoedBy': stornoId } },
    { new: true },
  ).exec()
  return !!claimed
}

/**
 * Give the sale back: its storno never happened.
 *
 * ⚠ Only while THIS storno holds the claim. A storno whose receipt failed released the sale long
 * ago if its retry arrives after another storno claimed it; an unconditional release would hand
 * that one's claim back too, and a third storno could then refund the sale twice.
 */
export async function releaseStornoClaim(original: any, stornoId: unknown): Promise<void> {
  await Invoice.updateOne(
    { _id: original._id, orgId: original.orgId, 'register.stornoedBy': oid(stornoId) },
    { $set: { 'register.stornoState': 'none' }, $pull: { 'register.stornoedBy': oid(stornoId) }, $unset: { 'register.cancelledAt': 1 } },
  ).exec()
}

/**
 * The storno's return (D-7): the goods go back where they left from, at the cost they left at.
 *
 * The till restocked at the SALE price, which pulled `avgCost` towards the selling price. The
 * original dispatch recorded what each line cost when it left (`resolvedUnitCost`); the return
 * brings it back at that, through `confirmMovement` like every movement. If the sale moved no stock,
 * neither does its storno. A crash after the return was created finds it again by the storno's id.
 */
async function returnStornoStock(c: RegisterContext, storno: any, original: any): Promise<string | undefined> {
  const r = getRepos()
  const existing: any[] = await StockMovement.find({ orgId: storno.orgId, invoiceId: storno._id, type: 'return' }).lean().exec()
  if (existing.length) {
    for (const m of existing) if (m.status === 'draft') await confirmMovement(String(m._id), r)
    return String(existing[0]._id)
  }
  const dispatches: any[] = await StockMovement.find({
    orgId: original.orgId, invoiceId: original._id, type: 'dispatch', status: 'completed',
  }).lean().exec()
  let first: string | undefined
  for (const d of dispatches) {
    const lines = (d.lines || []).map((l: any) => {
      const unitCost = Number(l.resolvedUnitCost ?? l.unitCost) || 0
      return { productId: l.productId, quantity: l.quantity, unitCost, totalCost: round2(unitCost * l.quantity) }
    })
    if (!lines.length) continue
    const movement = await createNumberedMovement(r, String(storno.orgId), {
      type: 'return',
      status: 'draft',
      date: new Date(),
      toWarehouseId: d.fromWarehouseId,
      ...(storno.contactId ? { contactId: storno.contactId } : {}),
      invoiceId: storno._id,
      lines,
      totalAmount: round2(lines.reduce((s: number, l: any) => s + l.totalCost, 0)),
      notes: `Storno ${storno.invoiceNumber} of ${original.invoiceNumber}`,
      createdBy: c.user.id,
    })
    await confirmMovement(movement.id, r)
    first ??= movement.id
  }
  return first
}

/**
 * A storno whose request died, for the next person to touch it: its sale's next storno, or its
 * session's close. It prints nothing. What it can prove goes on as proved; anything else is held.
 */
export async function finishInterruptedStorno(c: RegisterContext, doc: any): Promise<any> {
  await decideInterrupted(c, doc, 'The storno was interrupted before its receipt printed.')
  return runStornoSteps({ ...c, printer: null }, String(doc._id))
}

/**
 * Run whatever the storno has not done yet, then mark it complete.
 *
 * ⚠ #145: nothing is refunded until the device's answer is known.
 * - **`failed`**, proved to have left nothing: the sale is given back, the storno is voided, and the
 *   operator is told to retry.
 * - **`unknown`** may be on the device, so it is neither of those: it keeps its claim on the sale, books
 *   no refund, no stock and no session totals, and is held (`holdInDoubt`). Voided and given back, the
 *   next press printed a second fiscal storno. A person settles it (`settleInDoubt`).
 */
export async function runStornoSteps(c: RegisterContext, id: string): Promise<any> {
  let doc: any = await Invoice.findOne({ _id: oid(id), orgId: oid(c.orgId) }).lean().exec()
  if (!doc) throw new RegisterRefusal(404, { message: 'Storno not found' })
  const original: any = await Invoice.findOne({ _id: doc.relatedInvoiceId, orgId: doc.orgId }).lean().exec()
  if (!original) throw new RegisterRefusal(404, { message: 'Original transaction not found' })
  // A person's to settle: nothing more happens to it here, whoever comes back to it.
  if (doc.register?.fiscal?.inDoubt) return doc

  if (isPendingNumber(doc.invoiceNumber)) {
    const numbered = await numberPending(c.orgId, doc)
    if (!numbered) {
      // Past its print it stands, under its placeholder, for the next touch. Before it, it never was.
      if (doc.register?.fiscal?.state === 'pending' || doc.register?.fiscal?.state === 'none') {
        await releaseStornoClaim(original, doc._id)
        await rollBack(doc)
      }
      throw new RegisterRefusal(409, { message: 'Could not allocate the cash-register number after 3 attempts' })
    }
    doc = numbered
  }

  if (doc.register?.fiscal?.state === 'pending') {
    if (c.printer && !doc.register?.unp) {
      doc = await setRegister(doc._id, { unp: await generateUNP(c.orgId, c.printer.deviceNumber, c.user.operatorCode as string) })
    }
    if (!c.printer) {
      doc = await couldNotPrint(doc, 'The fiscal device is no longer connected, so the storno was not printed.')
    } else {
      const printer = c.printer
      doc = await printInTurn(printer, doc, async (fresh) => {
        // In the turn, as a receipt does: a close finds this storno, or this storno finds the close.
        // A refund that prints after the Z leaves a drawer that was already counted.
        if (fresh.register?.sessionId && !(await POSSession.exists({ _id: fresh.register.sessionId, status: 'open' }).exec())) {
          return couldNotPrint(fresh, 'The session closed before this storno could print.')
        }
        return printOnce(printer, fresh, async () => {
          const receiptNo = await printer.printStorno(fresh, original)
          await printer.reached()
          logger.info({ documentId: id, unp: fresh.register?.unp, receiptNo }, 'Storno fiscal receipt printed')
          return receiptNo
        })
      })
    }
  }

  if (doc.register?.fiscal?.state === 'unknown') return holdInDoubt(doc)
  if (doc.register?.fiscal?.state === 'failed') {
    await releaseStornoClaim(original, doc._id)
    const now = new Date()
    const voided: any = await Invoice.findOneAndUpdate(
      { _id: doc._id, completedAt: { $exists: false } },
      {
        $set: { status: 'voided', 'register.cancelledAt': now, completedAt: now },
        $push: { statusHistory: { status: 'voided', fromStatus: 'paid', changedAt: now, changedBy: oid(c.user.id), reason: 'storno_receipt_not_printed' } },
        $unset: { leaseUntil: 1 },
      },
      { new: true },
    ).lean().exec()
    return voided ?? Invoice.findById(doc._id).lean().exec()
  }

  const sessionId = doc.register?.sessionId ? String(doc.register.sessionId) : undefined
  if (sessionId && !doc.register?.sessionTotalsApplied) {
    // H1 + #145: the refund leaves the drawer by the method it is paid out in, so the close screen
    // expects what is actually left — the same buckets as a sale, reversed. The storno's payments
    // are the refund: the operator's, or what the sale kept (cash tendered minus its change).
    const refund = stornoRefundBuckets(doc.payments, {})
    const inc: Record<string, number> = { totalReturns: Number(original.total) || 0, transactionCount: 1 }
    if (refund.cash) inc.totalCash = -refund.cash
    if (refund.card) inc.totalCard = -refund.card
    if (refund.other) inc.totalOther = -refund.other
    if (refund.cashOnDelivery) inc.totalCashOnDelivery = -refund.cashOnDelivery
    await applySessionTotals(doc, sessionId, inc)
    doc = await Invoice.findById(doc._id).lean().exec()
  }

  if (!doc.register?.movementId && !doc.register?.stockError) {
    try {
      const movementId = await returnStornoStock(c, doc, original)
      if (movementId) doc = await setRegister(doc._id, { movementId: oid(movementId) })
    } catch (e: any) {
      logger.error({ documentId: id, error: e?.message }, 'Storno stock return failed')
      doc = await setRegister(doc._id, { stockError: e?.message })
    }
  }

  const done: any = await Invoice.findOneAndUpdate(
    { _id: doc._id, completedAt: { $exists: false } },
    { $set: { completedAt: new Date() }, $unset: { leaseUntil: 1 } },
    { new: true },
  ).lean().exec()
  if (done) {
    createAuditEntry({
      orgId: c.orgId, userId: c.user.id, operatorCode: c.user.operatorCode, action: 'storno', module: c.audit.module,
      entityType: c.audit.entityType, entityId: String(done._id),
      entityName: `${done.invoiceNumber} (storno of ${original.invoiceNumber})`, unpNumber: done.register?.unp,
    })
  }
  return done ?? Invoice.findById(doc._id).lean().exec()
}

