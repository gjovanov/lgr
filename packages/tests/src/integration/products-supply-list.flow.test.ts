import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestUser, createTestContact, createTestWarehouse, createTestProduct, createTestStockLevel,
} from '../helpers/factories'
import { stockLevelController } from 'warehouse-api/src/controllers/stock-level.controller'
import { productController } from 'warehouse-api/src/controllers/product.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { Invoice, Order, StockLevel } from 'db/models'
import { mongoose } from 'db/connection'
import { getProductSupply, getProductsSupplyTotals, type ProductSupply, type SupplyTotals } from 'services/biz/product-supply.service'
import { createReservation } from 'services/biz/reservation-ops.service'
import { syncOrderDerivedState } from 'services/biz/reservation.service'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * FR-22.45 — the Products list's „Резервирано" and „Поръчано", for a whole page of products in
 * the call the list already makes (`GET /warehouse/stock-level/by-products`).
 *
 * The figures must be the stock tab's (#252, `getProductSupply`) summed, never a second reading
 * of "reserved" or "incoming": the list links each figure to the tab, and a number that changes
 * on the way there is worse than no number. And a page of 50 must cost what a page of 5 costs.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(stockLevelController).use(productController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const FIGURES = ['reserved', 'incoming', 'reservedIncoming', 'planned'] as const
const ZERO: SupplyTotals = { reserved: 0, incoming: 0, reservedIncoming: 0, planned: 0 }

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const userId = String(user._id)
  const supplier = await createTestContact(org._id, { type: 'supplier', companyName: 'Fastbolt' } as any)
  const c1 = await createTestContact(org._id, { type: 'customer', companyName: 'Клиент 1' } as any)
  const c2 = await createTestContact(org._id, { type: 'customer', companyName: 'Клиент 2' } as any)
  const w1 = await createTestWarehouse(org._id, { name: 'Склад 1', isDefault: true } as any)
  const w2 = await createTestWarehouse(org._id, { name: 'Склад 2' } as any)
  const token = await (signer as any).decorator.jwt.sign({
    id: userId, orgId, role: 'admin', email: 'a@t.bg', username: 'admin',
    firstName: 'A', lastName: 'B', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
  async function call(method: string, path: string) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/warehouse${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }
  const get = (path: string) => call('GET', path)
  let orders = 0
  /** An outgoing order straight into the collection, in the status the case needs. */
  async function order(status: string, lines: Array<{ product: any; allocations: Array<[any, number]> }>) {
    return Order.create({
      orgId: org._id,
      orderNumber: `ORDO-2026-${String(++orders).padStart(5, '0')}`,
      status,
      statusHistory: [{ status, changedAt: new Date() }],
      issueDate: new Date(),
      expectedDate: new Date('2026-11-05'),
      currency: 'EUR',
      exchangeRate: 1,
      supplierGroups: [{
        supplierId: supplier._id,
        lines: lines.map(({ product, allocations }) => ({
          productId: product._id,
          description: product.name,
          quantity: allocations.reduce((s, [, q]) => s + q, 0),
          unit: 'pcs',
          allocations: allocations.map(([wh, quantity]) => ({ warehouseId: wh._id, quantity })),
        })),
      }],
      createdBy: user._id,
    } as any)
  }
  /** A client's hold on one allocation of an order — what „Резервирай за клиент" makes. */
  async function reserveOnOrder(o: any, product: any, allocIndex: number, contact: any, quantity: number) {
    const g = o.supplierGroups[0]
    const line = g.lines.find((l: any) => String(l.productId) === String(product._id))
    const alloc = line.allocations[allocIndex]
    return createReservation(orgId, userId, {
      source: 'order', productId: String(product._id), contactId: String(contact._id), quantity,
      orderId: String(o._id), groupId: String(g._id), lineId: String(line._id), allocationId: String(alloc._id),
    })
  }
  /** The supplier's bill for part of an allocation, received: what makes an order partly received. */
  async function receive(o: any, product: any, allocIndex: number, quantity: number) {
    const g = o.supplierGroups[0]
    const line = g.lines.find((l: any) => String(l.productId) === String(product._id))
    const alloc = line.allocations[allocIndex]
    await Invoice.create({
      orgId: org._id,
      invoiceNumber: `BILL-${o.orderNumber}-${allocIndex}`,
      type: 'invoice',
      direction: 'incoming',
      status: 'received',
      contactId: supplier._id,
      issueDate: new Date(),
      dueDate: new Date(),
      currency: 'EUR',
      exchangeRate: 1,
      lines: [{
        productId: product._id, description: product.name, quantity, unit: 'pcs', unitPrice: 1,
        discount: 0, taxRate: 20, taxAmount: 0, lineTotal: 0, warehouseId: alloc.warehouseId,
        orderRef: { groupId: g._id, lineId: line._id, allocationId: alloc._id },
      }],
      subtotal: 0, taxTotal: 0, total: 0, totalBase: 0, amountDue: 0,
      billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
      orderId: o._id,
      orderGroupId: g._id,
      createdBy: user._id,
    } as any)
    // The receipt movement the bill books, as far as the shelf is concerned.
    await StockLevel.updateOne({ orgId: org._id, productId: product._id, warehouseId: alloc.warehouseId }, { $inc: { quantity } }).exec()
    await syncOrderDerivedState(orgId, String(o._id), userId)
  }
  return { org, orgId, userId, supplier, c1, c2, w1, w2, call, get, order, reserveOnOrder, receive }
}

/**
 * Bolts in two warehouses, held on the shelf and on two kinds of outgoing order; nuts only on
 * their way; washers with nothing at all.
 */
async function supplyWorld() {
  const w = await world()
  const bolt = await createTestProduct(w.org._id, { name: 'Болт М8', sku: 'PSL-BOLT' } as any)
  const nut = await createTestProduct(w.org._id, { name: 'Гайка М8', sku: 'PSL-NUT' } as any)
  const washer = await createTestProduct(w.org._id, { name: 'Шайба М8', sku: 'PSL-WASHER' } as any)
  await createTestStockLevel(w.org._id, bolt._id, w.w1._id, { quantity: 50, availableQuantity: 50 })
  await createTestStockLevel(w.org._id, bolt._id, w.w2._id, { quantity: 20, availableQuantity: 20 })
  await createTestStockLevel(w.org._id, nut._id, w.w1._id, { quantity: 10, availableQuantity: 10 })

  // 5 bolts on the shelf of Склад 1, held for Клиент 1.
  await createReservation(w.orgId, w.userId, {
    source: 'stock', productId: String(bolt._id), warehouseId: String(w.w1._id), contactId: String(w.c1._id), quantity: 5,
  })

  // Sent, and partly received: 20 bolts to Склад 1 (15 arrived), 10 to Склад 2 (none yet), 8 nuts
  // to Склад 1. Клиент 2 holds 18 of the Склад 1 bolts — 15 on the shelf now, 3 still coming —
  // and Клиент 1 holds 4 of the Склад 2 bolts, all still coming.
  const sent = await w.order('sent', [
    { product: bolt, allocations: [[w.w1, 20], [w.w2, 10]] },
    { product: nut, allocations: [[w.w1, 8]] },
  ])
  await w.reserveOnOrder(sent, bolt, 0, w.c2, 18)
  await w.reserveOnOrder(sent, bolt, 1, w.c1, 4)
  await w.receive(sent, bolt, 0, 15)
  expect((await Order.findById(sent._id).lean().exec() as any).status).toBe('partially_received')

  // A draft: 7 bolts to Склад 2 that nobody has ordered yet, 2 of them already promised.
  const draft = await w.order('draft', [{ product: bolt, allocations: [[w.w2, 7]] }])
  await w.reserveOnOrder(draft, bolt, 0, w.c2, 2)

  // A cancelled order brings nothing.
  await w.order('cancelled', [{ product: bolt, allocations: [[w.w1, 100]] }, { product: washer, allocations: [[w.w1, 100]] }])

  const ids = { bolt: String(bolt._id), nut: String(nut._id), washer: String(washer._id) }
  return { ...w, bolt, nut, washer, ids }
}

/** The stock tab's warehouse rows, summed the way the list sums them. */
function totalsOf(supply: ProductSupply, warehouseId?: string): SupplyTotals {
  const t = { ...ZERO }
  for (const row of supply.warehouses) {
    if (warehouseId && row.warehouseId !== warehouseId) continue
    for (const k of FIGURES) t[k] += row[k]
  }
  return t
}

/** Every Mongo operation `fn` issues, by collection and method. */
async function mongoOps<T>(fn: () => Promise<T>): Promise<{ result: T; ops: string[] }> {
  const ops: string[] = []
  mongoose.set('debug', (collection: string, method: string) => { ops.push(`${collection}.${method}`) })
  try {
    return { result: await fn(), ops }
  } finally {
    mongoose.set('debug', false)
  }
}

describe('the Products list: reserved and on order, per article (FR-22.45)', () => {
  it('sums the stock tab\'s own figures: shelf holds, open orders, drafts apart', async () => {
    const w = await supplyWorld()
    const totals = await getProductsSupplyTotals(w.orgId, [w.ids.bolt, w.ids.nut, w.ids.washer])

    // Reserved = the shelf's holds: 5 for Клиент 1 + the 15 of Клиент 2's 18 that arrived.
    // On order = 5 still due to Склад 1 + 10 to Склад 2; the draft's 7 are planned, not ordered,
    // and the cancelled order brings nothing. Of what is coming, 3 (Клиент 2) + 4 (Клиент 1) are
    // promised; the draft's 2 are not counted, its order was never sent.
    expect(totals[w.ids.bolt]).toEqual({ reserved: 20, incoming: 15, reservedIncoming: 7, planned: 7 })
    expect(totals[w.ids.nut]).toEqual({ reserved: 0, incoming: 8, reservedIncoming: 0, planned: 0 })
    expect(totals[w.ids.washer]).toEqual(ZERO)

    for (const id of Object.values(w.ids)) {
      expect(totals[id]).toEqual(totalsOf(await getProductSupply(w.orgId, id)))
    }
  }, 60_000)

  it('with a warehouse chosen, counts only what is held in it and on its way to it', async () => {
    const w = await supplyWorld()
    const w1 = String(w.w1._id)
    const w2 = String(w.w2._id)
    const in1 = await getProductsSupplyTotals(w.orgId, Object.values(w.ids), { warehouseId: w1 })
    const in2 = await getProductsSupplyTotals(w.orgId, Object.values(w.ids), { warehouseId: w2 })

    expect(in1[w.ids.bolt]).toEqual({ reserved: 20, incoming: 5, reservedIncoming: 3, planned: 0 })
    expect(in2[w.ids.bolt]).toEqual({ reserved: 0, incoming: 10, reservedIncoming: 4, planned: 7 })
    expect(in1[w.ids.nut]).toEqual({ reserved: 0, incoming: 8, reservedIncoming: 0, planned: 0 })
    expect(in2[w.ids.nut]).toEqual(ZERO)

    for (const id of Object.values(w.ids)) {
      const supply = await getProductSupply(w.orgId, id)
      expect(in1[id]).toEqual(totalsOf(supply, w1))
      expect(in2[id]).toEqual(totalsOf(supply, w2))
    }
  }, 60_000)

  it('answers every product asked about, ignores what is not an id, and nothing of another org', async () => {
    const w = await supplyWorld()
    const other = await createTestOrg()
    const elsewhere = await createTestProduct(other._id, { name: 'Чужд болт', sku: 'PSL-OTHER' } as any)

    const totals = await getProductsSupplyTotals(w.orgId, [w.ids.bolt.toUpperCase(), 'not-an-id', '', String(elsewhere._id)])
    expect(Object.keys(totals).sort()).toEqual([w.ids.bolt, String(elsewhere._id)].sort())
    expect(totals[w.ids.bolt].reserved).toBe(20)
    expect(totals[String(elsewhere._id)]).toEqual(ZERO)
    expect(await getProductsSupplyTotals(w.orgId, [])).toEqual({})
  }, 60_000)

  it('rides along in the stock-badge call, and the badges follow the warehouse filter too', async () => {
    const w = await supplyWorld()
    const ids = Object.values(w.ids).join(',')

    const all = await w.get(`/stock-level/by-products?productIds=${ids}`)
    expect(all.status).toBe(200)
    expect(all.json.supply).toEqual(await getProductsSupplyTotals(w.orgId, Object.values(w.ids)))
    expect(all.json.stock[w.ids.bolt].map((s: any) => [s.warehouseName, s.quantity]).sort()).toEqual([['Склад 1', 65], ['Склад 2', 20]])

    const one = await w.get(`/stock-level/by-products?productIds=${ids}&warehouseId=${w.w1._id}`)
    expect(one.status).toBe(200)
    expect(one.json.supply[w.ids.bolt]).toEqual({ reserved: 20, incoming: 5, reservedIncoming: 3, planned: 0 })
    expect(one.json.stock[w.ids.bolt].map((s: any) => [s.warehouseName, s.quantity])).toEqual([['Склад 1', 65]])

    const none = await w.get('/stock-level/by-products?productIds=')
    expect(none.json).toEqual({ stock: {}, supply: {} })
  }, 60_000)

  it('costs a fixed handful of queries, for 5 products or 50', async () => {
    const w = await world()
    const products: any[] = []
    for (let i = 0; i < 50; i++) {
      const p = await createTestProduct(w.org._id, { name: `Болт ${i}`, sku: `PSL-N${i}` } as any)
      await createTestStockLevel(w.org._id, p._id, w.w1._id, { quantity: 30, availableQuantity: 30 })
      await createTestStockLevel(w.org._id, p._id, w.w2._id, { quantity: 10, availableQuantity: 10 })
      products.push(p)
    }
    // Every product held on the shelf and on its way, so a per-row lookup would have rows to find.
    const sent = await w.order('sent', products.map((p) => ({ product: p, allocations: [[w.w1, 6], [w.w2, 4]] as Array<[any, number]> })))
    for (const p of products) {
      await createReservation(w.orgId, w.userId, {
        source: 'stock', productId: String(p._id), warehouseId: String(w.w1._id), contactId: String(w.c1._id), quantity: 2,
      })
      await w.reserveOnOrder(sent, p, 1, w.c2, 3)
    }
    const page = (n: number) => products.slice(0, n).map((p) => String(p._id)).join(',')

    const five = await mongoOps(() => w.get(`/stock-level/by-products?productIds=${page(5)}`))
    const fifty = await mongoOps(() => w.get(`/stock-level/by-products?productIds=${page(50)}`))
    expect(fifty.result.status).toBe(200)
    expect(Object.keys(fifty.result.json.supply)).toHaveLength(50)
    for (const p of products) {
      expect(fifty.result.json.supply[String(p._id)]).toEqual({ reserved: 2, incoming: 10, reservedIncoming: 3, planned: 0 })
    }
    // Badges (stock levels + warehouse names) and the supply (stock levels, orders, reservations).
    // The first two prove the hook saw the request at all, so the bound cannot pass on nothing.
    expect(fifty.ops).toContain('orders.find')
    expect(fifty.ops).toContain('reservations.find')
    expect(fifty.ops.length).toBeLessThanOrEqual(5)
    // In any order: the badges' warehouse-name lookup waits for its stock levels.
    expect([...fifty.ops].sort()).toEqual([...five.ops].sort())
  }, 120_000)
})

