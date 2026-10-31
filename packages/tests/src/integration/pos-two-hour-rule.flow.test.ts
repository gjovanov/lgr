import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg,
  createTestUser,
  createTestWarehouse,
  createTestProduct,
  createTestStockLevel,
  createTestFiscalDevice,
  allowSalesWithoutPrinter,
} from '../helpers/factories'
import { EltradeSimulator } from '../helpers/eltrade-simulator'
import { posController } from 'invoicing-api/src/controllers/pos.controller'
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import { setReachWriterForTests } from 'fiscal/device-reach'
import { FiscalDevice, Invoice, POSTransaction } from 'db/models'
import { getRepos } from 'services/context'
import { getNextNumber } from 'services/biz/sequence.service'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * FR-20.49 (P1-10b) — Н-18 Прил. 29 т. 8 at the till: no fiscal sale opens on a device that has not
 * been reached in two hours, in SUPTO production mode. A stale device is asked before anything is
 * refused, and a device that answers is recorded as reached.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

let app: Elysia
const registered: string[] = []
const mode = config.supto.mode
const HOUR = 60 * 60 * 1000

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(posController)
}, 60_000)

afterAll(async () => {
  config.supto.mode = mode
  await teardownTestDB()
}, 60_000)

afterEach(async () => {
  config.supto.mode = mode
  setReachWriterForTests(null)
  for (const id of registered.splice(0)) unregisterPrinter(id)
  await clearCollections()
}, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(u: { id: string; orgId: string }) {
  return (signer as any).decorator.jwt.sign({
    id: u.id, orgId: u.orgId, role: 'admin', email: 'cashier@test.com', username: 'cashier',
    firstName: 'Иван', lastName: 'Петров', operatorCode: '0001',
    permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}

async function post(path: string, token: string, body: any) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  }))
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

function saleBody(productId: string, nonFiscal = false) {
  return {
    type: 'sale',
    lines: [{ productId, name: 'Болт DIN 933 М8Х25', quantity: 2, unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 4, lineTotal: 20 }],
    subtotal: 20, discountTotal: 0, taxTotal: 4, total: 24,
    payments: [{ method: 'cash', amount: 24 }],
    changeDue: 0,
    nonFiscal,
  }
}

/** A till whose one device was last reached at `lastCommunicationAt`, and is connected or not. */
async function till(opts: { lastCommunicationAt?: Date; connected: boolean }) {
  const org = await createTestOrg()
  // The two-hour rule on its own: with "no sale without a connected printer" on, a device not
  // connected is refused before it (`till-printer-gate.flow` has that).
  await allowSalesWithoutPrinter(org._id)
  const warehouse = await createTestWarehouse(org._id)
  const user = await createTestUser(org._id, { operatorCode: '0001' } as any)
  const product = await createTestProduct(org._id, { sellingPrice: 10, taxRate: 20 } as any)
  await createTestStockLevel(org._id, product._id, warehouse._id, { quantity: 100 })
  const device = await createTestFiscalDevice(org._id, warehouse._id, {
    name: 'Eltrade A3', deviceNumber: 'ED123456', manufacturer: 'eltrade', connectionType: 'browser',
    status: opts.connected ? 'online' : 'offline',
    ...(opts.lastCommunicationAt ? { lastCommunicationAt: opts.lastCommunicationAt } : {}),
  } as any)
  const deviceId = String(device._id)
  const sim = new EltradeSimulator()
  if (opts.connected) {
    registerPrinter(deviceId, new EltradeFiscalPrinter(sim.exchange, deviceId))
    registered.push(deviceId)
  }
  const session = await getRepos().posSessions.create({
    orgId: String(org._id), warehouseId: String(warehouse._id), cashierId: String(user._id),
    sessionNumber: await getNextNumber(String(org._id), 'POS', 6),
    openedAt: new Date(), status: 'open', openingBalance: 0, currency: 'EUR',
    totalSales: 0, totalReturns: 0, totalCash: 0, totalCard: 0, transactionCount: 0,
  } as any)
  const token = await tokenFor({ id: String(user._id), orgId: String(org._id) })
  return { product, deviceId, sim, token, url: `/org/${org._id}/trade/pos/session/${session.id}/transaction` }
}

async function lastReached(deviceId: string): Promise<number> {
  const d = await FiscalDevice.findById(deviceId).lean().exec() as any
  return d?.lastCommunicationAt ? new Date(d.lastCommunicationAt).getTime() : 0
}

/** The write is fire-and-forget: wait for it. */
async function reachedAfter(deviceId: string, since: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if ((await lastReached(deviceId)) >= since) return true
    await new Promise(r => setTimeout(r, 20))
  }
  return false
}

describe('Прил. 29 т. 8 at the till (SUPTO production mode)', () => {
  it('refuses a fiscal sale on a device not reached in two hours, and opens nothing', async () => {
    config.supto.mode = 'production'
    const t = await till({ lastCommunicationAt: new Date(Date.now() - 3 * HOUR), connected: false })
    const { status, json } = await post(t.url, t.token, saleBody(String(t.product._id)))
    expect(status).toBe(409)
    expect(json.code).toBe('fiscal_device_unreached')
    expect(json.message).toContain('Eltrade A3')
    expect(json.deviceName).toBe('Eltrade A3')
    expect(new Date(json.lastCommunicationAt).getTime()).toBeLessThan(Date.now() - 2 * HOUR)
    expect(await POSTransaction.countDocuments({})).toBe(0)
    expect(await Invoice.countDocuments({})).toBe(0)
  })

  it('refuses one never reached at all', async () => {
    config.supto.mode = 'production'
    const t = await till({ connected: false })
    const { status, json } = await post(t.url, t.token, saleBody(String(t.product._id)))
    expect(status).toBe(409)
    expect(json.lastCommunicationAt).toBeNull()
  })

  it('asks a stale device first, and a device that answers is reached: the sale prints', async () => {
    config.supto.mode = 'production'
    const t = await till({ lastCommunicationAt: new Date(Date.now() - 3 * HOUR), connected: true })
    const before = Date.now()
    const { status, json } = await post(t.url, t.token, saleBody(String(t.product._id)))
    expect(status).toBe(200)
    expect(json.receiptError).toBeUndefined()
    expect(json.transaction.fiscalReceiptNumber).toBe('0000101')
    expect(await reachedAfter(t.deviceId, before)).toBe(true)
  })

  it('lets a sale open on a device reached within the two hours', async () => {
    config.supto.mode = 'production'
    const t = await till({ lastCommunicationAt: new Date(Date.now() - 30 * 60 * 1000), connected: true })
    const { status, json } = await post(t.url, t.token, saleBody(String(t.product._id)))
    expect(status).toBe(200)
    expect(json.transaction.fiscalReceiptNumber).toBe('0000101')
  })

  it('does not judge a sale the device does not print (the non-fiscal toggle)', async () => {
    config.supto.mode = 'production'
    const t = await till({ lastCommunicationAt: new Date(Date.now() - 3 * HOUR), connected: false })
    const { status } = await post(t.url, t.token, saleBody(String(t.product._id), true))
    expect(status).toBe(200)
  })
})

describe('outside SUPTO production mode', () => {
  it('enforces nothing: the default every deployment runs today', async () => {
    config.supto.mode = 'development'
    const t = await till({ lastCommunicationAt: new Date(Date.now() - 3 * HOUR), connected: false })
    const { status } = await post(t.url, t.token, saleBody(String(t.product._id)))
    expect(status).toBe(200)
  })
})

describe('the time the rule reads', () => {
  it('is kept by every receipt the device prints, in every mode', async () => {
    config.supto.mode = 'development'
    const t = await till({ lastCommunicationAt: new Date(Date.now() - 5 * HOUR), connected: true })
    const before = Date.now()
    const { status } = await post(t.url, t.token, saleBody(String(t.product._id)))
    expect(status).toBe(200)
    // ⚠ It used to be written at registration and never again, so a till printing all day read
    // "not reached since 07:00" by 09:00, and the rule would have stopped a working shop.
    expect(await reachedAfter(t.deviceId, before)).toBe(true)
  })
})
