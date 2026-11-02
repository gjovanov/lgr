import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, reconnect, type TillWorld } from '../helpers/till-world'
import { draftOf, gate, pay, raw, receiptsOf, send, sessionOf } from '../helpers/receipt-world'
import { createTestFiscalDevice } from '../helpers/factories'
import { FiscalDevice, FiscalPresence, Invoice, POSSession } from 'db/models'
import { paymentReceiptDocument } from 'services/biz/cash-register/payment-receipt.service'
import { receiptBody } from 'services/biz/cash-register/receipt-lines'
import { POD_ID } from 'services/biz/fiscal-presence.service'
import { deviceFromJournalDocument, deviceFromSettledDocument } from 'fiscal/fiscal-route'
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

const settle = (w: TillWorld, id: unknown, printed: boolean, receiptNumber?: string) =>
  w.call('POST', `/cash-register/documents/${id}/settle`, { printed, ...(receiptNumber ? { receiptNumber } : {}) })
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

describe('the route: the document\'s own device (finding 1)', () => {
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
