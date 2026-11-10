import { describe, it, expect } from 'bun:test'
import {
  COST_TIER_NAMES, PRICE_LEVEL_CAPS, compileLegacy, keepStoredCosts, levelsOf, CATALOGUE, projectGrant, redactProduct, redactStockCost,
  summarize, templateGrant, withImplied, type CapabilityId,
} from 'config/access'
import { DEFAULT_ROLE_PERMISSIONS, ROLES } from 'config/constants'

/**
 * FR-27.6 (#529, D-5) — the cost figures, a field group: `products.costs`.
 */

const product = {
  _id: 'p1', name: 'Bolt', purchasePrice: 2, standardCost: 2.1, sellingPrice: 5,
  priceTiers: [
    { name: 'Доставна цена', percent: 0, finalPrice: 2 },
    { name: 'Цена на едро', percent: 50, finalPrice: 3 },
    { name: 'Цена 1', percent: 150, finalPrice: 5, tags: ['Цена 1'] },
  ],
  variants: [{ sku: 'B-1', purchasePrice: 2, sellingPrice: 5 }],
}
// Every price level (FR-27.11), so these tests are about the cost figures alone.
const viewer = { caps: new Set<CapabilityId>(['products.view', ...PRICE_LEVEL_CAPS]) }
const costs = { caps: new Set<CapabilityId>(['products.view', 'products.costs', ...PRICE_LEVEL_CAPS]) }

describe('nobody loses the cost figures on the legacy model', () => {
  it('every legacy role that reads a product holds them', () => {
    for (const role of ROLES) {
      const g = compileLegacy({ role, permissions: [...(DEFAULT_ROLE_PERMISSIONS[role] ?? [])] })
      const readsProducts = g.all || ['products.view', 'products.lookup', 'sales-docs.view', 'till.view'].some(c => (g.caps as Set<string>).has(c))
      if (readsProducts) expect(g.all || g.caps.has('products.costs')).toBe(true)
    }
  })

  it('so does every built-in role; a grant that reads no product has none', () => {
    expect(templateGrant('seller').caps?.has('products.costs')).toBe(true)
    expect(compileLegacy({ role: 'member', permissions: [] }).caps.has('products.costs')).toBe(false)
  })
})

describe('redaction', () => {
  it('a role without them reads the product without its costs: the keys are absent', () => {
    const r: any = redactProduct(viewer, product)
    expect('purchasePrice' in r).toBe(false)
    expect('standardCost' in r).toBe(false)
    expect(r.priceTiers.map((t: any) => t.name)).toEqual(['Цена на едро', 'Цена 1'])
    expect(r.priceTiers.some((t: any) => 'percent' in t)).toBe(false)
    expect('purchasePrice' in r.variants[0]).toBe(false)
    expect(r.sellingPrice).toBe(5)
    expect(JSON.stringify(r)).not.toContain('Доставна')
  })

  it('a role with them, and the Administrator, read everything', () => {
    expect(redactProduct(costs, product)).toBe(product)
    expect(redactProduct({ all: true }, product)).toBe(product)
  })

  it("a stock level's average cost", () => {
    expect('avgCost' in redactStockCost(viewer, { quantity: 3, avgCost: 2 })).toBe(false)
    expect(redactStockCost(costs, { quantity: 3, avgCost: 2 }).avgCost).toBe(2)
  })
})

describe('a write by a role without them keeps the stored costs', () => {
  it('drops the cost fields, puts the cost slot back first and every margin as stored', () => {
    const sent = { name: 'Bolt 2', purchasePrice: 0, standardCost: 9, priceTiers: [{ name: 'Цена на едро', finalPrice: 3.5 }, { name: 'Цена 1', finalPrice: 6 }, { name: 'Цена 1', finalPrice: 0 }] }
    const out = keepStoredCosts(viewer, sent, product)
    expect('purchasePrice' in out).toBe(false)
    expect('standardCost' in out).toBe(false)
    expect(out.priceTiers.map((t: any) => t.name)).toEqual(['Доставна цена', 'Цена на едро', 'Цена 1'])
    expect(out.priceTiers[0]).toMatchObject({ finalPrice: 2 })
    expect(out.priceTiers[1]).toMatchObject({ finalPrice: 3.5, percent: 50 })
  })

  it('a role with them writes what it sends', () => {
    const sent = { purchasePrice: 3, priceTiers: [] }
    expect(keepStoredCosts(costs, sent, product)).toBe(sent)
  })
})

describe('the editor and the projection', () => {
  const products = CATALOGUE.find(f => f.id === 'products')!

  it('Cost figures is an extra of Products, outside every level', () => {
    const l = levelsOf(products)
    expect(l.extras).toContain('products.costs')
    expect(l.full).not.toContain('products.costs')
  })

  it('a role that only reads products and sees costs is still read-only in the summary', () => {
    const s = summarize(costs)
    expect(s.readOnly).toContain('products')
    expect(s.canCreate).not.toContain('products')
  })

  it('a bill or a receipt brings the cost figures with it (their forms show the buying price)', () => {
    expect(withImplied(['bills.view'] as CapabilityId[])).toContain('products.costs')
    expect(withImplied(['movements.create'] as CapabilityId[])).toContain('products.costs')
  })

  it('a role without them projects onto the legacy model, which cannot withhold them: not exact', () => {
    const reader = compileLegacy({ role: 'member', permissions: ['inventory.read'] }) as { caps: Set<CapabilityId> }
    const withoutCosts = new Set([...reader.caps].filter(c => c !== 'products.costs'))
    const p = projectGrant({ caps: withoutCosts })
    expect(p.exact).toBe(false)
    expect(p.legacy.permissions).toContain('inventory.read')
    expect(COST_TIER_NAMES).toEqual(['Доставна цена'])
  })
})
