import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact, createTestProduct, createTestWarehouse } from '../helpers/factories'
import { orderController } from 'invoicing-api/src/controllers/order.controller'
import { internalOrderController } from 'invoicing-api/src/controllers/internal-order.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { InternalOrder, Order, Product, Contact } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * FR-28.20 — the ids a save of a supplier order (ORDO) or a customer order (ORDI) points at are checked, with the
 * same rule the Products list's create endpoints (FR-28.17, .18) have: the supplier, client, article and warehouse
 * belong to the organization of the route (another organization's id is "not found", as one that does not exist), a
 * supplier is an active supplier or both contact, a client an active customer or both contact.
 *
 * What the cases pin:
 *   - POST: every one of those refusals, with its code, naming where in the order it is (group, line, allocation);
 *     nothing is saved when one fails; a free-text line (no article) and a line with no allocation stay valid;
 *   - PUT: the "active" rule belongs to what the save INTRODUCES. An old order whose article, supplier or client was
 *     deactivated since still saves with those references unchanged (the user is editing its notes, its dates, a
 *     quantity), and the same deactivated article on a NEW line, or put in place of another, is refused. Membership
 *     of the organization is checked for anything that is new or changed as well.
 *
 * Over HTTP through the real controllers. NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(orderController).use(internalOrderController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const NOT_AN_ID = 'not-an-object-id'

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const alfa = await createTestContact(org._id, { type: 'supplier', companyName: 'Alfa Fasteners' } as any)
  const beta = await createTestContact(org._id, { type: 'supplier', companyName: 'Beta Tools' } as any)
  const gamma = await createTestContact(org._id, { type: 'both', companyName: 'Gamma Supply' } as any)
  const client = await createTestContact(org._id, { type: 'customer', companyName: 'Delta Client' } as any)
  const dormantSupplier = await createTestContact(org._id, { type: 'supplier', companyName: 'Dormant Ltd', isActive: false } as any)
  const dormantClient = await createTestContact(org._id, { type: 'customer', companyName: 'Dormant Client', isActive: false } as any)
  const main = await createTestWarehouse(org._id, { name: 'Main', isDefault: true } as any)
  const second = await createTestWarehouse(org._id, { name: 'Second' } as any)
  const bolt = await createTestProduct(org._id, { name: 'Hex bolt M8x40', sku: 'PRD-0001' } as any)
  const nut = await createTestProduct(org._id, { name: 'Hex nut M8', sku: 'PRD-0002' } as any)
  const retired = await createTestProduct(org._id, { name: 'Old washer', sku: 'PRD-0009', isActive: false } as any)

  // ANOTHER organization, with one of everything: none of it may be reachable from the first.
  const other = await createTestOrg()
  const otherSupplier = await createTestContact(other._id, { type: 'supplier', companyName: 'Foreign Supplier' } as any)
  const otherClient = await createTestContact(other._id, { type: 'customer', companyName: 'Foreign Client' } as any)
  const otherWarehouse = await createTestWarehouse(other._id, { name: 'Foreign WH', isDefault: true } as any)
  const otherProduct = await createTestProduct(other._id, { name: 'Foreign bolt', sku: 'FRN-0001' } as any)

  const token = () => (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, email: 'a@t.test', username: 'u', firstName: 'A', lastName: 'B', ownRecordsModules: [],
    role: 'admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin,
  }) as Promise<string>

  async function call(method: string, path: string, body?: any) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await token()}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* not json */ }
    return { status: res.status, json, text }
  }

  const id = (d: any) => String(d._id)
  /** One supplier group with one line per article, each with one allocation of its whole quantity to `warehouse`. */
  const group = (supplier: any, products: any[], warehouse: any = main, extra: Record<string, unknown> = {}) => ({
    supplierId: id(supplier),
    lines: products.map((p) => ({
      description: p.name, quantity: 10, unit: 'pcs',
      ...(p ? { productId: id(p) } : {}),
      allocations: [{ warehouseId: id(warehouse), quantity: 10 }],
    })),
    ...extra,
  })
  const ordoBody = (groups: any[], extra: Record<string, unknown> = {}) => ({ issueDate: '2026-05-10', supplierGroups: groups, ...extra })
  const ordiBody = (lines: any[], extra: Record<string, unknown> = {}) => ({
    contactId: id(client), issueDate: '2026-05-10', requestedDeliveryDate: '2026-06-10',
    lines: lines.map((p) => ({ productId: id(p), description: p.name, quantity: 3 })), ...extra,
  })
  const postOrdo = (body: any) => call('POST', '/invoicing/orders', body)
  const putOrdo = (orderId: string, body: any) => call('PUT', `/invoicing/orders/${orderId}`, body)
  const postOrdi = (body: any) => call('POST', '/invoicing/internal-orders', body)
  const putOrdi = (orderId: string, body: any) => call('PUT', `/invoicing/internal-orders/${orderId}`, body)

  /** The body of a PUT that changes nothing: the saved order's groups (with their ids), as the form sends them back. */
  const sameGroups = (order: any) => order.supplierGroups.map((g: any) => ({
    _id: g._id, supplierId: String(g.supplierId),
    lines: g.lines.map((l: any) => ({
      _id: l._id, ...(l.productId ? { productId: String(l.productId) } : {}), description: l.description, quantity: l.quantity, unit: l.unit,
      allocations: (l.allocations || []).map((a: any) => ({ _id: a._id, warehouseId: String(a.warehouseId), quantity: a.quantity })),
    })),
  }))
  const sameLines = (order: any) => order.lines.map((l: any) => ({ _id: l._id, productId: String(l.productId), description: l.description, quantity: l.quantity }))

  return {
    org, orgId, alfa, beta, gamma, client, dormantSupplier, dormantClient, main, second, bolt, nut, retired,
    otherSupplier, otherClient, otherWarehouse, otherProduct,
    call, id, group, ordoBody, ordiBody, postOrdo, putOrdo, postOrdi, putOrdi, sameGroups, sameLines,
  }
}

describe('FR-28.20 — a supplier order (ORDO): POST', () => {
  it('accepts supplier and both contacts, an own warehouse, a line with no article and a line with no allocation', async () => {
    const w = await world()
    const r = await w.postOrdo(w.ordoBody([
      w.group(w.alfa, [w.bolt]),
      { supplierId: w.id(w.gamma), lines: [
        { description: 'Carriage', quantity: 1, unit: 'pcs' },
        { description: w.nut.name, productId: w.id(w.nut), quantity: 4, unit: 'pcs' },
      ] },
    ]))
    expect(r.status).toBe(200)
    expect(r.json.order.status).toBe('draft')
    expect(r.json.order.supplierGroups).toHaveLength(2)
  })

  it('refuses a supplier of another organization, naming the group, and saves nothing', async () => {
    const w = await world()
    const r = await w.postOrdo(w.ordoBody([w.group(w.alfa, [w.bolt]), w.group(w.otherSupplier, [w.nut])]))
    expect(r.status).toBe(422)
    expect(r.json.code).toBe('supplier_not_found')
    expect(r.json.message).toContain('Group 2')
    expect(await Order.countDocuments({})).toBe(0)
  })

  it('refuses a contact that is not a supplier, and a deactivated supplier', async () => {
    const w = await world()
    const notSupplier = await w.postOrdo(w.ordoBody([w.group(w.client, [w.bolt])]))
    expect(notSupplier.status).toBe(422)
    expect(notSupplier.json.code).toBe('not_a_supplier')
    const dormant = await w.postOrdo(w.ordoBody([w.group(w.dormantSupplier, [w.bolt])]))
    expect(dormant.status).toBe(422)
    expect(dormant.json.code).toBe('supplier_inactive')
    expect(await Order.countDocuments({})).toBe(0)
  })

  it('refuses an article of another organization, a deactivated article, and an id that is not an id, naming the line', async () => {
    const w = await world()
    const foreign = await w.postOrdo(w.ordoBody([w.group(w.alfa, [w.bolt, w.otherProduct])]))
    expect(foreign.status).toBe(422)
    expect(foreign.json.code).toBe('product_not_found')
    expect(foreign.json.message).toContain('Group 1, line 2')
    const retired = await w.postOrdo(w.ordoBody([w.group(w.alfa, [w.retired])]))
    expect(retired.status).toBe(422)
    expect(retired.json.code).toBe('product_inactive')
    const garbage = await w.postOrdo(w.ordoBody([{ supplierId: w.id(w.alfa), lines: [{ productId: NOT_AN_ID, description: 'x', quantity: 1 }] }]))
    expect(garbage.status).toBe(422)
    expect(garbage.json.code).toBe('product_not_found')
    expect(await Order.countDocuments({})).toBe(0)
  })

  it('refuses a warehouse of another organization on an allocation, and one that is not an id', async () => {
    const w = await world()
    const foreign = await w.postOrdo(w.ordoBody([w.group(w.alfa, [w.bolt], w.otherWarehouse)]))
    expect(foreign.status).toBe(422)
    expect(foreign.json.code).toBe('warehouse_not_found')
    expect(foreign.json.message).toContain('allocation 1')
    const garbage = await w.postOrdo(w.ordoBody([{ supplierId: w.id(w.alfa), lines: [
      { description: 'x', quantity: 1, allocations: [{ warehouseId: NOT_AN_ID, quantity: 1 }] },
    ] }]))
    expect(garbage.status).toBe(422)
    expect(garbage.json.code).toBe('warehouse_not_found')
    expect(await Order.countDocuments({})).toBe(0)
  })

  it('checks the ids before the order is saved with staged reservations, too', async () => {
    const w = await world()
    const r = await w.postOrdo(w.ordoBody([w.group(w.alfa, [w.bolt], w.otherWarehouse)], {
      reservationChanges: { create: [{ allocationKey: 'k', contactId: w.id(w.client), quantity: 1 }] },
    }))
    expect(r.status).toBe(422)
    expect(r.json.code).toBe('warehouse_not_found')
    expect(await Order.countDocuments({})).toBe(0)
  })
})

describe('FR-28.20 — a supplier order (ORDO): PUT', () => {
  it('saves an old order whose article and supplier were deactivated since, when the save does not point at anything new', async () => {
    const w = await world()
    const made = await w.postOrdo(w.ordoBody([w.group(w.alfa, [w.bolt, w.nut])]))
    expect(made.status).toBe(200)
    await Product.updateOne({ _id: w.bolt._id }, { $set: { isActive: false } })
    await Contact.updateOne({ _id: w.alfa._id }, { $set: { isActive: false } })

    const r = await w.putOrdo(made.json.order._id, w.ordoBody(w.sameGroups(made.json.order), { notes: 'edited after the article was retired' }))
    expect(r.status).toBe(200)
    expect(r.json.order.notes).toBe('edited after the article was retired')
  })

  it('refuses a deactivated article on a NEW line, and in place of another article on an old one', async () => {
    const w = await world()
    const made = await w.postOrdo(w.ordoBody([w.group(w.alfa, [w.bolt])]))
    const groups = w.sameGroups(made.json.order)

    const added = structuredClone(groups)
    added[0].lines.push({ productId: w.id(w.retired), description: w.retired.name, quantity: 2, unit: 'pcs' })
    const withNew = await w.putOrdo(made.json.order._id, w.ordoBody(added))
    expect(withNew.status).toBe(422)
    expect(withNew.json.code).toBe('product_inactive')
    expect(withNew.json.message).toContain('line 2')

    const swapped = structuredClone(groups)
    swapped[0].lines[0].productId = w.id(w.retired)
    const withSwap = await w.putOrdo(made.json.order._id, w.ordoBody(swapped))
    expect(withSwap.status).toBe(422)
    expect(withSwap.json.code).toBe('product_inactive')

    // Nothing was written by either refusal.
    const stored: any = await Order.findById(made.json.order._id).lean()
    expect(stored.supplierGroups[0].lines).toHaveLength(1)
    expect(String(stored.supplierGroups[0].lines[0].productId)).toBe(w.id(w.bolt))
  })

  it('refuses a deactivated or foreign supplier on a NEW group, and a foreign one put in place of the old', async () => {
    const w = await world()
    const made = await w.postOrdo(w.ordoBody([w.group(w.alfa, [w.bolt])]))
    const groups = w.sameGroups(made.json.order)

    const dormant = [...groups, { supplierId: w.id(w.dormantSupplier), lines: [{ description: 'x', quantity: 1, unit: 'pcs' }] }]
    const a = await w.putOrdo(made.json.order._id, w.ordoBody(dormant))
    expect(a.status).toBe(422)
    expect(a.json.code).toBe('supplier_inactive')
    expect(a.json.message).toContain('Group 2')

    const swapped = structuredClone(groups)
    swapped[0].supplierId = w.id(w.otherSupplier)
    const b = await w.putOrdo(made.json.order._id, w.ordoBody(swapped))
    expect(b.status).toBe(422)
    expect(b.json.code).toBe('supplier_not_found')

    // A new group for a supplier that is fine is accepted, beside the old one.
    const fine = [...groups, w.group(w.beta, [w.nut])]
    const c = await w.putOrdo(made.json.order._id, w.ordoBody(fine))
    expect(c.status).toBe(200)
    expect(c.json.order.supplierGroups).toHaveLength(2)
  })

  it('refuses an allocation to a warehouse of another organization, new or changed, and accepts the old one unchanged', async () => {
    const w = await world()
    const made = await w.postOrdo(w.ordoBody([w.group(w.alfa, [w.bolt])]))
    const groups = w.sameGroups(made.json.order)

    const added = structuredClone(groups)
    added[0].lines[0].quantity = 20
    added[0].lines[0].allocations.push({ warehouseId: w.id(w.otherWarehouse), quantity: 5 })
    const a = await w.putOrdo(made.json.order._id, w.ordoBody(added))
    expect(a.status).toBe(422)
    expect(a.json.code).toBe('warehouse_not_found')

    const moved = structuredClone(groups)
    moved[0].lines[0].allocations[0].warehouseId = w.id(w.otherWarehouse)
    const b = await w.putOrdo(made.json.order._id, w.ordoBody(moved))
    expect(b.status).toBe(422)
    expect(b.json.code).toBe('warehouse_not_found')

    const own = structuredClone(groups)
    own[0].lines[0].allocations.push({ warehouseId: w.id(w.second), quantity: 0 })
    const c = await w.putOrdo(made.json.order._id, w.ordoBody(own))
    expect(c.status).toBe(200)
  })
})

describe('FR-28.20 — a customer order (ORDI): POST', () => {
  it('accepts a customer and a both contact, an own warehouse and active articles', async () => {
    const w = await world()
    const both = await createTestContact(w.org._id, { type: 'both', companyName: 'Both Ltd' } as any)
    const a = await w.postOrdi(w.ordiBody([w.bolt, w.nut], { warehouseId: w.id(w.main) }))
    expect(a.status).toBe(200)
    expect(a.json.internalOrder.status).toBe('draft')
    const b = await w.postOrdi(w.ordiBody([w.bolt], { contactId: w.id(both) }))
    expect(b.status).toBe(200)
  })

  it('refuses a client of another organization, one that is not a customer, and a deactivated one', async () => {
    const w = await world()
    const foreign = await w.postOrdi(w.ordiBody([w.bolt], { contactId: w.id(w.otherClient) }))
    expect(foreign.status).toBe(422)
    expect(foreign.json.code).toBe('client_not_found')
    const supplier = await w.postOrdi(w.ordiBody([w.bolt], { contactId: w.id(w.alfa) }))
    expect(supplier.status).toBe(422)
    expect(supplier.json.code).toBe('not_a_customer')
    const dormant = await w.postOrdi(w.ordiBody([w.bolt], { contactId: w.id(w.dormantClient) }))
    expect(dormant.status).toBe(422)
    expect(dormant.json.code).toBe('client_inactive')
    const garbage = await w.postOrdi(w.ordiBody([w.bolt], { contactId: NOT_AN_ID }))
    expect(garbage.status).toBe(422)
    expect(garbage.json.code).toBe('client_not_found')
    expect(await InternalOrder.countDocuments({})).toBe(0)
  })

  it('refuses an article of another organization, a deactivated one, and a warehouse of another organization, naming the line', async () => {
    const w = await world()
    const foreign = await w.postOrdi(w.ordiBody([w.bolt, w.otherProduct]))
    expect(foreign.status).toBe(422)
    expect(foreign.json.code).toBe('product_not_found')
    expect(foreign.json.message).toContain('Line 2')
    const retired = await w.postOrdi(w.ordiBody([w.retired]))
    expect(retired.status).toBe(422)
    expect(retired.json.code).toBe('product_inactive')
    const warehouse = await w.postOrdi(w.ordiBody([w.bolt], { warehouseId: w.id(w.otherWarehouse) }))
    expect(warehouse.status).toBe(422)
    expect(warehouse.json.code).toBe('warehouse_not_found')
    expect(await InternalOrder.countDocuments({})).toBe(0)
  })
})

describe('FR-28.20 — a customer order (ORDI): PUT', () => {
  it('saves an old order whose article and client were deactivated since, when the save points at nothing new', async () => {
    const w = await world()
    const made = await w.postOrdi(w.ordiBody([w.bolt, w.nut], { warehouseId: w.id(w.main) }))
    expect(made.status).toBe(200)
    await Product.updateOne({ _id: w.bolt._id }, { $set: { isActive: false } })
    await Contact.updateOne({ _id: w.client._id }, { $set: { isActive: false } })

    const lines = w.sameLines(made.json.internalOrder)
    lines[1].quantity = 5
    const r = await w.putOrdi(made.json.internalOrder._id, {
      contactId: w.id(w.client), issueDate: '2026-05-10', requestedDeliveryDate: '2026-06-12', warehouseId: w.id(w.main), lines, notes: 'moved a week',
    })
    expect(r.status).toBe(200)
    expect(r.json.internalOrder.notes).toBe('moved a week')
  })

  it('refuses a deactivated article on a NEW line or in place of another, and a client or warehouse of another organization', async () => {
    const w = await world()
    const made = await w.postOrdi(w.ordiBody([w.bolt], { warehouseId: w.id(w.main) }))
    const id = made.json.internalOrder._id
    const base = (lines: any[], extra: Record<string, unknown> = {}) => ({
      contactId: w.id(w.client), issueDate: '2026-05-10', requestedDeliveryDate: '2026-06-10', warehouseId: w.id(w.main), lines, ...extra,
    })
    const lines = w.sameLines(made.json.internalOrder)

    const added = await w.putOrdi(id, base([...lines, { productId: w.id(w.retired), description: w.retired.name, quantity: 1 }]))
    expect(added.status).toBe(422)
    expect(added.json.code).toBe('product_inactive')
    expect(added.json.message).toContain('Line 2')

    const swapped = await w.putOrdi(id, base([{ ...lines[0], productId: w.id(w.retired) }]))
    expect(swapped.status).toBe(422)
    expect(swapped.json.code).toBe('product_inactive')

    const client = await w.putOrdi(id, base(lines, { contactId: w.id(w.otherClient) }))
    expect(client.status).toBe(422)
    expect(client.json.code).toBe('client_not_found')

    const dormant = await w.putOrdi(id, base(lines, { contactId: w.id(w.dormantClient) }))
    expect(dormant.status).toBe(422)
    expect(dormant.json.code).toBe('client_inactive')

    const warehouse = await w.putOrdi(id, base(lines, { warehouseId: w.id(w.otherWarehouse) }))
    expect(warehouse.status).toBe(422)
    expect(warehouse.json.code).toBe('warehouse_not_found')

    const stored: any = await InternalOrder.findById(id).lean()
    expect(stored.lines).toHaveLength(1)
    expect(String(stored.contactId)).toBe(w.id(w.client))
  })
})
