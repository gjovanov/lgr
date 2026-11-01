/**
 * FR-21 — the till's side of the cash-register service: what only a door with a fiscal device has.
 *
 * `services/biz/cash-register/register.service.ts` runs the steps of every cash-register document,
 * but `services` must not import `fiscal/*` (which imports it). So the till builds the service's
 * `RegisterPrinter` here, from the device connected for the session's warehouse and the operator
 * signed in, and answers in the till's own shape. Two routes storno a sale — the till's
 * `/trade/pos/session/:id/storno` and the journal's `/cash-register/documents/:id/storno` — and
 * both come through `stornoDoor`.
 */
import { Invoice, Org, POSSession } from 'db/models'
import { getRepos } from 'services/context'
import { orgDao } from 'services/dao/org.dao'
import { logger } from 'services/logger'
import { toPosTransaction } from 'services/biz/cash-register/mapping'
import { asEntity } from 'services/biz/cash-register/pos-union'
import type { RegisterPrinter } from 'services/biz/cash-register/printer'
import { livePresence } from 'services/biz/fiscal-presence.service'
import {
  RegisterRefusal, claimForStorno, insertRegisterDocument, invoicedRefusal, newDocumentId, originOf, printedFiscally, releaseStornoClaim,
  runStornoSteps, settleKeyedDocument, stornoDocument, stornoRefusal,
  type RegisterContext, type RegisterSession, type RegisterUser,
} from 'services/biz/cash-register/register.service'
import { fiscalUnitPrice } from 'services/biz/cash-register/receipt-lines'
import { isDeviceConnected, getPrinter, type IFiscalPrinter } from 'fiscal/fiscal-device.service'
import { maySaleOpen } from 'fiscal/device-reach'
import { FiscalPaymentMethodError, toFiscalPaymentType } from 'fiscal/types'
import { lineNameMaxOf, unsupportedReason } from 'fiscal/capabilities'
import { mapTaxRateToVatGroup } from 'fiscal/vat-groups'
import { fiscalOperation } from 'fiscal/in-flight'
import { deviceTurn } from 'fiscal/device-turn'
import { stagedPrint } from 'fiscal/print-stage'
import { roundCents } from 'config/pos-totals'

export { fiscalUnitPrice }

/**
 * Who may reverse a sale (H4, #145), on top of the route's permission (`pos.write`, or the journal's
 * `pos.write`/`invoicing.write`). The UI's list (`ui-shared/cash-register/storno.ts`) is the same.
 * Not `warehouse_manager` (owner, 2026-10-27): its permissions reach no storno door.
 */
export const STORNO_ROLES = ['admin', 'manager']

export type FiscalCtx = {
  deviceId: string
  deviceNumber: string
  printer: IFiscalPrinter
  cashOnDeliveryRefusal: string | null
  printsFiscalText: boolean
  lineNameMax?: number
} | null

/**
 * Look up the active fiscal device for a warehouse.
 * Returns { deviceId, deviceNumber, printer } if connected, or null if no fiscal device.
 * Throws if a device is configured but in error state (Appendix 29: must block operations).
 *
 * A warehouse can have more than one active device (e.g. a Tremol and an Eltrade while one
 * replaces the other). The CONNECTED one is used — picking an arbitrary one used to send a
 * sale to the unplugged device, which silently printed nothing.
 */
export async function getFiscalContext(orgId: string, warehouseId: string): Promise<FiscalCtx> {
  const r = getRepos()
  const devices = await r.fiscalDevices.findMany({ orgId, warehouseId, isActive: true } as any) as any[]
  if (!devices?.length) return null

  const device = devices.find(d => isDeviceConnected(d.id))
  logger.info({ deviceIds: devices.map(d => d.id), connectedId: device?.id, warehouseId }, 'getFiscalContext: device lookup result')

  if (!device) {
    const failed = devices.find(d => d.status === 'error')
    if (failed) {
      throw new Error(`Fiscal device "${failed.name}" is in error state. Cannot process sale.`)
    }
    // ⚠ FR-24.52: "held elsewhere" is never "offline". A device another pod holds right now prints
    // there; a request that reached this pod anyway (a route that did not declare its device,
    // FR-24.50) is refused, and never completes without the receipt it should have.
    for (const d of devices) {
      if (await livePresence({ orgId, deviceNumber: String(d.deviceNumber) })) {
        throw Object.assign(
          new Error(`Fiscal device "${d.name}" is connected to another server process. Nothing was done; try again.`),
          { code: 'fiscal_held_elsewhere' },
        )
      }
    }
    logger.warn({ deviceIds: devices.map(d => d.id), warehouseId }, 'Fiscal device offline, proceeding without fiscal receipt')
    return null
  }

  return {
    deviceId: device.id,
    deviceNumber: device.deviceNumber as string,
    printer: getPrinter(device.id),
    cashOnDeliveryRefusal: unsupportedReason(device.manufacturer, device.connectionType, 'cashOnDelivery'),
    printsFiscalText: unsupportedReason(device.manufacturer, device.connectionType, 'fiscalText') === null,
    lineNameMax: lineNameMaxOf(device.manufacturer, device.connectionType),
  }
}

/** What the customer handed over, per payment: the device computes the change itself. */
const tendered = (doc: any) => (doc.payments || []).map((p: any) => ({ method: p.method, amount: Number(p.tendered ?? p.amount) || 0 }))

/**
 * Format receipt as text lines for non-fiscal printing (testing with non-fiscalized devices).
 * Uses the org locale for translated labels and the given (session) currency for amounts.
 */
export function formatNonFiscalLines(body: any, transactionNumber: string, operatorName: string, locale: string, currency: string): string[] {
  const labels: Record<string, Record<string, string>> = {
    en: { subtotal: 'Subtotal:', vat: 'VAT:', total: 'TOTAL:', cash: 'CASH:', card: 'CARD:', cod: 'ON DELIVERY:', change: 'CHANGE:', nonFiscal: '* NON-FISCAL *', operator: 'Op:' },
    bg: { subtotal: 'Междинна сума:', vat: 'ДДС:', total: 'ОБЩО:', cash: 'В БРОЙ:', card: 'КАРТА:', cod: 'НАЛОЖЕН ПЛАТЕЖ:', change: 'РЕСТО:', nonFiscal: '* НЕФИСКАЛЕН *', operator: 'Оп:' },
    de: { subtotal: 'Zwischensumme:', vat: 'MwSt:', total: 'GESAMT:', cash: 'BAR:', card: 'KARTE:', cod: 'NACHNAHME:', change: 'WECHSEL:', nonFiscal: '* NICHT-FISKAL *', operator: 'Op:' },
    mk: { subtotal: 'Меѓузбир:', vat: 'ДДВ:', total: 'ВКУПНО:', cash: 'ГОТОВИНА:', card: 'КАРТИЦА:', cod: 'ПРИ ДОСТАВА:', change: 'КУСУР:', nonFiscal: '* НЕФИСКАЛЕН *', operator: 'Оп:' },
  }
  const l = labels[locale] || labels.en

  const paymentLabels: Record<string, string> = {
    cash: l.cash,
    card: l.card,
    cash_on_delivery: l.cod,
    mobile: 'MOBILE:',
    voucher: 'VOUCHER:',
  }

  const fmt = (amount: number) => `${amount.toFixed(2)} ${currency}`

  // Tremol M20 adds '# ' prefix and ' #' suffix to each line (4 chars total)
  // 57mm paper = ~32 printable chars, minus 4 for borders = 28 usable
  const W = 28
  const sep = '-'.repeat(W)
  const center = (s: string) => {
    const pad = Math.max(0, Math.floor((W - s.length) / 2))
    return ' '.repeat(pad) + s
  }
  const lr = (left: string, right: string) => {
    const gap = Math.max(1, W - left.length - right.length)
    return left + ' '.repeat(gap) + right
  }
  const lines: string[] = []
  lines.push(center(l.nonFiscal))
  lines.push(sep)
  lines.push(transactionNumber)
  lines.push(new Date().toLocaleString(`${locale}-${locale.toUpperCase()}`, { timeZone: 'Europe/Sofia' }))
  lines.push(`${l.operator} ${operatorName.substring(0, W - l.operator.length - 1)}`)
  lines.push(sep)
  for (const item of body.lines) {
    lines.push(item.name.substring(0, W))
    const qty = ` ${item.quantity}x${item.unitPrice.toFixed(4)}`
    const total = fmt(item.quantity * item.unitPrice)
    lines.push(lr(qty, total))
  }
  lines.push(sep)
  lines.push(lr(l.subtotal, fmt(body.subtotal)))
  lines.push(lr(l.vat, fmt(body.taxTotal)))
  lines.push(lr(l.total, fmt(body.total)))
  lines.push(sep)
  for (const p of body.payments) {
    const label = paymentLabels[p.method] || (p.method.toUpperCase() + ':')
    lines.push(lr(label, fmt(p.amount)))
  }
  if (body.changeDue > 0) lines.push(lr(l.change, fmt(body.changeDue)))
  lines.push(sep)
  lines.push(center(l.nonFiscal))
  return lines
}

/**
 * The till's fiscal device as the cash-register service drives it: the device connected for the
 * session's warehouse, the operator signed in, and what this device needs for a sale.
 */
export function tillPrinter(orgId: string, fiscal: NonNullable<FiscalCtx>, user: RegisterUser, session: { currency?: string } | null): RegisterPrinter {
  const r = getRepos()
  const p = fiscal.printer
  const operatorCode = user.operatorCode as string
  const operatorName = `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim()
  return {
    deviceId: fiscal.deviceId,
    deviceNumber: fiscal.deviceNumber,
    lastReceiptNumber: async () => (p.getLastReceiptNumber ? p.getLastReceiptNumber() : undefined),
    receiptOpen: async () => p.isReceiptOpen?.(),
    clearLeftovers: async () => p.clearLeftovers?.(),
    printsText: !!p.openNonFiscalReceipt,
    cashOnDeliveryRefusal: fiscal.cashOnDeliveryRefusal,
    printsFiscalText: fiscal.printsFiscalText,
    lineNameMax: fiscal.lineNameMax,
    async printSale(doc) {
      // Read before the receipt opens: a payment no receipt can carry must not strand an open one.
      const payments = tendered(doc).map((t: any) => ({ type: toFiscalPaymentType(t.method), amount: t.amount }))
      return stagedPrint(async (reached) => {
        await p.openFiscalReceipt(operatorCode, operatorName, doc.register?.unp)
        reached('lines')
        for (const line of doc.lines || []) {
          const taxRate = line.taxRate ?? 0
          await p.printSaleLine(line.description, line.quantity, fiscalUnitPrice(line.unitPrice, taxRate), mapTaxRateToVatGroup(taxRate), line.discount || undefined, taxRate)
        }
        // FR-23: the invoice a whole payment is for, under its lines. Only ever on a device that can.
        if (doc.register?.receiptText) await p.printFiscalText?.(doc.register.receiptText)
        reached('paying')
        for (const payment of payments) await p.printPayment(payment.type, payment.amount)
        reached('closing')
        const { fiscalReceiptNumber } = await p.closeFiscalReceipt()
        return fiscalReceiptNumber
      })
    },
    async printText(doc) {
      const org = await orgDao.findById(orgId) as any
      const locale = org?.settings?.locale || 'en'
      const currency = session?.currency || org?.settings?.baseCurrency || 'EUR'
      const body = {
        lines: (doc.lines || []).map((l: any) => ({ name: l.description, quantity: l.quantity, unitPrice: l.unitPrice })),
        subtotal: doc.subtotal, taxTotal: doc.taxTotal, total: doc.total,
        payments: tendered(doc), changeDue: doc.register?.changeDue || 0,
      }
      await p.openNonFiscalReceipt!(operatorCode || '1')
      for (const line of formatNonFiscalLines(body, doc.invoiceNumber, operatorName, locale, currency)) await p.printNonFiscalText!(line)
      await p.closeNonFiscalReceipt!()
    },
    async printStorno(storno, original) {
      const stornoLines = (original.lines || []).map((l: any) => ({
        name: l.description,
        quantity: l.quantity,
        // VAT-inclusive, like the sale it reverses (see fiscalUnitPrice)
        price: fiscalUnitPrice(l.unitPrice, l.taxRate ?? 0),
        vatGroup: mapTaxRateToVatGroup(l.taxRate ?? 0),
        taxRate: l.taxRate ?? 0,
      }))
      const method = refundMethod(storno.payments, original)
      const s = storno.register?.storno || {}
      const result = await p.printStornoReceipt(
        operatorCode, operatorName, storno.register?.unp,
        s.originalReceiptNumber, s.originalDate, s.originalUnp,
        s.reason, stornoLines,
        { type: toFiscalPaymentType(method), amount: original.total },
      )
      return result.fiscalReceiptNumber
    },
    async abandonReceipt() {
      if (p.cancelFiscalReceipt) {
        await p.cancelFiscalReceipt()
        return undefined
      }
      // Drivers without a cancel keep the old best-effort close. If it goes through, that receipt is
      // real: it must not be recorded as failed.
      await p.closeFiscalReceipt()
      return { closed: true }
    },
    async abandonText() {
      await p.closeNonFiscalReceipt?.()
    },
    async reached() {
      await r.fiscalDevices.update(fiscal.deviceId, { lastCommunicationAt: new Date(), status: 'online' } as any)
    },
    async failed() {
      await r.fiscalDevices.update(fiscal.deviceId, { status: 'error' } as any)
    },
    // Counted from the moment it is asked for, so a graceful stop waits for one still in the queue.
    operation: fn => fiscalOperation(() => deviceTurn(fiscal.deviceId, fn)),
  }
}

/**
 * The tender of a sale or a refund, checked BEFORE anything is written: no number, no УНП, no
 * receipt. Every door that prints comes through these (the till's sale, both storno routes, the
 * back office's sale joined to a session). What they refuse used to reach the device: a bank
 * transfer printed as cash, and cash on delivery refused by the driver with the receipt already open.
 */
function assertFiscalMethods(methods: string[]): void {
  for (const method of methods) {
    try {
      toFiscalPaymentType(method)
    } catch (e) {
      if (!(e instanceof FiscalPaymentMethodError)) throw e
      throw new RegisterRefusal(422, { code: 'payment_method_not_fiscal', method, message: e.message })
    }
  }
}

/** The device the receipt prints on has somewhere to print this tender. */
function assertDeviceTakes(methods: string[], printer: RegisterPrinter | null | undefined): void {
  if (printer?.cashOnDeliveryRefusal && methods.includes('cash_on_delivery')) {
    throw new RegisterRefusal(422, { code: 'cod_not_supported', message: printer.cashOnDeliveryRefusal })
  }
}

/**
 * Cash on delivery settles the whole amount, exactly. The courier owes it and the drawer never holds
 * it, so a short tender would book the rest as cash taken (`keptByMethod`), and an over-tender
 * would give change out of a drawer that took nothing.
 */
function assertCashOnDeliveryExact(tenders: { method: string; amount: number }[], total: number): void {
  if (!tenders.some(t => t.method === 'cash_on_delivery')) return
  if (tenders.length === 1 && roundCents(tenders[0].amount) === roundCents(total)) return
  throw new RegisterRefusal(422, {
    code: 'cod_amount_mismatch',
    message: `Cash on delivery is the only payment and exactly the total (${roundCents(total).toFixed(2)}): no change is given.`,
  })
}

/** A till sale: every method one a receipt can carry, whichever receipt it prints. */
export function assertTillTender(tenders: { method: string; amount: number }[], total: number, printer: RegisterPrinter | null | undefined): void {
  const methods = tenders.map(t => t.method)
  assertFiscalMethods(methods)
  assertDeviceTakes(methods, printer)
  assertCashOnDeliveryExact(tenders, total)
}

/** A back-office sale joined to a session (D-13): its `method`, on the receipt it asked for. */
export function assertJoinedSaleTender(method: string, receipt: 'fiscal' | 'text', printer: RegisterPrinter | null | undefined): void {
  if (!printer) return
  if (receipt === 'fiscal') assertFiscalMethods([method])
  assertDeviceTakes([method], printer)
}

/** The one method a storno receipt prints for the whole amount: the first the refund names. */
function refundMethod(refund: { method: string }[] | undefined, original: any): string {
  return refund?.[0]?.method || original.payments?.[0]?.method || original.paymentMethod || 'cash'
}

/** A storno: the refund the operator named, and what its receipt prints when it prints one. */
function assertStornoTender(refund: { method: string; amount: number }[] | undefined, original: any, printer: RegisterPrinter | null): void {
  assertFiscalMethods((refund ?? []).map(p => p.method))
  assertCashOnDeliveryExact(refund ?? [], Number(original.total) || 0)
  if (!printer) return
  const method = refundMethod(refund, original)
  assertFiscalMethods([method])
  assertDeviceTakes([method], printer)
}

/**
 * FR-20.49 — Прил. 29 т. 8: no fiscal receipt opens on a device not reached in two hours (SUPTO
 * production mode only). For a NEW document only: a retry of one that already opened must finish.
 */
export async function assertSaleMayOpen(orgId: string, warehouseId: unknown): Promise<void> {
  const verdict = await maySaleOpen(orgId, warehouseId as any)
  if (verdict.ok) return
  throw new RegisterRefusal(409, {
    code: 'fiscal_device_unreached',
    message: `The fiscal device "${verdict.deviceName}" has not answered for more than 2 hours. A sale cannot open until it does (Н-18, Прил. 29 т. 8).`,
    deviceName: verdict.deviceName,
    lastCommunicationAt: verdict.lastCommunicationAt,
  })
}

/** FR-21.31 (D-13): the user's own open session, which their back-office documents join. */
export async function openSessionOf(orgId: string, userId: string): Promise<any | null> {
  return POSSession.findOne({ orgId, cashierId: userId, status: 'open' }).sort({ openedAt: -1 }).lean().exec()
}

/** A session as the service reads it. */
export const registerSession = (s: any): RegisterSession => ({
  id: String(s.id ?? s._id), warehouseId: String(s.warehouseId), cashierId: s.cashierId ? String(s.cashierId) : undefined, currency: s.currency,
})

/** The till's context for a session's warehouse: its device, if one is connected. */
export async function tillContext(orgId: string, user: RegisterUser, session: any, opts: { needsOperator: boolean }): Promise<RegisterContext> {
  let fiscal: FiscalCtx = null
  try {
    fiscal = await getFiscalContext(orgId, String(session.warehouseId))
  } catch (e: any) {
    throw new RegisterRefusal(503, { message: e.message })
  }
  if (!user.operatorCode && fiscal && opts.needsOperator) {
    throw new RegisterRefusal(400, { message: 'User has no operator code. Contact admin to assign one before using POS with fiscal device.' })
  }
  return {
    orgId,
    user,
    session: registerSession(session),
    printer: fiscal ? tillPrinter(orgId, fiscal, user, session) : null,
    // The till's own check runs before the print (FR-21.16); after it, the dispatch must not fail.
    allowNegative: true,
    audit: { module: 'trade', entityType: 'pos_transaction' },
  }
}

/**
 * The document a keyed till request already made (FR-21.10, §6 edge 1). A key an older release put
 * on a POS row travelled with the row into its document (0008/0009 keep `clientKey`), so the
 * documents are the one place to look since R4 (FR-21.27).
 */
export async function findKeyedTillDocument(orgId: string, key: string): Promise<any | null> {
  return Invoice.findOne({ orgId, clientKey: key }).lean().exec()
}

/** What the till answers for a sale: the document as the POS row it stands for. */
export function saleResponse(doc: any) {
  const transaction: any = asEntity(toPosTransaction(doc))
  return {
    transaction,
    ...(transaction.receiptError ? { receiptError: transaction.receiptError } : {}),
    ...(transaction.stockError ? { stockError: transaction.stockError } : {}),
  }
}

/** What the till answers for a storno: the reversal, or the 503 of #145 when its receipt failed. */
export function stornoResponse(doc: any): { status: number; body: Record<string, unknown> } | { transaction: any; stockError?: string } {
  const transaction: any = asEntity(toPosTransaction(doc))
  if (doc.status === 'voided' && doc.register?.receiptError) {
    return { status: 503, body: { code: 'fiscal_error', message: `The storno receipt was not printed, so nothing was reversed: ${doc.register.receiptError}` } }
  }
  return { transaction, ...(transaction.stockError ? { stockError: transaction.stockError } : {}) }
}

export interface StornoDoorInput {
  orgId: string
  user: RegisterUser & { role?: string }
  originalId: string
  reason: string
  payments?: { method: string; amount: number; reference?: string }[]
  /** The session the refund leaves: the till's own, or the one the journal's dialog chose. */
  session: any | null
  key?: string
  hash?: string
}

/**
 * Storno a sale (D-2, §3.5), from the till or from the journal.
 *
 * - **A till sale** goes back through a till: an open session in the sale's own warehouse, so the
 *   same fiscal device prints the storno receipt (it cites that device's receipt number) and the
 *   refund leaves the drawer that took the money.
 * - **A back-office sale** has no receipt and no drawer: its storno prints nothing and needs no session.
 * - **An imported till day** and **an invoiced sale** are refused (`stornoRefusal`).
 *
 * The sale is claimed atomically, the storno is its own `cash_storno` document, and the sale stays
 * `paid` with `stornoState: 'full'`. A sale an older release rang up is stornoed as its
 * copy, under the row's id (§6 edge 3).
 */
export async function stornoDoor(input: StornoDoorInput): Promise<{ status: number; body: Record<string, unknown> } | { transaction: any; stockError?: string }> {
  const { orgId, user, key, hash } = input
  /** A back-office sale and its storno are invoicing's documents, audited as its own. */
  const backOffice = (): RegisterContext => ({ orgId, user, session: null, printer: null, audit: { module: 'invoicing', entityType: 'invoice' } })
  const context = async (): Promise<RegisterContext> => {
    const original: any = await Invoice.findOne({ _id: input.originalId, orgId }).lean().exec()
    if (originOf(original) !== 'pos' || !input.session) return backOffice()
    return tillContext(orgId, user, input.session, { needsOperator: printedFiscally(original) })
  }
  const answer = (doc: any) => stornoResponse(doc)

  try {
    if (key) {
      const existing = await findKeyedTillDocument(orgId, key)
      if (existing) return answer(await settleKeyedDocument(existing, hash!, context, runStornoSteps))
    }

    // A sale an older release rang up is its copy since 0008/0009, under the same id.
    const original: any = Invoice.base.Types.ObjectId.isValid(input.originalId)
      ? await Invoice.findOne({ _id: input.originalId, orgId }).lean().exec()
      : null
    const refusal = await stornoRefusal(original)
    if (refusal) {
      // ⚠ A duplicate sent at the same moment can read the sale AFTER the first request claimed it
      // and BEFORE that request wrote its storno, the document that carries the key. It answered
      // "already cancelled" for a storno that went through. So a keyed request waits for its key.
      if (key && original?.register?.stornoState === 'full') {
        for (let i = 0; i < 40; i++) {
          // ⚠ In this order. The other way round, a storno landing between the two reads was this
          // request's own, found as "a paid storno" and missed as "my key", so it was refused.
          const reversed = await Invoice.exists({ orgId, type: 'cash_storno', relatedInvoiceId: original._id, status: 'paid' }).exec()
          const mine = await Invoice.findOne({ orgId, clientKey: key }).lean().exec()
          if (mine) return answer(await settleKeyedDocument(mine, hash!, context, runStornoSteps))
          if (reversed) break
          await new Promise(res => setTimeout(res, 100))
        }
      }
      throw refusal
    }

    const tillSale = originOf(original) === 'pos'
    let session: any = null
    if (tillSale) {
      session = input.session
      if (!session) {
        throw new RegisterRefusal(400, { code: 'storno_needs_session', message: 'A till sale is reversed in an open session of the warehouse it was sold from' })
      }
      if (session.status === 'closed') throw new RegisterRefusal(400, { message: 'Session is closed' })
      const soldFrom = original.register?.warehouseId ?? (original.register?.sessionId ? (await POSSession.findById(original.register.sessionId, { warehouseId: 1 }).lean().exec() as any)?.warehouseId : undefined)
      if (soldFrom && String(soldFrom) !== String(session.warehouseId)) {
        throw new RegisterRefusal(400, { code: 'storno_other_warehouse', message: 'A storno must be made in a session of the warehouse the sale was made in' })
      }
    }

    const c = tillSale ? await tillContext(orgId, user, session, { needsOperator: printedFiscally(original) }) : backOffice()
    // #281 (owner, 2026-10-27): a sale that printed a FISCAL receipt is reversed by a storno receipt
    // on the device (Н-18). With no device connected it went through printing nothing: the cash left
    // the drawer, the goods came back, and the device's records and the books disagreed. It is
    // refused now, before the claim, so nothing is left behind; a storno whose print FAILS was
    // already refused and voided (#145).
    if (printedFiscally(original) && !c.printer) {
      throw new RegisterRefusal(503, {
        code: 'fiscal_device_unavailable',
        message: 'This sale printed a fiscal receipt: its storno prints a storno receipt on the fiscal device, which is not connected. Connect the device and try again.',
      })
    }
    const printsReceipt = !!c.printer && printedFiscally(original)
    // Before the claim: a refused refund leaves the sale as it was.
    assertStornoTender(input.payments, original, printsReceipt ? c.printer! : null)

    const stornoId = newDocumentId()
    if (!(await claimForStorno(original, stornoId))) {
      // A duplicate of the request that won: wait for its storno, then answer as it does.
      if (key) {
        for (let i = 0; i < 40; i++) {
          const winner = await Invoice.findOne({ orgId, clientKey: key }).lean().exec()
          if (winner) return answer(await settleKeyedDocument(winner, hash!, context, runStornoSteps))
          await new Promise(res => setTimeout(res, 100))
        }
      }
      throw new RegisterRefusal(409, { code: 'storno_in_progress', message: 'This sale is already being reversed' })
    }

    let inserted: any
    try {
      // An invoice claimed between `stornoRefusal` and the claim (see `invoicedRefusal`).
      const invoicedMeanwhile = await invoicedRefusal(original)
      if (invoicedMeanwhile) throw invoicedMeanwhile
      const doc = stornoDocument({
        orgId, user, original, reason: input.reason, payments: input.payments,
        session: tillSale ? registerSessionOf(session) : null, printsReceipt, printer: c.printer ?? null,
      })
      const outcome = await insertRegisterDocument(orgId, { ...doc, _id: stornoId }, key ? { key, hash: hash! } : undefined)
      if ('existing' in outcome) {
        await releaseStornoClaim(original, stornoId)
        return answer(await settleKeyedDocument(outcome.existing, hash!, context, runStornoSteps))
      }
      inserted = outcome.inserted
    } catch (e) {
      // Every early exit from here on must give the sale back.
      await releaseStornoClaim(original, stornoId)
      throw e
    }
    return answer(await runStornoSteps({ ...c, printer: printsReceipt ? c.printer : null }, String(inserted._id)))
  } catch (e: any) {
    if (e instanceof RegisterRefusal) return { status: e.statusCode, body: e.body }
    throw e
  }
}

const registerSessionOf = (s: any) => (s ? registerSession(s) : null)

/**
 * The org's settings the till reads: its base currency, whether it may sell below zero, and
 * whether a sale needs a connected printer.
 */
export async function tillSettings(orgId: string): Promise<{ baseCurrency?: string; allowNegativeStock: boolean; requireConnectedDevice: boolean }> {
  const org: any = await Org.findById(orgId, { 'settings.baseCurrency': 1, 'settings.cashRegister': 1 }).lean().exec()
  return {
    baseCurrency: org?.settings?.baseCurrency,
    // FR-21.16: unset means allowed, which is what the till always did.
    allowNegativeStock: org?.settings?.cashRegister?.allowNegativeStock !== false,
    // Unset means required: only an org that turned it off sells with nothing to print on.
    requireConnectedDevice: org?.settings?.cashRegister?.requireConnectedDevice !== false,
  }
}

/**
 * No sale without a connected printer (2026-10-31): a sale that prints — every till sale, and a
 * back-office sale that asked its session's device for a receipt — is refused when nothing would
 * print it, unless the org turned the rule off (a demo or test org with no device). Called before
 * anything is written, so a refused sale draws no number and no УНП.
 */
/** The way out of the printer gate. Every refusal of it says so: an org with no printer has no other. */
export const PRINTER_GATE_SWITCH = 'An organization that prints nothing here turns "A sale needs a connected fiscal printer" off in Settings → Organization → Cash register.'

export async function assertPrinterConnected(orgId: string, warehouseId: string, ctx: { printer?: unknown } | null): Promise<void> {
  if (ctx?.printer) return
  if (!(await tillSettings(orgId)).requireConnectedDevice) return
  const configured = (await getRepos().fiscalDevices.count({ orgId, warehouseId, isActive: true } as any)) > 0
  throw new RegisterRefusal(409, {
    code: 'fiscal_device_not_connected',
    deviceConfigured: configured,
    message: configured
      ? `The fiscal printer is not connected. Connect it before selling. ${PRINTER_GATE_SWITCH}`
      : `No fiscal printer is set up for this warehouse. Set one up and connect it before selling. ${PRINTER_GATE_SWITCH}`,
  })
}
