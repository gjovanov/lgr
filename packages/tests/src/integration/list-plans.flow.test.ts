import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'

import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../api/src/api.js'
import { spaErrorHandler } from '../../../api/src/spa-fallback.js'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { Account, Contact, Employee, Invoice, Product, ProductCategory, StockLevel, StockMovement, User } from 'db/models'
import { tokenize } from 'services/biz/auth.service'
import { LIST_SORTS, type ListSortId } from 'config/list-sorts'
import { dropUnreadTextIndexes, TEXT_INDEX_COLLECTIONS } from 'migrations/migrations/0016-drop-unread-text-indexes'

/**
 * FR-30 slice A (#795): a list reads a page, not the organization's collection.
 *
 * FR-30.1: the default query of the Products, Sales invoices, Bills, Stock levels and Movements lists, as the grids
 * send it, and with their usual filters, has no in-memory sort and reads at most five times the page size.
 * FR-30.2: every sort a list declares as index-served (`config/list-sorts`) passes the same test, in both orders; a
 * `sortBy` the list does not declare runs its default sort. FR-30.3: the contact ledger's cash-sale rule reads the
 * invoices of that contact only. FR-30.4: the text indexes are gone from the schemas, and the migration drops them.
 *
 * Measured as the audit measured it: the database's profiler, on the real routes. A plan does not depend on the
 * size, so the fixture is small (FR-30.28); what matters is that it is several pages deep, so a plan that reads the
 * collection reads far more than five pages.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
const oid = () => new mongoose.Types.ObjectId()
const PAGE = 10
const READ_BUDGET = PAGE * 5

let app: Elysia
let orgId: string
let token = ''
let warehouseA: mongoose.Types.ObjectId
let ledgerContact: mongoose.Types.ObjectId

const db = () => mongoose.connection.db!

async function get(path: string): Promise<{ status: number; json: any }> {
  const res = await app.handle(new Request(`http://localhost/api/org/${orgId}${path}`, { headers: { authorization: `Bearer ${token}` } }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

interface Profiled { op: string; ns: string; command: any; docsExamined?: number; keysExamined?: number; hasSortStage?: boolean; planSummary?: string; nreturned?: number }

/** The operations a call ran on `collection`, read off the profiler (level 2, this database only). */
async function profiled(collection: string, run: () => Promise<unknown>): Promise<Profiled[]> {
  await db().command({ profile: 0 })
  await db().collection('system.profile').drop().catch(() => {})
  await db().command({ profile: 2 })
  try {
    await run()
  } finally {
    await db().command({ profile: 0 })
  }
  const ns = `${db().databaseName}.${collection}`
  return (await db().collection('system.profile').find({ ns }).toArray()) as unknown as Profiled[]
}

/** The page's `find` of a list call: the one with a limit (the count and the lookups after the page have none). */
async function pageFind(collection: string, path: string): Promise<Profiled & { status: number; collection: string }> {
  let status = 0
  const ops = await profiled(collection, async () => { status = (await get(path)).status })
  const finds = ops.filter((o) => o.command?.find === collection && o.command?.limit)
  expect({ path, finds: finds.length }).toEqual({ path, finds: 1 })
  return { ...finds[0]!, status, collection }
}

/** The profiler names an index by its keys (`IXSCAN { orgId: 1, createdAt: -1 }`); the tables name it by its name. */
async function scanOf(collection: string, index: string): Promise<string> {
  const found = (await db().collection(collection).indexes()).find((i) => i.name === index)
  expect({ collection, index, declared: !!found }).toEqual({ collection, index, declared: true })
  return `IXSCAN { ${Object.entries(found!.key).map(([k, v]) => `${k}: ${v}`).join(', ')} }`
}

/** FR-30.1's test: no in-memory sort, at most five pages read, through the index named. */
async function servedFromIndex(path: string, op: Profiled & { status: number; collection: string }, index: string) {
  expect({ path, status: op.status }).toEqual({ path, status: 200 })
  const scan = await scanOf(op.collection, index)
  expect({ path, sortInMemory: !!op.hasSortStage, plan: op.planSummary?.includes(scan) ? index : op.planSummary })
    .toEqual({ path, sortInMemory: false, plan: index })
  expect({ path, withinBudget: (op.docsExamined ?? Infinity) <= READ_BUDGET ? true : op.docsExamined })
    .toEqual({ path, withinBudget: true })
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  const org = await createTestOrg({ slug: 'list-plans' } as any)
  orgId = String(org._id)
  const admin = await createTestUser(org._id, { role: 'admin', username: 'admin', email: 'admin@list-plans.test' } as any)
  token = await (signer as any).decorator.jwt.sign(await tokenize((await User.findById(admin._id).exec())!))

  // Another org's rows beside ours, as on any server: the indexes start with the org.
  const other = oid()
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 3_600_000)
  warehouseA = oid()
  const warehouseB = oid()
  const contacts = Array.from({ length: 12 }, () => oid())
  ledgerContact = contacts[0]!

  // 400 articles; one in eight deactivated, which the grid's default ("active") leaves out.
  const products = Array.from({ length: 400 }, (_, i) => ({
    _id: oid(), orgId: org._id, sku: `S-${String(i).padStart(4, '0')}`, name: `Article ${(i * 7919) % 400}`, nameLower: `article ${(i * 7919) % 400}`,
    category: `Cat ${i % 5}`, type: 'goods', unit: 'pcs', sellingPrice: i, isActive: i % 8 !== 0, priceTiers: [], tags: [],
    createdAt: at(i), updatedAt: at(i),
  }))
  await Product.collection.insertMany([...products, ...products.slice(0, 50).map((p) => ({ ...p, _id: oid(), orgId: other }))] as any[])

  // Two stock levels an article, one in each of two warehouses.
  const levels = products.flatMap((p, i) => [warehouseA, warehouseB].map((w, k) => ({
    _id: oid(), orgId: org._id, productId: p._id, warehouseId: w, quantity: (i + k) % 9, reservedQuantity: 0, availableQuantity: (i + k) % 9, avgCost: 1,
    createdAt: at(2 * i + k), updatedAt: at(2 * i + k),
  })))
  await StockLevel.collection.insertMany(levels as any[])

  // 500 documents in the shape of a shop-year: four in five outgoing (sales invoices with their notes, a cash sale
  // and a proforma now and then), one in five a bill. Some invoices were issued for a cash sale of a contact.
  const OUT_TYPES = ['invoice', 'invoice', 'invoice', 'invoice', 'invoice', 'invoice', 'credit_note', 'cash_sale', 'proforma', 'invoice']
  const STATUSES = ['draft', 'sent', 'paid', 'partially_paid', 'overdue']
  const invoices = Array.from({ length: 500 }, (_, i) => {
    const incoming = i % 5 === 4
    const type = incoming ? 'invoice' : OUT_TYPES[i % OUT_TYPES.length]
    const contactId = contacts[i % contacts.length]
    return {
      _id: oid(), orgId: org._id, direction: incoming ? 'incoming' : 'outgoing', type, status: STATUSES[Math.floor(i / 5) % STATUSES.length],
      invoiceNumber: `${incoming ? 'BILL' : 'INV'}-${String(i).padStart(6, '0')}`, contactId, currency: 'EUR',
      issueDate: at(i), dueDate: at(i + 720), subtotal: i, taxTotal: i / 5, total: i * 1.2, amountPaid: 0, amountDue: i * 1.2,
      lines: [], payments: [], tags: [],
      ...(!incoming && type === 'invoice' && i % 3 === 0 ? { cashSaleRef: { cashSaleId: oid(), contactId } } : {}),
      createdAt: at(i), updatedAt: at(i),
    }
  })
  await Invoice.collection.insertMany([...invoices, ...invoices.slice(0, 50).map((d) => ({ ...d, _id: oid(), orgId: other }))] as any[])

  // 300 movements, dated out of the order they were made in (an import brings old ones).
  const MOVE_TYPES = ['receipt', 'dispatch', 'transfer', 'adjustment']
  const movements = Array.from({ length: 300 }, (_, i) => ({
    _id: oid(), orgId: org._id, movementNumber: `SM-2026-${String(i).padStart(5, '0')}`, type: MOVE_TYPES[i % 4], status: i % 6 ? 'confirmed' : 'draft',
    date: at((i * 37) % 300), toWarehouseId: warehouseA, fromWarehouseId: i % 4 === 2 ? warehouseB : undefined, lines: [], totalAmount: i,
    createdAt: at(i), updatedAt: at(i),
  }))
  await StockMovement.collection.insertMany(movements as any[])
})

afterAll(async () => {
  await db().command({ profile: 0 }).catch(() => {})
  await teardownTestDB()
})

/** Each list's grid query today: what its view sends when it opens (`usePaginatedTable` / `useProductList`). */
const DEFAULT_QUERIES: Array<{ list: string; collection: string; path: string; index: string }> = [
  { list: 'Products', collection: 'products', path: `/warehouse/product?page=0&size=${PAGE}&sortBy=createdAt&sortOrder=desc&isActive=true`, index: 'orgId_1_createdAt_-1' },
  { list: 'Sales invoices', collection: 'invoices', path: `/invoices?page=0&size=${PAGE}&sortBy=createdAt&sortOrder=desc&direction=outgoing&types=invoice,credit_note,debit_note`, index: 'orgId_1_direction_1_createdAt_-1' },
  { list: 'Bills', collection: 'invoices', path: `/invoices?page=0&size=${PAGE}&sortBy=createdAt&sortOrder=desc&direction=incoming&types=invoice,credit_note,debit_note`, index: 'orgId_1_direction_1_createdAt_-1' },
  { list: 'Stock levels', collection: 'stocklevels', path: `/warehouse/stock-level?page=0&size=${PAGE}&sortBy=createdAt&sortOrder=desc`, index: 'orgId_1_createdAt_-1' },
  { list: 'Movements', collection: 'stockmovements', path: `/warehouse/movement?page=0&size=${PAGE}&sortBy=createdAt&sortOrder=desc`, index: 'orgId_1_createdAt_-1' },
]

describe('FR-30.1: a list opens on a page, not on the collection', () => {
  for (const q of DEFAULT_QUERIES) {
    it(`${q.list}: the grid's first page`, async () => {
      await servedFromIndex(q.path, await pageFind(q.collection, q.path), q.index)
    })
  }

  it('and through the API with no sort named (each list\'s own default)', async () => {
    const cases: Array<[string, string, string]> = [
      ['products', `/warehouse/product?size=${PAGE}`, 'orgId_1_name_1'],
      ['invoices', `/invoices?size=${PAGE}&direction=outgoing`, 'orgId_1_direction_1_createdAt_-1'],
      ['stocklevels', `/warehouse/stock-level?size=${PAGE}`, 'orgId_1_createdAt_-1'],
      ['stockmovements', `/warehouse/movement?size=${PAGE}`, 'orgId_1_date_-1'],
    ]
    for (const [collection, path, index] of cases) await servedFromIndex(path, await pageFind(collection, path), index)
  })

  it('with the lists\' usual filters', async () => {
    const cases: Array<[string, string, string]> = [
      // A warehouse chosen on Stock levels.
      ['stocklevels', `/warehouse/stock-level?page=0&size=${PAGE}&sortBy=createdAt&sortOrder=desc&warehouseId=${warehouseA}`, 'orgId_1_createdAt_-1'],
      // A type, and a status, chosen on Movements.
      ['stockmovements', `/warehouse/movement?page=0&size=${PAGE}&sortBy=createdAt&sortOrder=desc&status=confirmed`, 'orgId_1_createdAt_-1'],
      ['stockmovements', `/warehouse/movement?page=0&size=${PAGE}&sortBy=date&sortOrder=desc&type=receipt`, 'orgId_1_type_1_date_-1'],
      // Open documents on Sales invoices (every status but the draft), and the plain invoices.
      ['invoices', `/invoices?page=0&size=${PAGE}&sortBy=createdAt&sortOrder=desc&direction=outgoing&types=invoice,credit_note,debit_note&status=sent,paid,partially_paid,overdue`, 'orgId_1_direction_1_createdAt_-1'],
      ['invoices', `/invoices?page=0&size=${PAGE}&sortBy=createdAt&sortOrder=desc&direction=outgoing&types=invoice`, 'orgId_1_direction_1_createdAt_-1'],
      // Deactivated articles included (the list's "All").
      ['products', `/warehouse/product?page=0&size=${PAGE}&sortBy=createdAt&sortOrder=desc`, 'orgId_1_createdAt_-1'],
    ]
    for (const [collection, path, index] of cases) await servedFromIndex(path, await pageFind(collection, path), index)
  })
})

/** The path of a list for a sort, with the filters its grid always sends. */
const LIST_PATHS: Record<ListSortId, { collection: string; path: (sort: string, order: string) => string; also?: (sort: string, order: string) => string }> = {
  products: { collection: 'products', path: (s, o) => `/warehouse/product?page=0&size=${PAGE}&sortBy=${s}&sortOrder=${o}&isActive=true` },
  // Sales invoices, and Bills: one document in five.
  invoices: {
    collection: 'invoices',
    path: (s, o) => `/invoices?page=0&size=${PAGE}&sortBy=${s}&sortOrder=${o}&direction=outgoing&types=invoice,credit_note,debit_note`,
    also: (s, o) => `/invoices?page=0&size=${PAGE}&sortBy=${s}&sortOrder=${o}&direction=incoming&types=invoice,credit_note,debit_note`,
  },
  stockLevels: { collection: 'stocklevels', path: (s, o) => `/warehouse/stock-level?page=0&size=${PAGE}&sortBy=${s}&sortOrder=${o}` },
  movements: { collection: 'stockmovements', path: (s, o) => `/warehouse/movement?page=0&size=${PAGE}&sortBy=${s}&sortOrder=${o}` },
}

describe('FR-30.2: a list sorts only as it declares', () => {
  for (const list of Object.keys(LIST_SORTS) as ListSortId[]) {
    it(`${list}: every index-served sort reads a page, in both orders`, async () => {
      const { collection, path, also } = LIST_PATHS[list]
      for (const [key, { served }] of Object.entries(LIST_SORTS[list].keys)) {
        if (!('index' in served)) continue
        for (const order of ['asc', 'desc']) {
          for (const p of [path(key, order), ...(also ? [also(key, order)] : [])]) await servedFromIndex(p, await pageFind(collection, p), served.index)
        }
      }
    })
  }

  it('a sort the list does not declare runs the default sort, which reads a page', async () => {
    const cases: Array<[ListSortId, string, string]> = [
      // A name the server looks up after the page; and a field of the lines.
      ['invoices', 'contactName', 'orgId_1_direction_1_createdAt_-1'],
      ['invoices', 'lines.productId', 'orgId_1_direction_1_createdAt_-1'],
      ['stockLevels', 'productName', 'orgId_1_createdAt_-1'],
      ['stockLevels', 'warehouseName', 'orgId_1_createdAt_-1'],
      ['products', 'priceTiers', 'orgId_1_name_1'],
      ['movements', 'lines', 'orgId_1_date_-1'],
    ]
    for (const [list, key, index] of cases) {
      const { collection, path } = LIST_PATHS[list]
      const op = await pageFind(collection, path(key, 'asc'))
      await servedFromIndex(path(key, 'asc'), op, index)
      const spec = LIST_SORTS[list]
      expect({ list, key, sort: op.command.sort })
        .toEqual({ list, key, sort: { [spec.keys[spec.defaultKey]!.field]: spec.defaultOrder === 'asc' ? 1 : -1 } })
    }
  })

  it('the default order is kept: the rows of the first page are the newest, as before', async () => {
    const { json } = await get(LIST_PATHS.invoices.path('createdAt', 'desc'))
    const expected = await Invoice.find({ orgId, direction: 'outgoing', type: { $in: ['invoice', 'credit_note', 'debit_note'] } }).sort({ createdAt: -1 }).limit(PAGE).lean()
    expect(json.invoices.map((d: any) => d.invoiceNumber ?? d.number)).toEqual(expected.map((d: any) => d.invoiceNumber))
  })

  it('the sorts no index serves are the ones written down, each with its reason', () => {
    const unindexed = Object.fromEntries((Object.keys(LIST_SORTS) as ListSortId[]).map((list) => [
      list,
      Object.entries(LIST_SORTS[list].keys).filter(([, k]) => !('index' in k.served)).map(([key]) => key).sort(),
    ]))
    // A new key here is a decision (FR-30.2): an index, or a reason the filtered rows are few enough. `_id` is on
    // every list for what reads the whole list in pages (the suite below), and no grid offers it.
    expect(unindexed).toEqual({
      products: ['_id', 'isActive', 'minStockLevel', 'purchasePrice', 'sellingPrice', 'type', 'unit'],
      invoices: ['_id', 'amountDue', 'currency', 'reference', 'status', 'subtotal', 'taxTotal', 'total', 'type'],
      stockLevels: ['_id', 'quantity'],
      movements: ['_id', 'contactName', 'fromWarehouseName', 'status', 'toWarehouseName', 'total'],
    })
    for (const list of Object.keys(LIST_SORTS) as ListSortId[]) {
      for (const [key, { served }] of Object.entries(LIST_SORTS[list].keys)) {
        const why = 'scan' in served ? served.scan : 'aggregate' in served ? served.aggregate : served.index
        expect({ list, key, why: why.length > 5 }).toEqual({ list, key, why: true })
      }
    }
  })
})

/**
 * The import and audit tooling reads a WHOLE list over the API, in pages (`fetchAll` in `scripts/compare-stock-api.ts`,
 * `.claude/skills/daily-import/predict.ts` and seven more): `page=N&size=…&sortBy=_id&sortOrder=asc`, until a page
 * adds nothing. It asks for the id because pages need an order with no ties: rows whose sort keys are equal come in
 * whatever order the database finds them, which may differ for another skip, so a page can repeat a row and leave
 * another out, and nothing tells the reader (its loop just ends). Every list's default sort has ties (a name, the
 * moment a batch was inserted, a movement's day). The id is the one key every list has that has none.
 */
describe('a whole list read in pages by the id, as the import and audit tooling reads it', () => {
  const SIZE = 60

  /** `fetchAll` as the scripts have it: page after page, each row once, until a page adds nothing. */
  async function fetchAll(path: string, key: string): Promise<{ ids: string[]; total: number | undefined; pages: number }> {
    const ids: string[] = []
    const seen = new Set<string>()
    const sep = path.includes('?') ? '&' : '?'
    let total: number | undefined
    let pages = 0
    for (let page = 0; page < 50; page++) {
      const { status, json } = await get(`${path}${sep}page=${page}&size=${SIZE}&sortBy=_id&sortOrder=asc`)
      expect({ path, page, status }).toEqual({ path, page, status: 200 })
      const items: any[] = json[key] || []
      total = json.total
      let added = 0
      for (const it of items) { const id = String(it._id); if (!seen.has(id)) { seen.add(id); ids.push(id); added++ } }
      if (!items.length || !added) break
      pages++
    }
    return { ids, total, pages }
  }

  const idsOf = async (model: { find(f: any, p: any): any }, filter: Record<string, unknown>) =>
    ((await model.find(filter, { _id: 1 }).sort({ _id: 1 }).lean()) as Array<{ _id: unknown }>).map((d) => String(d._id))

  const WHOLE: Array<{ name: string; path: () => string; key: string; own: () => Promise<string[]> }> = [
    { name: 'Products', path: () => '/warehouse/product', key: 'products', own: () => idsOf(Product, { orgId }) },
    { name: 'Stock levels of a warehouse', path: () => `/warehouse/stock-level?warehouseId=${warehouseA}`, key: 'stockLevels', own: () => idsOf(StockLevel, { orgId, warehouseId: warehouseA }) },
    { name: 'Documents', path: () => '/invoices', key: 'invoices', own: () => idsOf(Invoice, { orgId }) },
    { name: 'Movements', path: () => '/warehouse/movement', key: 'stockMovements', own: () => idsOf(StockMovement, { orgId }) },
  ]

  for (const list of WHOLE) {
    it(`${list.name}: every row once, in the id's order, over several pages`, async () => {
      const own = await list.own()
      expect(own.length).toBeGreaterThan(SIZE * 3)
      const { ids, total, pages } = await fetchAll(list.path(), list.key)
      const ascending = ids.every((id, i) => i === 0 || ids[i - 1]! < id)
      expect({ list: list.name, rows: ids.length, total, pages, ascending, same: ids.join() === own.join() })
        .toEqual({ list: list.name, rows: own.length, total: own.length, pages: Math.ceil(own.length / SIZE), ascending: true, same: true })
    })
  }

  it('and the page query sorts by the id, in the order asked', async () => {
    for (const [collection, path] of [
      ['products', '/warehouse/product'], ['invoices', '/invoices'], ['stocklevels', '/warehouse/stock-level'], ['stockmovements', '/warehouse/movement'],
    ] as const) {
      const asc = await pageFind(collection, `${path}?page=1&size=${PAGE}&sortBy=_id&sortOrder=asc`)
      expect({ path, status: asc.status, sort: asc.command.sort }).toEqual({ path, status: 200, sort: { _id: 1 } })
      const desc = await pageFind(collection, `${path}?page=1&size=${PAGE}&sortBy=_id&sortOrder=desc`)
      expect({ path, status: desc.status, sort: desc.command.sort }).toEqual({ path, status: 200, sort: { _id: -1 } })
    }
  })
})

describe('FR-30.3: the contact ledger reads one contact\'s invoices', () => {
  it('the cash sales an invoice was issued for are read through their partial index', async () => {
    const ops = await profiled('invoices', async () => {
      expect((await get(`/invoicing/contact-ledger/${ledgerContact}`)).status).toBe(200)
    })
    const distinct = ops.filter((o) => o.command?.distinct === 'invoices' && o.command?.query?.['cashSaleRef.contactId'])
    expect(distinct).toHaveLength(1)
    const own = await Invoice.countDocuments({ orgId, 'cashSaleRef.contactId': ledgerContact })
    expect(own).toBeGreaterThan(0)
    expect({ plan: distinct[0]!.planSummary, examined: distinct[0]!.docsExamined })
      .toEqual({ plan: expect.stringContaining(await scanOf('invoices', 'orgId_1_cashSaleRef.contactId_1')), examined: own })
  })
})

describe('FR-30.4: the text indexes nothing reads', () => {
  const MODELS = [Account, Contact, Employee, Invoice, ProductCategory, Product, StockMovement]

  it('no schema declares one', () => {
    for (const model of MODELS) {
      const text = model.schema.indexes().filter(([keys]) => Object.values(keys).includes('text'))
      expect({ model: model.modelName, text }).toEqual({ model: model.modelName, text: [] })
    }
    expect(MODELS.map((m) => m.collection.collectionName).sort()).toEqual([...TEXT_INDEX_COLLECTIONS].sort())
  })

  it('the migration drops each one an existing database still has, by the name it has, and only those', async () => {
    // What a database built before FR-30 holds: the seven, under the names Mongoose gave them.
    const OLD: Record<string, Record<string, 'text'>> = {
      accounts: { name: 'text', code: 'text', description: 'text' },
      contacts: { companyName: 'text', firstName: 'text', lastName: 'text', email: 'text' },
      employees: { firstName: 'text', middleName: 'text', lastName: 'text', email: 'text' },
      invoices: { invoiceNumber: 'text', notes: 'text', reference: 'text' },
      productcategories: { name: 'text' },
      products: { name: 'text', sku: 'text', barcode: 'text', description: 'text', category: 'text' },
      stockmovements: { movementNumber: 'text', notes: 'text' },
    }
    const names = async (c: string) => (await db().collection(c).indexes()).map((i) => i.name).sort()
    const before: Record<string, string[]> = {}
    for (const [c, keys] of Object.entries(OLD)) {
      before[c] = await names(c).catch(() => [])
      await db().collection(c).createIndex(keys)
    }
    const logged: string[] = []
    try {
      await dropUnreadTextIndexes.up({ db: db() as any, log: (m) => logged.push(m), orgFilter: {} })
      expect(logged).toHaveLength(7)
      for (const c of Object.keys(OLD)) expect({ c, after: await names(c) }).toEqual({ c, after: before[c]!.length ? before[c] : ['_id_'] })
      // Idempotent: nothing left to drop, nothing dropped.
      await dropUnreadTextIndexes.up({ db: db() as any, log: (m) => logged.push(m), orgFilter: {} })
      expect(logged).toHaveLength(7)
    } finally {
      // Whatever happened, the next test file meets the schemas' indexes.
      for (const c of Object.keys(OLD)) {
        for (const i of await db().collection(c).indexes().catch(() => [])) if ((i.key as any)?._fts === 'text') await db().collection(c).dropIndex(i.name!)
      }
    }
  })
})

// The budgets of FR-30 §0 at the audit's fixture size (FR-30.28): about one shop-year, in an organization of its own
// beside the small one. It takes a while to build and measures a machine, so it is opt-in:
// `LGR_PERF=1 bun test packages/tests/src/integration/list-plans.flow.test.ts --env-file=.env.test --timeout 900000`.
// "Before" is the same data with this slice's indexes dropped (what every database had), "after" with them built.
const perf = process.env.LGR_PERF === '1' ? describe : describe.skip
perf('the budgets at shop-year size (opt-in: LGR_PERF=1)', () => {
  it('each list\'s first page, and one contact\'s ledger, before and after the indexes', async () => {
    const big = await createTestOrg({ slug: 'list-plans-big' } as any)
    const bigId = String(big._id)
    const t0 = Date.UTC(2025, 0, 1)
    const at = (i: number, n: number) => new Date(t0 + Math.floor((i * 365 * 86_400_000) / n))
    const warehouses = [oid(), oid()]
    const contacts = Array.from({ length: 620 }, () => oid())
    const tiers = Array.from({ length: 10 }, (_, k) => ({ name: `Цена ${k}`, percent: 10 * k, finalPrice: 1 + k, manualOverride: false }))
    const insert = async (c: { insertMany(d: any[], o?: any): Promise<unknown> }, docs: any[]) => {
      for (let i = 0; i < docs.length; i += 2000) await c.insertMany(docs.slice(i, i + 2000), { ordered: false })
    }

    const N_PRODUCTS = 23_050
    const products = Array.from({ length: N_PRODUCTS }, (_, i) => ({
      _id: oid(), orgId: big._id, sku: `P-${String(i).padStart(6, '0')}`, name: `БОЛТ DIN 933 M${(i % 30) + 3}x${(i % 200) + 10} ${i}`,
      nameLower: `болт din 933 m${(i % 30) + 3}x${(i % 200) + 10} ${i}`, category: `Категория ${i % 40}`, type: 'goods', unit: 'pcs',
      purchasePrice: 1, sellingPrice: 2, isActive: i % 20 !== 0, priceTiers: tiers, tags: [], description: 'Стомана, поцинкована, клас 8.8',
      createdAt: at(i, N_PRODUCTS), updatedAt: at(i, N_PRODUCTS),
    }))
    await insert(Product.collection, products)
    // 46 100 levels: two warehouses per article.
    await insert(StockLevel.collection, products.flatMap((p, i) => warehouses.map((w, k) => ({
      _id: oid(), orgId: big._id, productId: p._id, warehouseId: w, quantity: (i + k) % 50, reservedQuantity: 0, availableQuantity: (i + k) % 50, avgCost: 1,
      createdAt: at(2 * i + k, 2 * N_PRODUCTS), updatedAt: at(2 * i + k, 2 * N_PRODUCTS),
    }))))
    const N_INVOICES = 10_020
    const line = (i: number, k: number) => ({
      _id: oid(), productId: products[(i * 12 + k) % N_PRODUCTS]!._id, description: products[(i * 12 + k) % N_PRODUCTS]!.name, quantity: 1 + k, unit: 'pcs',
      unitPrice: 2.5, discount: 0, taxRate: 20, taxAmount: 0.5, lineTotal: 3, warehouseId: warehouses[0],
      priceExplanation: [{ type: 'base', label: 'Продажна цена', price: 2.5 }],
    })
    await insert(Invoice.collection, Array.from({ length: N_INVOICES }, (_, i) => {
      const incoming = i % 5 === 4
      const type = incoming ? 'invoice' : (['invoice', 'invoice', 'invoice', 'credit_note', 'cash_sale'] as const)[i % 5]!
      const contactId = contacts[i % contacts.length]!
      return {
        _id: oid(), orgId: big._id, direction: incoming ? 'incoming' : 'outgoing', type, status: ['sent', 'paid', 'overdue', 'draft'][i % 4],
        invoiceNumber: `${incoming ? 'BILL' : 'INV'}-${String(i).padStart(7, '0')}`, contactId, currency: 'EUR', issueDate: at(i, N_INVOICES), dueDate: at(i + 300, N_INVOICES),
        subtotal: 30, taxTotal: 6, total: 36, amountPaid: 0, amountDue: 36, lines: Array.from({ length: 12 }, (_, k) => line(i, k)), payments: [], tags: [],
        ...(!incoming && type === 'invoice' && i % 7 === 0 ? { cashSaleRef: { cashSaleId: oid(), contactId } } : {}),
        createdAt: at(i, N_INVOICES), updatedAt: at(i, N_INVOICES),
      }
    }))
    const N_MOVES = 5_000
    await insert(StockMovement.collection, Array.from({ length: N_MOVES }, (_, i) => ({
      _id: oid(), orgId: big._id, movementNumber: `SM-2025-${String(i).padStart(5, '0')}`, type: ['receipt', 'dispatch', 'transfer', 'adjustment'][i % 4],
      status: 'confirmed', date: at(i, N_MOVES), toWarehouseId: warehouses[0], totalAmount: 10,
      lines: Array.from({ length: 10 }, (_, k) => ({ _id: oid(), productId: products[(i * 10 + k) % N_PRODUCTS]!._id, quantity: 1, unitCost: 1, totalCost: 1 })),
      createdAt: at(i, N_MOVES), updatedAt: at(i, N_MOVES),
    })))
    const ledgerOf = contacts[7]!

    const CASES: Array<[string, string, string]> = [
      ['Products', 'products', `/warehouse/product?page=0&size=${PAGE}&sortBy=createdAt&sortOrder=desc&isActive=true`],
      ['Products by name (API)', 'products', `/warehouse/product?page=0&size=${PAGE}`],
      ['Sales invoices', 'invoices', `/invoices?page=0&size=${PAGE}&sortBy=createdAt&sortOrder=desc&direction=outgoing&types=invoice,credit_note,debit_note`],
      ['Sales by number', 'invoices', `/invoices?page=0&size=${PAGE}&sortBy=number&sortOrder=asc&direction=outgoing&types=invoice,credit_note,debit_note`],
      ['Bills', 'invoices', `/invoices?page=0&size=${PAGE}&sortBy=createdAt&sortOrder=desc&direction=incoming&types=invoice,credit_note,debit_note`],
      ['Stock levels', 'stocklevels', `/warehouse/stock-level?page=0&size=${PAGE}&sortBy=createdAt&sortOrder=desc`],
      ['Movements', 'stockmovements', `/warehouse/movement?page=0&size=${PAGE}&sortBy=createdAt&sortOrder=desc`],
      ['Movements by date', 'stockmovements', `/warehouse/movement?page=0&size=${PAGE}&sortBy=date&sortOrder=desc`],
    ]
    const NEW: Array<[string, string]> = [
      ['products', 'orgId_1_createdAt_-1'], ['products', 'orgId_1_name_1'],
      ['invoices', 'orgId_1_direction_1_createdAt_-1'], ['invoices', 'orgId_1_direction_1_invoiceNumber_1'], ['invoices', 'orgId_1_cashSaleRef.contactId_1'],
      ['stocklevels', 'orgId_1_createdAt_-1'], ['stockmovements', 'orgId_1_date_-1'], ['stockmovements', 'orgId_1_createdAt_-1'],
    ]
    const bigAdmin = await createTestUser(big._id, { role: 'admin', username: 'admin', email: 'admin@list-plans-big.test' } as any)
    const saved = { orgId, token }
    orgId = bigId
    token = await (signer as any).decorator.jwt.sign(await tokenize((await User.findById(bigAdmin._id).exec())!))
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!
    const timed = async (path: string) => {
      for (let k = 0; k < 2; k++) await get(path)
      const ms: number[] = []
      for (let k = 0; k < 7; k++) { const s = performance.now(); expect((await get(path)).status).toBe(200); ms.push(performance.now() - s) }
      return Math.round(median(ms) * 10) / 10
    }
    const measure = async () => {
      const rows: Record<string, { ms: number; read: number | undefined; sorted?: boolean; countMs?: number }> = {}
      for (const [name, collection, path] of CASES) {
        const ms = await timed(path)
        const ops = await profiled(collection, () => get(path))
        const page = ops.find((o) => o.command?.find === collection && o.command?.limit) as Profiled & { millis?: number }
        // The list's total, `countDocuments`: an aggregate that matches and counts.
        const count = ops.find((o) => o.command?.aggregate === collection && o.command?.pipeline?.some((st: any) => st.$group)) as Profiled & { millis?: number } | undefined
        rows[name] = { ms, read: page?.docsExamined, sorted: !!page?.hasSortStage, countMs: count?.millis }
      }
      const ledger = `/invoicing/contact-ledger/${ledgerOf}`
      const ms = await timed(ledger)
      const ops = await profiled('invoices', () => get(ledger))
      const distinct = ops.find((o) => o.command?.distinct === 'invoices' && o.command?.query?.['cashSaleRef.contactId'])
      const started = performance.now()
      for (let k = 0; k < 7; k++) await Invoice.distinct('cashSaleRef.cashSaleId', { orgId: big._id, type: 'invoice', 'cashSaleRef.contactId': ledgerOf, status: { $nin: ['draft'] } } as any).exec()
      rows['Contact ledger (whole route)'] = { ms, read: distinct?.docsExamined }
      rows['Contact ledger (its cash-sale read)'] = { ms: Math.round(((performance.now() - started) / 7) * 10) / 10, read: distinct?.docsExamined }
      return rows
    }
    try {
      const keys = new Map<string, any>()
      for (const [c, name] of NEW) {
        const found = (await db().collection(c).indexes()).find((i) => i.name === name)!
        keys.set(`${c}/${name}`, { key: found.key, ...(found.partialFilterExpression ? { partialFilterExpression: found.partialFilterExpression } : {}) })
        await db().collection(c).dropIndex(name)
      }
      const before = await measure()
      for (const [c, name] of NEW) {
        const { key, ...opts } = keys.get(`${c}/${name}`)
        await db().collection(c).createIndex(key, { name, ...opts })
      }
      const after = await measure()
      console.log('FR-30 slice A at shop-year size (median of 7 API calls; documents the page query read)')
      console.table(Object.fromEntries(Object.keys(before).map((k) => [k, {
        'before ms': before[k]!.ms, 'before read': before[k]!.read, 'before sort in memory': before[k]!.sorted,
        'after ms': after[k]!.ms, 'after read': after[k]!.read, 'after sort in memory': after[k]!.sorted, 'after: its total, ms': after[k]!.countMs,
      }])))
      for (const [name] of CASES) expect({ name, read: after[name]!.read! <= READ_BUDGET, sorted: after[name]!.sorted }).toEqual({ name, read: true, sorted: false })
    } finally {
      ;({ orgId, token } = saved)
    }
  })
})
