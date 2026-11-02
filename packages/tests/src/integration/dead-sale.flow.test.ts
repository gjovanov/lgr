import { describe, it, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import { draftOf, gate, pay, send, sessionOf, until } from '../helpers/receipt-world'
import { createTestAccount, createTestStockLevel, createTestWarehouse } from '../helpers/factories'
import { AuditLog, Invoice, Journal, JournalEntry, Org, POSSession, StockLevel, StockMovement } from 'db/models'
import { LEASE_MS } from 'services/biz/hot-path-key'
import { deviceTurn } from 'fiscal/device-turn'
import { getPrinter } from 'fiscal/fiscal-device.service'
import { saleProgress } from 'services/biz/cash-register/in-doubt'
import { PENDING_NUMBER, isPendingNumber } from 'services/biz/cash-register/pending-number'
import { bookedOnItsSession } from 'services/biz/cash-register/register.service'
import { postPosSessionJournal } from 'services/events/handlers'

/**
 * FR-23, the third read's finding 3: a sale that died in its print. Every reader of the rows counts it and its
 * session does not, because nothing had booked it, so the preview said one thing and the close another, the
 * drawer read as over by exactly that, and money settled afterwards landed on a closed session and nowhere.
 *
 * Its money stands (D-4). So what next reads the session's figures finishes it first, printing nothing.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = tillApp() as any
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { forgetDevices(); await clearCollections() }, 30_000)

const read = (id: unknown): Promise<any> => Invoice.findById(id).lean().exec()
const lastSale = (w: TillWorld): Promise<any> => Invoice.findOne({ orgId: w.oid, type: 'cash_sale' }).sort({ _id: -1 }).lean().exec()
const preview = (w: TillWorld) => w.call('GET', `/trade/pos/session/${w.sessionId}/close-preview`)
const close = (w: TillWorld, cash: number, extra: Record<string, unknown> = {}) => w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash }, ...extra })
const settle = (w: TillWorld, id: unknown, printed: boolean, receiptNumber?: string) =>
  w.call('POST', `/cash-register/documents/${id}/settle`, { printed, ...(receiptNumber ? { receiptNumber } : {}) })

/** The write `at` picks never lands: the process went away right there. Returns what puts it back. */
function diesAt(at: (update: any) => boolean) {
  const real = Invoice.findOneAndUpdate
  let done = false
  ;(Invoice as any).findOneAndUpdate = function (filter: any, update: any, ...rest: any[]) {
    if (done || !at(update)) return (real as any).call(Invoice, filter, update, ...rest)
    done = true
    const chain = { lean: () => chain, exec: async () => { throw new Error('the pod went away') } }
    return chain
  }
  return () => { (Invoice as any).findOneAndUpdate = real }
}

/** The receipt closed on the device, and the process died before it wrote that down. */
const atItsPrint = (update: any) => update?.$set?.['register.fiscal.state'] === 'printed'
/** It printed and wrote that down, and died before the session's totals. */
const atItsTotals = (update: any) => !!update?.$set?.['register.sessionTotalsApplied']
/** It died before it started: nothing reached the device. */
const atItsAttempt = (update: any) => !!update?.$set?.['register.fiscal.attemptedAt']

/** A sale of 12 whose request died at `where`, and whose lease has lapsed. */
async function deadSale(w: TillWorld, where: (update: any) => boolean, o: { nonFiscal?: boolean; key?: string } = {}) {
  const undo = diesAt(where)
  try {
    const r = await w.sell(1, { nonFiscal: o.nonFiscal }, o.key)
    expect(r.status).toBe(500)
  } finally {
    undo()
  }
  const sale = await lastSale(w)
  expect(sale.completedAt).toBeUndefined()
  await Invoice.updateOne({ _id: sale._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })
  return String(sale._id)
}

/** The draft transfer of one unit a joined sale asks for, out of a second warehouse. */
async function transferIn(w: TillWorld) {
  const source = await createTestWarehouse(w.oid, { name: 'Склад 2', code: 'WH2' } as any)
  await createTestStockLevel(w.oid, w.product._id, source._id, { quantity: 10, availableQuantity: 10, avgCost: 4 } as any)
  const transfer: any = await StockMovement.create({
    orgId: w.oid, movementNumber: 'SM-2026-90001', type: 'transfer', status: 'draft', date: new Date(),
    fromWarehouseId: source._id, toWarehouseId: w.warehouse._id, createdBy: w.user._id,
    lines: [{ productId: w.product._id, quantity: 1, unitCost: 4, totalCost: 4 }],
  })
  const level = async (warehouseId: unknown) => ((await StockLevel.findOne({ orgId: w.oid, productId: w.product._id, warehouseId }).lean().exec()) as any)?.quantity
  return { transferId: String(transfer._id), transfer, source: () => level(source._id), here: () => level(w.warehouse._id) }
}

describe('the close finishes a sale whose request died (finding 3)', () => {
  it('the preview and the close tell one story: it counts, the difference is 0, and it is finished', async () => {
    const w = await tillWorld(app)
    const id = await deadSale(w, atItsPrint)
    expect((await sessionOf(w)).totalCash).toBe(0)

    const shown = await preview(w)

    expect(shown.json.expected.cash).toBe(112)
    expect(shown.json.report.total).toBe(12)
    expect(shown.json.deadSales).toEqual([expect.objectContaining({ id })])
    expect(shown.json.unfinishedReceipts).toEqual([])
    // A GET writes nothing.
    expect((await sessionOf(w)).totalCash).toBe(0)
    expect((await read(id)).completedAt).toBeUndefined()

    const closed = await close(w, 112)

    expect(closed.status).toBe(200)
    const session = await sessionOf(w)
    expect(session).toMatchObject({ status: 'closed', totalCash: 12, expectedBalance: 112, difference: 0, totalSales: 12, transactionCount: 1 })
    const sale = await read(id)
    expect(sale.completedAt).toBeTruthy()
    // It prints nothing: what nothing can prove goes to a person, and its money stands.
    expect(sale.register.fiscal.state).toBe('unknown')
    expect((await w.stock()).quantity).toBe(9)
    expect(await StockMovement.countDocuments({ orgId: w.oid, invoiceId: id })).toBe(1)
    expect(closed.json.report.total).toBe(12)
  })

  it('the close prints nothing for it: one receipt on the device, as the first print left', async () => {
    const w = await tillWorld(app)
    await deadSale(w, atItsPrint)
    const closedBefore = w.sim!.receipts.filter(r => !r.voided).length
    const opens = w.sim!.executed.filter(c => c.cmd === 0x90).length

    expect((await close(w, 112)).status).toBe(200)

    expect(w.sim!.executed.filter(c => c.cmd === 0x90)).toHaveLength(opens)
    expect(w.sim!.receipts.filter(r => !r.voided)).toHaveLength(closedBefore)
  })

  it('settled afterwards it adds nothing twice, whichever way', async () => {
    for (const printed of [true, false]) {
      const w = await tillWorld(app)
      const id = await deadSale(w, atItsPrint)
      expect((await close(w, 112)).status).toBe(200)
      const before = await sessionOf(w)
      const number = printed ? w.sim!.receipts.at(-1)!.number : undefined

      const r = await settle(w, id, printed, number)

      expect(r.status).toBe(200)
      expect((await read(id)).register.fiscal.state).toBe(printed ? 'printed' : 'failed')
      const after = await sessionOf(w)
      expect(after.totalCash).toBe(before.totalCash)
      expect(after.totalSales).toBe(before.totalSales)
      expect((await w.stock()).quantity).toBe(9)
      expect(await StockMovement.countDocuments({ orgId: w.oid, invoiceId: id })).toBe(1)
      forgetDevices()
    }
  })

  it('a sale stopped after its print and before its totals: no `pending` to find it by, and it is finished all the same', async () => {
    const w = await tillWorld(app)
    const id = await deadSale(w, atItsTotals)
    expect((await read(id)).register.fiscal.state).toBe('printed')
    expect((await sessionOf(w)).totalCash).toBe(0)

    expect((await preview(w)).json.expected.cash).toBe(112)
    const closed = await close(w, 112)

    expect(closed.status).toBe(200)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 12, difference: 0 })
    const sale = await read(id)
    // What it knew stands: it printed.
    expect(sale.register.fiscal.state).toBe('printed')
    expect(sale.completedAt).toBeTruthy()
    expect((await w.stock()).quantity).toBe(9)
  })

  it('a sale stopped after its totals: the preview does not add them again', async () => {
    const w = await tillWorld(app)
    const undo = diesAt(update => !!update?.$set?.completedAt)
    let r: any
    try {
      r = await w.sell(1)
    } finally {
      undo()
    }
    expect(r.status).toBe(500)
    const sale = await lastSale(w)
    expect(sale.register.sessionTotalsApplied).toBe(true)
    await Invoice.updateOne({ _id: sale._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })

    expect((await preview(w)).json.expected.cash).toBe(112)
    expect((await close(w, 112)).status).toBe(200)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 12, difference: 0 })
  })

  it('a text sale is finished alike: its money stands', async () => {
    const w = await tillWorld(app)
    const id = await deadSale(w, update => update?.$set?.['register.fiscal.state'] === 'printed', { nonFiscal: true })

    expect((await preview(w)).json.expected.cash).toBe(112)
    expect((await close(w, 112)).status).toBe(200)

    expect(await sessionOf(w)).toMatchObject({ totalCash: 12, difference: 0 })
    expect((await read(id)).completedAt).toBeTruthy()
  })

  it('one that never reached the device is finished alike: the request that died took its money', async () => {
    const w = await tillWorld(app)
    const id = await deadSale(w, atItsAttempt)
    expect(w.sim!.executed.filter(c => c.cmd === 0x90)).toHaveLength(0)

    expect((await close(w, 112)).status).toBe(200)

    expect(await sessionOf(w)).toMatchObject({ totalCash: 12, difference: 0 })
    expect((await read(id)).register.fiscal.state).toBe('unknown')
    expect(w.sim!.executed.filter(c => c.cmd === 0x90)).toHaveLength(0)
  })

  it('the preview says which a person has to settle: a fiscal sale nothing can prove, never a text sale, nor one that printed', async () => {
    const fiscal = await tillWorld(app)
    await deadSale(fiscal, atItsPrint)
    expect((await preview(fiscal)).json.deadSales).toEqual([expect.objectContaining({ settles: true })])
    forgetDevices()

    const text = await tillWorld(app)
    await deadSale(text, atItsPrint, { nonFiscal: true })
    expect((await preview(text)).json.deadSales).toEqual([expect.objectContaining({ settles: false })])
    forgetDevices()

    const printed = await tillWorld(app)
    await deadSale(printed, atItsTotals)
    expect((await preview(printed)).json.deadSales).toEqual([expect.objectContaining({ settles: false })])
  })

  it('one that died before it drew its number is named by its id, never by its placeholder, and the close numbers it', async () => {
    const w = await tillWorld(app)
    const id = await deadSale(w, atItsPrint, { key: 'died-before-its-number' })
    await Invoice.updateOne({ _id: id }, { $set: { invoiceNumber: `${PENDING_NUMBER}died-before-its-number` } })

    expect((await preview(w)).json.deadSales).toEqual([{ id, number: null, settles: true }])

    expect((await close(w, 112)).status).toBe(200)
    expect(isPendingNumber((await read(id)).invoiceNumber)).toBe(false)
  })

  it('with nothing left on the shelf it goes below zero and says no more: the till\'s rule, and the goods have left', async () => {
    const w = await tillWorld(app)
    const id = await deadSale(w, atItsPrint)
    // Somebody sold the rest while it lay dead.
    await StockLevel.updateOne({ orgId: w.oid, productId: w.product._id, warehouseId: w.warehouse._id }, { $set: { quantity: 0, availableQuantity: 0 } })

    expect((await close(w, 112)).status).toBe(200)

    const sale = await read(id)
    expect(sale.completedAt).toBeTruthy()
    expect(sale.register.stockError).toBeUndefined()
    expect((await w.stock()).quantity).toBe(-1)
  })

  it('a sale with no key has a lease while it waits its turn, so a slow Z does not read it as dead, and none once it is done', async () => {
    const w = await tillWorld(app)
    const held = gate()
    w.sim!.beforeCommand = cmd => (cmd === 0x90 ? held.closed : undefined)
    const selling = w.sell(1)
    await until(async () => !!(await lastSale(w))?.register?.fiscal?.attemptedAt, 'the sale to reach the device')

    const waiting = await lastSale(w)
    expect(waiting.clientKey).toBeUndefined()
    expect(new Date(waiting.leaseUntil).getTime()).toBeGreaterThan(Date.now())
    expect(saleProgress(waiting)).toBe('live')

    w.sim!.beforeCommand = null
    held.open()
    expect((await selling).status).toBe(200)
    const done = await lastSale(w)
    expect(done.leaseUntil).toBeUndefined()
    expect(saleProgress(done)).toBeNull()
  })

  it('with no lease its age says it died, and younger than a lease it may not have', async () => {
    const w = await tillWorld(app)
    const id = await deadSale(w, atItsPrint)
    await Invoice.updateOne({ _id: id }, { $unset: { leaseUntil: 1 } })

    expect((await preview(w)).json.deadSales).toHaveLength(0)
    expect((await preview(w)).json.unfinishedReceipts).toEqual([expect.objectContaining({ id, kind: 'sale' })])
    const young = await close(w, 112)
    expect(young.status).toBe(409)
    expect(young.json.code).toBe('receipts_unfinished')

    await Invoice.collection.updateOne({ _id: new Invoice.base.Types.ObjectId(id) }, { $set: { createdAt: new Date(Date.now() - LEASE_MS - 1000) } })
    expect((await preview(w)).json.deadSales).toHaveLength(1)
    expect((await close(w, 112)).status).toBe(200)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 12, difference: 0 })
  })

  it('the session\'s journal entry books no over or short from it', async () => {
    const w = await tillWorld(app)
    const cash = await createTestAccount(w.oid, { name: 'Cash', type: 'asset' })
    const receivable = await createTestAccount(w.oid, { name: 'Receivable', type: 'asset' })
    const revenue = await createTestAccount(w.oid, { name: 'Revenue', type: 'revenue', subType: 'operating_revenue' } as any)
    const overShort = await createTestAccount(w.oid, { name: 'Over/short', type: 'expense' } as any)
    const journal = await Journal.create({ orgId: w.oid, name: 'Sales', code: 'S1', type: 'sale' })
    const cashJ = await Journal.create({ orgId: w.oid, name: 'Cash', code: 'C1', type: 'cash', defaultDebitAccountId: cash._id })
    await Org.updateOne({ _id: w.oid }, {
      $set: {
        'settings.accounting.defaultSaleJournalId': journal._id,
        'settings.accounting.defaultCashJournalId': cashJ._id,
        'settings.accounting.defaultReceivableAccountId': receivable._id,
        'settings.accounting.defaultRevenueAccountId': revenue._id,
        'settings.accounting.cashOverShortAccountId': overShort._id,
      },
    })
    await deadSale(w, atItsPrint)

    expect((await close(w, 112)).status).toBe(200)
    await postPosSessionJournal({ orgId: w.orgId, sessionId: w.sessionId, userId: String(w.user._id) })

    const entries: any[] = await JournalEntry.find({ orgId: w.oid }).lean().exec()
    expect(entries).toHaveLength(1)
    expect(entries[0].lines.filter((l: any) => String(l.accountId) === String(overShort._id))).toHaveLength(0)
    expect((await sessionOf(w)).difference).toBe(0)
  })
})

describe('a sale not finished holds the close (finding 3)', () => {
  it('a live one: refused, naming it as a sale, with no Z; and it closes once the sale is done', async () => {
    const w = await tillWorld(app)
    const held = gate()
    w.sim!.beforeCommand = cmd => (cmd === 0x38 ? held.closed : undefined)
    const selling = w.sell(1)
    await until(() => w.sim!.receipt?.payments.length === 1, 'the sale to take its money')

    const shown = await preview(w)
    expect(shown.json.deadSales).toEqual([])
    expect(shown.json.unfinishedReceipts).toEqual([expect.objectContaining({ kind: 'sale' })])
    const refused = await close(w, 112)

    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('receipts_unfinished')
    expect(refused.json.receipts).toEqual([expect.objectContaining({ kind: 'sale' })])
    expect(w.sim!.reports).toHaveLength(0)
    expect((await sessionOf(w)).status).toBe('open')

    w.sim!.beforeCommand = null
    held.open()
    expect((await selling).status).toBe(200)
    expect((await close(w, 112)).status).toBe(200)
    expect(await sessionOf(w)).toMatchObject({ status: 'closed', totalCash: 12, difference: 0 })
  })

  it('one that starts after the close read it: the claim\'s second look finds it, and the session goes back to open', async () => {
    const w = await tillWorld(app)
    const realClaim = POSSession.findOneAndUpdate
    let id: unknown
    ;(POSSession as any).findOneAndUpdate = function (filter: any, update: any, ...rest: any[]) {
      if (update?.$set?.status !== 'closing_control') return (realClaim as any).call(POSSession, filter, update, ...rest)
      return {
        exec: async () => {
          const doc: any = await (realClaim as any).call(POSSession, filter, update, ...rest).exec()
          // A sale written just as the close claims, whose print is under way.
          const sale: any = await Invoice.create({
            orgId: w.oid, invoiceNumber: 'CS-LATE-0001', type: 'cash_sale', direction: 'outgoing', status: 'paid', issueDate: new Date(), dueDate: new Date(), currency: 'EUR', exchangeRate: 1, total: 12,
            lines: [{ description: 'x', quantity: 1, unit: 'бр.', unitPrice: 10, taxRate: 20, taxAmount: 2, lineTotal: 12 }],
            billingAddress: { street: '-' }, createdBy: w.user._id, leaseUntil: new Date(Date.now() + 60_000),
            register: { origin: 'pos', sessionId: w.sessionId, isFiscal: true, fiscalDeviceNumber: 'ED123456', fiscal: { state: 'pending', mode: 'fiscal' } },
          })
          id = sale._id
          return doc
        },
      }
    }
    let r: any
    try {
      r = await close(w, 100)
    } finally {
      ;(POSSession as any).findOneAndUpdate = realClaim
    }

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('receipts_unfinished')
    expect(r.json.receipts[0]).toMatchObject({ id: String(id), kind: 'sale' })
    expect((await sessionOf(w)).status).toBe('open')
    expect(w.sim!.reports).toHaveLength(0)
  })

  it('one whose finish threw: refused, and the next attempt finishes it', async () => {
    const w = await tillWorld(app)
    const id = await deadSale(w, atItsPrint)
    const dies = spyOn(Invoice, 'startSession').mockImplementationOnce(() => { throw new Error('the database went away') })

    const refused = await close(w, 112)

    dies.mockRestore()
    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('receipts_unfinished')
    expect(refused.json.receipts[0]).toMatchObject({ id, kind: 'sale' })
    expect((await sessionOf(w)).status).toBe('open')
    expect(w.sim!.reports).toHaveLength(0)

    await Invoice.updateOne({ _id: id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })
    expect((await close(w, 112)).status).toBe(200)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 12, difference: 0 })
  })

  it('a copied POS row with no finish of its own is neither finished nor holds it', async () => {
    const w = await tillWorld(app)
    const copy: any = await Invoice.create({
      orgId: w.oid, invoiceNumber: 'TXN-OLD-2', type: 'cash_sale', direction: 'outgoing', status: 'paid', issueDate: new Date(), dueDate: new Date(), currency: 'EUR', exchangeRate: 1, total: 12,
      lines: [{ description: 'x', quantity: 1, unit: 'бр.', unitPrice: 10, taxRate: 20, taxAmount: 2, lineTotal: 12 }],
      billingAddress: { street: '-' }, createdBy: w.user._id, leaseUntil: new Date(Date.now() - 1000),
      register: { origin: 'pos', sessionId: w.sessionId, legacy: { source: 'postransactions', type: 'sale', transactionNumber: 'TXN-OLD-2' } },
    })

    expect((await preview(w)).json.deadSales).toEqual([])
    expect((await close(w, 100)).status).toBe(200)
    expect((await read(copy._id)).completedAt).toBeUndefined()
    expect((await sessionOf(w)).totalCash).toBe(0)
  })

  it('a settle that stopped on a sale: the close finishes it, and what they said reaches the trail', async () => {
    const w = await tillWorld(app)
    const id = await deadSale(w, atItsPrint)
    const number = w.sim!.receipts.at(-1)!.number!
    const dies = spyOn(Invoice, 'startSession').mockImplementationOnce(() => { throw new Error('the pod went away') })
    // It stops between its claim and its audit row.
    const realAudit = AuditLog.create
    ;(AuditLog as any).create = async () => { throw new Error('the pod went away') }
    let stopped: any
    try {
      stopped = await settle(w, id, true, number)
    } finally {
      ;(AuditLog as any).create = realAudit
      dies.mockRestore()
    }
    expect(stopped.status).toBe(500)
    expect(await AuditLog.countDocuments({ orgId: w.oid, action: 'settle_receipt' })).toBe(0)
    await Invoice.updateOne({ _id: id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })

    expect((await close(w, 112)).status).toBe(200)

    expect((await read(id)).completedAt).toBeTruthy()
    expect((await read(id)).register.fiscalReceiptNumber).toBe(number)
    expect(await AuditLog.countDocuments({ orgId: w.oid, action: 'settle_receipt' })).toBe(1)
  })
})

describe('a settle beside whatever is finishing the sale (the fourth read, finding 5)', () => {
  /** Run `meanwhile` right before the sale's dispatch is looked for, with the lease held by what is finishing it. */
  function atItsDispatch(id: string, meanwhile: () => Promise<unknown>) {
    const real = StockMovement.find
    let done = false
    ;(StockMovement as any).find = function (filter: any, ...rest: any[]) {
      if (done || filter?.type !== 'dispatch' || String(filter?.invoiceId) !== id) return (real as any).call(StockMovement, filter, ...rest)
      done = true
      return {
        lean: () => ({
          exec: async () => {
            await meanwhile()
            return (real as any).call(StockMovement, filter, ...rest).lean().exec()
          },
        }),
      }
    }
    return () => { (StockMovement as any).find = real }
  }
  const dispatches = (w: TillWorld, id: string) => StockMovement.countDocuments({ orgId: w.oid, invoiceId: id, type: 'dispatch' })

  it('the reader\'s run: a settle inside the close\'s finish hears one is finishing it: one dispatch, stock 9', async () => {
    const w = await tillWorld(app)
    const id = await deadSale(w, atItsPrint)
    const number = w.sim!.receipts.at(-1)!.number!
    let settled: any
    const undo = atItsDispatch(id, async () => { settled = await settle(w, id, true, number) })
    let closed: any
    try {
      closed = await close(w, 112)
    } finally {
      undo()
    }

    expect(settled.status).toBe(409)
    expect(settled.json.code).toBe('sale_in_progress')
    expect(closed.status).toBe(200)
    expect(await dispatches(w, id)).toBe(1)
    expect((await w.stock()).quantity).toBe(9)
    expect(await sessionOf(w)).toMatchObject({ status: 'closed', totalCash: 12, difference: 0 })

    // And once that is done a person says, and nothing moves again.
    expect((await settle(w, id, true, number)).status).toBe(200)
    expect((await read(id)).register.fiscalReceiptNumber).toBe(number)
    expect(await dispatches(w, id)).toBe(1)
    expect((await w.stock()).quantity).toBe(9)
  })

  it('a settle inside its own request, past its print: the same', async () => {
    const w = await tillWorld(app)
    let settled: any
    const key = 'unknown-and-still-going'
    w.sim!.dropAfter = 0x38
    const real = StockMovement.find
    let done = false
    ;(StockMovement as any).find = function (filter: any, ...rest: any[]) {
      if (done || filter?.type !== 'dispatch') return (real as any).call(StockMovement, filter, ...rest)
      done = true
      return {
        lean: () => ({
          exec: async () => {
            const sale = await lastSale(w)
            expect(sale.register.fiscal.state).toBe('unknown')
            w.sim!.disconnected = false
            settled = await settle(w, sale._id, false)
            return (real as any).call(StockMovement, filter, ...rest).lean().exec()
          },
        }),
      }
    }
    let r: any
    try {
      r = await w.sell(1, {}, key)
    } finally {
      ;(StockMovement as any).find = real
    }

    expect(settled.json.code).toBe('sale_in_progress')
    expect(r.status).toBe(200)
    expect((await w.stock()).quantity).toBe(9)
  })

  it('a lease left by a crash lapses into what a settle can finish', async () => {
    const w = await tillWorld(app)
    const id = await deadSale(w, atItsPrint)
    const number = w.sim!.receipts.at(-1)!.number!
    // Something took it over, turned it `unknown`, and died there, with its lease still good.
    await Invoice.updateOne({ _id: id }, { $set: { 'register.fiscal.state': 'unknown', leaseUntil: new Date(Date.now() + 60_000) } })

    const refused = await settle(w, id, true, number)
    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('sale_in_progress')
    expect((await read(id)).register.settled).toBeUndefined()

    await Invoice.updateOne({ _id: id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })

    expect((await settle(w, id, true, number)).status).toBe(200)
    expect((await read(id)).completedAt).toBeTruthy()
    expect(await dispatches(w, id)).toBe(1)
    expect((await w.stock()).quantity).toBe(9)
  })

  it('an `unknown` sale that finished has no lease to wait for', async () => {
    const w = await tillWorld(app)
    w.sim!.dropAfter = 0x38
    const sold = await w.sell(1)
    w.sim!.disconnected = false
    expect(sold.json.transaction.fiscal.state).toBe('unknown')
    await getPrinter(w.deviceId).printDailyXReport()

    expect((await settle(w, sold.json.transaction.id, false)).status).toBe(200)
  })
})

describe('the preview says what the close will book, by the function the close books with (the fourth read, finding 4)', () => {
  /** The write `at` picks never lands, and the lease on what that left has lapsed. */
  async function stopsAt(at: (update: any) => boolean, run: () => Promise<any>, of: () => Promise<any>) {
    const undo = diesAt(at)
    try {
      expect((await run()).status).toBe(500)
    } finally {
      undo()
    }
    const doc = await of()
    expect(doc.completedAt).toBeUndefined()
    await Invoice.updateOne({ _id: doc._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })
    return String(doc._id)
  }
  const lastOf = (w: TillWorld, type: string): Promise<any> => Invoice.findOne({ orgId: w.oid, type }).sort({ _id: -1 }).lean().exec()

  it('a receipt that printed and stopped before its totals: the prefilled count is what the close expects, and the difference is 0', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    const id = await stopsAt(atItsTotals, () => pay(w, d.id, 24), () => lastOf(w, 'payment_receipt'))
    expect((await read(id)).register.fiscal.state).toBe('printed')

    const shown = await preview(w)

    expect(shown.json.expected.cash).toBe(124)
    expect(shown.json.report.total).toBe(24)
    expect(shown.json.unfinishedReceipts).toEqual([])
    expect(shown.json.deadDocuments).toEqual([expect.objectContaining({ id, kind: 'payment' })])
    // A GET writes nothing.
    expect((await sessionOf(w)).totalCash).toBe(0)

    const closed = await close(w, shown.json.expected.cash)

    expect(closed.status).toBe(200)
    expect(await sessionOf(w)).toMatchObject({ status: 'closed', totalCash: 24, expectedBalance: 124, difference: 0 })
    expect((await read(id)).completedAt).toBeTruthy()
  })

  it('a storno that printed and stopped before its totals: the same', async () => {
    const w = await tillWorld(app)
    const saleId = String((await w.sell(1)).json.transaction.id)
    const id = await stopsAt(atItsTotals, () => w.storno(saleId), () => lastOf(w, 'cash_storno'))
    expect((await read(id)).register.fiscal.state).toBe('printed')

    const shown = await preview(w)

    expect(shown.json.expected.cash).toBe(100)
    expect(shown.json.report.total).toBe(0)
    expect(shown.json.unfinishedReceipts).toEqual([])
    expect(shown.json.deadDocuments).toEqual([expect.objectContaining({ id, kind: 'storno' })])
    expect((await sessionOf(w)).totalCash).toBe(12)

    const closed = await close(w, shown.json.expected.cash)

    expect(closed.status).toBe(200)
    expect(await sessionOf(w)).toMatchObject({ status: 'closed', totalCash: 0, totalReturns: 12, expectedBalance: 100, difference: 0 })
  })

  it('a storno of a text sale, with nothing to print: the same', async () => {
    const w = await tillWorld(app)
    const saleId = String((await w.sell(1, { nonFiscal: true })).json.transaction.id)
    await stopsAt(atItsTotals, () => w.storno(saleId), () => lastOf(w, 'cash_storno'))

    const shown = await preview(w)

    expect(shown.json.expected.cash).toBe(100)
    expect((await close(w, shown.json.expected.cash)).status).toBe(200)
    expect(await sessionOf(w)).toMatchObject({ status: 'closed', expectedBalance: 100, difference: 0 })
  })

  it('one that stopped after its totals is in the session already, and is not added twice', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    await stopsAt(update => !!update?.$set?.completedAt, () => pay(w, d.id, 24), () => lastOf(w, 'payment_receipt'))
    expect((await sessionOf(w)).totalCash).toBe(24)

    const shown = await preview(w)

    expect(shown.json.expected.cash).toBe(124)
    expect((await close(w, shown.json.expected.cash)).status).toBe(200)
    expect((await sessionOf(w)).difference).toBe(0)
  })

  it('a receipt that never reached the device takes nothing, and the close gives it up: named, and not added', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    const id = await stopsAt(atItsAttempt, () => pay(w, d.id, 24), () => lastOf(w, 'payment_receipt'))

    const shown = await preview(w)

    expect(shown.json.expected.cash).toBe(100)
    expect(shown.json.unfinishedReceipts).toEqual([])
    expect(shown.json.deadDocuments).toEqual([expect.objectContaining({ id })])
    expect((await close(w, 100)).status).toBe(200)
    expect((await read(id)).status).toBe('voided')
    expect((await sessionOf(w)).difference).toBe(0)
  })

  it('one nothing can prove: named as one the close will look at, it holds the close, and then it is one that holds it', async () => {
    const w = await tillWorld(app)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    // It reached the device and its answer never came back to anyone.
    const id = await stopsAt(atItsPrint, () => pay(w, d.id, 24), () => lastOf(w, 'payment_receipt'))
    expect((await read(id)).register.fiscal.state).toBe('pending')

    const shown = await preview(w)
    expect(shown.json.expected.cash).toBe(100)
    expect(shown.json.deadDocuments).toEqual([expect.objectContaining({ id })])
    expect(shown.json.unfinishedReceipts).toEqual([])

    const refused = await close(w, 100)
    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('receipts_unfinished')

    const again = await preview(w)
    expect(again.json.deadDocuments).toEqual([])
    expect(again.json.unfinishedReceipts).toEqual([expect.objectContaining({ id, inDoubt: true })])
  })

  it('one still running is no business of the preview\'s figures: it holds the close, and it is said so', async () => {
    const w = await tillWorld(app)
    const held = gate()
    w.sim!.beforeCommand = cmd => (cmd === 0x38 ? held.closed : undefined)
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    const paying = pay(w, d.id, 24)
    await until(() => w.sim!.receipt?.payments.length === 1, 'the receipt to take its money')

    const shown = await preview(w)

    expect(shown.json.expected.cash).toBe(100)
    expect(shown.json.deadDocuments).toEqual([])
    expect(shown.json.unfinishedReceipts).toEqual([expect.objectContaining({ kind: 'payment' })])
    w.sim!.beforeCommand = null
    held.open()
    expect((await paying).status).toBe(200)
  })

  it('what a sale, a receipt and a storno book is one function, read by the preview and by the steps', () => {
    const payments = [{ method: 'cash', amount: 12 }]
    const reg = (fiscal: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ fiscal, ...extra })
    const sale = { type: 'cash_sale', total: 12, payments, register: reg({ state: 'pending' }) }
    const receipt = (state: string, extra = {}) => ({ type: 'payment_receipt', total: 24, payments: [{ method: 'cash', amount: 24 }], register: reg({ state }, extra) })
    const storno = (state: string) => ({ type: 'cash_storno', total: 12, payments, register: reg({ state }) })

    expect(bookedOnItsSession(sale)).toMatchObject({ totalCash: 12, totalSales: 12, transactionCount: 1 })
    expect(bookedOnItsSession(receipt('printed'))).toMatchObject({ totalCash: 24 })
    expect(bookedOnItsSession(receipt('unknown'))).toMatchObject({ totalCash: 24 })
    for (const state of ['pending', 'failed']) expect(bookedOnItsSession(receipt(state))).toBeNull()
    expect(bookedOnItsSession(receipt('unknown', { inDoubt: undefined }))).toMatchObject({ totalCash: 24 })
    expect(bookedOnItsSession({ ...receipt('unknown'), register: { fiscal: { state: 'unknown', inDoubt: true } } })).toBeNull()
    expect(bookedOnItsSession(receipt('printed', { sessionTotalsApplied: true }))).toBeNull()
    expect(bookedOnItsSession({ ...receipt('printed'), status: 'voided' })).toBeNull()
    for (const state of ['printed', 'none']) expect(bookedOnItsSession(storno(state), { total: 12 })).toMatchObject({ totalCash: -12, totalReturns: 12, transactionCount: 1 })
    for (const state of ['pending', 'unknown', 'failed']) expect(bookedOnItsSession(storno(state), { total: 12 })).toBeNull()
  })
})

describe('a session takes nothing new unless it is open (the fourth read, finding 1)', () => {
  const Z = 0x45
  const closedOnDevice = (w: TillWorld) => w.sim!.receipts.filter(r => !r.voided)
  /** A close with its Z held on the device: claimed, its `expected` read, and nothing left but to wait. */
  async function closingInItsZ(w: TillWorld, cash: number) {
    const held = gate()
    let reached = false
    w.sim!.beforeCommand = (cmd) => {
      if (cmd !== Z) return undefined
      reached = true
      return held.closed
    }
    const closing = close(w, cash)
    await until(() => reached, 'the Z to be under way')
    expect((await sessionOf(w)).status).toBe('closing_control')
    return {
      closing,
      finish: async () => {
        w.sim!.beforeCommand = null
        held.open()
        return closing
      },
    }
  }

  for (const nonFiscal of [false, true]) {
    it(`a ${nonFiscal ? 'text' : 'fiscal'} sale sent during the Z is refused at the door: nothing printed, nothing booked, and the close's difference is 0`, async () => {
      const w = await tillWorld(app)
      const z = await closingInItsZ(w, 100)
      const printed = closedOnDevice(w).length

      const r = await w.sell(1, { nonFiscal })

      expect(r.status).toBe(409)
      expect(r.json.code).toBe('session_closing')
      expect(r.json.message).toContain('being closed')
      const done = await z.finish()
      expect(done.status).toBe(200)
      expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_sale' })).toBe(0)
      expect(closedOnDevice(w)).toHaveLength(printed)
      expect((await w.stock()).quantity).toBe(10)
      expect(await sessionOf(w)).toMatchObject({ status: 'closed', totalCash: 0, expectedBalance: 100, difference: 0, transactionCount: 0 })
    })
  }

  for (const nonFiscal of [true, false]) {
    it(`a storno of a ${nonFiscal ? 'text' : 'fiscal'} sale sent during the Z is refused at the door: the sale stands, and the close's difference is 0`, async () => {
      const w = await tillWorld(app)
      const id = String((await w.sell(1, { nonFiscal })).json.transaction.id)
      const z = await closingInItsZ(w, 112)
      const printed = closedOnDevice(w).length

      const r = await w.storno(id)

      expect(r.status).toBe(409)
      expect(r.json.code).toBe('session_closing')
      expect((await z.finish()).status).toBe(200)
      expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_storno' })).toBe(0)
      expect((await read(id)).register.stornoState).not.toBe('full')
      expect(closedOnDevice(w)).toHaveLength(printed)
      expect((await w.stock()).quantity).toBe(9)
      expect(await sessionOf(w)).toMatchObject({ status: 'closed', totalCash: 12, totalReturns: 0, expectedBalance: 112, difference: 0 })
    })
  }

  it('the journal\'s storno door says the same', async () => {
    const w = await tillWorld(app)
    const id = String((await w.sell(1)).json.transaction.id)
    const z = await closingInItsZ(w, 112)

    const r = await w.call('POST', `/cash-register/documents/${id}/storno`, { reason: 'customer_return', sessionId: w.sessionId })

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('session_closing')
    expect((await z.finish()).status).toBe(200)
  })

  it('a keyed retry of a sale made before the close replays through all of it, during the Z and after', async () => {
    const w = await tillWorld(app)
    const key = 'sale-before-the-close'
    const first = await w.sell(1, {}, key)
    expect(first.status).toBe(200)
    const z = await closingInItsZ(w, 112)
    const printed = closedOnDevice(w).length

    const during = await w.sell(1, {}, key)

    expect(during.status).toBe(200)
    expect(during.json.transaction.id).toBe(first.json.transaction.id)
    expect((await z.finish()).status).toBe(200)
    const after = await w.sell(1, {}, key)
    expect(after.status).toBe(200)
    expect(after.json.transaction.id).toBe(first.json.transaction.id)
    expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_sale' })).toBe(1)
    expect(closedOnDevice(w)).toHaveLength(printed)
    expect(await sessionOf(w)).toMatchObject({ status: 'closed', totalCash: 12, difference: 0 })
  })

  it('a keyed retry of a storno made before the close replays too', async () => {
    const w = await tillWorld(app)
    const id = String((await w.sell(1)).json.transaction.id)
    const key = 'storno-before-the-close'
    const first = await w.storno(id, key)
    expect(first.status).toBe(200)
    const z = await closingInItsZ(w, 100)

    const during = await w.storno(id, key)

    expect(during.status).toBe(200)
    expect(during.json.transaction.id).toBe(first.json.transaction.id)
    expect((await z.finish()).status).toBe(200)
    expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_storno' })).toBe(1)
  })

  it('a session back to `open` after a dead close sells again', async () => {
    const w = await tillWorld(app)
    await POSSession.updateOne({ _id: w.sessionId }, { $set: { status: 'closing_control', closeLeaseUntil: new Date(Date.now() - 1000) } })
    expect((await w.sell(1)).json.code).toBe('session_closing')

    expect((await close(w, 100)).json.code).toBe('close_interrupted')

    expect((await sessionOf(w)).status).toBe('open')
    expect((await w.sell(1)).status).toBe(200)
  })

  it('a keyed retry of a sale that reached the device is not taken back, whatever the session says now', async () => {
    const w = await tillWorld(app)
    const key = 'reached-the-device'
    const id = await deadSale(w, atItsPrint, { key })
    await POSSession.updateOne({ _id: w.sessionId }, { $set: { status: 'closing_control', closeLeaseUntil: new Date(Date.now() + 60_000) } })

    const r = await w.sell(1, {}, key)

    expect(r.status).toBe(200)
    expect(r.json.transaction.id).toBe(id)
    expect((await read(id)).completedAt).toBeTruthy()
  })

  it('a keyed retry of one that stopped after its totals is not taken back either, and books nothing twice', async () => {
    const w = await tillWorld(app, { device: false })
    const key = 'stopped-after-its-totals'
    const undo = diesAt(update => !!update?.$set?.completedAt)
    try {
      expect((await w.sell(1, {}, key)).status).toBe(500)
    } finally {
      undo()
    }
    const sale = await lastSale(w)
    expect(sale.register.sessionTotalsApplied).toBe(true)
    await Invoice.updateOne({ _id: sale._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })
    await POSSession.updateOne({ _id: w.sessionId }, { $set: { status: 'closing_control', closeLeaseUntil: new Date(Date.now() + 60_000) } })

    const r = await w.sell(1, {}, key)

    expect(r.status).toBe(200)
    expect((await read(sale._id)).completedAt).toBeTruthy()
    expect(await sessionOf(w)).toMatchObject({ totalCash: 12, transactionCount: 1 })
    expect((await w.stock()).quantity).toBe(9)
  })

  it('a closed session answers as it always did', async () => {
    const w = await tillWorld(app)
    expect((await close(w, 100)).status).toBe(200)

    const r = await w.sell(1)

    expect(r.status).toBe(400)
    expect(r.json.message).toBe('Session is closed')
  })

  describe('in its turn', () => {
    /** A sale that got past the door and waits behind a report, with the device's turn held. */
    async function waitingItsTurn(w: TillWorld, o: { nonFiscal?: boolean; key?: string } = {}) {
      const taken = gate()
      const holder = deviceTurn(w.deviceId, () => taken.closed)
      const selling = w.sell(1, { nonFiscal: o.nonFiscal }, o.key)
      await until(async () => !!(await lastSale(w)), 'the sale to be written')
      return { selling, go: async () => { taken.open(); await holder } }
    }

    for (const nonFiscal of [false, true]) {
      it(`a ${nonFiscal ? 'text' : 'fiscal'} sale whose turn comes with the session no longer open gives way: nothing printed, nothing booked, and no document`, async () => {
        const w = await tillWorld(app)
        const waiting = await waitingItsTurn(w, { nonFiscal, key: `gives-way-${nonFiscal}` })
        const printed = closedOnDevice(w).length
        await POSSession.updateOne({ _id: w.sessionId }, { $set: { status: 'closing_control', closeLeaseUntil: new Date(Date.now() + 60_000) } })

        await waiting.go()
        const r = await waiting.selling

        expect(r.status).toBe(409)
        expect(r.json.code).toBe('session_closing')
        expect(closedOnDevice(w)).toHaveLength(printed)
        expect(w.sim!.receipt).toBeNull()
        expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_sale' })).toBe(0)
        expect((await w.stock()).quantity).toBe(10)
        expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalSales: 0, transactionCount: 0 })
      })
    }

    it('a sale that holds the turn first holds the close, and it closes once that is done', async () => {
      const w = await tillWorld(app)
      const waiting = await waitingItsTurn(w)

      const refused = await close(w, 112)

      expect(refused.status).toBe(409)
      expect(refused.json.code).toBe('receipts_unfinished')
      expect(refused.json.receipts).toEqual([expect.objectContaining({ kind: 'sale' })])
      expect((await sessionOf(w)).status).toBe('open')

      await waiting.go()
      expect((await waiting.selling).status).toBe(200)
      expect((await close(w, 112)).status).toBe(200)
      expect(await sessionOf(w)).toMatchObject({ status: 'closed', totalCash: 12, difference: 0 })
    })
  })

  describe('with no device there is no turn, so a close landing anywhere either finds it or it gives way', () => {
    /** Run the whole of `meanwhile` right before the next write of a document of this type. */
    function atItsInsert(type: string, meanwhile: () => Promise<unknown>) {
      const real = Invoice.create
      let done = false
      ;(Invoice as any).create = async function (...args: any[]) {
        if (!done && args[0]?.type === type) {
          done = true
          await meanwhile()
        }
        return (real as any).apply(Invoice, args)
      }
      return () => { (Invoice as any).create = real }
    }
    /** Run `meanwhile` right before the next document's session totals. */
    function atItsTotals(meanwhile: () => Promise<unknown>) {
      const real = Invoice.startSession
      let done = false
      ;(Invoice as any).startSession = async function (...args: any[]) {
        if (!done) {
          done = true
          await meanwhile()
        }
        return (real as any).apply(Invoice, args)
      }
      return () => { (Invoice as any).startSession = real }
    }

    it('a sale past the door, the close landing before its insert: it finds the session gone, and gives way', async () => {
      const w = await tillWorld(app, { device: false })
      let closed: any
      const undo = atItsInsert('cash_sale', async () => { closed = await close(w, 100) })
      let r: any
      try {
        r = await w.sell(1, {}, 'a-sale-past-the-door')
      } finally {
        undo()
      }

      expect(closed.status).toBe(200)
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('session_closing')
      expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_sale' })).toBe(0)
      expect((await w.stock()).quantity).toBe(10)
      expect(await sessionOf(w)).toMatchObject({ status: 'closed', totalCash: 0, expectedBalance: 100, difference: 0 })
    })

    it('a sale written, the close landing before its totals: the close finds it, and refuses', async () => {
      const w = await tillWorld(app, { device: false })
      let closed: any
      const undo = atItsTotals(async () => { closed = await close(w, 112) })
      let r: any
      try {
        r = await w.sell(1)
      } finally {
        undo()
      }

      expect(closed.status).toBe(409)
      expect(closed.json.code).toBe('receipts_unfinished')
      expect(r.status).toBe(200)
      expect((await close(w, 112)).status).toBe(200)
      expect(await sessionOf(w)).toMatchObject({ status: 'closed', totalCash: 12, expectedBalance: 112, difference: 0 })
      expect((await w.stock()).quantity).toBe(9)
    })

    it('a sale that finishes between the claim and the close\'s second look: found by neither, and what it booked is in `expected`', async () => {
      const w = await tillWorld(app, { device: false })
      const held = gate()
      const real = Invoice.startSession
      let reached = false
      ;(Invoice as any).startSession = async function (...args: any[]) {
        reached = true
        await held.closed
        return (real as any).apply(Invoice, args)
      }
      const selling = w.sell(1)
      await until(() => reached, 'the sale to reach its totals')
      ;(Invoice as any).startSession = real
      const claim = POSSession.findOneAndUpdate
      let answer: any
      ;(POSSession as any).findOneAndUpdate = function (filter: any, update: any, ...rest: any[]) {
        if (update?.$set?.status !== 'closing_control') return (claim as any).call(POSSession, filter, update, ...rest)
        return {
          exec: async () => {
            const doc = await (claim as any).call(POSSession, filter, update, ...rest).exec()
            held.open()
            answer = await selling
            return doc
          },
        }
      }
      // Past the first look, which finds it unfinished: this one is forced through to the claim.
      const unfinished = spyOn(Invoice, 'find')
      unfinished.mockImplementationOnce((() => ({ sort: () => ({ lean: () => ({ exec: async () => [] }) }) })) as any)
      unfinished.mockImplementationOnce((() => ({ sort: () => ({ lean: () => ({ exec: async () => [] }) }) })) as any)
      unfinished.mockImplementationOnce((() => ({ lean: () => ({ exec: async () => [] }) })) as any)
      unfinished.mockImplementationOnce((() => ({ sort: () => ({ lean: () => ({ exec: async () => [] }) }) })) as any)
      let r: any
      try {
        r = await close(w, 112)
      } finally {
        unfinished.mockRestore()
        ;(POSSession as any).findOneAndUpdate = claim
      }

      expect(answer.status).toBe(200)
      expect(r.status).toBe(200)
      expect(await sessionOf(w)).toMatchObject({ status: 'closed', totalCash: 12, expectedBalance: 112, difference: 0 })
    })

    it('a text storno past the door, the close landing before its insert: voided with its number, the sale given back, and the close stands', async () => {
      const w = await tillWorld(app)
      const id = String((await w.sell(1, { nonFiscal: true })).json.transaction.id)
      let closed: any
      const undo = atItsInsert('cash_storno', async () => { closed = await close(w, 112) })
      let r: any
      try {
        r = await w.storno(id)
      } finally {
        undo()
      }

      expect(closed.status).toBe(200)
      expect(r.status).toBe(503)
      expect(r.json.message).toContain('The session closed')
      const storno: any = await Invoice.findOne({ orgId: w.oid, type: 'cash_storno' }).lean().exec()
      expect(storno.status).toBe('voided')
      expect((await read(id)).register.stornoState).toBe('none')
      expect((await w.stock()).quantity).toBe(9)
      expect(await sessionOf(w)).toMatchObject({ status: 'closed', totalCash: 12, totalReturns: 0, expectedBalance: 112, difference: 0 })
    })

    it('a text storno written, the close landing before its totals: the close finds it, and refuses', async () => {
      const w = await tillWorld(app)
      const id = String((await w.sell(1, { nonFiscal: true })).json.transaction.id)
      let closed: any
      const undo = atItsTotals(async () => { closed = await close(w, 100) })
      let r: any
      try {
        r = await w.storno(id)
      } finally {
        undo()
      }

      expect(closed.status).toBe(409)
      expect(closed.json.code).toBe('receipts_unfinished')
      expect(r.status).toBe(200)
      expect((await close(w, 100)).status).toBe(200)
      expect(await sessionOf(w)).toMatchObject({ status: 'closed', totalCash: 0, totalReturns: 12, expectedBalance: 100, difference: 0 })
    })

    it('a sale that died is still finished by what comes to it: a dead sale is no new sale', async () => {
      const w = await tillWorld(app)
      const id = await deadSale(w, atItsAttempt, { nonFiscal: true })
      await POSSession.updateOne({ _id: w.sessionId }, { $set: { status: 'closing_control', closeLeaseUntil: new Date(Date.now() + 60_000) } })

      // Its storno finishes it first, whatever the session says; the door then answers for the session.
      const r = await w.storno(id)

      expect(r.json.code).toBe('session_closing')
      expect((await read(id)).completedAt).toBeTruthy()
    })
  })
})

describe('the storno of a sale that died: it is finished first (finding 5)', () => {
  it('a text sale: the reader\'s run. Its money is booked, the storno gives it back, and the retry changes nothing', async () => {
    const w = await tillWorld(app)
    const key = 'text-sale-died-0001'
    const body = w.saleBody(1, { nonFiscal: true })
    const id = await deadSale(w, atItsPrint, { nonFiscal: true, key })
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 0 })
    expect((await w.stock()).quantity).toBe(10)

    const storno = await w.storno(id)

    expect(storno.status).toBe(200)
    // Booked and then given back: not -12 in a drawer that never had it.
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalSales: 12, totalReturns: 12 })
    expect((await w.stock()).quantity).toBe(10)
    expect((await read(id)).completedAt).toBeTruthy()
    const movements = await StockMovement.countDocuments({ orgId: w.oid })

    const retry = await w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, body, key)

    expect(retry.status).toBe(200)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalSales: 12, totalReturns: 12 })
    expect((await w.stock()).quantity).toBe(10)
    expect(await StockMovement.countDocuments({ orgId: w.oid })).toBe(movements)
    expect((await read(id)).register.stornoState).toBe('full')
  })

  it('a fiscal sale: its money is booked, and the storno answers that a person must say', async () => {
    const w = await tillWorld(app)
    const id = await deadSale(w, atItsPrint)

    const r = await w.storno(id)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('sale_receipt_in_doubt')
    expect(await sessionOf(w)).toMatchObject({ totalCash: 12, totalReturns: 0 })
    expect((await w.stock()).quantity).toBe(9)
    expect((await read(id)).register.stornoState).not.toBe('full')
    expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_storno' })).toBe(0)

    // A person says, and the storno goes through, once.
    expect((await settle(w, id, true, w.sim!.receipts.at(-1)!.number)).status).toBe(200)
    expect((await w.storno(id)).status).toBe(200)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 12 })
    expect((await w.stock()).quantity).toBe(10)
  })

  it('one stopped after its print: finished, and reversed, with the number it printed under', async () => {
    const w = await tillWorld(app)
    const id = await deadSale(w, atItsTotals)
    expect((await read(id)).register.fiscal.state).toBe('printed')

    const r = await w.storno(id)

    expect(r.status).toBe(200)
    expect(w.sim!.receipts.filter(x => x.kind === 'storno')).toHaveLength(1)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalSales: 12, totalReturns: 12 })
    expect((await w.stock()).quantity).toBe(10)
  })

  for (const nonFiscal of [true, false]) {
    it(`a ${nonFiscal ? 'text' : 'fiscal'} sale still running: refused as that, whatever it prints, and it finishes as it would have`, async () => {
      const w = await tillWorld(app)
      const held = gate()
      w.sim!.beforeCommand = cmd => (cmd === 0x27 || cmd === 0x38 ? held.closed : undefined)
      const key = `sale-running-${nonFiscal}`
      const selling = w.sell(1, { nonFiscal }, key)
      await until(async () => !!(await lastSale(w))?.register?.fiscal?.attemptedAt, 'the sale to reach the device')
      const id = String((await lastSale(w))._id)

      const r = await w.storno(id)

      expect(r.status).toBe(409)
      expect(r.json.code).toBe('sale_in_progress')
      expect(r.json.message).toContain('Nothing was reversed')
      expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_storno' })).toBe(0)
      expect((await read(id)).register.stornoState).not.toBe('full')

      w.sim!.beforeCommand = null
      held.open()
      expect((await selling).status).toBe(200)
      expect(await sessionOf(w)).toMatchObject({ totalCash: 12, totalReturns: 0 })
      expect((await w.stock()).quantity).toBe(9)
      expect((await w.storno(id)).status).toBe(200)
      expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 12 })
      expect((await w.stock()).quantity).toBe(10)
    })
  }

  it('one whose finish throws is refused too, and refunds nothing', async () => {
    const w = await tillWorld(app)
    const id = await deadSale(w, atItsPrint, { nonFiscal: true })
    const dies = spyOn(Invoice, 'startSession').mockImplementationOnce(() => { throw new Error('the database went away') })

    const r = await w.storno(id)

    dies.mockRestore()
    expect(r.status).toBe(409)
    expect(r.json.code).toBe('sale_in_progress')
    expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_storno' })).toBe(0)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 0 })
  })

  it('a back-office sale with no session, whose keyed create died: finished the same, and the retry changes nothing', async () => {
    const w = await tillWorld(app)
    const key = 'backoffice-died-0001'
    const undo = diesAt(update => !!update?.$set?.completedAt)
    let r: any
    try {
      r = await w.backOfficeSale(1, {}, key)
    } finally {
      undo()
    }
    expect(r.status).toBe(500)
    const sale = await lastSale(w)
    expect(sale.register.sessionId).toBeUndefined()
    await Invoice.updateOne({ _id: sale._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })

    const storno = await w.call('POST', `/cash-register/documents/${sale._id}/storno`, { reason: 'customer_return' }, undefined, w.clerkToken)

    expect(storno.status).toBe(200)
    expect((await read(sale._id)).completedAt).toBeTruthy()
    expect((await w.stock()).quantity).toBe(10)
    expect((await w.backOfficeSale(1, {}, key)).status).toBe(200)
    expect((await w.stock()).quantity).toBe(10)
  })

  it('an imported day whose create died is refused as an imported day, and left as it is', async () => {
    const w = await tillWorld(app)
    const imported: any = await Invoice.create({
      orgId: w.oid, invoiceNumber: 'CSR-DIED-0001', type: 'cash_sale', direction: 'outgoing', status: 'paid', issueDate: new Date(), dueDate: new Date(), currency: 'EUR', exchangeRate: 1, total: 12,
      lines: [{ productId: w.product._id, warehouseId: w.warehouse._id, description: 'x', quantity: 1, unit: 'бр.', unitPrice: 10, taxRate: 20, taxAmount: 2, lineTotal: 12 }],
      billingAddress: { street: '-' }, createdBy: w.user._id, leaseUntil: new Date(Date.now() - 1000),
      register: { origin: 'import' }, tags: ['cash-register-import'],
    })

    const r = await w.call('POST', `/cash-register/documents/${imported._id}/storno`, { reason: 'customer_return' })

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('storno_imported_day')
    expect((await read(imported._id)).completedAt).toBeUndefined()
    expect((await w.stock()).quantity).toBe(10)
  })

  it('an old sale with no finish, no lease and no session is no dead sale: its steps do not run again', async () => {
    const w = await tillWorld(app)
    const old: any = await Invoice.create({
      orgId: w.oid, invoiceNumber: 'CS-OLD-0002', type: 'cash_sale', direction: 'outgoing', status: 'paid', issueDate: new Date(), dueDate: new Date(), currency: 'EUR', exchangeRate: 1, total: 12,
      lines: [{ productId: w.product._id, warehouseId: w.warehouse._id, description: 'x', quantity: 1, unit: 'бр.', unitPrice: 10, taxRate: 20, taxAmount: 2, lineTotal: 12 }],
      billingAddress: { street: '-' }, createdBy: w.user._id, register: { origin: 'backoffice' },
    })
    await Invoice.collection.updateOne({ _id: old._id }, { $set: { createdAt: new Date(Date.now() - LEASE_MS - 1000) } })

    const r = await w.call('POST', `/cash-register/documents/${old._id}/storno`, { reason: 'customer_return' })

    expect(r.status).toBe(200)
    expect(await StockMovement.countDocuments({ orgId: w.oid, invoiceId: old._id, type: 'dispatch' })).toBe(0)
    expect((await w.stock()).quantity).toBe(10)
  })
})

describe('a sale\'s progress, by the table', () => {
  const now = Date.now()
  const base = { type: 'cash_sale', register: { sessionId: 's' }, createdAt: new Date(now) }
  const old = new Date(now - LEASE_MS - 1)

  it('reads what it can, and reads nothing into an old document', () => {
    expect(saleProgress({ ...base, completedAt: new Date(now) }, now)).toBeNull()
    expect(saleProgress({ ...base, register: { sessionId: 's', legacy: {} } }, now)).toBeNull()
    expect(saleProgress({ ...base, type: 'cash_storno' }, now)).toBeNull()
    expect(saleProgress({ ...base, leaseUntil: new Date(now + 1) }, now)).toBe('live')
    expect(saleProgress({ ...base, leaseUntil: new Date(now - 1) }, now)).toBe('dead')
    expect(saleProgress(base, now)).toBe('live')
    expect(saleProgress({ ...base, createdAt: old }, now)).toBe('dead')
    // ⚠ A sale with no session and no lease may be from before `completedAt` existed: its steps must not run.
    expect(saleProgress({ type: 'cash_sale', createdAt: old }, now)).toBeNull()
    expect(saleProgress({ type: 'cash_sale', register: { origin: 'backoffice' }, createdAt: old }, now)).toBeNull()
    // A lapsed lease is a request that died, with a session or none.
    expect(saleProgress({ type: 'cash_sale', leaseUntil: new Date(now - 1) }, now)).toBe('dead')
  })
})

describe('a joined sale\'s transfers are on the document (finding 3)', () => {
  /** A back-office sale joined to the session, with a receipt and a confirmed transfer dialog, that died in its print. */
  async function joinedDead(w: TillWorld, transferId: string) {
    const undo = diesAt(atItsPrint)
    let r: any
    try {
      r = await w.cashierBackOfficeSale(1, { receipt: 'fiscal', pendingTransferIds: [transferId] })
    } finally {
      undo()
    }
    expect(r.status).toBe(500)
    const sale = await lastSale(w)
    expect(sale.register.joinedFrom).toBe('backoffice')
    expect(sale.register.transfersToConfirm.map(String)).toEqual([transferId])
    expect(sale.pendingTransferIds).toHaveLength(0)
    await Invoice.updateOne({ _id: sale._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })
    return String(sale._id)
  }

  it('settled, the transfer completes first, and neither warehouse is wrong', async () => {
    const w = await tillWorld(app, { stock: 0 })
    const t = await transferIn(w)
    const id = await joinedDead(w, t.transferId)
    const number = w.sim!.receipts.at(-1)!.number!

    const r = await settle(w, id, true, number)

    expect(r.status).toBe(200)
    expect((await StockMovement.findById(t.transferId).lean().exec() as any).status).toBe('completed')
    expect(await t.source()).toBe(9)
    expect(await t.here()).toBe(0)
    const sale = await read(id)
    expect(sale.register.stockError).toBeUndefined()
    expect(sale.pendingTransferIds.map(String)).toEqual([t.transferId])
  })

  it('at the close alike', async () => {
    const w = await tillWorld(app, { stock: 0 })
    const t = await transferIn(w)
    await joinedDead(w, t.transferId)

    expect((await close(w, 112)).status).toBe(200)

    expect((await StockMovement.findById(t.transferId).lean().exec() as any).status).toBe('completed')
    expect(await t.source()).toBe(9)
    expect(await t.here()).toBe(0)
  })

  it('a confirm that fails sets `stockError` and never fails the settle', async () => {
    const w = await tillWorld(app, { stock: 0 })
    const t = await transferIn(w)
    const id = await joinedDead(w, t.transferId)
    // Somebody cancelled it while the sale lay dead.
    await StockMovement.updateOne({ _id: t.transferId }, { $set: { status: 'cancelled' } })
    const number = w.sim!.receipts.at(-1)!.number!

    const r = await settle(w, id, true, number)

    expect(r.status).toBe(200)
    const sale = await read(id)
    expect(sale.completedAt).toBeTruthy()
    expect(sale.register.stockError).toBeTruthy()
    expect(sale.register.fiscal.state).toBe('printed')
    expect(await sessionOf(w)).toMatchObject({ totalCash: 12 })
    expect(await t.source()).toBe(10)
  })

  it('a live sale with transfers confirms them as it always did, and one that names none confirms nothing', async () => {
    const w = await tillWorld(app, { stock: 0 })
    const t = await transferIn(w)

    const r = await w.cashierBackOfficeSale(1, { receipt: 'fiscal', pendingTransferIds: [t.transferId] })

    expect(r.status).toBe(200)
    expect((await StockMovement.findById(t.transferId).lean().exec() as any).status).toBe('completed')
    expect(await t.source()).toBe(9)
    expect(await t.here()).toBe(0)
    expect((await lastSale(w)).pendingTransferIds.map(String)).toEqual([t.transferId])
  })
})
