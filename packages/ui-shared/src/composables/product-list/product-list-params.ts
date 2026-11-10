/**
 * FR-28.22 — what a product list asks the server for, as pure functions of the filters.
 *
 * No Vue, no `window`: `unit/product-list-params.test.ts` holds the rules. The Products list and the
 * product dialog build their requests here, so the two cannot ask for different things.
 */

/** FR-22.48: which articles the list shows. A deactivated one only when asked for. */
export const ACTIVE_FILTERS = ['active', 'inactive', 'all'] as const
export type ActiveFilter = (typeof ACTIVE_FILTERS)[number]

/** The filters as the user has set them (the typed ones already debounced). */
export interface ProductFilterState {
  search: string
  category: string | null
  type: string | null
  tags: string[]
  /** The warehouse the user chose to RESTRICT the list to (not the one the screen's figures read). */
  warehouse: string | null
  status: ActiveFilter
  supplierIds: string[]
  noSupplier: boolean
  stockMin: string
  stockMax: string
  belowMin: boolean
  projected: boolean
}

export const DEFAULT_PRODUCT_FILTERS: ProductFilterState = {
  search: '',
  category: null,
  type: null,
  tags: [],
  warehouse: null,
  status: 'active',
  supplierIds: [],
  noSupplier: false,
  stockMin: '',
  stockMax: '',
  belowMin: false,
  projected: false,
}

/**
 * The query of `GET /warehouse/product` for the filters (FR-28.3). A supplier filter is sent only to
 * a caller who may read bills: a URL that carries one to a role that may not is ignored, not refused,
 * because the server would answer 403 and the list would not open.
 */
export function productListParams(f: ProductFilterState, opts: { seesSuppliers: boolean }): Record<string, string> {
  const p: Record<string, string> = {}
  if (f.search) p.search = f.search
  if (f.category) p.category = f.category
  if (f.type) p.type = f.type
  if (f.tags.length) p.tags = f.tags.join(',')
  if (f.warehouse) p.warehouseId = f.warehouse
  if (f.status !== 'all') p.isActive = f.status === 'active' ? 'true' : 'false'
  if (opts.seesSuppliers) {
    if (f.supplierIds.length) p.supplierId = f.supplierIds.join(',')
    if (f.noSupplier) p.noSupplier = 'true'
  }
  if (f.stockMin !== '') p.stockMin = f.stockMin
  if (f.stockMax !== '') p.stockMax = f.stockMax
  if (f.belowMin) p.belowMin = 'true'
  if (f.projected) p.basis = 'projected'
  return p
}

/**
 * The till's catalog (`GET /trade/pos/catalog`) has fewer filters: active articles only, the session
 * warehouse's stock, and the grid's own search, category, type and tags.
 */
export function tillCatalogParams(f: ProductFilterState, warehouseId?: string | null): Record<string, string> {
  const p: Record<string, string> = {}
  if (warehouseId) p.warehouseId = warehouseId
  if (f.search) p.search = f.search
  // The catalog filters `Product.category` by NAME.
  if (f.category) p.category = f.category
  if (f.type) p.type = f.type
  if (f.tags.length) p.tags = f.tags.join(',')
  return p
}

/** True when any filter narrows the list: switches the empty state to "no matches". (`projected` only changes a figure.) */
export function hasActiveProductFilters(f: ProductFilterState, opts: { seesSuppliers: boolean }): boolean {
  return !!(
    f.search || f.category || f.type || f.tags.length || f.warehouse || f.status !== 'active'
    || (opts.seesSuppliers && (f.supplierIds.length || f.noSupplier))
    || f.stockMin !== '' || f.stockMax !== '' || f.belowMin
  )
}

/** "Out of stock" is the range at 0 (FR-28.3): on while that is exactly what is set. */
export function isOutOfStockRange(f: Pick<ProductFilterState, 'stockMin' | 'stockMax'>): boolean {
  return f.stockMax === '0' && f.stockMin === ''
}
