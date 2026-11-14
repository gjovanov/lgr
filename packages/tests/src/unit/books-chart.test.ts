import { describe, it, expect } from 'bun:test'
import { ANALYTIC_KINDS as MODEL_KINDS } from 'db/models'
import { AS_BOOKED as SERVER_AS_BOOKED, depthOf } from 'services/biz/accounting-books/analytics-query'
import {
  ANALYTIC_KINDS,
  AS_BOOKED,
  analyticDepth,
  analyticErrorKey,
  analyticIndent,
  analyticsFilters,
  balanceSideColor,
  balanceSideKey,
  currentMonth,
  hasAnalyticsFilters,
  isBooksOrg,
  kindColor,
  kindLabelKey,
  linkPayload,
  paramErrors,
  paramsPayload,
  rootLabelKey,
} from '../../../accounting-ui/src/views/accounting/books-chart'

/** FR-25a §3.1–3.3: the accounting screens' rules about the books, without a browser. */

describe('what the UI copies from the server', () => {
  it('lists the analytic kinds the model does, in its order', () => {
    expect([...ANALYTIC_KINDS]).toEqual([...MODEL_KINDS])
  })

  it('refuses with the server\'s code, and reads depth as the server does', () => {
    expect(AS_BOOKED).toBe(SERVER_AS_BOOKED)
    for (const path of ['КЛИЕНТИ', 'КЛИЕНТИ:Клиент А', 'РАЗХОДИ:УСЛУГИ:Наем', '']) expect(analyticDepth(path)).toBe(depthOf(path))
  })
})

describe('the books org', () => {
  it('is the org whose books mode is `books`', () => {
    expect(isBooksOrg({ settings: { accounting: { books: { mode: 'books' } } } })).toBe(true)
    expect(isBooksOrg({ settings: { accounting: { books: { mode: 'branch' } } } })).toBe(false)
    expect(isBooksOrg({ settings: {} })).toBe(false)
    expect(isBooksOrg({})).toBe(false)
    expect(isBooksOrg(null)).toBe(false)
  })
})

describe('the tree grid', () => {
  it('indents a row by its depth', () => {
    expect(analyticIndent('КЛИЕНТИ')).toBe(0)
    expect(analyticIndent('КЛИЕНТИ:Клиент А')).toBe(16)
    expect(analyticIndent('РАЗХОДИ:УСЛУГИ:Наем', 20)).toBe(40)
    expect(analyticIndent(undefined)).toBe(0)
  })

  it('names a kind it knows, and any other as other', () => {
    expect(kindLabelKey('customer')).toBe('accounting.analytics.kinds.customer')
    expect(kindLabelKey('bank_account')).toBe('accounting.analytics.kinds.bank_account')
    expect(kindLabelKey('something')).toBe('accounting.analytics.kinds.other')
    expect(kindLabelKey(undefined)).toBe('accounting.analytics.kinds.other')
    expect(kindColor('customer')).toBe('primary')
    expect(kindColor('nope')).toBe('grey')
  })

  it('names a root by the registry\'s word, and leaves another as written', () => {
    const roots = [{ root: 'КЛИЕНТИ', labelKey: 'customers', count: 3 }, { root: 'САМОСТОЯТЕЛЕН', count: 1 }]
    expect(rootLabelKey('КЛИЕНТИ', roots)).toBe('reports.accountingBooks.roots.customers')
    expect(rootLabelKey('САМОСТОЯТЕЛЕН', roots)).toBeUndefined()
    expect(rootLabelKey('ДРУГО', roots)).toBeUndefined()
  })

  it('sends only the filters that are set, in the API\'s words', () => {
    expect(analyticsFilters({})).toEqual({})
    expect(analyticsFilters({ search: '  клиент ', root: 'КЛИЕНТИ', kind: 'customer', hasContact: 'yes', active: 'inactive' })).toEqual({
      search: 'клиент', root: 'КЛИЕНТИ', kind: 'customer', hasContact: 'true', isActive: 'false',
    })
    expect(analyticsFilters({ hasContact: 'no', active: 'active', search: '   ' })).toEqual({ hasContact: 'false', isActive: 'true' })
    expect(hasAnalyticsFilters({ search: ' ' })).toBe(false)
    expect(hasAnalyticsFilters({ root: 'ДА' })).toBe(true)
  })
})

describe('the properties editor', () => {
  it('flags a row with no name, and the second row of a name', () => {
    expect(paramErrors([{ key: 'A', value: '1' }, { key: ' ', value: '' }, { key: ' A ', value: '2' }, { key: 'B', value: '' }])).toEqual([
      null, 'keyRequired', 'keyDuplicate', null,
    ])
    expect(paramErrors([])).toEqual([])
  })

  it('sends the rows trimmed, in their order', () => {
    expect(paramsPayload([{ key: ' Б ', value: '2' }, { key: 'A', value: '' }])).toEqual([{ key: 'Б', value: '2' }, { key: 'A', value: '' }])
  })

  it('sends a cleared link as null', () => {
    expect(linkPayload('a'.repeat(24))).toBe('a'.repeat(24))
    expect(linkPayload('')).toBeNull()
    expect(linkPayload(null)).toBeNull()
    expect(linkPayload(undefined)).toBeNull()
  })
})

describe('the chart', () => {
  it('names a balance side, and none for an account the books never described', () => {
    expect(balanceSideKey('both')).toBe('accounting.accountBooks.balanceSides.both')
    expect(balanceSideKey(undefined)).toBeNull()
    expect(balanceSideKey('sideways')).toBeNull()
    expect(balanceSideColor('debit')).toBe('blue')
    expect(balanceSideColor(undefined)).toBe('grey')
  })
})

describe('the rest', () => {
  it('reads this month on the viewer\'s clock', () => {
    expect(currentMonth(new Date(2026, 0, 31, 23, 59))).toBe('2026-01')
    expect(currentMonth(new Date(2026, 10, 1))).toBe('2026-11')
  })

  it('has words for the API\'s refusals, and none for a code it does not know', () => {
    expect(analyticErrorKey('books_as_booked')).toBe('accounting.analytics.errors.books_as_booked')
    expect(analyticErrorKey('param_key_duplicate')).toBe('accounting.analytics.errors.param_key_duplicate')
    expect(analyticErrorKey('something_else')).toBeUndefined()
    expect(analyticErrorKey(undefined)).toBeUndefined()
  })
})
