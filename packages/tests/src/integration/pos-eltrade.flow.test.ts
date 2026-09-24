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
} from '../helpers/factories'
import { EltradeSimulator } from '../helpers/eltrade-simulator'
import { posController, fiscalUnitPrice } from 'invoicing-api/src/controllers/pos.controller'
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import { FiscalDevice, POSTransaction } from 'db/models'
import { getRepos } from 'services/context'
import { getNextNumber } from 'services/biz/sequence.service'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * The POS sale path end to end over HTTP, with an Eltrade on the bridge — played by
 * `EltradeSimulator`, which implements the device protocol (see its header).
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

let app: Elysia
const registered: string[] = []

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(posController)
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

afterEach(async () => {
  for (const id of registered.splice(0)) unregisterPrinter(id)
  await clearCollections()
}, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(u: { id: string; orgId: string }) {
  return (signer as any).decorator.jwt.sign({
    id: u.id,
    orgId: u.orgId,
    role: 'admin',
    email: 'cashier@test.com',
    username: 'cashier',
    firstName: 'Иван',
    lastName: 'Петров',
    operatorCode: '0001',
    permissions: DEFAULT_ROLE_PERMISSIONS.admin,
    ownRecordsModules: [],
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

/** 2 × 10.00 net at 20 % → 24.00 to pay. */
function saleBody(productId: string, nonFiscal: boolean) {
  return {
    type: 'sale',
    lines: [{ productId, name: 'Болт DIN 933 М8Х25', quantity: 2, unitPrice: 10, discount: 0, taxRate: 20, taxAmount: 4, lineTotal: 20 }],
    subtotal: 20, discountTotal: 0, taxTotal: 4, total: 24,
    payments: [{ method: 'cash', amount: 24 }],
    changeDue: 0,
    nonFiscal,
  }
}

async function world(extraDevices: { name: string; manufacturer: string; deviceNumber: string }[] = []) {
  const org = await createTestOrg()
  const warehouse = await createTestWarehouse(org._id)
  const user = await createTestUser(org._id, { operatorCode: '0001' } as any)
  const product = await createTestProduct(org._id, { sellingPrice: 10, taxRate: 20 } as any)
  await createTestStockLevel(org._id, product._id, warehouse._id, { quantity: 100 })
  for (const d of extraDevices) {
    await createTestFiscalDevice(org._id, warehouse._id, { ...d, connectionType: 'browser' } as any)
  }
  const device = await createTestFiscalDevice(org._id, warehouse._id, {
    name: 'Z Eltrade A3', deviceNumber: 'ED123456', manufacturer: 'eltrade', connectionType: 'browser', status: 'online',
  } as any)
  const deviceId = String(device._id)
  const sim = new EltradeSimulator()
  registerPrinter(deviceId, new EltradeFiscalPrinter(sim.exchange, deviceId))
  registered.push(deviceId)

  const r = getRepos()
  const session = await r.posSessions.create({
    orgId: String(org._id), warehouseId: String(warehouse._id), cashierId: String(user._id),
    sessionNumber: await getNextNumber(String(org._id), 'POS', 6),
    openedAt: new Date(), status: 'open', openingBalance: 0, currency: 'EUR',
    totalSales: 0, totalReturns: 0, totalCash: 0, totalCard: 0, transactionCount: 0,
  } as any)
  const token = await tokenFor({ id: String(user._id), orgId: String(org._id) })
  const url = `/org/${org._id}/trade/pos/session/${session.id}/transaction`
  return { org, product, deviceId, sim, token, url }
}

describe('POS sale on an Eltrade', () => {
  it('issues a fiscal receipt with the УНП, VAT-inclusive prices in group Б, and stores its number', async () => {
    const w = await world()
    const { status, json } = await post(w.url, w.token, saleBody(String(w.product._id), false))

    expect(status).toBe(200)
    expect(json.receiptError).toBeUndefined()
    expect(json.transaction.unpNumber).toBe('ED123456-0001-0000001')
    expect(json.transaction.fiscalReceiptNumber).toBe('0000101')

    const receipt = w.sim.receipts[0]
    expect(receipt.kind).toBe('fiscal')
    expect(receipt.header).toEqual(['Иван Петров', 'ED123456-0001-0000001'])
    // net 10.00 + 20 % = 12.00 per piece, in Б (Н-18: 20 %) — not the net price, not group А (0 %)
    expect(receipt.sales).toEqual([{ text: 'Болт DIN 933 М8Х25', group: 'Б', price: 12, quantity: 2, percent: 0, amount: 24 }])
    expect(receipt.payments).toEqual([{ mode: 'P', amount: 24 }])

    const saved = await POSTransaction.findById(json.transaction.id || json.transaction._id).lean().exec() as any
    expect(saved.fiscalReceiptNumber).toBe('0000101')
    expect(saved.isFiscal).toBe(true)
  })

  it('prints a non-fiscal text receipt when the toggle is on — and issues nothing fiscal', async () => {
    const w = await world()
    const { status, json } = await post(w.url, w.token, saleBody(String(w.product._id), true))

    expect(status).toBe(200)
    expect(json.receiptError).toBeUndefined()
    expect(json.transaction.unpNumber).toBeUndefined()
    expect(w.sim.receipts).toHaveLength(0)
    expect(w.sim.nonFiscalOpen).toBe(false)
    expect(w.sim.nonFiscalLines.some(l => l.includes('24.00'))).toBe(true)
  })

  it('uses the CONNECTED device when the warehouse also has another one set up', async () => {
    // Sorts first by name and is not connected — the old findOne could land on it.
    const w = await world([{ name: 'A Tremol M20', manufacturer: 'tremol', deviceNumber: 'ZK123456' }])
    const { json } = await post(w.url, w.token, saleBody(String(w.product._id), false))

    expect(json.transaction.fiscalReceiptNumber).toBe('0000101')
    expect(w.sim.receipts).toHaveLength(1)
  })

  it('reports a receipt that did not print instead of a silent success, and leaves nothing open', async () => {
    const w = await world()
    w.sim.paper = false
    const { status, json } = await post(w.url, w.token, saleBody(String(w.product._id), false))

    expect(status).toBe(200) // the sale itself is recorded
    expect(json.receiptError).toContain('out of paper')
    expect(w.sim.receipt).toBeNull()
    const device = await FiscalDevice.findById(w.deviceId).lean().exec() as any
    expect(device.status).toBe('error')
  })
})

describe('fiscalUnitPrice', () => {
  it('adds VAT to the net unit price and rounds to cents', () => {
    expect(fiscalUnitPrice(10, 20)).toBe(12)
    expect(fiscalUnitPrice(0.4167, 20)).toBe(0.5)
    expect(fiscalUnitPrice(10, 9)).toBe(10.9)
    expect(fiscalUnitPrice(3.5, undefined)).toBe(3.5)
  })
})
