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
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { internalOrderController } from 'invoicing-api/src/controllers/internal-order.controller'
import { orderController } from 'invoicing-api/src/controllers/order.controller'
import { reservationController } from 'invoicing-api/src/controllers/reservation.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { InternalOrder, Invoice, StockLevel } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * A price chosen on a customer order's line is what the order's invoice charges.
 *
 * A customer order line shows a price. Until now it was an indication only: Convert priced every invoice line for
 * the client on the day of the invoice (`resolvePrice`), so a price picked on the order with „Select price" (or
 * typed) showed on the order and in its total, and was not what the client was charged.
 *
 * The rule now (`config/order-line-price`): a line whose price was chosen says so (`pricePinned`), and Convert
 * charges that price, from the customer order and from a supplier order that covers the line alike. The invoice
 * line's trail keeps what the client resolves to and names the order after it, as an override. A line nobody chose
 * a price on is priced for the client, as before: that is every line written before the field existed.
 *
 * The client here is in price group „Цена 4" (7.00) of an article sold at 10.00, so the two prices can be told
 * apart. Everything runs through the real endpoints. NOTE: no `.rejects` / `.resolves` (the Bun-on-Windows deadlock
 * in the Known Issues table).
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

const SELLING = 10
const CLIENTS = 7 // the client's own price: group „Цена 4"
const CHOSEN = 8 // „Цена 2", which the client is not in

interface LineSpec { quantity?: number; expectedUnitPrice?: number; pricePinned?: boolean }

async function world(opts: { stock?: number } = {}) {
  const org = await createTestOrg()
  const user = await createTestUser(org._id)
  const token = await tokenFor({ id: String(user._id), orgId: String(org._id) })
  const orgId = String(org._id)
  const client = await createTestContact(org._id, { companyName: 'Nordic Wholesale', tags: ['Цена 4'] } as any)
  const supplier = await createTestContact(org._id, { type: 'supplier', companyName: 'Luxor Imports' })
  const article = (name: string) => createTestProduct(org._id, {
    name,
    sellingPrice: SELLING,
    priceTiers: [
      { name: 'Цена 2', percent: 0, finalPrice: CHOSEN, manualOverride: true, contactIds: [], tags: [] },
      { name: 'Цена 4', percent: 0, finalPrice: CLIENTS, manualOverride: true, contactIds: [], tags: ['Цена 4'] },
    ],
  } as any)
  const product = await article('Product 28 - Office Supplies')
  const second = await article('Product 29 - Office Supplies')
  const wh = await createTestWarehouse(org._id, { isDefault: true })
  const stock = opts.stock ?? 100
  if (stock) {
    for (const p of [product, second]) {
      await createTestStockLevel(org._id, p._id, wh._id, { quantity: stock, availableQuantity: stock, avgCost: 1 } as any)
    }
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

  const lineBody = (p: any, l: LineSpec) => ({
    productId: String(p._id), description: p.name, quantity: l.quantity ?? 5, unit: 'pcs',
    ...(l.expectedUnitPrice !== undefined ? { expectedUnitPrice: l.expectedUnitPrice } : {}),
    ...(l.pricePinned !== undefined ? { pricePinned: l.pricePinned } : {}),
  })
  const header = () => ({
    contactId: String(client._id), issueDate: TODAY, requestedDeliveryDate: IN_TWO_WEEKS, warehouseId: String(wh._id),
  })

  /** A customer order as the form saves it: one line per spec, the first on `product`, the second on `second`. */
  async function draft(lines: LineSpec[]) {
    const { internalOrder } = await ok('POST', '/invoicing/internal-orders', {
      ...header(), lines: lines.map((l, i) => lineBody(i === 0 ? product : second, l)),
    })
    return internalOrder
  }

  /** The same, confirmed and reserved from the shelf: ready to convert. */
  async function reserved(lines: LineSpec[]) {
    const ordi = await draft(lines)
    const id = String(ordi._id)
    const confirmed = (await ok('POST', `/invoicing/internal-orders/${id}/confirm`)).internalOrder
    await ok('POST', `/invoicing/internal-orders/${id}/reserve-available`, {})
    return { id, number: confirmed.orderNumber as string, lines: confirmed.lines as any[] }
  }

  const stored = async (id: string) => ((await InternalOrder.findById(id).lean()) as any).lines as any[]
  const invoiceOf = async (id: string) => (await Invoice.findById(id).lean()) as any
  const trail = (line: any) => (line.priceExplanation || []).map((s: any) => [s.type, s.label, s.price])

  return { org, orgId, client, supplier, product, second, wh, api, ok, header, lineBody, draft, reserved, stored, invoiceOf, trail }
}

describe('Convert charges the price chosen on the customer order\'s line', () => {
  it('a line nobody chose a price on is priced for the client, whatever the order showed: as before', async () => {
    const w = await world()
    const ordi = await w.reserved([{ expectedUnitPrice: SELLING }])

    const { invoice } = await w.ok('POST', `/invoicing/internal-orders/${ordi.id}/convert`)
    const inv = await w.invoiceOf(idOf(invoice))
    expect(inv.lines).toHaveLength(1)
    expect(inv.lines[0].unitPrice).toBe(CLIENTS)
    expect(w.trail(inv.lines[0])).toEqual([['base', 'Selling price', SELLING], ['tier', 'Цена 4', CLIENTS]])
    expect(inv.subtotal).toBe(5 * CLIENTS)
  })

  it('a chosen price is the invoice\'s, and the trail names the order after what the client resolves to', async () => {
    const w = await world()
    const ordi = await w.reserved([{ expectedUnitPrice: CHOSEN, pricePinned: true }])

    const { invoice } = await w.ok('POST', `/invoicing/internal-orders/${ordi.id}/convert`)
    const inv = await w.invoiceOf(idOf(invoice))
    expect(inv.lines[0].unitPrice).toBe(CHOSEN)
    expect(w.trail(inv.lines[0])).toEqual([
      ['base', 'Selling price', SELLING],
      ['tier', 'Цена 4', CLIENTS],
      ['override', ordi.number, CHOSEN],
    ])
    // The document adds up on the chosen price: net, VAT (the organization's 18 %) and the total.
    expect(inv.subtotal).toBe(40)
    expect(inv.taxTotal).toBe(7.2)
    expect(inv.total).toBe(47.2)
    expect(inv.lines[0].lineTotal).toBe(47.2)

    // And it issues: the price is the line's, as any typed on an invoice.
    const issued = await w.ok('POST', `/invoices/${idOf(invoice)}/send`, {})
    expect(issued.invoice.lines[0].unitPrice).toBe(CHOSEN)
  })

  it('a chosen price above the client\'s is charged as chosen too', async () => {
    const w = await world()
    const ordi = await w.reserved([{ expectedUnitPrice: 12.5, pricePinned: true }])
    const { invoice } = await w.ok('POST', `/invoicing/internal-orders/${ordi.id}/convert`)
    const inv = await w.invoiceOf(idOf(invoice))
    expect(inv.lines[0].unitPrice).toBe(12.5)
    expect(w.trail(inv.lines[0]).at(-1)).toEqual(['override', ordi.number, 12.5])
  })

  it('the chosen price is the client\'s own figure: the trail is the client\'s, with no step added', async () => {
    const w = await world()
    const ordi = await w.reserved([{ expectedUnitPrice: CLIENTS, pricePinned: true }])
    const { invoice } = await w.ok('POST', `/invoicing/internal-orders/${ordi.id}/convert`)
    const inv = await w.invoiceOf(idOf(invoice))
    expect(inv.lines[0].unitPrice).toBe(CLIENTS)
    expect(w.trail(inv.lines[0])).toEqual([['base', 'Selling price', SELLING], ['tier', 'Цена 4', CLIENTS]])
  })

  it('each line by its own rule on one order', async () => {
    const w = await world()
    const ordi = await w.reserved([
      { quantity: 2, expectedUnitPrice: CHOSEN, pricePinned: true },
      { quantity: 3, expectedUnitPrice: SELLING },
    ])
    const { invoice } = await w.ok('POST', `/invoicing/internal-orders/${ordi.id}/convert`)
    const inv = await w.invoiceOf(idOf(invoice))
    const byArticle = new Map(inv.lines.map((l: any) => [String(l.productId), l]))
    expect((byArticle.get(String(w.product._id)) as any).unitPrice).toBe(CHOSEN)
    expect((byArticle.get(String(w.second._id)) as any).unitPrice).toBe(CLIENTS)
    expect(inv.subtotal).toBe(2 * CHOSEN + 3 * CLIENTS)
  })

  it('a line invoiced in two parts is charged the chosen price both times', async () => {
    const w = await world({ stock: 3 })
    const ordi = await w.draft([{ quantity: 5, expectedUnitPrice: CHOSEN, pricePinned: true }])
    const id = String(ordi._id)
    await w.ok('POST', `/invoicing/internal-orders/${id}/confirm`)
    await w.ok('POST', `/invoicing/internal-orders/${id}/reserve-available`, {})
    const first = await w.ok('POST', `/invoicing/internal-orders/${id}/convert`)
    expect((await w.invoiceOf(idOf(first.invoice))).lines.map((l: any) => [l.quantity, l.unitPrice])).toEqual([[3, CHOSEN]])
    await w.ok('POST', `/invoices/${idOf(first.invoice)}/send`, {})

    // The other two arrive on the shelf and are reserved for the line.
    await StockLevel.updateOne({ orgId: w.org._id, productId: w.product._id, warehouseId: w.wh._id } as any, { $inc: { quantity: 2, availableQuantity: 2 } })
    await w.ok('POST', `/invoicing/internal-orders/${id}/reserve-available`, {})
    const second = await w.ok('POST', `/invoicing/internal-orders/${id}/convert`)
    expect((await w.invoiceOf(idOf(second.invoice))).lines.map((l: any) => [l.quantity, l.unitPrice])).toEqual([[2, CHOSEN]])
  })
})

describe('What a save stores as chosen', () => {
  it('a pin needs a price that can be charged: with none, or zero, the line is stored unpinned and priced for the client', async () => {
    const w = await world()
    const ordi = await w.reserved([{ expectedUnitPrice: 0, pricePinned: true }, { pricePinned: true }])
    expect((await w.stored(ordi.id)).map((l) => l.pricePinned)).toEqual([undefined, undefined])

    const { invoice } = await w.ok('POST', `/invoicing/internal-orders/${ordi.id}/convert`)
    const inv = await w.invoiceOf(idOf(invoice))
    expect(inv.lines.map((l: any) => l.unitPrice)).toEqual([CLIENTS, CLIENTS])
  })

  it('the order reads back what was chosen, and a line that was not carries no flag', async () => {
    const w = await world()
    const ordi = await w.draft([{ expectedUnitPrice: CHOSEN, pricePinned: true }, { expectedUnitPrice: SELLING, pricePinned: false }])
    const { internalOrder } = await w.ok('GET', `/invoicing/internal-orders/${ordi._id}`)
    expect(internalOrder.lines.map((l: any) => [l.expectedUnitPrice, l.pricePinned])).toEqual([[CHOSEN, true], [SELLING, undefined]])
  })

  it('a save that says nothing about it keeps a chosen price chosen: an older tab cannot unpin by saving back', async () => {
    const w = await world()
    const ordi = await w.draft([{ expectedUnitPrice: CHOSEN, pricePinned: true }, { expectedUnitPrice: SELLING }])
    const [l1, l2] = await w.stored(String(ordi._id))

    // What a form from before the field sends: every line with its id, no `pricePinned` at all.
    await w.ok('PUT', `/invoicing/internal-orders/${ordi._id}`, {
      ...w.header(),
      notes: 'saved by a tab that does not know the field',
      lines: [
        { _id: String(l1._id), ...w.lineBody(w.product, { quantity: 6, expectedUnitPrice: CHOSEN }) },
        { _id: String(l2._id), ...w.lineBody(w.second, { expectedUnitPrice: SELLING }) },
      ],
    })
    const after = await w.stored(String(ordi._id))
    expect(after.map((l) => [l.quantity, l.expectedUnitPrice, l.pricePinned])).toEqual([[6, CHOSEN, true], [5, SELLING, undefined]])
  })

  it('such a save pins nothing new: a price it changed, or another article on the line, is an indication again', async () => {
    const w = await world()
    const ordi = await w.draft([{ expectedUnitPrice: CHOSEN, pricePinned: true }, { expectedUnitPrice: CHOSEN, pricePinned: true }])
    const [l1, l2] = await w.stored(String(ordi._id))

    await w.ok('PUT', `/invoicing/internal-orders/${ordi._id}`, {
      ...w.header(),
      lines: [
        // The price changed.
        { _id: String(l1._id), ...w.lineBody(w.product, { expectedUnitPrice: 9 }) },
        // The article changed (the first one again, on the second line), the price did not.
        { _id: String(l2._id), ...w.lineBody(w.product, { expectedUnitPrice: CHOSEN }) },
      ],
    })
    expect((await w.stored(String(ordi._id))).map((l) => [l.expectedUnitPrice, l.pricePinned])).toEqual([[9, undefined], [CHOSEN, undefined]])
  })

  it('a save that says so gives the choice back, and takes a new one', async () => {
    const w = await world()
    const ordi = await w.draft([{ expectedUnitPrice: CHOSEN, pricePinned: true }, { expectedUnitPrice: SELLING }])
    const [l1, l2] = await w.stored(String(ordi._id))

    await w.ok('PUT', `/invoicing/internal-orders/${ordi._id}`, {
      ...w.header(),
      lines: [
        { _id: String(l1._id), ...w.lineBody(w.product, { expectedUnitPrice: CHOSEN, pricePinned: false }) },
        { _id: String(l2._id), ...w.lineBody(w.second, { expectedUnitPrice: 9.5, pricePinned: true }) },
      ],
    })
    expect((await w.stored(String(ordi._id))).map((l) => [l.expectedUnitPrice, l.pricePinned])).toEqual([[CHOSEN, undefined], [9.5, true]])
  })
})

describe('The supplier order\'s Convert charges it too', () => {
  it('a reservation on a supplier order that covers a customer order\'s line is invoiced at the price chosen on that line', async () => {
    const w = await world({ stock: 0 })
    const ordi = await w.draft([{ quantity: 4, expectedUnitPrice: CHOSEN, pricePinned: true }])
    const ordiId = String(ordi._id)
    const confirmed = (await w.ok('POST', `/invoicing/internal-orders/${ordiId}/confirm`)).internalOrder
    const generated = await w.ok('POST', `/invoicing/internal-orders/${ordiId}/generate-external`, {
      lines: [{ internalOrderLineId: String(confirmed.lines[0]._id), quantity: 4, supplierId: String(w.supplier._id) }],
    })
    const { order } = await w.ok('POST', `/invoicing/orders/${generated.order._id}/send`)

    // The supplier's goods arrive: a bill against the supplier order's allocation, received.
    const g = order.supplierGroups[0]
    const l = g.lines[0]
    const a = l.allocations[0]
    const { invoice: bill } = await w.ok('POST', '/invoices', {
      type: 'invoice', direction: 'incoming', contactId: String(w.supplier._id), issueDate: TODAY, currency: 'EUR',
      orderId: String(order._id), orderGroupId: String(g._id),
      lines: [{
        productId: String(w.product._id), description: w.product.name, quantity: 4, unit: 'pcs', unitPrice: 1, taxRate: 18,
        warehouseId: String(a.warehouseId),
        orderRef: { orderId: String(order._id), groupId: String(g._id), lineId: String(l._id), allocationId: String(a._id) },
      }],
      subtotal: 4, total: 4.72,
    })
    await w.ok('POST', `/invoices/${idOf(bill)}/receive`)

    const conv = await w.ok('POST', `/invoicing/orders/${order._id}/convert`, { contactId: String(w.client._id) })
    const inv = await w.invoiceOf(idOf(conv.invoice))
    expect(inv.lines.map((x: any) => [x.quantity, x.unitPrice])).toEqual([[4, CHOSEN]])
    expect(w.trail(inv.lines[0]).at(-1)).toEqual(['override', confirmed.orderNumber, CHOSEN])
  })

  it('a client\'s reservation on a supplier order with no customer order behind it is priced for the client', async () => {
    const w = await world({ stock: 0 })
    const { order: made } = await w.ok('POST', '/invoicing/orders', {
      issueDate: TODAY,
      supplierGroups: [{
        supplierId: String(w.supplier._id),
        lines: [{
          productId: String(w.product._id), description: w.product.name, quantity: 4, unit: 'pcs', expectedUnitPrice: 1,
          allocations: [{ warehouseId: String(w.wh._id), quantity: 4 }],
        }],
      }],
    })
    const { order } = await w.ok('POST', `/invoicing/orders/${made._id}/send`)
    const g = order.supplierGroups[0]
    const l = g.lines[0]
    const a = l.allocations[0]
    await w.ok('POST', '/invoicing/reservations', {
      source: 'order', productId: String(w.product._id), quantity: 4, contactId: String(w.client._id),
      orderId: String(order._id), groupId: String(g._id), lineId: String(l._id), allocationId: String(a._id),
    })
    const { invoice: bill } = await w.ok('POST', '/invoices', {
      type: 'invoice', direction: 'incoming', contactId: String(w.supplier._id), issueDate: TODAY, currency: 'EUR',
      orderId: String(order._id), orderGroupId: String(g._id),
      lines: [{
        productId: String(w.product._id), description: w.product.name, quantity: 4, unit: 'pcs', unitPrice: 1, taxRate: 18,
        warehouseId: String(a.warehouseId),
        orderRef: { orderId: String(order._id), groupId: String(g._id), lineId: String(l._id), allocationId: String(a._id) },
      }],
      subtotal: 4, total: 4.72,
    })
    await w.ok('POST', `/invoices/${idOf(bill)}/receive`)

    const conv = await w.ok('POST', `/invoicing/orders/${order._id}/convert`, { contactId: String(w.client._id) })
    const inv = await w.invoiceOf(idOf(conv.invoice))
    expect(inv.lines.map((x: any) => [x.quantity, x.unitPrice])).toEqual([[4, CLIENTS]])
    expect(w.trail(inv.lines[0])).toEqual([['base', 'Selling price', SELLING], ['tier', 'Цена 4', CLIENTS]])
  })
})
