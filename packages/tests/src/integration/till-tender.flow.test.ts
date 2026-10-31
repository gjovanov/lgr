import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import type { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import { captureRejection, expectRejection } from '../helpers/capture-rejection'
import { Invoice, POSSession, Sequence } from 'db/models'
import { getPrinter } from 'fiscal/fiscal-device.service'
import { FiscalPaymentMethodError } from 'fiscal/types'
import { tillPrinter } from 'invoicing-api/src/lib/cash-register-till'

/**
 * A payment no fiscal receipt can carry used to print as cash: `toFiscalPaymentType` answered 'cash'
 * for anything it did not know, so a bank transfer on a back-office sale joined to a session was
 * recorded by the device as cash taken. Every door that prints now refuses such a method up front
 * (422 `payment_method_not_fiscal`) with nothing written: no document, no number, no УНП, nothing
 * on the device.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => { await setupTestDB(); app = tillApp() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { forgetDevices(); await clearCollections() })

const NOT_FISCAL = ['bank_transfer', 'other', 'check', 'crypto']

/** Everything a refused request must leave as it was. */
async function footprint(w: TillWorld) {
  const counters = (await Sequence.find({ orgId: w.oid }).lean().exec() as any[]).map(s => `${s.prefix}:${s.year}:${s.lastNumber}`).sort()
  const session: any = await POSSession.findById(w.sessionId).lean().exec()
  return {
    documents: await Invoice.countDocuments({ orgId: w.oid }),
    counters,
    session: [session.totalSales, session.totalCash, session.totalCard, session.totalOther, session.totalCashOnDelivery, session.transactionCount],
    device: w.sim ? w.sim.executed.length : 0,
    receipts: w.sim ? w.sim.receipts.length : 0,
  }
}

function expectNotFiscal(r: { status: number; json: any }, method: string) {
  expect({ method, status: r.status, code: r.json?.code }).toEqual({ method, status: 422, code: 'payment_method_not_fiscal' })
}

describe('the till', () => {
  it('refuses a method no receipt can carry, on a fiscal and on a text receipt, before anything is written', async () => {
    const w = await tillWorld(app)
    const before = await footprint(w)
    for (const method of NOT_FISCAL) {
      for (const nonFiscal of [false, true]) {
        expectNotFiscal(await w.sell(1, { method, nonFiscal }), method)
      }
    }
    expect(await footprint(w)).toEqual(before)
  })

  it('says what to do about it, in words', async () => {
    const w = await tillWorld(app)
    const r = await w.sell(1, { method: 'bank_transfer' })
    expect(r.json.method).toBe('bank_transfer')
    expect(r.json.message).toContain('bank transfer')
    expect(r.json.message).not.toContain('bank_transfer')
  })

  it('refuses them with no device too: the till takes the same methods either way', async () => {
    const w = await tillWorld(app, { device: false })
    const before = await footprint(w)
    expectNotFiscal(await w.sell(1, { method: 'bank_transfer' }), 'bank_transfer')
    expect(await footprint(w)).toEqual(before)
  })

  it('still takes what it took: card, and a legacy mobile payment as card on the device', async () => {
    const w = await tillWorld(app)
    expect((await w.sell(1, { method: 'card' })).status).toBe(200)
    expect((await w.sell(1, { method: 'mobile' })).status).toBe(200)
    expect((await w.sell(1, { method: 'voucher' })).status).toBe(200)
    expect(w.sim!.receipts.map(r => r.payments[0].mode)).toEqual(['L', 'L', 'C'])
  })
})

describe('past the doors', () => {
  it('a document an older release left pending opens no receipt it could not pay', async () => {
    const w = await tillWorld(app)
    const before = w.sim!.executed.length
    const printer = tillPrinter(w.orgId, {
      deviceId: w.deviceId, deviceNumber: 'ED123456', printer: getPrinter(w.deviceId), cashOnDeliveryRefusal: null,
    }, { id: String(w.user._id), operatorCode: '0001' }, null)

    const err = await captureRejection(printer.printSale({
      register: { unp: 'ED123456-0001-0000099' },
      lines: [{ description: 'Болт', quantity: 1, unitPrice: 10, taxRate: 20 }],
      payments: [{ method: 'bank_transfer', amount: 12 }],
    }))

    expectRejection(err, FiscalPaymentMethodError)
    expect(w.sim!.executed).toHaveLength(before)
    expect(w.sim!.receipt).toBeNull()
  })
})

describe('a back-office sale joined to a session (D-13)', () => {
  it('refuses the method on a fiscal receipt: it used to print as cash', async () => {
    const w = await tillWorld(app)
    const before = await footprint(w)
    for (const method of ['bank_transfer', 'other', 'crypto']) {
      expectNotFiscal(await w.cashierBackOfficeSale(1, { paymentMethod: method, receipt: 'fiscal' }), method)
    }
    expect(await footprint(w)).toEqual(before)
  })

  it('leaves the sale alone when nothing fiscal prints: a text receipt, or none', async () => {
    const w = await tillWorld(app)
    expect((await w.cashierBackOfficeSale(1, { paymentMethod: 'bank_transfer', receipt: 'text' })).status).toBe(200)
    expect((await w.cashierBackOfficeSale(1, { paymentMethod: 'bank_transfer' })).status).toBe(200)
    expect(w.sim!.receipts).toHaveLength(0)
  })

  it('a clerk with no session prints nothing, so the method is theirs to name', async () => {
    const w = await tillWorld(app)
    expect((await w.backOfficeSale(1, { paymentMethod: 'bank_transfer', receipt: 'fiscal' })).status).toBe(200)
    expect(w.sim!.receipts).toHaveLength(0)
  })
})

describe('a storno', () => {
  const refund = (method: string, amount = 12) => ({ payments: [{ method, amount }] })

  it('the till: a refund no receipt can carry is refused, and the sale stays stornoable', async () => {
    const w = await tillWorld(app)
    const sale = (await w.sell(1, { method: 'card' })).json.transaction
    const before = await footprint(w)

    for (const method of ['bank_transfer', 'other', 'crypto']) {
      expectNotFiscal(await w.storno(sale.id, undefined, refund(method)), method)
    }

    expect(await footprint(w)).toEqual(before)
    const doc: any = await Invoice.findById(sale.id).lean().exec()
    expect(doc.register.stornoState).toBe('none')
    expect((await w.storno(sale.id)).status).toBe(200)
  })

  it('the journal: the same refusal, before the sale is claimed', async () => {
    const w = await tillWorld(app)
    const sale = (await w.sell(1, { method: 'card' })).json.transaction
    const before = await footprint(w)

    const r = await w.call('POST', `/cash-register/documents/${sale.id}/storno`, { reason: 'customer_return', sessionId: w.sessionId, ...refund('bank_transfer') })
    expectNotFiscal(r, 'bank_transfer')

    expect(await footprint(w)).toEqual(before)
    const doc: any = await Invoice.findById(sale.id).lean().exec()
    expect(doc.register.stornoedBy ?? []).toHaveLength(0)
  })

  it('a sale whose own method no receipt can carry: refused until the refund names one', async () => {
    const w = await tillWorld(app)
    const sale = (await w.sell(1, { method: 'card' })).json.transaction
    // A back-office sale an older release printed: its receipt said cash, its payment says otherwise.
    await Invoice.updateOne({ _id: sale.id }, { $set: { 'payments.0.method': 'bank_transfer' } }).exec()

    expectNotFiscal(await w.storno(sale.id), 'bank_transfer')
    expect((await w.sim!.receipts.filter(r => r.kind === 'storno'))).toHaveLength(0)

    expect((await w.storno(sale.id, undefined, refund('cash'))).status).toBe(200)
    expect(w.sim!.receipts.at(-1)).toMatchObject({ kind: 'storno', payments: [{ mode: 'P', amount: 12 }] })
  })

  it('a back-office sale paid by bank transfer keeps its storno: nothing prints', async () => {
    const w = await tillWorld(app)
    const sale = (await w.backOfficeSale(1, { paymentMethod: 'bank_transfer' })).json.invoice
    const r = await w.call('POST', `/cash-register/documents/${sale.id}/storno`, { reason: 'customer_return' })
    expect(r.status).toBe(200)
    expect(w.sim!.receipts).toHaveLength(0)
  })
})
