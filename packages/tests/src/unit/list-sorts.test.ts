import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LIST_SORTS, chooseListSort, isListSortKey, sortableHeaders, type ListSortId } from 'config/list-sorts'
import { productColumnHeaders } from 'ui-shared/composables/product-list/useProductColumns'
import { Invoice, Product, StockLevel, StockMovement } from 'db/models'

/**
 * FR-30.2 (#795): each large list declares what it sorts by (`config/list-sorts`). The server sorts on nothing else,
 * and the grid offers nothing else. `integration/list-plans.flow.test.ts` holds each index-served key to a page read.
 */

describe('chooseListSort', () => {
  it('takes a declared key, mapped to its stored field, in the order asked', () => {
    expect(chooseListSort('invoices', 'number', 'asc')).toEqual({ key: 'number', field: 'invoiceNumber', order: 1 })
    expect(chooseListSort('movements', 'total', 'desc')).toEqual({ key: 'total', field: 'totalAmount', order: -1 })
    expect(chooseListSort('products', 'sku', undefined)).toEqual({ key: 'sku', field: 'sku', order: 1 })
  })

  it('runs the default sort for a key the list does not declare, a name looked up after the page, or nothing', () => {
    expect(chooseListSort('invoices', 'contactName', 'asc')).toEqual({ key: 'createdAt', field: 'createdAt', order: -1 })
    expect(chooseListSort('invoices', 'lines.productId', 'asc')).toEqual({ key: 'createdAt', field: 'createdAt', order: -1 })
    expect(chooseListSort('stockLevels', 'productName', 'asc')).toEqual({ key: 'createdAt', field: 'createdAt', order: -1 })
    expect(chooseListSort('products', undefined, undefined)).toEqual({ key: 'name', field: 'name', order: 1 })
    expect(chooseListSort('movements', '', 'asc')).toEqual({ key: 'date', field: 'date', order: -1 })
    expect(chooseListSort('movements', { $gt: '' }, 'asc')).toEqual({ key: 'date', field: 'date', order: -1 })
    // An inherited name is not a key.
    expect(chooseListSort('products', 'constructor', 'asc')).toEqual({ key: 'name', field: 'name', order: 1 })
  })

  it('passes the Products list\'s own sorts (price tiers, stock) through for their own path', () => {
    for (const key of ['tier_1', 'tier_delivery', 'stock', 'reserved', 'onOrder']) {
      expect(chooseListSort('products', key, 'desc')).toEqual({ key, field: key, order: -1 })
    }
    expect(isListSortKey('products', 'tier_1')).toBe(true)
    expect(isListSortKey('invoices', 'tier_1')).toBe(false)
  })
})

describe('sortableHeaders', () => {
  it('turns off the sort of a column the list does not declare, and leaves the rest as they are', () => {
    const headers = [
      { key: 'number', sortable: true },
      { key: 'contactName', sortable: true },
      { key: 'total' },
      { key: 'actions', sortable: false },
    ]
    expect(sortableHeaders('invoices', headers)).toEqual([
      { key: 'number', sortable: true },
      { key: 'contactName', sortable: false },
      { key: 'total' },
      { key: 'actions', sortable: false },
    ])
  })
})

describe('the grids offer only the sorts their list declares', () => {
  const offered = (headers: Array<{ key?: string; sortable?: boolean }>) => headers.filter((h) => h.sortable !== false).map((h) => h.key!)

  it('the Products list and its dialog', () => {
    const headers = productColumnHeaders((k) => k, { seesSuppliers: true, activeFilter: 'all' })
    expect(offered(headers).filter((k) => !isListSortKey('products', k))).toEqual([])
  })

  // The views wrap their headers in `sortableHeaders`, so a column added later is held too.
  const VIEWS: Array<[string, ListSortId]> = [
    ['invoicing-ui/src/views/SalesInvoicesView.vue', 'invoices'],
    ['invoicing-ui/src/views/PurchaseInvoicesView.vue', 'invoices'],
    ['inventory-ui/src/views/StockLevelsView.vue', 'stockLevels'],
    ['inventory-ui/src/views/MovementsView.vue', 'movements'],
  ]
  for (const [file, list] of VIEWS) {
    it(file, () => {
      const source = readFileSync(join(import.meta.dir, '..', '..', '..', file), 'utf-8')
      expect(source).toContain(`const headers = computed(() => sortableHeaders('${list}', [`)
    })
  }
})

describe('the table names indexes the schemas declare', () => {
  const MODEL: Record<ListSortId, { schema: { indexes(): Array<[Record<string, unknown>, Record<string, unknown>]> } }> = {
    products: Product, invoices: Invoice, stockLevels: StockLevel, movements: StockMovement,
  }
  /** Mongoose's name for an index: its own `name`, else the keys joined (`orgId_1_createdAt_-1`). */
  const nameOf = ([keys, opts]: [Record<string, unknown>, Record<string, unknown>]) => (opts?.name as string) ?? Object.entries(keys).map(([k, v]) => `${k}_${v}`).join('_')

  for (const list of Object.keys(LIST_SORTS) as ListSortId[]) {
    it(list, () => {
      // `tenantPlugin` adds `{ orgId }`; every other index is declared on the schema.
      const declared = new Set(MODEL[list].schema.indexes().map(nameOf))
      for (const [key, { served, field }] of Object.entries(LIST_SORTS[list].keys)) {
        if (!('index' in served)) continue
        expect({ key, index: served.index, declared: declared.has(served.index) }).toEqual({ key, index: served.index, declared: true })
        // The index orders the field the key sorts on: its first key after the equalities.
        expect({ key, orders: served.index.includes(`_${field}_`) || served.index.endsWith(`_${field}_1`) }).toEqual({ key, orders: true })
      }
      expect(Object.hasOwn(LIST_SORTS[list].keys, LIST_SORTS[list].defaultKey)).toBe(true)
    })
  }
})
