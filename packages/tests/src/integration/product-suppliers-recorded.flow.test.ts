import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { captureRejection, expectRejection } from '../helpers/capture-rejection'
import {
  createTestOrg, createTestUser, createTestContact, createTestInvoice, createTestProduct, createTestStockMovement,
} from '../helpers/factories'
import { productController } from 'warehouse-api/src/controllers/product.controller'
import { productSupplierController, productSupplierRecordController } from 'warehouse-api/src/controllers/product-supplier.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { AuditLog, Contact, InternalOrder, Order, ProductSupplier } from 'db/models'
import { mongoose } from 'db/connection'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { accessRefusal } from 'services/biz/access/evaluate'
import { getInternalOrderSuggestions } from 'services/biz/reservation-ops.service'
import { previewOrderFromProducts } from 'services/biz/orders-from-products.service'
import {
  findProductIdsBySuppliers, findProductIdsWithoutSupplier, getDefaultSuppliers, getSupplierFacts,
} from 'services/biz/product-suppliers.service'
import { recordSupplier, listRecordedSuppliers } from 'services/biz/recorded-suppliers.service'

/**
 * FR-28.9 — recorded suppliers: what a person writes about an article and one of its suppliers.
 *
 * What the cases pin (spec §2.2, §3.1, §6):
 *   - one row per article and supplier, replaced as a whole, and never written by a document;
 *   - `preferred` is unique per article, moved by setting another, and held by the database too;
 *   - PUT and DELETE need `products.edit`; the product and the supplier must belong to the route's organization,
 *     and the supplier must be an active supplier (or both);
 *   - a supplier with documents stays listed with its facts when the record is cleared;
 *   - the Supplier filter and "No supplier" count a recorded link;
 *   - the recorded preference is the first rule of the default supplier, and the customer-order hint follows it;
 *   - the recorded rows are served only to a caller who may read bills, with the facts beside them.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = new Elysia()
    .onError(spaErrorHandler({}) as any)
    .use(productController)
    .use(productSupplierController)
    .use(productSupplierRecordController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const { Types } = mongoose
const day = (iso: string) => new Date(`${iso}T10:00:00Z`)

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const alfa = await createTestContact(org._id, { type: 'supplier', companyName: 'Alfa Fasteners' } as any)
  const beta = await createTestContact(org._id, { type: 'supplier', companyName: 'Beta Tools' } as any)
  const gamma = await createTestContact(org._id, { type: 'both', companyName: 'Gamma Supply' } as any)
  const client = await createTestContact(org._id, { type: 'customer', companyName: 'Delta Client' } as any)
  const bolt = await createTestProduct(org._id, { name: 'Hex bolt M8x40', sku: 'PRD-0001' } as any)
  const nut = await createTestProduct(org._id, { name: 'Hex nut M8', sku: 'PRD-0002' } as any)
  const washer = await createTestProduct(org._id, { name: 'Washer M8', sku: 'PRD-0003' } as any)

  const claims = (over: object) => ({
    id: String(user._id), orgId, email: 'a@t.test', username: 'u', firstName: 'A', lastName: 'B', ownRecordsModules: [],
    role: 'admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ...over,
  })
  const token = (over: object = {}) => (signer as any).decorator.jwt.sign(claims(over)) as Promise<string>

  async function http(method: string, path: string, tok: string, body?: unknown, org = orgId) {
    const res = await app.handle(new Request(`http://localhost/org/${org}/warehouse${path}`, {
      method,
      headers: { authorization: `Bearer ${tok}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }))
    const text = await res.text()
    let json: any = null
    try { json = JSON.parse(text) } catch { /* not json */ }
    return { status: res.status, json, text }
  }
  const put = async (product: any, supplier: any, body: object = {}, tok?: string) =>
    http('PUT', `/product/${product._id}/suppliers/${supplier._id}`, tok ?? await token(), body)
  const del = async (product: any, supplier: any, tok?: string) =>
    http('DELETE', `/product/${product._id}/suppliers/${supplier._id}`, tok ?? await token())
  const tab = async (product: any, tok?: string) => http('GET', `/product-supplier/${product._id}`, tok ?? await token())

  let n = 0
  function bill(supplier: any, lines: Array<[any, number, number]>, over: Record<string, unknown> = {}) {
    return createTestInvoice(org._id, supplier._id, {
      invoiceNumber: `BILL-2026-${String(++n).padStart(5, '0')}`,
      type: 'invoice', direction: 'incoming', status: 'received', currency: 'EUR', issueDate: day('2026-05-10'),
      lines: lines.map(([p, quantity, unitPrice]) => ({
        productId: p._id, description: p.name, quantity, unit: 'pcs', unitPrice, discount: 0, taxRate: 20, taxAmount: 0, lineTotal: quantity * unitPrice,
      })),
      ...over,
    } as any)
  }
  const preferredOf = async (product: any) => (await ProductSupplier.find({ orgId: org._id, productId: product._id, preferred: true }).lean()).map((r: any) => String(r.supplierId))

  return { org, orgId, user, alfa, beta, gamma, client, bolt, nut, washer, token, http, put, del, tab, bill, preferredOf }
}

describe('recording a supplier for an article', () => {
  it('stores preferred, the supplier code, the lead time and a note, and the tab reads them back with the supplier name', async () => {
    const w = await world()
    const r = await w.put(w.bolt, w.alfa, { preferred: true, supplierSku: 'AF-8.8-M8X40', leadTimeDays: 7, note: 'Ships on Tuesdays' })
    expect(r.status).toBe(200)
    expect(r.json.supplier).toMatchObject({
      supplierId: String(w.alfa._id), supplierName: 'Alfa Fasteners', supplierActive: true,
      preferred: true, supplierSku: 'AF-8.8-M8X40', leadTimeDays: 7, note: 'Ships on Tuesdays',
    })

    const row: any = await ProductSupplier.findOne({ orgId: w.org._id, productId: w.bolt._id, supplierId: w.alfa._id }).lean()
    expect(row).toMatchObject({ preferred: true, supplierSku: 'AF-8.8-M8X40', supplierSkuLower: 'af-8.8-m8x40', leadTimeDays: 7, note: 'Ships on Tuesdays' })

    const tab = await w.tab(w.bolt)
    expect(tab.status).toBe(200)
    expect(tab.json.recorded).toHaveLength(1)
    expect(tab.json.recorded[0]).toMatchObject({ supplierName: 'Alfa Fasteners', preferred: true, supplierSku: 'AF-8.8-M8X40', leadTimeDays: 7 })
    // The facts are a different key: nothing was bought from this supplier, so nothing is listed there.
    expect(tab.json.suppliers).toEqual([])
  })

  it('is one row per article and supplier: a second PUT replaces the row as a whole, and what it leaves out is cleared', async () => {
    const w = await world()
    await w.put(w.bolt, w.alfa, { preferred: true, supplierSku: 'AF-1', leadTimeDays: 3, note: 'first' })
    const second = await w.put(w.bolt, w.alfa, { supplierSku: 'AF-2' })
    expect(second.status).toBe(200)
    expect(await ProductSupplier.countDocuments({ orgId: w.org._id, productId: w.bolt._id, supplierId: w.alfa._id })).toBe(1)
    const row: any = await ProductSupplier.findOne({ orgId: w.org._id, productId: w.bolt._id, supplierId: w.alfa._id }).lean()
    expect(row.supplierSku).toBe('AF-2')
    expect(row.supplierSkuLower).toBe('af-2')
    expect(row.preferred).toBe(false)
    expect(row.leadTimeDays).toBeUndefined()
    expect(row.note).toBeUndefined()
    // An emptied code clears the mirror with it.
    await w.put(w.bolt, w.alfa, { supplierSku: '   ' })
    const cleared: any = await ProductSupplier.findOne({ orgId: w.org._id, productId: w.bolt._id }).lean()
    expect(cleared.supplierSku).toBeUndefined()
    expect(cleared.supplierSkuLower).toBeUndefined()
  })

  it('is held by the database too: the same article and supplier twice is refused by the unique index', async () => {
    const w = await world()
    await ProductSupplier.create({ orgId: w.org._id, productId: w.bolt._id, supplierId: w.alfa._id })
    const err = await captureRejection(ProductSupplier.create({ orgId: w.org._id, productId: w.bolt._id, supplierId: w.alfa._id }))
    expectRejection(err, /E11000/)
    // Another article, another supplier, another organization: all fine.
    await ProductSupplier.create({ orgId: w.org._id, productId: w.nut._id, supplierId: w.alfa._id })
    await ProductSupplier.create({ orgId: w.org._id, productId: w.bolt._id, supplierId: w.beta._id })
  })

  it('is never written by a document: a received bill, a receipt and a supplier order leave the recorded rows as they are', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 10, 0.12]])
    await createTestStockMovement(w.org._id, {
      movementNumber: 'SM-2026-90001', type: 'receipt', status: 'completed', date: day('2026-05-12'), contactId: w.beta._id,
      lines: [{ productId: w.bolt._id, quantity: 5, unitCost: 0.1, totalCost: 0.5 }],
    } as any)
    expect(await ProductSupplier.countDocuments({ orgId: w.org._id })).toBe(0)
    // And what is recorded does not show up as a purchase.
    await w.put(w.bolt, w.gamma, { preferred: true })
    const facts = (await getSupplierFacts(w.orgId, [String(w.bolt._id)]))[String(w.bolt._id)]
    expect(facts.map((f) => f.supplierName).sort()).toEqual(['Alfa Fasteners', 'Beta Tools'])
  })

  it('refuses text and numbers it cannot keep: a code or a note too long, a lead time that is not a whole number of days', async () => {
    const w = await world()
    const long = await w.put(w.bolt, w.alfa, { supplierSku: 'x'.repeat(101) })
    expect(long.status).toBe(422)
    expect(long.json.code).toBe('too_long')
    expect((await w.put(w.bolt, w.alfa, { note: 'x'.repeat(501) })).json.code).toBe('too_long')
    for (const bad of [-1, 1.5, 3651]) {
      const r = await w.put(w.bolt, w.alfa, { leadTimeDays: bad })
      expect(r.status).toBe(422)
      expect(r.json.code).toBe('invalid_lead_time')
    }
    expect(await ProductSupplier.countDocuments({ orgId: w.org._id })).toBe(0)
  })
})

describe('the preferred supplier is unique per article (FR-28.9)', () => {
  it('setting another supplier preferred clears the previous one', async () => {
    const w = await world()
    await w.put(w.bolt, w.alfa, { preferred: true })
    expect(await w.preferredOf(w.bolt)).toEqual([String(w.alfa._id)])
    await w.put(w.bolt, w.beta, { preferred: true })
    expect(await w.preferredOf(w.bolt)).toEqual([String(w.beta._id)])
    // The displaced supplier is still recorded, only no longer preferred.
    const recorded = (await listRecordedSuppliers(w.orgId, String(w.bolt._id))).map((r) => [r.supplierName, r.preferred])
    expect(recorded).toEqual([['Beta Tools', true], ['Alfa Fasteners', false]])
    // Another article is its own business.
    await w.put(w.nut, w.alfa, { preferred: true })
    expect(await w.preferredOf(w.nut)).toEqual([String(w.alfa._id)])
    expect(await w.preferredOf(w.bolt)).toEqual([String(w.beta._id)])
  })

  it('clearing the flag leaves none, and setting the same supplier again changes nothing', async () => {
    const w = await world()
    await w.put(w.bolt, w.alfa, { preferred: true })
    await w.put(w.bolt, w.alfa, { preferred: true })
    expect(await w.preferredOf(w.bolt)).toEqual([String(w.alfa._id)])
    await w.put(w.bolt, w.alfa, { preferred: false })
    expect(await w.preferredOf(w.bolt)).toEqual([])
  })

  it('is held by the database: a second preferred row for the article is refused, a preferred row for another article is not', async () => {
    const w = await world()
    await ProductSupplier.create({ orgId: w.org._id, productId: w.bolt._id, supplierId: w.alfa._id, preferred: true })
    const err = await captureRejection(ProductSupplier.create({ orgId: w.org._id, productId: w.bolt._id, supplierId: w.beta._id, preferred: true }))
    expectRejection(err, /E11000/)
    await ProductSupplier.create({ orgId: w.org._id, productId: w.bolt._id, supplierId: w.beta._id, preferred: false })
    await ProductSupplier.create({ orgId: w.org._id, productId: w.nut._id, supplierId: w.beta._id, preferred: true })
  })

  it('callers racing to prefer different suppliers leave exactly one, and none of them fails', async () => {
    const w = await world()
    const suppliers = [w.alfa, w.beta, w.gamma]
    for (let round = 0; round < 3; round++) {
      const results = await Promise.all(suppliers.map((s) => captureRejection(recordSupplier(w.orgId, String(w.bolt._id), String(s._id), { preferred: true }))))
      expect(results).toEqual([null, null, null])
      expect(await w.preferredOf(w.bolt)).toHaveLength(1)
    }
    expect(await ProductSupplier.countDocuments({ orgId: w.org._id, productId: w.bolt._id })).toBe(3)
  })

  it('callers racing to record the same new row end with one row', async () => {
    const w = await world()
    const results = await Promise.all([1, 2, 3, 4].map((i) => captureRejection(recordSupplier(w.orgId, String(w.bolt._id), String(w.alfa._id), { supplierSku: `AF-${i}` }))))
    expect(results).toEqual([null, null, null, null])
    expect(await ProductSupplier.countDocuments({ orgId: w.org._id, productId: w.bolt._id, supplierId: w.alfa._id })).toBe(1)
  })
})

describe('who may record, and what may be recorded (FR-28.9)', () => {
  it('refuses a supplier that is not one: a customer, a deactivated supplier, another organization\'s contact, an id that is no contact', async () => {
    const w = await world()
    const other = await world()
    const gone = await createTestContact(w.org._id, { type: 'supplier', companyName: 'Gone Ltd', isActive: false } as any)

    const customer = await w.put(w.bolt, w.client)
    expect(customer.status).toBe(422)
    expect(customer.json.code).toBe('not_a_supplier')
    expect((await w.put(w.bolt, gone)).json.code).toBe('supplier_inactive')
    // The answer for another organization's contact is the answer for a contact that does not exist.
    const foreign = await w.put(w.bolt, other.alfa)
    expect(foreign.status).toBe(422)
    expect(foreign.json.code).toBe('supplier_not_found')
    expect((await w.http('PUT', `/product/${w.bolt._id}/suppliers/${new Types.ObjectId()}`, await w.token(), {})).json.code).toBe('supplier_not_found')
    expect((await w.http('PUT', `/product/${w.bolt._id}/suppliers/not-an-id`, await w.token(), {})).json.code).toBe('supplier_not_found')

    expect(await ProductSupplier.countDocuments({})).toBe(0)
    // A supplier and a "both" contact are fine.
    expect((await w.put(w.bolt, w.alfa)).status).toBe(200)
    expect((await w.put(w.bolt, w.gamma)).status).toBe(200)
  })

  it('refuses an article that is not this organization\'s, whoever asks, and writes nothing', async () => {
    const w = await world()
    const other = await world()
    const foreign = await w.http('PUT', `/product/${other.bolt._id}/suppliers/${w.alfa._id}`, await w.token(), { preferred: true })
    expect(foreign.status).toBe(404)
    expect(foreign.json.code).toBe('product_not_found')
    expect((await w.http('DELETE', `/product/${other.bolt._id}/suppliers/${w.alfa._id}`, await w.token())).status).toBe(404)
    expect((await w.http('PUT', `/product/${new Types.ObjectId()}/suppliers/${w.alfa._id}`, await w.token(), {})).status).toBe(404)
    expect(await ProductSupplier.countDocuments({})).toBe(0)
  })

  it('refuses a token of another organization (the tenant guard), on both verbs', async () => {
    const w = await world()
    const other = await world()
    const theirs = await other.token()
    expect((await w.http('PUT', `/product/${w.bolt._id}/suppliers/${w.alfa._id}`, theirs, { preferred: true })).status).toBe(403)
    expect((await w.http('DELETE', `/product/${w.bolt._id}/suppliers/${w.alfa._id}`, theirs)).status).toBe(403)
    expect(await ProductSupplier.countDocuments({})).toBe(0)
  })

  it('needs products.edit: the roles that hold inventory.write may; a Seller, a Sales role, a member, an accountant and an auditor may not', async () => {
    const w = await world()
    const as = (role: string) => w.token({ role, permissions: DEFAULT_ROLE_PERMISSIONS[role as keyof typeof DEFAULT_ROLE_PERMISSIONS], ...(role === 'seller' ? { areas: [] } : {}) })

    for (const role of ['admin', 'manager', 'warehouse_manager']) {
      expect((await w.put(w.bolt, w.alfa, {}, await as(role))).status, role).toBe(200)
      expect((await w.del(w.bolt, w.alfa, await as(role))).status, role).toBe(200)
    }
    for (const role of ['seller', 'sales', 'member', 'accountant', 'nra_auditor']) {
      const put = await w.put(w.bolt, w.alfa, { preferred: true }, await as(role))
      expect(put.status, `${role} PUT`).toBe(403)
      expect((await w.del(w.bolt, w.alfa, await as(role))).status, `${role} DELETE`).toBe(403)
    }
    expect(await ProductSupplier.countDocuments({})).toBe(0)
  })

  it('needs products.edit itself, not any product write: a role that may only create articles is refused (the evaluator on a role\'s grant)', () => {
    const route = '/api/org/:orgId/warehouse/product/:id/suppliers/:supplierId'
    const session = (caps: string[]) => ({ role: 'custom', permissions: [], access: { caps: new Set(caps) } }) as any
    for (const method of ['PUT', 'DELETE']) {
      expect(accessRefusal(session(['products.create', 'products.delete']), method, route)?.capabilities).toEqual(['products.edit'])
      expect(accessRefusal(session(['products.view']), method, route)).not.toBeNull()
      expect(accessRefusal(session(['products.edit']), method, route)).toBeNull()
    }
    // The article's own edit is still any of the three (the prefix rule), so the new rule is the narrower one.
    expect(accessRefusal(session(['products.create']), 'PUT', '/api/org/:orgId/warehouse/product/:id')).toBeNull()
  })

  it('writes an audit entry for what was recorded and for what was cleared', async () => {
    const w = await world()
    await w.put(w.bolt, w.alfa, { preferred: true, supplierSku: 'AF-1' })
    await w.del(w.bolt, w.alfa)
    // `createAuditEntry` is fire-and-forget.
    for (let i = 0; i < 20 && (await AuditLog.countDocuments({ orgId: w.org._id, entityType: 'product' })) < 2; i++) await new Promise((r) => setTimeout(r, 50))
    const entries: any[] = await AuditLog.find({ orgId: w.org._id, entityType: 'product' }).sort({ createdAt: 1 }).lean()
    expect(entries.map((e) => e.action).sort()).toEqual(['create', 'update'])
    const created = entries.find((e) => e.action === 'create')
    expect(created.changes[0].newValue).toMatchObject({ supplier: 'Alfa Fasteners', preferred: true, supplierSku: 'AF-1' })
    const cleared = entries.find((e) => e.action === 'update')
    expect(cleared.changes[0].newValue ?? null).toBeNull()
    expect(cleared.changes[0].oldValue).toMatchObject({ supplier: 'Alfa Fasteners' })
  })
})

describe('clearing what is recorded', () => {
  it('removes the row, and a second clear is not an error', async () => {
    const w = await world()
    await w.put(w.bolt, w.alfa, { preferred: true })
    const first = await w.del(w.bolt, w.alfa)
    expect(first.json).toEqual({ deleted: true })
    expect(await ProductSupplier.countDocuments({})).toBe(0)
    expect((await w.del(w.bolt, w.alfa)).json).toEqual({ deleted: false })
    expect((await w.http('DELETE', `/product/${w.bolt._id}/suppliers/not-an-id`, await w.token())).json).toEqual({ deleted: false })
  })

  it('cannot remove a supplier the documents name: its facts return, only the recorded fields go', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 10, 0.12]])
    await w.put(w.bolt, w.alfa, { preferred: true, supplierSku: 'AF-1', leadTimeDays: 5 })
    await w.put(w.bolt, w.beta, { note: 'recorded only' })

    let tab = (await w.tab(w.bolt)).json
    expect(tab.suppliers.map((s: any) => s.supplierName)).toEqual(['Alfa Fasteners'])
    expect(tab.recorded.map((s: any) => s.supplierName)).toEqual(['Alfa Fasteners', 'Beta Tools'])

    await w.del(w.bolt, w.alfa)
    await w.del(w.bolt, w.beta)
    tab = (await w.tab(w.bolt)).json
    // The recorded supplier with no document is gone; the one the bill names is still a supplier of the article.
    expect(tab.recorded).toEqual([])
    expect(tab.suppliers).toHaveLength(1)
    expect(tab.suppliers[0]).toMatchObject({ supplierName: 'Alfa Fasteners', quantity: 10, documents: 1 })
  })

  it('flags a recorded supplier that has stopped being one, and keeps the row so it can be cleared', async () => {
    const w = await world()
    await w.put(w.bolt, w.alfa, { preferred: true })
    await w.put(w.bolt, w.beta, {})
    const { Contact } = await import('db/models')
    await Contact.updateOne({ _id: w.alfa._id }, { $set: { isActive: false } })
    await Contact.updateOne({ _id: w.beta._id }, { $set: { type: 'customer' } })
    const recorded = (await w.tab(w.bolt)).json.recorded
    expect(recorded.map((r: any) => [r.supplierName, r.supplierActive])).toEqual([['Alfa Fasteners', false], ['Beta Tools', false]])
    expect((await w.del(w.bolt, w.alfa)).json.deleted).toBe(true)
  })
})

describe('who sees the recorded suppliers, next to the facts (slice 2\'s rule)', () => {
  const INVENTORY_ONLY = { role: 'member', permissions: ['inventory.read'] }
  const SELLER = { role: 'seller', permissions: ['invoicing.read', 'invoicing.write', 'inventory.read'], areas: [] as string[] }

  it('the tab is for a caller who reads bills; anyone else is refused with nothing of it in the body', async () => {
    const w = await world()
    await w.put(w.bolt, w.alfa, { preferred: true, supplierSku: 'AF-SECRET-1', note: 'private note' })
    const ok = await w.tab(w.bolt)
    expect(ok.status).toBe(200)
    expect(ok.json.recorded[0].supplierSku).toBe('AF-SECRET-1')
    for (const who of [INVENTORY_ONLY, SELLER]) {
      const refused = await w.tab(w.bolt, await w.token(who))
      expect(refused.status).toBe(403)
      expect(refused.text).not.toContain('Alfa')
      expect(refused.text).not.toContain('AF-SECRET-1')
      expect(refused.text).not.toContain('private note')
      expect(refused.text).not.toContain('recorded')
    }
  })

  it('the tab stays what slice 2 made it when nothing is recorded: the same keys, plus an empty `recorded`', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 10, 0.12]])
    const tab = (await w.tab(w.bolt)).json
    expect(Object.keys(tab).sort()).toEqual(['documents', 'recorded', 'suppliers'])
    expect(tab.recorded).toEqual([])
    expect(tab.suppliers).toHaveLength(1)
  })
})

describe('a recorded link counts in the Supplier filter and in "No supplier" (§2.3)', () => {
  it('finds the article a person recorded the supplier for, beside the ones the documents name', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 1, 1]])
    await w.put(w.nut, w.alfa, {})
    await w.put(w.washer, w.beta, {})
    const sorted = async (ids: string[]) => (await findProductIdsBySuppliers(w.orgId, ids)).sort()
    expect(await sorted([String(w.alfa._id)])).toEqual([String(w.bolt._id), String(w.nut._id)].sort())
    expect(await sorted([String(w.beta._id)])).toEqual([String(w.washer._id)])
    expect(await sorted([String(w.gamma._id)])).toEqual([])
  })

  it('"No supplier" lists the articles with neither a document nor a recorded supplier', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 1, 1]])
    await w.put(w.nut, w.beta, {})
    expect(await findProductIdsWithoutSupplier(w.orgId)).toEqual([String(w.washer._id)])
    await w.del(w.nut, w.beta)
    expect((await findProductIdsWithoutSupplier(w.orgId)).sort()).toEqual([String(w.nut._id), String(w.washer._id)].sort())
  })

  it('answers the list route the same way, and still refuses the filter to a caller who reads no bills', async () => {
    const w = await world()
    await w.put(w.nut, w.alfa, {})
    const filtered = await w.http('GET', `/product?supplierId=${w.alfa._id}`, await w.token())
    expect(filtered.status).toBe(200)
    expect(filtered.json.products.map((p: any) => p.name)).toEqual(['Hex nut M8'])
    const none = await w.http('GET', '/product?noSupplier=true', await w.token())
    expect(none.json.products.map((p: any) => p.name).sort()).toEqual(['Hex bolt M8x40', 'Washer M8'])
    const refused = await w.http('GET', `/product?supplierId=${w.alfa._id}`, await w.token({ role: 'member', permissions: ['inventory.read'] }))
    expect(refused.status).toBe(403)
  })
})

describe('the default supplier of an article (FR-28.11): the recorded preference comes first', () => {
  const orderOf = (w: Awaited<ReturnType<typeof world>>, supplier: any, prod: any, n = 1) => Order.create({
    orgId: w.org._id, orderNumber: `ORDO-2026-0000${n}`, status: 'draft', statusHistory: [{ status: 'draft', changedAt: new Date() }],
    issueDate: new Date(), currency: 'EUR', exchangeRate: 1, createdBy: w.user._id,
    supplierGroups: [{ supplierId: supplier._id, lines: [{ productId: prod._id, description: 'x', quantity: 1, unit: 'pcs', allocations: [] }] }],
  } as any)
  const defaultOf = async (w: Awaited<ReturnType<typeof world>>, prod: any) => (await getDefaultSuppliers(w.orgId, [String(prod._id)])).get(String(prod._id))

  it('is the preferred supplier, then the supplier of the last purchase, then the newest supplier order, then none', async () => {
    const w = await world()
    // None: nobody bought it, nobody ordered it, nobody recorded it.
    expect(await defaultOf(w, w.bolt)).toBeUndefined()
    // The newest supplier order.
    await orderOf(w, w.gamma, w.bolt)
    expect(await defaultOf(w, w.bolt)).toMatchObject({ supplierId: String(w.gamma._id), basis: 'order' })
    // The last purchase beats the order.
    await w.bill(w.beta, [[w.bolt, 1, 1]])
    expect(await defaultOf(w, w.bolt)).toEqual({ supplierId: String(w.beta._id), basis: 'purchase' })
    // A recorded supplier that is not preferred changes nothing.
    await w.put(w.bolt, w.alfa, {})
    expect(await defaultOf(w, w.bolt)).toEqual({ supplierId: String(w.beta._id), basis: 'purchase' })
    // The preferred one beats the purchase.
    await w.put(w.bolt, w.alfa, { preferred: true })
    expect(await defaultOf(w, w.bolt)).toEqual({ supplierId: String(w.alfa._id), basis: 'recorded' })
    // Moving the preference moves the default.
    await w.put(w.bolt, w.gamma, { preferred: true })
    expect(await defaultOf(w, w.bolt)).toEqual({ supplierId: String(w.gamma._id), basis: 'recorded' })
    // Clearing it goes back to the purchase.
    await w.put(w.bolt, w.gamma, { preferred: false })
    expect(await defaultOf(w, w.bolt)).toEqual({ supplierId: String(w.beta._id), basis: 'purchase' })
  })

  it('answers every article asked about in one go, each by its own rule', async () => {
    const w = await world()
    await w.put(w.bolt, w.alfa, { preferred: true })
    await w.bill(w.beta, [[w.nut, 1, 1]])
    const answers = await getDefaultSuppliers(w.orgId, [String(w.bolt._id), String(w.nut._id), String(w.washer._id)])
    expect(answers.get(String(w.bolt._id))?.basis).toBe('recorded')
    expect(answers.get(String(w.nut._id))?.basis).toBe('purchase')
    expect(answers.has(String(w.washer._id))).toBe(false)
  })

  it('skips a preference for a supplier that is no longer one: it goes stale, the rule reads on', async () => {
    const w = await world()
    const { Contact } = await import('db/models')
    await w.bill(w.beta, [[w.bolt, 1, 1]])
    await w.put(w.bolt, w.alfa, { preferred: true })
    await Contact.updateOne({ _id: w.alfa._id }, { $set: { isActive: false } })
    expect(await defaultOf(w, w.bolt)).toEqual({ supplierId: String(w.beta._id), basis: 'purchase' })
    await Contact.updateOne({ _id: w.alfa._id }, { $set: { isActive: true, type: 'customer' } })
    expect(await defaultOf(w, w.bolt)).toEqual({ supplierId: String(w.beta._id), basis: 'purchase' })
    await Contact.updateOne({ _id: w.alfa._id }, { $set: { type: 'both' } })
    expect((await defaultOf(w, w.bolt))?.basis).toBe('recorded')
  })

  it('is the customer-order form\'s supplier hint: the recorded preference, named as such', async () => {
    const w = await world()
    await w.bill(w.beta, [[w.bolt, 10, 0.12]])
    await w.put(w.bolt, w.alfa, { preferred: true })
    const ordi: any = await InternalOrder.create({
      orgId: w.org._id, orderNumber: 'ORDI-2026-00001', status: 'confirmed', statusHistory: [{ status: 'confirmed', changedAt: new Date() }],
      contactId: w.client._id, issueDate: new Date(), requestedDeliveryDate: new Date(Date.now() + 7 * 864e5), priority: 'normal',
      currency: 'EUR', exchangeRate: 1, lines: [{ productId: w.bolt._id, description: 'line', quantity: 5, unit: 'pcs' }], createdBy: w.user._id,
    } as any)
    const [line] = await getInternalOrderSuggestions(w.orgId, String(ordi._id))
    expect(line.supplierHint).toEqual({ supplierId: String(w.alfa._id), source: 'recorded' })
  })
})

describe('the order preview offers a recorded supplier, and agrees with the customer-order hint (FR-28.11)', () => {
  const rowOf = async (w: Awaited<ReturnType<typeof world>>, product: any, kind: 'supplier' | 'customer' = 'supplier') => {
    const caller = { id: String(w.user._id), orgId: w.orgId, role: 'admin', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [] } as any
    const res = await previewOrderFromProducts(w.orgId, caller, { productIds: [String(product._id)], kind })
    return res.rows[0]
  }
  const hintOf = async (w: Awaited<ReturnType<typeof world>>, product: any) => {
    const ordi: any = await InternalOrder.create({
      orgId: w.org._id, orderNumber: `ORDI-2026-${String(Math.floor(Math.random() * 99999)).padStart(5, '0')}`, status: 'confirmed',
      statusHistory: [{ status: 'confirmed', changedAt: new Date() }], contactId: w.client._id, issueDate: new Date(),
      requestedDeliveryDate: new Date(Date.now() + 7 * 864e5), priority: 'normal', currency: 'EUR', exchangeRate: 1,
      lines: [{ productId: product._id, description: 'line', quantity: 5, unit: 'pcs' }], createdBy: w.user._id,
    } as any)
    return (await getInternalOrderSuggestions(w.orgId, String(ordi._id)))[0].supplierHint
  }

  it('a preferred supplier no document names is the default and heads the choices; the dialog and the hint name the same one', async () => {
    const w = await world()
    await w.put(w.bolt, w.alfa, { preferred: true })
    const row = await rowOf(w, w.bolt)
    expect(row.supplierId).toBe(String(w.alfa._id))
    expect(row.suppliers.map((s: any) => s.name)).toEqual(['Alfa Fasteners'])
    expect((await hintOf(w, w.bolt))?.supplierId).toBe(row.supplierId)
  })

  it('a recorded supplier that is not preferred is offered too, after the ones the documents name, and changes no default', async () => {
    const w = await world()
    await w.bill(w.beta, [[w.bolt, 10, 0.12]])
    await w.put(w.bolt, w.gamma, { supplierSku: 'GS-1' })
    const row = await rowOf(w, w.bolt)
    expect(row.suppliers.map((s: any) => s.name)).toEqual(['Beta Tools', 'Gamma Supply'])
    expect(row.supplierId).toBe(String(w.beta._id))
    expect((await hintOf(w, w.bolt))).toMatchObject({ supplierId: String(w.beta._id), source: 'purchase' })
  })

  it('a preference for a supplier the documents also name moves it to the head, and the default is that supplier', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 10, 0.1]], { issueDate: day('2026-04-01') })
    await w.bill(w.beta, [[w.bolt, 10, 0.12]], { issueDate: day('2026-05-01') })
    expect((await rowOf(w, w.bolt)).suppliers.map((s: any) => s.name)).toEqual(['Beta Tools', 'Alfa Fasteners'])
    await w.put(w.bolt, w.alfa, { preferred: true })
    const row = await rowOf(w, w.bolt)
    expect(row.suppliers.map((s: any) => s.name)).toEqual(['Alfa Fasteners', 'Beta Tools'])
    expect(row.supplierId).toBe(String(w.alfa._id))
    expect((await hintOf(w, w.bolt))).toMatchObject({ supplierId: String(w.alfa._id), source: 'recorded' })
  })

  it('offers only what an order may be placed with: a recorded supplier since deactivated or retyped is not a choice', async () => {
    const w = await world()
    await w.put(w.bolt, w.alfa, { preferred: true })
    await w.put(w.bolt, w.gamma, {})
    await Contact.updateOne({ _id: w.alfa._id }, { $set: { isActive: false } })
    await Contact.updateOne({ _id: w.gamma._id }, { $set: { type: 'customer' } })
    const row = await rowOf(w, w.bolt)
    expect(row.suppliers).toEqual([])
    expect(row.supplierId).toBeUndefined()
    expect(await hintOf(w, w.bolt)).toBeUndefined()
  })

  it('a customer order lists no supplier at all, recorded or not', async () => {
    const w = await world()
    await w.put(w.bolt, w.alfa, { preferred: true })
    const row = await rowOf(w, w.bolt, 'customer')
    expect(row.suppliers).toBeUndefined()
    expect(row.supplierId).toBeUndefined()
  })
})

describe('the Products list\'s Suppliers column names a recorded supplier too (FR-28.9)', () => {
  const byProducts = async (w: Awaited<ReturnType<typeof world>>, products: any[], tok?: string) =>
    w.http('GET', `/product-supplier/by-products?productIds=${products.map((p) => p._id).join(',')}`, tok ?? await w.token())

  it('an article found by the Supplier filter only through a recorded link is not a dash: the supplier is listed, with no purchase', async () => {
    const w = await world()
    await w.put(w.bolt, w.alfa, { preferred: true, supplierSku: 'AF-1' })
    const res = await byProducts(w, [w.bolt, w.nut])
    expect(res.status).toBe(200)
    expect(res.json.suppliers[String(w.bolt._id)]).toEqual([{ supplierId: String(w.alfa._id), supplierName: 'Alfa Fasteners', quantity: 0, documents: 0 }])
    expect(res.json.counts[String(w.bolt._id)]).toBe(1)
    // An article with neither is still answered, with nobody: that is the dash (an absent key would read "not loaded yet").
    expect(res.json.suppliers[String(w.nut._id)]).toEqual([])
    expect(res.json.counts[String(w.nut._id)]).toBe(0)
  })

  it('the documents\' suppliers come first, most recent first; a supplier both name is listed once, with its facts', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 10, 0.1]], { issueDate: day('2026-04-01') })
    await w.bill(w.beta, [[w.bolt, 10, 0.12]], { issueDate: day('2026-05-01') })
    await w.put(w.bolt, w.alfa, { preferred: true })
    await w.put(w.bolt, w.gamma, {})
    const list = (await byProducts(w, [w.bolt])).json.suppliers[String(w.bolt._id)]
    expect(list.map((s: any) => s.supplierName)).toEqual(['Beta Tools', 'Alfa Fasteners', 'Gamma Supply'])
    expect(list[0].documents).toBe(1)
    expect(list[1].documents).toBe(1)
    expect(list[2]).toEqual({ supplierId: String(w.gamma._id), supplierName: 'Gamma Supply', quantity: 0, documents: 0 })
  })

  it('counts every supplier, but lists five at most', async () => {
    const w = await world()
    for (let i = 0; i < 7; i++) {
      const s = await createTestContact(w.org._id, { type: 'supplier', companyName: `Recorded Supplier ${i}` } as any)
      await w.put(w.bolt, s, {})
    }
    const res = await byProducts(w, [w.bolt])
    expect(res.json.suppliers[String(w.bolt._id)]).toHaveLength(5)
    expect(res.json.counts[String(w.bolt._id)]).toBe(7)
  })

  it('is still nothing at all for a caller who reads no bills', async () => {
    const w = await world()
    await w.put(w.bolt, w.alfa, { preferred: true })
    const res = await byProducts(w, [w.bolt], await w.token({ role: 'member', permissions: ['inventory.read'] }))
    expect(res.json).toEqual({})
    expect(res.text).not.toContain('Alfa')
  })
})

describe('searching by the supplier\'s code (FR-28.10)', () => {
  const find = async (w: Awaited<ReturnType<typeof world>>, search: string, tok?: string) => {
    const res = await w.http('GET', `/product?search=${encodeURIComponent(search)}`, tok ?? await w.token())
    expect(res.status).toBe(200)
    return (res.json.products as any[]).map((p) => p.sku).sort()
  }

  it('finds the article by a code a person recorded, in any case', async () => {
    const w = await world()
    await w.put(w.bolt, w.alfa, { supplierSku: 'AF-8.8-M8X40' })
    expect(await find(w, 'AF-8.8-M8X40')).toEqual(['PRD-0001'])
    expect(await find(w, 'af-8.8-m8x40')).toEqual(['PRD-0001'])
    // A part of the code is a term like any other.
    expect(await find(w, 'm8x40')).toEqual(['PRD-0001'])
    expect(await find(w, 'AF-9.9')).toEqual([])
  })

  it('is an AND of the keywords: each may match the article\'s own fields or the code', async () => {
    const w = await world()
    await w.put(w.bolt, w.alfa, { supplierSku: 'AF-12' })
    await w.put(w.nut, w.alfa, { supplierSku: 'AF-13' })
    // "hex" is in both names; the code tells them apart.
    expect(await find(w, 'hex AF-12')).toEqual(['PRD-0001'])
    expect(await find(w, 'hex AF-13')).toEqual(['PRD-0002'])
    expect(await find(w, 'hex AF')).toEqual(['PRD-0001', 'PRD-0002'])
    // The name of a bolt and the code of a nut are two different articles: nothing is both.
    expect(await find(w, 'bolt AF-13')).toEqual([])
  })

  it('finds a Cyrillic code, in either case, and a look-alike Latin letter counts as the Cyrillic one', async () => {
    const w = await world()
    await w.put(w.bolt, w.alfa, { supplierSku: 'КВ-77' })
    expect(await find(w, 'КВ-77')).toEqual(['PRD-0001'])
    expect(await find(w, 'кв-77')).toEqual(['PRD-0001'])
    // A Latin K and B in place of the Cyrillic К and В, which look the same.
    expect(await find(w, 'KB-77')).toEqual(['PRD-0001'])
    // A letter that only resembles another in some fonts is no match: Б is not B.
    expect(await find(w, 'КБ-77')).toEqual([])
  })

  it('does not search a supplier\'s NAME: the Supplier filter does that', async () => {
    const w = await world()
    await w.put(w.bolt, w.alfa, { supplierSku: 'AF-1' })
    expect(await find(w, 'Alfa')).toEqual([])
    expect(await find(w, 'Fasteners')).toEqual([])
  })

  it('is for a caller who may read bills: anyone else gets the article search and nothing of the code, and is not refused', async () => {
    const w = await world()
    await w.put(w.bolt, w.alfa, { supplierSku: 'AF-8.8-M8X40' })
    const reader = await w.token({ role: 'member', permissions: ['inventory.read'] })
    expect(await find(w, 'AF-8.8-M8X40', reader)).toEqual([])
    expect(await find(w, 'Hex bolt', reader)).toEqual(['PRD-0001'])
  })

  it('stays inside the organization: another organization\'s recorded code is no hit', async () => {
    const w = await world()
    const other = await createTestOrg()
    const otherSupplier = await createTestContact(other._id, { type: 'supplier', companyName: 'Elsewhere Supply' } as any)
    const otherProduct = await createTestProduct(other._id, { name: 'Other bolt', sku: 'OTH-1' } as any)
    await ProductSupplier.create({ orgId: other._id, productId: otherProduct._id, supplierId: otherSupplier._id, preferred: false, supplierSku: 'SHARED-CODE', supplierSkuLower: 'shared-code' } as any)
    expect(await find(w, 'SHARED-CODE')).toEqual([])
  })

  it('narrows with the other filters, as any search does', async () => {
    const w = await world()
    await w.bill(w.alfa, [[w.bolt, 10, 0.1]])
    await w.put(w.bolt, w.alfa, { supplierSku: 'AF-1' })
    await w.put(w.nut, w.beta, { supplierSku: 'AF-2' })
    const res = await w.http('GET', `/product?search=AF&supplierId=${w.alfa._id}`, await w.token())
    expect((res.json.products as any[]).map((p) => p.sku)).toEqual(['PRD-0001'])
  })
})
