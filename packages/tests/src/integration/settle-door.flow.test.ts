import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, reconnect, type TillWorld } from '../helpers/till-world'
import { clerkSale, clerkSession, draftOf, gate, pay, raw, receiptsOf, send, sessionOf } from '../helpers/receipt-world'
import { createTestContact, createTestFiscalDevice } from '../helpers/factories'
import { AuditLog, FiscalDevice, FiscalPresence, Invoice, POSSession } from 'db/models'
import { paymentReceiptDocument } from 'services/biz/cash-register/payment-receipt.service'
import { receiptBody } from 'services/biz/cash-register/receipt-lines'
import { POD_ID } from 'services/biz/fiscal-presence.service'
import { deviceFromJournalDocument, deviceFromSettledDocument, setFiscalForwarding } from 'fiscal/fiscal-route'
import { deviceTurn } from 'fiscal/device-turn'
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { getPrinter, registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import { fiscalDeviceController } from '../../../portal-api/src/controllers/fiscal-device.controller'

/**
 * FR-23, the third read's finding 1: a person's word is taken only for what only a person can know. What
 * the device can still change, or can answer, it is asked first.
 *
 * The line drops after the payment command, so the money is on the device and its receipt is open. Settled
 * "not printed" while the device was away, that document was voided, and the next document's clear finished
 * it in cash, which prints it: two fiscal documents on the device for one in LGR. So while a fiscal
 * document's device row is active both answers wait for the device, and a device gone for good is
 * deactivated on its page, after which the word stands. Nothing is stuck.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = tillApp().use(fiscalDeviceController) as any
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { forgetDevices(); await clearCollections() }, 30_000)

const PAYMENT = 0x35

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

const settle = (w: TillWorld, id: unknown, printed: boolean, receiptNumber?: string, extra: Record<string, unknown> = {}) =>
  w.call('POST', `/cash-register/documents/${id}/settle`, { printed, ...(receiptNumber ? { receiptNumber } : {}), ...extra })
/** "The slip says this number." */
const CONFIRM = { confirmNumber: true }
const read = (id: unknown): Promise<any> => Invoice.findById(id).lean().exec()
/** The next command runs and answers, and the line drops behind it. */
const dropsAfterPayment = (w: TillWorld) => { w.sim!.beforeCommand = cmd => { if (cmd === PAYMENT) w.sim!.disconnected = true } }
const lineBack = (w: TillWorld) => { w.sim!.beforeCommand = null; w.sim!.disconnected = false }
const closedOnDevice = (w: TillWorld) => w.sim!.receipts.filter(r => !r.voided)

/** A storno with its money on the device and its receipt open: held. */
async function storno(w: TillWorld) {
  const sold = await w.sell(1)
  dropsAfterPayment(w)
  const answer = await w.storno(String(sold.json.transaction.id))
  lineBack(w)
  expect(answer.json.code).toBe('storno_in_doubt')
  return { kind: 'storno' as const, id: String(answer.json.receipt.id), saleId: String(sold.json.transaction.id) }
}

/** A till sale the same way: `unknown`, its money standing. */
async function sale(w: TillWorld) {
  dropsAfterPayment(w)
  const sold = await w.sell(1)
  lineBack(w)
  expect(sold.json.transaction.fiscal.state).toBe('unknown')
  return { kind: 'sale' as const, id: String(sold.json.transaction.id) }
}

/**
 * A payment's receipt: its request died with the money on the device and the receipt open, and the next
 * touch held it. Only a request that dies leaves one, so the print is driven by hand and the document
 * written as the process left it.
 */
async function receipt(w: TillWorld) {
  const d = await draftOf(w, { method: 'bank_transfer' })
  await send(w, d.id)
  const invoice = await raw(d.id)
  const body = receiptBody({ doc: invoice, amount: d.total, whole: false, printsText: true, receipts: [] })!
  const document = paymentReceiptDocument({
    invoice, body, tender: { method: 'cash', amount: d.total, date: new Date() },
    session: { id: w.sessionId, warehouseId: String(w.warehouse._id) },
    user: { id: String(w.user._id), operatorCode: '0001' },
    printer: { deviceNumber: 'ED123456' } as any,
  })
  const unp = 'ED123456-0001-0000099'
  const counterBefore = w.sim!.lastDocNumber
  const printing = getPrinter(w.deviceId)
  await printing.openFiscalReceipt('0001', 'Иван Петров', unp)
  await printing.printSaleLine('Плащане', 1, d.total, 'Б', undefined, 20)
  await printing.printPayment('cash', d.total)
  const inserted: any = await Invoice.create({
    ...document, invoiceNumber: 'CS-2026-90099', leaseUntil: new Date(Date.now() - 1000),
    register: { ...document.register, unp, fiscal: { state: 'pending', mode: 'fiscal', attemptedAt: new Date(), counterBefore } },
  })
  await Invoice.updateOne({ _id: d.id }, { $push: { receiptHolds: { receiptId: inserted._id, amount: d.total } } })
  const next = await pay(w, d.id, d.total, 'card')
  expect(next.json.code).toBe('receipt_in_doubt')
  return { kind: 'receipt' as const, id: String(inserted._id), invoiceId: d.id }
}

const KINDS = { storno, sale, receipt }

/** All a refused settle must leave as it was. */
async function everything(w: TillWorld, id: unknown) {
  const doc = await read(id)
  return { doc, session: await sessionOf(w), stock: (await w.stock()).quantity, device: w.sim!.executed.length, documents: await Invoice.countDocuments({ orgId: w.oid }) }
}

/** What "printed" takes: a sale cites the number off its slip. */
const printedAnswer = (w: TillWorld, kind: string) => (kind === 'sale' ? w.sim!.receipts.at(-1)!.number : undefined)

describe('a fiscal document in doubt, its money on the device: both answers wait for the device (finding 1)', () => {
  for (const kind of ['storno', 'sale', 'receipt'] as const) {
    it(`a ${kind}, the bridge gone: both refused, nothing changed; back, the receipt is open; an X report; settled printed; one document on the device and one in LGR`, async () => {
      const w = await tillWorld(app)
      const held = await KINDS[kind](w)
      expect(w.sim!.receipt?.payments.length).toBeGreaterThan(0)
      forgetDevices()
      const before = await everything(w, held.id)

      for (const printed of [false, true]) {
        const r = await settle(w, held.id, printed, printed && kind === 'sale' ? '101' : undefined)
        expect(r.status).toBe(409)
        expect(r.json.code).toBe('receipt_device_away')
        expect(r.json.message).toContain('Connect it')
        expect(r.json.message).toContain('deactivated')
      }
      expect(await everything(w, held.id)).toEqual(before)

      reconnect(w)
      for (const printed of [false, true]) {
        const r = await settle(w, held.id, printed, printed && kind === 'sale' ? '101' : undefined)
        expect(r.status).toBe(409)
        expect(r.json.code).toBe('receipt_open_on_device')
      }
      expect((await read(held.id)).register.settled).toBeUndefined()

      await getPrinter(w.deviceId).printDailyXReport()
      expect(w.sim!.receipt).toBeNull()

      const done = await settle(w, held.id, true, printedAnswer(w, kind))
      expect(done.status).toBe(200)

      if (kind === 'storno') {
        // The sale's receipt, and the storno: one each, as LGR has it.
        expect(closedOnDevice(w).map(r => r.kind)).toEqual(['fiscal', 'storno'])
        expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_storno', status: 'paid' })).toBe(1)
        expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 12 })
      } else if (kind === 'sale') {
        expect(closedOnDevice(w).map(r => r.kind)).toEqual(['fiscal'])
        expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_sale' })).toBe(1)
        expect(await sessionOf(w)).toMatchObject({ totalCash: 12, totalReturns: 0 })
      } else {
        expect(closedOnDevice(w).map(r => r.kind)).toEqual(['fiscal'])
        expect((await receiptsOf((held as any).invoiceId)).filter(r => r.status === 'paid')).toHaveLength(1)
        expect(await raw((held as any).invoiceId)).toMatchObject({ status: 'paid', amountPaid: 24 })
        expect(await sessionOf(w)).toMatchObject({ totalCash: 24 })
      }
    })
  }

  it('settled not printed once it is cleared: nothing else prints later, and the next press is the only storno', async () => {
    const w = await tillWorld(app)
    const held = await storno(w)
    forgetDevices()
    expect((await settle(w, held.id, false)).json.code).toBe('receipt_device_away')
    expect((await read(held.saleId)).register.stornoState).toBe('full')
    reconnect(w)
    await getPrinter(w.deviceId).printDailyXReport()
    // It took money, so the X report finished it, and the person reads it on the device.
    expect(closedOnDevice(w).filter(r => r.kind === 'storno')).toHaveLength(1)
    expect((await settle(w, held.id, true)).status).toBe(200)

    const again = await w.storno(held.saleId)

    expect(again.status).toBe(400)
    expect(closedOnDevice(w).filter(r => r.kind === 'storno')).toHaveLength(1)
  })

  it('a read that failed is no answer: the line gone with the driver still here', async () => {
    const w = await tillWorld(app)
    const held = await storno(w)
    w.sim!.disconnected = true
    const before = await everything(w, held.id)

    const dropped = await settle(w, held.id, false)

    expect(dropped.status).toBe(409)
    expect(dropped.json.code).toBe('receipt_device_away')
    w.sim!.disconnected = false
    w.sim!.silent = true
    const silent = await settle(w, held.id, false)
    expect(silent.json.code).toBe('receipt_device_away')
    w.sim!.silent = false
    expect(await everything(w, held.id)).toEqual({ ...before, device: w.sim!.executed.length })
  })

  it('a busy device is told as busy, and it is asked again', async () => {
    const w = await tillWorld(app)
    const held = await storno(w)
    const taken = gate()
    const holder = deviceTurn(w.deviceId, () => taken.closed)

    const r = await settle(w, held.id, false)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('device_busy')
    expect((await read(held.id)).register.settled).toBeUndefined()
    taken.open()
    await holder
    expect((await settle(w, held.id, false)).json.code).toBe('receipt_open_on_device')
  }, 30_000)

  it('a device that does not answer, switched off with its tab still open: told in time, before the request is cut', async () => {
    const w = await tillWorld(app)
    const held = await storno(w)
    const never = gate()
    w.sim!.beforeCommand = () => never.closed
    const started = Date.now()

    const r = await settle(w, held.id, false)

    expect(r.json.code).toBe('receipt_device_away')
    expect(Date.now() - started).toBeLessThan(25_000)
    expect((await read(held.id)).register.settled).toBeUndefined()
    w.sim!.beforeCommand = null
    never.open()
  }, 40_000)

  it('a driver with no way to ask leaves it to the person', async () => {
    const w = await tillWorld(app)
    const held = await storno(w)
    // As a Tremol or a Datecs is: no open flag and no counter to read. The device is there.
    unregisterPrinter(w.deviceId)
    const driver = new EltradeFiscalPrinter(w.sim!.exchange, w.deviceId)
    registerPrinter(w.deviceId, new Proxy(driver, {
      get: (t: any, p) => (p === 'isReceiptOpen' || p === 'getLastReceiptNumber' ? undefined : t[p]),
    }))

    const r = await settle(w, held.id, false)

    expect(r.status).toBe(200)
    expect((await read(held.id)).status).toBe('voided')
  })
})

describe('the way out, and what must not make a real settle impossible (finding 1)', () => {
  for (const kind of ['storno', 'sale', 'receipt'] as const) {
    it(`a device gone for good, deactivated on its page with the session still open: the word stands on a ${kind}`, async () => {
      const w = await tillWorld(app)
      const held = await KINDS[kind](w)
      forgetDevices()
      expect((await settle(w, held.id, false)).json.code).toBe('receipt_device_away')

      const gone = await w.call('DELETE', `/fiscal/device/${w.deviceId}`)
      expect(gone.status).toBe(200)
      expect(((await POSSession.findById(w.sessionId).lean().exec()) as any).status).toBe('open')

      const r = await settle(w, held.id, false)

      expect(r.status).toBe(200)
      expect((await read(held.id)).register.settled).toMatchObject({ printed: false })
    })
  }

  it('deactivated with the driver still registered: the word stands, the device is not asked', async () => {
    const w = await tillWorld(app)
    const held = await storno(w)
    await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { isActive: false } })
    const commands = w.sim!.executed.length

    expect((await settle(w, held.id, true)).status).toBe(200)
    expect(w.sim!.executed.length).toBe(commands)
  })

  it('a row that does not say it is deactivated is not: only `false` lets the word stand', async () => {
    const w = await tillWorld(app)
    const held = await storno(w)
    forgetDevices()
    await FiscalDevice.collection.updateOne({ _id: new FiscalDevice.base.Types.ObjectId(w.deviceId) }, { $unset: { isActive: '' } })

    expect((await settle(w, held.id, false)).json.code).toBe('receipt_device_away')
    expect(await deviceFromSettledDocument({ params: { orgId: w.orgId, id: held.id }, user: {}, body: {} })).toEqual({ orgId: w.orgId, deviceId: w.deviceId, deviceNumber: 'ED123456' })
  })

  it('no row at all: the word stands', async () => {
    const w = await tillWorld(app)
    const held = await storno(w)
    forgetDevices()
    await FiscalDevice.deleteOne({ _id: w.deviceId })

    expect((await settle(w, held.id, false)).status).toBe(200)
  })

  it('a device connected while its row reads `error` is asked, and its answer counts', async () => {
    const w = await tillWorld(app)
    const held = await storno(w)
    await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { status: 'error' } })

    expect((await settle(w, held.id, false)).json.code).toBe('receipt_open_on_device')

    await getPrinter(w.deviceId).printDailyXReport()
    expect((await settle(w, held.id, true)).status).toBe(200)
  })

  it('a device away whose row reads `error` is away, not "the word stands"', async () => {
    const w = await tillWorld(app)
    const held = await storno(w)
    forgetDevices()
    await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { status: 'error' } })

    expect((await settle(w, held.id, false)).json.code).toBe('receipt_device_away')
  })

  it('a document on a closed session reaches its device', async () => {
    const w = await tillWorld(app)
    const held = await sale(w)
    await POSSession.updateOne({ _id: w.sessionId }, { $set: { status: 'closed' } })

    expect((await settle(w, held.id, false)).json.code).toBe('receipt_open_on_device')
  })

  it('a document whose session is gone reaches its device all the same', async () => {
    const w = await tillWorld(app)
    const held = await sale(w)
    await POSSession.deleteOne({ _id: w.sessionId })

    expect((await settle(w, held.id, false)).json.code).toBe('receipt_open_on_device')
  })

  it('held by another pod that no hop reached: 503, nothing written, and never the word', async () => {
    const w = await tillWorld(app)
    const held = await storno(w)
    forgetDevices()
    await FiscalPresence.create({
      orgId: w.oid, deviceNumber: 'ED123456', deviceId: w.deviceId, kind: 'user', label: 'till', podId: 'another-pod#1', podAddr: 'http://127.0.0.1:1', connId: 'c1', connectedAt: new Date(), heartbeatAt: new Date(),
    } as any)

    const r = await settle(w, held.id, false)

    expect(r.status).toBe(503)
    expect((await read(held.id)).register.settled).toBeUndefined()
  })

  it('a row naming this very process, with nothing connected, is away', async () => {
    const w = await tillWorld(app)
    const held = await storno(w)
    forgetDevices()
    await FiscalPresence.create({
      orgId: w.oid, deviceNumber: 'ED123456', deviceId: w.deviceId, kind: 'user', label: 'till', podId: POD_ID, podAddr: 'http://127.0.0.1:1', connId: 'c1', connectedAt: new Date(), heartbeatAt: new Date(),
    } as any)

    expect((await settle(w, held.id, false)).json.code).toBe('receipt_device_away')
  })

  it('a text document is unaffected: the device holds no money on one', async () => {
    const w = await tillWorld(app)
    const held = await receipt(w)
    await Invoice.updateOne({ _id: held.id }, { $set: { 'register.isFiscal': false, 'register.fiscal.mode': 'text' } })
    forgetDevices()

    expect((await settle(w, held.id, false)).status).toBe(200)
    expect((await read(held.id)).status).toBe('voided')
  })

  it('a document not in doubt is told so, whether or not the device is here', async () => {
    const w = await tillWorld(app)
    const sold = await w.sell(1)
    forgetDevices()

    const r = await settle(w, sold.json.transaction.id, false)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('receipt_not_in_doubt')
  })
})

describe('a number typed off the slip (finding 7)', () => {
  /** A sale in doubt, cleared by an X report, so the device reads idle. Answers the number on its slip. */
  async function settleable(w: TillWorld) {
    const held = await sale(w)
    forgetDevices()
    reconnect(w)
    await getPrinter(w.deviceId).printDailyXReport()
    return { id: held.id, onTheSlip: w.sim!.receipts.at(-1)!.number!, last: w.sim!.lastDocNumber }
  }

  describe('its bounds', () => {
    it('above the device\'s last number: refused, read in the same turn as the open flag', async () => {
      const w = await tillWorld(app)
      const { id, last } = await settleable(w)

      const r = await settle(w, id, true, '9999999')

      expect(r.status).toBe(422)
      expect(r.json.code).toBe('receipt_number_off_device')
      expect(r.json.last).toBe(last)
      expect((await read(id)).register.fiscal.state).toBe('unknown')
      expect((await read(id)).register.settled).toBeUndefined()
    })

    it('the last number itself is taken, and so is one below it: there is no lower bound', async () => {
      const w = await tillWorld(app)
      const { id, onTheSlip } = await settleable(w)
      expect(Number(onTheSlip)).toBeLessThanOrEqual(w.sim!.lastDocNumber)
      expect((await settle(w, id, true, '1')).status).toBe(200)
      expect((await read(id)).register.fiscalReceiptNumber).toBe('1')
    })

    it('a device that cannot say skips it, and the rest of the checks stand', async () => {
      const w = await tillWorld(app)
      const { id } = await settleable(w)
      unregisterPrinter(w.deviceId)
      const driver = new EltradeFiscalPrinter(w.sim!.exchange, w.deviceId)
      registerPrinter(w.deviceId, new Proxy(driver, {
        get: (t: any, p) => {
          const v = t[p]
          if (p === 'getLastReceiptNumber') return undefined
          return typeof v === 'function' ? v.bind(t) : v
        },
      }))

      expect((await settle(w, id, true, 'ФБ-1')).json.code).toBe('receipt_number_required')
      expect((await settle(w, id, true, '9999999')).status).toBe(200)
    })

    it('a counter that cannot be read, on a driver that has one, is no answer', async () => {
      const w = await tillWorld(app)
      const { id, onTheSlip } = await settleable(w)
      // The open flag reads fine, and the line goes at the counter, in the same turn.
      w.sim!.beforeCommand = (cmd) => { if (cmd === 0x71) throw new Error('Bridge disconnected') }

      const r = await settle(w, id, true, onTheSlip)

      expect(r.json.code).toBe('receipt_device_away')
      expect((await read(id)).register.settled).toBeUndefined()
    })

    it('a device whose counter has gone back since this sale read it: its memory was replaced, and it says nothing of this slip', async () => {
      const w = await tillWorld(app)
      const { id } = await settleable(w)
      await Invoice.updateOne({ _id: id }, { $set: { 'register.fiscal.counterBefore': w.sim!.lastDocNumber + 400 } })

      const r = await settle(w, id, true, String(w.sim!.lastDocNumber + 401))

      expect(r.status).toBe(200)
    })

    it('deactivated: nothing to read it against, and the word stands', async () => {
      const w = await tillWorld(app)
      const { id } = await settleable(w)
      await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { isActive: false } })

      expect((await settle(w, id, true, '9999999')).status).toBe(200)
    })

    it('another session\'s number on the same device is taken: two on one device is normal', async () => {
      const w = await tillWorld(app)
      const clerk = await clerkSession(w)
      const other = await clerkSale(w, clerk, 1)
      const theirs = other.json.transaction.fiscalReceiptNumber
      const { id } = await settleable(w)

      const r = await settle(w, id, true, String(Number(theirs)))

      expect(r.status).toBe(422)
      expect(r.json.code).toBe('receipt_number_taken')
      expect(r.json.document).toBe(other.json.transaction.transactionNumber)
    })

    it('in all three spellings', async () => {
      const w = await tillWorld(app)
      const clerk = await clerkSession(w)
      const theirs = (await clerkSale(w, clerk, 1)).json.transaction.fiscalReceiptNumber
      const { id } = await settleable(w)
      for (const spelled of [theirs, String(Number(theirs)), String(Number(theirs)).padStart(4, '0')]) {
        const r = await settle(w, id, true, spelled)
        expect(r.json.code, spelled).toBe('receipt_number_taken')
      }
    })

    it('as a number, whatever padding is stored or typed (the fourth read, finding 7)', async () => {
      const w = await tillWorld(app)
      const clerk = await clerkSession(w)
      const other = await clerkSale(w, clerk, 1)
      const theirs = other.json.transaction.fiscalReceiptNumber as string
      expect(theirs).toBe('0000101')
      const { id } = await settleable(w)

      for (const spelled of ['00000101', '00101', '0000000101']) {
        const r = await settle(w, id, true, spelled)
        expect(r.status, spelled).toBe(422)
        expect(r.json.code, spelled).toBe('receipt_number_taken')
        expect(r.json.document, spelled).toBe(other.json.transaction.transactionNumber)
      }

      // Stored with a padding of its own, and typed with none.
      await Invoice.updateOne({ _id: other.json.transaction.id }, { $set: { 'register.fiscalReceiptNumber': '00101' } })
      expect((await settle(w, id, true, '101')).json.code).toBe('receipt_number_taken')
      expect((await read(id)).register.settled).toBeUndefined()

      // A number that only ends the same way is another number.
      expect((await settle(w, id, true, '1')).status).toBe(200)
    })

    it('another device\'s, or the same device\'s outside 31 days, is not: a replaced fiscal memory counts from one again', async () => {
      const w = await tillWorld(app)
      const earlier = await w.sell(1)
      const theirs = earlier.json.transaction.fiscalReceiptNumber
      const { id } = await settleable(w)
      const earlierId = new Invoice.base.Types.ObjectId(String(earlier.json.transaction.id))

      await Invoice.collection.updateOne({ _id: earlierId }, { $set: { 'register.fiscalDeviceNumber': 'ED999999' } })
      const another = await settle(w, id, true, theirs)
      expect(another.json.code).not.toBe('receipt_number_taken')
      expect(another.status).toBe(200)
    })

    it('outside 31 days of this sale it is not taken', async () => {
      const w = await tillWorld(app)
      const earlier = await w.sell(1)
      const theirs = earlier.json.transaction.fiscalReceiptNumber
      const { id } = await settleable(w)
      const earlierId = new Invoice.base.Types.ObjectId(String(earlier.json.transaction.id))

      await Invoice.collection.updateOne({ _id: earlierId }, { $set: { createdAt: new Date(Date.now() - 30 * 86_400_000) } })
      expect((await settle(w, id, true, theirs)).json.code).toBe('receipt_number_taken')
      await Invoice.collection.updateOne({ _id: earlierId }, { $set: { createdAt: new Date(Date.now() - 32 * 86_400_000) } })
      expect((await settle(w, id, true, theirs)).status).toBe(200)
    })
  })

  describe('a question, not a dead end: nobody has held a real slip against 71h (the fourth read, finding 3)', () => {
    /** A sale that stored the device's number, and a sale in doubt cleared by an X report. */
    async function beside(w: TillWorld) {
      const other = await w.sell(1)
      const s = await settleable(w)
      return { ...s, theirs: other.json.transaction.fiscalReceiptNumber as string, theirNumber: other.json.transaction.transactionNumber as string }
    }
    const trail = async (w: TillWorld, id: string, action: string) => {
      const row: any = await AuditLog.findOne({ orgId: w.oid, action, entityId: new Invoice.base.Types.ObjectId(id) }).lean().exec()
      return row
    }

    it('the reader\'s run: 101 against a stored 0000101 is refused, naming it; then confirmed, stored as typed, and on the trail', async () => {
      const w = await tillWorld(app)
      const { id, theirs, theirNumber } = await beside(w)
      expect(theirs).toBe('0000101')

      const asked = await settle(w, id, true, '101')

      expect(asked.status).toBe(422)
      expect(asked.json.code).toBe('receipt_number_taken')
      expect(asked.json.document).toBe(theirNumber)
      expect((await read(id)).register.settled).toBeUndefined()

      const confirmed = await settle(w, id, true, '101', CONFIRM)

      expect(confirmed.status).toBe(200)
      const { register } = await read(id)
      expect(register.fiscalReceiptNumber).toBe('101')
      expect(register.settled).toMatchObject({ printed: true, receiptNumber: '101' })
      expect(register.settled.confirmedOver).toContain(theirNumber)
      const audit = await trail(w, id, 'settle_receipt')
      expect(audit.changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'receiptNumber', newValue: '101' }),
        expect.objectContaining({ field: 'confirmedOver', newValue: expect.stringContaining(theirNumber) }),
      ]))
    })

    it('the same above the device\'s last number: refused, naming the last, then confirmed and on the trail', async () => {
      const w = await tillWorld(app)
      const { id, last } = await settleable(w)

      const asked = await settle(w, id, true, '9999999')

      expect(asked.status).toBe(422)
      expect(asked.json.code).toBe('receipt_number_off_device')
      expect(asked.json.last).toBe(last)

      expect((await settle(w, id, true, '9999999', CONFIRM)).status).toBe(200)

      const { register } = await read(id)
      expect(register.fiscalReceiptNumber).toBe('9999999')
      expect(register.settled.confirmedOver).toContain(String(last))
      expect((await trail(w, id, 'settle_receipt')).changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'confirmedOver', newValue: expect.stringContaining(String(last)) }),
      ]))
    })

    it('with the device deactivated it still asks, and the confirm is the way through: no dead end', async () => {
      const w = await tillWorld(app)
      const { id, theirs } = await beside(w)
      await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { isActive: false } })

      expect((await settle(w, id, true, String(Number(theirs)))).json.code).toBe('receipt_number_taken')
      expect((await settle(w, id, true, String(Number(theirs)), CONFIRM)).status).toBe(200)
      expect((await read(id)).completedAt).toBeTruthy()
    })

    it('a confirm with nothing to confirm says nothing on the trail', async () => {
      const w = await tillWorld(app)
      const { id, onTheSlip } = await settleable(w)

      expect((await settle(w, id, true, onTheSlip, CONFIRM)).status).toBe(200)

      expect((await read(id)).register.settled.confirmedOver).toBeUndefined()
      expect((await trail(w, id, 'settle_receipt')).changes.map((c: any) => c.field)).not.toContain('confirmedOver')
    })

    it('a format refusal is never confirmable: its storno could not cite it', async () => {
      const w = await tillWorld(app)
      const { id } = await settleable(w)

      const r = await settle(w, id, true, 'ФБ-1', CONFIRM)

      expect(r.status).toBe(422)
      expect(r.json.code).toBe('receipt_number_required')
      expect((await read(id)).register.settled).toBeUndefined()
    })

    it('nor is a device that still holds a receipt open: a confirm speaks for the number, not for the device', async () => {
      const w = await tillWorld(app)
      const held = await sale(w)

      expect((await settle(w, held.id, true, '9999999', CONFIRM)).json.code).toBe('receipt_open_on_device')
    })

    it('a stopped settle keeps what it was confirmed over, and whatever finishes it writes that on the trail', async () => {
      const w = await tillWorld(app)
      const { id, theirs, theirNumber } = await beside(w)
      // As a sale whose request died leaves it, with what a person says next still to book.
      await Invoice.updateOne({ _id: id }, { $unset: { completedAt: 1, 'register.sessionTotalsApplied': 1 } })
      const realAudit = AuditLog.create
      const dies = spyOn(Invoice, 'startSession').mockImplementationOnce(() => { throw new Error('the pod went away') })
      ;(AuditLog as any).create = async () => { throw new Error('the pod went away') }
      let stopped: any
      try {
        stopped = await settle(w, id, true, theirs, CONFIRM)
      } finally {
        ;(AuditLog as any).create = realAudit
        dies.mockRestore()
      }
      expect(stopped.status).toBe(500)
      expect(await AuditLog.countDocuments({ orgId: w.oid, action: 'settle_receipt' })).toBe(0)
      await Invoice.updateOne({ _id: id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })

      expect((await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 124 } })).status).toBe(200)

      expect((await trail(w, id, 'settle_receipt')).changes).toEqual(expect.arrayContaining([
        expect.objectContaining({ field: 'confirmedOver', newValue: expect.stringContaining(theirNumber) }),
      ]))
    })

    describe('and correcting one', () => {
      async function typed(w: TillWorld, number: string) {
        const s = await beside(w)
        expect((await settle(w, s.id, true, number)).status).toBe(200)
        return s
      }

      it('asks the same, and confirmed it is rewritten and on the trail, old to new, with what it was over', async () => {
        const w = await tillWorld(app)
        const { id, theirs, theirNumber } = await typed(w, '1')

        const asked = await settle(w, id, true, theirs)
        expect(asked.status).toBe(422)
        expect(asked.json.code).toBe('receipt_number_taken')
        expect(asked.json.document).toBe(theirNumber)
        expect((await read(id)).register.fiscalReceiptNumber).toBe('1')

        expect((await settle(w, id, true, theirs, CONFIRM)).status).toBe(200)

        const { register } = await read(id)
        expect(register.fiscalReceiptNumber).toBe(theirs)
        expect(register.settled.confirmedOver).toContain(theirNumber)
        const audit = await trail(w, id, 'correct_receipt_number')
        expect(audit.changes).toEqual(expect.arrayContaining([
          expect.objectContaining({ field: 'receiptNumber', oldValue: '1', newValue: theirs }),
          expect.objectContaining({ field: 'confirmedOver', newValue: expect.stringContaining(theirNumber) }),
        ]))
      })

      it('corrected again to one that collides with nothing, the old confirm goes', async () => {
        const w = await tillWorld(app)
        const { id, theirs } = await typed(w, '1')
        expect((await settle(w, id, true, theirs, CONFIRM)).status).toBe(200)

        expect((await settle(w, id, true, '2')).status).toBe(200)

        const { register } = await read(id)
        expect(register.fiscalReceiptNumber).toBe('2')
        expect(register.settled.confirmedOver).toBeUndefined()
      })

      it('above the device\'s last too', async () => {
        const w = await tillWorld(app)
        const { id, last } = await typed(w, '1')

        expect((await settle(w, id, true, '9999999')).json.code).toBe('receipt_number_off_device')
        expect((await settle(w, id, true, '9999999', CONFIRM)).status).toBe(200)

        expect((await trail(w, id, 'correct_receipt_number')).changes).toEqual(expect.arrayContaining([
          expect.objectContaining({ field: 'confirmedOver', newValue: expect.stringContaining(String(last)) }),
        ]))
      })

      it('a cited number is not confirmable: it protects a storno already on the device', async () => {
        const w = await tillWorld(app)
        const { id, theirs } = await typed(w, '2')
        expect((await w.storno(id)).status).toBe(200)

        const r = await settle(w, id, true, theirs, CONFIRM)

        expect(r.status).toBe(409)
        expect(r.json.code).toBe('receipt_number_cited')
        expect((await read(id)).register.fiscalReceiptNumber).toBe('2')
      })

      it('the rights stay the door\'s', async () => {
        const w = await tillWorld(app)
        const { id, theirs } = await typed(w, '1')

        const r = await w.call('POST', `/cash-register/documents/${id}/settle`, { printed: true, receiptNumber: theirs, ...CONFIRM }, undefined, await w.tokenAs('sales'))

        expect(r.status).toBe(403)
        expect((await read(id)).register.fiscalReceiptNumber).toBe('1')
      })
    })
  })

  describe('correcting one', () => {
    /** A sale settled printed under `typed`, finished. */
    async function settled(w: TillWorld, typed = '1') {
      const s = await settleable(w)
      expect((await settle(w, s.id, true, typed)).status).toBe(200)
      return s
    }
    const fields = async (id: string) => {
      const { register: r } = await read(id)
      return { settled: r.settled.receiptNumber, receiptNo: r.fiscal.receiptNo, number: r.fiscalReceiptNumber }
    }

    it('the same door and rights: all three stored fields rewritten, audited old to new, and the storno cites it', async () => {
      const w = await tillWorld(app)
      const { id, onTheSlip } = await settled(w)

      expect((await w.call('POST', `/cash-register/documents/${id}/settle`, { printed: true, receiptNumber: onTheSlip }, undefined, await w.tokenAs('sales'))).status).toBe(403)
      expect((await fields(id)).number).toBe('1')

      const r = await settle(w, id, true, onTheSlip)

      expect(r.status).toBe(200)
      expect(await fields(id)).toEqual({ settled: onTheSlip, receiptNo: onTheSlip, number: onTheSlip })
      const audit: any = await AuditLog.findOne({ orgId: w.oid, action: 'correct_receipt_number' }).lean().exec()
      expect(String(audit.entityId)).toBe(id)
      expect(String(audit.userId)).toBe(String(w.user._id))
      expect(audit.changes).toEqual([expect.objectContaining({ field: 'receiptNumber', oldValue: '1', newValue: onTheSlip })])
      const page = (await w.call('GET', `/cash-register/documents/${id}`)).json
      expect(page.row.fiscal).toMatchObject({ numberTyped: true, receiptNumber: onTheSlip })

      expect((await w.storno(id)).status).toBe(200)
      expect(closedOnDevice(w).at(-1)!.header[5]).toBe(onTheSlip)
    })

    it('the same checks: digits, the device\'s last number, one already taken, the device asked', async () => {
      const w = await tillWorld(app)
      const other = (await w.sell(1)).json.transaction.fiscalReceiptNumber
      const { id } = await settled(w)

      expect((await settle(w, id, true, 'ФБ-1')).json.code).toBe('receipt_number_required')
      expect((await settle(w, id, true, '9999999')).json.code).toBe('receipt_number_off_device')
      expect((await settle(w, id, true, other)).json.code).toBe('receipt_number_taken')
      forgetDevices()
      expect((await settle(w, id, true, '2')).json.code).toBe('receipt_device_away')
      expect((await fields(id)).number).toBe('1')
      expect(await AuditLog.countDocuments({ orgId: w.oid, action: 'correct_receipt_number' })).toBe(0)
    })

    it('the number it has already: nothing written, and nothing on the trail', async () => {
      const w = await tillWorld(app)
      const { id } = await settled(w)

      expect((await settle(w, id, true, '1')).status).toBe(200)
      expect(await AuditLog.countDocuments({ orgId: w.oid, action: 'correct_receipt_number' })).toBe(0)
    })

    it('once a storno cites it: 409, and the number stands', async () => {
      const w = await tillWorld(app)
      const { id, onTheSlip } = await settled(w, '2')
      expect((await w.storno(id)).status).toBe(200)

      const r = await settle(w, id, true, onTheSlip)

      expect(r.status).toBe(409)
      expect(r.json.code).toBe('receipt_number_cited')
      expect((await fields(id)).number).toBe('2')
      // And that is what it is told, whatever it typed: nothing it could type would be taken.
      expect((await settle(w, id, true, '9999999')).json.code).toBe('receipt_number_cited')
    })

    it('a storno held in doubt cites it too', async () => {
      const w = await tillWorld(app)
      const { id, onTheSlip } = await settled(w, '2')
      w.sim!.dropAfter = 0x38
      expect((await w.storno(id)).json.code).toBe('storno_in_doubt')
      w.sim!.disconnected = false

      expect((await settle(w, id, true, onTheSlip)).json.code).toBe('receipt_number_cited')
    })

    it('a storno voided since cites nothing: it gave the sale back, and a bad number is why one is corrected', async () => {
      const w = await tillWorld(app)
      const { id, onTheSlip } = await settled(w, '2')
      w.sim!.paper = false
      expect((await w.storno(id)).status).toBe(503)
      w.sim!.paper = true
      expect((await read(id)).register.stornoState).toBe('none')

      const r = await settle(w, id, true, onTheSlip)

      expect(r.status).toBe(200)
      expect((await fields(id)).number).toBe(onTheSlip)
      expect((await w.storno(id)).status).toBe(200)
      expect(closedOnDevice(w).at(-1)!.header[5]).toBe(onTheSlip)
    })

    it('an invoice for the sale carries it, printed: it stands', async () => {
      const w = await tillWorld(app)
      const { id, onTheSlip } = await settled(w, '2')
      const contact = await createTestContact(w.oid, { companyName: 'Клиент ООД', type: 'customer' } as any)
      expect((await w.call('POST', `/invoices/${id}/to-invoice`, { contactId: String(contact._id), issue: false })).status).toBe(200)

      expect((await settle(w, id, true, onTheSlip)).json.code).toBe('receipt_number_cited')

      const r = await w.call('POST', `/invoices/${id}/to-invoice`, { contactId: String(contact._id), issue: false })
      expect(r.status).toBeGreaterThanOrEqual(200)
    })

    it('a number the device gave cannot be corrected, and neither can what was settled not printed', async () => {
      const w = await tillWorld(app)
      const printed = await w.sell(1)
      const r = await settle(w, printed.json.transaction.id, true, '1')
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('receipt_not_in_doubt')

      const { id } = await settleable(w)
      expect((await settle(w, id, false)).status).toBe(200)
      expect((await settle(w, id, true, '1')).json.code).toBe('receipt_not_in_doubt')
    })

    it('of a correction and a storno\'s claim one gives way: corrected first, the storno cites the correction', async () => {
      const w = await tillWorld(app)
      const { id, onTheSlip } = await settled(w, '2')
      const undo = during(update => update?.$set?.['register.stornoState'] === 'full', async () => {
        expect((await settle(w, id, true, onTheSlip)).status).toBe(200)
      })
      let r: any
      try {
        r = await w.storno(id)
      } finally {
        undo()
      }

      expect(r.status).toBe(200)
      expect(closedOnDevice(w).at(-1)!.header[5]).toBe(onTheSlip)
    })

    it('claimed first, the correction is refused, and the storno cites what it read', async () => {
      const w = await tillWorld(app)
      const { id, onTheSlip } = await settled(w, '2')
      let inside: any
      const undo = during(update => !!update?.$set?.['register.settled.receiptNumber'], async () => {
        inside = await w.storno(id)
      })
      let r: any
      try {
        r = await settle(w, id, true, onTheSlip)
      } finally {
        undo()
      }

      expect(inside.status).toBe(200)
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('receipt_number_cited')
      expect((await fields(id)).number).toBe('2')
      expect(closedOnDevice(w).at(-1)!.header[5]).toBe('2')
    })

    it('a settle that stopped halfway: corrected, and the same answer finishes it', async () => {
      const w = await tillWorld(app)
      const s = await settleable(w)
      await Invoice.updateOne({ _id: s.id }, { $unset: { completedAt: 1 } })
      const undo = during(update => !!update?.$set?.completedAt, async () => { throw new Error('the pod went away') })
      try {
        expect((await settle(w, s.id, true, '1')).status).toBe(500)
      } finally {
        undo()
      }
      await Invoice.updateOne({ _id: s.id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })

      expect((await settle(w, s.id, true, s.onTheSlip)).status).toBe(200)

      const done = await read(s.id)
      expect(done.register.fiscalReceiptNumber).toBe(s.onTheSlip)
      expect(done.completedAt).toBeTruthy()
    })
  })
})

describe('the route: the document\'s own device (finding 1)', () => {
  describe('with the device on another pod, this one holding the warehouse\'s other', () => {
    const forwarded: { to: string; path: string }[] = []
    let reachable = true
    beforeEach(() => {
      setFiscalForwarding({
        async forward(to, request) {
          forwarded.push({ to, path: new URL(request.url).pathname })
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

    /** A sale in doubt on a second device, whose till is on pod B. The device this process holds is the warehouse's other. */
    async function heldOnPodB(w: TillWorld) {
      const held = await sale(w)
      const other = await createTestFiscalDevice(w.oid, w.warehouse._id, { name: 'Second', deviceNumber: 'ED654321', manufacturer: 'eltrade', connectionType: 'browser', status: 'online' } as any)
      await Invoice.updateOne({ _id: held.id }, { $set: { 'register.fiscalDeviceNumber': 'ED654321' } })
      const now = new Date()
      await FiscalPresence.create({
        orgId: w.orgId, deviceNumber: 'ED654321', deviceId: String(other._id), kind: 'user', label: 'Till on B', podId: 'pod-b', podAddr: 'http://10.0.0.2:4001', connId: 'conn-b', connectedAt: now, heartbeatAt: now,
      } as any)
      return held
    }

    it('it runs where its own device is: hopped there, its answer is this answer, and nothing is written here', async () => {
      const w = await tillWorld(app)
      const held = await heldOnPodB(w)
      const before = await everything(w, held.id)

      const r = await settle(w, held.id, false)

      expect(r).toEqual({ status: 200, json: { from: 'pod-b' } })
      expect(forwarded).toEqual([{ to: 'http://10.0.0.2:4001', path: `/org/${w.orgId}/cash-register/documents/${held.id}/settle` }])
      expect(await everything(w, held.id)).toEqual(before)
    })

    it('that pod unreachable: 503, nothing written, and never the word', async () => {
      const w = await tillWorld(app)
      const held = await heldOnPodB(w)
      reachable = false
      const before = await everything(w, held.id)

      const r = await settle(w, held.id, false)

      expect(r.status).toBe(503)
      expect(r.json.code).toBe('fiscal_holder_unreachable')
      expect(await everything(w, held.id)).toEqual(before)
    })
  })

  it('by the number on the document, never its warehouse\'s, where a warehouse holds two', async () => {
    const w = await tillWorld(app)
    const held = await sale(w)
    const other = await createTestFiscalDevice(w.oid, w.warehouse._id, { name: 'Second', deviceNumber: 'ED654321', manufacturer: 'eltrade', connectionType: 'browser', status: 'online' } as any)
    // Printed on the second, whose till is on another pod: the warehouse finds the one this process holds.
    await Invoice.updateOne({ _id: held.id }, { $set: { 'register.fiscalDeviceNumber': 'ED654321' } })
    const ctx = { params: { orgId: w.orgId, id: held.id }, user: { id: String(w.user._id) }, body: {} }

    expect(await deviceFromSettledDocument(ctx)).toEqual({ orgId: w.orgId, deviceId: String(other._id), deviceNumber: 'ED654321' })
    // The storno's route stays the warehouse's, and that is why the settle door has its own.
    expect((await deviceFromJournalDocument(ctx))?.deviceNumber).toBe('ED123456')
  })

  it('names nothing for a deactivated device, a text document, or one with no number: they run where they are', async () => {
    const w = await tillWorld(app)
    const held = await sale(w)
    const ctx = { params: { orgId: w.orgId, id: held.id }, user: { id: String(w.user._id) }, body: {} }
    expect(await deviceFromSettledDocument(ctx)).toEqual({ orgId: w.orgId, deviceId: w.deviceId, deviceNumber: 'ED123456' })

    await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { isActive: false } })
    expect(await deviceFromSettledDocument(ctx)).toBeNull()
    await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { isActive: true } })

    await Invoice.updateOne({ _id: held.id }, { $set: { 'register.isFiscal': false } })
    expect(await deviceFromSettledDocument(ctx)).toBeNull()
    await Invoice.updateOne({ _id: held.id }, { $set: { 'register.isFiscal': true }, $unset: { 'register.fiscalDeviceNumber': 1 } })
    expect(await deviceFromSettledDocument(ctx)).toBeNull()
    expect(await deviceFromSettledDocument({ ...ctx, params: { orgId: w.orgId, id: 'not-an-id' } })).toBeNull()
  })
})
