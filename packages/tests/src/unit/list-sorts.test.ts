import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { LIST_SORTS, chooseListSort, isListSortKey, sortableHeaders, type ListSortId } from 'config/list-sorts'
import { LIST_CEILING } from 'config/list-rows'
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

  it('sorts every list by the id: the one order with no ties, for what reads a whole list in pages', () => {
    for (const list of Object.keys(LIST_SORTS) as ListSortId[]) {
      expect({ list, sort: chooseListSort(list, '_id', 'asc') }).toEqual({ list, sort: { key: '_id', field: '_id', order: 1 } })
      expect({ list, sort: chooseListSort(list, '_id', 'desc') }).toEqual({ list, sort: { key: '_id', field: '_id', order: -1 } })
    }
  })
})

/**
 * The repository's own scripts and skills read these lists over the API, most of them a whole list in pages
 * (`fetchAll`). A `sortBy` a list does not declare is not refused: the list runs its default sort, and the script
 * goes on reading pages of another order than the one it asked for. So what they send is held to the table here.
 */
const ROOT = join(import.meta.dir, '..', '..', '..', '..')
/** Every TypeScript file of the scripts and the skills, with its source. */
function tooling(): Array<{ file: string; source: string }> {
  const out: Array<{ file: string; source: string }> = []
  for (const dir of ['scripts', '.claude/skills']) {
    for (const name of new Bun.Glob('**/*.ts').scanSync({ cwd: join(ROOT, dir) })) {
      const file = `${dir}/${name.replaceAll('\\', '/')}`
      out.push({ file, source: readFileSync(join(ROOT, file), 'utf-8') })
    }
  }
  return out
}

describe('the scripts and skills ask the lists only for sorts the lists declare', () => {
  const LIST_OF_ROUTE: Array<[RegExp, ListSortId]> = [
    [/\/warehouse\/product\b/, 'products'],
    [/\/invoices\b/, 'invoices'],
    [/\/warehouse\/stock-level\b/, 'stockLevels'],
    [/\/warehouse\/movement\b/, 'movements'],
  ]
  /** A route of the API that is none of the four lists: its own sorts are not this table's. */
  const OTHER_ROUTE = /\/(contacts?|invoicing\/contact|orders|internal-orders|reservations)\b/
  const ALL = Object.keys(LIST_SORTS) as ListSortId[]

  /** Each `sortBy=<key>` a file sends, with the lists its line reads: the one its route names, else all four. */
  const sent: Array<{ file: string; key: string; lists: ListSortId[] }> = []
  for (const { file, source } of tooling()) {
    for (const line of source.split('\n')) {
      for (const m of line.matchAll(/sortBy=([A-Za-z_][A-Za-z0-9_.]*)/g)) {
        const named = LIST_OF_ROUTE.filter(([route]) => route.test(line)).map(([, list]) => list)
        if (!named.length && OTHER_ROUTE.test(line)) continue
        // A helper that takes the path as a parameter (`${path}${sep}page=…`) serves every list it is handed.
        sent.push({ file, key: m[1]!, lists: named.length ? named : ALL })
      }
    }
  }

  it('some do read a whole list by the id (the test reads what it thinks it reads)', () => {
    const byId = sent.filter((s) => s.key === '_id').map((s) => s.file)
    expect(byId).toContain('scripts/compare-stock-api.ts')
    expect(byId).toContain('.claude/skills/daily-import/predict.ts')
  })

  it('and every key they send is one the list declares', () => {
    const undeclared = sent.flatMap((s) => s.lists.filter((list) => !isListSortKey(list, s.key)).map((list) => `${s.file}: sortBy=${s.key} on ${list}`))
    expect(undeclared).toEqual([])
  })
})

/**
 * FR-30.8: no list answer carries more than `LIST_CEILING` rows, and `size <= 0` no longer means "everything": the
 * answer is cut at the ceiling and says `truncated`, which a script that reads one answer never looks at. So the
 * sizes the scripts and skills write into a request are held under the ceiling here; whoever needs more reads in pages.
 */
describe('the scripts and skills ask no list for more than one answer carries', () => {
  const sizes: Array<{ file: string; size: number }> = []
  for (const { file, source } of tooling()) {
    for (const m of source.matchAll(/[?&]size=(-?\d+)/g)) sizes.push({ file, size: Number(m[1]) })
    // A whole-list reader takes its page size as a parameter: the default is what it sends.
    for (const m of source.matchAll(/function fetchAll\(.*\b(?:size|pageSize) = (\d+)/g)) sizes.push({ file, size: Number(m[1]) })
  }

  it('some do write a size, and some read at the ceiling (the test reads what it thinks it reads)', () => {
    expect(sizes.length).toBeGreaterThan(20)
    expect(sizes.filter((s) => s.size === LIST_CEILING).map((s) => s.file)).toContain('.claude/skills/daily-import/predict.ts')
    expect(sizes.filter((s) => s.size === LIST_CEILING).map((s) => s.file)).toContain('scripts/compare-stock-api.ts')
  })

  it('and none asks for everything in one answer, or for more than the ceiling', () => {
    expect(sizes.filter((s) => s.size <= 0 || s.size > LIST_CEILING).map((s) => `${s.file}: size=${s.size}`)).toEqual([])
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
    ['web/src/modules/invoicing/views/SalesInvoicesView.vue', 'invoices'],
    ['web/src/modules/invoicing/views/PurchaseInvoicesView.vue', 'invoices'],
    ['web/src/modules/inventory/views/StockLevelsView.vue', 'stockLevels'],
    ['web/src/modules/inventory/views/MovementsView.vue', 'movements'],
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
