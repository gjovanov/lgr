import { describe, it, expect, beforeAll, afterAll, afterEach, spyOn } from 'bun:test'
import { Elysia } from 'elysia'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import { gate, sessionOf, until } from '../helpers/receipt-world'
import { AuditLog, FiscalDevice, Invoice, POSSession, StockMovement } from 'db/models'
import { getPrinter } from 'fiscal/fiscal-device.service'
import { contactController } from 'invoicing-api/src/controllers/contact.controller'
import { invoiceExportController } from 'invoicing-api/src/controllers/invoice-export.controller'
import { reportById, validateParams } from 'services/biz/report-registry'
import { buildDailyDigest } from 'services/biz/digest/daily-digest.service'
import { getContactLedger } from 'services/biz/contact-ledger.service'
import { getInvoiceSummary } from 'services/biz/invoice-summary.service'
import { getProductLedger } from 'services/biz/product-ledger.service'
import { buildSessionReport } from 'services/biz/cash-register/session-report'
import { listJournal } from 'services/biz/cash-register/journal.service'
import { unfinishedRefusal } from 'services/biz/cash-register/payment-receipt.service'
import { loadPosRows } from 'services/biz/cash-register/pos-union'
import { exportCancelledSales, exportPaymentDetails, exportReversedSales } from 'services/biz/supto-export.service'
import { postPosSessionJournal } from 'services/events/handlers'
import { createTestContact, createTestFiscalDevice } from '../helpers/factories'
import { EltradeSimulator } from '../helpers/eltrade-simulator'
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import ExcelJS from 'exceljs'

/**
 * FR-23, the second review's finding 1: `unknown` means a person must look at the device. A storno
 * that may have printed is neither voided nor booked: it keeps its claim on the sale and is held, and
 * pressing again prints nothing. Voided and given back, the next press printed a second fiscal storno.
 *
 * Every one of these runs through the real routes on the simulator. The first half of the file was
 * reproduced on the code before this fix: two stornos on the device, one refund in LGR.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = tillApp().use(contactController).use(invoiceExportController) as any
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { forgetDevices(); await clearCollections() }, 30_000)

const CLOSE = 0x38
const PAYMENT = 0x35
const LINE = 0x31

const settle = (w: TillWorld, id: string, printed: boolean, as?: string, receiptNumber?: string) =>
  w.call('POST', `/cash-register/documents/${id}/settle`, { printed, ...(receiptNumber ? { receiptNumber } : {}) }, undefined, as)
const stornoOf = (w: TillWorld): Promise<any> => Invoice.findOne({ type: 'cash_storno', orgId: w.oid }).sort({ _id: -1 }).lean().exec()
const read = (id: unknown): Promise<any> => Invoice.findById(id).lean().exec()
const stornosOnDevice = (w: TillWorld) => w.sim!.receipts.filter(r => r.kind === 'storno' && !r.voided)

/**
 * A sale of 12, and its storno printed on the device with the answer lost and the line gone: the case
 * that used to read as not printed. The line comes back after it.
 */
async function held(w: TillWorld, key?: string) {
  const sale = await w.sell(1)
  expect(sale.status).toBe(200)
  const saleId = String(sale.json.transaction.id)
  w.sim!.dropAfter = CLOSE
  const answer = await w.storno(saleId, key)
  w.sim!.disconnected = false
  return { saleId, answer, storno: await stornoOf(w) }
}

describe('a storno that may have printed is held, not voided (finding 1)', () => {
  it('the close went through and the line dropped: the answer says so, and nothing moved', async () => {
    const w = await tillWorld(app)
    const { saleId, answer, storno } = await held(w)

    expect(answer.status).toBe(409)
    expect(answer.json.code).toBe('storno_in_doubt')
    expect(answer.json.message).toContain('may have printed')
    expect(answer.json.message).toContain('nothing was reversed')
    expect(answer.json.message).toContain('Do not press storno again')
    expect(answer.json.message).not.toContain('was not printed')
    expect(answer.json.receipt).toEqual({ id: String(storno._id), number: storno.invoiceNumber })

    expect(storno.status).toBe('paid')
    expect(storno.register.fiscal).toMatchObject({ state: 'unknown', inDoubt: true })
    expect(storno.completedAt).toBeUndefined()
    expect(storno.register.sessionTotalsApplied).toBeFalsy()
    expect(await StockMovement.countDocuments({ orgId: w.oid, invoiceId: storno._id })).toBe(0)
    // Its claim stands.
    const sale = await read(saleId)
    expect(sale.register.stornoState).toBe('full')
    expect(sale.register.stornoedBy.map(String)).toEqual([String(storno._id)])
    // No refund, no stock, no session totals.
    expect(await sessionOf(w)).toMatchObject({ totalCash: 12, totalReturns: 0 })
    expect((await w.stock()).quantity).toBe(9)
    expect(stornosOnDevice(w)).toHaveLength(1)
  })

  it('a second press is refused and says the same, and prints nothing more: a new key, and the same one', async () => {
    const w = await tillWorld(app)
    const { saleId, storno } = await held(w, 'storno-first-press')
    const commands = w.sim!.executed.length

    const newKey = await w.storno(saleId, 'storno-second-press')
    const sameKey = await w.storno(saleId, 'storno-first-press')
    const noKey = await w.storno(saleId)
    const journal = await w.call('POST', `/cash-register/documents/${saleId}/storno`, { reason: 'customer_return', sessionId: w.sessionId })

    for (const r of [newKey, sameKey, noKey, journal]) {
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('storno_in_doubt')
      expect(r.json.receipt.id).toBe(String(storno._id))
    }
    expect(w.sim!.executed.slice(commands).filter(c => c.cmd === 0x90 || c.cmd === CLOSE)).toHaveLength(0)
    expect(stornosOnDevice(w)).toHaveLength(1)
    expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_storno' })).toBe(1)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 12, totalReturns: 0 })
  })

  it('the same key, twice in a row: a held storno takes no lease to leave behind, so the retry is not told to wait', async () => {
    const w = await tillWorld(app)
    const { saleId } = await held(w, 'storno-twice-press')

    expect((await w.storno(saleId, 'storno-twice-press')).json.code).toBe('storno_in_doubt')
    const started = Date.now()
    expect((await w.storno(saleId, 'storno-twice-press')).json.code).toBe('storno_in_doubt')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('a dead storno a keyed retry finds: the counter moved, which proves nothing, and it is held', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    const saleId = String(sale.json.transaction.id)
    const key = 'storno-died-0001'
    // It printed, and the process died before its answer: the document says only that it started.
    w.sim!.dropAfter = CLOSE
    await w.storno(saleId, key)
    w.sim!.disconnected = false
    const dead = await stornoOf(w)
    await Invoice.updateOne({ _id: dead._id }, {
      $set: { 'register.fiscal': { state: 'pending', mode: 'fiscal', attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber - 1 }, leaseUntil: new Date(Date.now() - 1000) },
      $unset: { 'register.receiptError': 1 },
    })

    const r = await w.storno(saleId, key)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('storno_in_doubt')
    expect((await read(dead._id)).register.fiscal.inDoubt).toBe(true)
    expect(stornosOnDevice(w)).toHaveLength(1)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 12, totalReturns: 0 })
  })

  it('a dead storno a new press finds: finished first, and what it finds is held', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    const saleId = String(sale.json.transaction.id)
    w.sim!.dropAfter = CLOSE
    await w.storno(saleId)
    w.sim!.disconnected = false
    const dead = await stornoOf(w)
    await Invoice.updateOne({ _id: dead._id }, {
      $set: { 'register.fiscal': { state: 'pending', mode: 'fiscal', attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber - 1 }, leaseUntil: new Date(Date.now() - 1000) },
    })
    const commands = w.sim!.executed.length

    const r = await w.storno(saleId, 'storno-another-press')

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('storno_in_doubt')
    expect(w.sim!.executed.slice(commands).filter(c => c.cmd === 0x90)).toHaveLength(0)
  })

  it('one proved never to have reached the device gives the sale back to the press that finds it, which prints once', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    const saleId = String(sale.json.transaction.id)
    // A storno that died after its claim and before its print.
    const dead: any = await Invoice.create({
      orgId: w.oid, invoiceNumber: 'CS-DIED-0001', type: 'cash_storno', direction: 'outgoing', status: 'paid',
      issueDate: new Date(), dueDate: new Date(), currency: 'EUR', exchangeRate: 1, total: 12,
      lines: [{ description: 'x', quantity: 1, unit: 'бр.', unitPrice: 10, taxRate: 20, taxAmount: 2, lineTotal: 12 }],
      billingAddress: { street: '-' }, relatedInvoiceId: saleId, createdBy: w.user._id, leaseUntil: new Date(Date.now() - 1000),
      register: { origin: 'pos', sessionId: w.sessionId, fiscalDeviceNumber: 'ED123456', isFiscal: true, fiscal: { state: 'pending', mode: 'fiscal' } },
    })
    await Invoice.updateOne({ _id: saleId }, { $set: { 'register.stornoState': 'full' }, $push: { 'register.stornoedBy': dead._id } })

    const r = await w.storno(saleId, 'storno-after-the-dead')

    expect(r.status).toBe(200)
    expect((await read(dead._id)).status).toBe('voided')
    expect(stornosOnDevice(w)).toHaveLength(1)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 12 })
  })

  it('a storno with no key has a lease too: it is how a dead one is found', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    const held = gate()
    w.sim!.beforeCommand = cmd => (cmd === 0x90 ? held.closed : undefined)
    const stornoing = w.storno(String(sale.json.transaction.id))
    await until(async () => (await stornoOf(w))?.register?.fiscal?.attemptedAt, 'the storno to reach the device')

    expect((await stornoOf(w)).leaseUntil).toBeTruthy()

    w.sim!.beforeCommand = null
    held.open()
    expect((await stornoing).status).toBe(200)
    expect((await stornoOf(w)).leaseUntil).toBeUndefined()
  })

  it('a retry goes back to the device it started on: with two in the warehouse no other counter says anything', async () => {
    const w = await tillWorld(app)
    // The warehouse finds this one first, and the storno started on the other.
    const second = await createTestFiscalDevice(w.oid, w.warehouse._id, { name: 'Second', deviceNumber: 'ED654321', manufacturer: 'eltrade', connectionType: 'browser', status: 'online' } as any)
    const sim = new EltradeSimulator()
    sim.serial = 'ED654321'
    sim.lastDocNumber = 500
    registerPrinter(String(second._id), new EltradeFiscalPrinter(sim.exchange, String(second._id)))
    try {
      const sale = await w.sell(1)
      const saleId = String(sale.json.transaction.id)
      const key = 'storno-own-device'
      expect((await w.storno(saleId, key)).status).toBe(200)
      const storno = await stornoOf(w)
      expect(storno.register.fiscalDeviceNumber).toBe('ED654321')
      const others = sim.receipts.filter(r => r.kind === 'storno').length
      // As the process died before its print on the world's own device, whose counter did not move.
      await Invoice.updateOne({ _id: storno._id }, {
        $set: {
          'register.fiscalDeviceNumber': 'ED123456', 'register.unp': 'ED123456-0001-0000001', 'register.storno.originalUnp': 'ED123456-0001-0000001',
          'register.fiscal': { state: 'pending', mode: 'fiscal', attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber },
          leaseUntil: new Date(Date.now() - 1000),
        },
        $unset: { completedAt: 1, 'register.sessionTotalsApplied': 1, 'register.movementId': 1, 'register.fiscalReceiptNumber': 1 },
      })

      const r = await w.storno(saleId, key)

      // The proof holds on its own device, so it prints there. Read on the other it could only be held.
      expect(r.status).toBe(200)
      expect(w.sim!.receipts.filter(x => x.kind === 'storno')).toHaveLength(1)
      expect(sim.receipts.filter(x => x.kind === 'storno')).toHaveLength(others)
    } finally {
      unregisterPrinter(String(second._id))
    }
  })

  it('a lapsed lease frees nothing: the claim is on the sale and has none, and no new storno takes it', async () => {
    const w = await tillWorld(app)
    const { saleId, storno } = await held(w, 'storno-lease-press')
    await Invoice.updateOne({ _id: storno._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })

    const r = await w.storno(saleId, 'storno-after-the-lease')

    expect(r.json.code).toBe('storno_in_doubt')
    const sale = await read(saleId)
    expect(sale.register.stornoState).toBe('full')
    expect(sale.register.stornoedBy.map(String)).toEqual([String(storno._id)])
    expect((await read(storno._id)).register.fiscal.inDoubt).toBe(true)
    expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_storno' })).toBe(1)
  })

  it('no printer on a resume, never started: it never printed, so it is failed and the sale is free', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    const saleId = String(sale.json.transaction.id)
    w.sim!.dropAfter = 0x90
    const key = 'storno-never-started'
    await w.storno(saleId, key)
    w.sim!.disconnected = false
    const first = await stornoOf(w)
    // As the process died right after its insert.
    await Invoice.updateOne({ _id: first._id }, {
      $set: { status: 'paid', 'register.fiscal': { state: 'pending', mode: 'fiscal' }, leaseUntil: new Date(Date.now() - 1000), 'register.stornoState': undefined },
      $unset: { completedAt: 1, 'register.receiptError': 1 },
    })
    await Invoice.updateOne({ _id: saleId }, { $set: { 'register.stornoState': 'full' }, $addToSet: { 'register.stornoedBy': first._id } })
    forgetDevices()
    await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { status: 'online' } })

    const r = await w.storno(saleId, key)

    expect(r.status).toBe(503)
    expect(r.json.code).toBe('fiscal_error')
    expect((await read(first._id)).status).toBe('voided')
    expect((await read(saleId)).register.stornoState).toBe('none')
    expect(await sessionOf(w)).toMatchObject({ totalCash: 12, totalReturns: 0 })
  })

  it('no printer on a resume, started: it may be on the device, so it is held and the sale stays claimed', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    const saleId = String(sale.json.transaction.id)
    w.sim!.dropAfter = CLOSE
    const key = 'storno-started-died'
    await w.storno(saleId, key)
    w.sim!.disconnected = false
    const first = await stornoOf(w)
    await Invoice.updateOne({ _id: first._id }, {
      $set: { 'register.fiscal': { state: 'pending', mode: 'fiscal', attemptedAt: new Date(), counterBefore: 1 }, leaseUntil: new Date(Date.now() - 1000) },
    })
    forgetDevices()
    await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { status: 'online' } })

    const r = await w.storno(saleId, key)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('storno_in_doubt')
    expect((await read(first._id)).register.fiscal).toMatchObject({ state: 'unknown', inDoubt: true })
    expect((await read(saleId)).register.stornoState).toBe('full')
  })

  it('a device in error on a resume proves nothing either: no refusal of the retry, and it is held', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    const saleId = String(sale.json.transaction.id)
    w.sim!.dropAfter = CLOSE
    const key = 'storno-device-error'
    await w.storno(saleId, key)
    w.sim!.disconnected = false
    const first = await stornoOf(w)
    await Invoice.updateOne({ _id: first._id }, {
      $set: { 'register.fiscal': { state: 'pending', mode: 'fiscal', attemptedAt: new Date(), counterBefore: 1 }, leaseUntil: new Date(Date.now() - 1000) },
    })
    forgetDevices()
    await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { status: 'error' } })

    const r = await w.storno(saleId, key)

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('storno_in_doubt')
  })

  it('the line drops at the payment, the money on the device and nothing closed: it may yet print, and it is held', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    const saleId = String(sale.json.transaction.id)
    w.sim!.beforeCommand = cmd => { if (cmd === PAYMENT) w.sim!.disconnected = true }
    const r = await w.storno(saleId)
    w.sim!.beforeCommand = null
    w.sim!.disconnected = false

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('storno_in_doubt')
    expect(stornosOnDevice(w)).toHaveLength(0)
    expect(w.sim!.receipt?.payments).toHaveLength(1)
  })
})

describe('a person settles a storno in doubt (finding 1)', () => {
  it('it printed: the rest runs with no device, the refund leaves the session, the goods come back, and it says who said so', async () => {
    const w = await tillWorld(app)
    const { saleId, storno } = await held(w)
    forgetDevices()

    const answer = await settle(w, String(storno._id), true)

    expect(answer.status).toBe(200)
    expect(answer.json.document.row.fiscal.state).toBe('printed')
    expect(answer.json.document.row.status).toBe('completed')
    const after = await read(storno._id)
    expect(after.register.fiscal.inDoubt).toBeFalsy()
    expect(after.register.settled).toMatchObject({ printed: true, by: w.user._id })
    expect(after.completedAt).toBeTruthy()
    expect(after.status).toBe('paid')
    expect((await read(saleId)).register.stornoState).toBe('full')
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 12 })
    expect((await w.stock()).quantity).toBe(10)
    const audit: any = await AuditLog.findOne({ orgId: w.oid, action: 'settle_receipt' }).lean().exec()
    expect(String(audit.entityId)).toBe(String(storno._id))
    expect(stornosOnDevice(w)).toHaveLength(1)
  })

  /** The line drops after the last sale line: no money on the device, its receipt open, `unknown`. */
  async function heldBeforeItsMoney(w: TillWorld) {
    const sale = await w.sell(1)
    const saleId = String(sale.json.transaction.id)
    w.sim!.beforeCommand = cmd => { if (cmd === LINE) w.sim!.disconnected = true }
    const first = await w.storno(saleId)
    w.sim!.beforeCommand = null
    w.sim!.disconnected = false
    expect(first.json.code).toBe('storno_in_doubt')
    return { saleId, storno: await stornoOf(w) }
  }

  it('the device still holds its receipt open: nothing is final, either way, until it is cleared', async () => {
    const w = await tillWorld(app)
    const { storno } = await heldBeforeItsMoney(w)
    expect(w.sim!.receipt).not.toBeNull()

    for (const printed of [true, false]) {
      const r = await settle(w, String(storno._id), printed)
      expect(r.status).toBe(409)
      expect(r.json.code).toBe('receipt_open_on_device')
    }
    const still = await read(storno._id)
    expect(still.register.fiscal.inDoubt).toBe(true)
    expect(still.register.settled).toBeUndefined()

    await getPrinter(w.deviceId).printDailyXReport()

    expect(w.sim!.receipt).toBeNull()
    expect((await settle(w, String(storno._id), false)).status).toBe(200)
  })

  it('its money was on the device: the X report finishes it, which is a real storno, and printed is the answer', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    const saleId = String(sale.json.transaction.id)
    w.sim!.beforeCommand = cmd => { if (cmd === PAYMENT) w.sim!.disconnected = true }
    await w.storno(saleId)
    w.sim!.beforeCommand = null
    w.sim!.disconnected = false
    const storno = await stornoOf(w)

    expect((await settle(w, String(storno._id), false)).json.code).toBe('receipt_open_on_device')
    await getPrinter(w.deviceId).printDailyXReport()
    expect(stornosOnDevice(w)).toHaveLength(1)

    expect((await settle(w, String(storno._id), true)).status).toBe(200)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 12 })
    expect(stornosOnDevice(w)).toHaveLength(1)
  })

  it('a device that is not here says nothing, and the person\'s word stands', async () => {
    const w = await tillWorld(app)
    const { storno } = await heldBeforeItsMoney(w)
    forgetDevices()
    await FiscalDevice.updateOne({ _id: w.deviceId }, { $set: { status: 'online' } })

    expect((await settle(w, String(storno._id), false)).status).toBe(200)
  })

  it('it did not: voided with its number, the sale given back, and the next press prints the one storno', async () => {
    const w = await tillWorld(app)
    const { saleId, storno } = await heldBeforeItsMoney(w)
    await getPrinter(w.deviceId).printDailyXReport()

    expect((await settle(w, String(storno._id), false)).status).toBe(200)

    const after = await read(storno._id)
    expect(after.status).toBe('voided')
    expect(after.invoiceNumber).toBe(storno.invoiceNumber)
    expect(after.register.settled).toMatchObject({ printed: false })
    expect(after.completedAt).toBeTruthy()
    const given = await read(saleId)
    expect(given.register.stornoState).toBe('none')
    expect(given.register.stornoedBy).toHaveLength(0)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 12, totalReturns: 0 })
    expect((await w.stock()).quantity).toBe(9)

    const again = await w.storno(saleId)
    expect(again.status).toBe(200)
    expect(stornosOnDevice(w)).toHaveLength(1)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 12 })
  })

  it('a second settle is harmless: the same answer changes nothing, the opposite is refused', async () => {
    const w = await tillWorld(app)
    const { storno } = await held(w)
    expect((await settle(w, String(storno._id), true)).status).toBe(200)

    const same = await settle(w, String(storno._id), true)
    const opposite = await settle(w, String(storno._id), false)

    expect(same.status).toBe(409)
    expect(same.json.code).toBe('receipt_not_in_doubt')
    expect(opposite.status).toBe(409)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 12 })
    expect((await w.stock()).quantity).toBe(10)
    expect(await AuditLog.countDocuments({ orgId: w.oid, action: 'settle_receipt' })).toBe(1)
  })

  it('only a manager or an admin, as for a storno', async () => {
    const w = await tillWorld(app)
    const { storno } = await held(w)
    const sales = await w.tokenAs('sales')

    const r = await settle(w, String(storno._id), true, sales)

    expect(r.status).toBe(403)
    expect((await read(storno._id)).register.fiscal.inDoubt).toBe(true)
  })

  it('a crash between the claim and the booking: the next press finishes it with no device, and books it once', async () => {
    const w = await tillWorld(app)
    const { saleId, storno } = await held(w)
    const dies = spyOn(Invoice, 'startSession').mockImplementationOnce(() => { throw new Error('the pod went away') })

    expect((await settle(w, String(storno._id), true)).status).toBe(500)

    dies.mockRestore()
    const stopped = await read(storno._id)
    expect(stopped.register.settled).toMatchObject({ printed: true })
    expect(stopped.completedAt).toBeUndefined()
    expect(stopped.leaseUntil).toBeTruthy()
    expect(await sessionOf(w)).toMatchObject({ totalCash: 12, totalReturns: 0 })

    await Invoice.updateOne({ _id: storno._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })
    forgetDevices()
    const next = await w.storno(saleId, 'storno-after-the-crash')

    expect(next.status).toBe(400)
    expect((await read(storno._id)).completedAt).toBeTruthy()
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 12 })
    expect((await w.stock()).quantity).toBe(10)
  })

  it('a crash after "not printed": the close finishes it, and the sale is given back', async () => {
    const w = await tillWorld(app)
    const { saleId, storno } = await held(w)
    const dies = spyOn(Invoice, 'updateOne').mockImplementationOnce(() => { throw new Error('the pod went away') })

    expect((await settle(w, String(storno._id), false)).status).toBe(500)

    dies.mockRestore()
    expect((await read(saleId)).register.stornoState).toBe('full')
    await Invoice.updateOne({ _id: storno._id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } })
    forgetDevices()

    const closed = await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 112 }, closeWithoutFiscal: true })

    expect(closed.status).toBe(200)
    expect((await read(storno._id)).status).toBe('voided')
    expect((await read(saleId)).register.stornoState).toBe('none')
  })
})

describe('a session and its stornos in doubt (finding 1)', () => {
  it('the close is refused before any Z, and the preview says so; settled, it closes', async () => {
    const w = await tillWorld(app)
    const { storno } = await held(w)
    const preview = await w.call('GET', `/trade/pos/session/${w.sessionId}/close-preview`)
    expect(preview.json.unfinishedReceipts).toEqual([
      expect.objectContaining({ id: String(storno._id), number: storno.invoiceNumber, inDoubt: true, kind: 'storno' }),
    ])
    // It counts nothing in the figures the close shows.
    expect(preview.json.report.counts).toMatchObject({ sales: 1, stornos: 0, voided: 0 })
    expect(preview.json.report.total).toBe(12)

    const refused = await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 112 } })

    expect(refused.status).toBe(409)
    expect(refused.json.code).toBe('receipts_unfinished')
    expect(refused.json.receipts[0]).toMatchObject({ id: String(storno._id), inDoubt: true, kind: 'storno' })
    expect(w.sim!.reports).toHaveLength(0)
    expect((await POSSession.findById(w.sessionId).lean().exec() as any).status).toBe('open')

    expect((await settle(w, String(storno._id), true)).status).toBe(200)
    expect((await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 100 } })).status).toBe(200)
    expect(w.sim!.reports).toHaveLength(1)
  })

  it('a dead storno on the session is finished by the close, and what it cannot prove holds it', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    w.sim!.dropAfter = CLOSE
    await w.storno(String(sale.json.transaction.id))
    w.sim!.disconnected = false
    const dead = await stornoOf(w)
    await Invoice.updateOne({ _id: dead._id }, {
      $set: { 'register.fiscal': { state: 'pending', mode: 'fiscal', attemptedAt: new Date(), counterBefore: w.sim!.lastDocNumber - 1 }, leaseUntil: new Date(Date.now() - 1000) },
    })

    const r = await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 112 } })

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('receipts_unfinished')
    expect((await read(dead._id)).register.fiscal.inDoubt).toBe(true)
  })

  it('a closing session takes no new storno: it finds the close in its turn, prints nothing and gives the sale back', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    const held = gate()
    let paused = false
    // A second sale holds the device; the storno waits its turn behind it.
    w.sim!.beforeCommand = cmd => { if (cmd === LINE && !paused) { paused = true; return held.closed } }
    const second = w.sell(1)
    await until(() => paused, 'the sale to hold the device')
    const stornoing = w.storno(String(sale.json.transaction.id))
    await until(async () => !!(await stornoOf(w)), 'the storno to wait its turn')
    await POSSession.updateOne({ _id: w.sessionId }, { $set: { status: 'closed' } })
    held.open()
    await second

    const r = await stornoing

    expect(r.status).toBe(503)
    expect((await stornoOf(w)).status).toBe('voided')
    expect((await read(sale.json.transaction.id)).register.stornoState).toBe('none')
    expect(stornosOnDevice(w)).toHaveLength(0)
  })

  it('one that arrived under its placeholder is named by its id, never as "for undefined"', () => {
    const refusal = unfinishedRefusal([{ _id: 'abc', type: 'cash_storno', invoiceNumber: '~pending:doc:x', register: { fiscal: { inDoubt: true } } }])
    expect(refusal.message).toContain('abc')
    expect(refusal.message).not.toContain('undefined')
    expect(refusal.receipts[0]).toMatchObject({ number: null, kind: 'storno', inDoubt: true })
  })

  it('a copied POS row with no finish of its own holds nothing', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    await Invoice.create({
      orgId: w.oid, invoiceNumber: 'TXN-OLD-1', type: 'cash_storno', direction: 'outgoing', status: 'paid',
      issueDate: new Date(), dueDate: new Date(), currency: 'EUR', exchangeRate: 1, total: 12,
      lines: [{ description: 'x', quantity: 1, unit: 'бр.', unitPrice: 10, taxRate: 20, taxAmount: 2, lineTotal: 12 }],
      billingAddress: { street: '-' }, relatedInvoiceId: sale.json.transaction.id, createdBy: w.user._id,
      register: { origin: 'pos', sessionId: w.sessionId, sessionTotalsApplied: true, legacy: { source: 'postransactions', type: 'storno', transactionNumber: 'TXN-OLD-1' } },
    })

    expect((await w.call('POST', `/trade/pos/session/${w.sessionId}/close`, { counted: { cash: 112 } })).status).toBe(200)
  })
})

describe('a sale that went unknown is refunded with no storno on the device: not any more (finding 4)', () => {
  /** A sale of 12 whose close went through with its answer lost and the line gone: `unknown`, no number. */
  async function saleInDoubt(w: TillWorld, key?: string) {
    w.sim!.dropAfter = CLOSE
    const r = await w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, w.saleBody(1), key)
    w.sim!.disconnected = false
    expect(r.status).toBe(200)
    expect(r.json.transaction.fiscal.state).toBe('unknown')
    expect(r.json.transaction.fiscalReceiptNumber).toBeUndefined()
    return String(r.json.transaction.id)
  }

  it('the door refuses it before the claim, and says what to do: nothing is left behind', async () => {
    const w = await tillWorld(app)
    const saleId = await saleInDoubt(w)

    const r = await w.storno(saleId)
    const journal = await w.call('POST', `/cash-register/documents/${saleId}/storno`, { reason: 'customer_return', sessionId: w.sessionId })

    for (const answer of [r, journal]) {
      expect(answer.status).toBe(409)
      expect(answer.json.code).toBe('sale_receipt_in_doubt')
      expect(answer.json.message).toContain('Check the device')
    }
    expect((await read(saleId)).register.stornoState).not.toBe('full')
    expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_storno' })).toBe(0)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 12, totalReturns: 0 })
    expect((await w.stock()).quantity).toBe(9)
    expect(w.sim!.receipts.filter(x => x.kind === 'storno')).toHaveLength(0)
  })

  it('a text sale prints nothing to reverse, and is unaffected', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1, { nonFiscal: true })
    await Invoice.updateOne({ _id: sale.json.transaction.id }, { $set: { 'register.fiscal.state': 'unknown' } })

    const r = await w.storno(sale.json.transaction.id)

    expect(r.status).toBe(200)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 12 })
  })

  it('it printed: the number off the slip goes on the sale, and the storno cites it', async () => {
    const w = await tillWorld(app)
    const saleId = await saleInDoubt(w)
    const onDevice = w.sim!.receipts.at(-1)!.number!

    const answer = await settle(w, saleId, true, undefined, onDevice)

    expect(answer.status).toBe(200)
    expect(answer.json.document.row.status).toBe('completed')
    const sale = await read(saleId)
    expect(sale.register.fiscal.state).toBe('printed')
    expect(sale.register.fiscalReceiptNumber).toBe(onDevice)
    expect(sale.register.receiptError).toBeUndefined()
    expect(sale.register.settled).toMatchObject({ printed: true, by: w.user._id, receiptNumber: onDevice })
    const audit: any = await AuditLog.findOne({ orgId: w.oid, action: 'settle_receipt' }).lean().exec()
    expect(String(audit.entityId)).toBe(saleId)
    expect(JSON.stringify(audit.changes)).toContain(onDevice)
    // Its money did not move: it stood already.
    expect(await sessionOf(w)).toMatchObject({ totalCash: 12 })

    const storno = await w.storno(saleId)
    expect(storno.status).toBe(200)
    const printed = w.sim!.receipts.filter(x => x.kind === 'storno' && !x.voided)
    expect(printed).toHaveLength(1)
    expect(printed[0].header[5]).toBe(onDevice)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 12 })
  })

  it('printed needs that number: no digits, no settling, whatever the driver would have said later', async () => {
    const w = await tillWorld(app)
    const saleId = await saleInDoubt(w)

    for (const typed of [undefined, '', 'ФБ-12', '12 34']) {
      const r = await settle(w, saleId, true, undefined, typed)
      expect(r.status).toBe(typed === undefined || typed === '' ? 422 : 422)
      expect(r.json.code).toBe('receipt_number_required')
    }
    expect((await read(saleId)).register.fiscal.state).toBe('unknown')
    expect((await read(saleId)).register.settled).toBeUndefined()
  })

  it('a number this device already gave another document is a slip misread', async () => {
    const w = await tillWorld(app)
    const other = await w.sell(1)
    const taken = other.json.transaction.fiscalReceiptNumber
    const saleId = await saleInDoubt(w)

    const r = await settle(w, saleId, true, undefined, String(Number(taken)))

    expect(r.status).toBe(422)
    expect(r.json.code).toBe('receipt_number_taken')
    expect((await read(saleId)).register.fiscal.state).toBe('unknown')
  })

  it('it did not: failed, the money stands, and its storno prints nothing, which is true', async () => {
    const w = await tillWorld(app)
    const saleId = await saleInDoubt(w)

    expect((await settle(w, saleId, false)).status).toBe(200)

    const sale = await read(saleId)
    expect(sale.register.fiscal.state).toBe('failed')
    expect(sale.register.settled).toMatchObject({ printed: false })
    expect(await sessionOf(w)).toMatchObject({ totalCash: 12 })
    const commands = w.sim!.executed.length

    const storno = await w.storno(saleId)

    expect(storno.status).toBe(200)
    expect(storno.json.transaction.isFiscal).toBe(false)
    expect(w.sim!.executed.slice(commands).filter(c => c.cmd === 0x90)).toHaveLength(0)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 12 })
    expect((await w.stock()).quantity).toBe(10)
  })

  it('a sale already finished is only told what happened: settling it moves nothing again', async () => {
    const w = await tillWorld(app)
    const saleId = await saleInDoubt(w)
    // A finished sale whose goods moved no movement it could find: only its steps running again would dispatch.
    await StockMovement.deleteMany({ orgId: w.oid, invoiceId: saleId })
    await Invoice.updateOne({ _id: saleId }, { $unset: { 'register.movementId': 1 } })
    const stock = await w.stock()

    expect((await settle(w, saleId, false)).status).toBe(200)

    expect(await StockMovement.countDocuments({ orgId: w.oid, invoiceId: saleId })).toBe(0)
    expect((await w.stock()).quantity).toBe(stock.quantity)
  })

  it('a sale that came into doubt as it was read: its number was never asked for, so it is not claimed', async () => {
    const w = await tillWorld(app)
    const saleId = await saleInDoubt(w)
    await Invoice.updateOne({ _id: saleId }, { $set: { 'register.fiscal.state': 'pending', leaseUntil: new Date(Date.now() + 60_000) } })
    // Its print ends as the settle reads it: `pending` and alive at the read, `unknown` at the claim.
    const real = Invoice.findOne
    let once = true
    ;(Invoice as any).findOne = function (...args: any[]) {
      const query = (real as any).apply(Invoice, args)
      if (!once || typeof args[0]?._id === 'string' || String(args[0]?._id) !== saleId || !args[0]?.type?.$in) return query
      once = false
      return { lean: () => ({ exec: async () => {
        const doc = await query.lean().exec()
        await Invoice.updateOne({ _id: saleId }, { $set: { 'register.fiscal.state': 'unknown' } })
        return doc
      } }) }
    }
    let r: any
    try {
      r = await settle(w, saleId, true)
    } finally {
      ;(Invoice as any).findOne = real
    }

    expect(r.status).toBe(409)
    expect(r.json.code).toBe('receipt_not_in_doubt')
    expect((await read(saleId)).register.fiscal.state).toBe('unknown')
  })

  it('the same rights as a storno, and a second settle changes nothing', async () => {
    const w = await tillWorld(app)
    const saleId = await saleInDoubt(w)
    const onDevice = w.sim!.receipts.at(-1)!.number!

    expect((await settle(w, saleId, true, await w.tokenAs('sales'), onDevice)).status).toBe(403)
    expect((await settle(w, saleId, true, undefined, onDevice)).status).toBe(200)

    const again = await settle(w, saleId, false)
    expect(again.status).toBe(409)
    expect(again.json.code).toBe('receipt_not_in_doubt')
    expect((await read(saleId)).register.fiscal.state).toBe('printed')
    expect(await AuditLog.countDocuments({ orgId: w.oid, action: 'settle_receipt' })).toBe(1)
  })

  it('the device still holds its receipt open: not final, for a sale either', async () => {
    const w = await tillWorld(app)
    w.sim!.beforeCommand = cmd => { if (cmd === PAYMENT) w.sim!.disconnected = true }
    const sold = await w.sell(1)
    w.sim!.beforeCommand = null
    w.sim!.disconnected = false
    expect(sold.json.transaction.fiscal.state).toBe('unknown')

    expect((await settle(w, sold.json.transaction.id, false)).json.code).toBe('receipt_open_on_device')
  })

  it('a sale whose request died, still pending: a storno is refused, and a person settling it finishes it', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    const saleId = String(sale.json.transaction.id)
    const onDevice = w.sim!.receipts.at(-1)!.number!
    await w.call('POST', `/trade/pos/session/${w.sessionId}/close-preview`).catch(() => undefined)
    await POSSession.updateOne({ _id: w.sessionId }, { $set: { totalCash: 0, totalSales: 0, transactionCount: 0 } })
    await Invoice.updateOne({ _id: saleId }, {
      $set: { 'register.fiscal': { state: 'pending', mode: 'fiscal', attemptedAt: new Date(), counterBefore: 1 }, leaseUntil: new Date(Date.now() - 1000) },
      $unset: { completedAt: 1, 'register.fiscalReceiptNumber': 1, 'register.sessionTotalsApplied': 1, 'register.movementId': 1, 'register.printedAt': 1 },
    })

    expect((await w.storno(saleId)).json.code).toBe('sale_receipt_in_doubt')

    const page = await listJournal({ orgId: w.orgId, kind: 'sale' })
    expect(page.rows[0]).toMatchObject({ status: 'inDoubt', fiscal: expect.objectContaining({ inDoubt: true }) })

    expect((await settle(w, saleId, true, undefined, onDevice)).status).toBe(200)

    const done = await read(saleId)
    expect(done.completedAt).toBeTruthy()
    expect(done.register.fiscalReceiptNumber).toBe(onDevice)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 12 })
  })

  it('one still printing, its lease alive, is no sale to reverse and nobody\'s to settle yet', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    const saleId = String(sale.json.transaction.id)
    await Invoice.updateOne({ _id: saleId }, {
      $set: { 'register.fiscal': { state: 'pending', mode: 'fiscal', attemptedAt: new Date(), counterBefore: 1 }, leaseUntil: new Date(Date.now() + 60_000) },
      $unset: { completedAt: 1, 'register.fiscalReceiptNumber': 1 },
    })

    expect((await w.storno(saleId)).status).toBe(409)
    expect((await settle(w, saleId, false)).json.code).toBe('receipt_not_in_doubt')
  })
})

describe('a storno in doubt counts nowhere until it is settled (finding 1)', () => {
  const report = (id: string, orgId: string, params: Record<string, any>) => {
    const entry = reportById(id)!
    return entry.handler!({ orgId, params: validateParams(entry, params), output: 'table' }) as Promise<any>
  }
  const around = () => {
    const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
    return { preset: 'custom', from: day(-1), to: day(1) }
  }
  const window = () => ({ dateFrom: new Date(Date.now() - 86_400_000), dateTo: new Date(Date.now() + 86_400_000) })

  /** What each reader says, on the world as it stands. Settled as printed, every one of them moves. */
  async function readings(w: TillWorld, contactId: string) {
    // The digest's day is the process's: noon of it, so that nothing here depends on the hour it runs.
    const now = new Date()
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const noon = new Date(`${date}T12:00:00`)
    await Invoice.updateMany({ orgId: w.oid }, { $set: { issueDate: noon, 'payments.$[].date': noon } })
    const digest: any = await buildDailyDigest(w.orgId, date)
    const history = await report('sales-history', w.orgId, { period: around(), includeNonRegister: true })
    const register = await report('cash-register', w.orgId, { period: around() })
    const ledger = await getContactLedger(w.orgId, contactId)
    const product: any = await getProductLedger(w.orgId, String(w.product._id))
    const summary = await getInvoiceSummary(w.orgId, {} as any)
    const rows = await loadPosRows({ orgId: w.orgId, sessionId: w.sessionId })
    const filters = { orgId: w.orgId, ...window() } as any
    const cellsOf = async () => {
      const res = await app.handle(new Request(`http://localhost/org/${w.orgId}/invoicing/export/kind/cash_register`, {
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
    const stornoNumber = (await stornoOf(w)).invoiceNumber
    return {
      digestCash: digest.kpis.cashTotal,
      digestPayments: digest.kpis.paymentsTotal,
      digestFamily: digest.documents.families?.find?.((f: any) => f.key === 'cash')?.total ?? digest.documents.cash?.total,
      history: history.rows.filter((r: any) => r.number === stornoNumber).length,
      historyCash: history.meta.summary[0].cash,
      register: register.rows.filter((r: any) => r.number === stornoNumber).length,
      ledgerSales: ledger.summary.totalSales,
      ledgerRows: ledger.entries.filter(e => e.documentNumber === stornoNumber).length,
      productSales: product.summary.totalCashRegisterSales,
      paid30d: summary.paid30d.amount,
      session: buildSessionReport({ sessionNumber: 'S', currency: 'EUR', openingBalance: 0 }, rows).total,
      suptoPayments: (await exportPaymentDetails(filters)).filter((t: any) => t.transactionNumber === stornoNumber).length,
      suptoReversed: (await exportReversedSales(filters)).length,
      suptoCancelled: (await exportCancelledSales(filters)).length,
      export: (await cellsOf()).includes(stornoNumber),
    }
  }

  it('every reader, held and then settled', async () => {
    const w = await tillWorld(app)
    const contact = await createTestContact(w.oid, { companyName: 'Клиент ООД', type: 'customer' } as any)
    const contactId = String(contact._id)
    const sale = await w.sell(1)
    const saleId = String(sale.json.transaction.id)
    await Invoice.updateOne({ _id: saleId }, { $set: { contactId: contact._id } })
    w.sim!.dropAfter = CLOSE
    expect((await w.storno(saleId)).json.code).toBe('storno_in_doubt')
    w.sim!.disconnected = false
    const storno = await stornoOf(w)
    await Invoice.updateOne({ _id: storno._id }, { $set: { contactId: contact._id } })

    expect(await readings(w, contactId)).toEqual({
      digestCash: 12,
      digestPayments: 12,
      digestFamily: 12,
      history: 0,
      historyCash: 12,
      register: 0,
      ledgerSales: 12,
      ledgerRows: 0,
      productSales: 12,
      paid30d: 12,
      session: 12,
      suptoPayments: 0,
      suptoReversed: 0,
      suptoCancelled: 0,
      export: false,
    })

    expect((await settle(w, String(storno._id), true)).status).toBe(200)

    expect(await readings(w, contactId)).toEqual({
      digestCash: 0,
      digestPayments: 24,
      digestFamily: 0,
      history: 1,
      historyCash: 0,
      register: 1,
      ledgerSales: 0,
      ledgerRows: 1,
      productSales: 0,
      paid30d: 0,
      session: 0,
      suptoPayments: 1,
      suptoReversed: 1,
      suptoCancelled: 1,
      export: true,
    })
  })

  it('the session\'s journal entry: posted over a held storno by any way round, it takes no refund', async () => {
    const w = await tillWorld(app)
    const { storno } = await held(w)
    const rows = await loadPosRows({ orgId: w.orgId, sessionId: w.sessionId })
    expect(rows.find(r => String(r._id) === String(storno._id))).toMatchObject({ type: 'storno', status: 'completed' })
    expect(typeof postPosSessionJournal).toBe('function')
    const report = buildSessionReport({ sessionNumber: 'S', currency: 'EUR', openingBalance: 0 }, rows)
    expect(report.byMethod.cash).toBe(12)
    expect(report.counts).toMatchObject({ sales: 1, stornos: 0, voided: 0 })
  })

  it('an old storno the old code voided as unknown stays what it was: listed, and voided', async () => {
    const w = await tillWorld(app)
    const sale = await w.sell(1)
    const old: any = await Invoice.create({
      orgId: w.oid, invoiceNumber: 'CS-OLD-0001', type: 'cash_storno', direction: 'outgoing', status: 'voided',
      issueDate: new Date(), dueDate: new Date(), currency: 'EUR', exchangeRate: 1, total: 12, completedAt: new Date(),
      lines: [{ description: 'x', quantity: 1, unit: 'бр.', unitPrice: 10, taxRate: 20, taxAmount: 2, lineTotal: 12 }],
      billingAddress: { street: '-' }, relatedInvoiceId: sale.json.transaction.id, createdBy: w.user._id,
      register: { origin: 'pos', sessionId: w.sessionId, isFiscal: true, fiscal: { state: 'unknown', mode: 'fiscal' } },
    })

    const register = await report('cash-register', w.orgId, { period: around() })
    expect(register.rows.some((r: any) => r.number === old.invoiceNumber)).toBe(true)
    const rows = await loadPosRows({ orgId: w.orgId, sessionId: w.sessionId })
    expect(buildSessionReport({ sessionNumber: 'S', currency: 'EUR', openingBalance: 0 }, rows).counts.voided).toBe(1)
    expect((await exportReversedSales({ orgId: w.orgId, ...window() } as any)).map((t: any) => t.transactionNumber)).toEqual([old.invoiceNumber])
    expect((await exportCancelledSales({ orgId: w.orgId, ...window() } as any)).map((t: any) => t.transactionNumber)).toEqual([old.invoiceNumber])
  })

  it('the journal lists it, says so, and offers the sale no storno', async () => {
    const w = await tillWorld(app)
    const { saleId, storno } = await held(w)

    const page = await listJournal({ orgId: w.orgId, kind: 'storno' })
    expect(page.rows[0]).toMatchObject({ id: String(storno._id), status: 'inDoubt', fiscal: expect.objectContaining({ state: 'unknown', inDoubt: true }) })
    const sale = (await w.call('GET', `/cash-register/documents/${saleId}`)).json
    expect(sale.row.status).toBe('stornoed')
    expect(sale.related[0]).toMatchObject({ id: String(storno._id), status: 'inDoubt' })
  })
})
