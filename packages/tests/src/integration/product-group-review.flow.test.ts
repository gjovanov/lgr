import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import type { Types } from 'mongoose'
import { config } from 'config'
import type { Role } from 'config/constants'
import { clearCollections, setupTestDB, teardownTestDB } from '../setup'
import { captureRejection } from '../helpers/capture-rejection'
import { createTestContact, createTestInvoice, createTestOrg, createTestProduct, createTestUser } from '../helpers/factories'
import { AccountingAnalytic, AuditLog, ProductGroupMap } from 'db/models'
import { importAnalytics, importChart, importJournalMonth } from 'services/biz/accounting-books/import.service'
import { linkBooks } from 'services/biz/accounting-books/link-books.service'
import { learnProductGroups } from 'services/biz/accounting-books/product-groups.service'
import { parseAnalyticsFile } from 'services/biz/accounting-books/plusminus-exports'
import {
  ProductGroupReviewError, confirmProductGroup, forgetReviewCache, forgetReviewStamps, goodsGroupList, reviewQueue, setProductGroup, withdrawProductGroup,
} from 'services/biz/accounting-books/product-group-review.service'
import type { ImportDocument } from 'services/biz/accounting-books/import.types'
import { createApiApp } from '../../../api/src/api.js'

/**
 * FR-25 R3, slice 2: the accountant's review queue of the product → accounting group map, over one store's share of
 * split books (R7): what it lists and in which order, the documents behind a conflict, the three writes and their
 * conditions, and who may make them. Made-up series, numbers, groups, products and amounts.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const EIK = '000000000'
const SERIES_HOME = '90001'
const SERIES_STORE = '90002'
const SERIES_OUTSIDE = '90009'

const CHART = [['304', 'Стоки'], ['411', 'Клиенти'], ['4532', 'ДДС за продажбите'], ['501', 'Каса'], ['702', 'Приходи от стоки'], ['703', 'Приходи от услуги']]
  .map(([code, name]) => ({ code, name }))

const G1 = 'СТОКИ:ТЕСТ ГРУПА 1'
const G2 = 'СТОКИ:ТЕСТ ГРУПА 2'
const G3 = 'СТОКИ:ТЕСТ АРТИКУЛ 3'
const CUSTOMER = 'КЛИЕНТИ:Тест Клиент'
const ITEMS = parseAnalyticsFile(new TextEncoder().encode(JSON.stringify([
  { ap: 'СТОКИ', params: {}, group: 'true' },
  { ap: G1, params: { 'МЯРКА': 'бр' } },
  { ap: G2, params: { 'МЯРКА': 'бр' } },
  { ap: G3, params: { 'МЯРКА': 'бр' } },
  { ap: 'КЛИЕНТИ', params: {}, group: 'true' },
  { ap: CUSTOMER, params: { 'БУЛСТАТ': '000000011' } },
])))

/** A sale as the accountant books it: per goods line a `D702 K304[group]` with its quantity, then the customer's net and VAT. */
const sale = (docNumber: string, date: string, goods: [string, number][], net: number, over: Partial<ImportDocument> = {}): ImportDocument => ({
  date, docType: '-ФЕ', docNumber, vatKind: '1', total: net * 1.2,
  ops: [
    ...goods.map(([ak, qty]) => ({ d: '702', k: '304', ak, qty, amount: qty / 2 })),
    { d: '411', k: '702', ad: CUSTOMER, amount: net },
    { d: '411', k: '4532', ad: CUSTOMER, amount: net * 0.2 },
  ],
  ...over,
})

const MARCH: ImportDocument[] = [
  // One group over two lines: both products are the group's.
  sale(`${SERIES_STORE}00001`, '2025-03-03', [[G1, 10], [G1, 4]], 14),
  // Two groups, line for line.
  sale(`${SERIES_STORE}00002`, '2025-03-04', [[G1, 3], [G2, 5]], 8),
  // The fourth product in another group than on the document before: a conflict of one document against one.
  sale(`${SERIES_STORE}00003`, '2025-03-05', [[G1, 2], [G3, 1]], 3),
  // A credit notice: its quantity is negative on its side.
  sale(`${SERIES_STORE}00004`, '2025-03-06', [[G1, -1]], -1, { props: { registerDocType: '3' } }),
  sale(`${SERIES_HOME}00001`, '2025-03-10', [[G2, 7]], 7),
  { date: '2025-03-20', docType: '-ФЕ', docNumber: `${SERIES_OUTSIDE}00001`, total: 12, ops: [{ d: '501', k: '702', amount: 10 }, { d: '501', k: '4532', amount: 2 }] },
]

type ProductKey = 'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'h1'
interface World {
  home: { id: string; slug: string }
  store: { id: string; slug: string }
  products: Record<ProductKey, string>
  groups: Record<'g1' | 'g2' | 'g3' | 'homeG1' | 'customer' | 'root', string>
  /** The store's accountant, who decides. */
  accountant: { id: string }
}

let seq = 0
let world: World

const line = (productId: string | undefined, quantity: number) => ({
  ...(productId ? { productId } : {}), description: 'Тестов ред', quantity, unit: 'бр', unitPrice: 1, discount: 0, taxRate: 20, taxAmount: quantity * 0.2, lineTotal: quantity * 1.2,
})

async function invoice(orgId: string, contactId: Types.ObjectId, number: string, isoDay: string, lines: ReturnType<typeof line>[], over: Record<string, unknown> = {}) {
  const net = lines.reduce((s, l) => s + l.quantity, 0)
  await createTestInvoice(orgId as never, contactId, {
    invoiceNumber: number, status: 'sent', issueDate: new Date(`${isoDay}T09:00:00.000Z`), lines,
    subtotal: net, taxTotal: net * 0.2, total: net * 1.2, totalBase: net * 1.2, amountDue: net * 1.2, ...over,
  } as never)
}

async function makeWorld(): Promise<World> {
  const n = ++seq
  const home = await createTestOrg({ slug: `pgr-home-${n}`, name: 'Тест А', taxNumber: EIK } as never)
  const store = await createTestOrg({ slug: `pgr-store-${n}`, name: 'Тест Б', taxNumber: EIK } as never)
  await linkBooks({
    booksSlug: home.slug,
    split: true,
    branches: [{ slug: home.slug, code: 'A', docSeries: [SERIES_HOME] }, { slug: store.slug, code: 'B', docSeries: [SERIES_STORE] }],
    externalBranches: [{ code: 'W', docSeries: [SERIES_OUTSIDE] }],
  }, { dryRun: false })
  const importer = { id: String((await createTestUser(home._id as never))._id) }
  for (const org of [home, store]) {
    const orgId = String(org._id)
    await importChart(orgId, { eik: EIK, dryRun: false, accounts: CHART }, importer)
    await importAnalytics(orgId, { eik: EIK, dryRun: false, items: ITEMS }, importer)
    await importJournalMonth(orgId, { eik: EIK, dryRun: false, month: '2025-03', coverage: { from: '2025-01-01', to: '2025-12-31' }, documents: MARCH }, importer)
  }
  const accountant = await createTestUser(store._id as never, { role: 'accountant', firstName: 'Тест', lastName: 'Счетоводител' } as never)

  const product = async (orgId: Types.ObjectId, name: string, sku: string, type = 'goods') => String((await createTestProduct(orgId, { name, sku, type } as never))._id)
  const products = {
    p1: await product(store._id, 'ТЕСТОВ АРТИКУЛ 1', 'ТСТ-001'),
    p2: await product(store._id, 'ТЕСТОВ АРТИКУЛ 2', 'ТСТ-002'),
    // Its name is a group's: `exact`.
    p3: await product(store._id, 'Тест  артикул 3', 'ТСТ-003'),
    p4: await product(store._id, 'ТЕСТОВ АРТИКУЛ 4', 'ТСТ-004'),
    p5: await product(store._id, 'ТЕСТОВА УСЛУГА', 'ТСТ-005', 'service'),
    h1: await product(home._id, 'ТЕСТОВ АРТИКУЛ 7', 'ТСТ-007'),
  }
  const analytic = async (orgId: Types.ObjectId, path: string) => String((await AccountingAnalytic.findOne({ orgId, path }).lean())!._id)
  const groups = {
    g1: await analytic(store._id, G1), g2: await analytic(store._id, G2), g3: await analytic(store._id, G3),
    homeG1: await analytic(home._id, G1), customer: await analytic(store._id, CUSTOMER), root: await analytic(store._id, 'СТОКИ'),
  }

  const customer = (await createTestContact(store._id))._id
  await invoice(String(store._id), customer, `INV-${SERIES_STORE}00001`, '2025-03-03', [line(products.p1, 10), line(products.p2, 4), line(products.p5, 1)])
  await invoice(String(store._id), customer, `INV-${SERIES_STORE}00002`, '2025-03-04', [line(products.p1, 3), line(products.p4, 5)])
  await invoice(String(store._id), customer, `INV-${SERIES_STORE}00003`, '2025-03-05', [line(products.p4, 2), line(products.p3, 1)])
  await invoice(String(store._id), customer, `INV-${SERIES_STORE}00004`, '2025-03-06', [line(products.p2, 1)], { type: 'credit_note' })
  // In LGR, not in the books, with a typed line.
  await invoice(String(store._id), customer, `INV-${SERIES_STORE}00006`, '2025-03-08', [line(products.p1, 1), line(undefined, 1)])
  // A draft is no document.
  await invoice(String(store._id), customer, `DRF-INV-${SERIES_STORE}00007`, '2025-03-09', [line(products.p4, 9)], { status: 'draft' })
  await invoice(String(store._id), customer, 'CS-2025-0001', '2025-03-12', [line(products.p1, 2), line(products.p4, 1)], { type: 'cash_sale', status: 'paid' })

  // The accountant decided long ago that the second product is the second group's, whatever the documents say.
  await ProductGroupMap.create({
    orgId: store._id, productId: products.p2, analyticId: groups.g2, source: 'accountant', evidenceCount: 0, conflictCount: 0,
    reviewedBy: accountant._id, reviewedAt: new Date('2025-04-01T00:00:00.000Z'),
  })
  return {
    home: { id: String(home._id), slug: home.slug }, store: { id: String(store._id), slug: store.slug }, products, groups,
    accountant: { id: String(accountant._id) },
  }
}

/** The queue as the stamps are now: a test reads what it wrote, never the snapshot before it. */
const queue = (orgId: string, query: Record<string, unknown> = {}) => reviewQueue(orgId, query, { wait: true })
const rowOf = async (productId: string, query: Record<string, unknown> = {}) => (await queue(world.store.id, query)).rows.find(r => r.productId === productId)
const iso = (d: Date | undefined) => (d ? new Date(d).toISOString() : '')
const storedOf = (productId: string) => ProductGroupMap.findOne({ orgId: world.store.id, productId }).lean()
const auditOf = async (productId: string) =>
  (await AuditLog.find({ orgId: world.store.id, entityType: 'product_group_map' }).sort({ timestamp: 1 }).lean()).filter(a => String(a.entityId) === productId)

function refusal(err: unknown, statusCode: number, code: string): ProductGroupReviewError {
  expect(err).toBeInstanceOf(ProductGroupReviewError)
  const e = err as ProductGroupReviewError
  expect([e.statusCode, e.code]).toEqual([statusCode, code])
  return e
}

beforeAll(async () => {
  await setupTestDB()
}, 120_000)

afterAll(async () => {
  forgetReviewCache()
  await teardownTestDB()
}, 60_000)

beforeEach(async () => {
  forgetReviewCache()
  await clearCollections()
  world = await makeWorld()
})

afterEach(() => {
  forgetReviewCache()
})

describe('the queue', () => {
  it('lists the period\'s goods by sales value, each with its state, and the summary of the whole period', async () => {
    const q = await queue(world.store.id)
    const { p1, p2, p3, p4 } = world.products
    // NET: a credit notice and a till sale count their value, the service and the draft do not.
    expect(q.rows.map(r => [r.productId, r.state, r.value, r.lines])).toEqual([
      [p1, 'unmapped', 16, 4],
      [p4, 'conflict', 8, 3],
      [p2, 'accountant', 5, 2],
      [p3, 'unmapped', 1, 1],
    ])
    expect(q).toMatchObject({ total: 4, page: 0, pageSize: 25, totalPages: 1, period: { to: expect.any(String) }, evidence: { fresh: true, refreshing: false } })
    expect(q.period.from).toBeUndefined()
    expect(q.summary.byState).toEqual({ conflict: 1, unmapped: 2, learned: 0, exact: 0, accountant: 1, reviewed: 0 })
    expect(q.summary).toMatchObject({ products: 4, oneDocumentConflicts: 1, suggested: 2 })
    // What posts as stored (the accountant's one row), and what would after a learning run: the script's coverage.
    expect(q.summary.coverage.all).toEqual({
      lines: 11, value: 31, noProductLines: 1, noProductValue: 1, postingLines: 2, postingValue: 5, afterLearningLines: 7, afterLearningValue: 22,
    })
    expect(q.summary.coverage.invoices).toMatchObject({ lines: 9, value: 28, afterLearningLines: 6, afterLearningValue: 20 })
    expect(q.summary.coverage.till).toMatchObject({ lines: 2, value: 3, afterLearningLines: 1, afterLearningValue: 2 })
    expect(q.analytics[world.groups.g1]).toEqual({ name: 'ТЕСТ ГРУПА 1', path: G1, active: true, goods: true })
    expect(q.reviewers[world.accountant.id]).toBe('Тест Счетоводител')
  })

  it('a conflict shows each group with the documents that name it; an unmapped product the group its documents name', async () => {
    const q = await queue(world.store.id)
    const { g1, g2, g3 } = world.groups
    const conflict = q.rows.find(r => r.productId === world.products.p4)!
    expect(conflict.oneDocument).toBe(true)
    expect(conflict.suggestion).toBeUndefined()
    expect(conflict.groups.map(g => [g.analyticId, g.docs, g.documents.map(d => [d.number, d.rule, d.groupId, iso(d.day).slice(0, 10)])])).toEqual([
      [g1, 1, [[`INV-${SERIES_STORE}00003`, 'line_for_line', g1, '2025-03-05']]],
      [g2, 1, [[`INV-${SERIES_STORE}00002`, 'line_for_line', g2, '2025-03-04']]],
    ])
    const learned = q.rows.find(r => r.productId === world.products.p1)!
    expect(learned.suggestion).toEqual({ analyticId: g1, source: 'learned' })
    expect(learned.groups.map(g => [g.analyticId, g.docs, g.documents.map(d => [d.number, d.rule])])).toEqual([
      [g1, 2, [[`INV-${SERIES_STORE}00002`, 'line_for_line'], [`INV-${SERIES_STORE}00001`, 'one_group']]],
    ])
    expect(q.rows.find(r => r.productId === world.products.p3)!.suggestion).toEqual({ analyticId: g3, source: 'exact' })
    // The accountant's row is done: its documents still show, and nothing is suggested over it.
    const decided = q.rows.find(r => r.productId === world.products.p2)!
    expect(decided).toMatchObject({ state: 'accountant', stored: { analyticId: g2, source: 'accountant', reviewedBy: world.accountant.id } })
    expect(decided.suggestion).toBeUndefined()
    expect(decided.groups.map(g => [g.analyticId, g.docs])).toEqual([[g1, 2]])
  })

  it('filters by state, by name or SKU, sorts and pages; a period lists only what it sold', async () => {
    const { p1, p2, p3, p4 } = world.products
    expect((await queue(world.store.id, { state: 'conflict' })).rows.map(r => r.productId)).toEqual([p4])
    const work = await queue(world.store.id, { state: 'unmapped,conflict' })
    expect(work.rows.map(r => r.productId)).toEqual([p1, p4, p3])
    expect(work.summary.products).toBe(4)
    expect((await queue(world.store.id, { search: 'артикул 3' })).rows.map(r => r.productId)).toEqual([p3])
    expect((await queue(world.store.id, { search: 'тст-00' })).rows.map(r => r.productId)).toEqual([p1, p4, p2, p3])
    expect((await queue(world.store.id, { sortBy: 'name', sortOrder: 'asc' })).rows.map(r => r.productId)).toEqual([p3, p1, p2, p4])
    const second = await queue(world.store.id, { size: '2', page: '1' })
    expect(second.rows.map(r => r.productId)).toEqual([p2, p3])
    expect(second).toMatchObject({ total: 4, page: 1, pageSize: 2, totalPages: 2 })
    // From the tenth: only the till's day sold anything.
    const late = await queue(world.store.id, { from: '2025-03-10', to: '2025-03-31' })
    expect(late.rows.map(r => [r.productId, r.value])).toEqual([[p1, 2], [p4, 1]])
    expect(late.period).toEqual({ from: '2025-03-10', to: '2025-03-31' })
    // The states are the whole books' all the same.
    expect(late.rows.map(r => r.state)).toEqual(['unmapped', 'conflict'])
  })

  it('lists the goods groups a product may be given, the active ones first', async () => {
    await AccountingAnalytic.updateOne({ _id: world.groups.g3 }, { $set: { isActive: false } })
    const { groups } = await goodsGroupList(world.store.id)
    expect(groups.map(g => [g.path, g.active])).toEqual([[G1, true], [G2, true], [G3, false]])
  })

  it('an accountant\'s row whose group is switched off is the work again, as slice 3 refuses its lines', async () => {
    const { p2 } = world.products
    const mine = await storedOf(p2)
    const groupId = String(mine!.analyticId)
    expect((await rowOf(p2))!.state).toBe('accountant')
    // As a books import switches a group off. The pod reads its stamps again within seconds; a test does not wait.
    await AccountingAnalytic.updateOne({ _id: groupId }, { $set: { isActive: false } })
    forgetReviewCache()
    const q = await queue(world.store.id)
    expect(q.rows.find(r => r.productId === p2)).toMatchObject({ state: 'unmapped', stored: { analyticId: groupId, source: 'accountant' } })
    expect(q.summary.byState).toEqual({ conflict: 1, unmapped: 3, learned: 0, exact: 0, accountant: 0, reviewed: 0 })
    // Its sales were the one row that posted.
    expect(q.summary.coverage.all).toMatchObject({ postingLines: 0, postingValue: 0 })
    expect(q.analytics[groupId]).toMatchObject({ active: false })
    // The default filter, the work, lists it.
    expect((await queue(world.store.id, { state: 'conflict,unmapped' })).rows.map(r => r.productId)).toContain(p2)
  })
})

describe('the accountant\'s writes', () => {
  it('setting a group makes the row the accountant\'s, which a learning run then leaves alone and counts', async () => {
    const { p4 } = world.products
    expect((await rowOf(p4))!.stored).toBeUndefined()
    const w = await setProductGroup(world.store.id, p4, { analyticId: world.groups.g1, expected: null }, world.accountant)
    expect(w.stored).toMatchObject({ analyticId: world.groups.g1, source: 'accountant', reviewedBy: world.accountant.id })
    const stored = await storedOf(p4)
    expect(stored).toMatchObject({ source: 'accountant' })
    expect(stored!.reviewedAt).toBeInstanceOf(Date)
    expect(iso(w.stored!.updatedAt)).toBe(iso(stored!.updatedAt))

    const q = await queue(world.store.id)
    expect(q.rows.find(r => r.productId === p4)).toMatchObject({ state: 'accountant', stored: { analyticId: world.groups.g1, source: 'accountant' } })
    expect(q.summary.byState).toMatchObject({ conflict: 0, accountant: 2 })
    // The conflict's value now posts.
    expect(q.summary.coverage.all).toMatchObject({ postingLines: 5, postingValue: 13 })

    const run = await learnProductGroups(world.store.id, { execute: true })
    expect(run.products.accountants).toBe(2)
    expect(run.products.conflicts).toBe(0)
    const after = await storedOf(p4)
    expect([String(after!.analyticId), after!.source, iso(after!.updatedAt)]).toEqual([world.groups.g1, 'accountant', iso(stored!.updatedAt)])

    // The accountant may change their mind: the row they were shown.
    const again = await setProductGroup(world.store.id, p4, { analyticId: world.groups.g2, expected: iso(stored!.updatedAt) }, world.accountant)
    expect(again.stored).toMatchObject({ analyticId: world.groups.g2, source: 'accountant' })

    const audit = await auditOf(p4)
    expect(audit.map(a => a.action)).toEqual(['create', 'update'])
    expect(audit[0]).toMatchObject({ module: 'accounting', entityName: 'ТЕСТОВ АРТИКУЛ 4' })
    expect(audit[1].changes?.find(c => c.field === 'group')).toMatchObject({ oldValue: G1, newValue: G2 })
  })

  it('accepting a suggestion is setting its group; confirming keeps a learned row\'s group and source', async () => {
    const shown = (await rowOf(world.products.p3))!
    await setProductGroup(world.store.id, world.products.p3, { analyticId: shown.suggestion!.analyticId, expected: null }, world.accountant)
    expect(await storedOf(world.products.p3)).toMatchObject({ source: 'accountant' })

    await learnProductGroups(world.store.id, { execute: true })
    const learned = (await rowOf(world.products.p1))!
    expect(learned).toMatchObject({ state: 'learned', stored: { analyticId: world.groups.g1, source: 'learned', evidenceCount: 2 } })
    expect(learned.suggestion).toBeUndefined()
    const c = await confirmProductGroup(world.store.id, world.products.p1, { expected: iso(learned.stored!.updatedAt) }, world.accountant)
    expect(c.stored).toMatchObject({ analyticId: world.groups.g1, source: 'learned', evidenceCount: 2, reviewedBy: world.accountant.id })
    expect((await rowOf(world.products.p1))!.state).toBe('reviewed')
    const db = await storedOf(world.products.p1)
    expect([db!.source, String(db!.reviewedBy), iso(db!.updatedAt)]).toEqual(['learned', world.accountant.id, iso(c.stored!.updatedAt)])

    // Confirmed once is the accountant's: neither confirmed again, nor touched by learning.
    refusal(await captureRejection(confirmProductGroup(world.store.id, world.products.p1, { expected: iso(c.stored!.updatedAt) }, world.accountant)), 422, 'already_reviewed')
    const run = await learnProductGroups(world.store.id, { execute: true })
    expect(run.products.accountants).toBe(3)
    expect(iso((await storedOf(world.products.p1))!.updatedAt)).toBe(iso(c.stored!.updatedAt))
    expect((await auditOf(world.products.p1)).map(a => a.action)).toEqual(['update'])
  })

  it('withdrawing removes the accountant\'s own row, and takes the review off a confirmed one', async () => {
    await learnProductGroups(world.store.id, { execute: true })
    const learned = (await rowOf(world.products.p1))!
    const confirmed = await confirmProductGroup(world.store.id, world.products.p1, { expected: iso(learned.stored!.updatedAt) }, world.accountant)

    const unreviewed = await withdrawProductGroup(world.store.id, world.products.p1, { expected: iso(confirmed.stored!.updatedAt) }, world.accountant)
    expect(unreviewed.stored).toMatchObject({ analyticId: world.groups.g1, source: 'learned' })
    expect(unreviewed.stored!.reviewedAt).toBeUndefined()
    const db = await storedOf(world.products.p1)
    expect([db!.source, db!.reviewedAt, db!.reviewedBy]).toEqual(['learned', undefined, undefined])
    expect((await rowOf(world.products.p1))!.state).toBe('learned')

    const decided = (await rowOf(world.products.p2))!
    const removed = await withdrawProductGroup(world.store.id, world.products.p2, { expected: iso(decided.stored!.updatedAt) }, world.accountant)
    expect(removed.stored).toBeNull()
    expect(await storedOf(world.products.p2)).toBeNull()
    // The product is learning's again: its documents name the first group.
    expect(await rowOf(world.products.p2)).toMatchObject({ state: 'unmapped', suggestion: { analyticId: world.groups.g1, source: 'learned' } })

    // Nothing of the accountant's left on it: nothing to withdraw.
    const now = (await rowOf(world.products.p1))!
    refusal(await captureRejection(withdrawProductGroup(world.store.id, world.products.p1, { expected: iso(now.stored!.updatedAt) }, world.accountant)), 422, 'not_reviewed')
    expect((await auditOf(world.products.p2)).map(a => a.action)).toEqual(['delete'])
    expect((await auditOf(world.products.p1)).map(a => a.action)).toEqual(['update', 'update'])
  })

  it('every write names the row the queue showed, and is refused with the row as it is now when that changed', async () => {
    const { p1, p2 } = world.products
    // The queue showed no row; a learning run wrote one meanwhile.
    expect((await rowOf(p1))!.stored).toBeUndefined()
    await learnProductGroups(world.store.id, { execute: true })
    const raced = refusal(await captureRejection(setProductGroup(world.store.id, p1, { analyticId: world.groups.g2, expected: null }, world.accountant)), 409, 'row_changed')
    expect(raced.stored).toMatchObject({ analyticId: world.groups.g1, source: 'learned' })

    // A row the queue showed at another time.
    const stale = '2025-01-01T00:00:00.000Z'
    refusal(await captureRejection(setProductGroup(world.store.id, p2, { analyticId: world.groups.g1, expected: stale }, world.accountant)), 409, 'row_changed')
    refusal(await captureRejection(confirmProductGroup(world.store.id, p1, { expected: stale }, world.accountant)), 409, 'row_changed')
    refusal(await captureRejection(withdrawProductGroup(world.store.id, p2, { expected: stale }, world.accountant)), 409, 'row_changed')
    refusal(await captureRejection(setProductGroup(world.store.id, p2, { analyticId: world.groups.g1, expected: 'yesterday' }, world.accountant)), 422, 'bad_expected')

    // Nothing was written.
    expect(await storedOf(p2)).toMatchObject({ source: 'accountant' })
    expect(String((await storedOf(p2))!.analyticId)).toBe(world.groups.g2)
    expect((await storedOf(p1))!.reviewedAt).toBeUndefined()
    expect(await AuditLog.countDocuments({ orgId: world.store.id, entityType: 'product_group_map', action: { $in: ['create', 'update', 'delete'] }, userId: world.accountant.id })).toBe(0)
  })

  it('refuses what is not the org\'s own goods: another org\'s product or group, a service, an inactive group, an analytic that is no goods group', async () => {
    const by = world.accountant
    refusal(await captureRejection(setProductGroup(world.store.id, world.products.h1, { analyticId: world.groups.g1, expected: null }, by)), 404, 'product_not_found')
    refusal(await captureRejection(setProductGroup(world.store.id, world.products.p4, { analyticId: world.groups.homeG1, expected: null }, by)), 422, 'not_a_goods_group')
    refusal(await captureRejection(setProductGroup(world.store.id, world.products.p4, { analyticId: world.groups.customer, expected: null }, by)), 422, 'not_a_goods_group')
    refusal(await captureRejection(setProductGroup(world.store.id, world.products.p4, { analyticId: world.groups.root, expected: null }, by)), 422, 'not_a_goods_group')
    refusal(await captureRejection(setProductGroup(world.store.id, world.products.p5, { analyticId: world.groups.g1, expected: null }, by)), 422, 'service_product')
    await AccountingAnalytic.updateOne({ _id: world.groups.g3 }, { $set: { isActive: false } })
    refusal(await captureRejection(setProductGroup(world.store.id, world.products.p4, { analyticId: world.groups.g3, expected: null }, by)), 422, 'not_a_goods_group')
    // The home's product is no product of the store's, whatever the home's row says.
    const homeRow = await ProductGroupMap.create({
      orgId: world.home.id, productId: world.products.h1, analyticId: world.groups.homeG1, source: 'accountant', evidenceCount: 0, conflictCount: 0,
      reviewedAt: new Date('2025-04-01T00:00:00.000Z'),
    })
    refusal(await captureRejection(withdrawProductGroup(world.store.id, world.products.h1, { expected: iso(homeRow.updatedAt) }, by)), 409, 'row_changed')
    expect(await ProductGroupMap.countDocuments({ orgId: world.store.id })).toBe(1)
    expect(await ProductGroupMap.countDocuments({ orgId: world.home.id })).toBe(1)
  })

  it('an org that keeps no books has no queue, and a query that is none is refused', async () => {
    const plain = await createTestOrg({ slug: `pgr-plain-${++seq}` } as never)
    const plainId = String(plain._id)
    const product = String((await createTestProduct(plain._id as never, { name: 'ТЕСТОВ АРТИКУЛ 9' } as never))._id)
    refusal(await captureRejection(reviewQueue(plainId, {})), 409, 'not_a_books_org')
    refusal(await captureRejection(goodsGroupList(plainId)), 409, 'not_a_books_org')
    refusal(await captureRejection(setProductGroup(plainId, product, { analyticId: world.groups.g1, expected: null }, world.accountant)), 409, 'not_a_books_org')
    refusal(await captureRejection(confirmProductGroup(plainId, product, { expected: '2025-01-01T00:00:00.000Z' }, world.accountant)), 409, 'not_a_books_org')
    refusal(await captureRejection(withdrawProductGroup(plainId, product, { expected: '2025-01-01T00:00:00.000Z' }, world.accountant)), 409, 'not_a_books_org')
    expect(await ProductGroupMap.countDocuments({ orgId: plainId })).toBe(0)

    refusal(await captureRejection(reviewQueue(world.store.id, { from: '2025-02-30' })), 422, 'bad_period')
    refusal(await captureRejection(reviewQueue(world.store.id, { from: '2025-03-31', to: '2025-03-01' })), 422, 'bad_period')
    refusal(await captureRejection(reviewQueue(world.store.id, { state: 'mapped' })), 422, 'bad_query')
    refusal(await captureRejection(reviewQueue(world.store.id, { sortBy: 'margin' })), 422, 'bad_query')
  })
})

describe('the evidence a pod keeps', () => {
  it('serves the snapshot it made until the books change, then says it is not fresh until the next is made', async () => {
    const first = await reviewQueue(world.store.id, {})
    expect(first.evidence).toMatchObject({ fresh: true, refreshing: false })
    const same = await reviewQueue(world.store.id, {})
    expect(iso(same.evidence.computedAt)).toBe(iso(first.evidence.computedAt))

    // The books now hold the document LGR had alone, and name its first product in the second group.
    await importJournalMonth(world.store.id, {
      eik: EIK, dryRun: false, month: '2025-03', coverage: { from: '2025-01-01', to: '2025-12-31' },
      documents: [...MARCH, sale(`${SERIES_STORE}00006`, '2025-03-08', [[G2, 1], [G2, 1]], 2)],
    }, { id: world.accountant.id })
    forgetReviewStamps(world.store.id)
    const stale = await reviewQueue(world.store.id, {})
    expect(stale.evidence).toMatchObject({ fresh: false, refreshing: true })
    expect(iso(stale.evidence.computedAt)).toBe(iso(first.evidence.computedAt))
    expect(stale.rows.find(r => r.productId === world.products.p1)!.state).toBe('unmapped')

    const fresh = await queue(world.store.id)
    expect(fresh.evidence).toMatchObject({ fresh: true, refreshing: false })
    expect(fresh.rows.find(r => r.productId === world.products.p1)).toMatchObject({ state: 'conflict' })
  })
})

describe('over HTTP', () => {
  const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
  let app: Elysia

  async function tokenFor(orgId: string, role: Role): Promise<{ token: string; id: string }> {
    const email = `${role}-${++seq}@pgr.test`
    const user = await createTestUser(orgId as never, { role, email } as never)
    const token = await (signer as unknown as { decorator: { jwt: { sign: (p: Record<string, string>) => Promise<string> } } }).decorator.jwt.sign({
      id: String(user._id), orgId, email, username: `${role}-${seq}`, firstName: 'R', lastName: 'P',
    })
    return { token, id: String(user._id) }
  }

  async function call(method: string, path: string, token: string, body?: unknown) {
    const res = await app.handle(new Request(`http://localhost/api/org/${world.store.id}/accounting/product-groups${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }))
    let json: any = null
    try {
      json = await res.json()
    } catch {
      // Not JSON: the status says enough.
    }
    return { status: res.status, json }
  }

  beforeAll(() => {
    app = new Elysia().use(createApiApp())
  })

  it('a read-only role reads the queue and the groups, and is refused every write; the accountant writes', async () => {
    const auditor = await tokenFor(world.store.id, 'nra_auditor')
    const member = await tokenFor(world.store.id, 'member')
    const accountant = await tokenFor(world.store.id, 'accountant')
    const { p1, p4 } = world.products

    const read = await call('GET', '/review?state=conflict,unmapped', auditor.token)
    expect(read.status).toBe(200)
    expect(read.json.rows.map((r: { productId: string }) => r.productId)).toEqual([p1, p4, world.products.p3])
    expect((await call('GET', '/groups', member.token)).json.groups.map((g: { path: string }) => g.path)).toEqual([G3, G1, G2])

    for (const t of [auditor, member]) {
      expect((await call('PUT', `/${p4}`, t.token, { analyticId: world.groups.g1, expected: null })).status).toBe(403)
      expect((await call('POST', `/${p4}/confirm`, t.token, { expected: '2025-01-01T00:00:00.000Z' })).status).toBe(403)
      expect((await call('DELETE', `/${p4}/review?expected=2025-01-01T00:00:00.000Z`, t.token)).status).toBe(403)
    }
    expect(await storedOf(p4)).toBeNull()

    const set = await call('PUT', `/${p4}`, accountant.token, { analyticId: world.groups.g1, expected: null })
    expect(set.status).toBe(200)
    expect(set.json.stored).toMatchObject({ analyticId: world.groups.g1, source: 'accountant', reviewedBy: accountant.id })
    const twice = await call('PUT', `/${p4}`, accountant.token, { analyticId: world.groups.g2, expected: null })
    expect([twice.status, twice.json.code]).toEqual([409, 'row_changed'])
    expect(twice.json.stored).toMatchObject({ analyticId: world.groups.g1, source: 'accountant' })
    const back = await call('DELETE', `/${p4}/review?expected=${encodeURIComponent(set.json.stored.updatedAt)}`, accountant.token)
    expect([back.status, back.json.stored]).toEqual([200, null])
    // A write without the row it was shown is no write.
    expect((await call('PUT', `/${p4}`, accountant.token, { analyticId: world.groups.g1 })).status).toBe(422)
  })

  it('another org\'s session gets nothing of the store\'s', async () => {
    const outsider = await tokenFor(world.home.id, 'accountant')
    expect((await call('GET', '/review', outsider.token)).status).toBe(403)
    expect((await call('PUT', `/${world.products.p4}`, outsider.token, { analyticId: world.groups.g1, expected: null })).status).toBe(403)
    expect(await storedOf(world.products.p4)).toBeNull()
  })
})
