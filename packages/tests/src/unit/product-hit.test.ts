import { describe, it, expect } from 'bun:test'
import {
  SEARCH_DEBOUNCE_MS, SEARCH_HITS, SEARCH_MIN_CHARS,
  hitPriceText, hitStockText, hitSubtitle, hitTitle,
} from 'ui-shared/composables/product-hit'

/**
 * FR-28.24 — ONE result row for the two inline product searches: the name, then `SKU · unit · stock · price`.
 * The formatting is pure, so both widgets (a movement's field, a document line's description) print the same row.
 */

const fmtQty = (n: number) => String(n)
const ctx = { fmtQty, reservedLabel: (n: number) => `${n} reserved`, named: true }

describe('the search is the one both widgets have always made', () => {
  it('keeps two characters, a 300 ms pause and ten hits', () => {
    expect(SEARCH_MIN_CHARS).toBe(2)
    expect(SEARCH_DEBOUNCE_MS).toBe(300)
    expect(SEARCH_HITS).toBe(10)
  })
})

describe('the stock part of a hit', () => {
  it('says nothing when the stock is not known, rather than a zero that would read "none here"', () => {
    expect(hitStockText(undefined, ctx)).toBe('')
  })

  it('is on hand, named for the warehouse when the screen works in one', () => {
    expect(hitStockText({ quantity: 4, reserved: 0, warehouseName: 'Main' }, ctx)).toBe('Main: 4')
    expect(hitStockText({ quantity: 31, reserved: 0, warehouseName: 'Main' }, ctx)).toBe('Main: 31')
  })

  it('puts what is reserved in brackets, only when there is some (D-11)', () => {
    expect(hitStockText({ quantity: 4, reserved: 2, warehouseName: 'Main' }, ctx)).toBe('Main: 4 (2 reserved)')
    expect(hitStockText({ quantity: 4, reserved: 0, warehouseName: 'Main' }, ctx)).toBe('Main: 4')
  })

  it('is the sum, unnamed, when the screen names no warehouse', () => {
    expect(hitStockText({ quantity: 9, reserved: 0 }, { ...ctx, named: false })).toBe('9')
    // Even if a name came with it: an unnamed screen does not print one.
    expect(hitStockText({ quantity: 9, reserved: 1, warehouseName: 'Main' }, { ...ctx, named: false })).toBe('9 (1 reserved)')
  })

  it('keeps a zero when the stock IS known: none on hand is an answer', () => {
    expect(hitStockText({ quantity: 0, reserved: 0 }, { ...ctx, named: false })).toBe('0')
  })
})

describe('the price part of a hit', () => {
  const product = { sellingPrice: 0.12, purchasePrice: 0.0472, currency: 'EUR' }

  it('is the price the line starts from: the selling price on a sale, the purchase price on a bill', () => {
    expect(hitPriceText(product, 'sellingPrice', 'EUR', 'en-US')).toBe('€0.12')
    expect(hitPriceText(product, 'purchasePrice', 'EUR', 'en-US')).toBe('€0.0472')
  })

  it('names no price when the screen starts from none', () => {
    expect(hitPriceText(product, null, 'EUR', 'en-US')).toBe('')
    expect(hitPriceText(product, undefined, 'EUR', 'en-US')).toBe('')
  })

  it('leaves out a price that is not in the answer: a role that may not see it never learns it from a hit (FR-27)', () => {
    expect(hitPriceText({ sellingPrice: 3 }, 'purchasePrice', 'EUR', 'en-US')).toBe('')
    expect(hitPriceText({ purchasePrice: null }, 'purchasePrice', 'EUR', 'en-US')).toBe('')
  })

  it('keeps a price of zero: free is a price', () => {
    expect(hitPriceText({ sellingPrice: 0 }, 'sellingPrice', 'EUR', 'en-US')).toBe('€0.00')
  })

  it('uses the article\'s own currency, else the organization\'s', () => {
    expect(hitPriceText({ sellingPrice: 5, currency: 'USD' }, 'sellingPrice', 'EUR', 'en-US')).toBe('$5.00')
    expect(hitPriceText({ sellingPrice: 5 }, 'sellingPrice', 'EUR', 'en-US')).toBe('€5.00')
  })
})

describe('the row', () => {
  it('is SKU · unit · stock · price, in that order', () => {
    expect(hitSubtitle({ sku: 'PRD-0042', unit: 'pcs', stock: 'Main: 4 (2 reserved)', price: '€0.12' }))
      .toBe('PRD-0042 · pcs · Main: 4 (2 reserved) · €0.12')
  })

  it('leaves out what is not known, with no stray separators', () => {
    expect(hitSubtitle({ sku: 'PRD-0043', unit: 'pcs', price: '€0.14' })).toBe('PRD-0043 · pcs · €0.14')
    expect(hitSubtitle({ sku: 'PRD-0044' })).toBe('PRD-0044')
    expect(hitSubtitle({ sku: '', unit: ' ', stock: undefined, price: '' })).toBe('')
  })

  it('has the name as its first line', () => {
    expect(hitTitle({ name: ' Hex bolt M8x40 ' })).toBe('Hex bolt M8x40')
    expect(hitTitle({ displayName: 'Hex bolt (PRD-0042)' })).toBe('Hex bolt (PRD-0042)')
    expect(hitTitle({})).toBe('')
  })
})
