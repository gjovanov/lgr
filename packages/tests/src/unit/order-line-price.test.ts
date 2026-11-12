import { describe, it, expect } from 'bun:test'
import {
  chargeablePrice, linePricePinned, pinnedPriceOf,
  pickLinePrice, typeLinePrice, releaseLinePrice, setLineArticle,
} from 'config/order-line-price'

/**
 * A customer order line's price is an indication (the article's selling price) until somebody chooses one: a price
 * picked from the article's prices or typed is pinned, and the order's invoice charges it. One rule, read by the
 * form (`InternalOrderFormView`), the route (`internal-order.controller#sanitizeLines`) and both conversions
 * (`lib/reservation-convert`). What the invoice then says is `integration/order-price-carry.flow.test.ts`.
 */

describe('chargeablePrice: a price that can be charged', () => {
  it('a figure above zero, as a number or as the text a field holds', () => {
    expect(chargeablePrice(8)).toBe(8)
    expect(chargeablePrice(0.0071)).toBe(0.0071)
    expect(chargeablePrice('12.5')).toBe(12.5)
  })

  it('an empty field, a zero and anything that is no figure are no choice', () => {
    for (const v of [undefined, null, '', 0, '0', -1, NaN, Infinity, 'abc', {}, []]) expect(chargeablePrice(v)).toBeUndefined()
  })
})

describe('linePricePinned: what a save leaves', () => {
  const stored = { productId: 'p1', expectedUnitPrice: 8, pricePinned: true }

  it('the save says so, either way', () => {
    expect(linePricePinned({ productId: 'p1', expectedUnitPrice: 8, pricePinned: true })).toBe(true)
    expect(linePricePinned({ productId: 'p1', expectedUnitPrice: 8, pricePinned: false }, stored)).toBe(false)
  })

  it('a line with no price to charge is never pinned, whatever the save says', () => {
    expect(linePricePinned({ productId: 'p1', pricePinned: true })).toBe(false)
    expect(linePricePinned({ productId: 'p1', expectedUnitPrice: 0, pricePinned: true })).toBe(false)
    expect(linePricePinned({ productId: 'p1', expectedUnitPrice: 0 }, stored)).toBe(false)
  })

  it('a save that does not say keeps the stored pin while the article and the price are the stored ones', () => {
    expect(linePricePinned({ productId: 'p1', expectedUnitPrice: 8 }, stored)).toBe(true)
    // An id read back from the database is not the string the body carries.
    expect(linePricePinned({ productId: 'p1', expectedUnitPrice: 8 }, { ...stored, productId: { toString: () => 'p1' } })).toBe(true)
  })

  it('a save that does not say pins nothing new: another price, another article, a line that was not pinned', () => {
    expect(linePricePinned({ productId: 'p1', expectedUnitPrice: 9 }, stored)).toBe(false)
    expect(linePricePinned({ productId: 'p2', expectedUnitPrice: 8 }, stored)).toBe(false)
    expect(linePricePinned({ productId: 'p1', expectedUnitPrice: 8 }, { ...stored, pricePinned: undefined })).toBe(false)
    expect(linePricePinned({ productId: 'p1', expectedUnitPrice: 8 })).toBe(false)
    expect(linePricePinned({ productId: 'p1', expectedUnitPrice: 8 }, null)).toBe(false)
  })
})

describe('pinnedPriceOf: what the conversion charges', () => {
  it('the line\'s price when it was chosen', () => {
    expect(pinnedPriceOf({ expectedUnitPrice: 8, pricePinned: true })).toBe(8)
  })

  it('nothing for a line that was not, or has no line, or holds a pin without a price', () => {
    expect(pinnedPriceOf({ expectedUnitPrice: 8 })).toBeUndefined()
    expect(pinnedPriceOf({ expectedUnitPrice: 8, pricePinned: false })).toBeUndefined()
    expect(pinnedPriceOf({ expectedUnitPrice: 0, pricePinned: true })).toBeUndefined()
    expect(pinnedPriceOf({ pricePinned: true })).toBeUndefined()
    expect(pinnedPriceOf(undefined)).toBeUndefined()
    expect(pinnedPriceOf(null)).toBeUndefined()
  })
})

describe('the form\'s line', () => {
  it('a pick is the line\'s price, chosen', () => {
    const line = { productId: 'p1', expectedUnitPrice: 10 }
    pickLinePrice(line, 8)
    expect(line).toEqual({ productId: 'p1', expectedUnitPrice: 8, pricePinned: true })
  })

  it('a typed price is chosen; an emptied field or a zero gives the choice back', () => {
    const line: any = { productId: 'p1', expectedUnitPrice: 10 }
    typeLinePrice(line, 12.5)
    expect(line.pricePinned).toBe(true)
    typeLinePrice(line, '')
    expect(line.pricePinned).toBeUndefined()
    typeLinePrice(line, '7')
    expect(line.pricePinned).toBe(true)
    typeLinePrice(line, 0)
    expect(line.pricePinned).toBeUndefined()
  })

  it('a release unpins, and shows the client\'s price of today when it is known', () => {
    const line: any = { productId: 'p1', expectedUnitPrice: 8, pricePinned: true }
    releaseLinePrice(line, 9)
    expect(line).toEqual({ productId: 'p1', expectedUnitPrice: 9, pricePinned: undefined })

    const kept: any = { productId: 'p1', expectedUnitPrice: 8, pricePinned: true }
    releaseLinePrice(kept)
    expect(kept).toEqual({ productId: 'p1', expectedUnitPrice: 8, pricePinned: undefined })
  })

  it('another article on a pinned line: the pin and its price go, the line starts from the new article', () => {
    const line: any = { productId: 'p1', expectedUnitPrice: 8, pricePinned: true }
    setLineArticle(line, 'p2')
    expect(line).toEqual({ productId: 'p2', expectedUnitPrice: undefined, pricePinned: undefined })

    const cleared: any = { productId: 'p1', expectedUnitPrice: 8, pricePinned: true }
    setLineArticle(cleared, undefined)
    expect(cleared).toEqual({ productId: undefined, expectedUnitPrice: undefined, pricePinned: undefined })
  })

  it('the same article again, or an article on a line that was not pinned, changes no price', () => {
    const same: any = { productId: 'p1', expectedUnitPrice: 8, pricePinned: true }
    setLineArticle(same, 'p1')
    expect(same).toEqual({ productId: 'p1', expectedUnitPrice: 8, pricePinned: true })

    const plain: any = { productId: 'p1', expectedUnitPrice: 10 }
    setLineArticle(plain, 'p2')
    expect(plain).toEqual({ productId: 'p2', expectedUnitPrice: 10 })
  })

  it('a line that was never pinned reads the same as JSON after a release: no edit is invented', () => {
    const line: any = { productId: 'p1', expectedUnitPrice: 10 }
    const before = JSON.stringify(line)
    releaseLinePrice(line)
    typeLinePrice(line, '')
    expect(JSON.stringify(line)).toBe(before)
  })
})
