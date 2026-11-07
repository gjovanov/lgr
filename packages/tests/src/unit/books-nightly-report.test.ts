import { describe, it, expect } from 'bun:test'
import { gzipSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImportDocument } from 'services/biz/accounting-books/import.types'
import {
  docsRootDown,
  documentChanges,
  documentChangesText,
  importedDocuments,
  labelOf,
  listsWithin,
  parseImport,
  parseImported,
  problems,
  serializeImported,
  summarize,
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
