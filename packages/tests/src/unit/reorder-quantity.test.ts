import { describe, it, expect } from 'bun:test'
import { hasNoReorderLevels, reorderPosition, suggestedOrderQuantity, toOrderQuantity } from 'config/reorder-quantity'

/**
 * FR-28 D-9 — the arithmetic behind the Products list's „To order" column and the order dialog's starting quantity.
 *
 * Both read `config/reorder-quantity`: `useProductList.toOrder` for the column, `previewOrderFromProducts` for the
 * dialog. The cases below are the column's cases, and each one also asks the dialog's function, so the two cannot
 * drift: where the list shows a figure the dialog starts from it, and where the list shows a dash the dialog starts
 * from `max(1, target − position)`.
 */

const bolt = { trackInventory: true, minStockLevel: 20, maxStockLevel: 50 }
const minOnly = { trackInventory: true, minStockLevel: 5, maxStockLevel: 0 }
const maxOnly = { trackInventory: true, minStockLevel: 0, maxStockLevel: 30 }

describe('position: on hand − reserved + on order', () => {
  it('adds what is coming and takes what is held, without float noise', () => {
    expect(reorderPosition(4, 1, 10)).toBe(13)
    expect(reorderPosition(0.1, 0, 0.2)).toBe(0.3)
    expect(reorderPosition(0, 5, 0)).toBe(-5)
    expect(reorderPosition(undefined as any, null as any, NaN as any)).toBe(0)
  })
})

describe('the list\'s „To order" (toOrderQuantity)', () => {
  it('is the distance from the position to the maximum, for an article at or below its minimum', () => {
    expect(toOrderQuantity(bolt, 4)).toBe(46)
    expect(toOrderQuantity(bolt, 13)).toBe(37)
    expect(toOrderQuantity(bolt, 0)).toBe(50)
    // Below zero (more reserved than on hand): the shortfall is part of what to order.
    expect(toOrderQuantity(bolt, -3)).toBe(53)
  })

  it('goes up to the minimum when there is no maximum', () => {
    expect(toOrderQuantity(minOnly, 2)).toBe(3)
    expect(toOrderQuantity(minOnly, 0)).toBe(5)
  })

  it('has nothing to order while the position is at or above the minimum', () => {
    expect(toOrderQuantity(bolt, 20)).toBeNull()
    expect(toOrderQuantity(bolt, 35)).toBeNull()
    expect(toOrderQuantity(minOnly, 5)).toBeNull()
  })

  it('with a maximum and no minimum, orders what is missing from the maximum', () => {
    expect(toOrderQuantity(maxOnly, 10)).toBe(20)
    expect(toOrderQuantity(maxOnly, 30)).toBeNull()
    expect(toOrderQuantity(maxOnly, 45)).toBeNull()
  })

  it('has nothing to order for a service or an article with no levels', () => {
    expect(toOrderQuantity({ trackInventory: false, minStockLevel: 20, maxStockLevel: 50 }, 0)).toBeNull()
    expect(toOrderQuantity({ trackInventory: true, minStockLevel: 0, maxStockLevel: 0 }, 0)).toBeNull()
    expect(toOrderQuantity({}, 0)).toBeNull()
    expect(hasNoReorderLevels({ trackInventory: false, minStockLevel: 9 })).toBe(true)
    expect(hasNoReorderLevels({ minStockLevel: 9 })).toBe(false)
    expect(hasNoReorderLevels({ minStockLevel: null, maxStockLevel: undefined })).toBe(true)
  })
})

describe('the dialog\'s starting quantity (suggestedOrderQuantity): max(1, target − position)', () => {
  it('equals the list\'s figure wherever the list shows one', () => {
    for (const article of [bolt, minOnly, maxOnly]) {
      for (let position = -10; position <= 60; position++) {
        const shown = toOrderQuantity(article, position)
        if (shown !== null && shown >= 1) expect(suggestedOrderQuantity(article, position), `${JSON.stringify(article)} @ ${position}`).toBe(shown)
      }
    }
  })

  it('starts at 1 for a service and for an article that has no minimum or maximum', () => {
    expect(suggestedOrderQuantity({ trackInventory: false, minStockLevel: 20, maxStockLevel: 50 }, 0)).toBe(1)
    expect(suggestedOrderQuantity({ trackInventory: true, minStockLevel: 0, maxStockLevel: 0 }, 7)).toBe(1)
    expect(suggestedOrderQuantity({}, 0)).toBe(1)
  })

  it('where the list shows a dash for a ticked article it still asks for what is missing from the target, at least 1', () => {
    // Above the minimum but under the maximum: the list has nothing to order, the dialog tops up to the maximum.
    expect(toOrderQuantity(bolt, 35)).toBeNull()
    expect(suggestedOrderQuantity(bolt, 35)).toBe(15)
    // At or over the target: 1, never 0 or a negative quantity.
    expect(suggestedOrderQuantity(bolt, 50)).toBe(1)
    expect(suggestedOrderQuantity(bolt, 80)).toBe(1)
    expect(suggestedOrderQuantity(minOnly, 5)).toBe(1)
    expect(suggestedOrderQuantity(minOnly, 12)).toBe(1)
  })

  it('a missing quantity under one unit is one unit', () => {
    // The list shows the fraction; the dialog starts from a whole unit.
    expect(toOrderQuantity({ minStockLevel: 5 }, 4.6)).toBeCloseTo(0.4, 3)
    expect(suggestedOrderQuantity({ minStockLevel: 5 }, 4.6)).toBe(1)
  })

  it('never goes below 1 whatever the position', () => {
    for (const article of [bolt, minOnly, maxOnly, {}]) {
      for (const position of [-100, -1, 0, 0.5, 5, 20, 50, 1e6]) {
        expect(suggestedOrderQuantity(article, position)).toBeGreaterThanOrEqual(1)
      }
    }
  })
})
