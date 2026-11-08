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
import { finishInterruptedReceipt, interruptedDocuments, unfinishedReceipts } from 'services/biz/cash-register/payment-receipt.service'
import { registerOpeningFloat, type FloatPrinter } from 'services/biz/cash-register/opening-float'
import { saleProgress } from 'services/biz/cash-register/in-doubt'
import { asEntity } from 'services/biz/cash-register/pos-union'
import { RECEIPT_DEVICE_AWAY, auditStoppedSettlement } from 'services/biz/cash-register/settle.service'
import type { RegisterPrinter } from 'services/biz/cash-register/printer'
import { takeLease } from 'services/biz/hot-path-key'
import { POD_ID, livePresence } from 'services/biz/fiscal-presence.service'
import {
  RegisterRefusal, SESSION_CLOSING, claimForStorno, markStornoWritten, finishInterruptedStorno, finishSale, insertRegisterDocument, invoicedRefusal, newDocumentId, originOf, printedAsText, printedFiscally,
  releaseOrphanClaims, releaseStornoClaim, runStornoSteps, settleKeyedDocument, stornoClaimed, stornoDocument, stornoInDoubtRefusal, stornoRefusal,
  type RegisterContext, type RegisterSession, type RegisterUser,
} from 'services/biz/cash-register/register.service'
import { documentText, fiscalUnitPrice, linesOnDevice, refundText } from 'services/biz/cash-register/receipt-lines'
import { leftByRate, totalOf } from 'services/biz/cash-register/refund-budget'
import { isPlanRefusal, leftByMethod, planStorno, refundOfPart, type StornoPlan } from 'services/biz/cash-register/storno-lines'
import { isDeviceConnected, getPrinter, type IFiscalPrinter } from 'fiscal/fiscal-device.service'
import { maySaleOpen } from 'fiscal/device-reach'
import { FiscalPaymentMethodError, toFiscalPaymentType, type ZReportResult } from 'fiscal/types'
import { fiscalCapabilities, lineNameMaxOf, unsupportedReason } from 'fiscal/capabilities'
import { receiptMode } from 'services/biz/cash-register/receipt-mode'
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
 *
 * `deviceNumber`: that device and no other, wherever it stands now: what a document that started on a
 * device needs, because no other device's counter says anything about it.
 */
export async function getFiscalContext(orgId: string, warehouseId: string, deviceNumber?: string): Promise<FiscalCtx> {
  const r = getRepos()
  const devices = await r.fiscalDevices.findMany((deviceNumber ? { orgId, deviceNumber } : { orgId, warehouseId, isActive: true }) as any) as any[]
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

/**
 * The first of these devices that is connected in this warehouse, when one is. A warehouse can hold two while one
 * replaces the other, and `getFiscalContext` takes whichever it comes to first, so a door that needs a particular
 * one asks for it by number, as a document's own device is found (`deviceFromDeadReceipt`).
 */
export async function connectedInWarehouse(orgId: string, warehouseId: string, deviceNumbers: string[]): Promise<string | undefined> {
  if (!deviceNumbers.length) return undefined
  const devices = await getRepos().fiscalDevices.findMany({ orgId, warehouseId, isActive: true } as any) as any[]
  return deviceNumbers.find(n => devices.some(d => d.deviceNumber === n && isDeviceConnected(d.id)))
}

/** What the customer handed over, per payment: the device computes the change itself. */
const tendered = (doc: any) => (doc.payments || []).map((p: any) => ({ method: p.method, amount: Number(p.tendered ?? p.amount) || 0 }))

/** `text` in lines of `width`, broken at its spaces. */
function wrapped(text: string, width: number): string[] {
  const out: string[] = []
  let line = ''
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > width) {
      out.push(line)
      line = ''
    }
    line = line ? `${line} ${word}` : word
  }
  if (line) out.push(line)
  return out
}

/**
 * Format receipt as text lines for non-fiscal printing (testing with non-fiscalized devices).
 * Uses the org locale for translated labels and the given (session) currency for amounts.
 */
export function formatNonFiscalLines(body: any, transactionNumber: string, operatorName: string, locale: string, currency: string, timeZone = 'Europe/Sofia'): string[] {
  const labels: Record<string, Record<string, string>> = {
    en: { subtotal: 'Subtotal:', vat: 'VAT:', total: 'TOTAL:', cash: 'CASH:', card: 'CARD:', cod: 'ON DELIVERY:', change: 'CHANGE:', nonFiscal: '* NON-FISCAL *', operator: 'Op:', storno: 'STORNO', refunded: 'REFUNDED:' },
    bg: { subtotal: 'Междинна сума:', vat: 'ДДС:', total: 'ОБЩО:', cash: 'В БРОЙ:', card: 'КАРТА:', cod: 'НАЛОЖЕН ПЛАТЕЖ:', change: 'РЕСТО:', nonFiscal: '* НЕФИСКАЛЕН *', operator: 'Оп:', storno: 'СТОРНО', refunded: 'ВЪРНАТИ:' },
    de: { subtotal: 'Zwischensumme:', vat: 'MwSt:', total: 'GESAMT:', cash: 'BAR:', card: 'KARTE:', cod: 'NACHNAHME:', change: 'WECHSEL:', nonFiscal: '* NICHT-FISKAL *', operator: 'Op:', storno: 'STORNO', refunded: 'ERSTATTET:' },
    mk: { subtotal: 'Меѓузбир:', vat: 'ДДВ:', total: 'ВКУПНО:', cash: 'ГОТОВИНА:', card: 'КАРТИЦА:', cod: 'ПРИ ДОСТАВА:', change: 'КУСУР:', nonFiscal: '* НЕФИСКАЛЕН *', operator: 'Оп:', storno: 'СТОРНО', refunded: 'ВРАТЕНИ:' },
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
  // A storno says so at its head, and what it reverses under its number (owner, 2026-11-08): with only a
  // line under its articles, its slip read as a sale.
  if (body.storno) lines.push(center(l.storno))
  lines.push(sep)
  lines.push(transactionNumber)
  if (body.storno && body.receiptText) lines.push(...wrapped(body.receiptText, W))
  // #454: the org's clock, as the session report reads it (`formatSessionReport`), Sofia when it names none.
  lines.push(new Date().toLocaleString(`${locale}-${locale.toUpperCase()}`, { timeZone }))
  lines.push(`${l.operator} ${operatorName.substring(0, W - l.operator.length - 1)}`)
  lines.push(sep)
  for (const item of body.lines) {
    // A payment's receipt names the invoice in the line: that number is what must not be cut.
    lines.push(...(body.keepNames ? wrapped(item.name, W) : [item.name.substring(0, W)]))
    const qty = ` ${item.quantity}x${item.unitPrice.toFixed(4)}`
    const total = fmt(item.quantity * item.unitPrice)
    lines.push(lr(qty, total))
  }
  // FR-23: „Фактура № …", as a fiscal receipt says it under its lines.
  if (body.receiptText && !body.storno) lines.push(...wrapped(body.receiptText, W))
  lines.push(sep)
  lines.push(lr(l.subtotal, fmt(body.subtotal)))
  lines.push(lr(l.vat, fmt(body.taxTotal)))
  lines.push(lr(l.total, fmt(body.total)))
  lines.push(sep)
  // A storno's money went back to the customer.
  if (body.storno) lines.push(l.refunded)
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
    async fiscalized() {
      const status = await p.getStatus()
      // A driver reports a read that failed as `connected: false`, which says nothing about the device.
      if (status.connected === false) throw new Error(status.errors?.[0] || 'The device did not answer.')
      return status.fiscalized
    },
    printsText: !!p.openNonFiscalReceipt,
    cashOnDeliveryRefusal: fiscal.cashOnDeliveryRefusal,
    printsFiscalText: fiscal.printsFiscalText,
    lineNameMax: fiscal.lineNameMax,
    async printSale(doc) {
      // Read before the receipt opens: a payment no receipt can carry must not strand an open one.
      const payments = tendered(doc).map((t: any) => ({ type: toFiscalPaymentType(t.method), amount: t.amount }))
      const lines: any[] = linesOnDevice(doc, documentText(doc, fiscal.lineNameMax))
      return stagedPrint(async (reached) => {
        await p.openFiscalReceipt(operatorCode, operatorName, doc.register?.unp)
        reached('lines')
        for (const line of lines) {
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
        // FR-23: the same words a fiscal receipt of this payment prints. A refund's storno says what it reverses there.
        ...(doc.type === 'payment_receipt' || doc.type === 'payment_storno' ? { keepNames: true, receiptText: doc.register?.receiptText } : {}),
        // And a till sale's storno, what it reverses (#467).
        ...(doc.type === 'cash_storno' ? { receiptText: doc.register?.receiptText } : {}),
        // Either storno says so at its head, and that its money went back.
        ...(doc.type === 'cash_storno' || doc.type === 'payment_storno' ? { storno: true } : {}),
      }
      await p.openNonFiscalReceipt!(operatorCode || '1')
      for (const line of formatNonFiscalLines(body, doc.invoiceNumber, operatorName, locale, currency, org?.settings?.timezone || 'Europe/Sofia')) await p.printNonFiscalText!(line)
      await p.closeNonFiscalReceipt!()
    },
    async printStorno(storno, original) {
      // Its own lines and its own total: a refund's storno takes part of a receipt, whichever lines
      // and amounts that printed. A till sale's storno carries the sale's, by the rule the sale printed by.
      const stornoLines = (linesOnDevice(storno, refundText(original ?? storno, fiscal.lineNameMax)) as any[]).map((l: any) => ({
        name: l.description,
        quantity: l.quantity,
        // VAT-inclusive, like the sale it reverses (see fiscalUnitPrice)
        price: fiscalUnitPrice(l.unitPrice, l.taxRate ?? 0),
        vatGroup: mapTaxRateToVatGroup(l.taxRate ?? 0),
        taxRate: l.taxRate ?? 0,
        // ⚠ As the sale printed it. Without it a device adds the line up undiscounted, and the driver tenders the difference.
        ...(l.discount ? { discount: l.discount } : {}),
      }))
      const method = refundMethod(storno.payments, original)
      const s = storno.register?.storno || {}
      const result = await p.printStornoReceipt(
        operatorCode, operatorName, storno.register?.unp,
        s.originalReceiptNumber, s.originalDate, s.originalUnp,
        s.reason, stornoLines,
        { type: toFiscalPaymentType(method), amount: storno.total },
      )
      return result.fiscalReceiptNumber
    },
    async abandonReceipt() {
      if (p.cancelFiscalReceipt) return p.cancelFiscalReceipt()
      // Drivers without a cancel keep the old best-effort close. If it goes through, that receipt is
      // real: it must not be recorded as failed.
      await p.closeFiscalReceipt()
      return 'finished'
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
    operation: (fn, opts) => fiscalOperation(() => deviceTurn(fiscal.deviceId, fn, opts)),
    readServiceCash: p.readServiceCash && (() => p.readServiceCash!()),
    moveServiceCash: p.moveServiceCash && ((amount) => p.moveServiceCash!(amount)),
  }
}

/** How long an open waits for the device's turn over a float, which goes first with the next document if it must. */
const FLOAT_TURN_WAIT_MS = 5_000

/** A device as the float sees it (`opening-float.ts`). */
const floatPrinterOf = (p: IFiscalPrinter, deviceNumber: string): FloatPrinter => ({
  deviceNumber,
  readServiceCash: p.readServiceCash && (() => p.readServiceCash!()),
  moveServiceCash: p.moveServiceCash && ((amount) => p.moveServiceCash!(amount)),
})

/** Whether a session opening with `openingBalance` owes it to a device: one stands in its warehouse that can take it (#473). */
export async function owesDeviceFloat(orgId: string, warehouseId: string, openingBalance: number): Promise<boolean> {
  if (!(openingBalance > 0)) return false
  const devices = await getRepos().fiscalDevices.findMany({ orgId, warehouseId, isActive: true } as any) as any[]
  return devices.some(d => fiscalCapabilities(d.manufacturer, d.connectionType).features.serviceCash)
}

/**
 * A session's opening amount in a turn of its own, at the open. ⚠ The open never waits on it or fails for it:
 * with the device away or busy it stays owed, and goes first in the next document's turn.
 */
export async function floatInItsOwnTurn(deviceId: string, deviceNumber: string, sessionId: string): Promise<void> {
  try {
    const p = getPrinter(deviceId)
    await fiscalOperation(() => deviceTurn(deviceId, () => registerOpeningFloat(floatPrinterOf(p, deviceNumber), sessionId), { waitMs: FLOAT_TURN_WAIT_MS }))
  } catch (e: any) {
    logger.info({ sessionId, deviceNumber, error: e?.message }, 'Opening float waits for the next turn on the device')
  }
}

/**
 * A close's Z, in one turn with the float its session still owes (#473), which goes first: the Z is the last
 * document that can show it, so it waits for the device as long as the Z does. ⚠ Looked at twice: an attempt
 * that lost its answer is settled by the second look's read of `ServIn`, before the Z clears it. A float that
 * does not get there never stops the Z, and the session's report says so.
 */
export function zReportOwingFloat(deviceId: string, deviceNumber: string, sessionId: string): Promise<ZReportResult> {
  const p = getPrinter(deviceId)
  return fiscalOperation(() => deviceTurn(deviceId, async () => {
    for (let look = 0; look < 2; look++) await registerOpeningFloat(floatPrinterOf(p, deviceNumber), sessionId, { closing: true })
    return p.printDailyZReport()
  }))
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

/** A back-office sale joined to a session (D-13) that prints: its `method`, as the till's, whichever receipt the device prints. */
export function assertJoinedSaleTender(method: string, printer: RegisterPrinter | null | undefined): void {
  if (!printer) return
  assertFiscalMethods([method])
  assertDeviceTakes([method], printer)
}

/**
 * A fiscal receipt names its operator, and a text one does not. Only for who has no code is the device asked here,
 * so that it is refused before anything is written. The document's turn asks again, and decides: a device that cannot
 * say counts as fiscal.
 */
export async function assertOperatorFor(user: RegisterUser, printer: RegisterPrinter | null | undefined): Promise<void> {
  if (!printer || user.operatorCode) return
  if ((await receiptMode(printer).catch(() => 'fiscal')) === 'fiscal') {
    throw new RegisterRefusal(400, { message: 'User has no operator code. Contact admin to assign one before using POS with fiscal device.' })
  }
}

/** The one method a storno receipt prints for the whole amount: the first the refund names. */
function refundMethod(refund: { method: string }[] | undefined, original: any): string {
  return refund?.[0]?.method || original?.payments?.[0]?.method || original?.paymentMethod || 'cash'
}

/**
 * A storno: the refund the operator named, and what its receipt prints when it prints one. `total`: what it gives back.
 * `tillSale`: at the till a refund is what a receipt can carry, whichever receipt it prints, as the sale was. A
 * back-office sale prints nothing and has no drawer, so a bank transfer or `other`, which it may have been paid by, are
 * its to name. Anything else is no method at all, and is refused the same way.
 */
function assertStornoTender(refund: { method: string; amount: number }[] | undefined, original: any, printer: RegisterPrinter | null, tillSale: boolean, total = Number(original.total) || 0): void {
  const methods = (refund ?? []).map(p => p.method)
  assertFiscalMethods(tillSale ? methods : methods.filter(m => m !== 'bank_transfer' && m !== 'other'))
  assertCashOnDeliveryExact(refund ?? [], total)
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

/**
 * Why someone with no open session gets no receipt or storno: `what` says what it would have printed.
 * ⚠ One being closed takes nothing new, and it would be no answer to send its cashier to open another.
 */
export async function noOpenSession(orgId: string, userId: string, what: string): Promise<RegisterRefusal> {
  if (await POSSession.exists({ orgId, cashierId: userId, status: 'closing_control' }).exec()) return new RegisterRefusal(409, { ...SESSION_CLOSING })
  return new RegisterRefusal(409, {
    code: 'fiscal_device_not_connected',
    noSession: true,
    message: `Open a session at the till first: ${what} on that session's device. ${PRINTER_GATE_SWITCH}`,
  })
}

/** A session as the service reads it. */
export const registerSession = (s: any): RegisterSession => ({
  id: String(s.id ?? s._id), warehouseId: String(s.warehouseId), cashierId: s.cashierId ? String(s.cashierId) : undefined, currency: s.currency,
})

/** The till's context for a session's warehouse: its device, if one is connected. */
export async function tillContext(orgId: string, user: RegisterUser, session: any, opts: { needsOperator: boolean; deviceNumber?: string }): Promise<RegisterContext> {
  let fiscal: FiscalCtx = null
  try {
    fiscal = await getFiscalContext(orgId, String(session.warehouseId), opts.deviceNumber)
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

/** A context with no device: what cannot be proved stays held, and nothing prints. */
export const deviceless = (orgId: string, user: RegisterUser): RegisterContext =>
  ({ orgId, user, session: null, printer: null, audit: { module: 'trade', entityType: 'pos_transaction' } })

/**
 * What finishing a receipt or a storno takes, on any request: the device it was printing on, when that
 * device is here. ⚠ Only that device. Another one's counter says nothing about it, and its УНП would be
 * refused there. A device in error, or held by another pod, proves nothing either, which is no reason
 * to fail the request: the document is held instead, and the person it reaches has a way out.
 */
export async function documentContext(orgId: string, user: RegisterUser, doc: any): Promise<RegisterContext> {
  const session = doc.register?.sessionId ? await POSSession.findOne({ _id: doc.register.sessionId, orgId }).lean().exec() : null
  if (!session || !doc.register?.fiscalDeviceNumber) return deviceless(orgId, user)
  try {
    return await tillContext(orgId, user, session, { needsOperator: false, deviceNumber: doc.register.fiscalDeviceNumber })
  } catch (e) {
    if (e instanceof RegisterRefusal) return deviceless(orgId, user)
    throw e
  }
}

/**
 * The device a person's word about `doc` has to get past at the settle door, by the number on the document.
 * Null when the word stands: a text document, which leaves no money on a device; one with no number; and a
 * device with no row or deactivated, which is the way out for one gone for good. Otherwise it refuses,
 * with nothing written, until the device can be asked.
 *
 * ⚠ Not `documentContext`. That turns every refusal into "no device", 503s included, which here would read
 * as "the word stands" with the money still on the device, and it needs a session. Not `getFiscalContext`
 * either: a device away whose row reads `error` throws there. A device connected while its row reads
 * `error` is asked here, as it is there, and a document on a closed session, or on none, reaches its device.
 */
export async function settleDevice(orgId: string, user: RegisterUser, doc: any): Promise<RegisterPrinter | null> {
  const deviceNumber = doc.register?.isFiscal ? doc.register.fiscalDeviceNumber : undefined
  if (!deviceNumber) return null
  const device: any = await getRepos().fiscalDevices.findOne({ orgId, deviceNumber } as any)
  // ⚠ Deactivated means said so: a row with no such field has not been, and the money may be on it.
  if (!device || device.isActive === false) return null
  if (isDeviceConnected(device.id)) {
    return tillPrinter(orgId, { deviceId: device.id, deviceNumber, printer: getPrinter(device.id), cashOnDeliveryRefusal: null, printsFiscalText: false }, user, null)
  }
  // ⚠ FR-24.52: held elsewhere is never "not here". The route hops to the holder first, so this is a
  // request no hop reached. A row naming this process, with nothing connected, is a bridge that just went.
  const row = await livePresence({ orgId, deviceNumber: String(deviceNumber) })
  if (row && row.podId !== POD_ID) {
    throw new RegisterRefusal(503, { code: 'fiscal_holder_unreachable', message: `Fiscal device "${device.name}" is connected to another server process. Nothing was done; try again.` })
  }
  throw new RegisterRefusal(409, { ...RECEIPT_DEVICE_AWAY })
}

/**
 * Finish the receipts and stornos of a document, a session or a sale whose request died, before
 * anything else is done with it: a receipt's hold must not outlive it, what printed must not be taken
 * again, and a session must not close over either. True when one was. It prints nothing, and books
 * nothing it cannot prove.
 */
export async function finishInterruptedDocuments(orgId: string, user: RegisterUser, where: string | { sessionId: string } | { ids: unknown[] }): Promise<boolean> {
  let any = false
  for (const doc of await interruptedDocuments(orgId, typeof where === 'string' ? { documentId: where } : where)) {
    if (!(await takeLease(Invoice, orgId, doc._id))) continue
    try {
      const c = await documentContext(orgId, user, doc)
      await auditStoppedSettlement(c, doc)
      await (doc.type === 'cash_storno' ? finishInterruptedStorno(c, doc) : finishInterruptedReceipt(c, doc))
      any = true
    } catch (e: any) {
      // What it holds stands, and the new request is told one is in progress. Nothing is lost.
      logger.error({ orgId, documentId: String(doc._id), error: e?.message }, 'Interrupted fiscal document could not be finished')
    }
  }
  return any
}

/**
 * Finish the sales of a session whose request died, before anything reads its figures. It prints nothing and
 * books what the sale's own request would have. One that cannot be finished stays what it was, and what it
 * holds stands: the close is refused over it, and the next attempt finds it again.
 */
export async function finishDeadSales(orgId: string, user: RegisterUser, sessionId: string): Promise<void> {
  for (const doc of await unfinishedReceipts(orgId, sessionId)) {
    if (saleProgress(doc) === 'dead') await finishDeadSale(orgId, user, doc)
  }
}

/** One sale whose request died. True when this request finished it. */
export async function finishDeadSale(orgId: string, user: RegisterUser, doc: any): Promise<boolean> {
  if (!(await takeLease(Invoice, orgId, doc._id))) return false
  try {
    const c = deviceless(orgId, user)
    // One a person settled, that stopped there: what they said reaches the trail however it ended.
    await auditStoppedSettlement(c, doc)
    await finishSale(c, String(doc._id))
    return true
  } catch (e: any) {
    logger.error({ orgId, documentId: String(doc._id), error: e?.message }, 'Interrupted sale could not be finished')
    return false
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

/**
 * What the till answers for a storno: the reversal; the 503 of #145 when its receipt is proved not to
 * have printed; and the truth when nobody knows: 409 `storno_in_doubt`, never "was not printed".
 */
export function stornoResponse(doc: any): { status: number; body: Record<string, unknown> } | { transaction: any; stockError?: string; receiptError?: string } {
  const transaction: any = asEntity(toPosTransaction(doc))
  if (doc.register?.fiscal?.inDoubt) return { status: 409, body: stornoInDoubtRefusal(doc) }
  if (doc.status === 'voided' && doc.register?.receiptError) {
    return { status: 503, body: { code: 'fiscal_error', message: `The storno receipt was not printed, so nothing was reversed: ${doc.register.receiptError}` } }
  }
  return {
    transaction,
    ...(transaction.receiptError ? { receiptError: transaction.receiptError } : {}),
    ...(transaction.stockError ? { stockError: transaction.stockError } : {}),
  }
}

export interface StornoDoorInput {
  orgId: string
  user: RegisterUser & { role?: string }
  originalId: string
  reason: string
  payments?: { method: string; amount: number; reference?: string }[]
  /** Which lines come back, and how much of each. Absent: all that is left. */
  lines?: { lineId: string; quantity: number }[]
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
 * `paid` with `stornoState: 'full'`, or `'partial'` while any of it is left (FR-23 R3). A sale an older
 * release rang up is stornoed as its copy, under the row's id (§6 edge 3).
 */
export async function stornoDoor(input: StornoDoorInput): Promise<ReturnType<typeof stornoResponse>> {
  const { orgId, user, key, hash } = input
  /** A back-office sale and its storno are invoicing's documents, audited as its own. */
  const backOffice = (): RegisterContext => ({ orgId, user, session: null, printer: null, audit: { module: 'invoicing', entityType: 'invoice' } })
  /** ⚠ A retry goes back to the device it started on: no other device's counter says anything about it. */
  const contextOf = (storno: any) => async (): Promise<RegisterContext> => {
    const original: any = await Invoice.findOne({ _id: input.originalId, orgId }).lean().exec()
    if (originOf(original) !== 'pos' || !input.session) return backOffice()
    try {
      return await tillContext(orgId, user, input.session, { needsOperator: printedFiscally(original), deviceNumber: storno.register?.fiscalDeviceNumber })
    } catch (e) {
      // A device in error, or held by another pod, proves nothing, which is no reason to fail the
      // retry: with no device it is `failed` if it never started, and held if it did.
      if (e instanceof RegisterRefusal && e.statusCode === 503) return backOffice()
      throw e
    }
  }
  const answer = (doc: any) => stornoResponse(doc)

  try {
    if (key) {
      const existing = await findKeyedTillDocument(orgId, key)
      if (existing) return answer(await settleKeyedDocument(existing, hash!, contextOf(existing), runStornoSteps))
    }

    // A sale an older release rang up is its copy since 0008/0009, under the same id.
    const read = (): Promise<any> => Invoice.findOne({ _id: input.originalId, orgId }).lean().exec()
    let original: any = Invoice.base.Types.ObjectId.isValid(input.originalId) ? await read() : null
    // What a request that died left on this sale comes first: a claim whose storno was never written, and one
    // that was, which may have printed, or be proved not to.
    if (stornoClaimed(original)) {
      const released = await releaseOrphanClaims(original)
      const finished = await finishInterruptedDocuments(orgId, user, { ids: original.register.stornoedBy ?? [] })
      if (released || finished) original = await read()
    }
    // And what a request that died left of the sale itself: its money stands, and it is booked before anything
    // reverses it, or the refund leaves a drawer that never had it. An imported day is refused as it stands.
    if (saleProgress(original) === 'dead' && originOf(original) !== 'import' && await finishDeadSale(orgId, user, original)) {
      original = await read()
    }
    /** The storno of a racing duplicate of this request, once nothing more is coming: every claim on the sale has its document. */
    const ownOnceWritten = async (): Promise<any | null> => {
      if (!key) return null
      for (let i = 0; i < 40; i++) {
        // ⚠ In this order. The other way round, a storno landing between the two reads was this
        // request's own, found as written and missed as "my key", so it was refused.
        const ids: unknown[] = (await read())?.register?.stornoedBy ?? []
        const written = await Invoice.countDocuments({ _id: { $in: ids }, orgId }).exec()
        const mine = await findKeyedTillDocument(orgId, key)
        if (mine) return mine
        if (written >= ids.length) return null
        await new Promise(res => setTimeout(res, 100))
      }
      return null
    }
    const part = !!input.lines?.length
    const refusal = await stornoRefusal(original, { part })
    if (refusal) {
      // ⚠ A duplicate sent at the same moment can read the sale AFTER the first request claimed it
      // and BEFORE that request wrote its storno, the document that carries the key. It answered
      // "already cancelled" for a storno that went through. So a keyed request waits for its key.
      if (key && stornoClaimed(original)) {
        for (let i = 0; i < 40; i++) {
          // ⚠ In this order. The other way round, a storno landing between the two reads was this
          // request's own, found as "a paid storno" and missed as "my key", so it was refused.
          const reversed = await Invoice.exists({ orgId, type: 'cash_storno', relatedInvoiceId: original._id, status: 'paid' }).exec()
          const ids: unknown[] = (await read())?.register?.stornoedBy ?? []
          const unwritten = ids.length > await Invoice.countDocuments({ _id: { $in: ids }, orgId }).exec()
          const mine = await Invoice.findOne({ orgId, clientKey: key }).lean().exec()
          if (mine) return answer(await settleKeyedDocument(mine, hash!, contextOf(mine), runStornoSteps))
          // An earlier part is "a paid storno" too: this request's own may still be between its claim and its insert.
          if (reversed && !unwritten) break
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
      if (session.status !== 'open') throw new RegisterRefusal(409, { ...SESSION_CLOSING })
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
    // #467: a sale that printed a slip is reversed by one, on its device, as a refund's storno is. With the device
    // away nothing prints, as before: a slip has no legal weight, and nothing on the device holds the sale.
    const printsSlip = !printsReceipt && !!c.printer?.printsText && printedAsText(original)

    /**
     * What this request takes of the sale as it stands, and how it goes back. All before the claim: a refused
     * refund leaves the sale as it was. `duplicate`: a racing duplicate of it got there first, and that is its answer.
     */
    const prepared = async (): Promise<{ plan: StornoPlan; payments?: StornoDoorInput['payments'] } | { duplicate: any }> => {
      // ⚠ What the operator names is what leaves the drawer, and the device prints the storno's own total whatever
      // it says. So no row below nothing, which the session's buckets drop and a sum would net off, and no sum but
      // the storno's: `{cash, 1000}` on a sale of 12 took 988 out of a drawer that never held it.
      const named = input.payments?.length ? input.payments : undefined
      if (named?.some(p => !((Number(p.amount) || 0) > 0))) {
        throw new RegisterRefusal(422, { code: 'storno_refund_not_positive', message: 'Every row of a refund is above 0. Nothing was reversed.' })
      }
      const assertAddsUp = (total: number) => {
        if (named && Math.round(named.reduce((s, p) => s + (Number(p.amount) || 0), 0) * 100) !== Math.round(total * 100)) {
          throw new RegisterRefusal(422, {
            code: 'storno_refund_mismatch',
            amount: total,
            message: `This storno gives back ${total.toFixed(2)}, and the refund named comes to something else. Nothing was reversed.`,
          })
        }
      }
      const plan = planStorno(original, input.lines)
      if (isPlanRefusal(plan)) {
        const mine = await ownOnceWritten()
        if (mine) return { duplicate: mine }
        throw new RegisterRefusal(plan.statusCode, plan.body)
      }
      if (!plan.partial) {
        assertStornoTender(input.payments, original, printsReceipt ? c.printer! : null, tillSale)
        assertAddsUp(plan.total)
        return { plan, payments: input.payments }
      }
      // ⚠ Lines that fit can still be more than what went back by a refund leaves of their rate: said here, in words a
      // person can use. A line's own parts never come to more than the line, so it takes money gone another way.
      const left = leftByRate(original)
      if ([...plan.want].some(([rate, cents]) => cents > (left.get(rate) || 0))) {
        throw new RegisterRefusal(409, {
          code: 'storno_exceeds_budget',
          left: totalOf(left) / 100,
          message: `These lines come to more than this sale's receipt still holds (${(totalOf(left) / 100).toFixed(2)}). Nothing was reversed.`,
        })
      }
      assertAddsUp(plan.total)
      const ids: unknown[] = original.register?.stornoedBy ?? []
      const stornos: any[] = ids.length ? await Invoice.find({ _id: { $in: ids }, orgId }, { status: 1, payments: 1 }).lean().exec() : []
      const payments = named ?? refundOfPart(leftByMethod(original, stornos), Math.round(plan.total * 100))
      assertStornoTender(payments, original, printsReceipt ? c.printer! : null, tillSale, plan.total)
      return { plan, payments }
    }

    const stornoId = newDocumentId()
    let plan: StornoPlan | undefined
    let payments: StornoDoorInput['payments']
    for (let attempt = 0; attempt < 5; attempt++) {
      const ready = await prepared()
      if ('duplicate' in ready) return answer(await settleKeyedDocument(ready.duplicate, hash!, contextOf(ready.duplicate), runStornoSteps))
      const claimed = await claimForStorno(original, stornoId, ready.plan)
      if (claimed) {
        original = claimed
        plan = ready.plan
        payments = ready.payments
        break
      }
      // ⚠ All of a sale nothing has touched: lost, it is someone else's by now, and it does not go on as "what is left".
      if (!ready.plan.partial) break
      // A part, on a sale that moved since it read it. The other storno may have taken what this one needs, or left
      // the rest, and which is what the next read says. A duplicate of this request is simply that request's.
      const mine = key ? await findKeyedTillDocument(orgId, key) : null
      if (mine) return answer(await settleKeyedDocument(mine, hash!, contextOf(mine), runStornoSteps))
      original = await read()
      const refused = await stornoRefusal(original, { part })
      if (refused) {
        // What refuses it may be its own duplicate, between that one's claim and its insert.
        const own = await ownOnceWritten()
        if (own) return answer(await settleKeyedDocument(own, hash!, contextOf(own), runStornoSteps))
        throw refused
      }
    }
    if (!plan) {
      // A duplicate of the request that won: wait for its storno, then answer as it does.
      if (key) {
        for (let i = 0; i < 40; i++) {
          const winner = await Invoice.findOne({ orgId, clientKey: key }).lean().exec()
          if (winner) return answer(await settleKeyedDocument(winner, hash!, contextOf(winner), runStornoSteps))
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
        orgId, user, original, reason: input.reason, payments, plan,
        session: tillSale ? registerSessionOf(session) : null, printsReceipt, printsSlip, printer: c.printer ?? null,
      })
      const outcome = await insertRegisterDocument(orgId, { ...doc, _id: stornoId }, key ? { key, hash: hash! } : undefined)
      if ('existing' in outcome) {
        await releaseStornoClaim(original, stornoId)
        return answer(await settleKeyedDocument(outcome.existing, hash!, contextOf(outcome.existing), runStornoSteps))
      }
      inserted = outcome.inserted
    } catch (e) {
      // Every early exit from here on must give the sale back.
      await releaseStornoClaim(original, stornoId)
      throw e
    }
    // #454: the claim's storno exists. Outside the block above: a failed mark must never give the sale back.
    await markStornoWritten(original, stornoId).catch(err => logger.warn({ err, stornoId: String(stornoId) }, 'Could not mark a storno claim as written'))
    return answer(await runStornoSteps({ ...c, printer: printsReceipt || printsSlip ? c.printer : null }, String(inserted._id)))
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

/** The way out of the printer gate. Every refusal of it says so: an org with no printer has no other. */
export const PRINTER_GATE_SWITCH = 'An organization that prints nothing here turns "A sale needs a connected fiscal printer" off in Settings → Organization → Cash register.'

/**
 * No sale without a connected printer (2026-10-31): a sale that prints — every till sale, and a
 * back-office sale that asked its session's device for a receipt — is refused when nothing would
 * print it, unless the org turned the rule off (a demo or test org with no device). Called before
 * anything is written, so a refused sale draws no number and no УНП.
 */
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
