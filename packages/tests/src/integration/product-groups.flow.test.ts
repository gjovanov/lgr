import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { join } from 'node:path'
import type { Types } from 'mongoose'
import { clearCollections, setupTestDB, teardownTestDB, testDbUri } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg, createTestProduct, createTestUser } from '../helpers/factories'
import { AccountingAnalytic, AuditLog, ProductGroupMap } from 'db/models'
import { importAnalytics, importChart, importJournalMonth } from 'services/biz/accounting-books/import.service'
import { linkBooks } from 'services/biz/accounting-books/link-books.service'
import { learnProductGroups } from 'services/biz/accounting-books/product-groups.service'
import { parseAnalyticsFile } from 'services/biz/accounting-books/plusminus-exports'
import type { ImportDocument } from 'services/biz/accounting-books/import.types'

/**
 * FR-25 R3, slice 1: the product → accounting group map learned from one org's share of split books
 * (R7) and its own documents, written idempotently, the accountant's rows untouched; and the script
 * that runs it prints counts only. Made-up series, numbers, groups, products and amounts.
 */

const REPO = join(import.meta.dir, '..', '..', '..', '..')
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
  // One group over two lines: every product on it is the group's. The service is booked apart.
  sale(`${SERIES_STORE}00001`, '2025-03-03', [[G1, 10], [G1, 4]], 19, { ops: [...sale('', '', [[G1, 10], [G1, 4]], 14).ops, { d: '411', k: '703', ad: CUSTOMER, amount: 5 }] }),
  // Two groups, line for line.
  sale(`${SERIES_STORE}00002`, '2025-03-04', [[G1, 3], [G2, 5]], 8),
  // The fourth product in another group than on the document before: a conflict.
  sale(`${SERIES_STORE}00003`, '2025-03-05', [[G1, 2], [G3, 1]], 3),
  // A credit notice: its quantity is negative on its side.
  sale(`${SERIES_STORE}00004`, '2025-03-06', [[G1, -1]], -1, { props: { registerDocType: '3' } }),
  // In the books, not in LGR.
  sale(`${SERIES_STORE}00005`, '2025-03-07', [[G2, 1]], 1),
  // The home's own sale, a store outside LGR, and a till's month: all the home's.
  sale(`${SERIES_HOME}00001`, '2025-03-10', [[G2, 7]], 7),
  { date: '2025-03-20', docType: '-ФЕ', docNumber: `${SERIES_OUTSIDE}00001`, total: 12, ops: [{ d: '501', k: '702', amount: 10 }, { d: '501', k: '4532', amount: 2 }] },
  { date: '2025-03-31', docType: 'КП', docNumber: '1', vatKind: '3', total: 6, ops: [{ d: '702', k: '304', ak: G1, qty: 4, amount: 2 }, { d: '501', k: '702', amount: 5 }, { d: '501', k: '4532', amount: 1 }] },
]

interface World {
  home: { id: string; slug: string }
  store: { id: string; slug: string }
  products: Record<'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'h1', string>
  groups: Record<'g1' | 'g2' | 'g3', string>
  userId: string
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
  const home = await createTestOrg({ slug: `pg-home-${n}`, name: 'Тест А', taxNumber: EIK } as never)
  const store = await createTestOrg({ slug: `pg-store-${n}`, name: 'Тест Б', taxNumber: EIK } as never)
  await linkBooks({
    booksSlug: home.slug,
    split: true,
    branches: [{ slug: home.slug, code: 'A', docSeries: [SERIES_HOME] }, { slug: store.slug, code: 'B', docSeries: [SERIES_STORE] }],
    externalBranches: [{ code: 'W', docSeries: [SERIES_OUTSIDE] }],
  }, { dryRun: false })
  const user = await createTestUser(home._id as never)
  const by = { id: String(user._id) }
  for (const org of [home, store]) {
    const orgId = String(org._id)
    await importChart(orgId, { eik: EIK, dryRun: false, accounts: CHART }, by)
    await importAnalytics(orgId, { eik: EIK, dryRun: false, items: ITEMS }, by)
    await importJournalMonth(orgId, { eik: EIK, dryRun: false, month: '2025-03', coverage: { from: '2025-01-01', to: '2025-12-31' }, documents: MARCH }, by)
  }

  const product = async (orgId: Types.ObjectId, name: string, type = 'goods') => String((await createTestProduct(orgId, { name, type } as never))._id)
  const products = {
    p1: await product(store._id, 'ТЕСТОВ АРТИКУЛ 1'),
    p2: await product(store._id, 'ТЕСТОВ АРТИКУЛ 2'),
    // Its name is a group's: `exact`.
    p3: await product(store._id, 'Тест  артикул 3'),
    p4: await product(store._id, 'ТЕСТОВ АРТИКУЛ 4'),
    p5: await product(store._id, 'ТЕСТОВА УСЛУГА', 'service'),
    h1: await product(home._id, 'ТЕСТОВ АРТИКУЛ 7'),
  }
  const groupId = async (path: string) => String((await AccountingAnalytic.findOne({ orgId: store._id, path }).lean())!._id)
  const groups = { g1: await groupId(G1), g2: await groupId(G2), g3: await groupId(G3) }

  const customer = (await createTestContact(store._id))._id
  await invoice(String(store._id), customer, `INV-${SERIES_STORE}00001`, '2025-03-03', [line(products.p1, 10), line(products.p2, 4), line(products.p5, 1)])
  await invoice(String(store._id), customer, `INV-${SERIES_STORE}00002`, '2025-03-04', [line(products.p1, 3), line(products.p4, 5)])
  await invoice(String(store._id), customer, `INV-${SERIES_STORE}00003`, '2025-03-05', [line(products.p4, 2), line(products.p3, 1)])
  await invoice(String(store._id), customer, `INV-${SERIES_STORE}00004`, '2025-03-06', [line(products.p2, 1)], { type: 'credit_note' })
  // In LGR, not in the books, with a typed line.
  await invoice(String(store._id), customer, `INV-${SERIES_STORE}00006`, '2025-03-08', [line(products.p1, 1), line(undefined, 1)])
  // A draft is no document: neither paired nor covered.
  await invoice(String(store._id), customer, `DRF-INV-${SERIES_STORE}00007`, '2025-03-09', [line(products.p4, 9)], { status: 'draft' })
  await invoice(String(store._id), customer, `CS-2025-0001`, '2025-03-12', [line(products.p1, 2), line(products.p4, 1)], { type: 'cash_sale', status: 'paid' })
  const homeCustomer = (await createTestContact(home._id))._id
  await invoice(String(home._id), homeCustomer, `INV-${SERIES_HOME}00001`, '2025-03-10', [line(products.h1, 7)])

  // The accountant decided the second product is the second group's, whatever the documents say.
  await ProductGroupMap.create({
    orgId: store._id, productId: products.p2, analyticId: groups.g2, source: 'accountant', evidenceCount: 0, conflictCount: 0,
    reviewedBy: user._id, reviewedAt: new Date('2025-04-01T00:00:00.000Z'),
  })
  return { home: { id: String(home._id), slug: home.slug }, store: { id: String(store._id), slug: store.slug }, products, groups, userId: String(user._id) }
}

const rowsOf = async (orgId: string) =>
  (await ProductGroupMap.find({ orgId }).sort({ productId: 1 }).lean()).map(r => ({
    productId: String(r.productId), analyticId: String(r.analyticId), source: r.source, evidenceCount: r.evidenceCount, conflictCount: r.conflictCount,
    lastEvidenceAt: r.lastEvidenceAt?.toISOString(), updatedAt: r.updatedAt.toISOString(),
  }))

async function cli(...args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', join(REPO, 'scripts', 'learn-product-groups.ts'), ...args], {
    cwd: REPO, env: { ...process.env, MONGODB_URI: testDbUri() }, stdout: 'pipe', stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out: out + err }
}

const MARCH_ONLY = { from: '2025-03-01', to: '2025-03-31' }

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

describe('learning a store\'s products\' groups from its share of the books', () => {
  it('pairs its own documents, learns what they agree on, counts the rest, and changes nothing on a dry run', async () => {
    const r = await learnProductGroups(world.store.id, MARCH_ONLY)
    // R7: the store holds its own series only.
    expect(r.places).toEqual({ own: 5, till: 0, outside: 0, other_store: 0, no_series: 0 })
    expect(r.pairing).toEqual({ entries: 5, pairedEntries: 4, pairedDocuments: 4, notInLgr: 1, noNumber: 0, ambiguous: 0, typeDiffers: 0, notInBooks: 1 })
    expect(r.outcomes).toMatchObject({ one_group: 2, line_for_line: 2, not_line_for_line: 0 })
    expect(r.lines).toEqual({ goods: 7, byOneGroup: 3, byQuantity: 4, notMatched: 0, noProduct: 0 })
    expect(r.products).toEqual({
      goods: 4, exact: 1, exactAmbiguous: 0, learned: 1, conflicts: 1, conflictsOfOneDocument: 1, inactiveGroup: 0, accountants: 1, unmapped: 1,
    })
    expect(r.rows.bySource).toEqual({ exact: 1, learned: 1, rule: 0, ai: 0, accountant: 1 })
    expect(r.planned).toEqual({ create: 2, update: 0, remove: 0, unchanged: 0 })
    expect(r.written).toBeUndefined()
    // Coverage as the map would be: the accountant's row counts, the conflicted product does not, a service is left out.
    expect(r.coverage.invoices).toEqual([{ month: '2025-03', cell: { lines: 9, mappedLines: 6, noProduct: 1, value: 28, mappedValue: 20 } }])
    expect(r.coverage.till).toEqual([{ month: '2025-03', cell: { lines: 2, mappedLines: 1, noProduct: 0, value: 3, mappedValue: 2 } }])
    expect((await rowsOf(world.store.id)).map(x => x.source)).toEqual(['accountant'])
  })

  it('writes the map, leaves the accountant\'s row as it was, and a second run changes nothing', async () => {
    const accountantBefore = (await rowsOf(world.store.id))[0]
    const first = await learnProductGroups(world.store.id, { ...MARCH_ONLY, execute: true })
    expect(first.written).toEqual({ created: 2, updated: 0, removed: 0, skipped: 0 })

    const rows = await rowsOf(world.store.id)
    const byProduct = new Map(rows.map(x => [x.productId, x]))
    expect(byProduct.get(world.products.p1)).toMatchObject({ analyticId: world.groups.g1, source: 'learned', evidenceCount: 2, conflictCount: 0, lastEvidenceAt: '2025-03-04T00:00:00.000Z' })
    expect(byProduct.get(world.products.p3)).toMatchObject({ analyticId: world.groups.g3, source: 'exact', evidenceCount: 1, conflictCount: 0 })
    expect(byProduct.get(world.products.p2)).toEqual(accountantBefore)
    expect(byProduct.has(world.products.p4)).toBe(false)
    expect(byProduct.has(world.products.p5)).toBe(false)

    const second = await learnProductGroups(world.store.id, { ...MARCH_ONLY, execute: true })
    expect(second.planned).toEqual({ create: 0, update: 0, remove: 0, unchanged: 2 })
    expect(second.written).toEqual({ created: 0, updated: 0, removed: 0, skipped: 0 })
    expect(await rowsOf(world.store.id)).toEqual(rows)

    // Without a period: the whole of the books, the same answer.
    const whole = await learnProductGroups(world.store.id, { execute: true })
    expect(whole.planned).toEqual({ create: 0, update: 0, remove: 0, unchanged: 2 })
  })

  it('a period with no evidence keeps the learned rows; one where the evidence disagrees takes the learned row away', async () => {
    await learnProductGroups(world.store.id, { ...MARCH_ONLY, execute: true })
    const april = await learnProductGroups(world.store.id, { from: '2025-04-01', to: '2025-04-30', execute: true })
    expect(april.planned).toEqual({ create: 0, update: 0, remove: 0, unchanged: 2 })

    // The books now hold the document LGR had alone, and name the first product on it in the second group.
    await importJournalMonth(world.store.id, {
      eik: EIK, dryRun: false, month: '2025-03', coverage: { from: '2025-01-01', to: '2025-12-31' },
      documents: [...MARCH, sale(`${SERIES_STORE}00006`, '2025-03-08', [[G2, 1], [G2, 1]], 2)],
    }, { id: world.userId })
    const after = await learnProductGroups(world.store.id, { ...MARCH_ONLY, execute: true })
    expect(after.products).toMatchObject({ learned: 0, conflicts: 2 })
    expect(after.written).toEqual({ created: 0, updated: 0, removed: 1, skipped: 0 })
    expect((await rowsOf(world.store.id)).map(x => x.source).sort()).toEqual(['accountant', 'exact'])
  })

  it('the home pairs its own series, and counts the till\'s month and the store outside LGR apart', async () => {
    const r = await learnProductGroups(world.home.id, { ...MARCH_ONLY, execute: true })
    expect(r.places).toEqual({ own: 1, till: 1, outside: 1, other_store: 0, no_series: 0 })
    expect(r.pairing).toMatchObject({ pairedDocuments: 1, notInLgr: 0, notInBooks: 0 })
    const rows = await ProductGroupMap.find({ orgId: world.home.id }).lean()
    // The home's analytics are its own copies of the tree.
    const g2 = await AccountingAnalytic.findOne({ orgId: world.home.id, path: G2 }).lean()
    expect(rows.map(x => [String(x.productId), String(x.analyticId), x.source])).toEqual([[world.products.h1, String(g2!._id), 'learned']])
  })
})

describe('the script', () => {
  it('prints counts only on a dry run, writes with --execute and leaves one audit row, and a rerun writes nothing', async () => {
    const dry = await cli('--org', world.store.slug, '--from', '2025-03-01', '--to', '2025-03-31')
    expect(dry.code).toBe(0)
    expect(dry.out).toContain(`Org ${world.store.slug} — DRY-RUN — business days 2025-03-01 to 2025-03-31`)
    expect(dry.out).toContain('      4  paired, with 4 LGR documents')
    expect(dry.out).toContain('      1  learned: every document of theirs names the same group')
    expect(dry.out).toMatch(/\n {2}2025-03 +9 +66\.7% +71\.4% +1\n/)
    expect(dry.out).toContain('Dry run — nothing written.')
    // No number, no name: the output can go in a public PR.
    for (const secret of [SERIES_STORE, 'ТЕСТ', 'Тест']) expect(dry.out).not.toContain(secret)
    expect(await ProductGroupMap.countDocuments({ orgId: world.store.id })).toBe(1)

    const run = await cli('--org', world.store.slug, '--execute')
    expect(run.code).toBe(0)
    expect(run.out).toContain('Written: 2 created, 0 updated, 0 removed')
    expect(await ProductGroupMap.countDocuments({ orgId: world.store.id })).toBe(3)
    const audit = await AuditLog.find({ orgId: world.store.id, entityType: 'product_group_map' }).lean()
    expect(audit).toHaveLength(1)
    expect(audit[0].changes?.find(c => c.field === 'created')?.newValue).toBe(2)

    const again = await cli('--org', world.store.slug, '--execute')
    expect(again.out).toContain('Planned: 0 to create, 0 to update, 0 to remove, 2 unchanged')
    expect(await AuditLog.countDocuments({ orgId: world.store.id, entityType: 'product_group_map' })).toBe(1)
  })

  it('refuses an org that keeps no books, and a day that is no day', async () => {
    const plain = await createTestOrg({ slug: `pg-plain-${++seq}` } as never)
    const refused = await cli('--org', plain.slug)
    expect(refused.code).toBe(2)
    expect(refused.out).toContain('Refused (not_a_books_org)')
    const badDay = await cli('--org', world.store.slug, '--from', '2025-02-30')
    expect(badDay.code).toBe(2)
    expect(badDay.out).toContain('Refused (bad_period)')
    expect((await cli('--org', world.store.slug, '--period', '202503')).code).toBe(2)
  })
})
