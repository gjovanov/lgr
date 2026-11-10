import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import {
  createTestOrg, createTestUser, createTestContact, createTestInvoice, createTestProduct, createTestStockLevel,
  createTestStockMovement, createTestWarehouse,
} from '../helpers/factories'
import { productController } from 'warehouse-api/src/controllers/product.controller'
import { stockLevelController } from 'warehouse-api/src/controllers/stock-level.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { Order } from 'db/models'
import { mongoose } from 'db/connection'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { runStockLevels } from 'services/biz/reports/stock-levels.report'
import { figureOf, hasStockFilter, parseStockFilter, passesStockFilter } from 'services/biz/product-stock-filter'

/**
 * FR-28.3 / .4 / .5 — the Products list's supplier and quantity filters.
 *
 * One fixture, every rule the spec pins (§6):
 *   - the range is on THE stock figure, an article with no stock row is at 0, a negative level is what it is;
 *   - "below minimum" is the Reports `stock-levels` rule, plus the articles that report drops for having no
 *     stock row; an unset minimum is no threshold, and a service never matches;
 *   - the warehouse filter keeps hiding what a warehouse does not hold, unless a quantity filter decides;
 *   - every filter ANDs with every other, `ids` still overrides the warehouse restriction, and the response
 *     keeps its shape.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(productController).use(stockLevelController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const { Types } = mongoose

/**
 * The list of articles a stock-taker sees. SKUs are `PRD-00xx`, in the order below:
 *
 *   PRD-0001 bolt        min 20  WH-A 4                  → short, tracked
 *   PRD-0002 nut         min 20  WH-A 31                 → fine
 *   PRD-0003 washer      min 30  no stock row            → short: 0 on hand, never stocked
 *   PRD-0004 anchor      no min  no stock row            → no threshold; out of stock
 *   PRD-0005 negative    min 10  WH-A -3                 → short, below zero
 *   PRD-0006 zero        min 5   WH-A 0                  → short, a level at zero (no badge)
 *   PRD-0007 consulting  min 10  service, no stock       → never matches a quantity filter
 *   PRD-0008 spread      min 50  WH-A 30 + WH-B 25       → fine in total (55), short in WH-A alone
 *   PRD-0009 retired     min 10  deactivated, no stock   → short, but not active
 */
async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const whA = await createTestWarehouse(org._id, { name: 'WH-A', code: 'A', isDefault: true } as any)
  const whB = await createTestWarehouse(org._id, { name: 'WH-B', code: 'B' } as any)
  const alfa = await createTestContact(org._id, { type: 'supplier', companyName: 'Alfa Fasteners' } as any)
  const beta = await createTestContact(org._id, { type: 'supplier', companyName: 'Beta Tools' } as any)

  const product = (sku: string, name: string, over: Record<string, unknown> = {}) =>
    createTestProduct(org._id, { sku, name, category: 'Bolts', type: 'goods', tags: [], isActive: true, ...over } as any)
  const p = {
    bolt: await product('PRD-0001', 'Hex bolt M8x40', { minStockLevel: 20, tags: ['seasonal'] }),
    nut: await product('PRD-0002', 'Hex nut M8', { minStockLevel: 20, category: 'Nuts' }),
    washer: await product('PRD-0003', 'Washer M8', { minStockLevel: 30, category: 'Nuts' }),
    anchor: await product('PRD-0004', 'Anchor 10x80', { minStockLevel: undefined }),
    negative: await product('PRD-0005', 'Oversold plug', { minStockLevel: 10 }),
    zero: await product('PRD-0006', 'Emptied clip', { minStockLevel: 5 }),
    consulting: await product('PRD-0007', 'Consulting hour', { minStockLevel: 10, trackInventory: false, type: 'service' }),
    spread: await product('PRD-0008', 'Spread bracket', { minStockLevel: 50 }),
    retired: await product('PRD-0009', 'Retired hinge', { minStockLevel: 10, isActive: false }),
  }
  const level = (prod: any, wh: any, quantity: number) =>
    createTestStockLevel(org._id, prod._id, wh._id, { quantity, availableQuantity: quantity, reservedQuantity: 0 })
  await level(p.bolt, whA, 4)
  await level(p.nut, whA, 31)
  await level(p.negative, whA, -3)
  await level(p.zero, whA, 0)
  await level(p.spread, whA, 30)
  await level(p.spread, whB, 25)

  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'a@t.test', username: 'u', firstName: 'A', lastName: 'B',
    permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
  async function get(path: string) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/warehouse${path}`, { headers: { authorization: `Bearer ${token}` } }))
    return { status: res.status, json: (await res.json().catch(() => null)) as any }
  }
  /** The SKUs the list answers with, in order. */
  const skus = async (query: string) => {
    const r = await get(`/product?size=0&sortBy=sku&sortOrder=asc${query ? `&${query}` : ''}`)
    expect(r.status).toBe(200)
    return (r.json.products as any[]).map((x) => x.sku)
  }
  /** An outgoing order, in the status the case needs: what makes an article's "on order" figure. */
  function order(status: string, prod: any, wh: any, quantity: number) {
    return Order.create({
      orgId: org._id, orderNumber: `ORDO-2026-${String(Math.floor(Math.random() * 90000) + 10000)}`, status,
      statusHistory: [{ status, changedAt: new Date() }], issueDate: new Date(), expectedDate: new Date('2026-12-01'),
      currency: 'EUR', exchangeRate: 1, createdBy: user._id,
      supplierGroups: [{ supplierId: alfa._id, lines: [{ productId: prod._id, description: prod.name, quantity, unit: 'pcs', allocations: [{ warehouseId: wh._id, quantity }] }] }],
    } as any)
  }
  let n = 0
  const bill = (supplier: any, prod: any) => createTestInvoice(org._id, supplier._id, {
    invoiceNumber: `BILL-2026-${String(++n).padStart(5, '0')}`, type: 'invoice', direction: 'incoming', status: 'received',
    lines: [{ productId: prod._id, description: prod.name, quantity: 1, unit: 'pcs', unitPrice: 1, discount: 0, taxRate: 20, taxAmount: 0, lineTotal: 1 }],
  } as any)

  return { org, orgId, user, whA, whB, alfa, beta, p, get, skus, order, bill, token }
}

const ALL = ['PRD-0001', 'PRD-0002', 'PRD-0003', 'PRD-0004', 'PRD-0005', 'PRD-0006', 'PRD-0007', 'PRD-0008', 'PRD-0009']

describe('the quantity filters are one rule (FR-28.4, .5)', () => {
  it('parses what the query says, and a value that is no number is no bound', () => {
    expect(parseStockFilter({ stockMin: '5', stockMax: '40', belowMin: 'true', basis: 'projected', warehouseId: 'w1' }))
      .toEqual({ stockMin: 5, stockMax: 40, belowMin: true, basis: 'projected', warehouseId: 'w1' })
    expect(parseStockFilter({ stockMin: '0', stockMax: '0' })).toEqual({ stockMin: 0, stockMax: 0 })
    expect(parseStockFilter({ stockMin: 'abc', stockMax: '', belowMin: 'false', basis: 'weird' })).toEqual({})
    expect(hasStockFilter(parseStockFilter({ stockMax: '0' }))).toBe(true)
    expect(hasStockFilter(parseStockFilter({ basis: 'projected', warehouseId: 'w1' }))).toBe(false)
  })

  it('passesStockFilter: the range is inclusive, a minimum must be set to be short of, a service never matches', () => {
    const tracked = { trackInventory: true, minStockLevel: 10 }
    expect(passesStockFilter(5, tracked, { stockMin: 5 })).toBe(true)
    expect(passesStockFilter(4.999, tracked, { stockMin: 5 })).toBe(false)
    expect(passesStockFilter(40, tracked, { stockMax: 40 })).toBe(true)
    expect(passesStockFilter(40.001, tracked, { stockMax: 40 })).toBe(false)
    expect(passesStockFilter(-3, tracked, { stockMax: 0 })).toBe(true)
    // Below minimum: strictly under, and only with a minimum above zero.
    expect(passesStockFilter(9.999, tracked, { belowMin: true })).toBe(true)
    expect(passesStockFilter(10, tracked, { belowMin: true })).toBe(false)
    expect(passesStockFilter(0, { trackInventory: true }, { belowMin: true })).toBe(false)
    expect(passesStockFilter(0, { trackInventory: true, minStockLevel: 0 }, { belowMin: true })).toBe(false)
    expect(passesStockFilter(0, { trackInventory: true, minStockLevel: null }, { belowMin: true })).toBe(false)
    // An article saved before `trackInventory` existed is tracked; only an explicit false is a service.
    expect(passesStockFilter(0, { minStockLevel: 10 }, { belowMin: true })).toBe(true)
    expect(passesStockFilter(0, { trackInventory: false, minStockLevel: 10 }, { belowMin: true })).toBe(false)
    expect(passesStockFilter(0, { trackInventory: false }, { stockMax: 0 })).toBe(false)
    // Several bounds AND.
    expect(passesStockFilter(7, tracked, { stockMin: 5, stockMax: 8, belowMin: true })).toBe(true)
    expect(passesStockFilter(9, tracked, { stockMin: 5, stockMax: 8, belowMin: true })).toBe(false)
  })

  it('figureOf: an article the figures do not name is at 0', () => {
    const figures = new Map([['a', 12], ['b', -3]])
    expect([figureOf(figures, 'a'), figureOf(figures, 'b'), figureOf(figures, 'never-stocked')]).toEqual([12, -3, 0])
  })
})

describe('GET /warehouse/product: the range on the stock figure', () => {
  it('stockMin and stockMax are inclusive, over the sum of the warehouses', async () => {
    const w = await world()
    expect(await w.skus('stockMin=31&stockMax=31')).toEqual(['PRD-0002'])
    // The spread article is 30 + 25: it is 55, not "30" and not "25".
    expect(await w.skus('stockMin=55&stockMax=55')).toEqual(['PRD-0008'])
    expect(await w.skus('stockMin=56')).toEqual([])
    expect(await w.skus('stockMin=4&stockMax=31')).toEqual(['PRD-0001', 'PRD-0002'])
    expect(await w.skus('stockMin=100')).toEqual([])
  })

  it('an article with no stock row is at 0, a level at 0 is 0, and a negative level is what it is', async () => {
    const w = await world()
    // Out of stock = at most 0: never stocked (0003, 0004, 0009), a level at zero (0006), below zero (0005).
    // 0007 is a service and has no stock to be out of.
    expect(await w.skus('stockMax=0')).toEqual(['PRD-0003', 'PRD-0004', 'PRD-0005', 'PRD-0006', 'PRD-0009'])
    expect(await w.skus('stockMax=0&isActive=true')).toEqual(['PRD-0003', 'PRD-0004', 'PRD-0005', 'PRD-0006'])
    expect(await w.skus('stockMin=0&stockMax=0&isActive=true')).toEqual(['PRD-0003', 'PRD-0004', 'PRD-0006'])
    expect(await w.skus('stockMax=-1')).toEqual(['PRD-0005'])
  })

  it('a service never matches a quantity filter, and still lists without one', async () => {
    const w = await world()
    for (const q of ['stockMax=0', 'stockMin=0', 'belowMin=true', 'stockMin=-100&stockMax=100']) {
      expect(await w.skus(q)).not.toContain('PRD-0007')
    }
    expect(await w.skus('')).toContain('PRD-0007')
    expect(await w.skus('type=service')).toEqual(['PRD-0007'])
  })

  it('the figure is the Stock cell: the by-products badges sum to what the filter reads', async () => {
    const w = await world()
    const cell = async (prod: any) => {
      const r = await w.get(`/stock-level/by-products?productIds=${prod._id}`)
      return (r.json.stock[String(prod._id)] || []).reduce((s: number, b: any) => s + b.quantity, 0)
    }
    for (const prod of Object.values(w.p)) {
      const shown = await cell(prod)
      // The cell's figure pinned as a one-point range: the filter reads the same number.
      const hits = await w.skus(`stockMin=${shown}&stockMax=${shown}&isActive=${prod.isActive ? 'true' : 'false'}`)
      if (prod.trackInventory === false) expect(hits).not.toContain(prod.sku)
      else expect({ sku: prod.sku, found: hits.includes(prod.sku) }).toEqual({ sku: prod.sku, found: true })
    }
  })
})

describe('GET /warehouse/product: below minimum (FR-28.5)', () => {
  it('lists what is under its own minimum, the never-stocked included, an unset minimum and a service not', async () => {
    const w = await world()
    // 0001 (4<20), 0003 (0<30), 0005 (-3<10), 0006 (0<5), 0009 (0<10, retired). Not 0002 (31), 0004 (no min),
    // 0007 (service), 0008 (55 ≥ 50).
    expect(await w.skus('belowMin=true')).toEqual(['PRD-0001', 'PRD-0003', 'PRD-0005', 'PRD-0006', 'PRD-0009'])
    expect(await w.skus('belowMin=true&isActive=true')).toEqual(['PRD-0001', 'PRD-0003', 'PRD-0005', 'PRD-0006'])
  })

  it('contains everything the Reports stock-levels report lists, and the articles that report drops for having no stock row', async () => {
    const w = await world()
    const listed = new Set(await w.skus('belowMin=true'))
    const report = await runStockLevels({ orgId: w.orgId, output: 'table', params: { groupBy: 'product', belowMin: true, includeZero: true } })
    const reported = new Set(report.rows.map((r: any) => String(r.sku)))
    expect(reported.size).toBeGreaterThan(0)
    for (const sku of reported) expect({ sku, listed: listed.has(sku) }).toEqual({ sku, listed: true })
    // What the report cannot see: no stock row at all — exactly what a reorder list is for.
    const dropped = [...listed].filter((sku) => !reported.has(sku)).sort()
    expect(dropped).toEqual(['PRD-0003', 'PRD-0009'])
  })

  it('with a warehouse chosen, the figure is that warehouse\'s and the quantity filter decides who is listed', async () => {
    const w = await world()
    // WH-A: 0001 has 4 (<20), 0003 and 0009 have none (0), 0005 has -3, 0006 has 0, 0008 has 30 (<50: short HERE,
    // though 55 in total). 0002 has 31 (≥20).
    expect(await w.skus(`belowMin=true&warehouseId=${w.whA._id}`)).toEqual(['PRD-0001', 'PRD-0003', 'PRD-0005', 'PRD-0006', 'PRD-0008', 'PRD-0009'])
    // WH-B holds only the spread article (25 < 50): everything else is at 0 there, so everything with a minimum is short.
    expect(await w.skus(`belowMin=true&warehouseId=${w.whB._id}&isActive=true`)).toEqual(['PRD-0001', 'PRD-0002', 'PRD-0003', 'PRD-0005', 'PRD-0006', 'PRD-0008'])
    expect(await w.skus(`stockMax=0&warehouseId=${w.whB._id}&isActive=true`)).toEqual(['PRD-0001', 'PRD-0002', 'PRD-0003', 'PRD-0004', 'PRD-0005', 'PRD-0006'])
  })

  it('the Reports rule, per warehouse, is contained in the list\'s answer for that warehouse', async () => {
    const w = await world()
    const listed = new Set(await w.skus(`belowMin=true&warehouseId=${w.whA._id}`))
    const report = await runStockLevels({ orgId: w.orgId, output: 'table', params: { warehouseId: String(w.whA._id), belowMin: true, includeZero: true } })
    expect(report.rows.length).toBeGreaterThan(0)
    for (const row of report.rows as any[]) expect({ sku: row.sku, listed: listed.has(row.sku) }).toEqual({ sku: row.sku, listed: true })
  })

  it('counting open orders: on hand − reserved + on order is the figure', async () => {
    const w = await world()
    // 0001 has 4 of a minimum of 20: short. 30 more are on a sent order: 34, no longer short.
    await w.order('sent', w.p.bolt, w.whA, 30)
    expect(await w.skus('belowMin=true&isActive=true')).toContain('PRD-0001')
    expect(await w.skus('belowMin=true&isActive=true&basis=projected')).not.toContain('PRD-0001')
    // A draft order brings nothing.
    const w2 = await world()
    await w2.order('draft', w2.p.bolt, w2.whA, 30)
    expect(await w2.skus('belowMin=true&isActive=true&basis=projected')).toContain('PRD-0001')
    // The basis alone changes the figure, not the rows.
    expect(await w2.skus('basis=projected')).toEqual(ALL)
  })
})

describe('GET /warehouse/product: the warehouse restriction (FR-28.3)', () => {
  it('without a quantity filter the warehouse still lists only what it holds (quantity above zero)', async () => {
    const w = await world()
    expect(await w.skus(`warehouseId=${w.whA._id}`)).toEqual(['PRD-0001', 'PRD-0002', 'PRD-0008'])
    expect(await w.skus(`warehouseId=${w.whB._id}`)).toEqual(['PRD-0008'])
  })

  it('`ids` still overrides the warehouse restriction, and narrows the new filters', async () => {
    const w = await world()
    const ids = `${w.p.washer._id},${w.p.nut._id}`
    // Neither is held in WH-B, and `ids` wins over that restriction, as before.
    expect(await w.skus(`warehouseId=${w.whB._id}&ids=${ids}`)).toEqual(['PRD-0002', 'PRD-0003'])
    // …and a quantity filter ANDs with the ids: only the short one of the two.
    expect(await w.skus(`belowMin=true&ids=${ids}`)).toEqual(['PRD-0003'])
    expect(await w.skus('belowMin=true&ids=not-an-id')).toEqual([])
  })
})

describe('GET /warehouse/product: every filter ANDs with every other', () => {
  it('combines with search, category, type, tags and status', async () => {
    const w = await world()
    expect(await w.skus('belowMin=true&search=Hex')).toEqual(['PRD-0001'])
    expect(await w.skus('belowMin=true&category=Nuts')).toEqual(['PRD-0003'])
    expect(await w.skus('belowMin=true&category=Bolts&isActive=true')).toEqual(['PRD-0001', 'PRD-0005', 'PRD-0006'])
    expect(await w.skus('belowMin=true&tags=seasonal')).toEqual(['PRD-0001'])
    expect(await w.skus('belowMin=true&type=service')).toEqual([])
    expect(await w.skus('stockMax=0&isActive=false')).toEqual(['PRD-0009'])
  })

  it('combines with the supplier filters, and the supplier filters with each other', async () => {
    const w = await world()
    await w.bill(w.alfa, w.p.bolt)
    await w.bill(w.alfa, w.p.nut)
    await w.bill(w.beta, w.p.nut)
    await w.bill(w.beta, w.p.spread)
    expect(await w.skus(`supplierId=${w.alfa._id}`)).toEqual(['PRD-0001', 'PRD-0002'])
    expect(await w.skus(`supplierId=${w.beta._id}`)).toEqual(['PRD-0002', 'PRD-0008'])
    // Several suppliers: any of them.
    expect(await w.skus(`supplierId=${w.alfa._id},${w.beta._id}`)).toEqual(['PRD-0001', 'PRD-0002', 'PRD-0008'])
    // No supplier: the rest.
    expect(await w.skus('noSupplier=true')).toEqual(['PRD-0003', 'PRD-0004', 'PRD-0005', 'PRD-0006', 'PRD-0007', 'PRD-0009'])
    // With a quantity filter, search, category, a warehouse and ids.
    expect(await w.skus(`supplierId=${w.alfa._id},${w.beta._id}&belowMin=true`)).toEqual(['PRD-0001'])
    expect(await w.skus('noSupplier=true&belowMin=true&isActive=true')).toEqual(['PRD-0003', 'PRD-0005', 'PRD-0006'])
    expect(await w.skus(`supplierId=${w.beta._id}&search=nut`)).toEqual(['PRD-0002'])
    expect(await w.skus(`supplierId=${w.beta._id}&category=Nuts`)).toEqual(['PRD-0002'])
    expect(await w.skus(`supplierId=${w.beta._id}&warehouseId=${w.whB._id}`)).toEqual(['PRD-0008'])
    expect(await w.skus(`supplierId=${w.alfa._id}&ids=${w.p.nut._id},${w.p.washer._id}`)).toEqual(['PRD-0002'])
    // Both supplier filters at once: an article cannot be bought from Alfa and from no one.
    expect(await w.skus(`supplierId=${w.alfa._id}&noSupplier=true`)).toEqual([])
    // A supplier nobody bought from, and an id that is none.
    expect(await w.skus(`supplierId=${new Types.ObjectId()}`)).toEqual([])
    expect(await w.skus('supplierId=nope')).toEqual([])
  })

  it('a bill that is not received brings no supplier: the filters follow the documents', async () => {
    const w = await world()
    const b = await w.bill(w.alfa, w.p.bolt)
    expect(await w.skus(`supplierId=${w.alfa._id}`)).toEqual(['PRD-0001'])
    await (await import('db/models')).Invoice.updateOne({ _id: b._id }, { $set: { status: 'voided' } })
    expect(await w.skus(`supplierId=${w.alfa._id}`)).toEqual([])
    expect(await w.skus('noSupplier=true')).toEqual(ALL)
  })

  it('a receipt that names its supplier counts for the filter', async () => {
    const w = await world()
    await createTestStockMovement(w.org._id, {
      type: 'receipt', status: 'completed', contactId: w.alfa._id,
      lines: [{ productId: w.p.washer._id, quantity: 5, unitCost: 1, totalCost: 5 }],
    } as any)
    expect(await w.skus(`supplierId=${w.alfa._id}`)).toEqual(['PRD-0003'])
  })
})

describe('GET /warehouse/product: what does not change', () => {
  it('keeps the response shape, with and without the new filters', async () => {
    const w = await world()
    for (const q of ['', 'belowMin=true', 'stockMax=0', `warehouseId=${w.whA._id}&belowMin=true`, 'noSupplier=true']) {
      const r = await w.get(`/product?${q}`)
      expect(Object.keys(r.json).sort()).toEqual(['items', 'page', 'products', 'size', 'total', 'totalPages'])
    }
  })

  it('pages and counts the filtered answer, in every sort', async () => {
    const w = await world()
    const page = async (query: string) => (await w.get(`/product?${query}`)).json
    const first = await page('belowMin=true&isActive=true&size=2&page=0&sortBy=sku&sortOrder=asc')
    const second = await page('belowMin=true&isActive=true&size=2&page=1&sortBy=sku&sortOrder=asc')
    expect(first).toMatchObject({ total: 4, totalPages: 2, size: 2, page: 0 })
    expect(first.products.map((x: any) => x.sku)).toEqual(['PRD-0001', 'PRD-0003'])
    expect(second.products.map((x: any) => x.sku)).toEqual(['PRD-0005', 'PRD-0006'])
    // The stock column sorts by its figure over exactly the filtered articles.
    const byStock = await page('belowMin=true&isActive=true&size=0&sortBy=stock&sortOrder=desc')
    expect(byStock.total).toBe(4)
    expect(byStock.products[0].sku).toBe('PRD-0001')
    const byName = await page('belowMin=true&isActive=true&size=0&sortBy=name&sortOrder=asc')
    expect(byName.products.map((x: any) => x.name)).toEqual(['Emptied clip', 'Hex bolt M8x40', 'Oversold plug', 'Washer M8'])
  })

  it('a value that is no number is no bound: the list is as unfiltered', async () => {
    const w = await world()
    expect(await w.skus('stockMin=abc&stockMax=&belowMin=false')).toEqual(ALL)
  })
})

describe('the Stock-levels page: "low stock only" is the same below minimum', () => {
  it('lists only the levels of articles under their minimum', async () => {
    const w = await world()
    const r = await w.get('/stock-level?size=0&lowStockOnly=true')
    expect(r.status).toBe(200)
    const names = (r.json.stockLevels as any[]).map((l) => l.productSku).sort()
    // 0001, 0005 and 0006 have a level and are short; 0008 is 55 in total, so its two levels are not.
    expect(names).toEqual(['PRD-0001', 'PRD-0005', 'PRD-0006'])
    const all = await w.get('/stock-level?size=0')
    expect(all.json.total).toBe(6)
  })

  it('with a warehouse chosen it is that warehouse\'s quantity against the minimum', async () => {
    const w = await world()
    const r = await w.get(`/stock-level?size=0&lowStockOnly=true&warehouseId=${w.whA._id}`)
    // WH-A: the spread article is 30 of 50 there, so its WH-A level is listed (and only that one).
    const rows = (r.json.stockLevels as any[]).map((l) => `${l.productSku}@${l.warehouseName}`).sort()
    expect(rows).toEqual(['PRD-0001@WH-A', 'PRD-0005@WH-A', 'PRD-0006@WH-A', 'PRD-0008@WH-A'])
  })

  it('narrows what the page already filtered by search, and by a product', async () => {
    const w = await world()
    const search = await w.get('/stock-level?size=0&lowStockOnly=true&search=Hex')
    expect((search.json.stockLevels as any[]).map((l) => l.productSku)).toEqual(['PRD-0001'])
    const one = await w.get(`/stock-level?size=0&lowStockOnly=true&productId=${w.p.nut._id}`)
    expect(one.json.stockLevels).toEqual([])
    const bolt = await w.get(`/stock-level?size=0&lowStockOnly=true&productId=${w.p.bolt._id}`)
    expect(bolt.json.stockLevels).toHaveLength(1)
  })
})
