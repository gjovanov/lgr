import { describe, it, expect } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImportDocument } from 'services/biz/accounting-books/import.types'
import {
  continuityOfFiles,
  docsRootDown,
  documentChanges,
  documentChangesText,
  importedDocuments,
  isSplitImport,
  labelOf,
  listsWithin,
  orgsOf,
  parseImport,
  parseImported,
  problems,
  serializeImported,
  splitProblems,
  sumImports,
  summarize,
  summarizeOrgs,
} from '../../../../scripts/lib/books-nightly-report'

/**
 * What the unattended books run reads out of `import-accounting-books.ts`. The lines are the importer's own,
 * from the 2026-11-05 runs: a dry rerun after an import, and the import before it.
 */

const month = (m: string, over: Record<string, unknown> = {}) => `journal ${m}: ${JSON.stringify({
  month: m, currency: 'EUR', entries: 1898, documents: 1813, operations: 9230, balanced: 1898, settles: 285, analyticsToCreate: 0,
  fiscalPeriod: 'exists', new: 0, changed: 0, gone: 0, unchanged: 1898, unknownDocTypes: [], unknownAccounts: [], ...over,
})}`

const rerun = [
  'Dry run: nothing is written. Add --execute.',
  'chart: {"created":0,"updated":0,"unchanged":251}',
  '  dropped from the chart: 149694 (code), 503 (name)',
  'analytics: {"created":0,"updated":0,"unchanged":10340,"byRoot":{},"contacts":{"created":0,"linked":0,"withoutIdentifier":0},"bankAccounts":{"created":0,"linked":8,"noLedgerAccount":0},"fixedAssets":{"linked":0,"unlinked":122}}',
  'opening 2026: {"year":2026,"currency":"EUR","outcome":"unchanged","lines":1760,"balanced":true,"accountsWithRemainder":["401","411"],"unknownAccounts":[],"analyticsToCreate":0,"continuity":{"checked":66,"equal":66,"differing":[]}}',
  'journal-2026.json: 21408 documents, 110250 operations, 2026-01-01 to 2026-11-05',
  month('2026-01'),
  'journal total: {"entries":22151,"operations":110250,"balanced":22151,"new":0,"changed":0,"gone":0,"unchanged":22151,"settles":3517}',
  'finish: {"accounts":251,"changed":0}',
].join('\n')

describe('books nightly: reading the importer', () => {
  it('a dry rerun with nothing to do is no change and no problem', () => {
    const r = parseImport(rerun)
    expect(Object.keys(r.steps).sort()).toEqual(['analytics', 'chart', 'finish', 'journal total', 'opening'])
    expect(r.months).toHaveLength(1)
    expect(problems(r)).toEqual([])
    expect(summarize(2026, r)).toEqual({
      year: 2026,
      changes: 0,
      text: '2026: journal 0 new, 0 changed, 0 gone (22151 entries) · opening unchanged · chart 0 · analytics 0, contacts 0 · finish 0 accounts',
    })
  })

  it('counts every kind of change, the opening as one', () => {
    const r = parseImport(rerun
      .replace('"outcome":"unchanged"', '"outcome":"changed"')
      .replace('"new":0,"changed":0,"gone":0,"unchanged":22151', '"new":41,"changed":126,"gone":41,"unchanged":21984')
      .replace('"contacts":{"created":0', '"contacts":{"created":2')
      .replace('finish: {"accounts":251,"changed":0}', 'finish: {"accounts":251,"changed":3}'))
    expect(summarize(2026, r).changes).toBe(41 + 126 + 41 + 1 + 2 + 3)
  })

  it('stops on an unbalanced month, an unknown account or document type, a broken continuity, or a missing step', () => {
    const r = parseImport([
      rerun.replace('"differing":[]', '"differing":["401"]').replace(/^finish: .*$/m, ''),
      month('2026-02', { balanced: 1897, unknownDocTypes: ['ЗЗ'], unknownAccounts: ['999'] }),
    ].join('\n'))
    expect(problems(r)).toEqual([
      'the import printed no finish line',
      '2026-02: 1 entries not balanced',
      '2026-02: 1 unknown document types',
      '2026-02: 1 unknown accounts',
      'opening: continuity differs on 1 accounts',
    ])
  })
})

/**
 * The docs root is a WSL share. A stuck distro HANGS a read rather than failing it, and the run's own state lives on that
 * share, so the run asks a child whether the root lists and keeps the outage on the PC.
 */
describe('books nightly: a docs root that does not answer', () => {
  const at = (hours: number) => new Date(Date.UTC(2026, 10, 6, 6) + hours * 3600_000).toISOString()

  it('counts from the first run it does not answer, and mails nothing yet', () => {
    expect(docsRootDown(undefined, at(0), 6)).toEqual({ down: { since: at(0) }, hours: 0, mail: false })
  })

  it('is mailed once it has been down the hours it is given', () => {
    expect(docsRootDown({ since: at(0) }, at(4), 6).mail).toBe(false)
    expect(docsRootDown({ since: at(0) }, at(6), 6)).toEqual({ down: { since: at(0) }, hours: 6, mail: true })
  })

  it('then once a day while it lasts', () => {
    const mailed = { since: at(0), mailedAt: at(6) }
    expect(docsRootDown(mailed, at(8), 6)).toEqual({ down: mailed, hours: 8, mail: false })
    expect(docsRootDown(mailed, at(30), 6).mail).toBe(true)
  })

  it('a folder that lists answers, a missing one does not', async () => {
    expect(await listsWithin(tmpdir(), 10_000)).toBe(true)
    expect(await listsWithin(join(tmpdir(), `no-such-folder-${process.pid}-${Date.now()}`), 10_000)).toBe(false)
  })

  it('a child that has not answered in time is killed, and that is no answer', async () => {
    // A child that never answers, as a hung share does. A 0 ms deadline on a real listing raced the child (#569).
    const started = Date.now()
    expect(await listsWithin(tmpdir(), 200, [process.execPath, '-e', 'setInterval(() => {}, 1000)'])).toBe(false)
    expect(Date.now() - started).toBeLessThan(5_000)
  })
})

/**
 * The importer answers with counts per month. The run keeps the documents of each import by the importer's own key, so the
 * next mail can say which documents changed, by date, type and number. Made-up documents in the archive's shape.
 */
describe('books nightly: which documents an import changed', () => {
  const customer = 'КЛИЕНТИ:Примерна фирма ЕООД'
  const sale = (over: Partial<ImportDocument> = {}, partner = customer): ImportDocument => ({
    date: '2026-01-08',
    docType: '-ФЕ',
    docNumber: '2000000001',
    vatKind: '1',
    total: 120,
    comment: 'Стоки',
    ops: [
      { d: '702', k: '304', ak: 'СТОКИ:Болт М8Х25', qty: 10, amount: 80 },
      { d: '411', k: '702', ad: partner, amount: 100 },
      { d: '411', k: '4532', ad: partner, amount: 20 },
    ],
    ...over,
  })
  const payment: ImportDocument = { date: '2026-02-23', ops: [{ d: '503', k: '411', ad: 'БАНКОВИ СМЕТКИ:BG00TEST00000000000001', ak: customer, amount: 120 }] }
  const changes = (before: ImportDocument[], after: ImportDocument[]) => documentChanges(importedDocuments(before), importedDocuments(after))

  it('the same journal twice changes nothing', () => {
    expect(changes([sale(), payment], [sale(), payment])).toEqual([])
  })

  it('an invoice paid later changes in its header alone, and says so (FR-25a)', () => {
    const issued = sale({ props: { paymentCode: '2' } })
    const paid = sale({ props: { paymentCode: '2', paidAmount: 120, links: [{ docType: '+ББ', docNumber: '901', amount: 120 }] } })
    expect(changes([issued], [paid])).toEqual([{ month: '2026-01', kind: 'changed', label: '2026-01-08 -ФЕ 2000000001', what: 'header (paid, links, …)' }])
    // the first run that sends a header at all says the same of every document, and a document without one reads as before
    expect(changes([sale()], [issued])[0].what).toBe('header (paid, links, …)')
    expect(importedDocuments([sale()]).values().next().value!.parts.split('.')).toHaveLength(9)
  })

  it('a document with another operation, or other amounts, is changed, and says what', () => {
    const paid = sale({ ops: [...sale().ops, { d: '501', k: '411', ak: customer, amount: 120 }] })
    expect(changes([sale()], [paid])).toEqual([{ month: '2026-01', kind: 'changed', label: '2026-01-08 -ФЕ 2000000001', what: '3 → 4 operations' }])
    const resold = sale({ total: 121, ops: sale().ops.map(op => (op.k === '702' ? { ...op, amount: 101 } : op)) })
    expect(changes([sale()], [resold])[0].what).toBe('total, amounts or quantities')
  })

  /**
   * A delivery entered back-dated makes PlusMinus work out the cost of the goods sold since then again: 49 documents of the
   * 2026-11-06 mail had changed nothing else.
   */
  describe('the cost of goods', () => {
    const recost = (doc: ImportDocument, amount: number): ImportDocument => ({ ...doc, ops: doc.ops.map(op => (op.k === '304' ? { ...op, amount } : op)) })

    it('a sale whose cost alone was worked out again says so', () => {
      expect(changes([sale()], [recost(sale(), 65.31)])[0].what).toBe('cost of goods')
    })

    it('so does a write-off, which takes goods out of stock too', () => {
      const writeOff: ImportDocument = { date: '2026-03-02', docType: 'СИ', docNumber: '7', total: 0, ops: [{ d: '601', k: '304', ak: 'СТОКИ:Болт М8Х25', qty: 2, amount: 16 }] }
      expect(changes([writeOff], [recost(writeOff, 15.5)])[0].what).toBe('cost of goods')
    })

    it('a quantity is never a cost: another quantity sold is other amounts too', () => {
      const more = sale({ total: 132, ops: [
        { d: '702', k: '304', ak: 'СТОКИ:Болт М8Х25', qty: 11, amount: 88 },
        { d: '411', k: '702', ad: customer, amount: 110 },
        { d: '411', k: '4532', ad: customer, amount: 22 },
      ] })
      expect(changes([sale()], [more])[0].what).toBe('total, amounts or quantities, cost of goods')
      const recounted = sale({ ops: sale().ops.map(op => (op.k === '304' ? { ...op, qty: 11 } : op)) })
      expect(changes([sale()], [recounted])[0].what).toBe('amounts or quantities')
    })

    it('goods coming into stock are not a cost', () => {
      const delivery: ImportDocument = { date: '2026-10-26', docType: '+ФЕ', docNumber: '475', total: 96, ops: [{ d: '304', k: '401', ad: 'СТОКИ:Болт М8Х25', ak: 'ДОСТАВЧИЦИ:Доставчик ООД', qty: 10, amount: 80 }] }
      expect(changes([delivery], [{ ...delivery, ops: [{ ...delivery.ops[0], amount: 79 }] }])[0].what).toBe('amounts or quantities')
    })

    it('against a file kept before the cost of goods was told apart, it is still "amounts or quantities"', () => {
      const kept = importedDocuments([sale()])
      for (const doc of kept.values()) doc.parts = doc.parts.split('.').slice(0, 7).join('.')
      expect(documentChanges(kept, importedDocuments([recost(sale(), 65.31)]))[0].what).toBe('amounts or quantities')
      expect(documentChanges(kept, importedDocuments([sale()]))).toEqual([])
    })
  })

  it('a document moved to another customer is one move, not one new and one gone', () => {
    const credit = sale({ docType: '-ФИ', total: -120 })
    const moved = changes([sale(), credit], [sale({}, 'КЛИЕНТИ:Друга фирма ООД'), credit])
    expect(moved).toEqual([{ month: '2026-01', kind: 'moved', label: '2026-01-08 -ФЕ 2000000001', what: 'another customer or supplier' }])
  })

  it('a document that arrives is new, one that leaves is gone', () => {
    const later = sale({ date: '2026-10-31', docNumber: '2000000002' })
    expect(changes([sale(), payment], [sale(), later]).map(c => [c.month, c.kind, c.label])).toEqual([
      ['2026-02', 'gone', '2026-02-23 D503 K411'],
      ['2026-10', 'new', '2026-10-31 -ФЕ 2000000002'],
    ])
  })

  it('a label is a date, a type and a number, never a name or an amount', () => {
    expect(labelOf(sale())).toBe('2026-01-08 -ФЕ 2000000001')
    expect(labelOf(payment)).toBe('2026-02-23 D503 K411')
    const text = documentChangesText(changes([sale(), payment], [sale({}, 'КЛИЕНТИ:Друга фирма ООД'), sale({ docNumber: '2000000002', total: 77.5 })])).join('\n')
    expect(text).not.toContain('фирма')
    expect(text).not.toContain('77.5')
  })

  it('reads as a line per month with its counts, then a line per document', () => {
    const before = [sale(), sale({ docNumber: '2000000002' }), payment]
    const after = [sale({ ops: sale().ops.slice(0, 2) }), sale({ docNumber: '2000000003' }), payment, sale({ date: '2026-10-16', docNumber: '2000000004' })]
    expect(documentChangesText(changes(before, after))).toEqual([
      '2026-01: 1 new, 1 changed, 1 gone',
      '  changed 2026-01-08 -ФЕ 2000000001 (3 → 2 operations)',
      '  gone    2026-01-08 -ФЕ 2000000002',
      '  new     2026-01-08 -ФЕ 2000000003',
      '2026-10: 1 new',
      '  new     2026-10-16 -ФЕ 2000000004',
    ])
  })

  it('what a run keeps reads back as it was, and anything else reads as nothing', () => {
    const kept = { archive: '20261106.arz', sha12: 'E0C4B28A3E71', at: '2026-11-06T16:00:54.395Z', documents: importedDocuments([sale(), payment]) }
    expect(parseImported(serializeImported(kept))).toEqual(kept)
    expect(parseImported(new Uint8Array([1, 2, 3]))).toBeUndefined()
    expect(parseImported(gzipSync(JSON.stringify({ v: 2, documents: [] })))).toBeUndefined()
  })
})

/**
 * FR-25 R7: one archive into every org of a split. Fictional counts. Each org prints the importer's lines for its share;
 * the run reads them per org and as the group.
 */
describe('books nightly: a split, imported into each org of it', () => {
  /** One org's printed import of 2026: its share, and the file's whole count beside it. */
  const share = (role: 'home' | 'member', o: { entries: number; file?: number; new?: number; opening?: string; contacts?: number; finish?: number }) => [
    'chart: {"created":0,"updated":0,"unchanged":10}',
    `analytics: {"created":0,"updated":0,"unchanged":20,"byRoot":{},"contacts":{"created":${o.contacts ?? 0},"linked":0,"withoutIdentifier":0,"deferred":5},"bankAccounts":{"created":0,"linked":1,"noLedgerAccount":0},"fixedAssets":{"linked":0,"unlinked":0}}`,
    `opening 2026: ${JSON.stringify({ year: 2026, currency: 'EUR', outcome: o.opening ?? 'unchanged', lines: role === 'home' ? 12 : 0, balanced: true, accountsWithRemainder: [], unknownAccounts: [], analyticsToCreate: 0, continuity: null, split: { role } })}`,
    `journal total: ${JSON.stringify({ entries: o.entries, operations: o.entries * 3, balanced: o.entries, new: o.new ?? 0, changed: 0, gone: 0, unchanged: o.entries - (o.new ?? 0), settles: 0, fileEntries: o.file ?? 100 })}`,
    `finish: {"accounts":10,"changed":${o.finish ?? 0}}`,
  ].join('\n')

  const home = (o: Parameters<typeof share>[1]) => ({ org: 'store-a', parsed: parseImport(share('home', o)) })
  const store = (o: Parameters<typeof share>[1]) => ({ org: 'store-b', parsed: parseImport(share('member', o)) })

  it('takes every org of BOOKS_NIGHTLY_ORGS, else the one BOOKS_NIGHTLY_ORG, as before', () => {
    expect(orgsOf(' store-a, store-b ,store-a,', 'books')).toEqual(['store-a', 'store-b'])
    expect(orgsOf('', 'books')).toEqual(['books'])
    expect(orgsOf(undefined, 'books')).toEqual(['books'])
  })

  it('one org reads exactly as the run always read it', () => {
    const one = { org: 'books', parsed: parseImport(rerun) }
    expect(summarizeOrgs(2026, [one])).toEqual(summarize(2026, one.parsed))
    expect(isSplitImport(one.parsed)).toBe(false)
    expect(splitProblems(2026, [one])).toEqual([])
  })

  it('a split reads as the group, then a line an org, counts only', () => {
    const parts = [home({ entries: 70, new: 3, opening: 'changed', finish: 2 }), store({ entries: 30, new: 1, contacts: 1 })]
    expect(parts.every(p => isSplitImport(p.parsed))).toBe(true)
    expect(problems(parts[0].parsed)).toEqual([])
    expect(problems(parts[1].parsed)).toEqual([])
    const year = summarizeOrgs(2026, parts)
    expect(year.changes).toBe(3 + 1 + 2 + 1 + 1)
    expect(year.text.split('\n')).toEqual([
      '2026: journal 4 new, 0 changed, 0 gone (100 entries) · opening changed · chart 0 · analytics 0, contacts 1 · finish 2 accounts',
      '  store-a: journal 3 new, 0 changed, 0 gone (70 entries) · opening changed · chart 0 · analytics 0, contacts 0 · finish 2 accounts',
      '  store-b: journal 1 new, 0 changed, 0 gone (30 entries) · opening unchanged · chart 0 · analytics 0, contacts 1 · finish 0 accounts',
    ])
  })

  it('adds the steps of several imports up: counts, the one outcome that moved, flags that hold everywhere', () => {
    const sum = sumImports([home({ entries: 70, opening: 'new' }), store({ entries: 30 })].map(p => p.parsed))
    expect(sum.steps['journal total']).toMatchObject({ entries: 100, balanced: 100, operations: 300 })
    expect(sum.steps.opening).toMatchObject({ outcome: 'new', balanced: true, lines: 12, continuity: null })
    expect(sum.steps.analytics.contacts).toMatchObject({ created: 0, deferred: 10 })
  })

  it('the shares add up to the file, with one home: else the run stops and says why', () => {
    expect(splitProblems(2026, [home({ entries: 70 }), store({ entries: 30 })])).toEqual([])
    // A store left out of the run, or listed with other stores in one org than in the other: an entry held by nobody or twice.
    expect(splitProblems(2026, [home({ entries: 70 })])).toEqual([
      "2026: the orgs hold 70 entries of the file's 100: every org of the split must be in BOOKS_NIGHTLY_ORGS, with the same stores",
    ])
    expect(splitProblems(2026, [home({ entries: 75 }), store({ entries: 30 })])[0]).toContain('hold 105 entries')
    expect(splitProblems(2026, [home({ entries: 70 }), store({ entries: 30, file: 99 })])).toEqual(['2026: the orgs were sent files of different sizes (100, 99 entries)'])
    expect(splitProblems(2026, [store({ entries: 70 }), store({ entries: 30 })])).toEqual(['2026: 0 orgs answered as the split\'s home, not one'])
    expect(splitProblems(2026, [home({ entries: 100 }), { org: 'books', parsed: parseImport(rerun) }])[0]).toBe('2026: 1 of the orgs keep books of their own, beside a split')
  })

  it('the year opens where the one before closed, per account, at the rate where the currency changed', () => {
    const before = {
      opening: [{ code: '101', debit: 0, credit: 1955.83 }, { code: '501', debit: 1955.83, credit: 0 }],
      documents: [
        { date: '2025-03-03', docType: '-ФЕ', docNumber: '1', ops: [{ d: '501', k: '702', amount: 195.583 }] },
        { date: '2025-12-31', ops: [{ d: '702', k: '123', amount: 195.583 }] },
      ] as ImportDocument[],
    }
    const opening = [{ code: '101', debit: 0, credit: 1000 }, { code: '501', debit: 1100, credit: 0 }, { code: '123', debit: 0, credit: 100 }]
    expect(continuityOfFiles(2026, before, opening)).toEqual({ checked: 4, equal: 4, differing: [] })
    expect(continuityOfFiles(2026, before, opening.map(l => (l.code === '501' ? { ...l, debit: 1099 } : l)))).toEqual({ checked: 4, equal: 3, differing: ['501'] })
    // Inside one currency there is no rate.
    expect(continuityOfFiles(2025, { opening: [{ code: '501', debit: 10, credit: 0 }], documents: [] }, [{ code: '501', debit: 10, credit: 0 }]).differing).toEqual([])
  })
})
