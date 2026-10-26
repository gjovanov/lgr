import { Elysia, t } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { getRepos } from 'services/context'
import { orgDao } from 'services/dao/org.dao'
import { buildProductSearchFilter } from 'services/biz/search.utils'
import { createAuditEntry, generateCorrelationId } from 'services/biz/audit-log.service'
import { eventBus } from 'services/events/event-bus'
import { getNextNumber, generateUNP } from 'services/biz/sequence.service'
import { confirmMovement } from 'services/biz/warehouse.service'
import { logger } from 'services/logger'
import { Invoice, POSSession, POSTransaction } from 'db/models'
import { toPosTransaction } from 'services/biz/cash-register/mapping'
import { asEntity, findPosRow, loadPosRows } from 'services/biz/cash-register/pos-union'
import {
  isDeviceConnected,
  getPrinter,
  type IFiscalPrinter,
} from 'fiscal/fiscal-device.service'
import { toFiscalPaymentType } from 'fiscal/types'
import { mapTaxRateToVatGroup } from 'fiscal/vat-groups'
import { fiscalOperation } from 'fiscal/in-flight'
import { maySaleOpen } from 'fiscal/device-reach'
import { computePosTotals, roundCents } from 'config/pos-totals'
import {
  readIdempotencyKey, requestHash, assertSameRequest, isDuplicateKey, takeLease, waitForCompletion,
  IdempotencyError, LEASE_MS, WAIT_MS,
} from 'services/biz/hot-path-key'

/**
 * Look up the active fiscal device for a warehouse.
 * Returns { deviceId, deviceNumber, printer } if connected, or null if no fiscal device.
 * Throws if a device is configured but in error state (Appendix 29: must block operations).
 *
 * A warehouse can have more than one active device (e.g. a Tremol and an Eltrade while one
 * replaces the other). The CONNECTED one is used — picking an arbitrary one used to send a
 * sale to the unplugged device, which silently printed nothing.
 */
async function getFiscalContext(orgId: string, warehouseId: string) {
  const r = getRepos()
  const devices = await r.fiscalDevices.findMany({
    orgId,
    warehouseId,
    isActive: true,
  } as any) as any[]
  if (!devices?.length) return null

  const device = devices.find(d => isDeviceConnected(d.id))
  logger.info({ deviceIds: devices.map(d => d.id), connectedId: device?.id, warehouseId }, 'getFiscalContext: device lookup result')

  if (!device) {
    const failed = devices.find(d => d.status === 'error')
    if (failed) {
      throw new Error(`Fiscal device "${failed.name}" is in error state. Cannot process sale.`)
    }
    logger.warn({ deviceIds: devices.map(d => d.id), warehouseId }, 'Fiscal device offline, proceeding without fiscal receipt')
    return null
  }

  return {
    deviceId: device.id,
    deviceNumber: device.deviceNumber as string,
    printer: getPrinter(device.id),
  }
}

/**
 * The VAT-inclusive unit price a fiscal device must be given. POS lines carry NET prices
 * (the cart adds tax on top); a fiscal device derives VAT from the gross amount per group,
 * so sending the net price would print — and book — every line without its VAT.
 */
export function fiscalUnitPrice(netUnitPrice: number, taxRate: number | undefined): number {
  return roundCents(netUnitPrice * (1 + (taxRate || 0) / 100))
}

/**
 * Create a stock movement under the org's next `SM-<year>-NNNNN`: the latest existing number
 * + 1, the way every other movement path numbers them (movements UI, invoice dispatch,
 * transfers, document import).
 *
 * The POS used to draw from a Sequence counter of its own that nothing else advances. In an
 * org whose movements were booked elsewhere first, that counter pointed at numbers already
 * taken: every sale's movement hit the unique index, the error was only logged, and POS
 * sales never took anything out of stock.
 *
 * "Latest + 1" is read-then-write, so another till or an import booking at the same moment
 * can take the number first — a duplicate is retried with a fresh number rather than losing
 * the movement. (The movement number is the model's only unique key besides `_id`.)
 */
async function createNumberedMovement(r: ReturnType<typeof getRepos>, orgId: string, data: Record<string, any>) {
  const prefix = `SM-${new Date().getFullYear()}-`
  for (let attempt = 1; ; attempt++) {
    const latest = await r.stockMovements.findAll(
      { orgId, movementNumber: { $regex: `^${prefix}` } } as any,
      { page: 0, size: 1, sort: { movementNumber: -1 } },
    )
    const last = parseInt(String(latest.items[0]?.movementNumber ?? '').slice(prefix.length), 10)
    const movementNumber = `${prefix}${String((Number.isFinite(last) ? last : 0) + 1).padStart(5, '0')}`
    try {
      return await r.stockMovements.create({ ...data, orgId, movementNumber } as any)
    } catch (e: any) {
      if (e?.code !== 'DUPLICATE' || attempt >= 5) throw e
      logger.warn({ orgId, movementNumber, attempt }, 'POS stock movement number already taken, retrying')
    }
  }
}

// ── FR-09 (#18): end-of-day close ──────────────────────────────────────────

/** Payment buckets the close screen reconciles, in display order. */
export const CLOSE_METHODS = ['cash', 'card', 'other'] as const

export interface ExpectedTotals { cash: number; card: number; other: number }

/**
 * What the register SHOULD hold, from the session's own accumulators.
 *
 * Cash includes the opening float; card and other do not — nobody starts the day with a
 * card balance. Note this reads the session totals rather than `expectedBalance`, which is
 * only written at close.
 */
export function expectedTotals(session: any): ExpectedTotals {
  return {
    cash: round2((session.openingBalance || 0) + (session.totalCash || 0)),
    card: round2(session.totalCard || 0),
    other: round2(session.totalOther || 0),
  }
}

/**
 * #145: how much of a storno's refund leaves each close bucket.
 *
 * With explicit refund `payments` (how the operator actually pays it back), those are summed.
 * Without them it mirrors the ORIGINAL sale: what it put in each bucket comes back out of it —
 * card and other as paid, cash as tendered minus the change it handed back, which is the very
 * amount the sale added to `totalCash` (see the `/transaction` route). Never negative.
 */
export function stornoRefundBuckets(
  payments: { method: string; amount: number }[] | undefined,
  original: { payments?: { method: string; amount: number }[]; changeDue?: number },
): ExpectedTotals {
  const bucket = (m: string) => (m === 'cash' ? 'cash' : m === 'card' ? 'card' : 'other')
  const out: ExpectedTotals = { cash: 0, card: 0, other: 0 }
  const source = payments?.length ? payments : original.payments || []
  for (const p of source) out[bucket(p.method)] += Number(p.amount) || 0
  if (!payments?.length) out.cash -= Number(original.changeDue) || 0
  return { cash: Math.max(0, round2(out.cash)), card: Math.max(0, round2(out.card)), other: Math.max(0, round2(out.other)) }
}

export function buildClosingBreakdown(expected: ExpectedTotals, counted: Record<string, number | undefined>) {
  return CLOSE_METHODS.map(method => {
    const exp = round2(expected[method] || 0)
    const got = round2(Number(counted?.[method]) || 0)
    return { method, expected: exp, counted: got, difference: round2(got - exp) }
  })
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100
}

/**
 * The device to close the fiscal day on. Unlike `getFiscalContext` (which is about printing
 * a receipt and returns null for an offline device), this returns the CONFIGURED device
 * regardless of connection state — an unreachable device must produce a loud fiscal error,
 * not a silent skip. Prefers a connected device when a warehouse has more than one.
 */
async function resolveFiscalDeviceForClose(orgId: string, warehouseId: string): Promise<any | null> {
  const r = getRepos()
  const devices = await r.fiscalDevices.findMany({ orgId, warehouseId, isActive: true } as any) as any[]
  if (!devices?.length) return null
  return devices.find(d => isDeviceConnected(d.id)) || devices[0]
}

/**
 * Turn a printer error into something a cashier can act on. The transport layer throws
 * plain `Error`s with no codes, so this matches on their text — see the error inventory in
 * FR-09 §1 (`not connected`, `timeout`, `NAK`, `bridge disconnected`).
 */
function fiscalErrorMessage(raw: string): string {
  const m = raw.toLowerCase()
  if (m.includes('not connected') || m.includes('disconnected') || m.includes('timeout')) {
    return `Няма връзка с фискалното устройство. Денят НЕ е приключен. (${raw})`
  }
  return `Фискалното устройство върна грешка. Денят НЕ е приключен. (${raw})`
}

/**
 * Format receipt as text lines for non-fiscal printing (testing with non-fiscalized devices).
 * Uses the org locale for translated labels and the given (session) currency for amounts.
 */
function formatNonFiscalLines(body: any, transactionNumber: string, operatorName: string, locale: string, currency: string): string[] {
  const labels: Record<string, Record<string, string>> = {
    en: { subtotal: 'Subtotal:', vat: 'VAT:', total: 'TOTAL:', cash: 'CASH:', card: 'CARD:', change: 'CHANGE:', nonFiscal: '* NON-FISCAL *', operator: 'Op:' },
    bg: { subtotal: 'Междинна сума:', vat: 'ДДС:', total: 'ОБЩО:', cash: 'В БРОЙ:', card: 'КАРТА:', change: 'РЕСТО:', nonFiscal: '* НЕФИСКАЛЕН *', operator: 'Оп:' },
    de: { subtotal: 'Zwischensumme:', vat: 'MwSt:', total: 'GESAMT:', cash: 'BAR:', card: 'KARTE:', change: 'WECHSEL:', nonFiscal: '* NICHT-FISKAL *', operator: 'Op:' },
    mk: { subtotal: 'Меѓузбир:', vat: 'ДДВ:', total: 'ВКУПНО:', cash: 'ГОТОВИНА:', card: 'КАРТИЦА:', change: 'КУСУР:', nonFiscal: '* НЕФИСКАЛЕН *', operator: 'Оп:' },
  }
  const l = labels[locale] || labels.en

  const paymentLabels: Record<string, string> = {
    cash: l.cash,
    card: l.card,
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
 * Recalculate and validate totals from line items (H5: server-side validation).
 * Returns the verified totals or throws on mismatch.
 */
function validateTotals(body: any) {
  // The same function the terminal computes its screen with, so they cannot disagree.
  const { subtotal, discountTotal, taxTotal, total } = computePosTotals(body.lines)

  // The tolerance only serves clients that still round their own way (an open tab from
  // before the shared computation shipped); the current terminal sends exactly `total`.
  if (Math.abs(total - body.total) > 0.02) {
    throw new Error(`Total mismatch: calculated ${total.toFixed(2)}, received ${body.total.toFixed(2)}`)
  }

  const paymentTotal = body.payments.reduce((s: number, p: any) => s + p.amount, 0)
  if (paymentTotal < total - 0.02) {
    throw new Error(`Insufficient payment: total ${total.toFixed(2)}, paid ${paymentTotal.toFixed(2)}`)
  }

  return {
    subtotal,
    discountTotal,
    taxTotal,
    total,
    // Never negative: a cent short inside the tolerance is a shortfall, not change owed.
    changeDue: Math.max(0, roundCents(paymentTotal - total)),
  }
}

// ── The sale as resumable steps (FR-20.37, #155) ───────────────────────────────────────────
//
// A sale is: a УНП, the receipt, the session's totals, the stock. Each step records on the
// transaction that it ran, so a retry after a crash — or a duplicate request with the same
// `Idempotency-Key` — runs only what is missing. The receipt is the step that must never run
// twice: before printing, the device's last document number is stored, and a resume of an
// interrupted print compares it with the device's current one (see `printStep`).

type FiscalCtx = { deviceId: string; deviceNumber: string; printer: IFiscalPrinter } | null

interface SaleCtx {
  orgId: string
  user: any
  session: any
  body: any
  verified: ReturnType<typeof validateTotals>
  fiscal: FiscalCtx
  nonFiscal: boolean
}

/** What the route answers, rebuilt from the stored transaction — identical on every replay. */
async function saleResponse(id: string, orgId: string) {
  const txn = await getRepos().posTransactions.findByIdInOrg(id, orgId) as any
  return {
    transaction: { ...txn, fiscalReceiptNumber: txn.fiscalReceiptNumber, unpNumber: txn.unpNumber },
    ...(txn.receiptError ? { receiptError: txn.receiptError } : {}),
    ...(txn.stockError ? { stockError: txn.stockError } : {}),
  }
}

/** The receipt state a new transaction starts in. */
function initialFiscalState(body: any, fiscal: FiscalCtx, nonFiscal: boolean) {
  if (!fiscal || body.type !== 'sale') return { state: 'none' as const }
  return { state: 'pending' as const, mode: nonFiscal ? 'text' as const : 'fiscal' as const }
}

async function setTxn(id: string, set: Record<string, unknown>) {
  return POSTransaction.findByIdAndUpdate(id, { $set: set }, { new: true }).lean().exec() as any
}

/**
 * Print the receipt, at most once.
 *
 * - **First attempt:** store `attemptedAt` and the device's last document number, then print.
 * - **An interrupted attempt** (`attemptedAt` set, still `pending`): ask the device again.
 *   Unchanged → it did not print; print it. Exactly one more → that one is ours; record it.
 *   Anything else, or a device that cannot say (Tremol) → `unknown`, and NEVER reprinted: a
 *   second fiscal receipt for one sale is the failure this exists to prevent. The cashier
 *   checks the device. A text (non-fiscal) receipt has no legal weight and is simply reprinted.
 */
/**
 * A fiscal document (sale or storno receipt), printed at most once. `print` talks to the device
 * and returns the receipt number; this wraps it in the counter check described above, and
 * records the outcome on the transaction. Throws only what `print` throws.
 */
async function printFiscalOnce(fiscal: NonNullable<FiscalCtx>, txn: any, print: () => Promise<string>): Promise<any> {
  if (txn.fiscal?.attemptedAt) {
    const before = txn.fiscal.counterBefore
    const now = fiscal.printer.getLastReceiptNumber
      ? await fiscal.printer.getLastReceiptNumber().catch(() => undefined)
      : undefined
    if (before === undefined || now === undefined || (now !== before && now !== before + 1)) {
      logger.warn({ transactionId: String(txn._id), before, now }, 'Interrupted fiscal receipt: device cannot confirm it — not reprinting')
      return setTxn(txn._id, {
        'fiscal.state': 'unknown',
        receiptError: 'The receipt was interrupted and the device cannot confirm whether it printed. Check the device; do not ring the sale up again.',
      })
    }
    if (now === before + 1) {
      const receiptNo = String(now).padStart(7, '0')
      logger.info({ transactionId: String(txn._id), receiptNo }, 'Interrupted fiscal receipt had printed — recorded, not reprinted')
      return setTxn(txn._id, {
        'fiscal.state': 'printed', 'fiscal.receiptNo': receiptNo, 'fiscal.printedAt': new Date(),
        fiscalReceiptNumber: receiptNo, printedAt: new Date(),
      })
    }
    // now === before: it never printed. Print it.
  }

  // The counter goes on the record BEFORE the device is touched.
  const counterBefore = fiscal.printer.getLastReceiptNumber
    ? await fiscal.printer.getLastReceiptNumber().catch(() => undefined)
    : undefined
  await setTxn(txn._id, { 'fiscal.attemptedAt': new Date(), 'fiscal.counterBefore': counterBefore })
  const fiscalReceiptNumber = await print()
  return setTxn(txn._id, {
    'fiscal.state': 'printed', 'fiscal.receiptNo': fiscalReceiptNumber, 'fiscal.printedAt': new Date(),
    fiscalReceiptNumber, printedAt: new Date(),
  })
}

async function printStep(c: SaleCtx, txn: any): Promise<any> {
  const r = getRepos()
  const fiscal = c.fiscal
  const mode = txn.fiscal?.mode
  if (!fiscal) {
    return setTxn(txn._id, { 'fiscal.state': 'unknown', receiptError: 'The fiscal device is no longer connected — check whether the receipt printed.' })
  }

  const operatorCode = c.user.operatorCode
  const operatorName = `${c.user.firstName} ${c.user.lastName}`
  const body = c.body

  if (mode === 'text') {
    if (!fiscal.printer.openNonFiscalReceipt) {
      const receiptError = 'This fiscal device cannot print non-fiscal receipts — switch "Non-fiscal" off to issue a fiscal receipt.'
      return setTxn(txn._id, { 'fiscal.state': 'failed', 'fiscal.error': receiptError, receiptError })
    }
    await setTxn(txn._id, { 'fiscal.attemptedAt': new Date() })
    const org = await orgDao.findById(c.orgId) as any
    const orgLocale = org?.settings?.locale || 'en'
    const receiptCurrency = c.session.currency || org?.settings?.baseCurrency || 'EUR'
    try {
      await fiscal.printer.openNonFiscalReceipt(operatorCode || '1')
      const receiptBody = { ...body, subtotal: c.verified.subtotal, taxTotal: c.verified.taxTotal, total: c.verified.total, changeDue: c.verified.changeDue }
      for (const line of formatNonFiscalLines(receiptBody, txn.transactionNumber, operatorName, orgLocale, receiptCurrency)) {
        await fiscal.printer.printNonFiscalText!(line)
      }
      await fiscal.printer.closeNonFiscalReceipt!()
      await r.fiscalDevices.update(fiscal.deviceId, { lastCommunicationAt: new Date(), status: 'online' } as any)
      logger.info({ transactionId: String(txn._id), transactionNumber: txn.transactionNumber }, 'Receipt printed (non-fiscal text mode)')
      return setTxn(txn._id, { 'fiscal.state': 'printed', 'fiscal.printedAt': new Date(), printedAt: new Date() })
    } catch (e: any) {
      try { await fiscal.printer.closeNonFiscalReceipt!() } catch { /* best-effort */ }
      logger.error({ transactionId: String(txn._id), error: e.message }, 'Receipt printing FAILED')
      await r.fiscalDevices.update(fiscal.deviceId, { status: 'error' } as any)
      return setTxn(txn._id, { 'fiscal.state': 'failed', 'fiscal.error': e.message, receiptError: e.message })
    }
  }

  try {
    return await printFiscalOnce(fiscal, txn, async () => {
      await fiscal.printer.openFiscalReceipt(operatorCode, operatorName, txn.unpNumber)
      for (const line of body.lines) {
        const taxRate = line.taxRate ?? 0
        await fiscal.printer.printSaleLine(
          line.name,
          line.quantity,
          fiscalUnitPrice(line.unitPrice, taxRate),
          mapTaxRateToVatGroup(taxRate),
          line.discount || undefined,
          taxRate,
        )
      }
      for (const payment of body.payments) {
        await fiscal.printer.printPayment(toFiscalPaymentType(payment.method), payment.amount)
      }
      const { fiscalReceiptNumber } = await fiscal.printer.closeFiscalReceipt()
      await r.fiscalDevices.update(fiscal.deviceId, { lastCommunicationAt: new Date(), status: 'online' } as any)
      logger.info({ transactionId: String(txn._id), unpNumber: txn.unpNumber, fiscalReceiptNumber }, 'Fiscal receipt printed')
      return fiscalReceiptNumber
    })
  } catch (e: any) {
    // Void the half-printed receipt, or the device refuses everything after it. Drivers
    // without a cancel keep the old best-effort close.
    try {
      if (fiscal.printer.cancelFiscalReceipt) await fiscal.printer.cancelFiscalReceipt()
      else await fiscal.printer.closeFiscalReceipt()
    } catch { /* printer may not have an open receipt */ }
    logger.error({ transactionId: String(txn._id), unpNumber: txn.unpNumber, error: e.message }, 'Fiscal receipt printing FAILED')
    await r.fiscalDevices.update(fiscal.deviceId, { status: 'error' } as any)
    return setTxn(txn._id, { 'fiscal.state': 'failed', 'fiscal.error': e.message, receiptError: e.message })
  }
}

/** The session's accumulators — claimed and applied in one Mongo transaction, so never twice. */
async function applySessionTotals(c: SaleCtx, txn: any): Promise<void> {
  const body = c.body
  const incData: Record<string, number> = { transactionCount: 1 }
  if (body.type === 'sale') incData.totalSales = c.verified.total
  else if (body.type === 'return') incData.totalReturns = c.verified.total

  const cashPayment = body.payments.filter((p: any) => p.method === 'cash').reduce((s: number, p: any) => s + p.amount, 0)
  const cardPayment = body.payments.filter((p: any) => p.method === 'card').reduce((s: number, p: any) => s + p.amount, 0)
  // FR-9.2: mobile/voucher were accepted per transaction but never summed, so the
  // close screen had no expected value to show for them.
  const otherPayment = body.payments
    .filter((p: any) => p.method !== 'cash' && p.method !== 'card')
    .reduce((s: number, p: any) => s + p.amount, 0)
  // Change goes back out of the drawer in cash, so the drawer keeps what was tendered in
  // cash minus the change. Adding the tendered amount made the close expect money the
  // till had already handed back.
  const cashKept = roundCents(cashPayment - c.verified.changeDue)
  if (cashKept) incData.totalCash = cashKept
  if (cardPayment) incData.totalCard = cardPayment
  if (otherPayment) incData.totalOther = otherPayment

  const s = await POSTransaction.startSession()
  try {
    await s.withTransaction(async () => {
      const claimed = await POSTransaction.findOneAndUpdate(
        { _id: txn._id, sessionTotalsApplied: { $ne: true } },
        { $set: { sessionTotalsApplied: true } },
        { session: s },
      ).exec()
      if (claimed) await POSSession.updateOne({ _id: c.session.id ?? c.session._id }, { $inc: incData }, { session: s }).exec()
    })
  } finally {
    await s.endSession()
  }
}

/** The dispatch movement. A crash after creating it is found again by its note, never duplicated. */
async function stockStep(c: SaleCtx, txn: any): Promise<void> {
  const r = getRepos()
  try {
    const productLines = c.body.lines.filter((l: any) => l.productId)
    if (!productLines.length) return
    const notes = `POS sale ${txn.transactionNumber}`
    let movement = await r.stockMovements.findOne({ orgId: c.orgId, type: 'dispatch', notes } as any) as any
    if (!movement) {
      const movementLines = productLines.map((l: any) => ({
        productId: l.productId,
        quantity: l.quantity,
        unitCost: l.unitPrice,
        totalCost: l.quantity * l.unitPrice,
      }))
      const totalAmount = movementLines.reduce((s: number, l: any) => s + l.totalCost, 0)
      movement = await createNumberedMovement(r, c.orgId, {
        type: 'dispatch', status: 'draft', date: new Date(),
        fromWarehouseId: c.session.warehouseId, lines: movementLines, totalAmount,
        notes, createdBy: c.user.id,
      })
    }
    if (movement.status === 'draft') await confirmMovement(movement.id, r)
    await setTxn(txn._id, { movementId: movement.id })
  } catch (e: any) {
    logger.error({ transactionId: String(txn._id), error: e.message }, 'POS stock movement failed')
    await setTxn(txn._id, { stockError: e.message })
  }
}

/** Run whatever the transaction has not done yet, then mark it complete. */
async function runSaleSteps(c: SaleCtx, id: string): Promise<void> {
  let txn = await POSTransaction.findById(id).lean().exec() as any

  if (c.fiscal && !c.nonFiscal && !txn.unpNumber) {
    const unpNumber = await generateUNP(c.orgId, c.fiscal.deviceNumber, c.user.operatorCode)
    txn = await setTxn(id, { unpNumber })
  }
  // One fiscal operation from the first command to the last, so a graceful stop cannot land
  // between "open receipt" and "close receipt" (FR-20.23).
  if (txn.fiscal?.state === 'pending') txn = await fiscalOperation(() => printStep(c, txn))
  if (!txn.sessionTotalsApplied) await applySessionTotals(c, txn)
  if (c.body.type === 'sale' && !txn.movementId && !txn.stockError) await stockStep(c, txn)

  const done = await POSTransaction.findOneAndUpdate(
    { _id: id, completedAt: { $exists: false } },
    { $set: { completedAt: new Date() }, $unset: { leaseUntil: 1 } },
    { new: true },
  ).lean().exec() as any
  if (done) {
    createAuditEntry({ orgId: c.orgId, userId: c.user.id, operatorCode: c.user.operatorCode, action: 'create', module: 'trade', entityType: 'pos_transaction', entityId: id, entityName: done.transactionNumber, unpNumber: done.unpNumber })
  }
}

/**
 * A request carrying a key that is already on a transaction: replay it, finish it, or wait for
 * whoever is finishing it. Never starts the sale a second time.
 */
type Status = (code: number, body: Record<string, unknown>) => any
type CtxOrError<C> = C | { error: [number, Record<string, unknown>] }

async function settleKeyed<C>(
  existing: any,
  hash: string,
  ctx: () => Promise<CtxOrError<C>>,
  run: (c: C, id: string) => Promise<void>,
  respond: (id: string, status: Status) => Promise<any>,
  status: Status,
) {
  assertSameRequest(existing.requestHash, hash)
  const id = String(existing._id)
  if (existing.completedAt) return respond(id, status)

  for (let round = 0; round < 2; round++) {
    const leased = await takeLease(POSTransaction, String(existing.orgId), existing._id)
    if (leased) {
      const c = await ctx()
      if (c && typeof c === 'object' && 'error' in (c as any)) {
        const [code, body] = (c as any).error
        return status(code, body)
      }
      await run(c as C, id)
      return respond(id, status)
    }
    const { doc, leaseLapsed } = await waitForCompletion(POSTransaction, String(existing.orgId), existing._id)
    if (doc?.completedAt) return respond(id, status)
    if (!leaseLapsed) break
  }
  return status(409, { code: 'idempotency_in_progress', message: 'This request is still being processed — retry with the same Idempotency-Key.' })
}

/**
 * FR-21.10 — a keyed till request whose sale or storno lives as a cash-register document.
 *
 * From R2 the till writes its sales as documents in `invoices`. After a rollback to this code, a
 * retry of such a request must find it there and answer as it did: never ring the sale up a second
 * time, with a second УНП and a second receipt. This code cannot resume another release's steps, so
 * a document still in progress answers 409 and the client retries until it completes.
 */
async function answerFromDocument(orgId: string, key: string, hash: string, status: Status, kind: 'sale' | 'storno') {
  const doc: any = await Invoice.findOne({ orgId, clientKey: key }).lean().exec()
  if (!doc) return null
  if (doc.requestHash !== hash) {
    return status(422, { code: 'idempotency_key_reused', message: 'This Idempotency-Key was already used for a different request' })
  }
  if (!doc.completedAt) {
    return status(409, { code: 'idempotency_in_progress', message: 'This request is still being processed — retry with the same Idempotency-Key.' })
  }
  const transaction: any = asEntity(toPosTransaction(doc))
  if (kind === 'storno' && transaction.status === 'cancelled' && transaction.receiptError) {
    return status(503, {
      code: 'fiscal_error',
      message: `The storno receipt was not printed, so nothing was reversed: ${transaction.receiptError}`,
    })
  }
  return {
    transaction,
    ...(kind === 'sale' && transaction.receiptError ? { receiptError: transaction.receiptError } : {}),
    ...(transaction.stockError ? { stockError: transaction.stockError } : {}),
  }
}

/** A keyed request's replay or resume, with a reused key turned into its 422. */
async function settle<C>(
  existing: any, hash: string, ctx: () => Promise<CtxOrError<C>>,
  run: (c: C, id: string) => Promise<void>, respond: (id: string, status: Status) => Promise<any>, status: Status,
) {
  try {
    return await settleKeyed(existing, hash, ctx, run, respond, status)
  } catch (e: any) {
    if (e instanceof IdempotencyError) return status(e.statusCode, { code: e.code, message: e.message })
    throw e
  }
}

// ── The storno as resumable steps ──────────────────────────────────────────────────────────

interface StornoCtx {
  orgId: string
  user: any
  session: any
  body: any
  original: any
  fiscal: FiscalCtx
}

/** The storno's answer from its stored record: the reversal, or the 503 of #145. */
async function stornoResponse(id: string, orgId: string, status: Status) {
  const txn = await getRepos().posTransactions.findByIdInOrg(id, orgId) as any
  if (txn.status === 'cancelled' && txn.receiptError) {
    return status(503, {
      code: 'fiscal_error',
      message: `The storno receipt was not printed, so nothing was reversed: ${txn.receiptError}`,
    })
  }
  return {
    transaction: { ...txn, fiscalReceiptNumber: txn.fiscalReceiptNumber, unpNumber: txn.unpNumber },
    ...(txn.stockError ? { stockError: txn.stockError } : {}),
  }
}

async function runStornoSteps(c: StornoCtx, id: string): Promise<void> {
  const r = getRepos()
  const { original, body, user } = c
  let txn = await POSTransaction.findById(id).lean().exec() as any

  if (c.fiscal && !txn.unpNumber) {
    txn = await setTxn(id, { unpNumber: await generateUNP(c.orgId, c.fiscal.deviceNumber, user.operatorCode) })
  }

  if (txn.fiscal?.state === 'pending') {
    if (!c.fiscal) {
      txn = await setTxn(id, { 'fiscal.state': 'unknown', receiptError: 'The fiscal device is no longer connected — check whether the storno printed.' })
    } else {
      const fiscal = c.fiscal
      try {
        txn = await fiscalOperation(() => printFiscalOnce(fiscal, txn, async () => {
          const stornoLines = original.lines.map((l: any) => ({
            name: l.name,
            quantity: l.quantity,
            // VAT-inclusive, like the sale it reverses (see fiscalUnitPrice)
            price: fiscalUnitPrice(l.unitPrice, l.taxRate ?? 0),
            vatGroup: mapTaxRateToVatGroup(l.taxRate ?? 0),
            taxRate: l.taxRate ?? 0,
          }))
          const paymentMethod = body.payments?.[0]?.method || original.payments?.[0]?.method || 'cash'
          const result = await fiscal.printer.printStornoReceipt(
            user.operatorCode, `${user.firstName} ${user.lastName}`, txn.unpNumber,
            original.fiscalReceiptNumber, original.createdAt, original.unpNumber,
            body.reason, stornoLines,
            { type: toFiscalPaymentType(paymentMethod), amount: original.total },
          )
          logger.info({ transactionId: id, unpNumber: txn.unpNumber, fiscalReceiptNumber: result.fiscalReceiptNumber }, 'Storno fiscal receipt printed')
          return result.fiscalReceiptNumber
        }))
      } catch (e: any) {
        logger.error({ transactionId: id, error: e.message }, 'Storno fiscal receipt printing FAILED')
        await r.fiscalDevices.update(fiscal.deviceId, { status: 'error' } as any)
        txn = await setTxn(id, { 'fiscal.state': 'failed', 'fiscal.error': e.message, receiptError: e.message })
      }
    }
  }

  // ⚠ #145: a storno the fiscal device did not record is NOT a storno. Nothing moves: the sale
  // is given back, the storno row is voided, and the operator is told to retry. An `unknown`
  // outcome counts as not recorded — the device has to be checked before anything is refunded.
  if (txn.fiscal?.state === 'failed' || txn.fiscal?.state === 'unknown') {
    await POSTransaction.updateOne({ _id: original.id, orgId: c.orgId }, { $set: { status: 'completed' } }).exec()
    await POSTransaction.updateOne(
      { _id: id, completedAt: { $exists: false } },
      { $set: { status: 'cancelled', completedAt: new Date() }, $unset: { leaseUntil: 1 } },
    ).exec()
    return
  }

  if (!txn.sessionTotalsApplied) {
    // H1 + #145: the refund leaves the drawer by the method it is paid out in, so the close
    // screen expects what is actually left — the same buckets and the same rule as a sale
    // (cash = tendered − change; mobile/voucher → other), with the sign reversed.
    const refund = stornoRefundBuckets(body.payments, original)
    const stornoInc: Record<string, number> = { totalReturns: original.total, transactionCount: 1 }
    if (refund.cash) stornoInc.totalCash = -refund.cash
    if (refund.card) stornoInc.totalCard = -refund.card
    if (refund.other) stornoInc.totalOther = -refund.other
    const s = await POSTransaction.startSession()
    try {
      await s.withTransaction(async () => {
        const claimed = await POSTransaction.findOneAndUpdate(
          { _id: id, sessionTotalsApplied: { $ne: true } },
          { $set: { sessionTotalsApplied: true } },
          { session: s },
        ).exec()
        if (claimed) await POSSession.updateOne({ _id: txn.sessionId }, { $inc: stornoInc }, { session: s }).exec()
      })
    } finally {
      await s.endSession()
    }
  }

  // Reverse stock movement — found again by its note after a crash, never duplicated.
  if (original.movementId && !txn.movementId && !txn.stockError) {
    try {
      const notes = `Storno reversal for ${original.transactionNumber}`
      let movement = await r.stockMovements.findOne({ orgId: c.orgId, type: 'return', notes } as any) as any
      if (!movement) {
        const movementLines = original.lines.filter((l: any) => l.productId).map((l: any) => ({
          productId: l.productId, quantity: l.quantity, unitCost: l.unitPrice, totalCost: l.quantity * l.unitPrice,
        }))
        const totalAmount = movementLines.reduce((s: number, l: any) => s + l.totalCost, 0)
        movement = await createNumberedMovement(r, c.orgId, {
          type: 'return', status: 'draft', date: new Date(),
          toWarehouseId: c.session.warehouseId, lines: movementLines, totalAmount,
          notes, createdBy: user.id,
        })
      }
      if (movement.status === 'draft') await confirmMovement(movement.id, r)
      await setTxn(id, { movementId: movement.id })
    } catch (e: any) {
      logger.error({ transactionId: id, error: e.message }, 'Storno stock reversal failed')
      await setTxn(id, { stockError: e.message })
    }
  }

  const done = await POSTransaction.findOneAndUpdate(
    { _id: id, completedAt: { $exists: false } },
    { $set: { completedAt: new Date() }, $unset: { leaseUntil: 1 } },
    { new: true },
  ).lean().exec() as any
  if (done) {
    createAuditEntry({ orgId: c.orgId, userId: user.id, operatorCode: user.operatorCode, action: 'storno', module: 'trade', entityType: 'pos_transaction', entityId: id, entityName: `${done.transactionNumber} (storno of ${original.transactionNumber})`, unpNumber: done.unpNumber })
  }
}

/** The body of a POS sale. */
const SALE_BODY = t.Object({
  type: t.Union([t.Literal('sale'), t.Literal('return'), t.Literal('exchange')]),
  customerId: t.Optional(t.String()),
  lines: t.Array(t.Object({
    productId: t.String(),
    name: t.String(),
    quantity: t.Number({ minimum: 1 }),
    unitPrice: t.Number(),
    discount: t.Optional(t.Number()),
    taxRate: t.Optional(t.Number()),
    taxAmount: t.Optional(t.Number()),
    lineTotal: t.Number(),
    type: t.Optional(t.String()),
    priceExplanation: t.Optional(t.Array(t.Object({
      type: t.Union([t.Literal('base'), t.Literal('tag'), t.Literal('contact'), t.Literal('override')]),
      label: t.String(),
      price: t.Number(),
    }))),
  })),
  subtotal: t.Number(),
  discountTotal: t.Optional(t.Number()),
  taxTotal: t.Optional(t.Number()),
  total: t.Number(),
  payments: t.Array(t.Object({
    method: t.Union([t.Literal('cash'), t.Literal('card'), t.Literal('mobile'), t.Literal('voucher')]),
    amount: t.Number(),
    reference: t.Optional(t.String()),
  })),
  changeDue: t.Optional(t.Number()),
  nonFiscal: t.Optional(t.Boolean()),
})

// ── The terminals' catalog ──────────────────────────────────────────────────────────────────
// `GET /catalog` is the product grid of the till (PosTerminalView) and of the cash-sale terminal
// (CashSaleTerminal); `GET /catalog/lookup` is the one product Enter adds from their search.

/** The grid's filter: active products, the typed search, and the category / type / tag filters. */
function catalogFilter(orgId: string, query: Record<string, any>): Record<string, any> {
  const productFilter: Record<string, any> = { orgId, isActive: true }
  if (query.search) {
    // The same search the inventory product list runs (see buildProductSearchFilter).
    Object.assign(productFilter, buildProductSearchFilter(query.search as string))
  }
  if (query.category) productFilter.category = query.category
  if (query.type) productFilter.type = query.type
  if (query.tags) {
    const tagList = Array.isArray(query.tags) ? query.tags : (query.tags as string).split(',')
    productFilter.tags = { $in: tagList }
  }
  return productFilter
}

/** Products the way a terminal shows them, with the stock of `warehouseId` when one is given. */
async function toCatalogProducts(orgId: string, items: any[], warehouseId: unknown) {
  const stockMap = new Map<string, number>()
  if (warehouseId && items.length > 0) {
    const productIds = items.map((p: any) => p.id)
    const stockLevels = await getRepos().stockLevels.findMany(
      { orgId, warehouseId, productId: { $in: productIds } } as any,
    )
    for (const sl of stockLevels) {
      stockMap.set(sl.productId, sl.quantity)
    }
  }
  return items.map((p: any) => ({
    productId: p.id,
    productName: p.name,
    sku: p.sku,
    barcode: p.barcode,
    unitPrice: p.sellingPrice,
    taxRate: p.taxRate ?? 0,
    unit: p.unit,
    type: p.type,
    category: p.category,
    stockAvailable: stockMap.get(p.id) ?? null,
  }))
}

type CodeMatch = 'barcode' | 'sku' | 'search'

/**
 * FR-22.55: the product Enter adds from a terminal's search. A barcode scanner types the code
 * and presses Enter within milliseconds, long before the search's 300 ms debounce has filtered
 * the grid, so the terminal asks here instead of counting the cards it shows.
 *
 * The first rung that matches anything decides:
 *   1. the barcode is the code: as typed, then ignoring case;
 *   2. the SKU is the code, the same way (a barcode outranks a SKU: a scanner reads barcodes);
 *   3. no exact match: the grid's own search, with the grid's filters, finds exactly one product.
 * Two products on the deciding rung answer `null`, as does a search finding several: a scan is
 * never guessed, and the terminal shows the search instead. Only active products, as in the
 * grid. The exact rungs ignore the grid's category / type / tag filters: a scanned article is
 * that article, whatever the cashier was browsing.
 */
async function lookupCatalogCode(
  orgId: string,
  code: string,
  query: Record<string, any>,
): Promise<{ product: any; matchedBy: CodeMatch } | null> {
  const r = getRepos()
  const lower = code.toLocaleLowerCase('bg')
  // The raw fields as well as the `*Lower` mirrors: a product written past the mirror hooks
  // (a bulkWrite) is still found by the code exactly as printed on it.
  const exact = await r.products.findAll({
    orgId,
    isActive: true,
    $or: [{ barcode: code }, { barcodeLower: lower }, { sku: code }, { skuLower: lower }],
  } as any, { page: 0, size: 20, sort: { name: 1 } })
  const folded = (v: unknown) => (typeof v === 'string' ? v.toLocaleLowerCase('bg') : undefined)
  const rungs: Array<[CodeMatch, (p: any) => boolean]> = [
    ['barcode', p => p.barcode === code],
    ['barcode', p => folded(p.barcode) === lower],
    ['sku', p => p.sku === code],
    ['sku', p => folded(p.sku) === lower],
  ]
  for (const [matchedBy, matches] of rungs) {
    const hits = exact.items.filter(matches)
    if (hits.length === 1) return { product: hits[0], matchedBy }
    if (hits.length > 1) return null
  }
  const found = await r.products.findAll(catalogFilter(orgId, { ...query, search: code }), { page: 0, size: 2, sort: { name: 1 } })
  return found.total === 1 ? { product: found.items[0], matchedBy: 'search' } : null
}

export const posController = new Elysia({ prefix: '/org/:orgId/trade/pos' })
  .use(AppAuthService)
  // ── POS Catalog (server-side pagination + filters) ──
  .get('/catalog', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const page = Math.max(0, Number(query.page) || 0)
    const size = Math.min(200, Math.max(1, Number(query.size) || 24))
    const sortBy = (query.sortBy as string) || 'name'
    const sortOrder = (query.sortOrder as string) === 'desc' ? -1 : 1

    const productResult = await r.products.findAll(catalogFilter(orgId, query), { page, size, sort: { [sortBy]: sortOrder } })
    const products = await toCatalogProducts(orgId, productResult.items, query.warehouseId)

    return { products, total: productResult.total, totalPages: productResult.totalPages, page, size }
  }, { isSignIn: true })
  // FR-22.55: the one product Enter adds from the till's or the cash-sale terminal's search —
  // `{ product, matchedBy }`, or `{ product: null }` when the code names nothing unambiguously.
  // `warehouseId`, `category`, `type` and `tags` are the grid's own parameters.
  .get('/catalog/lookup', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const code = typeof query.code === 'string' ? query.code.trim() : ''
    const hit = code ? await lookupCatalogCode(orgId, code, query) : null
    if (!hit) return { product: null, matchedBy: null }
    const [product] = await toCatalogProducts(orgId, [hit.product], query.warehouseId)
    return { product, matchedBy: hit.matchedBy }
  }, { isSignIn: true })
  // ── Sessions ──
  .post(
    '/session',
    async ({ params: { orgId }, body, user, status, headers }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      let key: string | undefined
      try {
        key = readIdempotencyKey(headers)
      } catch (e: any) {
        return status(e.statusCode, { code: e.code, message: e.message })
      }
      const hash = key ? requestHash('pos.session.open', body) : undefined
      /** A retried open returns the session it opened — before the "already open" check would refuse it. */
      const replay = async (keyed: any) => {
        if (keyed.requestHash !== hash) {
          return status(422, { code: 'idempotency_key_reused', message: 'This Idempotency-Key was already used for a different request' })
        }
        return { session: await r.posSessions.findById(String(keyed._id)) }
      }
      if (key) {
        const keyed = await POSSession.findOne({ orgId, clientKey: key }).lean().exec()
        if (keyed) return replay(keyed)
      }

      const existing = await r.posSessions.findOne({ orgId, cashierId: user.id, status: 'open' } as any)
      if (existing) return status(400, { message: 'You already have an open session' })

      try {
        await getFiscalContext(orgId, body.warehouseId)
      } catch (e: any) {
        return status(503, { message: e.message })
      }

      const sessionNumber = await getNextNumber(orgId, 'POS', 6)

      let session: any
      try {
        session = await r.posSessions.create({
          ...body,
          orgId,
          sessionNumber,
          cashierId: user.id,
          openedAt: new Date(),
          status: 'open',
          totalSales: 0,
          totalReturns: 0,
          totalCash: 0,
          totalCard: 0,
          transactionCount: 0,
          ...(key ? { clientKey: key, requestHash: hash } : {}),
        } as any)
      } catch (e: any) {
        // A concurrent duplicate of this open won the insert: answer with its session.
        if (!key || !(isDuplicateKey(e) || e?.code === 'DUPLICATE')) throw e
        const keyed = await POSSession.findOne({ orgId, clientKey: key }).lean().exec()
        if (!keyed) throw e
        return replay(keyed)
      }

      createAuditEntry({ orgId, userId: user.id, operatorCode: user.operatorCode, action: 'create', module: 'trade', entityType: 'pos_session', entityId: session.id, entityName: sessionNumber })

      return { session }
    },
    {
      isSignIn: true,
      body: t.Object({
        warehouseId: t.String(),
        openingBalance: t.Number({ minimum: 0 }),
        currency: t.String(),
      }),
    },
  )
  .get('/session', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const filter: Record<string, any> = { orgId }
    if (query.status) filter.status = query.status
    if (query.cashierId) filter.cashierId = query.cashierId

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'openedAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1

    const result = await r.posSessions.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { sessions: result.items, ...result }
  }, { isSignIn: true })
  .get('/session/:id', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()
    const session = await r.posSessions.findOne({ id, orgId } as any)
    if (!session) return status(404, { message: 'POS session not found' })
    return { session }
  }, { isSignIn: true })
  /**
   * FR-9.8 — what the operator sees BEFORE committing: the expected amount per method, the
   * fiscal device that will be used, and whether anyone else still has this warehouse open
   * (a Z-report zeroes the DEVICE's fiscal day, not just one session).
   */
  .get('/session/:id/close-preview', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()

    const session = await r.posSessions.findOne({ id, orgId } as any) as any
    if (!session) return status(404, { message: 'POS session not found' })

    const device = await resolveFiscalDeviceForClose(orgId, String(session.warehouseId))
    const openOnWarehouse = await POSSession.countDocuments({
      orgId, warehouseId: session.warehouseId, status: 'open', _id: { $ne: id },
    }).exec()

    return {
      expected: expectedTotals(session),
      currency: session.currency,
      openSessionsOnWarehouse: openOnWarehouse,
      fiscalDevice: device
        ? { id: device.id, name: device.name, deviceNumber: device.deviceNumber, connected: isDeviceConnected(device.id) }
        : null,
    }
  }, { isSignIn: true })

  /**
   * FR-9.3–9.6 — the real close.
   *
   * Order matters and is the whole point: **the Z-report runs FIRST**, and the session is
   * only marked closed once the device confirms. The old flow closed the session
   * unconditionally and never spoke to the printer at all, so a day could read as closed in
   * LGR while the fiscal device still had it open — exactly the state the ordinance exists
   * to prevent.
   *
   * Backward compatible: the legacy `{ closingBalance }` body still works and maps to
   * `counted.cash` (existing e2e and any API clients depend on it).
   */
  .post(
    '/session/:id/close',
    async ({ params: { orgId, id }, body, user, status, headers }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()
      const b = body as any

      let key: string | undefined
      try {
        key = readIdempotencyKey(headers)
      } catch (e: any) {
        return status(e.statusCode, { code: e.code, message: e.message })
      }
      const hash = key ? requestHash(`pos.session.close:${id}`, body) : undefined

      /**
       * The close this key already made, or the one in progress under it. A retry after a
       * successful close gets that close back — never a second Z-report, never "already
       * closed". A close that failed was released (its key cleared), so its retry closes anew.
       */
      const replayClose = async (): Promise<any> => {
        const deadline = Date.now() + WAIT_MS
        for (;;) {
          const s = await POSSession.findOne({ _id: id, orgId }).lean().exec() as any
          if (!s || s.closeClientKey !== key) return null
          if (s.closeRequestHash !== hash) {
            return status(422, { code: 'idempotency_key_reused', message: 'This Idempotency-Key was already used for a different request' })
          }
          if (s.status === 'closed') {
            return { session: await r.posSessions.findByIdInOrg(id, orgId), fiscalStatus: s.fiscalStatus, zReportNumber: s.zReportNumber }
          }
          if (Date.now() >= deadline) {
            return status(409, { code: 'idempotency_in_progress', message: 'This close is still being processed — retry with the same Idempotency-Key.' })
          }
          await new Promise(res => setTimeout(res, 150))
        }
      }

      const session = await r.posSessions.findOne({ id, orgId } as any) as any
      if (!session) return status(404, { message: 'POS session not found' })
      if (key && session.closeClientKey === key) {
        const replayed = await replayClose()
        if (replayed) return replayed
      }
      if (session.status === 'closed') return status(400, { message: 'Session already closed' })

      // The cashier who owns the session may close it; anyone else needs a manager role.
      const isManager = user.role === 'admin' || user.role === 'manager'
      if (String(session.cashierId) !== String(user.id) && !isManager) {
        return status(403, { message: 'Only the session owner or a manager can close it' })
      }

      // Legacy single-number body maps onto the cash line.
      const counted = b.counted ?? { cash: Number(b.closingBalance) || 0 }
      const expected = expectedTotals(session)

      /**
       * A conditional transition, not a read-then-write: two tills hitting Close at once
       * used to both proceed, each firing its own Z-report. The loser now sees "already
       * closing" instead.
       */
      const claimed = await POSSession.findOneAndUpdate(
        { _id: id, orgId, status: 'open' },
        { $set: { status: 'closing_control', ...(key ? { closeClientKey: key, closeRequestHash: hash } : {}) } },
        { new: true },
      ).exec()
      if (!claimed) {
        // A concurrent duplicate of this close holds the claim: answer as it does.
        if (key) {
          const replayed = await replayClose()
          if (replayed) return replayed
        }
        return status(400, { message: 'Session is already being closed' })
      }

      /** Put the session back the way we found it — a failed close must not strand it. */
      const release = async (fiscalStatus?: 'failed', fiscalError?: string) => {
        await POSSession.updateOne(
          { _id: id, orgId },
          {
            $set: { status: 'open', ...(fiscalStatus ? { fiscalStatus, fiscalError } : {}) },
            $unset: { closeClientKey: 1, closeRequestHash: 1 },
          },
        ).exec()
      }

      const device = await resolveFiscalDeviceForClose(orgId, String(session.warehouseId))

      let fiscalStatus: 'closed' | 'skipped' = 'skipped'
      let zReportNumber: string | undefined
      let fiscalClosedAt: Date | undefined

      if (device && b.closeWithoutFiscal) {
        // Only an explicit, privileged decision may bypass a device that exists. A
        // connected-but-failing device is NEVER silently skipped.
        if (!isManager) {
          await release()
          return status(403, { message: 'Closing without a fiscal report requires a manager' })
        }
      } else if (device) {
        try {
          const printer = getPrinter(device.id)
          const report = await printer.printDailyZReport()
          fiscalStatus = 'closed'
          fiscalClosedAt = new Date()
          // Tremol reports 'unknown' — store nothing rather than that literal, so the UI
          // can say "the fiscal day is closed" without printing a bogus number.
          const num = (report as any)?.reportNumber
          if (num && num !== 'unknown') zReportNumber = String(num)
        } catch (e: any) {
          const message = e?.message || 'Fiscal device error'
          await release('failed', message.slice(0, 300))
          // Mirror the sale path: a device that just failed is marked so the next operation
          // does not walk into it blind.
          try {
            await r.fiscalDevices.update(device.id, { status: 'error' } as any)
          } catch { /* the close outcome must not depend on this bookkeeping */ }

          logger.error({ orgId, sessionId: id, deviceId: device.id, err: message }, 'Z-report failed — session left open')
          createAuditEntry({
            orgId, userId: user.id, operatorCode: user.operatorCode, action: 'z_report_failed',
            module: 'pos', entityType: 'pos_session', entityId: id, entityName: session.sessionNumber,
          })
          return status(503, { code: 'fiscal_error', message: fiscalErrorMessage(message) })
        }
      }
      // device === null → no active device on this warehouse; close proceeds as 'skipped'.

      const breakdown = buildClosingBreakdown(expected, counted)
      const cashLine = breakdown.find(l => l.method === 'cash')!

      let updated: any
      try {
        updated = await POSSession.findOneAndUpdate(
          { _id: id, orgId },
          {
            $set: {
              status: 'closed',
              closedAt: new Date(),
              // Legacy fields keep their cash-only meaning — the JE handler reads `difference`.
              closingBalance: cashLine.counted,
              expectedBalance: cashLine.expected,
              difference: cashLine.difference,
              closingBreakdown: breakdown,
              notes: b.notes ?? session.notes,
              fiscalStatus,
              fiscalError: undefined,
              ...(zReportNumber ? { zReportNumber } : {}),
              ...(fiscalClosedAt ? { fiscalClosedAt } : {}),
              ...(device ? { fiscalDeviceId: device.id } : {}),
            },
          },
          { new: true },
        ).exec()
      } catch (e: any) {
        // FR-9 edge case 5: the fiscal day IS closed on the device but we could not record
        // it. Say so loudly — the recovery is a retry with closeWithoutFiscal.
        logger.error(
          { orgId, sessionId: id, err: e?.message },
          'Z-report succeeded but the session update failed — retry the close with closeWithoutFiscal',
        )
        await release()
        return status(500, {
          message: 'The fiscal day was closed on the device, but the session could not be updated. Retry the close without a fiscal report.',
        })
      }

      const correlationId = generateCorrelationId()
      createAuditEntry({
        orgId, userId: user.id, operatorCode: user.operatorCode, action: 'close',
        module: 'pos', entityType: 'pos_session', entityId: id, entityName: session.sessionNumber,
        correlationId,
      })
      if (fiscalStatus === 'closed') {
        createAuditEntry({
          orgId, userId: user.id, operatorCode: user.operatorCode, action: 'z_report',
          module: 'pos', entityType: 'pos_session', entityId: id,
          entityName: zReportNumber || session.sessionNumber,
          correlationId,
        })
      }

      // Emit for cross-module batch movement + journal entry creation (unchanged: async,
      // fire-and-forget — a JE failure must not un-close a fiscally closed day).
      eventBus.emit('pos.session.closed', { sessionId: id, orgId, userId: user.id })

      return { session: updated, fiscalStatus, zReportNumber }
    },
    {
      isSignIn: true,
      body: t.Object({
        /** Legacy single-number form — still accepted, maps to `counted.cash`. */
        closingBalance: t.Optional(t.Number()),
        counted: t.Optional(t.Object({
          cash: t.Number(),
          card: t.Optional(t.Number()),
          other: t.Optional(t.Number()),
        })),
        notes: t.Optional(t.String()),
        closeWithoutFiscal: t.Optional(t.Boolean()),
      }),
    },
  )
  // ── Transactions ──
  .post(
    '/session/:id/transaction',
    async ({ params: { orgId, id: sessionId }, body, user, status, headers }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      const r = getRepos()

      let key: string | undefined
      try {
        key = readIdempotencyKey(headers)
      } catch (e: any) {
        return status(e.statusCode, { code: e.code, message: e.message })
      }

      const session = await r.posSessions.findOne({ id: sessionId, orgId } as any) as any
      logger.info({ sessionId, orgId, sessionWarehouse: session?.warehouseId, sessionStatus: session?.status }, 'POS transaction: session loaded')
      if (!session) return status(404, { message: 'POS session not found' })

      // H5: Server-side total validation
      let verified: ReturnType<typeof validateTotals>
      try {
        verified = validateTotals(body)
      } catch (e: any) {
        return status(400, { message: e.message })
      }
      const nonFiscal = !!body.nonFiscal

      /** The fiscal device and the checks that depend on it — for a new sale or a resumed one. */
      const saleContext = async (): Promise<SaleCtx | { error: [number, Record<string, unknown>] }> => {
        let fiscal: FiscalCtx = null
        try {
          fiscal = await getFiscalContext(orgId, session.warehouseId)
        } catch (e: any) {
          return { error: [503, { message: e.message }] }
        }
        logger.info({ hasFiscal: !!fiscal, fiscalDeviceNumber: fiscal?.deviceNumber }, 'POS transaction: fiscal context resolved')
        if (!user.operatorCode && fiscal && !nonFiscal) {
          return { error: [400, { message: 'User has no operator code. Contact admin to assign one before using POS with fiscal device.' }] }
        }
        return { orgId, user, session, body, verified, fiscal, nonFiscal }
      }

      // ⚠ A keyed retry is answered BEFORE anything is allocated: a sale that already happened
      // must not draw a second УНП, transaction number or receipt — even if the session has
      // closed since (the retry is of a sale made while it was open).
      const hash = key ? requestHash(`pos.sale:${sessionId}`, body) : undefined
      const respond = (id: string) => saleResponse(id, orgId)
      if (key) {
        const existing = await POSTransaction.findOne({ orgId, clientKey: key }).lean().exec()
        if (existing) return settle(existing, hash!, saleContext, runSaleSteps, respond, status)
        const fromDocument = await answerFromDocument(orgId, key, hash!, status, 'sale')
        if (fromDocument) return fromDocument
      }

      if (session.status === 'closed') return status(400, { message: 'Session is closed' })

      const c = await saleContext()
      if ('error' in c) return status(c.error[0], c.error[1])

      // FR-20.49 — Прил. 29 т. 8: no fiscal sale opens on a device not reached in two hours (SUPTO
      // production mode only). ⚠ Here, for a NEW sale only: a keyed retry above is a sale that
      // already opened, and refusing it now would strand its receipt.
      if (!nonFiscal) {
        const verdict = await maySaleOpen(orgId, session.warehouseId)
        if (!verdict.ok) {
          return status(409, {
            code: 'fiscal_device_unreached',
            message: `The fiscal device "${verdict.deviceName}" has not answered for more than 2 hours. A sale cannot open until it does (Н-18, Прил. 29 т. 8).`,
            deviceName: verdict.deviceName,
            lastCommunicationAt: verdict.lastCommunicationAt,
          })
        }
      }

      const transactionNumber = await getNextNumber(orgId, 'TXN', 7)

      // The УНП is drawn AFTER this row exists (`runSaleSteps`), so of several requests racing
      // on one key, only the one whose insert wins ever draws one.
      let transaction: any
      try {
        transaction = await r.posTransactions.create({
          ...body,
          orgId,
          sessionId,
          transactionNumber,
          status: 'completed',
          // Use server-validated totals
          subtotal: verified.subtotal,
          discountTotal: verified.discountTotal,
          taxTotal: verified.taxTotal,
          total: verified.total,
          changeDue: verified.changeDue,
          fiscalDeviceNumber: c.fiscal?.deviceNumber,
          isFiscal: !!c.fiscal && !nonFiscal,
          fiscal: initialFiscalState(body, c.fiscal, nonFiscal),
          ...(key ? { clientKey: key, requestHash: hash, leaseUntil: new Date(Date.now() + LEASE_MS) } : {}),
          createdBy: user.id,
        } as any)
      } catch (e: any) {
        if (!key || !(isDuplicateKey(e) || e?.code === 'DUPLICATE')) throw e
        const existing = await POSTransaction.findOne({ orgId, clientKey: key }).lean().exec()
        if (!existing) throw e
        return settle(existing, hash!, saleContext, runSaleSteps, respond, status)
      }

      await runSaleSteps(c, transaction.id)
      return saleResponse(transaction.id, orgId)
    },
    {
      isSignIn: true,
      body: SALE_BODY,
    },
  )
  .get('/session/:id/transaction', async ({ params: { orgId, id: sessionId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const r = getRepos()
    const filter: Record<string, any> = { orgId, sessionId }
    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const sortOrder = (query.sortOrder as string) === 'asc' ? 1 : -1
    const result = await r.posTransactions.findAll(filter, { page, size, sort: { [sortBy]: sortOrder } })
    return { transactions: result.items, ...result }
  }, { isSignIn: true })
  // ── Storno (Appendix 29 compliance) ──
  .post(
    '/session/:id/storno',
    async ({ params: { orgId, id: sessionId }, body, user, status, headers }) => {
      if (!user) return status(401, { message: 'Unauthorized' })

      // H4: Storno requires manager or admin role
      if (!['admin', 'manager', 'warehouse_manager'].includes(user.role)) {
        return status(403, { message: 'Storno requires manager or admin authorization' })
      }

      let key: string | undefined
      try {
        key = readIdempotencyKey(headers)
      } catch (e: any) {
        return status(e.statusCode, { code: e.code, message: e.message })
      }

      const r = getRepos()

      const session = await r.posSessions.findOne({ id: sessionId, orgId } as any) as any
      if (!session) return status(404, { message: 'POS session not found' })

      const original = await r.posTransactions.findOne({ id: body.originalTransactionId, orgId } as any) as any
      if (!original) {
        // FR-21: a till sale a newer release wrote as a cash-register document. This release can
        // read it but not reverse it (FR-21 §6, edge 5); its storno waits for that release.
        if (key) {
          const fromDocument = await answerFromDocument(orgId, key, requestHash(`pos.storno:${sessionId}`, body), status, 'storno')
          if (fromDocument) return fromDocument
        }
        if (await findPosRow(orgId, body.originalTransactionId)) {
          return status(409, {
            code: 'storno_needs_newer_release',
            message: 'This sale was recorded by a newer version of LGR. It can be reversed once that version is running again.',
          })
        }
        return status(404, { message: 'Original transaction not found' })
      }

      const stornoContext = async (): Promise<CtxOrError<StornoCtx>> => {
        try {
          const fiscal = await getFiscalContext(orgId, session.warehouseId)
          if (!user.operatorCode && fiscal) {
            return { error: [400, { message: 'User has no operator code. Contact admin to assign one before using POS with fiscal device.' }] }
          }
          return { orgId, user, session, body, original, fiscal }
        } catch (e: any) {
          return { error: [503, { message: e.message }] }
        }
      }

      // A keyed retry is answered before the original is claimed again or anything is allocated.
      const hash = key ? requestHash(`pos.storno:${sessionId}`, body) : undefined
      const findKeyed = () => key ? POSTransaction.findOne({ orgId, clientKey: key }).lean().exec() : Promise.resolve(null)
      const answerKeyed = (row: any) => settle(row, hash!, stornoContext, runStornoSteps, (id: string, st: Status) => stornoResponse(id, orgId, st), status)
      const keyed = await findKeyed()
      if (keyed) return answerKeyed(keyed)
      if (key) {
        const fromDocument = await answerFromDocument(orgId, key, hash!, status, 'storno')
        if (fromDocument) return fromDocument
      }

      if (session.status === 'closed') return status(400, { message: 'Session is closed' })
      if (original.status === 'cancelled') {
        // ⚠ A duplicate sent at the same moment can read the sale AFTER the first request claimed
        // it and BEFORE that request wrote its storno row, the row that carries the key (the
        // fiscal context and the number are in between). It answered "already cancelled" for a
        // storno that went through. So a keyed request waits for the row, as a lost claim does.
        // One query sees both "the row with my key" and "a live storno of this sale", so a row
        // written between two reads cannot be taken for somebody else's.
        if (key) {
          for (let i = 0; i < 40; i++) {
            const rows: any[] = await POSTransaction.find({
              orgId,
              $or: [
                { clientKey: key },
                // A storno whose receipt failed was given back and is `cancelled` itself (#145).
                { type: 'storno', originalTransactionId: original.id, status: { $ne: 'cancelled' } },
              ],
            }).lean().exec()
            const mine = rows.find(t => t.clientKey === key)
            if (mine) return answerKeyed(mine)
            if (rows.length) break   // reversed by another request
            await new Promise(res => setTimeout(res, 100))
          }
        }
        return status(400, { message: 'Original transaction is already cancelled' })
      }
      if (original.type === 'storno') return status(400, { message: 'Cannot storno a storno transaction' })

      // #145: a storno goes back through the till that took the money — the same warehouse, so
      // the same fiscal device the original receipt was printed on (the storno receipt cites
      // that device's receipt number) and the drawer the refund physically leaves.
      const originalSession = await r.posSessions.findOne({ id: String(original.sessionId), orgId } as any) as any
      if (originalSession && String(originalSession.warehouseId) !== String(session.warehouseId)) {
        return status(400, { code: 'storno_other_warehouse', message: 'A storno must be made in a session of the warehouse the sale was made in' })
      }

      // ⚠ CLAIM the original before anything else happens. Read-then-write let two clicks (or two
      // tills) both pass the `cancelled` check above and refund the same sale twice — two storno
      // receipts, twice the stock back, twice the cash out. Exactly one caller wins this update.
      const claimed = await POSTransaction.findOneAndUpdate(
        { _id: original.id, orgId, status: 'completed' },
        { $set: { status: 'cancelled' } },
      ).exec()
      if (!claimed) {
        // A duplicate of the request that won: wait for its storno row, then answer as it does.
        if (key) {
          for (let i = 0; i < 40; i++) {
            const winner = await findKeyed()
            if (winner) return answerKeyed(winner)
            await new Promise(res => setTimeout(res, 100))
          }
        }
        return status(409, { code: 'storno_in_progress', message: 'This sale is already being reversed' })
      }

      // Every early exit from here on must give the sale back its `completed` status.
      const releaseClaim = () => POSTransaction.updateOne({ _id: original.id, orgId }, { $set: { status: 'completed' } }).exec()

      const c = await stornoContext()
      if ('error' in c) {
        await releaseClaim()
        return status(c.error[0], c.error[1])
      }

      const transactionNumber = await getNextNumber(orgId, 'TXN', 7)
      const printsReceipt = !!c.fiscal && original.isFiscal && !!original.fiscalReceiptNumber

      const stornoTransaction = await r.posTransactions.create({
        orgId, sessionId, transactionNumber, type: 'storno', status: 'completed',
        customerId: original.customerId, lines: original.lines,
        subtotal: original.subtotal, discountTotal: original.discountTotal,
        taxTotal: original.taxTotal, total: original.total,
        payments: body.payments || original.payments, changeDue: 0,
        fiscalDeviceNumber: c.fiscal?.deviceNumber, isFiscal: !!c.fiscal,
        fiscal: printsReceipt ? { state: 'pending', mode: 'fiscal' } : { state: 'none' },
        originalTransactionId: original.id, originalUNP: original.unpNumber,
        originalFiscalReceiptNumber: original.fiscalReceiptNumber,
        originalTransactionDate: original.createdAt, stornoReason: body.reason,
        ...(key ? { clientKey: key, requestHash: hash, leaseUntil: new Date(Date.now() + LEASE_MS) } : {}),
        createdBy: user.id,
      } as any)

      await runStornoSteps(c, stornoTransaction.id)
      return stornoResponse(stornoTransaction.id, orgId, status)
    },
    {
      isSignIn: true,
      body: t.Object({
        originalTransactionId: t.String(),
        reason: t.Union([t.Literal('operator_error'), t.Literal('customer_return'), t.Literal('price_reduction'), t.Literal('tax_base_reduction')]),
        payments: t.Optional(t.Array(t.Object({
          method: t.Union([t.Literal('cash'), t.Literal('card'), t.Literal('mobile'), t.Literal('voucher')]),
          amount: t.Number(),
          reference: t.Optional(t.String()),
        }))),
      }),
    },
  )
  // ── Global Transaction List (across all sessions) ──
  // FR-21.8: both stores, each row once — a till sale is a POS row until R2 and a cash-register
  // document after it. Filtered, sorted and paged after the union; the shape is the one this
  // route always answered (the DAL's page). The journal (`/cash-register/documents`) replaces it.
  .get('/transactions', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    const from = query.dateFrom ? new Date(query.dateFrom as string) : undefined
    const to = query.dateTo ? new Date(query.dateTo as string + 'T23:59:59') : undefined
    let rows = await loadPosRows({ orgId, from, to, sessionId: (query.sessionId as string) || undefined })
    if (query.type) rows = rows.filter(t => t.type === query.type)
    if (query.status) rows = rows.filter(t => t.status === query.status)
    if (query.isFiscal !== undefined) {
      const want = query.isFiscal === 'true'
      rows = rows.filter(t => !!t.isFiscal === want)
    }
    if (query.search) {
      const needle = String(query.search).toLowerCase()
      rows = rows.filter(t =>
        String(t.transactionNumber || '').toLowerCase().includes(needle)
        || String(t.unpNumber || '').toLowerCase().includes(needle))
    }

    const page = Math.max(0, Number(query.page) || 0)
    const size = query.size !== undefined ? Number(query.size) : 10
    const sortBy = (query.sortBy as string) || 'createdAt'
    const dir = (query.sortOrder as string) === 'asc' ? 1 : -1
    const key = (v: unknown) => (v instanceof Date ? v.getTime() : typeof v === 'string' && sortBy.endsWith('At') ? Date.parse(v) : v) as any
    rows.sort((a, b) => {
      const x = key(a[sortBy])
      const y = key(b[sortBy])
      return (x === y ? 0 : x === undefined || x === null ? -1 : y === undefined || y === null ? 1 : x < y ? -1 : 1) * dir
    })

    const total = rows.length
    const items = size > 0 ? rows.slice(page * size, page * size + size) : rows
    return {
      transactions: items,
      items,
      total,
      page: size > 0 ? page : 0,
      size: size > 0 ? size : items.length,
      totalPages: size > 0 ? Math.ceil(total / size) : 1,
    }
  }, { isSignIn: true })
  .get('/transactions/:txnId', async ({ params: { orgId, txnId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    const transaction = await findPosRow(orgId, txnId)
    if (!transaction) return status(404, { message: 'Transaction not found' })
    return { transaction }
  }, { isSignIn: true })
