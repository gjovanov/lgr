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
import { Invoice, Order } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * FR-22 slice 4b — the order screens: why a client-order or supplier-order action is refused (a
 * code the UI translates), what the Reservations list finds, how a client order's coverage reads,
 * and what generating a supplier order appends to.
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
  const user = await createTestUser(org._id)
  const supplier = await createTestContact(org._id, { type: 'supplier', companyName: 'Fastbolt' } as any)
  const supplier2 = await createTestContact(org._id, { type: 'supplier', companyName: 'Vintove OOD' } as any)
  const c1 = await createTestContact(org._id, { type: 'customer', companyName: 'Клиент 1' } as any)
  const c2 = await createTestContact(org._id, { type: 'customer', companyName: 'Клиент 2' } as any)
  const product = await createTestProduct(org._id, { name: 'Болт М8', sku: 'BLT-M8', unit: 'pcs' } as any)
  const other = await createTestProduct(org._id, { name: 'Гайка М10', sku: 'NUT-M10', unit: 'pcs' } as any)
  const w1 = await createTestWarehouse(org._id, { name: 'Склад 1', isDefault: true } as any)
  await createTestStockLevel(org._id, product._id, w1._id, { quantity: 10, reservedQuantity: 0, availableQuantity: 10 })
  await createTestStockLevel(org._id, other._id, w1._id, { quantity: 10, reservedQuantity: 0, availableQuantity: 10 })
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

  /** A supplier order bringing `quantity` of a product to Склад 1, in `status`. */
  async function order(status: string, quantity: number, opts: { product?: any; supplier?: any } = {}) {
    const p = opts.product || product
    const res = await call('POST', '/orders', {
      issueDate: '2026-10-26', currency: 'EUR', tags: [],
      supplierGroups: [{
        supplierId: String((opts.supplier || supplier)._id),
        lines: [{ productId: String(p._id), description: p.name, quantity, unit: 'pcs', allocations: [{ warehouseId: String(w1._id), quantity }] }],
      }],
    })
    expect(res.status).toBe(200)
    const id = res.json.order._id
    if (status !== 'draft') await Order.updateOne({ _id: id }, { $set: { status } }).exec()
    const o = (await call('GET', `/orders/${id}`)).json.order
    const g = o.supplierGroups[0]
    const l = g.lines[0]
    return { id, number: o.orderNumber, alloc: { orderId: id, groupId: g._id, lineId: l._id, allocationId: l.allocations[0]._id } }
  }

  /** A client's incoming order, confirmed unless `draft`; one line per product. */
  async function ordi(contact: any, lines: Array<{ product: any; quantity: number }>, opts: { draft?: boolean } = {}) {
    const res = await call('POST', '/internal-orders', {
      contactId: String(contact._id), issueDate: '2026-10-26', requestedDeliveryDate: '2026-11-10',
      lines: lines.map((l) => ({ productId: String(l.product._id), description: l.product.name, quantity: l.quantity, unit: 'pcs' })),
    })
    expect(res.status).toBe(200)
    const id = res.json.internalOrder._id
    if (!opts.draft) expect((await call('POST', `/internal-orders/${id}/confirm`)).status).toBe(200)
    const o = (await call('GET', `/internal-orders/${id}`)).json.internalOrder
    return { id, number: o.orderNumber, lineIds: o.lines.map((l: any) => String(l._id)) }
  }

  /** A draft sales invoice naming the client order, which is what blocks cancelling it. */
  async function draftInvoiceFor(ordiId: string, extra: Record<string, any> = {}) {
    return Invoice.create({
      orgId, invoiceNumber: `DRF-INV-${Date.now()}`, type: 'invoice', direction: 'outgoing', status: 'draft',
      contactId: c1._id, issueDate: new Date(), dueDate: new Date(), currency: 'EUR', exchangeRate: 1,
      lines: [{ productId: product._id, description: 'Болт М8', quantity: 1, unit: 'pcs', unitPrice: 1, discount: 0, taxRate: 20, taxAmount: 0, lineTotal: 0, warehouseId: w1._id }],
      subtotal: 0, taxTotal: 0, total: 0, totalBase: 0, amountDue: 0,
      billingAddress: { street: '-', city: '-', postalCode: '-', country: '-' },
      internalOrderId: ordiId, createdBy: user._id, ...extra,
    } as any)
  }

  return { orgId, supplier, supplier2, c1, c2, product, other, w1, call, order, ordi, draftInvoiceFor }
}

describe('a refused client-order or supplier-order action says why', () => {
  it('with a code the UI translates, beside the English message', async () => {
    const w = await world()
    const mine = await w.ordi(w.c1, [{ product: w.product, quantity: 4 }])

    // Cancelling a client order an invoice names.
    await w.draftInvoiceFor(mine.id)
    const cancel = await w.call('POST', `/internal-orders/${mine.id}/cancel`)
    expect(cancel.status).toBe(409)
    expect(cancel.json).toMatchObject({ code: 'incoming_order_has_invoices' })
    expect(cancel.json.message).toContain('linked invoices')

    // Completing a draft.
    const draft = await w.ordi(w.c2, [{ product: w.product, quantity: 1 }], { draft: true })
    const complete = await w.call('POST', `/internal-orders/${draft.id}/complete`)
    expect(complete.status).toBe(400)
    expect(complete.json).toMatchObject({ code: 'incoming_order_not_completable', orderStatus: 'draft' })

    // Reserving for, or generating a supplier order for, a closed client order.
    expect((await w.call('POST', `/internal-orders/${draft.id}/reserve-available`, {})).json).toMatchObject({ code: 'incoming_order_not_reservable', orderStatus: 'draft' })
    const gen = await w.call('POST', `/internal-orders/${draft.id}/generate-external`, {
      lines: [{ internalOrderLineId: draft.lineIds[0], quantity: 1, supplierId: String(w.supplier._id) }],
    })
    expect(gen.json).toMatchObject({ code: 'incoming_order_not_reservable' })

    // Appending to a supplier order that is no longer a draft.
    const sent = await w.order('sent', 5)
    const append = await w.call('POST', `/internal-orders/${mine.id}/generate-external`, {
      orderId: sent.id, lines: [{ internalOrderLineId: mine.lineIds[0], quantity: 1, supplierId: String(w.supplier._id) }],
    })
    expect(append.status).toBe(422)
    expect(append.json).toMatchObject({ code: 'order_not_draft', orderStatus: 'sent' })
  }, 60_000)

  it('a supplier order an invoice names cannot be cancelled, and says so with a code', async () => {
    const w = await world()
    const sent = await w.order('sent', 5)
    const mine = await w.ordi(w.c1, [{ product: w.product, quantity: 2 }])
    await w.draftInvoiceFor(mine.id, { orderId: sent.id })
    const res = await w.call('POST', `/orders/${sent.id}/cancel`)
    expect(res.status).toBe(409)
    expect(res.json).toMatchObject({ code: 'order_has_invoices' })
  }, 60_000)
})

describe('the Reservations list finds a reservation by', () => {
  it('its number, its client, its article\'s name or SKU, and the number of either order', async () => {
    const w = await world()
    const sent = await w.order('sent', 6)
    const mine = await w.ordi(w.c1, [{ product: w.product, quantity: 3 }])
    // RES 1: Клиент 1's bolts from stock, for the client order. RES 2: Клиент 2's nuts from stock.
    // RES 3: Клиент 2's bolts on the supplier order.
    const r1 = (await w.call('POST', '/reservations', {
      source: 'stock', productId: String(w.product._id), warehouseId: String(w.w1._id), contactId: String(w.c1._id), quantity: 2,
      internalOrderId: mine.id, internalOrderLineId: mine.lineIds[0],
    })).json.reservation
    const r2 = (await w.call('POST', '/reservations', {
      source: 'stock', productId: String(w.other._id), warehouseId: String(w.w1._id), contactId: String(w.c2._id), quantity: 1,
    })).json.reservation
    const r3 = (await w.call('POST', '/reservations', {
      source: 'order', productId: String(w.product._id), contactId: String(w.c2._id), quantity: 4, ...sent.alloc,
    })).json.reservation
    const found = async (q: string) =>
      ((await w.call('GET', `/reservations?search=${encodeURIComponent(q)}&size=50`)).json.reservations || [])
        .map((r: any) => r.reservationNumber).sort()

    expect(await found(r2.reservationNumber)).toEqual([r2.reservationNumber])
    expect(await found('Клиент 2')).toEqual([r2.reservationNumber, r3.reservationNumber].sort())
    expect(await found('гайка')).toEqual([r2.reservationNumber])           // the article's name, any case
    expect(await found('blt-m8')).toEqual([r1.reservationNumber, r3.reservationNumber].sort()) // its SKU
    expect(await found(sent.number)).toEqual([r3.reservationNumber])      // the supplier order
    expect(await found(mine.number)).toEqual([r1.reservationNumber])      // the client order
    expect(await found('nothing like it')).toEqual([])
  }, 60_000)
})

describe('a client order covered by a supplier order not sent yet (FR-22.44)', () => {
  it('reads „ordered", line by line and on the list, until the supplier order goes out', async () => {
    const w = await world()
    // Line 1 (bolts): 4, all from stock. Line 2 (nuts): 15 — 10 from stock, 5 put on a new draft
    // supplier order the way „Създай изходяща поръчка" does it.
    const mine = await w.ordi(w.c1, [{ product: w.product, quantity: 4 }, { product: w.other, quantity: 15 }])
    expect((await w.call('POST', `/internal-orders/${mine.id}/reserve-available`, {})).json.short).toEqual([
      expect.objectContaining({ lineId: mine.lineIds[1], missing: 5 }),
    ])
    const gen = await w.call('POST', `/internal-orders/${mine.id}/generate-external`, {
      lines: [{ internalOrderLineId: mine.lineIds[1], quantity: 5, supplierId: String(w.supplier._id) }],
    })
    expect(gen.status).toBe(200)
    expect(gen.json.order.status).toBe('draft')

    const read = async () => (await w.call('GET', `/internal-orders/${mine.id}`)).json.internalOrder
    const listed = async () => ((await w.call('GET', '/internal-orders?size=50')).json.internalOrders || []).find((o: any) => o._id === mine.id)
    const before = await read()
    expect(before.reservationCoverage).toBe('ordered')
    expect(before.shortQuantity).toBe(0)
    expect(before.lines.map((l: any) => [l.reservedQuantity, l.onUnsentOrderQuantity])).toEqual([[4, 0], [15, 5]])
    expect((await listed()).reservationCoverage).toBe('ordered')

    // Sent: the supplier order orders it now — the client order reads reserved.
    expect((await w.call('POST', `/orders/${gen.json.order._id}/send`)).status).toBe(200)
    const after = await read()
    expect(after.reservationCoverage).toBe('full')
    expect(after.lines.map((l: any) => l.onUnsentOrderQuantity)).toEqual([0, 0])
    expect((await listed()).reservationCoverage).toBe('full')
  }, 60_000)
})
