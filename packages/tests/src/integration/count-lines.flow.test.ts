import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestProduct, createTestStockLevel, createTestUser, createTestWarehouse } from '../helpers/factories'
import { createApiApp } from '../../../api/src/api.js'
import { spaErrorHandler } from '../../../api/src/spa-fallback.js'
import { config } from 'config'
import { withImplied } from 'config/access'
import { InventoryCount, StockLevel, StockMovement, User } from 'db/models'
import { tokenize } from 'services/biz/auth.service'
import { nextCountNumber } from 'services/biz/count-number'

/**
 * FR-33 slice B-server (#933): what a stock count must hold once articles can be added to it one by one.
 *
 * - FR-33.13: one line per article. POST, PUT and `/complete` answer 422 `count_article_repeated`, naming the
 *   articles; `/complete` before it books anything. Two lines of one article booked its difference twice.
 * - FR-33.14: a count with lines keeps its warehouse: PUT answers 422 `count_warehouse_locked`.
 * - FR-33.15 (D-4): found goods (no level in the count's warehouse, or a level without an average cost) are priced at
 *   the article's purchase price, never at 0, and the completion opens the level at that cost.
 * - FR-33.11: `GET /warehouse/product/lookup` answers as the till's `GET /trade/pos/catalog/lookup` does.
 * - FR-33.17: a role made with the count capabilities alone reads products, stock levels, warehouses and categories.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: Elysia
let org: any
let orgId: string
let admin: string
let main: any
let annex: any
const ids: Record<string, string> = {}

async function call(method: string, path: string, body?: unknown, token = admin) {
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
const idOf = (doc: any) => String(doc?.id ?? doc?._id)
const line = (key: string, systemQuantity: number, countedQuantity: number) => ({ productId: ids[key], systemQuantity, countedQuantity, variance: countedQuantity - systemQuantity })
const level = async (key: string, warehouse = main) => (await StockLevel.findOne({ orgId: org._id, productId: ids[key], warehouseId: warehouse._id }).lean().exec()) as any
const counts = () => InventoryCount.countDocuments({ orgId: org._id }).exec()
const stored = async (id: string) => (await InventoryCount.findById(id).lean().exec()) as any

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  org = await createTestOrg({ slug: 'count-lines' } as any)
  orgId = String(org._id)
  const person = await createTestUser(org._id, { role: 'admin', username: 'admin', email: 'admin@count-lines.test' } as any)
  admin = await sign(person._id)
  main = await createTestWarehouse(org._id, { name: 'Main', code: 'CL-MAIN', isDefault: true } as any)
  annex = await createTestWarehouse(org._id, { name: 'Annex', code: 'CL-ANNEX' } as any)

  const make = async (key: string, fields: Record<string, unknown>) => { ids[key] = String((await createTestProduct(org._id, fields as any))._id) }
  // ⚠ Fixed SKUs: the factory's own is `SKU-<timestamp>`, whose digits can contain any code here.
  await make('bolt', { name: 'Болт DIN 933 М8х20', sku: 'CL-B8', barcode: '3800000000017', purchasePrice: 5 })
  await make('washer', { name: 'Шайба пружинна М10', sku: 'CL-W10', barcode: '3800000000024', purchasePrice: 4 })
  await make('nut', { name: 'Гайка DIN 934 М8', sku: 'CL-N8', purchasePrice: 3 })
  await make('pin', { name: 'Щифт без цена', sku: 'CL-PIN', purchasePrice: 0 })
  await make('screw', { name: 'Винт DIN 7985 М4', sku: 'CL-S4', purchasePrice: 2 })
  // One product's barcode is another one's SKU; two articles sharing a barcode.
  await make('byBarcode', { name: 'Анкер с код', sku: 'CL-ANK', barcode: 'X-100' })
  await make('bySku', { name: 'Анкер с артикул', sku: 'X-100' })
  await make('twinA', { name: 'Дюбел двойник А', sku: 'CL-TW-A', barcode: '4000000000001' })
  await make('twinB', { name: 'Дюбел двойник Б', sku: 'CL-TW-B', barcode: '4000000000001' })

  await createTestStockLevel(org._id, ids.bolt as any, main._id, { quantity: 100, availableQuantity: 100, avgCost: 5 })
  await createTestStockLevel(org._id, ids.screw as any, main._id, { quantity: 40, availableQuantity: 40, avgCost: 2 })
  // A level with no average cost: found goods too.
  await createTestStockLevel(org._id, ids.nut as any, main._id, { quantity: 0, availableQuantity: 0, avgCost: 0 })
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('FR-33.13 one line per article', () => {
  it('POST: a count naming an article twice is refused, names it, and takes no number', async () => {
    const before = await counts()
    const next = await nextCountNumber(orgId)
    const r = await call('POST', '/warehouse/inventory-count', {
      warehouseId: String(main._id), date: '2026-11-25', type: 'partial',
      lines: [line('bolt', 100, 98), line('screw', 40, 40), line('bolt', 100, 98)],
    })
    expect([r.status, r.json?.code]).toEqual([422, 'count_article_repeated'])
    expect(r.json.productIds).toEqual([ids.bolt])
    expect(r.json.repeated).toEqual([{ productId: ids.bolt, name: 'Болт DIN 933 М8х20', sku: 'CL-B8', lines: [1, 3] }])
    expect(r.json.articles).toBe('Болт DIN 933 М8х20 (CL-B8)')
    expect(r.json.message).toContain('lines 1, 3')
    expect(await counts()).toBe(before)
    // The refusal drew no number: the next count takes the one after the probe above.
    const ok = await call('POST', '/warehouse/inventory-count', { warehouseId: String(main._id), date: '2026-11-25', type: 'partial', lines: [line('bolt', 100, 100)] })
    expect(ok.status).toBe(200)
    expect(Number(ok.json.inventoryCount.countNumber.split('-').pop())).toBe(Number(next.split('-').pop()) + 1)
    await call('DELETE', `/warehouse/inventory-count/${idOf(ok.json.inventoryCount)}`)
  })

  it('PUT: lines that name an article twice are refused, and the count is unchanged', async () => {
    const made = await call('POST', '/warehouse/inventory-count', { warehouseId: String(main._id), date: '2026-11-25', type: 'partial', lines: [line('bolt', 100, 97)] })
    expect(made.status).toBe(200)
    const id = idOf(made.json.inventoryCount)
    const r = await call('PUT', `/warehouse/inventory-count/${id}`, { lines: [line('bolt', 100, 97), line('screw', 40, 41), line('screw', 40, 39), line('bolt', 100, 99)] })
    expect([r.status, r.json?.code]).toEqual([422, 'count_article_repeated'])
    expect(r.json.productIds.sort()).toEqual([ids.bolt, ids.screw].sort())
    expect((await stored(id)).lines.map((l: any) => [String(l.productId), l.countedQuantity])).toEqual([[ids.bolt, 97]])
    // A PUT that leaves the lines alone is not asked about them.
    expect((await call('PUT', `/warehouse/inventory-count/${id}`, { notes: 'преброено' })).status).toBe(200)
    await call('DELETE', `/warehouse/inventory-count/${id}`)
  })

  it('complete: a stored count that names an article twice is refused before anything is booked', async () => {
    // Saved before the rule, or past the routes.
    const doc: any = await InventoryCount.create({
      orgId: org._id, countNumber: await nextCountNumber(orgId), warehouseId: main._id, date: new Date(), type: 'partial', status: 'in_progress',
      lines: [{ ...line('bolt', 100, 98), varianceCost: -10 }, { ...line('bolt', 100, 98), varianceCost: -10 }], createdBy: (await User.findOne({ orgId: org._id }).lean().exec() as any)._id,
    } as any)
    const r = await call('POST', `/warehouse/inventory-count/${doc._id}/complete`, {})
    expect([r.status, r.json?.code]).toEqual([422, 'count_article_repeated'])
    expect(r.json.repeated[0].lines).toEqual([1, 2])
    expect((await level('bolt')).quantity).toBe(100)
    expect(await StockMovement.countDocuments({ orgId: org._id, inventoryCountId: doc._id }).exec()).toBe(0)
    const after = await stored(String(doc._id))
    expect([after.status, 'leaseUntil' in after && after.leaseUntil !== null]).toEqual(['in_progress', false])
    await InventoryCount.deleteOne({ _id: doc._id }).exec()
  })

  it('the count a manual adjustment makes for itself is still made for a movement with a repeated article', async () => {
    const made = await call('POST', '/warehouse/movement', {
      type: 'adjustment', date: '2026-11-25', toWarehouseId: String(annex._id),
      lines: [{ productId: ids.screw, quantity: 2, unitCost: 2, totalCost: 4 }, { productId: ids.screw, quantity: 3, unitCost: 2, totalCost: 6 }],
      totalAmount: 10,
    })
    expect(made.status).toBe(200)
    const movementId = idOf(made.json.stockMovement)
    const confirmed = await call('POST', `/warehouse/movement/${movementId}/confirm`, { createCount: true })
    expect(confirmed.status).toBe(200)
    const movement: any = await StockMovement.findById(movementId).lean().exec()
    const count = await stored(String(movement.inventoryCountId))
    expect([count.status, count.lines.length, count.lines.every((l: any) => String(l.productId) === ids.screw)]).toEqual(['completed', 2, true])
  })
})

describe('FR-33.14 a count with lines keeps its warehouse', () => {
  it('PUT: another warehouse on a count with lines is refused; the same one, or none named, saves', async () => {
    const made = await call('POST', '/warehouse/inventory-count', { warehouseId: String(main._id), date: '2026-11-25', type: 'partial', lines: [line('bolt', 100, 96)] })
    const id = idOf(made.json.inventoryCount)

    const moved = await call('PUT', `/warehouse/inventory-count/${id}`, { warehouseId: String(annex._id) })
    expect([moved.status, moved.json?.code, moved.json?.lines]).toEqual([422, 'count_warehouse_locked', 1])
    // With new lines as well: still the first warehouse's count.
    const withLines = await call('PUT', `/warehouse/inventory-count/${id}`, { warehouseId: String(annex._id), lines: [line('screw', 0, 5)] })
    expect([withLines.status, withLines.json?.code]).toEqual([422, 'count_warehouse_locked'])
    const kept = await stored(id)
    expect([String(kept.warehouseId), kept.lines.map((l: any) => String(l.productId))]).toEqual([String(main._id), [ids.bolt]])

    // The form sends the warehouse back as loaded.
    expect((await call('PUT', `/warehouse/inventory-count/${id}`, { warehouseId: String(main._id), lines: [line('bolt', 100, 95)] })).status).toBe(200)
    expect((await stored(id)).lines[0].countedQuantity).toBe(95)
    await call('DELETE', `/warehouse/inventory-count/${id}`)
  })

  it('a count with no lines changes its warehouse, and so does one whose every line the same save removes', async () => {
    const empty = await call('POST', '/warehouse/inventory-count', { warehouseId: String(main._id), date: '2026-11-25', type: 'partial', lines: [] })
    const emptyId = idOf(empty.json.inventoryCount)
    expect((await call('PUT', `/warehouse/inventory-count/${emptyId}`, { warehouseId: String(annex._id) })).status).toBe(200)
    expect(String((await stored(emptyId)).warehouseId)).toBe(String(annex._id))
    // Empty, it takes its first lines in another warehouse in the same save.
    expect((await call('PUT', `/warehouse/inventory-count/${emptyId}`, { warehouseId: String(main._id), lines: [line('bolt', 100, 100)] })).status).toBe(200)
    expect(String((await stored(emptyId)).warehouseId)).toBe(String(main._id))

    const full = await call('POST', '/warehouse/inventory-count', { warehouseId: String(main._id), date: '2026-11-25', type: 'partial', lines: [line('bolt', 100, 99)] })
    const fullId = idOf(full.json.inventoryCount)
    expect((await call('PUT', `/warehouse/inventory-count/${fullId}`, { warehouseId: String(annex._id), lines: [] })).status).toBe(200)
    const moved = await stored(fullId)
    expect([String(moved.warehouseId), moved.lines.length]).toEqual([String(annex._id), 0])
    await call('DELETE', `/warehouse/inventory-count/${emptyId}`)
    await call('DELETE', `/warehouse/inventory-count/${fullId}`)
  })
})

describe('FR-33.15 found goods are priced by the server (D-4)', () => {
  it('no level, or a level without an average cost: the purchase price; with neither, 0; on save and at completion', async () => {
    const made = await call('POST', '/warehouse/inventory-count', {
      warehouseId: String(main._id), date: '2026-11-25', type: 'partial',
      lines: [
        { ...line('washer', 0, 5), varianceCost: 0 }, // no level here: the purchase price, 4
        { ...line('nut', 0, 10), varianceCost: 999 }, // a level at no average cost: the purchase price, 3
        line('pin', 0, 2), // no level, no purchase price: 0
        line('bolt', 100, 98), // a level at its average cost, 5, as before
      ],
    })
    expect(made.status).toBe(200)
    const id = idOf(made.json.inventoryCount)
    expect((await stored(id)).lines.map((l: any) => l.varianceCost)).toEqual([20, 30, 0, -10])

    const done = await call('POST', `/warehouse/inventory-count/${id}/complete`, {})
    expect(done.status).toBe(200)
    const adjustment: any = await StockMovement.findOne({ orgId: org._id, inventoryCountId: id }).lean().exec()
    const byProduct = new Map(adjustment.lines.map((l: any) => [String(l.productId), l]))
    expect(byProduct.get(ids.washer)).toMatchObject({ quantity: 5, unitCost: 4, totalCost: 20 })
    expect(byProduct.get(ids.nut)).toMatchObject({ quantity: 10, unitCost: 3, totalCost: 30 })
    // The completion opened the washer's level at that cost, not at 0, and gave the nut's level its cost.
    expect([(await level('washer')).quantity, (await level('washer')).avgCost]).toEqual([5, 4])
    expect([(await level('nut')).quantity, (await level('nut')).avgCost]).toEqual([10, 3])
    expect((await level('bolt')).quantity).toBe(98)
  })

  it('the cost comes from the count\'s warehouse: an article stocked elsewhere is found goods here', async () => {
    const made = await call('POST', '/warehouse/inventory-count', { warehouseId: String(annex._id), date: '2026-11-25', type: 'partial', lines: [line('bolt', 0, 2)] })
    expect(made.status).toBe(200)
    // Main holds the bolt at 5; Annex has no level: the purchase price, 5 as well, from the article.
    expect((await stored(idOf(made.json.inventoryCount))).lines[0].varianceCost).toBe(10)
    await call('DELETE', `/warehouse/inventory-count/${idOf(made.json.inventoryCount)}`)
  })
})

describe('FR-33.11 the code lookup, at the till and in the warehouse', () => {
  const till = (code: string) => call('GET', `/trade/pos/catalog/lookup?code=${encodeURIComponent(code)}`)
  const warehouse = (code: string) => call('GET', `/warehouse/product/lookup?code=${encodeURIComponent(code)}`)

  it('answers alike on a barcode, a SKU, a search and an ambiguity', async () => {
    const cases: Array<[string, string | null, string | null]> = [
      ['3800000000017', 'bolt', 'barcode'],
      ['X-100', 'byBarcode', 'barcode'], // a barcode outranks a SKU
      ['cl-w10', 'washer', 'sku'], // any case
      ['пружинна', 'washer', 'search'], // the one article the search finds
      ['4000000000001', null, null], // two articles share the barcode
      ['DIN', null, null], // the search finds several
      ['', null, null],
      ['nothing-like-it', null, null],
    ]
    for (const [code, key, matchedBy] of cases) {
      const [t, w] = [await till(code), await warehouse(code)]
      expect([code, t.status, w.status]).toEqual([code, 200, 200])
      const expected = key ? ids[key] : null
      expect([code, t.json.product?.productId ?? null, t.json.matchedBy]).toEqual([code, expected, matchedBy])
      expect([code, w.json.product ? idOf(w.json.product) : null, w.json.matchedBy]).toEqual([code, expected, matchedBy])
    }
    // The warehouse route answers the article as `GET /warehouse/product/:id` does.
    const one = await warehouse('CL-B8')
    expect([one.json.product.name, one.json.product.sku, one.json.product.unit]).toEqual(['Болт DIN 933 М8х20', 'CL-B8', 'pcs'])
  })
})

describe('FR-33.17 the count capabilities imply the lookups', () => {
  it('withImplied gives the two count capabilities the four lookups', () => {
    for (const cap of ['inventory-counts.create', 'inventory-counts.edit'] as const) {
      expect(withImplied([cap])).toEqual(expect.arrayContaining(['products.lookup', 'stock-levels.lookup', 'warehouses.lookup', 'categories.lookup']))
    }
    expect(withImplied(['inventory-counts.view'])).toEqual(['inventory-counts.view'])
  })

  it('a role saved with the count capabilities alone reads products, stock levels, warehouses and categories, and counts', async () => {
    const role = await call('POST', '/roles', { name: 'Counter only', caps: ['inventory-counts.view', 'inventory-counts.create', 'inventory-counts.edit'] })
    expect(role.status).toBe(200)
    expect(role.json.role.caps).toEqual(expect.arrayContaining(['products.lookup', 'stock-levels.lookup', 'warehouses.lookup', 'categories.lookup']))
    const person = await createTestUser(org._id, { role: 'member', username: 'counter', email: 'counter@count-lines.test' } as any)
    expect((await call('PUT', `/user/${person._id}`, { roleId: idOf(role.json.role) })).status).toBe(200)
    const token = await sign(person._id)

    for (const path of [
      '/warehouse/product?search=Болт',
      `/warehouse/product/${ids.bolt}`,
      '/warehouse/product/lookup?code=CL-B8',
      `/warehouse/stock-level?warehouseId=${main._id}`,
      `/warehouse/stock-level/by-products?warehouseId=${main._id}&productIds=${ids.bolt}`,
      '/warehouse/warehouse',
      '/warehouse/product-category',
    ]) {
      const r = await call('GET', path, undefined, token)
      expect([path, r.status]).toEqual([path, 200])
    }
    // The hit carries no cost and no price (FR-33.17: the count form shows none).
    const hit = await call('GET', '/warehouse/product/lookup?code=CL-B8', undefined, token)
    expect([hit.json.product.purchasePrice, hit.json.product.sellingPrice]).toEqual([undefined, undefined])

    const made = await call('POST', '/warehouse/inventory-count', { warehouseId: String(main._id), date: '2026-11-25', type: 'partial', lines: [line('bolt', 98, 98)] }, token)
    expect(made.status).toBe(200)
    await call('DELETE', `/warehouse/inventory-count/${idOf(made.json.inventoryCount)}`)
  })
})
