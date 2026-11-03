import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import { sessionOf, until } from '../helpers/receipt-world'
import { Invoice, Sequence } from 'db/models'
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import { WsTremolFiscalPrinter } from 'fiscal/ws-tremol-printer'
import { WebSocketFiscalPrinter } from 'fiscal/ws-fiscal-printer'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * The prod sweep's D1 (#461): the till's „Нефискален" switch decided what a fiscal device printed. In a
 * fresh browser it started on, so a fiscal device printed a slip: 200, green, money and stock booked, and
 * the Z never saw it. Off on a device that is not fiscalized, the money and the stock were booked and the
 * print `failed`.
 *
 * The owner's rule for receipts is the till's now: the device decides, never a switch. Read fresh, in the
 * document's turn. Text only when the device's own status says `fiscalized === false`.
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

const FISCAL = [0x90, 0x31, 0x36, 0x35, 0x38]
const fiscalCommands = (w: TillWorld) => w.sim!.executed.filter(c => FISCAL.includes(c.cmd))
const textsClosed = (w: TillWorld) => w.sim!.executed.filter(c => c.cmd === 0x27).length
const docOf = (id: string) => Invoice.findById(id).lean().exec() as Promise<any>

/** A sale of one article, with `nonFiscal` as a tab sends it: an old tab, a new one, or none at all. */
function sale(w: TillWorld, nonFiscal?: boolean, key?: string) {
  const body = w.saleBody(1)
  return w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, nonFiscal === undefined ? body : { ...body, nonFiscal }, key)
}

async function aFiscalReceiptAndTheMoney(w: TillWorld, r: { status: number; json: any }) {
  expect(r.status).toBe(200)
  expect(r.json.receiptError).toBeUndefined()
  expect(r.json.transaction.fiscal).toMatchObject({ state: 'printed', mode: 'fiscal' })
  expect(r.json.transaction.unpNumber).toMatch(/^ED123456-0001-\d{7}$/)
  expect(w.sim!.receipts.filter(x => !x.voided)).toHaveLength(1)
  expect(textsClosed(w)).toBe(0)
  expect(await sessionOf(w)).toMatchObject({ totalCash: 12, totalSales: 12 })
  expect((await w.stock()).quantity).toBe(9)
}

async function aTextSlipAndTheMoney(w: TillWorld, r: { status: number; json: any }) {
  expect(r.status).toBe(200)
  expect(r.json.receiptError).toBeUndefined()
  expect(r.json.transaction.fiscal).toMatchObject({ state: 'printed', mode: 'text' })
  expect(r.json.transaction.unpNumber).toBeUndefined()
  expect(fiscalCommands(w)).toHaveLength(0)
  expect(textsClosed(w)).toBe(1)
  const doc = await docOf(r.json.transaction.id)
  expect(doc.register.isFiscal).toBe(false)
  expect(doc.register.unp).toBeUndefined()
  expect(await sessionOf(w)).toMatchObject({ totalCash: 12, totalSales: 12 })
  expect((await w.stock()).quantity).toBe(9)
  expect(await Sequence.countDocuments({ orgId: w.oid, prefix: /^UNP/ })).toBe(0)
}

describe('the device decides what a till sale prints (D1)', () => {
  describe('a fiscal device prints a fiscal receipt, whatever a tab sends', () => {
    it('a new tab, which sends nothing', async () => {
      const w = await tillWorld(app)
      await aFiscalReceiptAndTheMoney(w, await sale(w))
    })

    it('an old tab whose switch is on, as it is in a fresh browser: the sale the Z never saw', async () => {
      const w = await tillWorld(app)
      await aFiscalReceiptAndTheMoney(w, await sale(w, true))
    })

    it('an old tab whose switch is off', async () => {
      const w = await tillWorld(app)
      await aFiscalReceiptAndTheMoney(w, await sale(w, false))
    })
  })

  describe('a device that is not fiscalized prints a text slip, whatever a tab sends', () => {
    const theUnit = async () => {
      const w = await tillWorld(app)
      w.sim!.unfiscalizedUnit = true
      return w
    }

    it('a new tab, which sends nothing', async () => {
      const w = await theUnit()
      await aTextSlipAndTheMoney(w, await sale(w))
    })

    it('an old tab whose switch is off: money and stock booked and the print `failed`, until now', async () => {
      const w = await theUnit()
      await aTextSlipAndTheMoney(w, await sale(w, false))
    })

    it('an old tab whose switch is on', async () => {
      const w = await theUnit()
      await aTextSlipAndTheMoney(w, await sale(w, true))
    })
  })

  it('read fresh, in the turn: the same bridge, fiscalized by service, goes fiscal on its next sale', async () => {
    const w = await tillWorld(app)
    w.sim!.unfiscalizedUnit = true
    await aTextSlipAndTheMoney(w, await sale(w))

    w.sim!.unfiscalizedUnit = false
    const next = await sale(w)

    expect(next.json.transaction.fiscal).toMatchObject({ state: 'printed', mode: 'fiscal' })
    expect(w.sim!.receipts.filter(x => !x.voided)).toHaveLength(1)
  })

  it('in the turn, not at the door: a sale waiting behind another document asks when its turn comes', async () => {
    const w = await tillWorld(app)
    w.sim!.unfiscalizedUnit = true
    let open!: () => void
    const closed = new Promise<void>(r => { open = r })
    let first = true
    w.sim!.beforeCommand = cmd => { if (cmd === 0x27 && first) { first = false; return closed } }
    const ahead = sale(w, undefined, 'ahead-0001')
    await until(() => w.sim!.executed.some(c => c.cmd === 0x2A), 'the first slip to hold the device')
    const waiting = sale(w, undefined, 'waiting-0001')
    await until(async () => (await Invoice.countDocuments({ orgId: w.oid, clientKey: 'waiting-0001' })) === 1, 'the second sale to be written')

    w.sim!.unfiscalizedUnit = false
    open()
    await ahead
    const r = await waiting

    expect(r.json.transaction.fiscal).toMatchObject({ state: 'printed', mode: 'fiscal' })
    expect(r.json.transaction.unpNumber).toBeTruthy()
  })

  it('a device that does not report it never prints text', async () => {
    const w = await tillWorld(app)
    unregisterPrinter(w.deviceId)
    const printer = new EltradeFiscalPrinter(w.sim!.exchange, w.deviceId)
    const status = printer.getStatus.bind(printer)
    printer.getStatus = async () => { const s = await status(); delete (s as any).fiscalized; return s }
    registerPrinter(w.deviceId, printer)

    await aFiscalReceiptAndTheMoney(w, await sale(w, true))
  })

  it('a status read that fails is never "not fiscalized": no slip, a fiscal row as any print that cannot reach the device leaves, and the sale\'s money stands (D-4)', async () => {
    const w = await tillWorld(app)
    w.sim!.unfiscalizedUnit = true
    unregisterPrinter(w.deviceId)
    const printer = new EltradeFiscalPrinter(w.sim!.exchange, w.deviceId)
    printer.getStatus = async () => ({ connected: false, paperPresent: false, fiscalMemoryOk: false, errors: ['The device did not answer'] })
    registerPrinter(w.deviceId, printer)

    const r = await sale(w, true)

    expect(r.status).toBe(200)
    expect(r.json.transaction.fiscal.state).toBe('failed')
    expect(r.json.receiptError).toContain('did not answer')
    expect(textsClosed(w)).toBe(0)
    expect(fiscalCommands(w)).toHaveLength(0)
    expect(r.json.transaction.unpNumber).toMatch(/^ED123456-0001-\d{7}$/)
    expect(r.json.transaction.isFiscal).toBe(true)
    expect(await sessionOf(w)).toMatchObject({ totalCash: 12 })
    expect((await w.stock()).quantity).toBe(9)
  })

  describe('what a Tremol and a Datecs report: nothing, so they never print text', () => {
    it('a Tremol over its bridge says nothing about it', async () => {
      const printer = new WsTremolFiscalPrinter(async () => Buffer.from([0x06]), 'tremol-1') as any
      const status = await printer.getStatus()
      expect(status.connected).toBe(true)
      expect(status.fiscalized).toBeUndefined()
    })

    it('a Datecs over its bridge says nothing about it', async () => {
      const printer = new WebSocketFiscalPrinter(async () => { throw new Error('no answer') }, 'datecs-1') as any
      const status = await printer.getStatus()
      expect(status.fiscalized).toBeUndefined()
    })
  })

  describe('a storno stays what its sale was', () => {
    it('a fiscal sale\'s storno is a fiscal storno', async () => {
      const w = await tillWorld(app)
      const r = await sale(w)

      const back = await w.storno(r.json.transaction.id)

      expect(back.status).toBe(200)
      expect(w.sim!.receipts.filter(x => x.kind === 'storno')).toHaveLength(1)
      expect(back.json.transaction.fiscal).toMatchObject({ state: 'printed' })
    })

    /** All the slips the device printed, as one line of words: a slip wraps what it says at its width. */
    const slipWords = (w: TillWorld) => w.sim!.nonFiscalLines.join(' ').replace(/\s+/g, ' ')

    it('a text sale\'s storno prints a slip, nothing fiscal, on the device that printed it (#467)', async () => {
      const w = await tillWorld(app)
      w.sim!.unfiscalizedUnit = true
      const r = await sale(w)
      const sold = await docOf(r.json.transaction.id)

      const back = await w.storno(r.json.transaction.id)

      expect(back.status).toBe(200)
      expect(back.json.receiptError).toBeUndefined()
      expect(back.json.transaction.fiscal).toMatchObject({ state: 'printed', mode: 'text' })
      expect(fiscalCommands(w)).toHaveLength(0)
      expect(textsClosed(w)).toBe(2)
      // It says what it reverses, as a refund's storno does.
      expect(slipWords(w)).toContain(`Сторно на бон № ${sold.invoiceNumber}`)
      const storno = await docOf(back.json.transaction.id)
      expect(storno.register).toMatchObject({ isFiscal: false, receiptText: `Сторно на бон № ${sold.invoiceNumber}`, fiscalDeviceNumber: 'ED123456' })
      expect(storno.register.unp).toBeUndefined()
      expect(await Sequence.countDocuments({ orgId: w.oid, prefix: /^UNP/ })).toBe(0)
      expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 12 })
      // The session's report counts it among the slips. Printing nothing, it read as unprinted.
      const shown = await w.call('GET', `/trade/pos/session/${w.sessionId}/close-preview`)
      expect(shown.json.report.counts).toMatchObject({ text: 2, unprinted: 0 })
    })

    it('and on one fiscalized since: the device holds no record of that sale, so nothing fiscal cites it, nor a slip', async () => {
      const w = await tillWorld(app)
      w.sim!.unfiscalizedUnit = true
      const r = await sale(w)
      w.sim!.unfiscalizedUnit = false

      const back = await w.storno(r.json.transaction.id)

      expect(back.status).toBe(200)
      expect(fiscalCommands(w)).toHaveLength(0)
      // A fiscalized device never prints text.
      expect(textsClosed(w)).toBe(1)
      const storno = await docOf(back.json.transaction.id)
      expect(storno.register.fiscal).toMatchObject({ state: 'none' })
      expect(storno.register.fiscal.mode).toBeUndefined()
      expect(storno.register.receiptText ?? null).toBeNull()
      expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 12 })
    })

    it('with the device away, nothing prints and it goes through, as before: a slip has no legal weight', async () => {
      const w = await tillWorld(app)
      w.sim!.unfiscalizedUnit = true
      const r = await sale(w)
      forgetDevices()

      const back = await w.storno(r.json.transaction.id)

      expect(back.status).toBe(200)
      expect(textsClosed(w)).toBe(1)
      expect((await docOf(back.json.transaction.id)).register.fiscal).toMatchObject({ state: 'none' })
      expect(await sessionOf(w)).toMatchObject({ totalCash: 0, totalReturns: 12 })
    })

    it('a slip that does not print gives the sale back, and nothing is reversed', async () => {
      const w = await tillWorld(app)
      w.sim!.unfiscalizedUnit = true
      const r = await sale(w)
      w.sim!.paper = false

      const back = await w.storno(r.json.transaction.id)

      w.sim!.paper = true
      expect(back.status).toBe(503)
      expect(back.json.code).toBe('fiscal_error')
      const sold = await docOf(r.json.transaction.id)
      expect(sold.register.stornoState ?? 'none').toBe('none')
      expect(sold.register.stornoedBy ?? []).toHaveLength(0)
      expect(await sessionOf(w)).toMatchObject({ totalCash: 12, totalReturns: 0 })
      expect((await w.stock()).quantity).toBe(9)
      expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_storno', status: { $ne: 'voided' } })).toBe(0)
    })
  })

  describe('a sale that started, come back to with its key', () => {
    /** A sale its request left at `fiscal`, its lease lapsed, on the device it started on. */
    async function leftAt(w: TillWorld, key: string, body: any, fiscal: Record<string, unknown>, isFiscal: boolean) {
      const r = await w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, body, key)
      await Invoice.updateOne(
        { _id: r.json.transaction.id },
        {
          $set: { leaseUntil: new Date(Date.now() - 1000), 'register.fiscal': fiscal, 'register.isFiscal': isFiscal, 'register.sessionTotalsApplied': false },
          $unset: { completedAt: 1, 'register.movementId': 1, 'register.unp': 1, 'register.fiscalReceiptNumber': 1, 'register.printedAt': 1 },
        },
      )
      w.sim!.receipts = []
      w.sim!.executed = []
      return String(r.json.transaction.id)
    }

    it('one that started as text, on a device fiscalized since, prints what the device says now: a slip has no legal weight, and the Z must see it', async () => {
      const w = await tillWorld(app)
      w.sim!.unfiscalizedUnit = true
      const body = w.saleBody(1)
      const id = await leftAt(w, 'text-attempt', body, { state: 'pending', mode: 'text', attemptedAt: new Date() }, false)
      w.sim!.unfiscalizedUnit = false

      const r = await w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, body, 'text-attempt')

      expect(r.status).toBe(200)
      expect(r.json.transaction.fiscal).toMatchObject({ state: 'printed', mode: 'fiscal' })
      expect((await docOf(id)).register.isFiscal).toBe(true)
      expect(w.sim!.receipts.filter(x => !x.voided)).toHaveLength(1)
    })

    it('one that started fiscally stays fiscal, whatever the device says now: what it may have left there is not to be printed over', async () => {
      const w = await tillWorld(app)
      const body = w.saleBody(1)
      await leftAt(w, 'fiscal-attempt', body, { state: 'pending', mode: 'fiscal', attemptedAt: new Date(), counterBefore: 1 }, true)
      w.sim!.unfiscalizedUnit = true

      const r = await w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, body, 'fiscal-attempt')

      expect(r.status).toBe(200)
      expect(r.json.transaction.fiscal.state).toBe('unknown')
      expect(textsClosed(w)).toBe(0)
      expect(fiscalCommands(w)).toHaveLength(0)
    })
  })

  describe('who has no operator code', () => {
    const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
    const withNoCode = (w: TillWorld): Promise<string> => (signer as any).decorator.jwt.sign({
      id: String(w.user._id), orgId: w.orgId, role: 'admin', email: 'cashier@test.com', username: 'cashier',
      firstName: 'Иван', lastName: 'Петров', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
    })

    it('a text slip names no operator, so it goes through', async () => {
      const w = await tillWorld(app)
      w.sim!.unfiscalizedUnit = true
      const r = await w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, w.saleBody(1), undefined, await withNoCode(w))
      expect(r.status).toBe(200)
      expect(r.json.transaction.fiscal).toMatchObject({ state: 'printed', mode: 'text' })
    })

    it('a fiscal receipt names one, so it is refused before anything is written, whatever a tab sends', async () => {
      const w = await tillWorld(app)
      const r = await w.call('POST', `/trade/pos/session/${w.sessionId}/transaction`, { ...w.saleBody(1), nonFiscal: true }, undefined, await withNoCode(w))
      expect(r.status).toBe(400)
      expect(r.json.message).toContain('operator code')
      expect(await Invoice.countDocuments({ orgId: w.oid, type: 'cash_sale' })).toBe(0)
      expect(w.sim!.executed.filter(c => c.cmd === 0x90)).toHaveLength(0)
    })
  })

  describe('a back-office sale joined to the session asks for a receipt, and the device says which', () => {
    it('`text` on a fiscal device prints a fiscal receipt', async () => {
      const w = await tillWorld(app)
      const r = await w.cashierBackOfficeSale(1, { receipt: 'text' })
      expect(r.status).toBe(200)
      expect((await docOf(r.json.invoice.id)).register).toMatchObject({ isFiscal: true, fiscal: expect.objectContaining({ state: 'printed', mode: 'fiscal' }) })
      expect(w.sim!.receipts.filter(x => !x.voided)).toHaveLength(1)
      expect(textsClosed(w)).toBe(0)
    })

    it('`fiscal` on a device that is not fiscalized prints a text slip', async () => {
      const w = await tillWorld(app)
      w.sim!.unfiscalizedUnit = true
      const r = await w.cashierBackOfficeSale(1, { receipt: 'fiscal' })
      expect(r.status).toBe(200)
      expect((await docOf(r.json.invoice.id)).register).toMatchObject({ isFiscal: false, fiscal: expect.objectContaining({ state: 'printed', mode: 'text' }) })
      expect(fiscalCommands(w)).toHaveLength(0)
      expect(textsClosed(w)).toBe(1)
    })
  })
})
