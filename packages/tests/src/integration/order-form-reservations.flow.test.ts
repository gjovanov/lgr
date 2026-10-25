import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestUser, createTestContact, createTestWarehouse, createTestProduct, createTestStockLevel,
} from '../helpers/factories'
import { orderController } from 'invoicing-api/src/controllers/order.controller'
import { reservationController } from 'invoicing-api/src/controllers/reservation.controller'
import { productSupplyController } from 'invoicing-api/src/controllers/product-supply.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { Order, Reservation } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * #203 — client reservations inside the outgoing-order form, saved with the order; a reservation
 * changed in place or reserved again; a draft order's delete taking its reservations along; and
 * a product's supply picture.
 *
 * Over HTTP through the real controllers: the transaction and the rules live on those routes.
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(orderController).use(reservationController).use(productSupplyController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const supplier = await createTestContact(org._id, { type: 'supplier', companyName: 'Fastbolt' } as any)
  const c1 = await createTestContact(org._id, { type: 'customer', companyName: 'Клиент 1' } as any)
  const c2 = await createTestContact(org._id, { type: 'customer', companyName: 'Клиент 2' } as any)
  const product = await createTestProduct(org._id, { name: 'Болт М8' } as any)
  const w1 = await createTestWarehouse(org._id, { name: 'Склад 1', isDefault: true } as any)
  const w2 = await createTestWarehouse(org._id, { name: 'Склад 2' } as any)
  await createTestStockLevel(org._id, product._id, w1._id, { quantity: 10 })
  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'a@t.bg', username: 'admin',
    firstName: 'A', lastName: 'B', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
  async function call(method: string, path: string, body?: any) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/invoicing${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }
  /** One supplier, one line of 10 bolts, split over the two warehouses. */
  const groups = (a1: number, a2: number, ids?: { group?: string; line?: string; a1?: string; a2?: string }) => [{
    ...(ids?.group ? { _id: ids.group } : {}),
    supplierId: String(supplier._id),
    lines: [{
      ...(ids?.line ? { _id: ids.line } : {}),
      productId: String(product._id), description: 'Болт М8', quantity: 10, unit: 'pcs',
      allocations: [
        { ...(ids?.a1 ? { _id: ids.a1 } : { clientKey: 'k1' }), warehouseId: String(w1._id), quantity: a1 },
        { ...(ids?.a2 ? { _id: ids.a2 } : { clientKey: 'k2' }), warehouseId: String(w2._id), quantity: a2 },
      ],
    }],
  }]
  const body = (extra: Record<string, any> = {}) => ({ issueDate: '2026-10-25', currency: 'EUR', tags: [], ...extra })
  const load = async (id: string) => (await call('GET', `/orders/${id}`)).json
  /** The saved ids of the line's allocations, in order. */
  const idsOf = (order: any) => {
    const g = order.supplierGroups[0]
    const l = g.lines[0]
    return { group: String(g._id), line: String(l._id), a1: String(l.allocations[0]._id), a2: String(l.allocations[1]._id) }
  }
  return { orgId, supplier, c1, c2, product, w1, w2, call, groups, body, load, idsOf }
}

describe('client reservations in the outgoing-order form', () => {
  it('a NEW order takes reservations staged on its new allocations, in one save', async () => {
    const w = await world()
    const res = await w.call('POST', '/orders', w.body({
      supplierGroups: w.groups(6, 4),
      reservationChanges: {
        create: [
          { allocationKey: 'k1', contactId: String(w.c1._id), quantity: 3 },
          { allocationKey: 'k1', contactId: String(w.c2._id), quantity: 2 },
          { allocationKey: 'k2', contactId: String(w.c1._id), quantity: 4 },
        ],
      },
    }))
    expect(res.status).toBe(200)
    const { order, reservations } = await w.load(res.json.order._id)
    const ids = w.idsOf(order)
    expect(reservations).toHaveLength(3)
    expect(reservations.map((r: any) => [String(r.allocationId), String(r.contactId), r.quantity, r.status])).toEqual([
      [ids.a1, String(w.c1._id), 3, 'active'],
      [ids.a1, String(w.c2._id), 2, 'active'],
      [ids.a2, String(w.c1._id), 4, 'active'],
    ])
    expect(reservations.every((r: any) => /^RES-/.test(r.reservationNumber))).toBe(true)
    expect(reservations.every((r: any) => String(r.groupId) === ids.group && String(r.lineId) === ids.line)).toBe(true)
  }, 60_000)

  it('refuses reservations beyond an allocation, and then saves nothing at all', async () => {
    const w = await world()
    const res = await w.call('POST', '/orders', w.body({
      supplierGroups: w.groups(5, 5),
      reservationChanges: { create: [
        { allocationKey: 'k1', contactId: String(w.c1._id), quantity: 3 },
        { allocationKey: 'k1', contactId: String(w.c2._id), quantity: 3 },
      ] },
    }))
    expect(res.status).toBe(422)
    expect(res.json.message).toContain('exceed the allocated 5')
    expect(await Order.countDocuments({ orgId: w.orgId }).exec()).toBe(0)
    expect(await Reservation.countDocuments({ orgId: w.orgId }).exec()).toBe(0)
  }, 60_000)

  it('lowers an allocation together with its reservations in one save', async () => {
    const w = await world()
    const created = await w.call('POST', '/orders', w.body({
      supplierGroups: w.groups(6, 4),
      reservationChanges: { create: [
        { allocationKey: 'k1', contactId: String(w.c1._id), quantity: 3 },
        { allocationKey: 'k1', contactId: String(w.c2._id), quantity: 2 },
      ] },
    }))
    const id = created.json.order._id
    const { order, reservations } = await w.load(id)
    const ids = w.idsOf(order)
    const [r1, r2] = reservations

    // Without the reservation changes, the shrink is refused as it always was.
    const legacy = await w.call('PUT', `/orders/${id}`, w.body({ supplierGroups: w.groups(3, 4, ids) }))
    expect(legacy.status).toBe(409)

    const res = await w.call('PUT', `/orders/${id}`, w.body({
      supplierGroups: w.groups(3, 4, ids),
      reservationChanges: { update: [{ id: r1._id, quantity: 1 }], cancel: [{ id: r2._id }] },
    }))
    expect(res.status).toBe(200)
    const after = await w.load(id)
    expect(w.idsOf(after.order)).toEqual(ids)
    expect(after.order.supplierGroups[0].lines[0].allocations[0].quantity).toBe(3)
    const byId = new Map(after.reservations.map((r: any) => [r._id, r]))
    expect((byId.get(r1._id) as any).quantity).toBe(1)
    expect((byId.get(r2._id) as any).status).toBe('cancelled')
  }, 60_000)

  it('a refused raise rolls the whole save back, the order included', async () => {
    const w = await world()
    const created = await w.call('POST', '/orders', w.body({
      supplierGroups: w.groups(6, 4),
      reservationChanges: { create: [{ allocationKey: 'k1', contactId: String(w.c1._id), quantity: 3 }] },
    }))
    const id = created.json.order._id
    const { order, reservations } = await w.load(id)
    const ids = w.idsOf(order)

    const res = await w.call('PUT', `/orders/${id}`, w.body({
      supplierGroups: w.groups(6, 2, ids),
      notes: 'changed',
      reservationChanges: { update: [{ id: reservations[0]._id, quantity: 7 }] },
    }))
    expect(res.status).toBe(422)
    const after = await w.load(id)
    expect(after.order.notes).toBeUndefined()
    expect(after.order.supplierGroups[0].lines[0].allocations[1].quantity).toBe(4)
    expect(after.reservations[0].quantity).toBe(3)
  }, 60_000)

  it('moves a reservation to another client while nothing of it is consumed', async () => {
    const w = await world()
    const created = await w.call('POST', '/orders', w.body({
      supplierGroups: w.groups(6, 4),
      reservationChanges: { create: [{ allocationKey: 'k1', contactId: String(w.c1._id), quantity: 3 }] },
    }))
    const id = created.json.order._id
    const { order, reservations } = await w.load(id)
    const ids = w.idsOf(order)
    const rid = reservations[0]._id

    const moved = await w.call('PUT', `/orders/${id}`, w.body({
      supplierGroups: w.groups(6, 4, ids),
      reservationChanges: { update: [{ id: rid, contactId: String(w.c2._id) }] },
    }))
    expect(moved.status).toBe(200)
    expect(String((await Reservation.findById(rid).lean().exec() as any).contactId)).toBe(String(w.c2._id))

    await Reservation.updateOne({ _id: rid }, { $set: { invoicedQuantity: 1 } }).exec()
    const refused = await w.call('PUT', `/orders/${id}`, w.body({
      supplierGroups: w.groups(6, 4, ids),
      reservationChanges: { update: [{ id: rid, contactId: String(w.c1._id) }] },
    }))
    expect(refused.status).toBe(422)
  }, 60_000)

  it('deleting a draft order cancels its reservations instead of orphaning them', async () => {
    const w = await world()
    const created = await w.call('POST', '/orders', w.body({
      supplierGroups: w.groups(6, 4),
      reservationChanges: { create: [{ allocationKey: 'k2', contactId: String(w.c1._id), quantity: 2 }] },
    }))
    const id = created.json.order._id
    const res = await w.call('DELETE', `/orders/${id}`)
    expect(res.status).toBe(200)
    const left: any[] = await Reservation.find({ orgId: w.orgId }).lean().exec()
    expect(left.map(r => [r.status, r.cancelReason])).toEqual([['cancelled', 'external_order_cancelled']])
  }, 60_000)
})

describe('a reservation changed in place, and reserved again', () => {
  async function withReservation() {
    const w = await world()
    const created = await w.call('POST', '/orders', w.body({
      supplierGroups: w.groups(6, 4),
      reservationChanges: { create: [{ allocationKey: 'k1', contactId: String(w.c1._id), quantity: 3 }] },
    }))
    const { order, reservations } = await w.load(created.json.order._id)
    return { ...w, orderId: created.json.order._id, ids: w.idsOf(order), rid: reservations[0]._id as string }
  }

  it('raises within the allocation, refuses beyond it and below what was invoiced', async () => {
    const w = await withReservation()
    const up = await w.call('POST', `/reservations/${w.rid}/update`, { quantity: 6 })
    expect(up.status).toBe(200)
    expect(up.json.reservation.quantity).toBe(6)
    expect((await w.call('POST', `/reservations/${w.rid}/update`, { quantity: 7 })).status).toBe(422)

    await Reservation.updateOne({ _id: w.rid }, { $set: { invoicedQuantity: 4 } }).exec()
    const down = await w.call('POST', `/reservations/${w.rid}/update`, { quantity: 3 })
    expect(down.status).toBe(422)
    expect(down.json.message).toContain('(4)')
  }, 60_000)

  it('a fulfilled reservation is closed: neither the order nor the update endpoint changes it', async () => {
    const w = await withReservation()
    await Reservation.updateOne({ _id: w.rid }, { $set: { status: 'fulfilled', invoicedQuantity: 3, dispatchedQuantity: 3 } }).exec()
    const supplierGroups = w.groups(6, 4, w.ids)

    const raise = await w.call('PUT', `/orders/${w.orderId}`, w.body({ supplierGroups, reservationChanges: { update: [{ id: w.rid, quantity: 5 }] } }))
    expect(raise.status).toBe(422)
    expect(raise.json.message).toContain('fulfilled')
    const cancel = await w.call('PUT', `/orders/${w.orderId}`, w.body({ supplierGroups, reservationChanges: { cancel: [{ id: w.rid }] } }))
    expect(cancel.status).toBe(422)
    expect((await w.call('POST', `/reservations/${w.rid}/update`, { quantity: 5 })).status).toBe(422)

    const res: any = await Reservation.findById(w.rid).lean().exec()
    expect([res.status, res.quantity]).toEqual(['fulfilled', 3])
  }, 60_000)

  it('a cancelled reservation is reserved again, once', async () => {
    const w = await withReservation()
    expect((await w.call('POST', `/reservations/${w.rid}/repeat`, {})).status).toBe(422)

    await w.call('POST', `/reservations/${w.rid}/cancel`, {})
    const first = await w.call('POST', `/reservations/${w.rid}/repeat`, {})
    expect(first.status).toBe(200)
    expect(first.json.created).toBe(true)
    expect(first.json.reservation).toMatchObject({ status: 'active', quantity: 3 })
    expect(String(first.json.reservation.repeatOf)).toBe(w.rid)
    expect(String(first.json.reservation.allocationId)).toBe(w.ids.a1)

    const again = await w.call('POST', `/reservations/${w.rid}/repeat`, {})
    expect(again.json.created).toBe(false)
    expect(again.json.reservation._id).toBe(first.json.reservation._id)
    expect(await Reservation.countDocuments({ orgId: w.orgId, status: 'active' }).exec()).toBe(1)
  }, 60_000)

  it('says why when the supply of a cancelled reservation is gone', async () => {
    const w = await withReservation()
    await w.call('POST', `/reservations/${w.rid}/cancel`, {})
    // The allocation it pointed at is dropped from the order.
    const g = w.groups(6, 4, w.ids)
    g[0].lines[0].allocations = [g[0].lines[0].allocations[1]]
    expect((await w.call('PUT', `/orders/${w.orderId}`, w.body({ supplierGroups: g }))).status).toBe(200)
    const res = await w.call('POST', `/reservations/${w.rid}/repeat`, {})
    expect(res.status).toBe(404)
    expect(res.json.message).toMatch(/allocation/i)
  }, 60_000)
})

describe('a product\'s supply', () => {
  it('shows the shelf, its holds, what is on its way and how much of that is promised', async () => {
    const w = await world()
    // A sent order: 6 bolts on their way to Склад 1, 3 of them reserved for Клиент 1.
    const created = await w.call('POST', '/orders', w.body({
      supplierGroups: w.groups(6, 4),
      reservationChanges: { create: [{ allocationKey: 'k1', contactId: String(w.c1._id), quantity: 3 }] },
    }))
    const id = created.json.order._id
    await Order.updateOne({ _id: id }, { $set: { status: 'sent', expectedDate: new Date('2026-11-05') } }).exec()
    // And 2 of the 10 on the shelf held for Клиент 2.
    const held = await w.call('POST', '/reservations', {
      source: 'stock', productId: String(w.product._id), warehouseId: String(w.w1._id), contactId: String(w.c2._id), quantity: 2,
    })
    expect(held.status).toBe(200)

    const res = await w.call('GET', `/product-supply/${w.product._id}`)
    expect(res.status).toBe(200)
    const s = res.json.supply
    const w1 = s.warehouses.find((x: any) => x.warehouseId === String(w.w1._id))
    expect(w1).toMatchObject({ onHand: 10, reserved: 2, available: 8, incoming: 6, reservedIncoming: 3, planned: 0 })
    expect(new Date(w1.expectedDate).toISOString().slice(0, 10)).toBe('2026-11-05')
    const toW1 = s.incoming.find((i: any) => i.warehouseId === String(w.w1._id))
    expect(toW1).toMatchObject({ ordered: 6, received: 0, outstanding: 6, reservedIncoming: 3, planned: false })
    expect(toW1.clients).toEqual([{ contactId: String(w.c1._id), name: 'Клиент 1', quantity: 3 }])
    expect(s.reservations.map((r: any) => [r.source, r.contactName, r.quantity])).toEqual([
      ['order', 'Клиент 1', 3], ['stock', 'Клиент 2', 2],
    ])
  }, 60_000)

  it('a draft order is planned, not incoming', async () => {
    const w = await world()
    await w.call('POST', '/orders', w.body({ supplierGroups: w.groups(6, 4) }))
    const s = (await w.call('GET', `/product-supply/${w.product._id}`)).json.supply
    const w2 = s.warehouses.find((x: any) => x.warehouseId === String(w.w2._id))
    expect(w2).toMatchObject({ incoming: 0, planned: 4 })
  }, 60_000)
})
