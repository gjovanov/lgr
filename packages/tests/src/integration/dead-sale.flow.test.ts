import { describe, it, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import { gate, sessionOf, until } from '../helpers/receipt-world'
import { createTestAccount, createTestStockLevel, createTestWarehouse } from '../helpers/factories'
import { AuditLog, Invoice, Journal, JournalEntry, Org, POSSession, StockLevel, StockMovement } from 'db/models'
import { LEASE_MS } from 'services/biz/hot-path-key'
import { saleProgress } from 'services/biz/cash-register/in-doubt'
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
