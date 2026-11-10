import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestUser, createTestContact, createTestProduct, createTestStockLevel, createTestWarehouse,
} from '../helpers/factories'
import { internalOrderController } from 'invoicing-api/src/controllers/internal-order.controller'
import { orderController } from 'invoicing-api/src/controllers/order.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { AuditLog, InternalOrder, Order, Reservation, StockLevel } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { MAX_ORDER_ITEMS } from 'services/biz/orders-from-products.service'

/**
 * FR-28.18 — a customer order from the Products list: ONE draft ORDI, idempotent on `requestId`, that confirms,
 * reserves and sends nothing.
 *
 * What the cases pin (spec §6): the draft and its lines; every id checked against the organization of the route (a
 * client, product or warehouse of ANOTHER one is refused); the client a customer (or both); an inactive product and a
 * quantity <= 0 skipped; more than 500; the same `requestId` twice makes ONE order; the audit entry; the draft number
 * and its retry on a duplicate; a read-only role is refused.
 *
 * Over HTTP through the real controllers. NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(internalOrderController).use(orderController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const year = new Date().getFullYear()
const READ_ONLY = { role: 'member', permissions: ['invoicing.read', 'inventory.read'] }

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const client = await createTestContact(org._id, { type: 'customer', companyName: 'Delta Client' } as any)
  const both = await createTestContact(org._id, { type: 'both', companyName: 'Gamma Trade' } as any)
  const supplier = await createTestContact(org._id, { type: 'supplier', companyName: 'Alfa Fasteners' } as any)
  const gone = await createTestContact(org._id, { type: 'customer', companyName: 'Gone Client', isActive: false } as any)
  const main = await createTestWarehouse(org._id, { name: 'Main', isDefault: true } as any)
  const bolt = await createTestProduct(org._id, { name: 'Hex bolt M8x40', sku: 'PRD-0001', unit: 'pcs', sellingPrice: 0.3 } as any)
  const nut = await createTestProduct(org._id, { name: 'Hex nut M8', sku: 'PRD-0002', unit: 'box', sellingPrice: 0 } as any)
  const retired = await createTestProduct(org._id, { name: 'Old washer', sku: 'PRD-0009', isActive: false } as any)

  const other = await createTestOrg()
  const otherClient = await createTestContact(other._id, { type: 'customer', companyName: 'Foreign Client' } as any)
  const otherWarehouse = await createTestWarehouse(other._id, { name: 'Foreign WH', isDefault: true } as any)
  const otherProduct = await createTestProduct(other._id, { name: 'Foreign bolt', sku: 'FRN-0001' } as any)

  const claims = (over: object) => ({
    id: String(user._id), orgId, email: 'a@t.test', username: 'u', firstName: 'A', lastName: 'B', ownRecordsModules: [],
    role: 'admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ...over,
  })
  const token = (over: object = {}) => (signer as any).decorator.jwt.sign(claims(over)) as Promise<string>
  async function create(body: any, who: object = {}) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/invoicing/internal-orders/from-products`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token(who)}` },
      body: JSON.stringify(body),
    }))
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* not json */ }
    return { status: res.status, json, text }
  }
  let rid = 0
  const requestId = () => `req-${Date.now()}-${++rid}`
  const body = (over: Record<string, unknown> = {}) => ({
    requestId: requestId(), contactId: String(client._id), requestedDeliveryDate: '2026-12-15',
    items: [{ productId: String(bolt._id), quantity: 3 }, { productId: String(nut._id), quantity: 1 }], ...over,
  })
  return { org, orgId, user, client, both, supplier, gone, main, bolt, nut, retired, other, otherClient, otherWarehouse, otherProduct, create, body, requestId }
}

describe('the create: one draft customer order (FR-28.18)', () => {
  it('makes ONE draft ORDI: the client, the delivery date, a line per article from the selling price; nothing confirmed, reserved or sent', async () => {
    const w = await world()
    await createTestStockLevel(w.org._id, w.bolt._id, w.main._id, { quantity: 50, availableQuantity: 50 })
    const res = await w.create(w.body({ priority: 'high', warehouseId: String(w.main._id), issueDate: '2026-11-10' }))
    expect(res.status).toBe(200)
    expect(res.json.skipped).toEqual([])
    const order = res.json.order
    expect(order.status).toBe('draft')
    expect(order.orderNumber).toMatch(new RegExp(`^DRF-ORDI-${year}-\\d{5}$`))
    expect(order.contactId).toBe(String(w.client._id))
    expect(order.priority).toBe('high')
    expect(order.warehouseId).toBe(String(w.main._id))
    expect(order.currency).toBe('EUR')
    expect(order.requestedDeliveryDate.slice(0, 10)).toBe('2026-12-15')
    expect(order.issueDate.slice(0, 10)).toBe('2026-11-10')
    expect(order.createdFrom).toMatchObject({ source: 'products' })
    expect(order.lines.map((l: any) => [l.description, l.sku, l.quantity, l.unit])).toEqual([
      ['Hex bolt M8x40', 'PRD-0001', 3, 'pcs'], ['Hex nut M8', 'PRD-0002', 1, 'box'],
    ])
    // The price is the selling price a customer order shows, and a price of 0 is "not set".
    expect(order.lines[0].expectedUnitPrice).toBe(0.3)
    expect(order.lines[1].expectedUnitPrice).toBeUndefined()
    for (const l of order.lines) expect([l.reservedQuantity, l.invoicedQuantity, l.deliveredQuantity]).toEqual([0, 0, 0])

    expect(await InternalOrder.countDocuments({ orgId: w.org._id })).toBe(1)
    expect(await Reservation.countDocuments({})).toBe(0)
    expect(await Order.countDocuments({})).toBe(0)
    const stock: any = await StockLevel.findOne({ productId: w.bolt._id }).lean()
    expect([stock.quantity, stock.reservedQuantity]).toEqual([50, 0])
    expect(((await InternalOrder.findOne({}).lean()) as any).status).toBe('draft')
  })

  it('a client that is both a customer and a supplier will do; the defaults: normal priority, issued today, no preferred warehouse', async () => {
    const w = await world()
    const res = await w.create(w.body({ contactId: String(w.both._id) }))
    expect(res.status).toBe(200)
    expect(res.json.order).toMatchObject({ contactId: String(w.both._id), priority: 'normal' })
    expect(res.json.order.warehouseId).toBeUndefined()
    expect(res.json.order.issueDate.slice(0, 10)).toBe(new Date().toISOString().slice(0, 10))
  })

  it('writes an audit entry: a create of a customer order, with its source and the number of articles', async () => {
    const w = await world()
    const res = await w.create(w.body())
    let entry: any = null
    for (let i = 0; i < 40 && !entry; i++) {
      entry = await AuditLog.findOne({ orgId: w.org._id, entityType: 'internal_order', action: 'create' }).lean()
      if (!entry) await new Promise((r) => setTimeout(r, 50))
    }
    expect(entry).toBeTruthy()
    expect(String(entry.entityId)).toBe(res.json.order._id)
    expect(entry.entityName).toBe(res.json.order.orderNumber)
    expect(entry.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'source', newValue: 'products' }),
      expect.objectContaining({ field: 'items', newValue: 2 }),
    ]))
  })

  it('the same requestId twice makes ONE order, even at the same moment', async () => {
    const w = await world()
    const same = w.body({ requestId: 'dialog-open-1' })
    const first = await w.create(same)
    const second = await w.create(same)
    expect([first.status, second.status]).toEqual([200, 200])
    expect(second.json.order._id).toBe(first.json.order._id)
    expect(second.json.replayed).toBe(true)
    expect(await InternalOrder.countDocuments({ orgId: w.org._id })).toBe(1)

    const double = w.body({ requestId: 'double-click' })
    const answers = await Promise.all([w.create(double), w.create(double), w.create(double)])
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200])
    expect(new Set(answers.map((a) => a.json.order._id)).size).toBe(1)
    expect(await InternalOrder.countDocuments({ orgId: w.org._id })).toBe(2)
  })

  it('checks every id against the organization of the route: the client, the warehouse and the articles of another one are refused', async () => {
    const w = await world()
    const client = await w.create(w.body({ contactId: String(w.otherClient._id) }))
    expect(client.status).toBe(404)
    expect(client.json.code).toBe('client_not_found')
    const warehouse = await w.create(w.body({ warehouseId: String(w.otherWarehouse._id) }))
    expect(warehouse.status).toBe(422)
    expect(warehouse.json.code).toBe('warehouse_not_found')
    // An article of another organization is skipped, as one that does not exist.
    const mixed = await w.create(w.body({ items: [{ productId: String(w.bolt._id), quantity: 2 }, { productId: String(w.otherProduct._id), quantity: 2 }] }))
    expect(mixed.status).toBe(200)
    expect(mixed.json.skipped).toEqual([{ productId: String(w.otherProduct._id), reason: 'product_not_found' }])
    expect(mixed.json.order.lines).toHaveLength(1)
    expect(await InternalOrder.countDocuments({ orgId: w.other._id })).toBe(0)
    expect(await InternalOrder.countDocuments({})).toBe(1)
  })

  it('the client must be a customer, and active; the delivery date must be a date', async () => {
    const w = await world()
    const asSupplier = await w.create(w.body({ contactId: String(w.supplier._id) }))
    expect(asSupplier.status).toBe(422)
    expect(asSupplier.json.code).toBe('not_a_customer')
    const dormant = await w.create(w.body({ contactId: String(w.gone._id) }))
    expect(dormant.status).toBe(422)
    expect(dormant.json.code).toBe('client_inactive')
    const noDate = await w.create(w.body({ requestedDeliveryDate: 'sometime' }))
    expect(noDate.status).toBe(422)
    expect(noDate.json.code).toBe('delivery_date_required')
    const badIssue = await w.create(w.body({ issueDate: 'yesterday-ish' }))
    expect(badIssue.status).toBe(422)
    expect(badIssue.json.code).toBe('invalid_issue_date')
    const noClient = await w.create({ ...w.body(), contactId: 'not-an-id' })
    expect(noClient.status).toBe(404)
    expect(await InternalOrder.countDocuments({})).toBe(0)
  })

  it('skips an inactive article and a quantity of 0 or less, and is refused with 422 when none can stand', async () => {
    const w = await world()
    const res = await w.create(w.body({
      items: [{ productId: String(w.bolt._id), quantity: 2 }, { productId: String(w.retired._id), quantity: 2 }, { productId: String(w.nut._id), quantity: 0 }],
    }))
    expect(res.status).toBe(200)
    expect(res.json.skipped).toEqual([
      { productId: String(w.retired._id), reason: 'product_inactive' },
      { productId: String(w.nut._id), reason: 'invalid_quantity' },
    ])
    expect(res.json.order.lines).toHaveLength(1)

    const none = await w.create(w.body({ items: [{ productId: String(w.retired._id), quantity: 2 }] }))
    expect(none.status).toBe(422)
    expect(none.json.code).toBe('nothing_to_order')
    const empty = await w.create(w.body({ items: [] }))
    expect(empty.status).toBe(422)
    expect(empty.json.code).toBe('no_items')
    expect(await InternalOrder.countDocuments({})).toBe(1)
  })

  it('refuses more than 500 articles', async () => {
    const w = await world()
    const items = Array.from({ length: MAX_ORDER_ITEMS + 1 }, () => ({ productId: String(w.bolt._id), quantity: 1 }))
    const res = await w.create(w.body({ items }))
    expect(res.status).toBe(422)
    expect(res.json).toMatchObject({ code: 'selection_too_large', max: MAX_ORDER_ITEMS })
    const ok = await w.create(w.body({ items: items.slice(0, MAX_ORDER_ITEMS) }))
    expect(ok.status).toBe(200)
    expect(ok.json.order.lines).toHaveLength(MAX_ORDER_ITEMS)
  }, 60_000)

  it('allocates the draft number from the draft counter, and tries again when it is taken', async () => {
    const w = await world()
    const first = await w.create(w.body())
    const n1 = Number(first.json.order.orderNumber.split('-').pop())
    await InternalOrder.create({
      orgId: w.org._id, orderNumber: `DRF-ORDI-${year}-${String(n1 + 1).padStart(5, '0')}`, status: 'draft', contactId: w.client._id,
      issueDate: new Date(), requestedDeliveryDate: new Date(), currency: 'EUR', exchangeRate: 1, createdBy: w.user._id, lines: [],
    } as any)
    const next = await w.create(w.body())
    expect(next.status).toBe(200)
    expect(next.json.order.orderNumber).toBe(`DRF-ORDI-${year}-${String(n1 + 2).padStart(5, '0')}`)
  })

  it('a read-only role is refused, and so is another organization\'s URL', async () => {
    const w = await world()
    expect((await w.create(w.body(), READ_ONLY)).status).toBe(403)
    const foreign = await app.handle(new Request(`http://localhost/org/${w.other._id}/invoicing/internal-orders/from-products`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await (signer as any).decorator.jwt.sign({
        id: String(w.user._id), orgId: w.orgId, email: 'a@t.test', username: 'u', firstName: 'A', lastName: 'B', ownRecordsModules: [],
        role: 'admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin,
      })}` },
      body: JSON.stringify(w.body()),
    }))
    expect(foreign.status).toBe(403)
    expect(await InternalOrder.countDocuments({})).toBe(0)
  })
})
