import { describe, it, expect, beforeEach } from 'bun:test'
import { useGridColumns } from 'ui-shared/composables/useGridColumns'

/**
 * FR-22.23: a document list fits 1366 px, so a column that repeats what another shows — the
 * currency of an amount printed with its currency — starts hidden (`defaultHidden`) and is offered
 * on the grid's cog. The user's choice to show it must stick, a reset must bring the default back,
 * and the columns nobody marked keep behaving as before.
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

// A static catalog: `useGridColumns` reads `headers.value` (a ref in the app; the tests package has no `vue`).
const headers = { value: [
  { title: 'Number', key: 'number' },
  { title: 'Currency', key: 'currency', defaultHidden: true },
  { title: 'Tax', key: 'taxTotal' },
  { title: 'Total', key: 'total' },
  { title: '', key: 'actions' },
] as any[] } as any

const grid = () => useGridColumns({ headers, gridId: () => 'invoicing.sales' })
const keys = (g: ReturnType<typeof grid>) => g.effectiveHeaders.value.map((h: any) => h.key)

beforeEach(() => {
  ;(globalThis as any).localStorage = new MemoryStorage()
  ;(globalThis as any).sessionStorage = new MemoryStorage()
})

describe('useGridColumns — default-hidden columns (FR-22.23)', () => {
  it('starts without a default-hidden column, and the cog lists it as hidden', () => {
    const g = grid()
    expect(keys(g)).toEqual(['number', 'taxTotal', 'total', 'actions'])
    expect(g.entries.value.find((e) => e.key === 'currency')?.visible).toBe(false)
    expect(g.customized.value).toBe(false)
  })

  it('shown from the cog, it stays shown on the next load', () => {
    grid().toggle('currency')
    const next = grid()
    expect(keys(next)).toEqual(['number', 'currency', 'taxTotal', 'total', 'actions'])
    expect(next.entries.value.find((e) => e.key === 'currency')?.visible).toBe(true)
    expect(next.customized.value).toBe(true)
  })

  it('hidden again, it stays hidden; a reset brings the default back', () => {
    const g = grid()
    g.toggle('currency')
    g.toggle('currency')
    expect(keys(grid())).not.toContain('currency')

    g.toggle('currency')
    expect(keys(grid())).toContain('currency')
    g.reset()
    const next = grid()
    expect(keys(next)).not.toContain('currency')
    expect(next.customized.value).toBe(false)
  })

  it('a column nobody marked hides and shows as before, and actions never hide', () => {
    const g = grid()
    g.toggle('taxTotal')
    g.toggle('actions')
    expect(keys(grid())).toEqual(['number', 'total', 'actions'])
    grid().toggle('taxTotal')
    expect(keys(grid())).toEqual(['number', 'taxTotal', 'total', 'actions'])
  })

  it('reads a preference saved before `shown` existed', () => {
    localStorage.setItem('lgr:grid-cols:anon:no-org:invoicing.sales', JSON.stringify({ order: [], hidden: ['taxTotal'] }))
    const g = grid()
    expect(keys(g)).toEqual(['number', 'total', 'actions'])
    g.toggle('currency')
    expect(keys(grid())).toEqual(['number', 'currency', 'total', 'actions'])
  })
})
