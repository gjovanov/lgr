import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestUser, createTestContact, createTestWarehouse, createTestProduct, createTestStockLevel,
} from '../helpers/factories'
import { orderController } from 'invoicing-api/src/controllers/order.controller'
import { internalOrderController } from 'invoicing-api/src/controllers/internal-order.controller'
import { reservationController } from 'invoicing-api/src/controllers/reservation.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { Order, Reservation, StockLevel } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * FR-28.45 — a reservation's page draws the supply it hangs on: `detail.supply` of `GET /reservations/:id`.
 *
 *  - a supplier-order reservation: the order's line, EVERY warehouse it was given, and the live reservations on them;
 *  - a stock reservation: the warehouse's figures and the active stock reservations on that article there;
 *  - this one is always among the rows (cancelled or beyond the cap too); every other cancelled one is left out;
 *  - `null` when the allocation it was on has left the order;
 *  - nothing of another organization, ever.
 *
 * Over HTTP through the real controllers, on the harness of `reservation-screen.flow.test.ts`. NOTE: no `.rejects` /
 * `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any)
    .use(orderController).use(internalOrderController).use(reservationController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

/** The id of the reservation a create or an action answered with. */
const idOf = (res: any) => String(res.json.reservation._id)

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id, { firstName: 'Мария', lastName: 'Иванова' } as any)
  const supplier = await createTestContact(org._id, { type: 'supplier', companyName: 'Beispiel Schrauben' } as any)
  const c1 = await createTestContact(org._id, { type: 'customer', companyName: 'Клиент 1' } as any)
  const c2 = await createTestContact(org._id, { type: 'customer', companyName: 'Клиент 2' } as any)
  const product = await createTestProduct(org._id, { name: 'Болт М8', unit: 'pcs' } as any)
  const product2 = await createTestProduct(org._id, { name: 'Шайба М8', unit: 'pcs' } as any)
  const w1 = await createTestWarehouse(org._id, { name: 'Склад 1', isDefault: true } as any)
  const w2 = await createTestWarehouse(org._id, { name: 'Склад 2' } as any)
  await createTestStockLevel(org._id, product._id, w1._id, { quantity: 10, reservedQuantity: 0, availableQuantity: 10 })
  await createTestStockLevel(org._id, product._id, w2._id, { quantity: 3, reservedQuantity: 0, availableQuantity: 3 })
  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'a@t.bg', username: 'admin',
    firstName: 'Мария', lastName: 'Иванова', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
  async function call(method: string, path: string, body?: any) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/invoicing${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }
  const pid = String(product._id)

  /** A supplier order for the bolts (and, when `second` is given, the washers on a line of their own), in `status`. */
  async function order(status: string, allocations: Array<{ warehouse: any; quantity: number }>, second?: { warehouse: any; quantity: number }) {
    const quantity = allocations.reduce((s, a) => s + a.quantity, 0)
    const lines: any[] = [{
      productId: pid, description: 'Болт М8', quantity, unit: 'pcs',
      allocations: allocations.map((a) => ({ warehouseId: String(a.warehouse._id), quantity: a.quantity })),
    }]
    if (second) {
      lines.push({
        productId: String(product2._id), description: 'Шайба М8', quantity: second.quantity, unit: 'pcs',
        allocations: [{ warehouseId: String(second.warehouse._id), quantity: second.quantity }],
      })
    }
    const res = await call('POST', '/orders', {
      issueDate: '2026-10-26', currency: 'EUR', tags: [],
      supplierGroups: [{ supplierId: String(supplier._id), lines }],
    })
    expect(res.status).toBe(200)
    const id = res.json.order._id
    await Order.updateOne({ _id: id }, { $set: { status } }).exec()
    const o = (await call('GET', `/orders/${id}`)).json.order
    const g = o.supplierGroups[0]
    return {
      id, number: o.orderNumber,
      alloc: (i: number, line = 0) => ({ orderId: id, groupId: g._id, lineId: g.lines[line]._id, allocationId: g.lines[line].allocations[i]._id }),
    }
  }

  /** A client's incoming order for the bolts, confirmed. */
  async function ordi(contact: any, quantity: number) {
    const res = await call('POST', '/internal-orders', {
      contactId: String(contact._id), issueDate: '2026-10-26', requestedDeliveryDate: '2026-11-10', priority: 'normal',
      lines: [{ productId: pid, description: 'Болт М8', quantity, unit: 'pcs' }],
    })
    expect(res.status).toBe(200)
    const id = res.json.internalOrder._id
    expect((await call('POST', `/internal-orders/${id}/confirm`)).status).toBe(200)
    const o = (await call('GET', `/internal-orders/${id}`)).json.internalOrder
    return { id, number: o.orderNumber, lineId: String(o.lines[0]._id) }
  }

  const reserve = (body: Record<string, any>) => call('POST', '/reservations', { productId: pid, ...body })
  const stockRes = (contact: any, warehouse: any, quantity: number, extra: Record<string, any> = {}) =>
    reserve({ source: 'stock', contactId: String(contact._id), warehouseId: String(warehouse._id), quantity, ...extra })
  const supplyOf = async (res: any) => {
    const page = await call('GET', `/reservations/${res.json.reservation._id}`)
    expect(page.status).toBe(200)
    return page.json.detail
  }

  return { orgId, org, user, supplier, c1, c2, product, product2, pid, w1, w2, call, order, ordi, reserve, stockRes, supplyOf }
}

describe('the supply of a supplier-order reservation', () => {
  it('is the order\'s line with every warehouse and the live reservations on them, this one among them', async () => {
    const w = await world()
    const sent = await w.order('sent', [{ warehouse: w.w1, quantity: 6 }, { warehouse: w.w2, quantity: 4 }])
    const mine = await w.ordi(w.c1, 3)
    const a = await w.reserve({ source: 'order', contactId: String(w.c1._id), quantity: 3, ...sent.alloc(0), internalOrderId: mine.id, internalOrderLineId: mine.lineId })
    const b = await w.reserve({ source: 'order', contactId: String(w.c2._id), quantity: 2, ...sent.alloc(0) })
    const c = await w.reserve({ source: 'order', contactId: String(w.c2._id), quantity: 1, ...sent.alloc(1) })
    for (const x of [a, b, c]) expect(x.status).toBe(200)

    const { supply } = await w.supplyOf(a)
    expect(supply).toMatchObject({ kind: 'order', truncated: false, total: 3 })
    expect(supply.line).toEqual({ _id: sent.alloc(0).lineId, description: 'Болт М8', quantity: 10, receivedQuantity: 0 })
    // BOTH warehouses of the line, named, with what each was given.
    expect(supply.allocations).toEqual([
      { _id: sent.alloc(0).allocationId, warehouseId: String(w.w1._id), warehouseName: 'Склад 1', quantity: 6, receivedQuantity: 0 },
      { _id: sent.alloc(1).allocationId, warehouseId: String(w.w2._id), warehouseName: 'Склад 2', quantity: 4, receivedQuantity: 0 },
    ])
    // Every live reservation of the line, oldest first, each with its client's name and the warehouse it is on.
    expect(supply.reservations.map((r: any) => [r._id, r.contactName, r.quantity, r.allocationId])).toEqual([
      [idOf(a), 'Клиент 1', 3, sent.alloc(0).allocationId],
      [idOf(b), 'Клиент 2', 2, sent.alloc(0).allocationId],
      [idOf(c), 'Клиент 2', 1, sent.alloc(1).allocationId],
    ])
    // What the tree needs to place and describe a row: the customer order's number, and the supplier order's ids.
    const first = supply.reservations[0]
    expect(first).toMatchObject({
      reservationNumber: a.json.reservation.reservationNumber, status: 'active', source: 'order',
      invoicedQuantity: 0, dispatchedQuantity: 0, internalOrderId: mine.id, internalOrderNumber: mine.number,
      internalOrderLineId: mine.lineId, orderId: sent.id, lineId: sent.alloc(0).lineId, contactId: String(w.c1._id),
    })
    // A reservation that serves no customer order says nothing of one (the key is absent, not an empty string).
    expect(supply.reservations[1].internalOrderId).toBeUndefined()
    expect(supply.reservations[1].internalOrderNumber).toBeUndefined()
  }, 60_000)

  it('names the same supply from every reservation on it', async () => {
    const w = await world()
    const sent = await w.order('sent', [{ warehouse: w.w1, quantity: 6 }, { warehouse: w.w2, quantity: 4 }])
    const a = await w.reserve({ source: 'order', contactId: String(w.c1._id), quantity: 3, ...sent.alloc(0) })
    const c = await w.reserve({ source: 'order', contactId: String(w.c2._id), quantity: 1, ...sent.alloc(1) })
    const fromA = (await w.supplyOf(a)).supply
    const fromC = (await w.supplyOf(c)).supply
    expect(fromC).toEqual(fromA)
  }, 60_000)

  it('leaves out every OTHER cancelled reservation, keeps a fulfilled one, and keeps this one whatever its state', async () => {
    const w = await world()
    const sent = await w.order('sent', [{ warehouse: w.w1, quantity: 6 }])
    const a = await w.reserve({ source: 'order', contactId: String(w.c1._id), quantity: 3, ...sent.alloc(0) })
    const b = await w.reserve({ source: 'order', contactId: String(w.c2._id), quantity: 2, ...sent.alloc(0) })
    const c = await w.reserve({ source: 'order', contactId: String(w.c2._id), quantity: 1, ...sent.alloc(0) })
    expect((await w.call('POST', `/reservations/${idOf(b)}/cancel`, {})).status).toBe(200)
    await Reservation.updateOne({ _id: idOf(c) }, { $set: { status: 'fulfilled' } }).exec()

    // From a live one: the cancelled one is not there, the fulfilled one is.
    const live = (await w.supplyOf(a)).supply
    expect(live.reservations.map((r: any) => [r._id, r.status])).toEqual([[idOf(a), 'active'], [idOf(c), 'fulfilled']])
    expect(live.total).toBe(2)
    // From the cancelled one: it is there itself, with its state, and the others around it.
    const cancelled = (await w.supplyOf(b)).supply
    expect(cancelled.reservations.map((r: any) => [r._id, r.status])).toEqual([[idOf(a), 'active'], [idOf(b), 'cancelled'], [idOf(c), 'fulfilled']])
    expect(cancelled.total).toBe(3)
  }, 60_000)

  it('does not take in the reservations of the order\'s other lines', async () => {
    const w = await world()
    const sent = await w.order('sent', [{ warehouse: w.w1, quantity: 6 }], { warehouse: w.w1, quantity: 5 })
    const bolts = await w.reserve({ source: 'order', contactId: String(w.c1._id), quantity: 3, ...sent.alloc(0) })
    const washers = await w.reserve({
      source: 'order', productId: String(w.product2._id), contactId: String(w.c2._id), quantity: 4, ...sent.alloc(0, 1),
    })
    expect(washers.status).toBe(200)

    const onBolts = (await w.supplyOf(bolts)).supply
    expect(onBolts.line.description).toBe('Болт М8')
    expect(onBolts.reservations.map((r: any) => r._id)).toEqual([idOf(bolts)])
    const onWashers = (await w.supplyOf(washers)).supply
    expect(onWashers.line.description).toBe('Шайба М8')
    expect(onWashers.reservations.map((r: any) => r._id)).toEqual([idOf(washers)])
  }, 60_000)

  it('is null when the allocation it was on has left the order, or the order itself is gone', async () => {
    const w = await world()
    const sent = await w.order('sent', [{ warehouse: w.w1, quantity: 6 }])
    const a = await w.reserve({ source: 'order', contactId: String(w.c1._id), quantity: 3, ...sent.alloc(0) })
    expect((await w.supplyOf(a)).supply).toMatchObject({ kind: 'order' })

    await Order.updateOne({ _id: sent.id }, { $set: { 'supplierGroups.0.lines.0.allocations': [] } }).exec()
    const gone = await w.supplyOf(a)
    expect(gone.allocation).toBeNull()
    expect(gone.supply).toBeNull()

    await Order.deleteOne({ _id: sent.id }).exec()
    const noOrder = await w.supplyOf(a)
    expect(noOrder.order).toBeNull()
    expect(noOrder.supply).toBeNull()
  }, 60_000)
})

describe('the supply of a stock reservation', () => {
  it('is the warehouse\'s figures and the ACTIVE stock reservations on that article there', async () => {
    const w = await world()
    const x = await w.stockRes(w.c1, w.w1, 2)
    const y = await w.stockRes(w.c2, w.w1, 3)
    // Not on this supply: another warehouse, a cancelled hold, and a hold on a supplier order's goods.
    await w.stockRes(w.c2, w.w2, 1)
    const z = await w.stockRes(w.c1, w.w1, 1)
    expect((await w.call('POST', `/reservations/${idOf(z)}/cancel`, {})).status).toBe(200)
    const sent = await w.order('sent', [{ warehouse: w.w1, quantity: 5 }])
    expect((await w.reserve({ source: 'order', contactId: String(w.c1._id), quantity: 1, ...sent.alloc(0) })).status).toBe(200)

    const { supply } = await w.supplyOf(x)
    expect(supply).toMatchObject({ kind: 'stock', truncated: false, total: 2 })
    // On the shelf 10; 2 and 3 are held; the supplier order's goods have not arrived, so nothing of theirs is held here.
    expect(supply.warehouse).toEqual({ _id: String(w.w1._id), name: 'Склад 1', onHand: 10, available: 5 })
    expect(supply.reservations.map((r: any) => [r._id, r.contactName, r.quantity, r.source, r.warehouseId])).toEqual([
      [idOf(x), 'Клиент 1', 2, 'stock', String(w.w1._id)],
      [idOf(y), 'Клиент 2', 3, 'stock', String(w.w1._id)],
    ])
    // It has no line or allocations: those belong to a supplier order.
    expect(supply.line).toBeUndefined()
    expect(supply.allocations).toBeUndefined()

    // Cancelled, the page about z still shows where it was: the warehouse, and the live holds beside it.
    const fromZ = (await w.supplyOf(z)).supply
    expect(fromZ.reservations.map((r: any) => [r._id, r.status])).toEqual([[idOf(x), 'active'], [idOf(y), 'active'], [idOf(z), 'cancelled']])
  }, 60_000)

  it('still names the warehouse when its stock level is gone', async () => {
    const w = await world()
    const x = await w.stockRes(w.c1, w.w1, 2)
    await StockLevel.deleteMany({ orgId: w.orgId }).exec()
    const { supply } = await w.supplyOf(x)
    expect(supply.warehouse).toEqual({ _id: String(w.w1._id), name: 'Склад 1', onHand: 0, available: 0 })
    expect(supply.reservations.map((r: any) => r._id)).toEqual([idOf(x)])
  }, 60_000)
})

describe('how many reservations the supply names', () => {
  it('stops at a cap, keeps this one even when the cap does not reach it, and says it was cut', async () => {
    const w = await world()
    await StockLevel.updateOne({ orgId: w.orgId, productId: w.pid, warehouseId: String(w.w1._id) }, { $set: { quantity: 1000, availableQuantity: 1000 } }).exec()
    // 205 older holds, then this one: the newest, which a plain "first 200" would drop.
    await Reservation.insertMany(Array.from({ length: 205 }, (_, i) => ({
      orgId: w.orgId, reservationNumber: `RES-CAP-${String(i).padStart(4, '0')}`, status: 'active',
      contactId: w.c2._id, source: 'stock', warehouseId: w.w1._id, productId: w.product._id, quantity: 1,
    })))
    const mine = await w.stockRes(w.c1, w.w1, 2)
    expect(mine.status).toBe(200)

    const { supply } = await w.supplyOf(mine)
    expect(supply.truncated).toBe(true)
    expect(supply.total).toBe(206)
    expect(supply.reservations).toHaveLength(201)
    const ids = supply.reservations.map((r: any) => r._id)
    expect(ids).toContain(idOf(mine))
    expect(ids[ids.length - 1]).toBe(idOf(mine))
    expect(new Set(ids).size).toBe(201)
  }, 120_000)

  it('is not cut below the cap', async () => {
    const w = await world()
    const x = await w.stockRes(w.c1, w.w1, 2)
    const { supply } = await w.supplyOf(x)
    expect(supply).toMatchObject({ truncated: false, total: 1 })
  }, 60_000)
})

describe('whose rows the supply names', () => {
  it('never those of another organization, even where they name this one\'s article, warehouse and order', async () => {
    const w = await world()
    const sent = await w.order('sent', [{ warehouse: w.w1, quantity: 6 }])
    const stock = await w.stockRes(w.c1, w.w1, 2)
    const onOrder = await w.reserve({ source: 'order', contactId: String(w.c1._id), quantity: 1, ...sent.alloc(0) })

    // Another organization, with a client of its own and stray rows that point at THIS organization's ids.
    const other = await createTestOrg()
    const stranger = await createTestContact(other._id, { type: 'customer', companyName: 'Чужд клиент' } as any)
    await Reservation.create({
      orgId: other._id, reservationNumber: 'RES-FOREIGN-1', status: 'active', contactId: stranger._id, source: 'stock',
      warehouseId: w.w1._id, productId: w.product._id, quantity: 1,
    })
    await Reservation.create({
      orgId: other._id, reservationNumber: 'RES-FOREIGN-2', status: 'active', contactId: stranger._id, source: 'order',
      warehouseId: w.w1._id, productId: w.product._id, quantity: 1,
      orderId: sent.id, lineId: sent.alloc(0).lineId, allocationId: sent.alloc(0).allocationId,
    })
    // And a row of THIS organization whose client is another organization's: the name is not read across.
    await Reservation.create({
      orgId: w.orgId, reservationNumber: 'RES-ODD-1', status: 'active', contactId: stranger._id, source: 'stock',
      warehouseId: w.w1._id, productId: w.product._id, quantity: 1,
    })

    const onStock = (await w.supplyOf(stock)).supply
    const numbers = onStock.reservations.map((r: any) => r.reservationNumber)
    expect(numbers).not.toContain('RES-FOREIGN-1')
    expect(JSON.stringify(onStock)).not.toContain('Чужд клиент')
    expect(onStock.reservations.find((r: any) => r.reservationNumber === 'RES-ODD-1').contactName).toBe('')

    const onSupplier = (await w.supplyOf(onOrder)).supply
    expect(onSupplier.reservations.map((r: any) => r.reservationNumber)).toEqual([onOrder.json.reservation.reservationNumber])
    expect(JSON.stringify(onSupplier)).not.toContain('Чужд клиент')
  }, 60_000)
})
