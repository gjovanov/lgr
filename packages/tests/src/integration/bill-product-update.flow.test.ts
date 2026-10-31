import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestContact, createTestWarehouse, createTestProduct } from '../helpers/factories'
import { invoiceController } from 'invoicing-api/src/controllers/invoice.controller'
import { receiptBillController } from 'invoicing-api/src/controllers/receipt-bill.controller'
import { movementController } from 'warehouse-api/src/controllers/movement.controller'
import { productController } from 'warehouse-api/src/controllers/product.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
// The bill form's own payload code — PURE modules, reached by path as document-payload.test.ts does.
import { buildPayload, buildProductUpdates } from '../../../invoicing-ui/src/composables/document-form/document-payload'
import { DOCUMENT_CONFIGS } from '../../../invoicing-ui/src/composables/document-form/configs'
import { cascadePurchasePrice, seedFromProduct, setProductField, setTierPrice } from 'ui-shared/composables/gr-product-update'
import { Invoice, Product, ProductCategory } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS, MAX_PRICE_TIERS } from 'config/constants'

/**
 * The supplier bill's „С актуализация на продукт" opens ON. What makes that safe, end to end:
 * the form sends only what a line changed from what it was seeded with, and the server merges
 * tiers into the product's own by name. Each case below drives the form's payload code
 * (`document-payload.ts` + `gr-product-update.ts`) through the real controllers.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any)
    .use(invoiceController).use(receiptBillController).use(movementController).use(productController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(u: { id: string; orgId: string }) {
  return (signer as any).decorator.jwt.sign({
    id: u.id, orgId: u.orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'Мария', lastName: 'Иванова', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
}

const VALID_FROM = new Date('2026-01-01T00:00:00Z')
const VALID_TO = new Date('2026-12-31T00:00:00Z')

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const supplier = await createTestContact(org._id, { companyName: 'Доставчик АД', type: 'supplier' } as any)
  const customer = await createTestContact(org._id, { companyName: 'Клиент ООД', type: 'customer' } as any)
  const warehouse = await createTestWarehouse(org._id, { isDefault: true } as any)
  const other = await createTestWarehouse(org._id)
  const product = await createTestProduct(org._id, {
    sku: 'PRD-0001', name: 'Болт М8', purchasePrice: 10, sellingPrice: 20, taxRate: 20,
    priceTiers: [
      // derived from the purchase price: 10 + 20 %
      { name: 'Цена на едро', percent: 20, finalPrice: 12, manualOverride: false, contactIds: [], tags: [] },
      // a tier only one customer gets, from 10 pieces, this year — the filters the form never shows
      {
        name: 'Цена 1', percent: 0, finalPrice: 18, manualOverride: true, contactIds: [customer._id], tags: ['Цена 1'],
        minQuantity: 10, validFrom: VALID_FROM, validTo: VALID_TO,
      },
      // a backfilled slot: the selling price, percent 0, not fixed
      { name: 'Цена 3', percent: 0, finalPrice: 20, manualOverride: false, contactIds: [], tags: [] },
    ],
  } as any)
  const token = await tokenFor({ id: String(user._id), orgId })

  async function call(method: string, path: string, body?: any) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }

  /** A bill line as the form holds it once loaded: the product read the way the form reads it. */
  async function line(wh = warehouse, quantity = 5, unitPrice = 10) {
    const { json } = await call('GET', `/warehouse/product/${product._id}`)
    return {
      productId: String(product._id), description: 'Болт М8', quantity, unit: 'pcs', unitPrice, taxRate: 20,
      warehouseId: String(wh._id), ...seedFromProduct(json.product, String(product._id)),
    }
  }

  /** What the bill form sends for these lines: the payload, plus the product updates when there are any. */
  function payload(lines: any[]) {
    const p = buildPayload({
      contactId: String(supplier._id), supplierInvoiceNumber: 'SUP-1', issueDate: '2026-10-29', dueDate: '2026-11-29',
      paymentMethod: '', currency: 'EUR', exchangeRate: 1, notes: '', tags: [], lines,
    }, DOCUMENT_CONFIGS.purchase_invoice)
    const updates = buildProductUpdates(lines)
    if (updates.length) p.productUpdates = updates
    return p
  }

  async function newBill() {
    const res = await call('POST', '/invoices', payload([await line()]))
    expect(res.status).toBe(200)
    return res.json.invoice
  }

  const read = () => Product.findById(product._id).lean().exec() as Promise<any>
  /** The product as a comparable record: what a write could have touched. */
  const state = (p: any) => JSON.parse(JSON.stringify({
    purchasePrice: p.purchasePrice, sellingPrice: p.sellingPrice, taxRate: p.taxRate, unit: p.unit, type: p.type,
    priceTiers: p.priceTiers, updatedAt: p.updatedAt,
  }))

  return { orgId, supplier, customer, warehouse, other, product, call, line, payload, newBill, read, state }
}

describe('a supplier bill saved with „С актуализация на продукт" ON', () => {
  it('opened and saved untouched, it updates no product: no product update is even sent', async () => {
    const w = await world()
    const bill = await w.newBill()
    const before = w.state(await w.read())

    const body = w.payload([await w.line()])
    expect(body).not.toHaveProperty('productUpdates')
    expect((await w.call('PUT', `/invoices/${bill.id}`, body)).status).toBe(200)

    expect(w.state(await w.read())).toEqual(before)
  }, 60_000)

  it('an edited price changes that field and nothing else', async () => {
    const w = await world()
    const bill = await w.newBill()
    const before = w.state(await w.read())

    const l = await w.line()
    setProductField(l, 'sellingPrice', '25.5')
    const body = w.payload([l])
    expect(body.productUpdates).toEqual([{ productId: String(w.product._id), sellingPrice: 25.5 }])
    expect((await w.call('PUT', `/invoices/${bill.id}`, body)).status).toBe(200)

    const after = w.state(await w.read())
    expect(after.sellingPrice).toBe(25.5)
    expect({ ...after, sellingPrice: before.sellingPrice, updatedAt: before.updatedAt }).toEqual(before)
  }, 60_000)

  it('an edited tier keeps its filters, and no tier is padded in or lost', async () => {
    const w = await world()
    const bill = await w.newBill()
    const l = await w.line()
    setTierPrice(l, 'Цена 1', '16.5')
    expect((await w.call('PUT', `/invoices/${bill.id}`, w.payload([l]))).status).toBe(200)

    const tiers = (await w.read()).priceTiers
    expect(tiers.map((t: any) => t.name)).toEqual(['Цена на едро', 'Цена 1', 'Цена 3'])
    const t1 = tiers[1]
    expect([t1.finalPrice, t1.manualOverride, t1.minQuantity]).toEqual([16.5, true, 10])
    expect(t1.contactIds.map(String)).toEqual([String(w.customer._id)])
    expect(t1.tags).toEqual(['Цена 1'])
    expect([t1.validFrom.toISOString(), t1.validTo.toISOString()]).toEqual([VALID_FROM.toISOString(), VALID_TO.toISOString()])
    expect([tiers[0].finalPrice, tiers[2].finalPrice]).toEqual([12, 20])
  }, 60_000)

  it('a price in a tier the article lacks adds that tier, by its name', async () => {
    const w = await world()
    const bill = await w.newBill()
    const l = await w.line()
    setTierPrice(l, 'Цена 4', '33')
    expect((await w.call('PUT', `/invoices/${bill.id}`, w.payload([l]))).status).toBe(200)

    const tiers = (await w.read()).priceTiers
    expect(tiers.map((t: any) => [t.name, t.finalPrice])).toEqual([['Цена на едро', 12], ['Цена 1', 18], ['Цена 3', 20], ['Цена 4', 33]])
    expect(tiers.some((t: any) => /^Price /.test(t.name))).toBe(false)
  }, 60_000)

  it('the unit price moves the purchase price and the tier derived from it — not the backfilled one', async () => {
    const w = await world()
    const bill = await w.newBill()
    const l = await w.line()
    l.unitPrice = 12.5
    cascadePurchasePrice(l, l.unitPrice) // what typing the bill's unit price does
    expect((await w.call('PUT', `/invoices/${bill.id}`, w.payload([l]))).status).toBe(200)

    const p = await w.read()
    expect(p.purchasePrice).toBe(12.5)
    expect(p.priceTiers.map((t: any) => [t.name, t.finalPrice])).toEqual([['Цена на едро', 15], ['Цена 1', 18], ['Цена 3', 20]])
    expect(p.sellingPrice).toBe(20)
  }, 60_000)

  it('a price changed elsewhere while the bill was open stays changed', async () => {
    const w = await world()
    const bill = await w.newBill()
    const l = await w.line()
    // Someone reprices the article in Products meanwhile.
    await Product.updateOne({ _id: w.product._id }, { $set: { sellingPrice: 27, 'priceTiers.2.finalPrice': 26 } }).exec()

    setTierPrice(l, 'Цена 1', '17')
    expect((await w.call('PUT', `/invoices/${bill.id}`, w.payload([l]))).status).toBe(200)

    const p = await w.read()
    expect(p.sellingPrice).toBe(27)
    expect(p.priceTiers.map((t: any) => t.finalPrice)).toEqual([12, 17, 26])
  }, 60_000)

  it('two lines of one article both land: one write per product', async () => {
    const w = await world()
    const bill = await w.newBill()
    const a = await w.line(w.warehouse, 5)
    const b = await w.line(w.other, 3)
    setProductField(a, 'sellingPrice', '22')
    setTierPrice(b, 'Цена 3', '21')
    const body = w.payload([a, b])
    expect(body.productUpdates).toHaveLength(2)
    expect((await w.call('PUT', `/invoices/${bill.id}`, body)).status).toBe(200)

    const p = await w.read()
    expect(p.sellingPrice).toBe(22)
    expect(p.priceTiers.map((t: any) => t.finalPrice)).toEqual([12, 18, 21])
  }, 60_000)

  it('a new bill: the create path sends and writes only the edited field', async () => {
    const w = await world()
    const before = w.state(await w.read())
    const l = await w.line()
    setProductField(l, 'taxRate', '9')
    const res = await w.call('POST', '/invoices', w.payload([l]))
    expect(res.status).toBe(200)
    const after = w.state(await w.read())
    expect(after.taxRate).toBe(9)
    expect({ ...after, taxRate: before.taxRate, updatedAt: before.updatedAt }).toEqual(before)
  }, 60_000)

  it('a tier the article has no room for is refused whole: 422, the bill and the product unchanged', async () => {
    const w = await world()
    await Product.updateOne({ _id: w.product._id }, {
      $set: { priceTiers: Array.from({ length: MAX_PRICE_TIERS }, (_, i) => ({ name: `Ниво ${i + 1}`, percent: 0, finalPrice: 20 + i, manualOverride: true })) },
    }).exec()
    const bill = await w.newBill()
    const before = w.state(await w.read())

    const l = await w.line(w.warehouse, 7)
    setTierPrice(l, 'Цена 1', '19')
    const res = await w.call('PUT', `/invoices/${bill.id}`, w.payload([l]))
    expect(res.status).toBe(422)
    expect(String(res.json.message)).toContain(`${MAX_PRICE_TIERS}`)
    expect(w.state(await w.read())).toEqual(before)
    expect(((await Invoice.findById(bill.id).lean().exec()) as any).lines[0].quantity).toBe(5)
  }, 60_000)

  it('a bill in another currency updates no product: 422 on create and on edit, nothing written', async () => {
    const w = await world()
    const before = w.state(await w.read())
    const l = await w.line()
    setProductField(l, 'sellingPrice', '30')

    const created = await w.call('POST', '/invoices', { ...w.payload([l]), currency: 'USD', exchangeRate: 0.9 })
    expect([created.status, created.json.code]).toEqual([422, 'foreign_currency_bill'])
    expect(created.json.message).toBe('A bill in USD updates no product: product prices are kept in EUR')

    const bill = await w.newBill()
    const edited = await w.call('PUT', `/invoices/${bill.id}`, { ...w.payload([l]), currency: 'USD', exchangeRate: 0.9 })
    expect([edited.status, edited.json.code]).toEqual([422, 'foreign_currency_bill'])

    // A bill already in another currency, with no currency in the body, is refused all the same.
    await Invoice.updateOne({ _id: bill.id }, { $set: { currency: 'USD' } })
    const { currency: _c, ...noCurrency } = w.payload([l]) as any
    const stored = await w.call('PUT', `/invoices/${bill.id}`, noCurrency)
    expect([stored.status, stored.json.code]).toEqual([422, 'foreign_currency_bill'])

    expect(w.state(await w.read())).toEqual(before)
  }, 60_000)

  it('a bill in another currency saved with no product update is an ordinary bill', async () => {
    const w = await world()
    const res = await w.call('POST', '/invoices', { ...w.payload([await w.line()]), currency: 'USD', exchangeRate: 0.9 })
    expect(res.status).toBe(200)
    expect(res.json.invoice.currency).toBe('USD')
  }, 60_000)

  it('a category picked on a line renames the article too: the name lists read, and its search mirror', async () => {
    const w = await world()
    const category = await ProductCategory.create({ orgId: w.product.orgId, name: 'Болтове DIN' })
    const l = await w.line()
    setProductField(l, 'categoryId', String(category._id))
    expect((await w.call('POST', '/invoices', w.payload([l]))).status).toBe(200)
    const after = await w.read()
    expect([String(after.categoryId), after.category, after.categoryLower]).toEqual([String(category._id), 'Болтове DIN', 'болтове din'])
  }, 60_000)

  it('a category of another org is refused: 422, the article unchanged', async () => {
    const w = await world()
    const elsewhere = await createTestOrg()
    const category = await ProductCategory.create({ orgId: elsewhere._id, name: 'Чужда' })
    const before = await w.read()
    const l = await w.line()
    setProductField(l, 'categoryId', String(category._id))
    const res = await w.call('POST', '/invoices', w.payload([l]))
    expect(res.status).toBe(422)
    const after = await w.read()
    expect([String(after.categoryId), after.category]).toEqual([String(before.categoryId), before.category])
  }, 60_000)

  it('the product list reads several articles at once, the org\'s own only', async () => {
    const w = await world()
    const second = await createTestProduct(w.product.orgId, { sku: 'PRD-0002', name: 'Шайба М8' })
    const elsewhere = await createTestOrg()
    const foreign = await createTestProduct(elsewhere._id, { sku: 'PRD-0003', name: 'Чужд продукт' })
    const ids = [w.product._id, second._id, foreign._id, 'not-an-id'].join(',')
    const res = await w.call('GET', `/warehouse/product?ids=${ids}&size=4`)
    expect(res.status).toBe(200)
    expect(res.json.products.map((p: any) => String(p.id ?? p._id)).sort()).toEqual([String(w.product._id), String(second._id)].sort())
    // The whole article: what a line is seeded from.
    const own = res.json.products.find((p: any) => String(p.id ?? p._id) === String(w.product._id))
    expect(own.priceTiers.map((t: any) => t.name)).toEqual((await w.read()).priceTiers.map((t: any) => t.name))

    const none = await w.call('GET', '/warehouse/product?ids=not-an-id&size=4')
    expect(none.json.products).toEqual([])
  }, 60_000)

  it('a bill made from goods receipts updates no product: 422, nothing written', async () => {
    const w = await world()
    const ls = [{ productId: String(w.product._id), quantity: 4, unitCost: 10, totalCost: 40 }]
    const mv = await w.call('POST', '/warehouse/movement', {
      type: 'receipt', date: '2026-10-20', toWarehouseId: String(w.warehouse._id), contactId: String(w.supplier._id), lines: ls, totalAmount: 40,
    })
    const movementId = mv.json.stockMovement._id || mv.json.stockMovement.id
    expect((await w.call('POST', `/warehouse/movement/${movementId}/confirm`, {})).status).toBe(200)
    const made = await w.call('POST', '/invoicing/bills/from-receipt', { movementIds: [String(movementId)] })
    expect(made.status).toBe(200)
    const before = w.state(await w.read())

    const l = await w.line(w.warehouse, 4)
    setProductField(l, 'sellingPrice', '30')
    const res = await w.call('PUT', `/invoices/${made.json.invoice.id}`, w.payload([l]))
    expect([res.status, res.json.code]).toEqual([422, 'receipt_linked_bill'])
    expect(w.state(await w.read())).toEqual(before)
  }, 60_000)
})
