import { describe, it, expect } from 'bun:test'
import {
  ACTIVE_FILTERS, DEFAULT_PRODUCT_FILTERS, hasActiveProductFilters, isOutOfStockRange, productListParams, tillCatalogParams,
  type ProductFilterState,
} from 'ui-shared/composables/product-list/product-list-params'

/**
 * FR-28.22 — what a product list asks the server for. The Products page and the product dialog build their
 * requests from the same function, so a filter means the same in both.
 */

const f = (over: Partial<ProductFilterState> = {}): ProductFilterState => ({ ...DEFAULT_PRODUCT_FILTERS, ...over })
const sees = { seesSuppliers: true }
const blind = { seesSuppliers: false }

describe('the request of the product list', () => {
  it('asks for active articles and nothing else when nothing is filtered', () => {
    expect(productListParams(f(), sees)).toEqual({ isActive: 'true' })
  })

  it('"all" sends no isActive at all; "inactive" asks for the deactivated', () => {
    expect(productListParams(f({ status: 'all' }), sees)).toEqual({})
    expect(productListParams(f({ status: 'inactive' }), sees)).toEqual({ isActive: 'false' })
  })

  it('sends each filter under the name the endpoint reads', () => {
    expect(productListParams(f({
      search: 'bolt', category: 'Hardware', type: 'goods', tags: ['a', 'b'], warehouse: 'w1',
    }), sees)).toEqual({ search: 'bolt', category: 'Hardware', type: 'goods', tags: 'a,b', warehouseId: 'w1', isActive: 'true' })
  })

  it('sends the supplier and quantity filters (FR-28.3)', () => {
    expect(productListParams(f({ supplierIds: ['s1', 's2'], stockMin: '1', stockMax: '5', belowMin: true, projected: true }), sees))
      .toEqual({ isActive: 'true', supplierId: 's1,s2', stockMin: '1', stockMax: '5', belowMin: 'true', basis: 'projected' })
    expect(productListParams(f({ noSupplier: true }), sees)).toEqual({ isActive: 'true', noSupplier: 'true' })
  })

  it('keeps a bound of 0: "out of stock" is the range at 0, not an empty one', () => {
    expect(productListParams(f({ stockMax: '0' }), sees)).toEqual({ isActive: 'true', stockMax: '0' })
  })

  it('drops the supplier filters for a role that may not read bills: ignored, never refused', () => {
    expect(productListParams(f({ supplierIds: ['s1'], noSupplier: true, stockMin: '2' }), blind)).toEqual({ isActive: 'true', stockMin: '2' })
  })

  it('has no ACTIVE value the URL could carry that the server would not understand', () => {
    expect([...ACTIVE_FILTERS]).toEqual(['active', 'inactive', 'all'])
  })
})

describe('the till\'s catalog', () => {
  it('has the four filters of the grid and the session warehouse, and no isActive: it lists active articles only', () => {
    expect(tillCatalogParams(f({ search: 'x', category: 'C', type: 'goods', tags: ['t'], supplierIds: ['s'], belowMin: true }), 'wh'))
      .toEqual({ warehouseId: 'wh', search: 'x', category: 'C', type: 'goods', tags: 't' })
  })

  it('sends no warehouse when the till has none', () => {
    expect(tillCatalogParams(f(), undefined)).toEqual({})
    expect(tillCatalogParams(f(), null)).toEqual({})
  })
})

describe('"are filters narrowing the list?"', () => {
  it('is false at the defaults, and for the one thing that only changes a figure (counting open orders)', () => {
    expect(hasActiveProductFilters(f(), sees)).toBe(false)
    expect(hasActiveProductFilters(f({ projected: true }), sees)).toBe(false)
  })

  it('is true for any filter that narrows, and for a status other than active', () => {
    for (const over of [
      { search: 'a' }, { category: 'C' }, { type: 'goods' }, { tags: ['t'] }, { warehouse: 'w' }, { status: 'all' as const },
      { supplierIds: ['s'] }, { noSupplier: true }, { stockMin: '0' }, { stockMax: '0' }, { belowMin: true },
    ]) expect(hasActiveProductFilters(f(over), sees)).toBe(true)
  })

  it('does not count a supplier filter a role cannot use', () => {
    expect(hasActiveProductFilters(f({ supplierIds: ['s'] }), blind)).toBe(false)
  })
})

describe('"out of stock"', () => {
  it('is the range at 0, and only that', () => {
    expect(isOutOfStockRange({ stockMin: '', stockMax: '0' })).toBe(true)
    expect(isOutOfStockRange({ stockMin: '0', stockMax: '0' })).toBe(false)
    expect(isOutOfStockRange({ stockMin: '', stockMax: '5' })).toBe(false)
    expect(isOutOfStockRange({ stockMin: '', stockMax: '' })).toBe(false)
  })
})
