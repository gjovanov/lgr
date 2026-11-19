import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test'
import { clearCollections, setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { JournalEntry, Org } from 'db/models'
import { importChart, importJournalMonth } from 'services/biz/accounting-books/import.service'
import { linkBooks } from 'services/biz/accounting-books/link-books.service'
import { journalOfYear, type ArchiveBooks, type RawRecord } from 'services/biz/accounting-books/plusminus-archive'
import { assertWholeJournal, journalRequests, type ParsedJournal } from 'services/biz/accounting-books/plusminus-exports'
import type { JournalAnswer } from 'services/biz/accounting-books/import.types'

/**
 * A figure the archive cannot read HOLDS its day (`plusminus-archive.ts`, `hold`), and the import sends the month as a
 * request per run of the days around it (`plusminus-exports.ts#journalRequests`). On the real import service: what LGR
 * holds of the held day is neither inserted, updated nor deleted, every other day is imported as it would have been, and
 * a dry rerun is unchanged. Then the figure is retyped, and the day comes in.
 *
 * From archive records to stored entries, through the same functions `pull-books.ts` and `import-accounting-books.ts`
 * call: the journal of a year, its requests, the server. Fictional company, documents and figures.
 */

const EIK = '000000000'
const SERIES_HOME = '00001'
const SERIES_STORE = '00002'
const CHART = [
  ['241', 'Амортизация'], ['304', 'Стоки'], ['401', 'Доставчици'], ['411', 'Клиенти'], ['4531', 'ДДС за покупките'],
  ['4532', 'ДДС за продажбите'], ['603', 'Разходи за амортизация'], ['702', 'Приходи от стоки'],
].map(([code, name]) => ({ code, name }))
const GOODS = 'СТОКИ:БОЛТОВЕ'
const SUPPLIER = 'ДОСТАВЧИЦИ:Доставчик А'
const CUSTOMER = 'КЛИЕНТИ:Клиент А'

type Figure = string | number
interface Spec { docType?: string; docNumber?: string; total?: number; ops: { d: string; k: string; ad?: string; ak?: string; qty?: Figure; amount: Figure }[] }

/** A document as the archive keeps it: its header record, then a record per operation, keyed `<yyyymmdd>\<seq>`. */
function recordsOf(day: string, docs: Spec[]): RawRecord[] {
  const date = day.replace(/-/g, '')
  let seq = 0
  const next = () => String(++seq).padStart(8, '0')
  return docs.flatMap((doc): RawRecord[] => {
    const own: Record<string, Figure> = doc.docType ? { 'ДОКУМЕНТ': doc.docType, 'ДОКУМ.No': doc.docNumber ?? '' } : {}
    return [
      ...(doc.docType ? [{ date, seq: next(), f: { ...own, 'СУМА': doc.total ?? 0, 'ТИП': '1' } }] : []),
      ...doc.ops.map(op => {
        const f: Record<string, Figure> = { ...own, 'ДЕБИТ': op.d, 'КРЕДИТ': op.k, 'СУМА': op.amount }
        if (op.ad) f['АНАЛДЕБ'] = op.ad
        if (op.ak) f['АНАЛКРЕ'] = op.ak
        if (op.qty !== undefined) f['КОЛИЧЕСТВО'] = op.qty
        return { date, seq: next(), f }
      }),
    ]
  })
}

const sale = (number: string, amount: number): Spec => ({ docType: '-ФЕ', docNumber: number, total: amount * 1.2, ops: [
  { d: '411', k: '702', ad: CUSTOMER, amount }, { d: '411', k: '4532', ad: CUSTOMER, amount: amount / 5 },
] })
const purchase = (qty: Figure): Spec => ({ docType: '+ФЕ', docNumber: '77', total: 120, ops: [
  { d: '304', k: '401', ad: GOODS, ak: SUPPLIER, qty, amount: 100 }, { d: '4531', k: '401', ak: SUPPLIER, amount: 20 },
] })
const depreciation: Spec = { ops: [{ d: '603', k: '241', amount: 10 }] }

/**
 * Four days of March. The 4th is the day that will be held: a purchase whose quantity the accountant mistypes, and a sale
 * of the store they edit on the same day. The 6th books the same operation twice, so that a repeat's key (`#2`) is in it.
 */
function archive(o: { qtyOn4th: Figure; saleOn4th: number; saleOn5th: number }): ArchiveBooks {
  const records = [
    ...recordsOf('2025-03-03', [sale(`${SERIES_HOME}00101`, 100)]),
    ...recordsOf('2025-03-04', [purchase(o.qtyOn4th), sale(`${SERIES_STORE}00101`, o.saleOn4th)]),
    ...recordsOf('2025-03-05', [sale(`${SERIES_HOME}00102`, o.saleOn5th)]),
    ...recordsOf('2025-03-06', [depreciation, depreciation]),
  ]
  return { company: 'ТЕСТ ООД', eik: EIK, records, span: null, accounts: null, analytics: null }
}

/** The year as `pull-books.ts` writes it and the importer reads it back: holding, and through JSON. */
const journalOf = (books: ArchiveBooks): ParsedJournal => JSON.parse(JSON.stringify(journalOfYear(books, 2025, '2025-03-31', { hold: true })))

const V1 = archive({ qtyOn4th: '10', saleOn4th: 200, saleOn5th: 50 })
/** The quantity mistyped (a stray quote before the digits), the 4th's sale edited, the 5th's sale edited. */
const V2 = archive({ qtyOn4th: '„7', saleOn4th: 210, saleOn5th: 55 })
/** The quantity retyped. */
const V3 = archive({ qtyOn4th: '7', saleOn4th: 210, saleOn5th: 55 })

type Totals = Record<'entries' | 'new' | 'changed' | 'gone' | 'unchanged' | 'balanced' | 'fileEntries', number>

/** A journal imported into one org as `import-accounting-books.ts` sends it, its answers added up. */
async function importInto(orgId: string, by: { id: string }, journal: ParsedJournal, dryRun = false): Promise<{ totals: Totals; answers: JournalAnswer[] }> {
  assertWholeJournal(journal)
  const totals: Totals = { entries: 0, new: 0, changed: 0, gone: 0, unchanged: 0, balanced: 0, fileEntries: 0 }
  const answers: JournalAnswer[] = []
  for (const r of journalRequests(journal)) {
    const answer = await importJournalMonth(orgId, { eik: EIK, dryRun, month: r.month, coverage: r.coverage, documents: r.documents }, by)
    for (const key of ['entries', 'new', 'changed', 'gone', 'unchanged', 'balanced'] as const) totals[key] += answer[key]
    totals.fileEntries += answer.split?.fileEntries ?? 0
    answers.push(answer)
  }
  return { totals, answers }
}

/** What an org holds of a day, as the next import would find it. */
async function storedOn(orgId: string, day: string) {
  const entries: any[] = await JournalEntry.find({ orgId, date: new Date(`${day}T00:00:00.000Z`) }).sort({ importKey: 1 }).lean()
  return entries.map(e => ({ id: String(e._id), importKey: e.importKey, importHash: e.importHash, lines: JSON.stringify(e.lines), batch: String(e.importBatchId) }))
}
const keysOf = async (orgId: string) => (await JournalEntry.find({ orgId }, { importKey: 1 }).lean() as any[]).map(e => e.importKey).sort()

beforeAll(async () => {
  await setupTestDB()
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

beforeEach(async () => {
  await clearCollections()
})

describe('the journal of a year with a held day', () => {
  it('holds the 4th alone, and its month goes as two runs around it', () => {
    const j = journalOf(V2)
    expect(j.held?.map(h => [h.date, h.documents, h.operations])).toEqual([['2025-03-04', 2, 4]])
    expect(j.held![0].records.map(r => [r.at, r.field, r.value])).toEqual([['20250304\\00000002', 'КОЛИЧЕСТВО', '„7']])
    expect(j.documents.map(d => d.date)).toEqual(['2025-03-03', '2025-03-05', '2025-03-06', '2025-03-06'])
    expect(journalRequests(j).map(r => [r.month, r.coverage, r.documents.length])).toEqual([
      ['2025-01', { from: '2025-01-01', to: '2025-03-31' }, 0],
      ['2025-02', { from: '2025-01-01', to: '2025-03-31' }, 0],
      ['2025-03', { from: '2025-03-01', to: '2025-03-03' }, 1],
      ['2025-03', { from: '2025-03-05', to: '2025-03-31' }, 3],
    ])
    // every other day is the journal it would be with the figure readable: the same documents, to the field
    expect(j.documents).toEqual(journalOf(V3).documents.filter(d => d.date !== '2025-03-04'))
    expect(j.counts).toEqual({ documents: 2, operations: 6 })
  })
})

describe('one books org', () => {
  let orgId: string
  let by: { id: string }

  beforeEach(async () => {
    const store = await createTestOrg({ taxNumber: EIK } as any)
    const books = await createTestOrg({ taxNumber: EIK } as any)
    await Org.updateOne({ _id: books._id }, { $set: { 'settings.accounting.books': { mode: 'books', branches: [{ orgId: store._id, code: 'PZ', label: 'Магазин', docSeries: [SERIES_STORE] }] } } })
    await Org.updateOne({ _id: store._id }, { $set: { 'settings.accounting.books': { mode: 'branch', booksOrgId: books._id, branchCode: 'PZ' } } })
    orgId = String(books._id)
    by = { id: String((await createTestUser(books._id as any))._id) }
    await importChart(orgId, { eik: EIK, dryRun: false, accounts: CHART }, by)
    const first = await importInto(orgId, by, journalOf(V1))
    expect(first.totals).toMatchObject({ entries: 6, new: 6, balanced: 6 })
  })

  it('leaves what it holds of the held day as it is, writes the other day\'s change, and a dry rerun is unchanged', async () => {
    const heldBefore = await storedOn(orgId, '2025-03-04')
    const keysBefore = await keysOf(orgId)
    expect(heldBefore).toHaveLength(2)

    const v2 = await importInto(orgId, by, journalOf(V2))
    expect(v2.totals).toMatchObject({ entries: 4, new: 0, changed: 1, gone: 0, unchanged: 3, balanced: 4 })
    // the 4th: the same entries, ids, hashes and lines, untouched by this import; the edit made on it is not in LGR yet
    expect(await storedOn(orgId, '2025-03-04')).toEqual(heldBefore)
    // the 5th's edit is written; every key is the one it was, the repeat on the 6th included
    const fifth = await JournalEntry.findOne({ orgId, docNumber: `${SERIES_HOME}00102` }).lean() as any
    expect(fifth.lines.find((l: any) => l.credit === 55)).toBeTruthy()
    expect(await keysOf(orgId)).toEqual(keysBefore)
    expect(keysBefore.filter(k => k.endsWith('#2'))).toHaveLength(1)

    const rerun = await importInto(orgId, by, journalOf(V2), true)
    expect(rerun.totals).toMatchObject({ new: 0, changed: 0, gone: 0 })
    expect(rerun.totals.unchanged).toBe(rerun.totals.entries)
  })

  it('sent as one request a month, the way an importer that knows no held day would, the held day would be gone', async () => {
    const j = journalOf(V2)
    const march = await importJournalMonth(orgId, { eik: EIK, dryRun: true, month: '2025-03', coverage: j.period, documents: j.documents }, by)
    expect(march).toMatchObject({ gone: 2 })
    // which is why the journal names its held days as a filter, and such an importer refuses the file
    expect(j.filters).toEqual(['Held days, not to be replaced: 2025-03-04'])
  })

  it('once the figure is retyped, the day comes in with what was edited on it', async () => {
    await importInto(orgId, by, journalOf(V2))
    const heldBefore = await storedOn(orgId, '2025-03-04')
    const v3 = await importInto(orgId, by, journalOf(V3))
    expect(v3.totals).toMatchObject({ entries: 6, new: 0, changed: 2, gone: 0, unchanged: 4 })
    const after = await storedOn(orgId, '2025-03-04')
    expect(after.map(e => e.id)).toEqual(heldBefore.map(e => e.id))
    expect(after.map(e => e.importHash)).not.toEqual(heldBefore.map(e => e.importHash))
    const rerun = await importInto(orgId, by, journalOf(V3), true)
    expect(rerun.totals).toMatchObject({ entries: 6, unchanged: 6, new: 0, changed: 0, gone: 0 })
  })
})

describe('books split over two orgs (FR-25 R7)', () => {
  let home: string
  let store: string
  let by: { id: string }

  beforeEach(async () => {
    const a = await createTestOrg({ slug: 'held-home', name: 'Магазин А', taxNumber: EIK } as any)
    const b = await createTestOrg({ slug: 'held-store', name: 'Магазин Б', taxNumber: EIK } as any)
    await linkBooks({
      booksSlug: a.slug, split: true,
      branches: [{ slug: a.slug, code: 'A', docSeries: [SERIES_HOME] }, { slug: b.slug, code: 'B', docSeries: [SERIES_STORE] }],
    }, { dryRun: false })
    home = String(a._id)
    store = String(b._id)
    by = { id: String((await createTestUser(a._id as any))._id) }
    for (const orgId of [home, store]) await importChart(orgId, { eik: EIK, dryRun: false, accounts: CHART }, by)
    for (const orgId of [home, store]) await importInto(orgId, by, journalOf(V1))
  })

  it('each org leaves its share of the held day as it is, and the shares still add up to what the file sends', async () => {
    const heldHome = await storedOn(home, '2025-03-04')
    const heldStore = await storedOn(store, '2025-03-04')
    expect([heldHome.length, heldStore.length]).toEqual([1, 1])

    const h = await importInto(home, by, journalOf(V2))
    const s = await importInto(store, by, journalOf(V2))
    expect(await storedOn(home, '2025-03-04')).toEqual(heldHome)
    expect(await storedOn(store, '2025-03-04')).toEqual(heldStore)
    expect(h.totals).toMatchObject({ gone: 0, changed: 1 })
    expect(s.totals).toMatchObject({ gone: 0, changed: 0, entries: 0 })
    // what `splitProblems` checks: every request's file is the same in each org, and the shares add up to it
    expect(h.answers.map(a => a.split?.fileEntries)).toEqual(s.answers.map(a => a.split?.fileEntries))
    expect(h.totals.entries + s.totals.entries).toBe(h.totals.fileEntries)
    expect(h.totals.fileEntries).toBe(4)

    for (const orgId of [home, store]) {
      const rerun = await importInto(orgId, by, journalOf(V2), true)
      expect(rerun.totals).toMatchObject({ new: 0, changed: 0, gone: 0 })
    }
  })
})
