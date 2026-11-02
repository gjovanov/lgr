import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import { computePosTotals, partOfLine } from 'config/pos-totals'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import { createTestContact, createTestProduct, createTestStockLevel, createTestWarehouse } from '../helpers/factories'
import { draftOf, line, pay, raw, send, sessionOf } from '../helpers/receipt-world'
import { Invoice, POSSession, StockLevel, StockMovement } from 'db/models'
import { contactController } from 'invoicing-api/src/controllers/contact.controller'
import { loadPosRows } from 'services/biz/cash-register/pos-union'
import { leftByRate, takeBudget } from 'services/biz/cash-register/refund-budget'
import { releaseOrphanClaims } from 'services/biz/cash-register/register.service'
import { buildSessionReport } from 'services/biz/cash-register/session-report'
import { listJournal } from 'services/biz/cash-register/journal.service'
import { exportCancelledSales, exportReversedSales } from 'services/biz/supto-export.service'
import { reportById, validateParams } from 'services/biz/report-registry'
import { localDayOf } from 'services/biz/local-day'

/**
 * FR-23 R3, #363 — the till's partial storno. A customer brings back one of three articles.
 *
 * Every one of these runs through the real routes on the Eltrade simulator. What cannot be timed is forced, with a
 * write held at the moment that matters (`during`).
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = tillApp().use(contactController) as any
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { forgetDevices(); await clearCollections() }, 30_000)

const CLOSE = 0x38
const PAYMENT = 0x35
const VOID = 0x3C

/** The next print is refused at its money and voided: nothing is on the device, so it is proved not printed. */
function failsProved(w: TillWorld) {
  w.sim!.beforeCommand = (cmd) => {
    if (cmd === PAYMENT) w.sim!.paper = false
    if (cmd === VOID) {
      w.sim!.paper = true
      w.sim!.beforeCommand = null
    }
  }
}

const read = (id: unknown): Promise<any> => Invoice.findById(id).lean().exec() as Promise<any>
/** The day a sale made now belongs to, which is what an invoice attaches by: Sofia's, not UTC's. */
const onSaleDay = () => ({ issueDate: localDayOf(new Date()) })
const stornosOnDevice = (w: TillWorld) => w.sim!.receipts.filter(r => r.kind === 'storno' && !r.voided)
const stornosOf = (saleId: unknown): Promise<any[]> => Invoice.find({ type: 'cash_storno', relatedInvoiceId: saleId }).sort({ _id: 1 }).lean().exec() as Promise<any[]>
const levelOf = async (w: TillWorld, productId: unknown) => {
  const level: any = await StockLevel.findOne({ orgId: w.oid, productId, warehouseId: w.warehouse._id }).lean().exec()
  return level?.quantity
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
/** Run `meanwhile` exactly once, right after the write `at` picks. */
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
/** A storno's claim, about to be written. */
const aClaim = (update: any) => !!update?.$push?.['register.stornoClaims']

interface Sold { saleId: string; sale: any; ids: string[]; products: unknown[] }

/**
 * Three articles on one receipt: 3 × 10 net at 20 % (36.00), 2 × 5 net at 20 % (12.00), 1 × 10 net at 9 % (10.90).
 * 58.90 in all, in cash unless `payments` says.
 */
async function threeArticles(w: TillWorld, o: { payments?: { method: string; amount: number }[]; text?: boolean; discount?: number } = {}): Promise<Sold> {
  const nut = await createTestProduct(w.oid, { name: 'Гайка', sellingPrice: 5, purchasePrice: 2, taxRate: 20, unit: 'бр.' } as any)
  const washer = await createTestProduct(w.oid, { name: 'Шайба', sellingPrice: 10, purchasePrice: 3, taxRate: 9, unit: 'бр.' } as any)
  await createTestStockLevel(w.oid, nut._id, w.warehouse._id, { quantity: 10, availableQuantity: 10, avgCost: 2 } as any)
  await createTestStockLevel(w.oid, washer._id, w.warehouse._id, { quantity: 10, availableQuantity: 10, avgCost: 3 } as any)
  const products = [w.product._id, nut._id, washer._id]
  const discount = o.discount ?? 0
  const raw: { productId: string; name: string; quantity: number; unitPrice: number; taxRate: number }[] = [
    { productId: String(w.product._id), name: 'Болт', quantity: 3, unitPrice: 10, taxRate: 20 },
    { productId: String(nut._id), name: 'Гайка', quantity: 2, unitPrice: 5, taxRate: 20 },
    { productId: String(washer._id), name: 'Шайба', quantity: 1, unitPrice: 10, taxRate: 9 },
  ]
  const lines = raw.map((l) => {
    const net = l.quantity * l.unitPrice * (1 - discount / 100)
    return { ...l, discount, lineTotal: Math.round(net * 100) / 100, taxAmount: Math.round(((net * l.taxRate) / 100) * 100) / 100 }
  })
  const t = computePosTotals(lines.map(l => ({ quantity: l.quantity, unitPrice: l.unitPrice, discount, taxRate: l.taxRate })))
  const body = {
    type: 'sale', lines, subtotal: t.subtotal, discountTotal: t.discountTotal, taxTotal: t.taxTotal, total: t.total,
    payments: o.payments ?? [{ method: 'cash', amount: t.total }], changeDue: 0,
  }
  // A text sale is what a device that says it is not fiscalized prints, and nothing a request says makes one.
  if (o.text) w.sim!.unfiscalizedUnit = true
  const res = await w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, body)
  if (o.text) w.sim!.unfiscalizedUnit = false
  expect(res.status).toBe(200)
  const saleId = String(res.json.transaction.id ?? res.json.transaction._id)
  const sale = await read(saleId)
  return { saleId, sale, products, ids: sale.lines.map((l: any) => String(l._id)) }
}

/** `[line index, quantity]` of this sale, back through the till's own route. */
const back = (w: TillWorld, s: Sold, picks: [number, number][], key?: string, extra: Record<string, unknown> = {}) =>
  w.storno(s.saleId, key, { lines: picks.map(([i, quantity]) => ({ lineId: s.ids[i], quantity })), ...extra })

const closeOn = (w: TillWorld, cash: number) => w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash } })
const preview = (w: TillWorld) => w.call('GET', `/trade/pos/session/${w.sessionId}/close-preview`)

describe('one article of three comes back', () => {
  it('its storno carries that line alone, cites the sale, and only its stock and its money move', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const before = await sessionOf(w)

    const r = await back(w, s, [[0, 1]])

    expect(r.status).toBe(200)
    const [storno] = await stornosOf(s.saleId)
    expect(storno.total).toBe(12)
    expect(storno.subtotal).toBe(10)
    expect(storno.taxTotal).toBe(2)
    expect(storno.amountPaid).toBe(12)
    expect(storno.lines).toHaveLength(1)
    expect(storno.lines[0]).toMatchObject({ description: 'Болт', quantity: 1, lineTotal: 12, taxAmount: 2 })
    expect(storno.payments).toEqual([expect.objectContaining({ method: 'cash', amount: 12 })])
    expect(storno.register.storno).toMatchObject({ originalId: s.sale._id, originalUnp: s.sale.register.unp, originalReceiptNumber: s.sale.register.fiscalReceiptNumber, partial: true })

    // On the device: that line, and the sale's УНП and number on its header.
    const [printed] = stornosOnDevice(w)
    expect(printed.sales).toHaveLength(1)
    expect(printed.sales[0]).toMatchObject({ quantity: 1, price: 12 })
    expect(printed.total).toBe(12)
    expect(printed.payments).toHaveLength(1)
    expect(printed.header[1]).toBe(s.sale.register.unp)
    expect(printed.header[5]).toBe(s.sale.register.fiscalReceiptNumber)

    // The sale stays paid and says how far it went.
    const sale = await read(s.saleId)
    expect(sale.status).toBe('paid')
    expect(sale.register.stornoState).toBe('partial')
    expect(sale.register.stornoedBy.map(String)).toEqual([String(storno._id)])
    expect(sale.register.cancelledAt).toBeUndefined()
    expect(sale.register.refundClaims).toEqual([{ stornoId: storno._id, rate: 20, cents: 1200 }])

    // The stock of that line, none of the others.
    expect(await levelOf(w, s.products[0])).toBe(10 - 3 + 1)
    expect(await levelOf(w, s.products[1])).toBe(10 - 2)
    expect(await levelOf(w, s.products[2])).toBe(10 - 1)

    const now = await sessionOf(w)
    expect(now.totalReturns).toBe((before.totalReturns || 0) + 12)
    expect(now.totalCash).toBe(before.totalCash - 12)
  })

  it('the stock comes back at the cost it left at, whatever the article costs now and whatever it sold for', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    await StockLevel.updateOne({ orgId: w.oid, productId: s.products[0], warehouseId: w.warehouse._id }, { $set: { avgCost: 7 } })

    expect((await back(w, s, [[0, 2]])).status).toBe(200)

    const [storno] = await stornosOf(s.saleId)
    const m: any = await StockMovement.findOne({ orgId: w.oid, invoiceId: storno._id, type: 'return' }).lean().exec()
    expect(m.toWarehouseId).toEqual(w.warehouse._id)
    expect(m.status).toBe('completed')
    expect(m.lines).toHaveLength(1)
    expect(m.lines[0]).toMatchObject({ quantity: 2, unitCost: 4, totalCost: 8 })
    expect(String(m.lines[0].productId)).toBe(String(s.products[0]))
  })

  it('a discounted line goes back discounted, on the document and on the device', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w, { discount: 10 })
    expect(w.sim!.receipts.at(-1)!.total).toBe(s.sale.total)

    expect((await back(w, s, [[0, 1]])).status).toBe(200)

    const [storno] = await stornosOf(s.saleId)
    expect(storno.total).toBe(10.8)
    expect(storno.discountTotal).toBe(1)
    const [printed] = stornosOnDevice(w)
    expect(printed.sales[0]).toMatchObject({ quantity: 1, price: 12, percent: -10, amount: 10.8 })
    expect(printed.total).toBe(10.8)
    expect(printed.paid).toBe(10.8)
  })

  it('a whole storno of a discounted sale adds up on the device too: it used to print the undiscounted lines', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w, { discount: 10 })
    expect((await w.storno(s.saleId)).status).toBe(200)
    const [printed] = stornosOnDevice(w)
    expect(printed.total).toBe(s.sale.total)
    expect(printed.paid).toBe(s.sale.total)
  })

  it('whole stays what it was: no lines named, the sale\'s own figures, and it ends full', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)

    expect((await w.storno(s.saleId)).status).toBe(200)

    const [storno] = await stornosOf(s.saleId)
    expect(storno.total).toBe(s.sale.total)
    expect(storno.subtotal).toBe(s.sale.subtotal)
    expect(storno.lines).toHaveLength(3)
    expect(storno.register.storno.partial).toBeUndefined()
    const sale = await read(s.saleId)
    expect(sale.register.stornoState).toBe('full')
    expect(sale.register.cancelledAt).toBeTruthy()
    expect(await levelOf(w, s.products[0])).toBe(10)
    expect(await levelOf(w, s.products[1])).toBe(10)
    expect(await levelOf(w, s.products[2])).toBe(10)
    expect(stornosOnDevice(w)[0].sales).toHaveLength(3)
  })

  it('every line named in full is the whole sale, by its own figures', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    expect((await back(w, s, [[0, 3], [1, 2], [2, 1]])).status).toBe(200)
    const [storno] = await stornosOf(s.saleId)
    expect(storno.register.storno.partial).toBeUndefined()
    expect(storno.total).toBe(s.sale.total)
    expect((await read(s.saleId)).register.stornoState).toBe('full')
  })

  it('refused before anything is claimed: an unknown line, a wrong quantity, nothing left, a refund that does not add up', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const unknown = await w.storno(s.saleId, undefined, { lines: [{ lineId: 'nope', quantity: 1 }] })
    expect([unknown.status, unknown.json.code]).toEqual([422, 'storno_line_unknown'])
    for (const quantity of [0, -1, 0.0001]) {
      const r = await back(w, s, [[0, quantity]])
      expect([r.status, r.json.code]).toEqual([422, 'storno_quantity_invalid'])
    }
    const over = await back(w, s, [[0, 4]])
    expect([over.status, over.json.code]).toEqual([409, 'storno_exceeds_left'])
    expect(over.json.lines).toEqual([{ lineId: s.ids[0], left: 3, requested: 4 }])
    const twice = await back(w, s, [[0, 2], [0, 2]])
    expect(twice.json.code).toBe('storno_exceeds_left')
    const mismatch = await back(w, s, [[0, 1]], undefined, { payments: [{ method: 'cash', amount: 11.99 }] })
    expect([mismatch.status, mismatch.json.code, mismatch.json.amount]).toEqual([422, 'storno_refund_mismatch', 12])

    const sale = await read(s.saleId)
    expect(sale.register.stornoState).toBe('none')
    expect(sale.register.stornoClaims ?? []).toHaveLength(0)
    expect(await stornosOf(s.saleId)).toHaveLength(0)
    expect(stornosOnDevice(w)).toHaveLength(0)
  })

  it('an empty list of lines is no way to say all of it: refused by the route', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const r = await w.storno(s.saleId, undefined, { lines: [] })
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(r.status).toBeLessThan(500)
    expect(stornosOnDevice(w)).toHaveLength(0)
  })

  it('refused with the device offline, as a whole storno is (#281): never claimed', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    forgetDevices()
    const r = await back(w, s, [[0, 1]])
    expect([r.status, r.json.code]).toEqual([503, 'fiscal_device_unavailable'])
    const sale = await read(s.saleId)
    expect(sale.register.stornoState).toBe('none')
    expect(sale.register.stornoClaims ?? []).toHaveLength(0)
    expect(await stornosOf(s.saleId)).toHaveLength(0)
  })
})

describe('the budget of a line: sold, less what live stornos returned', () => {
  it('several parts add up to the sale to the cent, the last takes the rest, and it ends full', async () => {
    const w = await tillWorld(app)
    // 3 × 3.33 gross: thirds of it do not round to a third of the line's money.
    const p = await createTestProduct(w.oid, { name: 'Дюбел', sellingPrice: 2.775, purchasePrice: 1, taxRate: 20, unit: 'бр.' } as any)
    await createTestStockLevel(w.oid, p._id, w.warehouse._id, { quantity: 50, availableQuantity: 50, avgCost: 1 } as any)
    const t = computePosTotals([{ quantity: 3, unitPrice: 2.775, taxRate: 20 }])
    const res = await w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, {
      type: 'sale',
      lines: [{ productId: String(p._id), name: 'Дюбел', quantity: 3, unitPrice: 2.775, discount: 0, taxRate: 20, taxAmount: 1.67, lineTotal: 8.33 }],
      subtotal: t.subtotal, discountTotal: 0, taxTotal: t.taxTotal, total: t.total,
      payments: [{ method: 'cash', amount: t.total }], changeDue: 0,
    })
    expect(res.status).toBe(200)
    const saleId = String(res.json.transaction.id)
    const sale = await read(saleId)
    const s: Sold = { saleId, sale, ids: sale.lines.map((l: any) => String(l._id)), products: [p._id] }

    for (const i of [1, 2, 3]) expect((await back(w, s, [[0, 1]])).status, `part ${i}`).toBe(200)

    const stornos = await stornosOf(saleId)
    expect(stornos).toHaveLength(3)
    const sum = stornos.reduce((c, d) => c + Math.round(d.total * 100), 0)
    expect(sum).toBe(Math.round(sale.total * 100))
    const after = await read(saleId)
    expect(after.register.stornoState).toBe('full')
    expect(after.register.cancelledAt).toBeTruthy()
    expect(leftByRate(after).size).toBe(0)
    const over = await back(w, s, [[0, 1]])
    expect(over.status).toBe(400)
    expect(over.json.message).toContain('already cancelled')
  })

  it('a part, then a part of what is left, then more than is left: refused, and nothing prints', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    expect((await back(w, s, [[0, 2]])).status).toBe(200)
    const onDevice = stornosOnDevice(w).length

    const r = await back(w, s, [[0, 2]])

    expect([r.status, r.json.code]).toEqual([409, 'storno_exceeds_left'])
    expect(r.json.lines).toEqual([{ lineId: s.ids[0], left: 1, requested: 2 }])
    expect(stornosOnDevice(w)).toHaveLength(onDevice)
    expect((await back(w, s, [[0, 1]])).status).toBe(200)
    expect(await levelOf(w, s.products[0])).toBe(10)
    expect((await read(s.saleId)).register.stornoState).toBe('partial')
  })

  it('a part, then a whole of what is left: it reverses what is left, and the session comes to nothing', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    expect((await back(w, s, [[0, 1], [2, 1]])).status).toBe(200)

    const r = await w.storno(s.saleId)

    expect(r.status).toBe(200)
    const [first, second] = await stornosOf(s.saleId)
    expect(first.total).toBe(22.9)
    expect(second.total).toBe(36)
    expect(second.register.storno.partial).toBe(true)
    expect(second.lines.map((l: any) => [l.description, l.quantity])).toEqual([['Болт', 2], ['Гайка', 2]])
    expect(stornosOnDevice(w)[1].sales).toHaveLength(2)
    expect((await read(s.saleId)).register.stornoState).toBe('full')
    for (const p of s.products) expect(await levelOf(w, p)).toBe(10)
    const session = await sessionOf(w)
    expect(session.totalCash).toBe(0)
    expect(session.totalReturns).toBe(58.9)
    expect((await w.storno(s.saleId)).status).toBe(400)
  })

  it('two parts of one line racing, and only one fits: the later gives way, on its fresh read, with nothing printed', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    let other: any
    const undo = during(aClaim, async () => { other = await back(w, s, [[0, 2]]) })
    let r: any
    try {
      r = await back(w, s, [[0, 2]])
    } finally {
      undo()
    }
    expect(other.status).toBe(200)
    expect([r.status, r.json.code]).toEqual([409, 'storno_exceeds_left'])
    expect(await stornosOf(s.saleId)).toHaveLength(1)
    expect(stornosOnDevice(w)).toHaveLength(1)
    const sale = await read(s.saleId)
    expect(sale.register.stornoClaims).toHaveLength(1)
    expect(sale.register.stornoedBy).toHaveLength(1)
    expect(await levelOf(w, s.products[0])).toBe(10 - 3 + 2)
  })

  it('two parts of one line racing, and both fit: both go through, each reading the running total', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    let other: any
    const undo = during(aClaim, async () => { other = await back(w, s, [[0, 1]]) })
    let r: any
    try {
      r = await back(w, s, [[0, 1]])
    } finally {
      undo()
    }
    expect([other.status, r.status]).toEqual([200, 200])
    expect(stornosOnDevice(w)).toHaveLength(2)
    expect((await stornosOf(s.saleId)).map(d => d.total)).toEqual([12, 12])
    expect((await read(s.saleId)).register.stornoClaims).toHaveLength(2)
  })

  it('six presses at once, for real, on a line of three: never more back than was sold, on the device or on the shelf', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const answers = await Promise.all([1, 2, 3, 4, 5, 6].map(() => back(w, s, [[0, 1]])))
    const through = answers.filter(a => a.status === 200)
    expect(through.length).toBeLessThanOrEqual(3)
    for (const a of answers) if (a.status !== 200) expect(a.status).toBe(409)
    expect(stornosOnDevice(w)).toHaveLength(through.length)
    const sale = await read(s.saleId)
    expect(sale.register.stornoClaims.reduce((c: number, x: any) => c + x.milli, 0)).toBe(through.length * 1000)
    expect(await levelOf(w, s.products[0])).toBe(7 + through.length)
    expect((await stornosOf(s.saleId)).filter(d => d.status === 'paid').reduce((c, d) => c + d.total, 0)).toBe(through.length * 12)
  })

  it('all of a sale nothing had touched, and a part landing first: it does not go on as what is left', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    let other: any
    const undo = during(aClaim, async () => { other = await back(w, s, [[0, 1]]) })
    let r: any
    try {
      r = await w.storno(s.saleId)
    } finally {
      undo()
    }
    expect(other.status).toBe(200)
    expect([r.status, r.json.code]).toEqual([409, 'storno_in_progress'])
    expect(stornosOnDevice(w)).toHaveLength(1)
    expect((await read(s.saleId)).register.stornoState).toBe('partial')
  })

  it('a part, and all of it landing first: the part is told so, with nothing printed', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    let other: any
    const undo = during(aClaim, async () => { other = await w.storno(s.saleId) })
    let r: any
    try {
      r = await back(w, s, [[0, 1]])
    } finally {
      undo()
    }
    expect(other.status).toBe(200)
    expect(r.status).toBe(400)
    expect(r.json.message).toContain('already cancelled')
    expect(stornosOnDevice(w)).toHaveLength(1)
    expect((await read(s.saleId)).register.stornoClaims).toHaveLength(3)
  })

  it('a session that is closing takes no part either: nothing is claimed', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    await POSSession.updateOne({ _id: w.sessionId }, { $set: { status: 'closing_control' } })
    const r = await back(w, s, [[0, 1]])
    expect([r.status, r.json.code]).toEqual([409, 'session_closing'])
    expect((await read(s.saleId)).register.stornoState).toBe('none')
    expect(await stornosOf(s.saleId)).toHaveLength(0)
  })

  it('a line with a negative amount: a sale like that goes back whole, never by its lines', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    await Invoice.updateOne({ _id: s.saleId }, { $set: { 'lines.2.lineTotal': -10.9 } })
    const r = await back(w, s, [[0, 1]])
    expect([r.status, r.json.code]).toEqual([422, 'storno_not_splittable'])
    expect((await read(s.saleId)).register.stornoState).toBe('none')
  })

  it('two parts of two lines at once, together the whole sale: it ends full, whichever claim wrote last', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    let other: any
    const undo = during(aClaim, async () => { other = await back(w, s, [[0, 3], [1, 2]]) })
    let r: any
    try {
      r = await back(w, s, [[2, 1]])
    } finally {
      undo()
    }
    expect([other.status, r.status]).toEqual([200, 200])
    expect((await read(s.saleId)).register.stornoState).toBe('full')
  })

  describe('a retry under an Idempotency-Key', () => {
    it('the same key and the same lines: the storno the first made, printed once and booked once', async () => {
      const w = await tillWorld(app)
      const s = await threeArticles(w)
      const first = await back(w, s, [[0, 1]], 'partial-key-1')
      const again = await back(w, s, [[0, 1]], 'partial-key-1')
      expect([first.status, again.status]).toEqual([200, 200])
      expect(String(again.json.transaction.id)).toBe(String(first.json.transaction.id))
      expect(stornosOnDevice(w)).toHaveLength(1)
      expect((await read(s.saleId)).register.stornoClaims).toHaveLength(1)
      expect((await sessionOf(w)).totalReturns).toBe(12)
      expect(await levelOf(w, s.products[0])).toBe(8)
    })

    it('the same key with other lines is another request, and refused', async () => {
      const w = await tillWorld(app)
      const s = await threeArticles(w)
      expect((await back(w, s, [[0, 1]], 'partial-key-2')).status).toBe(200)
      const other = await back(w, s, [[1, 1]], 'partial-key-2')
      expect(other.status).toBeGreaterThanOrEqual(400)
      expect(stornosOnDevice(w)).toHaveLength(1)
      expect((await read(s.saleId)).register.stornoClaims).toHaveLength(1)
    })

    it('two at once under one key, when both would fit: one storno, the loser\'s claim given back', async () => {
      const w = await tillWorld(app)
      const s = await threeArticles(w)
      const [a, b] = await Promise.all([back(w, s, [[0, 1]], 'partial-key-3'), back(w, s, [[0, 1]], 'partial-key-3')])
      expect([a.status, b.status]).toEqual([200, 200])
      expect(String(a.json.transaction.id)).toBe(String(b.json.transaction.id))
      expect(stornosOnDevice(w)).toHaveLength(1)
      const sale = await read(s.saleId)
      expect(sale.register.stornoClaims).toHaveLength(1)
      expect(sale.register.stornoedBy.map(String)).toEqual([String(a.json.transaction.id)])
      expect((await sessionOf(w)).totalReturns).toBe(12)
    })

    it('two at once under one key, when only one fits: the loser waits for its key and answers the same', async () => {
      const w = await tillWorld(app)
      const s = await threeArticles(w)
      let other: any
      const undo = during(aClaim, async () => { other = await back(w, s, [[0, 3]], 'partial-key-4') })
      let r: any
      try {
        r = await back(w, s, [[0, 3]], 'partial-key-4')
      } finally {
        undo()
      }
      expect([other.status, r.status]).toEqual([200, 200])
      expect(String(r.json.transaction.id)).toBe(String(other.json.transaction.id))
      expect(stornosOnDevice(w)).toHaveLength(1)
    })

    it('losing the claim to its own duplicate, whose insert is still to come: it waits for that one\'s answer, and never says "already cancelled"', async () => {
      const w = await tillWorld(app)
      const s = await threeArticles(w)
      const real = Invoice.create
      let stalled = false
      ;(Invoice as any).create = async function (...args: any[]) {
        if (!stalled && args[0]?.type === 'cash_storno') {
          stalled = true
          await new Promise(res => setTimeout(res, 400))
        }
        return (real as any).apply(Invoice, args)
      }
      let inner: any
      const undo = during(aClaim, async () => {
        // The duplicate claims everything left and stalls before its insert. The outer one's claim then finds the sale moved.
        inner = back(w, s, [[0, 3], [1, 2], [2, 1]], 'partial-key-6')
        for (let i = 0; i < 50 && (await read(s.saleId)).register.stornoState !== 'full'; i++) await new Promise(res => setTimeout(res, 20))
      })
      let r: any
      try {
        r = await back(w, s, [[0, 3], [1, 2], [2, 1]], 'partial-key-6')
      } finally {
        undo()
        ;(Invoice as any).create = real
      }
      const duplicate = await inner
      expect([r.status, duplicate.status]).toEqual([200, 200])
      expect(String(r.json.transaction.id)).toBe(String(duplicate.json.transaction.id))
      expect(stornosOnDevice(w)).toHaveLength(1)
    })

    it('the last part under a key, read after its own claim and before its insert: still its answer, never "already cancelled"', async () => {
      const w = await tillWorld(app)
      const s = await threeArticles(w)
      expect((await back(w, s, [[0, 1]])).status).toBe(200)
      // The rest, claimed by a duplicate whose insert is slow.
      const real = Invoice.create
      let inner: any
      let once = false
      ;(Invoice as any).create = async function (...args: any[]) {
        if (!once && args[0]?.type === 'cash_storno') {
          once = true
          inner = back(w, s, [[0, 2], [1, 2], [2, 1]], 'partial-key-5')
          await new Promise(res => setTimeout(res, 300))
        }
        return (real as any).apply(Invoice, args)
      }
      let r: any
      try {
        r = await back(w, s, [[0, 2], [1, 2], [2, 1]], 'partial-key-5')
      } finally {
        ;(Invoice as any).create = real
      }
      const duplicate = await inner
      expect([r.status, duplicate.status]).toEqual([200, 200])
      expect(String(r.json.transaction.id)).toBe(String(duplicate.json.transaction.id))
      expect(stornosOnDevice(w)).toHaveLength(2)
    })
  })
})

describe('a storno that does not print', () => {
  it('proved not to have printed: voided with its number, and its quantities and its money go back', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    failsProved(w)

    const r = await back(w, s, [[0, 1]])

    expect(r.status).toBe(503)
    expect(r.json.code).toBe('fiscal_error')
    const [storno] = await stornosOf(s.saleId)
    expect(storno.status).toBe('voided')
    const sale = await read(s.saleId)
    expect(sale.register.stornoState).toBe('none')
    expect(sale.register.stornoedBy).toHaveLength(0)
    expect(sale.register.stornoClaims).toHaveLength(0)
    expect(sale.register.refundClaims).toHaveLength(0)
    expect(sale.register.cancelledAt).toBeUndefined()
    expect(await levelOf(w, s.products[0])).toBe(7)
    expect((await sessionOf(w)).totalReturns || 0).toBe(0)

    // The next press is a new storno, and all of it is there again.
    expect((await back(w, s, [[0, 3]])).status).toBe(200)
    expect(await levelOf(w, s.products[0])).toBe(10)
  })

  it('the last of three parts failing takes the sale back from full to partial, and 18.5 no longer lists it', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    expect((await back(w, s, [[0, 3], [1, 2]])).status).toBe(200)
    failsProved(w)
    expect((await back(w, s, [[2, 1]])).status).toBe(503)

    const sale = await read(s.saleId)
    expect(sale.register.stornoState).toBe('partial')
    expect(sale.register.cancelledAt).toBeUndefined()
    expect(sale.register.stornoedBy).toHaveLength(1)
    expect(sale.register.stornoClaims.map((c: any) => c.lineId).sort()).toEqual([s.ids[0], s.ids[1]].sort())
    const cancelled = await exportCancelledSales({ orgId: w.orgId, dateFrom: new Date(Date.now() - 86_400_000), dateTo: new Date(Date.now() + 86_400_000) } as any)
    expect(JSON.stringify(cancelled)).not.toContain(s.sale.invoiceNumber)
  })

  describe('one that may have printed', () => {
    async function held(w: TillWorld, s: Sold) {
      w.sim!.dropAfter = CLOSE
      const answer = await back(w, s, [[0, 1]])
      w.sim!.disconnected = false
      const stornos = await stornosOf(s.saleId)
      return { answer, storno: stornos.at(-1) }
    }

    it('keeps its quantities and its money, books nothing, and no other press of this sale goes through', async () => {
      const w = await tillWorld(app)
      const s = await threeArticles(w)
      const { answer, storno } = await held(w, s)

      expect([answer.status, answer.json.code]).toEqual([409, 'storno_in_doubt'])
      expect(storno.register.fiscal).toMatchObject({ state: 'unknown', inDoubt: true })
      const sale = await read(s.saleId)
      expect(sale.register.stornoState).toBe('partial')
      expect(sale.register.stornoClaims).toHaveLength(1)
      expect(sale.register.refundClaims).toEqual([{ stornoId: storno._id, rate: 20, cents: 1200 }])
      expect(await levelOf(w, s.products[0])).toBe(7)
      expect((await sessionOf(w)).totalReturns || 0).toBe(0)

      // Another line, a new key, all of it: each hears the same, and nothing prints.
      const printed = stornosOnDevice(w).length
      for (const again of [await back(w, s, [[1, 1]]), await back(w, s, [[0, 1]], 'other-key'), await w.storno(s.saleId)]) {
        expect([again.status, again.json.code]).toEqual([409, 'storno_in_doubt'])
        expect(again.json.receipt.id).toBe(String(storno._id))
      }
      expect(stornosOnDevice(w)).toHaveLength(printed)
      expect(await stornosOf(s.saleId)).toHaveLength(1)
    })

    it('holds the close, and the preview names it', async () => {
      const w = await tillWorld(app)
      const s = await threeArticles(w)
      const { storno } = await held(w, s)

      const p = await preview(w)
      expect(p.json.unfinishedReceipts).toEqual([expect.objectContaining({ id: String(storno._id), inDoubt: true, kind: 'storno' })])
      const closed = await closeOn(w, 158.9)
      expect([closed.status, closed.json.code]).toEqual([409, 'receipts_unfinished'])
    })

    it('it counts nowhere until it is settled', async () => {
      const w = await tillWorld(app)
      const s = await threeArticles(w)
      const { storno } = await held(w, s)

      const rows = await loadPosRows({ orgId: w.orgId, sessionId: w.sessionId })
      const report = buildSessionReport({ sessionNumber: 'S', currency: 'EUR', openingBalance: 0 }, rows)
      expect(report.byMethod.cash).toBe(58.9)
      expect(report.counts).toMatchObject({ sales: 1, stornos: 0 })
      const reversed = await exportReversedSales({ orgId: w.orgId, dateFrom: new Date(Date.now() - 86_400_000), dateTo: new Date(Date.now() + 86_400_000) } as any)
      expect(JSON.stringify(reversed)).not.toContain(storno.invoiceNumber)
    })

    it('settled as printed: the rest runs, those lines only, and what is left can go on', async () => {
      const w = await tillWorld(app)
      const s = await threeArticles(w)
      const { storno } = await held(w, s)

      const settled = await w.call('POST', `/cash-register/documents/${storno._id}/settle`, { printed: true })
      expect(settled.status).toBe(200)

      expect(await levelOf(w, s.products[0])).toBe(8)
      expect(await levelOf(w, s.products[1])).toBe(8)
      const session = await sessionOf(w)
      expect(session.totalReturns).toBe(12)
      expect((await read(s.saleId)).register.stornoState).toBe('partial')
      expect((await back(w, s, [[1, 1]])).status).toBe(200)
    })

    it('settled as not printed: voided with its number, and its quantities go back', async () => {
      const w = await tillWorld(app)
      const s = await threeArticles(w)
      const { storno } = await held(w, s)
      // The device was asked by a line that is back, and holds nothing open.
      const settled = await w.call('POST', `/cash-register/documents/${storno._id}/settle`, { printed: false })
      expect(settled.status).toBe(200)

      expect((await read(storno._id)).status).toBe('voided')
      const sale = await read(s.saleId)
      expect(sale.register.stornoState).toBe('none')
      expect(sale.register.stornoClaims).toHaveLength(0)
      expect(sale.register.refundClaims).toHaveLength(0)
      expect(await levelOf(w, s.products[0])).toBe(7)
      expect((await back(w, s, [[0, 3]])).status).toBe(200)
    })
  })

  it('one whose request died before it reached the device: the next press finishes it, gives it back, and goes on', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    expect((await back(w, s, [[1, 2]])).status).toBe(200)
    // A storno that stopped after its claim and its insert, having started nothing.
    failsProved(w)
    expect((await back(w, s, [[0, 3]])).status).toBe(503)
    const [, dead] = await stornosOf(s.saleId)
    await Invoice.updateOne({ _id: dead._id }, {
      $set: { status: 'paid', leaseUntil: new Date(Date.now() - 1000), 'register.fiscal': { state: 'pending', mode: 'fiscal' }, 'register.stornoState': 'partial' },
      $unset: { completedAt: 1 },
    })
    await Invoice.updateOne({ _id: s.saleId }, {
      $push: {
        'register.stornoedBy': dead._id,
        'register.stornoClaims': { stornoId: dead._id, lineId: s.ids[0], milli: 3000, at: new Date() },
        'register.refundClaims': { stornoId: dead._id, rate: 20, cents: 3600 },
      },
    })

    const r = await back(w, s, [[0, 3]])

    expect(r.status).toBe(200)
    expect((await read(dead._id)).status).toBe('voided')
    const sale = await read(s.saleId)
    expect(sale.register.stornoedBy.map(String)).not.toContain(String(dead._id))
    expect(sale.register.stornoClaims.reduce((c: number, x: any) => c + x.milli, 0)).toBe(5000)
  })
})

describe('a claim whose storno was never written: each claim has its own age', () => {
  const ObjectId = Invoice.base.Types.ObjectId
  const old = () => new Date(Date.now() - 121_000)
  /** The claim the process died holding: the line taken, and no document. */
  async function orphan(s: Sold, at: Date, lineIndex = 0, milli = 1000) {
    const id = new ObjectId()
    await Invoice.updateOne({ _id: s.saleId }, {
      $set: { 'register.stornoState': 'partial' },
      $push: {
        'register.stornoedBy': id,
        'register.stornoClaims': { stornoId: id, lineId: s.ids[lineIndex], milli, at },
        'register.refundClaims': { stornoId: id, rate: 20, cents: 1200 },
      },
    })
    return id
  }

  it('within a lease it holds its line, and the press that needs it hears there is not enough', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const id = await orphan(s, new Date())

    const r = await back(w, s, [[0, 3]])

    expect([r.status, r.json.code]).toEqual([409, 'storno_exceeds_left'])
    expect((await read(s.saleId)).register.stornoedBy.map(String)).toEqual([String(id)])
    expect((await back(w, s, [[1, 1]])).status).toBe(200)
  })

  it('past a lease the next press pulls it, with what it held', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const id = await orphan(s, old())

    expect((await back(w, s, [[0, 3]])).status).toBe(200)

    const sale = await read(s.saleId)
    expect(sale.register.stornoedBy.map(String)).not.toContain(String(id))
    expect(sale.register.stornoClaims.every((c: any) => String(c.stornoId) !== String(id))).toBe(true)
    expect(sale.register.refundClaims.every((c: any) => String(c.stornoId) !== String(id))).toBe(true)
    expect(stornosOnDevice(w)).toHaveLength(1)
  })

  it('an older orphan is not hidden by a later claim: a second storno does not refresh its age', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const id = await orphan(s, old())
    expect((await back(w, s, [[1, 1]])).status).toBe(200)
    const sale = await read(s.saleId)
    expect(sale.register.stornoedBy.map(String)).not.toContain(String(id))
    expect(sale.register.stornoState).toBe('partial')
  })

  it('a younger orphan beside an old one: the old goes, the young stays', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const aged = await orphan(s, old(), 0)
    const young = await orphan(s, new Date(), 1)

    expect(await releaseOrphanClaims(await read(s.saleId))).toBe(true)

    const ids = (await read(s.saleId)).register.stornoedBy.map(String)
    expect(ids).toEqual([String(young)])
    expect(ids).not.toContain(String(aged))
  })

  it('a live storno given back beside it leaves it standing, and a sale with only that left reads partial, then none', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const id = await orphan(s, new Date(), 1)
    failsProved(w)
    expect((await back(w, s, [[0, 1]])).status).toBe(503)
    expect((await read(s.saleId)).register.stornoState).toBe('partial')
    expect((await read(s.saleId)).register.stornoedBy.map(String)).toEqual([String(id)])
    await Invoice.updateOne({ _id: s.saleId }, { $set: { 'register.stornoClaims.0.at': old() } })
    expect(await releaseOrphanClaims(await read(s.saleId))).toBe(true)
    expect((await read(s.saleId)).register.stornoState).toBe('none')
  })

  it('the close sweeps its sessions\' sales, the ones reading partial too', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const id = await orphan(s, old())
    expect((await closeOn(w, 158.9)).status).toBe(200)
    const sale = await read(s.saleId)
    expect(sale.register.stornoedBy.map(String)).not.toContain(String(id))
    expect(sale.register.stornoState).toBe('none')
  })

  it('the journal reads it for what it is: no write, and past a lease it reversed nothing', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const id = await orphan(s, new Date())
    expect((await w.call('GET', `/cash-register/documents/${s.saleId}`)).json.row.status).toBe('partial')
    await Invoice.updateOne({ _id: s.saleId }, { $set: { 'register.stornoClaims.0.at': old() } })

    const page = (await w.call('GET', `/cash-register/documents/${s.saleId}`)).json

    expect(page.row.status).toBe('completed')
    expect((await read(s.saleId)).register.stornoedBy.map(String)).toEqual([String(id)])
  })

  it('a to-invoice past a lease does not lose the line to it', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    await orphan(s, old())
    const contact = await createTestContact(w.oid)
    const r = await w.call('POST', `/invoices/${s.saleId}/to-invoice`, { contactId: String(contact._id) })
    expect(r.status).toBe(200)
    expect(r.json.invoice.total).toBe(58.9)
  })
})

describe('what counts a partial storno: at its own amount', () => {
  it('the session\'s totals, the preview and the close agree, and the difference is 0', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    expect((await back(w, s, [[0, 1]])).status).toBe(200)

    const p = await preview(w)
    // 100 opening, 58.90 sold, 12 back.
    expect(p.json.expected.cash).toBe(146.9)
    expect(p.json.unfinishedReceipts).toEqual([])
    expect(p.json.report.byMethod.cash).toBe(46.9)
    expect(p.json.report.counts).toMatchObject({ sales: 1, stornos: 1 })

    const closed = await closeOn(w, 146.9)
    expect(closed.status).toBe(200)
    const cash = closed.json.session.closingBreakdown.find((b: any) => b.method === 'cash')
    expect(cash).toMatchObject({ expected: 146.9, counted: 146.9, difference: 0 })
  })

  it('a dead part that printed: the preview and the close both count it at its own amount, and the prefilled count closes on 0', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    expect((await back(w, s, [[0, 1]])).status).toBe(200)
    const [dead] = await stornosOf(s.saleId)
    // As it stood had it stopped after its print: nothing of its totals or its stock booked, and its lease lapsed.
    await Invoice.updateOne({ _id: dead._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) }, $unset: { completedAt: 1, 'register.sessionTotalsApplied': 1, 'register.movementId': 1 } })
    await POSSession.updateOne({ _id: w.sessionId }, { $inc: { totalCash: 12, totalReturns: -12, transactionCount: -1 } })
    await StockMovement.deleteMany({ invoiceId: dead._id })
    await StockLevel.updateOne({ orgId: w.oid, productId: s.products[0], warehouseId: w.warehouse._id }, { $inc: { quantity: -1, availableQuantity: -1 } })

    const p = await preview(w)
    expect(p.json.expected.cash).toBe(146.9)
    expect(p.json.unfinishedReceipts).toEqual([])
    const closed = await closeOn(w, p.json.expected.cash)
    expect(closed.status).toBe(200)
    expect(closed.json.session.closingBreakdown.find((b: any) => b.method === 'cash')).toMatchObject({ difference: 0 })
    expect(await levelOf(w, s.products[0])).toBe(8)
  })

  it('SUPTO: 18.4 lists each part at its own amount and lines, 18.5 only once all of it is back', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const period = { orgId: w.orgId, dateFrom: new Date(Date.now() - 86_400_000), dateTo: new Date(Date.now() + 86_400_000) } as any
    expect((await back(w, s, [[0, 1]])).status).toBe(200)

    const firstReversed: any = await exportReversedSales(period)
    const list = (r: any) => (Array.isArray(r) ? r : r.transactions ?? r.rows)
    expect(list(firstReversed)).toHaveLength(1)
    expect(list(firstReversed)[0]).toMatchObject({ total: 12, originalUNP: s.sale.register.unp, originalFiscalReceiptNumber: s.sale.register.fiscalReceiptNumber })
    expect(list(firstReversed)[0].lines).toHaveLength(1)
    expect(list(await exportCancelledSales(period))).toHaveLength(0)

    expect((await w.storno(s.saleId)).status).toBe(200)
    expect(list(await exportReversedSales(period)).map((t: any) => t.total)).toEqual([12, 46.9])
    const cancelled = list(await exportCancelledSales(period))
    expect(cancelled).toHaveLength(1)
    expect(String(cancelled[0]._id)).toBe(s.saleId)
  })

  it('reports read it at its own amount: the session report, the sales history and the register', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    expect((await back(w, s, [[0, 1]])).status).toBe(200)

    const rows = await loadPosRows({ orgId: w.orgId, sessionId: w.sessionId })
    const built = buildSessionReport({ sessionNumber: 'S', currency: 'EUR', openingBalance: 0 }, rows)
    expect(built.total).toBe(46.9)
    expect(built.byMethod.cash).toBe(46.9)

    const today = new Date().toISOString().slice(0, 10)
    const params = validateParams(reportById('sales-history')!, { period: { from: today, to: today } } as any)
    const history: any = await reportById('sales-history')!.handler({ orgId: w.orgId, params } as any)
    expect(history.rows.map((r: any) => r.total).sort((a: number, b: number) => a - b)).toEqual([-12, 58.9])
  })

  it('the journal: the badge, the filter, the lines, and the chain both ways', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    expect((await listJournal({ orgId: w.orgId, kind: 'sale' })).rows[0].status).toBe('completed')
    expect((await back(w, s, [[0, 1]])).status).toBe(200)
    const [storno] = await stornosOf(s.saleId)

    expect((await listJournal({ orgId: w.orgId, kind: 'sale' })).rows[0].status).toBe('partial')
    expect((await listJournal({ orgId: w.orgId, status: 'partial' })).rows.map(r => r.id)).toEqual([s.saleId])
    expect((await listJournal({ orgId: w.orgId, status: 'completed', kind: 'sale' })).rows).toHaveLength(0)
    expect((await listJournal({ orgId: w.orgId, status: 'stornoed' })).rows).toHaveLength(0)
    const filtered = await w.call('GET', '/cash-register/documents?status=partial')
    expect(filtered.status).toBe(200)

    const page = (await w.call('GET', `/cash-register/documents/${s.saleId}`)).json
    expect(page.row.stornoedBy).toEqual([String(storno._id)])
    expect(page.related.map((r: any) => r.id)).toEqual([String(storno._id)])
    expect(page.lines.map((l: any) => [l.lineId, l.returned, l.left, l.value])).toEqual([
      [s.ids[0], 1, 2, 3600], [s.ids[1], 0, 2, 1200], [s.ids[2], 0, 1, 1090],
    ])
    const onStorno = (await w.call('GET', `/cash-register/documents/${storno._id}`)).json
    expect(onStorno.row).toMatchObject({ kind: 'storno', total: 12, relatedId: s.saleId })
    expect(onStorno.lines[0].lineId).toBeUndefined()
  })
})

describe('the shapes a part comes in', () => {
  /** One line of the world's article, in cash. */
  async function oneLine(w: TillWorld, quantity: number, unitPrice = 10): Promise<Sold> {
    const t = computePosTotals([{ quantity, unitPrice, taxRate: 20 }])
    const res = await w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, {
      type: 'sale',
      lines: [{ productId: String(w.product._id), name: 'Болт', quantity, unitPrice, discount: 0, taxRate: 20, taxAmount: t.taxTotal, lineTotal: t.subtotal }],
      subtotal: t.subtotal, discountTotal: 0, taxTotal: t.taxTotal, total: t.total,
      payments: [{ method: 'cash', amount: t.total }], changeDue: 0,
    })
    expect(res.status).toBe(200)
    const saleId = String(res.json.transaction.id)
    const sale = await read(saleId)
    return { saleId, sale, ids: sale.lines.map((l: any) => String(l._id)), products: [w.product._id] }
  }

  it('fractions: 1.5 at 10 net, half of it back three times: the device and the document agree, and it ends full', async () => {
    const w = await tillWorld(app)
    const s = await oneLine(w, 1.5)
    for (let i = 0; i < 3; i++) expect((await back(w, s, [[0, 0.5]])).status).toBe(200)
    expect((await stornosOf(s.saleId)).map(d => d.total)).toEqual([6, 6, 6])
    expect(stornosOnDevice(w).map(r => r.total)).toEqual([6, 6, 6])
    expect((await read(s.saleId)).register.stornoState).toBe('full')
    expect((await w.stock()).quantity).toBe(10)
  })

  it('a price no third of which is a cent: the parts come to the sale, each to the cent on the device (#461, D2), and the drawer to nothing', async () => {
    const w = await tillWorld(app)
    const s = await oneLine(w, 3, 0.1234)
    for (let i = 0; i < 3; i++) expect((await back(w, s, [[0, 1]])).status).toBe(200)
    const stornos = await stornosOf(s.saleId)
    expect(stornos.reduce((c, d) => c + Math.round(d.total * 100), 0)).toBe(Math.round(s.sale.total * 100))
    stornosOnDevice(w).forEach((r, i) => expect(r.total).toBe(stornos[i].total))
    expect((await sessionOf(w)).totalCash).toBeCloseTo(0, 5)
  })

  it('a part of a sale whose session has closed: from a new session, booked on that one, and what is left after it', async () => {
    const w = await tillWorld(app)
    const s = await oneLine(w, 3)
    expect((await back(w, s, [[0, 1]])).status).toBe(200)
    expect((await closeOn(w, 124)).status).toBe(200)
    const opened = await w.call('POST', '/trade/pos/session', { warehouseId: String(w.warehouse._id), openingBalance: 100, currency: 'EUR' })
    const sessionId = String(opened.json.session.id ?? opened.json.session._id)

    const r = await w.call('POST', `/cash-register/documents/${s.saleId}/storno`, { reason: 'customer_return', sessionId, lines: [{ lineId: s.ids[0], quantity: 1 }] })

    expect(r.status).toBe(200)
    expect((await w.call('GET', `/trade/pos/session/${sessionId}/close-preview`)).json.expected.cash).toBe(88)
    expect((await w.call('POST', `/cash-register/documents/${s.saleId}/storno`, { reason: 'customer_return', sessionId })).status).toBe(200)
    expect((await read(s.saleId)).register.stornoState).toBe('full')
  })

  it('a back-office sale in two warehouses: a part comes back where it left from, at what it cost there', async () => {
    const w = await tillWorld(app)
    const other = await createTestWarehouse(w.oid, { name: 'Втори', code: 'W2' } as any)
    const nut = await createTestProduct(w.oid, { name: 'Гайка', sellingPrice: 5, purchasePrice: 2, taxRate: 20, unit: 'бр.' } as any)
    await createTestStockLevel(w.oid, nut._id, other._id, { quantity: 10, availableQuantity: 10, avgCost: 2 } as any)
    const sold = await w.call('POST', '/invoices', {
      type: 'cash_sale', direction: 'outgoing', issueDate: '2026-10-26', currency: 'EUR',
      lines: [
        { productId: String(w.product._id), warehouseId: String(w.warehouse._id), description: 'Болт', quantity: 2, unit: 'бр.', unitPrice: 10, taxRate: 20 },
        { productId: String(nut._id), warehouseId: String(other._id), description: 'Гайка', quantity: 4, unit: 'бр.', unitPrice: 5, taxRate: 20 },
      ],
      subtotal: 40, taxTotal: 8, total: 48, paymentMethod: 'cash',
    }, undefined, w.clerkToken)
    expect(sold.status).toBe(200)
    const id = String(sold.json.invoice.id)
    const sale = await read(id)

    const r = await w.call('POST', `/cash-register/documents/${id}/storno`, { reason: 'customer_return', lines: [{ lineId: String(sale.lines[1]._id), quantity: 1 }] }, undefined, w.clerkToken)

    expect(r.status).toBe(200)
    const level: any = await StockLevel.findOne({ orgId: w.oid, productId: nut._id, warehouseId: other._id }).lean().exec()
    expect(level.quantity).toBe(7)
    expect((await w.stock()).quantity).toBe(8)
    const [storno] = await stornosOf(id)
    const moved: any[] = await StockMovement.find({ invoiceId: storno._id }).lean().exec()
    expect(moved).toHaveLength(1)
    expect(String(moved[0].toWarehouseId)).toBe(String(other._id))
    expect(moved[0].lines[0].unitCost).toBe(2)
  })

  it('a part that stalled past a lease between its claim and its insert wakes with no claim, and prints nothing', async () => {
    const w = await tillWorld(app)
    const s = await oneLine(w, 3)
    const real = Invoice.create
    let stalled = false
    let through: any
    ;(Invoice as any).create = async function (...args: any[]) {
      if (!stalled && args[0]?.type === 'cash_storno') {
        stalled = true
        await Invoice.updateOne({ _id: s.saleId }, { $set: { 'register.stornoClaims.0.at': new Date(Date.now() - 121_000) } })
        through = await back(w, s, [[0, 3]])
      }
      return (real as any).apply(Invoice, args)
    }
    let woke: any
    try {
      woke = await back(w, s, [[0, 1]])
    } finally {
      ;(Invoice as any).create = real
    }
    expect(through.status).toBe(200)
    expect(woke.status).toBe(503)
    expect(woke.json.message).toContain('took over')
    const sale = await read(s.saleId)
    expect(sale.register.stornoState).toBe('full')
    expect(sale.register.stornoClaims.reduce((c: number, x: any) => c + x.milli, 0)).toBe(3000)
    expect(stornosOnDevice(w)).toHaveLength(1)
    expect((await sessionOf(w)).totalReturns).toBe(36)
  })

  describe('an earlier part given back while a later one stands (the reader, finding 2)', () => {
    /** A line of 3 worth 1.00, whose thirds are 0.33, 0.34 and 0.33 on its running total. */
    const worthOne = async (w: TillWorld) => {
      const s = await oneLine(w, 3, 0.2778)
      expect(s.sale.total).toBe(1)
      return s
    }
    /** A part claims, a later one prints meanwhile, and then the first is proved not to have printed. */
    async function overlapped(w: TillWorld, s: Sold) {
      const undo = justAfter(aClaim, async () => {
        expect((await back(w, s, [[0, 1]])).status).toBe(200)
        failsProved(w)
      })
      try {
        expect((await back(w, s, [[0, 1]])).status).toBe(503)
      } finally {
        undo()
      }
    }
    const liveTotals = async (saleId: string) => (await stornosOf(saleId)).filter(d => d.status === 'paid').map(d => d.total)

    it('the last unit still comes back: the line ends full, to the cent', async () => {
      const w = await tillWorld(app)
      const s = await worthOne(w)
      await overlapped(w, s)

      expect((await back(w, s, [[0, 1]])).status).toBe(200)
      const last = await back(w, s, [[0, 1]])

      expect(last.status).toBe(200)
      expect(await liveTotals(s.saleId)).toEqual([0.34, 0.33, 0.33])
      const sale = await read(s.saleId)
      expect(sale.register.stornoState).toBe('full')
      expect(leftByRate(sale).size).toBe(0)
      expect((await w.stock()).quantity).toBe(10)
      expect((await sessionOf(w)).totalReturns).toBeCloseTo(1, 5)
      expect((await sessionOf(w)).totalCash).toBeCloseTo(0, 5)
    })

    it('all that is left goes back too, for what is left of the line', async () => {
      const w = await tillWorld(app)
      const s = await worthOne(w)
      await overlapped(w, s)

      expect((await w.storno(s.saleId)).status).toBe(200)

      expect(await liveTotals(s.saleId)).toEqual([0.34, 0.66])
      expect((await read(s.saleId)).register.stornoState).toBe('full')
    })

    it('the page says what the next part gives back, as the door books it: a named refund of that goes through', async () => {
      const w = await tillWorld(app)
      const s = await worthOne(w)
      await overlapped(w, s)
      const page = (await w.call('GET', `/cash-register/documents/${s.saleId}`)).json
      expect(page.lines[0]).toMatchObject({ returned: 1, left: 2, value: 100, taken: 34 })
      expect(partOfLine(100, 3000, 1000, 34, 1000)).toBe(33)

      expect((await back(w, s, [[0, 1]], undefined, { payments: [{ method: 'cash', amount: 0.33 }] })).status).toBe(200)
    })

    it('a claim that died, with a part pressed inside its lease and the claim pulled after: the same', async () => {
      const w = await tillWorld(app)
      const s = await worthOne(w)
      const orphan = new Invoice.base.Types.ObjectId()
      await Invoice.updateOne({ _id: s.saleId }, {
        $set: { 'register.stornoState': 'partial' },
        $push: {
          'register.stornoedBy': orphan,
          'register.stornoClaims': { stornoId: orphan, lineId: s.ids[0], milli: 1000, cents: 33, at: new Date() },
          'register.refundClaims': { stornoId: orphan, rate: 20, cents: 33 },
        },
      })
      expect((await back(w, s, [[0, 1]])).status).toBe(200)
      await Invoice.updateOne({ _id: s.saleId }, { $set: { 'register.stornoClaims.0.at': new Date(Date.now() - 121_000) } })

      expect((await back(w, s, [[0, 1]])).status).toBe(200)
      expect((await back(w, s, [[0, 1]])).status).toBe(200)

      expect(await liveTotals(s.saleId)).toEqual([0.34, 0.33, 0.33])
      expect((await read(s.saleId)).register.stornoState).toBe('full')
    })

    it('the refusal blames nobody it cannot name: no credit note took anything here, and none is said to', async () => {
      const w = await tillWorld(app)
      const s = await worthOne(w)
      // Money gone from the rate by a hand this door knows nothing of.
      expect(await takeBudget(await read(s.saleId), new Invoice.base.Types.ObjectId(), new Map([[20, 80]]))).toBe(true)
      const r = await back(w, s, [[0, 1]])
      expect([r.status, r.json.code, r.json.left]).toEqual([409, 'storno_exceeds_budget', 0.2])
      expect(r.json.message).not.toContain('credit note')
    })
  })

  it('a keyed part whose request died after its insert: the retry prints it once, and another replays it', async () => {
    const w = await tillWorld(app)
    const s = await oneLine(w, 3)
    const real = Invoice.findOneAndUpdate
    let died = false
    ;(Invoice as any).findOneAndUpdate = function (filter: any, update: any, ...rest: any[]) {
      if (!died && update?.$set?.['register.unp']) {
        died = true
        throw new Error('the process died here')
      }
      return (real as any).call(Invoice, filter, update, ...rest)
    }
    try {
      await back(w, s, [[0, 1]], 'partial-dead-key-1').catch(() => undefined)
    } finally {
      ;(Invoice as any).findOneAndUpdate = real
    }
    const [dead] = await stornosOf(s.saleId)
    expect(stornosOnDevice(w)).toHaveLength(0)
    await Invoice.updateOne({ _id: dead._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })

    expect((await back(w, s, [[0, 1]], 'partial-dead-key-1')).status).toBe(200)
    expect((await back(w, s, [[0, 1]], 'partial-dead-key-1')).status).toBe(200)

    expect(stornosOnDevice(w)).toHaveLength(1)
    expect((await read(s.saleId)).register.stornoClaims).toHaveLength(1)
    expect((await sessionOf(w)).totalReturns).toBe(12)
  })
})

describe('a refund the operator names comes to what the storno gives back (the reader, finding 3)', () => {
  /** Both doors, as the till and the journal each take a storno. */
  const atBothDoors = (w: TillWorld, saleId: string, body: Record<string, unknown>) => Promise.all([
    w.storno(saleId, undefined, body),
    w.call('POST', `/cash-register/documents/${saleId}/storno`, { reason: 'customer_return', sessionId: w.sessionId, ...body }),
  ])
  /** Refused, with nothing claimed, printed or booked. */
  async function nothingMoved(w: TillWorld, s: Sold, cash: number) {
    const sale = await read(s.saleId)
    expect(sale.register.stornoState).toBe('none')
    expect(sale.register.stornoClaims ?? []).toHaveLength(0)
    expect(await stornosOf(s.saleId)).toHaveLength(0)
    expect(stornosOnDevice(w)).toHaveLength(0)
    expect((await sessionOf(w)).totalCash).toBe(cash)
  }

  it('all of a sale with a refund of a thousand: refused at both doors, and the drawer does not move', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    for (const r of await atBothDoors(w, s.saleId, { payments: [{ method: 'cash', amount: 1000 }] })) {
      expect([r.status, r.json.code, r.json.amount]).toEqual([422, 'storno_refund_mismatch', 58.9])
    }
    await nothingMoved(w, s, 58.9)
  })

  it('a whole storno of 12 with a refund of 1000: the one the reader ran', async () => {
    const w = await tillWorld(app)
    const sold = await w.sell(1)
    const id = String(sold.json.transaction.id)
    const r = await w.storno(id, undefined, { payments: [{ method: 'cash', amount: 1000 }] })
    expect([r.status, r.json.code, r.json.amount]).toEqual([422, 'storno_refund_mismatch', 12])
    expect((await sessionOf(w)).totalCash).toBe(12)
    expect((await w.storno(id, undefined, { payments: [{ method: 'cash', amount: 12 }] })).status).toBe(200)
    expect((await sessionOf(w)).totalCash).toBe(0)
  })

  it('every line named in full takes the same check, by the sale\'s own total', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const r = await back(w, s, [[0, 3], [1, 2], [2, 1]], undefined, { payments: [{ method: 'cash', amount: 500 }] })
    expect([r.status, r.json.code, r.json.amount]).toEqual([422, 'storno_refund_mismatch', 58.9])
    await nothingMoved(w, s, 58.9)
  })

  it('a row below zero is refused however the rows add up: the drawer lost 50 for a part of 12', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const lines = [{ lineId: s.ids[0], quantity: 1 }]
    for (const r of await atBothDoors(w, s.saleId, { lines, payments: [{ method: 'cash', amount: 50 }, { method: 'card', amount: -38 }] })) {
      expect([r.status, r.json.code]).toEqual([422, 'storno_refund_not_positive'])
    }
    await nothingMoved(w, s, 58.9)
  })

  it('so is a row of nothing, and one below zero on all of a sale', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const zero = await back(w, s, [[0, 1]], undefined, { payments: [{ method: 'cash', amount: 12 }, { method: 'card', amount: 0 }] })
    expect([zero.status, zero.json.code]).toEqual([422, 'storno_refund_not_positive'])
    const whole = await w.storno(s.saleId, undefined, { payments: [{ method: 'cash', amount: 70 }, { method: 'card', amount: -11.1 }] })
    expect([whole.status, whole.json.code]).toEqual([422, 'storno_refund_not_positive'])
    await nothingMoved(w, s, 58.9)
  })

  it('rows that do come to it go through, split or not', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    expect((await w.storno(s.saleId, undefined, { payments: [{ method: 'cash', amount: 50 }, { method: 'card', amount: 8.9 }] })).status).toBe(200)
    const session = await sessionOf(w)
    expect(session.totalCash).toBeCloseTo(8.9, 5)
    expect(session.totalCard).toBeCloseTo(-8.9, 5)
  })
})

describe('split tender: the refund goes by what the operator picks, or by what the sale still holds', () => {
  const split = [{ method: 'cash', amount: 30 }, { method: 'card', amount: 28.9 }]

  it('named by nobody: one method when one still holds all of it, the first the sale names', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w, { payments: split })
    expect((await back(w, s, [[0, 1]])).status).toBe(200)
    const [storno] = await stornosOf(s.saleId)
    expect(storno.payments.map((p: any) => [p.method, p.amount])).toEqual([['cash', 12]])
    expect(stornosOnDevice(w)[0].payments).toHaveLength(1)
    const session = await sessionOf(w)
    expect(session.totalCash).toBe(18)
    expect(session.totalCard).toBe(28.9)
  })

  it('larger than any one: it draws on them in order, and the last part gives each method back the rest', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w, { payments: split })
    expect((await back(w, s, [[0, 3]])).status).toBe(200)
    const [first] = await stornosOf(s.saleId)
    expect(first.payments.map((p: any) => [p.method, p.amount])).toEqual([['cash', 30], ['card', 6]])
    expect((await w.storno(s.saleId)).status).toBe(200)
    const [, rest] = await stornosOf(s.saleId)
    expect(rest.payments.map((p: any) => [p.method, p.amount])).toEqual([['card', 22.9]])
    const session = await sessionOf(w)
    expect(session.totalCash).toBe(0)
    expect(session.totalCard).toBe(0)
  })

  it('the operator\'s pick stands, for the returned amount, in the drawer and on the device', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w, { payments: split })
    expect((await back(w, s, [[0, 1]], undefined, { payments: [{ method: 'card', amount: 12 }] })).status).toBe(200)
    const session = await sessionOf(w)
    expect(session.totalCash).toBe(30)
    expect(session.totalCard).toBe(16.9)
    const printed = stornosOnDevice(w)[0]
    expect(printed.payments).toHaveLength(1)
    expect(printed.payments[0].amount).toBe(12)
    expect(printed.payments[0].mode).not.toBe('P')
  })

  it('a split the operator names is summed, and the close stays on 0', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w, { payments: split })
    expect((await back(w, s, [[0, 1]], undefined, { payments: [{ method: 'cash', amount: 5 }, { method: 'card', amount: 7 }] })).status).toBe(200)
    const p = await preview(w)
    expect(p.json.expected.cash).toBe(125)
    const closed = await closeOn(w, 125)
    expect(closed.status).toBe(200)
    expect(closed.json.session.closingBreakdown.find((b: any) => b.method === 'cash')).toMatchObject({ difference: 0 })
  })

  it('cash on delivery: its refund is its method, and exactly the part', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w, { payments: [{ method: 'cash_on_delivery', amount: 58.9 }] })
    expect((await back(w, s, [[0, 1]])).status).toBe(200)
    const [storno] = await stornosOf(s.saleId)
    expect(storno.payments.map((p: any) => [p.method, p.amount])).toEqual([['cash_on_delivery', 12]])
    const named = await back(w, s, [[0, 1]], undefined, { payments: [{ method: 'cash_on_delivery', amount: 12 }] })
    expect(named.status).toBe(200)
  })

  it('a method no receipt can carry is refused before the claim', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const r = await back(w, s, [[0, 1]], undefined, { payments: [{ method: 'bank_transfer', amount: 12 }] })
    expect([r.status, r.json.code]).toEqual([422, 'payment_method_not_fiscal'])
    expect((await read(s.saleId)).register.stornoState).toBe('none')
  })

  it('a change kept by the sale is not refunded: the budget per method is what it kept', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w, { payments: [{ method: 'cash', amount: 100 }] })
    expect(s.sale.payments[0].amount).toBe(58.9)
    expect((await w.storno(s.saleId)).status).toBe(200)
    expect((await sessionOf(w)).totalCash).toBe(0)
  })
})

describe('what else takes a partial storno, and what does not', () => {
  it('a text sale takes it as it takes a whole one: nothing prints, the stock and the drawer move', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w, { text: true })
    const onDevice = w.sim!.receipts.length

    expect((await back(w, s, [[0, 1]])).status).toBe(200)

    const [storno] = await stornosOf(s.saleId)
    expect(storno.register.fiscal.state).toBe('none')
    expect(storno.total).toBe(12)
    expect(w.sim!.receipts).toHaveLength(onDevice)
    expect(await levelOf(w, s.products[0])).toBe(8)
    expect((await sessionOf(w)).totalReturns).toBe(12)
    expect((await read(s.saleId)).register.stornoState).toBe('partial')
  })

  it('a back-office sale: no session and no receipt, and it can no longer be edited or voided', async () => {
    const w = await tillWorld(app)
    const sold = await w.backOfficeSale(4)
    const id = String(sold.json.invoice.id)
    const sale = await read(id)
    const r = await w.call('POST', `/cash-register/documents/${id}/storno`, { reason: 'customer_return', lines: [{ lineId: String(sale.lines[0]._id), quantity: 1 }] }, undefined, w.clerkToken)

    expect(r.status).toBe(200)
    const [storno] = await stornosOf(id)
    expect(storno.total).toBe(12)
    expect(storno.register.fiscal.state).toBe('none')
    expect((await read(id)).register.stornoState).toBe('partial')
    expect((await w.stock()).quantity).toBe(10 - 4 + 1)

    const voided = await w.call('POST', `/invoices/${id}/void`, {}, undefined, w.clerkToken)
    expect(voided.status).toBeGreaterThanOrEqual(400)
    const edited = await w.call('PUT', `/invoices/${id}`, { notes: 'x', total: 1 }, undefined, w.clerkToken)
    expect(edited.status).toBeGreaterThanOrEqual(400)
    expect((await w.stock()).quantity).toBe(10 - 4 + 1)
  })

  describe('a back-office sale paid by bank: nothing prints, so the method is theirs (the reader, finding 4)', () => {
    async function byBank(w: TillWorld) {
      const sold = await w.backOfficeSale(4, { paymentMethod: 'bank_transfer' })
      expect(sold.status).toBe(200)
      const id = String(sold.json.invoice.id)
      return { id, lineId: String((await read(id)).lines[0]._id) }
    }
    const press = (w: TillWorld, id: string, body: Record<string, unknown>) =>
      w.call('POST', `/cash-register/documents/${id}/storno`, { reason: 'customer_return', ...body }, undefined, w.clerkToken)

    it('with nothing named, a part goes back as the sale was paid, as a whole one does', async () => {
      const w = await tillWorld(app)
      const { id, lineId } = await byBank(w)

      const r = await press(w, id, { lines: [{ lineId, quantity: 1 }] })

      expect(r.status).toBe(200)
      const [storno] = await stornosOf(id)
      expect(storno.payments.map((p: any) => [p.method, p.amount])).toEqual([['bank_transfer', 12]])
      expect(storno.register.fiscal.state).toBe('none')
      expect(w.sim!.receipts).toHaveLength(0)
      expect((await w.stock()).quantity).toBe(7)
      // And what is left, as the sale was paid.
      expect((await press(w, id, {})).status).toBe(200)
      expect((await stornosOf(id))[1].payments.map((p: any) => [p.method, p.amount])).toEqual([['bank_transfer', 36]])
    })

    it('picked by name, a part and all of a sale alike', async () => {
      const w = await tillWorld(app)
      const { id, lineId } = await byBank(w)
      expect((await press(w, id, { lines: [{ lineId, quantity: 1 }], payments: [{ method: 'bank_transfer', amount: 12 }] })).status).toBe(200)
      expect((await press(w, id, { payments: [{ method: 'other', amount: 36 }] })).status).toBe(200)
    })

    it('a method that is none is still refused, and nothing is claimed', async () => {
      const w = await tillWorld(app)
      const { id, lineId } = await byBank(w)
      const r = await press(w, id, { lines: [{ lineId, quantity: 1 }], payments: [{ method: 'crypto', amount: 12 }] })
      expect([r.status, r.json.code]).toEqual([422, 'payment_method_not_fiscal'])
      expect((await read(id)).register.stornoState).toBeUndefined()
    })

    it('at the till the rule stands, text or fiscal: its refund is what a receipt can carry', async () => {
      const w = await tillWorld(app)
      for (const text of [true, false]) {
        const s = await threeArticles(w, { text })
        const r = await back(w, s, [[0, 1]], undefined, { payments: [{ method: 'bank_transfer', amount: 12 }] })
        expect([r.status, r.json.code]).toEqual([422, 'payment_method_not_fiscal'])
      }
    })
  })

  it('a sale copied from an old POS row, whose lines have no ids, is named by their place', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    await Invoice.collection.updateOne({ _id: s.sale._id }, { $unset: { 'lines.$[]._id': '' } })
    const page = (await w.call('GET', `/cash-register/documents/${s.saleId}`)).json
    expect(page.lines.map((l: any) => l.lineId)).toEqual(['#0', '#1', '#2'])

    const r = await w.storno(s.saleId, undefined, { lines: [{ lineId: '#1', quantity: 1 }] })

    expect(r.status).toBe(200)
    expect((await stornosOf(s.saleId))[0].lines[0]).toMatchObject({ description: 'Гайка', quantity: 1, lineTotal: 6 })
  })

  it('an invoiced till sale stays refused: it is corrected through its invoice\'s credit note', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const contact = await createTestContact(w.oid)
    expect((await w.call('POST', `/invoices/${s.saleId}/to-invoice`, { contactId: String(contact._id) })).status).toBe(200)

    const r = await back(w, s, [[0, 1]])

    expect([r.status, r.json.code]).toEqual([409, 'cash_sale_invoiced'])
    expect((await read(s.saleId)).register.stornoState).toBe('none')
    expect(stornosOnDevice(w)).toHaveLength(0)
  })

  it('an invoice claimed between the door\'s read and the claim: the storno gives everything back', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const contact = await createTestContact(w.oid)
    let invoiced: any
    const undo = during(aClaim, async () => { invoiced = await w.call('POST', `/invoices/${s.saleId}/to-invoice`, { contactId: String(contact._id) }) })
    let r: any
    try {
      r = await back(w, s, [[0, 1]])
    } finally {
      undo()
    }
    expect(invoiced.status).toBe(200)
    expect([r.status, r.json.code]).toEqual([409, 'cash_sale_invoiced'])
    const sale = await read(s.saleId)
    expect(sale.register.stornoState).toBe('none')
    expect(sale.register.stornoClaims).toHaveLength(0)
    expect(sale.register.refundClaims).toHaveLength(0)
    expect(stornosOnDevice(w)).toHaveLength(0)
  })

  it('a receipt number a person typed stands once a part cites it, and again once that part gave way', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    // A sale whose print nothing could prove, settled with the number off the slip.
    await Invoice.updateOne({ _id: s.saleId }, { $set: { 'register.fiscal.state': 'unknown' }, $unset: { 'register.fiscalReceiptNumber': 1, 'register.fiscal.receiptNo': 1, leaseUntil: 1 } })
    const number = String(w.sim!.receipts.at(-1)!.number ?? '1')
    expect((await w.call('POST', `/cash-register/documents/${s.saleId}/settle`, { printed: true, receiptNumber: number, confirmNumber: true })).status).toBe(200)

    failsProved(w)
    expect((await back(w, s, [[0, 1]])).status).toBe(503)
    // Given back: it cites nothing, so the number can still be corrected.
    expect((await w.call('POST', `/cash-register/documents/${s.saleId}/settle`, { printed: true, receiptNumber: number + '0', confirmNumber: true })).status).toBe(200)
    expect((await read(s.saleId)).register.fiscalReceiptNumber).toBe(number + '0')
    await w.call('POST', `/cash-register/documents/${s.saleId}/settle`, { printed: true, receiptNumber: number, confirmNumber: true })

    expect((await back(w, s, [[0, 1]])).status).toBe(200)
    const refused = await w.call('POST', `/cash-register/documents/${s.saleId}/settle`, { printed: true, receiptNumber: number + '0', confirmNumber: true })
    expect([refused.status, refused.json.code]).toEqual([409, 'receipt_number_cited'])
    expect((await read(s.saleId)).register.fiscalReceiptNumber).toBe(number)
  })
})

describe('the owner\'s decision: a partly stornoed sale invoices only what is left', () => {
  const invoiceable = (w: TillWorld, s: Sold) => w.call('GET', `/invoices/${s.saleId}/to-invoice`)

  it('its lines are what was not returned, a line all of which came back is not one of them, and it moves nothing', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    expect((await back(w, s, [[0, 1], [2, 1]])).status).toBe(200)
    const contact = await createTestContact(w.oid)
    const stock = await levelOf(w, s.products[0])

    const state = (await invoiceable(w, s)).json.invoicing
    expect(state.canInvoice).toBe(true)
    expect(state.lines.map((l: any) => [l.quantity, l.returned, l.remaining])).toEqual([[3, 1, 2], [2, 0, 2], [1, 1, 0]])
    expect(state.remainingTotals.total).toBe(36)

    const r = await w.call('POST', `/invoices/${s.saleId}/to-invoice`, { contactId: String(contact._id) })

    expect(r.status).toBe(200)
    const invoice = await raw(r.json.invoice.id)
    expect(invoice.lines.map((l: any) => [l.description, l.quantity])).toEqual([['Болт', 2], ['Гайка', 2]])
    expect(invoice.total).toBe(36)
    expect(invoice.amountPaid).toBe(36)
    expect(invoice.status).toBe('paid')
    expect(await levelOf(w, s.products[0])).toBe(stock)
    const sale = (await w.call('GET', `/cash-register/documents/${s.saleId}`)).json
    expect(sale.row.invoicingState).toBe('full')
    expect(sale.row.status).toBe('partial')
  })

  it('more than is left is refused, and the rest of it can be invoiced in parts', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    expect((await back(w, s, [[0, 1]])).status).toBe(200)
    const contact = await createTestContact(w.oid)

    const over = await w.call('POST', `/invoices/${s.saleId}/to-invoice`, { contactId: String(contact._id), lines: [{ lineId: s.ids[0], quantity: 3 }] })
    expect([over.status, over.json.code]).toEqual([409, 'cash_sale_quantity_exceeded'])

    const part = await w.call('POST', `/invoices/${s.saleId}/to-invoice`, { contactId: String(contact._id), lines: [{ lineId: s.ids[0], quantity: 2 }] })
    expect(part.status).toBe(200)
    expect(part.json.invoice.total).toBe(24)
  })

  it('a sale to a named customer: invoiced once, whole, whole meaning what is left', async () => {
    const w = await tillWorld(app)
    const contact = await createTestContact(w.oid)
    const sold = await w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, { ...w.saleBody(3), customerId: String(contact._id) })
    expect(sold.status).toBe(200)
    const saleId = String(sold.json.transaction.id)
    const sale = await read(saleId)
    const s: Sold = { saleId, sale, ids: sale.lines.map((l: any) => String(l._id)), products: [w.product._id] }
    expect((await back(w, s, [[0, 1]])).status).toBe(200)

    const partOf = await w.call('POST', `/invoices/${saleId}/to-invoice`, { contactId: String(contact._id), lines: [{ lineId: s.ids[0], quantity: 1 }] })
    expect([partOf.status, partOf.json.code]).toEqual([422, 'cash_sale_whole_only'])

    const r = await w.call('POST', `/invoices/${saleId}/to-invoice`, { contactId: String(contact._id) })
    expect(r.status).toBe(200)
    expect(r.json.invoice.total).toBe(24)
  })

  it('all of it back: nothing to invoice, by name', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    expect((await back(w, s, [[0, 3], [1, 2]])).status).toBe(200)
    expect((await back(w, s, [[2, 1]])).status).toBe(200)
    const contact = await createTestContact(w.oid)
    const r = await w.call('POST', `/invoices/${s.saleId}/to-invoice`, { contactId: String(contact._id) })
    expect([r.status, r.json.code]).toEqual([422, 'cash_sale_stornoed'])
  })

  it('one in doubt keeps what it took from an invoice too', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    w.sim!.dropAfter = CLOSE
    expect((await back(w, s, [[0, 1]])).json.code).toBe('storno_in_doubt')
    w.sim!.disconnected = false
    const contact = await createTestContact(w.oid)

    const r = await w.call('POST', `/invoices/${s.saleId}/to-invoice`, { contactId: String(contact._id) })

    expect(r.status).toBe(200)
    expect(r.json.invoice.total).toBe(46.9)
  })

  it('a part landing while the invoice is being claimed: the invoice reads the sale after its own claim, and gives way', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const contact = await createTestContact(w.oid)
    // The invoice's placeholder goes in for line 1 in full, and a storno takes one of it right then.
    const real = Invoice.create
    ;(Invoice as any).create = async function (...args: any[]) {
      const made = await (real as any).apply(Invoice, args)
      if (args[0]?.cashSaleRef) {
        await Invoice.updateOne({ _id: s.saleId }, {
          $set: { 'register.stornoState': 'partial' },
          $push: { 'register.stornoClaims': { stornoId: new Invoice.base.Types.ObjectId(), lineId: s.ids[0], milli: 1000, at: new Date() } },
        })
      }
      return made
    }
    let r: any
    try {
      r = await w.call('POST', `/invoices/${s.saleId}/to-invoice`, { contactId: String(contact._id), lines: [{ lineId: s.ids[0], quantity: 3 }] })
    } finally {
      ;(Invoice as any).create = real
    }
    expect([r.status, r.json.code]).toEqual([409, 'cash_sale_quantity_exceeded'])
    expect(await Invoice.countDocuments({ orgId: w.oid, type: 'invoice' })).toBe(0)
  })

  it('attaching an invoice that already exists: what came back is not there to attach to', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    expect((await back(w, s, [[0, 2]])).status).toBe(200)

    const tooMuch = await draftOf(w, { method: 'bank_transfer', lines: [line(w, 2)], extra: onSaleDay() })
    expect((await send(w, tooMuch.id)).status).toBe(200)
    const refused = await w.call('POST', `/invoices/${tooMuch.id}/attach-to-cash-sale`, { cashSaleId: s.saleId })
    expect(refused.status).toBeGreaterThanOrEqual(400)
    expect(refused.json.code).toBe('line_quantity_exceeds')
    expect((await raw(tooMuch.id)).cashSaleRef).toBeUndefined()

    const fits = await draftOf(w, { method: 'bank_transfer', lines: [line(w, 1)], extra: onSaleDay() })
    expect((await send(w, fits.id)).status).toBe(200)
    expect((await w.call('POST', `/invoices/${fits.id}/attach-to-cash-sale`, { cashSaleId: s.saleId })).status).toBe(200)
    expect(String((await raw(fits.id)).cashSaleRef.cashSaleId)).toBe(s.saleId)
  })

  it('the invoice mirrors what the sale still holds per method, not what it was paid', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w, { payments: [{ method: 'cash', amount: 30 }, { method: 'card', amount: 28.9 }] })
    expect((await back(w, s, [[0, 1]], undefined, { payments: [{ method: 'card', amount: 12 }] })).status).toBe(200)
    const contact = await createTestContact(w.oid)
    const r = await w.call('POST', `/invoices/${s.saleId}/to-invoice`, { contactId: String(contact._id) })
    expect(r.status).toBe(200)
    const invoice = await raw(r.json.invoice.id)
    expect(invoice.payments.map((p: any) => [p.method, p.amount])).toEqual([['cash', 30], ['card', 16.9]])
  })
})

describe('a sale whose lines have no ids, copied raw from an old POS row (the reader, finding 6)', () => {
  /** Three articles, their lines' ids gone, and one of the first back. */
  async function stripped(w: TillWorld) {
    const s = await threeArticles(w)
    await Invoice.collection.updateOne({ _id: s.sale._id }, { $unset: { 'lines.$[]._id': '' } })
    expect((await w.storno(s.saleId, undefined, { lines: [{ lineId: '#0', quantity: 1 }] })).status).toBe(200)
    return s
  }
  const stateOf = async (w: TillWorld, s: Sold) => (await w.call('GET', `/invoices/${s.saleId}/to-invoice`)).json.invoicing
  const invoiceIt = async (w: TillWorld, s: Sold, lines?: { lineId: string; quantity: number }[]) => {
    const contact = await createTestContact(w.oid)
    return w.call('POST', `/invoices/${s.saleId}/to-invoice`, { contactId: String(contact._id), ...(lines ? { lines } : {}) })
  }

  it('names them by their place, as the storno does, and each keeps what it sold and what came back', async () => {
    const w = await tillWorld(app)
    const s = await stripped(w)
    const state = await stateOf(w, s)
    expect(state.lines.map((l: any) => [l.lineId, l.quantity, l.returned, l.remaining])).toEqual([['#0', 3, 1, 2], ['#1', 2, 0, 2], ['#2', 1, 0, 1]])
    expect(state.remainingTotals.total).toBe(46.9)
  })

  it('invoices all that is left, on every line, and claims it: a second invoice finds nothing', async () => {
    const w = await tillWorld(app)
    const s = await stripped(w)

    const r = await invoiceIt(w, s)

    expect(r.status).toBe(200)
    const invoice = await raw(r.json.invoice.id)
    expect(invoice.lines.map((l: any) => [l.description, l.quantity, l.cashSaleLineId])).toEqual([['Болт', 2, '#0'], ['Гайка', 2, '#1'], ['Шайба', 1, '#2']])
    expect(invoice.total).toBe(46.9)
    expect((await stateOf(w, s)).state).toBe('full')

    const again = await invoiceIt(w, s)
    expect([again.status, again.json.code]).toEqual([409, 'cash_sale_fully_invoiced'])
    expect((await w.call('GET', `/cash-register/documents/${s.saleId}`)).json.row.invoicingState).toBe('full')
  })

  it('in parts, by place, never past what is left, and a void gives it back', async () => {
    const w = await tillWorld(app)
    const s = await stripped(w)

    const part = await invoiceIt(w, s, [{ lineId: '#1', quantity: 1 }])
    expect(part.status).toBe(200)
    expect(part.json.invoice.total).toBe(6)
    const over = await invoiceIt(w, s, [{ lineId: '#1', quantity: 2 }])
    expect([over.status, over.json.code]).toEqual([409, 'cash_sale_quantity_exceeded'])
    expect((await stateOf(w, s)).lines[1]).toMatchObject({ invoiced: 1, remaining: 1 })

    expect((await w.call('POST', `/invoices/${part.json.invoice.id}/void`, {})).status).toBe(200)
    expect((await stateOf(w, s)).lines[1]).toMatchObject({ invoiced: 0, remaining: 2 })
  })

  it('a draft keeps its place through an edit', async () => {
    const w = await tillWorld(app)
    const s = await stripped(w)
    const contact = await createTestContact(w.oid)
    const draft = await w.call('POST', `/invoices/${s.saleId}/to-invoice`, { contactId: String(contact._id), issue: false })
    expect(draft.status).toBe(200)
    const lines = (await raw(draft.json.invoice.id)).lines.map((l: any) => ({ productId: String(l.productId), description: l.description, quantity: l.cashSaleLineId === '#0' ? 1 : l.quantity, unit: l.unit, unitPrice: l.unitPrice, discount: l.discount, taxRate: l.taxRate, cashSaleLineId: l.cashSaleLineId }))

    const edited = await w.call('PUT', `/invoices/${draft.json.invoice.id}`, { lines })

    expect(edited.status).toBe(200)
    expect((await raw(draft.json.invoice.id)).lines.map((l: any) => [l.cashSaleLineId, l.quantity])).toEqual([['#0', 1], ['#1', 2], ['#2', 1]])
    expect((await stateOf(w, s)).lines[0]).toMatchObject({ invoiced: 1, remaining: 1 })
  })

  it('an invoice attached to it claims by place too', async () => {
    const w = await tillWorld(app)
    const s = await stripped(w)
    const d = await draftOf(w, { method: 'bank_transfer', lines: [line(w, 1)], extra: onSaleDay() })
    expect((await send(w, d.id)).status).toBe(200)

    const r = await w.call('POST', `/invoices/${d.id}/attach-to-cash-sale`, { cashSaleId: s.saleId })

    expect(r.status).toBe(200)
    expect((await raw(d.id)).lines[0].cashSaleLineId).toBe('#0')
    expect((await stateOf(w, s)).lines[0]).toMatchObject({ invoiced: 1, remaining: 1 })
  })

  it('a sale whose lines have ids is as it was: the invoice line points at its id', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const r = await invoiceIt(w, s)
    expect(r.status).toBe(200)
    const invoice = await raw(r.json.invoice.id)
    expect(invoice.lines.map((l: any) => String(l.cashSaleLineId))).toEqual(s.ids)
    expect(invoice.lines[0].cashSaleLineId instanceof Invoice.base.Types.ObjectId).toBe(true)
  })
})

describe('a partial storno and a credit note\'s refund draw on one budget, per VAT rate', () => {
  /** A note on an invoice for that sale, for `quantity` of the world's article, issued giving nothing back yet. */
  async function noteFor(w: TillWorld, invoice: { id: string; contactId: string }, quantity = 1, productLine?: any) {
    const d = await draftOf(w, {
      type: 'credit_note', method: 'bank_transfer',
      lines: [productLine ?? line(w, quantity)],
      extra: { relatedInvoiceId: invoice.id, contactId: invoice.contactId },
    })
    expect((await send(w, d.id)).status).toBe(200)
    return d
  }
  async function invoiced(w: TillWorld, saleId: string) {
    const contact = await createTestContact(w.oid)
    const res = await w.call('POST', `/invoices/${saleId}/to-invoice`, { contactId: String(contact._id) })
    expect(res.status).toBe(200)
    return { id: String(res.json.invoice.id), contactId: String(contact._id) }
  }

  it('a part first: what is left of the sale is what its invoice\'s note can refund, citing the same receipt', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    expect((await back(w, s, [[0, 1]])).status).toBe(200)
    expect([...leftByRate(await read(s.saleId))]).toEqual([[20, 3600], [9, 1090]])
    const inv = await invoiced(w, s.saleId)
    const note = await noteFor(w, inv, 2)

    const r = await pay(w, note.id, 24)

    expect(r.status).toBe(200)
    const printed = stornosOnDevice(w)
    expect(printed).toHaveLength(2)
    expect(printed[1].header[5]).toBe(s.sale.register.fiscalReceiptNumber)
    expect([...leftByRate(await read(s.saleId))]).toEqual([[20, 1200], [9, 1090]])
  })

  it('a part first: a refund asking more than the rate has left gives way, in the budget itself', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    expect((await back(w, s, [[0, 3], [1, 1]])).status).toBe(200)
    const sale = await read(s.saleId)
    expect([...leftByRate(sale)]).toEqual([[20, 600], [9, 1090]])
    const stormy = new Invoice.base.Types.ObjectId()
    expect(await takeBudget(sale, stormy, new Map([[20, 601]]))).toBe(false)
    expect(await takeBudget(sale, stormy, new Map([[9, 1091]]))).toBe(false)
    expect(await takeBudget(sale, stormy, new Map([[20, 600]]))).toBe(true)
  })

  /** A sale a refund has taken from, with its invoice gone: what a void racing the refund leaves. */
  async function refundedThenVoided(w: TillWorld, amount = 24) {
    const s = await threeArticles(w)
    const inv = await invoiced(w, s.saleId)
    const note = await noteFor(w, inv, amount / 12)
    expect((await pay(w, note.id, amount)).status).toBe(200)
    await Invoice.updateOne({ _id: inv.id }, { $set: { status: 'voided' } })
    return { s, inv, note }
  }

  it('a refund first: a part that fits goes, whole is refused by name, a part past the rate is refused and says what is left', async () => {
    const w = await tillWorld(app)
    const { s } = await refundedThenVoided(w)
    expect([...leftByRate(await read(s.saleId))]).toEqual([[20, 2400], [9, 1090]])

    const whole = await w.storno(s.saleId)
    expect([whole.status, whole.json.code]).toEqual([409, 'cash_sale_refunded'])

    const tooMuch = await back(w, s, [[0, 3]])
    expect([tooMuch.status, tooMuch.json.code]).toEqual([409, 'storno_exceeds_budget'])
    expect(tooMuch.json.left).toBe(34.9)
    const onDevice = stornosOnDevice(w).length

    expect((await back(w, s, [[0, 2]])).status).toBe(200)
    expect((await back(w, s, [[2, 1]])).status).toBe(200)
    expect(stornosOnDevice(w)).toHaveLength(onDevice + 2)
    expect(leftByRate(await read(s.saleId)).size).toBe(0)
  })

  it('a refund first, on one rate: a part of the other rate is untouched by it', async () => {
    const w = await tillWorld(app)
    const { s } = await refundedThenVoided(w, 36)
    // 48 at 20 %, 36 of it refunded: two bolts are past that rate, and the washer at 9 % never was in it.
    const bolts = await back(w, s, [[0, 2]])
    expect([bolts.status, bolts.json.code]).toEqual([409, 'storno_exceeds_budget'])
    expect(bolts.json.left).toBe(22.9)
    expect((await back(w, s, [[2, 1]])).status).toBe(200)
    expect((await back(w, s, [[0, 1]])).status).toBe(200)
    expect(leftByRate(await read(s.saleId)).size).toBe(0)
  })

  it('a refund\'s claim landing between a part\'s read and its claim: the part gives way with nothing printed', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const undo = during(aClaim, async () => {
      const fresh = await read(s.saleId)
      expect(await takeBudget(fresh, new Invoice.base.Types.ObjectId(), new Map([[20, 2500]]))).toBe(true)
    })
    let r: any
    try {
      r = await back(w, s, [[0, 2]])
    } finally {
      undo()
    }
    expect([r.status, r.json.code]).toEqual([409, 'storno_exceeds_budget'])
    expect(stornosOnDevice(w)).toHaveLength(0)
    expect((await read(s.saleId)).register.stornoClaims ?? []).toHaveLength(0)
  })

  it('a part\'s claim landing just before a refund\'s: the refund gives way, on the budget', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const stale = await read(s.saleId)
    expect((await back(w, s, [[0, 3], [1, 1]])).status).toBe(200)
    expect(await takeBudget(stale, new Invoice.base.Types.ObjectId(), new Map([[20, 601]]))).toBe(false)
  })

  it('a part in doubt holds what it took from a refund, and a refund that needs it is told to settle it', async () => {
    const w = await tillWorld(app)
    const { s, inv } = await refundedThenVoided(w, 12)
    w.sim!.dropAfter = CLOSE
    expect((await back(w, s, [[0, 1]])).json.code).toBe('storno_in_doubt')
    w.sim!.disconnected = false
    await Invoice.updateOne({ _id: inv.id }, { $set: { status: 'paid' } })
    // 48 at 20 %: 12 refunded, 12 in doubt, so three more need what it holds.
    const note = await noteFor(w, inv, 3)

    const r = await pay(w, note.id, 36)

    expect([r.status, r.json.code]).toEqual([409, 'receipt_in_doubt'])
    const [held] = (await stornosOf(s.saleId))
    expect(r.json.receipt.id).toBe(String(held._id))
    // What it does not hold can still go back.
    expect((await pay(w, note.id, 24)).status).toBe(200)
  })

  it('a dead part holding a claim is finished by the refund\'s door first, and what it held is there again', async () => {
    const w = await tillWorld(app)
    const s = await threeArticles(w)
    const inv = await invoiced(w, s.saleId)
    // Its invoice is what let the refund in: the dead part predates it. It never reached the device.
    const dead: any = await Invoice.create({
      orgId: w.oid, invoiceNumber: 'CS-DEAD-0001', type: 'cash_storno', direction: 'outgoing', status: 'paid',
      issueDate: new Date(), dueDate: new Date(), currency: 'EUR', exchangeRate: 1, total: 36, leaseUntil: new Date(Date.now() - 1000),
      lines: [{ description: 'Болт', quantity: 3, unit: 'бр.', unitPrice: 10, taxRate: 20, taxAmount: 6, lineTotal: 36 }],
      billingAddress: { street: '-' }, relatedInvoiceId: s.saleId, createdBy: w.user._id,
      register: { origin: 'pos', sessionId: w.sessionId, isFiscal: true, fiscal: { state: 'pending', mode: 'fiscal' }, storno: { originalId: s.saleId, partial: true } },
    })
    await Invoice.updateOne({ _id: s.saleId }, {
      $set: { 'register.stornoState': 'partial' },
      $push: {
        'register.stornoedBy': dead._id,
        'register.stornoClaims': { stornoId: dead._id, lineId: s.ids[0], milli: 3000, at: new Date() },
        'register.refundClaims': { stornoId: dead._id, rate: 20, cents: 3600 },
      },
    })
    const note = await noteFor(w, inv, 3)

    const r = await pay(w, note.id, 36)

    expect(r.status).toBe(200)
    expect((await read(dead._id)).status).toBe('voided')
    expect(stornosOnDevice(w)).toHaveLength(1)
  })
})
