import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import ExcelJS from 'exceljs'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg, createTestStockMovement, createTestUser, createTestWarehouse } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { PRICE_TIERS } from 'config/constants'
import { compileLegacy } from 'config/access'
import { InventoryCount, Invoice, Order, Org, Product, Role, StockLevel, StockMovement, User } from 'db/models'
import { tokenize } from 'services/biz/auth.service'
import { forgetAccessModel } from 'services/biz/access/shadow'
import { forgetMember, forgetRole } from 'services/biz/access/live'
import { canSeeSupplierPrices } from 'services/biz/product-suppliers.service'
import { orgRouteRest } from 'services/biz/route-permission'
import { mongoose } from 'db/connection'

/**
 * FR-27.11.C (#529, owner 2026-11-10) — the server decides: hiding a column hides nothing. A Seller of regal-pz's list
 * (FR-27.11.B: the selling price, Цена 1, Цена 2 and the other prices; no cost figure) reads products, saves one and
 * asks for prices through the API, with the Administrator as the control.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: Elysia
let orgId: string
let productId: string
let contactId: string
const tokens: Record<string, string> = {}
const TIERS = PRICE_TIERS.map((t, i) => ({ name: t.name, percent: 10 * i, finalPrice: 10 + i }))

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/api/org/${orgId}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}
const sign = async (id: unknown) => (signer as any).decorator.jwt.sign(await tokenize((await User.findById(id).exec())!))
const tierNames = (p: any) => (p?.priceTiers ?? []).map((t: any) => t.name)

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  const org: any = await createTestOrg({ slug: 'access-price-levels' } as any)
  orgId = String(org._id)
  const admin = await createTestUser(org._id, { role: 'admin', username: 'admin', email: 'admin@price-levels.test' } as any)
  const seller = await createTestUser(org._id, { role: 'member', username: 'seller', email: 'seller@price-levels.test' } as any)
  const product = await Product.create({
    orgId: org._id, sku: 'B-1', name: 'Bolt', category: 'Общи', type: 'goods', unit: 'pcs', purchasePrice: 9, standardCost: 9.1, sellingPrice: 20,
    priceTiers: TIERS,
  } as any)
  productId = String(product._id)
  // A customer on Цена 3 (the tier-name tag convention): a level the Seller does not see.
  await Product.updateOne({ _id: product._id }, { $set: { 'priceTiers.5.tags': ['Цена 3'] } }).exec()
  contactId = String((await createTestContact(org._id, { tags: ['Цена 3'] } as any))._id)
  await Org.updateOne({ _id: org._id }, { $set: { 'settings.access.model': 'roles' } }).exec()
  forgetAccessModel(orgId)
  const role: any = await Role.create({
    // Its projection, as a role made through the API carries: what still reads claims (the history's scope) reads it.
    orgId: org._id, name: 'Seller (regal-pz)', isBuiltin: false, edited: true, version: 1, legacy: { role: 'member', permissions: ['inventory.read'] },
    caps: ['products.view', 'products.edit', 'pricing.read', 'contacts.view', 'products.price:selling', 'products.price:1', 'products.price:2', 'products.price:other'],
  } as any)
  await User.updateOne({ _id: seller._id }, { $set: { roleId: role._id } }).exec()
  forgetMember(seller._id)
  forgetRole(role._id)
  tokens.admin = await sign(admin._id)
  tokens.seller = await sign(seller._id)
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('C.1 the product routes send no hidden level', () => {
  it('by id and in the list: Цена 1 and Цена 2, the selling price; no cost figure, no margin', async () => {
    const one = await call('GET', `/warehouse/product/${productId}`, tokens.seller)
    expect(one.status).toBe(200)
    expect(tierNames(one.json.product)).toEqual(['Цена 1', 'Цена 2'])
    expect(one.json.product.sellingPrice).toBe(20)
    expect('purchasePrice' in one.json.product || 'standardCost' in one.json.product).toBe(false)
    expect(one.json.product.priceTiers.some((t: any) => 'percent' in t)).toBe(false)
    const list = await call('GET', '/warehouse/product?size=10', tokens.seller)
    const row = (list.json.products ?? list.json.items).find((p: any) => p._id === productId)
    expect(tierNames(row)).toEqual(['Цена 1', 'Цена 2'])
    expect(JSON.stringify(list.json)).not.toContain('Цена 3')
  })

  it('the Administrator reads the article as it is', async () => {
    const one = await call('GET', `/warehouse/product/${productId}`, tokens.admin)
    expect(tierNames(one.json.product)).toEqual(PRICE_TIERS.map(t => t.name))
    expect(one.json.product.purchasePrice).toBe(9)
  })
})

describe('C.4 a save changes no figure the role cannot see', () => {
  it('the form it loaded, sent back with a purchase price of 0: every hidden figure is byte-identical', async () => {
    const before: any = await Product.findById(productId).lean().exec()
    const loaded = (await call('GET', `/warehouse/product/${productId}`, tokens.seller)).json.product
    const sent = { ...loaded, name: 'Bolt (edited)', purchasePrice: 0, priceTiers: loaded.priceTiers.map((t: any) => (t.name === 'Цена 1' ? { ...t, finalPrice: 11.5 } : t)) }
    const put = await call('PUT', `/warehouse/product/${productId}`, tokens.seller, sent)
    expect(put.status).toBe(200)
    const after: any = await Product.findById(productId).lean().exec()
    expect(after.name).toBe('Bolt (edited)')
    expect(after.purchasePrice).toBe(before.purchasePrice)
    expect(after.standardCost).toBe(before.standardCost)
    const strip = (t: any) => ({ name: t.name, percent: t.percent, finalPrice: t.finalPrice, tags: t.tags ?? [] })
    expect(after.priceTiers.map((t: any) => t.name)).toEqual(before.priceTiers.map((t: any) => t.name))
    for (const [i, t] of after.priceTiers.entries()) {
      if (t.name === 'Цена 1') expect(strip(t)).toEqual({ ...strip(before.priceTiers[i]), finalPrice: 11.5 })
      else expect(strip(t)).toEqual(strip(before.priceTiers[i]))
    }
  })
})

describe('C.6 resolution is not visibility', () => {
  it('the Select-price menu offers no hidden level, and the customer\'s own price as "Customer price"', async () => {
    const mine = await call('GET', `/pricing/options?productId=${productId}&contactId=${contactId}&all=true`, tokens.seller)
    expect(mine.status).toBe(200)
    const names = mine.json.options.map((o: any) => o.name)
    expect(names).not.toContain('Цена 3')
    expect(names).not.toContain('Доставна цена')
    expect(names.filter((n: string) => /^Цена \d/.test(n))).toEqual(['Цена 1', 'Цена 2'])
    const admins = await call('GET', `/pricing/options?productId=${productId}&contactId=${contactId}&all=true`, tokens.admin)
    expect(admins.json.options.map((o: any) => o.name)).toContain('Цена 3')
  })

  it("the customer on Цена 3 pays Цена 3 whoever issues the document, and the Seller is not told the level's name", async () => {
    const mine = await call('GET', `/pricing/resolve?productId=${productId}&contactId=${contactId}`, tokens.seller)
    const admins = await call('GET', `/pricing/resolve?productId=${productId}&contactId=${contactId}`, tokens.admin)
    expect(admins.json.steps.at(-1).label).toBe('Цена 3')
    expect(mine.json.finalPrice).toBe(admins.json.finalPrice)
    expect(mine.json.steps.at(-1)).toMatchObject({ type: 'customer', label: 'Customer price', price: admins.json.finalPrice })
    expect(JSON.stringify(mine.json)).not.toContain('Цена 3')
  })
})

describe('C.1 the supplier prices are cost figures', () => {
  it('who we bought from needs bills; what we paid needs the costs as well', () => {
    const user = (caps: string[]) => ({ id: 'u', orgId, role: 'member', permissions: [], access: { caps: new Set(caps) } }) as any
    expect(canSeeSupplierPrices(user(['bills.view']))).toBe(false)
    expect(canSeeSupplierPrices(user(['bills.view', 'products.costs']))).toBe(true)
    expect(canSeeSupplierPrices(user(['products.costs']))).toBe(false)
  })
})

describe('C.3 a sort on a hidden figure is refused, on every route', () => {
  // However it is spelled: a tier column, a cost by name or path, a path into the tiers.
  const HIDDEN = ['purchasePrice', 'tier_3', 'tier_delivery', 'priceTiers.0.finalPrice', 'lines.unitCost', 'avgCost']

  it('the Products list and the till catalog answer 403 naming the level; the Administrator sorts as before', async () => {
    const list = await call('GET', '/warehouse/product?sortBy=tier_3', tokens.seller)
    expect(list.status).toBe(403)
    expect(list.json).toMatchObject({ code: 'capability_required', capabilities: ['products.price:3'] })
    expect((await call('GET', '/warehouse/product?sortBy=purchasePrice', tokens.seller)).json.capabilities).toEqual(['products.costs'])
    expect((await call('GET', '/trade/pos/catalog?sortBy=purchasePrice', tokens.seller)).status).toBe(403)
    // What it sees, it sorts by.
    expect((await call('GET', '/warehouse/product?sortBy=tier_1', tokens.seller)).status).toBe(200)
    expect((await call('GET', '/warehouse/product?sortBy=purchasePrice', tokens.admin)).status).toBe(200)
  })

  it('no GET route of the org answers a hidden sort key with data', async () => {
    const routes = ((createApiApp() as any).routes as Array<{ method: string; path: string }>)
      .filter(r => r.method === 'GET' && orgRouteRest(r.path) !== null)
    expect(routes.length).toBeGreaterThan(100)
    const leaks: string[] = []
    for (const r of routes) {
      const path = r.path.replace('/api/org/:orgId', '').replace(/:[A-Za-z]+/g, () => String(new mongoose.Types.ObjectId()))
      for (const key of HIDDEN) {
        const res = await call('GET', `${path}${path.includes('?') ? '&' : '?'}sortBy=${encodeURIComponent(key)}`, tokens.seller)
        if (res.status < 300) leaks.push(`${r.path} sortBy=${key} → ${res.status}`)
      }
    }
    expect(leaks).toEqual([])
  }, 120_000)
})

describe('C.4 a count is priced by the server', () => {
  it('a role that counts without the costs books its adjustment at the stored average cost, whatever the body says', async () => {
    const org: any = await Org.findById(orgId).lean().exec()
    const wh = await createTestWarehouse(org._id, { name: 'Count WH', code: 'CW' } as any)
    await StockLevel.create({ orgId: org._id, productId, warehouseId: wh._id, quantity: 10, availableQuantity: 10, avgCost: 2 } as any)
    const counter: any = await Role.create({
      orgId: org._id, name: 'Counter (no costs)', isBuiltin: false, edited: true, version: 1, legacy: { role: 'member', permissions: [] },
      caps: ['inventory-counts.view', 'inventory-counts.create', 'inventory-counts.edit', 'warehouses.lookup', 'products.lookup', 'stock-levels.lookup'],
    } as any)
    const person = await createTestUser(org._id, { role: 'member', username: 'counter', email: 'counter@price-levels.test' } as any)
    await User.updateOne({ _id: person._id }, { $set: { roleId: counter._id } }).exec()
    forgetMember(person._id)
    forgetRole(counter._id)
    const token = await sign(person._id)

    const line = { productId, systemQuantity: 10, countedQuantity: 13, variance: 3, varianceCost: 0 }
    const made = await call('POST', '/warehouse/inventory-count', token, { warehouseId: String(wh._id), date: new Date().toISOString(), type: 'full', status: 'in_progress', lines: [line] })
    expect(made.status).toBe(200)
    expect('varianceCost' in made.json.inventoryCount.lines[0]).toBe(false)
    const id = made.json.inventoryCount._id ?? made.json.inventoryCount.id
    expect((await InventoryCount.findById(id).lean().exec() as any).lines[0].varianceCost).toBe(6)

    // A later save that sends another figure is priced again.
    await call('PUT', `/warehouse/inventory-count/${id}`, token, { lines: [{ ...line, varianceCost: 999 }] })
    expect((await InventoryCount.findById(id).lean().exec() as any).lines[0].varianceCost).toBe(6)

    const done = await call('POST', `/warehouse/inventory-count/${id}/complete`, token)
    expect(done.status).toBe(200)
    const adj: any = await StockMovement.findOne({ inventoryCountId: id }).lean().exec()
    expect(adj.lines[0]).toMatchObject({ quantity: 3, unitCost: 2, totalCost: 6 })
  })
})

describe('C.5 history, C.2 derived figures', () => {
  it("a product's history names no change of a figure the role does not see; the Administrator's names every one", async () => {
    // The earlier save wrote an entry: the name, Цена 1, and (refused) nothing else.
    await Product.updateOne({ _id: productId }, { $set: { purchasePrice: 9.5 } }).exec()
    const { createAuditEntry } = await import('services/biz/audit-log.service')
    await createAuditEntry({ orgId, userId: String(new mongoose.Types.ObjectId()), action: 'update', module: 'warehouse', entityType: 'product', entityId: productId, entityName: 'Bolt', changes: [
      { field: 'purchasePrice', oldValue: 9, newValue: 9.5 },
      { field: 'priceTiers', oldValue: [], newValue: [] },
      { field: 'name', oldValue: 'Bolt', newValue: 'Bolt (edited)' },
    ] } as any)
    await new Promise(r => setTimeout(r, 200))
    const q = `/audit-logs?entityType=product&entityId=${productId}`
    const mine = await call('GET', q, tokens.seller)
    const theirs = await call('GET', q, tokens.admin)
    const fields = (r: any) => (r.json.auditLogs ?? []).flatMap((e: any) => e.changes.map((c: any) => c.field))
    expect(theirs.status).toBe(200)
    expect(fields(theirs)).toEqual(expect.arrayContaining(['purchasePrice', 'priceTiers', 'name']))
    expect(mine.status).toBe(200)
    expect(fields(mine)).toContain('name')
    expect(fields(mine)).not.toContain('purchasePrice')
    expect(fields(mine)).not.toContain('priceTiers')
  })

  it("the dashboard's stock value is absent without the costs", async () => {
    const mine = await call('GET', '/dashboard/summary', tokens.seller)
    if (mine.status === 200) expect('totalValue' in (mine.json.stock ?? {})).toBe(false)
    const theirs = await call('GET', '/dashboard/summary', tokens.admin)
    expect(theirs.status).toBe(200)
    expect(typeof theirs.json.stock.totalValue).toBe('number')
  })
})

describe('C.1 / C.2 what else carries a cost', () => {
  let reader: string
  beforeAll(async () => {
    const org: any = await Org.findById(orgId).lean().exec()
    // What `invoicing.read` + `inventory.read` give, and the Reports app, less the cost figures.
    const permissions = ['invoicing.read', 'inventory.read', 'reports.read']
    const caps = [...(compileLegacy({ role: 'member', permissions }) as any).caps].filter((c: string) => c !== 'products.costs')
    const role: any = await Role.create({ orgId: org._id, name: 'Reader (no costs)', isBuiltin: false, edited: true, version: 1, legacy: { role: 'member', permissions }, caps } as any)
    const person = await createTestUser(org._id, { role: 'member', username: 'reader', email: 'reader@price-levels.test' } as any)
    await User.updateOne({ _id: person._id }, { $set: { roleId: role._id } }).exec()
    forgetMember(person._id)
    forgetRole(role._id)
    reader = await sign(person._id)
    await createTestInvoice(org._id, contactId as any, { invoiceNumber: 'INV-PL-1', status: 'sent', lines: [{ productId, description: 'Bolt', quantity: 2, unit: 'pcs', unitPrice: 20, taxRate: 20, taxAmount: 8, lineTotal: 40 }] } as any)
  })

  it("a movement's lines, by id: no unit or total cost", async () => {
    const org: any = await Org.findById(orgId).lean().exec()
    const m: any = await createTestStockMovement(org._id, { type: 'receipt', lines: [{ productId, quantity: 3, unitCost: 9, totalCost: 27 }] } as any)
    const mine = await call('GET', `/warehouse/movement/${m._id}`, reader)
    expect(mine.status).toBe(200)
    expect(mine.json.stockMovement.lines[0].quantity).toBe(3)
    expect('unitCost' in mine.json.stockMovement.lines[0] || 'totalCost' in mine.json.stockMovement.lines[0]).toBe(false)
    expect((await call('GET', `/warehouse/movement/${m._id}`, tokens.admin)).json.stockMovement.lines[0].unitCost).toBe(9)
  })

  it("a movement's own total is those costs summed: absent by id and in the list, which is not ordered by it", async () => {
    const org: any = await Org.findById(orgId).lean().exec()
    // Two receipts of one line each, so each total IS its line's cost. Dated apart from every other movement here.
    const dear: any = await createTestStockMovement(org._id, { type: 'receipt', movementNumber: 'SM-PL-DEAR', date: new Date('2026-01-02'), totalAmount: 500, lines: [{ productId, quantity: 1, unitCost: 500, totalCost: 500 }] } as any)
    await createTestStockMovement(org._id, { type: 'receipt', movementNumber: 'SM-PL-CHEAP', date: new Date('2026-01-03'), totalAmount: 5, lines: [{ productId, quantity: 1, unitCost: 5, totalCost: 5 }] } as any)
    const totals = ['totalAmount', 'total']

    const mine = (await call('GET', `/warehouse/movement/${dear._id}`, reader)).json.stockMovement
    expect(mine.movementNumber).toBe('SM-PL-DEAR')
    expect(totals.filter(k => k in mine)).toEqual([])
    expect((await call('GET', `/warehouse/movement/${dear._id}`, tokens.admin)).json.stockMovement.totalAmount).toBe(500)

    const listed = async (token: string, sort = '') =>
      (await call('GET', `/warehouse/movement?dateFrom=2026-01-01&dateTo=2026-01-04&size=50${sort}`, token)).json.stockMovements as any[]
    const numbers = (rows: any[]) => rows.map(r => r.number)
    const rows = await listed(reader)
    expect(numbers(rows)).toEqual(['SM-PL-CHEAP', 'SM-PL-DEAR']) // newest first, as the list comes unasked
    expect(rows.flatMap(r => totals.filter(k => k in r))).toEqual([])
    expect((await listed(tokens.admin)).map(r => r.total)).toEqual([5, 500])

    // Ordered by the total, the Administrator's list is. The reader's comes as it does unasked: an order by a figure
    // it is not sent would say which receipt cost more.
    expect(numbers(await listed(tokens.admin, '&sortBy=total&sortOrder=desc'))).toEqual(['SM-PL-DEAR', 'SM-PL-CHEAP'])
    for (const key of ['total', 'totalAmount']) {
      expect(numbers(await listed(reader, `&sortBy=${key}&sortOrder=desc`))).toEqual(['SM-PL-CHEAP', 'SM-PL-DEAR'])
      expect(numbers(await listed(reader, `&sortBy=${key}&sortOrder=asc`))).toEqual(['SM-PL-CHEAP', 'SM-PL-DEAR'])
    }
  })

  it("the product ledger: no unit cost, line value, running value or current value", async () => {
    const mine = await call('GET', `/warehouse/product-ledger/${productId}`, reader)
    expect(mine.status).toBe(200)
    expect('currentValue' in mine.json.summary).toBe(false)
    for (const e of mine.json.entries) expect(['unitCost', 'lineTotalCost', 'runningValue'].some(k => k in e)).toBe(false)
  })

  it("the contact ledger: no purchase price on a row, no profitability", async () => {
    const mine = await call('GET', `/invoicing/contact-ledger/${contactId}`, reader)
    expect(mine.status).toBe(200)
    expect('profitabilityNet' in mine.json.summary || 'profitabilityGross' in mine.json.summary).toBe(false)
    for (const e of mine.json.entries) expect('purchasePrice' in e).toBe(false)
    const theirs = await call('GET', `/invoicing/contact-ledger/${contactId}`, tokens.admin)
    expect(typeof theirs.json.summary.profitabilityNet).toBe('number')
  })

  it("the contact ledger: a stock movement's own row carries no unit cost and no value; the report that reads it, the same", async () => {
    const org: any = await Org.findById(orgId).lean().exec()
    const wh: any = await createTestWarehouse(org._id)
    await createTestStockMovement(org._id, {
      movementNumber: 'SM-PL-OUT', type: 'transfer', status: 'completed', fromWarehouseId: wh._id, contactId,
      lines: [{ productId, quantity: 4, unitCost: 9, totalCost: 36 }],
    } as any)
    const movement = (r: any) => (r.json.entries ?? r.json.rows).find((e: any) => e.documentType === 'stock_movement')

    const mine = await call('GET', `/invoicing/contact-ledger/${contactId}`, reader)
    expect(mine.status).toBe(200)
    expect(movement(mine).movements.map((m: any) => m.number)).toEqual(['SM-PL-OUT'])
    expect(movement(mine).quantity).toBe(4)
    expect(['unitPrice', 'lineTotal'].filter(k => k in movement(mine))).toEqual([])
    // A document's row keeps its price: what the customer was charged is no cost figure.
    expect(mine.json.entries.find((e: any) => e.documentNumber === 'INV-PL-1').unitPrice).toBe(20)
    const theirs = await call('GET', `/invoicing/contact-ledger/${contactId}`, tokens.admin)
    expect([movement(theirs).unitPrice, movement(theirs).lineTotal]).toEqual([9, 36])

    const report = await call('POST', '/reports/contact-ledger/run', reader, { params: { contactId } })
    expect(report.status).toBe(200)
    expect(movement(report).movementNumbers).toBe('SM-PL-OUT')
    expect(['unitPrice', 'lineTotal'].filter(k => k in movement(report))).toEqual([])
    expect(movement(report)._href).toBe(`/inventory/movements/${movement(report).documentId}`)
    const admins = await call('POST', '/reports/contact-ledger/run', tokens.admin, { params: { contactId } })
    expect([movement(admins).unitPrice, movement(admins).lineTotal]).toEqual([9, 36])
  })

  it('the reports that read the two ledgers carry what the ledgers carry: no profitability, no unit, line, running or current value', async () => {
    const org: any = await Org.findById(orgId).lean().exec()
    const wh: any = await createTestWarehouse(org._id)
    // An article of its own: the count above booked an adjustment of the bolt.
    const nut: any = await Product.create({ orgId: org._id, sku: 'N-1', name: 'Nut', category: 'Общи', type: 'goods', unit: 'pcs', purchasePrice: 9, sellingPrice: 20 } as any)
    await createTestStockMovement(org._id, { type: 'receipt', status: 'completed', toWarehouseId: wh._id, lines: [{ productId: nut._id, quantity: 3, unitCost: 9, totalCost: 27 }] } as any)

    const contact = await call('POST', '/reports/contact-ledger/run', reader, { params: { contactId } })
    expect(contact.status).toBe(200)
    expect(contact.json.rows.length).toBeGreaterThan(0)
    expect(typeof contact.json.meta.ledgerSummary.totalSalesNet).toBe('number')
    expect('profitabilityNet' in contact.json.meta.ledgerSummary || 'profitabilityGross' in contact.json.meta.ledgerSummary).toBe(false)

    const article = await call('POST', '/reports/product-ledger/run', reader, { params: { productId: String(nut._id) } })
    expect(article.status).toBe(200)
    expect(article.json.rows).toHaveLength(1)
    expect(article.json.meta.ledgerSummary.totalIn).toBe(3)
    expect('currentValue' in article.json.meta.ledgerSummary).toBe(false)
    for (const r of article.json.rows) expect(['unitCost', 'lineTotalCost', 'runningValue'].filter(k => k in r)).toEqual([])
    expect(article.json.columns.map((c: any) => c.key)).not.toContain('unitCost')

    // The Administrator's carry them.
    const theirs = await call('POST', '/reports/product-ledger/run', tokens.admin, { params: { productId: String(nut._id) } })
    expect(theirs.json.meta.ledgerSummary.currentValue).toBe(27)
    expect(theirs.json.rows.map((r: any) => [r.unitCost, r.lineTotalCost, r.runningValue])).toEqual([[9, 27, 27]])
    expect(typeof (await call('POST', '/reports/contact-ledger/run', tokens.admin, { params: { contactId } })).json.meta.ledgerSummary.profitabilityNet).toBe('number')
  })

  it("an outgoing order's sheet (XLSX), like its JSON: no expected purchase price; the Administrator's has it", async () => {
    const org: any = await Org.findById(orgId).lean().exec()
    const wh: any = await createTestWarehouse(org._id)
    const supplier: any = await createTestContact(org._id, { type: 'supplier', companyName: 'Supplier PL' } as any)
    const order: any = await Order.create({
      orgId: org._id, orderNumber: 'ORDO-PL-1', status: 'sent', issueDate: new Date(), currency: 'EUR', exchangeRate: 1, createdBy: org.ownerId ?? undefined,
      supplierGroups: [{ supplierId: supplier._id, lines: [{ productId, description: 'Bolt', quantity: 10, unit: 'pcs', expectedUnitPrice: 7.77, allocations: [{ warehouseId: wh._id, quantity: 10 }] }] }],
    } as any)
    const groupId = String(order.supplierGroups[0]._id)
    const sheet = async (token: string, variant: string) => {
      const res = await app.handle(new Request(`http://localhost/api/org/${orgId}/invoicing/orders/${order._id}/export?groupId=${groupId}&variant=${variant}&format=xlsx`, {
        headers: { authorization: `Bearer ${token}` },
      }))
      expect(res.status).toBe(200)
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load(await res.arrayBuffer())
      const cells: unknown[] = []
      wb.eachSheet(ws => ws.eachRow(row => row.eachCell(cell => { cells.push(cell.value) })))
      return cells
    }
    for (const variant of ['internal', 'supplier']) {
      const mine = await sheet(reader, variant)
      expect(mine.some(v => String(v).includes('Bolt'))).toBe(true)
      expect(mine.some(v => Number(v) === 7.77)).toBe(false)
    }
    expect((await sheet(tokens.admin, 'internal')).some(v => Number(v) === 7.77)).toBe(true)
    // And the JSON, as before.
    const json = await call('GET', `/invoicing/orders/${order._id}`, reader)
    expect(json.status).toBe(200)
    expect('expectedUnitPrice' in json.json.order.supplierGroups[0].lines[0]).toBe(false)
  })
})

describe("C.6 a document's stored price trail", () => {
  it('names no level the reader does not see; a hidden winning level reads "Customer price", and the line price stays', async () => {
    const org: any = await Org.findById(orgId).lean().exec()
    const caps = [...(compileLegacy({ role: 'member', permissions: ['invoicing.read'] }) as any).caps].filter((c: string) => c !== 'products.price:3')
    const role: any = await Role.create({ orgId: org._id, name: 'Invoices without Цена 3', isBuiltin: false, edited: true, version: 1, legacy: { role: 'member', permissions: ['invoicing.read'] }, caps } as any)
    const person = await createTestUser(org._id, { role: 'member', username: 'no-tier-3', email: 'no-tier-3@price-levels.test' } as any)
    await User.updateOne({ _id: person._id }, { $set: { roleId: role._id } }).exec()
    forgetMember(person._id)
    forgetRole(role._id)
    const token = await sign(person._id)
    const trail = [{ type: 'base', label: 'Selling price', price: 20 }, { type: 'tier', label: 'Цена 3', price: 15 }]
    const inv: any = await createTestInvoice(org._id, contactId as any, {
      invoiceNumber: 'INV-PL-TRAIL', status: 'sent',
      lines: [{ productId, description: 'Bolt', quantity: 1, unit: 'pcs', unitPrice: 15, taxRate: 20, taxAmount: 3, lineTotal: 15, priceExplanation: trail }],
    } as any)

    const mine = await call('GET', `/invoices/${inv._id}`, token)
    expect(mine.status).toBe(200)
    const line = mine.json.invoice.lines[0]
    expect(line.unitPrice).toBe(15)
    expect(line.priceExplanation).toEqual([trail[0], { type: 'customer', label: 'Customer price', price: 15 }])
    expect(JSON.stringify(mine.json)).not.toContain('Цена 3')
    expect((await call('GET', `/invoices/${inv._id}`, tokens.admin)).json.invoice.lines[0].priceExplanation).toEqual(trail)
  })
})

describe('C.4 / C.6 the trail is not overwritten, and every answer is redacted', () => {
  let writer: string
  let invId: string
  const trail = [{ type: 'base', label: 'Selling price', price: 20 }, { type: 'tier', label: 'Цена 3', price: 15 }]
  beforeAll(async () => {
    const org: any = await Org.findById(orgId).lean().exec()
    // Writes invoices, does not see Цена 3.
    const caps = [...(compileLegacy({ role: 'member', permissions: ['invoicing.read', 'invoicing.write'] }) as any).caps].filter((c: string) => c !== 'products.price:3')
    const role: any = await Role.create({ orgId: org._id, name: 'Clerk without Цена 3', isBuiltin: false, edited: true, version: 1, legacy: { role: 'member', permissions: ['invoicing.read', 'invoicing.write'] }, caps } as any)
    const person = await createTestUser(org._id, { role: 'member', username: 'clerk-no-3', email: 'clerk-no-3@price-levels.test' } as any)
    await User.updateOne({ _id: person._id }, { $set: { roleId: role._id } }).exec()
    forgetMember(person._id)
    forgetRole(role._id)
    writer = await sign(person._id)
    invId = String((await createTestInvoice(org._id, contactId as any, {
      invoiceNumber: 'INV-PL-SAVE', status: 'draft',
      lines: [{ productId, description: 'Bolt', quantity: 1, unit: 'pcs', unitPrice: 15, taxRate: 20, taxAmount: 3, lineTotal: 15, priceExplanation: trail }],
    } as any))._id)
  })

  it('a save of the form it read keeps the stored trail: the Administrator still reads Цена 3', async () => {
    const read = await call('GET', `/invoices/${invId}`, writer)
    const line = read.json.invoice.lines[0]
    expect(line.priceExplanation.at(-1).type).toBe('customer')
    const { productId: pid, description, quantity, unit, unitPrice, taxRate, taxAmount, lineTotal, priceExplanation } = line
    const put = await call('PUT', `/invoices/${invId}`, writer, { notes: 'edited by a clerk', lines: [{ productId: pid, description, quantity, unit, unitPrice, taxRate, taxAmount, lineTotal, priceExplanation }] })
    expect(put.status).toBe(200)
    expect(JSON.stringify(put.json)).not.toContain('Цена 3')
    const stored: any = await Invoice.findById(invId).lean().exec()
    expect(stored.lines[0].priceExplanation.map((s: any) => s.label)).toEqual(['Selling price', 'Цена 3'])
    expect((await call('GET', `/invoices/${invId}`, tokens.admin)).json.invoice.lines[0].priceExplanation.at(-1).label).toBe('Цена 3')
  })

  it('a line it repriced keeps its new trail', async () => {
    const read = await call('GET', `/invoices/${invId}`, writer)
    const { productId: pid, description, quantity, unit, taxRate } = read.json.invoice.lines[0]
    const fresh = [{ type: 'base', label: 'Selling price', price: 20 }]
    expect((await call('PUT', `/invoices/${invId}`, writer, { lines: [{ productId: pid, description, quantity, unit, unitPrice: 20, taxRate, taxAmount: 4, lineTotal: 20, priceExplanation: fresh }] })).status).toBe(200)
    const stored: any = await Invoice.findById(invId).lean().exec()
    expect(stored.lines[0].priceExplanation.map((s: any) => s.label)).toEqual(['Selling price'])
  })

  it('a line priced at a hidden level is saved: the "Customer price" step is a step the API takes', async () => {
    const made = await call('POST', '/invoices', writer, {
      type: 'invoice', direction: 'outgoing', contactId, issueDate: new Date().toISOString(), currency: 'EUR', subtotal: 15, taxTotal: 3, total: 18,
      lines: [{ productId, description: 'Bolt', quantity: 1, unit: 'pcs', unitPrice: 15, taxRate: 20, taxAmount: 3, lineTotal: 15, priceExplanation: [{ type: 'base', label: 'Selling price', price: 20 }, { type: 'customer', label: 'Customer price', price: 15 }] }],
    })
    expect(made.status, JSON.stringify(made.json)).toBe(200)
  })

  it('the list and the other answers name no hidden level either', async () => {
    const list = await call('GET', '/invoices?size=50', writer)
    expect(list.status).toBe(200)
    expect(JSON.stringify(list.json)).not.toContain('Цена 3')
  })

  // A conversion answers with the draft invoice it made, from another controller than the invoices': the same rule.
  describe('the draft a conversion answers with', () => {
    const today = new Date().toISOString().slice(0, 10)
    let warehouseId: string
    const ok = async (method: string, path: string, body?: unknown) => {
      const res = await call(method, path, tokens.admin, body)
      expect(res.status, `${method} ${path}: ${JSON.stringify(res.json)}`).toBe(200)
      return res.json
    }
    /** What the clerk was answered names no hidden level; what is stored is whole. */
    const expectRedacted = async (conv: { status: number; json: any }) => {
      expect(conv.status, JSON.stringify(conv.json)).toBe(200)
      expect(JSON.stringify(conv.json)).not.toContain('Цена 3')
      const line = conv.json.invoice.lines[0]
      expect(line.unitPrice).toBe(15)
      expect(line.priceExplanation).toEqual([trail[0], { type: 'customer', label: 'Customer price', price: 15 }])
      const stored: any = await Invoice.findById(conv.json.invoice._id ?? conv.json.invoice.id).lean().exec()
      expect(stored.lines[0].priceExplanation.map((s: any) => [s.type, s.label, s.price])).toEqual([['base', 'Selling price', 20], ['tier', 'Цена 3', 15]])
    }

    beforeAll(async () => {
      const org: any = await Org.findById(orgId).lean().exec()
      const wh = await createTestWarehouse(org._id, { name: 'Conversion WH', code: 'CVW' } as any)
      warehouseId = String(wh._id)
    })

    it('a customer order converted by the clerk', async () => {
      await StockLevel.create({ orgId, productId, warehouseId, quantity: 5, availableQuantity: 5, avgCost: 9 } as any)
      const { internalOrder } = await ok('POST', '/invoicing/internal-orders', {
        contactId, issueDate: today, requestedDeliveryDate: today, warehouseId,
        lines: [{ productId, description: 'Bolt', quantity: 2, unit: 'pcs', expectedUnitPrice: 20 }],
      })
      await ok('POST', `/invoicing/internal-orders/${internalOrder._id}/confirm`)
      await ok('POST', `/invoicing/internal-orders/${internalOrder._id}/reserve-available`, {})

      await expectRedacted(await call('POST', `/invoicing/internal-orders/${internalOrder._id}/convert`, writer))
    })

    it('a supplier order converted by the clerk for that client', async () => {
      const supplier: any = await createTestContact(orgId as any, { type: 'supplier', companyName: 'Conversion supplier' } as any)
      const { order: made } = await ok('POST', '/invoicing/orders', {
        issueDate: today,
        supplierGroups: [{
          supplierId: String(supplier._id),
          lines: [{ productId, description: 'Bolt', quantity: 3, unit: 'pcs', expectedUnitPrice: 9, allocations: [{ warehouseId, quantity: 3 }] }],
        }],
      })
      const { order } = await ok('POST', `/invoicing/orders/${made._id}/send`)
      const g = order.supplierGroups[0]
      const l = g.lines[0]
      const a = l.allocations[0]
      await ok('POST', '/invoicing/reservations', {
        source: 'order', productId, quantity: 3, contactId,
        orderId: String(order._id), groupId: String(g._id), lineId: String(l._id), allocationId: String(a._id),
      })
      // The goods arrive: a bill against the allocation, received.
      const { invoice: bill } = await ok('POST', '/invoices', {
        type: 'invoice', direction: 'incoming', contactId: String(supplier._id), issueDate: today, currency: 'EUR',
        orderId: String(order._id), orderGroupId: String(g._id),
        lines: [{
          productId, description: 'Bolt', quantity: 3, unit: 'pcs', unitPrice: 9, taxRate: 20, warehouseId,
          orderRef: { orderId: String(order._id), groupId: String(g._id), lineId: String(l._id), allocationId: String(a._id) },
        }],
        subtotal: 27, total: 32.4,
      })
      await ok('POST', `/invoices/${bill._id ?? bill.id}/receive`)

      await expectRedacted(await call('POST', `/invoicing/orders/${order._id}/convert`, writer, { contactId }))
    })

    it('a line whose price was chosen on the order: the order\'s step stays, the level the customer resolves to is not named', async () => {
      const { internalOrder } = await ok('POST', '/invoicing/internal-orders', {
        contactId, issueDate: today, requestedDeliveryDate: today, warehouseId,
        lines: [{ productId, description: 'Bolt', quantity: 2, unit: 'pcs', expectedUnitPrice: 14, pricePinned: true }],
      })
      const { internalOrder: confirmed } = await ok('POST', `/invoicing/internal-orders/${internalOrder._id}/confirm`)
      await ok('POST', `/invoicing/internal-orders/${internalOrder._id}/reserve-available`, {})

      const conv = await call('POST', `/invoicing/internal-orders/${internalOrder._id}/convert`, writer)
      expect(conv.status, JSON.stringify(conv.json)).toBe(200)
      expect(JSON.stringify(conv.json)).not.toContain('Цена 3')
      const line = conv.json.invoice.lines[0]
      expect(line.unitPrice).toBe(14)
      // The hidden level lost to the order's price: a losing step is not named at all. The override is the person's own.
      expect(line.priceExplanation).toEqual([trail[0], { type: 'override', label: confirmed.orderNumber, price: 14 }])
      const stored: any = await Invoice.findById(conv.json.invoice._id ?? conv.json.invoice.id).lean().exec()
      expect(stored.lines[0].priceExplanation.map((s: any) => [s.type, s.label, s.price]))
        .toEqual([['base', 'Selling price', 20], ['tier', 'Цена 3', 15], ['override', confirmed.orderNumber, 14]])
    })
  })
})
