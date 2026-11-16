import { describe, it, expect } from 'bun:test'
import { PRICE_CAPS, priceCapOfLevel, templateGrant, withPriceLevels, type CapabilityId } from 'config/access'

/**
 * #529 (FR-27.11.B) — `scripts/role-price-levels.ts`'s pure part: level names to capabilities, and the guard that a
 * capability the role keeps does not bring a withheld level back (FR-27.11.A, a role that writes prices sees them all).
 */

const prices = (caps: readonly string[]) => caps.filter(c => (PRICE_CAPS as readonly string[]).includes(c)).sort()

describe('level names', () => {
  it('name the editor\'s ticks', () => {
    expect(priceCapOfLevel('selling')).toBe('products.price:selling')
    expect(priceCapOfLevel(' 7 ')).toBe('products.price:7')
    expect(priceCapOfLevel('Wholesale')).toBe('products.price:wholesale')
    expect(priceCapOfLevel('other')).toBe('products.price:other')
    expect(priceCapOfLevel('costs')).toBe('products.costs')
    for (const no of ['11', 'delivery', 'Цена 1', '']) expect(priceCapOfLevel(no)).toBeNull()
  })
})

describe('the stores\' Seller and Sales Consultant (#529)', () => {
  for (const key of ['seller', 'sales_consultant']) {
    it(`${key}: regal-pz's and regal-sf's levels replace the template's, and keep the rest`, () => {
      const template = [...(templateGrant(key).caps as Set<CapabilityId>)]
      const pz = withPriceLevels(template, ['selling', '1', '2', 'other'])
      const sf = withPriceLevels(template, ['selling', '6', '7', 'other'])
      for (const edit of [pz, sf]) expect([edit.unknown, edit.cameBack]).toEqual([[], []])
      expect(prices(pz.caps)).toEqual(['products.price:1', 'products.price:2', 'products.price:other', 'products.price:selling'])
      expect(prices(sf.caps)).toEqual(['products.price:6', 'products.price:7', 'products.price:other', 'products.price:selling'])
      const rest = (caps: readonly string[]) => caps.filter(c => !(PRICE_CAPS as readonly string[]).includes(c)).sort()
      expect(rest(pz.caps)).toEqual(rest(template))
    })
  }
})

describe('nothing that would not hold', () => {
  it('an unknown level is reported, not dropped', () => {
    expect(withPriceLevels([], ['selling', 'Цена 1']).unknown).toEqual(['Цена 1'])
  })

  it('a role that writes prices would see them all: the withheld levels are named, with what implies them', () => {
    const edit = withPriceLevels(['movements.create' as CapabilityId], ['selling'])
    expect(edit.cameBack.length).toBeGreaterThan(0)
    expect(edit.cameBack.every(b => b.from.includes('movements.create' as CapabilityId))).toBe(true)
    expect(edit.cameBack.map(b => b.cap)).toContain('products.costs')
  })
})
