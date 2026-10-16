import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser, createTestProduct } from '../helpers/factories'
import { posController } from 'invoicing-api/src/controllers/pos.controller'
import { productController } from 'warehouse-api/src/controllers/product.controller'
import { getRepos } from 'services/context'
import { buildSearchFilter } from 'services/biz/search.utils'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * „болт 933 8х20" found the bolt in Inventory but nothing in POS or Cash Sales.
 *
 * Inventory searches `GET /warehouse/product`; the POS terminal AND the cash-sale terminal both
 * search `GET /trade/pos/catalog`. The catalog built its regex without the `*Lower` mirrors,
 * relying on `$options: 'i'` — which the Mongo DAL's filter translator silently dropped, so the
 * match was case-sensitive and 'болт' never matched „Болт". Both endpoints now run the one
 * `buildProductSearchFilter`, which also treats Latin/Cyrillic look-alikes (x/х, M/М) as equal.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

let app: Elysia
let token: string
let orgId: string
const ids: Record<string, string> = {}

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

async function get(path: string) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    headers: { authorization: `Bearer ${token}` },
  }))
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

async function inventorySearch(q: string): Promise<string[]> {
  const { status, json } = await get(`/org/${orgId}/warehouse/product?size=50&search=${encodeURIComponent(q)}`)
  expect(status).toBe(200)
  return json.products.map((p: any) => String(p.id ?? p._id)).sort()
}

/** What PosTerminalView.vue and CashSaleTerminal.vue both call. */
async function catalogSearch(q: string): Promise<string[]> {
  const { status, json } = await get(`/org/${orgId}/trade/pos/catalog?size=50&search=${encodeURIComponent(q)}`)
  expect(status).toBe(200)
  return json.products.map((p: any) => String(p.productId)).sort()
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(productController).use(posController)

  const org = await createTestOrg()
  orgId = String(org._id)
  const user = await createTestUser(org._id)
  token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'cashier@test.com', username: 'cashier',
    firstName: 'Иван', lastName: 'Петров', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })

  const make = async (key: string, name: string, extra: Record<string, any> = {}) => {
    const p = await createTestProduct(org._id, { name, ...extra } as any)
    ids[key] = String(p._id)
  }
  // Cyrillic М and Cyrillic х — the way the seeded names are written.
  await make('cyr', 'Болт DIN 933 М8х20 8.8 ZN')
  // Latin M and Latin x, upper case — indistinguishable on screen.
  await make('lat', 'БОЛТ DIN 933 M8x20 10.9 HDG')
  // Decoys: wrong length, wrong standard, wrong article.
  await make('len', 'Болт DIN 933 М8х25 8.8 ZN')
  await make('std', 'Болт DIN 931 М8х20 8.8 ZN')
  await make('nut', 'Гайка DIN 934 М8 ZN')
  // Inactive: listed in Inventory (which shows deactivated products), never sold at the till.
  await make('old', 'Болт DIN 933 М8х20 стар', { isActive: false })
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

describe('product search parity: Inventory = POS = Cash Sales', () => {
  // The user's query: Cyrillic х, lower case, words in a different order/shape than the name.
  const queries = ['болт 933 8х20', 'болт 933 8x20', 'БОЛТ 933 М8Х20', '8х20 болт 933']

  for (const q of queries) {
    it(`"${q}" finds both spellings of the bolt and no decoy, everywhere`, async () => {
      const inventory = await inventorySearch(q)
      const catalog = await catalogSearch(q)

      expect(inventory).toEqual([ids.cyr, ids.lat, ids.old].sort())
      // POS and the cash-sale terminal: the same set minus the deactivated product.
      expect(catalog).toEqual([ids.cyr, ids.lat].sort())
      expect(catalog).toEqual(inventory.filter(id => id !== ids.old))
    })
  }

  it('the catalog also matches by SKU and category, like Inventory', async () => {
    const p = await createTestProduct((await getRepos().products.findById(ids.nut) as any).orgId, {
      name: 'Шайба DIN 125 М10', sku: 'ШБ-125-10', category: 'Шайби',
    } as any)
    expect(await catalogSearch('шб-125')).toEqual([String(p._id)])
    expect(await catalogSearch('шайби')).toEqual([String(p._id)])
    expect(await inventorySearch('шб-125')).toEqual([String(p._id)])
  })
})

describe('DAL keeps $options on a regex', () => {
  it('a non-lowered buildSearchFilter matches case-insensitively through the repository', async () => {
    const filter = { orgId, ...buildSearchFilter('гайка', ['name']) }
    const result = await getRepos().products.findAll(filter as any, { page: 0, size: 50 })
    expect(result.items.map((p: any) => String(p.id))).toEqual([ids.nut])
  })
})
