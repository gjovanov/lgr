import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact, createTestProduct, createTestWarehouse } from '../helpers/factories'
import { orderController } from 'api/src/invoicing/controllers/order.controller'
import { internalOrderController } from 'api/src/invoicing/controllers/internal-order.controller'
import { movementController } from 'api/src/warehouse/controllers/movement.controller'
import { spaErrorHandler } from '../../../api/src/spa-fallback.js'
import { isRequestIdTaken } from 'services/biz/create-request-id'
import { InternalOrder, Order, Product, Reservation, StockMovement } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * FR-29.13 (§2.4, §6 "Creates"): a request id on the three creates the forms make — a supplier order, a customer order
 * and a stock movement (both its routes: the plain create and the goods receipt with product update).
 *
 * The form sends `Idempotency-Key` (`createIdempotentAction`). For each route:
 *   - the same id twice makes one document, and the second answer is the first document, in the create's shape;
 *   - the same id sent twice AT ONCE makes one document too (the partial unique index decides);
 *   - the same id in another organization is another request;
 *   - no id behaves as today: two requests, two documents;
 *   - a malformed id is refused (400), never ignored.
 *
 * Over HTTP through the real controllers. NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(orderController).use(internalOrderController).use(movementController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const year = new Date().getFullYear()
let keySeq = 0
const newKey = () => `test-key-${Date.now().toString(36)}-${++keySeq}`

async function org() {
  const o = await createTestOrg()
  const orgId = String(o._id)
  const user = await createTestUser(o._id)
  const supplier = await createTestContact(o._id, { type: 'supplier', companyName: 'Alfa Fasteners' } as any)
  const client = await createTestContact(o._id, { type: 'customer', companyName: 'Delta Client' } as any)
  const main = await createTestWarehouse(o._id, { name: 'Main', isDefault: true } as any)
  const bolt = await createTestProduct(o._id, { name: 'Hex bolt M8x40', sku: 'PRD-0001', purchasePrice: 5, sellingPrice: 10, taxRate: 20 } as any)
  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, email: 'a@t.test', username: 'u', firstName: 'A', lastName: 'B', ownRecordsModules: [],
    role: 'admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin,
  })
  async function call(method: string, path: string, body?: unknown, key?: string) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
        ...(key !== undefined ? { 'idempotency-key': key } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* not json */ }
    return { status: res.status, json }
  }
  const id = (d: any) => String(d._id)
  return { orgId, user, supplier, client, main, bolt, call, id }
}

type World = Awaited<ReturnType<typeof org>>

/** Each create: its path, a body, how to read the made document's id from its answer, and how many the org holds. */
const CREATES: Array<{
  name: string
  path: string
  body: (w: World) => Record<string, unknown>
  idOf: (json: any) => string
  count: (orgId: string) => Promise<number>
}> = [
  {
    name: 'a supplier order',
    path: '/invoicing/orders',
    body: (w) => ({
      issueDate: `${year}-10-20`,
      supplierGroups: [{
        supplierId: w.id(w.supplier),
        lines: [{ productId: w.id(w.bolt), description: 'Hex bolt M8x40', quantity: 10, unit: 'pcs', allocations: [{ warehouseId: w.id(w.main), quantity: 10 }] }],
      }],
    }),
    idOf: (json) => String(json?.order?._id),
    count: (orgId) => Order.countDocuments({ orgId }).exec(),
  },
  {
    name: 'a customer order',
    path: '/invoicing/internal-orders',
    body: (w) => ({
      contactId: w.id(w.client),
      issueDate: `${year}-10-20`,
      requestedDeliveryDate: `${year}-10-30`,
      lines: [{ productId: w.id(w.bolt), description: 'Hex bolt M8x40', quantity: 4 }],
    }),
    idOf: (json) => String(json?.internalOrder?._id),
    count: (orgId) => InternalOrder.countDocuments({ orgId }).exec(),
  },
  {
    name: 'a stock movement',
    path: '/warehouse/movement',
    body: (w) => ({
      type: 'receipt', date: `${year}-10-20`, toWarehouseId: w.id(w.main), totalAmount: 10,
      lines: [{ productId: w.id(w.bolt), quantity: 2, unitCost: 5, totalCost: 10 }],
    }),
    idOf: (json) => String(json?.stockMovement?.id ?? json?.stockMovement?._id),
    count: (orgId) => StockMovement.countDocuments({ orgId }).exec(),
  },
  {
    name: 'a goods receipt with product update',
    path: '/warehouse/movement/with-update',
    body: (w) => ({
      type: 'receipt', date: `${year}-10-20`, toWarehouseId: w.id(w.main), totalAmount: 12,
      lines: [{ productId: w.id(w.bolt), quantity: 2, unitCost: 6, totalCost: 12 }],
      productUpdates: [{ productId: w.id(w.bolt), purchasePrice: 6 }],
    }),
    idOf: (json) => String(json?.stockMovement?._id),
    count: (orgId) => StockMovement.countDocuments({ orgId }).exec(),
  },
]

for (const c of CREATES) {
  describe(`FR-29.13 — ${c.name}`, () => {
    it('the same id twice makes one document, and the second answer is the first document', async () => {
      const w = await org()
      const key = newKey()
      const first = await w.call('POST', c.path, c.body(w), key)
      expect(first.status).toBe(200)
      const madeId = c.idOf(first.json)
      expect(madeId).toMatch(/^[0-9a-f]{24}$/)
      expect(first.json.replayed).toBeUndefined()

      const second = await w.call('POST', c.path, c.body(w), key)
      expect(second.status).toBe(200)
      expect(c.idOf(second.json)).toBe(madeId)
      expect(second.json.replayed).toBe(true)
      expect(await c.count(w.orgId)).toBe(1)
    })

    it('the same id sent twice at once makes one document', async () => {
      const w = await org()
      const key = newKey()
      const answers = await Promise.all([1, 2, 3].map(() => w.call('POST', c.path, c.body(w), key)))
      expect(answers.map(a => a.status)).toEqual([200, 200, 200])
      const ids = new Set(answers.map(a => c.idOf(a.json)))
      expect(ids.size).toBe(1)
      expect(await c.count(w.orgId)).toBe(1)
    })

    it('the same id in another organization is another request', async () => {
      const a = await org()
      const b = await org()
      const key = newKey()
      const inA = await a.call('POST', c.path, c.body(a), key)
      const inB = await b.call('POST', c.path, c.body(b), key)
      expect(inA.status).toBe(200)
      expect(inB.status).toBe(200)
      expect(c.idOf(inB.json)).not.toBe(c.idOf(inA.json))
      expect(inB.json.replayed).toBeUndefined()
      expect(await c.count(a.orgId)).toBe(1)
      expect(await c.count(b.orgId)).toBe(1)
    })

    it('no id behaves as today: two requests make two documents', async () => {
      const w = await org()
      const one = await w.call('POST', c.path, c.body(w))
      const two = await w.call('POST', c.path, c.body(w))
      expect(one.status).toBe(200)
      expect(two.status).toBe(200)
      expect(c.idOf(two.json)).not.toBe(c.idOf(one.json))
      expect(await c.count(w.orgId)).toBe(2)
    })

    it('a malformed id is refused, and nothing is made', async () => {
      const w = await org()
      const res = await w.call('POST', c.path, c.body(w), 'bad key!')
      expect(res.status).toBe(400)
      expect(res.json.code).toBe('idempotency_key_invalid')
      expect(await c.count(w.orgId)).toBe(0)
    })
  })
}

describe('FR-29.13 — what the id is stored as', () => {
  it('an order keeps it as `createdFrom` with the source `form`; a movement as `requestId`', async () => {
    const w = await org()
    const k1 = newKey()
    const k2 = newKey()
    const k3 = newKey()
    await w.call('POST', CREATES[0].path, CREATES[0].body(w), k1)
    await w.call('POST', CREATES[1].path, CREATES[1].body(w), k2)
    await w.call('POST', CREATES[2].path, CREATES[2].body(w), k3)
    const order: any = await Order.findOne({ orgId: w.orgId }).lean().exec()
    const ordi: any = await InternalOrder.findOne({ orgId: w.orgId }).lean().exec()
    const movement: any = await StockMovement.findOne({ orgId: w.orgId }).lean().exec()
    expect(order.createdFrom).toEqual({ source: 'form', requestId: k1 })
    expect(ordi.createdFrom).toEqual({ source: 'form', requestId: k2 })
    expect(movement.requestId).toBe(k3)
  })

  it('a create without an id stores none', async () => {
    const w = await org()
    await w.call('POST', CREATES[0].path, CREATES[0].body(w))
    await w.call('POST', CREATES[2].path, CREATES[2].body(w))
    const order: any = await Order.findOne({ orgId: w.orgId }).lean().exec()
    const movement: any = await StockMovement.findOne({ orgId: w.orgId }).lean().exec()
    expect(order.createdFrom).toBeUndefined()
    expect(movement.requestId).toBeUndefined()
  })

  it('a replayed goods receipt does not apply its product update again', async () => {
    const w = await org()
    const key = newKey()
    const body = CREATES[3].body(w)
    await w.call('POST', CREATES[3].path, body, key)
    await Product.updateOne({ _id: w.bolt._id }, { $set: { purchasePrice: 7 } }).exec()
    const again = await w.call('POST', CREATES[3].path, body, key)
    expect(again.status).toBe(200)
    expect(again.json.updatedProductIds).toEqual([])
    const bolt: any = await Product.findById(w.bolt._id).lean().exec()
    expect(bolt.purchasePrice).toBe(7)
  })

  it('a supplier order with staged reservations, repeated with its id, is one order with its reservations once', async () => {
    const w = await org()
    const key = newKey()
    const body = {
      ...CREATES[0].body(w),
      supplierGroups: [{
        supplierId: w.id(w.supplier),
        lines: [{
          productId: w.id(w.bolt), description: 'Hex bolt M8x40', quantity: 10, unit: 'pcs',
          allocations: [{ warehouseId: w.id(w.main), quantity: 10, clientKey: 'a1' }],
        }],
      }],
      reservationChanges: { create: [{ allocationKey: 'a1', contactId: w.id(w.client), quantity: 3 }] },
    }
    const first = await w.call('POST', '/invoicing/orders', body, key)
    expect(first.status).toBe(200)
    const second = await w.call('POST', '/invoicing/orders', body, key)
    expect(second.status).toBe(200)
    expect(String(second.json.order._id)).toBe(String(first.json.order._id))
    expect(await Order.countDocuments({ orgId: w.orgId }).exec()).toBe(1)
    expect(await Reservation.countDocuments({ orgId: w.orgId, status: { $ne: 'cancelled' } }).exec()).toBe(1)
  })
})

describe('isRequestIdTaken', () => {
  it('reads the driver duplicate on either field, and the DAL one', () => {
    expect(isRequestIdTaken({ code: 11000, keyPattern: { orgId: 1, requestId: 1 } })).toBe(true)
    expect(isRequestIdTaken({ code: 11000, keyPattern: { orgId: 1, 'createdFrom.requestId': 1 } })).toBe(true)
    expect(isRequestIdTaken({ code: 11000, keyPattern: { orgId: 1, movementNumber: 1 } })).toBe(false)
    expect(isRequestIdTaken({ code: 11000, message: 'E11000 duplicate key error index: orgId_1_requestId_1' })).toBe(true)
    expect(isRequestIdTaken({ code: 'DUPLICATE', fields: { orgId: 'x', requestId: 'k' } })).toBe(true)
    expect(isRequestIdTaken({ code: 'DUPLICATE', fields: { orgId: 'x', movementNumber: 'SM-1' } })).toBe(false)
    expect(isRequestIdTaken(new Error('boom'))).toBe(false)
  })
})
