import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PRODUCT_GROUP_SOURCES } from 'db/models'
import { REVIEW_STATES as SERVER_STATES } from 'services/biz/accounting-books/product-group-review'
import { parseReviewParams } from 'services/biz/accounting-books/product-group-review.service'
import {
  EVIDENCE_RULES,
  MAP_SOURCES,
  REVIEW_FILTERS,
  REVIEW_STATES,
  TO_REVIEW,
  actionsOf,
  documentPath,
  expectedOf,
  filterCount,
  filterLabelKey,
  groupLabel,
  isDecided,
  pickerOf,
  pickerStart,
  productPath,
  reviewFilters,
  ruleLabelKey,
  sourceLabelKey,
  stateColor,
  stateLabelKey,
  valueShare,
  valueShareAfterLearning,
  writeErrorKey,
  type GoodsGroup,
  type ReviewRow,
  type ReviewSummary,
  type StoredGroup,
} from '../../../accounting-ui/src/views/accounting/product-groups-page'

/** FR-25 R3, slice 2: the review queue page's rules, without a browser. Fictional data only. */

const stored = (over: Partial<StoredGroup> = {}): StoredGroup => ({
  analyticId: 'g1', source: 'learned', evidenceCount: 3, conflictCount: 0, updatedAt: '2026-01-05T10:00:00.000Z', ...over,
})
const row = (over: Partial<ReviewRow> = {}): ReviewRow => ({
  productId: 'p1', name: 'Тестов артикул', value: 10, lines: 2, state: 'unmapped', groups: [], contradicting: { docs: 0, documents: [] }, ...over,
})
const groups: GoodsGroup[] = [
  { id: 'g1', name: 'ГРУПА 1', path: 'СТОКИ:ГРУПА 1', active: true },
  { id: 'g2', name: 'ГРУПА 2', path: 'СТОКИ:ГРУПА 2', active: true },
  { id: 'g3', name: 'СТАРА', path: 'СТОКИ:СТАРА', active: false },
]

describe('what the page copies from the server', () => {
  it('lists the states and the sources the server does, in its order', () => {
    expect([...REVIEW_STATES]).toEqual([...SERVER_STATES])
    expect([...MAP_SOURCES]).toEqual([...PRODUCT_GROUP_SOURCES])
  })

  it('asks for what the server reads: the work by default, one state, or everything', () => {
    expect(parseReviewParams(reviewFilters({ filter: 'todo', search: '  болт ', from: '2026-01-01', to: '2026-01-31' }))).toEqual({
      from: '2026-01-01', to: '2026-01-31', query: { states: ['conflict', 'unmapped'], search: 'болт' },
    })
    expect(parseReviewParams(reviewFilters({ filter: 'reviewed' }))).toEqual({ query: { states: ['reviewed'] } })
    expect(parseReviewParams(reviewFilters({ filter: 'all', search: ' ', from: null, to: null }))).toEqual({ query: {} })
    for (const f of REVIEW_FILTERS) expect(() => parseReviewParams(reviewFilters({ filter: f }))).not.toThrow()
  })
})

describe('the filters', () => {
  it('are the work, each state, and everything', () => {
    expect([...REVIEW_FILTERS]).toEqual(['todo', ...REVIEW_STATES, 'all'])
    expect([...TO_REVIEW]).toEqual(['conflict', 'unmapped'])
  })

  it('count from the summary, whatever the page shows', () => {
    const summary = {
      products: 9,
      byState: { conflict: 2, unmapped: 3, learned: 1, exact: 1, accountant: 1, reviewed: 1 },
    } as ReviewSummary
    expect(filterCount('todo', summary)).toBe(5)
    expect(filterCount('all', summary)).toBe(9)
    expect(filterCount('learned', summary)).toBe(1)
    expect(filterCount('todo', null)).toBeUndefined()
  })
})

describe('a row', () => {
  it('offers the proposal on a product with no group, and nothing to confirm or withdraw', () => {
    expect(actionsOf(row({ suggestion: { analyticId: 'g1', source: 'learned' } }))).toEqual({ accept: true, confirm: false, withdraw: false })
    expect(actionsOf(row())).toEqual({ accept: false, confirm: false, withdraw: false })
  })

  it('confirms a group learning gave, by name or from the books, and offers a newer proposal beside it', () => {
    expect(actionsOf(row({ state: 'learned', stored: stored() }))).toEqual({ accept: false, confirm: true, withdraw: false })
    expect(actionsOf(row({ state: 'exact', stored: stored({ source: 'exact' }) }))).toEqual({ accept: false, confirm: true, withdraw: false })
    expect(actionsOf(row({ state: 'conflict', stored: stored(), suggestion: { analyticId: 'g2', source: 'learned' } })))
      .toEqual({ accept: true, confirm: true, withdraw: false })
  })

  it('never confirms a rule\'s or an AI\'s row: the accountant sets one', () => {
    expect(actionsOf(row({ stored: stored({ source: 'rule' }) })).confirm).toBe(false)
    expect(actionsOf(row({ stored: stored({ source: 'ai' }) })).confirm).toBe(false)
  })

  it('withdraws a decision, and offers nothing else on it', () => {
    const own = row({ state: 'accountant', stored: stored({ source: 'accountant', reviewedAt: '2026-01-06T00:00:00.000Z' }) })
    const confirmed = row({ state: 'reviewed', stored: stored({ reviewedAt: '2026-01-06T00:00:00.000Z' }), suggestion: { analyticId: 'g2', source: 'learned' } })
    expect([isDecided(own), isDecided(confirmed), isDecided(row({ stored: stored() }))]).toEqual([true, true, false])
    expect(actionsOf(own)).toEqual({ accept: false, confirm: false, withdraw: true })
    expect(actionsOf(confirmed)).toEqual({ accept: false, confirm: false, withdraw: true })
  })

  it('names the row as the page showed it: its updatedAt, or none', () => {
    expect(expectedOf(row({ stored: stored() }))).toBe('2026-01-05T10:00:00.000Z')
    expect(expectedOf(row())).toBeNull()
  })

  it('opens its product, and each document in the form of its kind', () => {
    expect(productPath('p1')).toBe('/inventory/products/p1/edit')
    expect(documentPath({ docId: 'd1', type: 'invoice' })).toBe('/invoicing/invoices/d1/edit')
    expect(documentPath({ docId: 'd2', type: 'credit_note' })).toBe('/invoicing/invoices/d2/edit')
    expect(documentPath({ docId: 'd3', type: 'cash_sale' })).toBe('/invoicing/cash-sales/d3/edit')
  })

  it('shows a group under the root every group shares', () => {
    expect(groupLabel('СТОКИ:ГРУПА 1')).toBe('ГРУПА 1')
    expect(groupLabel('СТОКИ:ГРУПА 1:ПОДГРУПА')).toBe('ГРУПА 1:ПОДГРУПА')
    expect(groupLabel('СТОКИ')).toBe('СТОКИ')
    expect(groupLabel(undefined)).toBe('')
  })

  it('colours the work, the automatic groups and the decisions apart', () => {
    expect(REVIEW_STATES.map(stateColor)).toEqual(['error', 'warning', 'info', 'info', 'success', 'success'])
  })
})

describe('the picker', () => {
  it('offers the active groups the documents name, most named first, and every active group', () => {
    const r = row({ groups: [
      { analyticId: 'g2', docs: 4, last: '2026-01-04T00:00:00.000Z', documents: [] },
      { analyticId: 'g3', docs: 2, last: '2026-01-03T00:00:00.000Z', documents: [] },
      { analyticId: 'g1', docs: 1, last: '2026-01-02T00:00:00.000Z', documents: [] },
    ] })
    const p = pickerOf(r, groups)
    expect(p.named.map(g => [g.id, g.docs])).toEqual([['g2', 4], ['g1', 1]])
    expect(p.all.map(g => g.id)).toEqual(['g1', 'g2'])
  })

  it('opens on the proposal, else on the group the documents name most that is not the row\'s own', () => {
    const named = [
      { analyticId: 'g1', docs: 4, last: '2026-01-04T00:00:00.000Z', documents: [] },
      { analyticId: 'g2', docs: 1, last: '2026-01-02T00:00:00.000Z', documents: [] },
    ]
    expect(pickerStart(row({ groups: named, suggestion: { analyticId: 'g2', source: 'learned' } }), groups)).toBe('g2')
    expect(pickerStart(row({ groups: named, stored: stored({ analyticId: 'g1' }) }), groups)).toBe('g2')
    expect(pickerStart(row({ groups: [{ analyticId: 'g3', docs: 2, last: '2026-01-02T00:00:00.000Z', documents: [] }] }), groups)).toBeNull()
    expect(pickerStart(row(), groups)).toBeNull()
  })
})

describe('the summary', () => {
  const share = { lines: 10, value: 200, noProductLines: 1, noProductValue: 10, postingLines: 6, postingValue: 120, afterLearningLines: 8, afterLearningValue: 150 }
  it('is the share of the sales value a group posts, now and once learning runs again', () => {
    expect(valueShare(share)).toBe(0.6)
    expect(valueShareAfterLearning(share)).toBe(0.75)
    expect(valueShare({ ...share, value: 0, postingValue: 0 })).toBeNull()
    expect(valueShare(undefined)).toBeNull()
  })
})

describe('the words', () => {
  const en = JSON.parse(readFileSync(join(import.meta.dir, '..', '..', '..', 'ui-shared', 'src', 'locales', 'en.json'), 'utf8'))
  const has = (key: string) => typeof key.split('.').reduce<any>((o, k) => o?.[k], en) === 'string'

  it('names every state, filter, rule and source', () => {
    const keys = [
      ...REVIEW_STATES.map(stateLabelKey), ...REVIEW_FILTERS.map(filterLabelKey), ...EVIDENCE_RULES.map(ruleLabelKey), ...MAP_SOURCES.map(sourceLabelKey),
    ]
    expect(keys.filter(k => !has(k))).toEqual([])
  })

  it('says a refused write in the page\'s words where it knows the refusal, and leaves the rest to the server', () => {
    for (const code of ['row_changed', 'already_reviewed', 'not_a_goods_group']) expect(has(writeErrorKey(code)!)).toBe(true)
    expect(writeErrorKey('service_product')).toBeNull()
    expect(writeErrorKey(undefined)).toBeNull()
  })
})
