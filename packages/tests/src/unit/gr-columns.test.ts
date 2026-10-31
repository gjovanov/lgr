import { describe, it, expect, beforeEach } from 'bun:test'
import { PRICE_TIER_NAMES } from 'config/constants'
import { GR_COLUMNS, useGRColumns } from 'ui-shared/composables/useGRColumns'

/**
 * The tier columns of the goods-receipt and supplier-bill forms ("with product update").
 *
 * They were ten positional columns headed „Цена 1..10" over the article's slots 0..9: on the
 * 13-slot layout (Доставна цена, Цена на едро, Цена 0, Цена 1, …) „Цена 1" showed and edited
 * Доставна цена. A column is now one tier, headed by its name and found by its name.
 */

class MemoryStorage {
  private readonly map = new Map<string, string>()
  get length() { return this.map.size }
  key(i: number) { return [...this.map.keys()][i] ?? null }
  getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null }
  setItem(key: string, value: string) { this.map.set(key, String(value)) }
  removeItem(key: string) { this.map.delete(key) }
  clear() { this.map.clear() }
}

const USER = { userId: () => 'user-1', orgId: () => 'org-1' }

beforeEach(() => {
  ;(globalThis as any).localStorage = new MemoryStorage()
})

describe('goods-receipt tier columns', () => {
  it('one per canonical tier, headed by the tier\'s own name and finding it by that name', () => {
    const tiers = GR_COLUMNS.filter(c => c.section === 'tier')
    expect(tiers.map(c => c.label)).toEqual([...PRICE_TIER_NAMES])
    expect(tiers.every(c => c.tierName === c.label && !c.i18n)).toBe(true)
    expect(tiers.find(c => c.label === 'Цена 1')?.key).toBe('tier_1')
    expect(tiers.find(c => c.label === 'Доставна цена')?.key).toBe('tier_delivery')
  })

  it('shows Цена 1..3 until the user picks others — the headings the forms always opened with', () => {
    const cols = useGRColumns(USER)
    expect(cols.activeColumns.value.filter(c => c.section === 'tier').map(c => c.label)).toEqual(['Цена 1', 'Цена 2', 'Цена 3'])
    expect(cols.selected.value).toContain('purchasePrice')
  })

  it('a column chosen before, by its heading, stays chosen: `price4` was „Цена 4"', () => {
    localStorage.setItem('lgr:gr-columns:user-1:org-1', JSON.stringify(['sellingPrice', 'price4', 'price10', 'price1']))
    const cols = useGRColumns(USER)
    expect(cols.selected.value).toEqual(['sellingPrice', 'tier_1', 'tier_4', 'tier_10'])
    expect(cols.activeColumns.value.map(c => c.label ?? c.key)).toEqual(['sellingPrice', 'Цена 1', 'Цена 4', 'Цена 10'])
  })
})
