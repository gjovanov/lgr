import { describe, it, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import {
  TODAY, clerkSession, draftOf, gate, pay, raw, receiptsOf, send, sessionOf, shown, until,
} from '../helpers/receipt-world'
import { AuditLog, FiscalDevice, Invoice, POSSession } from 'db/models'
import { paymentReceiptDocument, recordPayment, runReceiptSteps } from 'services/biz/cash-register/payment-receipt.service'
import { receiptBody } from 'services/biz/cash-register/receipt-lines'
import { applySessionTotals } from 'services/biz/cash-register/register.service'
import { requestHash } from 'services/biz/hot-path-key'
import { deviceFromCounter, deviceFromDeadReceipt } from 'fiscal/fiscal-route'
import { getPrinter, registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import { WsTremolFiscalPrinter } from 'fiscal/ws-tremol-printer'
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { EltradeSimulator } from '../helpers/eltrade-simulator'
import { createTestFiscalDevice, createTestWarehouse } from '../helpers/factories'
import { TREMOL_CMD } from 'fiscal/tremol'
import { decodeCp1251 } from 'fiscal/cp1251'

/**
 * FR-23: what proves a receipt printed, and what happens when nothing does.
 *
 * In the device's turn the counter is ours, so a print that throws can be judged: `printed`, `failed`,
 * or `unknown` with the money kept. Out of it nothing moved by one proves anything, because the device
 * is shared: a receipt whose request died is given up only when it never reached the device or the
 * device confirms it idle and unmoved. Anything else books nothing and prints nothing: the receipt
 * stays held, and a person settles it.
 *
 * Every one of these was reproduced through the real routes on the simulator before it was fixed.
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

const CLOSE = 0x38
const PAYMENT = 0x35
const VOID = 0x3C
const LINE = 0x31

const onBank = async (w: TillWorld) => {
  const d = await draftOf(w, { method: 'bank_transfer' })
  await send(w, d.id)
  return d
}
const closedOnDevice = (w: TillWorld) => w.sim!.receipts.filter(r => !r.voided)
const settle = (w: TillWorld, id: string, printed: boolean, as?: string) =>
  w.call('POST', `/cash-register/documents/${id}/settle`, { printed }, undefined, as)

/** A receipt its request left at `fiscal`, its lease lapsed: the process died there. */
async function dead(w: TillWorld, d: { id: string; total: number }, fiscal: Record<string, unknown>, o: { key?: string; hash?: string; method?: string; deviceNumber?: string } = {}) {
  const invoice = await raw(d.id)
  const body = receiptBody({ doc: invoice, amount: d.total, whole: false, printsText: true, receipts: [] })!
  const document = paymentReceiptDocument({
    invoice, body, tender: { method: o.method ?? 'cash', amount: d.total, date: new Date() },
    session: { id: w.sessionId, warehouseId: String(w.warehouse._id) },
    user: { id: String(w.user._id), operatorCode: '0001' },
    printer: { deviceNumber: o.deviceNumber ?? 'ED123456' } as any,
  })
  const inserted: any = await Invoice.create({
    ...document, invoiceNumber: `CS-2026-${String(Math.floor(Math.random() * 90000) + 10000)}`, leaseUntil: new Date(Date.now() - 1000),
    ...(o.key ? { clientKey: o.key, requestHash: o.hash } : {}),
    register: { ...document.register, unp: 'ED123456-0001-0000099', fiscal: { state: 'pending', mode: 'fiscal', ...fiscal } },
  })
  await Invoice.updateOne({ _id: d.id }, { $push: { receiptHolds: { receiptId: inserted._id, amount: d.total } } })
  return inserted
}
const reread = (doc: any) => Invoice.findById(doc._id).lean().exec() as Promise<any>

describe('a print that throws, in its turn on the device (ruling 1)', () => {
  it('the paper runs out after the device took the money: unknown, the money kept, and no second receipt ever', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    w.sim!.beforeCommand = cmd => { if (cmd === CLOSE) w.sim!.paper = false }

    const r = await pay(w, d.id, 24, 'cash', 'paid-then-no-paper')

    expect(r.status).toBe(200)
    expect(r.json.receipt.state).toBe('unknown')
    expect(r.json.receiptError).toContain('Check the device')
    const [receipt] = await receiptsOf(d.id)
    expect(receipt.status).toBe('paid')
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect((await sessionOf(w)).totalCash).toBe(24)

    // The paper comes back. The same key finds what it did, and a new attempt finds it paid.
    w.sim!.beforeCommand = null
    w.sim!.paper = true
    expect((await pay(w, d.id, 24, 'cash', 'paid-then-no-paper')).status).toBe(200)
    expect((await pay(w, d.id, 24, 'cash', 'a-new-attempt-key')).status).toBe(400)

    // The next document finishes the one left open: one receipt for one payment.
    await w.sell(1)
    expect(closedOnDevice(w).filter(x => x.total === 24)).toHaveLength(1)
  })

  it('the close went through and the connection dropped before its answer: unknown, the money kept', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    w.sim!.dropAfter = CLOSE

    const r = await pay(w, d.id, 24)

    expect(r.status).toBe(200)
    expect(r.json.receipt.state).toBe('unknown')
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect(w.sim!.receipts).toHaveLength(1)
    expect((await receiptsOf(d.id))[0].status).toBe('paid')
  })

  it('a split tender the driver had to finish in cash: printed stands, and the operator is told the device may differ (finding 13)', async () => {
    const w = await tillWorld(app)
    let legs = 0
    w.sim!.beforeCommand = cmd => {
      if (cmd === PAYMENT && ++legs === 2) w.sim!.paper = false
      if (cmd === VOID) w.sim!.paper = true
    }

    const r = await w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, {
      ...w.saleBody(1), payments: [{ method: 'cash', amount: 5 }, { method: 'card', amount: 7 }],
    })

    expect(r.status).toBe(200)
    expect(r.json.transaction.fiscal.state).toBe('printed')
    expect(r.json.receiptError).toContain('out of paper')
    expect(r.json.receiptError).toMatch(/may differ/)
    const doc: any = await Invoice.findById(r.json.transaction.id).lean().exec()
    expect(doc.register.receiptError).toBe(r.json.receiptError)
    expect(doc.register.fiscalReceiptNumber).toBe(closedOnDevice(w)[0].number)
    expect(closedOnDevice(w)[0].payments.map(p => p.mode)).toEqual(['P', 'P'])
    expect(await sessionOf(w)).toMatchObject({ totalCash: 5, totalCard: 7 })
    expect((await FiscalDevice.findById(w.deviceId).lean().exec() as any).status).not.toBe('error')
  })

  it('a receipt the driver finished after an error says so too, in the answer of the payment', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    w.sim!.beforeCommand = cmd => { if (cmd === CLOSE) w.sim!.loseNextAnswers = 99; else w.sim!.loseNextAnswers = 0 }

    const r = await pay(w, d.id, 24)

    expect(r.status).toBe(200)
    expect(r.json.receipt.state).toBe('printed')
    expect(r.json.receiptError).toMatch(/may differ/)
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
  })

  it('a storno the device finished after an error keeps the error on the answer', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    w.sim!.beforeCommand = cmd => { if (cmd === CLOSE) w.sim!.loseNextAnswers = 99; else w.sim!.loseNextAnswers = 0 }

    const r = await w.storno(sale.json.transaction.id)

    expect(r.status).toBe(200)
    expect(r.json.transaction.fiscal.state).toBe('printed')
    expect(r.json.receiptError).toMatch(/may differ/)
  })

  it('the answer to the close was lost and the device still answers: the counter proves it, in its turn', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const before = w.sim!.lastDocNumber
    w.sim!.beforeCommand = cmd => {
      if (cmd === CLOSE) w.sim!.loseNextAnswers = 99
      else w.sim!.loseNextAnswers = 0
    }

    const r = await pay(w, d.id, 24)

    expect(r.status).toBe(200)
    expect(r.json.receipt.state).toBe('printed')
    expect((await receiptsOf(d.id))[0].register.fiscalReceiptNumber).toBe(String(before + 1).padStart(7, '0'))
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
  })

  it('a payment the device refused, and voided: nothing is on it, so the failure is proved and the money is not kept', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    w.sim!.beforeCommand = cmd => {
      if (cmd === PAYMENT) w.sim!.paper = false
      if (cmd === VOID) w.sim!.paper = true
    }

    const r = await pay(w, d.id, 24)

    expect(r.status).toBe(503)
    expect(r.json.code).toBe('fiscal_error')
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect((await receiptsOf(d.id))[0].status).toBe('voided')
    expect(closedOnDevice(w)).toHaveLength(0)
  })

  it('a line refused before any payment: voided, failed, the invoice as it was', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    w.sim!.beforeCommand = cmd => {
      if (cmd === LINE) w.sim!.paper = false
      if (cmd === VOID) w.sim!.paper = true
    }

    expect((await pay(w, d.id, 24)).status).toBe(503)
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
  })

  it('a till sale is judged the same way: its money stood, and now its label does not lie', async () => {
    const w = await tillWorld(app)
    w.sim!.beforeCommand = cmd => { if (cmd === CLOSE) w.sim!.paper = false }

    const r = await w.sell(1)

    expect(r.status).toBe(200)
    const doc: any = await Invoice.findById(r.json.transaction.id).lean().exec()
    expect(doc.register.fiscal.state).toBe('unknown')
    expect((await sessionOf(w)).totalCash).toBe(12)
  })
})

describe('what a leftover on the device says about this document (finding 1)', () => {
  /** The roll runs out as `cmd` arrives, so that command is refused and the void still goes through. */
  const paperOutAt = (w: TillWorld, at: number) => { w.sim!.beforeCommand = cmd => { if (cmd === at) w.sim!.paper = false } }
  const leftPaidOpen = (w: TillWorld) => {
    w.sim!.receipt = { kind: 'fiscal', header: [], sales: [], texts: [], payments: [{ mode: 'P', amount: 5 }], total: 10, paid: 5 }
  }

  it('a service receipt left open moves the counter as this receipt opens, and a line refused after that books nothing', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    w.sim!.nonFiscalOpen = true
    const left = w.sim!.lastDocNumber + 1
    paperOutAt(w, LINE)

    const r = await pay(w, d.id, 24)

    expect(r.status).toBe(503)
    expect(r.json.code).toBe('fiscal_error')
    const [receipt] = await receiptsOf(d.id)
    expect(receipt.status).toBe('voided')
    expect(receipt.register.fiscal).toMatchObject({ state: 'failed', counterBefore: left })
    expect(receipt.register.fiscalReceiptNumber).toBeUndefined()
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0, receiptHolds: [] })
    expect((await sessionOf(w)).totalCash).toBe(0)
    expect(w.sim!.lastDocNumber).toBe(left)
  })

  it('a paid receipt left open is finished before the counter is read: the next document is not booked under its number', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    leftPaidOpen(w)
    const left = w.sim!.lastDocNumber + 1
    paperOutAt(w, LINE)

    const r = await pay(w, d.id, 24)

    expect(r.status).toBe(503)
    expect((await receiptsOf(d.id))[0].register.fiscal).toMatchObject({ state: 'failed', counterBefore: left })
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect(closedOnDevice(w).map(x => x.number)).toEqual([String(left).padStart(7, '0')])
  })

  it('a device that numbers a voided receipt reads +1 on every failure at a line: still no print', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    w.sim!.numbersVoided = true
    paperOutAt(w, LINE)

    const r = await pay(w, d.id, 24)

    expect(r.status).toBe(503)
    expect((await receiptsOf(d.id))[0].status).toBe('voided')
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect((await sessionOf(w)).totalCash).toBe(0)
  })

  it('a device whose 90h is refused, with a leftover cleared before it: the same', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    w.sim!.nonFiscalOpen = true
    paperOutAt(w, 0x90)

    expect((await pay(w, d.id, 24)).status).toBe(503)
    expect((await receiptsOf(d.id))[0].status).toBe('voided')
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
  })

  it('a storno through the driver, with a leftover and a refused line: it did not print, and nothing is refunded', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    expect(sale.status).toBe(200)
    const cash = (await sessionOf(w)).totalCash
    const stock = await w.stock()
    w.sim!.nonFiscalOpen = true
    paperOutAt(w, LINE)

    const r = await w.storno(sale.json.transaction.id)

    expect(r.status).toBe(503)
    expect(r.json.code).toBe('fiscal_error')
    expect((await sessionOf(w)).totalCash).toBe(cash)
    expect((await w.stock()).quantity).toBe(stock.quantity)
    expect((await Invoice.findById(sale.json.transaction.id).lean().exec() as any).register.stornoState).not.toBe('full')
    const storno: any = await Invoice.findOne({ type: 'cash_storno', orgId: w.oid }).lean().exec()
    expect(storno.status).toBe('voided')
    expect(storno.register.fiscal.state).toBe('failed')
  })

  it('a storno on a device that numbers a voided receipt: a refused line reads +1, and the stage says it did not print', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    const cash = (await sessionOf(w)).totalCash
    w.sim!.numbersVoided = true
    paperOutAt(w, LINE)

    const r = await w.storno(sale.json.transaction.id)

    expect(r.status).toBe(503)
    expect((await sessionOf(w)).totalCash).toBe(cash)
    expect((await Invoice.findOne({ type: 'cash_storno', orgId: w.oid }).lean().exec() as any).status).toBe('voided')
  })

  it('a paid leftover that cannot be cleared says nothing about this document: failed, and nothing abandoned on its behalf', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    w.sim!.receipt = { kind: 'fiscal', header: [], sales: [], texts: [], payments: [{ mode: 'P', amount: 5 }], total: 5, paid: 5 }
    let once = true
    w.sim!.beforeCommand = cmd => {
      if (cmd === VOID && once) {
        once = false
        throw new Error('Bridge disconnected')
      }
    }

    const r = await pay(w, d.id, 24)

    expect(r.status).toBe(503)
    expect(r.json.code).toBe('fiscal_error')
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    // It is still there for the next document to deal with: nobody finished it in this one's name.
    expect(w.sim!.receipt).not.toBeNull()
    expect(closedOnDevice(w)).toHaveLength(0)
  })

  it('a device that cannot be cleared answers as one that cannot open: nothing reached it for this document', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    w.sim!.disconnected = true

    expect((await pay(w, d.id, 24)).status).toBe(503)
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect((await receiptsOf(d.id))[0].register.fiscal.state).toBe('failed')
  })
})

describe('what the driver did to the receipt, which comes before any counter (the second review, finding 2)', () => {
  const refusedAt = (w: TillWorld, cmd: number) => {
    w.sim!.beforeCommand = c => {
      if (c === cmd) w.sim!.paper = false
      if (c === VOID) w.sim!.paper = true
    }
  }

  it('voided past the money, on a device that numbers a voided receipt: failed, whatever the counter reads, and nothing is booked', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    w.sim!.numbersVoided = true
    const counter = w.sim!.lastDocNumber
    refusedAt(w, PAYMENT)

    const r = await pay(w, d.id, 24)

    expect(w.sim!.lastDocNumber).toBe(counter + 1)
    expect(r.status).toBe(503)
    expect(r.json.code).toBe('fiscal_error')
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect((await receiptsOf(d.id))[0].status).toBe('voided')
    expect(closedOnDevice(w)).toHaveLength(0)
    expect((await sessionOf(w)).totalCash).toBe(0)
  })

  it('the same on a storno: the refund stays in the session, and the sale is given back', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    const stock = await w.stock()
    w.sim!.numbersVoided = true
    refusedAt(w, PAYMENT)

    const r = await w.storno(sale.json.transaction.id)

    expect(r.status).toBe(503)
    expect((await sessionOf(w)).totalCash).toBe(12)
    expect((await w.stock()).quantity).toBe(stock.quantity)
    expect((await Invoice.findById(sale.json.transaction.id).lean().exec() as any).register.stornoState).toBe('none')
    expect(closedOnDevice(w).filter(x => x.kind === 'storno')).toHaveLength(0)
  })

  it('finished at a line: 3Ch refused, and the fallback closed a real receipt: unknown, never failed, and no second receipt', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    w.sim!.refuseVoids = 1
    w.sim!.beforeCommand = c => { if (c === LINE) w.sim!.paper = false; else if (c === VOID) w.sim!.paper = true }

    const r = await pay(w, d.id, 24)

    expect(r.status).toBe(200)
    expect(r.json.receipt.state).toBe('unknown')
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    w.sim!.beforeCommand = null
    expect((await pay(w, d.id, 24, 'cash', 'a-new-attempt-key')).status).toBe(400)
    expect(closedOnDevice(w)).toHaveLength(1)
  })

  it('the same on a storno: held, nothing refunded, and a second press prints nothing', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    w.sim!.refuseVoids = 1
    w.sim!.beforeCommand = c => { if (c === LINE) w.sim!.paper = false; else if (c === VOID) w.sim!.paper = true }

    const r = await w.storno(sale.json.transaction.id)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('storno_in_doubt')
    expect((await sessionOf(w)).totalCash).toBe(12)
    w.sim!.beforeCommand = null
    expect((await w.storno(sale.json.transaction.id)).json.code).toBe('storno_in_doubt')
    expect(closedOnDevice(w).filter(x => x.kind === 'storno')).toHaveLength(1)
  })

  // ⚠ The reason it may only say voided if it SAW a receipt open. Read off the cancel alone, each of
  // these is a real receipt booked as failed, and printed again.
  describe('after a close whose answer was lost nothing is open: it says neither, and the counter decides', () => {
    it('at the close: printed, booked once, and printed once', async () => {
      const w = await tillWorld(app)
      const d = await onBank(w)
      const before = w.sim!.lastDocNumber
      w.sim!.beforeCommand = c => {
        if (c === CLOSE) w.sim!.loseNextAnswers = 99
        else w.sim!.loseNextAnswers = 0
      }

      const r = await pay(w, d.id, 24)

      expect(r.status).toBe(200)
      expect(r.json.receipt.state).toBe('printed')
      expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
      expect((await receiptsOf(d.id))[0].register.fiscalReceiptNumber).toBe(String(before + 1).padStart(7, '0'))
      w.sim!.beforeCommand = null
      expect((await pay(w, d.id, 24, 'cash', 'a-new-attempt-key')).status).toBe(400)
      expect(closedOnDevice(w)).toHaveLength(1)
      expect(w.sim!.receipts.filter(x => x.voided)).toHaveLength(0)
    })

    it('past the money: the receipt closed while the driver stood at its payment, and the same', async () => {
      const w = await tillWorld(app)
      const d = await onBank(w)
      const printer: any = getPrinter(w.deviceId)
      const real = printer.printPayment
      printer.printPayment = async (type: any, amount: number) => {
        await real.call(printer, type, amount)
        await printer.closeFiscalReceipt()
        throw new Error('Serial read timeout — the device stopped answering mid-response')
      }

      const r = await pay(w, d.id, 24)
      delete printer.printPayment

      expect(r.status).toBe(200)
      expect(r.json.receipt.state).toBe('printed')
      expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
      expect((await pay(w, d.id, 24, 'cash', 'a-new-attempt-key')).status).toBe(400)
      expect(closedOnDevice(w)).toHaveLength(1)
    })

    it('on a storno at the close: the refund is booked, once, and no second storno ever prints', async () => {
      const w = await tillWorld(app)
      const sale = await w.sell(1)
      w.sim!.beforeCommand = c => {
        if (c === CLOSE) w.sim!.loseNextAnswers = 99
        else w.sim!.loseNextAnswers = 0
      }

      const r = await w.storno(sale.json.transaction.id)

      expect(r.status).toBe(200)
      expect(r.json.transaction.fiscal.state).toBe('printed')
      expect((await sessionOf(w)).totalCash).toBe(0)
      w.sim!.beforeCommand = null
      expect((await w.storno(sale.json.transaction.id)).status).toBe(400)
      expect(closedOnDevice(w).filter(x => x.kind === 'storno')).toHaveLength(1)
    })
  })
})

describe('a counter read in another turn proves nothing, for any document (finding 6)', () => {
  /** A till document its request left at `attemptedAt`, with the counter as it read then. */
  const interrupted = (id: string, counterBefore: number, key: string, hash: string) => Invoice.updateOne({ _id: id }, {
    $set: {
      'register.fiscal': { state: 'pending', mode: 'fiscal', attemptedAt: new Date(), counterBefore },
      leaseUntil: new Date(Date.now() - 1000), clientKey: key, requestHash: hash,
    },
    $unset: { completedAt: 1 },
  })

  it('a sale that died before it printed is not booked under the next document\'s number', async () => {
    const w = await tillWorld(app)
    const key = 'died-sale-0001'
    const body = w.saleBody(1)
    const sale = await w.sell(1)
    const counter = w.sim!.lastDocNumber
    await Invoice.updateOne({ _id: sale.json.transaction.id }, { $unset: { 'register.fiscalReceiptNumber': 1, 'register.printedAt': 1 } })
    await interrupted(sale.json.transaction.id, counter, key, requestHash(`pos.sale:${w.sessionId}`, body))
    // Somebody else's document on the same device, between the turn that read and the retry.
    const d = await onBank(w)
    expect((await pay(w, d.id, 24)).status).toBe(200)
    const others = closedOnDevice(w).at(-1)!.number

    const r = await w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, body, key)

    expect(r.status).toBe(200)
    expect(r.json.transaction.fiscal.state).toBe('unknown')
    expect(r.json.receiptError).toMatch(/cannot confirm/)
    expect(r.json.transaction.fiscalReceiptNumber).not.toBe(others)
    expect(closedOnDevice(w)).toHaveLength(2)
  })

  it('a storno that died before it printed refunds nothing on the next document\'s number', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    const key = 'died-storno-0001'
    const storno = await w.storno(sale.json.transaction.id, key)
    expect(storno.status).toBe(200)
    const stornoId = storno.json.transaction.id
    const cash = (await sessionOf(w)).totalCash
    await Invoice.updateOne({ _id: stornoId }, {
      $unset: { 'register.fiscalReceiptNumber': 1, 'register.printedAt': 1, 'register.sessionTotalsApplied': 1, 'register.movementId': 1 },
    })
    await Invoice.updateOne({ _id: stornoId }, {
      $set: { 'register.fiscal': { state: 'pending', mode: 'fiscal', attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber }, leaseUntil: new Date(Date.now() - 1000) },
      $unset: { completedAt: 1 },
    })
    const d = await onBank(w)
    expect((await pay(w, d.id, 24)).status).toBe(200)

    const r = await w.storno(sale.json.transaction.id, key)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('storno_in_doubt')
    const doc: any = await Invoice.findById(stornoId).lean().exec()
    expect(doc.status).toBe('paid')
    expect(doc.register.fiscal).toMatchObject({ state: 'unknown', inDoubt: true })
    expect(doc.register.fiscalReceiptNumber).toBeUndefined()
    expect((await sessionOf(w)).totalCash).toBe(cash + 24)
  })

  it('and a receipt is held for a person, not booked', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const key = 'died-receipt-0001'
    const hash = requestHash(`invoice.payment:${d.id}`, { date: TODAY(), amount: 24, method: 'cash' })
    await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber - 1 }, { key, hash })

    const r = await w.call('POST', `/invoices/${d.id}/payments`, { date: TODAY(), amount: 24, method: 'cash' }, key)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('receipt_in_doubt')
    expect(await raw(d.id)).toMatchObject({ amountPaid: 0 })
  })
})

describe('a driver with no cancel (ruling 1)', () => {
  /** A real `WsTremolFiscalPrinter` on a device that answers ACK, as the bridge carries it. */
  function tremolOn(w: TillWorld, fail: (cmd: number) => boolean = () => false) {
    const sent: { cmd: number; text: string }[] = []
    unregisterPrinter(w.deviceId)
    registerPrinter(w.deviceId, new WsTremolFiscalPrinter(async (frame: Buffer | Uint8Array) => {
      const f = Buffer.from(frame)
      const cmd = f[3]
      sent.push({ cmd, text: decodeCp1251(f.subarray(4, f.length - 3)) })
      if (fail(cmd)) throw new Error('Tremol NAK: command rejected')
      return Buffer.from([0x06])
    }, w.deviceId) as any)
    return sent
  }
  const onTremol = async (fail?: (cmd: number) => boolean) => {
    const w = await tillWorld(app, { manufacturer: 'tremol' })
    await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { manufacturer: 'tremol' } })
    return { w, sent: tremolOn(w, fail) }
  }

  it('a failure at the payment closes the receipt in the fallback: real, so unknown, and the money kept', async () => {
    const { w } = await onTremol(cmd => cmd === TREMOL_CMD.PAYMENT)
    const d = await onBank(w)

    const r = await pay(w, d.id, 24)

    expect(r.status).toBe(200)
    expect(r.json.receipt.state).toBe('unknown')
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect((await receiptsOf(d.id))[0].status).toBe('paid')
  })

  it('a failure at the payment, and the close refused too: it may have the money, so unknown, never failed', async () => {
    const { w } = await onTremol(cmd => cmd === TREMOL_CMD.PAYMENT || cmd === TREMOL_CMD.CLOSE_RECEIPT)
    const d = await onBank(w)

    const r = await pay(w, d.id, 24)

    expect(r.status).toBe(200)
    expect(r.json.receipt.state).toBe('unknown')
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
  })

  it('a failure at a line, and the close refused too: nothing took money, so it failed', async () => {
    const { w } = await onTremol(cmd => cmd === TREMOL_CMD.SELL_ARTICLE || cmd === TREMOL_CMD.CLOSE_RECEIPT)
    const d = await onBank(w)

    expect((await pay(w, d.id, 24)).status).toBe(503)
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
  })

  it('a failure at a line, and the fallback close went through: a receipt closed, so it is not failed', async () => {
    const { w } = await onTremol(cmd => cmd === TREMOL_CMD.SELL_ARTICLE)
    const d = await onBank(w)

    const r = await pay(w, d.id, 24)

    expect(r.status).toBe(200)
    expect(r.json.receipt.state).toBe('unknown')
    expect((await receiptsOf(d.id))[0].status).toBe('paid')
  })

  it('prints the number where a Tremol keeps it, and stores no "unknown" for a receipt number (finding 12)', async () => {
    const { w, sent } = await onTremol()
    const d = await onBank(w)
    await Invoice.updateOne({ _id: d.id }, { $set: { invoiceNumber: 'INV-2026-00123' } })

    expect((await pay(w, d.id, 10)).status).toBe(200)

    const lines = sent.filter(s => s.cmd === TREMOL_CMD.SELL_ARTICLE)
    expect(lines).toHaveLength(1)
    // Cut at 34 by the driver: the whole number has to fit before that.
    expect(lines[0].text.split(';')[0]).toContain('INV-2026-00123')
    const [receipt] = await receiptsOf(d.id)
    expect(receipt.register.fiscal.state).toBe('printed')
    expect(receipt.register.fiscalReceiptNumber).toBeUndefined()
    expect(receipt.register.fiscal.receiptNo).toBeUndefined()
    expect((await shown(w, d.id)).paymentReceipts[0].receiptNumber).toBeUndefined()
  })

  it('a debit note\'s number fits too, and a storno of a sale with no receipt number is still fiscal', async () => {
    const { w, sent } = await onTremol()
    const { id } = await (async () => {
      const inv = await draftOf(w)
      await send(w, inv.id)
      return inv
    })()
    const note = await draftOf(w, { type: 'debit_note', method: 'bank_transfer', extra: { relatedInvoiceId: id, contactId: String((await raw(id)).contactId) } })
    await send(w, note.id)
    await Invoice.updateOne({ _id: note.id }, { $set: { invoiceNumber: 'INV-2026-00124' } })

    expect((await pay(w, note.id, 5)).status).toBe(200)

    expect(sent.filter(s => s.cmd === TREMOL_CMD.SELL_ARTICLE).at(-1)!.text.split(';')[0]).toContain('INV-2026-00124')
    expect((await w.sell(1)).status).toBe(200)
    const sale: any = await Invoice.findOne({ type: 'cash_sale', orgId: w.oid }).lean().exec()
    const { printedFiscally } = await import('services/biz/cash-register/register.service')
    expect(printedFiscally(sale)).toBe(true)
  })
})

describe('a receipt is dated as it prints', () => {
    const yesterday = () => new Date(Date.now() - 36 * 3_600_000)
    const days = (at: unknown) => new Date(at as string).toISOString().slice(0, 10)
    const agoWritten = () => {
      const at = yesterday()
      return { $set: { issueDate: at, dueDate: at, paidAt: at, 'payments.0.date': at } }
    }

    it('a payment that waited for the device past midnight says the day it printed, on the row too', async () => {
      const w = await tillWorld(app)
      const d = await onBank(w)
      const held = gate()
      w.sim!.beforeCommand = cmd => (cmd === CLOSE ? held.closed : undefined)
      const sale = w.sell(1)
      await until(() => w.sim!.executed.some(c => c.cmd === PAYMENT), 'the sale to hold the device')

      const paying = pay(w, d.id, 24)
      await until(async () => (await receiptsOf(d.id)).length === 1, 'the receipt to wait its turn')
      await Invoice.updateOne({ type: 'payment_receipt' }, agoWritten())
      w.sim!.beforeCommand = null
      held.open()
      await sale

      expect((await paying).status).toBe(200)
      const [receipt] = await receiptsOf(d.id)
      expect(days(receipt.issueDate)).toBe(TODAY())
      expect(days(receipt.payments[0].date)).toBe(TODAY())
      expect(days((await raw(d.id)).payments[0].date)).toBe(TODAY())
    })

    it('a keyed retry the next morning prints under that morning', async () => {
      const w = await tillWorld(app)
      const d = await onBank(w)
      const key = 'next-morning-0001'
      const hash = requestHash(`invoice.payment:${d.id}`, { date: TODAY(), amount: 24, method: 'cash' })
      const r = await dead(w, d, {}, { key, hash })
      await Invoice.updateOne({ _id: r._id }, agoWritten())

      expect((await pay(w, d.id, 24, 'cash', key)).status).toBe(200)

      const after = await reread(r)
      expect(after.register.fiscal.state).toBe('printed')
      expect(days(after.issueDate)).toBe(TODAY())
      expect(days((await raw(d.id)).payments[0].date)).toBe(TODAY())
    })

    it('one that cannot print keeps the date it had: nothing printed to date it', async () => {
      const w = await tillWorld(app)
      const d = await onBank(w)
      const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber - 1 })
      const before = yesterday()
      await Invoice.updateOne({ _id: r._id }, { $set: { issueDate: before } })

      await pay(w, d.id, 24, 'bank_transfer')

      expect(new Date((await reread(r)).issueDate).getTime()).toBe(before.getTime())
    })
  })

  describe('a driver that refuses before anything is sent (finding C)', () => {
    /** A real `WsTremolFiscalPrinter` on a device that answers ACK: a sale it closes has no number. */
    function tremolOn(w: TillWorld) {
      const sent: number[] = []
      unregisterPrinter(w.deviceId)
      registerPrinter(w.deviceId, new WsTremolFiscalPrinter(async (frame: Buffer | Uint8Array) => {
        sent.push(Buffer.from(frame)[3])
        return Buffer.from([0x06])
      }, w.deviceId) as any)
      return sent
    }

    it('a storno of a sale with no number to cite: failed, nothing maybe printed, and a healthy device stays healthy', async () => {
      const w = await tillWorld(app, { manufacturer: 'tremol' })
      await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { manufacturer: 'tremol' } })
      const sent = tremolOn(w)
      const sale = await w.sell(1)
      expect(sale.status).toBe(200)
      expect(sale.json.transaction.fiscalReceiptNumber).toBeUndefined()
      sent.length = 0

      const r = await w.storno(sale.json.transaction.id)

      expect(r.status).toBe(503)
      expect(r.json.code).toBe('fiscal_error')
      expect(r.json.message).toContain('no fiscal receipt number')
      expect(r.json.message).not.toContain('may have printed')
      const storno: any = await Invoice.findOne({ type: 'cash_storno', orgId: w.oid }).lean().exec()
      expect(storno.register.fiscal.state).toBe('failed')
      expect(storno.status).toBe('voided')
      expect(sent.filter(cmd => cmd === TREMOL_CMD.OPEN_FISCAL_RECEIPT || cmd === TREMOL_CMD.CLOSE_RECEIPT)).toHaveLength(0)
      expect((await FiscalDevice.findById(w.deviceId).lean().exec() as any).status).not.toBe('error')
      expect((await Invoice.findById(sale.json.transaction.id).lean().exec() as any).register.stornoState).not.toBe('full')
    })

    it('an Eltrade reads the same', async () => {
      const w = await tillWorld(app)
      const sale = await w.sell(1)
      await Invoice.updateOne({ _id: sale.json.transaction.id }, { $unset: { 'register.fiscalReceiptNumber': 1, 'register.fiscal.receiptNo': 1 } })
      const before = w.sim!.frames

      const r = await w.storno(sale.json.transaction.id)

      expect(r.status).toBe(503)
      expect(r.json.message).toContain('no fiscal receipt number')
      expect((await FiscalDevice.findById(w.deviceId).lean().exec() as any).status).not.toBe('error')
      expect(w.sim!.executed.filter(c => c.cmd === 0x90)).toHaveLength(1)
      expect(w.sim!.frames).toBeGreaterThanOrEqual(before)
    })
  })

describe('the lease of a receipt that is printing (ruling 5)', () => {
  it('a payment that finds its lease lapsed mid-print waits for the device, and never gives a live print up', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const held = gate()
    w.sim!.beforeCommand = cmd => (cmd === CLOSE ? held.closed : undefined)

    const paying = pay(w, d.id, 24)
    await until(async () => (await receiptsOf(d.id)).length === 1 && w.sim!.executed.some(c => c.cmd === PAYMENT), 'the print to reach its payment')
    await Invoice.updateOne({ type: 'payment_receipt' }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })

    const bank = pay(w, d.id, 24, 'bank_transfer')
    await new Promise(r => setTimeout(r, 100))
    held.open()

    expect((await paying).status).toBe(200)
    expect((await bank).status).toBe(400)
    const inv = await raw(d.id)
    expect(inv).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect(inv.payments.map((p: any) => p.method)).toEqual(['cash'])
    expect((await receiptsOf(d.id))[0].status).toBe('paid')
  })

  it('renews while it waits and prints', async () => {
    const { keepLease } = await import('services/biz/hot-path-key')
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, {})
    const stop = keepLease(Invoice, r._id, 10)
    await until(async () => new Date((await reread(r)).leaseUntil).getTime() > Date.now(), 'the lease to be renewed')
    stop()
  })

  it('a print that runs on keeps its lease, so nobody reads it as a request that died', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const held = gate()
    w.sim!.beforeCommand = cmd => (cmd === CLOSE ? held.closed : undefined)
    // The renewal's clock, in the test's time.
    const real = globalThis.setInterval
    globalThis.setInterval = ((run: () => void, ms?: number) => real(run, Math.min(ms ?? 0, 15))) as typeof setInterval
    try {
      const paying = pay(w, d.id, 24)
      await until(() => w.sim!.executed.some(c => c.cmd === PAYMENT), 'the print to reach its payment')
      await Invoice.updateOne({ type: 'payment_receipt' }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })

      await until(async () => new Date((await receiptsOf(d.id))[0].leaseUntil).getTime() > Date.now(), 'the lease to be renewed')

      held.open()
      expect((await paying).status).toBe(200)
    } finally {
      globalThis.setInterval = real
      held.open()
    }
  })

  it('a voided receipt takes no write and books no money, whoever comes back to it', async () => {
    const { setRegister } = await import('services/biz/cash-register/register.service')
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, {})
    await Invoice.updateOne({ _id: r._id }, { $set: { status: 'voided' } })

    await setRegister(r._id, { 'fiscal.state': 'printed' })
    await recordPayment({ orgId: w.orgId, user: { id: String(w.user._id) } } as any, await reread(r))

    expect((await reread(r)).register.fiscal.state).toBe('pending')
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect((await raw(d.id)).payments).toHaveLength(0)
  })
})

describe('a receipt whose request died (ruling 6)', () => {
  it('a sale moved the counter by one since: that proves nothing, so nothing is booked and nothing prints', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
    await w.sell(1)
    const printed = w.sim!.receipts.length

    const next = await pay(w, d.id, 24, 'bank_transfer')

    expect(next.status).toBe(409)
    expect(next.json.code).toBe('receipt_in_doubt')
    expect(next.json.receipt.number).toBe(r.invoiceNumber)
    const inv = await raw(d.id)
    expect(inv).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect(inv.payments).toHaveLength(0)
    expect(inv.receiptHolds).toHaveLength(1)
    const after = await reread(r)
    expect(after.register.fiscal).toMatchObject({ state: 'unknown', inDoubt: true })
    expect(after.register.fiscalReceiptNumber).toBeUndefined()
    expect((await sessionOf(w)).totalCash).toBe(12)
    expect(w.sim!.receipts).toHaveLength(printed)
  })

  it('two documents since: the same', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
    await w.sell(1)
    await w.sell(1)

    expect((await pay(w, d.id, 24, 'bank_transfer')).json.code).toBe('receipt_in_doubt')
    expect((await reread(r)).register.fiscal.inDoubt).toBe(true)
    expect((await raw(d.id)).amountPaid).toBe(0)
  })

  it('no device connected: it cannot be proved, so the same', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
    forgetDevices()

    expect((await pay(w, d.id, 24, 'bank_transfer')).json.code).toBe('receipt_in_doubt')
    expect((await reread(r)).register.fiscal.inDoubt).toBe(true)
    expect((await raw(d.id)).amountPaid).toBe(0)
  })

  it('a device that does not answer the read: never printed, however much the next read says it did not', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
    let reads = 0
    w.sim!.beforeCommand = cmd => {
      if (cmd === 0x71 && ++reads === 1) w.sim!.disconnected = true
    }

    await pay(w, d.id, 24, 'bank_transfer')

    w.sim!.disconnected = false
    expect(w.sim!.executed.some(c => c.cmd === 0x90)).toBe(false)
    expect((await reread(r)).register.fiscal.inDoubt).toBe(true)
  })

  it('the counter unmoved, but a receipt is open on the device: not idle, so it is not given up', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
    await getPrinter(w.deviceId).openFiscalReceipt('0001', 'Иван Петров', 'ED123456-0001-0000098')

    expect((await pay(w, d.id, 24, 'bank_transfer')).json.code).toBe('receipt_in_doubt')
    expect((await reread(r)).status).toBe('paid')
    expect((await reread(r)).register.fiscal.inDoubt).toBe(true)
  })

  it('the counter unmoved and nothing open: proved, given up, and the payment goes through', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })

    const next = await pay(w, d.id, 24, 'bank_transfer')

    expect(next.status).toBe(200)
    expect((await reread(r)).status).toBe('voided')
    expect((await raw(d.id)).receiptHolds).toHaveLength(0)
    expect(w.sim!.receipts).toHaveLength(0)
  })

  it('it never reached the device: given up without asking it', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, {})
    forgetDevices()

    expect((await pay(w, d.id, 24, 'bank_transfer')).status).toBe(200)
    expect((await reread(r)).status).toBe('voided')
  })

  it('a keyed retry of the same request does not book on a counter either', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const key = 'dead-keyed-retry-1'
    const hash = requestHash(`invoice.payment:${d.id}`, { date: new Date().toISOString().slice(0, 10), amount: 24, method: 'cash' })
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber }, { key, hash })
    await w.sell(1)

    const retry = await pay(w, d.id, 24, 'cash', key)

    expect(retry.status).toBe(409)
    expect(retry.json.code).toBe('receipt_in_doubt')
    expect((await raw(d.id)).amountPaid).toBe(0)
    expect((await reread(r)).register.fiscal.inDoubt).toBe(true)
  })

  it('a keyed retry the device does not answer: held, and nothing printed', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const key = 'dead-keyed-retry-3'
    const hash = requestHash(`invoice.payment:${d.id}`, { date: new Date().toISOString().slice(0, 10), amount: 24, method: 'cash' })
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber }, { key, hash })
    w.sim!.beforeCommand = (cmd) => { if (cmd === 0x71) throw new Error('no answer') }

    const retry = await pay(w, d.id, 24, 'cash', key)

    expect(retry.json.code).toBe('receipt_in_doubt')
    expect(closedOnDevice(w)).toHaveLength(0)
    expect((await reread(r)).register.fiscal.inDoubt).toBe(true)
  })

  it('a keyed retry with a receipt open on the device: held, and what is open is left alone', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const key = 'dead-keyed-retry-4'
    const hash = requestHash(`invoice.payment:${d.id}`, { date: new Date().toISOString().slice(0, 10), amount: 24, method: 'cash' })
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber }, { key, hash })
    await getPrinter(w.deviceId).openFiscalReceipt('0001', 'Иван Петров', 'ED123456-0001-0000098')

    const retry = await pay(w, d.id, 24, 'cash', key)

    expect(retry.json.code).toBe('receipt_in_doubt')
    expect(w.sim!.executed.filter(c => c.cmd === 0x90)).toHaveLength(1)
    expect(w.sim!.executed.some(c => c.cmd === VOID)).toBe(false)
    expect((await reread(r)).register.fiscal.inDoubt).toBe(true)
  })

  it('a second retry of one held: refused again, and still nothing booked', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const key = 'dead-keyed-retry-5'
    const hash = requestHash(`invoice.payment:${d.id}`, { date: new Date().toISOString().slice(0, 10), amount: 24, method: 'cash' })
    await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber - 1 }, { key, hash })

    expect((await pay(w, d.id, 24, 'cash', key)).json.code).toBe('receipt_in_doubt')
    expect((await pay(w, d.id, 24, 'cash', key)).json.code).toBe('receipt_in_doubt')

    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect((await sessionOf(w)).totalCash).toBe(0)
  })

  it('what finishes a dead request never prints, whatever it finds', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, {})
    let printed = 0
    const printer = { deviceNumber: 'ED123456', operation: (run: any) => run(), printSale: async () => { printed++; return '1' } }

    await runReceiptSteps({ orgId: w.orgId, user: { id: String(w.user._id) }, printer } as any, String(r._id), { neverPrint: true })

    expect(printed).toBe(0)
    expect((await reread(r)).register.fiscal.state).toBe('pending')
  })

  it('a keyed retry may print when the device proves it never did: the same customer, at the same counter', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const key = 'dead-keyed-retry-2'
    const hash = requestHash(`invoice.payment:${d.id}`, { date: new Date().toISOString().slice(0, 10), amount: 24, method: 'cash' })
    await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber }, { key, hash })

    expect((await pay(w, d.id, 24, 'cash', key)).status).toBe(200)
    expect(closedOnDevice(w)).toHaveLength(1)
    expect((await raw(d.id)).amountPaid).toBe(24)
  })

  it('a keyed retry on another device than it started on prints nothing (finding: receiptContext)', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const key = 'dead-keyed-retry-3'
    const hash = requestHash(`invoice.payment:${d.id}`, { date: new Date().toISOString().slice(0, 10), amount: 24, method: 'cash' })
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber }, { key, hash, deviceNumber: 'ED654321' })

    const retry = await pay(w, d.id, 24, 'cash', key)

    expect(retry.json.code).toBe('receipt_in_doubt')
    expect(w.sim!.receipts).toHaveLength(0)
    expect((await reread(r)).register.fiscal.inDoubt).toBe(true)
  })

  it('a dead receipt on an errored, unconnected device does not lock the invoice: it is held, and a person settles it', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
    forgetDevices()
    await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { status: 'error' } })

    expect((await pay(w, d.id, 24, 'bank_transfer')).json.code).toBe('receipt_in_doubt')
    expect((await w.call('POST', `/invoices/${d.id}/void`)).json.code).toBe('receipt_in_doubt')
    expect((await w.call('PUT', `/invoices/${d.id}`, { total: 36 })).json.code).toBe('receipt_in_doubt')

    expect((await settle(w, String(r._id), false)).status).toBe(200)
    expect((await pay(w, d.id, 24, 'bank_transfer')).status).toBe(200)
  })
})

describe('a person settles a receipt in doubt (ruling 6)', () => {
  async function inDoubt(w: TillWorld) {
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
    await w.sell(1)
    await pay(w, d.id, 24, 'bank_transfer')
    return { d, r }
  }

  it('it printed: the money is booked on the session, the payment recorded, and it says who said so', async () => {
    const w = await tillWorld(app)
    const { d, r } = await inDoubt(w)

    const answer = await settle(w, String(r._id), true)

    expect(answer.status).toBe(200)
    const after = await reread(r)
    expect(after.register.fiscal.state).toBe('printed')
    expect(after.register.fiscal.inDoubt).toBeFalsy()
    expect(after.register.settled).toMatchObject({ printed: true, by: w.user._id })
    expect(after.completedAt).toBeTruthy()
    const inv = await raw(d.id)
    expect(inv).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect(inv.receiptHolds).toHaveLength(0)
    expect((await sessionOf(w)).totalCash).toBe(36)
    const audit: any = await AuditLog.findOne({ orgId: w.oid, action: 'settle_receipt' }).lean().exec()
    expect(audit).toBeTruthy()
    expect(String(audit.entityId)).toBe(String(r._id))
    expect(JSON.stringify(audit.changes)).toContain('printed')
  })

  it('it did not: voided with its number, nothing booked, the hold gone, and that too is on the record', async () => {
    const w = await tillWorld(app)
    const { d, r } = await inDoubt(w)

    expect((await settle(w, String(r._id), false)).status).toBe(200)

    const after = await reread(r)
    expect(after.status).toBe('voided')
    expect(after.register.settled).toMatchObject({ printed: false })
    expect(await raw(d.id)).toMatchObject({ status: 'sent', amountPaid: 0 })
    expect((await raw(d.id)).receiptHolds).toHaveLength(0)
    expect((await sessionOf(w)).totalCash).toBe(12)
    expect(await AuditLog.countDocuments({ orgId: w.oid, action: 'settle_receipt' })).toBe(1)
  })

  it('only a manager or an admin: someone who may write invoices is not enough', async () => {
    const w = await tillWorld(app)
    const { r } = await inDoubt(w)

    for (const role of ['member', 'accountant']) {
      const refused = await settle(w, String(r._id), true, await w.tokenAs(role))

      expect(refused.status).toBe(403)
      expect((await reread(r)).register.fiscal.inDoubt).toBe(true)
    }
    const accountant = await settle(w, String(r._id), true, await w.tokenAs('accountant'))
    expect(accountant.json.message).toContain('manager or admin')
  })

  it('settles once, and only what is in doubt', async () => {
    const w = await tillWorld(app)
    const { r } = await inDoubt(w)
    expect((await settle(w, String(r._id), true)).status).toBe(200)
    const again = await settle(w, String(r._id), false)
    expect(again.status).toBe(409)
    expect(again.json.code).toBe('receipt_not_in_doubt')
    expect((await reread(r)).status).toBe('paid')
  })

  it('a receipt that is not in doubt is not settled, however dead it looks', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })

    const refused = await settle(w, String(r._id), true)

    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('receipt_not_in_doubt')
    expect((await reread(r)).register.fiscal.state).toBe('pending')
    expect(await raw(d.id)).toMatchObject({ amountPaid: 0 })
  })

  it('a document that is not there, or of another kind, is a 404', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    const d = await onBank(w)
    expect((await settle(w, '64b000000000000000000000', true)).status).toBe(404)
    expect((await settle(w, d.id, true)).status).toBe(404)
    // A sale it takes, once nothing can prove its receipt: this one printed.
    expect((await settle(w, sale.json.transaction.id, true)).json.code).toBe('receipt_not_in_doubt')
  })

  it('the document says it is in doubt, and the session\'s figures leave it out until it is settled', async () => {
    const w = await tillWorld(app)
    const { d, r } = await inDoubt(w)

    expect((await shown(w, d.id)).receiptInDoubt).toMatchObject({ id: String(r._id), number: r.invoiceNumber })
    // It paid nothing yet, so neither the form nor the PDF says it did.
    expect((await shown(w, d.id)).paymentReceipts ?? []).toHaveLength(0)
    const preview = (await w.call('GET', `/trade/pos/session/${w.sessionId}/close-preview`)).json
    expect(preview.report.counts.payments ?? 0).toBe(0)
    expect(preview.unfinishedReceipts.map((u: any) => u.number)).toEqual([r.invoiceNumber])
  })
})

describe('a settle that stops halfway (finding 3)', () => {
  async function inDoubt(w: TillWorld) {
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
    await w.sell(1)
    await pay(w, d.id, 24, 'bank_transfer')
    return { d, r }
  }
  /** The person said it; then the process dies before the money is booked. */
  async function stopped(w: TillWorld, id: string, printed: boolean) {
    const dies = spyOn(Invoice, 'startSession').mockImplementationOnce(() => { throw new Error('the pod went away') })
    // Failing it, a settle that says "not printed" has to stop somewhere of its own.
    const release = printed ? null : spyOn(Invoice, 'updateOne').mockImplementationOnce(() => { throw new Error('the pod went away') })
    const answer = await settle(w, id, printed)
    dies.mockRestore()
    release?.mockRestore()
    return answer
  }
  /** The person said it, and the process dies before even its audit row. */
  async function stoppedBeforeTheTrail(w: TillWorld, id: string, printed: boolean) {
    const dies = spyOn(AuditLog, 'create').mockImplementationOnce((() => { throw new Error('the pod went away') }) as any)
    const stops = spyOn(Invoice, 'startSession').mockImplementationOnce(() => { throw new Error('the pod went away') })
    const answer = await settle(w, id, printed)
    dies.mockRestore()
    stops.mockRestore()
    expect(await AuditLog.countDocuments({ orgId: w.oid, action: 'settle_receipt' })).toBe(0)
    return answer
  }

  it('a crash before its audit row: a second settle finishes it and writes the row, naming who said it, once', async () => {
    const w = await tillWorld(app)
    const { r } = await inDoubt(w)
    await stoppedBeforeTheTrail(w, String(r._id), true)
    await Invoice.updateOne({ _id: r._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })

    expect((await settle(w, String(r._id), true)).status).toBe(200)

    const audits: any[] = await AuditLog.find({ orgId: w.oid, action: 'settle_receipt' }).lean().exec()
    expect(audits).toHaveLength(1)
    expect(String(audits[0].entityId)).toBe(String(r._id))
    expect(String(audits[0].userId)).toBe(String(w.user._id))
  })

  it('the same when the next touch finishes it, and the row names who said it, not who came next', async () => {
    const w = await tillWorld(app)
    const { d, r } = await inDoubt(w)
    await stoppedBeforeTheTrail(w, String(r._id), true)
    await Invoice.updateOne({ _id: r._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })

    await pay(w, d.id, 24, 'bank_transfer', undefined, w.clerkToken)

    expect((await reread(r)).completedAt).toBeTruthy()
    const audits: any[] = await AuditLog.find({ orgId: w.oid, action: 'settle_receipt' }).lean().exec()
    expect(audits).toHaveLength(1)
    expect(String(audits[0].userId)).toBe(String(w.user._id))
  })

  it('one whose row was written before it stopped gets no second', async () => {
    const w = await tillWorld(app)
    const { d, r } = await inDoubt(w)
    await stopped(w, String(r._id), true)
    expect(await AuditLog.countDocuments({ orgId: w.oid, action: 'settle_receipt' })).toBe(1)
    await lapse(r)

    await pay(w, d.id, 24, 'bank_transfer')

    expect(await AuditLog.countDocuments({ orgId: w.oid, action: 'settle_receipt' })).toBe(1)
  })

  /** Only a lease the settle left: one it took away must not come back here. */
  const lapse = (r: any) => Invoice.updateOne({ _id: r._id, leaseUntil: { $exists: true } }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })

  it('the verdict is on the document before the money, and the receipt can still be found', async () => {
    const w = await tillWorld(app)
    const { d, r } = await inDoubt(w)

    expect((await stopped(w, String(r._id), true)).status).toBe(500)

    const after = await reread(r)
    expect(after.register.settled).toMatchObject({ printed: true, by: w.user._id })
    expect(after.register.fiscal.state).toBe('printed')
    expect(after.completedAt).toBeUndefined()
    expect(after.leaseUntil).toBeTruthy()
    expect(await raw(d.id)).toMatchObject({ amountPaid: 0 })
  })

  it('printed: the next touch books it, with no device, and the document takes no second payment', async () => {
    const w = await tillWorld(app)
    const { d, r } = await inDoubt(w)
    await stopped(w, String(r._id), true)
    await lapse(r)
    forgetDevices()

    const next = await pay(w, d.id, 24, 'bank_transfer')

    expect(next.status).toBe(400)
    expect((await reread(r)).completedAt).toBeTruthy()
    const inv = await raw(d.id)
    expect(inv).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect(inv.receiptHolds).toHaveLength(0)
    expect(inv.payments.map((p: any) => String(p.receiptId))).toEqual([String(r._id)])
    expect((await sessionOf(w)).totalCash).toBe(36)
  })

  it('not printed: the next touch gives it up, and its money is free again', async () => {
    const w = await tillWorld(app)
    const { d, r } = await inDoubt(w)
    await stopped(w, String(r._id), false)
    await lapse(r)

    expect((await pay(w, d.id, 24, 'bank_transfer')).status).toBe(200)

    expect((await reread(r)).status).toBe('voided')
    const inv = await raw(d.id)
    expect(inv).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect(inv.receiptHolds).toHaveLength(0)
    expect(inv.payments.map((p: any) => p.method)).toEqual(['bank_transfer'])
  })

  it('the close finishes it too, so the session is not stuck', async () => {
    const w = await tillWorld(app)
    const { r } = await inDoubt(w)
    await stopped(w, String(r._id), true)
    await lapse(r)

    const closed = await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 136 } })

    expect(closed.status).toBe(200)
    expect((await reread(r)).completedAt).toBeTruthy()
    expect((await sessionOf(w))).toMatchObject({ status: 'closed', totalCash: 36, difference: 0 })
  })

  it('a second /settle saying the same finishes it, once', async () => {
    const w = await tillWorld(app)
    const { d, r } = await inDoubt(w)
    await stopped(w, String(r._id), true)
    await lapse(r)

    expect((await settle(w, String(r._id), true)).status).toBe(200)

    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
    expect((await sessionOf(w)).totalCash).toBe(36)
    expect(await AuditLog.countDocuments({ orgId: w.oid, action: 'settle_receipt' })).toBe(1)
    const again = await settle(w, String(r._id), true)
    expect(again.status).toBe(409)
    expect((await raw(d.id)).amountPaid).toBe(24)
  })

  it('a second /settle saying the opposite changes nothing: what was said stands', async () => {
    const w = await tillWorld(app)
    const { d, r } = await inDoubt(w)
    await stopped(w, String(r._id), true)
    await lapse(r)

    const other = await settle(w, String(r._id), false)

    expect(other.status).toBe(409)
    expect(other.json.code).toBe('receipt_already_settled')
    const after = await reread(r)
    expect(after.register.settled).toMatchObject({ printed: true })
    expect(after.status).toBe('paid')
    expect(await raw(d.id)).toMatchObject({ amountPaid: 0 })
  })

  it('a second /settle while the first still holds it does nothing', async () => {
    const w = await tillWorld(app)
    const { d, r } = await inDoubt(w)
    await stopped(w, String(r._id), true)

    const second = await settle(w, String(r._id), true)

    expect(second.status).toBe(409)
    expect(await raw(d.id)).toMatchObject({ amountPaid: 0 })
    expect((await sessionOf(w)).totalCash).toBe(12)
  })
})

describe('a session and its unfinished receipts (ruling 7)', () => {
  const close = (w: TillWorld, cash: number) => w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash } })

  it('refuses to close over one that cannot be proved, and says which, with no Z printed', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
    await w.sell(1)

    const refused = await close(w, 112)

    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('receipts_unfinished')
    expect(refused.json.receipts.map((x: any) => x.number)).toEqual([r.invoiceNumber])
    expect(refused.json.message).toContain(r.invoiceNumber)
    expect(w.sim!.reports).toHaveLength(0)
    expect((await sessionOf(w)).status).toBe('open')

    // Settled, the close goes through and the drawer agrees: nothing is posted as cash over.
    expect((await settle(w, String(r._id), true)).status).toBe(200)
    const closed = await close(w, 136)
    expect(closed.status).toBe(200)
    expect((await sessionOf(w))).toMatchObject({ status: 'closed', totalCash: 36, difference: 0 })
    expect(w.sim!.reports).toHaveLength(1)
  })

  it('a refused close never touches the session: a receipt printing beside it finds it open', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber - 1 })
    const real = POSSession.findOneAndUpdate
    let claims = 0
    ;(POSSession as any).findOneAndUpdate = function (...args: unknown[]) {
      claims++
      return (real as any).apply(POSSession, args)
    }
    let refused: any
    try {
      refused = await close(w, 100)
    } finally {
      ;(POSSession as any).findOneAndUpdate = real
    }

    expect(refused.json.code).toBe('receipts_unfinished')
    expect(claims).toBe(0)
  })

  it('finishes one it can prove, and closes', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })

    expect((await close(w, 100)).status).toBe(200)
    expect((await reread(r)).status).toBe('voided')
    expect((await raw(d.id)).receiptHolds).toHaveLength(0)
  })

  it('refuses over one still printing', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const held = gate()
    w.sim!.beforeCommand = cmd => (cmd === CLOSE ? held.closed : undefined)
    const paying = pay(w, d.id, 24)
    await until(() => w.sim!.executed.some(c => c.cmd === PAYMENT), 'the print to reach its payment')

    const refused = await close(w, 100)

    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('receipts_unfinished')
    held.open()
    expect((await paying).status).toBe(200)
  })

  it('one that slips in under the claim: the close gives way, and no Z prints', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const real = POSSession.findOneAndUpdate
    let slipped: any
    ;(POSSession as any).findOneAndUpdate = function (...args: unknown[]) {
      const query = (real as any).apply(POSSession, args)
      return {
        exec: async () => {
          const claimed = await query.exec()
          slipped = await dead(w, d, {})
          return claimed
        },
      }
    }
    let refused: any
    try {
      refused = await close(w, 100)
    } finally {
      ;(POSSession as any).findOneAndUpdate = real
    }

    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('receipts_unfinished')
    expect(refused.json.receipts.map((x: any) => x.id)).toEqual([String(slipped._id)])
    expect(w.sim!.reports).toHaveLength(0)
    expect((await sessionOf(w)).status).toBe('open')
  })

  it('one its request left printed: the close records it first, and the drawer agrees', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
    await Invoice.updateOne({ _id: r._id }, { $set: { 'register.fiscal.state': 'printed' } })

    const closed = await close(w, 124)

    expect(closed.status).toBe(200)
    expect(await sessionOf(w)).toMatchObject({ status: 'closed', totalCash: 24, difference: 0 })
    expect(await raw(d.id)).toMatchObject({ status: 'paid', amountPaid: 24 })
  })

  it('a closing session takes no new receipt: it would land after the day was counted', async () => {
    const w = await tillWorld(app)
    const clerk = await clerkSession(w)
    const d = await onBank(w)
    // The clerk's receipt is queued behind a sale; the cashier's session stays open.
    const held = gate()
    w.sim!.beforeCommand = cmd => (cmd === LINE ? held.closed : undefined)
    const sale = w.sell(1)
    await until(() => w.sim!.executed.some(c => c.cmd === 0x90), 'the sale to open its receipt')
    const paying = pay(w, d.id, 24, 'cash', undefined, w.clerkToken)
    await until(async () => (await receiptsOf(d.id)).length === 1, 'the receipt to wait its turn')
    await POSSession.updateOne({ _id: clerk }, { $set: { status: 'closed' } })
    held.open()

    await sale
    const r = await paying
    expect(r.status).toBe(503)
    expect((await raw(d.id)).amountPaid).toBe(0)
    expect((await receiptsOf(d.id))[0].status).toBe('voided')
    expect(closedOnDevice(w).map(x => x.total)).toEqual([12])
  })

  it('never increments a closed session', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, {})
    await POSSession.updateOne({ _id: w.sessionId }, { $set: { status: 'closed' } })

    await applySessionTotals(r, w.sessionId, { totalCash: 24, totalSales: 24, transactionCount: 1 })

    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, transactionCount: 0 })
    expect((await reread(r)).register.sessionTotalsApplied).toBeFalsy()
  })
})

describe('which device a door follows (FR-24.50)', () => {
  it('a dead receipt\'s own device comes first: only it can say anything about that receipt', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    await dead(w, d, { attemptedAt: new Date(), counterBefore: 1 })
    // Whoever touches the document has a session of their own, on another device, at another store.
    const store = await createTestWarehouse(w.oid)
    const theirs = await createTestFiscalDevice(w.oid, store._id, { deviceNumber: 'ED654321', manufacturer: 'eltrade', connectionType: 'browser', status: 'online' } as any)
    registerPrinter(String(theirs._id), new EltradeFiscalPrinter(new EltradeSimulator().exchange, String(theirs._id)))
    try {
      const opened = await w.call('POST', '/trade/pos/session', { warehouseId: String(store._id), openingBalance: 0, currency: 'EUR' }, undefined, w.clerkToken)
      expect(opened.status).toBe(200)
      const params = { orgId: w.orgId, id: d.id }
      const user = { id: String(w.clerk._id) }

      const own = { orgId: w.orgId, deviceId: w.deviceId, deviceNumber: 'ED123456' }
      expect(await deviceFromCounter({ params, user, body: {} })).toEqual(own)
      expect(await deviceFromDeadReceipt({ params, user: {}, body: {} })).toEqual(own)

      // With no dead receipt the same person's door is their own device.
      const clean = await onBank(w)
      expect(await deviceFromCounter({ params: { orgId: w.orgId, id: clean.id }, user, body: {} }))
        .toEqual({ orgId: w.orgId, deviceId: String(theirs._id), deviceNumber: 'ED654321' })
    } finally {
      unregisterPrinter(String(theirs._id))
    }
  })

  describe('two devices in one warehouse (a Tremol and an Eltrade while one replaces the other)', () => {
    /** A second device, newer, connected here too. */
    async function newer(w: TillWorld) {
      const device = await createTestFiscalDevice(w.oid, w.warehouse._id as any, { deviceNumber: 'ED654321', name: 'The new one', manufacturer: 'eltrade', connectionType: 'browser', status: 'online' } as any)
      const sim = new EltradeSimulator()
      sim.serial = 'ED654321'
      registerPrinter(String(device._id), new EltradeFiscalPrinter(sim.exchange, String(device._id)))
      return { id: String(device._id), sim, gone: () => unregisterPrinter(String(device._id)) }
    }

    it('the door follows the receipt\'s own device, not whichever the warehouse finds first', async () => {
      const w = await tillWorld(app)
      const d = await onBank(w)
      await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
      const other = await newer(w)
      try {
        expect(await deviceFromDeadReceipt({ params: { orgId: w.orgId, id: d.id }, user: {}, body: {} }))
          .toEqual({ orgId: w.orgId, deviceId: w.deviceId, deviceNumber: 'ED123456' })
      } finally {
        other.gone()
      }
    })

    it('the door follows it to the device the warehouse finds last as well', async () => {
      const w = await tillWorld(app)
      const d = await onBank(w)
      const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: 0 })
      const other = await newer(w)
      await Invoice.updateOne({ _id: r._id }, { $set: { 'register.fiscalDeviceNumber': 'ED654321' } })
      try {
        expect(await deviceFromDeadReceipt({ params: { orgId: w.orgId, id: d.id }, user: {}, body: {} }))
          .toEqual({ orgId: w.orgId, deviceId: other.id, deviceNumber: 'ED654321' })
      } finally {
        other.gone()
      }
    })

    it('so its own device proves it: given up, where a look at the other one could only hold it', async () => {
      const w = await tillWorld(app)
      const d = await onBank(w)
      const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
      const other = await newer(w)
      try {
        const answer = await pay(w, d.id, 24, 'bank_transfer')

        expect(answer.status).toBe(200)
        expect((await reread(r)).status).toBe('voided')
        expect(w.sim!.executed.some(c => c.cmd === 0x71)).toBe(true)
        expect(other.sim.executed.some(c => c.cmd === 0x71)).toBe(false)
      } finally {
        other.gone()
      }
    })

    it('and a keyed retry prints on the device it started on', async () => {
      const w = await tillWorld(app)
      const d = await onBank(w)
      const key = 'two-devices-0001'
      const hash = requestHash(`invoice.payment:${d.id}`, { date: TODAY(), amount: 24, method: 'cash' })
      await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber }, { key, hash })
      const other = await newer(w)
      try {
        expect((await pay(w, d.id, 24, 'cash', key)).status).toBe(200)

        expect(closedOnDevice(w)).toHaveLength(1)
        expect(other.sim.receipts).toHaveLength(0)
      } finally {
        other.gone()
      }
    })
  })

  it('a receipt with no device on record is proved on none: it is held', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber })
    await Invoice.updateOne({ _id: r._id }, { $unset: { 'register.fiscalDeviceNumber': 1 } })

    expect((await pay(w, d.id, 24, 'bank_transfer')).json.code).toBe('receipt_in_doubt')
    expect((await reread(r)).register.fiscal.inDoubt).toBe(true)
  })

  it('one held for a person reaches no device, so it sends nobody anywhere', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: 1 })
    await Invoice.updateOne({ _id: r._id }, { $set: { 'register.fiscal.state': 'unknown', 'register.fiscal.inDoubt': true } })

    expect(await deviceFromDeadReceipt({ params: { orgId: w.orgId, id: d.id }, user: {}, body: {} })).toBeNull()
  })

  it('the proof of a dead receipt reads the device it was printing on, not the door\'s', async () => {
    const w = await tillWorld(app)
    const d = await onBank(w)
    const r = await dead(w, d, { attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber }, { deviceNumber: 'ED654321' })

    expect((await pay(w, d.id, 24, 'bank_transfer')).json.code).toBe('receipt_in_doubt')
    expect((await reread(r)).register.fiscal.inDoubt).toBe(true)
  })
})
