import { describe, expect, it } from 'bun:test'
import {
  addSales, buildQueue, coverageOf, isConflict, isOneDocumentConflict, newSales, planAgainst, reviewEvidenceOf, stateOf, suggestionOf,
  REVIEW_MAX_PAGE_SIZE,
  type ReviewEvidence, type StoredRow,
} from 'services/biz/accounting-books/product-group-review'
import { tallyEvidence, type BooksSalesEntry, type Evidence, type GroupVote, type LgrSalesDocument, type MapRow, type PairedDocument } from 'services/biz/accounting-books/product-groups'

/**
 * FR-25 R3, slice 2: the review queue's rules, without a database (`product-group-review.ts`). Made-up series,
 * numbers, groups, products and amounts only.
 */

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`)
const entry = (number: string, goods: [string, number][]): BooksSalesEntry => ({
  docType: '-ФЕ', docNumber: number, registerDocType: '1', goods: goods.map(([groupId, quantity]) => ({ groupId, quantity })),
})
const document = (id: string, number: string, iso: string, lines: [string | undefined, number][]): LgrSalesDocument => ({
  id, type: 'invoice', number: `INV-${number}`, day: day(iso), imported: true, inPeriod: true,
  lines: lines.map(([productId, quantity]) => ({ ...(productId ? { productId } : {}), quantity })),
})
const paired = (id: string, number: string, iso: string, lines: [string | undefined, number][], ...entries: [string, number][][]): PairedDocument => ({
  doc: document(id, number, iso, lines), entries: entries.map(goods => entry(number, goods)),
})

const row = (productId: string, analyticId: string, source: MapRow['source'], over: Partial<StoredRow> = {}): StoredRow => ({
  id: `row-${productId}`, productId, analyticId, source, evidenceCount: 0, conflictCount: 0, updatedAt: day('2026-01-01'), ...over,
})

/** Evidence as a learning run makes it: slice 1's votes per document, and what partition taught besides. */
function learnedOf(items: PairedDocument[], slice1: Record<string, GroupVote[]>, taught: Record<string, GroupVote[]> = {}, contradictedBy: Record<string, string[]> = {}) {
  const evidence: Evidence = tallyEvidence(items.map(p => ({ doc: p.doc, votes: [...(slice1[p.doc.id] ?? []), ...(taught[p.doc.id] ?? [])] })))
  const contradicted = new Map<string, number>()
  for (const blamed of Object.values(contradictedBy)) for (const p of blamed) contradicted.set(p, (contradicted.get(p) ?? 0) + 1)
  return { evidence, contradicted, taughtBy: new Map(Object.entries(taught)), contradictedBy: new Map(Object.entries(contradictedBy)) }
}

/**
 * Four documents: p1 on one group twice (one_group, line_for_line), p2 and p3 line for line, p4 in two groups (a
 * conflict of one document against one), p5 taught by partition, p6 contradicted, p7 on no document of the books.
 */
function fixture(): { items: PairedDocument[]; ev: ReviewEvidence } {
  const items = [
    paired('d1', '9000200001', '2025-03-03', [['p1', 10], ['p2', 4]], [['g1', 10], ['g1', 4]]),
    paired('d2', '9000200002', '2025-03-04', [['p1', 3], ['p4', 5]], [['g1', 3], ['g2', 5]]),
    paired('d3', '9000200003', '2025-03-05', [['p4', 2], ['p3', 1], ['p5', 7]], [['g1', 2], ['g3', 1], ['g2', 7]]),
    paired('d4', '9000200004', '2025-03-06', [['p6', 1], ['p5', 2], [undefined, 1]], [['g2', 3]]),
  ]
  const slice1 = {
    d1: [{ productId: 'p1', groupId: 'g1' }, { productId: 'p2', groupId: 'g1' }],
    d2: [{ productId: 'p1', groupId: 'g1' }, { productId: 'p4', groupId: 'g2' }],
    d3: [{ productId: 'p4', groupId: 'g1' }, { productId: 'p3', groupId: 'g3' }, { productId: 'p5', groupId: 'g2' }],
  }
  const learned = learnedOf(items, slice1, { d4: [{ productId: 'p5', groupId: 'g2' }] }, { d4: ['p6'] })
  const ev = reviewEvidenceOf({
    paired: items, learned, goodsProducts: ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'],
    exact: new Map([['p3', 'g3']]), exactAmbiguous: 0, activeGroups: new Set(['g1', 'g2', 'g3']),
  })
  return { items, ev }
}

describe('the documents behind the evidence', () => {
  it('labels each document with the rule that named the group, partition and contradictions included, newest first', () => {
    const { ev } = fixture()
    const docs = (p: string) => (ev.refs.get(p) ?? []).map(r => [ev.docs[r.doc].number, r.groupId ?? null, r.rule])
    expect(docs('p1')).toEqual([['INV-9000200002', 'g1', 'line_for_line'], ['INV-9000200001', 'g1', 'one_group']])
    expect(docs('p4')).toEqual([['INV-9000200003', 'g1', 'line_for_line'], ['INV-9000200002', 'g2', 'line_for_line']])
    // Slice 1 named it on one document and partition on another: each with its own rule.
    expect(docs('p5')).toEqual([['INV-9000200004', 'g2', 'partition'], ['INV-9000200003', 'g2', 'line_for_line']])
    expect(docs('p6')).toEqual([['INV-9000200004', null, 'contradicts']])
    expect(ev.refs.has('p7')).toBe(false)
  })

  it('counts every document once per product and group, as the evidence counts them', () => {
    const { ev } = fixture()
    for (const [productId, groups] of ev.evidence) {
      for (const [groupId, s] of groups) expect((ev.refs.get(productId) ?? []).filter(r => r.groupId === groupId)).toHaveLength(s.docs)
    }
    // A vote partition repeats on a document slice 1 already named it on is the same document.
    const items = [paired('d1', '9000200001', '2025-03-03', [['p1', 2]], [['g1', 2]])]
    const learned = learnedOf(items, { d1: [{ productId: 'p1', groupId: 'g1' }] }, { d1: [{ productId: 'p1', groupId: 'g1' }] })
    const once = reviewEvidenceOf({ paired: items, learned, goodsProducts: ['p1'], exact: new Map(), exactAmbiguous: 0, activeGroups: new Set(['g1']) })
    expect(once.refs.get('p1')).toEqual([{ doc: 0, groupId: 'g1', rule: 'one_group' }])
  })

  it('keeps only the documents that name something', () => {
    const items = [
      paired('d1', '9000200001', '2025-03-03', [['p1', 2]], [['g1', 2]]),
      // Line for line with no quantity unique on both sides: it names nothing.
      paired('d2', '9000200002', '2025-03-04', [['p1', 1], ['p2', 1]], [['g1', 1], ['g2', 1]]),
    ]
    const ev = reviewEvidenceOf({
      paired: items, learned: learnedOf(items, { d1: [{ productId: 'p1', groupId: 'g1' }] }), goodsProducts: ['p1', 'p2'],
      exact: new Map(), exactAmbiguous: 0, activeGroups: new Set(['g1', 'g2']),
    })
    expect(ev.docs.map(d => d.id)).toEqual(['d1'])
  })
})

describe('a product\'s state', () => {
  const { ev } = fixture()

  it('a conflict: two groups, a group by name another document disputes, or a document against the group a run gave', () => {
    expect(isConflict(ev, 'p4')).toBe(true)
    expect(isConflict(ev, 'p6')).toBe(true)
    expect(isConflict(ev, 'p1')).toBe(false)
    expect(isConflict(ev, 'p7')).toBe(false)
    const disputed: ReviewEvidence = { ...ev, exact: new Map([['p1', 'g2']]) }
    expect(isConflict(disputed, 'p1')).toBe(true)
    // Its own group by name, and no other: no conflict.
    expect(isConflict(ev, 'p3')).toBe(false)
    expect(isOneDocumentConflict(ev, 'p4')).toBe(true)
  })

  it('the accountant\'s rows first, then a conflict, then a row a line posts by; anything else is unmapped', () => {
    expect(stateOf(ev, 'p4', row('p4', 'g1', 'accountant', { reviewedAt: day('2026-01-02') }))).toBe('accountant')
    expect(stateOf(ev, 'p4', row('p4', 'g1', 'learned', { reviewedAt: day('2026-01-02') }))).toBe('reviewed')
    expect(stateOf(ev, 'p4', row('p4', 'g2', 'learned'))).toBe('conflict')
    expect(stateOf(ev, 'p1', row('p1', 'g1', 'learned'))).toBe('learned')
    expect(stateOf(ev, 'p3', row('p3', 'g3', 'exact'))).toBe('exact')
    expect(stateOf(ev, 'p1', undefined)).toBe('unmapped')
    // A reserved source posts nothing until reviewed.
    expect(stateOf(ev, 'p1', row('p1', 'g1', 'rule'))).toBe('unmapped')
    expect(stateOf(ev, 'p7', undefined)).toBe('unmapped')
  })

  it('a row on a group switched off since is the work again, the accountant\'s and a confirmed one too', () => {
    const off: ReviewEvidence = { ...ev, activeGroups: new Set(['g2', 'g3']) }
    const decided = { reviewedAt: day('2026-01-02') }
    expect(stateOf(off, 'p1', row('p1', 'g1', 'accountant', decided))).toBe('unmapped')
    expect(stateOf(off, 'p1', row('p1', 'g1', 'learned', decided))).toBe('unmapped')
    expect(stateOf(off, 'p1', row('p1', 'g1', 'learned'))).toBe('unmapped')
    // Its documents still disagree: a conflict, as for a product with no row.
    expect(stateOf(off, 'p4', row('p4', 'g1', 'accountant', decided))).toBe('conflict')
    // The accountant's row on a group still active stays done.
    expect(stateOf(off, 'p1', row('p1', 'g2', 'accountant', decided))).toBe('accountant')
  })

  it('suggests the group a run would give, never an inactive one, nor the one already stored, nor over a decision', () => {
    const stored: StoredRow[] = []
    const plan = planAgainst(ev, stored)
    expect(suggestionOf(plan, ev, 'p1', undefined, 'unmapped')).toEqual({ analyticId: 'g1', source: 'learned' })
    expect(suggestionOf(plan, ev, 'p3', undefined, 'unmapped')).toEqual({ analyticId: 'g3', source: 'exact' })
    expect(suggestionOf(plan, ev, 'p4', undefined, 'conflict')).toBeUndefined()
    expect(suggestionOf(plan, ev, 'p7', undefined, 'unmapped')).toBeUndefined()
    const learnedRow = row('p1', 'g1', 'learned')
    expect(suggestionOf(planAgainst(ev, [learnedRow]), ev, 'p1', learnedRow, 'learned')).toBeUndefined()
    // A reserved source's row is replaced by evidence: the suggestion is the learned group.
    const ruleRow = row('p1', 'g1', 'rule')
    expect(suggestionOf(planAgainst(ev, [ruleRow]), ev, 'p1', ruleRow, 'unmapped')).toEqual({ analyticId: 'g1', source: 'learned' })
    const mine = row('p1', 'g2', 'accountant', { reviewedAt: day('2026-01-02') })
    expect(suggestionOf(planAgainst(ev, [mine]), ev, 'p1', mine, 'accountant')).toBeUndefined()
    const inactive: ReviewEvidence = { ...ev, activeGroups: new Set(['g2', 'g3']) }
    expect(suggestionOf(planAgainst(inactive, stored), inactive, 'p1', undefined, 'unmapped')).toBeUndefined()
  })
})

describe('the period\'s sales and what posts', () => {
  it('per product, NET with the sign dropped; a service left out; a line with no product counted in the totals only', () => {
    const sales = newSales()
    addSales(sales, { kind: 'invoices', day: day('2025-03-03'), lines: [{ productId: 'p1', value: 10 }, { productId: 'p9', service: true, value: 5 }, { value: 2 }] })
    addSales(sales, { kind: 'invoices', day: day('2025-03-04'), lines: [{ productId: 'p1', value: -1 }, { productId: 'p2', value: 4 }] })
    addSales(sales, { kind: 'till', day: day('2025-03-05'), lines: [{ productId: 'p2', value: 3 }] })
    expect([...sales.products.values()].map(p => [p.productId, p.lines, p.value, p.byKind.invoices.value, p.byKind.till.value])).toEqual([
      ['p1', 2, 11, 11, 0],
      ['p2', 2, 7, 4, 3],
    ])
    expect(sales.totals.invoices).toEqual({ lines: 4, value: 17, noProduct: { lines: 1, value: 2 } })
    const cov = coverageOf(sales, p => p === 'p1', p => p === 'p1' || p === 'p2')
    expect(cov.invoices).toEqual({ lines: 4, value: 17, noProductLines: 1, noProductValue: 2, postingLines: 2, postingValue: 11, afterLearningLines: 3, afterLearningValue: 15 })
    expect(cov.till).toEqual({ lines: 1, value: 3, noProductLines: 0, noProductValue: 0, postingLines: 0, postingValue: 0, afterLearningLines: 1, afterLearningValue: 3 })
    expect(cov.all).toMatchObject({ lines: 5, value: 20, postingValue: 11, afterLearningValue: 18 })
  })
})

describe('the queue', () => {
  const { ev } = fixture()
  const sales = newSales()
  const sold: [string, number][] = [['p1', 30], ['p2', 5], ['p3', 1], ['p4', 20], ['p6', 5], ['p7', 2]]
  for (const [productId, value] of sold) addSales(sales, { kind: 'invoices', day: day('2025-03-03'), lines: [{ productId, value }] })
  const names = new Map([
    ['p1', { name: 'АРТИКУЛ ЕДНО', sku: 'T-001' }], ['p2', { name: 'Артикул две', sku: 'T-002' }], ['p3', { name: 'АРТИКУЛ ТРИ' }],
    ['p4', { name: 'АРТИКУЛ ЧЕТИРИ' }], ['p6', { name: 'АРТИКУЛ ШЕСТ' }], ['p7', { name: 'АРТИКУЛ СЕДЕМ' }],
  ])
  const stored = [row('p2', 'g2', 'accountant', { reviewedAt: day('2026-01-02'), reviewedBy: 'u1' }), row('p3', 'g3', 'exact')]

  it('by sales value, the most first, ties by name; every product the period sold, each with its state', () => {
    const q = buildQueue({ sales, names, evidence: ev, stored })
    expect(q.rows.map(r => [r.productId, r.state, r.value])).toEqual([
      ['p1', 'unmapped', 30], ['p4', 'conflict', 20], ['p2', 'accountant', 5], ['p6', 'conflict', 5], ['p7', 'unmapped', 2], ['p3', 'exact', 1],
    ])
    expect(q.summary.byState).toEqual({ conflict: 2, unmapped: 2, learned: 0, exact: 1, accountant: 1, reviewed: 0 })
    expect(q.summary).toMatchObject({ products: 6, oneDocumentConflicts: 1, suggested: 1 })
    expect(q.summary.coverage.all).toMatchObject({ lines: 6, value: 63, postingLines: 2, postingValue: 6, afterLearningLines: 3, afterLearningValue: 36 })
    expect(q).toMatchObject({ total: 6, page: 0, pageSize: 25, totalPages: 1 })
  })

  it('the accountant\'s row on a group switched off is listed with the work, its row shown, and its sales count as no group', () => {
    const off: ReviewEvidence = { ...ev, activeGroups: new Set(['g1', 'g3']) }
    const q = buildQueue({ sales, names, evidence: off, stored, query: { states: ['conflict', 'unmapped'] } })
    const p2 = q.rows.find(r => r.productId === 'p2')!
    expect(p2.state).toBe('unmapped')
    expect(p2.stored).toMatchObject({ analyticId: 'g2', source: 'accountant', reviewedBy: 'u1' })
    expect(p2.suggestion).toBeUndefined()
    expect(q.summary.byState).toMatchObject({ unmapped: 3, accountant: 0 })
    // p2's 5 no longer posts, by the map as stored or after learning; p3's 1 still does.
    expect(q.summary.coverage.all).toMatchObject({ postingLines: 1, postingValue: 1 })
  })

  it('a row carries its stored row, its suggestion, and per group its documents', () => {
    const q = buildQueue({ sales, names, evidence: ev, stored })
    const p1 = q.rows.find(r => r.productId === 'p1')!
    expect(p1.suggestion).toEqual({ analyticId: 'g1', source: 'learned' })
    expect(p1.groups.map(g => [g.analyticId, g.docs, g.documents.map(d => d.number)])).toEqual([['g1', 2, ['INV-9000200002', 'INV-9000200001']]])
    const p4 = q.rows.find(r => r.productId === 'p4')!
    expect(p4.oneDocument).toBe(true)
    expect(p4.groups.map(g => [g.analyticId, g.docs, g.documents.map(d => [d.number, d.rule])])).toEqual([
      ['g1', 1, [['INV-9000200003', 'line_for_line']]],
      ['g2', 1, [['INV-9000200002', 'line_for_line']]],
    ])
    const p6 = q.rows.find(r => r.productId === 'p6')!
    expect(p6.contradicting).toEqual({ docs: 1, documents: [expect.objectContaining({ number: 'INV-9000200004', rule: 'contradicts' })] })
    const p2 = q.rows.find(r => r.productId === 'p2')!
    expect(p2.stored).toMatchObject({ analyticId: 'g2', source: 'accountant', reviewedBy: 'u1', updatedAt: day('2026-01-01') })
    expect(p2.suggestion).toBeUndefined()
  })

  it('filters by state and by name or SKU in any case, the summary always over the whole period', () => {
    const conflicts = buildQueue({ sales, names, evidence: ev, stored, query: { states: ['conflict'] } })
    expect(conflicts.rows.map(r => r.productId)).toEqual(['p4', 'p6'])
    expect(conflicts.total).toBe(2)
    expect(conflicts.summary.products).toBe(6)
    expect(buildQueue({ sales, names, evidence: ev, stored, query: { states: ['unmapped', 'exact'] } }).rows.map(r => r.productId)).toEqual(['p1', 'p7', 'p3'])
    expect(buildQueue({ sales, names, evidence: ev, stored, query: { search: 'артикул дв' } }).rows.map(r => r.productId)).toEqual(['p2'])
    expect(buildQueue({ sales, names, evidence: ev, stored, query: { search: 't-00' } }).rows.map(r => r.productId)).toEqual(['p1', 'p2'])
  })

  it('sorts by lines or name either way, and pages from 0, a page past the end the last one, "All" the largest page', () => {
    const byName = buildQueue({ sales, names, evidence: ev, stored, query: { sortBy: 'name', sortOrder: 'asc' } })
    expect(byName.rows.map(r => r.productId)).toEqual(['p2', 'p1', 'p7', 'p3', 'p4', 'p6'])
    const paged = buildQueue({ sales, names, evidence: ev, stored, query: { size: 4, page: 1 } })
    expect(paged.rows.map(r => r.productId)).toEqual(['p7', 'p3'])
    expect(paged).toMatchObject({ total: 6, page: 1, pageSize: 4, totalPages: 2 })
    expect(buildQueue({ sales, names, evidence: ev, stored, query: { size: 4, page: 9 } }).page).toBe(1)
    expect(buildQueue({ sales, names, evidence: ev, stored, query: { size: 0 } }).pageSize).toBe(REVIEW_MAX_PAGE_SIZE)
    expect(buildQueue({ sales, names, evidence: ev, stored, query: { size: 10_000 } }).pageSize).toBe(REVIEW_MAX_PAGE_SIZE)
    const empty = buildQueue({ sales, names, evidence: ev, stored, query: { states: ['reviewed'] } })
    expect(empty).toMatchObject({ rows: [], total: 0, page: 0, totalPages: 0 })
  })
})
