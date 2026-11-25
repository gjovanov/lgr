import { describe, expect, it } from 'bun:test'
import {
  booksPlaceOf, changeOf, createBody, formProblems, lastChangeOf, sortOverrides, updateBody, writeErrorKey, type CostOverride,
} from '../../../web/src/modules/accounting/views/accounting/group-costs-page'

/** FR-25 R3 (2026-11-25): the rules of the group costs page. Made-up ids, groups and amounts. */

const HOME = '0000000000000000000000a1'
const STORE = '0000000000000000000000b2'
const books = (split?: string) => ({ accounting: { books: { mode: 'books', ...(split ? { split: { homeOrgId: split } } : {}) } } })

const row = (over: Partial<CostOverride>): CostOverride => ({
  id: 'o1', analyticId: 'g1', path: 'СТОКИ:ТЕСТ ГРУПА 1', active: true, from: '2026-03-05', unitCost: 0.4, reason: 'Брак',
  createdAt: '2026-11-25T10:00:00.000Z', updatedAt: '2026-11-25T10:00:00.000Z', ...over,
})

describe('the group costs page', () => {
  it('is the home\'s: an org without books has none, and a store of a split is sent to its home', () => {
    expect(booksPlaceOf(null)).toBe('none')
    expect(booksPlaceOf({ id: HOME, settings: {} })).toBe('none')
    expect(booksPlaceOf({ id: HOME, settings: { accounting: { books: { mode: 'branch' } } } })).toBe('none')
    expect(booksPlaceOf({ id: HOME, settings: books() })).toBe('home')
    expect(booksPlaceOf({ id: HOME, settings: books(HOME) })).toBe('home')
    expect(booksPlaceOf({ id: STORE, settings: books(HOME) })).toBe('store')
  })

  it('keeps Save off until a group, a day of the euro, a unit cost and a reason are given', () => {
    const ok = { analyticId: 'g1', from: '2026-03-05', unitCost: 0, reason: ' Брак ' }
    expect(formProblems(ok)).toEqual([])
    expect(formProblems({ analyticId: null, from: null, unitCost: null, reason: '  ' })).toEqual([
      'accounting.groupCosts.needGroup', 'accounting.groupCosts.needDay', 'accounting.groupCosts.needUnitCost', 'accounting.groupCosts.needReason',
    ])
    expect(formProblems({ ...ok, from: '2025-12-31' })).toEqual(['accounting.groupCosts.badDay'])
    expect(formProblems({ ...ok, unitCost: -0.01 })).toEqual(['accounting.groupCosts.needUnitCost'])
    expect(formProblems({ ...ok, reason: 'x'.repeat(501) })).toEqual(['accounting.groupCosts.needReason'])
  })

  it('sends a new override whole, and a change as its unit and reason against the row the page showed', () => {
    const f = { analyticId: 'g1', from: '2026-03-05', unitCost: 0.4, reason: ' Брак ' }
    expect(createBody(f)).toEqual({ analyticId: 'g1', from: '2026-03-05', unitCost: 0.4, reason: 'Брак' })
    expect(updateBody(f, '2026-11-25T10:00:00.000Z')).toEqual({ unitCost: 0.4, reason: 'Брак', expected: '2026-11-25T10:00:00.000Z' })
  })

  it('says a refusal it knows in its own words', () => {
    expect(writeErrorKey('row_changed')).toBe('accounting.groupCosts.rowChanged')
    expect(writeErrorKey('override_exists')).toBe('accounting.groupCosts.exists')
    expect(writeErrorKey('not_books_home')).toBe('accounting.groupCosts.notHome')
    expect(writeErrorKey('bad_unit_cost')).toBeNull()
    expect(writeErrorKey(undefined)).toBeNull()
  })

  it('names who changed an override last, the latest day first, and the change against the replayed average', () => {
    expect(lastChangeOf(row({ createdBy: { id: 'u1', name: 'А' } }))).toEqual({ name: 'А', at: '2026-11-25T10:00:00.000Z' })
    expect(lastChangeOf(row({ createdBy: { id: 'u1', name: 'А' }, updatedBy: { id: 'u2', name: 'Б' }, updatedAt: '2026-11-26T08:00:00.000Z' })))
      .toEqual({ name: 'Б', at: '2026-11-26T08:00:00.000Z' })
    const sorted = sortOverrides([row({ id: 'a', from: '2026-03-05', path: 'СТОКИ:Б' }), row({ id: 'b', from: '2026-04-01' }), row({ id: 'c', from: '2026-03-05', path: 'СТОКИ:А' })])
    expect(sorted.map(o => o.id)).toEqual(['b', 'c', 'a'])
    expect(changeOf(0.4, 0.5)).toBeCloseTo(-0.2, 12)
    expect(changeOf(0.4, undefined)).toBeNull()
    expect(changeOf(0.4, 0)).toBeNull()
    expect(changeOf(null, 0.5)).toBeNull()
  })
})
