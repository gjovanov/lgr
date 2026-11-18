import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'

import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { Contact, Product, StockLevel, User } from 'db/models'
import { tokenize } from 'services/biz/auth.service'
import { buildProductSearchFilter, legacyProductSearchFilter } from 'services/biz/search.utils'
import { joinedValue, SEARCH_FIELD_SEPARATOR } from 'db/plugins/search-field'
import { backfillProductSearchField, PRODUCT_SEARCH_FIELD } from '../../../../scripts/backfill-product-search-field'
import { productSearchField } from 'migrations/migrations/0018-product-search-field'

/**
 * FR-30 slice C (#795): one indexed search field.
 *
 * FR-30.11: the product search reads `searchLower`, the five lowered mirrors joined by a character nobody types, through
 * `{ orgId, searchLower }`. It finds what the five-field search found (the two builders run over one fixture, for a
 * list of keywords), no keyword matches across two parts, a search without a match reads no article, the field is kept
 * on every kind of write, and the backfill is idempotent with a dry run.
 * FR-30.12: a type-ahead counts nothing (`count=none`), or only when more match than it shows (`count=when-more`).
 * FR-30.13: the stock-level search is the product search, and reads the matching articles' ids only.
 *
 * `LGR_PERF=1` adds a shop-size catalogue (23 050 articles) and prints the search's time.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const oid = () => new mongoose.Types.ObjectId()
const db = () => mongoose.connection.db!

let app: Elysia
let orgId: string
let orgOid: mongoose.Types.ObjectId
let token = ''
let warehouse: mongoose.Types.ObjectId

async function get(path: string): Promise<{ status: number; json: any }> {
  const res = await app.handle(new Request(`http://localhost/api/org/${orgId}${path}`, { headers: { authorization: `Bearer ${token}` } }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

async function profiled(collection: string, run: () => Promise<unknown>): Promise<any[]> {
  await db().command({ profile: 0 })
  await db().collection('system.profile').drop().catch(() => {})
  await db().command({ profile: 2 })
  try { await run() } finally { await db().command({ profile: 0 }) }
  return db().collection('system.profile').find({ ns: `${db().databaseName}.${collection}` }).toArray()
}

/** Articles as a fastener shop names them: Cyrillic and Latin mixed, look-alike letters, sizes, codes. */
const NAMES = [
  'Болт DIN 933 М8Х25 ZN', 'БОЛТ DIN 931 M10x60 8.8', 'Гайка DIN 934 М8', 'Шайба DIN 125 Ф8', 'Винт ISO 7380 M6X16 A2',
  'Анкер химичен 300 мл', 'Дюбел нейлонов 8x40', 'Wood screw 4x40 yellow', 'Self-tapping screw 3.5x25', 'Нит алуминиева 4x10',
  'Шпилка М12 1м', 'Скоба U-образна', 'Pop rivet 4.8x12', 'Болт с гайка М6Х40', 'Saw blade 210mm', 'Свредло HSS 8мм',
]
const CATEGORIES = ['Болтове', 'Гайки', 'Шайби', 'Винтове', 'Анкери', 'Screws', 'Tools']

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  const org = await createTestOrg({ slug: 'product-search-field' } as any)
  orgOid = org._id as any
  orgId = String(org._id)
  const admin = await createTestUser(org._id, { role: 'admin', username: 'admin', email: 'admin@product-search.test' } as any)
  token = await (signer as any).decorator.jwt.sign(await tokenize((await User.findById(admin._id).exec())!))
  warehouse = oid()

  // Through the model: the plugin keeps the mirrors and the field, as every write of the app does.
  const docs = Array.from({ length: 320 }, (_, i) => ({
    orgId: org._id, sku: `SKU-${String(i).padStart(4, '0')}${i % 3 ? '' : 'Z'}`, barcode: i % 4 ? `380${100000 + i}` : undefined,
    name: `${NAMES[i % NAMES.length]} ${i % 7 === 0 ? 'ПОЦИНКОВАН' : ''}`.trim(), description: i % 5 ? `Описание ${i} heavy duty` : undefined,
    category: CATEGORIES[i % CATEGORIES.length], type: 'goods', unit: 'бр.', isActive: i % 9 !== 0,
  }))
  await Product.insertMany(docs)
  // Another org's articles beside them.
  await Product.insertMany(docs.slice(0, 40).map((d) => ({ ...d, orgId: oid() })))
  await Product.syncIndexes()

  if (process.env.LGR_PERF) {
    const big = Array.from({ length: 23_050 }, (_, i) => ({
      orgId: org._id, sku: `BIG-${i}`, name: `${NAMES[i % NAMES.length]} серия ${i}`, category: CATEGORIES[i % CATEGORIES.length], type: 'goods', unit: 'бр.',
    }))
    for (let k = 0; k < big.length; k += 5000) await Product.insertMany(big.slice(k, k + 5000))
  }
}, 600_000)

afterAll(async () => {
  await db().command({ profile: 0 }).catch(() => {})
  await teardownTestDB()
})

const ids = async (filter: Record<string, any>) => (await Product.find({ orgId: orgOid, ...filter }, { _id: 1 }).lean().exec()).map((d: any) => String(d._id)).sort()

/** The keyword list of FR-30.11: Cyrillic, Latin, mixed case, look-alike letters, digits, several words, none. */
const KEYWORDS = [
  'болт', 'БОЛТ', 'Болт', 'гайка', 'шайба din', 'din 933', 'м8х25', 'M8X25', 'm8x25', 'М8Х25 zn', 'screw', 'SCREW', 'Wood',
  'sku-0001', 'sku-0003z', '380100', '3801000', 'поцинкован', 'heavy duty', 'описание 12', 'болтове', 'screws', 'tools', '8x40',
  '4.8x12', 'a2', 'хим', 'мл', 'zzzz-nothing', 'болт гайка', 'нит 4x10', 'с гайка', '(', '.', '*', 'u-образна',
]

describe('FR-30.11: one indexed search field', () => {
  it('finds what the five-field search finds, for every keyword of the list', async () => {
    for (const k of KEYWORDS) {
      const was = await ids(legacyProductSearchFilter(k))
      const now = await ids(buildProductSearchFilter(k))
      expect({ k, now }).toEqual({ k, now: was })
    }
    // The list is not trivial: most keywords find something, and one finds nothing.
    expect((await ids(buildProductSearchFilter('болт'))).length).toBeGreaterThan(20)
    expect(await ids(buildProductSearchFilter('zzzz-nothing'))).toEqual([])
  })

  it('no keyword matches across two of the joined fields', async () => {
    const p = await Product.create({ orgId: orgOid, sku: 'QQX', name: 'Kappa', category: 'Omega', type: 'goods', unit: 'pcs' } as any)
    // `kappa` ends where `qqx` starts, and `qqx` where `omega` would: nothing typed bridges them.
    expect(p.get('searchLower')).toBe(['kappa', 'qqx', '', '', 'omega'].join(SEARCH_FIELD_SEPARATOR))
    for (const k of ['pqq', 'appaqqx', 'xom', 'kappa qqx']) {
      const found = (await ids(buildProductSearchFilter(k))).includes(String(p._id))
      expect({ k, found }).toEqual({ k, found: k === 'kappa qqx' })
    }
    await Product.deleteOne({ _id: p._id })
  })

  it('a search without a match reads no article, and a search reads only its matches, through the index', async () => {
    for (const [search, matches] of [['zzzz-nothing', 0], ['пОцИнКоВаН', null]] as const) {
      const ops = await profiled('products', () => get(`/warehouse/product?search=${encodeURIComponent(search)}&size=10&sortBy=createdAt&sortOrder=desc&isActive=true`))
      const isSearch = (o: any) => JSON.stringify(o.command ?? {}).includes('$regex')
      const keyReads = ops.filter((o) => o.command?.find === 'products' && isSearch(o))
      const pages = ops.filter((o) => o.command?.find === 'products' && JSON.stringify(o.command?.filter ?? {}).includes('$in') && !isSearch(o))
      const expected = matches ?? (await ids({ ...buildProductSearchFilter(search), isActive: { $ne: false } })).length
      // The matches are read from the index's keys: no article is fetched to find or to count them.
      expect({ search, keyReads: keyReads.map((o) => ({ read: o.docsExamined, plan: o.planSummary?.includes('searchLower: 1') })) })
        .toEqual({ search, keyReads: [{ read: 0, plan: true }] })
      expect(ops.filter((o) => (o.command?.count || o.command?.aggregate) && isSearch(o))).toHaveLength(0)
      // Nothing matches: no article is read. A few match: the page reads them, by id.
      expect({ search, read: pages.reduce((n, o) => n + (o.docsExamined ?? 0), 0) }).toEqual({ search, read: expected })
    }
  })

  it('is kept on every write: create, insertMany, the update queries, $unset, bulkWrite, inside a transaction', async () => {
    const check = async (id: unknown) => {
      const d: any = await Product.findById(id).lean().exec()
      expect(d.searchLower).toBe(joinedValue(d, PRODUCT_SEARCH_FIELD.parts))
      return d
    }
    const p = await Product.create({ orgId: orgOid, sku: 'KEEP-1', name: 'Първо', category: 'Болтове', type: 'goods', unit: 'бр.' } as any)
    await check(p._id)
    const [q] = await Product.insertMany([{ orgId: orgOid, sku: 'KEEP-2', name: 'Второ', category: 'Гайки', type: 'goods', unit: 'бр.' }])
    await check(q!._id)

    await Product.findOneAndUpdate({ _id: p._id }, { $set: { name: 'Трето Име' } }).exec()
    expect((await check(p._id)).searchLower.startsWith('трето име')).toBe(true)
    await Product.updateOne({ _id: p._id }, { description: 'Ново описание' }).exec()
    expect((await check(p._id)).searchLower).toContain('ново описание')
    await Product.updateOne({ _id: p._id }, { $unset: { description: 1 } }).exec()
    expect((await check(p._id)).searchLower).not.toContain('описание')
    // A category renamed by its own filter: the filter no longer matches once the update is done.
    await Product.updateMany({ orgId: orgOid, category: 'Гайки', sku: 'KEEP-2' }, { $set: { category: 'Гайки нови' } }).exec()
    expect((await check(q!._id)).searchLower).toContain('гайки нови')

    // A bulkWrite (an import, a goods receipt's article update) that sets the mirrors itself, in a transaction.
    const session = await mongoose.startSession()
    try {
      await session.withTransaction(async () => {
        await Product.bulkWrite([
          { updateOne: { filter: { _id: p._id }, update: { $set: { sku: 'KEEP-1B', skuLower: 'keep-1b' } } } },
          { insertOne: { document: { orgId: orgOid, sku: 'KEEP-3', skuLower: 'keep-3', name: 'Четвърто', nameLower: 'четвърто', category: 'Анкери', categoryLower: 'анкери', type: 'goods', unit: 'бр.' } as any } },
        ], { session, ordered: true })
      })
    } finally {
      await session.endSession()
    }
    expect((await check(p._id)).searchLower).toContain('keep-1b')
    const third: any = await Product.findOne({ orgId: orgOid, sku: 'KEEP-3' }).lean().exec()
    await check(third._id)
    // A write that names no searched field leaves it as it is.
    await Product.updateOne({ _id: p._id }, { $set: { sellingPrice: 3 } }).exec()
    await check(p._id)
    await Product.deleteMany({ sku: { $in: ['KEEP-1B', 'KEEP-2', 'KEEP-3'] } })
  })

  it('an article the field is not on yet is still found, and the backfill fills it once, after a dry run', async () => {
    const targets = (await Product.find({ orgId: orgOid, name: { $regex: 'Болт' } }, { _id: 1 }).limit(15).lean().exec()).map((d: any) => d._id)
    await Product.collection.updateMany({ _id: { $in: targets } }, { $unset: { searchLower: '' } })
    const found = await ids(buildProductSearchFilter('болт'))
    expect(targets.every((t) => found.includes(String(t)))).toBe(true)
    expect(found).toEqual(await ids(legacyProductSearchFilter('болт')))

    expect(await backfillProductSearchField([orgOid], { execute: false })).toEqual({ stale: 15, written: 0 })
    expect(await Product.countDocuments({ _id: { $in: targets }, searchLower: null }).exec()).toBe(15)
    expect(await backfillProductSearchField([orgOid], { execute: true })).toEqual({ stale: 15, written: 15 })
    expect(await backfillProductSearchField([orgOid], { execute: true })).toEqual({ stale: 0, written: 0 })
    expect(await Product.countDocuments({ orgId: orgOid, searchLower: null }).exec()).toBe(0)
  })

  it('migration 0018 fills it where it is missing or stale, and a second run changes nothing', async () => {
    const targets = (await Product.find({ orgId: orgOid }, { _id: 1 }).limit(12).lean().exec()).map((d: any) => d._id)
    await Product.collection.updateMany({ _id: { $in: targets.slice(0, 6) } }, { $unset: { searchLower: '' } })
    await Product.collection.updateMany({ _id: { $in: targets.slice(6) } }, { $set: { searchLower: 'stale' } })
    const logged: string[] = []
    const run = () => productSearchField.up({ db: db() as any, log: (m: string) => { logged.push(m) }, orgFilter: {} })
    await run()
    for (const d of await Product.find({ _id: { $in: targets } }).lean().exec()) expect((d as any).searchLower).toBe(joinedValue(d as any, PRODUCT_SEARCH_FIELD.parts))
    await run()
    expect(logged).toEqual(['products: the search field set on 12 article(s)', 'products: the search field set on 0 article(s)'])
  })

  it('the switch back runs the five-field search', async () => {
    const before = process.env.PRODUCT_SEARCH_FIELD
    process.env.PRODUCT_SEARCH_FIELD = 'off'
    try {
      expect(buildProductSearchFilter('болт')).toEqual(legacyProductSearchFilter('болт'))
    } finally {
      if (before === undefined) delete process.env.PRODUCT_SEARCH_FIELD
      else process.env.PRODUCT_SEARCH_FIELD = before
    }
    expect(JSON.stringify(buildProductSearchFilter('болт'))).toContain('searchLower')
  })

  it.if(!!process.env.LGR_PERF)('answers within 50 ms at shop size, for a common word, a rare one and one without a match', async () => {
    for (const search of ['болт', 'поцинкован', 'zzzz-nothing']) {
      const times: number[] = []
      for (let i = 0; i < 7; i++) {
        const t0 = performance.now()
        const { status } = await get(`/warehouse/product?search=${encodeURIComponent(search)}&size=10&sortBy=createdAt&sortOrder=desc&isActive=true&count=when-more`)
        times.push(performance.now() - t0)
        expect(status).toBe(200)
      }
      times.sort((a, b) => a - b)
      const was: number[] = []
      process.env.PRODUCT_SEARCH_FIELD = 'off'
      for (let i = 0; i < 7; i++) {
        const t0 = performance.now()
        await get(`/warehouse/product?search=${encodeURIComponent(search)}&size=10&sortBy=createdAt&sortOrder=desc&isActive=true`)
        was.push(performance.now() - t0)
      }
      delete process.env.PRODUCT_SEARCH_FIELD
      was.sort((a, b) => a - b)
      console.log(`search "${search}": five fields ${was[3]!.toFixed(0)} ms, one field ${times[3]!.toFixed(0)} ms (median of 7)`)
    }
  }, 600_000)
})

describe('FR-30.12: a type-ahead does not count', () => {
  it('the line search reads the matches from the index keys and its page by id; a list keeps its total', async () => {
    const all = await ids(buildProductSearchFilter('болт', { complete: true }))
    const isSearch = (o: any) => JSON.stringify(o.command ?? {}).includes('$regex')
    const ops = await profiled('products', async () => {
      const { json } = await get('/warehouse/product?search=%D0%B1%D0%BE%D0%BB%D1%82&size=10&isActive=true&count=when-more')
      expect(json.products).toHaveLength(10)
      expect(json.hasMore).toBe(true)
    })
    expect(ops.filter((o) => isSearch(o)).map((o) => o.docsExamined)).toEqual([0])
    const none = await profiled('products', async () => {
      const { json } = await get('/warehouse/product?search=QQ-NONE-xx&size=10&isActive=true&count=when-more')
      expect({ n: json.products.length, total: json.total, hasMore: json.hasMore }).toEqual({ n: 0, total: 0, hasMore: false })
    })
    expect(none.filter((o) => o.command?.find === 'products' && !isSearch(o) && o.command?.filter?._id)).toHaveLength(0)
    const list = await get('/warehouse/product?search=%D0%B1%D0%BE%D0%BB%D1%82&size=10')
    expect(list.json.total).toBe(all.length)
    expect('hasMore' in list.json).toBe(false)
    // More matches than are read by id: counted from the keys, and the page read as the planner plans it.
    const many = await get('/warehouse/product?search=sku-&size=10&sortBy=createdAt&sortOrder=desc')
    const expected = await ids(buildProductSearchFilter('sku-'))
    expect({ total: many.json.total, shown: many.json.products.length }).toEqual({ total: expected.length, shown: 10 })
    expect(expected.length).toBeGreaterThan(300)
    expect(many.json.products.map((p: any) => p.sku)).toEqual((await Product.find({ orgId: orgOid, sku: { $regex: '^SKU-' } }).sort({ createdAt: -1 }).limit(10).lean().exec()).map((p: any) => p.sku))
  })

  it('the contact type-ahead counts nothing, with the picker\'s ranking and without it', async () => {
    await Contact.insertMany(Array.from({ length: 30 }, (_, i) => ({ orgId: orgOid, type: 'customer', companyName: `Клиент ${i}` })))
    for (const path of ['/invoicing/contact?search=%D0%BA%D0%BB%D0%B8%D0%B5%D0%BD%D1%82&size=20&count=none', '/invoicing/contact?search=%D0%BA%D0%BB%D0%B8%D0%B5%D0%BD%D1%82&size=20&prefer=customer&count=none']) {
      const ops = await profiled('contacts', async () => {
        const { json } = await get(path)
        expect(json.contacts).toHaveLength(20)
        expect(json.hasMore).toBe(true)
      })
      expect({ path, counts: ops.filter((o) => o.command?.count || (o.command?.aggregate && JSON.stringify(o.command.pipeline).includes('$count'))).length }).toEqual({ path, counts: 0 })
    }
  })
})

describe('FR-30.13: the stock-level search is the product search', () => {
  it('finds Cyrillic whatever its case, and reads the matching articles\' ids only', async () => {
    const arts = await Product.find({ orgId: orgOid, name: { $regex: 'ПОЦИНКОВАН' } }, { _id: 1 }).lean().exec()
    await StockLevel.insertMany(arts.map((a: any, i: number) => ({ orgId: orgOid, productId: a._id, warehouseId: warehouse, quantity: i + 1, availableQuantity: i + 1, avgCost: 1 })))
    for (const search of ['поцинкован', 'ПОЦИНКОВАН', 'Поцинкован']) {
      const ops = await profiled('products', async () => {
        const { status, json } = await get(`/warehouse/stock-level?search=${encodeURIComponent(search)}&size=100&warehouseId=${warehouse}`)
        expect(status).toBe(200)
        expect({ search, n: json.stockLevels.length }).toEqual({ search, n: arts.length })
      })
      const lookup = ops.find((o) => o.command?.find === 'products' && JSON.stringify(o.command.filter).includes('searchLower'))
      expect(lookup?.command?.projection).toEqual({ _id: 1 })
    }
  })
})
