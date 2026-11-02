import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import ExcelJS from 'exceljs'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, reconnect, type TillWorld } from '../helpers/till-world'
import { clerkSale, clerkSession, draftOf, gate, line, pay, raw, receiptsOf, send, sessionOf, shown, TODAY, until } from '../helpers/receipt-world'
import { allowSalesWithoutPrinter, createTestAccount } from '../helpers/factories'
import { AuditLog, DocFile, FiscalDevice, Invoice, Journal, JournalEntry, Org, POSSession, Sequence, StockMovement } from 'db/models'
import { config } from 'config'
import { isImmutableRegisterDocument } from 'services/biz/cash-register/immutability'
import { deviceFromCounter, deviceFromDeadReceipt, deviceFromSettledDocument, setFiscalForwarding } from 'fiscal/fiscal-route'
import { deviceTurn } from 'fiscal/device-turn'
import { getPrinter, registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { statsController } from 'invoicing-api/src/controllers/stats.controller'
import { contactController } from 'invoicing-api/src/controllers/contact.controller'
import { invoiceExportController } from 'invoicing-api/src/controllers/invoice-export.controller'
import { agingReportController } from 'invoicing-api/src/controllers/aging-report.controller'
import { postPosSessionJournal, registerEventHandlers, resetEventHandlers } from 'services/events/handlers'
import { reportById, validateParams } from 'services/biz/report-registry'
import { buildDailyDigest } from 'services/biz/digest/daily-digest.service'
import { getContactLedger } from 'services/biz/contact-ledger.service'
import { getProductLedger } from 'services/biz/product-ledger.service'
import { getInvoiceSummary } from 'services/biz/invoice-summary.service'
import { getJournalDocument, listJournal } from 'services/biz/cash-register/journal.service'
import { loadPosRows } from 'services/biz/cash-register/pos-union'
import { buildSessionReport, formatSessionReport } from 'services/biz/cash-register/session-report'
import { paymentReceiptDocument, paymentStornoDocument } from 'services/biz/cash-register/payment-receipt.service'
import { receiptBody } from 'services/biz/cash-register/receipt-lines'
import { stornoUnproved } from 'services/biz/cash-register/counting'
import { deleteDocFiles, planDeleteDocFiles } from 'services/biz/files/doc-delete.service'
import { commitDocFile } from 'services/biz/files/doc-pipeline.service'
import { NOT_UNPROVED_STORNO } from 'services/biz/sale-counting'
import { takeBudget, giveBackBudget, leftByRate } from 'services/biz/cash-register/refund-budget'
import {
  exportCancelledSales, exportItemizedSales, exportPaymentDetails, exportReversedSales, exportSummarizedSales,
} from 'services/biz/supto-export.service'
import { deviceEvidence } from 'services/biz/home/device-witness.service'
import { bookingOf } from 'services/biz/move/fenced-import.service'
import { printableDocument } from 'invoicing-api/src/lib/invoice-pdf'
import { issuedReceiptNotice, sendIssue } from '../../../invoicing-ui/src/composables/document-issue'
import { localDayOf } from 'services/biz/local-day'

/**
 * FR-23 R2 — a refund on a credit note, in cash or by card, prints a storno of a receipt that paid its
 * invoice, on the Eltrade simulator. The credit note is the return: it takes the goods back and posts
 * the revenue. The storno is the money going back: it joins the open session of whoever gives it, prints
 * once, and records the refund on the credit note.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = tillApp().use(statsController).use(contactController).use(invoiceExportController).use(agingReportController) as any
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { forgetDevices(); await clearCollections() }, 30_000)

const stornosOf = (id: string) => Invoice.find({ type: 'payment_storno', 'register.refundOf': id }).sort({ _id: 1 }).lean().exec() as Promise<any[]>
const fresh = (id: unknown) => Invoice.findById(id).lean().exec() as Promise<any>
const settle = (w: TillWorld, id: unknown, printed: boolean, as?: string, receiptNumber?: string) =>
  w.call('POST', `/cash-register/documents/${id}/settle`, { printed, ...(receiptNumber !== undefined ? { receiptNumber } : {}) }, undefined, as)

/** The same, right AFTER that write has landed: what another request does one write later. */
function justAfter(at: (update: any) => boolean, meanwhile: () => Promise<unknown>) {
  const real = Invoice.findOneAndUpdate
  let done = false
  ;(Invoice as any).findOneAndUpdate = function (filter: any, update: any, ...rest: any[]) {
    if (done || !at(update)) return (real as any).call(Invoice, filter, update, ...rest)
    done = true
    const chain = {
      lean: () => chain,
      exec: async () => { const written = await (real as any).call(Invoice, filter, update, ...rest).lean().exec(); await meanwhile(); return written },
    }
    return chain
  }
  return () => { (Invoice as any).findOneAndUpdate = real }
}

/** Run `meanwhile` exactly once, right before the write `at` picks: an interleaving forced, not timed. */
function during(at: (update: any) => boolean, meanwhile: () => Promise<unknown>) {
  const real = Invoice.findOneAndUpdate
  let done = false
  ;(Invoice as any).findOneAndUpdate = function (filter: any, update: any, ...rest: any[]) {
    if (done || !at(update)) return (real as any).call(Invoice, filter, update, ...rest)
    done = true
    const chain = {
      lean: () => chain,
      exec: async () => { await meanwhile(); return (real as any).call(Invoice, filter, update, ...rest).lean().exec() },
    }
    return chain
  }
  return () => { (Invoice as any).findOneAndUpdate = real }
}

/** What a device executes to print: open, line, text, payment, close, and a text slip's. Asking it how it prints prints nothing. */
const PRINTING = [0x90, 0x31, 0x36, 0x35, 0x38, 0x3C, 0x26, 0x27, 0x2A]

/** Everything a refused request must leave as it was: no number, no УНП, no stock, nothing printed. */
async function footprint(w: TillWorld) {
  return {
    documents: await Invoice.countDocuments({ orgId: w.oid }),
    counters: (await Sequence.find({ orgId: w.oid }).lean().exec() as any[]).map(s => `${s.prefix}:${s.year}:${s.lastNumber}`).sort(),
    movements: await StockMovement.countDocuments({ orgId: w.oid }),
    device: w.sim ? w.sim.executed.filter(c => PRINTING.includes(c.cmd)).length : 0,
  }
}

/** A line's name as it printed: the driver folds a long one at its spaces. */
const nameOf = (s: { text: string }) => s.text.replace(/\s+/g, ' ')

/** A cash invoice of 24.00, issued and paid at the counter: its receipt printed whole. */
async function paidInvoice(w: TillWorld, o: Parameters<typeof draftOf>[1] = {}) {
  const d = await draftOf(w, o)
  const r = await send(w, d.id)
  expect(r.status).toBe(200)
  expect(r.json.receiptError).toBeUndefined()
  return { ...d, invoice: await raw(d.id), receipt: (await receiptsOf(d.id))[0] }
}

/** A credit note of that invoice as the form saves it. */
function noteOn(w: TillWorld, inv: { id: string; contactId: string }, o: { method?: string; quantity?: number; lines?: any[] } = {}) {
  return draftOf(w, {
    type: 'credit_note',
    method: o.method ?? 'cash',
    lines: o.lines ?? [line(w, o.quantity ?? 2)],
    extra: { relatedInvoiceId: inv.id, contactId: inv.contactId },
  })
}

/** An issued credit note that gives nothing back yet: bank at issue, cash when the refund is recorded. */
async function issuedNote(w: TillWorld, inv: { id: string; contactId: string }, o: { quantity?: number; lines?: any[] } = {}) {
  const note = await noteOn(w, inv, { ...o, method: 'bank_transfer' })
  const r = await send(w, note.id)
  expect(r.status).toBe(200)
  return { ...note, doc: await raw(note.id) }
}

/** An invoice paid by a receipt per amount, oldest first: part payments at the counter. */
async function paidInParts(w: TillWorld, amounts: number[], o: Parameters<typeof draftOf>[1] = {}) {
  const d = await draftOf(w, { method: 'bank_transfer', ...o })
  expect((await send(w, d.id)).status).toBe(200)
  for (const amount of amounts) expect((await pay(w, d.id, amount)).status).toBe(200)
  return { ...d, receipts: await receiptsOf(d.id) }
}

/** The ledger an org keeps: a cash and a bank journal, a receivable, a payable, a revenue account. */
async function books(w: TillWorld) {
  const cash = await createTestAccount(w.oid, { name: 'Cash', type: 'asset' })
  const bank = await createTestAccount(w.oid, { name: 'Bank', type: 'asset' })
  const receivable = await createTestAccount(w.oid, { name: 'Receivable', type: 'asset' })
  const payable = await createTestAccount(w.oid, { name: 'Payable', type: 'liability' })
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
      'settings.accounting.defaultPayableAccountId': payable._id,
      'settings.accounting.defaultRevenueAccountId': revenue._id,
      'settings.accounting.autoPostInvoiceEntries': true,
      'settings.accounting.autoPostPaymentEntries': true,
    },
  })
  return { cash, bank, receivable, payable, revenue }
}

/** Wait until a payment row's entry is stamped on it: the end of what `payment.recorded` does. */
async function entryOf(id: string, row = 0): Promise<any> {
  for (let i = 0; i < 400; i++) {
    const p = (await raw(id)).payments?.[row]
    if (p?.journalEntryId) return JournalEntry.findById(p.journalEntryId).lean().exec()
    await new Promise(r => setTimeout(r, 10))
  }
  throw new Error('no journal entry was stamped on the row')
}

/** Debit and credit per account of an entry. */
const moves = (je: any) => je.lines.map((l: any) => [String(l.accountId), l.debit, l.credit])

describe('§2.5 the risk: no credit note has ever been refunded through /payments', () => {
  beforeEach(() => { resetEventHandlers(); registerEventHandlers() })
  afterEach(() => { resetEventHandlers() })

  it('a bank refund is money OUT: Dr receivable, Cr bank; and its status, paid and due follow, stored positive', async () => {
    const w = await tillWorld(app)
    const a = await books(w)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    expect(note.doc).toMatchObject({ status: 'sent', amountPaid: 0, total: 24 })

    expect((await pay(w, note.id, 10, 'bank_transfer')).status).toBe(200)

    expect(await raw(note.id)).toMatchObject({ status: 'partially_paid', amountPaid: 10, amountDue: 14, total: 24 })
    const entry = await entryOf(note.id)
    expect(moves(entry)).toEqual([[String(a.receivable._id), 10, 0], [String(a.bank._id), 0, 10]])
    expect(entry.description).toContain('Payment sent')

    expect((await pay(w, note.id, 14, 'bank_transfer')).status).toBe(200)
    const done = await raw(note.id)
    expect(done).toMatchObject({ status: 'paid', amountPaid: 24, amountDue: 0, total: 24 })
    expect(done.paidAt).toBeTruthy()
    expect(moves(await entryOf(note.id, 1))).toEqual([[String(a.receivable._id), 14, 0], [String(a.bank._id), 0, 14]])
    // A bank refund prints nothing, and asks no receipt to cite.
    expect(await stornosOf(note.id)).toHaveLength(0)
  })

  it('a cash refund the same: Dr receivable, Cr cash, stamped on its row, once', async () => {
    const w = await tillWorld(app)
    const a = await books(w)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)

    expect((await pay(w, note.id, 24)).status).toBe(200)

    const entry = await entryOf(note.id)
    expect(moves(entry)).toEqual([[String(a.receivable._id), 24, 0], [String(a.cash._id), 0, 24]])
    const [row] = (await raw(note.id)).payments
    expect(row).toMatchObject({ method: 'cash', amount: 24, origin: 'payment_storno' })
    expect(await JournalEntry.countDocuments({ orgId: w.oid, description: { $regex: `^Payment sent: ${note.doc.invoiceNumber}` } })).toBe(1)
  })

  it('a supplier\'s credit note is the other way round: money IN, Dr bank, Cr payable', async () => {
    const w = await tillWorld(app)
    const a = await books(w)
    const bill = await draftOf(w, { method: 'bank_transfer', extra: { direction: 'incoming' } })
    expect((await w.call('POST', `/invoices/${bill.id}/receive`, {})).status).toBe(200)
    const note = await draftOf(w, {
      type: 'credit_note', method: 'bank_transfer',
      extra: { direction: 'incoming', relatedInvoiceId: bill.id, contactId: bill.contactId },
    })
    expect((await w.call('POST', `/invoices/${note.id}/receive`, {})).status).toBe(200)

    expect((await pay(w, note.id, 24, 'bank_transfer')).status).toBe(200)

    expect(moves(await entryOf(note.id))).toEqual([[String(a.bank._id), 24, 0], [String(a.payable._id), 0, 24]])
  })

  it('a sale\'s payment and a bill\'s go as they always did', async () => {
    const w = await tillWorld(app)
    const a = await books(w)
    const sale = await draftOf(w, { method: 'bank_transfer' })
    await send(w, sale.id)
    expect((await pay(w, sale.id, 24, 'bank_transfer')).status).toBe(200)
    expect(moves(await entryOf(sale.id))).toEqual([[String(a.bank._id), 24, 0], [String(a.receivable._id), 0, 24]])

    const bill = await draftOf(w, { method: 'bank_transfer', extra: { direction: 'incoming' } })
    expect((await w.call('POST', `/invoices/${bill.id}/receive`, {})).status).toBe(200)
    expect((await pay(w, bill.id, 24, 'bank_transfer')).status).toBe(200)
    expect(moves(await entryOf(bill.id))).toEqual([[String(a.payable._id), 24, 0], [String(a.bank._id), 0, 24]])
  })

  it('the session\'s close posts none of it: the credit note\'s payment did', async () => {
    const w = await tillWorld(app)
    await books(w)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    expect((await pay(w, note.id, 24)).status).toBe(200)
    await entryOf(note.id)

    const rows = await loadPosRows({ orgId: w.orgId, sessionId: w.sessionId })
    expect(rows.some((t: any) => t.type === 'payment_storno')).toBe(false)
    const before = await JournalEntry.countDocuments({ orgId: w.oid })
    await POSSession.updateOne({ _id: w.sessionId }, { $set: { status: 'closed' } })
    await postPosSessionJournal({ orgId: w.orgId, sessionId: w.sessionId, userId: String(w.user._id) })
    // Nothing of a till's own sold in it, so nothing to post.
    expect(await JournalEntry.countDocuments({ orgId: w.oid })).toBe(before)
  })
})

describe('at issue: a credit note in cash or by card gives its money back as it is issued', () => {
  it('in cash: it is issued, its goods come back once, and a storno prints citing the receipt that paid its invoice', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const stock = await w.stock()
    const printed = w.sim!.receipts.length
    const note = await noteOn(w, inv)

    const r = await send(w, note.id)

    expect(r.status).toBe(200)
    expect(r.json.receiptError).toBeUndefined()
    const issued = await raw(note.id)
    expect(issued).toMatchObject({ status: 'paid', amountPaid: 24, amountDue: 0 })
    expect(issued.invoiceNumber).toMatch(/^INV-/)
    expect(r.json.invoice.status).toBe('paid')

    // The document: what §2.1 says it is.
    const [storno] = await stornosOf(note.id)
    expect(storno).toMatchObject({ type: 'payment_storno', direction: 'outgoing', status: 'paid', total: 24, paymentMethod: 'cash', currency: 'EUR' })
    expect(storno.invoiceNumber).toMatch(/^CS-/)
    expect(String(storno.register.refundOf)).toBe(note.id)
    expect(storno.register.refundOfNumber).toBe(issued.invoiceNumber)
    expect(String(storno.register.storno.originalId)).toBe(String(inv.receipt._id))
    expect(storno.register.storno).toMatchObject({
      originalUnp: inv.receipt.register.unp,
      originalReceiptNumber: inv.receipt.register.fiscalReceiptNumber,
      reason: 'customer_return',
    })
    expect(storno.register.fiscal.state).toBe('printed')
    expect(storno.register.unp).toMatch(/^ED123456-0001-/)
    expect(storno.register.unp).not.toBe(inv.receipt.register.unp)
    expect(r.json.receipt).toMatchObject({ id: String(storno._id), number: storno.invoiceNumber, state: 'printed' })
    expect(r.json.stornos).toHaveLength(1)

    // The device saw a storno, and it cites the original: its УНП, its FM, its number.
    expect(w.sim!.receipts).toHaveLength(printed + 1)
    const receipt = w.sim!.receipts.at(-1)!
    expect(receipt.kind).toBe('storno')
    const header = receipt.header
    expect(header[1]).toBe(inv.receipt.register.unp)
    expect(header[2]).toBe('S')
    expect(header[3]).toBe(w.sim!.fiscalMemory)
    expect(header[4]).toBe('R')
    expect(header[5]).toBe(inv.receipt.register.fiscalReceiptNumber)
    expect(receipt.sales.map(s => [nameOf(s), s.price, s.quantity])).toEqual([[`Връщане по кредитно известие № ${issued.invoiceNumber}`, 24, 1]])
    expect(receipt.payments).toEqual([{ mode: 'P', amount: 24 }])
    expect(receipt.voided).toBeFalsy()

    // The payment row, linked to its storno, and no hold left.
    expect(issued.payments).toHaveLength(1)
    expect(issued.payments[0]).toMatchObject({ method: 'cash', amount: 24, origin: 'payment_storno' })
    expect(String(issued.payments[0].receiptId)).toBe(String(storno._id))
    expect(issued.receiptHolds ?? []).toHaveLength(0)

    // Stock: the credit note took the goods back, once; the storno moved nothing.
    expect((await w.stock()).quantity).toBe(stock.quantity + 2)
    expect(await StockMovement.countDocuments({ orgId: w.oid, invoiceId: note.id })).toBe(1)
    expect(await StockMovement.countDocuments({ orgId: w.oid, invoiceId: storno._id })).toBe(0)

    // The drawer gave it back, and the receipt's budget has it.
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalSales: 24, totalReturns: 24, transactionCount: 2 })
    expect(leftByRate(await fresh(inv.receipt._id)).size).toBe(0)
  })

  it('by card: a storno paid by card, out of the card bucket', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w, { method: 'card' })
    const note = await noteOn(w, inv, { method: 'card' })

    expect((await send(w, note.id)).status).toBe(200)

    expect(w.sim!.receipts.at(-1)!.payments).toEqual([{ mode: 'L', amount: 24 }])
    expect(await sessionOf(w)).toMatchObject({ totalCard: 0, totalCash: 0, totalReturns: 24 })
    expect((await raw(note.id)).payments[0]).toMatchObject({ method: 'card', origin: 'payment_storno' })
  })

  it('a refund by card on a receipt paid in cash has the same budget, and the same refusals', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv, { method: 'card' })
    expect((await send(w, note.id)).status).toBe(200)
    const beyond = await noteOn(w, inv, { method: 'card', quantity: 1 })
    const r = await send(w, beyond.id)
    expect(r.status).toBe(422)
    expect(r.json).toMatchObject({ code: 'refund_exceeds_paid', left: 0 })
  })

  it('a credit note with no product on it lowers what was charged: the device\'s other reason', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const free = { description: 'Отстъпка', quantity: 1, unit: 'бр.', unitPrice: 5, taxRate: 20, taxAmount: 1, lineTotal: 6 }
    const note = await noteOn(w, inv, { lines: [free] })
    expect((await send(w, note.id)).status).toBe(200)
    expect((await stornosOf(note.id))[0].register.storno.reason).toBe('tax_base_reduction')
    expect(w.sim!.receipts.at(-1)!.header[4]).toBe('T')
  })

  describe('refused before anything is written: no number, no stock, the draft a draft', () => {
    async function refusedAtIssue(w: TillWorld, note: { id: string }) {
      const before = await footprint(w)
      const r = await send(w, note.id)
      expect(await footprint(w)).toEqual(before)
      const after = await raw(note.id)
      expect(after.status).toBe('draft')
      expect(after.issue).toBeUndefined()
      return r
    }

    it('no receipt to storno: an invoice paid by bank', async () => {
      const w = await tillWorld(app)
      const inv = await draftOf(w, { method: 'bank_transfer' })
      await send(w, inv.id)
      await pay(w, inv.id, 24, 'bank_transfer')
      const r = await refusedAtIssue(w, await noteOn(w, inv))
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('no_receipt_to_storno')
      expect(r.json.message).toContain('by bank')
    })

    it('no receipt to storno, by card too', async () => {
      const w = await tillWorld(app)
      const inv = await draftOf(w, { method: 'bank_transfer' })
      await send(w, inv.id)
      const r = await refusedAtIssue(w, await noteOn(w, inv, { method: 'card' }))
      expect(r.json.code).toBe('no_receipt_to_storno')
    })

    it('more than the invoice\'s receipts still hold: 422, and how much they do', async () => {
      const w = await tillWorld(app)
      const inv = await paidInParts(w, [12])
      expect((await pay(w, inv.id, 12, 'bank_transfer')).status).toBe(200)
      const r = await refusedAtIssue(w, await noteOn(w, inv))
      expect(r.status).toBe(422)
      expect(r.json).toMatchObject({ code: 'refund_exceeds_receipts', left: 12 })
    })

    it('no open session: whoever gives money back at the counter has a drawer', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      await POSSession.updateOne({ _id: w.sessionId }, { $set: { status: 'closed' } })
      const r = await refusedAtIssue(w, await noteOn(w, inv))
      expect(r.status).toBe(409)
      expect(r.json).toMatchObject({ code: 'fiscal_device_not_connected', noSession: true })
    })

    it('the device not connected', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      unregisterPrinter(w.deviceId)
      const r = await refusedAtIssue(w, await noteOn(w, inv))
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('fiscal_device_not_connected')
    })

    it('another currency than the session\'s device prints in', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await noteOn(w, inv)
      await Invoice.updateOne({ _id: note.id }, { $set: { currency: 'USD' } })
      const r = await refusedAtIssue(w, note)
      expect(r.status).toBe(422)
      expect(r.json.code).toBe('receipt_currency')
    })

    it('no operator code: a fiscal storno names its operator', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await noteOn(w, inv)
      const token = await signedWithNoCode(w)
      const r = await send(w, note.id, undefined, token)
      expect(r.status).toBe(400)
      expect((await raw(note.id)).status).toBe('draft')
    })

    it('a device not reached in two hours, in SUPTO production mode', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await noteOn(w, inv)
      const mode = config.supto.mode
      config.supto.mode = 'production'
      try {
        await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { lastCommunicationAt: new Date(Date.now() - 3 * 3_600_000) } })
        w.sim!.silent = true
        const r = await refusedAtIssue(w, note)
        expect(r.status).toBe(409)
        expect(r.json.code).toBe('fiscal_device_unreached')
      } finally {
        config.supto.mode = mode
      }
    })

    it('a rate with a negative total cannot be split', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const lines = [line(w, 2), { description: 'Отстъпка', quantity: 1, unit: 'бр.', unitPrice: -30, taxRate: 9, taxAmount: -2.7, lineTotal: -32.7 }]
      const note = await draftOf(w, { type: 'credit_note', method: 'cash', lines, extra: { relatedInvoiceId: inv.id, contactId: inv.contactId, total: 24 } })
      const r = await refusedAtIssue(w, note)
      expect(r.status).toBe(422)
      expect(r.json.code).toBe('receipt_not_printable')
    })

    it('H4: a storno door, and whoever cannot storno a sale cannot use it', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await noteOn(w, inv)
      const before = await footprint(w)
      const r = await send(w, note.id, undefined, await w.tokenAs('accountant'))
      expect(r.status).toBe(403)
      expect(r.json.code).toBe('refund_requires_manager')
      expect(await footprint(w)).toEqual(before)
      // A manager may.
      expect((await send(w, note.id, undefined, await w.tokenAs('manager'))).status).toBe(200)
      expect((await raw(note.id)).status).toBe('paid')
    })

    it('H4 asks only of what prints: a bank refund is anyone\'s who may issue', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await noteOn(w, inv, { method: 'bank_transfer' })
      expect((await send(w, note.id, undefined, await w.tokenAs('accountant'))).status).toBe(200)
    })
  })

  describe('a print that fails', () => {
    it('leaves it issued and unpaid, its goods back, the money with no one: the storno voided with its number, the budget whole', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const stock = await w.stock()
      const note = await noteOn(w, inv)
      w.sim!.paper = false

      const r = await send(w, note.id)

      w.sim!.paper = true
      expect(r.status).toBe(200)
      expect(r.json.receiptError).toBeTruthy()
      expect(r.json.receipt.state).toBe('failed')
      expect(await raw(note.id)).toMatchObject({ status: 'sent', amountPaid: 0, amountDue: 24 })
      expect((await raw(note.id)).invoiceNumber).toMatch(/^INV-/)
      expect((await w.stock()).quantity).toBe(stock.quantity + 2)
      const [dead] = await stornosOf(note.id)
      expect(dead).toMatchObject({ status: 'voided' })
      expect(dead.invoiceNumber).toMatch(/^CS-/)
      expect(dead.register.fiscal.state).toBe('failed')
      expect((await raw(note.id)).receiptHolds ?? []).toHaveLength(0)
      expect(await sessionOf(w)).toMatchObject({ totalCash: 24, totalReturns: 0 })
      expect(leftByRate(await fresh(inv.receipt._id)).get(20)).toBe(2400)

      // The next attempt is a new storno, and it prints.
      const again = await pay(w, note.id, 24)
      expect(again.status).toBe(200)
      expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
      expect(await stornosOf(note.id)).toHaveLength(2)
      expect(leftByRate(await fresh(inv.receipt._id)).size).toBe(0)
    })

    it('a device that fails between the lines leaves nothing open, and stays usable', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await noteOn(w, inv)
      w.sim!.beforeCommand = (cmd: number) => { if (cmd === 0x31) throw new Error('line down') }
      await send(w, note.id)
      w.sim!.beforeCommand = null
      expect(w.sim!.receipt).toBeNull()
      expect((await pay(w, note.id, 24)).status).toBe(200)
    })
  })

  it('a note that moved after its issue was decided: nothing rings and it says so, never one amount and books another', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv)
    const real = Invoice.findOneAndUpdate
    ;(Invoice as any).findOneAndUpdate = function (filter: any, update: any, ...rest: any[]) {
      const query = (real as any).call(Invoice, filter, update, ...rest)
      if (!update?.$set?.issue?.leaseUntil) return query
      return {
        exec: async () => {
          const claimed = await query.exec()
          await Invoice.updateOne({ _id: note.id }, { $set: { total: 12, subtotal: 10, taxTotal: 2, lines: [line(w, 1)] } })
          return claimed
        },
      }
    }
    let r: any
    try {
      r = await send(w, note.id)
    } finally {
      ;(Invoice as any).findOneAndUpdate = real
    }
    expect(r.status).toBe(200)
    expect(r.json.receiptCode).toBe('issue_tender_moved')
    expect(r.json.receiptError).toContain('changed')
    expect(w.sim!.receipts.filter(x => x.kind === 'storno')).toHaveLength(0)
    expect(await raw(note.id)).toMatchObject({ total: 12, amountPaid: 0, status: 'sent' })

    // The way on: Refund, for what it says now.
    expect((await pay(w, note.id, 12)).status).toBe(200)
    expect(w.sim!.receipts.at(-1)).toMatchObject({ kind: 'storno', total: 12 })
    expect(w.sim!.receipts.at(-1)!.payments).toEqual([{ mode: 'P', amount: 12 }])
    expect(await raw(note.id)).toMatchObject({ total: 12, amountPaid: 12, amountDue: 0, status: 'paid' })
  })

  describe('a retry', () => {
    it('with the same key prints once and answers the same', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await noteOn(w, inv)
      const first = await send(w, note.id, 'refund-issue')
      const printed = w.sim!.receipts.length

      const second = await send(w, note.id, 'refund-issue')

      expect(second.status).toBe(200)
      expect(second.json.receipt.number).toBe(first.json.receipt.number)
      expect(w.sim!.receipts).toHaveLength(printed)
      expect(await stornosOf(note.id)).toHaveLength(1)
      expect(await raw(note.id)).toMatchObject({ amountPaid: 24, status: 'paid' })
    })

    it('two clicks at once: one issue, one storno', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await noteOn(w, inv)
      const printed = w.sim!.receipts.length

      const [a, b] = await Promise.all([send(w, note.id, 'refund-both'), send(w, note.id, 'refund-both')])

      expect([a.status, b.status].filter(s => s === 200).length).toBeGreaterThan(0)
      await until(async () => !!(await raw(note.id)).payments?.length, 'the refund')
      expect(w.sim!.receipts).toHaveLength(printed + 1)
      expect(await stornosOf(note.id)).toHaveLength(1)
      expect(await StockMovement.countDocuments({ orgId: w.oid, invoiceId: note.id })).toBe(1)
    })

    it('finishes a storno its first attempt never started: issued, with nothing printed', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await noteOn(w, inv)
      expect((await send(w, note.id, 'refund-died')).status).toBe(200)
      // As if the process had died after the issue and before the storno.
      for (const s of await stornosOf(note.id)) await Invoice.deleteOne({ _id: s._id })
      w.sim!.receipts.pop()
      await giveBackBudget(inv.receipt._id, w.oid, (await fresh(inv.receipt._id)).register.refundClaims[0].stornoId)
      await Invoice.updateOne({ _id: note.id }, { $set: { payments: [], amountPaid: 0, amountDue: 24, status: 'sent' } })

      const r = await send(w, note.id, 'refund-died')

      expect(r.status).toBe(200)
      expect(await stornosOf(note.id)).toHaveLength(1)
      expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    })
  })
})

describe('a credit note\'s issue holds its claim until its storno does (the third read, finding 2)', () => {
  /** A `PUT` as the form sends one: every line and every total, at `quantity`. */
  const editTo = (w: TillWorld, id: string, quantity: number, extra: Record<string, unknown> = {}) => {
    const l = line(w, quantity)
    return w.call('PUT', `/invoices/${id}`, {
      lines: [l], subtotal: +(l.lineTotal - l.taxAmount).toFixed(2), taxTotal: l.taxAmount, total: l.lineTotal, ...extra,
    })
  }
  const issueWrite = (update: any) => !!update?.$set?.['issue.completedAt']
  const lapse = (id: string) => Invoice.updateOne({ _id: id }, { $set: { 'issue.leaseUntil': new Date(Date.now() - 1000) } })
  const stornosOnDevice = (w: TillWorld) => w.sim!.receipts.filter(r => !r.voided && r.kind === 'storno')
  /** Device, stornos and books say one thing: what the device gave back is what the stornos and the note gave. */
  async function allAgree(w: TillWorld, inv: { receipt: any }, id: string, given: number) {
    expect(stornosOnDevice(w).reduce((s, r) => s + r.total, 0)).toBe(given)
    const stornos = (await stornosOf(id)).filter(s => s.status === 'paid')
    expect(stornos.reduce((s, r) => s + r.total, 0)).toBe(given)
    for (const s of stornos) expect(s.lines.reduce((sum: number, l: any) => sum + l.lineTotal, 0)).toBe(s.total)
    const note = await raw(id)
    expect(note.amountPaid).toBe(given)
    expect((note.payments ?? []).reduce((s: number, p: any) => s + p.amount, 0)).toBe(given)
    // What is due is derived as money moves: an edit of a credit note with none yet leaves it for the first.
    if (given) expect(note.amountDue).toBe(+(note.total - given).toFixed(2))
    expect((await sessionOf(w)).totalCash).toBe(24 - given)
    expect(leftByRate(await fresh(inv.receipt._id)).get(20) ?? 0).toBe(2400 - Math.round(given * 100))
  }
  /** `/send`, and `meanwhile` right after the issue's write. */
  async function sendWith(w: TillWorld, id: string, meanwhile: () => Promise<unknown>, key?: string) {
    const undo = justAfter(issueWrite, meanwhile)
    try {
      return await send(w, id, key)
    } finally {
      undo()
    }
  }

  it('it records what it decided, and keeps its claim for the print', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv)
    let during: any
    const r = await sendWith(w, note.id, async () => { during = (await raw(note.id)).issue })

    expect(r.status).toBe(200)
    expect(during.tender).toMatchObject({ method: 'cash', amount: 24 })
    expect(new Date(during.leaseUntil).getTime()).toBeGreaterThan(Date.now())
    expect((await raw(note.id)).issue.leaseUntil ?? null).toBeNull()
  })

  it('quantity 2 to 1 right after the issue\'s write: refused while it holds, and what was rung is what is booked', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv)
    let edit: any
    const r = await sendWith(w, note.id, async () => { edit = await editTo(w, note.id, 1) })

    expect(edit.status).toBe(409)
    expect(edit.json.code).toBe('issue_in_progress')
    expect(r.status).toBe(200)
    expect(r.json.receipt.state).toBe('printed')
    expect(await raw(note.id)).toMatchObject({ status: 'paid', total: 24, amountPaid: 24, amountDue: 0 })
    await allAgree(w, inv, note.id, 24)
  })

  it('the quantity up: the same', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv, { quantity: 1 })
    let edit: any
    const r = await sendWith(w, note.id, async () => { edit = await editTo(w, note.id, 2) })

    expect(edit.status).toBe(409)
    expect(edit.json.code).toBe('issue_in_progress')
    expect(r.json.receipt.state).toBe('printed')
    await allAgree(w, inv, note.id, 12)
  })

  it('bank to cash right after the issue\'s write: no row, no money and nothing on the device, and Refund gives it', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv, { method: 'bank_transfer' })
    let edit: any
    const r = await sendWith(w, note.id, async () => { edit = await w.call('PUT', `/invoices/${note.id}`, { paymentMethod: 'cash' }) })

    expect(edit.status).toBe(200)
    expect(r.status).toBe(200)
    const doc = await raw(note.id)
    expect(doc).toMatchObject({ status: 'sent', paymentMethod: 'cash', amountPaid: 0, amountDue: 24 })
    expect(doc.payments).toHaveLength(0)
    expect((await raw(note.id)).issue.leaseUntil ?? null).toBeNull()
    await allAgree(w, inv, note.id, 0)

    expect((await pay(w, note.id, 24)).status).toBe(200)
    await allAgree(w, inv, note.id, 24)
  })

  it('cash to bank right after the issue\'s write: it says so, nothing prints, and it stands issued with nothing given back', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv)
    let edit: any
    const r = await sendWith(w, note.id, async () => { edit = await w.call('PUT', `/invoices/${note.id}`, { paymentMethod: 'bank_transfer' }) })

    expect(edit.status).toBe(200)
    expect(r.status).toBe(200)
    expect(r.json.receiptError).toContain('changed')
    expect(r.json.receiptError).toContain('Refund')
    expect(r.json.receiptCode).toBe('issue_tender_moved')
    expect(await raw(note.id)).toMatchObject({ status: 'sent', paymentMethod: 'bank_transfer', amountPaid: 0, amountDue: 24 })
    expect(await stornosOf(note.id)).toHaveLength(0)
    await allAgree(w, inv, note.id, 0)
    expect((await raw(note.id)).issue.leaseUntil ?? null).toBeNull()
  })

  it('a lease lapsed in that gap holds no claim: an edit gets in, and the last check prints nothing', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv)
    let edit: any
    const r = await sendWith(w, note.id, async () => {
      await lapse(note.id)
      edit = await editTo(w, note.id, 1)
    })

    expect(edit.status).toBe(200)
    expect(r.status).toBe(200)
    expect(r.json.receiptError).toContain('changed')
    expect(await raw(note.id)).toMatchObject({ status: 'sent', total: 12, amountPaid: 0 })
    expect(await stornosOf(note.id)).toHaveLength(0)
    await allAgree(w, inv, note.id, 0)

    // The way on: Refund, for what it says now.
    expect((await pay(w, note.id, 12)).status).toBe(200)
    await allAgree(w, inv, note.id, 12)
  })

  it('all of it given back by bank in that gap: nothing prints, and nothing is left to say or to give', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv)
    const r = await sendWith(w, note.id, () => pay(w, note.id, 24, 'bank_transfer'))

    expect(r.status).toBe(200)
    expect(r.json.receiptError).toBeUndefined()
    expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect(await stornosOf(note.id)).toHaveLength(0)
    expect(stornosOnDevice(w)).toHaveLength(0)
  })

  it('part of it given back by bank in that gap: nothing prints, and it says what is left', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv)
    const r = await sendWith(w, note.id, () => pay(w, note.id, 10, 'bank_transfer'))

    expect(r.status).toBe(200)
    expect(r.json.receiptError).toContain('changed')
    expect(await raw(note.id)).toMatchObject({ status: 'partially_paid', amountPaid: 10, amountDue: 14 })
    expect(stornosOnDevice(w)).toHaveLength(0)
  })

  it('the claim stands while the storno prints, and goes when it is done, whichever way that ended', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv, { quantity: 1 })
    const held = gate()
    w.sim!.beforeCommand = cmd => (cmd === 0x38 ? held.closed : undefined)
    const issuing = send(w, note.id)
    await until(() => w.sim!.receipt?.payments.length === 1, 'the storno to give its money')

    expect((await raw(note.id)).issue.leaseUntil).toBeTruthy()

    w.sim!.beforeCommand = null
    held.open()
    expect((await issuing).status).toBe(200)
    expect((await raw(note.id)).issue.leaseUntil ?? null).toBeNull()

    // A storno that failed lets go of it too.
    const failing = await noteOn(w, inv, { quantity: 1 })
    w.sim!.paper = false
    expect((await send(w, failing.id)).json.receiptError).toBeTruthy()
    w.sim!.paper = true
    expect((await raw(failing.id)).issue.leaseUntil ?? null).toBeNull()
  })

  it('a refusal in that gap lets go of it as well: the receipt spent on another note, and said so', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const other = await issuedNote(w, inv)
    const note = await noteOn(w, inv)
    const r = await sendWith(w, note.id, () => pay(w, other.id, 24))

    expect(r.status).toBe(200)
    expect(r.json.receiptError).toContain('more than')
    expect(await raw(note.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect((await raw(note.id)).issue.leaseUntil ?? null).toBeNull()
  })

  it('what prints nothing keeps no lease: a credit note by bank', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv, { method: 'bank_transfer' })
    expect((await send(w, note.id)).status).toBe(200)
    expect((await raw(note.id)).issue.leaseUntil ?? null).toBeNull()
    expect((await raw(note.id)).issue.tender).toBeUndefined()
    expect((await editTo(w, note.id, 1)).status).toBe(200)
  })

  describe('a crash right after the issue\'s write', () => {
    /** It wrote, and the process went away: the claim stays, for its lease. */
    async function crashedAfterTheWrite(w: TillWorld, id: string, key: string) {
      const r = await sendWith(w, id, () => { throw new Error('the pod went away') }, key)
      expect(r.status).toBe(500)
      expect((await raw(id)).status).toBe('sent')
    }

    it('its lease holds an edit off, and lapses', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await noteOn(w, inv)
      await crashedAfterTheWrite(w, note.id, 'refund-crash-0001')

      expect((await editTo(w, note.id, 1)).json.code).toBe('issue_in_progress')
      await lapse(note.id)
      expect((await editTo(w, note.id, 1)).status).toBe(200)
    })

    it('its retry, nothing changed: prints the one storno, and lets go', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await noteOn(w, inv)
      await crashedAfterTheWrite(w, note.id, 'refund-crash-0002')

      const r = await send(w, note.id, 'refund-crash-0002')

      expect(r.status).toBe(200)
      expect(r.json.receipt.state).toBe('printed')
      await allAgree(w, inv, note.id, 24)
      expect((await raw(note.id)).issue.leaseUntil ?? null).toBeNull()
    })

    it('its retry after the lease lapsed, on a note edited since: nothing prints, and Refund gives what it says now', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await noteOn(w, inv)
      await crashedAfterTheWrite(w, note.id, 'refund-crash-0003')
      await lapse(note.id)
      expect((await editTo(w, note.id, 1)).status).toBe(200)

      const r = await send(w, note.id, 'refund-crash-0003')

      expect(r.status).toBe(200)
      expect(r.json.receiptError).toContain('changed')
      expect(r.json.receiptCode).toBe('issue_tender_moved')
      expect(await raw(note.id)).toMatchObject({ status: 'sent', total: 12, amountPaid: 0 })
      expect(await stornosOf(note.id)).toHaveLength(0)
      await allAgree(w, inv, note.id, 0)

      expect((await pay(w, note.id, 12)).status).toBe(200)
      await allAgree(w, inv, note.id, 12)
    })

    it('its retry on a note moved to a method that prints nothing: told too, and nothing printed', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await noteOn(w, inv)
      await crashedAfterTheWrite(w, note.id, 'refund-crash-0004')
      await lapse(note.id)
      expect((await w.call('PUT', `/invoices/${note.id}`, { paymentMethod: 'bank_transfer' })).status).toBe(200)

      const r = await send(w, note.id, 'refund-crash-0004')

      expect(r.status).toBe(200)
      expect(r.json.receiptError).toContain('changed')
      await allAgree(w, inv, note.id, 0)
    })

    it('its retry on a note refunded by hand since: nothing printed, and nothing to say', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await noteOn(w, inv)
      await crashedAfterTheWrite(w, note.id, 'refund-crash-0005')
      expect((await pay(w, note.id, 24, 'bank_transfer')).status).toBe(200)

      const r = await send(w, note.id, 'refund-crash-0005')

      expect(r.status).toBe(200)
      expect(r.json.receiptError).toBeUndefined()
      expect(stornosOnDevice(w)).toHaveLength(0)
    })
  })

  describe('a refund of several stornos, for what the issue decided', () => {
    /** Its first storno done, on an invoice paid by two receipts of 14 and 10: 10 went back, 14 did not. */
    const firstPartDone = (update: any) => !!update?.$set?.completedAt
    const issuedInParts = async (w: TillWorld) => {
      const inv = await paidInParts(w, [14, 10])
      const note = await noteOn(w, inv)
      return { inv, note }
    }
    const given = (w: TillWorld) => stornosOnDevice(w).map(r => r.total)

    it('nothing moved: both print, and it says nothing', async () => {
      const w = await tillWorld(app)
      const { note } = await issuedInParts(w)

      const r = await send(w, note.id)

      expect(r.status).toBe(200)
      expect(r.json.receiptError).toBeUndefined()
      expect(given(w)).toEqual([10, 14])
      expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    })

    it('its method moved between them: what printed stands, the rest does not print, and it says so', async () => {
      const w = await tillWorld(app)
      const { note } = await issuedInParts(w)
      let edit: any
      const undo = justAfter(firstPartDone, async () => { edit = await w.call('PUT', `/invoices/${note.id}`, { paymentMethod: 'card' }) })
      let r: any
      try {
        r = await send(w, note.id)
      } finally {
        undo()
      }

      expect(edit.status).toBe(200)
      expect(r.status).toBe(200)
      expect(given(w)).toEqual([10])
      expect(r.json.stornos).toHaveLength(1)
      expect(r.json.receiptCode).toBe('issue_tender_moved')
      expect(r.json.receiptError).toContain('what did not print did not go back')
      expect(await raw(note.id)).toMatchObject({ status: 'partially_paid', amountPaid: 10, amountDue: 14, paymentMethod: 'card' })

      // The way on: Refund, for the rest, by what it says now.
      expect((await pay(w, note.id, 14, 'card')).status).toBe(200)
      expect(given(w)).toEqual([10, 14])
    })

    it('money taken by hand between them: the same', async () => {
      const w = await tillWorld(app)
      const { note } = await issuedInParts(w)
      const undo = justAfter(firstPartDone, () => pay(w, note.id, 5, 'bank_transfer'))
      let r: any
      try {
        r = await send(w, note.id)
      } finally {
        undo()
      }

      expect(r.status).toBe(200)
      expect(given(w)).toEqual([10])
      expect(r.json.receiptCode).toBe('issue_tender_moved')
      expect(await raw(note.id)).toMatchObject({ amountPaid: 15, amountDue: 9 })
    })

    it('a process that died between them, its retry with nothing moved: it goes on from what printed', async () => {
      const w = await tillWorld(app)
      const { note } = await issuedInParts(w)
      const undo = justAfter(firstPartDone, () => { throw new Error('the pod went away') })
      try {
        expect((await send(w, note.id, 'refund-parts-1')).status).toBe(500)
      } finally {
        undo()
      }
      expect(given(w)).toEqual([10])

      const r = await send(w, note.id, 'refund-parts-1')

      expect(r.status).toBe(200)
      expect(r.json.receiptError).toBeUndefined()
      expect(given(w)).toEqual([10, 14])
      expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
      expect((await stornosOf(note.id)).map(s => s.clientKey)).toEqual(['refund-parts-1', 'refund-parts-1#2'])
    })

    it('its retry on a note whose method moved since: the first part answers, and the rest does not print', async () => {
      const w = await tillWorld(app)
      const { note } = await issuedInParts(w)
      const undo = justAfter(firstPartDone, () => { throw new Error('the pod went away') })
      try {
        expect((await send(w, note.id, 'refund-parts-2')).status).toBe(500)
      } finally {
        undo()
      }
      // By card, which prints too: the customer's refund was going back in cash.
      expect((await w.call('PUT', `/invoices/${note.id}`, { paymentMethod: 'card' })).status).toBe(200)

      const r = await send(w, note.id, 'refund-parts-2')

      expect(r.status).toBe(200)
      expect(given(w)).toEqual([10])
      expect(r.json.stornos).toHaveLength(1)
      expect(r.json.receiptCode).toBe('issue_tender_moved')
      expect(await raw(note.id)).toMatchObject({ amountPaid: 10, amountDue: 14 })
    })
  })
})

/** The world's cashier under a token with no operator code. */
async function signedWithNoCode(w: TillWorld): Promise<string> {
  const { default: jwt } = await import('@elysiajs/jwt')
  const { config } = await import('config')
  const { DEFAULT_ROLE_PERMISSIONS } = await import('config/constants')
  const signer: any = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
  return signer.decorator.jwt.sign({
    id: String(w.user._id), orgId: w.orgId, role: 'admin', email: 'cashier@test.com', username: 'cashier',
    firstName: 'Иван', lastName: 'Петров', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}

describe('a refund recorded later (/payments, §2.5)', () => {
  it('in part: a partial storno of the receipt, the rest still due and the rest of the receipt still held', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)

    const r = await pay(w, note.id, 10)

    expect(r.status).toBe(200)
    expect(r.json.invoice.status).toBe('partially_paid')
    expect(await raw(note.id)).toMatchObject({ status: 'partially_paid', amountPaid: 10, amountDue: 14 })
    const receipt = w.sim!.receipts.at(-1)!
    expect(receipt.kind).toBe('storno')
    expect(receipt.header[5]).toBe(inv.receipt.register.fiscalReceiptNumber)
    expect(receipt.sales.map(s => [s.price, s.quantity])).toEqual([[10, 1]])
    expect(receipt.payments).toEqual([{ mode: 'P', amount: 10 }])
    expect(leftByRate(await fresh(inv.receipt._id)).get(20)).toBe(1400)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 14, totalReturns: 10 })

    expect((await pay(w, note.id, 14)).status).toBe(200)
    expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24, amountDue: 0 })
    expect(leftByRate(await fresh(inv.receipt._id)).size).toBe(0)
  })

  it('it is dated as it prints: the device, the session and the row say one day', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    expect((await w.call('POST', `/invoices/${note.id}/payments`, { date: yesterday, amount: 24, method: 'cash' })).status).toBe(200)
    const [storno] = await stornosOf(note.id)
    expect(new Date(storno.issueDate).toISOString().slice(0, 10)).not.toBe(yesterday)
    expect(new Date((await raw(note.id)).payments[0].date).toISOString().slice(0, 10)).not.toBe(yesterday)
  })

  it('one that waited its turn past midnight says the moment it printed, whatever it said when it was written', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    const yesterday = new Date(Date.now() - 86_400_000)
    const real = Invoice.create
    ;(Invoice as any).create = function (doc: any, ...rest: any[]) {
      return (real as any).call(Invoice, { ...doc, issueDate: yesterday, dueDate: yesterday, paidAt: yesterday, payments: doc.payments.map((p: any) => ({ ...p, date: yesterday })) }, ...rest)
    }
    try {
      expect((await pay(w, note.id, 24)).status).toBe(200)
    } finally {
      ;(Invoice as any).create = real
    }
    const [storno] = await stornosOf(note.id)
    expect(new Date(storno.issueDate).getTime()).toBeGreaterThan(yesterday.getTime() + 3_600_000)
    expect(new Date(storno.payments[0].date).getTime()).toBeGreaterThan(yesterday.getTime() + 3_600_000)
    expect(new Date((await raw(note.id)).payments[0].date).getTime()).toBeGreaterThan(yesterday.getTime() + 3_600_000)
  })

  it('two rates: per rate, what the credit note says, and the budget per rate', async () => {
    const w = await tillWorld(app)
    const lines = [line(w, 1, 10, 20), line(w, 1, 10, 9)]
    const inv = await paidInvoice(w, { lines })
    const note = await issuedNote(w, inv, { lines })
    expect(note.doc.total).toBe(22.9)

    expect((await pay(w, note.id, 22.9)).status).toBe(200)

    const sales = w.sim!.receipts.at(-1)!.sales
    expect(sales.map(s => s.price).sort()).toEqual([10.9, 12])
    const left = leftByRate(await fresh(inv.receipt._id))
    expect(left.size).toBe(0)
  })

  it('a rate the receipts do not hold is refused, whatever the total comes to', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv, { lines: [line(w, 1, 10, 9)] })
    const before = await footprint(w)

    const r = await pay(w, note.id, 10.9)

    expect(r.status).toBe(422)
    expect(r.json).toMatchObject({ code: 'refund_exceeds_receipts', left: 0 })
    expect(await footprint(w)).toEqual(before)
  })

  describe('which receipt', () => {
    it('the newest with enough left, though an older one could', async () => {
      const w = await tillWorld(app)
      const inv = await paidInParts(w, [12, 12])
      const note = await issuedNote(w, inv, { quantity: 1 })
      const [older, newer] = inv.receipts

      expect((await pay(w, note.id, 5)).status).toBe(200)

      expect(String((await stornosOf(note.id))[0].register.storno.originalId)).toBe(String(newer._id))
      expect(leftByRate(await fresh(newer._id)).get(20)).toBe(700)
      expect(leftByRate(await fresh(older._id)).get(20)).toBe(1200)
    })

    it('an older one when the newest has not enough', async () => {
      const w = await tillWorld(app)
      const inv = await paidInParts(w, [20, 4])
      const note = await issuedNote(w, inv)
      const [older] = inv.receipts

      expect((await pay(w, note.id, 10)).status).toBe(200)

      expect(String((await stornosOf(note.id))[0].register.storno.originalId)).toBe(String(older._id))
      expect(await stornosOf(note.id)).toHaveLength(1)
    })

    it('larger than any one remainder: one storno per receipt it draws on, each citing its own', async () => {
      const w = await tillWorld(app)
      const inv = await paidInParts(w, [14, 10])
      const note = await issuedNote(w, inv)
      const [older, newer] = inv.receipts
      const printed = w.sim!.receipts.length

      const r = await pay(w, note.id, 24)

      expect(r.status).toBe(200)
      expect(r.json.stornos).toHaveLength(2)
      const stornos = await stornosOf(note.id)
      expect(stornos.map(s => s.total)).toEqual([10, 14])
      expect(stornos.map(s => String(s.register.storno.originalId))).toEqual([String(newer._id), String(older._id)])

      const [first, second] = w.sim!.receipts.slice(printed)
      expect(w.sim!.receipts).toHaveLength(printed + 2)
      expect(first.header[5]).toBe(newer.register.fiscalReceiptNumber)
      expect(first.payments).toEqual([{ mode: 'P', amount: 10 }])
      expect(second.header[5]).toBe(older.register.fiscalReceiptNumber)
      expect(second.payments).toEqual([{ mode: 'P', amount: 14 }])

      expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24, amountDue: 0 })
      expect((await raw(note.id)).payments.map((p: any) => p.amount)).toEqual([10, 14])
      expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 24 })
    })

    it('a second part that loses its race for a receipt: the first stands, and the refusal says how much went back', async () => {
      const w = await tillWorld(app)
      const inv = await paidInParts(w, [14, 10])
      const note = await issuedNote(w, inv)
      // Another credit note takes the older receipt between the two parts of this refund.
      const other = new Invoice.base.Types.ObjectId()
      const real = Invoice.collection.findOneAndUpdate
      let taken = false
      ;(Invoice.collection as any).findOneAndUpdate = async function (filter: any, update: any, ...rest: any[]) {
        const out = await (real as any).call(Invoice.collection, filter, update, ...rest)
        if (!taken && Array.isArray(update)) {
          taken = true
          expect(await takeBudget(await fresh(inv.receipts[0]._id), other, new Map([[20, 1400]]))).toBe(true)
        }
        return out
      }
      let r: any
      try {
        r = await pay(w, note.id, 24)
      } finally {
        ;(Invoice.collection as any).findOneAndUpdate = real
      }

      expect(r.status).toBe(422)
      expect(r.json).toMatchObject({ code: 'refund_exceeds_receipts', refunded: 10 })
      expect(await raw(note.id)).toMatchObject({ status: 'partially_paid', amountPaid: 10, amountDue: 14 })
      expect(await stornosOf(note.id)).toHaveLength(1)
    })

    it('a first part that fails stops the rest: nothing prints after it, and nothing went back', async () => {
      const w = await tillWorld(app)
      const inv = await paidInParts(w, [14, 10])
      const note = await issuedNote(w, inv)
      const printed = w.sim!.receipts.length
      // The driver tries a command three times. The line comes back for whatever follows them.
      let opened = 0
      w.sim!.beforeCommand = (cmd: number) => { if (cmd === 0x90 && ++opened <= 3) throw new Error('down') }

      const r = await pay(w, note.id, 24)

      w.sim!.beforeCommand = null
      expect(r.status).toBe(503)
      expect(r.json).toMatchObject({ code: 'fiscal_error', refunded: 0 })
      expect(opened).toBe(3)
      expect(w.sim!.receipts).toHaveLength(printed)
      expect((await stornosOf(note.id)).map(s => s.status)).toEqual(['voided'])
      expect(await raw(note.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    })

    it('a second part that fails: the first stands, the answer says how much went back, and nothing more is recorded', async () => {
      const w = await tillWorld(app)
      const inv = await paidInParts(w, [14, 10])
      const note = await issuedNote(w, inv)
      // The driver retries a command that got no answer: from the second storno on, the line stays down.
      let stornosOpened = 0
      w.sim!.beforeCommand = (cmd: number) => { if (cmd === 0x90 && ++stornosOpened >= 2) throw new Error('down') }

      const r = await pay(w, note.id, 24)

      w.sim!.beforeCommand = null
      expect(r.status).toBe(503)
      expect(r.json).toMatchObject({ code: 'fiscal_error', refunded: 10 })
      expect(await raw(note.id)).toMatchObject({ status: 'partially_paid', amountPaid: 10, amountDue: 14 })
      expect((await stornosOf(note.id)).map(s => s.status)).toEqual(['paid', 'voided'])
      expect(leftByRate(await fresh(inv.receipts[0]._id)).get(20)).toBe(1400)

      // What is left goes back on the next attempt.
      expect((await pay(w, note.id, 14)).status).toBe(200)
      expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    })
  })

  describe('refused, with nothing written', () => {
    it('beyond the budget: 422', async () => {
      const w = await tillWorld(app)
      const inv = await paidInParts(w, [10])
      expect((await pay(w, inv.id, 14, 'bank_transfer')).status).toBe(200)
      const note = await issuedNote(w, inv)
      const before = await footprint(w)

      const r = await pay(w, note.id, 11)

      expect(r.status).toBe(422)
      expect(r.json).toMatchObject({ code: 'refund_exceeds_receipts', left: 10 })
      expect(await footprint(w)).toEqual(before)
      expect((await pay(w, note.id, 10)).status).toBe(200)
    })

    it('no receipt: 409, and the bank takes it', async () => {
      const w = await tillWorld(app)
      const inv = await draftOf(w, { method: 'bank_transfer' })
      await send(w, inv.id)
      await pay(w, inv.id, 24, 'bank_transfer')
      const note = await issuedNote(w, inv)
      const before = await footprint(w)

      const r = await pay(w, note.id, 24)

      expect(r.status).toBe(409)
      expect(r.json.code).toBe('no_receipt_to_storno')
      expect(await footprint(w)).toEqual(before)
      expect((await pay(w, note.id, 24, 'bank_transfer')).status).toBe(200)
    })

    it('what an invoice paid before this FR had: settled with no receipt', async () => {
      const w = await tillWorld(app)
      const inv = await draftOf(w, { method: 'bank_transfer' })
      await send(w, inv.id)
      await Invoice.updateOne({ _id: inv.id }, { $set: { paymentMethod: 'cash', status: 'paid', amountPaid: 24, amountDue: 0, payments: [{ date: new Date(), amount: 24, method: 'cash', origin: 'cash_on_issue' }] } })
      const note = await issuedNote(w, inv)
      expect((await pay(w, note.id, 24)).json.code).toBe('no_receipt_to_storno')
    })

    it('an imported invoice\'s credit note, written by a person: nothing to cite', async () => {
      const w = await tillWorld(app)
      const contact = await draftOf(w, { method: 'bank_transfer' })
      const { invoiceId } = await importedInvoice(w, contact.contactId)
      const note = await issuedNote(w, { id: invoiceId, contactId: contact.contactId })
      expect((await pay(w, note.id, 24)).json.code).toBe('no_receipt_to_storno')
    })

    it('a receipt on delivery holds nothing to give back: its money is the courier\'s', async () => {
      const w = await tillWorld(app)
      const inv = await draftOf(w, { method: 'cash_on_delivery' })
      expect((await send(w, inv.id)).status).toBe(200)
      expect((await receiptsOf(inv.id))[0].register.fiscal.state).toBe('printed')
      const note = await issuedNote(w, inv)
      expect((await pay(w, note.id, 24)).json.code).toBe('no_receipt_to_storno')
    })

    it('more than the credit note still owes: its own rule, before any device', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await issuedNote(w, inv, { quantity: 1 })
      const r = await pay(w, note.id, 13)
      expect(r.status).toBe(422)
      expect(r.json.code).toBe('overpayment')
    })

    it('a draft credit note: a storno names its number', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await noteOn(w, inv)
      const r = await pay(w, note.id, 5)
      expect(r.status).toBe(422)
      expect(r.json.code).toBe('document_not_issued')
    })

    it('a voided receipt holds nothing: it took nothing', async () => {
      const w = await tillWorld(app)
      const inv = await draftOf(w, { method: 'bank_transfer' })
      await send(w, inv.id)
      w.sim!.paper = false
      expect((await pay(w, inv.id, 24)).status).toBe(503)
      w.sim!.paper = true
      const note = await issuedNote(w, inv)
      expect((await pay(w, note.id, 24)).json.code).toBe('no_receipt_to_storno')
    })

    it('a dead receipt on the invoice is finished first: past its print only the money was left, and then it holds', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      // The process died after the print: unfinished, its lease lapsed.
      await Invoice.updateOne({ _id: inv.receipt._id }, { $unset: { completedAt: 1 }, $set: { leaseUntil: new Date(Date.now() - 1000) } })
      const note = await issuedNote(w, inv)

      expect((await pay(w, note.id, 24)).status).toBe(200)

      expect((await fresh(inv.receipt._id)).completedAt).toBeTruthy()
      expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    })

    it('a receipt still printing: told so, for what it may hold', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      await Invoice.updateOne({ _id: inv.receipt._id }, { $unset: { completedAt: 1 }, $set: { leaseUntil: new Date(Date.now() + 60_000) } })
      const note = await issuedNote(w, inv)
      const r = await pay(w, note.id, 24)
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('payment_in_progress')
    })

    it('a receipt whose `unknown` stands holds nothing: it has no number to cite, no door settles it, and the refund goes by bank', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      // As an in-turn verdict leaves one: it stands, its money booked, and nothing proves it printed.
      await Invoice.updateOne({ _id: inv.receipt._id }, { $set: { 'register.fiscal.state': 'unknown' }, $unset: { 'register.fiscalReceiptNumber': 1 } })
      const note = await issuedNote(w, inv)
      const before = await footprint(w)

      const r = await pay(w, note.id, 24)

      expect(r.status).toBe(409)
      expect(r.json.code).toBe('no_receipt_to_storno')
      expect(r.json.message).toContain('Refund it by bank')
      expect(await footprint(w)).toEqual(before)
      expect((await shown(w, note.id)).refundable).toBe(0)
      // Nobody can settle it, so this is the way out, and it is open.
      expect((await settle(w, inv.receipt._id, true)).status).toBe(409)
      expect((await pay(w, note.id, 24, 'bank_transfer')).status).toBe(200)
      expect(await stornosOf(note.id)).toHaveLength(0)
    })

    it('another receipt that printed still holds its own: only what is unknown has no budget', async () => {
      const w = await tillWorld(app)
      const inv = await paidInParts(w, [14, 10])
      await Invoice.updateOne({ _id: inv.receipts[1]._id }, { $set: { 'register.fiscal.state': 'unknown' } })
      const note = await issuedNote(w, inv)

      expect((await pay(w, note.id, 14)).status).toBe(200)
      expect(String((await stornosOf(note.id))[0].register.storno.originalId)).toBe(String(inv.receipts[0]._id))

      const beyond = await pay(w, note.id, 1)
      expect(beyond.status).toBe(422)
      expect(beyond.json).toMatchObject({ code: 'refund_exceeds_receipts', left: 0 })
    })

    it('a receipt in doubt: its way out comes first, whichever the money it may be', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      await Invoice.updateOne({ _id: inv.receipt._id }, { $set: { 'register.fiscal.inDoubt': true, 'register.fiscal.state': 'unknown' }, $unset: { completedAt: 1 } })
      const note = await issuedNote(w, inv)
      const r = await pay(w, note.id, 24)
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('receipt_in_doubt')
      expect(r.json.receipt.number).toBe(inv.receipt.invoiceNumber)
    })
  })

  describe('a storno prints where its receipt printed: it cites that device\'s fiscal memory', () => {
    /** A second session on a second device, for the clerk, in another warehouse's till. */
    async function secondTill(w: TillWorld) {
      const device = await FiscalDevice.create({
        orgId: w.oid, warehouseId: w.warehouse._id, name: 'Eltrade B', deviceNumber: 'ED654321', manufacturer: 'eltrade',
        connectionType: 'browser', status: 'online', isActive: true,
      } as any)
      return device
    }

    it('a session on another device is refused, and told which device: nothing reaches this one', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await issuedNote(w, inv)
      // The receipt printed on a device this session's is not.
      await Invoice.updateOne({ _id: inv.receipt._id }, { $set: { 'register.fiscalDeviceNumber': 'ED654321' } })
      await secondTill(w)
      const before = await footprint(w)

      const r = await pay(w, note.id, 24)

      expect(r.status).toBe(409)
      expect(r.json).toMatchObject({ code: 'receipt_on_other_device', deviceNumbers: ['ED654321'] })
      expect(await footprint(w)).toEqual(before)
    })

    it('a refund that fits only with what another device printed: what this one holds, no more', async () => {
      const w = await tillWorld(app)
      const inv = await paidInParts(w, [10, 14])
      const note = await issuedNote(w, inv)
      await Invoice.updateOne({ _id: inv.receipts[1]._id }, { $set: { 'register.fiscalDeviceNumber': 'ED654321' } })

      const r = await pay(w, note.id, 24)

      expect(r.status).toBe(422)
      expect(r.json).toMatchObject({ code: 'refund_exceeds_receipts', left: 10 })
    })

    it('a receipt with no number on record has nothing to cite: refund by bank', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      await Invoice.updateOne({ _id: inv.receipt._id }, { $unset: { 'register.fiscalReceiptNumber': 1 } })
      const note = await issuedNote(w, inv)
      expect((await pay(w, note.id, 24)).json.code).toBe('no_receipt_to_storno')
    })
  })

  describe('the budget under load: two refunds on one receipt never over-refund it', () => {
    it('two credit notes at once that fit only one by one: one prints, one gives way, and no number is lost', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const a = await issuedNote(w, inv, { quantity: 2 })
      const b = await issuedNote(w, inv, { quantity: 2 })
      const printed = w.sim!.receipts.length
      const cs = await Sequence.findOne({ orgId: w.oid, prefix: 'CASH_SALE' }).lean().exec() as any

      const [ra, rb] = await Promise.all([pay(w, a.id, 24), pay(w, b.id, 24)])

      expect([ra.status, rb.status].sort()).toEqual([200, 422])
      expect(w.sim!.receipts).toHaveLength(printed + 1)
      const loser = ra.status === 200 ? b : a
      expect(await raw(loser.id)).toMatchObject({ amountPaid: 0, status: 'sent' })
      expect((await raw(loser.id)).receiptHolds ?? []).toHaveLength(0)
      expect(await stornosOf(loser.id)).toHaveLength(0)
      // A gap in the series would be a number a storno drew and gave up.
      expect((await Sequence.findOne({ orgId: w.oid, prefix: 'CASH_SALE' }).lean().exec() as any).lastNumber).toBe(cs.lastNumber + 1)
      expect(leftByRate(await fresh(inv.receipt._id)).size).toBe(0)
    })

    it('the interleaving `_id` order cannot hold: the later id read first and went on, the earlier wrote after it read', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const receipt = await fresh(inv.receipt._id)
      const want = new Map([[20, 2400]])
      const earlier = new Invoice.base.Types.ObjectId('000000000000000000000001')
      const later = new Invoice.base.Types.ObjectId('ffffffffffffffffffffffff')

      // The later id reaches the document first and takes it; under R0's rule the earlier then reads
      // "I am first" and goes ahead as well.
      expect(await takeBudget(receipt, later, want)).toBe(true)
      expect(await takeBudget(receipt, earlier, want)).toBe(false)

      expect((await fresh(receipt._id)).register.refundClaims.map((c: any) => String(c.stornoId))).toEqual([String(later)])
    })

    it('a resume finds its claim standing, and a claim given back is free', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const receipt = await fresh(inv.receipt._id)
      const want = new Map([[20, 1000]])
      const id = new Invoice.base.Types.ObjectId()

      expect(await takeBudget(receipt, id, want)).toBe(true)
      expect(await takeBudget(receipt, id, want)).toBe(true)
      expect((await fresh(receipt._id)).register.refundClaims).toHaveLength(1)

      await giveBackBudget(receipt._id, w.oid, id)
      await giveBackBudget(receipt._id, w.oid, id)
      expect((await fresh(receipt._id)).register.refundClaims).toHaveLength(0)
      expect(await takeBudget(receipt, new Invoice.base.Types.ObjectId(), new Map([[20, 2400]]))).toBe(true)
    })

    it('the claim holds per rate: room at another rate is no room at this one', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w, { lines: [line(w, 1, 10, 20), line(w, 1, 10, 9)] })
      const receipt = await fresh(inv.receipt._id)
      expect(await takeBudget(receipt, new Invoice.base.Types.ObjectId(), new Map([[20, 1200]]))).toBe(true)
      expect(await takeBudget(receipt, new Invoice.base.Types.ObjectId(), new Map([[20, 1]]))).toBe(false)
      expect(await takeBudget(receipt, new Invoice.base.Types.ObjectId(), new Map([[9, 1090]]))).toBe(true)
    })

    it('money a storno is printing for cannot be taken by a bank refund recorded meanwhile', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await issuedNote(w, inv)
      const hold = gate()
      w.sim!.beforeCommand = async (cmd: number) => { if (cmd === 0x90) await hold.closed }

      const printing = pay(w, note.id, 24)
      await until(async () => (await raw(note.id)).receiptHolds?.length > 0, 'the hold')
      const bank = await pay(w, note.id, 24, 'bank_transfer')
      hold.open()
      w.sim!.beforeCommand = null

      expect(bank.status).toBe(409)
      expect(bank.json.code).toBe('payment_in_progress')
      expect((await printing).status).toBe(200)
      expect(await raw(note.id)).toMatchObject({ amountPaid: 24, status: 'paid' })
    })
  })

  describe('a retry under one key', () => {
    it('prints once, and answers the same; the key on another amount is refused', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await issuedNote(w, inv)
      const first = await pay(w, note.id, 10, 'cash', 'refund-one')
      const printed = w.sim!.receipts.length

      const second = await pay(w, note.id, 10, 'cash', 'refund-one')

      expect(second.status).toBe(200)
      expect(second.json.receipt.number).toBe(first.json.receipt.number)
      expect(w.sim!.receipts).toHaveLength(printed)
      expect(await raw(note.id)).toMatchObject({ amountPaid: 10 })

      const other = await pay(w, note.id, 11, 'cash', 'refund-one')
      expect(other.status).toBe(422)
      expect(other.json.code).toBe('idempotency_key_reused')
    })

    it('over two receipts: a retry prints neither again', async () => {
      const w = await tillWorld(app)
      const inv = await paidInParts(w, [14, 10])
      const note = await issuedNote(w, inv)
      expect((await pay(w, note.id, 24, 'cash', 'refund-two')).status).toBe(200)
      const printed = w.sim!.receipts.length

      const second = await pay(w, note.id, 24, 'cash', 'refund-two')

      expect(second.status).toBe(200)
      expect(second.json.stornos).toHaveLength(2)
      expect(w.sim!.receipts).toHaveLength(printed)
      expect(await raw(note.id)).toMatchObject({ amountPaid: 24, status: 'paid' })
    })

    it('a process that died between two stornos: the retry goes on from what printed', async () => {
      const w = await tillWorld(app)
      const inv = await paidInParts(w, [14, 10])
      const note = await issuedNote(w, inv)
      // The first storno only: 10 of 24, as the request that died left it, its key the request's.
      expect((await pay(w, note.id, 10, 'cash', 'refund-three-part')).status).toBe(200)
      const hash = (await import('services/biz/hot-path-key')).requestHash(`invoice.payment:${note.id}`, { date: TODAY(), amount: 24, method: 'cash' })
      await Invoice.updateOne({ type: 'payment_storno', clientKey: 'refund-three-part' }, { $set: { clientKey: 'refund-three', requestHash: hash } })
      const printed = w.sim!.receipts.length

      const r = await pay(w, note.id, 24, 'cash', 'refund-three')

      expect(r.status).toBe(200)
      expect(w.sim!.receipts).toHaveLength(printed + 1)
      expect(w.sim!.receipts.at(-1)!.payments).toEqual([{ mode: 'P', amount: 14 }])
      expect(await raw(note.id)).toMatchObject({ amountPaid: 24, status: 'paid' })
      expect((await stornosOf(note.id)).map(s => s.clientKey)).toEqual(['refund-three', 'refund-three#2'])
    })

    it('a print that failed answers the same to its key, and prints nothing: a new attempt is a new key', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await issuedNote(w, inv)
      w.sim!.paper = false
      expect((await pay(w, note.id, 24, 'cash', 'refund-four')).status).toBe(503)
      w.sim!.paper = true
      const printed = w.sim!.receipts.length

      expect((await pay(w, note.id, 24, 'cash', 'refund-four')).status).toBe(503)

      expect(w.sim!.receipts).toHaveLength(printed)
      expect((await pay(w, note.id, 24, 'cash', 'refund-five')).status).toBe(200)
    })
  })

  describe('a print that fails records nothing', () => {
    it('503: no payment, no hold, the receipt\'s budget whole, its number voided and accounted for', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await issuedNote(w, inv)
      w.sim!.paper = false

      const r = await pay(w, note.id, 24)

      w.sim!.paper = true
      expect(r.status).toBe(503)
      expect(r.json).toMatchObject({ code: 'fiscal_error', refunded: 0 })
      expect(await raw(note.id)).toMatchObject({ status: 'sent', amountPaid: 0, amountDue: 24 })
      expect((await raw(note.id)).receiptHolds ?? []).toHaveLength(0)
      expect((await raw(note.id)).payments ?? []).toHaveLength(0)
      expect(leftByRate(await fresh(inv.receipt._id)).get(20)).toBe(2400)
      expect(await sessionOf(w)).toMatchObject({ totalCash: 24, totalReturns: 0 })
    })

    it('a device that is gone before its turn: failed, with nothing reached', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const note = await issuedNote(w, inv)
      w.sim!.beforeCommand = (cmd: number) => { if (cmd === 0x90) throw new Error('down') }
      expect((await pay(w, note.id, 24)).status).toBe(503)
      w.sim!.beforeCommand = null
      expect(await raw(note.id)).toMatchObject({ amountPaid: 0 })
    })
  })
})

/** An invoice as the import writes it: its first status entry says so. */
async function importedInvoice(w: TillWorld, contactId: string) {
  const { id } = await draftOf(w, { method: 'cash', extra: { contactId } })
  const first = await send(w, id)
  expect(first.status).toBe(200)
  // As if imported: another system printed its receipt.
  await Invoice.updateOne({ _id: id }, { $set: { 'statusHistory.0.reason': 'ocr_import' } })
  await Invoice.deleteMany({ type: 'payment_receipt', 'register.paidInvoiceId': id })
  return { invoiceId: id }
}

describe('what backs a refund, in doubt: a person settles it, and it holds what they said', () => {
  /** An invoice whose only receipt its request left past the print: no money booked yet, held for a person. */
  async function heldReceipt(w: TillWorld) {
    const d = await draftOf(w, { method: 'bank_transfer' })
    expect((await send(w, d.id)).status).toBe(200)
    const invoice = await raw(d.id)
    const body = receiptBody({ doc: invoice, amount: 24, whole: false, printsText: true, receipts: [] })!
    const document = paymentReceiptDocument({
      invoice, body, tender: { method: 'cash', amount: 24, date: new Date() },
      session: { id: w.sessionId, warehouseId: String(w.warehouse._id) },
      user: { id: String(w.user._id), operatorCode: '0001' },
      printer: { deviceNumber: 'ED123456' } as any,
    })
    const attemptedAt = new Date(Date.now() - 60_000)
    const receipt: any = await Invoice.create({
      ...document, invoiceNumber: `CS-2026-${String(Math.floor(Math.random() * 90000) + 10000)}`, leaseUntil: new Date(Date.now() - 1000),
      register: { ...document.register, unp: 'ED123456-0001-0000077', fiscal: { state: 'pending', mode: 'fiscal', attemptedAt, counterBefore: w.sim!.lastDocNumber - 1 } },
    })
    await Invoice.updateOne({ _id: d.id }, { $push: { receiptHolds: { receiptId: receipt._id, amount: 24 } } })
    return { ...d, receipt, attemptedAt }
  }

  it('held: the refund names it, and nothing prints', async () => {
    const w = await tillWorld(app)
    const inv = await heldReceipt(w)
    const note = await issuedNote(w, inv)
    const before = await footprint(w)

    const r = await pay(w, note.id, 24)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('receipt_in_doubt')
    expect(r.json.receipt.number).toBe(inv.receipt.invoiceNumber)
    expect(await footprint(w)).toEqual(before)
    expect((await shown(w, note.id)).refundable).toBe(0)
    expect((await fresh(inv.receipt._id)).register.fiscal).toMatchObject({ state: 'unknown', inDoubt: true })
  })

  it('settled as printed with the number off its slip: the refund cites that number, dated when it printed', async () => {
    const w = await tillWorld(app)
    const inv = await heldReceipt(w)
    const note = await issuedNote(w, inv)
    await pay(w, note.id, 24)

    const said = await settle(w, inv.receipt._id, true, undefined, '77')
    expect(said.status).toBe(200)

    const settled = await fresh(inv.receipt._id)
    expect(settled.completedAt).toBeTruthy()
    expect(settled.register).toMatchObject({ fiscalReceiptNumber: '77', settled: { printed: true, receiptNumber: '77' } })
    expect(settled.register.fiscal).toMatchObject({ state: 'printed', receiptNo: '77' })
    expect(new Date(settled.register.printedAt).getTime()).toBe(inv.attemptedAt.getTime())
    expect(await raw(inv.id)).toMatchObject({ status: 'paid', amountPaid: 24 })

    const r = await pay(w, note.id, 24)

    expect(r.status).toBe(200)
    const printed = w.sim!.receipts.at(-1)!
    expect(printed.kind).toBe('storno')
    expect(printed.header[1]).toBe('ED123456-0001-0000077')
    expect(printed.header[5]).toBe('77')
    expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    const [storno] = await stornosOf(note.id)
    expect(String(storno.register.storno.originalId)).toBe(String(inv.receipt._id))
    expect(new Date(storno.register.storno.originalDate).getTime()).toBe(inv.attemptedAt.getTime())
  })

  it('settled as printed with no number: it took the money, and with nothing to cite the refund goes by bank', async () => {
    const w = await tillWorld(app)
    const inv = await heldReceipt(w)
    const note = await issuedNote(w, inv)
    await pay(w, note.id, 24)

    expect((await settle(w, inv.receipt._id, true)).status).toBe(200)

    expect(await raw(inv.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect((await fresh(inv.receipt._id)).register.fiscalReceiptNumber).toBeUndefined()
    const r = await pay(w, note.id, 24)
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('no_receipt_to_storno')
    expect((await pay(w, note.id, 24, 'bank_transfer')).status).toBe(200)
  })

  it('a number that is none, or that this device gave another document, is refused and nothing is settled', async () => {
    const w = await tillWorld(app)
    const other = await paidInvoice(w)
    const inv = await heldReceipt(w)
    const note = await issuedNote(w, inv)
    await pay(w, note.id, 24)

    const bad = await settle(w, inv.receipt._id, true, undefined, 'abc')
    expect(bad.status).toBe(422)
    expect(bad.json.code).toBe('receipt_number_required')
    expect(bad.json.message).toContain('a refund of it goes by bank')

    const taken = await settle(w, inv.receipt._id, true, undefined, other.receipt.register.fiscalReceiptNumber)
    expect(taken.status).toBe(422)
    expect(taken.json.code).toBe('receipt_number_taken')
    expect(taken.json.document).toBe(other.receipt.invoiceNumber)

    const still = await fresh(inv.receipt._id)
    expect(still.register.fiscal.inDoubt).toBe(true)
    expect(still.register.settled).toBeUndefined()
  })

  describe('a number off a receipt\'s slip is held to all a sale\'s is (the third read, finding 7)', () => {
    /** A receipt held in doubt, its note issued, the touch that held it done: what the door then asks. */
    async function offItsSlip(w: TillWorld) {
      const inv = await heldReceipt(w)
      const note = await issuedNote(w, inv)
      expect((await pay(w, note.id, 24)).json.code).toBe('receipt_in_doubt')
      return { id: inv.receipt._id, inv, note }
    }
    const untouched = async (id: unknown) => {
      const still = await fresh(id)
      expect(still.register.fiscal).toMatchObject({ state: 'unknown', inDoubt: true })
      expect(still.register.settled).toBeUndefined()
      expect(still.register.fiscalReceiptNumber).toBeUndefined()
    }

    it('above the device\'s last number: refused, read in the same turn as the open flag', async () => {
      const w = await tillWorld(app)
      const { id } = await offItsSlip(w)

      const r = await settle(w, id, true, undefined, '9999999')

      expect(r.status).toBe(422)
      expect(r.json.code).toBe('receipt_number_off_device')
      expect(r.json.last).toBe(w.sim!.lastDocNumber)
      await untouched(id)
    })

    it('the last number itself passes, and one below it: there is no lower bound', async () => {
      const w = await tillWorld(app)
      const { id } = await offItsSlip(w)
      expect((await settle(w, id, true, undefined, '1')).status).toBe(200)
      expect((await fresh(id)).register.fiscalReceiptNumber).toBe('1')

      const other = await offItsSlip(w)
      expect((await settle(w, other.id, true, undefined, String(w.sim!.lastDocNumber))).status).toBe(200)
    })

    it('a device that cannot say skips that, and the rest of the checks stand', async () => {
      const w = await tillWorld(app)
      const { id } = await offItsSlip(w)
      unregisterPrinter(w.deviceId)
      const driver = new EltradeFiscalPrinter(w.sim!.exchange, w.deviceId)
      registerPrinter(w.deviceId, new Proxy(driver, {
        get: (t: any, p) => {
          const v = t[p]
          if (p === 'getLastReceiptNumber') return undefined
          return typeof v === 'function' ? v.bind(t) : v
        },
      }))

      expect((await settle(w, id, true, undefined, 'ФБ-1')).json.code).toBe('receipt_number_required')
      await untouched(id)
      expect((await settle(w, id, true, undefined, '9999999')).status).toBe(200)
    })

    it('a counter that cannot be read, on a driver that has one, is no answer', async () => {
      const w = await tillWorld(app)
      const { id } = await offItsSlip(w)
      // The open flag reads fine, and the line goes at the counter, in the same turn.
      w.sim!.beforeCommand = (cmd) => { if (cmd === 0x71) throw new Error('Bridge disconnected') }

      expect((await settle(w, id, true, undefined, '77')).json.code).toBe('receipt_device_away')

      await untouched(id)
    })

    it('with no number brought there is nothing to read the counter for: it stands as printed', async () => {
      const w = await tillWorld(app)
      const { id, inv } = await offItsSlip(w)
      w.sim!.beforeCommand = (cmd) => { if (cmd === 0x71) throw new Error('Bridge disconnected') }

      expect((await settle(w, id, true)).status).toBe(200)

      expect(await raw(inv.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
      expect((await fresh(id)).register.fiscalReceiptNumber).toBeUndefined()
    })

    it('settled as not printed it is not read at all: nothing printed, so nothing has a number', async () => {
      const w = await tillWorld(app)
      const { id } = await offItsSlip(w)
      w.sim!.beforeCommand = (cmd) => { if (cmd === 0x71) throw new Error('Bridge disconnected') }

      expect((await settle(w, id, false, undefined, '9999999')).status).toBe(200)

      expect((await fresh(id)).status).toBe('voided')
    })

    it('a device whose counter has gone back since this receipt read it: its memory was replaced, and it says nothing of this slip', async () => {
      const w = await tillWorld(app)
      const { id } = await offItsSlip(w)
      await Invoice.updateOne({ _id: id }, { $set: { 'register.fiscal.counterBefore': w.sim!.lastDocNumber + 400 } })

      expect((await settle(w, id, true, undefined, String(w.sim!.lastDocNumber + 401))).status).toBe(200)
    })

    it('another session\'s number on the same device is taken, in its three spellings: two on one device is normal', async () => {
      const w = await tillWorld(app)
      const clerk = await clerkSession(w)
      const other = await clerkSale(w, clerk, 1)
      const theirs = other.json.transaction.fiscalReceiptNumber
      const { id } = await offItsSlip(w)

      for (const spelled of [theirs, String(Number(theirs)), String(Number(theirs)).padStart(4, '0')]) {
        const r = await settle(w, id, true, undefined, spelled)
        expect(r.status, spelled).toBe(422)
        expect(r.json.code, spelled).toBe('receipt_number_taken')
        expect(r.json.document).toBe(other.json.transaction.transactionNumber)
      }
      await untouched(id)
    })

    it('outside 31 days of this receipt it is not taken: a replaced fiscal memory counts from one again', async () => {
      const w = await tillWorld(app)
      const earlier = await w.sell(1)
      const theirs = earlier.json.transaction.fiscalReceiptNumber
      const earlierId = new Invoice.base.Types.ObjectId(String(earlier.json.transaction.id))
      const { id } = await offItsSlip(w)

      await Invoice.collection.updateOne({ _id: earlierId }, { $set: { createdAt: new Date(Date.now() - 30 * 86_400_000) } })
      expect((await settle(w, id, true, undefined, theirs)).json.code).toBe('receipt_number_taken')
      await Invoice.collection.updateOne({ _id: earlierId }, { $set: { createdAt: new Date(Date.now() - 32 * 86_400_000) } })
      expect((await settle(w, id, true, undefined, theirs)).status).toBe(200)
    })

    it('deactivated: nothing to read it against, and the word stands', async () => {
      const w = await tillWorld(app)
      const { id } = await offItsSlip(w)
      await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { isActive: false } })

      expect((await settle(w, id, true, undefined, '9999999')).status).toBe(200)
    })
  })

  describe('correcting one: the door that took it, until a refund\'s storno cites it (the third read, finding 7)', () => {
    /** A receipt settled printed under `typed`, finished, with its note issued and nothing given back yet. */
    async function typedOn(w: TillWorld, typed = '77') {
      const inv = await heldReceipt(w)
      const note = await issuedNote(w, inv)
      expect((await pay(w, note.id, 24)).json.code).toBe('receipt_in_doubt')
      expect((await settle(w, inv.receipt._id, true, undefined, typed)).status).toBe(200)
      return { id: String(inv.receipt._id), inv, note }
    }
    const fields = async (id: unknown) => {
      const { register: r } = await fresh(id)
      return { settled: r.settled.receiptNumber, receiptNo: r.fiscal.receiptNo, number: r.fiscalReceiptNumber }
    }
    const corrected = (w: TillWorld) => AuditLog.countDocuments({ orgId: w.oid, action: 'correct_receipt_number' })
    const closedOnDevice = (w: TillWorld) => w.sim!.receipts.filter(r => !r.voided)

    it('the same door and rights: all three stored fields rewritten, audited old to new, and the refund cites it', async () => {
      const w = await tillWorld(app)
      const { id, note } = await typedOn(w)

      expect((await settle(w, id, true, await w.tokenAs('sales'), '78')).status).toBe(403)
      expect((await fields(id)).number).toBe('77')

      const r = await settle(w, id, true, undefined, '78')

      expect(r.status).toBe(200)
      expect(await fields(id)).toEqual({ settled: '78', receiptNo: '78', number: '78' })
      const audit: any = await AuditLog.findOne({ orgId: w.oid, action: 'correct_receipt_number' }).lean().exec()
      expect(String(audit.entityId)).toBe(id)
      expect(String(audit.userId)).toBe(String(w.user._id))
      expect(audit.changes).toEqual([expect.objectContaining({ field: 'receiptNumber', oldValue: '77', newValue: '78' })])
      const page = (await w.call('GET', `/cash-register/documents/${id}`)).json
      expect(page.row.fiscal).toMatchObject({ numberTyped: true, receiptNumber: '78' })

      expect((await pay(w, note.id, 24)).status).toBe(200)
      expect(closedOnDevice(w).at(-1)!.header[5]).toBe('78')
    })

    it('the same checks: digits, the device\'s last number, one already taken, the device asked', async () => {
      const w = await tillWorld(app)
      const other = (await w.sell(1)).json.transaction.fiscalReceiptNumber
      const { id } = await typedOn(w)

      expect((await settle(w, id, true, undefined, 'ФБ-1')).json.code).toBe('receipt_number_required')
      expect((await settle(w, id, true, undefined, '')).json.code).toBe('receipt_number_required')
      expect((await settle(w, id, true, undefined, '9999999')).json.code).toBe('receipt_number_off_device')
      expect((await settle(w, id, true, undefined, other)).json.code).toBe('receipt_number_taken')
      forgetDevices()
      expect((await settle(w, id, true, undefined, '78')).json.code).toBe('receipt_device_away')
      expect((await fields(id)).number).toBe('77')
      expect(await corrected(w)).toBe(0)
    })

    it('the number it has already: nothing written, and nothing on the trail', async () => {
      const w = await tillWorld(app)
      const { id } = await typedOn(w)

      expect((await settle(w, id, true, undefined, '77')).status).toBe(200)
      expect(await corrected(w)).toBe(0)
    })

    it('once a refund\'s storno cites it: 409, and the number stands, whatever is typed', async () => {
      const w = await tillWorld(app)
      const { id, note } = await typedOn(w)
      expect((await pay(w, note.id, 10)).status).toBe(200)

      const r = await settle(w, id, true, undefined, '78')

      expect(r.status).toBe(409)
      expect(r.json.code).toBe('receipt_number_cited')
      expect((await fields(id)).number).toBe('77')
      expect((await settle(w, id, true, undefined, '9999999')).json.code).toBe('receipt_number_cited')
      expect(await corrected(w)).toBe(0)
    })

    it('a storno held in doubt cites it too, until it is settled as not printed', async () => {
      const w = await tillWorld(app)
      const { id, note } = await typedOn(w)
      w.sim!.dropAfter = 0x38
      expect((await pay(w, note.id, 24)).json.code).toBe('receipt_in_doubt')
      w.sim!.disconnected = false
      const [storno] = await stornosOf(note.id)

      expect((await settle(w, id, true, undefined, '78')).json.code).toBe('receipt_number_cited')

      expect((await settle(w, storno._id, false)).status).toBe(200)
      expect((await settle(w, id, true, undefined, '78')).status).toBe(200)
      expect((await fields(id)).number).toBe('78')
    })

    it('a storno voided since cites nothing: it gave its claim back, and a bad number is why one is corrected', async () => {
      const w = await tillWorld(app)
      const { id, note } = await typedOn(w)
      w.sim!.paper = false
      expect((await pay(w, note.id, 24)).status).toBe(503)
      w.sim!.paper = true
      expect((await fresh(id)).register.refundClaims ?? []).toHaveLength(0)

      expect((await settle(w, id, true, undefined, '78')).status).toBe(200)

      expect((await pay(w, note.id, 24)).status).toBe(200)
      expect(closedOnDevice(w).at(-1)!.header[5]).toBe('78')
    })

    it('a number the device gave cannot be corrected, nor what was settled with none, nor settled not printed', async () => {
      const w = await tillWorld(app)
      const printed = await paidInvoice(w)
      expect((await settle(w, printed.receipt._id, true, undefined, '1')).json.code).toBe('receipt_not_in_doubt')

      const none = await heldReceipt(w)
      expect((await pay(w, (await issuedNote(w, none)).id, 24)).json.code).toBe('receipt_in_doubt')
      expect((await settle(w, none.receipt._id, true)).status).toBe(200)
      expect((await settle(w, none.receipt._id, true, undefined, '1')).json.code).toBe('receipt_not_in_doubt')

      const gone = await heldReceipt(w)
      expect((await pay(w, (await issuedNote(w, gone)).id, 24)).json.code).toBe('receipt_in_doubt')
      expect((await settle(w, gone.receipt._id, false)).status).toBe(200)
      expect((await settle(w, gone.receipt._id, true, undefined, '1')).json.code).toBe('receipt_not_in_doubt')
    })

    it('a text receipt has no number to correct', async () => {
      const w = await tillWorld(app)
      const inv = await heldReceipt(w)
      await Invoice.updateOne({ _id: inv.receipt._id }, { $set: { 'register.isFiscal': false, 'register.fiscal.mode': 'text', 'register.settled': { printed: true, receiptNumber: '77' }, 'register.fiscal.state': 'printed', completedAt: new Date() }, $unset: { 'register.unp': 1 } })

      expect((await settle(w, inv.receipt._id, true, undefined, '78')).json.code).toBe('receipt_not_in_doubt')
      expect(await corrected(w)).toBe(0)
    })

    it('of a correction and a storno\'s claim one gives way: corrected first, the storno cites the correction', async () => {
      const w = await tillWorld(app)
      const { id, note } = await typedOn(w)
      const undo = during(update => !!update?.$push?.['register.refundClaims'], async () => {
        expect((await settle(w, id, true, undefined, '78')).status).toBe(200)
      })
      let r: any
      try {
        r = await pay(w, note.id, 24)
      } finally {
        undo()
      }

      expect(r.status).toBe(200)
      expect(closedOnDevice(w).at(-1)!.header[5]).toBe('78')
      expect((await stornosOf(note.id))[0].register.storno.originalReceiptNumber).toBe('78')
    })

    it('claimed first, the correction is refused, and the storno cites what it read', async () => {
      const w = await tillWorld(app)
      const { id, note } = await typedOn(w)
      let inside: any
      const undo = during(update => !!update?.$set?.['register.settled.receiptNumber'], async () => {
        inside = await pay(w, note.id, 24)
      })
      let r: any
      try {
        r = await settle(w, id, true, undefined, '78')
      } finally {
        undo()
      }

      expect(inside.status).toBe(200)
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('receipt_number_cited')
      expect((await fields(id)).number).toBe('77')
      expect(closedOnDevice(w).at(-1)!.header[5]).toBe('77')
    })

    it('a settle that stopped halfway: corrected, and the same answer finishes it', async () => {
      const w = await tillWorld(app)
      const inv = await heldReceipt(w)
      const note = await issuedNote(w, inv)
      expect((await pay(w, note.id, 24)).json.code).toBe('receipt_in_doubt')
      const undo = during(update => !!update?.$set?.completedAt, async () => { throw new Error('the pod went away') })
      try {
        expect((await settle(w, inv.receipt._id, true, undefined, '77')).status).toBe(500)
      } finally {
        undo()
      }
      await Invoice.updateOne({ _id: inv.receipt._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })

      expect((await settle(w, inv.receipt._id, true, undefined, '78')).status).toBe(200)

      const done = await fresh(inv.receipt._id)
      expect(done.register.fiscalReceiptNumber).toBe('78')
      expect(done.completedAt).toBeTruthy()
      expect(await raw(inv.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    })

    it('a sale: a refund\'s storno cites its number as its own storno does, either side of the write', async () => {
      const w = await tillWorld(app)
      const held = await w.sell(4)
      const saleId = String(held.json.transaction.id)
      const offTheSlip = (await fresh(saleId)).register.fiscalReceiptNumber
      // Settled with a number typed off its slip, and a refund's storno holding its claim.
      await Invoice.updateOne({ _id: saleId }, { $set: { 'register.settled': { printed: true, receiptNumber: offTheSlip } } })
      await Invoice.updateOne({ _id: saleId }, { $push: { 'register.refundClaims': { stornoId: new Invoice.base.Types.ObjectId(), rate: 20, cents: 1200 } } })

      const r = await settle(w, saleId, true, undefined, '1')

      expect(r.status).toBe(409)
      expect(r.json.code).toBe('receipt_number_cited')
      expect((await fresh(saleId)).register.fiscalReceiptNumber).toBe(offTheSlip)

      // And a claim that lands between its read and its write.
      await Invoice.updateOne({ _id: saleId }, { $unset: { 'register.refundClaims': 1 } })
      const undo = during(update => !!update?.$set?.['register.settled.receiptNumber'], async () => {
        await Invoice.updateOne({ _id: saleId }, { $push: { 'register.refundClaims': { stornoId: new Invoice.base.Types.ObjectId(), rate: 20, cents: 1200 } } })
      })
      let raced: any
      try {
        raced = await settle(w, saleId, true, undefined, '1')
      } finally {
        undo()
      }
      expect(raced.json.code).toBe('receipt_number_cited')
      expect((await fresh(saleId)).register.fiscalReceiptNumber).toBe(offTheSlip)
    })
  })

  it('a number on one settled as not printed changes nothing: it printed nothing', async () => {
    const w = await tillWorld(app)
    const inv = await heldReceipt(w)
    const note = await issuedNote(w, inv)
    await pay(w, note.id, 24)

    expect((await settle(w, inv.receipt._id, false, undefined, '77')).status).toBe(200)

    const gone = await fresh(inv.receipt._id)
    expect(gone.status).toBe('voided')
    expect(gone.register.fiscalReceiptNumber).toBeUndefined()
    expect(await raw(inv.id)).toMatchObject({ amountPaid: 0 })
    expect((await pay(w, note.id, 24)).json.code).toBe('no_receipt_to_storno')
  })

  it('a text receipt has no number to bring, whatever is typed: its text storno names it by its own', async () => {
    const w = await tillWorld(app)
    const inv = await heldReceipt(w)
    await Invoice.updateOne({ _id: inv.receipt._id }, { $set: { 'register.isFiscal': false, 'register.fiscal.mode': 'text' }, $unset: { 'register.unp': 1 } })
    const note = await issuedNote(w, inv)
    await pay(w, note.id, 24)

    expect((await settle(w, inv.receipt._id, true, undefined, '77')).status).toBe(200)

    const settled = await fresh(inv.receipt._id)
    expect(settled.completedAt).toBeTruthy()
    expect(settled.register.fiscalReceiptNumber).toBeUndefined()
    expect(settled.register.settled.receiptNumber).toBeUndefined()
  })

  it('a Files rollback leaves a refund\'s storno, and says why: it is corrected by nothing but its own door', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    expect((await pay(w, note.id, 24)).status).toBe(200)
    const [storno] = await stornosOf(note.id)
    const file = await DocFile.create({
      orgId: w.oid, docType: 'cash_register', docNumber: 'X1', docDate: '2026-10-21', originalName: 'x.xlsx',
      currentPath: 'x', currentChecksum: 'x', mimeType: 'application/octet-stream', size: 1, uploadedBy: w.user._id,
      status: 'committed', committedIds: [storno._id],
    } as any)

    const plan: any = (await planDeleteDocFiles(w.orgId, [String(file._id)], { rollback: true, force: true })).plans[0]

    expect(plan.invoices[0].action).toBe('skip')
    expect(plan.warnings.join(' ')).toMatch(/cannot be edited, deleted or voided/)
  })

  it('settled not printed, and stopped before its void: `failed` and still `paid`, it gave nothing back, and no reader says it did', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    w.sim!.dropAfter = 0x38
    expect((await pay(w, note.id, 24)).json.code).toBe('receipt_in_doubt')
    w.sim!.disconnected = false
    const [storno] = await stornosOf(note.id)
    const filters = { orgId: w.orgId, dateFrom: new Date(Date.now() - 86_400_000), dateTo: new Date(Date.now() + 86_400_000) }
    // Its first step lets go of the hold: the process goes away right there.
    const dies = spyOn(Invoice, 'updateOne').mockImplementationOnce(() => { throw new Error('the pod went away') })

    expect((await settle(w, storno._id, false)).status).toBe(500)

    dies.mockRestore()
    const stopped = await fresh(storno._id)
    expect(stopped).toMatchObject({ status: 'paid' })
    expect(stopped.register.fiscal.state).toBe('failed')
    expect(stopped.completedAt).toBeUndefined()

    // Nothing moved, and none of them may say otherwise, until it is voided.
    const row = (await loadPosRows({ orgId: w.orgId, sessionId: w.sessionId, withReceipts: true })).find((t: any) => String(t._id ?? t.id) === String(storno._id)) as any
    expect(row.type).toBe('payment_storno')
    expect(stornoUnproved(row)).toBe(true)
    expect(await Invoice.countDocuments({ _id: storno._id, ...NOT_UNPROVED_STORNO })).toBe(0)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 24, totalReturns: 0 })
    const built = buildSessionReport(await sessionOf(w), await loadPosRows({ orgId: w.orgId, sessionId: w.sessionId, withReceipts: true }))
    expect(built.counts.refunds).toBeUndefined()
    expect(built.byMethod.cash).toBe(24)
    expect(await raw(note.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect(await exportReversedSales(filters)).toHaveLength(0)
    expect((await exportPaymentDetails(filters)).map((t: any) => t.transactionNumber)).toEqual([inv.receipt.invoiceNumber])

    // The next touch voids it, gives back what it held, and the refund goes on.
    await Invoice.updateOne({ _id: storno._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })
    expect((await pay(w, note.id, 24)).status).toBe(200)
    expect((await fresh(storno._id)).status).toBe('voided')
    expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 24 })
  })

  describe('a person\'s word waits for the device a refund\'s storno printed on (the third read, finding 1)', () => {
    const closedOnDevice = (w: TillWorld) => w.sim!.receipts.filter(r => !r.voided)
    /** The line drops after the payment command: its money is on the device and its receipt is open. Held. */
    async function heldOpen(w: TillWorld) {
      const inv = await paidInvoice(w)
      const note = await issuedNote(w, inv)
      w.sim!.beforeCommand = (cmd) => { if (cmd === 0x35) w.sim!.disconnected = true }
      const answer = await pay(w, note.id, 24)
      w.sim!.beforeCommand = null
      w.sim!.disconnected = false
      expect(answer.json.code).toBe('receipt_in_doubt')
      const [storno] = await stornosOf(note.id)
      expect(w.sim!.receipt?.payments.length).toBeGreaterThan(0)
      return { inv, note, storno }
    }
    const everything = async (w: TillWorld, id: unknown) => ({
      doc: await fresh(id), session: await sessionOf(w), device: w.sim!.executed.length, documents: await Invoice.countDocuments({ orgId: w.oid }),
    })

    it('the bridge gone: both refused, nothing changed; back, the receipt is open; an X report; settled printed; one storno on the device and one in LGR', async () => {
      const w = await tillWorld(app)
      const { inv, note, storno } = await heldOpen(w)
      forgetDevices()
      const before = await everything(w, storno._id)

      for (const printed of [false, true]) {
        const r = await settle(w, storno._id, printed)
        expect(r.status).toBe(409)
        expect(r.json.code).toBe('receipt_device_away')
        expect(r.json.message).toContain('Connect it')
      }
      expect(await everything(w, storno._id)).toEqual(before)

      reconnect(w)
      for (const printed of [false, true]) {
        const r = await settle(w, storno._id, printed)
        expect(r.status).toBe(409)
        expect(r.json.code).toBe('receipt_open_on_device')
      }
      expect((await fresh(storno._id)).register.settled).toBeUndefined()

      await getPrinter(w.deviceId).printDailyXReport()
      expect(w.sim!.receipt).toBeNull()

      expect((await settle(w, storno._id, true)).status).toBe(200)

      expect(closedOnDevice(w).map(r => r.kind)).toEqual(['fiscal', 'storno'])
      expect((await stornosOf(note.id)).filter(s => s.status === 'paid')).toHaveLength(1)
      expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
      expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 24 })
      expect(leftByRate(await fresh(inv.receipt._id)).size).toBe(0)
    })

    it('a device gone for good, deactivated: the word stands, its claim and its hold go back, and nothing prints', async () => {
      const w = await tillWorld(app)
      const { inv, note, storno } = await heldOpen(w)
      forgetDevices()
      expect((await settle(w, storno._id, false)).json.code).toBe('receipt_device_away')
      await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { isActive: false } })

      expect((await settle(w, storno._id, false)).status).toBe(200)

      expect((await fresh(storno._id)).status).toBe('voided')
      expect((await fresh(inv.receipt._id)).register.refundClaims ?? []).toHaveLength(0)
      expect(await raw(note.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
      expect((await raw(note.id)).receiptHolds ?? []).toHaveLength(0)
    })

    it('a busy device is told as busy, and the route goes to the document\'s own device', async () => {
      const w = await tillWorld(app)
      const { storno } = await heldOpen(w)
      expect(await deviceFromSettledDocument({ params: { orgId: w.orgId, id: String(storno._id) } } as any)).toMatchObject({ deviceNumber: 'ED123456' })
      const held = gate()
      const holding = deviceTurn(w.deviceId, () => held.closed)
      try {
        // Well past its wait in production: `waitMs` is the door's own, and this one is held for the length of it.
        const r = await settle(w, storno._id, false)
        expect(r.status).toBe(409)
        expect(r.json.code).toBe('device_busy')
      } finally {
        held.open()
        await holding
      }
      expect((await fresh(storno._id)).register.settled).toBeUndefined()
    }, 40_000)

    it('a text storno is unaffected: the device holds no money on one', async () => {
      const w = await tillWorld(app)
      w.sim!.unfiscalizedUnit = true
      const inv = await paidInvoice(w)
      const note = await issuedNote(w, inv)
      const held = gate()
      w.sim!.beforeCommand = cmd => (cmd === 0x27 ? held.closed : undefined)
      const refunding = pay(w, note.id, 24)
      await until(async () => (await stornosOf(note.id))[0]?.register?.fiscal?.attemptedAt, 'the text storno to start')
      const [storno] = await stornosOf(note.id)
      expect(storno.register).toMatchObject({ isFiscal: false })
      expect(storno.register.fiscal.mode).toBe('text')
      w.sim!.beforeCommand = null
      held.open()
      await refunding
      // Held as a request that died leaves one, its hold and its claim still there, and the bridge gone.
      await Invoice.updateOne({ _id: storno._id }, { $set: { 'register.fiscal.inDoubt': true, 'register.fiscal.state': 'unknown' }, $unset: { completedAt: 1 } })
      forgetDevices()

      expect((await settle(w, storno._id, true)).status).toBe(200)
      expect((await fresh(storno._id)).register.settled.printed).toBe(true)
    })
  })

  it('a storno that may have printed is money nobody can count on: every reader of a sum says the same', async () => {
    const row = (state: string, status = 'completed') => ({ type: 'payment_storno', status, fiscal: { state } }) as any
    for (const state of ['pending', 'unknown', 'failed']) expect(stornoUnproved(row(state))).toBe(true)
    for (const state of ['printed', 'none']) expect(stornoUnproved(row(state))).toBe(false)
    expect(stornoUnproved(row('unknown', 'cancelled'))).toBe(false)

    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    w.sim!.dropAfter = 0x38
    await pay(w, note.id, 24)
    w.sim!.disconnected = false
    const [storno] = await stornosOf(note.id)
    const seen = () => Invoice.countDocuments({ _id: storno._id, ...NOT_UNPROVED_STORNO })
    expect(await seen()).toBe(0)
    expect((await settle(w, storno._id, true)).status).toBe(200)
    expect(await seen()).toBe(1)
  })
})

describe('a Files rollback asks what stands on the document first (ruling 4)', () => {
  /** A sales invoice as a Files commit books it: analysed, committed through the real engine, issued, named by its file. */
  async function bookedByFiles(w: TillWorld, o: { type?: string; method?: string; number?: string } = {}) {
    const l = line(w)
    const number = o.number ?? '3000100974'
    const file: any = await DocFile.create({
      orgId: w.oid, docType: 'invoice', docNumber: number, docDate: TODAY(), originalName: `invoicem_${number}.pdf`,
      currentPath: `x-${number}`, currentChecksum: number, mimeType: 'application/pdf', size: 1, uploadedBy: w.user._id,
      uploadedAt: new Date(Date.now() - 60_000), status: 'analyzed',
      analysis: {
        target: 'invoice',
        mapped: {
          type: o.type ?? 'invoice', direction: 'outgoing', reference: number, currency: 'EUR', exchangeRate: 1, issueDate: TODAY(),
          lines: [l], subtotal: 20, taxTotal: 4, total: 24, paymentMethod: o.method ?? 'bank_transfer', tags: ['ocr-import'],
          billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
        },
      },
    })
    const committed = await commitDocFile(w.orgId, String(w.user._id), String(file._id), { convert: true })
    expect(committed?.ok).toBe(true)
    const stamped: any = await DocFile.findById(file._id).lean().exec()
    expect(stamped.status).toBe('committed')
    const id = String(stamped.committedIds[0])
    expect((await raw(id)).status).toBe('sent')
    expect((await raw(id)).statusHistory[0].reason).toBe('ocr_import')
    return { id, fileId: String(file._id) }
  }
  /**
   * The one line no door writes. The import's mark is what keeps a receipt off a document a commit booked
   * (`printsAtCounter`), so with it a cash payment prints nothing, and the first test here is that. Everything
   * else in this chain is the real thing: the rule must hold the day that mark no longer does.
   */
  const withoutTheMark = (id: string) => Invoice.updateOne({ _id: id }, { $set: { 'statusHistory.0.reason': 'created' } })
  const stockNow = async (w: TillWorld) => (await w.stock()).quantity
  const printedSoFar = (w: TillWorld) => w.sim!.executed.length

  it('import, a cash payment at the counter, rollback: an imported document prints nothing, so nothing holds it back', async () => {
    const w = await tillWorld(app)
    const { id, fileId } = await bookedByFiles(w)
    const shelf = await stockNow(w)

    expect((await pay(w, id, 24)).status).toBe(200)
    expect(await receiptsOf(id)).toHaveLength(0)
    expect(w.sim!.receipts).toHaveLength(0)

    const dry = await planDeleteDocFiles(w.orgId, [fileId], { rollback: true })
    expect(dry.plans[0].invoices[0].action).toBe('void')
    expect(dry.plans[0].warnings).toEqual([])

    const done = await deleteDocFiles(w.orgId, String(w.user._id), [fileId], { rollback: true, execute: true })
    expect(done.voided).toHaveLength(1)
    expect((await raw(id)).status).toBe('voided')
    expect(await stockNow(w)).toBe(shelf + 2)
  })

  it('import, a cash payment with a receipt, rollback: a dry-run shows it, and the real run leaves the invoice, the receipt and the device alone', async () => {
    const w = await tillWorld(app)
    const { id, fileId } = await bookedByFiles(w)
    await withoutTheMark(id)
    const r = await pay(w, id, 24)
    expect(r.status).toBe(200)
    const [receipt] = await receiptsOf(id)
    expect(receipt.register.fiscal.state).toBe('printed')
    const shelf = await stockNow(w)
    const device = printedSoFar(w)

    const dry: any = await planDeleteDocFiles(w.orgId, [fileId], { rollback: true })

    expect(dry.executed).toBe(false)
    expect(dry.plans[0].invoices[0].action).toBe('skip')
    expect(dry.plans[0].warnings.join(' ')).toContain('A receipt has printed for this document')
    expect(dry.plans[0].warnings.join(' ')).toContain('Correct it with a credit or a debit note')
    expect(dry.totals.invoices).toBe(0)
    expect(dry.stockImpact).toEqual([])

    // Force does not get past it: this is no question of which upload made what.
    const done: any = await deleteDocFiles(w.orgId, String(w.user._id), [fileId], { rollback: true, force: true, execute: true })

    expect(done.executed).toBe(true)
    expect(done.voided).toEqual([])
    expect(await raw(id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect(await fresh(receipt._id)).toMatchObject({ status: 'paid', completedAt: expect.anything() })
    expect(await stockNow(w)).toBe(shelf)
    expect(printedSoFar(w)).toBe(device)
    expect((await sessionOf(w)).totalCash).toBe(24)
    expect(await StockMovement.countDocuments({ orgId: w.oid, invoiceId: id, status: 'cancelled' })).toBe(0)
  })

  it('a receipt held in doubt: skipped too, and its own way out is what it says', async () => {
    const w = await tillWorld(app)
    const { id, fileId } = await bookedByFiles(w)
    await withoutTheMark(id)
    w.sim!.dropAfter = 0x38
    await pay(w, id, 24)
    w.sim!.disconnected = false
    const [receipt] = await receiptsOf(id)
    await Invoice.updateOne({ _id: receipt._id }, { $set: { 'register.fiscal.inDoubt': true }, $unset: { completedAt: 1 } })

    const dry: any = await planDeleteDocFiles(w.orgId, [fileId], { rollback: true })

    expect(dry.plans[0].invoices[0].action).toBe('skip')
    expect(dry.plans[0].warnings.join(' ')).toContain(`Nothing can prove whether receipt ${receipt.invoiceNumber} printed`)
  })

  it('a credit note whose storno printed: the device gave that money back, so it stays', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const { id, fileId } = await bookedByFiles(w, { type: 'credit_note', number: '3000100975' })
    await withoutTheMark(id)
    await Invoice.updateOne({ _id: id }, { $set: { relatedInvoiceId: inv.id } })
    expect((await pay(w, id, 24)).status).toBe(200)
    expect(await stornosOf(id)).toHaveLength(1)

    const dry: any = await planDeleteDocFiles(w.orgId, [fileId], { rollback: true })

    expect(dry.plans[0].invoices[0].action).toBe('skip')

    const done: any = await deleteDocFiles(w.orgId, String(w.user._id), [fileId], { rollback: true, execute: true })
    expect(done.voided).toEqual([])
    expect(await raw(id)).toMatchObject({ status: 'paid', amountPaid: 24 })
  })

  it('a receipt that failed holds nothing: it printed nothing, and the rollback goes through', async () => {
    const w = await tillWorld(app)
    const { id, fileId } = await bookedByFiles(w)
    await withoutTheMark(id)
    w.sim!.paper = false
    expect((await pay(w, id, 24)).status).toBe(503)
    w.sim!.paper = true
    expect((await receiptsOf(id))[0].status).toBe('voided')

    const done: any = await deleteDocFiles(w.orgId, String(w.user._id), [fileId], { rollback: true, execute: true })

    expect(done.voided).toHaveLength(1)
    expect((await raw(id)).status).toBe('voided')
  })

  it('with no rollback asked for, a file goes and says nothing of it: its bookings stay either way', async () => {
    const w = await tillWorld(app)
    const { id, fileId } = await bookedByFiles(w)
    await withoutTheMark(id)
    expect((await pay(w, id, 24)).status).toBe(200)

    const dry: any = await planDeleteDocFiles(w.orgId, [fileId], { rollback: false })

    expect(dry.plans[0].invoices[0].action).toBe('skip')
    expect(dry.plans[0].warnings).toEqual([])
  })

  it('a document a storno claimed: the plan reads what it asks about', async () => {
    const w = await tillWorld(app)
    const { id, fileId } = await bookedByFiles(w)
    await Invoice.updateOne({ _id: id }, { $set: { 'register.stornoState': 'full' } })

    const dry: any = await planDeleteDocFiles(w.orgId, [fileId], { rollback: true })

    expect(dry.plans[0].invoices[0].action).toBe('skip')
    expect(dry.plans[0].warnings.join(' ')).toMatch(/cannot be edited, deleted or voided/)
  })
})

describe('a receipt whose `unknown` stands has no door, so only its own print may leave one (the third read, finding 4)', () => {
  const closedOnDevice = (w: TillWorld) => w.sim!.receipts.filter(r => !r.voided)
  /**
   * An earlier sale's receipt, paid, left open. 3Ch is refused, and the fallback's close twice over, and then
   * it passes: a paper roll changed in that instant. The clear ignores what it said, so the next document's
   * open is refused, and its abandon is what finishes the earlier one. Answers how many closes it took.
   */
  function paidLeftover(w: TillWorld) {
    w.sim!.receipt = { kind: 'fiscal', header: [], sales: [], texts: [], payments: [{ mode: 'P', amount: 12 }], total: 12, paid: 12 }
    let closes = 0
    w.sim!.beforeCommand = (cmd) => { w.sim!.paper = !(cmd === 0x38 && ++closes <= 2) }
    return () => closes
  }

  it('a payment_receipt, a paid leftover, the fallback close failing twice and then passing: `failed`, no money booked, and nothing left for a door', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    expect((await send(w, d.id)).status).toBe(200)
    const closes = paidLeftover(w)

    const r = await pay(w, d.id, 24)

    expect(closes()).toBe(3)
    expect(r.status).toBe(503)
    expect(r.json.code).toBe('fiscal_error')
    const [receipt] = await receiptsOf(d.id)
    expect(receipt.type).toBe('payment_receipt')
    expect(receipt.register.fiscal.state).toBe('failed')
    expect(receipt.register.fiscal.inDoubt).toBeUndefined()
    expect(receipt.status).toBe('voided')
    const invoice = await raw(d.id)
    expect(invoice).toMatchObject({ status: 'sent', amountPaid: 0, amountDue: 24 })
    expect(invoice.payments).toHaveLength(0)
    expect(invoice.receiptHolds ?? []).toHaveLength(0)
    expect((await sessionOf(w)).totalCash).toBe(0)
    // The device holds only the earlier sale's, and nothing of this payment.
    expect(closedOnDevice(w).map(x => x.total)).toEqual([12])

    // It printed nothing, so its refund has nothing to cite, and it says so.
    w.sim!.beforeCommand = null
    const note = await issuedNote(w, d)
    expect((await pay(w, note.id, 24)).json.code).toBe('no_receipt_to_storno')

    // The next press prints it, and then it holds.
    expect((await pay(w, d.id, 24)).status).toBe(200)
    expect(closedOnDevice(w).map(x => x.total)).toEqual([12, 24])
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect((await pay(w, note.id, 24)).status).toBe(200)
    expect(closedOnDevice(w).map(x => x.kind)).toEqual(['fiscal', 'fiscal', 'storno'])
  })

  it('at issue, the same run: issued and unpaid, and Pay takes it', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w)
    const closes = paidLeftover(w)

    const r = await send(w, d.id)

    expect(closes()).toBe(3)
    expect(r.status).toBe(200)
    expect(r.json.receipt.state).toBe('failed')
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0, amountDue: 24 })
    expect((await sessionOf(w)).totalCash).toBe(0)
    expect(closedOnDevice(w).map(x => x.total)).toEqual([12])
  })

  it('a refund\'s storno, the same run: voided, its claim and its hold given back, nothing refunded, and the next press prints the one storno', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    const closes = paidLeftover(w)

    const r = await pay(w, note.id, 24)

    expect(closes()).toBe(3)
    expect(r.status).toBe(503)
    expect(r.json).toMatchObject({ code: 'fiscal_error', refunded: 0 })
    const [storno] = await stornosOf(note.id)
    expect(storno.register.fiscal.state).toBe('failed')
    expect(storno.status).toBe('voided')
    expect(await raw(note.id)).toMatchObject({ status: 'sent', amountPaid: 0, amountDue: 24 })
    expect((await raw(note.id)).receiptHolds ?? []).toHaveLength(0)
    expect((await fresh(inv.receipt._id)).register.refundClaims ?? []).toHaveLength(0)
    expect((await sessionOf(w)).totalCash).toBe(24)
    expect(closedOnDevice(w).map(x => x.kind)).toEqual(['fiscal', 'fiscal'])

    w.sim!.beforeCommand = null
    expect((await pay(w, note.id, 24)).status).toBe(200)
    expect(closedOnDevice(w).map(x => x.kind)).toEqual(['fiscal', 'fiscal', 'storno'])
    expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect((await sessionOf(w)).totalCash).toBe(0)
  })

  it('what does leave one, its own print with its answer lost: the device has it, its money is booked, and its refund goes by bank', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    expect((await send(w, d.id)).status).toBe(200)
    w.sim!.dropAfter = 0x38

    const r = await pay(w, d.id, 24)

    w.sim!.disconnected = false
    expect(r.status).toBe(200)
    expect(r.json.receipt.state).toBe('unknown')
    expect(closedOnDevice(w).map(x => x.total)).toEqual([24])
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect((await sessionOf(w)).totalCash).toBe(24)
    const [receipt] = await receiptsOf(d.id)
    expect(receipt.register.fiscal.inDoubt).toBeUndefined()
    expect(receipt.completedAt).toBeTruthy()
    expect((await settle(w, receipt._id, true, undefined, String(w.sim!.lastDocNumber))).json.code).toBe('receipt_not_in_doubt')

    const note = await issuedNote(w, d)
    expect((await pay(w, note.id, 24)).json.code).toBe('no_receipt_to_storno')
    expect((await pay(w, note.id, 24, 'bank_transfer')).status).toBe(200)
    expect(await stornosOf(note.id)).toHaveLength(0)
  })
})

describe('print-once, the receipt\'s own (#155): a storno on a device', () => {
  /** A storno its request left at `fiscal`, its lease lapsed: the process died there, holding what it held. */
  async function interrupted(w: TillWorld, inv: { receipt: any }, note: { id: string; total?: number }, fiscal: Record<string, unknown>, amount = 24) {
    const doc = await raw(note.id)
    const cited = await fresh(inv.receipt._id)
    const document = paymentStornoDocument({
      note: doc, cited, take: new Map([[20, Math.round(amount * 100)]]), tender: { method: 'cash', amount, date: new Date() },
      session: { id: w.sessionId, warehouseId: String(w.warehouse._id) },
      user: { id: String(w.user._id), operatorCode: '0001' },
      printer: { deviceNumber: 'ED123456' } as any,
    })
    const inserted: any = await Invoice.create({
      ...document, invoiceNumber: `CS-2026-${String(Math.floor(Math.random() * 90000) + 10000)}`, leaseUntil: new Date(Date.now() - 1000),
      register: { ...document.register, unp: 'ED123456-0001-0000099', fiscal: { state: 'pending', mode: 'fiscal', ...fiscal } },
    })
    await Invoice.updateOne({ _id: note.id }, { $push: { receiptHolds: { receiptId: inserted._id, amount } } })
    expect(await takeBudget(cited, inserted._id, new Map([[20, Math.round(amount * 100)]]))).toBe(true)
    return inserted
  }

  describe('on another note: what it holds of the same receipts (the readers, A8)', () => {
    it('dead, and it never reached the device: finished first, its claim goes back, and this one prints', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const other = await issuedNote(w, inv)
      const dead = await interrupted(w, inv, other, {})
      const note = await noteOn(w, inv)

      const r = await send(w, note.id)

      expect(r.status).toBe(200)
      expect(r.json.receipt.state).toBe('printed')
      expect((await fresh(dead._id)).status).toBe('voided')
      expect((await raw(other.id)).receiptHolds ?? []).toHaveLength(0)
      expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    })

    it('the same through /payments, whichever note asks', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const other = await issuedNote(w, inv)
      const dead = await interrupted(w, inv, other, {})
      const note = await issuedNote(w, inv)

      expect((await pay(w, note.id, 24)).status).toBe(200)

      expect((await fresh(dead._id)).status).toBe('voided')
      expect(leftByRate(await fresh(inv.receipt._id)).size).toBe(0)
    })

    it('dead, and it may have printed: held by that, and named', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const other = await issuedNote(w, inv)
      const dead = await interrupted(w, inv, other, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber - 1 })
      const note = await issuedNote(w, inv)
      const printed = w.sim!.receipts.length

      const r = await pay(w, note.id, 24)

      expect(r.status).toBe(409)
      expect(r.json.code).toBe('receipt_in_doubt')
      expect(r.json.receipt).toMatchObject({ id: String(dead._id), number: dead.invoiceNumber })
      expect(r.json.message).toContain('settle it')
      expect(w.sim!.receipts).toHaveLength(printed)
    })

    it('held: named with its own number, and settled not printed the money is there again', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const other = await issuedNote(w, inv)
      w.sim!.dropAfter = 0x38
      expect((await pay(w, other.id, 24)).json.code).toBe('receipt_in_doubt')
      w.sim!.disconnected = false
      const [held] = await stornosOf(other.id)
      const note = await issuedNote(w, inv)

      const r = await pay(w, note.id, 24)

      expect(r.status).toBe(409)
      expect(r.json.code).toBe('receipt_in_doubt')
      expect(r.json.receipt).toMatchObject({ id: String(held._id), number: held.invoiceNumber })

      // Whether it printed is what a person says; here it did not, and the device shows it closed.
      expect((await settle(w, held._id, false)).status).toBe(200)
      expect((await pay(w, note.id, 24)).status).toBe(200)
    })

    it('held on one receipt, with another holding enough: nothing stands in the way', async () => {
      const w = await tillWorld(app)
      const inv = await paidInParts(w, [12, 12])
      const other = await issuedNote(w, inv, { quantity: 1 })
      w.sim!.dropAfter = 0x38
      expect((await pay(w, other.id, 12)).json.code).toBe('receipt_in_doubt')
      w.sim!.disconnected = false
      const note = await issuedNote(w, inv, { quantity: 1 })

      expect((await pay(w, note.id, 12)).status).toBe(200)
    })

    it('a live one is nobody\'s to finish: its lease stands, and what it holds is held', async () => {
      const w = await tillWorld(app)
      const inv = await paidInvoice(w)
      const other = await issuedNote(w, inv)
      const live = await interrupted(w, inv, other, {})
      await Invoice.updateOne({ _id: live._id }, { $set: { leaseUntil: new Date(Date.now() + 60_000) } })
      const note = await issuedNote(w, inv)

      const r = await pay(w, note.id, 24)

      expect(r.status).toBe(422)
      expect(r.json.code).toBe('refund_exceeds_receipts')
      expect((await fresh(live._id)).status).toBe('paid')
    })
  })

  it('the next refund finds one that may have printed: nothing is booked and nothing prints, and a person settles it', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    const r = await interrupted(w, inv, note, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber - 1 })
    const printed = w.sim!.receipts.length

    const next = await pay(w, note.id, 24, 'card')

    expect(next.status).toBe(409)
    expect(next.json.code).toBe('receipt_in_doubt')
    expect(next.json.receipt.number).toBe(r.invoiceNumber)
    expect(w.sim!.receipts).toHaveLength(printed)
    expect(await raw(note.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect((await fresh(r._id)).register.fiscal).toMatchObject({ state: 'unknown', inDoubt: true })
    // The session cannot close over it, and the form says so.
    expect((await shown(w, note.id)).receiptInDoubt).toMatchObject({ number: r.invoiceNumber })
    const close = await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 124, card: 0, other: 0 } })
    expect(close.status).toBe(409)
    expect(close.json.code).toBe('receipts_unfinished')
    expect(close.json.receipts[0]).toMatchObject({ number: r.invoiceNumber, invoice: note.doc.invoiceNumber, inDoubt: true, kind: 'refund' })
  })

  it('one that never reached the device is given up: its hold and its claim go, and this one prints', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    const r = await interrupted(w, inv, note, {})

    expect((await pay(w, note.id, 24)).status).toBe(200)

    expect(await fresh(r._id)).toMatchObject({ status: 'voided' })
    expect((await fresh(r._id)).register.fiscal.state).toBe('failed')
    expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect((await raw(note.id)).receiptHolds ?? []).toHaveLength(0)
    expect((await fresh(inv.receipt._id)).register.refundClaims.map((c: any) => String(c.stornoId))).not.toContain(String(r._id))
  })

  it('one the device confirms never closed is given up the same way', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    const r = await interrupted(w, inv, note, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })

    expect((await pay(w, note.id, 24)).status).toBe(200)

    expect(await fresh(r._id)).toMatchObject({ status: 'voided' })
    expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
  })

  it('a print that may have gone through, in its turn: unlike a receipt no money moves, and it never prints again', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    const printed = w.sim!.receipts.length
    // The close went through, and the line dropped before its answer.
    w.sim!.dropAfter = 0x38

    const r = await pay(w, note.id, 24)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('receipt_in_doubt')
    expect(r.json.refunded).toBe(0)
    w.sim!.disconnected = false
    const [storno] = await stornosOf(note.id)
    expect(storno.register.fiscal).toMatchObject({ state: 'unknown', inDoubt: true })
    expect(await raw(note.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect((await raw(note.id)).receiptHolds).toHaveLength(1)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 24, totalReturns: 0 })

    // And the same request again finds it: nothing prints.
    const again = await pay(w, note.id, 24)
    expect(again.status).toBe(409)
    expect(w.sim!.receipts).toHaveLength(printed + 1)

    // A person who looked at the device says it did.
    expect((await settle(w, storno._id, true)).status).toBe(200)
    expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect((await raw(note.id)).receiptHolds ?? []).toHaveLength(0)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 24 })
    expect(await AuditLog.countDocuments({ orgId: w.oid, action: 'settle_receipt', entityId: storno._id })).toBe(1)
  })

  it('held, it is never voided and its claim stands: a second press of a part that would fit is refused too, with nothing printed', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    const printed = w.sim!.receipts.length
    w.sim!.dropAfter = 0x38

    const first = await pay(w, note.id, 10)

    expect(first.status).toBe(409)
    w.sim!.disconnected = false
    const [storno] = await stornosOf(note.id)
    expect(storno.status).toBe('paid')
    expect(storno.completedAt).toBeUndefined()
    expect((await fresh(inv.receipt._id)).register.refundClaims.map((c: any) => String(c.stornoId))).toEqual([String(storno._id)])
    expect(leftByRate(await fresh(inv.receipt._id)).get(20)).toBe(1400)

    // 10 more fits what is due and what the receipt holds. It is the same press, and it stays refused.
    const second = await pay(w, note.id, 10)
    expect(second.status).toBe(409)
    expect(second.json).toMatchObject({ code: 'receipt_in_doubt', receipt: { number: storno.invoiceNumber } })
    const byCard = await pay(w, note.id, 5, 'card')
    expect(byCard.json.code).toBe('receipt_in_doubt')
    expect(await stornosOf(note.id)).toHaveLength(1)
    expect(w.sim!.receipts).toHaveLength(printed + 1)

    // With its key too: the same answer, and the device sees nothing.
    const retried = await pay(w, note.id, 10)
    expect(retried.status).toBe(409)

    // The bank takes what no storno holds: that money is nobody's.
    expect((await pay(w, note.id, 14, 'bank_transfer')).status).toBe(200)
    expect(await raw(note.id)).toMatchObject({ amountPaid: 14, status: 'partially_paid' })
  })

  it('the same request under its key, once it is held: the same answer, printing nothing', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    const printed = w.sim!.receipts.length
    w.sim!.dropAfter = 0x38
    expect((await pay(w, note.id, 10, 'cash', 'refund-held-key')).status).toBe(409)
    w.sim!.disconnected = false

    const again = await pay(w, note.id, 10, 'cash', 'refund-held-key')

    expect(again.status).toBe(409)
    expect(again.json.code).toBe('receipt_in_doubt')
    expect(w.sim!.receipts).toHaveLength(printed + 1)
    expect(await stornosOf(note.id)).toHaveLength(1)
  })

  it('at issue: issued, its goods back, nothing refunded, and the answer says check the device', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv)
    w.sim!.dropAfter = 0x38

    const r = await send(w, note.id)

    expect(r.status).toBe(200)
    expect(r.json.receipt.state).toBe('unknown')
    expect(r.json.receiptError).toContain('settle')
    w.sim!.disconnected = false
    expect(await raw(note.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect((await stornosOf(note.id))[0].status).toBe('paid')
    expect((await stornosOf(note.id))[0].register.fiscal.inDoubt).toBe(true)
  })

  it('settled as not printed: voided, its hold and its claim go, and nothing moved', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    const r = await interrupted(w, inv, note, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber - 1 })
    await pay(w, note.id, 24, 'card')

    expect((await settle(w, r._id, false)).status).toBe(200)

    expect(await fresh(r._id)).toMatchObject({ status: 'voided' })
    expect(await raw(note.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect((await raw(note.id)).receiptHolds ?? []).toHaveLength(0)
    expect(leftByRate(await fresh(inv.receipt._id)).get(20)).toBe(2400)
    expect((await pay(w, note.id, 24)).status).toBe(200)
  })

  it('the device still holds it open: nothing is final, either way, until it is cleared', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    // The line went as its lines did, so the device holds it open, with no money on it yet.
    w.sim!.beforeCommand = cmd => { if (cmd === 0x31) w.sim!.disconnected = true }
    const first = await pay(w, note.id, 24)
    w.sim!.beforeCommand = null
    w.sim!.disconnected = false
    expect(first.json.code).toBe('receipt_in_doubt')
    const [storno] = await stornosOf(note.id)
    expect(w.sim!.receipt).not.toBeNull()

    for (const printed of [true, false]) {
      const r = await settle(w, storno._id, printed)
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('receipt_open_on_device')
    }
    expect((await fresh(storno._id)).register.fiscal.inDoubt).toBe(true)
    expect((await fresh(storno._id)).register.settled).toBeUndefined()

    await getPrinter(w.deviceId).printDailyXReport()
    expect(w.sim!.receipt).toBeNull()
    expect((await settle(w, storno._id, false)).status).toBe(200)

    expect(await fresh(storno._id)).toMatchObject({ status: 'voided' })
    expect(leftByRate(await fresh(inv.receipt._id)).get(20)).toBe(2400)
    expect((await pay(w, note.id, 24)).status).toBe(200)
  })

  it('a settle that stopped halfway is finished by the next touch, with no device, and what was said stands', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    const r = await interrupted(w, inv, note, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber - 1 })
    await pay(w, note.id, 24, 'card')
    // Claimed and said, and the process died before the money.
    await Invoice.updateOne({ _id: r._id }, {
      $set: { 'register.settled': { printed: true, by: w.user._id, at: new Date() }, 'register.fiscal.state': 'printed', leaseUntil: new Date(Date.now() - 1000) },
      $unset: { 'register.fiscal.inDoubt': 1 },
    })
    const printed = w.sim!.receipts.length

    const again = await settle(w, r._id, false)
    expect(again.status).toBe(409)
    expect(again.json.code).toBe('receipt_already_settled')
    expect(again.json.message).toContain('storno')

    // The next press finds it: the money went back, it is written down, and nothing printed.
    const next = await pay(w, note.id, 24)
    expect(next.status).toBe(400)
    expect(w.sim!.receipts).toHaveLength(printed)
    expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect(await AuditLog.countDocuments({ orgId: w.oid, action: 'settle_receipt', entityId: r._id })).toBe(1)
  })

  it('settling takes a storno\'s roles: it decides what happened to money', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    const r = await interrupted(w, inv, note, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber - 1 })
    await pay(w, note.id, 24, 'card')
    expect((await settle(w, r._id, true, await w.tokenAs('accountant'))).status).toBe(403)
    expect((await fresh(r._id)).register.fiscal.inDoubt).toBe(true)
  })

  it('a retry whose first attempt died between the print and the money: the money, and no second storno', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    const printed = w.sim!.receipts.length
    const real = Invoice.collection.findOneAndUpdate
    // The money is the one write with a pipeline: everything before it goes through.
    ;(Invoice.collection as any).findOneAndUpdate = function (filter: any, update: any, ...rest: any[]) {
      if (Array.isArray(update)) throw new Error('the process died')
      return (real as any).call(Invoice.collection, filter, update, ...rest)
    }
    const first = await pay(w, note.id, 24, 'cash', 'refund-money-died').catch(() => null)
    ;(Invoice.collection as any).findOneAndUpdate = real
    expect(first?.status ?? 500).toBe(500)
    expect(w.sim!.receipts).toHaveLength(printed + 1)
    await Invoice.updateOne({ type: 'payment_storno', 'register.refundOf': note.id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })

    const second = await pay(w, note.id, 24, 'cash', 'refund-money-died')

    expect(second.status).toBe(200)
    expect(w.sim!.receipts).toHaveLength(printed + 1)
    expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect((await raw(note.id)).payments).toHaveLength(1)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 24 })
  })

  it('a session that closed before its turn came: it did not print, and its hold and its claim go', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    const real = Invoice.create
    ;(Invoice as any).create = async function (...args: any[]) {
      const out = await (real as any).apply(Invoice, args)
      await POSSession.updateOne({ _id: w.sessionId }, { $set: { status: 'closed' } })
      return out
    }
    let r: any
    try {
      r = await pay(w, note.id, 24)
    } finally {
      ;(Invoice as any).create = real
    }
    expect(r.status).toBe(503)
    expect(await raw(note.id)).toMatchObject({ amountPaid: 0 })
    expect((await fresh(inv.receipt._id)).register.refundClaims).toHaveLength(0)
  })
})

describe('an invoice issued for a till sale (R0): the refund cites the sale\'s own receipt', () => {
  /** A till sale of 48.00 and an invoice for it, issued: that sale took the money. */
  async function invoicedSale(w: TillWorld, quantity = 4, o: { nonFiscal?: boolean } = {}) {
    const sale = await w.sell(quantity, o)
    expect(sale.status).toBe(200)
    const saleId = String(sale.json.transaction.id ?? sale.json.transaction._id)
    const contact = await draftOf(w, { method: 'bank_transfer' })
    const res = await w.call('POST', `/invoices/${saleId}/to-invoice`, { contactId: contact.contactId })
    expect(res.status).toBe(200)
    const id = String(res.json.invoice.id)
    return { saleId, id, contactId: contact.contactId, sale: await fresh(saleId) }
  }

  it('its number, its УНП and its budget; the rest of the sale stays in it', async () => {
    const w = await tillWorld(app)
    const inv = await invoicedSale(w)
    const note = await issuedNote(w, inv, { quantity: 1 })

    const r = await pay(w, note.id, 12)

    expect(r.status).toBe(200)
    const receipt = w.sim!.receipts.at(-1)!
    expect(receipt.kind).toBe('storno')
    expect(receipt.header[1]).toBe(inv.sale.register.unp)
    expect(receipt.header[5]).toBe(inv.sale.register.fiscalReceiptNumber)
    const [storno] = await stornosOf(note.id)
    expect(String(storno.register.storno.originalId)).toBe(inv.saleId)
    expect(leftByRate(await fresh(inv.saleId)).get(20)).toBe(3600)
  })

  it('at issue too, and beyond what the invoice took: 422', async () => {
    const w = await tillWorld(app)
    const inv = await invoicedSale(w, 1)
    const note = await noteOn(w, inv, { quantity: 1 })
    expect((await send(w, note.id)).status).toBe(200)
    expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 12 })
    const beyond = await issuedNote(w, inv, { quantity: 1 })
    const r = await pay(w, beyond.id, 12)
    expect(r.status).toBe(422)
    expect(r.json).toMatchObject({ code: 'refund_exceeds_paid', left: 0 })
  })

  it('a sale whose fiscal receipt may have printed cannot be reversed until a person says: it has no budget', async () => {
    const w = await tillWorld(app)
    const inv = await invoicedSale(w)
    await Invoice.updateOne({ _id: inv.saleId }, { $set: { 'register.fiscal.state': 'unknown' }, $unset: { 'register.fiscalReceiptNumber': 1 } })
    const note = await issuedNote(w, inv, { quantity: 1 })
    const before = await footprint(w)

    const r = await pay(w, note.id, 12)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('sale_receipt_in_doubt')
    expect(r.json.receipt.number).toBe(inv.sale.invoiceNumber)
    expect(await footprint(w)).toEqual(before)
  })

  it('the same of a sale whose request died, still pending; one still printing says so', async () => {
    const w = await tillWorld(app)
    const inv = await invoicedSale(w)
    await Invoice.updateOne({ _id: inv.saleId }, { $set: { 'register.fiscal.state': 'pending', leaseUntil: new Date(Date.now() + 60_000) }, $unset: { 'register.fiscalReceiptNumber': 1 } })
    const note = await issuedNote(w, inv, { quantity: 1 })
    expect((await pay(w, note.id, 12)).json.code).toBe('payment_in_progress')

    await Invoice.updateOne({ _id: inv.saleId }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })
    expect((await pay(w, note.id, 12)).json.code).toBe('sale_receipt_in_doubt')
  })

  it('settled as printed with the number off its slip: the refund cites that number and takes from the sale', async () => {
    const w = await tillWorld(app)
    const inv = await invoicedSale(w)
    const offTheSlip = String(Number((await fresh(inv.saleId)).register.fiscalReceiptNumber))
    await Invoice.updateOne({ _id: inv.saleId }, { $set: { 'register.fiscal.state': 'unknown' }, $unset: { 'register.fiscalReceiptNumber': 1 } })
    const note = await issuedNote(w, inv, { quantity: 1 })
    expect((await pay(w, note.id, 12)).json.code).toBe('sale_receipt_in_doubt')

    expect((await settle(w, inv.saleId, true, undefined, offTheSlip)).status).toBe(200)

    const r = await pay(w, note.id, 12)
    expect(r.status).toBe(200)
    const printed = w.sim!.receipts.at(-1)!
    expect(printed.kind).toBe('storno')
    expect(printed.header[5]).toBe(offTheSlip)
    expect(leftByRate(await fresh(inv.saleId)).get(20)).toBe(3600)
    expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 12 })
  })

  describe('a sale nobody finished comes first: nothing of it is booked yet (the third read, finding 5)', () => {
    /** As its request left it: printed or on a text slip, and its session's totals never applied. */
    async function stoppedBeforeItsTotals(w: TillWorld, saleId: string, leaseUntil: Date) {
      const sale = await fresh(saleId)
      await Invoice.updateOne({ _id: saleId }, { $unset: { completedAt: 1, 'register.sessionTotalsApplied': 1 }, $set: { leaseUntil } })
      await POSSession.updateOne({ _id: w.sessionId }, { $inc: { totalCash: -sale.total, totalSales: -sale.total, transactionCount: -1 } })
    }
    const lapsed = () => new Date(Date.now() - 1000)
    const stillRunning = () => new Date(Date.now() + 60_000)

    it('a text sale whose request died: it is booked first, and the refund comes out of a drawer that has it', async () => {
      const w = await tillWorld(app)
      w.sim!.unfiscalizedUnit = true
      const inv = await invoicedSale(w, 4, { nonFiscal: true })
      expect(inv.sale.register.fiscal.mode).toBe('text')
      const note = await issuedNote(w, inv, { quantity: 1 })
      await stoppedBeforeItsTotals(w, inv.saleId, lapsed())
      expect((await sessionOf(w)).totalCash).toBe(0)

      const r = await pay(w, note.id, 12)

      expect(r.status).toBe(200)
      expect((await fresh(inv.saleId)).completedAt).toBeTruthy()
      expect(await sessionOf(w)).toMatchObject({ totalCash: 36, totalSales: 48, totalReturns: 12 })
      expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 12 })
      // Its stock moved once, by its own request: finishing it does not dispatch it again.
      expect(await StockMovement.countDocuments({ orgId: w.oid, invoiceId: inv.saleId })).toBe(1)
    })

    it('a fiscal sale past its print, whose request died: the same, by the number it printed', async () => {
      const w = await tillWorld(app)
      const inv = await invoicedSale(w)
      const note = await issuedNote(w, inv, { quantity: 1 })
      await stoppedBeforeItsTotals(w, inv.saleId, lapsed())

      const r = await pay(w, note.id, 12)

      expect(r.status).toBe(200)
      expect(w.sim!.receipts.at(-1)!.header[5]).toBe(inv.sale.register.fiscalReceiptNumber)
      expect(await sessionOf(w)).toMatchObject({ totalCash: 36, totalSales: 48, totalReturns: 12 })
    })

    for (const [kind, text] of [['text', true], ['fiscal', false]] as const) {
      it(`a ${kind} sale still being rung up: told so, with nothing written and nothing finished under it`, async () => {
        const w = await tillWorld(app)
        if (text) w.sim!.unfiscalizedUnit = true
        const inv = await invoicedSale(w, 4, { nonFiscal: text })
        const note = await issuedNote(w, inv, { quantity: 1 })
        await stoppedBeforeItsTotals(w, inv.saleId, stillRunning())
        const before = await footprint(w)

        const r = await pay(w, note.id, 12)

        expect(r.status).toBe(409)
        expect(r.json.code).toBe('payment_in_progress')
        expect(await footprint(w)).toEqual(before)
        expect((await fresh(inv.saleId)).completedAt).toBeUndefined()
        expect((await sessionOf(w)).totalCash).toBe(0)
        expect((await shown(w, note.id)).refundable).toBe(0)
      })
    }

    it('one whose finish throws holds the refund too: it never gives back what was not booked', async () => {
      const w = await tillWorld(app)
      w.sim!.unfiscalizedUnit = true
      const inv = await invoicedSale(w, 4, { nonFiscal: true })
      const note = await issuedNote(w, inv, { quantity: 1 })
      await stoppedBeforeItsTotals(w, inv.saleId, lapsed())
      const undo = during(update => !!update?.$set?.completedAt, async () => { throw new Error('the pod went away') })
      let r: any
      try {
        r = await pay(w, note.id, 12)
      } finally {
        undo()
      }

      expect(r.status).toBe(409)
      expect(r.json.code).toBe('payment_in_progress')
      expect(await stornosOf(note.id)).toHaveLength(0)
      expect((await raw(note.id)).amountPaid).toBe(0)

      // Its lease lapses in time, and the next press finishes it and goes on.
      await Invoice.updateOne({ _id: inv.saleId }, { $set: { leaseUntil: lapsed() } })
      expect((await pay(w, note.id, 12)).status).toBe(200)
      expect(await sessionOf(w)).toMatchObject({ totalCash: 36, totalSales: 48 })
    })

    it('a fiscal sale that died before its print: booked, its money stands, and a person says before anything cites it', async () => {
      const w = await tillWorld(app)
      const inv = await invoicedSale(w)
      const note = await issuedNote(w, inv, { quantity: 1 })
      await stoppedBeforeItsTotals(w, inv.saleId, lapsed())
      await Invoice.updateOne({ _id: inv.saleId }, { $set: { 'register.fiscal.state': 'pending' }, $unset: { 'register.fiscalReceiptNumber': 1 } })

      const r = await pay(w, note.id, 12)

      expect(r.status).toBe(409)
      expect(r.json.code).toBe('sale_receipt_in_doubt')
      expect((await fresh(inv.saleId)).completedAt).toBeTruthy()
      expect((await fresh(inv.saleId)).register.fiscal.state).toBe('unknown')
      expect(await sessionOf(w)).toMatchObject({ totalCash: 48, totalSales: 48 })
      expect(await stornosOf(note.id)).toHaveLength(0)
    })
  })

  it('settled as not printed: it holds nothing and the refund goes by bank, with the sale\'s money standing', async () => {
    const w = await tillWorld(app)
    const inv = await invoicedSale(w)
    await Invoice.updateOne({ _id: inv.saleId }, { $set: { 'register.fiscal.state': 'unknown' }, $unset: { 'register.fiscalReceiptNumber': 1 } })
    const note = await issuedNote(w, inv, { quantity: 1 })

    expect((await settle(w, inv.saleId, false)).status).toBe(200)

    expect(await fresh(inv.saleId)).toMatchObject({ status: 'paid' })
    const r = await pay(w, note.id, 12)
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('no_receipt_to_storno')
    expect((await pay(w, note.id, 12, 'bank_transfer')).status).toBe(200)
  })

  it('a sale that printed nothing has nothing to cite', async () => {
    const w = await tillWorld(app)
    const inv = await invoicedSale(w)
    await Invoice.updateOne({ _id: inv.saleId }, { $set: { 'register.fiscal.state': 'none' }, $unset: { 'register.fiscalReceiptNumber': 1 } })
    const note = await issuedNote(w, inv, { quantity: 1 })
    expect((await pay(w, note.id, 12)).json.code).toBe('no_receipt_to_storno')
  })

  describe('R3 meets it here: what reverses the sale takes from one budget', () => {
    it('a sale a full storno reversed holds nothing', async () => {
      const w = await tillWorld(app)
      const inv = await invoicedSale(w)
      await Invoice.updateOne({ _id: inv.saleId }, { $set: { 'register.stornoState': 'full' } })
      const note = await issuedNote(w, inv, { quantity: 1 })
      const r = await pay(w, note.id, 12)
      expect(r.status).toBe(422)
      expect(r.json).toMatchObject({ code: 'refund_exceeds_receipts', left: 0 })
      expect(await takeBudget(await fresh(inv.saleId), new Invoice.base.Types.ObjectId(), new Map([[20, 100]]))).toBe(false)
    })

    it('a sale a refund took from cannot be stornoed whole, even with its invoice gone: refused by name', async () => {
      const w = await tillWorld(app)
      const inv = await invoicedSale(w)
      const note = await issuedNote(w, inv, { quantity: 1 })
      expect((await pay(w, note.id, 12)).status).toBe(200)
      expect((await w.call('POST', `/invoices/${inv.id}/void`, {})).status).toBe(200)

      const r = await w.storno(inv.saleId)

      expect(r.status).toBe(409)
      expect(r.json.code).toBe('cash_sale_refunded')
      expect((await fresh(inv.saleId)).register.stornoState).not.toBe('full')
    })

    it('of a full storno and a refund at once, one gives way: the storno finds the claim the read before it missed', async () => {
      const w = await tillWorld(app)
      const sale = await w.sell(1)
      const saleId = String(sale.json.transaction.id ?? sale.json.transaction._id)
      const printed = w.sim!.receipts.length
      const real = Invoice.exists
      let once = false
      // The refund's claim lands between the storno's refusal check and its claim.
      ;(Invoice as any).exists = function (...args: any[]) {
        const result = (real as any).apply(Invoice, args)
        if (once || !args[0]?.['cashSaleRef.cashSaleId']) return result
        once = true
        return { exec: async () => {
          const out = await result.exec()
          expect(await takeBudget(await fresh(saleId), new Invoice.base.Types.ObjectId(), new Map([[20, 100]]))).toBe(true)
          return out
        } }
      }
      let r: any
      try {
        r = await w.storno(saleId)
      } finally {
        ;(Invoice as any).exists = real
      }
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('storno_in_progress')
      expect(w.sim!.receipts).toHaveLength(printed)
      expect((await fresh(saleId)).register.stornoState).not.toBe('full')
    })
  })
})

describe('an issue whose refund stopped after a part printed says how much went back (the readers, A2 and B2)', () => {
  /** Its first storno done. */
  const firstPartDone = (update: any) => !!update?.$set?.completedAt
  /** `/send` as the form sends it, `meanwhile` right after the first part, through what the form reads. */
  async function issuedThroughTheForm(w: TillWorld, id: string, meanwhile: () => Promise<unknown>) {
    let answer: any
    const client: any = { post: async () => { answer = (await send(w, id)); return { data: answer.json } } }
    const undo = justAfter(firstPartDone, meanwhile)
    try {
      const issued = await sendIssue(client, '', id)
      return { answer, issued, notice: issuedReceiptNotice(issued) }
    } finally {
      undo()
    }
  }
  const onDevice = (w: TillWorld) => w.sim!.receipts.filter(r => !r.voided && r.kind === 'storno').map(r => r.total)

  it('the second print fails: 10 went back, the answer says so on its stornos, and the screen does not say nothing did', async () => {
    const w = await tillWorld(app)
    const inv = await paidInParts(w, [14, 10])
    const note = await noteOn(w, inv)

    const { answer, issued, notice } = await issuedThroughTheForm(w, note.id, async () => { w.sim!.paper = false })

    w.sim!.paper = true
    expect(answer.status).toBe(200)
    expect(answer.json.refunded).toBe(10)
    expect(answer.json.stornos.map((s: any) => [s.amount, s.state])).toEqual([[10, 'printed'], [14, 'failed']])
    expect(await raw(note.id)).toMatchObject({ status: 'partially_paid', amountPaid: 10, amountDue: 14 })
    expect(onDevice(w)).toEqual([10])
    expect(await sessionOf(w)).toMatchObject({ totalCash: 14, totalReturns: 10 })

    expect(issued.refunded).toBe(10)
    expect(issued.stornos).toHaveLength(2)
    expect(notice).toEqual({ key: 'cashRegister.receipt.issuedPartlyRefunded', takesPayment: true })

    // The way on is what it says: the rest goes back with Refund.
    expect((await pay(w, note.id, 14)).status).toBe(200)
    expect(onDevice(w)).toEqual([10, 14])
  })

  it('two receipts of 12, the second storno\'s open fails: the same', async () => {
    const w = await tillWorld(app)
    const inv = await paidInParts(w, [12, 12])
    const note = await noteOn(w, inv)
    const fails = () => { w.sim!.beforeCommand = (cmd) => { if (cmd === 0x90) throw new Error('Bridge disconnected') } }

    const { answer, notice } = await issuedThroughTheForm(w, note.id, async () => fails())

    w.sim!.beforeCommand = null
    expect(answer.json.refunded).toBe(12)
    expect(answer.json.stornos.map((s: any) => s.state)).toEqual(['printed', 'failed'])
    expect(notice?.key).toBe('cashRegister.receipt.issuedPartlyRefunded')
    expect(await sessionOf(w)).toMatchObject({ totalCash: 12, totalReturns: 12 })
  })

  it('the second part refused, another note took the older receipt: the refusal keeps what the first part did', async () => {
    const w = await tillWorld(app)
    const inv = await paidInParts(w, [14, 10])
    const other = await issuedNote(w, inv)
    const note = await noteOn(w, inv)

    const { answer, issued, notice } = await issuedThroughTheForm(w, note.id, () => pay(w, other.id, 14))

    expect(answer.status).toBe(200)
    expect(answer.json.refunded).toBe(10)
    expect(answer.json.stornos.map((s: any) => [s.amount, s.state])).toEqual([[10, 'printed']])
    expect(answer.json.receiptError).toBeTruthy()
    expect(await raw(note.id)).toMatchObject({ status: 'partially_paid', amountPaid: 10 })
    expect(issued.refunded).toBe(10)
    expect(notice).toEqual({ key: 'cashRegister.receipt.issuedPartlyRefunded', takesPayment: true })
  })

  it('a second part held in doubt: part of it went back, and Refund is no way on until a person says', async () => {
    const w = await tillWorld(app)
    const inv = await paidInParts(w, [14, 10])
    const note = await noteOn(w, inv)

    const { answer, notice } = await issuedThroughTheForm(w, note.id, async () => { w.sim!.dropAfter = 0x38 })

    w.sim!.disconnected = false
    expect(answer.json.refunded).toBe(10)
    expect(answer.json.stornos.map((s: any) => s.state)).toEqual(['printed', 'unknown'])
    expect(notice).toEqual({ key: 'cashRegister.receipt.issuedPartlyRefunded', takesPayment: false })
  })

  it('a retry that finds a part printed and the next one refused: the same on its own path', async () => {
    const w = await tillWorld(app)
    const inv = await paidInParts(w, [14, 10])
    const other = await issuedNote(w, inv)
    const note = await noteOn(w, inv)
    const undo = justAfter(firstPartDone, () => { throw new Error('the pod went away') })
    try {
      expect((await send(w, note.id, 'part-then-refused')).status).toBe(500)
    } finally {
      undo()
    }
    expect((await pay(w, other.id, 14)).status).toBe(200)

    const r = await send(w, note.id, 'part-then-refused')

    expect(r.status).toBe(200)
    expect(r.json.refunded).toBe(10)
    expect(r.json.stornos.map((s: any) => s.amount)).toEqual([10])
    expect(r.json.receiptError).toBeTruthy()
  })

  it('nothing went back: the words stay what they were, and a refund that went through says nothing', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv)
    w.sim!.paper = false
    const failed = await send(w, note.id)
    w.sim!.paper = true
    expect(failed.json.refunded).toBe(0)
    expect(issuedReceiptNotice({ ...failed.json.invoice, receiptError: failed.json.receiptError, refunded: failed.json.refunded, receipt: failed.json.receipt }))
      .toEqual({ key: 'cashRegister.receipt.issuedNotRefunded', takesPayment: true })
  })
})

describe('a refund that prints is capped at what the customer paid on the invoice (the readers, A1)', () => {
  /** A till sale of 48, and an invoice for one unit of it, 12. */
  async function invoicedInPart(w: TillWorld) {
    const sale = await w.sell(4)
    expect(sale.status).toBe(200)
    const saleId = String(sale.json.transaction.id)
    const contact = await draftOf(w, { method: 'bank_transfer' })
    const state = (await w.call('GET', `/invoices/${saleId}/to-invoice`)).json.invoicing
    const res = await w.call('POST', `/invoices/${saleId}/to-invoice`, { contactId: contact.contactId, lines: [{ lineId: state.lines[0].lineId, quantity: 1 }] })
    expect(res.status).toBe(200)
    expect(res.json.invoice.total).toBe(12)
    return { saleId, id: String(res.json.invoice.id), contactId: contact.contactId }
  }
  const stornoCount = (w: TillWorld) => w.sim!.receipts.filter(r => r.kind === 'storno').length

  it('an invoice for part of a sale: sale 48, invoice 12, a note of 48 in cash is refused as it is issued, with what the cap leaves', async () => {
    const w = await tillWorld(app)
    const inv = await invoicedInPart(w)
    const note = await noteOn(w, inv, { quantity: 4 })
    const before = await footprint(w)

    const r = await send(w, note.id)

    expect(r.status).toBe(422)
    expect(r.json.code).toBe('refund_exceeds_paid')
    expect(r.json.left).toBe(12)
    expect(r.json.atIssue).toBe(true)
    expect(r.json.message).toContain('by bank')
    expect(r.json.message).toContain('storno')
    expect(await footprint(w)).toEqual(before)
    expect((await raw(note.id)).status).toBe('draft')
    expect(stornoCount(w)).toBe(0)
  })

  it('the same through /payments: 48 refused, 12 goes back on the sale\'s receipt, and the bank takes the rest', async () => {
    const w = await tillWorld(app)
    const inv = await invoicedInPart(w)
    const note = await issuedNote(w, inv, { quantity: 4 })

    const over = await pay(w, note.id, 48)
    expect(over.status).toBe(422)
    expect(over.json).toMatchObject({ code: 'refund_exceeds_paid', left: 12 })
    expect(over.json.atIssue).toBeUndefined()
    expect(stornoCount(w)).toBe(0)

    expect((await pay(w, note.id, 12)).status).toBe(200)
    expect(stornoCount(w)).toBe(1)
    expect(leftByRate(await fresh(inv.saleId)).get(20)).toBe(3600)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 36, totalReturns: 12 })

    // What the cap leaves is nothing now. By card too: it is the money, not the method.
    const card = await pay(w, note.id, 1, 'card')
    expect(card.status).toBe(422)
    expect(card.json).toMatchObject({ code: 'refund_exceeds_paid', left: 0 })

    // A bank refund takes no cap: it touches neither the device nor the drawer.
    expect((await pay(w, note.id, 36, 'bank_transfer')).status).toBe(200)
    expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 48 })
    expect(stornoCount(w)).toBe(1)
  })

  it('a bank refund on one note and a cash one on another: notes of 24 and 24 on an invoice of 24', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const byBank = await issuedNote(w, inv)
    expect((await pay(w, byBank.id, 24, 'bank_transfer')).status).toBe(200)
    const inCash = await noteOn(w, inv)

    const r = await send(w, inCash.id)

    expect(r.status).toBe(422)
    expect(r.json).toMatchObject({ code: 'refund_exceeds_paid', left: 0, atIssue: true })
    expect((await raw(inCash.id)).status).toBe('draft')
    expect(stornoCount(w)).toBe(0)
    expect((await sessionOf(w)).totalCash).toBe(24)
    expect(leftByRate(await fresh(inv.receipt._id)).get(20)).toBe(2400)
  })

  it('a note refunded in parts: its earlier parts count, the last one goes through, and another note has nothing left', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)

    expect((await pay(w, note.id, 10)).status).toBe(200)
    expect((await pay(w, note.id, 14, 'card')).status).toBe(200)
    expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24 })

    const another = await issuedNote(w, inv)
    const r = await pay(w, another.id, 1)
    expect(r.status).toBe(422)
    expect(r.json).toMatchObject({ code: 'refund_exceeds_paid', left: 0 })
  })

  it('a part by bank on one note and the rest in cash on another: the cash is capped at the rest', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const first = await issuedNote(w, inv, { quantity: 1 })
    expect((await pay(w, first.id, 10, 'bank_transfer')).status).toBe(200)
    const second = await issuedNote(w, inv)

    const over = await pay(w, second.id, 24)
    expect(over.status).toBe(422)
    expect(over.json).toMatchObject({ code: 'refund_exceeds_paid', left: 14 })

    expect((await pay(w, second.id, 14)).status).toBe(200)
    expect(await raw(second.id)).toMatchObject({ status: 'partially_paid', amountPaid: 14 })
  })

  it('a part-paid invoice: what it took, never its total', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    expect((await send(w, d.id)).status).toBe(200)
    expect((await pay(w, d.id, 10)).status).toBe(200)

    const atIssue = await send(w, (await noteOn(w, d)).id)
    expect(atIssue.status).toBe(422)
    expect(atIssue.json).toMatchObject({ code: 'refund_exceeds_paid', left: 10, atIssue: true })

    const note = await issuedNote(w, d)
    const over = await pay(w, note.id, 24)
    expect(over.status).toBe(422)
    expect(over.json).toMatchObject({ code: 'refund_exceeds_paid', left: 10 })
    expect((await shown(w, note.id)).refundable).toBe(10)

    expect((await pay(w, note.id, 10)).status).toBe(200)
    expect(await raw(note.id)).toMatchObject({ amountPaid: 10 })
  })

  it('what a note gave back and then was voided, or never gave, does not count', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const gone = await issuedNote(w, inv)
    expect((await w.call('POST', `/invoices/${gone.id}/void`)).status).toBe(200)
    await issuedNote(w, inv)
    const note = await issuedNote(w, inv)

    expect((await pay(w, note.id, 24)).status).toBe(200)
  })

  it('what is unresolved on the invoice may be the money this needs: its way out comes before the cap', async () => {
    const w = await tillWorld(app)
    const inv = await paidInParts(w, [14, 10])
    await Invoice.updateOne({ _id: inv.receipts[1]._id }, { $set: { 'register.fiscal.inDoubt': true, 'register.fiscal.state': 'unknown' }, $unset: { completedAt: 1 } })
    await Invoice.updateOne({ _id: inv.id }, { $inc: { amountPaid: -10 } })
    const note = await issuedNote(w, inv)

    const r = await pay(w, note.id, 24)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('receipt_in_doubt')
  })

  it('what the dialog is told is what the cap leaves, when that is less than the receipts hold', async () => {
    const w = await tillWorld(app)
    const inv = await invoicedInPart(w)
    const note = await issuedNote(w, inv, { quantity: 4 })
    expect((await shown(w, note.id)).refundable).toBe(12)
  })

  it('a race past the guard is the budget\'s: never over the receipt', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const a = await issuedNote(w, inv)
    const b = await issuedNote(w, inv)

    const [one, two] = await Promise.all([pay(w, a.id, 24), pay(w, b.id, 24)])

    expect([one.status, two.status].sort()).toEqual([200, 422])
    expect(stornoCount(w)).toBe(1)
  })
})

describe('a till sale\'s invoice stands under its note\'s storno (the readers, B3)', () => {
  /** A till sale of 24, its invoice, and a credit note of 24 issued by bank. */
  async function invoiced(w: TillWorld) {
    const sale = await w.sell(2)
    const saleId = String(sale.json.transaction.id)
    const contact = await draftOf(w, { method: 'bank_transfer' })
    const res = await w.call('POST', `/invoices/${saleId}/to-invoice`, { contactId: contact.contactId })
    expect(res.status).toBe(200)
    const inv = { saleId, id: String(res.json.invoice.id), contactId: contact.contactId }
    return { inv, note: await issuedNote(w, inv) }
  }
  const voidIt = (w: TillWorld, id: string) => w.call('POST', `/invoices/${id}/void`)

  it('a storno printed for part of it: the void names the note, and the rest of the refund and the note\'s own edits go on', async () => {
    const w = await tillWorld(app)
    const { inv, note } = await invoiced(w)
    expect((await pay(w, note.id, 12)).status).toBe(200)
    const stock = (await w.stock()).quantity

    const r = await voidIt(w, inv.id)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('fiscally_paid')
    expect(r.json.document).toBe(note.doc.invoiceNumber)
    expect(r.json.message).toContain(note.doc.invoiceNumber)
    expect(await raw(inv.id)).toMatchObject({ status: 'paid' })
    expect((await raw(inv.id)).voidingUntil ?? null).toBeNull()
    expect((await w.stock()).quantity).toBe(stock)

    // With the invoice standing, the note's edit is no longer refused for what it corrects.
    expect((await w.call('PUT', `/invoices/${note.id}`, { notes: 'edited' })).status).toBe(200)

    expect((await pay(w, note.id, 12)).status).toBe(200)
    expect(w.sim!.receipts.at(-1)!.header[5]).toBe((await fresh(inv.saleId)).register.fiscalReceiptNumber)
    expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24 })

    // A new invoice for the sale is unreachable by this road: its invoice stands, and it covers the sale.
    const again = await w.call('POST', `/invoices/${inv.saleId}/to-invoice`, { contactId: inv.contactId })
    expect(again.status).not.toBe(200)
    expect(await Invoice.countDocuments({ orgId: w.oid, type: 'invoice', 'cashSaleRef.cashSaleId': inv.saleId })).toBe(1)
  })

  it('a storno held in doubt: refused too, in its own words, with the way to settle it', async () => {
    const w = await tillWorld(app)
    const { inv, note } = await invoiced(w)
    w.sim!.dropAfter = 0x38
    expect((await pay(w, note.id, 12)).json.code).toBe('receipt_in_doubt')
    w.sim!.disconnected = false
    const [storno] = await stornosOf(note.id)

    const r = await voidIt(w, inv.id)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('receipt_in_doubt')
    expect(r.json.receipt.number).toBe(storno.invoiceNumber)
    expect(await raw(inv.id)).toMatchObject({ status: 'paid' })

    // Settled as not printed it holds nothing up.
    expect((await w.call('POST', `/cash-register/documents/${storno._id}/settle`, { printed: false })).status).toBe(200)
    expect((await voidIt(w, inv.id)).status).toBe(200)
  })

  it('a storno that failed holds nothing up: it printed nothing', async () => {
    const w = await tillWorld(app)
    const { inv, note } = await invoiced(w)
    w.sim!.paper = false
    expect((await pay(w, note.id, 12)).status).toBe(503)
    w.sim!.paper = true
    const [storno] = await stornosOf(note.id)
    expect(storno.status).toBe('voided')

    expect((await voidIt(w, inv.id)).status).toBe(200)
  })

  it('a note refunded by bank, or by nothing, holds up no void, as before', async () => {
    const w = await tillWorld(app)
    const { inv, note } = await invoiced(w)
    expect((await pay(w, note.id, 12, 'bank_transfer')).status).toBe(200)

    expect((await voidIt(w, inv.id)).status).toBe(200)
  })

  it('a refund\'s storno landing while the void is being claimed: its second look refuses and lets go', async () => {
    const w = await tillWorld(app)
    const { inv, note } = await invoiced(w)
    let refund: any
    const undo = during(update => !!update?.$set?.voidingUntil, async () => { refund = await pay(w, note.id, 12) })
    let r: any
    try {
      r = await voidIt(w, inv.id)
    } finally {
      undo()
    }

    expect(refund.status).toBe(200)
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('fiscally_paid')
    expect((await raw(inv.id)).voidingUntil ?? null).toBeNull()
    expect((await raw(inv.id)).status).toBe('paid')
  })

  it('the void of an invoice with receipts of its own is what it was: its own receipts answer', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const r = await voidIt(w, inv.id)
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('fiscally_paid')
    expect(r.json.document).toBeUndefined()
  })
})

describe('a device that is not fiscalized: the device decides, never a switch', () => {
  /** Open, line, free text, payment, close: nothing of a fiscal receipt. */
  const FISCAL = [0x90, 0x31, 0x36, 0x35, 0x38]
  const fiscalCommands = (w: TillWorld) => w.sim!.executed.filter(c => FISCAL.includes(c.cmd))
  const textPrinted = (w: TillWorld) => w.sim!.executed.filter(c => c.cmd === 0x2A).map(c => c.data).join(' ').replace(/\s+/g, ' ')

  /** The unit in the field, with a cash invoice its text receipt paid. */
  async function theUnit() {
    const w = await tillWorld(app)
    w.sim!.unfiscalizedUnit = true
    const inv = await paidInvoice(w)
    expect(inv.receipt.register.fiscal.mode).toBe('text')
    return { w, inv }
  }

  it('a credit note in cash prints text, with a text receipt behind it, and gives the money back', async () => {
    const { w, inv } = await theUnit()
    const note = await noteOn(w, inv)

    const r = await send(w, note.id)

    expect(r.status).toBe(200)
    expect(r.json.receiptError).toBeUndefined()
    expect(fiscalCommands(w)).toHaveLength(0)
    const issued = await raw(note.id)
    expect(issued).toMatchObject({ status: 'paid', amountPaid: 24 })
    const [storno] = await stornosOf(note.id)
    expect(storno.register).toMatchObject({ isFiscal: false })
    expect(storno.register.fiscal).toMatchObject({ mode: 'text', state: 'printed' })
    expect(storno.register.unp).toBeUndefined()
    expect(storno.register.storno.originalUnp).toBeUndefined()
    expect(storno.register.storno.originalReceiptNumber).toBeUndefined()
    expect(String(storno.register.storno.originalId)).toBe(String(inv.receipt._id))
    const words = textPrinted(w)
    expect(words).toContain(`Връщане по кредитно известие № ${issued.invoiceNumber}`)
    expect(words).toContain(`Сторно на бон № ${inv.receipt.invoiceNumber}`)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 24 })
    expect(leftByRate(await fresh(inv.receipt._id)).size).toBe(0)
  })

  it('in part, through /payments, and the session report counts it as a text receipt', async () => {
    const { w, inv } = await theUnit()
    const note = await issuedNote(w, inv)
    expect((await pay(w, note.id, 10)).status).toBe(200)
    expect(fiscalCommands(w)).toHaveLength(0)
    const report = (await w.call('GET', `/trade/pos/session/${w.sessionId}/report`)).json.report
    expect(report.counts).toMatchObject({ payments: 1, refunds: 1, text: 2, fiscal: 0 })
  })

  it('a fiscal receipt needs a fiscal storno: a device that stopped being one has nothing to cite', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    w.sim!.unfiscalizedUnit = true
    const before = await footprint(w)

    const r = await pay(w, note.id, 24)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('no_receipt_to_storno')
    expect(await footprint(w)).toEqual(before)
  })

  it('a text receipt has nothing on a fiscal device to cite: refund by bank', async () => {
    const { w, inv } = await theUnit()
    const note = await issuedNote(w, inv)
    w.sim!.unfiscalizedUnit = false
    const before = await footprint(w)

    const r = await pay(w, note.id, 24)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('no_receipt_to_storno')
    expect(await footprint(w)).toEqual(before)
  })

  it('a unit fiscalized between the door and its turn: the turn decides, it prints nothing, and its hold and its claim go', async () => {
    const { w, inv } = await theUnit()
    const note = await issuedNote(w, inv)
    const real = Invoice.create
    ;(Invoice as any).create = async function (...args: any[]) {
      w.sim!.unfiscalizedUnit = false
      return (real as any).apply(Invoice, args)
    }
    let r: any
    try {
      r = await pay(w, note.id, 24)
    } finally {
      ;(Invoice as any).create = real
    }

    expect(r.status).toBe(503)
    expect(r.json.code).toBe('fiscal_error')
    expect(fiscalCommands(w)).toHaveLength(0)
    const [storno] = await stornosOf(note.id)
    expect(storno.status).toBe('voided')
    expect(storno.register.unp).toBeUndefined()
    expect(await raw(note.id)).toMatchObject({ amountPaid: 0 })
    expect(leftByRate(await fresh(inv.receipt._id)).get(20)).toBe(2400)
  })

  it('a status that cannot be read is never "not fiscalized": refused as a device that went away', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    w.sim!.disconnected = true
    const r = await pay(w, note.id, 24)
    w.sim!.disconnected = false
    expect(r.status).toBe(503)
    expect(w.sim!.executed.some(c => c.cmd === 0x2A)).toBe(false)
    expect(await raw(note.id)).toMatchObject({ amountPaid: 0 })
  })

  it('a text print that fails is failed: no money, a new attempt prints', async () => {
    const { w, inv } = await theUnit()
    const note = await issuedNote(w, inv)
    w.sim!.paper = false
    const r = await pay(w, note.id, 24)
    w.sim!.paper = true
    expect(r.status).toBe(503)
    expect(await raw(note.id)).toMatchObject({ amountPaid: 0 })
    expect(leftByRate(await fresh(inv.receipt._id)).get(20)).toBe(2400)
    expect((await pay(w, note.id, 24)).status).toBe(200)
  })
})

describe('a held storno and the switch (the readers, B5)', () => {
  /** A storno of 6 held in doubt, its receipt behind it, and then the switch off. */
  async function heldThenOff(w: TillWorld) {
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    w.sim!.dropAfter = 0x38
    expect((await pay(w, note.id, 6)).json.code).toBe('receipt_in_doubt')
    w.sim!.disconnected = false
    const [storno] = await stornosOf(note.id)
    await allowSalesWithoutPrinter(w.oid)
    return { inv, note, storno }
  }

  it('it holds its note\'s refunds whatever the switch says: refused, in its own words, nothing recorded', async () => {
    const w = await tillWorld(app)
    const { note, storno } = await heldThenOff(w)
    const before = await sessionOf(w)

    for (const method of ['cash', 'card']) {
      const r = await pay(w, note.id, 6, method)
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('receipt_in_doubt')
      expect(r.json.receipt.number).toBe(storno.invoiceNumber)
    }

    expect((await raw(note.id)).payments ?? []).toHaveLength(0)
    expect((await raw(note.id)).amountPaid).toBe(0)
    expect((await sessionOf(w)).totalCash).toBe(before.totalCash)
    expect((await shown(w, note.id)).receiptInDoubt).toMatchObject({ number: storno.invoiceNumber })
  })

  it('whoever asks: the way out is the settle door, not a role', async () => {
    const w = await tillWorld(app)
    const { note } = await heldThenOff(w)
    const r = await pay(w, note.id, 6, 'cash', undefined, await w.tokenAs('sales'))
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('receipt_in_doubt')
  })

  it('what a bank refund takes is what no storno holds, as it was: it touches no device', async () => {
    const w = await tillWorld(app)
    const { note } = await heldThenOff(w)
    expect((await pay(w, note.id, 18, 'bank_transfer')).status).toBe(200)
    expect((await pay(w, note.id, 6, 'bank_transfer')).json.code).toBe('receipt_in_doubt')
  })

  it('settled, the rest is by decision: the switch is off, so a cash refund is recorded with nothing printed', async () => {
    const w = await tillWorld(app)
    const { note, storno } = await heldThenOff(w)
    expect((await settle(w, storno._id, false)).status).toBe(200)
    const printed = w.sim!.receipts.length

    const r = await pay(w, note.id, 6)

    expect(r.status).toBe(200)
    expect(await raw(note.id)).toMatchObject({ status: 'partially_paid', amountPaid: 6 })
    expect((await raw(note.id)).payments.at(-1).origin).toBeUndefined()
    expect(w.sim!.receipts).toHaveLength(printed)
  })

  it('a new note in cash on an invoice with a receipt, the switch off: issued with no storno, by decision', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    await allowSalesWithoutPrinter(w.oid)
    const printed = w.sim!.receipts.length
    const note = await noteOn(w, inv)

    expect((await send(w, note.id)).status).toBe(200)

    expect(await raw(note.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect(await stornosOf(note.id)).toHaveLength(0)
    expect(w.sim!.receipts).toHaveLength(printed)
  })
})

describe('a storno that stands on a note holds what the note corrects (the readers, A7)', () => {
  /** Two receipted invoices of one customer, and a note on the first, issued by bank. */
  async function twoInvoices(w: TillWorld) {
    const a = await paidInvoice(w)
    const b = await paidInvoice(w, { extra: { contactId: a.contactId } })
    return { a, b, note: await issuedNote(w, a) }
  }
  const move = (w: TillWorld, id: string, to: string, extra: Record<string, unknown> = {}) => w.call('PUT', `/invoices/${id}`, { relatedInvoiceId: to, ...extra })

  it('printed: it moves with `fiscally_paid`, as its money does, and the next refund cites the same invoice', async () => {
    const w = await tillWorld(app)
    const { a, b, note } = await twoInvoices(w)
    expect((await pay(w, note.id, 12)).status).toBe(200)

    const r = await move(w, note.id, b.id)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('fiscally_paid')
    expect(String((await raw(note.id)).relatedInvoiceId)).toBe(a.id)

    expect((await pay(w, note.id, 12)).status).toBe(200)
    expect(w.sim!.receipts.at(-1)!.header[1]).toBe(a.receipt.register.unp)
  })

  it('what else it says stays editable, and so does sending the same one again', async () => {
    const w = await tillWorld(app)
    const { a, note } = await twoInvoices(w)
    expect((await pay(w, note.id, 12)).status).toBe(200)

    expect((await w.call('PUT', `/invoices/${note.id}`, { notes: 'edited' })).status).toBe(200)
    expect((await move(w, note.id, a.id, { notes: 'and again' })).status).toBe(200)

    expect(await raw(note.id)).toMatchObject({ notes: 'and again' })
  })

  it('held: refused in its own words', async () => {
    const w = await tillWorld(app)
    const { b, note } = await twoInvoices(w)
    w.sim!.dropAfter = 0x38
    expect((await pay(w, note.id, 12)).json.code).toBe('receipt_in_doubt')
    w.sim!.disconnected = false

    const r = await move(w, note.id, b.id)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('receipt_in_doubt')
  })

  it('one that failed holds nothing up, and neither does a refund by bank', async () => {
    const w = await tillWorld(app)
    const { b, note } = await twoInvoices(w)
    w.sim!.paper = false
    expect((await pay(w, note.id, 12)).status).toBe(503)
    w.sim!.paper = true
    expect((await pay(w, note.id, 5, 'bank_transfer')).status).toBe(200)

    expect((await move(w, note.id, b.id)).status).toBe(200)

    expect(String((await raw(note.id)).relatedInvoiceId)).toBe(b.id)
    expect((await pay(w, note.id, 12)).status).toBe(200)
    expect(w.sim!.receipts.at(-1)!.header[1]).toBe(b.receipt.register.unp)
  })

  it('an invoice\'s related document is none of this: only a credit note\'s stornos cite through it', async () => {
    const w = await tillWorld(app)
    const { a, b } = await twoInvoices(w)
    const debit = await draftOf(w, { type: 'debit_note', method: 'bank_transfer', extra: { relatedInvoiceId: a.id, contactId: a.contactId } })
    expect((await send(w, debit.id)).status).toBe(200)
    expect((await pay(w, debit.id, 24)).status).toBe(200)
    expect((await move(w, debit.id, b.id)).status).toBe(200)
  })
})

describe('nothing prints: credit notes behave as today', () => {
  it('the switch off: a credit note in cash is issued and stays due, no session asked for, and a cash refund is recorded', async () => {
    const w = await tillWorld(app)
    const inv = await draftOf(w, { method: 'bank_transfer' })
    await send(w, inv.id)
    await allowSalesWithoutPrinter(w.oid)
    await POSSession.updateOne({ _id: w.sessionId }, { $set: { status: 'closed' } })
    const note = await noteOn(w, inv)
    const printed = w.sim!.executed.filter(c => PRINTING.includes(c.cmd)).length

    const issued = await send(w, note.id)

    expect(issued.status).toBe(200)
    expect(await raw(note.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect(await stornosOf(note.id)).toHaveLength(0)

    const refunded = await pay(w, note.id, 24)

    expect(refunded.status).toBe(200)
    expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect((await raw(note.id)).payments[0].origin).toBeUndefined()
    expect(await stornosOf(note.id)).toHaveLength(0)
    expect(w.sim!.executed.filter(c => PRINTING.includes(c.cmd))).toHaveLength(printed)
  })

  it('an imported credit note, with the switch on: issued by a person it prints nothing, and its refund is recorded', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv)
    await Invoice.updateOne({ _id: note.id }, { $set: { 'statusHistory.0.reason': 'ocr_import' } })
    const printed = w.sim!.receipts.length

    expect((await send(w, note.id)).status).toBe(200)
    expect((await pay(w, note.id, 24)).status).toBe(200)

    expect(await raw(note.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect(w.sim!.receipts).toHaveLength(printed)
    expect(await stornosOf(note.id)).toHaveLength(0)
    expect(leftByRate(await fresh(inv.receipt._id)).get(20)).toBe(2400)
  })

  it('the re-issue of a number issued twice prints nothing: its money went back under the number it replaces', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv)
    await Invoice.updateOne({ _id: note.id }, { $set: { 'stockSource.detectedBy': 'number_clash' } })
    expect((await send(w, note.id)).status).toBe(200)
    expect(await stornosOf(note.id)).toHaveLength(0)
  })

  it('a bank transfer and `other` print nothing, in a printing org', async () => {
    const w = await tillWorld(app)
    const inv = await draftOf(w, { method: 'bank_transfer' })
    await send(w, inv.id)
    const note = await issuedNote(w, inv)
    expect((await pay(w, note.id, 4, 'bank_transfer')).status).toBe(200)
    expect((await pay(w, note.id, 4, 'other')).status).toBe(200)
    expect(await stornosOf(note.id)).toHaveLength(0)
    expect(w.sim!.receipts).toHaveLength(0)
  })

  it('a credit note on a sale of ours, written in cash, whose device is off: the bank still takes it', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    unregisterPrinter(w.deviceId)
    expect((await pay(w, note.id, 24)).json.code).toBe('fiscal_device_not_connected')
    expect((await pay(w, note.id, 24, 'bank_transfer')).status).toBe(200)
  })
})

describe('§2.7 — once a storno has printed, the credit note\'s total is the device\'s', () => {
  it('PUT answers 409 fiscally_paid to anything that moves it, and void is refused', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv)
    expect((await send(w, note.id)).status).toBe(200)

    const edit = await w.call('PUT', `/invoices/${note.id}`, { total: 12, lines: [line(w, 1)] })
    expect(edit.status).toBe(409)
    expect(edit.json.code).toBe('fiscally_paid')

    expect((await w.call('POST', `/invoices/${note.id}/void`, {})).status).toBe(409)
    expect(await raw(note.id)).toMatchObject({ total: 24, status: 'paid' })
  })

  it('in part, it is frozen too: what printed cannot change, and the rest can only go back', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    expect((await pay(w, note.id, 5)).status).toBe(200)
    const edit = await w.call('PUT', `/invoices/${note.id}`, { total: 12, lines: [line(w, 1)] })
    expect(edit.json.code).toBe('fiscally_paid')
    expect((await w.call('POST', `/invoices/${note.id}/void`, {})).status).toBe(409)
  })

  it('anything else on it stays editable', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv)
    expect((await send(w, note.id)).status).toBe(200)
    expect((await w.call('PUT', `/invoices/${note.id}`, { notes: 'Върната стока' })).status).toBe(200)
    expect((await raw(note.id)).notes).toBe('Върната стока')
  })

  it('a storno that failed holds nothing up: it printed nothing', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv)
    w.sim!.paper = false
    await send(w, note.id)
    w.sim!.paper = true
    expect((await w.call('PUT', `/invoices/${note.id}`, { total: 12, lines: [line(w, 1)] })).status).toBe(200)
    expect((await w.call('POST', `/invoices/${note.id}/void`, {})).status).toBe(200)
  })

  it('a storno cannot itself be edited, deleted or voided', async () => {
    expect(isImmutableRegisterDocument({ type: 'payment_storno' })).toBe(true)
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv)
    await send(w, note.id)
    const [storno] = await stornosOf(note.id)
    expect((await w.call('PUT', `/invoices/${storno._id}`, { notes: 'x' })).json.code).toBe('register_document_immutable')
    expect((await w.call('POST', `/invoices/${storno._id}/void`, {})).json.code).toBe('register_document_immutable')
  })

  it('a void under way: a refund gives way, by the same claim as a payment', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    await Invoice.updateOne({ _id: note.id }, { $set: { voidingUntil: new Date(Date.now() + 60_000) } })
    const r = await pay(w, note.id, 24)
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('document_claimed')
    expect(await stornosOf(note.id)).toHaveLength(0)
  })
})

describe('what the dialog is told: the server answers it', () => {
  it('a credit note that can give money back: which methods print, and what the receipts hold', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv, { quantity: 1 })
    expect((await shown(w, note.id))).toMatchObject({ printsOnPayment: ['cash', 'card'], refundable: 24 })
    const rows = (await w.call('GET', '/invoices?type=credit_note')).json.invoices
    expect(rows.find((d: any) => String(d.id) === note.id).printsOnPayment).toEqual(['cash', 'card'])

    expect((await pay(w, note.id, 12)).status).toBe(200)
    const done = await shown(w, note.id)
    expect(done.printsOnPayment).toEqual([])
    expect(done.refundable).toBe(12)
    expect(done.paymentReceipts).toHaveLength(1)
    expect(done.paymentReceipts[0]).toMatchObject({ method: 'cash' })
  })

  it('with the switch off, or imported, nothing is said to print', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    await Invoice.updateOne({ _id: note.id }, { $set: { 'statusHistory.0.reason': 'ocr_import' } })
    expect((await shown(w, note.id)).printsOnPayment).toEqual([])
    await Invoice.updateOne({ _id: note.id }, { $set: { 'statusHistory.0.reason': 'x' } })
    await allowSalesWithoutPrinter(w.oid)
    expect((await shown(w, note.id)).printsOnPayment).toEqual([])
  })

  it('a form with a storno in doubt says so', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    w.sim!.dropAfter = 0x38
    await pay(w, note.id, 24)
    w.sim!.disconnected = false
    const [storno] = await stornosOf(note.id)
    expect((await shown(w, note.id)).receiptInDoubt).toMatchObject({ id: String(storno._id), number: storno.invoiceNumber })
  })
})

describe('§2.6 — who reads what: each counts the money once', () => {
  /** A cash invoice of 24 and its credit note of 24, refunded on a storno: the same session. */
  async function refundedDay(w: TillWorld) {
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv)
    expect((await send(w, note.id)).status).toBe(200)
    const [storno] = await stornosOf(note.id)
    return { inv, note, storno, noteDoc: await raw(note.id), date: localDayOf(new Date(), 'Europe/Sofia') }
  }
  const report = (id: string, orgId: string, params: Record<string, any>) => {
    const entry = reportById(id)!
    return entry.handler!({ orgId, params: validateParams(entry, params), output: 'table' }) as Promise<any>
  }
  const around = () => {
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
    return { preset: 'custom', from: day(-1), to: day(1) }
  }

  it('the session: expected cash and the close preview count it negative', async () => {
    const w = await tillWorld(app)
    await refundedDay(w)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalSales: 24, totalReturns: 24, transactionCount: 2 })
    const preview = await w.call('GET', `/trade/pos/session/${w.sessionId}/close-preview`)
    expect(preview.json.expected.cash).toBe(100)
    expect(preview.json.report.byMethod.cash).toBe(0)
    expect(preview.json.report.total).toBe(0)
    expect(preview.json.unfinishedReceipts).toEqual([])
  })

  it('the session report: a line of its own, in the org\'s language, and the money and VAT negative', async () => {
    const w = await tillWorld(app)
    const d = await refundedDay(w)
    await w.sell(1)
    const session = await sessionOf(w)
    const built = buildSessionReport(session, await loadPosRows({ orgId: w.orgId, sessionId: w.sessionId, withReceipts: true }))
    expect(built.counts).toMatchObject({ sales: 1, payments: 1, refunds: 1, stornos: 0, fiscal: 3, text: 0 })
    expect(built.total).toBe(12)
    expect(built.byMethod.cash).toBe(12)
    expect(built.vat).toEqual([{ rate: 20, net: 10, vat: 2, gross: 12 }])
    expect(built.receipts!.last).toBe(await fresh(await lastReceiptOf(w)).then(r => r.register.fiscalReceiptNumber))
    expect(formatSessionReport(built, 'bg').join('\n')).toContain('Върнато по кр. известия')
    for (const locale of ['en', 'de', 'mk']) expect(formatSessionReport(built, locale).length).toBeGreaterThan(10)
    void d
  })

  it('a storno that failed takes no money and is counted voided; one in doubt is not counted yet', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    w.sim!.paper = false
    await pay(w, note.id, 24)
    w.sim!.paper = true
    const report1 = buildSessionReport(await sessionOf(w), await loadPosRows({ orgId: w.orgId, sessionId: w.sessionId, withReceipts: true }))
    expect(report1.counts).toMatchObject({ voided: 1, payments: 1 })
    expect(report1.counts.refunds).toBeUndefined()
    expect(report1.byMethod.cash).toBe(24)

    w.sim!.dropAfter = 0x38
    await pay(w, note.id, 24)
    w.sim!.disconnected = false
    const report2 = buildSessionReport(await sessionOf(w), await loadPosRows({ orgId: w.orgId, sessionId: w.sessionId, withReceipts: true }))
    expect(report2.counts.refunds).toBeUndefined()
    expect(report2.byMethod.cash).toBe(24)
  })

  it('the Z-report check: a closed day agrees with the device, the storno counted against it', async () => {
    const w = await tillWorld(app)
    await refundedDay(w)
    const close = await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 100, card: 0, other: 0 } })
    expect(close.status).toBe(200)
    const closed = await sessionOf(w)
    expect(closed).toMatchObject({ status: 'closed', fiscalStatus: 'closed', expectedBalance: 100, difference: 0 })
    expect(closed.report.counts).toMatchObject({ payments: 1, refunds: 1 })
    expect(closed.report.total).toBe(0)
    const stornos = w.sim!.receipts.filter(r => r.kind === 'storno')
    const sales = w.sim!.receipts.filter(r => r.kind === 'fiscal')
    const sum = (rs: typeof sales) => rs.reduce((s, r) => s + r.payments.reduce((p, x) => p + x.amount, 0), 0)
    expect(sum(sales) - sum(stornos)).toBe(closed.report.total)
  })

  it('stock: none, and "sales with no movement" leaves it out', async () => {
    const w = await tillWorld(app)
    const d = await refundedDay(w)
    expect(await StockMovement.countDocuments({ orgId: w.oid, invoiceId: d.storno._id })).toBe(0)
    await Invoice.updateMany({ orgId: w.oid }, { $set: { issueDate: new Date(`${d.date}T10:00:00Z`) } })
    const digest: any = await buildDailyDigest(w.orgId, d.date)
    expect(digest.undocumentedSales.count).toBe(0)
  })

  it('sales history: the invoice and the credit note count, the storno is no row, and the money foots to nothing', async () => {
    const w = await tillWorld(app)
    const d = await refundedDay(w)
    const out = await report('sales-history', w.orgId, { period: around(), includeNonRegister: true })
    const docs = out.rows.filter((r: any) => r.rowType === 'document')
    expect(docs.map((r: any) => r.number).sort()).toEqual([d.inv.invoice.invoiceNumber, d.noteDoc.invoiceNumber].sort())
    expect(out.rows.some((r: any) => r.number === d.storno.invoiceNumber)).toBe(false)
    expect(docs.find((r: any) => r.number === d.noteDoc.invoiceNumber).total).toBe(-24)
    expect(out.meta.summary.find((s: any) => s.currency === 'EUR')).toMatchObject({ total: 0, cash: 0 })
  })

  it('a credit note in cash whose storno failed gave nothing back: its header is no money where LGR prints', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv)
    w.sim!.paper = false
    await send(w, note.id)
    w.sim!.paper = true
    const out = await report('sales-history', w.orgId, { period: around(), includeNonRegister: true })
    expect(out.meta.summary.find((s: any) => s.currency === 'EUR')).toMatchObject({ total: 0, cash: 24, unpaid: -24 })
    const sales = await report('sales-documents', w.orgId, { period: around() })
    expect(sales.rows.find((r: any) => r.invoiceId === note.id)).toMatchObject({ total: -24, paidCash: 0, bank: -24 })
  })

  it('Reports: sales documents list the credit note with its money, the cash register does not list the storno', async () => {
    const w = await tillWorld(app)
    const d = await refundedDay(w)
    const sales = await report('sales-documents', w.orgId, { period: around() })
    expect(sales.rows.map((r: any) => r.number).sort()).toEqual([d.inv.invoice.invoiceNumber, d.noteDoc.invoiceNumber].sort())
    expect(sales.rows.find((r: any) => r.number === d.noteDoc.invoiceNumber)).toMatchObject({ total: -24, paidCash: -24, bank: 0 })
    const cash = await report('cash-register', w.orgId, { period: around() })
    expect(cash.rows.some((r: any) => r.number === d.storno.invoiceNumber)).toBe(false)
  })

  it('the digest: payments and methods net to nothing; no gap in the CS series; not one more cash document', async () => {
    const w = await tillWorld(app)
    const d = await refundedDay(w)
    await Invoice.updateMany({ orgId: w.oid }, { $set: { issueDate: new Date(`${d.date}T10:00:00Z`) } })
    await Invoice.updateMany({ orgId: w.oid, 'payments.0': { $exists: true } }, { $set: { 'payments.$[].date': new Date(`${d.date}T10:00:00Z`) } })

    const digest: any = await buildDailyDigest(w.orgId, d.date)

    expect(digest.kpis).toMatchObject({ paymentsTotal: 0, paymentsCount: 2, cashTotal: 0, cashCount: 0 })
    expect(digest.kpis.byMethod.find((m: any) => m.method === 'cash')).toMatchObject({ amount: 0 })
    expect(digest.documents.cash.sequence.count).toBe(2)
    expect(digest.documents.cash.sequence.missing).toEqual([])
    expect(digest.documents.cash.count).toBe(0)
    expect(digest.duplicates.count).toBe(0)
  })

  it('the exports: the sales documents name the credit note, and neither export names the storno', async () => {
    const w = await tillWorld(app)
    const d = await refundedDay(w)
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
    expect(outgoing).toContain(d.noteDoc.invoiceNumber)
    expect(outgoing).not.toContain(d.storno.invoiceNumber)
    expect(await cellsOf('cash_register')).not.toContain(d.storno.invoiceNumber)
  })

  it('the ledgers: the contact\'s and the product\'s list no storno, and neither count it nor its cost', async () => {
    const w = await tillWorld(app)
    const d = await refundedDay(w)
    const contact = await getContactLedger(w.orgId, d.inv.contactId)
    expect(contact.entries.some(e => e.documentNumber === d.storno.invoiceNumber)).toBe(false)
    const product = await getProductLedger(w.orgId, String(w.product._id), {} as any) as any
    expect(JSON.stringify(product)).not.toContain(d.storno.invoiceNumber)
  })

  it('the dashboard and the lists: the stats, the contact\'s summary, the summary and the invoice list', async () => {
    const w = await tillWorld(app)
    const d = await refundedDay(w)
    const list = await w.call('GET', '/invoices')
    expect(list.json.invoices.map((i: any) => i.invoiceNumber).sort()).toEqual([d.inv.invoice.invoiceNumber, d.noteDoc.invoiceNumber].sort())
    expect((await w.call('GET', `/stats/contact/${d.inv.contactId}`)).json.stats.invoiceCount).toBe(2)
    expect((await w.call('GET', `/invoicing/contact/${d.inv.contactId}/summary`)).json.invoiceCount).toBe(2)
    expect((await w.call('GET', `/stats/product/${w.product._id}`)).json.stats.invoiceCount).toBe(2)
    const totals = await getInvoiceSummary(w.orgId, {})
    expect(totals.paid30d).toEqual({ amount: 0, count: 2 })
  })

  it('aging: a credit note part refunded offsets what is left, and refunded whole it is gone', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    expect((await pay(w, note.id, 10)).status).toBe(200)
    const part = await w.call('GET', '/invoicing/reports/aging')
    expect(JSON.stringify(part.json)).toContain('-14')
    expect((await pay(w, note.id, 14)).status).toBe(200)
    const gone = await w.call('GET', '/invoicing/reports/aging')
    expect(JSON.stringify(gone.json)).not.toContain('-14')
  })

  it('the journal lists it: number, УНП, amount, the credit note, and the receipt it cites, both ways', async () => {
    const w = await tillWorld(app)
    const d = await refundedDay(w)
    const all = await listJournal({ orgId: w.orgId })
    expect(all.total).toBe(2)
    const kind = await listJournal({ orgId: w.orgId, kind: 'refund' })
    expect(kind.total).toBe(1)
    const row = kind.rows[0]
    expect(row).toMatchObject({ number: d.storno.invoiceNumber, kind: 'refund', status: 'completed', total: 24, relatedId: String(d.inv.receipt._id) })
    expect(row.fiscal).toMatchObject({ state: 'printed', unp: d.storno.register.unp, receiptNumber: d.storno.register.fiscalReceiptNumber })
    expect(row.invoices).toEqual([{ id: d.note.id, number: d.noteDoc.invoiceNumber, status: 'paid' }])
    const doc = await getJournalDocument(w.orgId, row.id)
    expect(doc!.related.map(r => r.number)).toEqual([d.inv.receipt.invoiceNumber])
    const cited = await getJournalDocument(w.orgId, String(d.inv.receipt._id))
    expect(cited!.row.stornoedBy).toEqual([String(d.storno._id)])
    expect(cited!.related.map(r => r.number)).toEqual([d.storno.invoiceNumber])
    const filter = await w.call('GET', '/cash-register/documents?kind=refund')
    expect(filter.status).toBe(200)
    expect(filter.json.total).toBe(1)
  })

  it('SUPTO: 18.2 and 18.4 list it, citing what it reverses; 18.1 and 18.3 do not, it is no sale', async () => {
    const w = await tillWorld(app)
    const d = await refundedDay(w)
    const filters = { orgId: w.orgId, dateFrom: new Date(Date.now() - 86_400_000), dateTo: new Date(Date.now() + 86_400_000) }
    const reversed = await exportReversedSales(filters)
    expect(reversed.map((t: any) => t.transactionNumber)).toEqual([d.storno.invoiceNumber])
    expect(reversed[0]).toMatchObject({
      type: 'payment_storno',
      unpNumber: d.storno.register.unp,
      originalUNP: d.inv.receipt.register.unp,
      originalFiscalReceiptNumber: d.inv.receipt.register.fiscalReceiptNumber,
      stornoReason: 'customer_return',
      total: 24,
    })
    expect(reversed[0].originalTransactionDate).toBeTruthy()
    const payments = await exportPaymentDetails(filters)
    expect(payments.map((t: any) => t.transactionNumber).sort()).toEqual([d.inv.receipt.invoiceNumber, d.storno.invoiceNumber].sort())
    const summarized = await exportSummarizedSales(filters)
    expect(summarized.transactions.map((t: any) => t.transactionNumber)).toEqual([d.inv.receipt.invoiceNumber])
    const itemized = await exportItemizedSales(filters)
    expect(itemized.map((t: any) => t.transactionNumber)).toEqual([d.inv.receipt.invoiceNumber])
    expect(await exportCancelledSales(filters)).toHaveLength(0)
  })

  it('SUPTO: 18.5 lists one that failed, with its number and УНП, and 18.4 and 18.2 do not', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv)
    w.sim!.paper = false
    await send(w, note.id)
    w.sim!.paper = true
    const [dead] = await stornosOf(note.id)
    const filters = { orgId: w.orgId, dateFrom: new Date(Date.now() - 86_400_000), dateTo: new Date(Date.now() + 86_400_000) }
    const cancelled = await exportCancelledSales(filters)
    expect(cancelled.map((t: any) => t.transactionNumber)).toEqual([dead.invoiceNumber])
    expect(cancelled[0].unpNumber).toBe(dead.register.unp)
    expect(await exportReversedSales(filters)).toHaveLength(0)
    expect((await exportPaymentDetails(filters)).map((t: any) => t.transactionNumber)).toEqual([inv.receipt.invoiceNumber])
  })

  it('SUPTO: a text storno stands in 18.4 with nothing fiscal on the row', async () => {
    const w = await tillWorld(app)
    w.sim!.unfiscalizedUnit = true
    const inv = await paidInvoice(w)
    const note = await noteOn(w, inv)
    await send(w, note.id)
    const filters = { orgId: w.orgId, dateFrom: new Date(Date.now() - 86_400_000), dateTo: new Date(Date.now() + 86_400_000) }
    const [row] = await exportReversedSales(filters)
    expect(row.unpNumber).toBeUndefined()
    expect(row.originalUNP).toBeUndefined()
    expect(row.fiscalReceiptNumber).toBeUndefined()
    expect(row.total).toBe(24)
  })

  it('a device\'s witness reads a storno as its last document, as the device does', async () => {
    const w = await tillWorld(app)
    const d = await refundedDay(w)
    const [evidence] = await deviceEvidence(w.orgId, async () => ({ state: 'read', lastDocument: w.sim!.lastDocNumber } as any))
    expect(evidence.recorded).toMatchObject({ receiptNo: d.storno.register.fiscalReceiptNumber, number: d.storno.invoiceNumber })
    expect(evidence.since).toBe(0)
  })

  it('the credit note\'s printout lists no storno: §2.6, and only an invoice is paid by a receipt', async () => {
    const w = await tillWorld(app)
    const d = await refundedDay(w)
    const printable = await printableDocument(w.orgId, d.noteDoc)
    expect(printable.paymentReceipts).toBeUndefined()
    // The form lists it: it took the money.
    expect((await shown(w, d.note.id)).paymentReceipts).toHaveLength(1)
  })

  it('the field check holds on an org with a refund: the journal lists them, and its invariant says so', async () => {
    const w = await tillWorld(app)
    await refundedDay(w)
    const script = await Bun.file(new URL('../../../../scripts/cash-register-field-check.ts', import.meta.url)).text()
    const formula = /row\.journalInvariant = (.+)/.exec(script)![1]
    const count = (type: string) => Invoice.countDocuments({ orgId: w.oid, type }).exec()
    const row = { pos: 0, copies: 0, cashSales: await count('cash_sale'), cashStornos: await count('cash_storno'), paymentReceipts: await count('payment_receipt'), paymentStornos: await count('payment_storno') }
    const all = await listJournal({ orgId: w.orgId, size: 1 })
    expect(row.paymentStornos).toBe(1)
    expect(new Function('row', 'all', `return ${formula}`)(row, all)).toBe(true)
  })

  it('a fenced import books nothing for it: its credit note comes in with the return and the row', () => {
    expect(bookingOf({ type: 'payment_storno', status: 'paid', direction: 'outgoing' })).toBe('none')
  })
})

async function lastReceiptOf(w: TillWorld): Promise<any> {
  const rows: any[] = await Invoice.find({ orgId: w.oid, 'register.fiscalReceiptNumber': { $exists: true } }).sort({ 'register.printedAt': -1, _id: -1 }).limit(1).lean().exec()
  return rows[0]._id
}

describe('FR-24.50: a refund runs where the printer is', () => {
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

  async function heldOnPodB(w: TillWorld) {
    forgetDevices()
    const { FiscalPresence } = await import('db/models')
    await FiscalPresence.init()
    const now = new Date()
    await FiscalPresence.create({
      orgId: w.orgId, deviceNumber: 'ED123456', deviceId: w.deviceId, kind: 'user', label: 'Till on B',
      podId: 'pod-b', podAddr: 'http://10.0.0.2:4001', connId: 'conn-b', connectedAt: now, heartbeatAt: now,
    })
  }

  it('issuing a credit note and recording a refund go to the pod with the printer, and nothing is written here', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const atIssue = await noteOn(w, inv)
    const later = await issuedNote(w, inv)
    await heldOnPodB(w)
    const before = await footprint(w)

    const answers = [await send(w, atIssue.id), await pay(w, later.id, 24)]

    expect(answers).toEqual(Array(2).fill({ status: 200, json: { from: 'pod-b' } }))
    expect(forwarded.map(f => f.path)).toEqual([`/org/${w.orgId}/invoices/${atIssue.id}/send`, `/org/${w.orgId}/invoices/${later.id}/payments`])
    expect(await footprint(w)).toEqual(before)
    expect((await raw(atIssue.id)).status).toBe('draft')
  })

  it('the holder unreachable: 503, nothing written, and the code that tells a client to keep its key', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    await heldOnPodB(w)
    reachable = false
    const before = await footprint(w)

    const r = await pay(w, note.id, 24)

    expect(r.status).toBe(503)
    expect(r.json.code).toBe('fiscal_holder_unreachable')
    expect(await footprint(w)).toEqual(before)
  })

  it('a dead storno comes first, on its own device, by the credit note it was for', async () => {
    const w = await tillWorld(app)
    const inv = await paidInvoice(w)
    const note = await issuedNote(w, inv)
    await Invoice.collection.insertOne({
      orgId: w.oid, type: 'payment_storno', register: { refundOf: new (Invoice.base as any).Types.ObjectId(note.id), warehouseId: w.warehouse._id, fiscalDeviceNumber: 'ED123456' },
    } as any)
    const ctx: any = { params: { orgId: w.orgId, id: note.id }, user: { id: String(w.clerk._id) } }
    expect(await deviceFromDeadReceipt(ctx)).toMatchObject({ deviceNumber: 'ED123456' })
    expect(await deviceFromCounter(ctx)).toMatchObject({ deviceNumber: 'ED123456' })
    // Someone with no session and nothing dead on the document: no printer is theirs to go to.
    const other = await issuedNote(w, inv)
    expect(await deviceFromCounter({ ...ctx, params: { orgId: w.orgId, id: other.id } })).toBeNull()
  })
})
