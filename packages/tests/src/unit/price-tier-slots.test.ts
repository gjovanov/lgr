import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_PRICE_TIERS, PRICE_TIER_NAMES } from 'config/constants'
import { tierSlotsToAdd } from 'ui-shared/composables/product-price-columns'

/**
 * The product form adds a price slot for each level the role sees that the article lacks, by name (FR-27.11.D, #529:
 * it no longer cuts the list to the role's count, which had erased slots). By name alone it also gave an article whose
 * slots carry OTHER names a second, whole set: ten slots called "Price 1" … "Price 10" (what
 * `scripts/backfill-price-tiers.ts` writes) became 23 on load, and Save stored all of them, because the update route
 * runs no validator. The model's cap is `MAX_PRICE_TIERS`, and a goods receipt that restates the prices of an article
 * over it is refused.
 */

const backfilled = Array.from({ length: 10 }, (_, i) => `Price ${i + 1}`)
const after = (have: readonly string[], visible: readonly string[] = PRICE_TIER_NAMES) => [...have, ...tierSlotsToAdd(have, visible)]

describe('tierSlotsToAdd: by name, into the free places only', () => {
  it('a new article gets a slot for every level', () => {
    expect(tierSlotsToAdd([], PRICE_TIER_NAMES)).toEqual([...PRICE_TIER_NAMES])
  })

  it('an article that has every level gets none, whatever the spacing or case of its names', () => {
    expect(tierSlotsToAdd(PRICE_TIER_NAMES, PRICE_TIER_NAMES)).toEqual([])
    expect(tierSlotsToAdd(PRICE_TIER_NAMES.map(n => n.replace(/\s+/g, '').toUpperCase()), PRICE_TIER_NAMES)).toEqual([])
  })

  it('an article with the first ten levels gets the three it lacks', () => {
    expect(tierSlotsToAdd(PRICE_TIER_NAMES.slice(0, 10), PRICE_TIER_NAMES)).toEqual(PRICE_TIER_NAMES.slice(10))
  })

  it('an article whose ten slots carry other names stays within the cap: it gets the names of its three free places', () => {
    const slots = after(backfilled)
    expect(slots.length).toBe(MAX_PRICE_TIERS)
    expect(slots.slice(10)).toEqual(PRICE_TIER_NAMES.slice(10))
  })

  it('a full article with one slot renamed gets nothing: it has no free place', () => {
    const renamed = PRICE_TIER_NAMES.map(n => (n === PRICE_TIER_NAMES[7] ? 'VIP' : n))
    expect(tierSlotsToAdd(renamed, PRICE_TIER_NAMES)).toEqual([])
  })

  it('no article ends over the cap, however its slots are named', () => {
    for (let n = 0; n <= MAX_PRICE_TIERS + 3; n++) {
      const other = Array.from({ length: n }, (_, i) => `Level ${i}`)
      expect({ n, slots: after(other).length }).toEqual({ n, slots: Math.max(n, MAX_PRICE_TIERS) })
    }
  })

  it('missing levels in the middle are added by name, never a second slot of a name the article has', () => {
    const have = PRICE_TIER_NAMES.filter((_, i) => i !== 5 && i !== 12)
    expect(tierSlotsToAdd(have, PRICE_TIER_NAMES)).toEqual([PRICE_TIER_NAMES[5], PRICE_TIER_NAMES[12]])
    const slots = after(have)
    expect(new Set(slots).size).toBe(slots.length)
  })

  it('a role that sees two levels gets those two, and nothing is ever taken away', () => {
    const visible = [PRICE_TIER_NAMES[3], PRICE_TIER_NAMES[4]]
    expect(tierSlotsToAdd([], visible)).toEqual(visible)
    expect(tierSlotsToAdd([visible[0]], visible)).toEqual([visible[1]])
    // More slots than the role sees levels (it also sees the "other" names): none is cut, the two are still added.
    expect(after(backfilled, visible)).toEqual([...backfilled, ...visible])
  })
})

describe('the product form pads its slots through tierSlotsToAdd', () => {
  const form = readFileSync(join(import.meta.dir, '../../../inventory-ui/src/views/ProductFormView.vue'), 'utf8')
  const body = form.slice(form.indexOf('function ensureTierSlots()'), form.indexOf('function recomputeTiersFromPurchase()'))

  it('ensureTierSlots asks the helper, and trims nothing', () => {
    expect(body).toContain('tierSlotsToAdd(')
    expect(body).not.toMatch(/\.length\s*=/)
    expect(body).not.toMatch(/\.splice\(|\.pop\(/)
  })
})
