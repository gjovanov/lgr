import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'

import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { Org, Product, StockLevel, User, type IUser } from 'db/models'
import { tokenize } from 'services/biz/auth.service'
import { seedDefaultPermissionSets } from 'services/biz/permission-set.seed'
import { forgetAccessModel } from 'services/biz/access/shadow'
import { rolesFromSets } from 'migrations/migrations/0015-roles-from-sets'
import { PRICE_LEVEL_CAPS } from 'config/access'

/**
 * FR-27.6 (#529, D-5; §8 field test step 3) — turn the cost figures off on a role, and read a product through the
 * API: no cost keys. Every serializer that sends a product or its costs: the list, by id, a create and an update,
 * the price options, the stock levels, the cost layers. A write by such a role keeps the stored costs.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: Elysia
let org: any
let orgId: string
let productId: string
const people: Record<string, IUser> = {}
const tokens: Record<string, string> = {}

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

const sign = async (key: string) => { tokens[key] = await (signer as any).decorator.jwt.sign(await tokenize((await User.findById(people[key]._id).exec())!)) }
const COST_KEYS = ['purchasePrice', 'standardCost']
const noCosts = (p: any) => {
  for (const k of COST_KEYS) expect(k in p).toBe(false)
  expect((p.priceTiers ?? []).map((t: any) => t.name)).not.toContain('Доставна цена')
  expect((p.priceTiers ?? []).some((t: any) => 'percent' in t)).toBe(false)
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  org = await createTestOrg({ slug: 'access-costs' } as any)
  orgId = String(org._id)
  await seedDefaultPermissionSets(orgId)
  people.admin = await createTestUser(org._id, { role: 'admin', username: 'admin', email: 'admin@access-costs.test' } as any)
  people.clerk = await createTestUser(org._id, { role: 'member', username: 'clerk', email: 'clerk@access-costs.test' } as any)
  people.manager = await createTestUser(org._id, { role: 'manager', username: 'manager', email: 'manager@access-costs.test' } as any)
  const product = await Product.create({
    orgId: org._id, sku: 'B-1', name: 'Bolt', category: 'Общи', type: 'goods', unit: 'pcs', purchasePrice: 2, standardCost: 2.1, sellingPrice: 5,
    priceTiers: [
      { name: 'Доставна цена', percent: 0, finalPrice: 2 },
      { name: 'Цена на едро', percent: 50, finalPrice: 3 },
      { name: 'Цена 1', percent: 150, finalPrice: 5 },
    ],
  } as any)
  productId = String(product._id)
  await StockLevel.create({ orgId: org._id, productId: product._id, warehouseId: new mongoose.Types.ObjectId(), quantity: 3, availableQuantity: 3, avgCost: 2 } as any)
  await rolesFromSets.up({ db: mongoose.connection.db as any, log: () => {}, orgFilter: {} })
  await Org.updateOne({ _id: org._id }, { $set: { 'settings.access.model': 'roles' } }).exec()
  forgetAccessModel(orgId)
  for (const key of Object.keys(people)) await sign(key)
  // A role that reads and edits products, without the cost figures, given to the clerk.
  // Every price level (FR-27.11), so this is about the cost figures alone.
  const role = await call('POST', '/roles', tokens.admin, { name: 'Shelf', caps: ['products.view', 'products.edit', ...PRICE_LEVEL_CAPS] })
  expect(role.json.role.caps).not.toContain('products.costs')
  expect((await call('PUT', `/user/${people.clerk._id}`, tokens.admin, { roleId: role.json.role.id })).status).toBe(200)
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('FR-27.6: a role without the cost figures', () => {
  it('reads products without them: the list and by id', async () => {
    const list = await call('GET', '/warehouse/product?size=10', tokens.clerk)
    expect(list.status).toBe(200)
    expect(list.json.products).toHaveLength(1)
    noCosts(list.json.products[0])
    noCosts(list.json.items[0])
    expect(list.json.products[0].sellingPrice).toBe(5)
    const one = await call('GET', `/warehouse/product/${productId}`, tokens.clerk)
    noCosts(one.json.product)
  })

  it('edits a product without touching them: the stored costs and margins stay', async () => {
    const r = await call('PUT', `/warehouse/product/${productId}`, tokens.clerk, {
      name: 'Bolt M8', purchasePrice: 0, priceTiers: [{ name: 'Цена на едро', finalPrice: 3.5 }, { name: 'Цена 1', finalPrice: 6 }],
    })
    expect(r.status).toBe(200)
    noCosts(r.json.product)
    const stored: any = await Product.findById(productId).lean().exec()
    expect(stored).toMatchObject({ name: 'Bolt M8', purchasePrice: 2, standardCost: 2.1 })
    expect(stored.priceTiers.map((t: any) => [t.name, t.finalPrice, t.percent])).toEqual([
      ['Доставна цена', 2, 0], ['Цена на едро', 3.5, 50], ['Цена 1', 6, 150],
    ])
  })

  it('is offered no buying price to sell at', async () => {
    const r = await call('GET', `/pricing/options?productId=${productId}&all=true`, tokens.clerk)
    expect(r.status).toBe(200)
    expect(r.json.options.map((o: any) => o.name)).not.toContain('Доставна цена')
  })

  it("reads no stock level's average cost, and no cost layer", async () => {
    const levels = await call('GET', `/warehouse/stock-level?productId=${productId}`, tokens.clerk)
    expect(levels.status).toBe(200)
    expect(levels.json.stockLevels[0].quantity).toBe(3)
    expect('avgCost' in levels.json.stockLevels[0]).toBe(false)
    const layers = await call('GET', '/warehouse/cost-layer', tokens.clerk)
    expect(layers.status).toBe(403)
    expect(layers.json.code).toBe('capability_required')
  })
})

describe('everyone else, as before', () => {
  it('the Administrator and a migrated manager read every cost figure', async () => {
    for (const key of ['admin', 'manager']) {
      const one = await call('GET', `/warehouse/product/${productId}`, tokens[key])
      expect(one.json.product.purchasePrice).toBe(2)
      expect(one.json.product.priceTiers[0].name).toBe('Доставна цена')
      expect(one.json.product.priceTiers[1].percent).toBe(50)
    }
    expect((await call('GET', `/warehouse/stock-level?productId=${productId}`, tokens.manager)).json.stockLevels[0].avgCost).toBe(2)
    expect((await call('GET', '/warehouse/cost-layer', tokens.manager)).status).toBe(200)
  })

  it('back on the legacy model, the clerk reads what their claims open, costs included', async () => {
    await Org.updateOne({ _id: org._id }, { $set: { 'settings.access.model': 'legacy' } }).exec()
    forgetAccessModel(orgId)
    const one = await call('GET', `/warehouse/product/${productId}`, tokens.clerk)
    expect(one.status).toBe(200)
    expect(one.json.product.purchasePrice).toBe(2)
  })
})
