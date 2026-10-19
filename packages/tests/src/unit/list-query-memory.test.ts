import { describe, it, expect } from 'bun:test'
import {
  LIST_QUERY_MEMORY_PREFIX,
  listMemoryKey,
  mergeOwnedIntoStored,
  normalizeQuery,
  recallListQuery,
  rememberListQuery,
  shouldRecallListQuery,
  type QueryMemoryStore,
} from 'ui-shared/composables/list-query-memory'

function memoryStore(): QueryMemoryStore & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: k => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, v) },
    removeItem: k => { data.delete(k) },
  }
}

// An invoice list's filters must survive opening a document and coming back by the form's
// Back button / after Save / via the menu — all of which push the BARE list route.
describe('list query memory (filters survive a detail page)', () => {
  it('keys by org+user scope and list, and refuses to key without a scope', () => {
    expect(listMemoryKey('org1:u1', 'invoicing.sales:/invoices')).toBe(`${LIST_QUERY_MEMORY_PREFIX}org1:u1:invoicing.sales:/invoices`)
    expect(listMemoryKey('', 'invoicing.sales:/invoices')).toBeNull()
    expect(listMemoryKey('org1:u1', '')).toBeNull()
  })

  it('round-trips a query and keeps orgs apart', () => {
    const s = memoryStore()
    const a = listMemoryKey('orgA:u1', 'invoicing.sales:/invoices')
    const b = listMemoryKey('orgB:u1', 'invoicing.sales:/invoices')
    rememberListQuery(s, a, { status: 'paid,sent', from: '2026-10-01', page: '2' })
    expect(recallListQuery(s, a)).toEqual({ status: 'paid,sent', from: '2026-10-01', page: '2' })
    expect(recallListQuery(s, b)).toBeNull()
  })

  it('an empty remembered query recalls nothing (the user cleared the filters)', () => {
    const s = memoryStore()
    const k = listMemoryKey('o:u', 'x:/invoices')
    rememberListQuery(s, k, { status: 'paid' })
    rememberListQuery(s, k, {})
    expect(recallListQuery(s, k)).toBeNull()
  })

  it('survives junk in storage and a throwing store', () => {
    const s = memoryStore()
    const k = listMemoryKey('o:u', 'x:/invoices')!
    s.data.set(k, '{not json')
    expect(recallListQuery(s, k)).toBeNull()
    const throwing: QueryMemoryStore = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('quota') },
      removeItem: () => {},
    }
    expect(() => rememberListQuery(throwing, k, { q: 'x' })).not.toThrow()
    expect(recallListQuery(throwing, k)).toBeNull()
    expect(recallListQuery(null, k)).toBeNull()
  })

  it('normalizes vue-router query values', () => {
    expect(normalizeQuery({ a: 'x', b: ['y', 'z'], c: null, d: '', e: 3 as any })).toEqual({ a: 'x', b: 'y' })
    expect(normalizeQuery(null)).toEqual({})
  })

  it('recalls only a bare URL reached by an in-app navigation', () => {
    // Back button / Save redirect / menu: vue-router recorded where we came from.
    expect(shouldRecallListQuery({}, { back: '/invoices/abc/edit' })).toBe(true)
    // A link WITH params always wins over the memory (shareable URLs).
    expect(shouldRecallListQuery({ status: 'paid' }, { back: '/invoices/abc/edit' })).toBe(false)
    expect(shouldRecallListQuery({ restore: 'p1' }, { back: '/x' })).toBe(false)
    // Fresh load / typed or pasted bare URL / arrival from another app: defaults.
    expect(shouldRecallListQuery({}, { back: null })).toBe(false)
    expect(shouldRecallListQuery({}, null)).toBe(false)
    expect(shouldRecallListQuery(undefined, undefined)).toBe(false)
  })

  it('merges one instance\'s keys without dropping another instance\'s', () => {
    // Filters instance owns q/status; the pagination instance stored page/size.
    const stored = { q: 'old', status: 'paid', page: '3', size: '50' }
    expect(mergeOwnedIntoStored(stored, ['q', 'status'], { q: 'INV' })).toEqual({ q: 'INV', page: '3', size: '50' })
    expect(mergeOwnedIntoStored(null, ['q'], { q: 'x' })).toEqual({ q: 'x' })
  })
})
