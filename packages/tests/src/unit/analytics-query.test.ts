import { describe, it, expect } from 'bun:test'
import {
  AS_BOOKED,
  accountBooksFilter,
  analyticsMatch,
  analyticsSort,
  depthOf,
  keepsBooks,
  MAX_PARAMS,
  monthRange,
  normaliseParams,
  parseAnalyticsQuery,
  treeKeyOf,
} from 'services/biz/accounting-books/analytics-query'

/** FR-25a §3.1–3.3: the analytics grid's query, as data. */

describe('the tree order', () => {
  it('puts a node right before what is under it, whatever its siblings are called', () => {
    // By the path, `УСЛУГИ АДМ` would come between `УСЛУГИ` and `УСЛУГИ:Наем`: a space sorts below `:`.
    const paths = ['РАЗХОДИ:УСЛУГИ АДМ', 'РАЗХОДИ:УСЛУГИ:Наем', 'РАЗХОДИ', 'РАЗХОДИ:УСЛУГИ', 'РАЗХОДИ:УСЛУГИ-2', 'РАЗХОДИ:УСЛУГИ1']
    expect([...paths].sort()).toEqual(['РАЗХОДИ', 'РАЗХОДИ:УСЛУГИ', 'РАЗХОДИ:УСЛУГИ АДМ', 'РАЗХОДИ:УСЛУГИ-2', 'РАЗХОДИ:УСЛУГИ1', 'РАЗХОДИ:УСЛУГИ:Наем'])
    const byTree = [...paths].sort((a, b) => (treeKeyOf(a) < treeKeyOf(b) ? -1 : treeKeyOf(a) > treeKeyOf(b) ? 1 : 0))
    expect(byTree).toEqual(['РАЗХОДИ', 'РАЗХОДИ:УСЛУГИ', 'РАЗХОДИ:УСЛУГИ:Наем', 'РАЗХОДИ:УСЛУГИ АДМ', 'РАЗХОДИ:УСЛУГИ-2', 'РАЗХОДИ:УСЛУГИ1'])
  })

  it('keeps each root together, a root that is a prefix of another included', () => {
    const paths = ['ДА 2:X', 'ДА:Машина', 'ДА 2', 'ДА']
    const byTree = [...paths].sort((a, b) => (treeKeyOf(a) < treeKeyOf(b) ? -1 : 1))
    expect(byTree).toEqual(['ДА', 'ДА:Машина', 'ДА 2', 'ДА 2:X'])
  })

  it('counts the depth from the root', () => {
    expect(depthOf('КЛИЕНТИ')).toBe(0)
    expect(depthOf('КЛИЕНТИ:Клиент А')).toBe(1)
    expect(depthOf('РАЗХОДИ:УСЛУГИ:Наем')).toBe(2)
  })
})

describe('the query string', () => {
  it('defaults to the first page of 25, in the tree order', () => {
    expect(parseAnalyticsQuery({})).toEqual({ page: 0, size: 25, sortBy: 'path', sortOrder: 1 })
  })

  it('keeps a known sort and the filters it was given, trimmed', () => {
    expect(parseAnalyticsQuery({
      page: '2', size: '50', sortBy: 'kind', sortOrder: 'desc', root: ' КЛИЕНТИ ', kind: 'customer', search: '  а ',
      hasContact: 'true', isActive: 'false', contactId: 'abc',
    })).toEqual({
      page: 2, size: 50, sortBy: 'kind', sortOrder: -1, root: 'КЛИЕНТИ', kind: 'customer', search: 'а', hasContact: true, isActive: false, contactId: 'abc',
    })
  })

  it('drops what it does not know, and never sorts by a field it was not given', () => {
    const q = parseAnalyticsQuery({ page: '-3', size: 'x', sortBy: 'params', hasContact: 'maybe', root: '   ' })
    // A size that is no number is the default page, never every row.
    expect(q).toEqual({ page: 0, size: 25, sortBy: 'path', sortOrder: 1 })
    expect(parseAnalyticsQuery({ size: '-1' }).size).toBe(25)
  })

  it('takes size 0 as every row', () => {
    expect(parseAnalyticsQuery({ size: '0' }).size).toBe(0)
  })
})

describe('the match', () => {
  const id = (s: string) => `id:${s}`

  it('has no filter for an empty query', () => {
    expect(analyticsMatch(parseAnalyticsQuery({}), id)).toEqual({})
  })

  it('reads a contact as linked when it is there and not null, and active unless switched off', () => {
    expect(analyticsMatch(parseAnalyticsQuery({ hasContact: 'true', isActive: 'true' }), id)).toEqual({
      contactId: { $exists: true, $ne: null },
      isActive: { $ne: false },
    })
    expect(analyticsMatch(parseAnalyticsQuery({ hasContact: 'false', isActive: 'false' }), id)).toEqual({
      contactId: { $in: [null] },
      isActive: false,
    })
  })

  it('matches nothing for an id that is no id', () => {
    const ok = 'a'.repeat(24)
    expect(analyticsMatch(parseAnalyticsQuery({ bankAccountId: ok, fixedAssetId: 'nope' }), id)).toEqual({
      bankAccountId: `id:${ok}`,
      fixedAssetId: { $in: [] },
    })
  })
})

describe('the sort', () => {
  it('ends every order in the tree, so a page is stable', () => {
    expect(analyticsSort(parseAnalyticsQuery({}))).toEqual({ treeKey: 1, _id: 1 })
    expect(analyticsSort(parseAnalyticsQuery({ sortBy: 'path', sortOrder: 'desc' }))).toEqual({ treeKey: -1, _id: 1 })
    expect(analyticsSort(parseAnalyticsQuery({ sortBy: 'root' }))).toEqual({ root: 1, treeKey: 1, _id: 1 })
    expect(analyticsSort(parseAnalyticsQuery({ sortBy: 'name', sortOrder: 'desc' }))).toEqual({ nameLower: -1, treeKey: 1, _id: 1 })
    expect(analyticsSort(parseAnalyticsQuery({ sortBy: 'isActive' }))).toEqual({ isActive: 1, treeKey: 1, _id: 1 })
  })
})

describe('the properties of an analytic of LGR\'s own', () => {
  it('trims each name, keeps the order and makes every value text', () => {
    expect(normaliseParams([{ key: ' Б ', value: '2' }, { key: 'A' }, { key: 'C', value: 3 as any }])).toEqual({
      params: [{ key: 'Б', value: '2' }, { key: 'A', value: '' }, { key: 'C', value: '3' }],
    })
  })

  it('refuses a property with no name, a name given twice, and too many', () => {
    expect(normaliseParams([{ key: '  ', value: '1' }])).toEqual({ refusal: 'param_key_required' })
    expect(normaliseParams([{ key: 'A' }, { key: ' A' }])).toEqual({ refusal: 'param_key_duplicate' })
    expect(normaliseParams(Array.from({ length: MAX_PARAMS + 1 }, (_, i) => ({ key: `k${i}` })))).toEqual({ refusal: 'too_many_params' })
  })

  it('keeps names that differ only in case apart: the file\'s spelling is the name', () => {
    expect(normaliseParams([{ key: 'Град' }, { key: 'ГРАД' }])).toEqual({ params: [{ key: 'Град', value: '' }, { key: 'ГРАД', value: '' }] })
  })
})

describe('the books org', () => {
  it('is an org whose books mode is `books`, and no other', () => {
    expect(keepsBooks({ settings: { accounting: { books: { mode: 'books' } } } })).toBe(true)
    expect(keepsBooks({ settings: { accounting: { books: { mode: 'branch' } } } })).toBe(false)
    expect(keepsBooks({ settings: { accounting: { books: { mode: 'own' } } } })).toBe(false)
    expect(keepsBooks({ settings: {} })).toBe(false)
    expect(keepsBooks(null)).toBe(false)
    expect(AS_BOOKED).toBe('books_as_booked')
  })
})

describe('the chart\'s filters (FR-25a §3.1)', () => {
  it('reads "has analytics" as a root listed, and "quantitative" as set', () => {
    expect(accountBooksFilter({})).toEqual({})
    expect(accountBooksFilter({ hasAnalytics: 'true', quantitative: 'true' })).toEqual({ 'analyticRoots.0': { $exists: true }, quantitative: true })
    expect(accountBooksFilter({ hasAnalytics: 'false', quantitative: 'false' })).toEqual({ 'analyticRoots.0': { $exists: false }, quantitative: { $ne: true } })
    expect(accountBooksFilter({ hasAnalytics: 'x' })).toEqual({})
  })
})

describe('a month', () => {
  it('is the half-open range of its days, at midnight UTC', () => {
    expect(monthRange('2026-03')).toEqual({ from: new Date('2026-03-01T00:00:00.000Z'), to: new Date('2026-04-01T00:00:00.000Z') })
    expect(monthRange('2026-12')).toEqual({ from: new Date('2026-12-01T00:00:00.000Z'), to: new Date('2027-01-01T00:00:00.000Z') })
    expect(monthRange('2026-13')).toBeNull()
    expect(monthRange('2026-00')).toBeNull()
    expect(monthRange('March')).toBeNull()
  })
})
