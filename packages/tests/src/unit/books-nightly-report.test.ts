import { describe, it, expect } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { docsRootDown, listsWithin, parseImport, problems, summarize } from '../../../../scripts/lib/books-nightly-report'

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
    expect(await listsWithin(tmpdir(), 0)).toBe(false)
  })
})
