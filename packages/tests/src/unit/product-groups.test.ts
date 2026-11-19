import { describe, expect, it } from 'bun:test'
import {
  addCoverage, evidenceOf, evidenceOfDocument, exactGroupsOf, groupNameKey, newCoverage, pairDocuments, placeOf, planProductGroups, postsBy,
  rowsBySource, tallyEvidence,
  type BooksSalesEntry, type Evidence, type LgrSalesDocument, type MapRow, type OrgSeries,
} from 'services/biz/accounting-books/product-groups'

/** FR-25 R3, slice 1: the product → accounting group map and its coverage. Made-up series, numbers, groups and products only. */

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const SERIES: OrgSeries = { own: ['90001'], otherStores: ['90002'], outside: ['90009'] }

const entry = (over: Partial<BooksSalesEntry> = {}): BooksSalesEntry => ({ docType: '-ФЕ', docNumber: '9000100001', registerDocType: '1', goods: [], ...over })
const doc = (over: Partial<LgrSalesDocument> = {}): LgrSalesDocument => ({
  id: 'd1', type: 'invoice', number: 'INV-9000100001', day: day('2026-09-10'), imported: true, inPeriod: true, lines: [], ...over,
})

describe('where a books entry belongs', () => {
  it('a store\'s own series, a till\'s month, a store outside LGR, another store, no series; nothing for a document that is no sale', () => {
    expect(placeOf({ docType: '-ФЕ', docNumber: '9000100001' }, SERIES)).toBe('own')
    expect(placeOf({ docType: '-ФЕА', docNumber: '9000100001' }, SERIES)).toBe('own')
    expect(placeOf({ docType: 'КП', docNumber: '1' }, SERIES)).toBe('till')
    // A till's month is told by its type, even where its number would read as a series.
    expect(placeOf({ docType: 'КП', docNumber: '9000100001' }, SERIES)).toBe('till')
    expect(placeOf({ docType: '-ФЕ', docNumber: '9000900001' }, SERIES)).toBe('outside')
    expect(placeOf({ docType: '-ФЕ', docNumber: '9000200001' }, SERIES)).toBe('other_store')
    expect(placeOf({ docType: '-ФЕ', docNumber: '1234' }, SERIES)).toBe('no_series')
    expect(placeOf({ docType: '+ФЕ', docNumber: '9000100001' }, SERIES)).toBeUndefined()
    expect(placeOf({ docType: undefined, docNumber: undefined }, SERIES)).toBeUndefined()
  })
})

describe('pairing a books document with LGR\'s', () => {
  it('matches the number without LGR\'s display prefix or leading zeros, and counts what has no pair', () => {
    const { paired, counts } = pairDocuments(
      [entry({ docNumber: '9000100001' }), entry({ docNumber: '9000100002' }), entry({ docNumber: '90001X' })],
      [
        doc({ id: 'a', number: 'INV-9000100001' }),
        doc({ id: 'b', number: 'INV-9000100003' }),
        // Outside the period, unpaired: loaded only to pair across the edge, so not "missing from the books".
        doc({ id: 'c', number: 'INV-9000100004', inPeriod: false }),
      ],
    )
    expect(paired.map(p => p.doc.id)).toEqual(['a'])
    expect(counts).toEqual({ entries: 3, pairedEntries: 1, pairedDocuments: 1, notInLgr: 1, noNumber: 1, ambiguous: 0, typeDiffers: 0, notInBooks: 1 })
  })

  it('of two LGR documents under one number takes the imported one, and pairs neither when that does not decide', () => {
    const one = pairDocuments([entry()], [doc({ id: 'native', imported: false }), doc({ id: 'imported' })])
    expect(one.paired.map(p => p.doc.id)).toEqual(['imported'])
    const none = pairDocuments([entry()], [doc({ id: 'x', imported: false }), doc({ id: 'y', imported: false })])
    expect(none.paired).toEqual([])
    expect(none.counts.ambiguous).toBe(1)
  })

  it('pairs a credit notice only with a credit note, and an entry without a register type with whatever holds the number', () => {
    const notice = entry({ registerDocType: '3' })
    expect(pairDocuments([notice], [doc({ type: 'invoice' })]).counts.typeDiffers).toBe(1)
    expect(pairDocuments([notice], [doc({ type: 'credit_note' })]).paired).toHaveLength(1)
    // `03` and `3` are one code.
    expect(pairDocuments([entry({ registerDocType: '03' })], [doc({ type: 'credit_note' })]).paired).toHaveLength(1)
    expect(pairDocuments([entry({ registerDocType: undefined })], [doc({ type: 'debit_note' })]).paired).toHaveLength(1)
  })

  it('an invoice and its annulment carry one number: one LGR document, two entries', () => {
    const { paired, counts } = pairDocuments([entry(), entry({ docType: '-ФЕА' })], [doc()])
    expect(paired).toHaveLength(1)
    expect(paired[0].entries.map(e => e.docType)).toEqual(['-ФЕ', '-ФЕА'])
    expect(counts).toMatchObject({ pairedEntries: 2, pairedDocuments: 1 })
  })
})

describe('what a paired document teaches', () => {
  it('one group at LGR\'s total quantity maps every product on the document; a typed line maps nothing', () => {
    const ev = evidenceOf(
      entry({ goods: [{ groupId: 'G1', quantity: 5 }, { groupId: 'G1', quantity: 2.5 }] }),
      doc({ lines: [{ productId: 'p1', quantity: 3 }, { productId: 'p2', quantity: 2.5 }, { productId: 'p1', quantity: 1 }, { quantity: 1 }] }),
    )
    expect(ev.outcome).toBe('one_group')
    expect(ev.votes).toEqual([{ productId: 'p1', groupId: 'G1' }, { productId: 'p2', groupId: 'G1' }])
    expect(ev.lines).toEqual({ goods: 4, byOneGroup: 3, byQuantity: 0, notMatched: 0, noProduct: 1 })
  })

  it('one group at another quantity than LGR\'s maps nothing by the group: a line may be booked elsewhere', () => {
    const ev = evidenceOf(entry({ goods: [{ groupId: 'G1', quantity: 5 }] }), doc({ lines: [{ productId: 'p1', quantity: 5 }, { productId: 'p2', quantity: 1 }] }))
    expect(ev).toMatchObject({ outcome: 'not_line_for_line', oneGroupQuantityDiffers: true, votes: [] })
    // As many operations as lines: the line-for-line rule maps what it can.
    const same = evidenceOf(entry({ goods: [{ groupId: 'G1', quantity: 5 }, { groupId: 'G1', quantity: 2 }] }), doc({ lines: [{ productId: 'p1', quantity: 5 }, { productId: 'p2', quantity: 1 }] }))
    expect(same).toMatchObject({ outcome: 'line_for_line', oneGroupQuantityDiffers: true, votes: [{ productId: 'p1', groupId: 'G1' }] })
  })

  it('line for line, a line maps only where its quantity is unique on both sides', () => {
    const ev = evidenceOf(
      entry({ goods: [{ groupId: 'G1', quantity: 4 }, { groupId: 'G2', quantity: 7 }, { groupId: 'G1', quantity: 2 }, { groupId: 'G3', quantity: 2 }] }),
      doc({ lines: [{ productId: 'p1', quantity: 4 }, { productId: 'p2', quantity: 7 }, { productId: 'p3', quantity: 2 }, { productId: 'p4', quantity: 2 }] }),
    )
    expect(ev.outcome).toBe('line_for_line')
    expect(ev.votes).toEqual([{ productId: 'p1', groupId: 'G1' }, { productId: 'p2', groupId: 'G2' }])
    expect(ev.lines).toMatchObject({ goods: 4, byQuantity: 2, notMatched: 2 })
  })

  it('booked per group, a quantity that is a sum of lines never maps a line of another group', () => {
    // G1 holds two lines (2 + 3 = 5); the 5 of p3 is G2's. One operation a group is not line for line.
    const ev = evidenceOf(
      entry({ goods: [{ groupId: 'G1', quantity: 5 }, { groupId: 'G2', quantity: 6 }] }),
      doc({ lines: [{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 3 }, { productId: 'p3', quantity: 5 }, { productId: 'p4', quantity: 1 }] }),
    )
    expect(ev).toMatchObject({ outcome: 'not_line_for_line', votes: [] })
  })

  it('leaves services out on LGR\'s side, reads a correction\'s negative quantity as its size, and refuses an operation on two groups', () => {
    const credit = evidenceOf(
      entry({ registerDocType: '3', goods: [{ groupId: 'G1', quantity: -2 }, { groupId: 'G2', quantity: -1 }] }),
      doc({ type: 'credit_note', lines: [{ productId: 'p1', quantity: 2 }, { productId: 's1', quantity: 1, service: true }, { productId: 'p2', quantity: 1 }] }),
    )
    expect(credit.votes).toEqual([{ productId: 'p1', groupId: 'G1' }, { productId: 'p2', groupId: 'G2' }])
    expect(credit.lines.goods).toBe(2)
    expect(evidenceOf(entry({ mixed: true, goods: [{ groupId: 'G1', quantity: 1 }] }), doc({ lines: [{ productId: 'p1', quantity: 1 }] })).outcome).toBe('two_groups_in_one_operation')
    expect(evidenceOf(entry(), doc({ lines: [{ productId: 'p1', quantity: 1 }] })).outcome).toBe('no_goods_in_books')
    expect(evidenceOf(entry({ goods: [{ groupId: 'G1', quantity: 1 }] }), doc({ lines: [{ productId: 's1', quantity: 1, service: true }] })).outcome).toBe('no_goods_in_lgr')
  })

  it('a document with two entries teaches what both say, once', () => {
    const goods = [{ groupId: 'G1', quantity: 3 }]
    const ev = evidenceOfDocument({ doc: doc({ lines: [{ productId: 'p1', quantity: 3 }] }), entries: [entry({ goods }), entry({ docType: '-ФЕА', goods: [{ groupId: 'G1', quantity: -3 }] })] })
    expect(ev.votes).toEqual([{ productId: 'p1', groupId: 'G1' }])
  })
})

describe('exact names', () => {
  it('compares a name trimmed, its spaces collapsed, in lower case, a Latin look-alike read as Cyrillic; a dot or a dash still counts', () => {
    expect(groupNameKey('  Тест   Група  ')).toBe('тест група')
    // A Latin K, A and O in a Cyrillic word.
    expect(groupNameKey('TECT KAPO')).toBe(groupNameKey('ТЕСТ КАРО'))
    expect(groupNameKey('ТЕСТ ГРУПА.')).not.toBe(groupNameKey('ТЕСТ ГРУПА'))
    expect(groupNameKey('ТЕСТ-ГРУПА')).not.toBe(groupNameKey('ТЕСТ ГРУПА'))
  })

  it('maps a product to the one active group of its name; two groups of the name, or an inactive one, map nothing', () => {
    const { byProduct, ambiguous } = exactGroupsOf(
      [{ id: 'p1', name: 'тест група 1' }, { id: 'p2', name: 'ТЕСТ ДВОЙНА' }, { id: 'p3', name: 'ТЕСТ СТАРА' }, { id: 'p4', name: 'ТЕСТОВ АРТИКУЛ' }],
      [
        { id: 'G1', name: 'ТЕСТ ГРУПА 1', active: true },
        { id: 'G2', name: 'ТЕСТ ДВОЙНА', active: true },
        { id: 'G3', name: 'Тест  двойна', active: true },
        { id: 'G4', name: 'ТЕСТ СТАРА', active: false },
      ],
    )
    expect([...byProduct]).toEqual([['p1', 'G1']])
    expect(ambiguous).toBe(1)
  })
})

describe('the plan', () => {
  const ACTIVE = new Set(['G1', 'G2', 'G3'])
  const ev = (rows: Record<string, Record<string, [number, string]>>): Evidence =>
    new Map(Object.entries(rows).map(([p, gs]) => [p, new Map(Object.entries(gs).map(([g, [docs, last]]) => [g, { docs, last: day(last) }]))]))
  const plan = (over: Partial<Parameters<typeof planProductGroups>[0]> = {}) =>
    planProductGroups({ goodsProducts: ['p1', 'p2', 'p3', 'p4'], exact: new Map(), exactAmbiguous: 0, evidence: new Map(), activeGroups: ACTIVE, existing: [], ...over })

  it('learns a product all of whose documents name one group, with their count and the latest day; a conflict maps nothing', () => {
    const p = plan({ evidence: ev({ p1: { G1: [3, '2026-09-12'] }, p2: { G1: [4, '2026-09-01'], G2: [1, '2026-09-02'] }, p3: { G1: [2, '2026-09-01'], G2: [2, '2026-09-03'] } }) })
    expect(p.create).toEqual([{ productId: 'p1', analyticId: 'G1', source: 'learned', evidenceCount: 3, conflictCount: 0, lastEvidenceAt: day('2026-09-12') }])
    expect(p.products).toMatchObject({ goods: 4, learned: 1, conflicts: 2, conflictsOfOneDocument: 1, unmapped: 3 })
  })

  it('tallies a document once per product and group, however many lines say it', () => {
    const d1 = doc({ id: 'd1', day: day('2026-09-01') })
    const d2 = doc({ id: 'd2', day: day('2026-09-05') })
    const t = tallyEvidence([
      { doc: d1, votes: [{ productId: 'p1', groupId: 'G1' }, { productId: 'p1', groupId: 'G1' }] },
      { doc: d2, votes: [{ productId: 'p1', groupId: 'G1' }] },
    ])
    expect(t.get('p1')?.get('G1')).toEqual({ docs: 2, last: day('2026-09-05') })
  })

  it('goes by the exact name first, and counts the evidence for and against its group', () => {
    const p = plan({ exact: new Map([['p1', 'G1']]), evidence: ev({ p1: { G1: [2, '2026-09-04'], G2: [1, '2026-09-05'] } }) })
    expect(p.create).toEqual([{ productId: 'p1', analyticId: 'G1', source: 'exact', evidenceCount: 2, conflictCount: 1, lastEvidenceAt: day('2026-09-04') }])
    expect(p.products).toMatchObject({ exact: 1, conflicts: 0 })
  })

  it('never changes or removes the accountant\'s row, nor one the accountant has reviewed', () => {
    const accountant: MapRow = { id: 'r1', productId: 'p1', analyticId: 'G3', source: 'accountant', evidenceCount: 0, conflictCount: 0 }
    const reviewed: MapRow = { id: 'r2', productId: 'p2', analyticId: 'G3', source: 'learned', evidenceCount: 1, conflictCount: 0, reviewedAt: day('2026-09-20') }
    const p = plan({
      existing: [accountant, reviewed],
      exact: new Map([['p1', 'G1']]),
      evidence: ev({ p1: { G1: [5, '2026-09-04'] }, p2: { G1: [2, '2026-09-04'], G2: [2, '2026-09-04'] } }),
    })
    expect([p.create, p.update, p.remove]).toEqual([[], [], []])
    expect(p.after.get('p1')).toBe(accountant)
    expect(p.after.get('p2')).toBe(reviewed)
    expect(p.products.accountants).toBe(2)
  })

  it('keeps a learned row its period does not mention, removes one whose evidence now disagrees, and an exact one whose name changed', () => {
    const learned = (productId: string): MapRow => ({ id: `r-${productId}`, productId, analyticId: 'G1', source: 'learned', evidenceCount: 2, conflictCount: 0, lastEvidenceAt: day('2026-08-01') })
    const exactRow: MapRow = { id: 'r-p3', productId: 'p3', analyticId: 'G2', source: 'exact', evidenceCount: 0, conflictCount: 0 }
    const p = plan({ existing: [learned('p1'), learned('p2'), exactRow], evidence: ev({ p2: { G1: [1, '2026-09-01'], G2: [1, '2026-09-02'] } }) })
    expect(p.remove.map(r => r.id)).toEqual(['r-p2', 'r-p3'])
    expect(p.after.has('p1')).toBe(true)
    expect(p.unchanged).toBe(1)
  })

  it('replaces a suggestion by evidence and leaves it alone otherwise; an inactive group is not learned', () => {
    const rule: MapRow = { id: 'r1', productId: 'p1', analyticId: 'G3', source: 'rule', evidenceCount: 0, conflictCount: 0 }
    const ai: MapRow = { id: 'r2', productId: 'p2', analyticId: 'G3', source: 'ai', evidenceCount: 0, conflictCount: 0 }
    const p = plan({ existing: [rule, ai], evidence: ev({ p1: { G2: [2, '2026-09-04'] }, p2: { G1: [1, '2026-09-01'], G2: [1, '2026-09-01'] }, p3: { G9: [3, '2026-09-01'] } }) })
    expect(p.update).toEqual([{ from: rule, to: { id: 'r1', productId: 'p1', analyticId: 'G2', source: 'learned', evidenceCount: 2, conflictCount: 0, lastEvidenceAt: day('2026-09-04') } }])
    expect(p.remove).toEqual([])
    expect(p.after.get('p2')).toBe(ai)
    expect(p.products).toMatchObject({ inactiveGroup: 1, conflicts: 1 })
    // A suggestion posts nothing: p2 is still unmapped, as are p3 and p4.
    expect(p.products.unmapped).toBe(3)
  })

  it('run on its own result, plans nothing', () => {
    const input = {
      exact: new Map([['p4', 'G3']]),
      evidence: ev({ p1: { G1: [3, '2026-09-12'] }, p2: { G2: [1, '2026-09-01'] }, p4: { G3: [1, '2026-09-02'] } }),
    }
    const first = plan(input)
    expect(first.create).toHaveLength(3)
    const stored = first.create.map((r, i) => ({ ...r, id: `r${i}` }))
    const second = plan({ ...input, existing: stored })
    expect([second.create, second.update, second.remove]).toEqual([[], [], []])
    expect(second.unchanged).toBe(3)
    expect(rowsBySource(second.after)).toEqual({ bySource: { exact: 1, learned: 2, rule: 0, ai: 0, accountant: 0 }, reviewed: 0 })
  })
})

describe('coverage', () => {
  it('counts the lines and the value with a group a line posts by, per month and kind; a service is left out, a typed line is never covered', () => {
    const after = new Map<string, MapRow>([
      ['p1', { productId: 'p1', analyticId: 'G1', source: 'learned', evidenceCount: 1, conflictCount: 0 }],
      ['p2', { productId: 'p2', analyticId: 'G1', source: 'rule', evidenceCount: 0, conflictCount: 0 }],
      ['p3', { productId: 'p3', analyticId: 'G1', source: 'rule', evidenceCount: 0, conflictCount: 0, reviewedAt: day('2026-09-01') }],
    ])
    const t = newCoverage()
    const posts = postsBy(after)
    addCoverage(t, { kind: 'invoices', day: day('2026-09-30'), lines: [{ productId: 'p1', value: 30 }, { productId: 'p2', value: 10 }, { value: 10 }, { productId: 's1', service: true, value: 99 }] }, posts)
    addCoverage(t, { kind: 'invoices', day: day('2026-10-01'), lines: [{ productId: 'p3', value: -5 }] }, posts)
    addCoverage(t, { kind: 'till', day: day('2026-09-15'), lines: [{ productId: 'p1', value: 4 }] }, posts)
    expect(t.invoices.get('2026-09')).toEqual({ lines: 3, mappedLines: 1, noProduct: 1, value: 50, mappedValue: 30 })
    expect(t.invoices.get('2026-10')).toEqual({ lines: 1, mappedLines: 1, noProduct: 0, value: 5, mappedValue: 5 })
    expect(t.till.get('2026-09')).toEqual({ lines: 1, mappedLines: 1, noProduct: 0, value: 4, mappedValue: 4 })
  })
})
