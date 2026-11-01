import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import ExcelJS from 'exceljs'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import { gate, until } from '../helpers/receipt-world'
import { allowSalesWithoutPrinter, createTestAccount, createTestContact } from '../helpers/factories'
import { captureRejection } from '../helpers/capture-rejection'
import { AuditLog, FiscalDevice, FiscalPresence, Invoice, Journal, JournalEntry, Org, POSSession, Product, Sequence, StockLevel, StockMovement } from 'db/models'
import { deviceFromCounter, deviceFromDeadReceipt, setFiscalForwarding } from 'fiscal/fiscal-route'
import { statsController } from 'invoicing-api/src/controllers/stats.controller'
import { contactController } from 'invoicing-api/src/controllers/contact.controller'
import { invoiceExportController } from 'invoicing-api/src/controllers/invoice-export.controller'
import { agingReportController } from 'invoicing-api/src/controllers/aging-report.controller'
import { convertDraftInvoice, persistInvoiceDraft } from 'services/biz/doc-import/persist'
import { orgsToSettle, unsettledInvoices } from 'services/biz/settlement-backlog'
import { eventBus } from 'services/events/event-bus'
import { postPosSessionJournal, registerEventHandlers, resetEventHandlers } from 'services/events/handlers'
import { reportById, validateParams } from 'services/biz/report-registry'
import { buildDailyDigest } from 'services/biz/digest/daily-digest.service'
import { getProductLedger } from 'services/biz/product-ledger.service'
import { getContactLedger } from 'services/biz/contact-ledger.service'
import { getInvoiceSummary } from 'services/biz/invoice-summary.service'
import { listJournal } from 'services/biz/cash-register/journal.service'
import { loadPosRows } from 'services/biz/cash-register/pos-union'
import {
  exportCancelledSales, exportItemizedSales, exportPaymentDetails, exportReversedSales, exportSummarizedSales,
} from 'services/biz/supto-export.service'
import { deviceEvidence } from 'services/biz/home/device-witness.service'
import { buildSessionReport, formatSessionReport } from 'services/biz/cash-register/session-report'
import { buildInvoiceHtml } from 'reporting/pdf/invoice.pdf'
import { printableDocument } from 'invoicing-api/src/lib/invoice-pdf'
import { bookingOf } from 'services/biz/move/fenced-import.service'
import { fitsDue } from 'services/biz/invoice-payment'
import { prepareClashCorrection } from 'services/biz/number-clash.service'
import { localDayOf } from 'services/biz/local-day'
import { config } from 'config'

/**
 * FR-23 R1 — a fiscal receipt for a cash or card payment on an invoice or a debit note, on the
 * Eltrade simulator.
 *
 * The invoice is the sale: it moves the stock and posts the revenue. The receipt is the money: it
 * joins the open session of whoever takes it, prints once, and records the payment. These drive the
 * doors a person uses (`/send`, `/payments`) and the import conversion, which never prints.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

/** A document's date: today, as a receipt's is the moment it printed. Nothing here depends on the day it runs. */
const TODAY = new Date().toISOString().slice(0, 10)

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = tillApp().use(statsController).use(contactController).use(invoiceExportController).use(agingReportController) as any
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { forgetDevices(); await clearCollections() }, 30_000)

/** The world's product at `quantity` × `price` net, 20 %: `taxAmount` and `lineTotal` as the form sends them. */
function line(w: TillWorld, quantity = 2, price = 10, taxRate = 20, extra: Record<string, unknown> = {}) {
  const net = quantity * price
  return {
    productId: String(w.product._id), warehouseId: String(w.warehouse._id), description: 'Болт DIN 933 М8Х25',
    quantity, unit: 'бр.', unitPrice: price, taxRate,
    taxAmount: +(net * taxRate / 100).toFixed(2), lineTotal: +(net * (1 + taxRate / 100)).toFixed(2), ...extra,
  }
}

/** A line of no product at this gross and rate: free text, and no stock. */
function freeLine(gross: number, taxRate: number, description = 'Услуга') {
  const taxAmount = +(gross * taxRate / (100 + taxRate)).toFixed(2)
  const net = +(gross - taxAmount).toFixed(2)
  return { description, quantity: 1, unit: 'бр.', unitPrice: net, taxRate, taxAmount, lineTotal: gross }
}

async function draftOf(w: TillWorld, o: { method?: string; lines?: any[]; type?: string; extra?: Record<string, unknown> } = {}) {
  const contact = await createTestContact(w.oid, { companyName: 'Клиент ООД', type: 'customer' } as any)
  const lines = o.lines ?? [line(w)]
  const taxTotal = +lines.reduce((s: number, l: any) => s + l.taxAmount, 0).toFixed(2)
  const total = +lines.reduce((s: number, l: any) => s + l.lineTotal, 0).toFixed(2)
  const r = await w.call('POST', '/invoices', {
    type: o.type ?? 'invoice', direction: 'outgoing', contactId: String(contact._id), issueDate: TODAY, currency: 'EUR', lines,
    subtotal: +(total - taxTotal).toFixed(2), taxTotal, total, paymentMethod: o.method ?? 'cash', ...o.extra,
  })
  if (r.status !== 200) throw new Error(`draft: ${r.status} ${JSON.stringify(r.json)}`)
  return { id: String(r.json.invoice.id), contactId: String(contact._id), total }
}

const send = (w: TillWorld, id: string, key?: string, as?: string) => w.call('POST', `/invoices/${id}/send`, {}, key, as)
const pay = (w: TillWorld, id: string, amount: number, method = 'cash', key?: string, as?: string) =>
  w.call('POST', `/invoices/${id}/payments`, { date: TODAY, amount, method }, key, as)
const printIt = (w: TillWorld, id: string, key?: string, as?: string) => w.call('POST', `/invoices/${id}/receipt`, {}, key, as)
const shown = async (w: TillWorld, id: string) => (await w.call('GET', `/invoices/${id}`)).json.invoice
const raw = (id: string) => Invoice.findById(id).lean().exec() as Promise<any>
const receiptsOf = (id: string) => Invoice.find({ type: 'payment_receipt', 'register.paidInvoiceId': id }).sort({ _id: 1 }).lean().exec() as Promise<any[]>
const sessionOf = (w: TillWorld) => POSSession.findById(w.sessionId).lean().exec() as Promise<any>
const preview = (w: TillWorld) => w.call('GET', `/trade/pos/session/${w.sessionId}/close-preview`)

/**
 * Run `meanwhile` exactly once, right before the `Invoice.findOneAndUpdate` whose update `at` picks: an
 * interleaving forced, not timed. Returns what puts it back.
 */
function during(at: (update: any) => boolean, meanwhile: () => Promise<unknown>) {
  const real = Invoice.findOneAndUpdate
  let done = false
  ;(Invoice as any).findOneAndUpdate = function (filter: any, update: any, ...rest: any[]) {
    if (done || !at(update)) return (real as any).call(Invoice, filter, update, ...rest)
    done = true
    const query = () => (real as any).call(Invoice, filter, update, ...rest)
    const chain = {
      lean: () => chain,
      exec: async () => { await meanwhile(); return query().lean().exec() },
    }
    return chain
  }
  return () => { (Invoice as any).findOneAndUpdate = real }
}

/** Everything a refused request must leave as it was: no number, no УНП, no stock, no device command. */
async function footprint(w: TillWorld) {
  return {
    documents: await Invoice.countDocuments({ orgId: w.oid }),
    counters: (await Sequence.find({ orgId: w.oid }).lean().exec() as any[]).map(s => `${s.prefix}:${s.year}:${s.lastNumber}`).sort(),
    movements: await StockMovement.countDocuments({ orgId: w.oid }),
    device: w.sim ? w.sim.executed.length : 0,
  }
}

async function issuedPaid(w: TillWorld, method = 'cash') {
  const d = await draftOf(w, { method })
  const r = await send(w, d.id)
  expect(r.status).toBe(200)
  return { ...d, invoice: await raw(d.id), receipt: (await receiptsOf(d.id))[0] }
}

describe('an invoice issued at the counter (§2.4)', () => {
  it('in cash: the invoice is issued, then its receipt prints its lines and „Фактура № …", and pays it', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    const before = await w.stock()

    const r = await send(w, d.id)

    expect(r.status).toBe(200)
    expect(r.json.receiptError).toBeUndefined()
    const inv = await raw(d.id)
    expect(inv.status).toBe('paid')
    expect(inv.invoiceNumber).toMatch(/^INV-/)
    expect(inv).toMatchObject({ amountPaid: 24, amountDue: 0 })
    expect(r.json.invoice.status).toBe('paid')

    // One fiscal receipt: the lines at VAT-inclusive prices, the invoice's number, the money.
    expect(w.sim!.receipts).toHaveLength(1)
    const printed = w.sim!.receipts[0]
    expect(printed).toMatchObject({ kind: 'fiscal', total: 24, paid: 24, payments: [{ mode: 'P', amount: 24 }] })
    expect(printed.sales).toEqual([expect.objectContaining({ text: 'Болт DIN 933 М8Х25', group: 'Б', price: 12, quantity: 2 })])
    expect(printed.texts).toEqual([`Фактура № ${inv.invoiceNumber}`])

    // The receipt: a document of the register, in its series, on the session.
    const [receipt] = await receiptsOf(d.id)
    expect(receipt.invoiceNumber).toMatch(/^CS-\d{4}-\d{5}$/)
    expect(receipt).toMatchObject({ type: 'payment_receipt', direction: 'outgoing', status: 'paid', total: 24, paymentMethod: 'cash' })
    expect(receipt.register).toMatchObject({
      origin: 'pos', isFiscal: true, fiscalDeviceNumber: 'ED123456', paidInvoiceNumber: inv.invoiceNumber,
      fiscal: { state: 'printed', mode: 'fiscal' },
    })
    expect(String(receipt.register.sessionId)).toBe(w.sessionId)
    expect(receipt.register.unp).toMatch(/^ED123456-0001-\d{7}$/)
    expect(receipt.register.fiscalReceiptNumber).toBe(printed.number)
    expect(r.json.receipt).toMatchObject({ id: String(receipt._id), number: receipt.invoiceNumber, state: 'printed', unp: receipt.register.unp })

    // The payment row, linked to its receipt.
    expect(inv.payments).toHaveLength(1)
    expect(inv.payments[0]).toMatchObject({ method: 'cash', amount: 24, origin: 'payment_receipt' })
    expect(String(inv.payments[0].receiptId)).toBe(String(receipt._id))

    // The stock left once, on the invoice.
    expect((await w.stock()).quantity).toBe(before.quantity - 2)
    expect(await StockMovement.countDocuments({ orgId: w.oid, invoiceId: d.id })).toBe(1)
    expect(await StockMovement.countDocuments({ orgId: w.oid, invoiceId: receipt._id })).toBe(0)

    // The drawer has it.
    expect(await sessionOf(w)).toMatchObject({ totalCash: 24, totalSales: 24, transactionCount: 1 })
  })

  it('by card: slot L, in the session\'s card bucket', async () => {
    const w = await tillWorld(app)
    const { invoice, receipt } = await issuedPaid(w, 'card')
    expect(w.sim!.receipts[0].payments).toEqual([{ mode: 'L', amount: 24 }])
    expect(invoice.status).toBe('paid')
    expect(invoice.payments[0]).toMatchObject({ method: 'card', origin: 'payment_receipt' })
    expect(receipt.paymentMethod).toBe('card')
    expect(await sessionOf(w)).toMatchObject({ totalCard: 24, totalCash: 0 })
  })

  it('a refused issue leaves no transfer behind: the next attempt draws up its own', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    const transfer: any = await StockMovement.create({
      orgId: w.oid, movementNumber: 'SM-2026-90001', type: 'transfer', status: 'draft', date: new Date(),
      fromWarehouseId: w.warehouse._id, toWarehouseId: w.warehouse._id, createdBy: w.user._id,
      lines: [{ productId: w.product._id, quantity: 1, unitCost: 1, totalCost: 1 }],
    })
    const done: any = await StockMovement.create({
      orgId: w.oid, movementNumber: 'SM-2026-90002', type: 'transfer', status: 'completed', date: new Date(),
      fromWarehouseId: w.warehouse._id, toWarehouseId: w.warehouse._id, createdBy: w.user._id,
      lines: [{ productId: w.product._id, quantity: 1, unitCost: 1, totalCost: 1 }],
    })

    // The clerk has no session.
    const r = await w.call('POST', `/invoices/${d.id}/send`, { pendingTransferIds: [String(transfer._id), String(done._id)] }, undefined, w.clerkToken)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('fiscal_device_not_connected')
    expect((await StockMovement.findById(transfer._id).lean().exec() as any).status).toBe('cancelled')
    expect((await StockMovement.findById(done._id).lean().exec() as any).status).toBe('completed')
  })

  it('a key another request used is refused as that: a 200 with a receipt error would drop it', async () => {
    const w = await tillWorld(app)
    const first = await draftOf(w, { method: 'bank_transfer' })
    await send(w, first.id)
    expect((await pay(w, first.id, 24, 'cash', 'used-key-0001')).status).toBe(200)
    const d = await draftOf(w)

    const r = await send(w, d.id, 'used-key-0001')

    expect(r.status).toBe(422)
    expect(r.json.code).toBe('idempotency_key_reused')
    expect(w.sim!.receipts).toHaveLength(1)
  })

  it('a retry while the first still prints is told so, so the client keeps its key', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    const held = gate()
    w.sim!.beforeCommand = cmd => (cmd === 0x38 ? held.closed : undefined)

    const first = send(w, d.id, 'issue-key-0001')
    await until(async () => w.sim!.executed.some(c => c.cmd === 0x35), 'the print to reach the payment')

    const second = await send(w, d.id, 'issue-key-0001')

    expect(second.status).toBe(409)
    expect(second.json.code).toBe('idempotency_in_progress')
    expect(second.json.receiptError).toBeUndefined()
    held.open()
    expect((await first).status).toBe(200)
    expect(w.sim!.receipts).toHaveLength(1)
    expect((await raw(d.id)).status).toBe('paid')
  })

  it('a retry with the same key prints once and answers the same', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    const a = await send(w, d.id, 'issue-key-0001')
    const b = await send(w, d.id, 'issue-key-0001')
    expect(a.status).toBe(200)
    expect(b.status).toBe(200)
    expect(b.json.receipt.id).toBe(a.json.receipt.id)
    expect(w.sim!.receipts).toHaveLength(1)
    expect(await receiptsOf(d.id)).toHaveLength(1)
    expect((await raw(d.id)).payments).toHaveLength(1)
    expect((await sessionOf(w)).totalCash).toBe(24)
  })

  it('two clicks at once: one issue, one receipt', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    const answers = await Promise.all([send(w, d.id, 'issue-key-0002'), send(w, d.id, 'issue-key-0002')])
    expect(answers.map(a => a.status)).toEqual([200, 200])
    expect(w.sim!.receipts).toHaveLength(1)
    expect((await raw(d.id)).payments).toHaveLength(1)
  })

  it('a retry finishes a receipt its first attempt never started', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    await send(w, d.id, 'issue-key-0003')
    // The first attempt stopped between the issue and the receipt.
    await Invoice.deleteMany({ type: 'payment_receipt', 'register.paidInvoiceId': d.id })
    await Invoice.updateOne({ _id: d.id }, { $set: { payments: [], amountPaid: 0, amountDue: d.total, status: 'sent' } })
    w.sim!.receipts.length = 0

    const again = await send(w, d.id, 'issue-key-0003')

    expect(again.status).toBe(200)
    expect(w.sim!.receipts).toHaveLength(1)
    expect((await raw(d.id)).status).toBe('paid')
  })

  it('a failed print leaves it issued and unpaid, and takes nothing back; the next attempt prints', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    const before = await w.stock()
    w.sim!.paper = false

    const r = await send(w, d.id)

    // Issued is issued: its number, its stock.
    expect(r.status).toBe(200)
    expect(r.json.receiptError).toContain('out of paper')
    expect(r.json.receipt.state).toBe('failed')
    let inv = await raw(d.id)
    expect(inv).toMatchObject({ status: 'sent', amountPaid: 0, amountDue: 24 })
    expect(inv.invoiceNumber).toMatch(/^INV-/)
    expect(inv.payments).toHaveLength(0)
    expect(inv.receiptHolds ?? []).toHaveLength(0)
    expect((await w.stock()).quantity).toBe(before.quantity - 2)
    expect(await StockMovement.countDocuments({ orgId: w.oid, invoiceId: d.id })).toBe(1)

    // The receipt stays a voided document: its number and УНП are accounted for.
    const [failed] = await receiptsOf(d.id)
    expect(failed).toMatchObject({ status: 'voided' })
    expect(failed.register).toMatchObject({ fiscal: { state: 'failed' } })
    expect(failed.invoiceNumber).toMatch(/^CS-/)
    expect(failed.register.unp).toBeTruthy()
    expect((await sessionOf(w)).totalCash).toBe(0)

    w.sim!.paper = true
    const retry = await pay(w, d.id, 24)

    expect(retry.status).toBe(200)
    inv = await raw(d.id)
    expect(inv.status).toBe('paid')
    expect(w.sim!.receipts.filter(x => !x.voided)).toHaveLength(1)
    expect((await receiptsOf(d.id)).map(x => x.status)).toEqual(['voided', 'paid'])
    expect((await sessionOf(w)).totalCash).toBe(24)
  })

  it('a device that fails between the lines voids the receipt it opened, and the device stays usable', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    // No VAT group is programmed at 20 %: the driver refuses the line with the receipt already open.
    w.sim!.rates = [0, 9, 9, 9, 0, 0, 0, 0]
    const r = await send(w, d.id)
    expect(r.json.receipt.state).toBe('failed')
    expect(w.sim!.receipt).toBeNull()
    expect(w.sim!.receipts.at(-1)).toMatchObject({ kind: 'fiscal', voided: true })
    expect((await raw(d.id)).status).toBe('sent')
  })

  it('no open session: refused before anything is written, no number and no УНП, the draft a draft', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    const before = await footprint(w)

    // The clerk has no session.
    const r = await send(w, d.id, undefined, w.clerkToken)

    expect(r.status).toBe(409)
    expect(r.json).toMatchObject({ code: 'fiscal_device_not_connected', noSession: true })
    expect(await footprint(w)).toEqual(before)
    const inv = await raw(d.id)
    expect(inv.status).toBe('draft')
    expect(inv.invoiceNumber).toMatch(/^DRF-/)
    expect(inv.issue?.leaseUntil ?? null).toBeNull()
  })

  it('a device set up but not connected: refused the same way, and says it is set up', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    forgetDevices()
    const before = await footprint(w)
    const r = await send(w, d.id)
    expect(r.status).toBe(409)
    expect(r.json).toMatchObject({ code: 'fiscal_device_not_connected', deviceConfigured: true })
    expect(await footprint(w)).toEqual(before)
    expect((await raw(d.id)).status).toBe('draft')
  })

  it('no device at all: refused, and says none is set up', async () => {
    const w = await tillWorld(app, { device: false, requireDevice: true })
    const d = await draftOf(w)
    const r = await send(w, d.id)
    expect(r.status).toBe(409)
    expect(r.json).toMatchObject({ code: 'fiscal_device_not_connected', deviceConfigured: false })
    expect((await raw(d.id)).status).toBe('draft')
  })

  it('a cashier with no operator code cannot open a fiscal receipt: refused before anything is written', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    const token = await signed(w, { operatorCode: undefined })
    const r = await send(w, d.id, undefined, token)
    expect(r.status).toBe(400)
    expect(String(r.json.message)).toContain('operator code')
    expect((await raw(d.id)).status).toBe('draft')
  })

  it('a device not reached in two hours, in SUPTO production mode: refused before anything is written', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    const mode = config.supto.mode
    config.supto.mode = 'production'
    try {
      await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { lastCommunicationAt: new Date(Date.now() - 3 * 3_600_000) } })
      w.sim!.silent = true
      const r = await send(w, d.id)
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('fiscal_device_unreached')
      expect((await raw(d.id)).status).toBe('draft')
    } finally {
      config.supto.mode = mode
    }
  })

  it('a document in another currency than the session\'s device: refused before anything is written', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { extra: { currency: 'USD', exchangeRate: 0.9 } })
    const r = await send(w, d.id)
    expect(r.status).toBe(422)
    expect(r.json.code).toBe('receipt_currency')
    expect((await raw(d.id)).status).toBe('draft')
  })

  it('takes its number from the register\'s series, under the org\'s prefix', async () => {
    const w = await tillWorld(app)
    await Sequence.create({ orgId: w.oid, prefix: 'CASH_SALE', year: 0, lastNumber: 0, displayPrefix: 'CSR' } as any)
    const { receipt } = await issuedPaid(w)
    expect(receipt.invoiceNumber).toMatch(/^CSR-\d{4}-\d{5}$/)
  })

  it('a draft invoice for a cash sale prints nothing and asks for no session: that sale took the money', async () => {
    const w = await tillWorld(app)
    const cs = (await w.backOfficeSale(1)).json.invoice
    const contact = await createTestContact(w.oid, { companyName: 'Y', type: 'customer' } as any)
    const draft = await w.call('POST', `/invoices/${cs.id}/to-invoice`, { contactId: String(contact._id), issueDate: TODAY, issue: false }, undefined, w.clerkToken)
    expect(draft.status).toBe(200)
    expect(draft.json.invoice.status).toBe('draft')

    const r = await send(w, String(draft.json.invoice.id), undefined, w.clerkToken)

    expect(r.status).toBe(200)
    expect(r.json.invoice.status).toBe('paid')
    expect(w.sim!.receipts).toHaveLength(0)
    expect(await receiptsOf(String(draft.json.invoice.id))).toHaveLength(0)
  })

  it('a bank transfer prints nothing and asks for no session', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    const r = await send(w, d.id, undefined, w.clerkToken)
    expect(r.status).toBe(200)
    expect(r.json.invoice.status).toBe('sent')
    expect(w.sim!.receipts).toHaveLength(0)
    expect(await receiptsOf(d.id)).toHaveLength(0)
  })

  it('a proforma and a credit note in cash print nothing', async () => {
    const w = await tillWorld(app)
    const proforma = await draftOf(w, { type: 'proforma' })
    expect((await send(w, proforma.id)).status).toBe(200)
    const { id, contactId } = await issuedPaid(w)
    const credit = await draftOf(w, { type: 'credit_note', extra: { relatedInvoiceId: id, contactId } })
    expect((await send(w, credit.id)).status).toBe(200)
    expect(w.sim!.receipts).toHaveLength(1)
  })
})

/** The cashier's token with some claims replaced. */
async function signed(w: TillWorld, claims: Record<string, unknown>) {
  const { default: jwt } = await import('@elysiajs/jwt')
  const { config } = await import('config')
  const { DEFAULT_ROLE_PERMISSIONS } = await import('config/constants')
  const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
  return (signer as any).decorator.jwt.sign({
    id: String(w.user._id), orgId: w.orgId, role: 'admin', email: 'cashier@test.com', username: 'cashier',
    firstName: 'Иван', lastName: 'Петров', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [], ...claims,
  })
}

describe('the switch is off: LGR prints nothing (Q-4)', () => {
  it('a cash invoice behaves exactly as today: settled on issue, no session asked for, no receipt', async () => {
    const w = await tillWorld(app)
    await allowSalesWithoutPrinter(w.oid)
    const d = await draftOf(w)

    const r = await send(w, d.id, undefined, w.clerkToken)

    expect(r.status).toBe(200)
    const inv = await raw(d.id)
    expect(inv.status).toBe('paid')
    expect(inv.payments).toHaveLength(1)
    expect(inv.payments[0]).toMatchObject({ method: 'cash', amount: 24, origin: 'cash_on_issue' })
    expect(w.sim!.executed).toHaveLength(0)
    expect(await receiptsOf(d.id)).toHaveLength(0)
  })

  it('a cash payment later prints nothing either', async () => {
    const w = await tillWorld(app)
    await allowSalesWithoutPrinter(w.oid)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    const r = await pay(w, d.id, 24, 'cash', undefined, w.clerkToken)
    expect(r.status).toBe(200)
    expect(w.sim!.executed).toHaveLength(0)
    expect((await raw(d.id)).status).toBe('paid')
  })
})

describe('an imported document never prints (§2.2)', () => {
  const mapped = (w: TillWorld, method: string): any => ({
    type: 'invoice', direction: 'outgoing', reference: '3000100974', currency: 'EUR', exchangeRate: 1, issueDate: TODAY,
    lines: [line(w)], subtotal: 20, taxTotal: 4, total: 24, paymentMethod: method, tags: ['ocr-import'],
    billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
  })

  it('through the conversion, with the switch on: settled as today, not a command to the device', async () => {
    const w = await tillWorld(app)
    const draft = await persistInvoiceDraft(w.orgId, String(w.user._id), mapped(w, 'cash'))

    const out = await convertDraftInvoice(w.orgId, String(draft.id), String(w.user._id))

    expect(out.ok).toBe(true)
    const inv = await raw(String(draft.id))
    expect(inv.status).toBe('paid')
    expect(inv.payments[0]).toMatchObject({ method: 'cash', origin: 'cash_on_issue' })
    expect(w.sim!.executed).toHaveLength(0)
    expect(await receiptsOf(String(draft.id))).toHaveLength(0)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, transactionCount: 0 })
  })

  it('a person issuing an imported draft prints nothing, wherever they are, and settles as today', async () => {
    const w = await tillWorld(app)
    const draft = await persistInvoiceDraft(w.orgId, String(w.user._id), mapped(w, 'cash'))
    const r = await send(w, String(draft.id), undefined, w.clerkToken)
    expect(r.status).toBe(200)
    expect((await raw(String(draft.id))).payments[0]).toMatchObject({ origin: 'cash_on_issue' })
    expect(w.sim!.executed).toHaveLength(0)
  })

  it('a cash payment recorded on an imported invoice prints nothing, and is recorded', async () => {
    const w = await tillWorld(app)
    const draft = await persistInvoiceDraft(w.orgId, String(w.user._id), mapped(w, 'bank_transfer'))
    await convertDraftInvoice(w.orgId, String(draft.id), String(w.user._id))
    const r = await pay(w, String(draft.id), 24, 'cash', undefined, w.clerkToken)
    expect(r.status).toBe(200)
    expect((await raw(String(draft.id))).status).toBe('paid')
    expect(w.sim!.executed).toHaveLength(0)
  })

  it('a copy of one is not one: the tag comes along, the import does not, and it prints', async () => {
    const w = await tillWorld(app)
    // What "Копирай" sends: the original's tags, verbatim.
    const d = await draftOf(w, { extra: { tags: ['ocr-import', 'dir:outgoing'] } })
    expect((await raw(d.id)).tags).toContain('ocr-import')

    const r = await send(w, d.id)

    expect(r.status).toBe(200)
    expect(w.sim!.receipts).toHaveLength(1)
    expect((await raw(d.id)).payments[0]).toMatchObject({ origin: 'payment_receipt' })
    expect((await sessionOf(w)).totalCash).toBe(24)
  })

  it('and asks for a session like any other: no cash on a copy without a receipt', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { extra: { tags: ['ocr-import', 'dir:outgoing'] } })

    const r = await send(w, d.id, undefined, w.clerkToken)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('fiscal_device_not_connected')
    expect(await raw(d.id)).toMatchObject({ status: 'draft', amountPaid: 0 })
  })

  it('a payment on a copy prints too', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer', extra: { tags: ['ocr-import'] } })
    await send(w, d.id)

    expect((await pay(w, d.id, 24)).status).toBe(200)

    expect(w.sim!.receipts).toHaveLength(1)
    expect((await raw(d.id)).payments[0]).toMatchObject({ origin: 'payment_receipt' })
  })

  it('a document LGR moved between its own nodes prints like any other: its payment', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    await Invoice.updateOne({ _id: d.id }, { $set: { importedFrom: { kind: 'fenced_export', nodeId: 'master-a' } } })

    expect((await pay(w, d.id, 24)).status).toBe(200)

    expect(w.sim!.receipts).toHaveLength(1)
    expect((await sessionOf(w)).totalCash).toBe(24)
  })

  it('a document LGR moved between its own nodes prints like any other: its draft, issued in cash', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    await Invoice.updateOne({ _id: d.id }, { $set: { importedFrom: { kind: 'fenced_export', nodeId: 'master-a' } } })

    expect((await send(w, d.id)).status).toBe(200)

    expect(w.sim!.receipts).toHaveLength(1)
    expect((await raw(d.id)).payments[0]).toMatchObject({ origin: 'payment_receipt' })
  })

  it('nobody gives a document the mark: not the form, not an edit', async () => {
    const w = await tillWorld(app)
    const mark = { statusHistory: [{ status: 'draft', changedAt: new Date(), reason: 'ocr_import' }] }
    const d = await draftOf(w, { extra: mark })
    expect((await w.call('PUT', `/invoices/${d.id}`, mark)).status).toBe(200)
    expect((await raw(d.id)).statusHistory?.[0]?.reason).not.toBe('ocr_import')

    expect((await send(w, d.id)).status).toBe(200)

    expect(w.sim!.receipts).toHaveLength(1)
  })
})

describe('the re-issue of a number issued twice (FR-20.51)', () => {
  /** Two cash invoices under one number, and the correction of the later one, prepared as drafts. */
  async function correction(w: TillWorld) {
    const contact = await createTestContact(w.oid, { companyName: 'Клиент ООД', type: 'customer' } as any)
    const { ObjectId } = (Invoice.base as any).Types
    const number = 'INV-2026-00007'
    const sale = (over: Record<string, unknown> = {}) => ({
      _id: new ObjectId(), orgId: w.oid, type: 'invoice', direction: 'outgoing', invoiceNumber: number, status: 'paid', paymentMethod: 'cash',
      issueDate: new Date(), dueDate: new Date(), createdAt: new Date(), contactId: contact._id, currency: 'EUR', exchangeRate: 1,
      subtotal: 20, taxTotal: 4, total: 24, amountPaid: 24, amountDue: 0, billingAddress: { street: 'Main 1', city: 'Sofia', country: 'BG' },
      lines: [{ ...line(w), _id: new ObjectId(), productId: w.product._id, warehouseId: w.warehouse._id }], payments: [], ...over,
    })
    const earlier = sale({ issueDate: new Date(Date.now() - 86_400_000), createdAt: new Date(Date.now() - 86_400_000) })
    await Invoice.collection.insertOne(earlier as any)
    const later = sale({ numberClash: { withId: earlier._id, withNumber: number, source: 'fenced_export', at: new Date() } })
    await Invoice.collection.insertOne(later as any)
    return prepareClashCorrection(w.orgId, String(later._id), { id: String(w.user._id) })
  }

  it('prints nothing and asks for no session: its money was taken under the number it replaces', async () => {
    const w = await tillWorld(app)
    const { reissue } = await correction(w)
    expect((await raw(reissue.id)).paymentMethod).toBe('cash')
    const device = w.sim!.executed.length

    // The clerk has no session: a receipt would be refused, and the correction with it.
    const r = await send(w, reissue.id, undefined, w.clerkToken)

    expect(r.status).toBe(200)
    expect(r.json.receiptError).toBeUndefined()
    expect(await receiptsOf(reissue.id)).toHaveLength(0)
    expect(w.sim!.executed.length).toBe(device)
    // Settled on issue, as it always was: the credit note gives that money back.
    const inv = await raw(reissue.id)
    expect(inv).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect(inv.payments.map((p: any) => p.origin)).toEqual(['cash_on_issue'])
  })
})

describe('what the payment dialog is told: the server answers it, by method', () => {
    /** The document as the form reads it, and as the list row reads it: they must agree. */
    async function told(w: TillWorld, id: string) {
      const one = (await shown(w, id)).printsOnPayment
      const row = (await w.call('GET', '/invoices?size=100')).json.invoices.find((i: any) => String(i.id) === id)
      expect(row.printsOnPayment ?? []).toEqual(one)
      return one
    }

    /** What it was told, held to what `/payments` then does. */
    async function keepsItsWord(w: TillWorld, id: string, expected: string[]) {
      expect(await told(w, id)).toEqual(expected)
      const printedBefore = w.sim!.receipts.filter(r => !r.voided).length
      expect((await pay(w, id, 1, 'cash')).status).toBe(200)
      expect(w.sim!.receipts.filter(r => !r.voided).length - printedBefore).toBe(expected.includes('cash') ? 1 : 0)
    }

    it('an open invoice prints in cash and by card, and not by bank', async () => {
      const w = await tillWorld(app)
      const d = await draftOf(w, { method: 'bank_transfer' })
      await send(w, d.id)
      await keepsItsWord(w, d.id, ['cash', 'card'])
    })

    it('a cash-on-delivery invoice whose receipt printed: nothing more prints, by any method', async () => {
      const w = await tillWorld(app)
      const d = await draftOf(w, { method: 'cash_on_delivery' })
      await send(w, d.id)
      await keepsItsWord(w, d.id, [])
    })

    it('a cash-on-delivery invoice whose receipt failed: a payment at the counter does print', async () => {
      const w = await tillWorld(app)
      const d = await draftOf(w, { method: 'cash_on_delivery' })
      w.sim!.paper = false
      await send(w, d.id)
      w.sim!.paper = true
      await keepsItsWord(w, d.id, ['cash', 'card'])
    })

    it('the re-issue of a number issued twice prints nothing, whatever its header', async () => {
      const w = await tillWorld(app)
      const d = await draftOf(w, { method: 'bank_transfer' })
      await send(w, d.id)
      await Invoice.updateOne({ _id: d.id }, { $set: { 'stockSource.detectedBy': 'number_clash' } })
      await keepsItsWord(w, d.id, [])
    })

    it('an org that prints nothing is told nothing prints', async () => {
      const w = await tillWorld(app)
      const d = await draftOf(w, { method: 'bank_transfer' })
      await send(w, d.id)
      await allowSalesWithoutPrinter(w.oid)
      await keepsItsWord(w, d.id, [])
    })

    it('a draft, a paid document, a credit note and a bill take nothing that prints', async () => {
      const w = await tillWorld(app)
      const draft = await draftOf(w, { method: 'bank_transfer' })
      expect(await told(w, draft.id)).toEqual([])
      const { id } = await issuedPaid(w)
      expect(await told(w, id)).toEqual([])
      const bill = await draftOf(w, { method: 'cash', extra: { direction: 'incoming' } })
      await w.call('POST', `/invoices/${bill.id}/receive`, {})
      expect(await told(w, bill.id)).toEqual([])
    })
  })

describe('scripts/settle-cash-invoices where LGR prints (finding 11)', () => {
  it('an org where LGR prints is refused by name, and skipped otherwise, and one that prints nothing is taken', async () => {
    const w = await tillWorld(app)
    const quiet = await tillWorld(app, { device: false })
    const orgs = [{ _id: w.oid, slug: 'prints' }, { _id: quiet.oid, slug: 'quiet' }]

    expect((await orgsToSettle(orgs, false)).map(o => o.slug)).toEqual(['quiet'])
    const refused = await captureRejection(orgsToSettle([orgs[0]], true))
    expect(String(refused)).toContain('LGR prints for this org')
    expect((await orgsToSettle([orgs[1]], true)).map(o => o.slug)).toEqual(['quiet'])
  })

  it('a document with a receipt tried is never selected, even with the switch turned off since', async () => {
    const w = await tillWorld(app)
    const failed = await draftOf(w)
    const part = await draftOf(w)
    w.sim!.paper = false
    await send(w, failed.id)
    await send(w, part.id)
    w.sim!.paper = true
    expect((await pay(w, part.id, 10)).status).toBe(200)
    await allowSalesWithoutPrinter(w.oid)
    // Nothing ever tried, in an org that prints nothing: the rule's own case.
    const plain = await draftOf(w, { method: 'bank_transfer' })
    await send(w, plain.id)
    await Invoice.updateOne({ _id: plain.id }, { $set: { paymentMethod: 'cash' } })

    const due = await unsettledInvoices(w.oid, ['cash', 'card'])

    expect(due.map(d => d.id)).toEqual([plain.id])
  })
})

describe('an edit does not settle silently where LGR prints', () => {
  it('an issued invoice edited to cash stays unpaid, and the Pay button prints', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)

    const r = await w.call('PUT', `/invoices/${d.id}`, { paymentMethod: 'cash' })

    expect(r.status).toBe(200)
    const inv = await raw(d.id)
    expect(inv).toMatchObject({ status: 'sent', amountPaid: 0, paymentMethod: 'cash' })
    expect(inv.payments).toHaveLength(0)
    expect(w.sim!.receipts).toHaveLength(0)

    expect((await pay(w, d.id, 24)).status).toBe(200)
    expect(w.sim!.receipts).toHaveLength(1)
  })

  /** Paid in cash on issue the day before LGR printed: a row of the rule, and no receipt. */
  async function fromBeforeLgrPrinted(w: TillWorld, method = 'cash') {
    await allowSalesWithoutPrinter(w.oid)
    const d = await draftOf(w, { method })
    await send(w, d.id)
    await Org.updateOne({ _id: w.oid }, { $set: { 'settings.cashRegister.requireConnectedDevice': true } })
    expect(await receiptsOf(d.id)).toHaveLength(0)
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    return d
  }

  async function imported(w: TillWorld) {
    const draft = await persistInvoiceDraft(w.orgId, String(w.user._id), {
      type: 'invoice', direction: 'outgoing', reference: '3000100975', currency: 'EUR', exchangeRate: 1, issueDate: TODAY,
      lines: [line(w)], subtotal: 20, taxTotal: 4, total: 24, paymentMethod: 'cash', tags: ['ocr-import'],
      billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
    } as any)
    const id = String(draft.id)
    await convertDraftInvoice(w.orgId, id, String(w.user._id))
    expect((await raw(id)).status).toBe('paid')
    return id
  }

  it('a total raised on a settled invoice with no receipt adds no payment: the rest is due, and payable', async () => {
    const w = await tillWorld(app)
    const { id } = await fromBeforeLgrPrinted(w)

    const r = await w.call('PUT', `/invoices/${id}`, { lines: [line(w, 3)], subtotal: 30, taxTotal: 6, total: 36 })

    expect(r.status).toBe(200)
    const inv = await raw(id)
    expect(inv.payments).toHaveLength(1)
    expect(inv).toMatchObject({ status: 'partially_paid', amountPaid: 24, amountDue: 12 })
    expect((await pay(w, id, 12, 'bank_transfer')).status).toBe(200)
    expect((await raw(id)).status).toBe('paid')
  })

  it('a total lowered shrinks no payment', async () => {
    const w = await tillWorld(app)
    const { id } = await fromBeforeLgrPrinted(w)

    await w.call('PUT', `/invoices/${id}`, { lines: [line(w, 1)], subtotal: 10, taxTotal: 2, total: 12 })

    const inv = await raw(id)
    expect(inv.payments).toHaveLength(1)
    expect(inv.payments[0].amount).toBe(24)
    expect(inv).toMatchObject({ status: 'paid', amountPaid: 24, amountDue: 0 })
  })

  it('raised and lowered again it is paid again, and says when: `paid30d` reads the date', async () => {
    const w = await tillWorld(app)
    const { id } = await fromBeforeLgrPrinted(w)

    await w.call('PUT', `/invoices/${id}`, { lines: [line(w, 3)], subtotal: 30, taxTotal: 6, total: 36 })
    expect((await raw(id)).paidAt).toBeNull()
    await w.call('PUT', `/invoices/${id}`, { lines: [line(w, 2)], subtotal: 20, taxTotal: 4, total: 24 })

    const inv = await raw(id)
    expect(inv.status).toBe('paid')
    expect(inv.paidAt).toBeTruthy()
  })

  it('moved off cash, the rule still takes its own payment back: nothing else can', async () => {
    const w = await tillWorld(app)
    const { id } = await fromBeforeLgrPrinted(w)

    const r = await w.call('PUT', `/invoices/${id}`, { paymentMethod: 'bank_transfer' })

    expect(r.status).toBe(200)
    expect(await raw(id)).toMatchObject({ status: 'sent', amountPaid: 0, amountDue: 24 })
    expect((await raw(id)).payments).toHaveLength(0)
    // And when the transfer arrives it can be recorded.
    expect((await pay(w, id, 24, 'bank_transfer')).status).toBe(200)
    expect((await raw(id)).status).toBe('paid')
    expect(w.sim!.executed).toHaveLength(0)
  })

  it('moved between two settled methods, its row goes and none takes its place: that money has to be taken, and print', async () => {
    const w = await tillWorld(app)
    const { id } = await fromBeforeLgrPrinted(w)
    const emitted = spyOn(eventBus, 'emit')

    const r = await w.call('PUT', `/invoices/${id}`, { paymentMethod: 'card' })

    const recorded = emitted.mock.calls.filter(([event]) => event === 'payment.recorded')
    emitted.mockRestore()
    expect(r.status).toBe(200)
    const inv = await raw(id)
    expect(inv.payments).toHaveLength(0)
    expect(inv).toMatchObject({ status: 'sent', amountPaid: 0, amountDue: 24, paidAt: null })
    expect(recorded).toHaveLength(0)
    expect(w.sim!.executed).toHaveLength(0)

    // The way that money is taken now is the payment action, which prints.
    expect((await pay(w, id, 24, 'card')).status).toBe(200)
    expect(w.sim!.receipts).toHaveLength(1)
    expect(await raw(id)).toMatchObject({ status: 'paid', amountPaid: 24 })
  })

  it('moved between two settled methods with a total raised, nothing nobody took is recorded', async () => {
    const w = await tillWorld(app)
    const { id } = await fromBeforeLgrPrinted(w)
    await w.call('PUT', `/invoices/${id}`, { lines: [line(w, 3)], subtotal: 30, taxTotal: 6, total: 36 })

    await w.call('PUT', `/invoices/${id}`, { paymentMethod: 'card' })

    const inv = await raw(id)
    expect(inv.payments).toHaveLength(0)
    expect(inv).toMatchObject({ status: 'sent', amountPaid: 0, amountDue: 36 })
  })

  it('a move keeps a payment recorded by hand, and the status follows what is left', async () => {
    const w = await tillWorld(app)
    const { id } = await fromBeforeLgrPrinted(w)
    await w.call('PUT', `/invoices/${id}`, { lines: [line(w, 3)], subtotal: 30, taxTotal: 6, total: 36 })
    expect((await pay(w, id, 12, 'bank_transfer')).status).toBe(200)

    await w.call('PUT', `/invoices/${id}`, { paymentMethod: 'card' })

    const inv = await raw(id)
    expect(inv.payments.map((p: any) => p.method)).toEqual(['bank_transfer'])
    expect(inv).toMatchObject({ status: 'partially_paid', amountPaid: 12, amountDue: 24 })
  })

  it('an imported invoice keeps the rule: it prints nothing, so nothing else would settle it', async () => {
    const w = await tillWorld(app)
    const id = await imported(w)

    await w.call('PUT', `/invoices/${id}`, { lines: [line(w, 3)], subtotal: 30, taxTotal: 6, total: 36 })

    expect(await raw(id)).toMatchObject({ status: 'paid', amountPaid: 36, amountDue: 0 })
    expect(w.sim!.executed).toHaveLength(0)

    await w.call('PUT', `/invoices/${id}`, { lines: [line(w, 1)], subtotal: 10, taxTotal: 2, total: 12 })
    expect(await raw(id)).toMatchObject({ status: 'paid', amountPaid: 12, amountDue: 0 })
    expect((await raw(id)).payments[0].amount).toBe(12)
  })

  it('with the switch off an edit settles as it always did', async () => {
    const w = await tillWorld(app)
    await allowSalesWithoutPrinter(w.oid)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    await w.call('PUT', `/invoices/${d.id}`, { paymentMethod: 'cash' })
    const inv = await raw(d.id)
    expect(inv.status).toBe('paid')
    expect(inv.payments[0]).toMatchObject({ origin: 'cash_on_issue' })
  })
})

describe('a payment recorded later (§2.2)', () => {
  /** 70.01 at 20 % and 30.00 at 9 %: two VAT groups, and a total that does not split evenly. */
  const twoRates = () => [freeLine(70.01, 20), freeLine(30, 9, 'Друга услуга')]

  it('prints one line per VAT rate, „Плащане по фактура № …", split pro rata', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer', lines: twoRates() })
    await send(w, d.id)
    const number = (await raw(d.id)).invoiceNumber

    const r = await pay(w, d.id, 50, 'cash', 'pay-key-0001')

    expect(r.status).toBe(200)
    expect(r.json.invoice.status).toBe('partially_paid')
    expect(r.json.receipt.state).toBe('printed')
    expect(w.sim!.receipts).toHaveLength(1)
    const printed = w.sim!.receipts[0]
    expect(printed.total).toBe(50)
    expect(printed.texts).toEqual([])
    expect(printed.sales.map(s => [s.text.replace('\n', ' '), s.group, s.amount])).toEqual([
      [`Плащане по фактура № ${number}`, 'Б', 35],
      [`Плащане по фактура № ${number}`, 'Г', 15],
    ])
    const inv = await raw(d.id)
    expect(inv).toMatchObject({ amountPaid: 50, amountDue: 50.01, status: 'partially_paid' })
    expect(inv.payments[0]).toMatchObject({ amount: 50, method: 'cash', origin: 'payment_receipt', clientKey: 'pay-key-0001' })
  })

  it('three part payments: per rate, the receipts add up to the invoice exactly', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer', lines: twoRates() })
    await send(w, d.id)

    expect((await pay(w, d.id, 33.33)).status).toBe(200)
    expect((await pay(w, d.id, 33.33, 'card')).status).toBe(200)
    const last = await pay(w, d.id, 33.35)
    expect(last.status).toBe(200)
    expect(last.json.invoice.status).toBe('paid')

    const inv = await raw(d.id)
    expect(inv).toMatchObject({ status: 'paid', amountPaid: 100.01, amountDue: 0 })
    expect(inv.payments).toHaveLength(3)

    // On the device, per VAT group: to the cent.
    const byGroup = (g: string) => +w.sim!.receipts.flatMap(r => r.sales).filter(s => s.group === g).reduce((s, x) => s + x.amount, 0).toFixed(2)
    expect(byGroup('Б')).toBe(70.01)
    expect(byGroup('Г')).toBe(30)
    // In the documents, per rate.
    const receipts = await receiptsOf(d.id)
    expect(receipts).toHaveLength(3)
    const byRate = (rate: number) => +receipts.flatMap(r => r.lines).filter((l: any) => l.taxRate === rate).reduce((s: number, l: any) => s + l.lineTotal, 0).toFixed(2)
    expect(byRate(20)).toBe(70.01)
    expect(byRate(9)).toBe(30)
    // Each document adds up to what its receipt printed.
    for (const r of receipts) expect(+r.lines.reduce((s: number, l: any) => s + l.lineTotal, 0).toFixed(2)).toBe(r.total)
    expect(w.sim!.receipts.map(r => r.total)).toEqual([33.33, 33.33, 33.35])
  })

  it('a later payment of the whole invoice is still a payment: one line per rate, no text line', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    await pay(w, d.id, 24)
    const number = (await raw(d.id)).invoiceNumber
    const printed = w.sim!.receipts[0]
    expect(printed.sales.map(s => s.text.replace('\n', ' '))).toEqual([`Плащане по фактура № ${number}`])
    expect(printed.texts).toEqual([])
    expect((await receiptsOf(d.id))[0].lines[0].productId).toBeUndefined()
  })

  it('a keyed lookup reaches its partial index', async () => {
    const { keyedReceipt } = await import('invoicing-api/src/lib/counter-receipt')
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    await pay(w, d.id, 24, 'cash', 'keyed-lookup-0001')

    // The filter as `keyedReceipt` writes it: what the planner proves is in its shape.
    const real = Invoice.findOne
    let filter: any
    ;(Invoice as any).findOne = function (...args: any[]) {
      filter = args[0]
      return (real as any).apply(Invoice, args)
    }
    let found: any
    try {
      found = await keyedReceipt(w.orgId, 'keyed-lookup-0001')
    } finally {
      ;(Invoice as any).findOne = real
    }

    expect(found?.clientKey).toBe('keyed-lookup-0001')
    expect(JSON.stringify(await Invoice.find(filter).explain('queryPlanner'))).toContain('orgId_1_clientKey_1')
  })

  it('a retry with the same key prints once; the same key on another amount is refused', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    const a = await pay(w, d.id, 10, 'cash', 'pay-key-0002')
    const b = await pay(w, d.id, 10, 'cash', 'pay-key-0002')
    expect(b.status).toBe(200)
    expect(b.json.receipt.id).toBe(a.json.receipt.id)
    expect(w.sim!.receipts).toHaveLength(1)
    expect((await raw(d.id)).amountPaid).toBe(10)

    const c = await pay(w, d.id, 11, 'cash', 'pay-key-0002')
    expect(c.status).toBe(422)
    expect(c.json.code).toBe('idempotency_key_reused')
    expect(w.sim!.receipts).toHaveLength(1)
  })

  it('a payment takes cents: a fiscal receipt has no others', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    expect((await pay(w, d.id, 10.004)).status).toBe(200)
    const [receipt] = await receiptsOf(d.id)
    expect(receipt.total).toBe(10)
    expect((await raw(d.id)).amountPaid).toBe(10)
    expect(w.sim!.receipts[0].total).toBe(10)
  })

  it('more than is due is refused before anything is written', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    const before = await footprint(w)
    const r = await pay(w, d.id, 25)
    expect(r.status).toBe(422)
    expect(r.json.code).toBe('overpayment')
    expect(await footprint(w)).toEqual(before)
  })

  it('two payments at once that fit only one by one: one prints, and no number is lost', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)

    const answers = await Promise.all([pay(w, d.id, 20), pay(w, d.id, 20)])

    expect(answers.filter(a => a.status === 200)).toHaveLength(1)
    expect(answers.find(a => a.status !== 200)!.json.code).toMatch(/^(overpayment|payment_in_progress)$/)
    expect(w.sim!.receipts).toHaveLength(1)
    expect((await raw(d.id)).amountPaid).toBe(20)
    expect(await receiptsOf(d.id)).toHaveLength(1)
    const counter: any = await Sequence.findOne({ orgId: w.oid, prefix: 'CASH_SALE', year: new Date().getFullYear() }).lean().exec()
    expect(counter.lastNumber).toBe(1)
  })

  it('money a receipt is printing for cannot be taken by a payment recorded meanwhile', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    // A receipt printing for the whole of it, its request still alive.
    await Invoice.updateOne({ _id: d.id }, { $set: { receiptHolds: [{ receiptId: new (Invoice.base as any).Types.ObjectId(), amount: 24 }] } })

    const r = await pay(w, d.id, 24, 'bank_transfer')

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('payment_in_progress')
    expect((await raw(d.id)).amountPaid).toBe(0)
  })

  it('the hold counts in the atomic check too, not only in the read before it', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    await Invoice.updateOne({ _id: d.id }, { $set: { receiptHolds: [{ receiptId: new (Invoice.base as any).Types.ObjectId(), amount: 20 }] } })
    expect(await Invoice.exists({ _id: d.id, ...fitsDue(4) }).exec()).toBeTruthy()
    expect(await Invoice.exists({ _id: d.id, ...fitsDue(4.01) }).exec()).toBeNull()
  })

  it('no session: refused, and the invoice stays as it was', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    const before = await footprint(w)
    const r = await pay(w, d.id, 24, 'cash', undefined, w.clerkToken)
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('fiscal_device_not_connected')
    expect(await footprint(w)).toEqual(before)
  })

  it('a failed print records nothing and answers 503; the next attempt prints', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    w.sim!.paper = false

    const r = await pay(w, d.id, 24, 'cash', 'pay-key-0003')

    expect(r.status).toBe(503)
    expect(r.json.code).toBe('fiscal_error')
    expect(r.json.message).toContain('no payment was recorded')
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })

    // The same key replays the outcome, as every keyed request does; a new attempt is a new key.
    w.sim!.paper = true
    expect((await pay(w, d.id, 24, 'cash', 'pay-key-0003')).status).toBe(503)
    const again = await pay(w, d.id, 24, 'cash', 'pay-key-0004')
    expect(again.status).toBe(200)
    expect(w.sim!.receipts.filter(x => !x.voided)).toHaveLength(1)
    expect((await raw(d.id)).status).toBe('paid')
  })

  it('a bank transfer and `other` print nothing, in a printing org', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    await pay(w, d.id, 10, 'bank_transfer', undefined, w.clerkToken)
    await pay(w, d.id, 14, 'other', undefined, w.clerkToken)
    expect((await raw(d.id)).status).toBe('paid')
    expect(w.sim!.receipts).toHaveLength(0)
  })

  it('a bank part and a cash part: the receipt carries the cash part, split on what no receipt holds', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer', lines: twoRates() })
    await send(w, d.id)
    await pay(w, d.id, 40.01, 'bank_transfer', undefined, w.clerkToken)
    expect((await pay(w, d.id, 60)).status).toBe(200)
    expect(w.sim!.receipts).toHaveLength(1)
    expect(w.sim!.receipts[0].total).toBe(60)
    expect((await raw(d.id)).status).toBe('paid')
  })

  it('a bank payment does not issue a draft: cash on it is still refused, and nothing prints', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    expect((await pay(w, d.id, 4, 'bank_transfer')).status).toBe(200)
    expect((await raw(d.id)).status).toBe('partially_paid')

    const r = await pay(w, d.id, 20)

    expect(r.status).toBe(422)
    expect(r.json.code).toBe('document_not_issued')
    expect(w.sim!.receipts).toHaveLength(0)
    expect(await receiptsOf(d.id)).toHaveLength(0)
    expect((await raw(d.id)).amountPaid).toBe(4)
  })

  it('dated yesterday it is today\'s: the device, the session and the row say one day', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

    const r = await w.call('POST', `/invoices/${d.id}/payments`, { date: yesterday, amount: 10, method: 'cash' })

    expect(r.status).toBe(200)
    const row = (await raw(d.id)).payments[0]
    expect(Date.now() - new Date(row.date).getTime()).toBeLessThan(60_000)
    const [receipt] = await receiptsOf(d.id)
    expect(Math.abs(new Date(receipt.issueDate).getTime() - new Date(row.date).getTime())).toBeLessThan(60_000)

    // A bank transfer has no receipt, and arrived the day it says.
    await w.call('POST', `/invoices/${d.id}/payments`, { date: yesterday, amount: 14, method: 'bank_transfer' })
    expect(new Date((await raw(d.id)).payments[1].date).toISOString().slice(0, 10)).toBe(yesterday)
  })

  it('refuses a payment on a draft: its receipt would name no number', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    const r = await pay(w, d.id, 24)
    expect(r.status).toBe(422)
    expect(r.json.code).toBe('document_not_issued')
    expect((await raw(d.id)).amountPaid).toBe(0)
  })

  it('a bill, a credit note and an invoice for a cash sale print nothing', async () => {
    const w = await tillWorld(app)
    const cs = (await w.backOfficeSale(1)).json.invoice
    const contact = await createTestContact(w.oid, { companyName: 'Y', type: 'customer' } as any)
    const inv = await w.call('POST', `/invoices/${cs.id}/to-invoice`, { contactId: String(contact._id), issueDate: TODAY })
    expect(inv.status).toBe(200)
    expect(w.sim!.receipts).toHaveLength(0)
  })
})

describe('a debit note (§2.2)', () => {
  it('issued in cash prints a sale receipt, naming itself; paid later prints per rate', async () => {
    const w = await tillWorld(app)
    const { id } = await issuedPaid(w)
    const contactId = (await raw(id)).contactId

    const a = await draftOf(w, { type: 'debit_note', extra: { relatedInvoiceId: id, contactId: String(contactId) } })
    const issued = await send(w, a.id)
    expect(issued.status).toBe(200)
    const debit = await raw(a.id)
    expect(debit.status).toBe('paid')
    expect(debit.payments[0]).toMatchObject({ method: 'cash', origin: 'payment_receipt' })
    expect(w.sim!.receipts[1].texts).toEqual([`Дебитно известие № ${debit.invoiceNumber}`])
    expect((await receiptsOf(a.id))[0].register.paidInvoiceNumber).toBe(debit.invoiceNumber)

    const b = await draftOf(w, { type: 'debit_note', method: 'bank_transfer', extra: { relatedInvoiceId: id, contactId: String(contactId) } })
    await send(w, b.id)
    const number = (await raw(b.id)).invoiceNumber
    expect((await pay(w, b.id, 24, 'card')).status).toBe(200)
    expect(w.sim!.receipts[2].sales[0].text.replace('\n', ' ')).toBe(`Плащане по дебитно известие № ${number}`)
    expect((await raw(b.id)).status).toBe('paid')
  })
})

describe('cash on delivery on an invoice (Q-2)', () => {
  it('prints at issue in slot R, and the invoice stays due until the courier pays', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'cash_on_delivery' })

    const r = await send(w, d.id)

    expect(r.status).toBe(200)
    expect(w.sim!.receipts).toHaveLength(1)
    expect(w.sim!.receipts[0]).toMatchObject({ total: 24, payments: [{ mode: 'R', amount: 24 }] })
    expect(w.sim!.receipts[0].texts).toHaveLength(1)
    const inv = await raw(d.id)
    expect(inv).toMatchObject({ status: 'sent', amountPaid: 0, amountDue: 24 })
    expect(inv.payments).toHaveLength(0)
    expect(inv.receiptHolds ?? []).toHaveLength(0)

    // In the courier's bucket: expected at the close, never counted, not in the drawer.
    expect(await sessionOf(w)).toMatchObject({ totalCashOnDelivery: 24, totalCash: 0 })
    expect((await preview(w)).json.expected).toMatchObject({ cash: 100, cashOnDelivery: 24 })
  })

  it('the courier\'s money prints nothing: every cent of it already has its receipt', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'cash_on_delivery' })
    await send(w, d.id)

    for (const [amount, method] of [[10, 'cash_on_delivery'], [14, 'cash']] as const) {
      expect((await pay(w, d.id, amount, method, undefined, w.clerkToken)).status).toBe(200)
    }
    expect(w.sim!.receipts).toHaveLength(1)
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect((await raw(d.id)).payments.map((p: any) => p.origin)).toEqual([undefined, undefined])
  })

  it('a device with no slot for it refuses at issue, before anything is written', async () => {
    const w = await tillWorld(app, { manufacturer: 'datecs' })
    const d = await draftOf(w, { method: 'cash_on_delivery' })
    const before = await footprint(w)
    const r = await send(w, d.id)
    expect(r.status).toBe(422)
    expect(r.json.code).toBe('cod_not_supported')
    expect(await footprint(w)).toEqual(before)
    expect((await raw(d.id)).status).toBe('draft')
  })

  it('a debit note on delivery prints nothing: only an invoice does', async () => {
    const w = await tillWorld(app)
    const { id } = await issuedPaid(w)
    const a = await draftOf(w, { type: 'debit_note', method: 'cash_on_delivery', extra: { relatedInvoiceId: id, contactId: String((await raw(id)).contactId) } })
    expect((await send(w, a.id)).status).toBe(200)
    expect(w.sim!.receipts).toHaveLength(1)
  })

  describe('a print that fails at issue', () => {
    /** Issued on delivery with the paper out, and the paper back in. */
    async function failedAtIssue(w: TillWorld) {
      const d = await draftOf(w, { method: 'cash_on_delivery' })
      w.sim!.paper = false
      const r = await send(w, d.id)
      expect(r.status).toBe(200)
      expect(r.json.receipt.state).toBe('failed')
      w.sim!.paper = true
      return d
    }

    it('prints on its own: no money is recorded, the invoice stays due, the courier\'s slot and the invoice\'s lines', async () => {
      const w = await tillWorld(app)
      const d = await failedAtIssue(w)
      expect((await shown(w, d.id)).receiptToPrint).toBe(true)

      const r = await printIt(w, d.id)

      expect(r.status).toBe(200)
      expect(r.json.receipt.state).toBe('printed')
      const printed = w.sim!.receipts.filter(x => !x.voided)
      expect(printed).toHaveLength(1)
      expect(printed[0]).toMatchObject({ total: 24, payments: [{ mode: 'R', amount: 24 }] })
      expect(printed[0].texts).toHaveLength(1)
      const inv = await raw(d.id)
      expect(inv).toMatchObject({ status: 'sent', amountPaid: 0, amountDue: 24 })
      expect(inv.payments).toHaveLength(0)
      expect(inv.receiptHolds ?? []).toHaveLength(0)
      expect(await sessionOf(w)).toMatchObject({ totalCashOnDelivery: 24, totalCash: 0 })
      expect((await shown(w, d.id)).receiptToPrint).toBe(false)
      expect((await shown(w, d.id)).paymentReceipts).toHaveLength(1)
    })

    it('a print that fails again says so, and is still owed', async () => {
      const w = await tillWorld(app)
      const d = await failedAtIssue(w)
      w.sim!.paper = false

      const r = await printIt(w, d.id)

      expect(r.status).toBe(503)
      expect(r.json.code).toBe('fiscal_error')
      expect(r.json.message).toContain('out of paper')
      expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0, amountDue: 24 })
      expect((await shown(w, d.id)).receiptToPrint).toBe(true)
      expect((await sessionOf(w)).totalCashOnDelivery ?? 0).toBe(0)
    })

    it('a retry with the same key prints once', async () => {
      const w = await tillWorld(app)
      const d = await failedAtIssue(w)

      const a = await printIt(w, d.id, 'cod-receipt-key-1')
      const b = await printIt(w, d.id, 'cod-receipt-key-1')

      expect([a.status, b.status]).toEqual([200, 200])
      expect(b.json.receipt.id).toBe(a.json.receipt.id)
      expect(w.sim!.receipts.filter(x => !x.voided)).toHaveLength(1)
    })

    it('no session: refused, and nothing is written', async () => {
      const w = await tillWorld(app)
      const d = await failedAtIssue(w)
      const before = await footprint(w)

      const r = await printIt(w, d.id, undefined, w.clerkToken)

      expect(r.status).toBe(409)
      expect(r.json.code).toBe('fiscal_device_not_connected')
      expect(await footprint(w)).toEqual(before)
    })

    it('a customer who pays at the counter after all prints that payment, as any does', async () => {
      const w = await tillWorld(app)
      const d = await failedAtIssue(w)

      expect((await pay(w, d.id, 24)).status).toBe(200)

      const printed = w.sim!.receipts.filter(x => !x.voided)
      expect(printed).toHaveLength(1)
      expect(printed[0].payments).toEqual([{ mode: 'P', amount: 24 }])
      expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
      expect((await shown(w, d.id)).receiptToPrint).toBe(false)
    })

    it('nothing is owed by one that printed, one that never tried, or one whose money is taken at the counter', async () => {
      const w = await tillWorld(app)
      const printed = await draftOf(w, { method: 'cash_on_delivery' })
      await send(w, printed.id)

      // Issued where LGR printed nothing yet: the courier's money, and no receipt ever tried.
      await Org.updateOne({ _id: w.oid }, { $set: { 'settings.cashRegister.requireConnectedDevice': false } })
      const never = await draftOf(w, { method: 'cash_on_delivery' })
      await send(w, never.id)
      await Org.updateOne({ _id: w.oid }, { $set: { 'settings.cashRegister.requireConnectedDevice': true } })

      // A cash invoice whose print failed: Pay takes that money, and prints.
      const cash = await draftOf(w)
      w.sim!.paper = false
      await send(w, cash.id)
      w.sim!.paper = true

      const device = w.sim!.executed.length
      for (const id of [printed.id, never.id, cash.id]) {
        const r = await printIt(w, id)
        expect(r.status).toBe(409)
        expect(r.json.code).toBe('no_receipt_owed')
        expect((await shown(w, id)).receiptToPrint).toBe(false)
      }
      expect(w.sim!.executed.length).toBe(device)
    })

    it('an issue that left no receipt behind still owes one: a claim refused its hold, and it was rolled back', async () => {
      const w = await tillWorld(app)
      const d = await draftOf(w, { method: 'cash_on_delivery' })
      const undo = during(u => !!u?.$push?.receiptHolds, () => Invoice.updateOne({ _id: d.id }, { $set: { voidingUntil: new Date(Date.now() + 60_000) } }))
      let r: any
      try {
        r = await send(w, d.id)
      } finally {
        undo()
      }
      expect(r.status).toBe(200)
      expect(r.json.receiptError).toBeTruthy()
      expect(await receiptsOf(d.id)).toHaveLength(0)
      await Invoice.updateOne({ _id: d.id }, { $unset: { voidingUntil: 1 } })

      expect((await shown(w, d.id)).receiptToPrint).toBe(true)
      expect((await pay(w, d.id, 24, 'cash_on_delivery')).json.code).toBe('delivery_receipt_owed')
      expect((await printIt(w, d.id)).status).toBe(200)
      expect((await shown(w, d.id)).receiptToPrint).toBe(false)
      expect((await pay(w, d.id, 24, 'cash_on_delivery')).status).toBe(200)
      expect(w.sim!.receipts.filter(x => !x.voided)).toHaveLength(1)
    })

    it('a process that died between the issue and its receipt: the same, and the courier\'s money waits', async () => {
      const w = await tillWorld(app)
      const d = await draftOf(w, { method: 'cash_on_delivery' })
      const dies = spyOn(Invoice, 'create').mockImplementationOnce(() => { throw new Error('the pod went away') })
      const r = await send(w, d.id)
      dies.mockRestore()
      expect(r.status).toBe(500)
      expect((await raw(d.id)).status).toBe('sent')
      expect(await receiptsOf(d.id)).toHaveLength(0)

      expect((await shown(w, d.id)).receiptToPrint).toBe(true)
      expect((await pay(w, d.id, 24, 'cash_on_delivery')).status).toBe(409)
      expect((await printIt(w, d.id)).status).toBe(200)
    })

    it('whether it is owed is the server\'s to write: no client can say so, on a form or on a copy', async () => {
      const w = await tillWorld(app)
      const created = await draftOf(w, { method: 'bank_transfer', extra: { deliveryReceiptOwed: true } })
      await send(w, created.id)
      await w.call('PUT', `/invoices/${created.id}`, { paymentMethod: 'cash_on_delivery', deliveryReceiptOwed: true })

      expect((await raw(created.id)).deliveryReceiptOwed).toBeUndefined()
      expect((await shown(w, created.id)).receiptToPrint).toBe(false)
    })

    it('voided, it is no longer owed: there is nothing left to print for', async () => {
      const w = await tillWorld(app)
      const voided = await failedAtIssue(w)
      expect((await w.call('POST', `/invoices/${voided.id}/void`)).status).toBe(200)

      expect((await shown(w, voided.id)).receiptToPrint).toBe(false)
      expect((await printIt(w, voided.id)).json.code).toBe('no_receipt_owed')
      expect(w.sim!.receipts.filter(x => !x.voided)).toHaveLength(0)
    })

    it('the courier\'s money does not go past a receipt that failed: it prints first, then it is recorded', async () => {
      const w = await tillWorld(app)
      const d = await failedAtIssue(w)

      const r = await pay(w, d.id, 24, 'cash_on_delivery')

      expect(r.status).toBe(409)
      expect(r.json.code).toBe('delivery_receipt_owed')
      expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
      expect((await shown(w, d.id)).receiptToPrint).toBe(true)

      expect((await printIt(w, d.id)).status).toBe(200)
      expect((await pay(w, d.id, 24, 'cash_on_delivery')).status).toBe(200)
      expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
      const printed = w.sim!.receipts.filter(x => !x.voided)
      expect(printed).toHaveLength(1)
      expect(printed[0].payments[0]).toMatchObject({ mode: 'R', amount: 24 })
    })

    it('part of the courier\'s money does not go past it either', async () => {
      const w = await tillWorld(app)
      const d = await failedAtIssue(w)
      expect((await pay(w, d.id, 10, 'cash_on_delivery')).json.code).toBe('delivery_receipt_owed')
      expect((await raw(d.id)).amountPaid).toBe(0)
    })

    it('part by bank, the receipt for the rest, and the courier\'s cash: recorded, and nothing more prints', async () => {
      const w = await tillWorld(app)
      const d = await failedAtIssue(w)
      expect((await pay(w, d.id, 4, 'bank_transfer')).status).toBe(200)

      expect((await printIt(w, d.id)).status).toBe(200)
      const printed = w.sim!.receipts.filter(x => !x.voided)
      expect(printed).toHaveLength(1)
      expect(printed[0].payments[0]).toMatchObject({ mode: 'R', amount: 20 })

      const r = await pay(w, d.id, 20)

      expect(r.status).toBe(200)
      expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24, amountDue: 0 })
      expect(w.sim!.receipts.filter(x => !x.voided)).toHaveLength(1)
    })

    it('a card payment in part prints its own receipt, and the delivery receipt prints what is left', async () => {
      const w = await tillWorld(app)
      const d = await failedAtIssue(w)
      expect((await pay(w, d.id, 4, 'card')).status).toBe(200)
      expect((await shown(w, d.id)).receiptToPrint).toBe(true)

      expect((await printIt(w, d.id)).status).toBe(200)

      const printed = w.sim!.receipts.filter(x => !x.voided)
      expect(printed.map(p => [p.payments[0].mode, p.payments[0].amount])).toEqual([['L', 4], ['R', 20]])
      expect((await shown(w, d.id)).receiptToPrint).toBe(false)
    })

    it('with the switch turned off since, it is no longer owed', async () => {
      const w = await tillWorld(app)
      const d = await failedAtIssue(w)
      await Org.updateOne({ _id: w.oid }, { $set: { 'settings.cashRegister.requireConnectedDevice': false } })

      const r = await printIt(w, d.id)

      expect(r.status).toBe(409)
      expect(r.json.code).toBe('no_receipt_owed')
      expect((await shown(w, d.id)).receiptToPrint).toBe(false)
      // And nothing stands in the courier's way.
      expect((await pay(w, d.id, 24, 'cash_on_delivery')).status).toBe(200)
    })

    it('a document that is not there is a 404', async () => {
      const w = await tillWorld(app)
      expect((await printIt(w, '64b000000000000000000000')).status).toBe(404)
    })
  })

  it('the freeze holds it: the receipt printed', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'cash_on_delivery' })
    await send(w, d.id)
    expect((await w.call('POST', `/invoices/${d.id}/void`)).json.code).toBe('fiscally_paid')
  })
})

describe('what a whole receipt prints', () => {
  it('a device with no text line prints the invoice\'s number as the line\'s name, per rate', async () => {
    const w = await tillWorld(app, { manufacturer: 'datecs' })
    const d = await draftOf(w)
    expect((await send(w, d.id)).status).toBe(200)
    const inv = await raw(d.id)
    const printed = w.sim!.receipts[0]
    expect(printed.texts).toEqual([])
    expect(printed.sales.map(s => [s.text, s.amount])).toEqual([[`Фактура № ${inv.invoiceNumber}`, 24]])
    expect(printed.total).toBe(24)
  })

  it('lines a device would add up differently print per rate: the receipt says what the invoice says', async () => {
    const w = await tillWorld(app, { stock: 2000 })
    // 1000 × 0.1234 net at 20 %: the invoice owes 148.08; at 0.15 rounded apiece a device says 150.00.
    const d = await draftOf(w, { lines: [line(w, 1000, 0.1234)] })
    expect((await send(w, d.id)).status).toBe(200)
    const printed = w.sim!.receipts[0]
    expect(printed.total).toBe(148.08)
    expect(printed.sales).toHaveLength(1)
    expect(printed.texts).toEqual([])
    expect((await raw(d.id)).status).toBe('paid')
  })

  it('a discount the device takes as the invoice does prints as a line', async () => {
    const w = await tillWorld(app)
    const l = { ...line(w, 2, 10), discount: 10, taxAmount: 3.6, lineTotal: 21.6 }
    const d = await draftOf(w, { lines: [l] })
    await send(w, d.id)
    const printed = w.sim!.receipts[0]
    expect(printed.total).toBe(21.6)
    expect(printed.sales[0]).toMatchObject({ quantity: 2, price: 12, percent: -10 })
    expect(printed.texts).toHaveLength(1)
  })

  it('a rate with a negative total at issue: refused with nothing written, the draft a draft with no number', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { lines: [freeLine(50, 20), { ...freeLine(-10, 9), quantity: 1 }] })
    const before = await footprint(w)

    const r = await send(w, d.id)

    expect(r.status).toBe(422)
    expect(r.json.code).toBe('receipt_not_printable')
    expect(await footprint(w)).toEqual(before)
    expect((await raw(d.id)).status).toBe('draft')
  })

  it('a rate with a negative total cannot be split: refused before anything is written', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer', lines: [freeLine(50, 20), { ...freeLine(-10, 9), quantity: 1 }] })
    await send(w, d.id)
    const r = await pay(w, d.id, 10)
    expect(r.status).toBe(422)
    expect(r.json.code).toBe('receipt_not_printable')
    expect(w.sim!.receipts).toHaveLength(0)
  })
})

describe('FR-24.50: a door that reaches a printer runs where the printer is', () => {
  const forwarded: Array<{ to: string; method: string; path: string }> = []
  let reachable = true

  beforeEach(() => {
    setFiscalForwarding({
      async forward(to, request) {
        forwarded.push({ to, method: request.method, path: new URL(request.url).pathname })
        return reachable ? new Response(JSON.stringify({ from: 'pod-b' }), { status: 200, headers: { 'content-type': 'application/json' } }) : null
      },
      isHop: () => false,
      clientIp: () => '203.0.113.7',
    })
  })
  afterEach(() => {
    setFiscalForwarding(null)
    forwarded.splice(0)
    reachable = true
  })

  /** This process lets go of the world's device, and a live row says pod B holds it. */
  async function heldOnPodB(w: TillWorld) {
    forgetDevices()
    await FiscalPresence.init()
    const now = new Date()
    await FiscalPresence.create({
      orgId: w.orgId, deviceNumber: 'ED123456', deviceId: w.deviceId, kind: 'user', label: 'Till on B',
      podId: 'pod-b', podAddr: 'http://10.0.0.2:4001', connId: 'conn-b', connectedAt: now, heartbeatAt: now,
    })
  }
  /** A receipt of this document that nobody finished, printing on the world's warehouse. */
  const unfinished = (w: TillWorld, id: string) => Invoice.collection.insertOne({
    orgId: w.oid, type: 'payment_receipt', register: { paidInvoiceId: new (Invoice.base as any).Types.ObjectId(id), warehouseId: w.warehouse._id },
  } as any)

  it('issuing, paying and printing a delivery receipt go to the pod with the printer, and nothing is written here', async () => {
    const w = await tillWorld(app)
    const cash = await draftOf(w)
    const bank = await draftOf(w, { method: 'bank_transfer' })
    await send(w, bank.id)
    const cod = await draftOf(w, { method: 'cash_on_delivery' })
    await heldOnPodB(w)
    const before = await footprint(w)

    const answers = [await send(w, cash.id), await pay(w, bank.id, 24), await printIt(w, cod.id)]

    expect(answers).toEqual(Array(3).fill({ status: 200, json: { from: 'pod-b' } }))
    expect(forwarded.map(f => f.path)).toEqual([
      `/org/${w.orgId}/invoices/${cash.id}/send`, `/org/${w.orgId}/invoices/${bank.id}/payments`, `/org/${w.orgId}/invoices/${cod.id}/receipt`,
    ])
    expect(await footprint(w)).toEqual(before)
    expect((await raw(cash.id)).status).toBe('draft')
  })

  it('the holder unreachable: 503, nothing written, the draft a draft', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    await heldOnPodB(w)
    reachable = false
    const before = await footprint(w)

    const r = await send(w, d.id)

    expect(r.status).toBe(503)
    expect(r.json.code).toBe('fiscal_holder_unreachable')
    expect(await footprint(w)).toEqual(before)
    expect((await raw(d.id)).status).toBe('draft')
  })

  it('a request that reaches this pod with no hop to take: held elsewhere is never offline (FR-24.52)', async () => {
    const w = await tillWorld(app)
    const cash = await draftOf(w)
    const bank = await draftOf(w, { method: 'bank_transfer' })
    await send(w, bank.id)
    await heldOnPodB(w)
    setFiscalForwarding(null)
    const before = await footprint(w)

    const answers = [await send(w, cash.id), await pay(w, bank.id, 24)]

    expect(answers.map(a => a.status)).toEqual([503, 503])
    for (const a of answers) expect(a.json.message).toContain('another server process')
    expect(await footprint(w)).toEqual(before)
    expect((await raw(cash.id)).status).toBe('draft')
    expect(await raw(bank.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
  })

  it('someone with no session and nothing to finish runs here: no printer is theirs to go to', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await heldOnPodB(w)

    expect((await send(w, d.id, undefined, w.clerkToken)).status).toBe(200)
    expect((await pay(w, d.id, 24, 'bank_transfer', undefined, w.clerkToken)).status).toBe(200)

    expect(forwarded).toHaveLength(0)
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
  })

  it('an edit and a void run here, unless a dead receipt is there to finish on its own device', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await heldOnPodB(w)

    expect((await w.call('PUT', `/invoices/${d.id}`, { reference: 'one' })).json.invoice.reference).toBe('one')
    expect(forwarded).toHaveLength(0)

    await unfinished(w, d.id)
    expect((await w.call('PUT', `/invoices/${d.id}`, { reference: 'two' })).json).toEqual({ from: 'pod-b' })
    expect((await w.call('POST', `/invoices/${d.id}/void`)).json).toEqual({ from: 'pod-b' })
    expect(forwarded.map(f => f.method)).toEqual(['PUT', 'POST'])
    expect((await raw(d.id)).reference).toBe('one')
  })

  it('the resolvers: the user\'s open session; else what a dead receipt was printing on; else nothing', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    const params = { orgId: w.orgId, id: d.id }
    const target = { orgId: w.orgId, deviceId: w.deviceId, deviceNumber: 'ED123456' }

    expect(await deviceFromCounter({ params, user: { id: String(w.user._id) }, body: {} })).toEqual(target)
    expect(await deviceFromCounter({ params, user: { id: String(w.clerk._id) }, body: {} })).toBeNull()
    expect(await deviceFromDeadReceipt({ params, user: {}, body: {} })).toBeNull()

    await unfinished(w, d.id)
    expect(await deviceFromCounter({ params, user: { id: String(w.clerk._id) }, body: {} })).toEqual(target)
    expect(await deviceFromDeadReceipt({ params, user: {}, body: {} })).toEqual(target)

    await Invoice.collection.updateMany({ orgId: w.oid, type: 'payment_receipt' } as any, { $set: { completedAt: new Date() } })
    expect(await deviceFromDeadReceipt({ params, user: {}, body: {} })).toBeNull()
  })
})

describe('§2.7 — once a receipt has printed, the total is the receipt\'s', () => {
  it('PUT answers 409 fiscally_paid to anything that moves it', async () => {
    const w = await tillWorld(app)
    const { id } = await issuedPaid(w)

    const moved = [
      { total: 25 },
      { lines: [line(w, 3)], subtotal: 30, taxTotal: 6, total: 36 },
      // The total kept, and the money moved between rates underneath it.
      { lines: [line(w, 2, 11, 9, { taxAmount: 1.98, lineTotal: 23.98 }), freeLine(0.02, 20)] },
      { currency: 'USD' },
    ]
    for (const body of moved) {
      const r = await w.call('PUT', `/invoices/${id}`, body)
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('fiscally_paid')
    }
    expect((await raw(id)).total).toBe(24)
  })

  it('anything else stays editable', async () => {
    const w = await tillWorld(app)
    const { id } = await issuedPaid(w)
    const r = await w.call('PUT', `/invoices/${id}`, { notes: 'доставка в петък', total: 24, lines: [line(w)] })
    expect(r.status).toBe(200)
    const inv = await raw(id)
    expect(inv.notes).toBe('доставка в петък')
    // And the money did not move with it.
    expect(inv).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect(inv.payments).toHaveLength(1)
  })

  it('a receipt whose request died and that never printed holds nothing up, for an edit or a void', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    const { paymentReceiptDocument } = await import('services/biz/cash-register/payment-receipt.service')
    const { receiptBody } = await import('services/biz/cash-register/receipt-lines')
    const invoice = await raw(d.id)
    const document = paymentReceiptDocument({
      invoice, body: receiptBody({ doc: invoice, amount: 24, whole: false, printsText: true, receipts: [] })!,
      tender: { method: 'cash', amount: 24, date: new Date() }, session: { id: w.sessionId, warehouseId: String(w.warehouse._id) },
      user: { id: String(w.user._id), operatorCode: '0001' }, printer: { deviceNumber: 'ED123456' } as any,
    })
    const stuck: any = await Invoice.create({ ...document, invoiceNumber: 'CS-2026-77777', leaseUntil: new Date(Date.now() - 1000) })
    await Invoice.updateOne({ _id: d.id }, { $push: { receiptHolds: { receiptId: stuck._id, amount: 24 } } })

    const edited = await w.call('PUT', `/invoices/${d.id}`, { lines: [line(w, 3)], subtotal: 30, taxTotal: 6, total: 36 })

    expect(edited.status).toBe(200)
    expect((await Invoice.findById(stuck._id).lean().exec() as any).status).toBe('voided')
    expect((await w.call('POST', `/invoices/${d.id}/void`)).status).toBe(200)
  })

  it('a void while a payment prints gives way, and the payment stands', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    const held = gate()
    w.sim!.beforeCommand = cmd => (cmd === 0x38 ? held.closed : undefined)

    const paying = pay(w, d.id, 24)
    await until(async () => w.sim!.executed.some(c => c.cmd === 0x35), 'the print to reach the payment')

    const voiding = await w.call('POST', `/invoices/${d.id}/void`)

    expect(voiding.status).toBe(409)
    held.open()
    expect((await paying).status).toBe(200)
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
  })

  it('a void finds a hold it did not see: it gives way, and moves no stock', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    // The hold lands between the void's check and its claim: no receipt to read yet.
    await Invoice.updateOne({ _id: d.id }, { $push: { receiptHolds: { receiptId: new (Invoice.base as any).Types.ObjectId(), amount: 24 } } })
    const movements = await StockMovement.countDocuments({ orgId: w.oid })

    const v = await w.call('POST', `/invoices/${d.id}/void`)

    expect(v.status).toBe(409)
    expect(v.json.code).toBe('payment_in_progress')
    expect((await raw(d.id)).status).toBe('sent')
    expect(await StockMovement.countDocuments({ orgId: w.oid })).toBe(movements)
  })

  it('a receipt that printed between a void\'s check and its claim stops it: a delivery receipt leaves no hold behind', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    const { ObjectId } = (Invoice.base as any).Types
    const real = Invoice.findOneAndUpdate
    ;(Invoice as any).findOneAndUpdate = function (filter: any, update: any, ...rest: any[]) {
      const query = (real as any).call(Invoice, filter, update, ...rest)
      if (!update?.$set?.voidingUntil) return query
      return {
        exec: async () => {
          await Invoice.collection.insertOne({
            orgId: w.oid, type: 'payment_receipt', direction: 'outgoing', status: 'paid', invoiceNumber: 'CS-2026-90001',
            issueDate: new Date(), currency: 'EUR', total: 24, paymentMethod: 'cash_on_delivery',
            register: { paidInvoiceId: new ObjectId(d.id), fiscal: { state: 'printed' } },
          } as any)
          return query.exec()
        },
      }
    }
    let v: any
    try {
      v = await w.call('POST', `/invoices/${d.id}/void`)
    } finally {
      ;(Invoice as any).findOneAndUpdate = real
    }

    expect(v.status).toBe(409)
    expect(v.json.code).toBe('fiscally_paid')
    const inv = await raw(d.id)
    expect(inv.status).toBe('sent')
    expect(inv.voidingUntil ?? null).toBeNull()
  })

  it('a payment while a void is under way gives way: no receipt on a voided invoice', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    await Invoice.updateOne({ _id: d.id }, { $set: { voidingUntil: new Date(Date.now() + 60_000) } })

    const r = await pay(w, d.id, 24)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('document_claimed')
    expect(w.sim!.receipts).toHaveLength(0)
    expect((await receiptsOf(d.id)).filter(x => x.status !== 'voided')).toHaveLength(0)
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
  })

  it('a bank payment while a void is under way gives way too: the claim is the money\'s, not the printer\'s', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    await Invoice.updateOne({ _id: d.id }, { $set: { voidingUntil: new Date(Date.now() + 60_000) } })

    const r = await pay(w, d.id, 24, 'bank_transfer')

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('document_claimed')
    const inv = await raw(d.id)
    expect(inv).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect(inv.payments).toHaveLength(0)
    expect(await JournalEntry.countDocuments({ orgId: w.oid, description: /Payment received/ })).toBe(0)
  })

  it('a payment that lands inside a real void, forced there, gives way, and the void ends clean', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    let inside: any
    const undo = during(update => !!update?.$set?.status && update.$set.status === 'voided', async () => {
      inside = await pay(w, d.id, 24, 'bank_transfer')
    })
    let v: any
    try {
      v = await w.call('POST', `/invoices/${d.id}/void`)
    } finally {
      undo()
    }

    expect(v.status).toBe(200)
    expect(inside.status).toBe(409)
    const inv = await raw(d.id)
    expect(inv).toMatchObject({ status: 'voided', amountPaid: 0 })
    expect(inv.payments).toHaveLength(0)
  })

  it('/send gives way to a void\'s claim: nothing is issued, no number is drawn, no stock moves', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    await Invoice.updateOne({ _id: d.id }, { $set: { voidingUntil: new Date(Date.now() + 60_000) } })
    const before = await footprint(w)

    const r = await send(w, d.id)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('document_claimed')
    expect((await raw(d.id)).status).toBe('draft')
    expect(await footprint(w)).toEqual(before)
  })

  it('/void gives way to an issue under way: its claim is on the draft, and the document ends issued', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    let inside: any
    const undo = during(update => !!update?.$set?.['issue.completedAt'], async () => {
      inside = await w.call('POST', `/invoices/${d.id}/void`)
    })
    let issued: any
    try {
      issued = await send(w, d.id)
    } finally {
      undo()
    }

    expect(inside.status).toBe(409)
    expect(inside.json.code).toBe('issue_in_progress')
    expect(issued.status).toBe(200)
    const inv = await raw(d.id)
    expect(inv.status).toBe('sent')
    expect(inv.voidingUntil ?? null).toBeNull()
  })

  it('a void inside an issue, on a cash draft: never a voided answer on a document that ends paid', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    await Invoice.updateOne({ _id: d.id }, { $set: { issue: { leaseUntil: new Date(Date.now() + 60_000) } } })

    const v = await w.call('POST', `/invoices/${d.id}/void`)

    expect(v.status).toBe(409)
    expect(v.json.code).toBe('issue_in_progress')
    expect((await raw(d.id)).status).toBe('draft')
    expect(w.sim!.receipts).toHaveLength(0)
  })

  it('an issue that crashed stops no void for long: its lease lapses', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await Invoice.updateOne({ _id: d.id }, { $set: { issue: { leaseUntil: new Date(Date.now() - 1000) } } })

    expect((await w.call('POST', `/invoices/${d.id}/void`)).status).toBe(200)
  })

  it('a void that crashed stops no issue for long: its claim lapses', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await Invoice.updateOne({ _id: d.id }, { $set: { voidingUntil: new Date(Date.now() - 1000) } })

    expect((await send(w, d.id)).status).toBe(200)
  })

  it('a void that crashed holds nothing up for long: its claim lapses', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    await Invoice.updateOne({ _id: d.id }, { $set: { voidingUntil: new Date(Date.now() - 1000) } })

    expect((await pay(w, d.id, 24)).status).toBe(200)

    expect(w.sim!.receipts).toHaveLength(1)
  })

  it('a void that fails on the stock gives the document back', async () => {
    const w = await tillWorld(app)
    // A bill: voiding it takes back goods that left since.
    const d = await draftOf(w, { method: 'bank_transfer', extra: { direction: 'incoming' } })
    expect((await w.call('POST', `/invoices/${d.id}/receive`, {})).status).toBe(200)
    await StockLevel.updateMany({ orgId: w.oid }, { $set: { quantity: 0 } })

    const v = await w.call('POST', `/invoices/${d.id}/void`)

    expect(v.status).toBe(400)
    const inv = await raw(d.id)
    expect(inv.status).toBe('received')
    expect(inv.voidingUntil ?? null).toBeNull()
  })

  it('a void and a payment at once: never both', async () => {
    const w = await tillWorld(app)
    for (let i = 0; i < 8; i++) {
      const d = await draftOf(w, { method: 'bank_transfer' })
      await send(w, d.id)
      const before = w.sim!.receipts.filter(r => !r.voided).length

      const [v, p] = await Promise.all([w.call('POST', `/invoices/${d.id}/void`), pay(w, d.id, 24)])

      const inv = await raw(d.id)
      const printed = w.sim!.receipts.filter(r => !r.voided).length - before
      expect(v.status === 200 && p.status === 200).toBe(false)
      if (inv.status === 'voided') {
        expect(printed).toBe(0)
        expect(inv.amountPaid).toBe(0)
      }
      if (p.status === 200) expect(inv).toMatchObject({ status: 'paid', amountPaid: 24 })
      expect(inv.voidingUntil ?? null).toBeNull()
    }
  })

  it('void is refused, and leaves the stock where it is', async () => {
    const w = await tillWorld(app)
    const { id } = await issuedPaid(w)
    const before = await w.stock()
    const r = await w.call('POST', `/invoices/${id}/void`)
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('fiscally_paid')
    expect((await raw(id)).status).toBe('paid')
    expect(await w.stock()).toEqual(before)
  })

  it('it cannot be attached to a cash sale either: its receipt took that money', async () => {
    const w = await tillWorld(app)
    const { id } = await issuedPaid(w)
    const cs = (await w.backOfficeSale(2)).json.invoice
    const r = await w.call('POST', `/invoices/${id}/attach-to-cash-sale`, { cashSaleId: String(cs.id) })
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('fiscally_paid')
  })

  describe('a claim, not a check (findings 5 and 9)', () => {
    /** The write that moves the money, with what would have landed between the freeze's read and it. */
    const raising = async (w: TillWorld, id: string, meanwhile: () => Promise<unknown>) => {
      const undo = during(update => update?.$set?.total === 12, meanwhile)
      try {
        return await w.call('PUT', `/invoices/${id}`, { lines: [line(w, 1)], subtotal: 10, taxTotal: 2, total: 12 })
      } finally {
        undo()
      }
    }

    it('a hold that lands after the freeze read: the edit gives way, and what is printing stands', async () => {
      const w = await tillWorld(app)
      const d = await draftOf(w, { method: 'bank_transfer' })
      await send(w, d.id)
      const hold = { receiptId: new (Invoice.base as any).Types.ObjectId(), amount: 24 }

      const r = await raising(w, d.id, () => Invoice.updateOne({ _id: d.id }, { $push: { receiptHolds: hold } }))

      expect(r.status).toBe(409)
      expect(r.json.code).toBe('payment_in_progress')
      expect(await raw(d.id)).toMatchObject({ total: 24, amountDue: 24 })
    })

    it('a payment that printed and finished after the freeze read: no negative due, and the total stands', async () => {
      const w = await tillWorld(app)
      const d = await draftOf(w, { method: 'bank_transfer' })
      await send(w, d.id)

      const r = await raising(w, d.id, () => pay(w, d.id, 24))

      expect(r.status).toBe(409)
      expect(r.json.code).toBe('fiscally_paid')
      expect(await raw(d.id)).toMatchObject({ status: 'paid', total: 24, amountPaid: 24, amountDue: 0 })
    })

    it('a bank payment after the read: the edit is told the document changed, and nothing is lost', async () => {
      const w = await tillWorld(app)
      const d = await draftOf(w, { method: 'bank_transfer' })
      await send(w, d.id)

      const r = await raising(w, d.id, () => pay(w, d.id, 20, 'bank_transfer'))

      expect(r.status).toBe(409)
      expect(r.json.code).toBe('document_changed')
      expect(await raw(d.id)).toMatchObject({ status: 'partially_paid', total: 24, amountPaid: 20, amountDue: 4 })
    })

    it('an edit that moves no money stays a plain write, with a hold on', async () => {
      const w = await tillWorld(app)
      const d = await draftOf(w, { method: 'bank_transfer' })
      await send(w, d.id)
      await Invoice.updateOne({ _id: d.id }, { $push: { receiptHolds: { receiptId: new (Invoice.base as any).Types.ObjectId(), amount: 24 } } })

      expect((await w.call('PUT', `/invoices/${d.id}`, { notes: 'a note' })).status).toBe(200)
      expect((await raw(d.id)).notes).toBe('a note')
    })

    /** An invoice issued on a day's sale, and that sale, as an attach finds them. */
    async function attachable(w: TillWorld) {
      const d = await draftOf(w, { method: 'bank_transfer' })
      await send(w, d.id)
      const cs = (await w.backOfficeSale(2, { issueDate: TODAY })).json.invoice
      return { d, cashSaleId: String(cs.id) }
    }
    const attach = (w: TillWorld, id: string, cashSaleId: string) => w.call('POST', `/invoices/${id}/attach-to-cash-sale`, { cashSaleId })

    it('attach is refused while a receipt holds the money, whatever the first read saw', async () => {
      const w = await tillWorld(app)
      const { d, cashSaleId } = await attachable(w)
      await Invoice.updateOne({ _id: d.id }, { $push: { receiptHolds: { receiptId: new (Invoice.base as any).Types.ObjectId(), amount: 24 } } })

      const r = await attach(w, d.id, cashSaleId)

      expect(r.status).toBe(409)
      expect(r.json.code).toBe('payment_in_progress')
      const inv = await raw(d.id)
      expect(inv.cashSaleRef).toBeUndefined()
      expect(inv.voidingUntil ?? null).toBeNull()
    })

    it('attach finds a receipt that came in as it claimed, and gives the document back', async () => {
      const w = await tillWorld(app)
      const { d, cashSaleId } = await attachable(w)
      const undo = during(update => !!update?.$set?.cashSaleRef, () => pay(w, d.id, 24))
      let r: any
      try {
        r = await attach(w, d.id, cashSaleId)
      } finally {
        undo()
      }

      expect(r.status).toBe(409)
      expect(r.json.code).toBe('fiscally_paid')
      const inv = await raw(d.id)
      expect(inv).toMatchObject({ status: 'paid', amountPaid: 24 })
      expect(inv.payments.map((p: any) => p.origin)).toEqual(['payment_receipt'])
      expect(inv.cashSaleRef).toBeUndefined()
      expect(inv.voidingUntil ?? null).toBeNull()
    })

    it('a hand payment that came in as it claimed stops it too: the final write would have dropped it', async () => {
      const w = await tillWorld(app)
      const { d, cashSaleId } = await attachable(w)
      const undo = during(update => !!update?.$set?.cashSaleRef, () => pay(w, d.id, 10, 'bank_transfer'))
      let r: any
      try {
        r = await attach(w, d.id, cashSaleId)
      } finally {
        undo()
      }

      expect(r.status).toBe(422)
      expect(r.json.code).toBe('invoice_has_payments')
      const inv = await raw(d.id)
      expect(inv.amountPaid).toBe(10)
      expect(inv.payments).toHaveLength(1)
      expect(inv.cashSaleRef).toBeUndefined()
    })

    it('a payment inside attach gives way: its claim stands until the link is finished', async () => {
      const w = await tillWorld(app)
      const { d, cashSaleId } = await attachable(w)
      let cash: any
      let bank: any
      const undo = during(update => !!update?.$set?.stockSource, async () => {
        cash = await pay(w, d.id, 24)
        bank = await pay(w, d.id, 24, 'bank_transfer')
      })
      let r: any
      try {
        r = await attach(w, d.id, cashSaleId)
      } finally {
        undo()
      }

      expect(r.status).toBe(200)
      expect(cash.status).toBe(409)
      expect(bank.status).toBe(409)
      expect(w.sim!.receipts.filter(x => x.kind === 'fiscal' && !x.voided).length).toBe(0)
      const inv = await raw(d.id)
      expect(inv).toMatchObject({ status: 'paid', amountPaid: 24, amountDue: 0 })
      expect(inv.voidingUntil ?? null).toBeNull()
      expect(inv.payments).toHaveLength(1)
    })

    it('an attach refused after its claim lets go of it', async () => {
      const w = await tillWorld(app)
      const { d, cashSaleId } = await attachable(w)
      await Invoice.updateOne({ _id: cashSaleId }, { $set: { 'register.stornoState': 'full' } })

      expect((await attach(w, d.id, cashSaleId)).status).toBeGreaterThanOrEqual(400)

      expect((await raw(d.id)).voidingUntil ?? null).toBeNull()
      expect((await pay(w, d.id, 24, 'bank_transfer')).status).toBe(200)
    })
  })

  it('an invoice whose only receipt failed stays editable and voidable', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    w.sim!.paper = false
    await send(w, d.id)
    w.sim!.paper = true

    expect((await w.call('PUT', `/invoices/${d.id}`, { lines: [line(w, 3)], subtotal: 30, taxTotal: 6, total: 36 })).status).toBe(200)
    expect((await w.call('POST', `/invoices/${d.id}/void`)).status).toBe(200)
  })

  it('every other invoice stays editable in every status, as today', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    expect((await w.call('PUT', `/invoices/${d.id}`, { lines: [line(w, 3)], subtotal: 30, taxTotal: 6, total: 36 })).status).toBe(200)
    expect((await w.call('POST', `/invoices/${d.id}/void`)).status).toBe(200)
  })

  it('the receipt itself is immutable: edit, delete and void refuse it', async () => {
    const w = await tillWorld(app)
    const { receipt } = await issuedPaid(w)
    const id = String(receipt._id)
    for (const [method, path, body] of [['PUT', `/invoices/${id}`, { notes: 'x' }], ['DELETE', `/invoices/${id}`], ['POST', `/invoices/${id}/void`]] as const) {
      const r = await w.call(method, path, body)
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('register_document_immutable')
    }
  })

  it('a storno is refused: it is no sale. R2 corrects it, through the credit note', async () => {
    const w = await tillWorld(app)
    const { receipt } = await issuedPaid(w)
    const r = await w.storno(String(receipt._id))
    expect(r.status).toBe(404)
    expect(w.sim!.receipts).toHaveLength(1)
  })
})

describe('print-once, reused unchanged (#155)', () => {
  /** A receipt its request left at `fiscal`, its lease lapsed: the process died there. */
  async function interrupted(w: TillWorld, d: { id: string; total: number }, fiscal: Record<string, unknown>, o: { key?: string; hash?: string; method?: string } = {}) {
    const { paymentReceiptDocument } = await import('services/biz/cash-register/payment-receipt.service')
    const { receiptBody } = await import('services/biz/cash-register/receipt-lines')
    const invoice = await raw(d.id)
    const body = receiptBody({ doc: invoice, amount: d.total, whole: false, printsText: true, receipts: [] })!
    const document = paymentReceiptDocument({
      invoice, body, tender: { method: o.method ?? 'cash', amount: d.total, date: new Date() },
      session: { id: w.sessionId, warehouseId: String(w.warehouse._id) },
      user: { id: String(w.user._id), operatorCode: '0001' },
      printer: { deviceNumber: 'ED123456' } as any,
    })
    const inserted: any = await Invoice.create({
      ...document, invoiceNumber: `CS-2026-${String(Math.floor(Math.random() * 90000) + 10000)}`, leaseUntil: new Date(Date.now() - 1000),
      ...(o.key ? { clientKey: o.key, requestHash: o.hash } : {}),
      register: { ...document.register, unp: 'ED123456-0001-0000099', fiscal: { state: 'pending', mode: 'fiscal', ...fiscal } },
    })
    await Invoice.updateOne({ _id: d.id }, { $push: { receiptHolds: { receiptId: inserted._id, amount: d.total } } })
    return inserted
  }

  const issuedOnBank = async (w: TillWorld) => {
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    return d
  }

  it('the next payment finds one that may have printed: nothing is booked and nothing prints, and a person settles it', async () => {
    const w = await tillWorld(app)
    const d = await issuedOnBank(w)
    // The counter moved past the note, and that proves nothing: the device is shared.
    const r = await interrupted(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber - 1 })

    const next = await pay(w, d.id, 24, 'card')

    expect(next.status).toBe(409)
    expect(next.json.code).toBe('receipt_in_doubt')
    expect(next.json.receipt.number).toBe(r.invoiceNumber)
    expect(w.sim!.receipts).toHaveLength(0)
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect((await sessionOf(w)).totalCash).toBe(0)
    expect((await Invoice.findById(r._id).lean().exec() as any).register.fiscal).toMatchObject({ state: 'unknown', inDoubt: true })
  })

  it('printing a delivery receipt finds a dead request first: one the device never printed is given up, and this one prints', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'cash_on_delivery' })
    w.sim!.paper = false
    await send(w, d.id)
    w.sim!.paper = true
    const dead = await interrupted(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber }, { method: 'cash_on_delivery' })

    const r = await printIt(w, d.id)

    expect(r.status).toBe(200)
    expect((await Invoice.findById(dead._id).lean().exec() as any).status).toBe('voided')
    expect(w.sim!.receipts.filter(x => !x.voided)).toHaveLength(1)
    expect((await raw(d.id)).receiptHolds ?? []).toHaveLength(0)
  })

  it('printing a delivery receipt finds a dead request first: one that may have printed is not printed again', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'cash_on_delivery' })
    w.sim!.paper = false
    await send(w, d.id)
    w.sim!.paper = true
    await interrupted(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber - 1 }, { method: 'cash_on_delivery' })

    const r = await printIt(w, d.id)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('receipt_in_doubt')
    expect(w.sim!.receipts).toHaveLength(0)
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
  })

  it('the next payment finds one the device never printed: it is given up, and this one prints', async () => {
    const w = await tillWorld(app)
    const d = await issuedOnBank(w)
    const r = await interrupted(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })

    const next = await pay(w, d.id, 24, 'card')

    expect(next.status).toBe(200)
    expect(w.sim!.receipts).toHaveLength(1)
    expect(w.sim!.receipts[0].payments[0].mode).toBe('L')
    expect((await Invoice.findById(r._id).lean().exec() as any).status).toBe('voided')
    expect((await raw(d.id)).payments).toHaveLength(1)
    expect((await raw(d.id)).payments[0].method).toBe('card')
  })

  it('one that never reached the device is given up, without asking it', async () => {
    const w = await tillWorld(app)
    const d = await issuedOnBank(w)
    await interrupted(w, d, {})
    expect((await pay(w, d.id, 24)).status).toBe(200)
    expect(w.sim!.receipts).toHaveLength(1)
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
  })

  it('a keyed retry reprints one the device never printed: the same request, the same customer', async () => {
    const w = await tillWorld(app)
    const d = await issuedOnBank(w)
    const { requestHash } = await import('services/biz/hot-path-key')
    const hash = requestHash(`invoice.payment:${d.id}`, { date: TODAY, amount: 24, method: 'cash' })
    await interrupted(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber }, { key: 'retry-key-0001', hash })

    const r = await pay(w, d.id, 24, 'cash', 'retry-key-0001')

    expect(r.status).toBe(200)
    expect(w.sim!.receipts).toHaveLength(1)
    expect((await raw(d.id)).status).toBe('paid')
  })

  it('a keyed retry the device cannot answer: unknown, never printed again, and held with the money unbooked', async () => {
    const w = await tillWorld(app)
    const d = await issuedOnBank(w)
    const { requestHash } = await import('services/biz/hot-path-key')
    const hash = requestHash(`invoice.payment:${d.id}`, { date: TODAY, amount: 24, method: 'cash' })
    // Two documents past the note: not ours alone.
    await interrupted(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber - 2 }, { key: 'retry-key-0002', hash })

    const r = await pay(w, d.id, 24, 'cash', 'retry-key-0002')

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('receipt_in_doubt')
    expect(w.sim!.receipts).toHaveLength(0)
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect((await sessionOf(w)).totalCash).toBe(0)

    // And it stands in the way of the freeze's doors, with the way out named.
    expect((await w.call('POST', `/invoices/${d.id}/void`)).json.code).toBe('receipt_in_doubt')
    expect((await w.call('PUT', `/invoices/${d.id}`, { lines: [line(w, 3)], subtotal: 30, taxTotal: 6, total: 36 })).json.code).toBe('receipt_in_doubt')
  })
})

describe('the ledger', () => {
  /** An org that keeps one: a cash and a bank journal, a receivable and a revenue account. */
  async function books(w: TillWorld) {
    const cash = await createTestAccount(w.oid, { name: 'Cash', type: 'asset' })
    const bank = await createTestAccount(w.oid, { name: 'Bank', type: 'asset' })
    const receivable = await createTestAccount(w.oid, { name: 'Receivable', type: 'asset' })
    const revenue = await createTestAccount(w.oid, { name: 'Revenue', type: 'revenue', subType: 'operating_revenue' } as any)
    const sale = await Journal.create({ orgId: w.oid, name: 'Sales', code: 'S1', type: 'sale' })
    const cashJ = await Journal.create({ orgId: w.oid, name: 'Cash', code: 'C1', type: 'cash', defaultDebitAccountId: cash._id })
    const bankJ = await Journal.create({ orgId: w.oid, name: 'Bank', code: 'B1', type: 'bank', defaultDebitAccountId: bank._id })
    await Org.updateOne({ _id: w.oid }, {
      $set: {
        'settings.accounting.defaultSaleJournalId': sale._id,
        'settings.accounting.defaultCashJournalId': cashJ._id,
        'settings.accounting.defaultBankJournalId': bankJ._id,
        'settings.accounting.defaultReceivableAccountId': receivable._id,
        'settings.accounting.defaultRevenueAccountId': revenue._id,
        'settings.accounting.autoPostInvoiceEntries': true,
        'settings.accounting.autoPostPaymentEntries': true,
      },
    })
    return { cash, bank, receivable, revenue }
  }
  const settled = async (w: TillWorld, count: number) => {
    for (let i = 0; i < 200; i++) {
      if (await JournalEntry.countDocuments({ orgId: w.oid }) >= count) break
      await new Promise(r => setTimeout(r, 25))
    }
    // The handler creates the entry and then stamps the payment's row: the stamp is the end of it.
    for (let i = 0; i < 80; i++) {
      const unstamped = { orgId: w.oid, payments: { $elemMatch: { origin: 'payment_receipt', journalEntryId: { $exists: false } } } }
      if (!(await Invoice.exists(unstamped).exec())) break
      await new Promise(r => setTimeout(r, 25))
    }
    await new Promise(r => setTimeout(r, 50))
  }

  /**
   * Holds the handler of `payment.recorded` between reading the invoice and posting its entry, which
   * is where another payment lands: what a test can see is the row, before and after.
   */
  async function whileItsEntryPosts(during: () => Promise<void>, run: () => Promise<unknown>) {
    const { getRepos } = await import('services/context')
    const repos: any = getRepos()
    const real = repos.invoices.findById
    let once = false
    repos.invoices.findById = async function (...args: any[]) {
      const doc = await real.apply(this, args)
      if (!once) {
        once = true
        await during()
      }
      return doc
    }
    try {
      await run()
      for (let i = 0; i < 200 && !once; i++) await new Promise(r => setTimeout(r, 10))
    } finally {
      repos.invoices.findById = real
    }
  }

  it('a payment\'s entry finds its own row: a receipt recorded meanwhile keeps its row', async () => {
    resetEventHandlers()
    registerEventHandlers()
    try {
      const w = await tillWorld(app)
      await books(w)
      const d = await draftOf(w, { method: 'bank_transfer' })
      await send(w, d.id)
      await settled(w, 1)

      await whileItsEntryPosts(
        async () => { expect((await pay(w, d.id, 10)).status).toBe(200) },
        async () => { expect((await pay(w, d.id, 14, 'bank_transfer')).status).toBe(200) },
      )
      await settled(w, 3)

      for (let i = 0; i < 120; i++) {
        const rows = (await raw(d.id)).payments
        if (rows.every((p: any) => p.journalEntryId)) break
        await new Promise(r => setTimeout(r, 25))
      }
      const inv = await raw(d.id)
      expect(inv.payments.map((p: any) => [p.method, p.amount])).toEqual([['bank_transfer', 14], ['cash', 10]])
      expect(inv).toMatchObject({ amountPaid: 24, status: 'paid' })
      const [bankRow, cashRow] = inv.payments
      expect(bankRow.journalEntryId).toBeTruthy()
      expect(cashRow.journalEntryId).toBeTruthy()
      expect(String(bankRow.journalEntryId)).not.toBe(String(cashRow.journalEntryId))
      const bankEntry: any = await JournalEntry.findById(bankRow.journalEntryId).lean().exec()
      expect(bankEntry.lines.map((l: any) => l.debit + l.credit)).toEqual([14, 14])
    } finally {
      resetEventHandlers()
    }
  })

  it('the settlement rule\'s payment finds its row too', async () => {
    resetEventHandlers()
    registerEventHandlers()
    try {
      const w = await tillWorld(app)
      await books(w)
      await allowSalesWithoutPrinter(w.oid)
      // The org's first entry opens its fiscal year: the two that follow must not race to.
      const first = await draftOf(w, { method: 'bank_transfer' })
      await send(w, first.id)
      await settled(w, 1)
      const d = await draftOf(w)
      await send(w, d.id)

      for (let i = 0; i < 200; i++) {
        if ((await raw(d.id)).payments?.[0]?.journalEntryId) break
        await new Promise(r => setTimeout(r, 25))
      }

      const [row] = (await raw(d.id)).payments
      expect(row.origin).toBe('cash_on_issue')
      expect(row.journalEntryId).toBeTruthy()
    } finally {
      resetEventHandlers()
    }
  })

  it('a cash payment posts as today, once, stamped on its own row; the session\'s close posts none of it', async () => {
    resetEventHandlers()
    registerEventHandlers()
    try {
      const w = await tillWorld(app)
      const a = await books(w)
      const { id, invoice } = await issuedPaid(w)
      await settled(w, 2)

      const entries: any[] = await JournalEntry.find({ orgId: w.oid }).sort({ _id: 1 }).lean().exec()
      expect(entries.map(e => e.description)).toEqual([`Sales invoice: ${invoice.invoiceNumber}`, `Payment received: ${invoice.invoiceNumber} (cash)`])
      const payment = entries[1]
      expect(payment.lines.map((l: any) => [String(l.accountId), l.debit, l.credit])).toEqual([
        [String(a.cash._id), 24, 0],
        [String(a.receivable._id), 0, 24],
      ])
      const row = (await raw(id)).payments[0]
      expect(String(row.journalEntryId)).toBe(String(payment._id))
      // Stamped in place: the row's link to its receipt, and its id, stand.
      expect(row.receiptId).toBeTruthy()

      // A close with nothing else in the session posts nothing: its money is the invoice's.
      await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 124 } })
      await postPosSessionJournal({ orgId: w.orgId, sessionId: w.sessionId, userId: String(w.user._id) })
      await new Promise(r => setTimeout(r, 50))
      expect(await JournalEntry.countDocuments({ orgId: w.oid })).toBe(2)
    } finally {
      resetEventHandlers()
    }
  })

  it('a receipt\'s entry is stamped on its own row, wherever that row is', async () => {
    resetEventHandlers()
    registerEventHandlers()
    try {
      const w = await tillWorld(app)
      await books(w)
      const d = await draftOf(w, { method: 'bank_transfer' })
      await send(w, d.id)
      await pay(w, d.id, 10)
      await settled(w, 2)
      await pay(w, d.id, 14)
      await settled(w, 3)
      const before = (await raw(d.id)).payments
      expect(before.map((p: any) => !!p.journalEntryId)).toEqual([true, true])

      // Another entry for the FIRST receipt, the second row now last: the last row keeps its own.
      const [first] = await receiptsOf(d.id)
      eventBus.emit('payment.recorded', { invoiceId: d.id, orgId: w.orgId, userId: String(w.user._id), amount: 10, method: 'cash', receiptId: String(first._id) })
      await settled(w, 4)
      let after = (await raw(d.id)).payments
      for (let i = 0; i < 120 && String(after[0].journalEntryId) === String(before[0].journalEntryId); i++) {
        await new Promise(r => setTimeout(r, 25))
        after = (await raw(d.id)).payments
      }
      expect(String(after[1].journalEntryId)).toBe(String(before[1].journalEntryId))
      expect(String(after[0].journalEntryId)).not.toBe(String(before[0].journalEntryId))
      // The array was not written back: the rows are the same rows.
      expect(after.map((p: any) => String(p._id))).toEqual(before.map((p: any) => String(p._id)))
    } finally {
      resetEventHandlers()
    }
  })

  it('card goes to the bank journal, as a card payment always did', async () => {
    resetEventHandlers()
    registerEventHandlers()
    try {
      const w = await tillWorld(app)
      const a = await books(w)
      await issuedPaid(w, 'card')
      await settled(w, 2)
      const entries: any[] = await JournalEntry.find({ orgId: w.oid }).sort({ _id: 1 }).lean().exec()
      expect(String(entries[1].lines[0].accountId)).toBe(String(a.bank._id))
    } finally {
      resetEventHandlers()
    }
  })

  it('a session with a till sale and a receipt: the close posts the sale alone', async () => {
    resetEventHandlers()
    registerEventHandlers()
    try {
      const w = await tillWorld(app)
      const a = await books(w)
      await issuedPaid(w)
      await settled(w, 2)
      await w.sell(1)
      await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 136 } })
      await settled(w, 3)
      const entry: any = await JournalEntry.findOne({ orgId: w.oid, description: /POS session/ }).lean().exec()
      expect(entry.totalDebit).toBe(12)
      // No output VAT account here: the VAT goes to revenue too, on its own line.
      expect(entry.lines.filter((l: any) => String(l.accountId) === String(a.revenue._id)).reduce((s: number, l: any) => s + l.credit, 0)).toBe(12)
    } finally {
      resetEventHandlers()
    }
  })

  it('a failed print and a cash-on-delivery receipt emit no payment', async () => {
    const recorded: any[] = []
    const off = eventBus.on('payment.recorded', (p: any) => { recorded.push(p) })
    try {
      const w = await tillWorld(app)
      const cod = await draftOf(w, { method: 'cash_on_delivery' })
      await send(w, cod.id)
      const d = await draftOf(w)
      w.sim!.paper = false
      await send(w, d.id)
      expect(recorded).toHaveLength(0)
      w.sim!.paper = true
      await pay(w, d.id, 24)
      expect(recorded).toHaveLength(1)
      expect(recorded[0]).toMatchObject({ invoiceId: d.id, amount: 24, method: 'cash' })
    } finally {
      off()
    }
  })
})

describe('§2.6 — who reads what: revenue counts the money once', () => {
  /** A till sale of 12 and a cash invoice of 24 through the same session, the invoice's receipt printed. */
  async function day(w: TillWorld) {
    await w.sell(1)
    const paid = await issuedPaid(w)
    return { ...paid, date: localDayOf(new Date(), 'Europe/Sofia') }
  }
  const report = (id: string, orgId: string, params: Record<string, any>) => {
    const entry = reportById(id)!
    return entry.handler!({ orgId, params: validateParams(entry, params), output: 'table' }) as Promise<any>
  }
  /** Yesterday to tomorrow: the documents' date and the receipt's moment are inside it at any hour. */
  const around = () => {
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
    return { preset: 'custom', from: day(-1), to: day(1) }
  }

  it('sales history: the invoice counts, the receipt is not a row', async () => {
    const w = await tillWorld(app)
    const d = await day(w)
    const out = await report('sales-history', w.orgId, { period: around(), includeNonRegister: true })
    const docs = out.rows.filter((r: any) => r.rowType === 'document')
    expect(docs.map((r: any) => r.number)).toEqual([d.invoice.invoiceNumber])
    expect(out.rows.some((r: any) => r.number === d.receipt.invoiceNumber)).toBe(false)
    const pos = await report('sales-history', w.orgId, { period: around(), source: 'pos' })
    expect(pos.rows.filter((r: any) => r.rowType === 'pos')).toHaveLength(1)
  })

  it('a cash invoice whose receipt failed took no money: sales history lists it, and counts nothing', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    w.sim!.paper = false
    await send(w, d.id)
    w.sim!.paper = true
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0, paymentMethod: 'cash' })

    const out = await report('sales-history', w.orgId, { period: around(), includeNonRegister: true })

    const docs = out.rows.filter((r: any) => r.rowType === 'document')
    expect(docs.map((r: any) => r.invoiceId)).toEqual([d.id])
    // The row keeps its total: it is issued revenue. The reconciliation foots on `unpaid`.
    expect(docs[0].total).toBe(24)
    const summary = out.meta.summary.find((s: any) => s.currency === 'EUR')
    expect(summary).toMatchObject({ total: 24, cash: 0, card: 0, other: 0, unpaid: 24 })
  })

  it('a part-paid one foots too: what was taken is money, the rest is unpaid', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    w.sim!.paper = false
    await send(w, d.id)
    w.sim!.paper = true
    expect((await pay(w, d.id, 10)).status).toBe(200)

    const out = await report('sales-history', w.orgId, { period: around(), includeNonRegister: true })

    expect(out.meta.summary.find((s: any) => s.currency === 'EUR')).toMatchObject({ total: 24, cash: 10, unpaid: 14 })
  })

  it('in an org that prints nothing the header is the money, as it always was, and the summary has no such line', async () => {
    const w = await tillWorld(app)
    await allowSalesWithoutPrinter(w.oid)
    const invoice = await draftOf(w, { method: 'bank_transfer' })
    await send(w, invoice.id)
    await Invoice.updateOne({ _id: invoice.id }, { $set: { paymentMethod: 'cash' } })

    const out = await report('sales-history', w.orgId, { period: around(), includeNonRegister: true })

    const summary = out.meta.summary.find((s: any) => s.currency === 'EUR')
    expect(summary).toMatchObject({ total: 24, cash: 24 })
    expect('unpaid' in summary).toBe(false)
  })

  it('a debit note issued in cash in an org that prints nothing keeps its money in the digest', async () => {
    const w = await tillWorld(app)
    const inv = await draftOf(w, { method: 'bank_transfer' })
    await send(w, inv.id)
    await allowSalesWithoutPrinter(w.oid)
    const note = await draftOf(w, { type: 'debit_note', extra: { relatedInvoiceId: inv.id, contactId: inv.contactId } })
    await send(w, note.id)
    expect(await raw(note.id)).toMatchObject({ status: 'sent', amountPaid: 0, paymentMethod: 'cash' })
    const date = localDayOf(new Date(), 'Europe/Sofia')
    await Invoice.updateMany({ orgId: w.oid }, { $set: { issueDate: new Date(`${date}T10:00:00Z`) } })

    const digest: any = await buildDailyDigest(w.orgId, date)

    expect(digest.kpis.byMethod.find((m: any) => m.method === 'cash')).toMatchObject({ amount: 24 })
  })

  it('the register: where LGR prints, the open part of a cash or card header goes to „По банка", never В брой or Карта', async () => {
    const w = await tillWorld(app)
    const cash = await draftOf(w)
    const card = await draftOf(w, { method: 'card' })
    const part = await draftOf(w)
    w.sim!.paper = false
    for (const d of [cash, card, part]) await send(w, d.id)
    w.sim!.paper = true
    expect((await pay(w, part.id, 10)).status).toBe(200)

    const out = await report('sales-documents', w.orgId, { period: around() })

    const row = async (id: string) => out.rows.find((r: any) => r.invoiceId === id)
    expect(await row(cash.id)).toMatchObject({ total: 24, paidCash: 0, paidCard: 0, bank: 24 })
    expect(await row(card.id)).toMatchObject({ total: 24, paidCash: 0, paidCard: 0, bank: 24 })
    expect(await row(part.id)).toMatchObject({ total: 24, paidCash: 10, paidCard: 0, bank: 14 })
  })

  it('cash on delivery keeps its own column, paid or not', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'cash_on_delivery' })
    await send(w, d.id)

    const out = await report('sales-documents', w.orgId, { period: around() })

    expect(out.rows.find((r: any) => r.invoiceId === d.id)).toMatchObject({ total: 24, paidCashOnDelivery: 24, bank: 0 })
  })

  it('the register of an org that prints nothing reads as it always did: an open cash header is В брой', async () => {
    const w = await tillWorld(app)
    const inv = await draftOf(w, { method: 'bank_transfer' })
    await send(w, inv.id)
    await allowSalesWithoutPrinter(w.oid)
    const note = await draftOf(w, { type: 'debit_note', extra: { relatedInvoiceId: inv.id, contactId: inv.contactId } })
    await send(w, note.id)

    const out = await report('sales-documents', w.orgId, { period: around() })

    expect(out.rows.find((r: any) => r.invoiceId === note.id)).toMatchObject({ total: 24, paidCash: 24, bank: 0 })
  })

  it('nor did it in the digest', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    w.sim!.paper = false
    await send(w, d.id)
    w.sim!.paper = true
    const date = localDayOf(new Date(), 'Europe/Sofia')
    await Invoice.updateMany({ orgId: w.oid }, { $set: { issueDate: new Date(`${date}T10:00:00Z`) } })

    const digest: any = await buildDailyDigest(w.orgId, date)

    expect(digest.kpis.byMethod.find((m: any) => m.method === 'cash')).toBeUndefined()
    expect(digest.kpis.salesTotal).toBe(24)
  })

  it('and once it is paid, it counts', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    w.sim!.paper = false
    await send(w, d.id)
    w.sim!.paper = true
    expect((await pay(w, d.id, 24)).status).toBe(200)

    const out = await report('sales-history', w.orgId, { period: around(), includeNonRegister: true })

    expect(out.meta.summary.find((s: any) => s.currency === 'EUR')?.cash).toBe(24)
  })

  it('the digest: KPIs, payments and methods count it once; no gap in the CS series; no "no movement"', async () => {
    const w = await tillWorld(app)
    const d = await day(w)
    await Invoice.updateMany({ orgId: w.oid }, { $set: { issueDate: new Date(`${d.date}T10:00:00Z`) } })
    await Invoice.updateMany({ orgId: w.oid, 'payments.0': { $exists: true } }, { $set: { 'payments.$[].date': new Date(`${d.date}T10:00:00Z`) } })

    const digest: any = await buildDailyDigest(w.orgId, d.date)

    expect(digest.kpis).toMatchObject({ salesTotal: 24, salesCount: 1, cashTotal: 12, cashCount: 1, paymentsTotal: 24 + 12, paymentsCount: 2 })
    expect(digest.kpis.byMethod.find((m: any) => m.method === 'cash')).toMatchObject({ amount: 36, count: 2 })
    expect(digest.undocumentedSales.count).toBe(0)
    expect(digest.duplicates.count).toBe(0)
    // Two numbers of the series, one a sale's and one a receipt's, and no gap between them.
    expect(digest.documents.cash.sequence.count).toBe(2)
    expect(digest.documents.cash.sequence.missing).toEqual([])
    expect(digest.documents.cash.count).toBe(1)
    expect(digest.documents.cash.total).toBe(12)
  })

  it('the field check holds on an org with a receipt: the journal lists them, and its invariant says so', async () => {
    const w = await tillWorld(app)
    await day(w)
    const script = await Bun.file(new URL('../../../../scripts/cash-register-field-check.ts', import.meta.url)).text()
    const formula = /row\.journalInvariant = (.+)/.exec(script)![1]
    const count = (type: string) => Invoice.countDocuments({ orgId: w.oid, type }).exec()
    const row = { pos: 0, copies: 0, cashSales: await count('cash_sale'), cashStornos: await count('cash_storno'), paymentReceipts: await count('payment_receipt') }
    const all = await listJournal({ orgId: w.orgId, size: 1 })

    expect(row.paymentReceipts).toBe(1)
    expect(new Function('row', 'all', `return ${formula}`)(row, all)).toBe(true)
  })

  it('Reports: sales documents list the invoice, the cash register does not list the receipt', async () => {
    const w = await tillWorld(app)
    const d = await day(w)
    const sales = await report('sales-documents', w.orgId, { period: around() })
    expect(sales.rows.map((r: any) => r.number)).toEqual([d.invoice.invoiceNumber])
    const cash = await report('cash-register', w.orgId, { period: around() })
    expect(cash.rows.some((r: any) => r.number === d.receipt.invoiceNumber)).toBe(false)
  })

  it('the exports: the sales documents name the invoice, and neither export names the receipt', async () => {
    const w = await tillWorld(app)
    const d = await day(w)
    const cellsOf = async (kind: string) => {
      const res = await app.handle(new Request(`http://localhost/org/${w.orgId}/invoicing/export/kind/${kind}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${w.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ format: 'xlsx', mode: 'compact', locale: 'en' }),
      }))
      expect(res.status).toBe(200)
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(await res.arrayBuffer())
      const cells: string[] = []
      wb.eachSheet(ws => ws.eachRow(r => r.eachCell(c => { cells.push(String(c.value ?? '')) })))
      return cells
    }
    const outgoing = await cellsOf('outgoing')
    expect(outgoing).toContain(d.invoice.invoiceNumber)
    expect(outgoing).not.toContain(d.receipt.invoiceNumber)
    expect(await cellsOf('cash_register')).not.toContain(d.receipt.invoiceNumber)
  })

  it('the list of invoices leaves it out', async () => {
    const w = await tillWorld(app)
    const d = await day(w)
    const list = await w.call('GET', '/invoices?size=50')
    const numbers = list.json.invoices.map((i: any) => i.number)
    expect(numbers).toContain(d.invoice.invoiceNumber)
    expect(numbers).not.toContain(d.receipt.invoiceNumber)
    expect(list.json.invoices.some((i: any) => i.type === 'payment_receipt')).toBe(false)
  })

  it('the ledgers: the customer owes and paid once; the product sold once', async () => {
    const w = await tillWorld(app)
    const d = await day(w)
    const ledger = await getContactLedger(w.orgId, d.contactId)
    expect(ledger.entries.map(e => e.documentNumber)).toEqual([d.invoice.invoiceNumber])
    expect(ledger.summary.totalSales).toBe(24)

    const product: any = await getProductLedger(w.orgId, String(w.product._id))
    expect(product.summary.totalInvoiceSales).toBe(24)
    expect(product.summary.totalCashRegisterSales).toBe(12)
    expect(product.entries.filter((e: any) => e.movementType === 'dispatch')).toHaveLength(2)
  })

  it('the customer\'s profitability counts the goods\' cost once: a receipt printed whole carries the lines too', async () => {
    const w = await tillWorld(app)
    await Product.updateOne({ _id: w.product._id }, { $set: { purchasePrice: 4 } })
    const d = await draftOf(w)
    await send(w, d.id)
    expect((await receiptsOf(d.id))[0].lines).toHaveLength(1)

    const ledger = await getContactLedger(w.orgId, d.contactId)

    expect(ledger.summary.profitabilityGross).toBe(16)
    expect(ledger.summary.profitabilityNet).toBe(12)
  })

  it('the dashboard and the list\'s KPIs: paid in the last 30 days counts it once', async () => {
    const w = await tillWorld(app)
    await day(w)
    const summary = await getInvoiceSummary(w.orgId, { direction: 'outgoing' } as any)
    // The till sale's 12 is a sale of its own, and the invoice's 24.
    expect(summary.paid30d).toEqual({ amount: 36, count: 2 })
    const list = await w.call('GET', '/invoices/summary?direction=outgoing')
    expect(list.json.summary.paid30d).toEqual({ amount: 36, count: 2 })
  })

  it('what is owed is the invoice\'s: aging and the open balance count a cash-on-delivery invoice once', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'cash_on_delivery' })
    await send(w, d.id)
    const aging = (await w.call('GET', '/invoicing/reports/aging')).json.data
    expect(aging.map((r: any) => [r.contactId, r.totalOutstanding])).toEqual([[d.contactId, 24]])
    expect((await w.call('GET', `/stats/contact/${d.contactId}`)).json.stats.openBalance).toBe(24)
    expect((await w.call('GET', `/invoicing/contact/${d.contactId}/summary`)).json.openBalance).toBe(24)
    expect((await getInvoiceSummary(w.orgId, { direction: 'outgoing' } as any)).outstanding).toEqual({ amount: 24, count: 1 })
  })

  it('the smart buttons count the invoice, not the receipt', async () => {
    const w = await tillWorld(app)
    const d = await day(w)
    expect((await w.call('GET', `/stats/product/${w.product._id}`)).json.stats.invoiceCount).toBe(2)
    expect((await w.call('GET', `/stats/contact/${d.contactId}`)).json.stats.invoiceCount).toBe(1)
    expect((await w.call('GET', `/invoicing/contact/${d.contactId}/summary`)).json.invoiceCount).toBe(1)
  })

  it('the journal lists it: number, УНП, amount and the invoice it paid, under its own kind', async () => {
    const w = await tillWorld(app)
    const d = await day(w)
    const all = await w.call('GET', '/cash-register/documents')
    expect(all.json.total).toBe(2)
    const only = await w.call('GET', '/cash-register/documents?kind=payment')
    expect(only.json.rows).toHaveLength(1)
    const row = only.json.rows[0]
    expect(row).toMatchObject({
      number: d.receipt.invoiceNumber, kind: 'payment', total: 24, origin: 'pos', status: 'completed',
      invoices: [{ id: d.id, number: d.invoice.invoiceNumber }],
      fiscal: { state: 'printed', unp: d.receipt.register.unp },
      stock: 'none',
    })
    const detail = await w.call('GET', `/cash-register/documents/${row.id}`)
    expect(detail.status).toBe(200)
    expect(detail.json.lines[0].description).toBe('Болт DIN 933 М8Х25')
    // Filtering on sales leaves it out.
    expect((await w.call('GET', '/cash-register/documents?kind=sale')).json.total).toBe(1)
  })

  it('a failed receipt is in the journal, voided', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    w.sim!.paper = false
    await send(w, d.id)
    const { rows } = (await w.call('GET', '/cash-register/documents?kind=payment')).json
    expect(rows[0]).toMatchObject({ status: 'voided', fiscal: { state: 'failed' } })
  })

  it('the session counts it: expected cash, the close preview, the report', async () => {
    const w = await tillWorld(app)
    await day(w)

    const p = (await preview(w)).json
    expect(p.expected).toMatchObject({ cash: 136, card: 0 })
    expect(p.report).toMatchObject({ total: 36, counts: { sales: 1, payments: 1, fiscal: 2, voided: 0 } })
    expect(p.report.byMethod.cash).toBe(36)
    expect(p.report.vat).toEqual([{ rate: 20, net: 30, vat: 6, gross: 36 }])

    const closed = await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 136 } })
    expect(closed.status).toBe(200)
    expect(closed.json.session).toMatchObject({ expectedBalance: 136, difference: 0, totalSales: 36 })
    expect(closed.json.report).toMatchObject({ total: 36, counts: { payments: 1 } })
    expect(closed.json.report.documents).toBeDefined()
    // What the session report says is what the device's day says.
    expect(w.sim!.closure).toBeGreaterThan(0)
    expect(w.sim!.reports.at(-1)!.data).toBe('0')
    expect(w.sim!.receipts.reduce((s, r) => s + r.total, 0)).toBe(closed.json.report.total)
  })

  it('the session report names the payments on a text receipt, in every language', () => {
    const report = buildSessionReport(
      { sessionNumber: 'POS-1', currency: 'EUR', openingBalance: 0 },
      [{
        transactionNumber: 'CS-1', type: 'payment_receipt', status: 'completed', total: 24, taxTotal: 4,
        fiscal: { state: 'printed', mode: 'fiscal' }, payments: [{ method: 'cash', amount: 24 }],
        lines: [{ taxRate: 20, taxAmount: 4, lineTotal: 20 }],
      }],
    )
    expect(report.counts).toMatchObject({ sales: 0, payments: 1, fiscal: 1 })
    expect(report.total).toBe(24)
    expect(formatSessionReport(report, 'bg').join('\n')).toContain('Плащания по фактури')
    expect(formatSessionReport(report, 'en').join('\n')).toContain('Invoice payments')
    expect(formatSessionReport(report, 'de').join('\n')).toContain('Rechnungszahlungen')
    expect(formatSessionReport(report, 'mk').join('\n')).toContain('Плаќања по фактури')
  })

  it('a report with none prints no such line and keeps its shape', () => {
    const report = buildSessionReport({ sessionNumber: 'POS-1', currency: 'EUR', openingBalance: 0 }, [])
    expect(report.counts).toEqual({ sales: 0, stornos: 0, voided: 0, fiscal: 0, text: 0, unprinted: 0 })
  })

  it('a failed receipt and a cash-on-delivery one, in the session\'s figures', async () => {
    const w = await tillWorld(app)
    const cod = await draftOf(w, { method: 'cash_on_delivery' })
    await send(w, cod.id)
    const d = await draftOf(w)
    w.sim!.paper = false
    await send(w, d.id)

    const p = (await preview(w)).json
    expect(p.expected).toMatchObject({ cash: 100, cashOnDelivery: 24 })
    expect(p.report.counts).toMatchObject({ payments: 1, voided: 1 })
    expect(p.report.byMethod).toMatchObject({ cash: 0, cashOnDelivery: 24 })
    expect(p.report.total).toBe(24)
  })

  it('the session journal entry never sees it: it reads the sales, and `loadPosRows` leaves it out', async () => {
    const w = await tillWorld(app)
    await day(w)
    expect((await loadPosRows({ orgId: w.orgId, sessionId: w.sessionId })).map(r => r.type)).toEqual(['sale'])
    expect((await loadPosRows({ orgId: w.orgId, sessionId: w.sessionId, withReceipts: true })).map(r => r.type)).toEqual(['sale', 'payment_receipt'])
  })

  it('SUPTO: 18.1, 18.2 and 18.3 list it, under its УНП, in the tables\' own layout', async () => {
    const w = await tillWorld(app)
    const d = await day(w)
    const filters = { orgId: w.orgId, dateFrom: new Date(Date.now() - 60_000), dateTo: new Date(Date.now() + 60_000) }

    const summarized = await exportSummarizedSales(filters)
    expect(summarized.transactions.map((t: any) => t.type)).toEqual(['sale', 'payment_receipt'])
    expect(summarized.cashSales).toHaveLength(0)
    const row = summarized.transactions[1]
    expect(row).toMatchObject({ unpNumber: d.receipt.register.unp, transactionNumber: d.receipt.invoiceNumber, total: 24, fiscalDeviceNumber: 'ED123456', operatorCode: '0001' })

    const payments = await exportPaymentDetails(filters)
    expect(payments.map((t: any) => t.payments[0])).toEqual([expect.objectContaining({ method: 'cash', amount: 12 }), expect.objectContaining({ method: 'cash', amount: 24 })])

    const items = await exportItemizedSales(filters)
    expect(items[1].lines).toEqual([expect.objectContaining({ name: 'Болт DIN 933 М8Х25', quantity: 2, taxRate: 20, taxAmount: 4, lineTotal: 20 })])

    expect(await exportReversedSales(filters)).toHaveLength(0)
    expect(await exportCancelledSales(filters)).toHaveLength(0)
  })

  it('SUPTO: a part payment lists its line per rate; a failed receipt lists in 18.5 alone', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    await pay(w, d.id, 12)
    const number = (await raw(d.id)).invoiceNumber
    w.sim!.paper = false
    await pay(w, d.id, 12)
    const filters = { orgId: w.orgId, dateFrom: new Date(Date.now() - 60_000), dateTo: new Date(Date.now() + 60_000) }

    const items = await exportItemizedSales(filters)
    expect(items).toHaveLength(1)
    expect(items[0].lines[0]).toMatchObject({ name: `Плащане по фактура № ${number}`, quantity: 1, taxRate: 20, taxAmount: 2, lineTotal: 10 })
    expect((await exportSummarizedSales(filters)).transactions).toHaveLength(1)
    expect(await exportPaymentDetails(filters)).toHaveLength(1)

    const cancelled = await exportCancelledSales(filters)
    expect(cancelled).toHaveLength(1)
    expect(cancelled[0]).toMatchObject({ type: 'payment_receipt', status: 'cancelled' })
    expect(cancelled[0].unpNumber).toBeTruthy()
  })

  it('the invoice PDF lists the receipts that paid it, УНП and number', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    await pay(w, d.id, 10)
    await pay(w, d.id, 14)
    const [a, b] = await receiptsOf(d.id)
    const shown = (await w.call('GET', `/invoices/${d.id}`)).json.invoice.paymentReceipts
    expect(shown.map((r: any) => r.number)).toEqual([a.invoiceNumber, b.invoiceNumber])
    const { html } = buildInvoiceHtml(await printableDocument(w.orgId, await raw(d.id)), { name: 'Org' } as any, {} as any, undefined, { locale: 'bg' })
    expect(html).toContain('Платена с касов бон')
    for (const r of [a, b]) {
      expect(html).toContain(r.invoiceNumber)
      expect(html).toContain(r.register.unp)
      expect(html).toContain(r.register.fiscalReceiptNumber)
    }
  })

  it('the PDF does not call a delivery receipt payment while the courier owes: it paid nothing yet', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'cash_on_delivery' })
    await send(w, d.id)
    const [receipt] = await receiptsOf(d.id)
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountDue: 24 })

    const due = buildInvoiceHtml(await printableDocument(w.orgId, await raw(d.id)), { name: 'Org' } as any, {} as any, undefined, { locale: 'bg' }).html
    expect(due).not.toContain('Платена с касов бон')
    expect(due).not.toContain(receipt.invoiceNumber)

    // GET still lists it: the document form shows what printed.
    expect((await shown(w, d.id)).paymentReceipts).toHaveLength(1)

    // The courier paid, and it did pay it.
    await pay(w, d.id, 24, 'cash_on_delivery')
    const paid = buildInvoiceHtml(await printableDocument(w.orgId, await raw(d.id)), { name: 'Org' } as any, {} as any, undefined, { locale: 'bg' }).html
    expect(paid).toContain('Платена с касов бон')
    expect(paid).toContain(receipt.invoiceNumber)
  })

  it('the PDF of an invoice with none prints no such row', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    const { html } = buildInvoiceHtml((await raw(d.id)) as any, { name: 'Org' } as any, {} as any, undefined, { locale: 'bg' })
    expect(html).not.toContain('Платена с касов бон')
  })

  it('the device witness reads a receipt as the last thing recorded on the device', async () => {
    const w = await tillWorld(app)
    const { receipt } = await issuedPaid(w)
    const [evidence] = await deviceEvidence(w.orgId, async () => ({ state: 'not_connected' }))
    expect(evidence.recorded).toMatchObject({ receiptNo: receipt.register.fiscalReceiptNumber, number: receipt.invoiceNumber })
  })

  it('a fenced import books a receipt as nothing: its invoice comes in with the stock and the money', () => {
    expect(bookingOf({ type: 'payment_receipt', status: 'paid', direction: 'outgoing' })).toBe('none')
    expect(bookingOf({ type: 'cash_sale', status: 'paid', direction: 'outgoing' })).toBe('register')
    expect(bookingOf({ type: 'invoice', status: 'paid', direction: 'outgoing' })).toBe('sale')
  })

  it('stock: a receipt moves none, printed or failed', async () => {
    const w = await tillWorld(app)
    const { receipt } = await issuedPaid(w)
    expect(await StockMovement.countDocuments({ orgId: w.oid, invoiceId: receipt._id })).toBe(0)
    const { rows } = (await w.call('GET', '/cash-register/documents?kind=payment')).json
    expect(rows[0].stock).toBe('none')
  })

  it('the audit trail names the receipt and the payment', async () => {
    const w = await tillWorld(app)
    const { id, receipt } = await issuedPaid(w)
    await new Promise(r => setTimeout(r, 50))
    expect(await AuditLog.countDocuments({ orgId: w.oid, entityId: receipt._id, action: 'create', unpNumber: receipt.register.unp })).toBe(1)
    expect(await AuditLog.countDocuments({ orgId: w.oid, entityId: (await raw(id))._id, action: 'record_payment' })).toBe(1)
  })
})

describe('a device left unusable by a failed receipt is not a sale refused forever', () => {
  it('the device row is marked, as a failed sale marks it, and the next attempt still prints', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    w.sim!.paper = false
    await send(w, d.id)
    expect((await FiscalDevice.findById(w.deviceId).lean().exec() as any).status).toBe('error')
    w.sim!.paper = true
    expect((await pay(w, d.id, 24)).status).toBe(200)
    expect(w.sim!.receipts.filter(x => !x.voided)).toHaveLength(1)
  })
})
