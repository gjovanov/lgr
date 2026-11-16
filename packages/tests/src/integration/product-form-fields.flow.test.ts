import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestProduct } from '../helpers/factories'
import { productController } from 'warehouse-api/src/controllers/product.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { Product, ProductCategory } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS, PRODUCT_TARIFF_CODE_MAX, PRODUCT_TYPES } from 'config/constants'

/**
 * What the product form sends, and what of it the routes store (owner, 2026-11-12).
 *
 *   - `tariffCode`, the customs tariff number: a new text field, empty until given.
 *   - Prices with four decimals and margins with three go in and come back as sent: no route rounds them.
 *   - ⚠ `type` on an update. A route's body schema is a whitelist: Elysia drops a field it does not name and answers
 *     200. The update route never named `type`, so the form's Type select did not save on an existing article, from the
 *     first commit. The last test holds the whole form to the route: a field added to the form and not to the schema
 *     fails here, not in production.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(productController)
}, 60_000)
afterAll(async () => { await teardownTestDB() }, 60_000)
afterEach(async () => { await clearCollections() }, 30_000)

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

async function world() {
  const org = await createTestOrg()
  const orgId = String(org._id)
  const user = await createTestUser(org._id)
  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
  async function call(method: 'POST' | 'PUT' | 'GET', path: string, body?: Record<string, any>) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/warehouse/product${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }
  const stored = async (id: string): Promise<any> => Product.findById(id).lean().exec()
  return { org, orgId, call, stored }
}

const NEW = { sku: 'TC-1', name: 'Болт DIN 933 M8x25', category: 'Общи', type: 'goods', unit: 'pcs' }

describe('the tariff code of an article', () => {
  it('is empty until given, kept as given without the spaces around it, changed and emptied', async () => {
    const w = await world()

    const bare = await w.call('POST', '', NEW)
    expect(bare.status).toBe(200)
    expect((await w.stored(bare.json.product.id)).tariffCode).toBeUndefined()
    expect((await w.call('GET', `/${bare.json.product.id}`)).json.product.tariffCode).toBeUndefined()

    const made = await w.call('POST', '', { ...NEW, sku: 'TC-2', tariffCode: '  7318 15 95 ' })
    expect([made.status, made.json.product.tariffCode]).toEqual([200, '7318 15 95'])
    const id = made.json.product.id
    expect((await w.stored(id)).tariffCode).toBe('7318 15 95')

    const changed = await w.call('PUT', `/${id}`, { tariffCode: ' 73181595  ' })
    expect([changed.status, changed.json.product.tariffCode]).toEqual([200, '73181595'])
    expect((await w.stored(id)).tariffCode).toBe('73181595')
    expect((await w.call('GET', `/${id}`)).json.product.tariffCode).toBe('73181595')

    // An update that does not name it leaves it; an empty one empties it.
    expect((await w.call('PUT', `/${id}`, { name: 'Болт DIN 933 M8x30' })).status).toBe(200)
    expect((await w.stored(id)).tariffCode).toBe('73181595')
    expect((await w.call('PUT', `/${id}`, { tariffCode: '' })).status).toBe(200)
    expect((await w.stored(id)).tariffCode).toBe('')
  }, 60_000)

  it('is refused past its length, on both routes, and nothing is stored', async () => {
    const w = await world()
    const longest = '7'.repeat(PRODUCT_TARIFF_CODE_MAX)

    const over = await w.call('POST', '', { ...NEW, tariffCode: `${longest}7` })
    expect(over.status).toBe(422)
    expect(await Product.countDocuments({ orgId: w.orgId }).exec()).toBe(0)

    const made = await w.call('POST', '', { ...NEW, tariffCode: longest })
    expect([made.status, made.json.product.tariffCode]).toEqual([200, longest])
    const id = made.json.product.id
    expect((await w.call('PUT', `/${id}`, { tariffCode: `${longest}7` })).status).toBe(422)
    expect((await w.stored(id)).tariffCode).toBe(longest)
  }, 60_000)
})

describe('prices and margins go in as sent', () => {
  it('a price keeps its four decimals and a margin its three, on create and on update', async () => {
    const w = await world()
    const tiers = [
      { name: 'Доставна цена', percent: 0, finalPrice: 0.0472, manualOverride: false },
      { name: 'Цена 1', percent: 2000.555, finalPrice: 0.9915, manualOverride: false },
      { name: 'Цена 2', percent: 12.288, finalPrice: 0.053, manualOverride: true },
    ]
    const made = await w.call('POST', '', { ...NEW, purchasePrice: 0.0472, sellingPrice: 12345.6789, priceTiers: tiers })
    expect(made.status).toBe(200)
    const id = made.json.product.id
    const first = await w.stored(id)
    expect([first.purchasePrice, first.sellingPrice]).toEqual([0.0472, 12345.6789])
    expect(first.priceTiers.map((t: any) => [t.name, t.percent, t.finalPrice, t.manualOverride])).toEqual(tiers.map(t => [t.name, t.percent, t.finalPrice, t.manualOverride]))

    const next = tiers.map(t => ({ ...t, percent: t.percent + 0.001, finalPrice: t.finalPrice + 0.0001 }))
    const put = await w.call('PUT', `/${id}`, { purchasePrice: 0.0473, sellingPrice: 0.1235, priceTiers: next })
    expect(put.status).toBe(200)
    const second = await w.stored(id)
    expect([second.purchasePrice, second.sellingPrice]).toEqual([0.0473, 0.1235])
    expect(second.priceTiers.map((t: any) => [t.percent, t.finalPrice])).toEqual(next.map(t => [t.percent, t.finalPrice]))
    // And the answer carries what was stored.
    expect(put.json.product.priceTiers.map((t: any) => [t.percent, t.finalPrice])).toEqual(next.map(t => [t.percent, t.finalPrice]))
  }, 60_000)
})

describe('a change of type', () => {
  it('is stored: the update route answered 200 and kept the old one', async () => {
    const w = await world()
    const product = await createTestProduct(w.org._id, { sku: 'TY-1', type: 'goods' } as any)
    const id = String(product._id)
    for (const type of [...PRODUCT_TYPES].reverse()) {
      const res = await w.call('PUT', `/${id}`, { type })
      expect({ type, status: res.status, answered: res.json.product.type, stored: (await w.stored(id)).type })
        .toEqual({ type, status: 200, answered: type, stored: type })
    }
  }, 60_000)

  it('to something an article cannot be is refused', async () => {
    const w = await world()
    const product = await createTestProduct(w.org._id, { sku: 'TY-2', type: 'goods' } as any)
    const res = await w.call('PUT', `/${String(product._id)}`, { type: 'gift' })
    expect(res.status).toBe(422)
    expect((await w.stored(String(product._id))).type).toBe('goods')
  }, 60_000)
})

describe('the product form and the update route name the same fields', () => {
  // The form's own state: every key of it is sent on a save (`{ ...form, priceTiers }`).
  const view = readFileSync(join(import.meta.dir, '../../../inventory-ui/src/views/ProductFormView.vue'), 'utf8')
  const block = view.slice(view.indexOf('const form = reactive({'), view.indexOf('\n})', view.indexOf('const form = reactive({')))
  const formFields = [...block.slice(block.indexOf('{') + 1).matchAll(/(?:^|,)\s*([A-Za-z]+):/gm)].map(m => m[1])

  it('reads the form\'s fields', () => {
    expect(formFields).toContain('sku')
    expect(formFields).toContain('tariffCode')
    expect(formFields).toContain('type')
    expect(formFields).toContain('tags')
    expect(formFields.length).toBeGreaterThanOrEqual(19)
  })

  it('every field the form sends reaches the article on an update', async () => {
    const w = await world()
    const category = await ProductCategory.create({ orgId: w.org._id, name: 'Крепежи' } as any)
    const product = await createTestProduct(w.org._id, {
      sku: 'FF-1', name: 'Before', type: 'goods', category: 'General', unit: 'pcs', barcode: '111', description: 'before',
      isActive: true, purchasePrice: 1, sellingPrice: 2, taxRate: 18, trackInventory: true, minStockLevel: 1, maxStockLevel: 2,
      tags: ['old'],
    } as any)
    const id = String(product._id)

    // One new value per field the form holds. A field the form gains must be given one here, and named by the route.
    const sent: Record<string, any> = {
      sku: 'FF-2', name: 'After', tariffCode: '73181595', type: 'service', category: 'Крепежи', categoryId: String(category._id),
      unit: 'kg', barcode: '222', description: 'after', isActive: false,
      purchasePrice: 0.0472, sellingPrice: 0.059, taxRate: 20,
      trackInventory: false, minStockLevel: 5, maxStockLevel: 50,
      costingMethod: 'standard', standardCost: 0.0481,
      tags: ['DIN 933', 'ZN'],
    }
    expect(Object.keys(sent).sort()).toEqual([...formFields].sort())

    const res = await w.call('PUT', `/${id}`, { ...sent, priceTiers: [{ name: 'Цена 1', percent: 25, finalPrice: 0.059, manualOverride: false }] })
    expect(res.status).toBe(200)
    const doc = await w.stored(id)
    const got: Record<string, any> = {}
    for (const key of Object.keys(sent)) got[key] = key === 'categoryId' ? String(doc[key]) : doc[key]
    expect(got).toEqual(sent)
    expect(doc.priceTiers.map((t: any) => [t.name, t.percent, t.finalPrice])).toEqual([['Цена 1', 25, 0.059]])
  }, 60_000)
})
