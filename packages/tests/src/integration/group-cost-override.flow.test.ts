import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import type { Types } from 'mongoose'
import { clearCollections, setupTestDB, teardownTestDB } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg, createTestProduct, createTestUser } from '../helpers/factories'
import { Account, AccountingAnalytic, AuditLog, GroupCostOverride, JournalEntry, ProductGroupMap } from 'db/models'
import { importAnalytics, importChart, importJournalMonth } from 'services/biz/accounting-books/import.service'
import { linkBooks } from 'services/biz/accounting-books/link-books.service'
import { parseAnalyticsFile } from 'services/biz/accounting-books/plusminus-exports'
import { seedPostingRules } from 'services/biz/accounting-books/posting-rule.service'
import { postShadowSales } from 'services/biz/accounting-books/shadow-sales.service'
import { createOverride, deleteOverride, updateOverride } from 'services/biz/accounting-books/group-cost-override.service'
import { createApiApp } from '../../../api/src/api.js'
import type { ImportDocument } from 'services/biz/accounting-books/import.types'

/**
 * FR-25 R3 (2026-11-25): the accountant's override of a goods group's average cost. Kept in the HOME of a split, it
 * restates the average every org of the split posts its sales at, from its day on; a change or a removal reposts the
 * shadow postings it changes, and only those. Made-up series, numbers, groups, products and amounts.
 */

const EIK = '000000000'
const SERIES_HOME = '90001'
const SERIES_STORE = '90002'
const CUSTOMER_EIK = '000000011'

const CHART = [['304', 'Стоки'], ['401', 'Доставчици'], ['411', 'Клиенти'], ['4531', 'ДДС за покупките'], ['4532', 'ДДС за продажбите'],
  ['501', 'Каса'], ['702', 'Приходи от стоки'], ['703', 'Приходи от услуги']].map(([code, name]) => ({ code, name }))

const G1 = 'СТОКИ:ТЕСТ ГРУПА 1'
const G2 = 'СТОКИ:ТЕСТ ГРУПА 2'
const CUSTOMER = 'КЛИЕНТИ:Тест Клиент'
const ITEMS = parseAnalyticsFile(new TextEncoder().encode(JSON.stringify([
  { ap: 'СТОКИ', params: {}, group: 'true' },
  { ap: G1, params: { 'МЯРКА': 'бр' } },
  { ap: G2, params: { 'МЯРКА': 'бр' } },
  { ap: 'КЛИЕНТИ', params: {}, group: 'true' },
  { ap: CUSTOMER, params: { 'БУЛСТАТ': CUSTOMER_EIK } },
])))

/** The home's purchase: the first group's average is 0.50 from the 2nd. */
const MARCH: ImportDocument[] = [
  { date: '2026-03-02', docType: '+ФЕ', docNumber: '0000000123', vatKind: '1', total: 84, ops: [
    { d: '304', k: '401', ad: G1, qty: 100, amount: 50 }, { d: '304', k: '401', ad: G2, qty: 10, amount: 20 }, { d: '4531', k: '401', amount: 14 },
  ] },
]
const MARCH_RUN = { from: '2026-03-01', to: '2026-03-31' }

interface World {
  home: string
  store: string
  plain: string
  userId: string
  g1: string
  docs: { early: string; late: string }
}
let world: World
let seq = 0

async function makeWorld(): Promise<World> {
  const n = ++seq
  const home = await createTestOrg({ slug: `gco-home-${n}`, name: 'Тест А', taxNumber: EIK } as never)
  const store = await createTestOrg({ slug: `gco-store-${n}`, name: 'Тест Б', taxNumber: EIK } as never)
  const plain = await createTestOrg({ slug: `gco-plain-${n}`, name: 'Тест В' } as never)
  await linkBooks({
    booksSlug: home.slug,
    split: true,
    branches: [{ slug: home.slug, code: 'A', docSeries: [SERIES_HOME] }, { slug: store.slug, code: 'B', docSeries: [SERIES_STORE] }],
  }, { dryRun: false })
  const user = await createTestUser(home._id as never, { role: 'admin' } as never)
  const by = { id: String(user._id) }
  // The partner card the books' customer links to, by its number: it exists before the analytics are imported.
  const customer = (await createTestContact(store._id, { companyName: 'Тест Клиент', taxId: CUSTOMER_EIK } as never))._id as Types.ObjectId
  for (const org of [home, store]) {
    const orgId = String(org._id)
    await importChart(orgId, { eik: EIK, dryRun: false, accounts: CHART }, by)
    await importAnalytics(orgId, { eik: EIK, dryRun: false, items: ITEMS }, by)
    await importJournalMonth(orgId, { eik: EIK, dryRun: false, month: '2026-03', coverage: { from: '2026-01-01', to: '2026-12-31' }, documents: MARCH }, by)
    await seedPostingRules(orgId, { execute: true })
  }
  const product = String((await createTestProduct(store._id, { name: 'ТЕСТОВ АРТИКУЛ 1', type: 'goods' } as never))._id)
  const storeG1 = (await AccountingAnalytic.findOne({ orgId: store._id, path: G1 }).lean())!._id
  await ProductGroupMap.create({ orgId: store._id, productId: product, analyticId: storeG1, source: 'accountant', evidenceCount: 1, conflictCount: 0 })
  const invoice = async (number: string, day: string) => String((await createTestInvoice(store._id, customer, {
    invoiceNumber: number, status: 'sent', issueDate: new Date(`${day}T09:00:00.000Z`),
    lines: [{ productId: product, description: 'Тестов ред', quantity: 10, unit: 'бр', unitPrice: 2, discount: 0, taxRate: 20, taxAmount: 4, lineTotal: 24 }],
    subtotal: 20, taxTotal: 4, total: 24, totalBase: 24, amountDue: 24,
  } as never))._id)
  return {
    home: String(home._id),
    store: String(store._id),
    plain: String(plain._id),
    userId: String(user._id),
    g1: String((await AccountingAnalytic.findOne({ orgId: home._id, path: G1 }).lean())!._id),
    docs: { early: await invoice(`INV-${SERIES_STORE}00001`, '2026-03-03'), late: await invoice(`INV-${SERIES_STORE}00002`, '2026-03-05') },
  }
}

/** The live shadow posting's cost of a document: `[group path, amount, quantity]` of its K304 lines. */
async function costOf(docId: string): Promise<unknown[][]> {
  const entries = await JournalEntry.find({ orgId: world.store, ledger: 'shadow', sourceId: docId }).sort({ postingKey: 1 }).lean()
  const live = entries.filter(e => !e.postingKey?.endsWith(':reversal')).at(-1)
  if (!live) return []
  const goods = (await Account.findOne({ orgId: world.store, code: '304' }).lean())!._id
  const paths = new Map((await AccountingAnalytic.find({ orgId: world.store }).lean()).map(a => [String(a._id), a.path]))
  return live.lines.filter(l => String(l.accountId) === String(goods)).map(l => [paths.get(String(l.analyticId)), l.credit, l.quantity])
}

const run = () => postShadowSales(world.store, { ...MARCH_RUN, execute: true, by: world.userId })
const by = () => ({ id: world.userId })

beforeAll(async () => {
  await setupTestDB()
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

beforeEach(async () => {
  await clearCollections()
  world = await makeWorld()
})

describe("the accountant's override of a group's average, in the shadow's cost of sales", () => {
  it("a store's sales post at the home's override from its day on, and the days before keep the replayed average", async () => {
    await createOverride(world.home, { analyticId: world.g1, from: '2026-03-05', unitCost: 0.8, reason: 'Брак' }, by())
    const r = await run()
    expect(r.cost.overrides).toBe(1)
    expect(await costOf(world.docs.early)).toEqual([[G1, 5, 10]])
    expect(await costOf(world.docs.late)).toEqual([[G1, 8, 10]])
  })

  it('a change reposts the postings it changes, on their own day, and a removal brings the replayed average back', async () => {
    const o = await createOverride(world.home, { analyticId: world.g1, from: '2026-03-05', unitCost: 0.8, reason: 'Брак' }, by())
    await run()
    const changed = await updateOverride(world.home, o.id, { unitCost: 0.6, reason: 'Брак, преброено', expected: o.updatedAt }, by())
    const second = await run()
    expect(second.actions).toMatchObject({ post: 0, repost: 1, none: 1 })
    expect(await costOf(world.docs.late)).toEqual([[G1, 6, 10]])
    const reversal = await JournalEntry.findOne({ postingKey: `shadow:invoice:${world.docs.late}:1:reversal` }).lean()
    expect(reversal?.date.toISOString().slice(0, 10)).toBe('2026-03-05')

    await deleteOverride(world.home, o.id, { expected: changed.updatedAt }, by())
    const third = await run()
    expect([third.actions.repost, third.cost.overrides]).toEqual([1, 0])
    expect(await costOf(world.docs.late)).toEqual([[G1, 5, 10]])
    expect((await run()).written).toEqual({ entries: 0, reversals: 0, vatRows: 0, raced: 0 })
  })
})

describe('the group costs page, over its routes', () => {
  const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
  let app: any

  async function call(orgId: string, method: string, path: string, body?: unknown) {
    app ??= new Elysia().use(createApiApp())
    const user = await createTestUser(orgId as never, { role: 'admin' } as never)
    const token = await (signer as any).decorator.jwt.sign({
      id: String(user._id), orgId, role: 'admin', email: user.email, username: user.username,
      firstName: 'Test', lastName: 'User', permissions: DEFAULT_ROLE_PERMISSIONS.admin, ownRecordsModules: [],
    })
    const res = await app.handle(new Request(`http://localhost/api/org/${orgId}/accounting/group-costs${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }))
    return { status: res.status, body: await res.json() as any }
  }

  it('adds, lists, changes and removes an override in the home, each in the audit trail, and refuses a stale page', async () => {
    const add = await call(world.home, 'POST', '/', { analyticId: world.g1, from: '2026-03-05', unitCost: 0.4, reason: 'Брак' })
    expect([add.status, add.body.path, add.body.from, add.body.unitCost, add.body.active]).toEqual([200, G1, '2026-03-05', 0.4, true])
    const twice = await call(world.home, 'POST', '/', { analyticId: world.g1, from: '2026-03-05', unitCost: 0.5, reason: 'Пак' })
    expect([twice.status, twice.body.code, twice.body.stored?.id]).toEqual([409, 'override_exists', add.body.id])

    const list = await call(world.home, 'GET', '/')
    expect(list.body.overrides.map((o: any) => [o.path, o.from, o.unitCost, o.reason])).toEqual([[G1, '2026-03-05', 0.4, 'Брак']])

    const put = await call(world.home, 'PUT', `/${add.body.id}`, { unitCost: 0.45, reason: 'Брак, преброено', expected: add.body.updatedAt })
    expect([put.status, put.body.unitCost]).toEqual([200, 0.45])
    const stale = await call(world.home, 'PUT', `/${add.body.id}`, { unitCost: 0.5, reason: 'Пак', expected: add.body.updatedAt })
    expect([stale.status, stale.body.code, stale.body.stored?.unitCost]).toEqual([409, 'row_changed', 0.45])
    const gone = await call(world.home, 'DELETE', `/${add.body.id}?expected=${encodeURIComponent(put.body.updatedAt)}`)
    expect(gone.status).toBe(200)
    expect(await GroupCostOverride.countDocuments({})).toBe(0)

    const audit = await AuditLog.find({ orgId: world.home, entityType: 'group_cost_override' }).sort({ createdAt: 1 }).lean()
    expect(audit.map(a => a.action)).toEqual(['create', 'update', 'delete'])
  })

  it('shows the average an override of a day restates, every other override applied', async () => {
    await createOverride(world.home, { analyticId: world.g1, from: '2026-03-04', unitCost: 0.3, reason: 'Брак' }, by())
    const before = await call(world.home, 'GET', `/average?analyticId=${world.g1}&day=2026-03-03`)
    expect([before.status, before.body.quantity, before.body.unitCost, before.body.override]).toEqual([200, 100, 0.5, undefined])
    // The day's own override is left out of what it would restate, and named beside it.
    const own = await call(world.home, 'GET', `/average?analyticId=${world.g1}&day=2026-03-04`)
    expect([own.body.unitCost, own.body.override?.unitCost]).toEqual([0.5, 0.3])
    const after = await call(world.home, 'GET', `/average?analyticId=${world.g1}&day=2026-03-06`)
    expect(after.body.unitCost).toBe(0.3)
  })

  it('a store of a split answers 409 not_books_home, an org without books 409 not_a_books_org, and a bad body 422', async () => {
    const storeG1 = String((await AccountingAnalytic.findOne({ orgId: world.store, path: G1 }).lean())!._id)
    expect((await call(world.store, 'GET', '/')).body.code).toBe('not_books_home')
    expect((await call(world.store, 'POST', '/', { analyticId: storeG1, from: '2026-03-05', unitCost: 1, reason: 'x' })).body.code).toBe('not_books_home')
    expect((await call(world.plain, 'GET', '/')).body.code).toBe('not_a_books_org')
    const customer = String((await AccountingAnalytic.findOne({ orgId: world.home, path: CUSTOMER }).lean())!._id)
    const refusals = [
      await call(world.home, 'POST', '/', { analyticId: customer, from: '2026-03-05', unitCost: 1, reason: 'x' }),
      await call(world.home, 'POST', '/', { analyticId: world.g1, from: '2025-12-31', unitCost: 1, reason: 'x' }),
      await call(world.home, 'POST', '/', { analyticId: world.g1, from: '2026-02-30', unitCost: 1, reason: 'x' }),
      await call(world.home, 'POST', '/', { analyticId: world.g1, from: '2026-03-05', unitCost: 1, reason: '   ' }),
    ]
    expect(refusals.map(r => [r.status, r.body.code])).toEqual([[422, 'not_a_goods_group'], [422, 'bad_day'], [422, 'bad_day'], [422, 'bad_reason']])
    expect(await GroupCostOverride.countDocuments({})).toBe(0)
  })
})
