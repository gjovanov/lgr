import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PERCENT_DECIMALS, PRICE_DECIMALS, formatFixed, marginOver, parseTyped, parseTypedPrice, priceAtMargin, roundPercent, roundPrice, roundTo,
} from 'ui-shared/composables/price-precision'
import { cascadePurchasePrice, seedFromProduct } from 'ui-shared/composables/gr-product-update'

/**
 * A price keeps four decimals and a margin three (owner, 2026-11-12: 0.0472 is a fastener's price, 2000.555 a margin).
 * The product form rounded a price to the cent and a margin to a tenth, so a tier recomputed from a purchase price of
 * 0.0472 at 25 % was stored as 0.06, and the goods receipt's cascade, which kept four decimals, disagreed with it.
 */

describe('how many decimals', () => {
  it('a price keeps four, a margin three', () => {
    expect([PRICE_DECIMALS, PERCENT_DECIMALS]).toEqual([4, 3])
    expect(roundPrice(0.04723)).toBe(0.0472)
    expect(roundPrice(12345.67891)).toBe(12345.6789)
    expect(roundPercent(2000.5554)).toBe(2000.555)
    expect(roundPercent(12.3456)).toBe(12.346)
  })
})

describe('roundTo: the figure as it is written', () => {
  it('a half goes away from zero, where toFixed rounds the double under it', () => {
    // The trap this replaces: the double nearest 2.00005 lies just below it (2.00004999999999988…).
    expect([(2.00005).toFixed(4), (0.50005).toFixed(4), (2000.5555).toFixed(3)]).toEqual(['2.0000', '0.5000', '2000.555'])
    expect([roundTo(2.00005, 4), roundTo(0.50005, 4), roundTo(2000.5555, 3)]).toEqual([2.0001, 0.5001, 2000.556])
    // Where the double lies above the half, both agree.
    expect([(1.00005).toFixed(4), roundTo(1.00005, 4)]).toEqual(['1.0001', 1.0001])
    expect(roundTo(1.005, 2)).toBe(1.01)
    expect(roundTo(-2.00005, 4)).toBe(-2.0001)
    expect([roundTo(2.5, 0), roundTo(-2.5, 0)]).toEqual([3, -3])
  })

  it('the noise of binary arithmetic is not a decimal', () => {
    expect(roundPercent(74.07000000000001)).toBe(74.07)
    expect(roundPrice(0.1 + 0.2)).toBe(0.3)
    expect(roundPrice(0.05899999999999999)).toBe(0.059)
  })

  it('what is no number is 0, and the answer is never -0', () => {
    for (const v of [undefined, null, '', 'abc', Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect({ v: String(v), rounded: roundTo(v, 4) }).toEqual({ v: String(v), rounded: 0 })
    }
    expect(Object.is(roundTo(-0.00001, 4), 0)).toBe(true)
    expect(Object.is(roundTo(-0, 4), 0)).toBe(true)
  })

  it('a figure printed with an exponent is rounded as the double it is', () => {
    expect(roundTo(1e-7, 4)).toBe(0)
    expect(roundTo(1.5e21, 4)).toBe(1.5e21)
  })

  it('reads a number handed over as text', () => {
    expect(roundTo('12.34567', 4)).toBe(12.3457)
  })
})

describe('formatFixed: what a field shows at rest', () => {
  it('every decimal, the trailing zeros too', () => {
    expect(formatFixed(0.053, 4)).toBe('0.0530')
    expect(formatFixed(12, 4)).toBe('12.0000')
    expect(formatFixed(2000.555, 3)).toBe('2000.555')
    expect(formatFixed(0, 3)).toBe('0.000')
  })

  it('a figure with more decimals is shown rounded, and a tiny negative one as zero', () => {
    expect(formatFixed(0.04723, 4)).toBe('0.0472')
    expect(formatFixed(-0.00001, 4)).toBe('0.0000')
  })

  it('no figure is an empty field, never "NaN"', () => {
    for (const v of [null, undefined, '', 'abc', Number.NaN]) expect(formatFixed(v, 4)).toBe('')
  })
})

describe('parseTyped: what was typed', () => {
  it('a number, with a point or a comma', () => {
    expect([parseTyped('12.5'), parseTyped('12,5'), parseTyped(' 7 '), parseTyped('12.'), parseTyped(3)]).toEqual([12.5, 12.5, 7, 12, 3])
  })

  it('nothing, or no number, is null', () => {
    expect([parseTyped(''), parseTyped(null), parseTyped(undefined), parseTyped('abc'), parseTyped(Number.NaN)]).toEqual([null, null, null, null, null])
  })
})

// The price a person types on a sales document line (PriceCombobox). Until 2026-11-12 it read the text with `Number`,
// so "12,5" was NaN and the typed price was dropped without a word.
describe('parseTypedPrice: a price typed on a line', () => {
  it('a comma is a decimal point: "12,5" is 12.5, as "12.5" is', () => {
    expect([parseTypedPrice('12,5'), parseTypedPrice('12.5'), parseTypedPrice(' 0,0472 '), parseTypedPrice('7')]).toEqual([12.5, 12.5, 0.0472, 7])
  })

  it("an offered price's name after the dash is not part of the figure", () => {
    expect([parseTypedPrice('10.00 — Selling price'), parseTypedPrice('9,90 — Цена 3')]).toEqual([10, 9.9])
  })

  it('nothing, no number, or a figure under zero is no price', () => {
    expect([parseTypedPrice(''), parseTypedPrice(null), parseTypedPrice('abc'), parseTypedPrice('-1'), parseTypedPrice('— Selling price')]).toEqual([null, null, null, null, null])
  })

  it('zero is a price (a line given away), and a number is taken as it is', () => {
    expect([parseTypedPrice('0'), parseTypedPrice(0), parseTypedPrice(12.5)]).toEqual([0, 0, 12.5])
  })
})

describe('a price and its margin over the purchase price', () => {
  it('a tier that follows the purchase price is the price plus its margin, to four decimals', () => {
    expect(priceAtMargin(0.0472, 12.345)).toBe(0.053) // 0.05302684
    expect(priceAtMargin(0.0472, 25)).toBe(0.059) // the form stored 0.06
    expect(priceAtMargin(10, 25)).toBe(12.5)
    expect(priceAtMargin(0.0472, 0)).toBe(0.0472)
    expect(priceAtMargin(0.5, 0.01)).toBe(0.5001) // 0.50005: a half, up
  })

  it('a price fixed by hand shows its margin to three decimals', () => {
    expect(marginOver(0.0472, 0.053)).toBe(12.288) // 12.28813…
    expect(marginOver(10, 12.5)).toBe(25)
    expect(marginOver(10, 5)).toBe(-50)
    expect(marginOver(3, 63.01665)).toBe(2000.555)
  })

  it('no purchase price, no margin', () => {
    expect([marginOver(0, 5), marginOver(null, 5), marginOver('', 5), marginOver(undefined, 5)]).toEqual([0, 0, 0, 0])
  })
})

describe('the goods receipt gives the article the price the product form gives it', () => {
  it('the cascade of a new purchase price rounds a following tier with the form\'s own rule', () => {
    const product = {
      _id: 'p1', purchasePrice: 10, sellingPrice: 15,
      priceTiers: [
        { name: 'Цена 1', percent: 12.345, finalPrice: 11.2345, manualOverride: false },
        { name: 'Цена 2', percent: 0.01, finalPrice: 10.001, manualOverride: false },
      ],
    }
    const line: any = { productId: 'p1', ...seedFromProduct(product) }
    cascadePurchasePrice(line, 0.5)
    expect(line.priceTiers.map((t: any) => t.finalPrice)).toEqual([priceAtMargin(0.5, 12.345), priceAtMargin(0.5, 0.01)])
    expect(line.priceTiers.map((t: any) => t.finalPrice)).toEqual([0.5617, 0.5001])
  })
})

describe('the product form computes with the one rule', () => {
  const form = readFileSync(join(import.meta.dir, '../../../inventory-ui/src/views/ProductFormView.vue'), 'utf8')
  const pricing = form.slice(form.indexOf('<v-tabs-window-item value="pricing">'), form.indexOf('<!-- Inventory Settings -->'))

  it('rounds nothing by itself', () => {
    expect(form).not.toMatch(/toFixed\(/)
    expect(form).toContain("from 'ui-shared/composables/price-precision'")
  })

  it('every price and margin on the pricing tab is a DecimalField with its decimals named', () => {
    expect(pricing.length).toBeGreaterThan(0)
    const fields = pricing.match(/<DecimalField[\s\S]*?\/>/g) ?? []
    // Top: purchase, selling, its margin, the read-only margin. Table: the two base rows (3 fields) and a tier's two.
    expect(fields.length).toBe(9)
    for (const f of fields) expect(f).toMatch(/:decimals="(PRICE_DECIMALS|PERCENT_DECIMALS)"/)
    // No price is left on a plain number field with a step of a cent.
    expect(pricing).not.toMatch(/step="0\.0?1"/)
  })

  it('the tiers begin with the article\'s two base prices, on the models of the fields above', () => {
    const table = pricing.slice(pricing.indexOf('<tbody>'))
    const purchase = table.slice(table.indexOf('data-testid="tier-base-purchase"'), table.indexOf('data-testid="tier-base-selling"'))
    const selling = table.slice(table.indexOf('data-testid="tier-base-selling"'), table.indexOf('data-testid="tier-row"'))
    expect(purchase).toContain('v-model="form.purchasePrice"')
    expect(purchase).toContain('@update:model-value="onPurchasePriceChange"')
    expect(selling).toContain('v-model="form.sellingPrice"')
    expect(selling).toContain('@update:model-value="onSellingPriceChange"')
    expect(selling).toContain('v-model="sellingPricePercent"')
    // Shown to whoever sees the field above (FR-27.6, FR-27.11.D).
    expect(table).toMatch(/<tr v-if="seesCosts"[^>]*data-testid="tier-base-purchase"/)
    expect(table).toMatch(/<tr v-if="seesSelling"[^>]*data-testid="tier-base-selling"/)
  })
})
