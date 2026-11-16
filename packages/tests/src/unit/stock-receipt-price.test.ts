import { describe, it, expect } from 'bun:test'
import { ALL, NOTHING, type CapabilityId, type Grant } from 'config/access'
import { PRICE_TIER_NAMES } from 'config/constants'
import {
  STOCK_RECEIPT_PRICE_LEVELS, capOfStockReceiptLevel, startingStockReceiptLevel, stockReceiptLevelFor, stockReceiptLevelOf, visibleStockReceiptLevels,
} from 'config/stock-receipt-price'

/**
 * Owner, 2026-11-15: a supplier bill's „Складова разписка" is the sheet the warehouse prices the goods from, so the
 * print asks which price to show: „Цена на едро" until the person chooses another, and that choice is remembered.
 *
 * One list serves the dialog and the route, and one rule says who sees a level (FR-27.11). These hold both.
 */

const grant = (...caps: string[]): Grant => ({ caps: new Set(caps as CapabilityId[]) })
const keys = (levels: readonly { key: string }[]) => levels.map((l) => l.key)
const LEVEL_CAPS = ['products.price:selling', 'products.costs', 'products.price:wholesale', ...Array.from({ length: 11 }, (_, i) => `products.price:${i}`)]

describe('the levels a stock receipt can print', () => {
  it('the selling price, every canonical slot by its stored name, and "as booked" last', () => {
    expect(keys(STOCK_RECEIPT_PRICE_LEVELS)).toEqual(['selling', ...PRICE_TIER_NAMES, 'booked'])
    expect(keys(STOCK_RECEIPT_PRICE_LEVELS)).toContain('Цена на едро')
    // The slot drawn as „Цена с ТО" is a level under the name it is stored by.
    expect(keys(STOCK_RECEIPT_PRICE_LEVELS)).toContain('Доставна цена')
    expect(new Set(keys(STOCK_RECEIPT_PRICE_LEVELS)).size).toBe(STOCK_RECEIPT_PRICE_LEVELS.length)
  })

  it('each needs what the product routes ask for that figure; "as booked" asks nothing more than the print', () => {
    expect(STOCK_RECEIPT_PRICE_LEVELS.map(capOfStockReceiptLevel)).toEqual([...LEVEL_CAPS, null])
  })

  it('a key names its level; a slot is found as every reader of a slot name finds it', () => {
    expect(stockReceiptLevelOf('selling')).toEqual({ key: 'selling', kind: 'selling' })
    expect(stockReceiptLevelOf('booked')).toEqual({ key: 'booked', kind: 'booked' })
    expect(stockReceiptLevelOf('Цена на едро')).toEqual({ key: 'Цена на едро', kind: 'tier', tier: 'Цена на едро' })
    expect(stockReceiptLevelOf(' Цена2 ')?.key).toBe('Цена 2')
    // A label goes back to its slot: nothing stores or sends a label, but a person may type one.
    expect(stockReceiptLevelOf('Цена с ТО')?.key).toBe('Доставна цена')
  })

  it('anything else names no level', () => {
    for (const junk of ['', '  ', 'Цена 11', 'Price 1', 'wholesale', 'SELLING', 'purchasePrice', undefined, null, 7, ['selling'], {}]) {
      expect({ junk, level: stockReceiptLevelOf(junk) }).toEqual({ junk, level: null })
    }
  })
})

describe('who may print which level', () => {
  it('an Administrator, and a legacy role that reads products: every level', () => {
    expect(keys(visibleStockReceiptLevels(ALL))).toEqual(keys(STOCK_RECEIPT_PRICE_LEVELS))
    expect(keys(visibleStockReceiptLevels(grant(...LEVEL_CAPS)))).toEqual(keys(STOCK_RECEIPT_PRICE_LEVELS))
  })

  it('a role sees the levels it was given, in the list\'s order, and "as booked"', () => {
    const seller = grant('products.price:selling', 'products.price:1', 'products.price:2', 'products.price:other')
    expect(keys(visibleStockReceiptLevels(seller))).toEqual(['selling', 'Цена 1', 'Цена 2', 'booked'])
    // The cost slot goes with the cost figures, not with a price level.
    expect(keys(visibleStockReceiptLevels(grant('products.costs')))).toEqual(['Доставна цена', 'booked'])
  })

  it('no grant at all still has "as booked": what the print needs is asked by the route, not here', () => {
    expect(keys(visibleStockReceiptLevels(NOTHING))).toEqual(['booked'])
    expect(keys(visibleStockReceiptLevels(null))).toEqual(['booked'])
  })
})

describe('the level a print starts from', () => {
  const noWholesale = grant('products.price:selling', 'products.price:1')

  it('„Цена на едро", for whoever sees it', () => {
    expect(startingStockReceiptLevel(ALL).key).toBe('Цена на едро')
    expect(startingStockReceiptLevel(ALL, null).key).toBe('Цена на едро')
    expect(startingStockReceiptLevel(grant('products.price:wholesale', 'products.price:selling')).key).toBe('Цена на едро')
  })

  it('the first level the role sees, when it does not see „Цена на едро"', () => {
    expect(startingStockReceiptLevel(noWholesale).key).toBe('selling')
    expect(startingStockReceiptLevel(grant('products.price:3')).key).toBe('Цена 3')
    expect(startingStockReceiptLevel(NOTHING).key).toBe('booked')
  })

  it('the person\'s last choice, while it is still a level the role sees', () => {
    expect(startingStockReceiptLevel(ALL, 'Цена 4').key).toBe('Цена 4')
    expect(startingStockReceiptLevel(ALL, 'booked').key).toBe('booked')
    expect(startingStockReceiptLevel(noWholesale, 'Цена 1').key).toBe('Цена 1')
  })

  it('a remembered level that is no level any more, or one the role no longer sees, gives way to the default', () => {
    expect(startingStockReceiptLevel(ALL, 'Цена 99').key).toBe('Цена на едро')
    expect(startingStockReceiptLevel(ALL, { key: 'selling' }).key).toBe('Цена на едро')
    expect(startingStockReceiptLevel(noWholesale, 'Цена на едро').key).toBe('selling')
    expect(startingStockReceiptLevel(noWholesale, 'Цена 5').key).toBe('selling')
  })
})

describe('what a print request comes to', () => {
  const noWholesale = grant('products.price:selling', 'products.price:1')

  it('no level asked: the one the dialog would open on, so an older caller prints the default', () => {
    for (const none of [undefined, null, '']) {
      expect(stockReceiptLevelFor(ALL, none)).toEqual({ level: { key: 'Цена на едро', kind: 'tier', tier: 'Цена на едро' } })
      expect(stockReceiptLevelFor(noWholesale, none)).toEqual({ level: { key: 'selling', kind: 'selling' } })
      expect(stockReceiptLevelFor(NOTHING, none)).toEqual({ level: { key: 'booked', kind: 'booked' } })
    }
  })

  it('a level the role sees: that level', () => {
    expect(stockReceiptLevelFor(ALL, 'selling')).toEqual({ level: { key: 'selling', kind: 'selling' } })
    expect(stockReceiptLevelFor(ALL, 'Цена 7')).toEqual({ level: { key: 'Цена 7', kind: 'tier', tier: 'Цена 7' } })
    expect(stockReceiptLevelFor(noWholesale, 'Цена 1')).toEqual({ level: { key: 'Цена 1', kind: 'tier', tier: 'Цена 1' } })
    // „As booked" asks for no level of its own.
    expect(stockReceiptLevelFor(NOTHING, 'booked')).toEqual({ level: { key: 'booked', kind: 'booked' } })
  })

  it('a level the role does not see is refused by the capability it takes, never swapped for another', () => {
    expect(stockReceiptLevelFor(noWholesale, 'Цена на едро')).toEqual({ refused: 'capability_required', capability: 'products.price:wholesale' })
    expect(stockReceiptLevelFor(noWholesale, 'Доставна цена')).toEqual({ refused: 'capability_required', capability: 'products.costs' })
    expect(stockReceiptLevelFor(noWholesale, 'Цена с ТО')).toEqual({ refused: 'capability_required', capability: 'products.costs' })
    expect(stockReceiptLevelFor(grant('products.price:1'), 'selling')).toEqual({ refused: 'capability_required', capability: 'products.price:selling' })
    expect(stockReceiptLevelFor(null, 'Цена 3')).toEqual({ refused: 'capability_required', capability: 'products.price:3' })
  })

  it('a name that is no level is refused as unknown: it is not read as the default', () => {
    for (const junk of ['Цена 11', 'wholesale', 'total', '   ', 0, {}, ['selling', 'booked']]) {
      expect({ junk, answer: stockReceiptLevelFor(ALL, junk) }).toEqual({ junk, answer: { refused: 'unknown_price_level' } })
    }
  })
})
