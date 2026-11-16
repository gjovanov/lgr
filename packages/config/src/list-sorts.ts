/**
 * FR-30.2: what each large list can be sorted by, and how the database serves that sort.
 *
 * A grid column's key goes to the server as `sortBy`. Before this table a list sorted on whatever it was sent: a
 * column whose cell the server computes (a contact's name, a warehouse's name) sorted on a field no document has,
 * and every sort read the organization's whole collection to sort it in memory. Now:
 * - the server sorts on a key of its list's table and on nothing else; any other `sortBy` is the list's default sort;
 * - the grid offers a sort only on a key of the table (`sortableHeaders`);
 * - each key says how it is served:
 *   - `index`: an index whose first key is `orgId` continues with the field, so the database reads a page and not
 *     the collection (`integration/list-plans.flow.test.ts` asserts it from `explain`, by the index name given here);
 *   - `scan`: no index orders it, so the database reads every document the filter keeps and sorts them, as every sort
 *     did before FR-30. Each says why it is kept. The test holds this list as it is: a new `scan` key is a decision.
 *   - `aggregate`: a name looked up on another collection, which only an aggregation orders (`MOVEMENT_SORT_BY_REF`).
 *
 * Import-pure: the API and the grids read the same table.
 */

export type ListSortId = 'products' | 'invoices' | 'stockLevels' | 'movements'

export type SortServed =
  | { index: string }
  | { scan: string }
  | { aggregate: string }

export interface ListSortKey {
  /** The stored field the key sorts on (the grid's key when they are the same). */
  field: string
  served: SortServed
}

export interface ListSortSpec {
  /** The sort of a request that names none, or names a key outside `keys`. */
  defaultKey: string
  defaultOrder: 'asc' | 'desc'
  keys: Record<string, ListSortKey>
  /**
   * Keys served by a path of their own, before this table is read (the Products list's price-tier and stock
   * columns: FR-22, FR-28). The grid offers them; the server's own code decides them.
   */
  special?: (key: string) => boolean
}

const SCAN_FIGURE = 'a figure of the row; no index orders it, so the filtered rows are sorted in memory'
const SCAN_SMALL_DOMAIN = 'a field of a few values; an index on it would not bound a page'

/** The Products list's price-tier columns (`tier_<slot>`) and its stock columns: FR-22.44 and FR-28.3. */
const PRODUCT_SPECIAL_SORT = /^(tier_[a-z0-9_]+|stock|reserved|onOrder)$/

export const LIST_SORTS: Record<ListSortId, ListSortSpec> = {
  // `GET /warehouse/product`. The API's own default is the name, the grid asks for the newest first.
  products: {
    defaultKey: 'name',
    defaultOrder: 'asc',
    keys: {
      createdAt: { field: 'createdAt', served: { index: 'orgId_1_createdAt_-1' } },
      name: { field: 'name', served: { index: 'orgId_1_name_1' } },
      sku: { field: 'sku', served: { index: 'orgId_1_sku_1' } },
      category: { field: 'category', served: { index: 'orgId_1_category_1' } },
      type: { field: 'type', served: { scan: SCAN_SMALL_DOMAIN } },
      unit: { field: 'unit', served: { scan: SCAN_SMALL_DOMAIN } },
      isActive: { field: 'isActive', served: { scan: SCAN_SMALL_DOMAIN } },
      minStockLevel: { field: 'minStockLevel', served: { scan: SCAN_FIGURE } },
      purchasePrice: { field: 'purchasePrice', served: { scan: SCAN_FIGURE } },
      sellingPrice: { field: 'sellingPrice', served: { scan: SCAN_FIGURE } },
    },
    special: (key) => PRODUCT_SPECIAL_SORT.test(key),
  },
  // `GET /invoices`: Sales invoices, Bills, and every other list of documents (proforma, offers, cash sales).
  invoices: {
    defaultKey: 'createdAt',
    defaultOrder: 'desc',
    keys: {
      createdAt: { field: 'createdAt', served: { index: 'orgId_1_direction_1_createdAt_-1' } },
      issueDate: { field: 'issueDate', served: { index: 'orgId_1_direction_1_issueDate_-1' } },
      // The grids' № column. The stored field is `invoiceNumber` (FR-22.10).
      number: { field: 'invoiceNumber', served: { index: 'orgId_1_direction_1_invoiceNumber_1' } },
      invoiceNumber: { field: 'invoiceNumber', served: { index: 'orgId_1_direction_1_invoiceNumber_1' } },
      dueDate: { field: 'dueDate', served: { index: 'orgId_1_dueDate_1_status_1' } },
      // `{ orgId, status }` exists, but not inside a direction: Bills sorted by status read the sales documents of every
      // status that sorts first.
      status: { field: 'status', served: { scan: SCAN_SMALL_DOMAIN } },
      type: { field: 'type', served: { scan: SCAN_SMALL_DOMAIN } },
      currency: { field: 'currency', served: { scan: SCAN_SMALL_DOMAIN } },
      reference: { field: 'reference', served: { scan: 'the supplier\'s own number of a bill; no index orders it' } },
      subtotal: { field: 'subtotal', served: { scan: SCAN_FIGURE } },
      taxTotal: { field: 'taxTotal', served: { scan: SCAN_FIGURE } },
      total: { field: 'total', served: { scan: SCAN_FIGURE } },
      amountDue: { field: 'amountDue', served: { scan: SCAN_FIGURE } },
    },
  },
  // `GET /warehouse/stock-level`. The product's and the warehouse's names are looked up after the page.
  stockLevels: {
    defaultKey: 'createdAt',
    defaultOrder: 'desc',
    keys: {
      createdAt: { field: 'createdAt', served: { index: 'orgId_1_createdAt_-1' } },
      quantity: { field: 'quantity', served: { scan: SCAN_FIGURE } },
    },
  },
  // `GET /warehouse/movement`. The API's own default is the date; the grid asks for the newest made first.
  movements: {
    defaultKey: 'date',
    defaultOrder: 'desc',
    keys: {
      date: { field: 'date', served: { index: 'orgId_1_date_-1' } },
      createdAt: { field: 'createdAt', served: { index: 'orgId_1_createdAt_-1' } },
      number: { field: 'movementNumber', served: { index: 'orgId_1_movementNumber_1' } },
      type: { field: 'type', served: { index: 'orgId_1_type_1_date_-1' } },
      status: { field: 'status', served: { scan: SCAN_SMALL_DOMAIN } },
      // FR-27.11.C.2: refused to a role without the costs (`sortsByMovementTotal`), which gets the default.
      total: { field: 'totalAmount', served: { scan: SCAN_FIGURE } },
      fromWarehouseName: { field: 'fromWarehouseName', served: { aggregate: 'the warehouse\'s name, looked up' } },
      toWarehouseName: { field: 'toWarehouseName', served: { aggregate: 'the warehouse\'s name, looked up' } },
      contactName: { field: 'contactName', served: { aggregate: 'the contact\'s name, looked up' } },
    },
  },
}

export interface ChosenSort {
  /** The key as the table names it: what the list was asked for when it is declared, else the default. */
  key: string
  /** The stored field to sort on. */
  field: string
  order: 1 | -1
}

/** Is `key` a sort the list offers: a key of its table, or one of its special ones. */
export function isListSortKey(list: ListSortId, key: unknown): key is string {
  const spec = LIST_SORTS[list]
  return typeof key === 'string' && (Object.hasOwn(spec.keys, key) || !!spec.special?.(key))
}

/**
 * The sort a list runs for `sortBy` and `sortOrder` as a request sent them. A key outside the list's table is its
 * default sort, in the default order (`sortOrder` is about the column that was asked for). A special key is returned
 * as it was asked, with `field` = the key, for the list's own path to take.
 */
export function chooseListSort(list: ListSortId, sortBy: unknown, sortOrder: unknown): ChosenSort {
  const spec = LIST_SORTS[list]
  const order = (o: unknown, fallback: 'asc' | 'desc'): 1 | -1 => (o === 'asc' ? 1 : o === 'desc' ? -1 : fallback === 'asc' ? 1 : -1)
  if (isListSortKey(list, sortBy) && sortBy) {
    const declared = spec.keys[sortBy]
    return { key: sortBy, field: declared?.field ?? sortBy, order: order(sortOrder, spec.defaultOrder) }
  }
  return { key: spec.defaultKey, field: spec.keys[spec.defaultKey]!.field, order: order(undefined, spec.defaultOrder) }
}

/**
 * The grid's headers with a sort offered only on the list's keys. A header that already says `sortable: false` stays
 * so; one that names no key of the table (a name the server looks up after the page) is made `sortable: false`.
 */
export function sortableHeaders<H extends { key?: string; sortable?: boolean }>(list: ListSortId, headers: readonly H[]): H[] {
  return headers.map((h) => (h.sortable !== false && !isListSortKey(list, h.key) ? { ...h, sortable: false } : h))
}
