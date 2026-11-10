import { describe, it, expect } from 'bun:test'
import {
  CAPABILITIES, CUSTOMER_PRICE_LABEL, PRICE_LEVELS, PRICE_LEVEL_CAPS, capOfTier, compileLegacy, keepStoredPrices,
  capsOfSortKey, redactPriceOptions, redactProduct, redactResolution, sameGrant, sortRefusal, templateDefaults, templateGrant, templateOf, withImplied, type CapabilityId,
} from 'config/access'
import { DEFAULT_ROLE_PERMISSIONS, PRICE_TIERS, ROLES } from 'config/constants'

/**
 * FR-27.11 (#529, owner 2026-11-10) — price visibility per role: a role carries the price levels it may see, and the
 * server sends no figure of another (C.1), lets no write change one (C.4), and resolves the whole article while naming
 * no hidden level (C.6). The two stores' lists of FR-27.11.B are the fixtures.
 */

const TIERS = PRICE_TIERS.map(t => ({ name: t.name, percent: 10, finalPrice: 1 + PRICE_TIERS.indexOf(t) }))
const product = {
  _id: 'p1', name: 'Bolt', purchasePrice: 2, standardCost: 2.1, sellingPrice: 5, priceTiers: TIERS,
  tagPrices: [{ tag: 'VIP', price: 4 }], customPrices: [{ contactId: 'c1', price: 3.5 }],
}

const caps = (...c: string[]) => ({ caps: new Set(['products.view', ...c] as CapabilityId[]) })
// FR-27.11.B: regal-pz's Seller sees the selling price, Цена 1 and Цена 2, and the other prices.
const regalPz = caps('products.price:selling', 'products.price:1', 'products.price:2', 'products.price:other')
// regal-sf's sees Цена 6 and Цена 7.
const regalSf = caps('products.price:selling', 'products.price:6', 'products.price:7', 'products.price:other')
const names = (p: any) => (p.priceTiers ?? []).map((t: any) => t.name)

describe('A. the levels', () => {
  it('one per PRICE_TIERS slot but the cost slot, the selling price and the others: each a capability', () => {
    expect(PRICE_LEVELS.filter(l => l.tier).map(l => l.tier)).toEqual(PRICE_TIERS.filter(t => t.key !== 'delivery').map(t => t.name))
    expect(PRICE_LEVEL_CAPS[0]).toBe('products.price:selling')
    expect(PRICE_LEVEL_CAPS.at(-1)).toBe('products.price:other')
    expect(PRICE_LEVEL_CAPS.every(c => CAPABILITIES.has(c))).toBe(true)
  })

  it('a slot is found by name as the grid finds it, spaces ignored', () => {
    expect(capOfTier('Цена 3')).toBe('products.price:3')
    expect(capOfTier('Цена3')).toBe('products.price:3')
    expect(capOfTier('Цена на едро')).toBe('products.price:wholesale')
    expect(capOfTier('Ценанаедро')).toBe('products.price:wholesale')
    expect(capOfTier('Доставна цена')).toBe('products.costs')
    expect(capOfTier('Цена за Иван')).toBe('products.price:other')
  })

  it('legacy grants every level wherever it reads products: nobody loses a price', () => {
    for (const role of ROLES) {
      const g = compileLegacy({ role, permissions: [...(DEFAULT_ROLE_PERMISSIONS[role] ?? [])] })
      const readsProducts = g.all || ['products.view', 'products.lookup', 'sales-docs.view', 'till.view'].some(c => (g.caps as Set<string>).has(c))
      if (readsProducts) expect({ role, all: PRICE_LEVEL_CAPS.every(c => g.all || g.caps.has(c)) }).toEqual({ role, all: true })
    }
  })

  it('what sells sees the selling price; what writes prices sees them all; editing an article implies none', () => {
    expect(withImplied(['till.sell'] as CapabilityId[])).toContain('products.price:selling')
    expect(withImplied(['sales-docs.create'] as CapabilityId[])).toContain('products.price:selling')
    for (const writer of ['price-lists.edit', 'bulk-pricing.create', 'opening-stock.create', 'movements.create'] as CapabilityId[]) {
      const g = withImplied([writer])
      expect({ writer, every: [...PRICE_LEVEL_CAPS, 'products.costs'].every(c => g.includes(c as CapabilityId)) }).toEqual({ writer, every: true })
    }
    expect(withImplied(['products.edit'] as CapabilityId[]).some(c => c.startsWith('products.price:') || c === 'products.costs')).toBe(false)
  })
})

describe('B. the templates (D-11, D-12)', () => {
  it('a Seller or a Sales Consultant made from the template starts without the costs, Цена на едро and Цена 0; every other level on', () => {
    for (const key of ['seller', 'sales_consultant']) {
      const g = templateDefaults(key) as { caps: Set<string> }
      expect(['products.costs', 'products.price:wholesale', 'products.price:0'].filter(c => g.caps.has(c))).toEqual([])
      expect(PRICE_LEVEL_CAPS.filter(c => !['products.price:wholesale', 'products.price:0'].includes(c)).every(c => g.caps.has(c))).toBe(true)
    }
  })

  it('every other template keeps every level', () => {
    for (const key of ['manager', 'accountant', 'warehouse_manager', 'sales', 'member']) {
      const g = templateDefaults(key) as { caps: Set<string> }
      expect({ key, every: [...PRICE_LEVEL_CAPS, 'products.costs'].every(c => g.caps.has(c)) }).toEqual({ key, every: true })
    }
  })

  it("the template itself stays the legacy role's access: an unedited built-in and migration 0015 change nobody", () => {
    expect(sameGrant(templateGrant('seller'), compileLegacy(templateOf('seller')!.legacy))).toBe(true)
    expect((templateGrant('seller') as any).caps.has('products.costs')).toBe(true)
  })
})

describe('C.1 a product as the role may read it', () => {
  it("regal-pz's Seller: Цена 1 and Цена 2, the selling price, the other prices; no cost, no margin", () => {
    const r: any = redactProduct(regalPz, product)
    expect(names(r)).toEqual(['Цена 1', 'Цена 2'])
    expect(r.sellingPrice).toBe(5)
    expect('purchasePrice' in r || 'standardCost' in r).toBe(false)
    expect(r.priceTiers.some((t: any) => 'percent' in t)).toBe(false)
    expect(r.tagPrices).toHaveLength(1)
    expect(JSON.stringify(r)).not.toContain('Цена 3')
  })

  it("regal-sf's: Цена 6 and Цена 7", () => {
    expect(names(redactProduct(regalSf, product))).toEqual(['Цена 6', 'Цена 7'])
  })

  it('without the selling price or the other prices, those keys are absent too', () => {
    const r: any = redactProduct(caps('products.price:3'), product)
    expect(names(r)).toEqual(['Цена 3'])
    expect('sellingPrice' in r || 'tagPrices' in r || 'customPrices' in r).toBe(false)
  })

  it('the Administrator, and a role that sees every level and the costs, read the record as it is', () => {
    expect(redactProduct({ all: true }, product)).toBe(product)
    expect(redactProduct(caps('products.costs', ...PRICE_LEVEL_CAPS), product)).toBe(product)
  })
})

describe('C.4 a write changes no figure the role cannot see', () => {
  it('hidden slots keep their stored values where they stood; visible ones take the body; the cost basis stays', () => {
    // The form regal-pz's Seller loaded: Цена 1 and Цена 2 only, and a purchase price it never saw, sent as 0.
    const body = { name: 'Bolt 2', purchasePrice: 0, sellingPrice: 6, priceTiers: [{ name: 'Цена 1', finalPrice: 7 }, { name: 'Цена 2', finalPrice: 8 }, { name: 'Цена 3', finalPrice: 0 }] }
    const out = keepStoredPrices(regalPz, body, product)
    expect('purchasePrice' in out).toBe(false)
    expect(out.sellingPrice).toBe(6)
    expect(out.priceTiers.map((t: any) => t.name)).toEqual(PRICE_TIERS.map(t => t.name))
    for (const t of out.priceTiers) {
      if (t.name === 'Цена 1') expect(t).toEqual({ name: 'Цена 1', finalPrice: 7, percent: 10 })
      else if (t.name === 'Цена 2') expect(t).toEqual({ name: 'Цена 2', finalPrice: 8, percent: 10 })
      else expect(t).toEqual(TIERS.find(x => x.name === t.name)!)
    }
  })

  it('a role without the selling price leaves it as stored', () => {
    expect('sellingPrice' in keepStoredPrices(caps('products.price:3'), { sellingPrice: 0 }, product)).toBe(false)
  })
})

describe('C.6 resolution is not visibility', () => {
  const resolution = {
    finalPrice: 4,
    steps: [{ type: 'base', label: 'Selling price', price: 5 }, { type: 'tier', label: 'Цена 3', price: 4 }],
  }

  it('the final price is the same; a hidden winning level goes out as "Customer price"', () => {
    const r: any = redactResolution(regalPz, resolution)
    expect(r.finalPrice).toBe(4)
    expect(r.steps).toEqual([{ type: 'base', label: 'Selling price', price: 5 }, { type: 'customer', label: CUSTOMER_PRICE_LABEL, price: 4 }])
    expect(JSON.stringify(r)).not.toContain('Цена 3')
  })

  it('a hidden step that does not win is not named at all', () => {
    const r: any = redactResolution(regalPz, { finalPrice: 3.5, steps: [...resolution.steps, { type: 'contact', label: 'Custom', price: 3.5 }] })
    expect(r.steps.map((s: any) => s.type)).toEqual(['base', 'contact'])
  })

  it('the Select-price menu offers no hidden level, and the customer\'s own price as "Customer price"', () => {
    const options = {
      resolvedKey: 'tier-3',
      options: [
        { key: 'selling', name: 'Selling price', price: 5, type: 'base' },
        { key: 'tier-0', name: 'Доставна цена', price: 2, type: 'tier' },
        { key: 'tier-1', name: 'Цена 1', price: 4.5, type: 'tier' },
        { key: 'tier-3', name: 'Цена 3', price: 4, type: 'tier' },
        { key: 'tier-5', name: 'Цена 5', price: 3.8, type: 'tier' },
      ],
    }
    const r: any = redactPriceOptions(regalPz, options)
    expect(r.options.map((o: any) => o.name)).toEqual(['Selling price', 'Цена 1', CUSTOMER_PRICE_LABEL])
    expect(r.resolvedKey).toBe('tier-3')
  })
})

describe('C.3 the levels a sort key reads', () => {
  it('however it is spelled', () => {
    expect(capsOfSortKey('tier_3')).toEqual(['products.price:3'])
    expect(capsOfSortKey('tier_wholesale')).toEqual(['products.price:wholesale'])
    expect(capsOfSortKey('tier_delivery')).toEqual(['products.costs'])
    expect(capsOfSortKey('purchasePrice')).toEqual(['products.costs'])
    expect(capsOfSortKey('lines.unitCost')).toEqual(['products.costs'])
    expect(capsOfSortKey('sellingPrice')).toEqual(['products.price:selling'])
    expect(capsOfSortKey('priceTiers.4.finalPrice')).toEqual(['products.costs', ...PRICE_LEVEL_CAPS])
    expect(capsOfSortKey('name')).toEqual([])
    expect(capsOfSortKey('total')).toEqual([])
  })

  it('refused for a level the role lacks, never for one it holds or for the Administrator', () => {
    expect(sortRefusal(regalPz, 'tier_3')?.capabilities).toEqual(['products.price:3'])
    expect(sortRefusal(regalPz, 'tier_1')).toBeNull()
    expect(sortRefusal(regalPz, 'name')).toBeNull()
    expect(sortRefusal({ all: true }, 'purchasePrice')).toBeNull()
    expect(sortRefusal(compileLegacy({ role: 'member', permissions: ['inventory.read'] }), 'purchasePrice')).toBeNull()
  })
})
