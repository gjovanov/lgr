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
import { posController } from 'invoicing-api/src/controllers/pos.controller'
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import { POSSession, POSTransaction } from 'db/models'
import { getRepos } from 'services/context'
import { getNextNumber } from 'services/biz/sequence.service'
import { computePosTotals } from 'config/pos-totals'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * What a POS sale records: the totals, the change, and the cash the drawer keeps.
 *
 * The terminal used to round VAT per line while the server did not, and a ±0.02 tolerance
 * let the gap through. A 17.8952-net valve was charged 21.48 against a 21.47 total, with
 * "0.01 change" and the tendered 21.48 counted as drawer cash. A 4.2233-net strainer was
 * taken for 5.06 against 5.07 and stored as change −0.01. The terminal now computes with the
 * server's own function (`config/pos-totals`); these cases pin what the server does with
 * exact, overpaid and old-style payments.
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

async function world(opts: { printer?: boolean } = {}) {
  const org = await createTestOrg()
  const warehouse = await createTestWarehouse(org._id)
  const user = await createTestUser(org._id, { operatorCode: '0001' } as any)
  const product = await createTestProduct(org._id, { sellingPrice: 17.8952, taxRate: 20 } as any)
  await createTestStockLevel(org._id, product._id, warehouse._id, { quantity: 50 })
  let sim: EltradeSimulator | undefined
  if (opts.printer) {
    const device = await createTestFiscalDevice(org._id, warehouse._id, {
      name: 'Eltrade A3', deviceNumber: 'ED123456', manufacturer: 'eltrade', connectionType: 'browser', status: 'online',
    } as any)
    sim = new EltradeSimulator()
    registerPrinter(String(device._id), new EltradeFiscalPrinter(sim.exchange, String(device._id)))
    registered.push(String(device._id))
  }
  const session = await getRepos().posSessions.create({
    orgId: String(org._id), warehouseId: String(warehouse._id), cashierId: String(user._id),
    sessionNumber: await getNextNumber(String(org._id), 'POS', 6),
    openedAt: new Date(), status: 'open', openingBalance: 0, currency: 'EUR',
    totalSales: 0, totalReturns: 0, totalCash: 0, totalCard: 0, transactionCount: 0,
  } as any)
  const token = await tokenFor({ id: String(user._id), orgId: String(org._id) })
  return { productId: String(product._id), sessionId: session.id, sim, token, url: `/org/${org._id}/trade/pos/session/${session.id}/transaction` }
}

/** One line; `screenTotal` is what the client claims, `paid` what it pays in cash. */
function sale(productId: string, unitPrice: number, screenTotal: number, paid: number, nonFiscal = true) {
  return {
    type: 'sale',
    lines: [{ productId, name: '0014 ВЪЗВР. КЛАПАН', quantity: 1, unitPrice, discount: 0, taxRate: 20, lineTotal: unitPrice }],
    subtotal: unitPrice, discountTotal: 0, taxTotal: 0, total: screenTotal,
    payments: [{ method: 'cash', amount: paid }], changeDue: 0, nonFiscal,
  }
}

async function drawerOf(sessionId: string) {
  return POSSession.findById(sessionId).lean().exec() as any
}

describe('POS totals and cash', () => {
  it('a sale paid at the terminal total records no change and the total as drawer cash', async () => {
    const w = await world()
    const total = computePosTotals([{ quantity: 1, unitPrice: 17.8952, taxRate: 20 }]).total
    const { status, json } = await post(w.url, w.token, sale(w.productId, 17.8952, total, total))

    expect(status).toBe(200)
    expect(json.transaction).toMatchObject({ subtotal: 17.89, taxTotal: 3.58, total: 21.47, changeDue: 0 })
    const s = await drawerOf(w.sessionId)
    expect(s.totalSales).toBe(21.47)
    expect(s.totalCash).toBe(21.47)
  })

  it('cash tendered above the total: the drawer keeps the total, the rest went back as change', async () => {
    const w = await world()
    const { json } = await post(w.url, w.token, sale(w.productId, 17.8952, 21.47, 50))

    expect(json.transaction.changeDue).toBe(28.53)
    expect((await drawerOf(w.sessionId)).totalCash).toBe(21.47)
  })

  it('an old-style screen total inside the tolerance is accepted, and the drawer counts what it kept', async () => {
    const w = await world()
    // The pre-fix terminal: VAT rounded per line → 21.48 claimed and paid.
    const { status, json } = await post(w.url, w.token, sale(w.productId, 17.8952, 21.48, 21.48))

    expect(status).toBe(200)
    expect(json.transaction.total).toBe(21.47)
    expect(json.transaction.changeDue).toBe(0.01)
    expect((await drawerOf(w.sessionId)).totalCash).toBe(21.47)
  })

  it('a cent short inside the tolerance is a shortfall, never negative change', async () => {
    const w = await world()
    // The pre-fix terminal took 5.06 for a 5.07 sale.
    const { json } = await post(w.url, w.token, sale(w.productId, 4.2233, 5.06, 5.06))

    expect(json.transaction.total).toBe(5.07)
    expect(json.transaction.changeDue).toBe(0)
    const saved = await POSTransaction.findById(json.transaction.id || json.transaction._id).lean().exec() as any
    expect(saved.changeDue).toBe(0)
    expect((await drawerOf(w.sessionId)).totalCash).toBe(5.06)
  })

  it('prints a receipt whose subtotal and VAT add up to its total', async () => {
    const w = await world({ printer: true })
    const { json } = await post(w.url, w.token, sale(w.productId, 17.8952, 21.47, 21.47))

    expect(json.receiptError).toBeUndefined()
    const lines = w.sim!.nonFiscalLines
    expect(lines.some(l => /^Subtotal:\s+17\.89 EUR$/.test(l))).toBe(true)
    expect(lines.some(l => /^VAT:\s+3\.58 EUR$/.test(l))).toBe(true)
    expect(lines.some(l => /^TOTAL:\s+21\.47 EUR$/.test(l))).toBe(true)
  })
})
