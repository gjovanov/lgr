import { describe, it, expect } from 'bun:test'
import {
  ALLOWED_PAGE_SIZES,
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
