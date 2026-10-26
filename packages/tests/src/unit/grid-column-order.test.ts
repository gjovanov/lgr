import { describe, it, expect } from 'bun:test'
import { orderColumnKeys } from 'ui-shared/composables/useGridColumns'

/**
 * FR-22.46 (#4.1) — the Products list's default puts „Наличност" before „Мярка", and FR-22.45
 * adds „Резервирано" and „Поръчано" after it. A user who reordered the columns keeps their order
 * (`useGridColumns` saves the whole order on the first move); the question is where the two new
 * columns land in it.
 */

const OLD = ['sku', 'name', 'category', 'type', 'unit', 'stock', 'purchasePrice', 'sellingPrice', 'isActive', 'actions']
const NEW = ['sku', 'name', 'category', 'type', 'stock', 'reserved', 'onOrder', 'unit', 'purchasePrice', 'sellingPrice', 'isActive', 'actions']

describe('columns a saved order has never seen', () => {
  it('nothing saved (or only hidden columns): the catalog order, so the new default reaches everyone', () => {
    expect(orderColumnKeys(NEW, [])).toEqual(NEW)
  })

  it('a saved order is kept, and the new columns follow the stock wherever the user put it', () => {
    // Saved under the old catalog: Мярка before Наличност, as the old default had it.
    expect(orderColumnKeys(NEW, OLD)).toEqual([
      'sku', 'name', 'category', 'type', 'unit', 'stock', 'reserved', 'onOrder', 'purchasePrice', 'sellingPrice', 'isActive', 'actions',
    ])
    // A user who had already swapped them (#4.1, by hand) and moved the stock first.
    const mine = ['stock', 'sku', 'name', 'category', 'type', 'unit', 'purchasePrice', 'sellingPrice', 'isActive', 'actions']
    expect(orderColumnKeys(NEW, mine)).toEqual([
      'stock', 'reserved', 'onOrder', 'sku', 'name', 'category', 'type', 'unit', 'purchasePrice', 'sellingPrice', 'isActive', 'actions',
    ])
  })

  it('a new first column leads, and a column the catalog dropped is gone', () => {
    expect(orderColumnKeys(['select', 'b', 'a'], ['a', 'b', 'retired'])).toEqual(['select', 'a', 'b'])
  })

  it('a saved order that names a column twice shows it once', () => {
    expect(orderColumnKeys(['a', 'b', 'c'], ['c', 'a', 'c'])).toEqual(['c', 'a', 'b'])
  })
})
