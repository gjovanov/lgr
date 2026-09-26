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
  createTestStockMovement,
  createTestFiscalDevice,
} from '../helpers/factories'
import { EltradeSimulator } from '../helpers/eltrade-simulator'
import { posController } from 'invoicing-api/src/controllers/pos.controller'
import { EltradeFiscalPrinter } from 'fiscal/eltrade'
import { registerPrinter, unregisterPrinter } from 'fiscal/fiscal-device.service'
import { Org, POSTransaction, StockLevel, StockMovement } from 'db/models'
import { getRepos } from 'services/context'
import { getNextNumber } from 'services/biz/sequence.service'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * A POS sale must take its goods out of stock — also in an org whose stock movements were
 * booked somewhere else first (imports, invoices, the movements UI), which is every real org.
 *
 * The POS used to number its movement from a Sequence counter that nothing else advances.
 * With movements already on file, that counter pointed at a taken number, the unique index
 * refused the movement, the error was only logged, and the sale left the stock untouched —
 * which is what regal-pz's first till sale did on 2026-09-26.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

let app: Elysia
const registered: string[] = []
const YEAR = new Date().getFullYear()
const sm = (n: number) => `SM-${YEAR}-${String(n).padStart(5, '0')}`

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

/**
 * An org that already has movements SM-…-00001..00003 on file and no `SM` Sequence counter
 * — the counter the POS used to draw from would have handed out 00001 again.
 */
async function world() {
  const org = await createTestOrg()
  const warehouse = await createTestWarehouse(org._id)
  const user = await createTestUser(org._id, { operatorCode: '0001' } as any)
  const product = await createTestProduct(org._id, { sellingPrice: 10, taxRate: 20 } as any)
  await createTestStockLevel(org._id, product._id, warehouse._id, { quantity: 10, availableQuantity: 10 } as any)
  for (const n of [1, 2, 3]) {
    await createTestStockMovement(org._id, { movementNumber: sm(n), status: 'completed', toWarehouseId: warehouse._id } as any)
  }

  const r = getRepos()
  const session = await r.posSessions.create({
    orgId: String(org._id), warehouseId: String(warehouse._id), cashierId: String(user._id),
    sessionNumber: await getNextNumber(String(org._id), 'POS', 6),
    openedAt: new Date(), status: 'open', openingBalance: 0, currency: 'EUR',
    totalSales: 0, totalReturns: 0, totalCash: 0, totalCard: 0, transactionCount: 0,
  } as any)
  const token = await tokenFor({ id: String(user._id), orgId: String(org._id) })
  const base = `/org/${org._id}/trade/pos/session/${session.id}`
  return { org, warehouse, product, token, base }
}

async function stockOf(w: Awaited<ReturnType<typeof world>>) {
  const level = await StockLevel.findOne({ orgId: w.org._id, productId: w.product._id, warehouseId: w.warehouse._id }).lean().exec() as any
  return level.quantity
}

async function savedTransaction(json: any) {
  return POSTransaction.findById(json.transaction.id || json.transaction._id).lean().exec() as any
}

describe('POS stock movements', () => {
  it('numbers the sale after the movements already on file and takes the goods out of stock', async () => {
    const w = await world()
    const { status, json } = await post(`${w.base}/transaction`, w.token, saleBody(String(w.product._id)))

    expect(status).toBe(200)
    expect(json.stockError).toBeUndefined()
    const txn = await savedTransaction(json)
    expect(txn.movementId).toBeDefined()

    const movement = await StockMovement.findById(txn.movementId).lean().exec() as any
    expect(movement.movementNumber).toBe(sm(4))
    expect(movement.type).toBe('dispatch')
    expect(movement.status).toBe('completed')
    expect(String(movement.fromWarehouseId)).toBe(String(w.warehouse._id))
    expect(await stockOf(w)).toBe(8)
  })

  it('puts the goods back on a storno, under the next free number', async () => {
    const w = await world()
    const sale = await post(`${w.base}/transaction`, w.token, saleBody(String(w.product._id)))
    const saleTxn = await savedTransaction(sale.json)

    const { status, json } = await post(`${w.base}/storno`, w.token, { originalTransactionId: String(saleTxn._id), reason: 'customer_return' })

    expect(status).toBe(200)
    expect(json.stockError).toBeUndefined()
    const storno = await savedTransaction(json)
    const reversal = await StockMovement.findById(storno.movementId).lean().exec() as any
    expect(reversal.movementNumber).toBe(sm(5))
    expect(reversal.type).toBe('return')
    expect(reversal.status).toBe('completed')
    expect(await stockOf(w)).toBe(10)
  })

  it('retries with a fresh number when another booking takes it first', async () => {
    const w = await world()
    // The first read is stale — as if a second till or an import booked 00003 in between —
    // so the first create collides with the unique index.
    const repo = getRepos().stockMovements as any
    let staleReads = 1
    repo.findAll = async function (filter: any, page: any) {
      const result = await Object.getPrototypeOf(repo).findAll.call(repo, filter, page)
      if (filter?.movementNumber && staleReads-- > 0) return { ...result, items: [{ movementNumber: sm(2) }] }
      return result
    }
    try {
      const { json } = await post(`${w.base}/transaction`, w.token, saleBody(String(w.product._id)))

      expect(json.stockError).toBeUndefined()
      expect(staleReads).toBeLessThan(0) // the stale read did happen, and a fresh one after it
      const movement = await StockMovement.findById((await savedTransaction(json)).movementId).lean().exec() as any
      expect(movement.movementNumber).toBe(sm(4))
      expect(await stockOf(w)).toBe(8)
    } finally {
      delete repo.findAll
    }
  })

  it('reports stock that did not move instead of a silent success', async () => {
    const w = await world()
    const repo = getRepos().stockMovements as any
    repo.create = async () => { throw new Error('write concern timeout') }
    try {
      const { status, json } = await post(`${w.base}/transaction`, w.token, saleBody(String(w.product._id)))

      expect(status).toBe(200) // the sale itself is recorded
      expect(json.stockError).toBe('write concern timeout')
      expect((await savedTransaction(json)).movementId).toBeUndefined()
      expect(await stockOf(w)).toBe(10)
    } finally {
      delete repo.create
    }
  })

  it("prints the receipt in the session's currency, not the org's base currency", async () => {
    const w = await world()
    await Org.updateOne({ _id: w.org._id }, { $set: { 'settings.baseCurrency': 'BGN' } }).exec()
    const device = await createTestFiscalDevice(w.org._id, w.warehouse._id, {
      name: 'Eltrade A3', deviceNumber: 'ED123456', manufacturer: 'eltrade', connectionType: 'browser', status: 'online',
    } as any)
    const deviceId = String(device._id)
    const sim = new EltradeSimulator()
    registerPrinter(deviceId, new EltradeFiscalPrinter(sim.exchange, deviceId))
    registered.push(deviceId)

    const { json } = await post(`${w.base}/transaction`, w.token, saleBody(String(w.product._id), true))

    expect(json.receiptError).toBeUndefined()
    expect(sim.nonFiscalLines.some(l => l.includes('24.00 EUR'))).toBe(true)
    expect(sim.nonFiscalLines.some(l => l.includes('BGN'))).toBe(false)
  })
})
