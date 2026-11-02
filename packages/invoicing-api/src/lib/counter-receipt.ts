/**
 * FR-23 R1 — the door of a payment's fiscal receipt: what `/send` and `/payments` share.
 *
 * `services/biz/cash-register/payment-receipt.service.ts` runs the receipt's steps; this finds what
 * they need that only a door with a device has, and refuses what cannot print BEFORE anything is
 * written: no number, no УНП, no stock, no claim on a draft (§2.3).
 *
 *   the switch → the document → the open session → its device → the tender → the money per rate
 *
 * There is ONE switch, the printer gate's (`settings.cashRegister.requireConnectedDevice`, #390).
 * Off, LGR prints nothing and nothing here runs: cash invoices behave exactly as they always did,
 * `syncCashSettlement` included.
 *
 * ⚠ `prepareReceipt` is called by a person's request only. The import conversion never comes this
 * way, and an imported document that a person issues or pays by hand is refused by
 * `printsAtCounter`: another system printed its receipt.
 */
import { Invoice } from 'db/models'
import { outstandingOf } from 'services/biz/invoice-payment'
import { MONEY_DOCUMENT_TYPES } from 'services/biz/cash-register/pos-union'
import {
  paymentReceiptDocument, printsAtCounter, receiptsOf, runReceiptSteps,
  type ReceiptTender,
} from 'services/biz/cash-register/payment-receipt.service'
import { receiptBody } from 'services/biz/cash-register/receipt-lines'
import { receiptMode } from 'services/biz/cash-register/receipt-mode'
import {
  RegisterRefusal, insertRegisterDocument, settleKeyedDocument, type RegisterContext, type RegisterUser,
} from 'services/biz/cash-register/register.service'
import { licenceRefusal } from 'services/biz/licence/master-licence.service'
import { PRINTER_GATE_SWITCH, assertPrinterConnected, assertSaleMayOpen, assertTillTender, documentContext, openSessionOf, tillContext, tillSettings } from './cash-register-till.js'

export interface PreparedReceipt {
  context: RegisterContext
  tender: ReceiptTender
  /** The whole document, paid as it is issued: its lines print, not a line per VAT rate. */
  whole: boolean
  /** Its receipts so far, which the next one's split per rate is what is left of. */
  receipts: any[]
}

const NOT_PRINTABLE = (message: string) => new RegisterRefusal(422, { code: 'receipt_not_printable', message })

/** Whether the document still carries the number of a draft, whatever a payment did to its status. */
const underDraftNumber = (doc: any) => doc.status === 'draft' || doc.numberHistory?.at(-1)?.status === 'draft'

/**
 * What printing a receipt for `tender` on `doc` takes, every check done; null when nothing prints.
 * Throws the refusal, before anything is written, when something should print and cannot.
 */
export async function prepareReceipt(orgId: string, user: RegisterUser, doc: any, tender: ReceiptTender, atIssue: boolean): Promise<PreparedReceipt | null> {
  if (!printsAtCounter(doc, tender.method, atIssue)) return null
  const settings = await tillSettings(orgId)
  if (!settings.requireConnectedDevice) return null

  // FR-20.55: under an expired licence a session opens for the money of what already exists. A
  // document started since prints nothing: a debit note is what is left to write, and whatever its
  // lines say, its receipt would be a new sale on the device.
  const unlicensed = await licenceRefusal(orgId, 'a fiscal receipt for a new document', doc.createdAt ?? new Date(0))
  if (unlicensed) throw new RegisterRefusal(402, unlicensed)

  const receipts = await receiptsOf(orgId, String(doc._id ?? doc.id))
  // The money a courier brings for a cash-on-delivery invoice is on its receipt, which took all that
  // was owed when it printed. A second receipt would book the sale on the device twice.
  if (receipts.some(r => r.paymentMethod === 'cash_on_delivery')) return null

  // The API takes a payment on a draft, which turns it `partially_paid` under its draft number. A
  // receipt names the invoice's number, and such a document has none: it was never issued.
  if (!atIssue && underDraftNumber(doc)) {
    throw new RegisterRefusal(422, { code: 'document_not_issued', message: 'Issue this document first: its receipt names its number.' })
  }

  const session = await openSessionOf(orgId, user.id)
  if (!session) {
    throw new RegisterRefusal(409, {
      code: 'fiscal_device_not_connected',
      noSession: true,
      message: `Open a session at the till first: a payment at the counter prints its receipt on that session's device. ${PRINTER_GATE_SWITCH}`,
    })
  }
  const context = await tillContext(orgId, user, session, { needsOperator: false })
  await assertPrinterConnected(orgId, String(session.warehouseId), context)
  // A fiscal receipt names its operator, and a text one does not, as a text sale does not. Only for
  // who has no code is the device asked here, so that it is refused before anything is written. The
  // turn asks again, and decides: a device that cannot say counts as fiscal.
  if (!user.operatorCode && (await receiptMode(context.printer!).catch(() => 'fiscal')) === 'fiscal') {
    throw new RegisterRefusal(400, { message: 'User has no operator code. Contact admin to assign one before using POS with fiscal device.' })
  }
  assertTillTender([tender], tender.amount, context.printer)
  await assertSaleMayOpen(orgId, session.warehouseId)

  const currency = session.currency || settings.baseCurrency
  if (doc.currency && currency && doc.currency !== currency) {
    throw new RegisterRefusal(422, {
      code: 'receipt_currency',
      message: `The session's device prints in ${currency}, and this document is in ${doc.currency}.`,
    })
  }
  const whole = atIssue && !(Number(doc.amountPaid) > 0)
  if (!receiptBody({ doc, amount: tender.amount, whole, printsText: !!context.printer?.printsFiscalText, receipts, nameMax: context.printer?.lineNameMax })) {
    throw NOT_PRINTABLE('This document\'s money cannot be split per VAT rate: a rate with a negative total does not print.')
  }
  return { context, tender, whole, receipts }
}

/** The receipt a document issued in cash, by card or on delivery takes: all it still owes. */
export function prepareIssueReceipt(orgId: string, user: RegisterUser, doc: any): Promise<PreparedReceipt | null> {
  const amount = outstandingOf(doc)
  if (amount <= 0) return Promise.resolve(null)
  return prepareReceipt(orgId, user, doc, { method: doc.paymentMethod, amount, date: new Date() }, true)
}

/**
 * Print it: the document, then its steps. `doc` is the document as stored now, under the number its
 * receipt names. A racing duplicate of a keyed request answers as the one that won.
 */
export async function printReceipt(orgId: string, prepared: PreparedReceipt, doc: any, keyed?: { key: string; hash: string }): Promise<any> {
  const { context: c, tender, whole, receipts } = prepared
  const body = receiptBody({ doc, amount: tender.amount, whole, printsText: !!c.printer?.printsFiscalText, receipts, nameMax: c.printer?.lineNameMax })
  if (!body) throw NOT_PRINTABLE('This document\'s money cannot be split per VAT rate.')
  const document = paymentReceiptDocument({ invoice: doc, body, tender, session: c.session!, user: c.user, printer: c.printer! })
  const outcome = await insertRegisterDocument(orgId, document, keyed)
  if ('existing' in outcome) return settleKeyedDocument(outcome.existing, keyed!.hash, async () => c, (ctx, id) => runReceiptSteps(ctx, id))
  return runReceiptSteps(c, String(outcome.inserted._id))
}

/** The receipt a keyed request already made: replay it, finish it, or wait for it. */
export function settleKeyedReceipt(orgId: string, user: RegisterUser, receipt: any, hash: string): Promise<any> {
  return settleKeyedDocument(receipt, hash, () => documentContext(orgId, user, receipt), (c, id) => runReceiptSteps(c, id))
}

/** The receipt holding this key, if a request with it already made one; or the first storno of a refund. */
export async function keyedReceipt(orgId: string, key: string): Promise<any | null> {
  // ⚠ `$type` is what reaches the partial index: on an equality alone the planner cannot prove its
  // filter, and walks the org's documents by another index.
  return Invoice.findOne({ orgId, clientKey: { $eq: key, $type: 'string' }, type: { $in: MONEY_DOCUMENT_TYPES } }).lean().exec()
}

/** What an answer says about the receipt: its identity, and the doubt, when there is one. */
export function receiptOutcome(doc: any) {
  const reg = doc?.register || {}
  return {
    receipt: {
      id: String(doc._id),
      number: doc.invoiceNumber,
      state: reg.fiscal?.state,
      ...(reg.unp ? { unp: reg.unp } : {}),
      ...(reg.fiscalReceiptNumber ? { receiptNumber: reg.fiscalReceiptNumber } : {}),
    },
    ...(reg.receiptError ? { receiptError: reg.receiptError } : {}),
  }
}
