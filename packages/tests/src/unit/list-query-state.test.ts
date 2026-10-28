import { describe, it, expect } from 'bun:test'
import {
  ALLOWED_PAGE_SIZES,
  allOptionsParam,
  sanitizeSelection,
  serializeQueryValue as ser,
  parseQueryValue as par,
} from 'ui-shared/composables/useListQueryState'

// FR-05 (#12): the querystring wire contract every synced grid relies on. The Vue/router
// integration itself is covered by the e2e back-restore spec.
describe('list query state codecs (FR-05)', () => {
  it('csv round-trips arrays and drops empties', () => {
    expect(ser(['draft', 'sent'], 'csv')).toBe('draft,sent')
    expect(ser([], 'csv')).toBeUndefined()
    expect(par('draft, sent ,,paid', 'csv')).toEqual(['draft', 'sent', 'paid'])
  })

  it('int rejects junk and keeps -1 (the "All" page size)', () => {
    expect(ser(3, 'int')).toBe('3')
    expect(ser(-1, 'int')).toBe('-1')
    expect(par('42', 'int')).toBe(42)
    expect(par('abc', 'int')).toBeUndefined()
  })

  it('date accepts only YYYY-MM-DD', () => {
    expect(ser('2026-08-22', 'date')).toBe('2026-08-22')
    expect(ser('22.08.2026', 'date')).toBeUndefined()
    expect(par('2026-08-22', 'date')).toBe('2026-08-22')
    expect(par('<script>', 'date')).toBeUndefined()
  })

  it('bool serializes only true; parses true/1', () => {
    expect(ser(true, 'bool')).toBe('true')
    expect(ser(false, 'bool')).toBeUndefined()
    expect(par('true', 'bool')).toBe(true)
    expect(par('1', 'bool')).toBe(true)
    expect(par('no', 'bool')).toBe(false)
  })

  it('string omits empty values (clean URLs)', () => {
    expect(ser('', 'string')).toBeUndefined()
    expect(ser(null, 'string')).toBeUndefined()
    expect(ser('болт', 'string')).toBe('болт')
  })

  it('allowed page sizes match the ListScaffold items-per-page options (incl. All = -1)', () => {
    expect(ALLOWED_PAGE_SIZES).toEqual([10, 25, 50, 100, -1])
  })
})

// FR-22.15: a status or type filter whose default is every option. Its default is declared, so a
// bare URL stays bare, and what a URL brings is read in the list's terms.
describe('a filter whose default is every option (FR-22.15)', () => {
  const STATUSES = ['draft', 'sent', 'converted', 'voided']
  const LEGACY_ALL = ['draft', 'sent', 'accepted', 'converted', 'expired']

  it('declares every option as its default, so selecting all writes nothing to the URL', () => {
    // A plain holder stands in for the Vue ref: `vue` resolves from ui-shared, not from here.
    const def = allOptionsParam('status', { value: [...STATUSES] } as any, STATUSES, LEGACY_ALL)
    expect(def).toMatchObject({ key: 'status', codec: 'csv', default: STATUSES })
    expect(ser(def.ref.value, 'csv')).toBe(ser(def.default, 'csv'))
  })

  it('reads an old bookmark that listed every status the list then offered as "all"', () => {
    expect(sanitizeSelection(['draft', 'sent', 'accepted', 'converted', 'expired'], STATUSES, LEGACY_ALL)).toEqual(STATUSES)
    // in any order
    expect(sanitizeSelection(['expired', 'converted', 'accepted', 'sent', 'draft'], STATUSES, LEGACY_ALL)).toEqual(STATUSES)
  })

  it('drops statuses the list does not offer and keeps the rest in the options\' order', () => {
    expect(sanitizeSelection(['voided', 'accepted', 'draft'], STATUSES, LEGACY_ALL)).toEqual(['draft', 'voided'])
  })

  it('keeps the default when nothing the list offers is left', () => {
    expect(sanitizeSelection(['accepted'], STATUSES, LEGACY_ALL)).toBeUndefined()
    expect(sanitizeSelection([], STATUSES)).toBeUndefined()
  })

  it('a narrower selection is kept as it is', () => {
    expect(sanitizeSelection(['sent'], STATUSES, LEGACY_ALL)).toEqual(['sent'])
    expect(sanitizeSelection(['draft', 'sent', 'converted'], STATUSES, LEGACY_ALL)).toEqual(['draft', 'sent', 'converted'])
  })
})
