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
import { Invoice, Org, POSSession, POSTransaction } from 'db/models'
import { getRepos } from 'services/context'
import { orgDao } from 'services/dao/org.dao'
import { logger } from 'services/logger'
import { waitForCompletion } from 'services/biz/hot-path-key'
import { toPosTransaction } from 'services/biz/cash-register/mapping'
import { asEntity } from 'services/biz/cash-register/pos-union'
import { copyPosRow } from 'services/biz/cash-register/copy'
import type { RegisterPrinter } from 'services/biz/cash-register/printer'
import {
  RegisterRefusal, claimForStorno, insertRegisterDocument, newDocumentId, originOf, printedFiscally, releaseStornoClaim,
  runStornoSteps, settleKeyedDocument, stornoDocument, stornoRefusal,
  type RegisterContext, type RegisterSession, type RegisterUser,
} from 'services/biz/cash-register/register.service'
import { isDeviceConnected, getPrinter, type IFiscalPrinter } from 'fiscal/fiscal-device.service'
import { toFiscalPaymentType } from 'fiscal/types'
import { mapTaxRateToVatGroup } from 'fiscal/vat-groups'
import { fiscalOperation } from 'fiscal/in-flight'
import { roundCents } from 'config/pos-totals'

/** Who may reverse a sale (H4, #145). */
export const STORNO_ROLES = ['admin', 'manager', 'warehouse_manager']

export type FiscalCtx = { deviceId: string; deviceNumber: string; printer: IFiscalPrinter } | null

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
    logger.warn({ deviceIds: devices.map(d => d.id), warehouseId }, 'Fiscal device offline, proceeding without fiscal receipt')
    return null
  }

  return { deviceId: device.id, deviceNumber: device.deviceNumber as string, printer: getPrinter(device.id) }
}

/**
 * The VAT-inclusive unit price a fiscal device must be given. Till lines carry NET prices (the
 * cart adds tax on top); a fiscal device derives VAT from the gross amount per group, so sending
 * the net price would print — and book — every line without its VAT.
 */
export function fiscalUnitPrice(netUnitPrice: number, taxRate: number | undefined): number {
  return roundCents(netUnitPrice * (1 + (taxRate || 0) / 100))
}

/** What the customer handed over, per payment: the device computes the change itself. */
const tendered = (doc: any) => (doc.payments || []).map((p: any) => ({ method: p.method, amount: Number(p.tendered ?? p.amount) || 0 }))

/**
 * Format receipt as text lines for non-fiscal printing (testing with non-fiscalized devices).
 * Uses the org locale for translated labels and the given (session) currency for amounts.
 */
export function formatNonFiscalLines(body: any, transactionNumber: string, operatorName: string, locale: string, currency: string): string[] {
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
    printsText: !!p.openNonFiscalReceipt,
    async printSale(doc) {
      await p.openFiscalReceipt(operatorCode, operatorName, doc.register?.unp)
      for (const line of doc.lines || []) {
        const taxRate = line.taxRate ?? 0
        await p.printSaleLine(line.description, line.quantity, fiscalUnitPrice(line.unitPrice, taxRate), mapTaxRateToVatGroup(taxRate), line.discount || undefined, taxRate)
      }
      for (const payment of tendered(doc)) await p.printPayment(toFiscalPaymentType(payment.method), payment.amount)
      const { fiscalReceiptNumber } = await p.closeFiscalReceipt()
      return fiscalReceiptNumber
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
      const method = storno.payments?.[0]?.method || original.payments?.[0]?.method || 'cash'
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
      // Drivers without a cancel keep the old best-effort close.
      if (p.cancelFiscalReceipt) await p.cancelFiscalReceipt()
      else await p.closeFiscalReceipt()
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
    operation: fn => fiscalOperation(fn),
  }
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

const IN_PROGRESS = { code: 'idempotency_in_progress', message: 'This request is still being processed — retry with the same Idempotency-Key.' }

/**
 * The document a keyed till request already made, in either store (FR-21.10, §6 edge 1). A POS row
 * an older release wrote is copied on the spot — after the request that holds it finishes — and
 * then replayed or resumed as a document. A storno row brings its sale along.
 */
export async function findKeyedTillDocument(orgId: string, key: string): Promise<any | null> {
  const doc = await Invoice.findOne({ orgId, clientKey: key }).lean().exec()
  if (doc) return doc
  const row: any = await POSTransaction.findOne({ orgId, clientKey: key }).lean().exec()
  if (!row) return null
  if (!row.completedAt && row.leaseUntil && new Date(row.leaseUntil).getTime() > Date.now()) {
    const { doc: done } = await waitForCompletion(POSTransaction, orgId, row._id)
    if (!done?.completedAt) throw new RegisterRefusal(409, IN_PROGRESS)
  }
  if (row.originalTransactionId) await copyPosRow(orgId, String(row.originalTransactionId))
  return copyPosRow(orgId, String(row._id))
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
 * `paid` with `stornoState: 'full'`. A sale still held as a POS row is copied first; the claim is
 * taken on the copy and the frozen row is never written (§6 edge 3).
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

    // From either store: a sale an older release rang up is copied first.
    const original: any = await copyPosRow(orgId, input.originalId)
    const refusal = await stornoRefusal(original)
    if (refusal) {
      // ⚠ A duplicate sent at the same moment can read the sale AFTER the first request claimed it
      // and BEFORE that request wrote its storno, the document that carries the key. It answered
      // "already cancelled" for a storno that went through. So a keyed request waits for its key.
      if (key && original?.register?.stornoState === 'full') {
        for (let i = 0; i < 40; i++) {
          const mine = await Invoice.findOne({ orgId, clientKey: key }).lean().exec()
          if (mine) return answer(await settleKeyedDocument(mine, hash!, context, runStornoSteps))
          if (await Invoice.exists({ orgId, type: 'cash_storno', relatedInvoiceId: original._id, status: 'paid' }).exec()) break
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
    const printsReceipt = !!c.printer && printedFiscally(original)

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

/** The org's settings the till reads: its base currency, and whether it may sell below zero. */
export async function tillSettings(orgId: string): Promise<{ baseCurrency?: string; allowNegativeStock: boolean }> {
  const org: any = await Org.findById(orgId, { 'settings.baseCurrency': 1, 'settings.cashRegister': 1 }).lean().exec()
  return {
    baseCurrency: org?.settings?.baseCurrency,
    // FR-21.16: unset means allowed, which is what the till always did.
    allowNegativeStock: org?.settings?.cashRegister?.allowNegativeStock !== false,
  }
}
