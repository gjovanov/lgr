import { describe, it, expect } from 'bun:test'
// PURE module: no Vue, no `window`, the storage is passed in. `ui-shared` resolves as a package.
import { panelStorageKey, readPanel, readPanels, writePanel, type PanelStore } from 'ui-shared/composables/panel-state'

/**
 * FR-28.43 — which collapsible panels of a screen the user left open or closed.
 *
 * A state that cannot be kept must never stop a panel from opening and closing: every access is
 * wrapped, because a private window, blocked site data or a full quota makes `localStorage` throw.
 */

function memoryStore(initial: Record<string, string> = {}): PanelStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k) => (data.has(k) ? (data.get(k) as string) : null),
    setItem: (k, v) => { data.set(k, v) },
  }
}

const throwingStore: PanelStore = {
  getItem() { throw new Error('SecurityError: storage is blocked') },
  setItem() { throw new Error('QuotaExceededError') },
}

describe('panel storage key', () => {
  it('is per user, organization and screen', () => {
    expect(panelStorageKey('u1', 'o1', 'orders.edit')).toBe('lgr:ui:panels:u1:o1:orders.edit')
    expect(panelStorageKey('u2', 'o1', 'orders.edit')).not.toBe(panelStorageKey('u1', 'o1', 'orders.edit'))
    expect(panelStorageKey('u1', 'o2', 'orders.edit')).not.toBe(panelStorageKey('u1', 'o1', 'orders.edit'))
    expect(panelStorageKey('u1', 'o1', 'internal-orders.edit')).not.toBe(panelStorageKey('u1', 'o1', 'orders.edit'))
  })
})

describe('reading', () => {
  const key = panelStorageKey('u1', 'o1', 'orders.edit')

  it('has nothing for a screen nobody touched, so a panel keeps its default', () => {
    const store = memoryStore()
    expect(readPanels(store, key)).toEqual({})
    expect(readPanel(store, key, 'reservations', true)).toBe(true)
    expect(readPanel(store, key, 'reservations', false)).toBe(false)
  })

  it('returns what was saved, closed or open, over the default', () => {
    const store = memoryStore({ [key]: JSON.stringify({ reservations: false, invoices: true }) })
    expect(readPanel(store, key, 'reservations', true)).toBe(false)
    expect(readPanel(store, key, 'invoices', false)).toBe(true)
    expect(readPanel(store, key, 'untouched', true)).toBe(true)
  })

  it('ignores anything that is not a boolean entry, and never throws on garbage', () => {
    expect(readPanels(memoryStore({ [key]: '{not json' }), key)).toEqual({})
    expect(readPanels(memoryStore({ [key]: '[true,false]' }), key)).toEqual({})
    expect(readPanels(memoryStore({ [key]: '"open"' }), key)).toEqual({})
    expect(readPanels(memoryStore({ [key]: 'null' }), key)).toEqual({})
    expect(readPanels(memoryStore({ [key]: JSON.stringify({ a: true, b: 'yes', c: 1, d: null, e: false }) }), key)).toEqual({ a: true, e: false })
  })

  it('does not let one screen read another screen', () => {
    const other = panelStorageKey('u1', 'o1', 'internal-orders.edit')
    const store = memoryStore({ [other]: JSON.stringify({ reservations: false }) })
    expect(readPanel(store, key, 'reservations', true)).toBe(true)
  })
})

describe('writing', () => {
  const key = panelStorageKey('u1', 'o1', 'orders.edit')

  it('keeps every panel of the screen: a second write does not overwrite the first', () => {
    const store = memoryStore()
    writePanel(store, key, 'reservations', false)
    writePanel(store, key, 'invoices', false)
    writePanel(store, key, 'reservations', true)
    expect(readPanels(store, key)).toEqual({ reservations: true, invoices: false })
  })

  it('repairs a screen whose saved value was garbage', () => {
    const store = memoryStore({ [key]: '{broken' })
    writePanel(store, key, 'reservations', false)
    expect(readPanels(store, key)).toEqual({ reservations: false })
  })
})

describe('storage that is not there or will not work', () => {
  const key = panelStorageKey('u1', 'o1', 'orders.edit')

  it('reads fall back to the default and writes are dropped, silently', () => {
    expect(readPanel(throwingStore, key, 'reservations', true)).toBe(true)
    expect(readPanel(null, key, 'reservations', false)).toBe(false)
    expect(readPanel(undefined, key, 'reservations', true)).toBe(true)
    // The point of the test: none of these may throw.
    writePanel(throwingStore, key, 'reservations', false)
    writePanel(null, key, 'reservations', false)
    writePanel(undefined, key, 'reservations', false)
  })
})
