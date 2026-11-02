/**
 * FR-23 R2 — the door of a refund's storno: what `/send` and `/payments` share for a credit note, as
 * `counter-receipt.ts` is for an invoice.
 *
 * `services/biz/cash-register/payment-receipt.service.ts` runs a storno's steps, the receipt's own, and
 * `refund-budget.ts` says what a receipt still holds. This finds what they need that only a door with a
 * device has, and refuses what cannot print BEFORE anything is written: no number, no УНП, no stock, no
 * claim on a draft (§2.3).
 *
 *   the switch → who may → the receipts behind it → the open session → its device → the tender → the
 *   money per rate, on what this device can reverse
 *
 * A refund larger than any one receipt's remainder prints one storno per receipt it draws on (§2.5). Each
 * has its own key, derived from the request's, so a retry finds what the first attempt printed and goes
 * on from there with what is left to give back: nothing prints twice and no plan has to survive a crash.
 */
import { Invoice } from 'db/models'
import { outstandingOf } from 'services/biz/invoice-payment'
import { PAYMENT_STORNO } from 'services/biz/cash-register/pos-union'
import {
  PAYMENT_IN_PROGRESS, citeableElsewhere, citeableOn, doubtRefusal, exceedsReceipts, inDoubtRefusal, noReceiptToStorno, onOtherDevice, paymentStornoDocument,
  printsRefund, receiptInDoubt, receiptsOf, refundBacking, refundNeed, runReceiptSteps, type ReceiptTender,
} from 'services/biz/cash-register/payment-receipt.service'
import { drawOn, holdEnough } from 'services/biz/cash-register/refund-budget'
import { receiptMode, type ReceiptMode } from 'services/biz/cash-register/receipt-mode'
import {
  RegisterRefusal, insertRegisterDocument, type RegisterContext, type RegisterUser,
} from 'services/biz/cash-register/register.service'
import { PRINTER_GATE_SWITCH, STORNO_ROLES, assertPrinterConnected, assertSaleMayOpen, assertTillTender, finishInterruptedDocuments, openSessionOf, tillContext, tillSettings } from './cash-register-till.js'
import { settleKeyedReceipt } from './counter-receipt.js'

export interface PreparedRefund {
  context: RegisterContext
  tender: ReceiptTender
  mode: ReceiptMode
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100

/** One request, one key per storno. The first keeps the request's: that is what a retry finds first. */
const partKey = (key: string, index: number) => (index ? `${key}#${index + 1}` : key)

/** Why what stands behind this note cannot back a refund of `amount` on this device, or null when it can. */
async function assertBacked(orgId: string, note: any, amount: number, deviceNumber: string, mode: ReceiptMode): Promise<void> {
  const backing = await refundBacking(orgId, note)
  const citeable = citeableOn(backing.cited, deviceNumber, mode, note.currency)
  const need = refundNeed(note, await receiptsOf(orgId, String(note._id)), amount)
  if (!need) {
    throw new RegisterRefusal(422, { code: 'receipt_not_printable', message: 'This document\'s money cannot be split per VAT rate: a rate with a negative total does not print.' })
  }
  if (holdEnough(need, citeable)) return
  // What is unresolved on the invoice may be the money this needs, and it has a way out of its own.
  if (backing.doubt) throw doubtRefusal(backing.doubt)
  if (backing.printing) throw new RegisterRefusal(409, { ...PAYMENT_IN_PROGRESS })
  if (citeable.length) throw exceedsReceipts(citeable, need)
  const elsewhere = citeableElsewhere(backing.cited, deviceNumber)
  throw elsewhere.length ? onOtherDevice(elsewhere) : noReceiptToStorno()
}

/**
 * What printing a storno for `tender` on `note` takes, every check done; null when nothing prints.
 * Throws the refusal, before anything is written, when something should print and cannot.
 */
export async function prepareRefund(orgId: string, user: RegisterUser & { role?: string }, note: any, tender: ReceiptTender, atIssue: boolean): Promise<PreparedRefund | null> {
  if (!printsRefund(note, tender.method)) return null
  const settings = await tillSettings(orgId)
  if (!settings.requireConnectedDevice) return null

  // H4: a storno door, and those who may reverse a sale are those who may use one. A storno at the
  // till needs a manager, and a credit note must not be the way round that.
  if (!user.role || !STORNO_ROLES.includes(user.role)) {
    throw new RegisterRefusal(403, { code: 'refund_requires_manager', message: 'A refund on a storno receipt requires manager or admin authorization' })
  }

  // The API takes a payment on a draft. A storno names the credit note's number, and a draft has none.
  if (!atIssue && (note.status === 'draft' || note.numberHistory?.at(-1)?.status === 'draft')) {
    throw new RegisterRefusal(422, { code: 'document_not_issued', message: 'Issue this document first: its storno names its number.' })
  }

  // ⚠ A storno of this note nothing can prove: it may have printed, nobody has said, and pressing again
  // is how a device ends up with two. Refused whatever the amount, even one that would fit beside it.
  const held = await receiptInDoubt(orgId, String(note._id))
  if (held) throw new RegisterRefusal(409, inDoubtRefusal(held))

  // What a request that died left on the invoice comes first: its receipt may have taken that money.
  // It prints nothing, and books nothing it cannot prove.
  if (note.relatedInvoiceId) await finishInterruptedDocuments(orgId, user, String(note.relatedInvoiceId))

  // Nothing to reverse, whoever asks and wherever: said before anyone is sent to open a session.
  const backing = await refundBacking(orgId, note)
  if (!backing.cited.length) {
    if (backing.doubt) throw doubtRefusal(backing.doubt)
    if (backing.printing) throw new RegisterRefusal(409, { ...PAYMENT_IN_PROGRESS })
    throw noReceiptToStorno()
  }

  const session = await openSessionOf(orgId, user.id)
  if (!session) {
    throw new RegisterRefusal(409, {
      code: 'fiscal_device_not_connected',
      noSession: true,
      message: `Open a session at the till first: a refund at the counter prints its storno on that session's device. ${PRINTER_GATE_SWITCH}`,
    })
  }
  const context = await tillContext(orgId, user, session, { needsOperator: false })
  await assertPrinterConnected(orgId, String(session.warehouseId), context)
  const printer = context.printer!
  assertTillTender([tender], tender.amount, printer)
  await assertSaleMayOpen(orgId, session.warehouseId)
  // The device says how it prints (`receiptMode`). A device that cannot say counts as fiscal here and
  // is asked again in the storno's turn, where it decides.
  const mode = await receiptMode(printer).catch((): ReceiptMode => 'fiscal')
  if (!user.operatorCode && mode === 'fiscal') {
    throw new RegisterRefusal(400, { message: 'User has no operator code. Contact admin to assign one before using POS with fiscal device.' })
  }

  const currency = session.currency || settings.baseCurrency
  if (note.currency && currency && note.currency !== currency) {
    throw new RegisterRefusal(422, { code: 'receipt_currency', message: `The session's device prints in ${currency}, and this document is in ${note.currency}.` })
  }
  await assertBacked(orgId, note, tender.amount, printer.deviceNumber, mode)
  return { context, tender, mode }
}

/** What a credit note issued in cash or by card gives back: all of it. */
export function prepareIssueRefund(orgId: string, user: RegisterUser & { role?: string }, note: any): Promise<PreparedRefund | null> {
  const amount = outstandingOf(note)
  if (amount <= 0) return Promise.resolve(null)
  return prepareRefund(orgId, user, note, issueTender(note), true)
}

/** The tender of a refund at issue, and of its retry. */
export const issueTender = (note: any): ReceiptTender => ({ method: note.paymentMethod, amount: outstandingOf(note), date: new Date() })

/** The storno holding this key, if a request with it already made one. */
const keyedStorno = (orgId: string, key: string): Promise<any | null> =>
  // ⚠ `$type` is what reaches the partial index (`keyedReceipt`).
  Invoice.findOne({ orgId, clientKey: { $eq: key, $type: 'string' }, type: PAYMENT_STORNO }).lean().exec()

/** Whether this storno gave its money back, so the next part may go on. */
const gaveMoney = (storno: any) => storno.status !== 'voided' && storno.register?.fiscal?.state === 'printed' && !storno.register?.fiscal?.inDoubt

/**
 * The refund: as many stornos as it draws on, in order, each its own steps. A retry under the key finds
 * what the first attempt made, finishes or replays it, and goes on with what is left. `prepared` is what
 * the door already checked; a retry that has parts still to print checks them here. Stops at the first
 * that did not give its money back: what printed stands, and the answer says so. Each part gives back
 * at least a cent, or nothing holds any and it is refused, so this ends.
 */
export async function refund(
  orgId: string,
  user: RegisterUser & { role?: string },
  note: any,
  tender: ReceiptTender,
  prepared: PreparedRefund | null,
  keyed?: { key: string; hash: string },
): Promise<any[]> {
  const stornos: any[] = []
  let remaining = Math.round(tender.amount * 100)
  let ready = prepared
  try {
    for (let index = 0; remaining > 0; index++) {
      const key = keyed ? partKey(keyed.key, index) : undefined
      const existing = key ? await keyedStorno(orgId, key) : null
      let storno: any
      if (existing) {
        storno = await settleKeyedReceipt(orgId, user, existing, keyed!.hash)
      } else {
        const amount = round2(remaining / 100)
        ready ??= await prepareRefund(orgId, user, note, { ...tender, amount }, false)
        if (!ready) return stornos
        storno = await nextPart(orgId, ready, note, amount, key ? { key, hash: keyed!.hash } : undefined, user)
      }
      stornos.push(storno)
      if (!gaveMoney(storno)) return stornos
      remaining -= Math.round((Number(storno.total) || 0) * 100)
    }
  } catch (e) {
    // A later part refused, a race for what a receipt held: what printed before it stands, and says so.
    if (e instanceof RegisterRefusal && stornos.length) e.body.refunded = refundedBy(stornos)
    throw e
  }
  return stornos
}

/** One storno: the next part of the refund, on what the receipts hold as this reads them. */
async function nextPart(orgId: string, prepared: PreparedRefund, note: any, amount: number, keyed: { key: string; hash: string } | undefined, user: RegisterUser): Promise<any> {
  const c = prepared.context
  const printer = c.printer!
  const backing = await refundBacking(orgId, note)
  const citeable = citeableOn(backing.cited, printer.deviceNumber, prepared.mode, note.currency)
  const need = refundNeed(note, await receiptsOf(orgId, String(note._id)), amount)
  const part = need && drawOn(need, citeable)
  if (!part) throw need ? exceedsReceipts(citeable, need) : noReceiptToStorno()
  const document = paymentStornoDocument({
    note, cited: part.cited, take: part.take, tender: prepared.tender, session: c.session!, user: c.user, printer,
  })
  const outcome = await insertRegisterDocument(orgId, document, keyed)
  // A racing duplicate of this request won the insert: its part is this one.
  if ('existing' in outcome) return settleKeyedReceipt(orgId, user, outcome.existing, keyed!.hash)
  return runReceiptSteps(c, String(outcome.inserted._id))
}

/** What an answer says about a refund: its last storno as a receipt is said, and all of them. */
export function refundOutcome(stornos: any[]) {
  return stornos.map((doc) => {
    const reg = doc.register || {}
    return {
      id: String(doc._id),
      number: doc.invoiceNumber,
      state: reg.fiscal?.state,
      amount: doc.total,
      ...(reg.unp ? { unp: reg.unp } : {}),
      ...(reg.fiscalReceiptNumber ? { receiptNumber: reg.fiscalReceiptNumber } : {}),
      cites: reg.storno?.originalReceiptNumber,
    }
  })
}

/** How much of a refund went back, as far as its stornos say. */
export const refundedBy = (stornos: any[]) => round2(stornos.filter(gaveMoney).reduce((s, d) => s + (Number(d.total) || 0), 0))
