import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestUser, createTestContact, createTestInvoice, createTestProduct, createTestStockLevel, createTestWarehouse,
} from '../helpers/factories'
import { orderController } from 'invoicing-api/src/controllers/order.controller'
import { productController } from 'warehouse-api/src/controllers/product.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { AuditLog, Order, Product, Reservation, StockLevel } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { can } from 'services/biz/access/evaluate'
import { MAX_ORDER_ITEMS } from 'services/biz/orders-from-products.service'
import { suggestedOrderQuantity, toOrderQuantity } from 'config/reorder-quantity'

/**
 * FR-28.16 / .17 / .21 — a supplier order from the Products list: the preview and the create.
 *
 * What the cases pin (spec §6):
 *   - the preview's defaults (quantity, supplier, price, warehouse), computed on the server, equal to what the
 *     list's „To order" column says; "all that match" resolved with the list's OWN filter builder;
 *   - one group per supplier, a line per article, one allocation of the whole quantity per line, a DRAFT;
 *   - every id checked against the organization of the route (a product, supplier or warehouse of ANOTHER one is
 *     refused, as one that does not exist); an inactive product and a non-supplier skipped; quantity <= 0; > 500;
 *   - `appendToOrderId` only to a draft; the same `requestId` twice makes ONE order, even at the same time;
 *   - the audit entry; the draft number and its retry on a duplicate;
 *   - a role without `bills.view` gets no supplier suggestion and no cost-derived price: the keys are absent.
 *
 * Over HTTP through the real controllers. NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(orderController).use(productController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const year = new Date().getFullYear()
const day = (iso: string) => new Date(`${iso}T10:00:00Z`)

// Roles as their tokens carry them. The Seller of FR-26 holds invoicing and an `areas` list: it may create an order
// (the `orders` area) and read no bill (no `purchases`). A read-only role may not create at all.
const NO_BILLS = { role: 'member', permissions: ['invoicing.write', 'inventory.read'], areas: ['orders'] as string[] }
const READ_ONLY = { role: 'member', permissions: ['invoicing.read', 'inventory.read'] }

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const alfa = await createTestContact(org._id, { type: 'supplier', companyName: 'Alfa Fasteners' } as any)
  const beta = await createTestContact(org._id, { type: 'supplier', companyName: 'Beta Tools' } as any)
  const gamma = await createTestContact(org._id, { type: 'both', companyName: 'Gamma Supply' } as any)
  const client = await createTestContact(org._id, { type: 'customer', companyName: 'Delta Client' } as any)
  const dormant = await createTestContact(org._id, { type: 'supplier', companyName: 'Dormant Ltd', isActive: false } as any)
  const main = await createTestWarehouse(org._id, { name: 'Main', isDefault: true } as any)
  const second = await createTestWarehouse(org._id, { name: 'Second' } as any)
  // bolt: min 20, max 50. nut: min 5, no max. washer: no levels. service: not tracked.
  const bolt = await createTestProduct(org._id, { name: 'Hex bolt M8x40', sku: 'PRD-0001', minStockLevel: 20, maxStockLevel: 50, purchasePrice: 0.1 } as any)
  const nut = await createTestProduct(org._id, { name: 'Hex nut M8', sku: 'PRD-0002', minStockLevel: 5, purchasePrice: 0.05 } as any)
  const washer = await createTestProduct(org._id, { name: 'Washer M8', sku: 'PRD-0003', minStockLevel: 0, purchasePrice: 0 } as any)
  const service = await createTestProduct(org._id, { name: 'Delivery', sku: 'SRV-0001', type: 'service', trackInventory: false, minStockLevel: 0, purchasePrice: 0 } as any)
  const retired = await createTestProduct(org._id, { name: 'Old washer', sku: 'PRD-0009', isActive: false } as any)

  // ANOTHER organization, with one of everything: none of it may be reachable from the first.
  const other = await createTestOrg()
  const otherSupplier = await createTestContact(other._id, { type: 'supplier', companyName: 'Foreign Supplier' } as any)
  const otherWarehouse = await createTestWarehouse(other._id, { name: 'Foreign WH', isDefault: true } as any)
  const otherProduct = await createTestProduct(other._id, { name: 'Foreign bolt', sku: 'FRN-0001' } as any)

  const claims = (over: object) => ({
    id: String(user._id), orgId, email: 'a@t.test', username: 'u', firstName: 'A', lastName: 'B', ownRecordsModules: [],
    role: 'admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ...over,
  })
  const token = (over: object = {}) => (signer as any).decorator.jwt.sign(claims(over)) as Promise<string>

  async function call(method: string, path: string, body?: any, who: object = {}, forOrg = orgId) {
    const res = await app.handle(new Request(`http://localhost/org/${forOrg}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token(who)}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* not json */ }
    return { status: res.status, json, text }
  }
  const preview = (body: any, who: object = {}) => call('POST', '/invoicing/orders/from-products/preview', body, who)
  const create = (body: any, who: object = {}) => call('POST', '/invoicing/orders/from-products', body, who)

  let n = 0
  /** A received bill, one line per `[product, quantity, unitPrice]`. */
  const bill = (supplier: any, lines: Array<[any, number, number]>, over: Record<string, unknown> = {}) => createTestInvoice(org._id, supplier._id, {
    invoiceNumber: `BILL-${year}-${String(++n).padStart(5, '0')}`, type: 'invoice', direction: 'incoming', status: 'received', currency: 'EUR',
    issueDate: day('2026-05-10'),
    lines: lines.map(([p, quantity, unitPrice]) => ({ productId: p._id, description: p.name, quantity, unit: 'pcs', unitPrice, discount: 0, taxRate: 20, taxAmount: 0, lineTotal: quantity * unitPrice })),
    ...over,
  } as any)

  const item = (product: any, supplier: any, quantity = 5, extra: Record<string, unknown> = {}) => ({
    productId: String(product._id), quantity, supplierId: String(supplier._id), warehouseId: String(main._id), ...extra,
  })
  let rid = 0
  const requestId = () => `req-${Date.now()}-${++rid}`

  return {
    org, orgId, user, alfa, beta, gamma, client, dormant, main, second, bolt, nut, washer, service, retired,
    other, otherSupplier, otherWarehouse, otherProduct, token, call, preview, create, bill, item, requestId,
  }
}

const rowOf = (res: any, product: any) => res.json.rows.find((r: any) => r.productId === String(product._id))

describe('the preview: the defaults of the dialog (FR-28.16)', () => {
  it('starts each quantity where the list\'s „To order" says, from the position on hand − reserved + on order', async () => {
    const w = await world()
    // bolt: 4 on hand, 1 reserved, 10 on a sent supplier order → position 13, target 50 → 37.
    await createTestStockLevel(w.org._id, w.bolt._id, w.main._id, { quantity: 4, reservedQuantity: 1, availableQuantity: 3 })
    await Order.create({
      orgId: w.org._id, orderNumber: 'ORDO-X-1', status: 'sent', issueDate: new Date(), currency: 'EUR', exchangeRate: 1, createdBy: w.user._id,
      supplierGroups: [{ supplierId: w.alfa._id, lines: [{ productId: w.bolt._id, description: 'bolt', quantity: 10, unit: 'pcs', allocations: [{ warehouseId: w.main._id, quantity: 10 }] }] }],
    } as any)
    // nut: min only. 2 on hand → 5 − 2 = 3. washer and the service carry no levels: 1.
    await createTestStockLevel(w.org._id, w.nut._id, w.main._id, { quantity: 2, availableQuantity: 2 })

    const res = await w.preview({ productIds: [String(w.bolt._id), String(w.nut._id), String(w.washer._id), String(w.service._id)] })
    expect(res.status).toBe(200)
    expect(res.json.total).toBe(4)
    expect(rowOf(res, w.bolt)).toMatchObject({ onHand: 4, reserved: 1, onOrder: 10, minStockLevel: 20, maxStockLevel: 50, suggestedQuantity: 37 })
    expect(rowOf(res, w.nut)).toMatchObject({ onHand: 2, reserved: 0, onOrder: 0, suggestedQuantity: 3 })
    expect(rowOf(res, w.washer).suggestedQuantity).toBe(1)
    expect(rowOf(res, w.service)).toMatchObject({ suggestedQuantity: 1, trackInventory: false })
    // The same figure the list shows: the shared arithmetic gives the same where the list has one.
    expect(toOrderQuantity(w.bolt as any, 13)).toBe(37)
    expect(suggestedOrderQuantity(w.bolt as any, 13)).toBe(37)
  })

  it('rows come with the article\'s facts and the default warehouse, in name order', async () => {
    const w = await world()
    const res = await w.preview({ productIds: [String(w.washer._id), String(w.bolt._id)] })
    expect(res.json.currency).toBe('EUR')
    expect(res.json.rows.map((r: any) => r.name)).toEqual(['Hex bolt M8x40', 'Washer M8'])
    expect(res.json.rows[0]).toMatchObject({ productId: String(w.bolt._id), sku: 'PRD-0001', unit: 'pcs', warehouseId: String(w.main._id) })
  })

  it('names the supplier of the last purchase, with its price; the cost price when there is no purchase', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 10, 0.12]], { issueDate: day('2026-05-10') })
    await w.bill(w.beta, [[w.bolt, 10, 0.2]], { issueDate: day('2026-06-10') })
    const res = await w.preview({ productIds: [String(w.bolt._id), String(w.nut._id)] })
    const bolt = rowOf(res, w.bolt)
    // The most recent purchase wins, and every supplier that sold it is offered, newest first.
    expect(bolt.supplierId).toBe(String(w.beta._id))
    expect(bolt.suppliers.map((s: any) => s.name)).toEqual(['Beta Tools', 'Alfa Fasteners'])
    expect(bolt.suppliers[0]).toMatchObject({ lastUnitPrice: 0.2, currency: 'EUR' })
    expect(bolt.expectedUnitPrice).toBe(0.2)
    // No purchase and no order: no supplier is guessed, and the price is the article's cost price.
    const nut = rowOf(res, w.nut)
    expect(nut.suppliers).toEqual([])
    expect(nut.supplierId).toBeUndefined()
    expect(nut.expectedUnitPrice).toBe(0.05)
    // A cost price of 0 is "not set": no price at all.
    expect((await w.preview({ productIds: [String(w.washer._id)] })).json.rows[0].expectedUnitPrice).toBeUndefined()
  })

  it('a supplier order with no purchase behind it still names the supplier; a customer, an inactive supplier and a bill in another currency do not mislead', async () => {
    const w = await world()
    await w.create({ requestId: w.requestId(), items: [w.item(w.washer, w.gamma, 3)] })
    await w.bill(w.client, [[w.nut, 5, 1]])
    await w.bill(w.dormant, [[w.bolt, 5, 1]])
    await w.bill(w.alfa, [[w.service, 5, 3]], { currency: 'USD' })
    const res = await w.preview({ productIds: [String(w.washer._id), String(w.nut._id), String(w.bolt._id), String(w.service._id)] })
    expect(rowOf(res, w.washer)).toMatchObject({ supplierId: String(w.gamma._id) })
    // A customer is not a supplier, and a deactivated supplier is not offered.
    expect(rowOf(res, w.nut).suppliers).toEqual([])
    expect(rowOf(res, w.bolt).suppliers).toEqual([])
    // A price in another currency than the order's is not copied: the cost price (0 here) stands in, i.e. none.
    expect(rowOf(res, w.service).suppliers[0]).toMatchObject({ name: 'Alfa Fasteners', lastUnitPrice: 3, currency: 'USD' })
    expect(rowOf(res, w.service).expectedUnitPrice).toBeUndefined()
  })

  it('scopes the figures to the warehouse of the list, and starts the allocation there', async () => {
    const w = await world()
    await createTestStockLevel(w.org._id, w.bolt._id, w.main._id, { quantity: 30, availableQuantity: 30 })
    await createTestStockLevel(w.org._id, w.bolt._id, w.second._id, { quantity: 4, availableQuantity: 4 })
    const all = rowOf(await w.preview({ productIds: [String(w.bolt._id)] }), w.bolt)
    expect(all).toMatchObject({ onHand: 34, suggestedQuantity: 16, warehouseId: String(w.main._id) })
    const scoped = rowOf(await w.preview({ productIds: [String(w.bolt._id)], warehouseId: String(w.second._id) }), w.bolt)
    expect(scoped).toMatchObject({ onHand: 4, suggestedQuantity: 46, warehouseId: String(w.second._id) })
    // The list's own warehouse filter, inside the filter, scopes the same way.
    const viaFilter = rowOf(await w.preview({ filter: { warehouseId: String(w.second._id), stockMax: '10' } }), w.bolt)
    expect(viaFilter).toMatchObject({ onHand: 4, warehouseId: String(w.second._id) })
  })

  it('"all that match" is resolved with the list\'s own filter: the same articles the list shows, active ones only', async () => {
    const w = await world()
    await createTestStockLevel(w.org._id, w.bolt._id, w.main._id, { quantity: 4, availableQuantity: 4 })
    await createTestStockLevel(w.org._id, w.nut._id, w.main._id, { quantity: 50, availableQuantity: 50 })
    await w.bill(w.alfa, [[w.bolt, 10, 0.12]])
    const filters: Array<Record<string, string>> = [
      { belowMin: 'true' }, { search: 'bolt' }, { search: 'hex' }, { stockMax: '0' }, { stockMin: '10' }, { supplierId: String(w.alfa._id) },
      { noSupplier: 'true' }, { category: 'General' }, { warehouseId: String(w.main._id) }, { isActive: 'true' }, { type: 'service' },
    ]
    for (const filter of filters) {
      const list = await w.call('GET', `/warehouse/product?size=0&isActive=true&${new URLSearchParams(filter)}`)
      const fromList = new Set((list.json.products as any[]).map((p) => String(p._id)))
      const rows = (await w.preview({ filter })).json.rows as any[]
      expect(new Set(rows.map((r) => r.productId)), JSON.stringify(filter)).toEqual(
        // The list was asked for active articles too: the preview never carries a deactivated one.
        new Set([...fromList].filter((id) => id !== String(w.retired._id))),
      )
    }
    // Below minimum: the bolt (4 < 20) and the nut is fine (50 >= 5); a never-stocked washer has no minimum.
    expect((await w.preview({ filter: { belowMin: 'true' } })).json.rows.map((r: any) => r.name)).toEqual(['Hex bolt M8x40'])
  })

  it('explicit articles and a filter together are the union, each article once', async () => {
    const w = await world()
    await createTestStockLevel(w.org._id, w.bolt._id, w.main._id, { quantity: 4, availableQuantity: 4 })
    const res = await w.preview({ productIds: [String(w.washer._id), String(w.bolt._id)], filter: { belowMin: 'true' } })
    // Below minimum: the bolt (4 < 20) and the never-stocked nut (0 < 5, the articles a reorder list is for); the washer is the explicit pick.
    expect(res.json.rows.map((r: any) => r.name).sort()).toEqual(['Hex bolt M8x40', 'Hex nut M8', 'Washer M8'])
    expect(res.json.total).toBe(3)
  })

  it('leaves a deactivated article out of the rows, and another organization\'s article is simply not there', async () => {
    const w = await world()
    const res = await w.preview({ productIds: [String(w.retired._id), String(w.otherProduct._id), String(w.bolt._id), 'not-an-id'] })
    expect(res.status).toBe(200)
    expect(res.json.rows.map((r: any) => r.name)).toEqual(['Hex bolt M8x40'])
  })

  it('refuses nothing to do, a warehouse of another organization, and more than 500 articles', async () => {
    const w = await world()
    const none = await w.preview({})
    expect(none.status).toBe(422)
    expect(none.json.code).toBe('no_selection')

    const foreign = await w.preview({ productIds: [String(w.bolt._id)], warehouseId: String(w.otherWarehouse._id) })
    expect(foreign.status).toBe(422)
    expect(foreign.json.code).toBe('warehouse_not_found')

    const many = Array.from({ length: MAX_ORDER_ITEMS + 1 }, (_, i) => `${i}`.padStart(24, '0'))
    const tooMany = await w.preview({ productIds: many })
    expect(tooMany.status).toBe(422)
    expect(tooMany.json).toMatchObject({ code: 'selection_too_large', max: MAX_ORDER_ITEMS })

    // A filter that matches more than the cap is refused the same way, and says how many it found.
    await Product.insertMany(Array.from({ length: MAX_ORDER_ITEMS }, (_, i) => ({
      orgId: w.org._id, sku: `BULK-${i}`, name: `Bulk ${i}`, category: 'General', type: 'goods', unit: 'pcs', isActive: true,
    })))
    const wide = await w.preview({ filter: { isActive: 'true' } })
    expect(wide.status).toBe(422)
    expect(wide.json).toMatchObject({ code: 'selection_too_large', max: MAX_ORDER_ITEMS })
    expect(wide.json.total).toBeGreaterThan(MAX_ORDER_ITEMS)
    // …and one that matches fewer is not.
    expect((await w.preview({ filter: { search: 'Bulk 1' } })).status).toBe(200)
  }, 60_000)

  it('a customer order\'s rows start at one and carry no supplier or cost', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 10, 0.12]])
    const res = await w.preview({ productIds: [String(w.bolt._id)], kind: 'customer' })
    const row = rowOf(res, w.bolt)
    expect(row.suggestedQuantity).toBe(1)
    expect(Object.keys(row)).not.toContain('suppliers')
    expect(Object.keys(row)).not.toContain('supplierId')
    expect(Object.keys(row)).not.toContain('expectedUnitPrice')
  })
})

describe('who may see what (FR-28.21): the keys are absent, not hidden', () => {
  it('a role that may create an order but not read bills gets no supplier suggestion and no cost-derived price', async () => {
    const w = await world()
    // The role the case needs, stated: it may create, it may not read bills.
    expect(can({ ...NO_BILLS } as any, 'orders.create')).toBe(true)
    expect(can({ ...NO_BILLS } as any, 'bills.view')).toBe(false)

    await w.bill(w.alfa, [[w.bolt, 10, 0.12]])
    await createTestStockLevel(w.org._id, w.bolt._id, w.main._id, { quantity: 4, availableQuantity: 4 })
    const res = await w.preview({ productIds: [String(w.bolt._id)] }, NO_BILLS)
    expect(res.status).toBe(200)
    const row = rowOf(res, w.bolt)
    // The quantity is the article's own business, and stays.
    expect(row).toMatchObject({ suggestedQuantity: 46, onHand: 4 })
    for (const key of ['suppliers', 'supplierId', 'expectedUnitPrice']) expect(Object.keys(row)).not.toContain(key)
    // The JSON is checked, not a column: nothing of the facts is anywhere in the body.
    expect(res.text).not.toContain('Alfa')
    expect(res.text).not.toContain('lastUnitPrice')
    expect(res.text).not.toContain('0.12')

    // The same caller is refused the supplier filters of "all that match", as the list refuses them.
    const bySupplier = await w.preview({ filter: { supplierId: String(w.alfa._id) } }, NO_BILLS)
    expect(bySupplier.status).toBe(403)
    expect(bySupplier.json).toMatchObject({ code: 'capability_required', capabilities: ['bills.view'] })
    expect((await w.preview({ filter: { noSupplier: 'true' } }, NO_BILLS)).status).toBe(403)
    // …and may still pick and order what it is shown: the supplier is its own choice.
    const made = await w.create({ requestId: w.requestId(), items: [w.item(w.bolt, w.alfa, 46)] }, NO_BILLS)
    expect(made.status).toBe(200)
    expect(made.json.order.supplierGroups[0].lines[0].expectedUnitPrice).toBeUndefined()
  })

  it('a read-only role may neither preview nor create; another organization\'s token reaches nothing', async () => {
    const w = await world()
    expect((await w.preview({ productIds: [String(w.bolt._id)] }, READ_ONLY)).status).toBe(403)
    expect((await w.create({ requestId: w.requestId(), items: [w.item(w.bolt, w.alfa)] }, READ_ONLY)).status).toBe(403)
    // A token of the first organization against the second one's URL: the tenant guard.
    const foreign = await w.call('POST', '/invoicing/orders/from-products', { requestId: 'x', items: [w.item(w.bolt, w.alfa)] }, {}, String(w.other._id))
    expect(foreign.status).toBe(403)
    expect(await Order.countDocuments({})).toBe(0)
  })
})

describe('the create: one draft supplier order (FR-28.17)', () => {
  it('makes ONE draft: a group per supplier, a line per article, one allocation of the whole quantity to the row\'s warehouse', async () => {
    const w = await world()
    const res = await w.create({
      requestId: w.requestId(),
      items: [
        w.item(w.bolt, w.alfa, 30, { expectedUnitPrice: 0.12 }),
        w.item(w.nut, w.alfa, 12),
        { ...w.item(w.washer, w.beta, 7), warehouseId: String(w.second._id) },
      ],
    })
    expect(res.status).toBe(200)
    expect(res.json.skipped).toEqual([])
    const order = res.json.order
    expect(order.status).toBe('draft')
    expect(order.orderNumber).toMatch(new RegExp(`^DRF-ORDO-${year}-\\d{5}$`))
    expect(order.draftNumber).toBeUndefined()
    expect(order.currency).toBe('EUR')
    expect(order.createdFrom).toMatchObject({ source: 'products' })
    expect(order.statusHistory).toHaveLength(1)
    expect(order.supplierGroups).toHaveLength(2)

    const alfa = order.supplierGroups.find((g: any) => g.supplierId === String(w.alfa._id))
    const beta = order.supplierGroups.find((g: any) => g.supplierId === String(w.beta._id))
    expect(alfa.lines.map((l: any) => l.description)).toEqual(['Hex bolt M8x40', 'Hex nut M8'])
    expect(alfa.lines[0]).toMatchObject({ productId: String(w.bolt._id), sku: 'PRD-0001', quantity: 30, unit: 'pcs', expectedUnitPrice: 0.12, receivedQuantity: 0 })
    expect(alfa.lines[1].expectedUnitPrice).toBeUndefined()
    // One allocation per line, of the whole quantity, to the row's warehouse.
    for (const line of [...alfa.lines, ...beta.lines]) {
      expect(line.allocations).toHaveLength(1)
      expect(line.allocations[0].quantity).toBe(line.quantity)
    }
    expect(alfa.lines[0].allocations[0].warehouseId).toBe(String(w.main._id))
    expect(beta.lines[0].allocations[0].warehouseId).toBe(String(w.second._id))

    // It is the same document in the database, and nothing else happened: no reservation, no stock moved, nothing sent.
    expect(await Order.countDocuments({ orgId: w.org._id })).toBe(1)
    expect(await Reservation.countDocuments({})).toBe(0)
    expect(await StockLevel.countDocuments({})).toBe(0)
    const stored: any = await Order.findOne({ orgId: w.org._id }).lean()
    expect(stored.status).toBe('draft')
  })

  it('writes an audit entry: a create of an order, with its source and the number of articles', async () => {
    const w = await world()
    const res = await w.create({ requestId: w.requestId(), items: [w.item(w.bolt, w.alfa), w.item(w.nut, w.beta)] })
    let entry: any = null
    for (let i = 0; i < 40 && !entry; i++) {
      entry = await AuditLog.findOne({ orgId: w.org._id, entityType: 'order', action: 'create' }).lean()
      if (!entry) await new Promise((r) => setTimeout(r, 50))
    }
    expect(entry).toBeTruthy()
    expect(String(entry.entityId)).toBe(res.json.order._id)
    expect(entry.entityName).toBe(res.json.order.orderNumber)
    expect(entry.module).toBe('invoicing')
    expect(entry.changes).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'source', newValue: 'products' }),
      expect.objectContaining({ field: 'items', newValue: 2 }),
    ]))
  })

  it('the same requestId twice makes ONE order, and answers with it', async () => {
    const w = await world()
    const body = { requestId: 'dialog-open-1', items: [w.item(w.bolt, w.alfa, 8)] }
    const first = await w.create(body)
    const second = await w.create(body)
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
    expect(second.json.order._id).toBe(first.json.order._id)
    expect(second.json.replayed).toBe(true)
    expect(first.json.replayed).toBeUndefined()
    expect(await Order.countDocuments({ orgId: w.org._id })).toBe(1)
    // Another request is another order.
    const third = await w.create({ ...body, requestId: 'dialog-open-2' })
    expect(third.json.order._id).not.toBe(first.json.order._id)
    expect(await Order.countDocuments({ orgId: w.org._id })).toBe(2)
  })

  it('a double click — two requests at the same moment — still makes ONE order', async () => {
    const w = await world()
    const body = { requestId: 'double-click', items: [w.item(w.bolt, w.alfa, 8), w.item(w.nut, w.beta, 2)] }
    const answers = await Promise.all([w.create(body), w.create(body), w.create(body)])
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200])
    expect(new Set(answers.map((a) => a.json.order._id)).size).toBe(1)
    expect(await Order.countDocuments({ orgId: w.org._id })).toBe(1)
  })

  it('the same requestId in two organizations is two requests', async () => {
    const w = await world()
    const otherUser = await createTestUser(w.other._id)
    const otherToken = await (signer as any).decorator.jwt.sign({
      id: String(otherUser._id), orgId: String(w.other._id), email: 'o@t.test', username: 'o', firstName: 'O', lastName: 'O',
      ownRecordsModules: [], role: 'admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin,
    })
    const mine = await w.create({ requestId: 'shared-id', items: [w.item(w.bolt, w.alfa)] })
    const res = await app.handle(new Request(`http://localhost/org/${w.other._id}/invoicing/orders/from-products`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${otherToken}` },
      body: JSON.stringify({
        requestId: 'shared-id',
        items: [{ productId: String(w.otherProduct._id), quantity: 1, supplierId: String(w.otherSupplier._id), warehouseId: String(w.otherWarehouse._id) }],
      }),
    }))
    const theirs: any = await res.json()
    expect(res.status).toBe(200)
    expect(theirs.order._id).not.toBe(mine.json.order._id)
    expect(await Order.countDocuments({})).toBe(2)
  })

  it('checks every id against the organization of the route: another organization\'s product, supplier and warehouse are refused', async () => {
    const w = await world()
    const res = await w.create({
      requestId: w.requestId(),
      items: [
        w.item(w.bolt, w.alfa, 5),
        { ...w.item(w.nut, w.alfa, 5), productId: String(w.otherProduct._id) },
        w.item(w.washer, w.otherSupplier, 5),
        { ...w.item(w.service, w.alfa, 5), warehouseId: String(w.otherWarehouse._id) },
      ],
    })
    // The article that can stand is ordered; the three that name something of another organization are skipped,
    // with the reason a missing one would give: nothing says it exists elsewhere.
    expect(res.status).toBe(200)
    expect(res.json.skipped).toEqual(expect.arrayContaining([
      { productId: String(w.otherProduct._id), reason: 'product_not_found' },
      { productId: String(w.washer._id), reason: 'supplier_not_found' },
      { productId: String(w.service._id), reason: 'warehouse_not_found' },
    ]))
    expect(res.json.skipped).toHaveLength(3)
    expect(res.json.order.supplierGroups).toHaveLength(1)
    expect(res.json.order.supplierGroups[0].lines.map((l: any) => l.description)).toEqual(['Hex bolt M8x40'])
  })

  it('skips an inactive article, a contact that is not a supplier, an inactive supplier, a quantity of 0 or less and a bad price', async () => {
    const w = await world()
    const res = await w.create({
      requestId: w.requestId(),
      items: [
        w.item(w.bolt, w.alfa, 5),
        w.item(w.retired, w.alfa, 5),
        w.item(w.nut, w.client, 5),
        w.item(w.washer, w.dormant, 5),
        w.item(w.service, w.alfa, 0),
        w.item(w.nut, w.gamma, -3),
        w.item(w.washer, w.gamma, 2, { expectedUnitPrice: -1 }),
      ],
    })
    expect(res.status).toBe(200)
    expect(res.json.skipped).toEqual([
      { productId: String(w.retired._id), reason: 'product_inactive' },
      { productId: String(w.nut._id), reason: 'not_a_supplier' },
      { productId: String(w.washer._id), reason: 'supplier_inactive' },
      { productId: String(w.service._id), reason: 'invalid_quantity' },
      { productId: String(w.nut._id), reason: 'invalid_quantity' },
      { productId: String(w.washer._id), reason: 'invalid_price' },
    ])
    expect(res.json.order.supplierGroups).toHaveLength(1)
    // A supplier that is both a supplier and a customer is a supplier.
    const both = await w.create({ requestId: w.requestId(), items: [w.item(w.nut, w.gamma, 2)] })
    expect(both.status).toBe(200)
  })

  it('is refused with 422 when no article can stand, and then makes nothing', async () => {
    const w = await world()
    const res = await w.create({ requestId: w.requestId(), items: [w.item(w.retired, w.alfa, 5), w.item(w.bolt, w.alfa, 0)] })
    expect(res.status).toBe(422)
    expect(res.json.code).toBe('nothing_to_order')
    expect(res.json.skipped).toHaveLength(2)
    expect(await Order.countDocuments({})).toBe(0)
    const empty = await w.create({ requestId: w.requestId(), items: [] })
    expect(empty.status).toBe(422)
    expect(empty.json.code).toBe('no_items')
    // …and a request with no requestId is a request that cannot be told from another.
    const anon = await w.create({ requestId: '', items: [w.item(w.bolt, w.alfa)] })
    expect(anon.status).toBe(422)
  })

  it('refuses more than 500 articles', async () => {
    const w = await world()
    const items = Array.from({ length: MAX_ORDER_ITEMS + 1 }, () => w.item(w.bolt, w.alfa, 1))
    const res = await w.create({ requestId: w.requestId(), items })
    expect(res.status).toBe(422)
    expect(res.json).toMatchObject({ code: 'selection_too_large', max: MAX_ORDER_ITEMS })
    expect(await Order.countDocuments({})).toBe(0)
    // Exactly 500 is fine: lines are appended, never merged, so one article twice is two lines.
    const ok = await w.create({ requestId: w.requestId(), items: Array.from({ length: MAX_ORDER_ITEMS }, () => w.item(w.bolt, w.alfa, 1)) })
    expect(ok.status).toBe(200)
    expect(ok.json.order.supplierGroups[0].lines).toHaveLength(MAX_ORDER_ITEMS)
  }, 60_000)

  it('allocates the draft number from the draft counter, and tries again when it is taken', async () => {
    const w = await world()
    const first = await w.create({ requestId: w.requestId(), items: [w.item(w.bolt, w.alfa)] })
    const n1 = Number(first.json.order.orderNumber.split('-').pop())
    // Someone else holds the next number: the create takes the one after it, not an error.
    await Order.create({
      orgId: w.org._id, orderNumber: `DRF-ORDO-${year}-${String(n1 + 1).padStart(5, '0')}`, status: 'draft', issueDate: new Date(), currency: 'EUR',
      exchangeRate: 1, createdBy: w.user._id, supplierGroups: [],
    } as any)
    const next = await w.create({ requestId: w.requestId(), items: [w.item(w.nut, w.alfa)] })
    expect(next.status).toBe(200)
    expect(next.json.order.orderNumber).toBe(`DRF-ORDO-${year}-${String(n1 + 2).padStart(5, '0')}`)
  })
})

describe('appendToOrderId: add to the open draft (FR-28.17)', () => {
  async function draftWith(w: any) {
    const made = await w.create({ requestId: w.requestId(), items: [w.item(w.bolt, w.alfa, 10)] })
    return made.json.order
  }

  it('appends lines to a draft of the organization: a new group for a new supplier, a new line (never merged) for the same article', async () => {
    const w = await world()
    const draft = await draftWith(w)
    const res = await w.create({
      requestId: w.requestId(), appendToOrderId: draft._id,
      items: [w.item(w.bolt, w.alfa, 4), w.item(w.nut, w.alfa, 6), w.item(w.washer, w.beta, 2)],
    })
    expect(res.status).toBe(200)
    expect(res.json.order._id).toBe(draft._id)
    expect(res.json.order.orderNumber).toBe(draft.orderNumber)
    const alfa = res.json.order.supplierGroups.find((g: any) => g.supplierId === String(w.alfa._id))
    expect(res.json.order.supplierGroups).toHaveLength(2)
    expect(alfa._id).toBe(draft.supplierGroups[0]._id)
    // The article that was already there is there twice: the dialog warns, the server does not merge.
    expect(alfa.lines.map((l: any) => [l.description, l.quantity])).toEqual([['Hex bolt M8x40', 10], ['Hex bolt M8x40', 4], ['Hex nut M8', 6]])
    expect(alfa.lines[0]._id).toBe(draft.supplierGroups[0].lines[0]._id)
    for (const g of res.json.order.supplierGroups) for (const l of g.lines) expect(l.allocations).toHaveLength(1)
    expect(await Order.countDocuments({})).toBe(1)
  })

  it('refuses a draft that is not one, an order of another organization, and one that does not exist', async () => {
    const w = await world()
    const draft = await draftWith(w)
    await Order.updateOne({ _id: draft._id }, { $set: { status: 'sent' } })
    const sent = await w.create({ requestId: w.requestId(), appendToOrderId: draft._id, items: [w.item(w.nut, w.alfa)] })
    expect(sent.status).toBe(422)
    expect(sent.json).toMatchObject({ code: 'order_not_draft', orderStatus: 'sent' })

    const foreign: any = await Order.create({
      orgId: w.other._id, orderNumber: 'DRF-ORDO-F-1', status: 'draft', issueDate: new Date(), currency: 'EUR', exchangeRate: 1, createdBy: w.user._id, supplierGroups: [],
    } as any)
    const theirs = await w.create({ requestId: w.requestId(), appendToOrderId: String(foreign._id), items: [w.item(w.nut, w.alfa)] })
    expect(theirs.status).toBe(404)
    expect(theirs.json.code).toBe('order_not_found')
    expect((await Order.findById(foreign._id).lean() as any).supplierGroups).toHaveLength(0)

    const missing = await w.create({ requestId: w.requestId(), appendToOrderId: 'f'.repeat(24), items: [w.item(w.nut, w.alfa)] })
    expect(missing.status).toBe(404)
    // The sent order is untouched.
    expect(((await Order.findById(draft._id).lean()) as any).supplierGroups[0].lines).toHaveLength(1)
  })

  it('a replayed append adds nothing twice', async () => {
    const w = await world()
    const draft = await draftWith(w)
    const body = { requestId: 'append-once', appendToOrderId: draft._id, items: [w.item(w.nut, w.alfa, 6)] }
    const answers = await Promise.all([w.create(body), w.create(body)])
    const again = await w.create(body)
    expect([...answers, again].map((a) => a.status)).toEqual([200, 200, 200])
    const stored: any = await Order.findById(draft._id).lean()
    expect(stored.supplierGroups[0].lines).toHaveLength(2)
  })

})

describe('the list\'s filter builder is one function', () => {
  it('the list and the preview agree on every supplier and quantity filter, and refuse the same caller', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 10, 0.12]])
    await w.bill(w.beta, [[w.nut, 10, 0.12]])
    const list = await w.call('GET', `/warehouse/product?isActive=true&size=0&supplierId=${w.alfa._id},${w.beta._id}`)
    const prev = await w.preview({ filter: { supplierId: `${w.alfa._id},${w.beta._id}` } })
    expect(new Set(prev.json.rows.map((r: any) => r.productId))).toEqual(new Set((list.json.products as any[]).map((p) => String(p._id))))
    const listRefused = await w.call('GET', `/warehouse/product?supplierId=${w.alfa._id}`, undefined, NO_BILLS)
    const previewRefused = await w.preview({ filter: { supplierId: String(w.alfa._id) } }, NO_BILLS)
    expect([listRefused.status, previewRefused.status]).toEqual([403, 403])
    expect(previewRefused.json).toMatchObject(listRefused.json)
    // Products that nobody asked for are not touched.
    expect(await Product.countDocuments({ orgId: w.org._id })).toBe(5)
  })
})
