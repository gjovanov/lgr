import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg,
  createTestUser,
  createTestContact,
  createTestProduct,
  createTestWarehouse,
  createTestStockLevel,
} from '../helpers/factories'
import { captureRejection, expectRejection } from '../helpers/capture-rejection'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { internalOrderController } from 'invoicing-api/src/controllers/internal-order.controller'
import { orderController } from 'invoicing-api/src/controllers/order.controller'
import { reservationController } from 'invoicing-api/src/controllers/reservation.controller'
import { stockAvailabilityController } from 'invoicing-api/src/controllers/stock-availability.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { validateStockAvailability } from 'services/biz/invoicing.service'
import { InternalOrder, Invoice, Reservation, StockLevel } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * FR-22.5 (B-7): converting an order invoices only what can be dispatched.
 *
 * The P7-chain walk found it: a client order (ORDI) for 414 units, 404 of them on the shelf.
 * „Резервирай от склад" reserved the 404, „Създай външна поръчка" put the other 10 on a supplier
 * order (ORDO), which was sent. Convert then put EVERY open reservation on the draft — the 10 held
 * on an ORDO whose goods had not arrived as well — and Issue's stock check exempted those 10,
 * because a reservation's exemption was its open quantity whatever its supply. Issuing took the
 * article from 404 to −10 and the client order read „Доставена".
 *
 * The rule now: a reservation on a supplier order counts only up to what its allocation has
 * RECEIVED and not yet dispatched — the same physical term that caps its stock hold — in Convert
 * and in Issue's budget alike. The rest stays reserved for a later invoice.
 *
 * Everything below runs through the real endpoints. NOTE: no `.rejects` / `.resolves` — the
 * Bun-on-Windows deadlock in the Known Issues table.
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia()
    .onError(spaErrorHandler({}) as any)
    .use(invoiceController)
    .use(internalOrderController)
    .use(orderController)
    .use(reservationController)
    .use(stockAvailabilityController)
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

afterEach(async () => {
  await clearCollections()
}, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(u: { id: string; orgId: string }) {
  return (signer as any).decorator.jwt.sign({
    id: u.id, orgId: u.orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Test', lastName: 'Admin',
    permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}

const TODAY = new Date().toISOString().split('T')[0]
const IN_TWO_WEEKS = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0]
const idOf = (doc: any) => String(doc?.id || doc?._id)

async function world(opts: { stock?: number } = {}) {
  const org = await createTestOrg()
  const user = await createTestUser(org._id)
  const token = await tokenFor({ id: String(user._id), orgId: String(org._id) })
  const orgId = String(org._id)
  const client = await createTestContact(org._id, { companyName: 'Nordic Wholesale' })
  const supplier = await createTestContact(org._id, { type: 'supplier', companyName: 'Luxor Imports' })
  const product = await createTestProduct(org._id, { name: 'Product 28 - Office Supplies' })
  const wh = await createTestWarehouse(org._id, { isDefault: true })
  if (opts.stock) {
    await createTestStockLevel(org._id, product._id, wh._id, { quantity: opts.stock, availableQuantity: opts.stock, avgCost: 1 } as any)
  }

  async function api(method: string, path: string, body?: any) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }

  async function ok(method: string, path: string, body?: any) {
    const res = await api(method, path, body)
    expect(res.status, `${method} ${path}: ${JSON.stringify(res.json)}`).toBe(200)
    return res.json
  }

  /** The walk's chain up to Convert: ORDI → confirm → reserve from stock → ORDO for the rest → send. */
  async function shortChain(ordered: number) {
    const { internalOrder } = await ok('POST', '/invoicing/internal-orders', {
      contactId: String(client._id),
      issueDate: TODAY,
      requestedDeliveryDate: IN_TWO_WEEKS,
      warehouseId: String(wh._id),
      lines: [{ productId: String(product._id), description: product.name, quantity: ordered, unit: 'pcs', expectedUnitPrice: 2 }],
    })
    const ordiId = String(internalOrder._id)
    const lineId = String(internalOrder.lines[0]._id)
    await ok('POST', `/invoicing/internal-orders/${ordiId}/confirm`)
    const reserved = await ok('POST', `/invoicing/internal-orders/${ordiId}/reserve-available`, {})
    const short = ordered - (reserved.created || []).reduce((s: number, r: any) => s + r.quantity, 0)
    const generated = await ok('POST', `/invoicing/internal-orders/${ordiId}/generate-external`, {
      lines: [{ internalOrderLineId: lineId, quantity: short, supplierId: String(supplier._id) }],
    })
    const { order } = await ok('POST', `/invoicing/orders/${generated.order._id}/send`)
    return {
      ordiId,
      lineId,
      stockRes: reserved.created?.[0],
      orderRes: generated.reservations[0],
      order,
      ordoNumber: order.orderNumber as string,
    }
  }

  /** An ORDO sent to the supplier: one line, all of it allocated to the warehouse. */
  async function sentOrder(quantity: number) {
    const { order } = await ok('POST', '/invoicing/orders', {
      issueDate: TODAY,
      supplierGroups: [{
        supplierId: String(supplier._id),
        lines: [{
          productId: String(product._id), description: product.name, quantity, unit: 'pcs', expectedUnitPrice: 1,
          allocations: [{ warehouseId: String(wh._id), quantity }],
        }],
      }],
    })
    return (await ok('POST', `/invoicing/orders/${order._id}/send`)).order
  }

  /** The supplier's goods arrive: a bill against the ORDO's allocation, received. */
  async function receive(order: any, quantity: number) {
    const g = order.supplierGroups[0]
    const l = g.lines[0]
    const a = l.allocations[0]
    const { invoice } = await ok('POST', '/invoices', {
      type: 'invoice', direction: 'incoming', contactId: String(supplier._id), issueDate: TODAY, currency: 'EUR',
      orderId: String(order._id), orderGroupId: String(g._id),
      lines: [{
        productId: String(product._id), description: product.name, quantity, unit: 'pcs', unitPrice: 1, taxRate: 18,
        warehouseId: String(a.warehouseId),
        orderRef: { orderId: String(order._id), groupId: String(g._id), lineId: String(l._id), allocationId: String(a._id) },
      }],
      subtotal: quantity, total: quantity * 1.18,
    })
    await ok('POST', `/invoices/${idOf(invoice)}/receive`)
  }

  /** A sales-invoice line that dispatches against a reservation, as Convert writes it. */
  function lineFor(res: any, quantity: number, ordiLineId?: string) {
    return {
      productId: String(product._id), description: product.name, quantity, unit: 'pcs', unitPrice: 2, taxRate: 18,
      warehouseId: String(res.warehouseId),
      orderRef: {
        orderId: res.orderId ? String(res.orderId) : undefined,
        groupId: res.groupId ? String(res.groupId) : undefined,
        lineId: res.lineId ? String(res.lineId) : undefined,
        allocationId: res.allocationId ? String(res.allocationId) : undefined,
        reservationId: String(res._id),
        internalOrderId: res.internalOrderId ? String(res.internalOrderId) : undefined,
        internalOrderLineId: ordiLineId,
      },
    }
  }

  const onHand = async () => {
    const levels = await StockLevel.find({ orgId: org._id, productId: product._id } as any).lean()
    return levels.reduce((s: number, l: any) => s + (l.quantity || 0), 0)
  }
  const invoiceLines = async (id: string) => {
    const inv: any = await Invoice.findById(id).lean()
    return (inv?.lines || []).map((l: any) => [String(l.orderRef?.reservationId), l.quantity])
  }

  return { org, orgId, client, supplier, product, wh, api, ok, shortChain, sentOrder, receive, lineFor, onHand, invoiceLines }
}

describe('Convert invoices only what can be dispatched (FR-22.5, B-7)', () => {
  it('the walk\'s chain: the units still on the supplier order stay reserved, and stock never goes below zero', async () => {
    const w = await world({ stock: 404 })
    const chain = await w.shortChain(414)
    expect(chain.stockRes.quantity).toBe(404)
    expect(chain.orderRes.quantity).toBe(10)

    const conv = await w.api('POST', `/invoicing/internal-orders/${chain.ordiId}/convert`)
    expect(conv.status).toBe(200)
    const invId = idOf(conv.json.invoice)
    const issued = await w.api('POST', `/invoices/${invId}/send`, {})
    expect(issued.status).toBe(200)

    // The defect as measured: 404 → −10, and the client order „Доставена" for goods it never got.
    expect(await w.onHand()).toBe(0)
    const ordi: any = await InternalOrder.findById(chain.ordiId).lean()
    expect(ordi.status).toBe('partially_delivered')
    expect(ordi.lines[0].deliveredQuantity).toBe(404)

    // Convert put on the invoice what was on the shelf, and only that …
    expect(await w.invoiceLines(invId)).toEqual([[String(chain.stockRes._id), 404]])
    // … and says what it left for later: the 10 on the supplier order, still reserved.
    expect(conv.json.waiting).toEqual([expect.objectContaining({
      reservationId: String(chain.orderRes._id), quantity: 10, orderNumber: chain.ordoNumber,
    })])
    const orderRes: any = await Reservation.findById(chain.orderRes._id).lean()
    expect(orderRes).toMatchObject({ status: 'active', quantity: 10, invoicedQuantity: 0, dispatchedQuantity: 0 })
  })

  it('a draft edited by hand to carry the on-order units cannot be issued: the pre-check and Issue hold the same rule', async () => {
    const w = await world({ stock: 404 })
    const chain = await w.shortChain(414)
    const conv = await w.api('POST', `/invoicing/internal-orders/${chain.ordiId}/convert`)
    expect(conv.status).toBe(200)
    const invId = idOf(conv.json.invoice)

    // The lines the old Convert wrote: the reservation on the shelf AND the one on the ORDO.
    const lines = [w.lineFor(chain.stockRes, 404, chain.lineId), w.lineFor(chain.orderRes, 10, chain.lineId)]
    const put = await w.api('PUT', `/invoices/${invId}`, { lines })
    expect(put.status).toBe(200)

    // The pre-flight the list's Issue runs first reports the shortfall …
    const check = await w.ok('POST', '/invoicing/stock-availability/check', {
      lines: lines.map((l) => ({ productId: l.productId, warehouseId: l.warehouseId, quantity: l.quantity, reservationId: l.orderRef.reservationId })),
    })
    expect(check.sufficient).toBe(false)
    expect(check.shortfalls).toEqual([expect.objectContaining({ requested: 10, available: 0, deficit: 10 })])

    // … and Issue refuses it, leaving the stock and the draft as they were.
    const issued = await w.api('POST', `/invoices/${invId}/send`, {})
    expect(issued.status).toBe(400)
    expect(String(issued.json?.message)).toContain('Insufficient stock')
    expect(await w.onHand()).toBe(404)
    expect(((await Invoice.findById(invId).lean()) as any).status).toBe('draft')
  })

  it('nothing received yet: Convert says so and creates no empty draft (FR-22 §5.5)', async () => {
    const w = await world({ stock: 0 })
    const chain = await w.shortChain(10)
    expect(chain.stockRes).toBeUndefined()

    const conv = await w.api('POST', `/invoicing/internal-orders/${chain.ordiId}/convert`)
    expect(conv.status).toBe(422)
    expect(conv.json.code).toBe('awaiting_receipt')
    expect(conv.json.orders).toEqual([chain.ordoNumber])
    expect(conv.json.quantity).toBe(10)
    expect(String(conv.json.message)).toContain(chain.ordoNumber)
    expect(await Invoice.countDocuments({ orgId: w.org._id } as any)).toBe(0)
  })

  it('once the supplier order is received, the next Convert invoices the rest and the client order is delivered', async () => {
    const w = await world({ stock: 404 })
    const chain = await w.shortChain(414)
    const first = await w.ok('POST', `/invoicing/internal-orders/${chain.ordiId}/convert`)
    await w.ok('POST', `/invoices/${idOf(first.invoice)}/send`, {})
    expect(await w.onHand()).toBe(0)

    await w.receive(chain.order, 10)
    expect(await w.onHand()).toBe(10)

    const second = await w.ok('POST', `/invoicing/internal-orders/${chain.ordiId}/convert`)
    expect(await w.invoiceLines(idOf(second.invoice))).toEqual([[String(chain.orderRes._id), 10]])
    expect(second.waiting).toEqual([])
    await w.ok('POST', `/invoices/${idOf(second.invoice)}/send`, {})

    expect(await w.onHand()).toBe(0)
    const ordi: any = await InternalOrder.findById(chain.ordiId).lean()
    expect(ordi.status).toBe('delivered')
    expect(((await Reservation.findById(chain.orderRes._id).lean()) as any).status).toBe('fulfilled')
  })

  it('a partly received allocation: Convert invoices what arrived and keeps the rest reserved', async () => {
    const w = await world({ stock: 0 })
    const chain = await w.shortChain(10)
    await w.receive(chain.order, 6)

    const conv = await w.ok('POST', `/invoicing/internal-orders/${chain.ordiId}/convert`)
    expect(await w.invoiceLines(idOf(conv.invoice))).toEqual([[String(chain.orderRes._id), 6]])
    expect(conv.waiting).toEqual([expect.objectContaining({ reservationId: String(chain.orderRes._id), quantity: 4 })])
    await w.ok('POST', `/invoices/${idOf(conv.invoice)}/send`, {})

    expect(await w.onHand()).toBe(0)
    const res: any = await Reservation.findById(chain.orderRes._id).lean()
    expect(res).toMatchObject({ status: 'active', quantity: 10, invoicedQuantity: 6, dispatchedQuantity: 6 })

    // Converting again before the rest arrives: nothing to invoice, said so.
    const again = await w.api('POST', `/invoicing/internal-orders/${chain.ordiId}/convert`)
    expect(again.status).toBe(422)
    expect(again.json).toMatchObject({ code: 'awaiting_receipt', quantity: 4 })
  })

  it('the supplier order\'s Convert follows the same rule, client by client', async () => {
    const w = await world({ stock: 0 })
    const order = await w.sentOrder(10)
    const g = order.supplierGroups[0]
    const { reservation } = await w.ok('POST', '/invoicing/reservations', {
      source: 'order', productId: String(w.product._id), quantity: 10, contactId: String(w.client._id),
      orderId: String(order._id), groupId: String(g._id), lineId: String(g.lines[0]._id), allocationId: String(g.lines[0].allocations[0]._id),
    })

    const before = await w.api('POST', `/invoicing/orders/${order._id}/convert`, { contactId: String(w.client._id) })
    expect(before.status).toBe(422)
    expect(before.json).toMatchObject({ code: 'awaiting_receipt', orders: [order.orderNumber], quantity: 10 })
    expect(await Invoice.countDocuments({ orgId: w.org._id, direction: 'outgoing' } as any)).toBe(0)

    await w.receive(order, 6)
    const conv = await w.ok('POST', `/invoicing/orders/${order._id}/convert`, { contactId: String(w.client._id) })
    expect(await w.invoiceLines(idOf(conv.invoice))).toEqual([[String(reservation._id), 6]])
    expect(conv.waiting).toEqual([expect.objectContaining({ reservationId: String(reservation._id), quantity: 4 })])
    await w.ok('POST', `/invoices/${idOf(conv.invoice)}/send`, {})
    expect(await w.onHand()).toBe(0)
  })

  it('two reservations on one allocation share what it received, in Convert and in Issue\'s budget', async () => {
    const w = await world({ stock: 0 })
    const order = await w.sentOrder(500)
    const g = order.supplierGroups[0]
    const supply = {
      source: 'order', productId: String(w.product._id), contactId: String(w.client._id),
      orderId: String(order._id), groupId: String(g._id), lineId: String(g.lines[0]._id), allocationId: String(g.lines[0].allocations[0]._id),
    }
    const a = (await w.ok('POST', '/invoicing/reservations', { ...supply, quantity: 300 })).reservation
    const b = (await w.ok('POST', '/invoicing/reservations', { ...supply, quantity: 200 })).reservation
    await w.receive(order, 400)
    expect(await w.onHand()).toBe(400)

    // One document taking both in full asks for 500 of the 400 that arrived: the budget exempts
    // only those 400, and the other 100 find no free stock.
    const err = await captureRejection(validateStockAvailability(w.orgId, [
      w.lineFor(a, 300) as any,
      w.lineFor(b, 200) as any,
    ]))
    expectRejection(err, 'Insufficient stock')

    // Convert shares the allocation the same way: 300 + 100 now, 100 for later.
    const conv = await w.ok('POST', `/invoicing/orders/${order._id}/convert`, { contactId: String(w.client._id) })
    expect(await w.invoiceLines(idOf(conv.invoice))).toEqual([[String(a._id), 300], [String(b._id), 100]])
    expect(conv.waiting).toEqual([expect.objectContaining({ reservationId: String(b._id), quantity: 100 })])
    await w.ok('POST', `/invoices/${idOf(conv.invoice)}/send`, {})
    expect(await w.onHand()).toBe(0)
  })

  it('fractional units: the rest is invoiced as 0.2, not 0.19999999999999998, and still issues', async () => {
    const w = await world({ stock: 0 })
    const order = await w.sentOrder(0.3)
    const g = order.supplierGroups[0]
    const { reservation } = await w.ok('POST', '/invoicing/reservations', {
      source: 'order', productId: String(w.product._id), quantity: 0.3, contactId: String(w.client._id),
      orderId: String(order._id), groupId: String(g._id), lineId: String(g.lines[0]._id), allocationId: String(g.lines[0].allocations[0]._id),
    })
    await w.receive(order, 0.3)
    // A first 0.1 goes out on an invoice made by hand: 0.3 − 0.1 is 0.19999999999999998 in floats.
    const first = await w.ok('POST', '/invoices', {
      type: 'invoice', direction: 'outgoing', contactId: String(w.client._id), issueDate: TODAY, currency: 'EUR',
      lines: [w.lineFor(reservation, 0.1)], subtotal: 0.2, total: 0.24,
    })
    await w.ok('POST', `/invoices/${idOf(first.invoice)}/send`, {})

    const conv = await w.ok('POST', `/invoicing/orders/${order._id}/convert`, { contactId: String(w.client._id) })
    expect(await w.invoiceLines(idOf(conv.invoice))).toEqual([[String(reservation._id), 0.2]])
    // The budget left is that same residue short of 0.2; it must not read as a shortfall.
    const issued = await w.api('POST', `/invoices/${idOf(conv.invoice)}/send`, {})
    expect(issued.status, JSON.stringify(issued.json)).toBe(200)
    expect(await w.onHand()).toBeCloseTo(0, 9)
  })
})
