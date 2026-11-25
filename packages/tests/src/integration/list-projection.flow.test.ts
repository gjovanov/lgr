import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'

import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../api/src/api.js'
import { spaErrorHandler } from '../../../api/src/spa-fallback.js'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { Account, Contact, Invoice, Product, StockLevel, StockMovement, User } from 'db/models'
import { tokenize } from 'services/biz/auth.service'
import { LIST_CEILING, LIST_ROW_EXCLUDES } from 'config/list-rows'

/**
 * FR-30 slice B (#795): what a list answers with, and how many rows at most.
 *
 * FR-30.7: with `fields=list` the invoice, product, contact, stock-level and movement lists answer rows: no line arrays,
 * no price tiers' filters or legacy price arrays, no search mirrors; 100 invoice rows weigh at most 120 KB. Without the
 * parameter every answer keeps its shape and its whole documents (FR-30.29, D-1).
 * FR-30.8: no answer carries more than 1 000 rows, whatever `size` says; a cut answer says so (`truncated`, the real
 * `total`). The count form's levels are the one declared lean "all", and the chart of accounts the reader that needs
 * every account.
 * FR-30.10: a document's read names each line's article, so the form reads none.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const oid = () => new mongoose.Types.ObjectId()

let app: Elysia
let orgId: string
let token = ''
let warehouse: mongoose.Types.ObjectId
let customer: mongoose.Types.ObjectId
let invoiceWithLines: string
let articleIds: mongoose.Types.ObjectId[] = []

const CONTACTS = LIST_CEILING + 100
const LEVELS = LIST_CEILING + 100

async function get(path: string): Promise<{ status: number; json: any; bytes: number }> {
  const res = await app.handle(new Request(`http://localhost/api/org/${orgId}${path}`, { headers: { authorization: `Bearer ${token}` } }))
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* not json */ }
  return { status: res.status, json, bytes: Buffer.byteLength(text) }
}

/** A sales line as a shop's invoice carries it: an article, a description, a price trail. */
const line = (i: number, productId: mongoose.Types.ObjectId) => ({
  _id: oid(), productId, description: `Болт DIN 933 М8Х25 ZN поцинкован ${i}`, quantity: 1 + (i % 7), unit: 'бр.',
  unitPrice: 0.0472 + i, discount: 0, taxRate: 20, taxAmount: 0.2 * (0.0472 + i), lineTotal: 1.2 * (0.0472 + i),
  warehouseId: warehouse,
  priceExplanation: [{ type: 'base', label: 'Продажна цена', price: 1 + i }, { type: 'tier', label: 'Цена 4', price: 0.9 + i }],
})

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  const org = await createTestOrg({ slug: 'list-projection' } as any)
  orgId = String(org._id)
  const admin = await createTestUser(org._id, { role: 'admin', username: 'admin', email: 'admin@list-projection.test' } as any)
  token = await (signer as any).decorator.jwt.sign(await tokenize((await User.findById(admin._id).exec())!))
  warehouse = oid()
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 60_000)

  // Thirty articles with the ten price slots of a shop, some of them filtered by tag or contact.
  const tiers = Array.from({ length: 10 }, (_, k) => ({
    name: k === 0 ? 'Доставна цена' : `Цена ${k + 1}`, percent: 10 * k, finalPrice: 1 + k, manualOverride: k % 3 === 0,
    contactIds: k === 4 ? [oid()] : [], tags: k > 1 ? [`Цена ${k + 1}`] : [], minQuantity: k === 9 ? 100 : undefined,
  }))
  const products = Array.from({ length: 30 }, (_, i) => ({
    _id: oid(), orgId: org._id, sku: `PRJ-${String(i).padStart(3, '0')}`, name: `Болт ${i}`, nameLower: `болт ${i}`, skuLower: `prj-${i}`,
    category: 'Болтове', categoryLower: 'болтове', type: 'goods', unit: 'бр.', sellingPrice: 2 + i, purchasePrice: 1 + i, isActive: true,
    priceTiers: tiers, customPrices: [{ name: 'Old', contactId: oid(), price: 1 }], tagPrices: [{ name: 'Old', tag: 'x', price: 1 }], tags: ['din'],
    createdAt: at(i), updatedAt: at(i),
  }))
  articleIds = products.map((p) => p._id)
  await Product.collection.insertMany(products as any[])

  // More contacts than an answer carries.
  const contacts = Array.from({ length: CONTACTS }, (_, i) => ({
    _id: oid(), orgId: org._id, type: i % 2 ? 'customer' : 'supplier', companyName: `Фирма ${String(i).padStart(4, '0')}`,
    companyNameLower: `фирма ${String(i).padStart(4, '0')}`, notes: 'Бележка за контакта, която списъкът не показва.',
    addresses: [{ type: 'billing', street: 'ул. Първа 1', city: 'София', isDefault: true }], taxId: `${100000000 + i}`, taxIdLower: `${100000000 + i}`,
    isActive: true, createdAt: at(i), updatedAt: at(i),
  }))
  customer = contacts[1]!._id
  await Contact.collection.insertMany(contacts as any[])

  // 120 documents of 12 lines, as the audit measured them.
  const invoices = Array.from({ length: 120 }, (_, i) => {
    const lines = Array.from({ length: 12 }, (_, k) => line(k, articleIds[(i + k) % articleIds.length]!))
    return {
      _id: oid(), orgId: org._id, direction: 'outgoing', type: 'invoice', status: i % 3 ? 'sent' : 'draft',
      invoiceNumber: `INV-2026-${String(i).padStart(5, '0')}`, contactId: customer, currency: 'EUR', exchangeRate: 1,
      issueDate: at(i), dueDate: at(i + 43_200), lines, subtotal: 100 + i, discountTotal: 0, taxTotal: 20, total: 120 + i, amountPaid: 0, amountDue: 120 + i,
      payments: [], tags: [], statusHistory: [{ status: 'draft', changedAt: at(i) }], paymentMethod: 'bank_transfer', notes: 'Плащане по сметка.',
      createdAt: at(i), updatedAt: at(i),
    }
  })
  invoiceWithLines = String(invoices[0]!._id)
  await Invoice.collection.insertMany(invoices as any[])

  // More levels in one warehouse than an answer carries: what a count of a large warehouse lists, one per article.
  const stocked = Array.from({ length: LEVELS }, (_, i) => ({
    _id: oid(), orgId: org._id, sku: `STK-${String(i).padStart(5, '0')}`, name: `Шайба ${i}`, category: 'Шайби', type: 'goods', unit: 'бр.',
    isActive: false, priceTiers: [], tags: [], createdAt: at(i), updatedAt: at(i),
  }))
  await Product.collection.insertMany(stocked as any[])
  const levels = stocked.map((p, i) => ({
    _id: oid(), orgId: org._id, productId: p._id, warehouseId: warehouse, quantity: i % 9, reservedQuantity: 0,
    availableQuantity: i % 9, avgCost: 1.5, createdAt: at(i), updatedAt: at(i),
  }))
  await StockLevel.collection.insertMany(levels as any[])

  const movements = Array.from({ length: 20 }, (_, i) => ({
    _id: oid(), orgId: org._id, movementNumber: `SM-2026-${String(i).padStart(5, '0')}`, type: 'receipt', status: 'completed', date: at(i),
    toWarehouseId: warehouse, totalAmount: 10 * i, createdBy: oid(),
    lines: Array.from({ length: 10 }, (_, k) => ({ productId: articleIds[k], quantity: 1 + k, unitCost: 1, totalCost: 1 + k, costAllocations: [{ quantity: 1, unitCost: 1, totalCost: 1 }], priceTiers: tiers })),
    createdAt: at(i), updatedAt: at(i),
  }))
  await StockMovement.collection.insertMany(movements as any[])

  // A chart larger than a list's ceiling.
  const accounts = Array.from({ length: LIST_CEILING + 50 }, (_, i) => ({
    _id: oid(), orgId: org._id, code: String(100000 + i), name: `Сметка ${i}`, type: 'asset', isActive: true, createdAt: at(i), updatedAt: at(i),
  }))
  await Account.collection.insertMany(accounts as any[])
})

afterAll(async () => {
  await teardownTestDB()
})

const keysOf = (rows: any[]) => [...new Set(rows.flatMap((r) => Object.keys(r)))].sort()

describe('FR-30.7: lists send rows', () => {
  it('an invoice row has no lines with fields=list, and 100 of them weigh at most 120 KB', async () => {
    const whole = await get('/invoices?size=100&direction=outgoing')
    const rows = await get('/invoices?size=100&direction=outgoing&fields=list')
    expect(whole.status).toBe(200)
    expect(rows.status).toBe(200)
    expect(whole.json.invoices).toHaveLength(100)
    expect(rows.json.invoices).toHaveLength(100)
    expect(whole.json.invoices.every((i: any) => Array.isArray(i.lines) && i.lines.length === 12)).toBe(true)
    expect(rows.json.invoices.some((i: any) => 'lines' in i)).toBe(false)
    // Everything else the row carried, it still carries.
    expect(keysOf(rows.json.invoices)).toEqual(keysOf(whole.json.invoices).filter((k) => k !== 'lines'))
    expect({ bytes: rows.bytes, within: rows.bytes <= 120 * 1024 }).toEqual({ bytes: rows.bytes, within: true })
    if (process.env.LGR_PERF) console.log(`100 invoice rows: ${(whole.bytes / 1024).toFixed(1)} KB whole, ${(rows.bytes / 1024).toFixed(1)} KB as rows`)
  })

  it('an article row keeps each price slot\'s name and price, without its filters, the legacy arrays or the mirrors', async () => {
    const whole = await get('/warehouse/product?size=30&sortBy=createdAt&sortOrder=asc&isActive=true')
    const rows = await get('/warehouse/product?size=30&sortBy=createdAt&sortOrder=asc&isActive=true&fields=list')
    expect(rows.json.products).toHaveLength(30)
    const row = rows.json.products[0]
    for (const f of ['customPrices', 'tagPrices', 'nameLower', 'skuLower', 'categoryLower']) expect({ f, present: f in row }).toEqual({ f, present: false })
    expect(row.priceTiers).toHaveLength(10)
    expect(keysOf(row.priceTiers)).toEqual(['finalPrice', 'manualOverride', 'name', 'percent'])
    // The grid's figures are the whole document's.
    expect(rows.json.products.map((p: any) => p.priceTiers.map((t: any) => [t.name, t.finalPrice])))
      .toEqual(whole.json.products.map((p: any) => p.priceTiers.map((t: any) => [t.name, t.finalPrice])))
    expect(whole.json.products[0].customPrices).toHaveLength(1)
    expect(whole.json.products[0].priceTiers[4].contactIds).toHaveLength(1)
  })

  it('so does a sort that only an aggregation serves (a price slot\'s column)', async () => {
    const rows = await get('/warehouse/product?size=5&sortBy=tier_3&sortOrder=desc&isActive=true&fields=list')
    expect(rows.status).toBe(200)
    expect(rows.json.products).toHaveLength(5)
    expect(rows.json.products.some((p: any) => 'customPrices' in p || p.priceTiers.some((t: any) => 'tags' in t))).toBe(false)
  })

  it('a contact row, in the list and in the picker, has no notes and no search mirrors, and keeps its addresses', async () => {
    for (const path of ['/invoicing/contact?size=20&fields=list', '/invoicing/contact?size=20&prefer=customer&fields=list']) {
      const { status, json } = await get(path)
      expect({ path, status }).toEqual({ path, status: 200 })
      expect(json.contacts).toHaveLength(20)
      const keys = keysOf(json.contacts)
      expect({ path, hidden: keys.filter((k) => k === 'notes' || k.endsWith('Lower')) }).toEqual({ path, hidden: [] })
      expect(json.contacts.every((c: any) => c.addresses?.[0]?.city === 'София' && c.taxId)).toBe(true)
    }
    const whole = await get('/invoicing/contact?size=20')
    expect(whole.json.contacts.every((c: any) => c.notes && c.companyNameLower)).toBe(true)
  })

  it('a movement row and a stock-level row are what they were, read narrower', async () => {
    for (const path of ['/warehouse/movement?size=20', '/warehouse/stock-level?size=20']) {
      const whole = await get(path)
      const rows = await get(`${path}&fields=list`)
      expect({ path, status: rows.status }).toEqual({ path, status: 200 })
      expect(rows.json).toEqual(whole.json)
    }
    const { json } = await get('/warehouse/movement?size=1&fields=list')
    expect(json.stockMovements[0].lineCount).toBe(10)
    expect('lines' in json.stockMovements[0]).toBe(false)
    // Filtered to one article, the row still sums its quantity.
    const one = await get(`/warehouse/movement?size=1&productId=${articleIds[3]}&fields=list`)
    expect(one.json.stockMovements[0].productQuantity).toBe(4)
    expect(LIST_ROW_EXCLUDES.stockLevels).toEqual({})
  })

  it('an answer without fields=list keeps its keys (FR-30.29)', async () => {
    const shapes: Array<[string, string[]]> = [
      ['/invoices?size=10', ['invoices', 'page', 'size', 'total', 'totalPages']],
      ['/warehouse/product?size=10', ['items', 'page', 'products', 'size', 'total', 'totalPages']],
      ['/invoicing/contact?size=10', ['contacts', 'items', 'page', 'size', 'total', 'totalPages']],
      ['/warehouse/stock-level?size=10', ['page', 'size', 'stockLevels', 'total', 'totalPages']],
      ['/warehouse/movement?size=10', ['page', 'size', 'stockMovements', 'total', 'totalPages']],
    ]
    for (const [path, keys] of shapes) {
      const { json } = await get(path)
      expect({ path, keys: Object.keys(json).sort() }).toEqual({ path, keys })
    }
  })
})

describe('FR-30.8: a page has a ceiling', () => {
  it('"All" is cut at the ceiling and says so, with the real total', async () => {
    const { status, json } = await get('/invoicing/contact?size=0')
    expect(status).toBe(200)
    expect(json.contacts).toHaveLength(LIST_CEILING)
    expect({ total: json.total, truncated: json.truncated }).toEqual({ total: CONTACTS, truncated: true })
  })

  it('so is a size above the ceiling', async () => {
    const { json } = await get('/invoicing/contact?size=5000')
    expect(json.contacts).toHaveLength(LIST_CEILING)
    expect({ total: json.total, truncated: json.truncated, size: json.size }).toEqual({ total: CONTACTS, truncated: true, size: LIST_CEILING })
    // Its last page holds the rest, and is not cut.
    const last = await get('/invoicing/contact?size=5000&page=1')
    expect(last.json.contacts).toHaveLength(CONTACTS - LIST_CEILING)
    expect('truncated' in last.json).toBe(false)
  })

  it('an answer that was not cut says nothing about it', async () => {
    for (const path of ['/warehouse/product?size=0&isActive=true', '/warehouse/product?size=10', '/invoicing/contact?size=10']) {
      const { json } = await get(path)
      expect({ path, truncated: 'truncated' in json }).toEqual({ path, truncated: false })
    }
    const all = await get('/warehouse/product?size=0&isActive=true')
    expect(all.json.products).toHaveLength(30)
    expect(all.json.total).toBe(30)
  })

  it('the stock-levels list is cut too, and its count form\'s lean "all" is not', async () => {
    const list = await get(`/warehouse/stock-level?size=0&warehouseId=${warehouse}`)
    expect(list.json.stockLevels).toHaveLength(LIST_CEILING)
    expect(list.json.truncated).toBe(true)

    const count = await get(`/warehouse/stock-level?size=0&warehouseId=${warehouse}&fields=count`)
    expect(count.status).toBe(200)
    expect(count.json.stockLevels).toHaveLength(LEVELS)
    expect('truncated' in count.json).toBe(false)
    // Narrow: what the form takes of a level, and nothing of its history.
    expect(keysOf(count.json.stockLevels).filter((k) => ['reservedQuantity', 'availableQuantity', 'createdAt', 'updatedAt'].includes(k))).toEqual([])
    expect(count.json.stockLevels[0]).toMatchObject({ productName: expect.any(String), productSku: expect.any(String), productUnit: 'бр.', productBarcode: expect.any(String), avgCost: 1.5 })
  })

  it('a sort only an aggregation serves is cut as well', async () => {
    const { json } = await get('/invoicing/contact?size=0&prefer=customer')
    // The picker's ranking pages; "All" is the plain list's, cut.
    expect(json.contacts.length).toBeLessThanOrEqual(LIST_CEILING)
    const sorted = await get('/warehouse/movement?size=0&sortBy=toWarehouseName&sortOrder=asc')
    expect(sorted.json.stockMovements.length).toBeLessThanOrEqual(LIST_CEILING)
  })

  it('the chart of accounts is read whole: its "All" and its tree', async () => {
    const all = await get('/accounting/account?size=0')
    expect(all.json.accounts).toHaveLength(LIST_CEILING + 50)
    expect('truncated' in all.json).toBe(false)
    const tree = await get('/accounting/account?view=tree')
    expect(tree.json.accounts).toHaveLength(LIST_CEILING + 50)
  })

  it('a contact\'s figures count every document of the contact, read narrow', async () => {
    const { json } = await get(`/stats/contact/${customer}`)
    expect(json.stats.invoiceCount).toBe(120)
    // Open: the 80 sent ones and the 40 drafts, each owing 120 + i.
    expect(json.stats.openBalance).toBe(Array.from({ length: 120 }, (_, i) => 120 + i).reduce((a, b) => a + b, 0))
  })
})

describe('FR-30.10: a document names its lines\' articles', () => {
  it('each line of the document\'s read carries its article\'s name and SKU', async () => {
    const { status, json } = await get(`/invoices/${invoiceWithLines}`)
    expect(status).toBe(200)
    expect(json.invoice.lines).toHaveLength(12)
    expect(json.invoice.lines.map((l: any) => l.productName)).toEqual(Array.from({ length: 12 }, (_, k) => `Болт ${k}`))
    expect(json.invoice.lines[0].productSku).toBe('PRJ-000')
    // The line itself is as stored.
    expect(json.invoice.lines[0]).toMatchObject({ description: 'Болт DIN 933 М8Х25 ZN поцинкован 0', quantity: 1, unit: 'бр.' })
  })
})
