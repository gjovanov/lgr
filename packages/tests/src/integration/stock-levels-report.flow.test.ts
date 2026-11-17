import { describe, it, expect, beforeAll, afterAll } from 'bun:test'

import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg } from '../helpers/factories'
import { mongoose } from 'db/connection'
import { Contact, Invoice, Product, ProductCategory, StockLevel, Warehouse } from 'db/models'
import { runStockLevels } from 'services/biz/reports/stock-levels.report'
import { legacyRunStockLevels } from '../helpers/stock-levels-report-legacy'
import { getInvoiceSummary, SUMMARY_STATUSES } from 'services/biz/invoice-summary.service'
import { cachedStockValuationTotals, getStockValuationTotals } from 'services/biz/warehouse.service'
import { forgetPickerRankings, pickerContacts } from 'services/biz/contact-picker.service'
import { ttlCache } from 'services/utils/ttl-cache'

/**
 * FR-30 slice D (#795): the stock-levels report and two dashboards.
 *
 * FR-30.14: without a filter that needs the article, the report sorts and cuts before it joins; with an article or a
 * category, that filter narrows the levels before the joins. Either way it returns the rows the old pipeline returned
 * (`helpers/stock-levels-report-legacy.ts`), with and without each filter, rolled up or not.
 * FR-30.15: the partner picker's ranking is aggregated once in five minutes per org and side.
 * FR-30.16: the KPI summary matches the statuses its tiles count first; the dashboard's stock value is at most a
 * minute old.
 *
 * `LGR_PERF=1` grows the fixture to a shop's 46 000 levels and prints the report's time.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const oid = () => new mongoose.Types.ObjectId()
const db = () => mongoose.connection.db!
let orgId: string
let orgOid: mongoose.Types.ObjectId
let warehouses: mongoose.Types.ObjectId[] = []
let parentCategory: mongoose.Types.ObjectId
let childCategory: mongoose.Types.ObjectId
let someProduct: mongoose.Types.ObjectId

async function profiled(collection: string, run: () => Promise<unknown>): Promise<any[]> {
  await db().command({ profile: 0 })
  await db().collection('system.profile').drop().catch(() => {})
  await db().command({ profile: 2 })
  try { await run() } finally { await db().command({ profile: 0 }) }
  return db().collection('system.profile').find({ ns: `${db().databaseName}.${collection}` }).toArray()
}

beforeAll(async () => {
  await setupTestDB()
  const org = await createTestOrg({ slug: 'stock-levels-report' } as any)
  orgOid = org._id as any
  orgId = String(org._id)
  warehouses = [oid(), oid(), oid()]
  await Warehouse.collection.insertMany(warehouses.map((_id, i) => ({ _id, orgId: org._id, name: `Склад ${i + 1}`, code: `W${i}`, isActive: true })) as any[])
  parentCategory = oid()
  childCategory = oid()
  await ProductCategory.collection.insertMany([
    { _id: parentCategory, orgId: org._id, name: 'Крепежи' },
    { _id: childCategory, orgId: org._id, name: 'Болтове', parentId: parentCategory },
    { _id: oid(), orgId: org._id, name: 'Инструменти' },
  ] as any[])

  const articles = process.env.LGR_PERF ? 15_400 : 400
  const products = Array.from({ length: articles }, (_, i) => ({
    _id: oid(), orgId: org._id, sku: `R-${i}`, name: `Артикул ${i}`, category: 'Болтове', unit: 'бр.', type: 'goods',
    categoryId: i % 3 === 0 ? childCategory : i % 3 === 1 ? parentCategory : undefined,
    minStockLevel: i % 4 === 0 ? 20 : undefined,
  }))
  someProduct = products[7]!._id
  for (let k = 0; k < products.length; k += 5000) await Product.collection.insertMany(products.slice(k, k + 5000) as any[])
  // Each article in the three warehouses: distinct values, so every order has one answer.
  const levels = products.flatMap((p, i) => warehouses.map((w, k) => {
    const quantity = (i * 7 + k * 3) % 40
    return {
      _id: oid(), orgId: org._id, productId: p._id, warehouseId: w, quantity, reservedQuantity: k, availableQuantity: quantity - k,
      avgCost: 1 + ((i * 13 + k) % 97) / 100 + i / 1e6 + k / 1e7,
    }
  }))
  for (let k = 0; k < levels.length; k += 10_000) await StockLevel.collection.insertMany(levels.slice(k, k + 10_000) as any[])
  // Another org's levels beside them.
  await StockLevel.collection.insertMany(levels.slice(0, 50).map((l) => ({ ...l, _id: oid(), orgId: oid() })) as any[])
}, 600_000)

afterAll(async () => {
  await db().command({ profile: 0 }).catch(() => {})
  await teardownTestDB()
})

const PARAM_SETS: Array<Record<string, unknown>> = [
  {},
  { includeZero: true },
  { groupBy: 'product' },
  { belowMin: true },
  { belowMin: true, groupBy: 'product' },
  { warehouseId: 'W1' },
  { productId: 'P' },
  { productId: 'P', groupBy: 'product' },
  { categoryId: 'PARENT' },
  { categoryId: 'CHILD', groupBy: 'product' },
  { categoryId: 'CHILD', belowMin: true },
  { categoryId: 'CHILD', productId: 'P' },
]

function paramsOf(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...p }
  if (p.warehouseId === 'W1') out.warehouseId = String(warehouses[1])
  if (p.productId === 'P') out.productId = String(someProduct)
  if (p.categoryId === 'PARENT') out.categoryId = String(parentCategory)
  if (p.categoryId === 'CHILD') out.categoryId = String(childCategory)
  return out
}

describe('FR-30.14: the stock-levels report limits before it joins', () => {
  for (const p of PARAM_SETS) {
    for (const output of ['table', 'xlsx'] as const) {
      it(`returns the rows the old pipeline returned: ${JSON.stringify(p)} (${output})`, async () => {
        const ctx = { orgId, params: paramsOf(p), output }
        const [now, was] = [await runStockLevels(ctx as any), await legacyRunStockLevels(ctx as any)]
        expect(now.rows.length).toBeGreaterThan(0)
        // The same rows; rows that tie on the order's key may come in either order, in both pipelines.
        const byJson = (rows: any[]) => rows.map((r) => JSON.stringify(r)).sort()
        expect(byJson(now.rows)).toEqual(byJson(was.rows))
        const key = p.belowMin ? (r: any) => r.quantity : (r: any) => -r.totalValue
        expect(now.rows.every((r: any, i: number) => i === 0 || key(now.rows[i - 1]) <= key(r))).toBe(true)
        expect(now.totals).toEqual(was.totals)
        expect(now.meta).toEqual(was.meta)
      })
    }
  }

  it('without a filter that needs the article, the articles and warehouses joined are the page\'s only', async () => {
    const ctx = { orgId, params: {}, output: 'table' }
    const cap = (await runStockLevels(ctx as any)).meta?.cap as number
    const ops = await profiled('products', () => runStockLevels(ctx as any))
    const read = ops.reduce((n, o) => n + (o.docsExamined ?? 0), 0)
    // The joins read one article per row kept (and one past the cap), not one per level.
    expect(read).toBeLessThanOrEqual(cap + 1)
  })

  it('a category narrows the levels before the joins', async () => {
    const ctx = { orgId, params: paramsOf({ categoryId: 'CHILD' }), output: 'table' }
    const ops = await profiled('stocklevels', () => runStockLevels(ctx as any))
    const agg = ops.find((o) => o.command?.aggregate === 'stocklevels')
    expect(JSON.stringify(agg?.command?.pipeline?.[0])).toContain('productId')
  })

  it.if(!!process.env.LGR_PERF)('answers within 500 ms at shop size', async () => {
    for (const run of [legacyRunStockLevels, runStockLevels]) {
      const times: number[] = []
      for (let i = 0; i < 5; i++) {
        const t0 = performance.now()
        await run({ orgId, params: {}, output: 'table' } as any)
        times.push(performance.now() - t0)
      }
      times.sort((a, b) => a - b)
      console.log(`${run === runStockLevels ? 'now' : 'was'}: ${times[2]!.toFixed(0)} ms (median of 5, ${await StockLevel.countDocuments({ orgId: orgOid })} levels)`)
      if (run === runStockLevels) expect(times[2]!).toBeLessThan(500)
    }
  }, 600_000)
})

describe('FR-30.15: the picker\'s ranking is not recomputed per form', () => {
  it('two forms opened within five minutes run the ranking aggregate once', async () => {
    forgetPickerRankings()
    const c = oid()
    await Contact.collection.insertOne({ _id: c, orgId: orgOid, type: 'customer', companyName: 'Клиент' } as any)
    await Invoice.collection.insertOne({ _id: oid(), orgId: orgOid, direction: 'outgoing', type: 'invoice', status: 'sent', contactId: c, issueDate: new Date(), invoiceNumber: 'R-1', total: 1 } as any)
    const ops = await profiled('invoices', async () => {
      await pickerContacts(orgId, { orgId }, 'customer', 0, 20)
      await pickerContacts(orgId, { orgId }, 'customer', 0, 20)
    })
    expect(ops.filter((o) => o.command?.aggregate === 'invoices')).toHaveLength(1)
    // The other side is its own ranking.
    const other = await profiled('invoices', () => pickerContacts(orgId, { orgId }, 'supplier', 0, 20))
    expect(other.filter((o) => o.command?.aggregate === 'invoices')).toHaveLength(1)
  })

  it('a kept value lives its time, and a failed read is not kept', async () => {
    let clock = 0
    const cache = ttlCache<number>(1000, () => clock)
    let loads = 0
    const load = async () => ++loads
    expect(await cache.get('k', load)).toBe(1)
    clock = 999
    expect(await cache.get('k', load)).toBe(1)
    clock = 1000
    expect(await cache.get('k', load)).toBe(2)
    let failed = false
    try { await cache.get('x', async () => { throw new Error('down') }) } catch { failed = true }
    expect(failed).toBe(true)
    expect(await cache.get('x', async () => 7)).toBe(7)
  })
})

describe('FR-30.16: dashboards do not re-read history', () => {
  it('the KPI summary\'s first stage matches the statuses its tiles count, and its figures are unchanged', async () => {
    const c = oid()
    const doc = (status: string, amount: number, extra: Record<string, unknown> = {}) => ({
      _id: oid(), orgId: orgOid, direction: 'outgoing', type: 'invoice', status, contactId: c, issueDate: new Date(), invoiceNumber: `K-${status}-${amount}`,
      total: amount, amountDue: amount, ...extra,
    })
    await Invoice.collection.insertMany([
      doc('sent', 10), doc('overdue', 20), doc('partially_paid', 5), doc('draft', 3), doc('paid', 40, { paidAt: new Date() }),
      doc('voided', 1000), doc('cancelled', 2000),
    ] as any[])
    const ops = await profiled('invoices', async () => {
      const s = await getInvoiceSummary(orgId, { direction: 'outgoing' })
      expect(s.outstanding).toEqual({ amount: 36, count: 4 })
      expect(s.overdue).toEqual({ amount: 20, count: 1 })
      expect(s.paid30d.count).toBe(1)
      expect(s.drafts.count).toBe(1)
    })
    const agg = ops.find((o) => o.command?.aggregate === 'invoices')
    expect(agg?.command?.pipeline?.[0]?.$match?.status).toEqual({ $in: SUMMARY_STATUSES })
  })

  it('the dashboard\'s stock value is read once a minute', async () => {
    const first = await cachedStockValuationTotals(orgId)
    expect(first).toEqual(await getStockValuationTotals(orgId))
    const ops = await profiled('stocklevels', () => cachedStockValuationTotals(orgId))
    expect(ops.filter((o) => o.command?.aggregate === 'stocklevels')).toHaveLength(0)
  })
})
