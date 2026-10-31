import { describe, it, expect } from 'bun:test'
import {
  buildProductUpdates,
  cascadePurchasePrice,
  needsSeed,
  productUpdateOf,
  seedFromProduct,
  setProductField,
  setTierPrice,
  tierPriceOf,
  type GRLine,
} from 'ui-shared/composables/gr-product-update'

/**
 * „С актуализация на продукт" on the goods-receipt and supplier-bill forms: what a line stages
 * for its product, and what of it reaches the product. The bill form now opens with the switch
 * ON, so the rules below are what keep an untouched bill from writing anything.
 */

/** An article as `GET /warehouse/product/:id` returns it. */
function product(over: Record<string, any> = {}) {
  return {
    _id: 'p1',
    type: 'goods',
    categoryId: 'c1',
    unit: 'pcs',
    purchasePrice: 10,
    sellingPrice: 20,
    taxRate: 20,
    priceTiers: [
      // derived from the purchase price: 10 + 30 %
      { name: 'Цена 1', percent: 30, finalPrice: 13, manualOverride: false, contactIds: ['k1'], tags: ['Цена 1'], minQuantity: 5 },
      // fixed by hand
      { name: 'Цена 2', percent: 0, finalPrice: 17.5, manualOverride: true },
      // a backfilled slot: the selling price, percent 0, not overridden
      { name: 'Цена 3', percent: 0, finalPrice: 20, manualOverride: false },
    ],
    ...over,
  }
}

function seededLine(over: Record<string, any> = {}): GRLine & Record<string, any> {
  return { productId: 'p1', unitPrice: 10, ...seedFromProduct(product(over), 'p1') }
}

describe('seeding a line from its product', () => {
  it('stages the product as it is, tiers by name and none padded in', () => {
    const line = seededLine()
    expect(line.productUpdate).toEqual({ type: 'goods', categoryId: 'c1', unit: 'pcs', purchasePrice: 10, sellingPrice: 20, taxRate: 20 })
    expect(line.priceTiers!.map(t => t.name)).toEqual(['Цена 1', 'Цена 2', 'Цена 3'])
    expect(line.productBase!.productId).toBe('p1')
    // An article with no tiers stays with none: the 13-slot padding with „Price N" junk is gone.
    expect(seedFromProduct(product({ priceTiers: [] }), 'p1').priceTiers).toEqual([])
  })

  it('a seeded line, or one that stages something, is not seeded again in bulk', () => {
    expect(needsSeed({ productId: 'p1', productUpdate: {}, priceTiers: [] })).toBe(true)
    expect(needsSeed(seededLine())).toBe(false)
    expect(needsSeed({ productId: 'p1', productUpdate: { sellingPrice: 30 }, priceTiers: [] })).toBe(false)
    expect(needsSeed({ productUpdate: {}, priceTiers: [] })).toBe(false) // free text
    // Seeded for another article than the line now names: seeded again.
    expect(needsSeed({ ...seededLine(), productId: 'p2', productUpdate: {}, priceTiers: [] })).toBe(true)
  })
})

describe('what a seeded line sends', () => {
  it('nothing, when nothing was touched — the plain save path', () => {
    expect(buildProductUpdates([seededLine(), seededLine({ _id: 'p2' })])).toEqual([])
  })

  it('only the field that was edited', () => {
    const line = seededLine()
    setProductField(line, 'sellingPrice', '24.5') // as a v-text-field hands it over
    expect(productUpdateOf(line)).toEqual({ productId: 'p1', sellingPrice: 24.5 })
  })

  it('a field typed back to what it was is no change, and a half-typed number is none either', () => {
    const line = seededLine()
    setProductField(line, 'sellingPrice', '20.00')
    setProductField(line, 'taxRate', '-')
    expect(productUpdateOf(line)).toBeNull()
  })

  it('a tier by name, with only its price and its fixing — never its filters', () => {
    const line = seededLine()
    setTierPrice(line, 'Цена 1', '15')
    expect(productUpdateOf(line)).toEqual({ productId: 'p1', priceTiers: [{ name: 'Цена 1', finalPrice: 15, manualOverride: true }] })
  })

  it('a tier the article does not hold is added by its name, only once it has a price', () => {
    const line = seededLine()
    expect(tierPriceOf(line.priceTiers, 'Цена 4')).toBeUndefined()
    setTierPrice(line, 'Цена 4', '')
    expect(productUpdateOf(line)).toBeNull()
    setTierPrice(line, 'Цена 4', '31')
    expect(tierPriceOf(line.priceTiers, 'Цена 4')).toBe(31)
    expect(productUpdateOf(line)!.priceTiers).toEqual([{ name: 'Цена 4', finalPrice: 31, manualOverride: true }])
  })

  it('finds a tier whatever spacing its name was stored with', () => {
    const line = { productId: 'p1', ...seedFromProduct(product({ priceTiers: [{ name: 'Цена1', percent: 0, finalPrice: 9, manualOverride: true }] }), 'p1') }
    expect(tierPriceOf(line.priceTiers, 'Цена 1')).toBe(9)
    setTierPrice(line, 'Цена 1', 11)
    expect(line.priceTiers!).toHaveLength(1)
    expect(productUpdateOf(line)!.priceTiers).toEqual([{ name: 'Цена1', finalPrice: 11, manualOverride: true }])
  })

  it('a free-text line sends nothing', () => {
    expect(productUpdateOf({ productUpdate: { purchasePrice: 5 } })).toBeNull()
  })
})

describe('the unit price moves the purchase price, and only the tiers derived from it', () => {
  it('moves a derived tier, leaves a fixed one and a backfilled one alone', () => {
    const line = seededLine()
    cascadePurchasePrice(line, 12)
    const u = productUpdateOf(line)!
    expect(u.purchasePrice).toBe(12)
    // 12 + 30 % = 15.6; Цена 2 is fixed by hand; Цена 3 sits at the selling price with percent 0 —
    // it was never derived from the purchase price, and snapping it to 12 was the old behaviour.
    expect(u.priceTiers).toEqual([{ name: 'Цена 1', finalPrice: 15.6, manualOverride: false }])
    expect(tierPriceOf(line.priceTiers, 'Цена 3')).toBe(20)
  })

  it('back at the catalog price, nothing is sent — not even a tier recomputed to more decimals', () => {
    // The product form stores a recomputed tier to the cent: 7.33 + 15 % = 8.4295 → 8.43.
    const line = seededLine({ purchasePrice: 7.33, priceTiers: [{ name: 'Цена 1', percent: 15, finalPrice: 8.43, manualOverride: false }] })
    cascadePurchasePrice(line, 9)
    cascadePurchasePrice(line, '7.33')
    expect(productUpdateOf(line)).toBeNull()
  })

  it('a tier typed by hand stops following the purchase price', () => {
    const line = seededLine()
    setTierPrice(line, 'Цена 1', 14)
    cascadePurchasePrice(line, 12)
    expect(tierPriceOf(line.priceTiers, 'Цена 1')).toBe(14)
  })

  it('a line staged without a base moves only its purchase price', () => {
    const line: GRLine = { productId: 'p1', productUpdate: {}, priceTiers: [{ name: 'Цена 1', percent: 30, finalPrice: 13, manualOverride: false }] }
    cascadePurchasePrice(line, 12)
    expect(line.productUpdate!.purchasePrice).toBe(12)
    expect(tierPriceOf(line.priceTiers, 'Цена 1')).toBe(13)
  })

  it('a price that is not one changes nothing', () => {
    const line = seededLine()
    cascadePurchasePrice(line, '')
    cascadePurchasePrice(line, 0)
    expect(productUpdateOf(line)).toBeNull()
  })
})

describe('a line staged without a base (the receipt form\'s import of a разписка)', () => {
  it('sends what it stages, each tier with only the fields it carries', () => {
    const line: GRLine = {
      productId: 'p1',
      productUpdate: { sellingPrice: 21, unit: '' },
      priceTiers: [
        { name: 'Цена 1', percent: 5, finalPrice: 21, manualOverride: true, tags: ['Цена 1'] },
        { name: 'Цена 2', percent: 0, finalPrice: 0, manualOverride: false },
      ],
    }
    expect(productUpdateOf(line)).toEqual({
      productId: 'p1',
      sellingPrice: 21,
      priceTiers: [
        { name: 'Цена 1', percent: 5, finalPrice: 21, manualOverride: true, tags: ['Цена 1'] },
        { name: 'Цена 2', percent: 0, finalPrice: 0, manualOverride: false },
      ],
    })
  })

  it('a tier typed on such a line sends what was typed — no percent to overwrite the product\'s', () => {
    const line: GRLine = { productId: 'p1', productUpdate: {}, priceTiers: [] }
    setTierPrice(line, 'Цена 1', '5.2')
    expect(productUpdateOf(line)).toEqual({ productId: 'p1', priceTiers: [{ name: 'Цена 1', finalPrice: 5.2, manualOverride: true }] })
  })

  it('sends no tiers when none carries a price or a fixing', () => {
    const line: GRLine = { productId: 'p1', productUpdate: {}, priceTiers: [{ name: 'Цена 1', percent: 0, finalPrice: 0, manualOverride: false }] }
    expect(productUpdateOf(line)).toBeNull()
  })
})
