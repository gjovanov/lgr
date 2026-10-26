import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, createTestProduct } from '../helpers/factories'
import { productController } from 'warehouse-api/src/controllers/product.controller'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { Product, ProductCategory } from 'db/models'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS, MAX_PRICE_TIERS } from 'config/constants'

/**
 * FR-22.30 (#3) — „+ Нов продукт „…"" on a receipt or bill line: the article is created without
 * leaving the document, born the way doc-import creates one (`newProductDoc`) — the next SKU of
 * the org's sequence, the org's tier template — but at the org's own currency and VAT, in „Общи"
 * (made when the org has none: the API refuses an article without a category), and never as a
 * second copy of one the catalog has.
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
  await createTestProduct(org._id, { sku: 'PRD-0001', name: 'Болт М8' } as any)
  await createTestProduct(org._id, { sku: 'PRD-0002', name: 'Гайка М8' } as any)
  const token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })
  async function quick(body: Record<string, any>) {
    const res = await app.handle(new Request(`http://localhost/org/${orgId}/warehouse/product/quick`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }))
    return { status: res.status, json: await res.json().catch(() => null) as any }
  }
  return { orgId, quick }
}

describe('a new article from a receipt or bill line (FR-22.30)', () => {
  it('continues the SKU sequence, lands in „Общи" (made when missing) at the org\'s VAT, with the tier template', async () => {
    const w = await world()
    expect(await ProductCategory.countDocuments({ orgId: w.orgId }).exec()).toBe(0)
    const res = await w.quick({ name: '  Шайба  М10 ', unit: 'pcs', purchasePrice: 3, sellingPrice: 5 })
    expect(res.status).toBe(200)
    const p: any = await Product.findById(res.json.product.id).lean().exec()
    expect([p.sku, p.name, p.unit, p.purchasePrice, p.sellingPrice, p.taxRate, p.currency, p.type])
      .toEqual(['PRD-0003', 'Шайба М10', 'pcs', 3, 5, 18, 'EUR', 'goods'])
    const cats: any[] = await ProductCategory.find({ orgId: w.orgId }).lean().exec()
    expect(cats.map(c => c.name)).toEqual(['Общи'])
    expect([p.category, String(p.categoryId)]).toEqual(['Общи', String(cats[0]._id)])
    // The org's tier template: every slot, the cost in „Доставна цена".
    expect(p.priceTiers).toHaveLength(MAX_PRICE_TIERS)
    expect(p.priceTiers.find((t: any) => t.name === 'Доставна цена').finalPrice).toBe(3)

    // A second one reuses the category and continues the sequence; a chosen VAT rate wins.
    const next = await w.quick({ name: 'Шайба М12', taxRate: 9, categoryId: String(cats[0]._id) })
    expect(next.status).toBe(200)
    expect([next.json.product.sku, next.json.product.taxRate]).toEqual(['PRD-0004', 9])
    expect(await ProductCategory.countDocuments({ orgId: w.orgId }).exec()).toBe(1)
  }, 60_000)

  it('never makes a second copy of an article the catalog has', async () => {
    const w = await world()
    const dup = await w.quick({ name: 'болт м8' })
    expect([dup.status, dup.json.code, dup.json.product?.sku]).toEqual([409, 'product_exists', 'PRD-0001'])
    // Differs only in separators — the doc-import twins.
    const twin = await w.quick({ name: 'Болт  -М8' })
    expect([twin.status, twin.json.code]).toEqual([409, 'product_exists'])
    const unknown = await w.quick({ name: 'Нещо', categoryId: '6a0000000000000000000000' })
    expect([unknown.status, unknown.json.code]).toEqual([422, 'category_not_found'])
    expect(await Product.countDocuments({ orgId: w.orgId }).exec()).toBe(2)
  }, 60_000)
})
