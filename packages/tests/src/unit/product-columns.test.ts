import { describe, it, expect } from 'bun:test'
import { productColumnHeaders, PRODUCT_CELL_KEYS } from 'ui-shared/composables/product-list/useProductColumns'
import { TIER_COLUMNS } from 'ui-shared/composables/product-price-columns'

/**
 * FR-28.22 / .23 — the columns of the product list are defined ONCE, for the Products page and the product dialog:
 * the dialog shows what the list shows, and the user's saved choice (kept under the list's key) means the same in both.
 */

// A translator that names the key, so a title is traceable and two columns never read alike by accident.
const t = (key: string) => `‹${key}›`
const keys = (hs: any[]) => hs.map((h) => h.key)
const list = productColumnHeaders(t, { seesSuppliers: true, activeFilter: 'active' })

describe('the Products list\'s columns', () => {
  it('are, in order: article, stock, supply, suppliers, prices, tiers, then the row menu', () => {
    expect(keys(list)).toEqual([
      'sku', 'name', 'category', 'type', 'stock', 'reserved', 'onOrder',
      'suppliers', 'lastPurchase', 'lastCost', 'minStockLevel', 'toOrder',
      'unit', 'purchasePrice', 'sellingPrice',
      ...TIER_COLUMNS.map((c) => c.key),
      'actions',
    ])
  })

  it('show the supplier names, and leave the last purchase, its cost, the minimum, what to order and the cost price on the cog', () => {
    const hidden = list.filter((h) => h.defaultHidden).map((h) => h.key)
    expect(hidden).toContain('lastPurchase')
    expect(hidden).toContain('lastCost')
    expect(hidden).toContain('minStockLevel')
    expect(hidden).toContain('toOrder')
    expect(hidden).toContain('purchasePrice')
    expect(hidden).not.toContain('suppliers')
    expect(hidden).not.toContain('sellingPrice')
    expect(hidden).not.toContain('name')
  })

  it('offer no supplier column to a role that may not read bills', () => {
    const blind = productColumnHeaders(t, { seesSuppliers: false, activeFilter: 'active' })
    expect(keys(blind)).not.toContain('suppliers')
    expect(keys(blind)).not.toContain('lastPurchase')
    expect(keys(blind)).not.toContain('lastCost')
    // …and keep every other column in its place.
    expect(keys(blind)).toEqual(keys(list).filter((k) => !['suppliers', 'lastPurchase', 'lastCost'].includes(k)))
  })

  it('show who is active only when the list can hold deactivated articles', () => {
    expect(keys(list)).not.toContain('isActive')
    expect(keys(productColumnHeaders(t, { seesSuppliers: true, activeFilter: 'all' }))).toContain('isActive')
    expect(keys(productColumnHeaders(t, { seesSuppliers: true, activeFilter: 'inactive' }))).toContain('isActive')
  })

  it('draw every one of their cells but the name and the row menu with the shared cell', () => {
    for (const k of keys(list)) {
      if (k === 'name' || k === 'actions') continue
      // 'category' and 'unit' print their own text: the table\'s default cell does it.
      if (k === 'category' || k === 'unit') continue
      expect(PRODUCT_CELL_KEYS).toContain(k)
    }
  })
})

describe('the product dialog\'s columns', () => {
  const dialog = productColumnHeaders(t, { seesSuppliers: true, activeFilter: 'active', withActions: false })

  it('are the list\'s, without its row menu: same keys, same titles, same order', () => {
    expect(dialog).toEqual(list.filter((h) => h.key !== 'actions'))
  })

  it('start with the price the screen starts a line from shown: a bill starts from the cost', () => {
    const bill = productColumnHeaders(t, { seesSuppliers: true, activeFilter: 'active', withActions: false, shownByDefault: ['purchasePrice'] })
    expect(bill.find((h) => h.key === 'purchasePrice')?.defaultHidden).toBeUndefined()
    // Only that one: nothing else the list hides is shown.
    expect(bill.filter((h) => h.defaultHidden).map((h) => h.key).sort())
      .toEqual(dialog.filter((h) => h.defaultHidden && h.key !== 'purchasePrice').map((h) => h.key).sort())
  })

  it('leave the list unchanged when no price is asked for', () => {
    const sale = productColumnHeaders(t, { seesSuppliers: true, activeFilter: 'active', withActions: false, shownByDefault: ['sellingPrice'] })
    expect(sale).toEqual(dialog)
  })
})

describe('the till\'s catalog', () => {
  const till = productColumnHeaders(t, { seesSuppliers: false, activeFilter: 'active', withActions: false, source: 'till' })

  it('shows what the catalog returns: the article, its stock in the session warehouse and its price', () => {
    expect(keys(till)).toEqual(['sku', 'name', 'category', 'type', 'unit', 'stockAvailable', 'sellingPrice'])
  })

  it('sorts only by what is a field of the article: the stock and the price of the catalog are computed', () => {
    for (const h of till) {
      if (['stockAvailable', 'sellingPrice', 'unit'].includes(h.key)) expect(h.sortable).toBe(false)
    }
  })

  it('is drawn by cells that exist', () => {
    expect(PRODUCT_CELL_KEYS).toContain('stockAvailable')
  })
})
