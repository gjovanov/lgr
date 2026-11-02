import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import type { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import { sessionOf } from '../helpers/receipt-world'
import { createTestProduct, createTestStockLevel } from '../helpers/factories'
import { Invoice } from 'db/models'
import { computePosTotals, roundCents } from 'config/pos-totals'

/**
 * The prod sweep's D2 (#461): a till sale's total on the device differed from its document, with no error. A device
 * adds up a VAT-inclusive price rounded to the cent, times the quantity, and fasteners are priced below that:
 *
 *   1000 × 0.0533 net at 20 %: LGR 63.96, the device 0.06 × 1000 = 60.00, cash 63.96, showing 3.96 change
 *   100 × 3.33 net at 20 %, by card: LGR 399.60, the device 400.00, L 399.60 + P 0.40 of cash nobody took
 *
 * and a storno of the first printed 60.00. The document read `printed`. `/send` got the same goods right, one
 * line per rate at the exact gross, and the till's sale and storno go through that rule now.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => { await setupTestDB(); app = tillApp() as any }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { forgetDevices(); await clearCollections() }, 30_000)

const MODE: Record<string, string> = { cash: 'P', card: 'L' }
const onDevice = (w: TillWorld, kind: 'fiscal' | 'storno') => w.sim!.receipts.filter(r => r.kind === kind && !r.voided)
const docOf = (id: string) => Invoice.findById(id).lean().exec() as Promise<any>

function saleOf(w: TillWorld, lines: { productId?: string; quantity: number; unitPrice: number; taxRate?: number; discount?: number }[], method: string) {
  const t = computePosTotals(lines.map(l => ({ quantity: l.quantity, unitPrice: l.unitPrice, taxRate: l.taxRate ?? 20, discount: l.discount ?? 0 })))
  const body = {
    type: 'sale',
    lines: lines.map((l) => {
      const net = l.quantity * l.unitPrice * (1 - (l.discount ?? 0) / 100)
      return {
        productId: l.productId ?? String(w.product._id), name: 'Винт DIN 7504', quantity: l.quantity, unitPrice: l.unitPrice, discount: l.discount ?? 0,
        taxRate: l.taxRate ?? 20, taxAmount: roundCents((net * (l.taxRate ?? 20)) / 100), lineTotal: roundCents(net),
      }
    }),
    subtotal: t.subtotal, discountTotal: t.discountTotal, taxTotal: t.taxTotal, total: t.total,
    payments: [{ method, amount: t.total }], changeDue: 0,
  }
  return { body, total: t.total }
}

const sell = (w: TillWorld, body: any) => w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, body)

/** What the sweep's check asks of a receipt: the document's total to the cent, no change shown, no cash top-up. */
function exact(printed: any, total: number, method: string) {
  expect(printed.total).toBe(total)
  expect(printed.paid).toBe(total)
  expect(printed.payments).toEqual([{ mode: MODE[method], amount: total }])
}

const RUNS = [
  { name: '1000 × 0.0533 net at 20 %', quantity: 1000, unitPrice: 0.0533, total: 63.96, wasOnDevice: 60 },
  { name: '100 × 3.33 net at 20 %', quantity: 100, unitPrice: 3.33, total: 399.6, wasOnDevice: 400 },
]

describe('what a till sale prints comes to its document, to the cent (D2)', () => {
  for (const run of RUNS) {
    for (const method of ['cash', 'card']) {
      describe(`${run.name}, by ${method}`, () => {
        const world = async () => {
          const w = await tillWorld(app, { stock: 5000 })
          const { body, total } = saleOf(w, [{ quantity: run.quantity, unitPrice: run.unitPrice }], method)
          expect(total).toBe(run.total)
          const r = await sell(w, body)
          expect(r.status).toBe(200)
          expect(r.json.receiptError).toBeUndefined()
          expect(r.json.transaction.fiscal.state).toBe('printed')
          return { w, id: String(r.json.transaction.id), total }
        }

        it('the sale: one line at the exact gross, no change, no top-up', async () => {
          const { w, id, total } = await world()
          const [printed] = onDevice(w, 'fiscal')
          exact(printed, total, method)
          expect(printed.sales).toHaveLength(1)
          expect(printed.sales[0]).toMatchObject({ quantity: 1, price: total, amount: total })
          expect(w.sim!.dayTotal).toBe(total)
          // The document keeps its articles: what moved is what was sold, and only the device's lines are one per rate.
          const doc = await docOf(id)
          expect(doc.lines).toHaveLength(1)
          expect(doc.lines[0]).toMatchObject({ quantity: run.quantity, unitPrice: run.unitPrice })
          expect((await w.stock()).quantity).toBe(5000 - run.quantity)
          expect((await sessionOf(w))[method === 'cash' ? 'totalCash' : 'totalCard']).toBe(total)
        })

        it('its whole storno equals what it reverses', async () => {
          const { w, id, total } = await world()

          const back = await w.storno(id)

          expect(back.status).toBe(200)
          expect(back.json.receiptError).toBeUndefined()
          const [sale] = onDevice(w, 'fiscal')
          const [storno] = onDevice(w, 'storno')
          exact(storno, total, method)
          expect(storno.total).toBe(sale.total)
          expect(storno.sales.map((s: any) => [s.quantity, s.price])).toEqual(sale.sales.map((s: any) => [s.quantity, s.price]))
          expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalCard: 0 })
        })

        it('in parts: each to its own document, and together what the sale printed', async () => {
          const { w, id, total } = await world()
          const lineId = String((await docOf(id)).lines[0]._id)
          const third = Math.floor(run.quantity / 3)

          const first = await w.storno(id, undefined, { lines: [{ lineId, quantity: third }] })
          const second = await w.storno(id, undefined, { lines: [{ lineId, quantity: run.quantity - third }] })

          expect(first.status).toBe(200)
          expect(second.status).toBe(200)
          const stornos = onDevice(w, 'storno')
          expect(stornos).toHaveLength(2)
          exact(stornos[0], first.json.transaction.total, method)
          exact(stornos[1], second.json.transaction.total, method)
          expect(roundCents(stornos[0].total + stornos[1].total)).toBe(total)
          const sale = await docOf(id)
          expect(sale.register.stornoState).toBe('full')
          expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalCard: 0 })
          expect((await w.stock()).quantity).toBe(5000)
        })
      })
    }
  }

  it('parts of one sale go each by its own money: one that comes out at the device\'s price keeps its article, and the rest does not', async () => {
    const w = await tillWorld(app, { stock: 500 })
    const { body, total } = saleOf(w, [{ quantity: 3, unitPrice: 3.33 }], 'cash')
    const r = await sell(w, body)
    expect(total).toBe(11.99)
    exact(onDevice(w, 'fiscal')[0], 11.99, 'cash')
    const lineId = String((await docOf(r.json.transaction.id)).lines[0]._id)

    // One of three is worth 4.00, which is the device's own 4.00 a piece. The other two are 7.99, and it would make them 8.00.
    const one = await w.storno(r.json.transaction.id, undefined, { lines: [{ lineId, quantity: 1 }] })
    const two = await w.storno(r.json.transaction.id, undefined, { lines: [{ lineId, quantity: 2 }] })

    expect([one.status, two.status]).toEqual([200, 200])
    const [first, second] = onDevice(w, 'storno')
    exact(first, 4, 'cash')
    exact(second, 7.99, 'cash')
    expect(first.sales[0]).toMatchObject({ text: 'Винт DIN 7504', price: 4, quantity: 1 })
    expect(second.sales[0]).toMatchObject({ price: 7.99, quantity: 1 })
  })

  describe('what prints as it always did', () => {
    it('a price that comes out exactly keeps its articles, and a storno of it too', async () => {
      const w = await tillWorld(app)
      const r = await w.sell(2)
      const [printed] = onDevice(w, 'fiscal')
      expect(printed.sales).toEqual([{ text: 'Болт DIN 933 М8Х25', group: 'Б', price: 12, quantity: 2, percent: 0, amount: 24 }])

      await w.storno(r.json.transaction.id)

      expect(onDevice(w, 'storno')[0].sales).toEqual([{ text: 'Болт DIN 933 М8Х25', group: 'Б', price: 12, quantity: 2, percent: 0, amount: 24 }])
    })

    it('what the customer handed over is still the customer\'s change', async () => {
      const w = await tillWorld(app, { stock: 5000 })
      const { body, total } = saleOf(w, [{ quantity: 1000, unitPrice: 0.0533 }], 'cash')
      const r = await sell(w, { ...body, payments: [{ method: 'cash', amount: 70 }] })
      expect(r.status).toBe(200)
      const [printed] = onDevice(w, 'fiscal')
      expect(printed.total).toBe(total)
      expect(printed.payments).toEqual([{ mode: 'P', amount: 70 }])
      expect(r.json.transaction.changeDue).toBe(6.04)
    })

    it('a split tender adds up to the document too', async () => {
      const w = await tillWorld(app, { stock: 500 })
      const { body, total } = saleOf(w, [{ quantity: 100, unitPrice: 3.33 }], 'cash')
      const r = await sell(w, { ...body, payments: [{ method: 'card', amount: 300 }, { method: 'cash', amount: 99.6 }] })
      expect(r.status).toBe(200)
      expect(r.json.receiptError).toBeUndefined()
      const [printed] = onDevice(w, 'fiscal')
      expect(printed.total).toBe(total)
      expect(printed.payments).toEqual([{ mode: 'L', amount: 300 }, { mode: 'P', amount: 99.6 }])
    })
  })

  it('two rates: one line each, at each rate\'s exact gross, in that rate\'s group', async () => {
    const w = await tillWorld(app, { stock: 5000 })
    const other = await createTestProduct(w.oid, { name: 'Книга', sellingPrice: 10, purchasePrice: 3, taxRate: 9, unit: 'бр.' } as any)
    await createTestStockLevel(w.oid, other._id, w.warehouse._id, { quantity: 10, availableQuantity: 10, avgCost: 3 } as any)
    const { body, total } = saleOf(w, [{ quantity: 1000, unitPrice: 0.0533 }, { productId: String(other._id), quantity: 1, unitPrice: 10, taxRate: 9 }], 'card')

    const r = await sell(w, body)

    expect(r.status).toBe(200)
    const [printed] = onDevice(w, 'fiscal')
    exact(printed, total, 'card')
    expect(printed.sales.map((s: any) => [s.group, s.amount])).toEqual([['Б', 63.96], ['Г', 10.9]])
  })

  it('names the sale, and a storno names what it reverses', async () => {
    const w = await tillWorld(app, { stock: 5000 })
    const { body } = saleOf(w, [{ quantity: 1000, unitPrice: 0.0533 }], 'cash')
    const r = await sell(w, body)
    const number = r.json.transaction.transactionNumber
    expect(onDevice(w, 'fiscal')[0].sales[0].text).toBe(`Продажба № ${number}`)

    await w.storno(r.json.transaction.id)

    expect(onDevice(w, 'storno')[0].sales[0].text.replace(/\s+/g, ' ')).toBe(`Връщане по продажба № ${number}`)
  })

  it('a back-office sale joined to the session goes the same way', async () => {
    const w = await tillWorld(app, { stock: 5000 })
    const r = await w.call('POST', '/invoices', {
      type: 'cash_sale', direction: 'outgoing', issueDate: '2026-11-02', currency: 'EUR',
      lines: [{ productId: String(w.product._id), warehouseId: String(w.warehouse._id), description: 'Винт', quantity: 1000, unit: 'бр.', unitPrice: 0.0533, taxRate: 20 }],
      subtotal: 53.3, taxTotal: 10.66, total: 63.96, paymentMethod: 'card', receipt: 'fiscal',
    })

    expect(r.status).toBe(200)
    exact(onDevice(w, 'fiscal')[0], 63.96, 'card')
  })

  it('a line a device would refuse, a discount of all of it, does not stop the rest: the rate\'s gross prints', async () => {
    const w = await tillWorld(app, { stock: 500 })
    const other = await createTestProduct(w.oid, { name: 'Подарък', sellingPrice: 5, purchasePrice: 3, taxRate: 20, unit: 'бр.' } as any)
    await createTestStockLevel(w.oid, other._id, w.warehouse._id, { quantity: 10, availableQuantity: 10, avgCost: 3 } as any)
    const { body, total } = saleOf(w, [{ quantity: 1, unitPrice: 10 }, { productId: String(other._id), quantity: 1, unitPrice: 5, discount: 100 }], 'cash')

    const r = await sell(w, body)

    expect(r.status).toBe(200)
    expect(r.json.transaction.fiscal.state).toBe('printed')
    exact(onDevice(w, 'fiscal')[0], total, 'cash')
  })

  it('the text slip is the document\'s own figures, as it always was: no device adds anything up', async () => {
    const w = await tillWorld(app, { stock: 5000 })
    w.sim!.unfiscalizedUnit = true
    const { body } = saleOf(w, [{ quantity: 1000, unitPrice: 0.0533 }], 'cash')

    const r = await sell(w, body)

    expect(r.json.transaction.fiscal).toMatchObject({ state: 'printed', mode: 'text' })
    const slip = w.sim!.nonFiscalLines
    expect(slip.some(l => l.includes('Винт DIN 7504'))).toBe(true)
    expect(slip.some(l => /1000x0\.0533/.test(l) && /53\.30 EUR/.test(l))).toBe(true)
    expect(slip.some(l => /^TOTAL:\s+63\.96 EUR$/.test(l))).toBe(true)
    expect(slip.some(l => /^CASH:\s+63\.96 EUR$/.test(l))).toBe(true)
    expect(slip.some(l => /CHANGE/.test(l))).toBe(false)
  })
})
