import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import { clerkSale, clerkSession, draftOf, gate, pay, raw, receiptsOf, send, until } from '../helpers/receipt-world'
import { deviceTurn, DeviceBusyError } from 'fiscal/device-turn'

/**
 * One turn per device, from the counter read to the close, in the process holding the device.
 *
 * FR-23 sends every back-office issue and payment to the device the till prints on, and a warehouse
 * normally has two sessions open. Without a turn, one receipt's open cleared the other's receipt off
 * the device, and a counter read by one request was moved by another. Through the real routes on the
 * simulated Eltrade, with a slow line so that they really do interleave.
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

/** Start `first`, let it reach the device, then start `second`, and answer both. */
async function inOrder<A, B>(w: TillWorld, first: () => Promise<A>, second: () => Promise<B>): Promise<[A, B]> {
  const before = w.sim!.frames
  const a = first()
  await until(() => w.sim!.frames > before, 'the first request to reach the device')
  const b = second()
  return [await a, await b]
}

const closedReceipts = (w: TillWorld) => w.sim!.receipts.filter(r => !r.voided)
const unps = (w: TillWorld) => w.sim!.receipts.map(r => r.header[1])

describe('a sale and a receipt on one device', () => {
  async function ready(w: TillWorld) {
    const d = await draftOf(w, { method: 'bank_transfer' })
    await send(w, d.id)
    w.sim!.latencyMs = 15
    return d
  }

  it('the sale first: each prints its own receipt, under its own УНП, and neither clears the other', async () => {
    const w = await tillWorld(app)
    const d = await ready(w)

    const [sale, payment] = await inOrder(w, () => w.sell(1), () => pay(w, d.id, 24))

    expect(sale.status).toBe(200)
    expect(sale.json.receiptError).toBeUndefined()
    expect(payment.status).toBe(200)
    expect(payment.json.receiptError).toBeUndefined()
    expect(w.sim!.receipts.map(r => [r.total, r.voided ?? false]).sort()).toEqual([[12, false], [24, false]])
    expect(new Set(unps(w)).size).toBe(2)
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect((await receiptsOf(d.id))[0].register.fiscal.state).toBe('printed')
  })

  it('the receipt first: the same', async () => {
    const w = await tillWorld(app)
    const d = await ready(w)

    const [payment, sale] = await inOrder(w, () => pay(w, d.id, 24), () => w.sell(1))

    expect(payment.status).toBe(200)
    expect(sale.status).toBe(200)
    expect(sale.json.receiptError).toBeUndefined()
    expect(w.sim!.receipts.map(r => [r.total, r.voided ?? false]).sort()).toEqual([[12, false], [24, false]])
    expect(new Set(unps(w)).size).toBe(2)
  })

  it('each reads the counter in its own turn, so each records its own number', async () => {
    const w = await tillWorld(app)
    const d = await ready(w)

    await inOrder(w, () => w.sell(1), () => pay(w, d.id, 24))

    const [receipt] = await receiptsOf(d.id)
    const printed = closedReceipts(w).find(r => r.total === 24)!
    expect(receipt.register.fiscalReceiptNumber).toBe(printed.number)
    expect(receipt.register.fiscal.counterBefore).toBe(Number(printed.number) - 1)
  })

  it('a session report asked during a sale waits its turn: its service receipt would find a receipt open', async () => {
    const w = await tillWorld(app)
    w.sim!.latencyMs = 15

    const [sale, report] = await inOrder(w, () => w.sell(1), () => w.call('POST', `/trade/pos/session/${w.sessionId}/report/print`))

    expect(sale.status).toBe(200)
    expect(sale.json.receiptError).toBeUndefined()
    expect(report.status).toBe(200)
    expect(closedReceipts(w)).toHaveLength(1)
  })

  it('two cashiers\' sales at once, on two sessions of one device', async () => {
    const w = await tillWorld(app)
    const clerk = await clerkSession(w)
    w.sim!.latencyMs = 15

    const [a, b] = await inOrder(w, () => w.sell(1), () => clerkSale(w, clerk, 2))

    expect([a.status, b.status]).toEqual([200, 200])
    expect([a.json.receiptError, b.json.receiptError]).toEqual([undefined, undefined])
    expect(closedReceipts(w).map(r => r.total).sort()).toEqual([12, 24])
    expect(w.sim!.receipts).toHaveLength(2)
  })
})

describe('a slow Z-report (FR-09), in either order', () => {
  const close = (w: TillWorld) => w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 100 } })

  it('the Z first: a sale waits its turn behind it, and prints when it is done', async () => {
    const w = await tillWorld(app)
    const clerk = await clerkSession(w)
    const held = gate()
    w.sim!.beforeCommand = cmd => (cmd === 0x45 ? held.closed : undefined)

    const closing = close(w)
    await until(() => w.sim!.frames > 0 && !!w.sim!.beforeCommand, 'the Z to reach the device')
    await new Promise(r => setTimeout(r, 50))
    const sale = clerkSale(w, clerk, 1)
    await new Promise(r => setTimeout(r, 100))
    // Behind the Z: not a command of the sale has reached the device.
    expect(w.sim!.executed.some(c => c.cmd === 0x90)).toBe(false)
    held.open()

    const [closed, sold] = [await closing, await sale]
    expect(closed.status).toBe(200)
    expect(sold.status).toBe(200)
    expect(sold.json.receiptError).toBeUndefined()
    expect(w.sim!.reports).toHaveLength(1)
    expect(closedReceipts(w)).toHaveLength(1)
  })

  it('the sale first: the Z waits its turn behind it, and closes the day when it is done', async () => {
    const w = await tillWorld(app)
    const clerk = await clerkSession(w)
    const held = gate()
    w.sim!.beforeCommand = cmd => (cmd === 0x31 ? held.closed : undefined)

    const sale = clerkSale(w, clerk, 1)
    await until(() => w.sim!.executed.some(c => c.cmd === 0x90), 'the sale to open its receipt')
    const closing = close(w)
    await new Promise(r => setTimeout(r, 100))
    expect(w.sim!.reports).toHaveLength(0)
    held.open()

    const [sold, closed] = [await sale, await closing]
    expect(sold.status).toBe(200)
    expect(sold.json.receiptError).toBeUndefined()
    expect(closed.status).toBe(200)
    expect(closed.json.fiscalStatus).toBe('closed')
    expect(closedReceipts(w)).toHaveLength(1)
    expect(w.sim!.reports).toHaveLength(1)
    // The day closed after the sale: it is in the Z, and the receipt was not cleared to make room.
    expect(w.sim!.receipts.some(r => r.voided)).toBe(false)
  })
})

describe('the turn itself', () => {
  it('runs one at a time, in the order asked, whatever each takes', async () => {
    const ran: string[] = []
    const job = (name: string, ms: number) => deviceTurn('d1', async () => {
      ran.push(`${name}+`)
      await new Promise(r => setTimeout(r, ms))
      ran.push(`${name}-`)
    })
    await Promise.all([job('a', 30), job('b', 1), job('c', 1)])
    expect(ran).toEqual(['a+', 'a-', 'b+', 'b-', 'c+', 'c-'])
  })

  it('never makes a device wait for another device', async () => {
    const ran: string[] = []
    const slow = deviceTurn('d1', async () => { await new Promise(r => setTimeout(r, 40)); ran.push('slow') })
    await deviceTurn('d2', async () => { ran.push('quick') })
    await slow
    expect(ran).toEqual(['quick', 'slow'])
  })

  it('is re-entrant, so what runs inside a turn cannot deadlock against it', async () => {
    const out = await deviceTurn('d1', () => deviceTurn('d1', async () => 'inner'))
    expect(out).toBe('inner')
  })

  it('a failed turn lets the next one run', async () => {
    let error: any
    try {
      await deviceTurn('d1', async () => { throw new Error('out of paper') })
    } catch (e) {
      error = e
    }
    expect(error?.message).toBe('out of paper')
    expect(await deviceTurn('d1', async () => 'next')).toBe('next')
  })

  it('a turn that does not come in time gives up, leaves the queue moving, and says the device is busy', async () => {
    const held = gate()
    const first = deviceTurn('d1', () => held.closed)
    let error: any
    try {
      await deviceTurn('d1', async () => 'never', { waitMs: 20 })
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(DeviceBusyError)
    const third = deviceTurn('d1', async () => 'third')
    held.open()
    await first
    expect(await third).toBe('third')
  })
})
