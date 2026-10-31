import { describe, it, expect, beforeEach } from 'bun:test'
import { PRICE_TIER_NAMES, MAX_PRICE_TIERS } from 'config/constants'
import { useGridColumns } from 'ui-shared/composables/useGridColumns'
// The Products list's price-tier columns (`inventory-ui` is a private app package).
import {
  DEFAULT_TIER_COLUMNS,
  TIER_COLUMNS,
  formatUnitPrice,
  tierPrice,
} from '../../../inventory-ui/src/composables/product-price-columns'
import { tierForSortKey } from 'services/biz/product-tier-sort'

/**
 * The Products list offers a column per price tier — Доставна цена, Цена на едро, Цена 0..Цена 10 —
 * and shows Доставна цена, Цена на едро and Цена 1, 2, 4, 5 until the user changes it on the cog.
 * Each column prints its tier's price, found by name, to four decimals.
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

// The list's catalog as `ProductsView` builds it, its other columns abridged. `useGridColumns`
// reads `headers.value` (a ref in the app; the tests package has no `vue`).
const headers = { value: [
  { title: 'SKU', key: 'sku' },
  { title: 'Name', key: 'name' },
  { title: 'Purchase price', key: 'purchasePrice' },
  { title: 'Selling price', key: 'sellingPrice' },
  ...TIER_COLUMNS.map((c) => ({ title: c.name, key: c.key, defaultHidden: c.defaultHidden })),
  { title: '', key: 'actions' },
] as any[] } as any

const grid = () => useGridColumns({ headers, gridId: () => 'inventory.products' })
const shown = (g: ReturnType<typeof grid>) => g.effectiveHeaders.value.map((h: any) => h.title)

beforeEach(() => {
  ;(globalThis as any).localStorage = new MemoryStorage()
  ;(globalThis as any).sessionStorage = new MemoryStorage()
})

describe('the Products list price-tier columns', () => {
  it('offers one column per canonical tier, in slot order', () => {
    expect(TIER_COLUMNS.map((c) => c.name)).toEqual([...PRICE_TIER_NAMES])
    expect(TIER_COLUMNS).toHaveLength(MAX_PRICE_TIERS)
    expect(new Set(TIER_COLUMNS.map((c) => c.key)).size).toBe(TIER_COLUMNS.length)
  })

  it('keys every column so its sort survives the URL, and the server reads the tier back', () => {
    // `usePaginatedTable` drops a sort key outside this pattern when it reads the URL back.
    for (const c of TIER_COLUMNS) expect(c.key).toMatch(/^[A-Za-z0-9_.]{1,60}$/)
    for (const c of TIER_COLUMNS) expect(tierForSortKey(c.key)).toBe(c.name)
    expect(tierForSortKey('tier_99')).toBeNull()
    expect(tierForSortKey('sellingPrice')).toBeNull()
    expect(tierForSortKey(undefined)).toBeNull()
  })

  it('shows Доставна цена, Цена на едро and Цена 1, 2, 4, 5; the rest wait on the cog', () => {
    const g = grid()
    expect(shown(g)).toEqual([
      'SKU', 'Name', 'Purchase price', 'Selling price',
      'Доставна цена', 'Цена на едро', 'Цена 1', 'Цена 2', 'Цена 4', 'Цена 5',
      '',
    ])
    const onCog = g.entries.value.filter((e) => e.key.startsWith('tier_'))
    expect(onCog.map((e) => e.title)).toEqual([...PRICE_TIER_NAMES])
    expect(onCog.filter((e) => e.visible).map((e) => e.title)).toEqual([...DEFAULT_TIER_COLUMNS])
    expect(g.customized.value).toBe(false)
  })

  it('a tier shown from the cog stays shown, and a reset brings the six back', () => {
    grid().toggle('tier_3')
    expect(shown(grid())).toContain('Цена 3')

    const g = grid()
    g.toggle('tier_wholesale')
    g.reset()
    expect(shown(grid()).filter((t: string) => t.startsWith('Цена') || t === 'Доставна цена')).toEqual([...DEFAULT_TIER_COLUMNS])
  })

  it('a user who had reordered the list gets the tiers after the selling price, wherever it went', () => {
    // Saved before the tier columns existed (no session in this process: `anon`, `no-org`).
    localStorage.setItem('lgr:grid-cols:anon:no-org:inventory.products', JSON.stringify({
      order: ['sellingPrice', 'sku', 'name', 'purchasePrice', 'actions'],
      hidden: ['purchasePrice'],
    }))
    expect(grid().effectiveHeaders.value.map((h: any) => h.key)).toEqual([
      'sellingPrice',
      'tier_delivery', 'tier_wholesale', 'tier_1', 'tier_2', 'tier_4', 'tier_5',
      'sku', 'name', 'actions',
    ])
  })
})

describe('tierPrice — a tier is found by its name', () => {
  const tiers = [
    { name: 'Доставна цена', finalPrice: 0.0512 },
    { name: 'Цена на едро', finalPrice: 0.0583 },
    { name: 'Цена 0', finalPrice: 0 },
    { name: 'Цена 1', finalPrice: 0.0472 },
    { name: 'Цена2', finalPrice: 0.07 },
    { name: 'Ценанаедро', finalPrice: 9 },
  ]

  it('prints the named slot, wherever the article holds it', () => {
    expect(tierPrice(tiers, 'Доставна цена')).toBe(0.0512)
    expect(tierPrice(tiers, 'Цена 1')).toBe(0.0472)
    expect(tierPrice([...tiers].reverse(), 'Цена 1')).toBe(0.0472)
  })

  it('reads a name its import folded together as the same slot — the first one wins', () => {
    expect(tierPrice(tiers, 'Цена 2')).toBe(0.07)
    expect(tierPrice(tiers, 'Цена на едро')).toBe(0.0583)
  })

  it('has no price for a slot the article lacks, a zero one, or an article with no tiers', () => {
    expect(tierPrice(tiers, 'Цена 5')).toBeNull()
    expect(tierPrice(tiers, 'Цена 0')).toBeNull()
    expect(tierPrice([], 'Цена 1')).toBeNull()
    expect(tierPrice(undefined, 'Цена 1')).toBeNull()
    expect(tierPrice(null, 'Цена 1')).toBeNull()
    expect(tierPrice([{ name: 'Цена 1', finalPrice: null }], 'Цена 1')).toBeNull()
  })

  it('never prints a tier an org named otherwise under a canonical heading', () => {
    // acme-corp's backfilled slots: „Price 1".."Price 10", all at the selling price.
    const acme = Array.from({ length: 10 }, (_, i) => ({ name: `Price ${i + 1}`, finalPrice: 185 }))
    for (const name of PRICE_TIER_NAMES) expect(tierPrice(acme, name)).toBeNull()
  })
})

describe('formatUnitPrice — four decimals, never rounded away', () => {
  const plain = (s: string) => s.replace(/\s/g, ' ')

  it('keeps a fraction of a cent, and pads a round price to two', () => {
    expect(plain(formatUnitPrice(0.0472, 'EUR', 'bg-BG'))).toBe('0,0472 €')
    expect(plain(formatUnitPrice(12.5, 'EUR', 'bg-BG'))).toBe('12,50 €')
    expect(formatUnitPrice(185, 'EUR', 'en-US')).toBe('€185.00')
    expect(plain(formatUnitPrice(1.23456, 'EUR', 'bg-BG'))).toBe('1,2346 €')
  })

  it('a missing price is zero, and a malformed currency still prints the figure', () => {
    expect(formatUnitPrice(undefined as any, 'EUR', 'en-US')).toBe('€0.00')
    expect(formatUnitPrice(1.5, 'EURO', 'en-US')).toBe('1.50 EURO')
  })
})
