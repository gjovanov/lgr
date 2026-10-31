import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser, createTestProduct, createTestWarehouse, createTestContact } from '../helpers/factories'
import { StockMovement } from 'db/models'
import { movementController } from 'warehouse-api/src/controllers/movement.controller'
import { productController } from 'warehouse-api/src/controllers/product.controller'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

/**
 * The Movements list finds its documents by the Products list's search and filters — applied to
 * the articles on their lines (`productSearch`, `productCategory`, `productType`, `productTags`,
 * `productActive`) — together with its own filters, and every column it shows sorts, before the
 * page is cut.
 *
 * NOTE: no `.rejects` / `.resolves` — the Bun-on-Windows deadlock in the Known Issues table.
 */

let app: Elysia
let token: string
let orgId: string
const P: Record<string, string> = {}
const W: Record<string, string> = {}

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

async function get(path: string) {
  const res = await app.handle(new Request(`http://localhost/org/${orgId}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  }))
  return { status: res.status, json: await res.json().catch(() => null) as any }
}

/** The list's movement numbers (`#`), in the order it gives them. */
async function movements(qs: string): Promise<string[]> {
  const { status, json } = await get(`/warehouse/movement?size=50&${qs}`)
  expect(status).toBe(200)
  return json.stockMovements.map((m: any) => m.number)
}
const q = encodeURIComponent

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(movementController).use(productController)

  const org = await createTestOrg()
  orgId = String(org._id)
  const user = await createTestUser(org._id)
  token = await (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId, role: 'admin', email: 'admin@test.com', username: 'admin',
    firstName: 'A', lastName: 'B', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
  })

  const make = async (key: string, name: string, extra: Record<string, any>) => {
    P[key] = String((await createTestProduct(org._id, { name, sku: `MPF-${key}`, ...extra } as any))._id)
  }
  // Cyrillic М and х, as the catalog writes them.
  await make('bolt', 'Болт DIN 933 М8х20', { category: 'Болтове', tags: ['DIN 933'] })
  await make('nut', 'Гайка DIN 934 М8', { category: 'Гайки', tags: ['DIN 934'] })
  await make('old', 'Болт DIN 931 М10х50', { category: 'Болтове', tags: ['DIN 931'], isActive: false })
  await make('svc', 'Монтаж', { category: 'Услуги', type: 'service', trackInventory: false })

  W.b = String((await createTestWarehouse(org._id, { name: 'Склад Б' }))._id)
  W.a = String((await createTestWarehouse(org._id, { name: 'Склад А' }))._id)
  const company = await createTestContact(org._id, { companyName: 'Бета ООД' })
  const person = await createTestContact(org._id, { companyName: undefined, firstName: 'Иван', lastName: 'Петров' } as any)

  const book = (n: number, type: string, date: string, total: number, lines: string[], extra: Record<string, any>) =>
    StockMovement.create({
      orgId: org._id, movementNumber: `SM-2026-0000${n}`, type, status: 'completed', date: new Date(date),
      lines: lines.map((k) => ({ productId: P[k], quantity: 1, unitCost: total, totalCost: total })),
      totalAmount: total, createdBy: user._id, ...extra,
    })
  await book(1, 'receipt', '2026-01-01', 100, ['bolt'], { toWarehouseId: W.b, contactId: company._id })
  await book(2, 'dispatch', '2026-01-02', 50, ['nut'], { fromWarehouseId: W.a, contactId: person._id })
  await book(3, 'transfer', '2026-01-03', 300, ['bolt', 'nut'], { fromWarehouseId: W.b, toWarehouseId: W.a })
  await book(4, 'receipt', '2026-01-04', 10, ['old'], { toWarehouseId: W.a })
  await book(5, 'dispatch', '2026-01-05', 20, ['svc'], { fromWarehouseId: W.b })
}, 60_000)

afterAll(async () => { await teardownTestDB() })

const M = (...n: number[]) => n.map((i) => `SM-2026-0000${i}`)

describe('GET /warehouse/movement — the Products list\'s search and filters', () => {
  it('searches the articles as the Products list does — a Latin x finds the Cyrillic х', async () => {
    expect(await movements(`productSearch=${q('болт 933 8x20')}`)).toEqual(M(3, 1))
    // The Products list finds exactly that article with the same words.
    const { json } = await get(`/warehouse/product?size=50&search=${q('болт 933 8x20')}`)
    expect(json.products.map((p: any) => p.sku)).toEqual(['MPF-bolt'])
  })

  it('filters by the articles\' category, type, tags and status', async () => {
    expect(await movements(`productCategory=${q('Болтове')}`)).toEqual(M(4, 3, 1))
    expect(await movements('productType=service')).toEqual(M(5))
    expect(await movements(`productTags=${q('DIN 934')}`)).toEqual(M(3, 2))
    expect(await movements('productActive=false')).toEqual(M(4))
    expect(await movements(`productActive=true&productCategory=${q('Болтове')}`)).toEqual(M(3, 1))
  })

  it('combines with the movement\'s own filters and with articles picked by id', async () => {
    expect(await movements(`productCategory=${q('Болтове')}&type=receipt`)).toEqual(M(4, 1))
    expect(await movements(`productCategory=${q('Болтове')}&warehouseId=${W.a}`)).toEqual(M(4, 3))
    expect(await movements(`productId=${P.nut}&productCategory=${q('Гайки')}`)).toEqual(M(3, 2))
    expect(await movements(`productId=${P.nut}&productCategory=${q('Болтове')}`)).toEqual([])
    expect(await movements(`productSearch=${q('няма такъв')}`)).toEqual([])
  })
})

describe('GET /warehouse/movement — every column sorts', () => {
  it('# and the total, which the list names differently from the fields', async () => {
    expect(await movements('sortBy=number&sortOrder=asc')).toEqual(M(1, 2, 3, 4, 5))
    expect(await movements('sortBy=number&sortOrder=desc')).toEqual(M(5, 4, 3, 2, 1))
    expect(await movements('sortBy=total&sortOrder=asc')).toEqual(M(4, 5, 2, 1, 3))
  })

  it('the warehouses by name, those without one last, newest first within a name', async () => {
    expect(await movements('sortBy=fromWarehouseName&sortOrder=asc')).toEqual(M(2, 5, 3, 4, 1))
    expect(await movements('sortBy=fromWarehouseName&sortOrder=desc')).toEqual(M(5, 3, 2, 4, 1))
    expect(await movements('sortBy=toWarehouseName&sortOrder=asc')).toEqual(M(4, 3, 1, 5, 2))
  })

  it('the contact by the name the list prints: the company, else the person', async () => {
    expect(await movements('sortBy=contactName&sortOrder=asc')).toEqual(M(1, 2, 5, 4, 3))
    expect(await movements('sortBy=contactName&sortOrder=desc')).toEqual(M(2, 1, 5, 4, 3))
  })

  it('sorts every filtered movement before cutting the page', async () => {
    const page = (n: number) => get(`/warehouse/movement?size=2&page=${n}&productCategory=${q('Болтове')}&sortBy=fromWarehouseName&sortOrder=asc`)
    const [p0, p1] = await Promise.all([page(0), page(1)])
    expect(p0.json.stockMovements.map((m: any) => m.number)).toEqual(M(3, 4))
    expect(p1.json.stockMovements.map((m: any) => m.number)).toEqual(M(1))
    expect(p0.json).toMatchObject({ total: 3, page: 0, size: 2, totalPages: 2 })
  })

  it('a page sorted by a name carries the same rows as an unsorted one', async () => {
    const sorted = (await get('/warehouse/movement?size=50&sortBy=contactName&sortOrder=asc')).json.stockMovements
    const plain = (await get('/warehouse/movement?size=50')).json.stockMovements
    const one = (rows: any[]) => rows.find((m) => m.number === 'SM-2026-00001')
    expect(one(sorted)).toEqual(one(plain))
  })
})
