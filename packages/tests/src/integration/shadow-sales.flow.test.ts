import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { join } from 'node:path'
import type { Types } from 'mongoose'
import { clearCollections, setupTestDB, teardownTestDB, testDbUri } from '../setup'
import { createTestContact, createTestInvoice, createTestOrg, createTestProduct, createTestUser } from '../helpers/factories'
import { Account, AccountingAnalytic, Invoice, JournalEntry, PostingRule, ProductGroupMap, VatRegisterEntry } from 'db/models'
import { importAnalytics, importChart, importJournalMonth } from 'services/biz/accounting-books/import.service'
import { linkBooks } from 'services/biz/accounting-books/link-books.service'
import { parseAnalyticsFile } from 'services/biz/accounting-books/plusminus-exports'
import { seedPostingRules } from 'services/biz/accounting-books/posting-rule.service'
import { postShadowSales } from 'services/biz/accounting-books/shadow-sales.service'
import type { ImportDocument } from 'services/biz/accounting-books/import.types'

/**
 * FR-25 R3, slice 3: a store's own sales documents posted into the shadow ledger of the STORE, their register rows in
 * the shadow register of the HOME (R7), idempotent on the document, an edit and a void reversed, never written over;
 * and the dry run's check against the accountant's entries. Made-up series, numbers, groups, products and amounts.
 */

const REPO = join(import.meta.dir, '..', '..', '..', '..')
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

const MARCH: ImportDocument[] = [
  // The home's purchase: the groups' average is 0.50 and 2.00 from the 2nd.
  { date: '2026-03-02', docType: '+ФЕ', docNumber: '0000000123', vatKind: '1', total: 84, ops: [
    { d: '304', k: '401', ad: G1, qty: 100, amount: 50 }, { d: '304', k: '401', ad: G2, qty: 10, amount: 20 }, { d: '4531', k: '401', amount: 14 },
  ] },
  // The store's first invoice, booked exactly as LGR's posting books it.
  { date: '2026-03-03', docType: '-ФЕ', docNumber: `${SERIES_STORE}00001`, vatKind: '1', total: 48, ops: [
    { d: '702', k: '304', ak: G1, qty: 14, amount: 7 }, { d: '702', k: '304', ak: G2, qty: 2, amount: 4 },
    { d: '411', k: '702', ad: CUSTOMER, amount: 36 }, { d: '411', k: '703', ad: CUSTOMER, amount: 4 }, { d: '411', k: '4532', ad: CUSTOMER, amount: 8 },
    { d: '501', k: '411', ak: CUSTOMER, amount: 48 },
  ] },
  // The second, at a cost the books' average does not give.
  { date: '2026-03-04', docType: '-ФЕ', docNumber: `${SERIES_STORE}00002`, vatKind: '1', total: 24, ops: [
    { d: '702', k: '304', ak: G1, qty: 10, amount: 5.2 }, { d: '411', k: '702', ad: CUSTOMER, amount: 20 }, { d: '411', k: '4532', ad: CUSTOMER, amount: 4 },
  ] },
  // The home's own sale.
  { date: '2026-03-05', docType: '-ФЕ', docNumber: `${SERIES_HOME}00001`, vatKind: '1', total: 6, ops: [
    { d: '702', k: '304', ak: G2, qty: 1, amount: 2 }, { d: '411', k: '702', ad: CUSTOMER, amount: 5 }, { d: '411', k: '4532', ad: CUSTOMER, amount: 1 },
  ] },
]

interface World {
  home: { id: string; slug: string }
  store: { id: string; slug: string }
  userId: string
  docs: Record<'inv1' | 'inv2' | 'inv3' | 'cn4' | 'home1', string>
}

let seq = 0
let world: World

const line = (productId: string, quantity: number, unitPrice: number) => ({
  productId, description: 'Тестов ред', quantity, unit: 'бр', unitPrice, discount: 0, taxRate: 20,
  taxAmount: quantity * unitPrice * 0.2, lineTotal: quantity * unitPrice * 1.2,
})

async function invoice(orgId: Types.ObjectId, contactId: Types.ObjectId, number: string, isoDay: string, lines: ReturnType<typeof line>[], over: Record<string, unknown> = {}) {
  const net = lines.reduce((s, l) => s + l.quantity * l.unitPrice, 0)
  const doc = await createTestInvoice(orgId, contactId, {
    invoiceNumber: number, status: 'sent', issueDate: new Date(`${isoDay}T09:00:00.000Z`), lines,
    subtotal: net, taxTotal: net * 0.2, total: net * 1.2, totalBase: net * 1.2, amountDue: net * 1.2, ...over,
  } as never)
  return String(doc._id)
}

async function makeWorld(): Promise<World> {
  const n = ++seq
  const home = await createTestOrg({ slug: `sh-home-${n}`, name: 'Тест А', taxNumber: EIK } as never)
  const store = await createTestOrg({ slug: `sh-store-${n}`, name: 'Тест Б', taxNumber: EIK } as never)
  await linkBooks({
    booksSlug: home.slug,
    split: true,
    branches: [{ slug: home.slug, code: 'A', docSeries: [SERIES_HOME] }, { slug: store.slug, code: 'B', docSeries: [SERIES_STORE] }],
  }, { dryRun: false })
  const user = await createTestUser(home._id as never)
  const by = { id: String(user._id) }
  const customers = new Map<string, Types.ObjectId>()
  for (const org of [home, store]) {
    const orgId = String(org._id)
    // The partner card the books' customer links to, by its number.
    customers.set(orgId, (await createTestContact(org._id, { companyName: 'Тест Клиент', taxId: CUSTOMER_EIK } as never))._id as Types.ObjectId)
    await importChart(orgId, { eik: EIK, dryRun: false, accounts: CHART }, by)
    await importAnalytics(orgId, { eik: EIK, dryRun: false, items: ITEMS }, by)
    await importJournalMonth(orgId, { eik: EIK, dryRun: false, month: '2026-03', coverage: { from: '2026-01-01', to: '2026-12-31' }, documents: MARCH }, by)
    await seedPostingRules(orgId, { execute: true })
  }

  const product = async (orgId: Types.ObjectId, name: string, type = 'goods') => String((await createTestProduct(orgId, { name, type } as never))._id)
  const group = async (orgId: Types.ObjectId, path: string) => (await AccountingAnalytic.findOne({ orgId, path }).lean())!._id
  const map = async (orgId: Types.ObjectId, productId: string, path: string, source: string) =>
    ProductGroupMap.create({ orgId, productId, analyticId: await group(orgId, path), source, evidenceCount: 1, conflictCount: 0 })
  const p = {
    p1: await product(store._id, 'ТЕСТОВ АРТИКУЛ 1'),
    p2: await product(store._id, 'ТЕСТОВ АРТИКУЛ 2'),
    p3: await product(store._id, 'ТЕСТОВ АРТИКУЛ 3'),
    p4: await product(store._id, 'ТЕСТОВ АРТИКУЛ 4'),
    s1: await product(store._id, 'ТЕСТОВА УСЛУГА', 'service'),
    h1: await product(home._id, 'ТЕСТОВ АРТИКУЛ 5'),
  }
  await map(store._id, p.p1, G1, 'learned')
  await map(store._id, p.p2, G1, 'accountant')
  await map(store._id, p.p3, G2, 'exact')
  await map(home._id, p.h1, G2, 'learned')

  const c = customers.get(String(store._id))!
  const docs = {
    // Goods of two groups and a service, paid in cash at the counter as it was issued.
    inv1: await invoice(store._id, c, `INV-${SERIES_STORE}00001`, '2026-03-03', [line(p.p1, 10, 2), line(p.p2, 4, 1.5), line(p.p3, 2, 5), line(p.s1, 1, 4)], {
      payments: [{ date: new Date('2026-03-03T09:05:00.000Z'), amount: 48, method: 'cash', origin: 'cash_on_issue' }], amountPaid: 48, amountDue: 0, status: 'paid',
    }),
    inv2: await invoice(store._id, c, `INV-${SERIES_STORE}00002`, '2026-03-04', [line(p.p1, 10, 2)]),
    // A product no map holds: it waits.
    inv3: await invoice(store._id, c, `INV-${SERIES_STORE}00003`, '2026-03-04', [line(p.p4, 1, 10)]),
    // Stored positive, as every credit notice is; not in the books yet.
    cn4: await invoice(store._id, c, `INV-${SERIES_STORE}00004`, '2026-03-05', [line(p.p1, 2, 2)], { type: 'credit_note' }),
    home1: await invoice(home._id, customers.get(String(home._id))!, `INV-${SERIES_HOME}00001`, '2026-03-05', [line(p.h1, 1, 5)]),
  }
  return { home: { id: String(home._id), slug: home.slug }, store: { id: String(store._id), slug: store.slug }, userId: String(user._id), docs }
}

const MARCH_RUN = { from: '2026-03-01', to: '2026-03-31' }
const shadowEntries = (orgId: string) => JournalEntry.find({ orgId, ledger: 'shadow' }).sort({ postingKey: 1 }).lean()
const shadowRows = (orgId: string) => VatRegisterEntry.find({ orgId, ledger: 'shadow' }).sort({ docNumber: 1 }).lean()
/** An entry's lines as `[side, account code, analytic path, amount, quantity]`, in their order. */
async function linesOf(entry: any): Promise<unknown[][]> {
  const codes = new Map((await Account.find({ orgId: entry.orgId }).lean()).map(a => [String(a._id), a.code]))
  const paths = new Map((await AccountingAnalytic.find({ orgId: entry.orgId }).lean()).map(a => [String(a._id), a.path]))
  return entry.lines.map((l: any) => [l.side, codes.get(String(l.accountId)), l.analyticId ? paths.get(String(l.analyticId)) : null, l.side === 'debit' ? l.debit : l.credit, l.quantity ?? null])
}
const balances = async (orgId: string) => (await Account.find({ orgId }).sort({ code: 1 }).lean()).map(a => [a.code, a.balance])

async function cli(...args: string[]): Promise<{ code: number; out: string }> {
  const proc = Bun.spawn(['bun', join(REPO, 'scripts', 'post-shadow-sales.ts'), ...args], {
    cwd: REPO, env: { ...process.env, MONGODB_URI: testDbUri() }, stdout: 'pipe', stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { code, out: out + err }
}

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

describe('posting a store\'s sales documents into the shadow ledger', () => {
  it('a dry run posts nothing, says why a document cannot post, and checks the rest against the books', async () => {
    const r = await postShadowSales(world.store.id, MARCH_RUN)
    expect(r.rules).toEqual({ stored: 12, active: 12, fromSeed: false })
    expect([r.documents, r.posts, r.refused.product_unmapped, r.voided]).toEqual([4, 3, 1, 0])
    expect(r.actions).toEqual({ post: 3, repost: 0, reverse: 0, post_and_reverse: 0, none: 1 })
    expect(r.vatRows).toEqual({ create: 3, update: 0, remove: 0, unchanged: 0, frozen: 0 })
    expect(r.check).toEqual({
      compared: 2, equal: 1, differs: 1,
      by: { revenue: 0, vat: 0, cost: 1, partner: 0, cash: 0, other: 0 },
      cost: { groups: 0, average: 1 }, costSpread: { within05: 0, within5: 1, more: 0 },
      booksMissing: 1, voided: 0,
    })
    expect(r.written).toBeUndefined()
    expect(await JournalEntry.countDocuments({ ledger: 'shadow' })).toBe(0)
    expect(await VatRegisterEntry.countDocuments({ ledger: 'shadow' })).toBe(0)
  })

  it('writes the entries in the store and their register rows in the home, moves no balance, and a re-run writes nothing', async () => {
    const before = { store: await balances(world.store.id), home: await balances(world.home.id) }
    const first = await postShadowSales(world.store.id, { ...MARCH_RUN, execute: true, by: world.userId })
    expect(first.written).toEqual({ entries: 3, reversals: 0, vatRows: 3, raced: 0 })

    const entries = await shadowEntries(world.store.id)
    expect(entries.map(e => e.postingKey)).toEqual([world.docs.inv1, world.docs.inv2, world.docs.cn4].map(id => `shadow:invoice:${id}:1`).sort())
    const inv1 = entries.find(e => String(e.sourceId) === world.docs.inv1)!
    expect(inv1).toMatchObject({ status: 'posted', sourceModule: 'shadow-sales', docType: '-ФЕ', docNumber: `${SERIES_STORE}00001`, registerDocType: '1', docTotal: 48, docVat: 8 })
    expect(await linesOf(inv1)).toEqual([
      ['debit', '702', null, 7, 14], ['credit', '304', G1, 7, 14],
      ['debit', '702', null, 4, 2], ['credit', '304', G2, 4, 2],
      ['debit', '411', CUSTOMER, 36, null], ['credit', '702', null, 36, null],
      ['debit', '411', CUSTOMER, 4, null], ['credit', '703', null, 4, null],
      ['debit', '411', CUSTOMER, 8, null], ['credit', '4532', null, 8, null],
      ['debit', '501', null, 48, null], ['credit', '411', CUSTOMER, 48, null],
    ])
    // A credit notice: the same operations, negative, on the same sides.
    const cn4 = entries.find(e => String(e.sourceId) === world.docs.cn4)!
    expect(await linesOf(cn4)).toEqual([
      // At the start of the 5th the average has the books' own cost of the 4th in it: 37.80 for 76.
      ['debit', '702', null, -0.99, -2], ['credit', '304', G1, -0.99, -2],
      ['debit', '411', CUSTOMER, -4, null], ['credit', '702', null, -4, null],
      ['debit', '411', CUSTOMER, -0.8, null], ['credit', '4532', null, -0.8, null],
    ])

    // R7: the register is the home's. The rows name the store's documents.
    expect(await shadowRows(world.store.id)).toEqual([])
    const rows = await shadowRows(world.home.id)
    expect(rows.map(r => [r.docNumber, r.docTypeCode, r.period, String(r.source?.orgId), r.source?.kind, String(r.source?.id), r.cells])).toEqual([
      [`${SERIES_STORE}00001`, '01', '202603', world.store.id, 'invoice', world.docs.inv1, { '02-10': 4000, '02-11': 4000, '02-20': 800, '02-21': 800 }],
      [`${SERIES_STORE}00002`, '01', '202603', world.store.id, 'invoice', world.docs.inv2, { '02-10': 2000, '02-11': 2000, '02-20': 400, '02-21': 400 }],
      [`${SERIES_STORE}00004`, '03', '202603', world.store.id, 'invoice', world.docs.cn4, { '02-10': -400, '02-11': -400, '02-20': -80, '02-21': -80 }],
    ])
    expect({ store: await balances(world.store.id), home: await balances(world.home.id) }).toEqual(before)

    const again = await postShadowSales(world.store.id, { ...MARCH_RUN, execute: true, by: world.userId })
    expect(again.written).toEqual({ entries: 0, reversals: 0, vatRows: 0, raced: 0 })
    expect(again.actions).toEqual({ post: 0, repost: 0, reverse: 0, post_and_reverse: 0, none: 4 })
    expect(again.vatRows.unchanged).toBe(3)
    expect(await JournalEntry.countDocuments({ ledger: 'shadow' })).toBe(3)
  })

  it('the home posts its own series in the home, and its rows sit beside the store\'s', async () => {
    await postShadowSales(world.store.id, { ...MARCH_RUN, execute: true, by: world.userId })
    const dry = await postShadowSales(world.home.id, MARCH_RUN)
    expect([dry.documents, dry.posts, dry.check?.compared, dry.check?.equal]).toEqual([1, 1, 1, 1])
    const r = await postShadowSales(world.home.id, { ...MARCH_RUN, execute: true, by: world.userId })
    expect(r.written).toEqual({ entries: 1, reversals: 0, vatRows: 1, raced: 0 })
    expect((await shadowEntries(world.home.id)).map(e => String(e.sourceId))).toEqual([world.docs.home1])
    expect((await shadowRows(world.home.id)).map(x => [x.docNumber, String(x.source?.orgId)])).toEqual([
      [`${SERIES_HOME}00001`, world.home.id],
      ...[1, 2, 4].map(k => [`${SERIES_STORE}0000${k}`, world.store.id]),
    ])
  })

  it('an edited document is reversed on its day and posted again; its register row follows', async () => {
    await postShadowSales(world.store.id, { ...MARCH_RUN, execute: true, by: world.userId })
    const doc = await Invoice.findById(world.docs.inv2).lean()
    await Invoice.updateOne({ _id: world.docs.inv2 }, { $set: { 'lines.0.quantity': 12, subtotal: 24, taxTotal: 4.8, total: 28.8 } })
    expect(doc).toBeTruthy()

    const r = await postShadowSales(world.store.id, { ...MARCH_RUN, execute: true, by: world.userId })
    expect(r.actions.repost).toBe(1)
    expect(r.written).toEqual({ entries: 1, reversals: 1, vatRows: 1, raced: 0 })
    const entries = (await shadowEntries(world.store.id)).filter(e => String(e.sourceId) === world.docs.inv2)
    expect(entries.map(e => [e.postingKey, e.type, e.date.toISOString().slice(0, 10)])).toEqual([
      [`shadow:invoice:${world.docs.inv2}:1`, 'standard', '2026-03-04'],
      [`shadow:invoice:${world.docs.inv2}:1:reversal`, 'reversing', '2026-03-04'],
      [`shadow:invoice:${world.docs.inv2}:2`, 'standard', '2026-03-04'],
    ])
    expect(await linesOf(entries[1])).toEqual((await linesOf(entries[0])).map(([side, code, path, amount, qty]) => [side, code, path, -(amount as number), qty === null ? null : -(qty as number)]))
    expect((await linesOf(entries[2]))[0]).toEqual(['debit', '702', null, 6, 12])
    const rows = (await shadowRows(world.home.id)).filter(x => String(x.source?.id) === world.docs.inv2)
    expect(rows.map(x => x.cells)).toEqual([{ '02-10': 2400, '02-11': 2400, '02-20': 480, '02-21': 480 }])

    const again = await postShadowSales(world.store.id, { ...MARCH_RUN, execute: true, by: world.userId })
    expect(again.written).toEqual({ entries: 0, reversals: 0, vatRows: 0, raced: 0 })
  })

  it('a voided document is reversed on the void\'s day, and one voided before it was posted is posted and reversed', async () => {
    await postShadowSales(world.store.id, { ...MARCH_RUN, execute: true, by: world.userId })
    const voided = (day: string) => ({ $set: { status: 'voided' }, $push: { statusHistory: { status: 'voided', changedAt: new Date(`${day}T10:00:00.000Z`) } } })
    await Invoice.updateOne({ _id: world.docs.inv2 }, voided('2026-03-10'))
    // The home's document, voided before any run saw it.
    await Invoice.updateOne({ _id: world.docs.home1 }, voided('2026-03-12'))

    const r = await postShadowSales(world.store.id, { ...MARCH_RUN, execute: true, by: world.userId })
    expect([r.voided, r.actions.reverse, r.written?.reversals, r.written?.entries]).toEqual([1, 1, 1, 0])
    const reversal = await JournalEntry.findOne({ postingKey: `shadow:invoice:${world.docs.inv2}:1:reversal` }).lean()
    expect(reversal?.date.toISOString().slice(0, 10)).toBe('2026-03-10')
    // Annulled in its own period: the register keeps its row, with its values blank.
    const row = (await shadowRows(world.home.id)).find(x => String(x.source?.id) === world.docs.inv2)
    expect(row?.cells ?? {}).toEqual({})

    const home = await postShadowSales(world.home.id, { ...MARCH_RUN, execute: true, by: world.userId })
    expect([home.actions.post_and_reverse, home.written?.entries, home.written?.reversals]).toEqual([1, 1, 1])
    expect((await shadowEntries(world.home.id)).map(e => [e.postingKey?.endsWith(':reversal'), e.date.toISOString().slice(0, 10)])).toEqual([
      [false, '2026-03-05'], [true, '2026-03-12'],
    ])
    const again = await postShadowSales(world.store.id, { ...MARCH_RUN, execute: true, by: world.userId })
    expect(again.written).toEqual({ entries: 0, reversals: 0, vatRows: 0, raced: 0 })
  })
})

describe('the posting rules of a books org', () => {
  it('a second seed adds nothing, and a rule the accountant changed stays as it was', async () => {
    await PostingRule.updateOne({ orgId: world.store.id, code: 'sales.invoice.cash' }, { $set: { isActive: false, source: 'accountant' } })
    await PostingRule.deleteOne({ orgId: world.store.id, code: 'sales.invoice.vat' })
    expect(await seedPostingRules(world.store.id)).toEqual({ rules: 12, create: 1, kept: 11 })
    expect(await seedPostingRules(world.store.id, { execute: true })).toEqual({ rules: 12, create: 1, kept: 11, written: 1 })
    expect(await seedPostingRules(world.store.id, { execute: true })).toEqual({ rules: 12, create: 0, kept: 12, written: 0 })
    expect(await PostingRule.findOne({ orgId: world.store.id, code: 'sales.invoice.cash' }).lean()).toMatchObject({ isActive: false, source: 'accountant' })
  })
})

describe('the script', () => {
  it('prints counts only on a dry run, and writes nothing', async () => {
    const { code, out } = await cli('--org', world.store.slug, '--from', MARCH_RUN.from, '--to', MARCH_RUN.to)
    expect([code, code ? out : '']).toEqual([0, ''])
    expect(out).toContain('DRY-RUN')
    expect(out).toContain('equal: every account, analytic and side')
    // No document number, partner or amount: only counts.
    expect(out).not.toContain(SERIES_STORE)
    expect(out).not.toContain('Тест')
    expect(out).not.toMatch(/\d+\.\d{2}/)
    expect(await JournalEntry.countDocuments({ ledger: 'shadow' })).toBe(0)
  })
})

describe('the seed script', () => {
  it('counts what an org has and what it would add, and adds nothing on a dry run', async () => {
    await PostingRule.deleteOne({ orgId: world.store.id, code: 'sales.credit_note.cash' })
    const proc = Bun.spawn(['bun', join(REPO, 'scripts', 'seed-posting-rules.ts'), '--org', world.store.slug], {
      cwd: REPO, env: { ...process.env, MONGODB_URI: testDbUri() }, stdout: 'pipe', stderr: 'pipe',
    })
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
    expect([code, code ? out + err : '']).toEqual([0, ''])
    expect(out).toMatch(/\s11 {2}the org holds already/)
    expect(out).toMatch(/\s1 {2}to add/)
    expect(await PostingRule.countDocuments({ orgId: world.store.id })).toBe(11)
  })
})
