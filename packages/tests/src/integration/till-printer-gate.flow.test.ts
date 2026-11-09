import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { tillApp, tillWorld, forgetDevices, type TillWorld } from '../helpers/till-world'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { orgController } from '../../../portal-api/src/controllers/org.controller'
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import { FiscalDevice, Invoice, Org, POSSession } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * "It should not be possible to make a sale if there is no connected printer device" (2026-10-31).
 *
 * A till sale, and a back-office sale that asks its session's device for a receipt, are refused
 * with nothing written — no document, so no number and no УНП — unless the org turned the rule
 * off for having no device at all (the demo org). A sale already in flight still finishes.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => { await setupTestDB(); app = tillApp() }, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { forgetDevices(); await clearCollections() })

const documents = (orgId: string) => Invoice.countDocuments({ orgId, type: { $in: ['cash_sale', 'cash_storno'] } })

describe('no sale without a connected printer', () => {
  it('a till with no device set up refuses the sale, says so, and writes nothing', async () => {
    const w = await tillWorld(app, { device: false, requireDevice: true })
    const r = await w.sell()
    expect(r.status).toBe(409)
    expect(r.json).toMatchObject({ code: 'fiscal_device_not_connected', deviceConfigured: false })
    expect(await documents(w.orgId)).toBe(0)
  })

  it('a device set up but not connected: refused as not connected, and the sale after it takes the first number', async () => {
    const w = await tillWorld(app)
    forgetDevices() // unplugged
    const refused = await w.sell()
    expect(refused.status).toBe(409)
    expect(refused.json).toMatchObject({ code: 'fiscal_device_not_connected', deviceConfigured: true })
    expect(await documents(w.orgId)).toBe(0)

    // Plugged back in: the refusal used up nothing.
    const device: any = await FiscalDevice.findOne({ orgId: w.oid }).lean().exec()
    const deviceId = String(device._id)
    registerPrinter(deviceId, new EltradeFiscalPrinter(w.sim!.exchange, deviceId))
    try {
      const sold = await w.sell()
      expect(sold.status).toBe(200)
      expect(sold.json.transaction.transactionNumber).toMatch(/0*1$/)
    } finally {
      unregisterPrinter(deviceId)
    }
  })

  it('a keyed retry of a sale rung before the device dropped still finishes', async () => {
    const w = await tillWorld(app)
    const first = await w.sell(2, {}, 'gate-retry-1')
    expect(first.status).toBe(200)
    forgetDevices()
    const retry = await w.sell(2, {}, 'gate-retry-1')
    expect(retry.status).toBe(200)
    expect(String(retry.json.transaction.id ?? retry.json.transaction._id)).toBe(String(first.json.transaction.id ?? first.json.transaction._id))
    expect(await documents(w.orgId)).toBe(1)
  })

  it('an org that turned the rule off sells with nothing to print on, as the demo org does', async () => {
    const w = await tillWorld(app, { device: false })
    const r = await w.sell()
    expect(r.status).toBe(200)
    expect(await documents(w.orgId)).toBe(1)
  })

  it('a back-office sale that joins a session is refused too, whether or not it asks for a receipt; a clerk with no session is refused for want of one (#492)', async () => {
    const w = await tillWorld(app, { device: false, requireDevice: true })
    for (const asked of [await w.cashierBackOfficeSale(1, { receipt: 'fiscal' }), await w.cashierBackOfficeSale(1)]) {
      expect(asked.status).toBe(409)
      expect(asked.json.code).toBe('fiscal_device_not_connected')
    }
    expect(await documents(w.orgId)).toBe(0)

    const none = await w.backOfficeSale(1)
    expect(none.status).toBe(409)
    expect(none.json).toMatchObject({ code: 'fiscal_device_not_connected', noSession: true })
    expect(await documents(w.orgId)).toBe(0)
  })

  describe('a missing `receipt` on a cash sale reads as fiscal, where LGR prints (D6)', () => {
    const sessionOf = (w: TillWorld) => POSSession.findById(w.sessionId).lean().exec() as Promise<any>

    it('the device gone: it no longer goes past the gate, paid, into the drawer, printing nothing', async () => {
      const w = await tillWorld(app)
      forgetDevices()

      const r = await w.cashierBackOfficeSale(1)

      expect(r.status).toBe(409)
      expect(r.json).toMatchObject({ code: 'fiscal_device_not_connected', deviceConfigured: true })
      expect(await documents(w.orgId)).toBe(0)
      expect((await sessionOf(w)).totalCash).toBe(0)
    })

    it('the device there: it prints, as the device says', async () => {
      const w = await tillWorld(app)
      const r = await w.cashierBackOfficeSale(1)
      expect(r.status).toBe(200)
      const doc: any = await Invoice.findById(r.json.invoice.id).lean().exec()
      expect(doc.register).toMatchObject({ isFiscal: true, fiscal: expect.objectContaining({ state: 'printed', mode: 'fiscal' }) })
      expect(w.sim!.receipts.filter(x => !x.voided)).toHaveLength(1)

      w.sim!.unfiscalizedUnit = true
      const text = await w.cashierBackOfficeSale(1)
      expect((await Invoice.findById(text.json.invoice.id).lean().exec() as any).register.fiscal).toMatchObject({ state: 'printed', mode: 'text' })
      expect(w.sim!.receipts.filter(x => !x.voided)).toHaveLength(1)
    })

    it('what no receipt can carry is refused, as it is when asked for', async () => {
      const w = await tillWorld(app)
      const r = await w.cashierBackOfficeSale(1, { paymentMethod: 'bank_transfer' })
      expect(r.status).toBe(422)
      expect(r.json.code).toBe('payment_method_not_fiscal')
      expect(await documents(w.orgId)).toBe(0)
    })

    describe('what it does not touch', () => {
      /** The skill's own body (`scripts/import-cash-register-sales-api.ts`). */
      const importedDay = (w: TillWorld, noStock: boolean) => ({
        reference: 'salesAnalysis:2026-10-26', tags: ['cash-register-import'], skipStockMovement: noStock, allowNegativeStock: true,
        notes: 'Дневни продажби каса — 2026-10-26', placeOfTransaction: 'София',
      })

      for (const noStock of [true, false]) {
        it(`an imported till day${noStock ? ' with --no-stock' : ''}, by someone with a session, on a device gone: imported, in no drawer, printing nothing`, async () => {
          const w = await tillWorld(app)
          const before = (await w.stock()).quantity
          forgetDevices()

          const r = await w.cashierBackOfficeSale(1, importedDay(w, noStock))

          expect(r.status).toBe(200)
          const doc: any = await Invoice.findById(r.json.invoice.id).lean().exec()
          expect(doc.register.origin).toBe('import')
          expect(doc.register.sessionId).toBeUndefined()
          expect(doc.register.fiscal?.state).not.toBe('pending')
          expect((await sessionOf(w)).totalCash).toBe(0)
          expect((await w.stock()).quantity).toBe(noStock ? before : before - 1)
        })
      }

      it('an imported till day on a device that is there: nothing reaches it', async () => {
        const w = await tillWorld(app)
        const frames = w.sim!.frames
        expect((await w.cashierBackOfficeSale(1, importedDay(w, true))).status).toBe(200)
        expect(w.sim!.frames).toBe(frames)
      })

      it('an org with the gate off: it joins the drawer and prints nothing, device or no device', async () => {
        const gone = await tillWorld(app, { device: false })
        const r = await gone.cashierBackOfficeSale(1)
        expect(r.status).toBe(200)
        expect((await Invoice.findById(r.json.invoice.id).lean().exec() as any).register).toMatchObject({ origin: 'pos', fiscal: { state: 'none' } })

        const there = await tillWorld(app)
        await Org.updateOne({ _id: there.oid }, { $set: { 'settings.cashRegister.requireConnectedDevice': false } })
        const frames = there.sim!.frames
        const s = await there.cashierBackOfficeSale(1)
        expect(s.status).toBe(200)
        expect((await Invoice.findById(s.json.invoice.id).lean().exec() as any).register.fiscal.state).toBe('none')
        expect(there.sim!.frames).toBe(frames)

        // And what asks still prints there, as it did.
        const asked = await there.cashierBackOfficeSale(1, { receipt: 'fiscal' })
        expect((await Invoice.findById(asked.json.invoice.id).lean().exec() as any).register.fiscal.state).toBe('printed')
      })

      it('in an org with the gate off a bank transfer with no receipt is as it was', async () => {
        const w = await tillWorld(app, { device: false })
        expect((await w.cashierBackOfficeSale(1, { paymentMethod: 'bank_transfer' })).status).toBe(200)
      })
    })
  })
})

describe('the Organization page keeps what it does not send', () => {
  const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

  it('a save keeps the time zone and the cash register\'s other switch, and the new switch saves', async () => {
    const org = await createTestOrg()
    await Org.updateOne({ _id: org._id }, { $set: { 'settings.timezone': 'Europe/Sofia', 'settings.cashRegister.allowNegativeStock': false } })
    const user = await createTestUser(org._id, { role: 'admin' } as any)
    const token = await (signer as any).decorator.jwt.sign({
      id: String(user._id), orgId: String(org._id), role: 'admin', email: 'a@test.com', username: 'admin',
      firstName: 'A', lastName: 'B', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
    })
    // What the page sends: every block it edits — never the time zone, which it does not edit.
    const res = await new Elysia().use(orgController).handle(new Request(`http://localhost/org/${org._id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        name: 'Org',
        settings: {
          baseCurrency: 'EUR', locale: 'bg', modules: [],
          taxConfig: { vatEnabled: true, vatRates: [] },
          inventory: { defaultCostingMethod: 'wac', allowNegativeStock: false },
          cashRegister: { allowNegativeStock: false, requireConnectedDevice: false },
          payroll: { payFrequency: 'Monthly' },
        },
      }),
    }))
    expect(res.status).toBe(200)

    const saved: any = await Org.findById(org._id).lean().exec()
    expect(saved.settings.timezone).toBe('Europe/Sofia')
    expect(saved.settings.cashRegister).toEqual({ allowNegativeStock: false, requireConnectedDevice: false })
    expect(saved.settings.locale).toBe('bg')
  })
})
