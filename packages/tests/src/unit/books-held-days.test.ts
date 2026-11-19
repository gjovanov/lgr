import { describe, it, expect } from 'bun:test'
import {
  ExportRefused,
  MAX_HELD_DAYS_A_YEAR,
  MAX_UNREADABLE_RECORDS,
  assertWholeJournal,
  daysAround,
  heldBeyondLimits,
  heldFilter,
  journalRequests,
  type HeldDay,
  type ParsedJournal,
} from 'services/biz/accounting-books/plusminus-exports'
import { monthsBetween } from 'services/biz/accounting-books/registry'
import type { ImportDocument } from 'services/biz/accounting-books/import.types'

/**
 * A journal with held days (`ParsedJournal.held`), as the importer takes it: which days each request covers, and what makes
 * such a journal one to replace months with. Invented documents and days.
 */

const doc = (date: string, docNumber: string): ImportDocument => ({ date, docType: '+ФЕ', docNumber, total: 12, ops: [{ d: '304', k: '401', amount: 10 }, { d: '4531', k: '401', amount: 2 }] })
const day = (date: string, over: Partial<HeldDay> = {}): HeldDay => ({
  date, documents: 1, operations: 2,
  records: [{ at: `${date.replace(/-/g, '')}\\00000002`, doc: '+ФЕ 1', line: 'Дт 304 Кт 401', field: 'КОЛИЧЕСТВО', value: '„1', reason: 'plusminus-archive: … is not a number' }],
  ...over,
})

/** A year's journal as `journalOfYear` writes it: held days named twice, in `held` and as its filter line. */
function journal(documents: ImportDocument[], held: HeldDay[] = [], period = { from: '2026-01-01', to: '2026-03-31' }): ParsedJournal {
  return {
    eik: '000000000', period, currency: 'EUR', filters: held.length ? [heldFilter(held)] : [], documents,
    counts: { documents: documents.length, operations: documents.reduce((n, d) => n + d.ops.length, 0) },
    declared: { documents: documents.length, operations: documents.reduce((n, d) => n + d.ops.length, 0) },
    withoutHeader: [], ...(held.length ? { held } : {}),
  }
}

const refusal = (j: ParsedJournal): string => {
  try {
    assertWholeJournal(j)
    return ''
  } catch (e) {
    return e instanceof ExportRefused ? `${e.code}: ${e.message}` : `not refused but thrown: ${(e as Error).message}`
  }
}

describe('the days around held ones', () => {
  it('is the range itself when nothing is held, and the runs between held days otherwise', () => {
    expect(daysAround('2026-03-01', '2026-03-31', [])).toEqual([{ from: '2026-03-01', to: '2026-03-31' }])
    expect(daysAround('2026-03-01', '2026-03-31', ['2026-03-04'])).toEqual([{ from: '2026-03-01', to: '2026-03-03' }, { from: '2026-03-05', to: '2026-03-31' }])
    expect(daysAround('2026-03-01', '2026-03-31', ['2026-03-04', '2026-03-05', '2026-03-20'])).toEqual([
      { from: '2026-03-01', to: '2026-03-03' }, { from: '2026-03-06', to: '2026-03-19' }, { from: '2026-03-21', to: '2026-03-31' },
    ])
  })

  it('drops a held first or last day, and is nothing when every day is held', () => {
    expect(daysAround('2026-03-01', '2026-03-31', ['2026-03-01', '2026-03-31'])).toEqual([{ from: '2026-03-02', to: '2026-03-30' }])
    expect(daysAround('2026-03-04', '2026-03-04', ['2026-03-04'])).toEqual([])
    // a held day outside the range changes nothing
    expect(daysAround('2026-03-01', '2026-03-31', ['2026-04-04'])).toEqual([{ from: '2026-03-01', to: '2026-03-31' }])
  })

  it('counts calendar days: a leap day, a month\'s end', () => {
    expect(daysAround('2028-02-27', '2028-03-02', ['2028-02-29'])).toEqual([{ from: '2028-02-27', to: '2028-02-28' }, { from: '2028-03-01', to: '2028-03-02' }])
    expect(daysAround('2026-02-27', '2026-03-01', [])).toEqual([{ from: '2026-02-27', to: '2026-03-01' }])
  })

  it('refuses what is no day', () => {
    expect(() => daysAround('2026-02-30', '2026-03-01', [])).toThrow('is no range of days')
    expect(() => daysAround('2026-3-1', '2026-03-01', [])).toThrow('is no range of days')
  })
})

describe('the requests a journal is imported as', () => {
  const docs = [doc('2026-01-15', '1'), doc('2026-03-03', '2'), doc('2026-03-05', '3'), doc('2026-03-31', '4')]

  it('with nothing held: a request a month, the empty ones too, each covering the whole file, as always', () => {
    const j = journal(docs)
    expect(journalRequests(j)).toEqual(monthsBetween('2026-01-01', '2026-03-31').map(month => ({
      month, coverage: j.period, documents: docs.filter(d => d.date.startsWith(month)),
    })))
  })

  it('a month with a held day goes as a request per run around it, each covering its run; the other months as always', () => {
    const j = journal(docs, [day('2026-03-04')])
    expect(journalRequests(j)).toEqual([
      { month: '2026-01', coverage: j.period, documents: [docs[0]] },
      { month: '2026-02', coverage: j.period, documents: [] },
      { month: '2026-03', coverage: { from: '2026-03-01', to: '2026-03-03' }, documents: [docs[1]] },
      { month: '2026-03', coverage: { from: '2026-03-05', to: '2026-03-31' }, documents: [docs[2], docs[3]] },
    ])
  })

  it('sends every document once, and covers each day of the period but the held ones exactly once', () => {
    const held = [day('2026-01-01'), day('2026-02-14'), day('2026-03-04')]
    const requests = journalRequests(journal(docs, held))
    expect(requests.flatMap(r => r.documents)).toEqual(docs)
    const next = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)
    const daysOf = (from: string, to: string) => { const out: string[] = []; for (let d = from; d <= to; d = next(d)) out.push(d); return out }
    const lastOf = (month: string) => new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10)
    // what the server judges of each request: its coverage, within its month (`import.service.ts#coveredDays`)
    const covered = requests.flatMap(r => daysOf([r.coverage.from, `${r.month}-01`].sort()[1], [r.coverage.to, lastOf(r.month)].sort()[0]))
    expect(new Set(covered).size).toBe(covered.length)
    expect([...covered, ...held.map(h => h.date)].sort()).toEqual(daysOf('2026-01-01', '2026-03-31'))
  })

  it('the period\'s first and last day held, and a month whose covered days are all held, which is not sent', () => {
    const j = journal([doc('2026-01-02', '1')], [day('2026-01-01'), day('2026-02-01')], { from: '2026-01-01', to: '2026-02-01' })
    expect(journalRequests(j)).toEqual([{ month: '2026-01', coverage: { from: '2026-01-02', to: '2026-01-31' }, documents: [doc('2026-01-02', '1')] }])
  })

  it('a document past the end of the file is refused here, as the server would refuse it', () => {
    const j = journal([doc('2026-03-31', '1')], [day('2026-03-04')], { from: '2026-01-01', to: '2026-03-30' })
    expect(() => journalRequests(j)).toThrow('A document of 2026-03-31 is outside what the file covers.')
  })
})

describe('a journal with held days, fit to replace months with', () => {
  const docs = [doc('2026-01-15', '1'), doc('2026-03-05', '3')]

  it('is whole but for its held days, its own filter line included', () => {
    expect(refusal(journal(docs, [day('2026-03-04')]))).toBe('')
    expect(refusal(journal(docs, [day('2026-02-01'), day('2026-03-04'), day('2026-03-06')]))).toBe('')
    // held days without the filter line are still held days: the line only keeps an older importer out
    expect(refusal({ ...journal(docs, [day('2026-03-04')]), filters: [] })).toBe('')
  })

  it('refuses a filter line that is not its own held days\', and any other filter as before', () => {
    expect(refusal({ ...journal(docs, [day('2026-03-04')]), filters: [heldFilter([day('2026-03-05')])] })).toMatch(/^filtered_export: This export is filtered \(1 filter/)
    expect(refusal({ ...journal(docs), filters: [heldFilter([day('2026-03-04')])] })).toMatch(/^filtered_export:/)
    expect(refusal({ ...journal(docs, [day('2026-03-04')]), filters: [heldFilter([day('2026-03-04')]), 'Партньор: Клиент А'] })).toMatch(/^filtered_export: This export is filtered \(1 filter/)
  })

  it('refuses a held day that still has a document in the journal, or an operation without its header', () => {
    expect(refusal(journal([...docs, doc('2026-03-04', '9')], [day('2026-03-04')]))).toBe('held_days: The journal holds 2026-03-04, and still has a document of that day.')
    const orphan = { ...journal(docs, [day('2026-03-04')]), withoutHeader: [{ at: 'archive 20260304\\00000009', date: '2026-03-04', docType: '+ББ', docNumber: '9' }] }
    expect(refusal(orphan)).toMatch(/^held_days: The journal holds 2026-03-04/)
  })

  it('refuses a held day that is none: no calendar day, named twice, uncounted, with nothing to retype', () => {
    for (const bad of [
      [day('2026-02-30')],
      [day('2026-03-04'), day('2026-03-04')],
      [day('2026-03-04', { documents: -1 })],
      [day('2026-03-04', { operations: 1.5 })],
      [day('2026-03-04', { records: [] })],
      [{ date: '2026-03-04' } as HeldDay],
    ]) expect(refusal(journal(docs, bad))).toMatch(/^held_days: A held day of this journal is not one/)
  })

  it('refuses more held days than a typo explains', () => {
    const four = ['2026-01-05', '2026-02-05', '2026-03-04', '2026-03-06'].map(d => day(d))
    expect(refusal(journal(docs, four))).toBe(
      `held_days: This journal holds more days than a typo explains: 4 days of 2026 would be held (more than ${MAX_HELD_DAYS_A_YEAR}): that looks like a change in the archive's format, not a typo, so no day is held.`,
    )
  })

  it('a journal whose only documents are on a held day is not a filtered one', () => {
    const noDocument: ImportDocument = { date: '2026-01-05', ops: [{ d: '603', k: '241', amount: 10 }] }
    const j = { ...journal([noDocument], [day('2026-01-02')]), declared: { documents: 0, operations: 1 } }
    expect(refusal(j)).toBe('')
    expect(refusal({ ...j, held: undefined, filters: [] })).toBe('filtered_export: This export has no document rows. Export the journal with the documents.')
  })
})

describe('how many held days are a typo', () => {
  const at = (date: string, n: number) => ({ date, records: Array.from({ length: n }, (_, i) => ({ at: `${date}\\${i}` })) })

  it('up to three days a year, and up to ten records, each counted once whatever its figures', () => {
    expect(heldBeyondLimits([at('2026-01-01', 1), at('2026-01-02', 1), at('2026-01-03', 1)])).toBeUndefined()
    expect(heldBeyondLimits([at('2025-01-01', 1), at('2025-01-02', 1), at('2025-01-03', 1), at('2026-01-01', 1), at('2026-01-02', 1), at('2026-01-03', 1)])).toBeUndefined()
    expect(heldBeyondLimits([at('2026-01-01', MAX_UNREADABLE_RECORDS)])).toBeUndefined()
    // one record with two figures is one record
    expect(heldBeyondLimits([{ date: '2026-01-01', records: [...at('2026-01-01', MAX_UNREADABLE_RECORDS).records, { at: '2026-01-01\\0' }] }])).toBeUndefined()
  })

  it('more is a change in the archive\'s format', () => {
    expect(heldBeyondLimits([at('2026-01-01', 1), at('2026-01-02', 1), at('2026-01-03', 1), at('2026-12-31', 1)])).toBe(
      '4 days of 2026 would be held (more than 3): that looks like a change in the archive\'s format, not a typo, so no day is held',
    )
    expect(heldBeyondLimits([at('2026-01-01', 6), at('2026-01-02', 5)])).toBe(
      '11 records cannot be read (more than 10): that looks like a change in the archive\'s format, not a typo, so no day is held',
    )
  })
})
