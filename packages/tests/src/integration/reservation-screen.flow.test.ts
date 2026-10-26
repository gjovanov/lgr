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
import { Invoice, Order, Reservation, StockLevel } from 'db/models'
import { syncOrderForInvoice } from 'services/biz/reservation.service'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * FR-22.37 — reservations get a screen: what a new reservation can take (`/sources`), why one is
 * refused (a code and the figure, for the user's language), a page that names everything the
 * reservation is linked to, a release of part of it, and a repeat that may take another source.
 *
 * Over HTTP through the real controllers. NOTE: no `.rejects` / `.resolves` (Bun-on-Windows
 * deadlock, see Known Issues).
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

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id, { firstName: 'Мария', lastName: 'Иванова' } as any)
  const supplier = await createTestContact(org._id, { type: 'supplier', companyName: 'Fastbolt' } as any)
  const c1 = await createTestContact(org._id, { type: 'customer', companyName: 'Клиент 1' } as any)
  const c2 = await createTestContact(org._id, { type: 'customer', companyName: 'Клиент 2' } as any)
  const product = await createTestProduct(org._id, { name: 'Болт М8', unit: 'pcs' } as any)
  const w1 = await createTestWarehouse(org._id, { name: 'Склад 1', isDefault: true } as any)
  const w2 = await createTestWarehouse(org._id, { name: 'Склад 2' } as any)
  const w3 = await createTestWarehouse(org._id, { name: 'Стар склад', isActive: false } as any)
  await createTestStockLevel(org._id, product._id, w1._id, { quantity: 10, reservedQuantity: 0, availableQuantity: 10 })
  await createTestStockLevel(org._id, product._id, w2._id, { quantity: 3, reservedQuantity: 0, availableQuantity: 3 })
  await createTestStockLevel(org._id, product._id, w3._id, { quantity: 5, reservedQuantity: 0, availableQuantity: 5 })
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

  /** A supplier order for the bolts, one allocation per warehouse given, in `status`. */
  async function order(status: string, allocations: Array<{ warehouse: any; quantity: number }>, expectedDate?: string) {
    const quantity = allocations.reduce((s, a) => s + a.quantity, 0)
    const res = await call('POST', '/orders', {
      issueDate: '2026-10-26', currency: 'EUR', tags: [],
      supplierGroups: [{
        supplierId: String(supplier._id),
        lines: [{
          productId: pid, description: 'Болт М8', quantity, unit: 'pcs',
          allocations: allocations.map((a) => ({ warehouseId: String(a.warehouse._id), quantity: a.quantity })),
        }],
      }],
    })
    expect(res.status).toBe(200)
    const id = res.json.order._id
    await Order.updateOne({ _id: id }, { $set: { status, ...(expectedDate ? { expectedDate: new Date(expectedDate) } : {}) } }).exec()
    const o = (await call('GET', `/orders/${id}`)).json.order
    const g = o.supplierGroups[0]
    const l = g.lines[0]
    return {
      id, number: o.orderNumber,
      alloc: (i: number) => ({ orderId: id, groupId: g._id, lineId: l._id, allocationId: l.allocations[i]._id }),
    }
  }

  /** A client's incoming order for the bolts, confirmed unless `draft`. */
  async function ordi(contact: any, quantity: number, opts: { draft?: boolean; priority?: string } = {}) {
    const res = await call('POST', '/internal-orders', {
      contactId: String(contact._id), issueDate: '2026-10-26', requestedDeliveryDate: '2026-11-10',
      priority: opts.priority || 'normal',
      lines: [{ productId: pid, description: 'Болт М8', quantity, unit: 'pcs' }],
    })
    expect(res.status).toBe(200)
    const id = res.json.internalOrder._id
    if (!opts.draft) expect((await call('POST', `/internal-orders/${id}/confirm`)).status).toBe(200)
    const o = (await call('GET', `/internal-orders/${id}`)).json.internalOrder
    return { id, number: o.orderNumber, lineId: String(o.lines[0]._id) }
  }

  const reserve = (body: Record<string, any>) => call('POST', '/reservations', { productId: pid, ...body })
  const stockRes = (contact: any, warehouse: any, quantity: number, extra: Record<string, any> = {}) =>
    reserve({ source: 'stock', contactId: String(contact._id), warehouseId: String(warehouse._id), quantity, ...extra })

  /** A draft sales invoice taking `quantity` of a reservation: what makes it "invoiced". */
  async function invoiceOf(res: any, quantity: number) {
    const inv = await Invoice.create({
      orgId, invoiceNumber: `DRF-INV-${Date.now()}-${quantity}`, type: 'invoice', direction: 'outgoing', status: 'draft',
      contactId: res.contactId, issueDate: new Date(), dueDate: new Date(), currency: 'EUR', exchangeRate: 1,
      lines: [{
        productId: pid, description: 'Болт М8', quantity, unit: 'pcs', unitPrice: 1, discount: 0, taxRate: 20,
        taxAmount: 0, lineTotal: 0, warehouseId: res.warehouseId,
        orderRef: { reservationId: res._id, ...(res.internalOrderId ? { internalOrderId: res.internalOrderId, internalOrderLineId: res.internalOrderLineId } : {}) },
      }],
      subtotal: 0, taxTotal: 0, total: 0, totalBase: 0, amountDue: 0,
      billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
      createdBy: user._id,
    } as any)
    await syncOrderForInvoice(orgId, inv)
    return inv
  }

  return { orgId, user, supplier, c1, c2, product, pid, w1, w2, w3, call, order, ordi, reserve, stockRes, invoiceOf }
}

describe('what a new reservation can take', () => {
  it('free stock per warehouse, room on supplier orders out to the supplier, the client\'s open lines', async () => {
    const w = await world()
    // The shelf: 10 in Склад 1, 2 of them held → 8 free; Склад 2's 3 all held; the inactive one never.
    expect((await w.stockRes(w.c2, w.w1, 2)).status).toBe(200)
    expect((await w.stockRes(w.c2, w.w2, 3)).status).toBe(200)
    // Supplier orders: a sent one with room, a partly received one already full, a draft, a completed one.
    const sent = await w.order('sent', [{ warehouse: w.w1, quantity: 6 }], '2026-11-05')
    expect((await w.reserve({ source: 'order', contactId: String(w.c2._id), quantity: 2, ...sent.alloc(0) })).status).toBe(200)
    const full = await w.order('partially_received', [{ warehouse: w.w2, quantity: 4 }])
    expect((await w.reserve({ source: 'order', contactId: String(w.c2._id), quantity: 4, ...full.alloc(0) })).status).toBe(200)
    await w.order('draft', [{ warehouse: w.w1, quantity: 5 }])
    await w.order('completed', [{ warehouse: w.w1, quantity: 5 }])
    // Client 1: an urgent confirmed order with 7 ordered (2 reserved), a draft; client 2's order.
    const mine = await w.ordi(w.c1, 7, { priority: 'urgent' })
    expect((await w.stockRes(w.c1, w.w1, 2, { internalOrderId: mine.id, internalOrderLineId: mine.lineId })).status).toBe(200)
    await w.ordi(w.c1, 3, { draft: true })
    await w.ordi(w.c2, 9)

    const res = await w.call('GET', `/reservations/sources?productId=${w.pid}&contactId=${w.c1._id}`)
    expect(res.status).toBe(200)
    expect(res.json.stock).toEqual([
      { warehouseId: String(w.w1._id), warehouseName: 'Склад 1', isDefault: true, onHand: 10, reserved: 4, free: 6 },
    ])
    expect(res.json.allocations.map((a: any) => [a.orderNumber, a.orderStatus, a.warehouseName, a.supplierName, a.quantity, a.reserved, a.free]))
      .toEqual([[sent.number, 'sent', 'Склад 1', 'Fastbolt', 6, 2, 4]])
    expect(res.json.allocations[0]).toMatchObject(sent.alloc(0))
    expect(new Date(res.json.allocations[0].expectedDate).toISOString().slice(0, 10)).toBe('2026-11-05')
    expect(res.json.demand.map((d: any) => [d.internalOrderNumber, d.lineId, d.quantity, d.reserved, d.open, d.priority]))
      .toEqual([[mine.number, mine.lineId, 7, 2, 5, 'urgent']])

    // No client named: no client orders to offer.
    const anyone = await w.call('GET', `/reservations/sources?productId=${w.pid}`)
    expect(anyone.json.demand).toEqual([])
    expect(anyone.json.stock).toHaveLength(1)
    // `/sources` is not a reservation id.
    expect((await w.call('GET', '/reservations/sources')).status).toBe(422)
  }, 60_000)
})

describe('a refused reservation says why', () => {
  it('with a code and the figure, beside the English message', async () => {
    const w = await world()
    const sent = await w.order('sent', [{ warehouse: w.w1, quantity: 5 }])
    expect((await w.reserve({ source: 'order', contactId: String(w.c2._id), quantity: 1, ...sent.alloc(0) })).status).toBe(200)
    const mine = await w.ordi(w.c1, 6)

    const stock = await w.stockRes(w.c1, w.w1, 11)
    expect(stock.status).toBe(422)
    expect(stock.json).toMatchObject({ code: 'insufficient_stock', available: 10 })
    expect(stock.json.message).toContain('Insufficient available stock')

    const alloc = await w.reserve({ source: 'order', contactId: String(w.c1._id), quantity: 5, ...sent.alloc(0) })
    expect(alloc.status).toBe(422)
    expect(alloc.json).toMatchObject({ code: 'allocation_full', free: 4 })

    const line = await w.stockRes(w.c1, w.w1, 7, { internalOrderId: mine.id, internalOrderLineId: mine.lineId })
    expect(line.status).toBe(422)
    expect(line.json).toMatchObject({ code: 'line_demand_exceeded', open: 6 })

    const other = await w.stockRes(w.c2, w.w1, 1, { internalOrderId: mine.id, internalOrderLineId: mine.lineId })
    expect(other.status).toBe(422)
    expect(other.json.code).toBe('contact_mismatch')

    expect(await Reservation.countDocuments({ orgId: w.orgId }).exec()).toBe(1)
  }, 60_000)
})

describe('a reservation\'s page', () => {
  it('names its client order and line, the invoices that take it, and who did what', async () => {
    const w = await world()
    const mine = await w.ordi(w.c1, 7)
    const made = await w.stockRes(w.c1, w.w1, 3, { internalOrderId: mine.id, internalOrderLineId: mine.lineId })
    const inv = await w.invoiceOf(made.json.reservation, 1)

    const page = await w.call('GET', `/reservations/${made.json.reservation._id}`)
    expect(page.status).toBe(200)
    const { reservation, detail } = page.json
    expect(reservation).toMatchObject({
      reservationNumber: made.json.reservation.reservationNumber, status: 'active', quantity: 3,
      invoicedQuantity: 1, releasable: 2, contactName: 'Клиент 1', warehouseName: 'Склад 1',
      productName: 'Болт М8', productUnit: 'pcs', internalOrderNumber: mine.number,
    })
    expect(detail.internalOrder).toMatchObject({ _id: mine.id, orderNumber: mine.number, status: 'confirmed' })
    expect(detail.internalOrderLine).toMatchObject({ _id: mine.lineId, description: 'Болт М8', quantity: 7, reservedQuantity: 3 })
    expect(detail.invoices.map((i: any) => [i._id, i.invoiceNumber, i.status, i.quantity]))
      .toEqual([[String(inv._id), inv.invoiceNumber, 'draft', 1]])
    expect(detail.order).toBeNull()
    expect(detail.allocation).toBeNull()
    expect(Object.values(detail.users)).toEqual(['Мария Иванова'])
  }, 60_000)

  it('names its supplier order and allocation, what it repeats and what repeats it', async () => {
    const w = await world()
    const sent = await w.order('sent', [{ warehouse: w.w2, quantity: 6 }], '2026-11-05')
    const made = await w.reserve({ source: 'order', contactId: String(w.c2._id), quantity: 2, ...sent.alloc(0) })
    const id = made.json.reservation._id

    const before = (await w.call('GET', `/reservations/${id}`)).json.detail
    expect(before.order).toMatchObject({ _id: sent.id, orderNumber: sent.number, status: 'sent', supplierName: 'Fastbolt' })
    expect(before.allocation).toMatchObject({ _id: sent.alloc(0).allocationId, warehouseName: 'Склад 2', quantity: 6, receivedQuantity: 0 })
    expect(before.repeatedAs).toBeNull()

    expect((await w.call('POST', `/reservations/${id}/cancel`, {})).status).toBe(200)
    const again = await w.call('POST', `/reservations/${id}/repeat`, {})
    const copy = again.json.reservation
    const old = (await w.call('GET', `/reservations/${id}`)).json
    expect(old.reservation.releasable).toBe(0)
    expect(old.detail.repeatedAs).toMatchObject({ _id: String(copy._id), reservationNumber: copy.reservationNumber, status: 'active' })
    const fresh = (await w.call('GET', `/reservations/${copy._id}`)).json.detail
    expect(fresh.repeatOf).toMatchObject({ _id: id, reservationNumber: made.json.reservation.reservationNumber, status: 'cancelled' })
  }, 60_000)

  it('names what a preemption took and where it went', async () => {
    const w = await world()
    const urgent = await w.ordi(w.c1, 4, { priority: 'urgent' })
    const held = await w.stockRes(w.c2, w.w1, 5)
    const taken = await w.call('POST', `/reservations/${held.json.reservation._id}/preempt`, {
      internalOrderId: urgent.id, internalOrderLineId: urgent.lineId, quantity: 3,
    })
    expect(taken.status).toBe(200)

    const source = (await w.call('GET', `/reservations/${held.json.reservation._id}`)).json
    expect(source.reservation).toMatchObject({ status: 'active', quantity: 2 })
    expect(source.detail.preemptedTo).toEqual([expect.objectContaining({
      _id: String(taken.json.created._id), reservationNumber: taken.json.created.reservationNumber,
      quantity: 3, internalOrderId: urgent.id, internalOrderNumber: urgent.number,
    })])
    const beneficiary = (await w.call('GET', `/reservations/${taken.json.created._id}`)).json.detail
    expect(beneficiary.preemptedFrom).toMatchObject({ _id: String(held.json.reservation._id), reservationNumber: held.json.reservation.reservationNumber })
  }, 60_000)

  it('is not found under an id that is no reservation', async () => {
    const w = await world()
    expect((await w.call('GET', '/reservations/not-an-id')).status).toBe(404)
    expect((await w.call('GET', `/reservations/${w.pid}`)).status).toBe(404)
  }, 60_000)
})

describe('releasing part of a reservation', () => {
  it('lowers it, refuses more than is free to release, and cancels it with the rest', async () => {
    const w = await world()
    const made = await w.stockRes(w.c1, w.w1, 5)
    const id = made.json.reservation._id
    const level = async () => (await StockLevel.findOne({ orgId: w.orgId, warehouseId: w.w1._id }).lean().exec() as any).reservedQuantity

    const part = await w.call('POST', `/reservations/${id}/cancel`, { quantity: 2 })
    expect(part.status).toBe(200)
    expect(part.json.reservation).toMatchObject({ status: 'active', quantity: 3 })
    expect(part.json.reservation.statusHistory.at(-1).reason).toBe('manual (-2)')
    expect(await level()).toBe(3)

    const over = await w.call('POST', `/reservations/${id}/cancel`, { quantity: 4 })
    expect(over.status).toBe(422)
    expect(over.json).toMatchObject({ code: 'releasable_exceeded', releasable: 3 })

    const rest = await w.call('POST', `/reservations/${id}/cancel`, { quantity: 3 })
    expect(rest.json.reservation).toMatchObject({ status: 'cancelled', cancelReason: 'manual', quantity: 3 })
    expect(await level()).toBe(0)
    expect((await w.call('POST', `/reservations/${id}/cancel`, {})).json.code).toBe('already_cancelled')
  }, 60_000)

  it('keeps what is invoiced: releasing everything else leaves it active for that', async () => {
    const w = await world()
    const made = await w.stockRes(w.c1, w.w1, 4)
    await w.invoiceOf(made.json.reservation, 1)
    const id = made.json.reservation._id
    expect((await w.call('GET', `/reservations/${id}`)).json.reservation.releasable).toBe(3)

    const res = await w.call('POST', `/reservations/${id}/cancel`, { quantity: 3 })
    expect(res.status).toBe(200)
    expect(res.json.reservation).toMatchObject({ status: 'active', quantity: 1, invoicedQuantity: 1 })
    expect((await w.call('POST', `/reservations/${id}/cancel`, {})).json.code).toBe('nothing_to_release')
  }, 60_000)
})

describe('repeating a cancelled reservation elsewhere', () => {
  it('when its warehouse has nothing free any more, the repeat takes a supplier order instead', async () => {
    const w = await world()
    const made = await w.stockRes(w.c1, w.w1, 4)
    const id = made.json.reservation._id
    await w.call('POST', `/reservations/${id}/cancel`, {})
    expect((await w.stockRes(w.c2, w.w1, 9)).status).toBe(200)

    const asIs = await w.call('POST', `/reservations/${id}/repeat`, {})
    expect(asIs.status).toBe(422)
    expect(asIs.json).toMatchObject({ code: 'insufficient_stock', available: 1 })

    const sent = await w.order('sent', [{ warehouse: w.w2, quantity: 6 }])
    const moved = await w.call('POST', `/reservations/${id}/repeat`, { source: 'order', ...sent.alloc(0) })
    expect(moved.status).toBe(200)
    expect(moved.json.created).toBe(true)
    expect(moved.json.reservation).toMatchObject({ source: 'order', quantity: 4, status: 'active' })
    expect(String(moved.json.reservation.allocationId)).toBe(sent.alloc(0).allocationId)
    expect(String(moved.json.reservation.warehouseId)).toBe(String(w.w2._id))
    expect(String(moved.json.reservation.contactId)).toBe(String(w.c1._id))
    expect(String(moved.json.reservation.repeatOf)).toBe(id)

    // Once: a second repeat answers the first, whatever it asks for.
    const twice = await w.call('POST', `/reservations/${id}/repeat`, { source: 'stock', warehouseId: String(w.w2._id), quantity: 1 })
    expect(twice.json).toMatchObject({ created: false })
    expect(twice.json.reservation._id).toBe(moved.json.reservation._id)
  }, 60_000)

  it('for another client, outside the client order the cancelled one served', async () => {
    const w = await world()
    const mine = await w.ordi(w.c1, 5)
    const made = await w.stockRes(w.c1, w.w1, 3, { internalOrderId: mine.id, internalOrderLineId: mine.lineId })
    const id = made.json.reservation._id
    await w.call('POST', `/reservations/${id}/cancel`, {})

    const res = await w.call('POST', `/reservations/${id}/repeat`, { contactId: String(w.c2._id), quantity: 2 })
    expect(res.status).toBe(200)
    expect(res.json.reservation).toMatchObject({ quantity: 2, source: 'stock' })
    expect(String(res.json.reservation.contactId)).toBe(String(w.c2._id))
    expect(res.json.reservation.internalOrderId).toBeUndefined()
    expect(String(res.json.reservation.warehouseId)).toBe(String(w.w1._id))
  }, 60_000)
})
