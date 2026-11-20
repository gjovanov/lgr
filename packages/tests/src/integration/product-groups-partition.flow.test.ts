import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { join } from 'node:path'
import type { Types } from 'mongoose'
import { clearCollections, setupTestDB, teardownTestDB, testDbUri } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg, createTestProduct, createTestUser } from '../helpers/factories'
import { AccountingAnalytic, ProductGroupMap } from 'db/models'
import { importAnalytics, importChart, importJournalMonth } from 'services/biz/accounting-books/import.service'
import { linkBooks } from 'services/biz/accounting-books/link-books.service'
import { learnProductGroups } from 'services/biz/accounting-books/product-groups.service'
import { parseAnalyticsFile } from 'services/biz/accounting-books/plusminus-exports'
import type { ImportDocument } from 'services/biz/accounting-books/import.types'

/**
 * FR-25 R3, slice 1b: the books' quantities per group teach the products slice 1 could not, end to end on a store
 * that keeps a share of split books (R7): pass after pass, a contradicted learned row taken away, the accountant's row
 * left as it is, a second run planning nothing, and the script printing counts only. Made-up series, numbers, groups,
 * products and amounts.
 */

const REPO = join(import.meta.dir, '..', '..', '..', '..')
const EIK = '000000000'
const SERIES_HOME = '90001'
const SERIES_STORE = '90002'

const CHART = [['304', 'Стоки'], ['411', 'Клиенти'], ['4532', 'ДДС за продажбите'], ['702', 'Приходи от стоки']].map(([code, name]) => ({ code, name }))
const G1 = 'СТОКИ:ТЕСТ ГРУПА 1'
const G2 = 'СТОКИ:ТЕСТ ГРУПА 2'
const G3 = 'СТОКИ:ТЕСТ ГРУПА 3'
const CUSTOMER = 'КЛИЕНТИ:Тест Клиент'
const ITEMS = parseAnalyticsFile(new TextEncoder().encode(JSON.stringify([
  { ap: 'СТОКИ', params: {}, group: 'true' },
  ...[G1, G2, G3].map(ap => ({ ap, params: { 'МЯРКА': 'бр' } })),
  { ap: 'КЛИЕНТИ', params: {}, group: 'true' },
  { ap: CUSTOMER, params: { 'БУЛСТАТ': '000000011' } },
])))

/** A sale as the accountant books it: one `D702 K304[group]` with its quantity per operation, then the customer's net and VAT. */
const sale = (n: number, goods: [string, number][]): ImportDocument => {
  const net = goods.reduce((s, [, q]) => s + q, 0)
  return {
    date: `2025-03-${String(n + 1).padStart(2, '0')}`, docType: '-ФЕ', docNumber: `${SERIES_STORE}${String(n).padStart(5, '0')}`, vatKind: '1', total: net * 1.2,
    ops: [
      ...goods.map(([ak, qty]) => ({ d: '702', k: '304', ak, qty, amount: qty / 2 })),
      { d: '411', k: '702', ad: CUSTOMER, amount: net },
      { d: '411', k: '4532', ad: CUSTOMER, amount: net * 0.2 },
    ],
  }
}

type P = 'pa' | 'pb' | 'pc' | 'pd' | 'pe' | 'pf' | 'pg' | 'ph' | 'pi' | 'pj' | 'pk' | 'pl' | 'pm' | 'pn' | 'po' | 'pp' | 'pq' | 'pr' | 'ps' | 'pt' | 'pu' | 'pw'

/** The books' operations and LGR's lines of each document (`undefined`: a line typed with no product). */
const DOCUMENTS: { books: [string, number][]; lgr: [P | undefined, number][] }[] = [
  // 1: one group: pa in G1 (slice 1).
  { books: [[G1, 5]], lgr: [['pa', 5]] },
  // 2: 5 | 3 + 2 only with pa in G1: pb and pc are G2's (pass 1).
  { books: [[G1, 5], [G2, 5]], lgr: [['pa', 5], ['pb', 3], ['pc', 2]] },
  // 3: 3 and 3, no unique quantity: pd is G3's once pb is G2's (pass 2).
  { books: [[G2, 3], [G3, 3]], lgr: [['pb', 3], ['pd', 3]] },
  // 4: line for line on the 4 (slice 1: pe in G1); the 1 against the books' 2 teaches nothing.
  { books: [[G1, 4], [G2, 2]], lgr: [['pe', 4], ['pf', 1]] },
  // 5: one group: pg in G1 (slice 1)...
  { books: [[G1, 3]], lgr: [['pg', 3]] },
  // 6: ...which this document contradicts: 4 does not fit G1's 2.
  { books: [[G3, 4], [G1, 2]], lgr: [['pg', 4], ['ph', 1], ['pi', 1]] },
  // 7: pj is the accountant's, in a group this document does not have.
  { books: [[G1, 2], [G2, 2]], lgr: [['pj', 2], ['pk', 1], ['pl', 1]] },
  // 8: pm is G1's in every split, the ones are not.
  { books: [[G1, 5], [G2, 2]], lgr: [['pm', 4], ['pn', 1], ['po', 1], ['pp', 1]] },
  // 9: four ones in two twos: nothing.
  { books: [[G1, 2], [G2, 2]], lgr: [['pq', 1], ['pr', 1], ['ps', 1], ['pt', 1]] },
  // 10: the typed line is G2's 1: pu and pw are G1's.
  { books: [[G1, 4], [G2, 1]], lgr: [['pu', 2], ['pw', 2], [undefined, 1]] },
]

interface World {
  store: { id: string; slug: string }
  products: Record<P, string>
  groups: { g1: string; g2: string; g3: string }
}
let seq = 0
let world: World

async function makeWorld(): Promise<World> {
  const n = ++seq
  const home = await createTestOrg({ slug: `pgp-home-${n}`, name: 'Тест А', taxNumber: EIK } as never)
  const store = await createTestOrg({ slug: `pgp-store-${n}`, name: 'Тест Б', taxNumber: EIK } as never)
  await linkBooks({
    booksSlug: home.slug, split: true,
    branches: [{ slug: home.slug, code: 'A', docSeries: [SERIES_HOME] }, { slug: store.slug, code: 'B', docSeries: [SERIES_STORE] }],
  }, { dryRun: false })
  const user = await createTestUser(home._id as never)
  const by = { id: String(user._id) }
  const books = DOCUMENTS.map((d, i) => sale(i + 1, d.books))
  for (const org of [home, store]) {
    const orgId = String(org._id)
    await importChart(orgId, { eik: EIK, dryRun: false, accounts: CHART }, by)
    await importAnalytics(orgId, { eik: EIK, dryRun: false, items: ITEMS }, by)
    await importJournalMonth(orgId, { eik: EIK, dryRun: false, month: '2025-03', coverage: { from: '2025-01-01', to: '2025-12-31' }, documents: books }, by)
  }

  const names = [...new Set(DOCUMENTS.flatMap(d => d.lgr.flatMap(([p]) => (p ? [p] : []))))].sort()
  const products = {} as Record<P, string>
  for (const [i, p] of names.entries()) products[p] = String((await createTestProduct(store._id as Types.ObjectId, { name: `ТЕСТОВ АРТИКУЛ ${i + 1}`, type: 'goods' } as never))._id)
  const groupId = async (path: string) => String((await AccountingAnalytic.findOne({ orgId: store._id, path }).lean())!._id)
  const groups = { g1: await groupId(G1), g2: await groupId(G2), g3: await groupId(G3) }

  const customer = (await createTestContact(store._id))._id
  for (const [i, d] of DOCUMENTS.entries()) {
    const lines = d.lgr.map(([p, quantity]) => ({
      ...(p ? { productId: products[p] } : {}), description: 'Тестов ред', quantity, unit: 'бр', unitPrice: 1, discount: 0, taxRate: 20, taxAmount: quantity * 0.2, lineTotal: quantity * 1.2,
    }))
    const net = d.lgr.reduce((s, [, q]) => s + q, 0)
    await createTestInvoice(String(store._id) as never, customer, {
      invoiceNumber: `INV-${SERIES_STORE}${String(i + 1).padStart(5, '0')}`, status: 'sent', issueDate: new Date(`2025-03-${String(i + 2).padStart(2, '0')}T09:00:00.000Z`), lines,
      subtotal: net, taxTotal: net * 0.2, total: net * 1.2, totalBase: net * 1.2, amountDue: net * 1.2,
    } as never)
  }

  // The accountant put pj in G3. An earlier run stored pg in G1, which document 6 contradicts.
  await ProductGroupMap.create({ orgId: store._id, productId: products.pj, analyticId: groups.g3, source: 'accountant', evidenceCount: 0, conflictCount: 0, reviewedBy: user._id, reviewedAt: new Date('2025-04-01T00:00:00.000Z') })
  await ProductGroupMap.create({ orgId: store._id, productId: products.pg, analyticId: groups.g1, source: 'learned', evidenceCount: 1, conflictCount: 0, lastEvidenceAt: new Date('2025-03-06T00:00:00.000Z') })
  return { store: { id: String(store._id), slug: store.slug }, products, groups }
}

const rowsOf = async (orgId: string) =>
  (await ProductGroupMap.find({ orgId }).sort({ productId: 1 }).lean()).map(r => ({
    productId: String(r.productId), analyticId: String(r.analyticId), source: r.source, evidenceCount: r.evidenceCount, conflictCount: r.conflictCount, updatedAt: r.updatedAt.toISOString(),
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

describe('learning from the books\' quantities per group', () => {
  it('teaches pass after pass, counts every document once, and writes nothing on a dry run', async () => {
    const r = await learnProductGroups(world.store.id, MARCH_ONLY)
    expect(r.pairing).toMatchObject({ pairedEntries: 10, pairedDocuments: 10, notInLgr: 0, notInBooks: 0 })
    // Slice 1 as it was: its outcomes and lines are its own.
    expect(r.outcomes).toMatchObject({ one_group: 2, line_for_line: 1, no_unique_quantity: 1, not_line_for_line: 6 })
    expect(r.partition).toEqual({
      documents: 8,
      outcomes: { unique: 3, partial: 1, ambiguous: 1, none: 1, too_many_lines: 0, too_many_groups: 0, budget: 0, anchor_contradicts: 1, accountant_contradicts: 1 },
      totalsDiffer: 1, passes: 4, restarts: 1, passLimit: false,
      lines: { left: 22, taught: 6 },
      products: { voted: 6, added: 6, takenAway: 1, contradicted: 1, distrusted: 0 },
      steps: r.partition.steps,
    })
    expect(r.partition.steps.total).toBeGreaterThan(0)
    expect(r.products).toMatchObject({ learned: 8, conflicts: 1, conflictsOfOneDocument: 1, accountants: 1, exact: 0 })
    expect(r.planned).toEqual({ create: 8, update: 0, remove: 1, unchanged: 0 })
    expect(r.written).toBeUndefined()
    expect((await rowsOf(world.store.id)).map(x => x.source).sort()).toEqual(['accountant', 'learned'])
  })

  it('writes the rows, takes the contradicted one away, leaves the accountant\'s, and a second run plans nothing', async () => {
    const accountantBefore = (await rowsOf(world.store.id)).find(x => x.source === 'accountant')
    const first = await learnProductGroups(world.store.id, { ...MARCH_ONLY, execute: true })
    expect(first.written).toEqual({ created: 8, updated: 0, removed: 1, skipped: 0 })

    const rows = await rowsOf(world.store.id)
    const byProduct = new Map(rows.map(x => [x.productId, x]))
    const { products: p, groups: g } = world
    const learned = (group: string) => ({ analyticId: group, source: 'learned', evidenceCount: 1, conflictCount: 0 })
    for (const [product, group] of [[p.pa, g.g1], [p.pb, g.g2], [p.pc, g.g2], [p.pd, g.g3], [p.pe, g.g1], [p.pm, g.g1], [p.pu, g.g1], [p.pw, g.g1]]) {
      expect(byProduct.get(product)).toMatchObject(learned(group))
    }
    expect(byProduct.get(p.pj)).toEqual(accountantBefore!)
    for (const none of [p.pf, p.pg, p.ph, p.pi, p.pk, p.pl, p.pn, p.po, p.pp, p.pq, p.pr, p.ps, p.pt]) expect(byProduct.has(none)).toBe(false)

    const second = await learnProductGroups(world.store.id, { ...MARCH_ONLY, execute: true })
    expect(second.planned).toEqual({ create: 0, update: 0, remove: 0, unchanged: 8 })
    expect(second.partition).toEqual(first.partition)
    expect(await rowsOf(world.store.id)).toEqual(rows)
  })
})

describe('the script', () => {
  it('prints partition\'s counts and nothing else of the documents', async () => {
    const dry = await cli('--org', world.store.slug, '--from', '2025-03-01', '--to', '2025-03-31')
    expect(dry.code).toBe(0)
    expect(dry.out).toContain('What the books\' quantities per group add (partition): 8 documents slice 1 leaves a product line on')
    expect(dry.out).toContain('      3  one split of the lines between the groups adds up: every product on it taught')
    expect(dry.out).toContain('      1  several splits; some products are in one group in all of them: those taught')
    expect(dry.out).toContain('      1    of them, the books\' goods total is not LGR\'s')
    expect(dry.out).toContain('      1  fits only without a group a product has by name or by another document: nothing, the product a conflict')
    expect(dry.out).toContain('      1  fits only without the accountant\'s rows: nothing')
    expect(dry.out).toContain('      0  more than 30 goods items (a product\'s lines one item): not searched')
    expect(dry.out).toMatch(/\n {2}passes 4, restarts 1; search steps \d+, the most for one document \d+\n/)
    expect(dry.out).toContain('  the product lines slice 1 left: 22, of them taught 6')
    expect(dry.out).toContain('  products named a group 6; learned with partition and not without 6, learned without and not with 1; a group contradicted 1, distrusted 0')
    expect(dry.out).toContain('      1  conflict: their documents name more than one group, or contradict the one the run gave them (not mapped; to review)')
    expect(dry.out).not.toContain('⚠')
    for (const secret of [SERIES_STORE, 'ТЕСТ', 'Тест']) expect(dry.out).not.toContain(secret)
  })
})
