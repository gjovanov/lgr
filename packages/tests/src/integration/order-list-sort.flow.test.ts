import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact, createTestProduct, createTestWarehouse } from '../helpers/factories'
import { internalOrderController } from 'invoicing-api/src/controllers/internal-order.controller'
import { orderController } from 'invoicing-api/src/controllers/order.controller'
import { reservationController } from 'invoicing-api/src/controllers/reservation.controller'
import { InternalOrder, Order, Reservation } from 'db/models'
import { mongoose } from 'db/connection'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * FR-22.10 (B-12): sorting by № works on the order and reservation lists.
 *
 * The grids sort by the key of the column they render, and the № column's key is `number` — a
 * field the controllers add to each row AFTER the query. Mongo sorted on a field no document has,
 * so the „№" header changed nothing. The documents are created out of numbering order here, so
 * neither creation order nor natural order can pass for a sort.
 */

const { Types } = mongoose
let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(internalOrderController).use(orderController).use(reservationController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

async function world() {
  const org = await createTestOrg()
  const user = await createTestUser(org._id)
  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId: String(org._id), role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Test', lastName: 'Admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
  const list = async (path: string, key: string, sortOrder: 'asc' | 'desc') => {
    const res = await app.handle(new Request(`http://localhost/org/${org._id}${path}?page=0&size=10&sortBy=number&sortOrder=${sortOrder}`, {
      headers: { authorization: `Bearer ${token}` },
    }))
    expect(res.status).toBe(200)
    return ((await res.json()) as any)[key].map((row: any) => row.number)
  }
  return {
    org,
    list,
    client: await createTestContact(org._id),
    supplier: await createTestContact(org._id, { type: 'supplier' }),
    product: await createTestProduct(org._id),
    wh: await createTestWarehouse(org._id, { isDefault: true }),
  }
}

const OUT_OF_ORDER = [2, 3, 1]
const numbered = (prefix: string, n: number) => `${prefix}-2026-${String(n).padStart(5, '0')}`

describe('№ sorting on the order and reservation lists (FR-22.10, B-12)', () => {
  it('client orders (ORDI)', async () => {
    const w = await world()
    for (const n of OUT_OF_ORDER) {
      await InternalOrder.create({
        orgId: w.org._id, orderNumber: numbered('ORDI', n), status: 'confirmed', contactId: w.client._id,
        issueDate: new Date(), requestedDeliveryDate: new Date(),
        lines: [{ productId: w.product._id, description: 'x', quantity: 1, unit: 'pcs' }],
        createdBy: new Types.ObjectId(),
      } as any)
    }
    expect(await w.list('/invoicing/internal-orders', 'internalOrders', 'asc')).toEqual([1, 2, 3].map((n) => numbered('ORDI', n)))
    expect(await w.list('/invoicing/internal-orders', 'internalOrders', 'desc')).toEqual([3, 2, 1].map((n) => numbered('ORDI', n)))
  })

  it('supplier orders (ORDO)', async () => {
    const w = await world()
    for (const n of OUT_OF_ORDER) {
      await Order.create({
        orgId: w.org._id, orderNumber: numbered('ORDO', n), status: 'sent', issueDate: new Date(),
        supplierGroups: [{ supplierId: w.supplier._id, lines: [{ productId: w.product._id, description: 'x', quantity: 1, unit: 'pcs', allocations: [] }] }],
        createdBy: new Types.ObjectId(),
      } as any)
    }
    expect(await w.list('/invoicing/orders', 'orders', 'asc')).toEqual([1, 2, 3].map((n) => numbered('ORDO', n)))
    expect(await w.list('/invoicing/orders', 'orders', 'desc')).toEqual([3, 2, 1].map((n) => numbered('ORDO', n)))
  })

  it('reservations (RES)', async () => {
    const w = await world()
    for (const n of OUT_OF_ORDER) {
      await Reservation.create({
        orgId: w.org._id, reservationNumber: numbered('RES', n), status: 'active', contactId: w.client._id,
        source: 'stock', warehouseId: w.wh._id, productId: w.product._id, quantity: 1,
        createdBy: new Types.ObjectId(),
      } as any)
    }
    expect(await w.list('/invoicing/reservations', 'reservations', 'asc')).toEqual([1, 2, 3].map((n) => numbered('RES', n)))
    expect(await w.list('/invoicing/reservations', 'reservations', 'desc')).toEqual([3, 2, 1].map((n) => numbered('RES', n)))
  })
})
