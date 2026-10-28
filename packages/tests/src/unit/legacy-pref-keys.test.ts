import { describe, it, expect, beforeEach } from 'bun:test'
import { useInvoiceLineColumns } from 'ui-shared/composables/useInvoiceLineColumns'
import { useGRColumns } from 'ui-shared/composables/useGRColumns'

/**
 * Per-user UI preferences used to be keyed by `appStore.user`, which is null on a fresh page load,
 * so many were saved under `anon`. They are keyed by the session token's user now, and the
 * composables keep READING the `anon` entry when the user has none of their own.
 *
 * The trap that fallback sets: a reset that removes only the user's own key lets the stale `anon`
 * entry come straight back on the next load. "Reset Defaults" would not stick, and only for the
 * people who had saved something before.
 */

class MemoryStorage {
  private readonly map = new Map<string, string>()
  get length() {
    return this.map.size
  }
  key(i: number) {
    return [...this.map.keys()][i] ?? null
  }
  getItem(key: string) {
    return this.map.has(key) ? this.map.get(key)! : null
  }
  setItem(key: string, value: string) {
    this.map.set(key, String(value))
  }
  removeItem(key: string) {
    this.map.delete(key)
  }
  clear() {
    this.map.clear()
  }
}

const ORG = 'org-1'
const USER = { userId: () => 'user-1', orgId: () => ORG }

beforeEach(() => {
  ;(globalThis as any).localStorage = new MemoryStorage()
})

describe('invoice line columns and the legacy `anon` key', () => {
  const legacy = `lgr:invoice-line-cols:anon:${ORG}:invoice`

  it('honours columns saved under `anon` while the user has none of their own', () => {
    localStorage.setItem(legacy, JSON.stringify({ order: [], hidden: [] })) // everything visible
    const cols = useInvoiceLineColumns('invoice', USER)
    expect(cols.selected.value).toContain('taxRate') // off by default, on in the saved preference
  })

  it('a reset sticks: the next load shows the defaults, not the `anon` columns', () => {
    localStorage.setItem(legacy, JSON.stringify({ order: [], hidden: [] }))
    const cols = useInvoiceLineColumns('invoice', USER)
    cols.resetDefaults()
    expect(cols.selected.value).not.toContain('taxRate')

    const nextLoad = useInvoiceLineColumns('invoice', USER)
    expect(nextLoad.selected.value).not.toContain('taxRate')
    expect(nextLoad.selected.value).toContain('lineSubtotal')
  })

  it('a saved preference goes under the user, not `anon`', () => {
    const cols = useInvoiceLineColumns('invoice', USER)
    cols.toggle('taxRate')
    expect(localStorage.getItem(`lgr:invoice-line-cols:user-1:${ORG}:invoice`)).not.toBeNull()
    expect(localStorage.getItem(legacy)).toBeNull()
  })
})

describe('goods-receipt columns and the legacy `anon` key', () => {
  const legacy = `lgr:gr-columns:anon:${ORG}`

  it('a reset sticks: it saves the defaults under the user, which shadow `anon` from then on', async () => {
    localStorage.setItem(legacy, JSON.stringify(['type', 'categoryId', 'unit']))
    const cols = useGRColumns(USER)
    expect(cols.selected.value).toEqual(['type', 'categoryId', 'unit'])

    cols.resetDefaults()
    await new Promise(r => setTimeout(r, 0)) // the save runs in a watcher, after this tick
    const nextLoad = useGRColumns(USER)
    expect(nextLoad.selected.value).not.toContain('type')
    expect(nextLoad.selected.value).toContain('purchasePrice')
  })
})
