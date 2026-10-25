import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser, createTestProduct, createTestWarehouse, createTestStockLevel } from '../helpers/factories'
import { posController } from 'invoicing-api/src/controllers/pos.controller'
import { Product } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS, type Role } from 'config/constants'
import { pinScopeRefusal, readRuleFor } from 'services/biz/route-permission'

/**
 * FR-22.55 — Enter in a terminal's search adds the article whose barcode or SKU is the code.
 *
 * A barcode scanner types the code and presses Enter within milliseconds. The till never added
 * anything on Enter (a scan only filtered the grid), and the cash-sale terminal added a card
 * only when the grid already showed exactly one — which it never did yet, because the scanner's
 * Enter lands before the search's 300 ms debounce has filtered it. Both terminals now ask
 * `GET /trade/pos/catalog/lookup`, which resolves the code on the server: the exact barcode,
 * else the exact SKU, else the one product the grid's own search finds — and never a guess.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const LOOKUP_ROUTE = '/api/org/:orgId/trade/pos/catalog/lookup'

let app: Elysia
let orgId: string
let otherOrgId: string
let warehouseId: string
const tokens: Record<string, string> = {}
const ids: Record<string, string> = {}

async function sign(role: Role, org: string, userId: string) {
  return (signer as any).decorator.jwt.sign({
    id: userId, orgId: org, role, email: `${role}@lookup.test`, username: role,
    firstName: 'Каса', lastName: 'Тест', permissions: DEFAULT_ROLE_PERMISSIONS[role], ownRecordsModules: [],
  })
}

async function get(path: string, token: string | null = tokens.sales) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  }))
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

/** What both terminals send on Enter: the code, plus the grid's own parameters. */
async function lookup(code: string, params: Record<string, string> = {}, token?: string) {
  const qs = Object.entries({ code, ...params }).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
  const { status, json } = await get(`/org/${orgId}/trade/pos/catalog/lookup?${qs}`, token)
  expect(status).toBe(200)
  return json as { product: any; matchedBy: string | null }
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(posController) as any

  const org = await createTestOrg()
  orgId = String(org._id)
  const other = await createTestOrg()
  otherOrgId = String(other._id)
  const user = await createTestUser(org._id)
  for (const role of ['sales', 'accountant', 'hr_manager', 'warehouse_manager'] as Role[]) {
    tokens[role] = await sign(role, orgId, String(user._id))
  }

  const wh = await createTestWarehouse(org._id)
  warehouseId = String(wh._id)

  const make = async (key: string, fields: Record<string, any>, orgOf = org._id) => {
    const p = await createTestProduct(orgOf, fields as any)
    ids[key] = String(p._id)
    return p
  }
  // ⚠ Fixed SKUs: the factory's own is `SKU-<timestamp>`, whose digits can contain any code here.
  const bolt8 = await make('bolt8', { name: 'Болт DIN 933 М8х20', sku: 'LK-B8', barcode: '3800000000017', category: 'Болтове' })
  await make('bolt10', { name: 'Болт DIN 933 М10х30', sku: 'LK-B10', barcode: '3800000000024', category: 'Болтове' })
  await make('washer', { name: 'Шайба DIN 125 М10', sku: 'LK-W10', barcode: '3800000000031', category: 'Шайби' })
  await make('nut', { name: 'Гайка DIN 934 М8', sku: 'LK-NUT8', category: 'Гайки' })
  // A Cyrillic SKU, typed in another case.
  await make('cyr', { name: 'Дюбел 8 мм', sku: 'ДЮБ-08', category: 'Дюбели' })
  // One product's barcode is another one's SKU.
  await make('byBarcode', { name: 'Анкер с код', sku: 'LK-ANK', barcode: 'X-100', category: 'Анкери' })
  await make('bySku', { name: 'Анкер с артикул', sku: 'X-100', category: 'Анкери' })
  // Two articles sharing one barcode (a data error the till must not paper over).
  await make('twinA', { name: 'Винт двойник А', sku: 'LK-TW-A', barcode: '4000000000001', category: 'Винтове' })
  await make('twinB', { name: 'Винт двойник Б', sku: 'LK-TW-B', barcode: '4000000000001', category: 'Винтове' })
  // Deactivated: Inventory lists it, the till never sells it.
  await make('old', { name: 'Болт стар', sku: 'LK-OLD', barcode: '3800000000048', category: 'Болтове', isActive: false })
  // Another org's articles: one of its own, and one with exactly this org's barcode and SKU.
  await make('foreign', { name: 'Чужд болт', sku: 'LK-FOREIGN', barcode: '5000000000002' }, other._id)
  await make('foreignTwin', { name: 'Чужд болт 2', sku: 'LK-B8', barcode: '3800000000017' }, other._id)

  await createTestStockLevel(org._id, bolt8._id, wh._id, { quantity: 7, availableQuantity: 7 })

  // Written past the mirror hooks, the way a bulkWrite does it: no `skuLower` / `barcodeLower`.
  const raw = await Product.collection.insertOne({
    orgId: org._id, name: 'Без огледални полета', sku: 'RAW-001', barcode: '7000000000009',
    category: 'Други', type: 'goods', unit: 'pcs', sellingPrice: 3, taxRate: 20, isActive: true,
    createdAt: new Date(), updatedAt: new Date(),
  } as any)
  ids.raw = String(raw.insertedId)
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

describe('the exact code', () => {
  it('a scanned barcode is that article, in the grid’s shape and with the warehouse’s stock', async () => {
    const { product, matchedBy } = await lookup('3800000000017', { warehouseId })
    expect(matchedBy).toBe('barcode')
    expect(product).toMatchObject({
      productId: ids.bolt8, productName: 'Болт DIN 933 М8х20', sku: 'LK-B8', barcode: '3800000000017',
      unitPrice: 100, taxRate: 18, unit: 'pcs', category: 'Болтове', stockAvailable: 7,
    })
    // The same object a card click adds: the grid lists this product identically.
    const grid = await get(`/org/${orgId}/trade/pos/catalog?size=50&warehouseId=${warehouseId}&search=LK-B8`)
    expect(grid.status).toBe(200)
    expect(grid.json.products.find((p: any) => p.productId === ids.bolt8)).toEqual(product)
  })

  it('without a warehouse the stock is unknown, as on the grid', async () => {
    const { product } = await lookup('3800000000017')
    expect(product.productId).toBe(ids.bolt8)
    expect(product.stockAvailable).toBeNull()
  })

  it('a scanner’s stray spaces do not matter', async () => {
    expect((await lookup('  3800000000024 ')).product?.productId).toBe(ids.bolt10)
  })

  it('a typed SKU, in any case — Cyrillic too', async () => {
    expect(await lookup('LK-B10')).toMatchObject({ matchedBy: 'sku', product: { productId: ids.bolt10 } })
    expect(await lookup('lk-b10')).toMatchObject({ matchedBy: 'sku', product: { productId: ids.bolt10 } })
    expect(await lookup('дюб-08')).toMatchObject({ matchedBy: 'sku', product: { productId: ids.cyr } })
  })

  it('a barcode outranks a SKU that reads the same', async () => {
    expect(await lookup('X-100')).toMatchObject({ matchedBy: 'barcode', product: { productId: ids.byBarcode } })
  })

  it('an article written past the mirror hooks is still found by its code as printed', async () => {
    expect(await lookup('7000000000009')).toMatchObject({ matchedBy: 'barcode', product: { productId: ids.raw } })
    expect(await lookup('RAW-001')).toMatchObject({ matchedBy: 'sku', product: { productId: ids.raw } })
  })

  it('two articles sharing a barcode: nothing is guessed', async () => {
    expect(await lookup('4000000000001')).toEqual({ product: null, matchedBy: null })
  })

  it('a deactivated article is never added, by code or by search', async () => {
    expect(await lookup('3800000000048')).toEqual({ product: null, matchedBy: null })
    expect(await lookup('LK-OLD')).toEqual({ product: null, matchedBy: null })
    expect(await lookup('Болт стар')).toEqual({ product: null, matchedBy: null })
  })

  it('another org’s article is never found, nor counted against this org’s own', async () => {
    expect(await lookup('5000000000002')).toEqual({ product: null, matchedBy: null })
    expect(await lookup('LK-FOREIGN')).toEqual({ product: null, matchedBy: null })
    // The other org holds an article with exactly this barcode and SKU: no ambiguity here.
    expect(await lookup('3800000000017')).toMatchObject({ matchedBy: 'barcode', product: { productId: ids.bolt8 } })
    expect(await lookup('LK-B8')).toMatchObject({ matchedBy: 'sku', product: { productId: ids.bolt8 } })
  })
})

describe('no exact code', () => {
  it('the one article the grid’s search finds is added', async () => {
    // „шайба" is in one name only.
    expect(await lookup('шайба')).toMatchObject({ matchedBy: 'search', product: { productId: ids.washer } })
    // The search's own rules hold: words in any order, Latin look-alikes for Cyrillic letters.
    expect(await lookup('m10x30')).toMatchObject({ matchedBy: 'search', product: { productId: ids.bolt10 } })
  })

  it('a search finding several adds nothing: the terminal shows the grid instead', async () => {
    expect(await lookup('болт')).toEqual({ product: null, matchedBy: null })
    expect(await lookup('no such article')).toEqual({ product: null, matchedBy: null })
  })

  it('counts with the grid’s filters, as the cashier sees it', async () => {
    // „din 933" is two bolts; within the washer category there is no bolt at all.
    expect(await lookup('din 933')).toEqual({ product: null, matchedBy: null })
    expect(await lookup('М8', { category: 'Гайки' })).toMatchObject({ matchedBy: 'search', product: { productId: ids.nut } })
    expect(await lookup('din 933', { category: 'Шайби' })).toEqual({ product: null, matchedBy: null })
  })

  it('while an exact code ignores them: a scanned article is that article', async () => {
    expect(await lookup('3800000000024', { category: 'Шайби' })).toMatchObject({ matchedBy: 'barcode', product: { productId: ids.bolt10 } })
    expect(await lookup('LK-NUT8', { category: 'Болтове', type: 'service' })).toMatchObject({ matchedBy: 'sku', product: { productId: ids.nut } })
  })

  it('an empty code answers nothing', async () => {
    expect(await lookup('')).toEqual({ product: null, matchedBy: null })
    expect(await lookup('   ')).toEqual({ product: null, matchedBy: null })
    const { status, json } = await get(`/org/${orgId}/trade/pos/catalog/lookup`)
    expect(status).toBe(200)
    expect(json).toEqual({ product: null, matchedBy: null })
  })
})

describe('who reaches it', () => {
  it('needs a session', async () => {
    expect((await get(`/org/${orgId}/trade/pos/catalog/lookup?code=LK-B8`, null)).status).toBe(401)
  })

  it('the till’s cashier and the back office’s accountant, as the grid; nobody else', async () => {
    expect(readRuleFor(LOOKUP_ROUTE)).toEqual(readRuleFor('/api/org/:orgId/trade/pos/catalog'))
    expect((await lookup('LK-B8', {}, tokens.sales)).product?.productId).toBe(ids.bolt8)
    expect((await lookup('LK-B8', {}, tokens.accountant)).product?.productId).toBe(ids.bolt8)
    for (const role of ['hr_manager', 'warehouse_manager']) {
      const { status, json } = await get(`/org/${orgId}/trade/pos/catalog/lookup?code=LK-B8`, tokens[role])
      expect(status).toBe(403)
      expect(json?.code).toBe('permission_required')
    }
  })

  it('a till signed in by PIN (FR-20) reaches it, as it reaches the grid', () => {
    const pin = { role: 'sales', permissions: DEFAULT_ROLE_PERMISSIONS.sales, amr: ['pin'] }
    expect(pinScopeRefusal(pin, 'GET', '/api/org/:orgId/trade/pos/catalog')).toBeNull()
    expect(pinScopeRefusal(pin, 'GET', LOOKUP_ROUTE)).toBeNull()
  })

  it('another org’s URL is refused before any lookup', async () => {
    const { status } = await get(`/org/${otherOrgId}/trade/pos/catalog/lookup?code=5000000000002`)
    expect(status).toBe(403)
  })
})
