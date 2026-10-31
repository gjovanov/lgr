import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser, createTestProduct } from '../helpers/factories'
import { productController } from 'warehouse-api/src/controllers/product.controller'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * The Products list sorts by a price tier's column (`tier_1` = „Цена 1") — every filtered
 * article, before the page is cut — and the filters still apply. A tier's price is an element of
 * `priceTiers[]`; an article with no price there (no such slot, or a zero one) goes last in both
 * directions.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

let app: Elysia
let token: string
let orgId: string

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

async function list(qs: string) {
  const res = await app.handle(new Request(`http://localhost/org/${orgId}/warehouse/product?${qs}`, {
    headers: { authorization: `Bearer ${token}` },
  }))
  const json = await res.json().catch(() => null) as any
  return { status: res.status, json, skus: (json?.products || []).map((p: any) => p.sku) as string[] }
}

const tier = (name: string, finalPrice: number) => ({ name, percent: 0, finalPrice, manualOverride: false })

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(productController)

  const org = await createTestOrg()
  orgId = String(org._id)
  const user = await createTestUser(org._id)
  token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'A', lastName: 'B', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })

  const make = (sku: string, name: string, priceTiers: any[], extra: Record<string, any> = {}) =>
    createTestProduct(org._id, { sku, name, priceTiers, ...extra } as any)
  await make('PTS-A', 'Болт A', [tier('Доставна цена', 0.05), tier('Цена 1', 0.5)])
  await make('PTS-B', 'Болт B', [tier('Цена 1', 0.0472)])
  // An import that folded the heading together: the same slot.
  await make('PTS-C', 'Болт C', [tier('Цена1', 2)])
  await make('PTS-D', 'Болт D', [])
  // A zero slot is no price at that level.
  await make('PTS-E', 'Болт E', [tier('Цена 1', 0)])
  await make('PTS-F', 'Болт F', [tier('Цена 1', 1)], { isActive: false })
  await make('PTS-G', 'Гайка G', [tier('Цена 1', 0.3)])
}, 60_000)

afterAll(async () => { await teardownTestDB() })

describe('GET /warehouse/product — sorted by a price tier', () => {
  it('orders by the tier price both ways, the articles without one last', async () => {
    const asc = await list('size=50&sortBy=tier_1&sortOrder=asc')
    expect(asc.status).toBe(200)
    expect(asc.skus).toEqual(['PTS-B', 'PTS-G', 'PTS-A', 'PTS-F', 'PTS-C', 'PTS-D', 'PTS-E'])
    expect((await list('size=50&sortBy=tier_1&sortOrder=desc')).skus)
      .toEqual(['PTS-C', 'PTS-F', 'PTS-A', 'PTS-G', 'PTS-B', 'PTS-D', 'PTS-E'])
  })

  it('sorts within the search and the status filter', async () => {
    const r = await list(`size=50&search=${encodeURIComponent('болт')}&isActive=true&sortBy=tier_1&sortOrder=asc`)
    expect(r.skus).toEqual(['PTS-B', 'PTS-A', 'PTS-C', 'PTS-D', 'PTS-E'])
    expect(r.json.total).toBe(5)
  })

  it('sorts every filtered article before cutting the page', async () => {
    const r = await list(`size=2&page=1&search=${encodeURIComponent('болт')}&isActive=true&sortBy=tier_1&sortOrder=asc`)
    expect(r.skus).toEqual(['PTS-C', 'PTS-D'])
    expect(r.json).toMatchObject({ total: 5, page: 1, size: 2, totalPages: 3 })
  })

  it('names the slot by its key: tier_delivery is „Доставна цена"', async () => {
    const r = await list('size=50&sortBy=tier_delivery&sortOrder=desc')
    expect(r.skus[0]).toBe('PTS-A')
    expect(r.skus.slice(1)).toEqual(['PTS-B', 'PTS-C', 'PTS-D', 'PTS-E', 'PTS-F', 'PTS-G'])
  })

  it('a sorted page carries the same article as an unsorted one', async () => {
    const sorted = (await list('size=50&sortBy=tier_1&sortOrder=asc')).json.products.find((p: any) => p.sku === 'PTS-A')
    const plain = (await list('size=50')).json.products.find((p: any) => p.sku === 'PTS-A')
    expect(Object.keys(sorted).sort()).toEqual(Object.keys(plain).sort())
    expect(sorted.id).toBe(plain.id)
    expect(sorted.priceTiers).toEqual(plain.priceTiers)
  })

  it('an unknown slot is just an unknown field, never an error', async () => {
    const r = await list('size=50&sortBy=tier_99&sortOrder=asc')
    expect(r.status).toBe(200)
    expect(r.skus).toHaveLength(7)
  })
})
