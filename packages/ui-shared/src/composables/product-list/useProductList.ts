import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useAccess } from '../../access/useAccess'
import { httpClient } from '../useHttpClient'
import { useListQueryState } from '../useListQueryState'
import { useSearchDebounce } from '../useSearchDebounce'
import { formatUnitPrice } from '../product-price-columns'
import type { PaginationState } from '../usePaginatedTable'
import {
  ACTIVE_FILTERS,
  hasActiveProductFilters,
  isOutOfStockRange,
  productListParams,
  tillCatalogParams,
  type ActiveFilter,
  type ProductFilterState,
} from './product-list-params'
import { NO_SUPPLY, type ProductRow, type StockBadge, type SupplierFact, type SupplyTotals } from './types'

/**
 * FR-28.22 — ONE engine behind every product list: the Products page and the product dialog (and the
 * dialog's till flavour). Before it, each built its own: its own filters, its own request, its own idea
 * of "active", and no way to say "below minimum". Now the dialog is the list in a window: it shows what
 * the list shows because it IS the list, and the two cannot drift.
 *
 * What it owns: the filters (and, for the page, their place in the URL), the request and its paging, the
 * three side calls that fill a page's cells (stock and supply, supplier facts), and what a cell needs to
 * say. What it leaves to its caller: the table, the row's actions, what a pick does.
 *
 * Returned as a `reactive` object so a child (`ProductFilterBar`, `ProductCell`) can `v-model` straight
 * onto it (`list.search`) without unwrapping refs.
 */

/** How many suppliers a cell names before "+N". */
export const SUPPLIERS_SHOWN = 2
/** The API's cap on articles per supplier call; a page of "All" goes in chunks. */
const SUPPLIER_CALL_SIZE = 100

export interface UseProductListOptions {
  orgUrl: () => string
  baseCurrency: () => string
  /** A BCP 47 tag (`en-US`), for dates, quantities and prices. */
  locale: () => string
  /** `till`: the cash register's catalog (active articles, the session warehouse's stock). */
  source?: 'products' | 'till'
  /** The page keeps its state in the querystring (FR-05). A dialog never does. */
  urlSync?: boolean
  defaultSize?: number
  defaultSortBy?: string
  defaultSortOrder?: 'asc' | 'desc'
  /**
   * The warehouse whose stock the cells show. It SCOPES the figures and never restricts the rows: a
   * receipt adds articles that have no stock there yet. (The Warehouse filter is what restricts.)
   */
  stockWarehouseId?: () => string | null | undefined
  /** Whether the Suppliers column is shown. Its facts are fetched only then (the page always shows it). */
  wantSupplierFacts?: () => boolean
}

/** A till catalog row as the list's own row. */
function tillRow(r: any): ProductRow {
  return {
    _id: String(r.productId),
    sku: r.sku || '',
    name: r.productName || '',
    category: r.category || '',
    type: r.type || 'goods',
    unit: r.unit || '',
    purchasePrice: 0,
    sellingPrice: Number(r.unitPrice) || 0,
    taxRate: r.taxRate,
    isActive: true,
    stockAvailable: r.stockAvailable ?? null,
    raw: r,
  }
}

export function useProductList(opts: UseProductListOptions) {
  const source = opts.source ?? 'products'
  const access = useAccess()
  // FR-28.6: supplier facts are incoming-document data (`bills.view`, the server's rule too): a role without it is
  // offered no Suppliers, Last purchase or Last cost column, and no supplier filter. The price is a cost figure,
  // which FR-27 will give its own right (`products.costs`); until the catalogue has it, whoever reads bills reads it.
  const seesSuppliers = source === 'products' && access.can('bills.view')

  // ── the filters ──
  const { search, debouncedSearch } = useSearchDebounce()
  const categoryFilter = ref<string | null>(null)
  const typeFilter = ref<string | null>(null)
  const tagFilter = ref<string[]>([])
  const warehouseFilter = ref<string | null>(null)
  const activeFilter = ref<ActiveFilter>('active')
  // FR-28.3: the supplier ids and the two stock bounds are what the user chose; the bounds are typed, so they are
  // debounced like the search is.
  const supplierFilter = ref<string[]>([])
  const noSupplier = ref(false)
  const { search: stockMin, debouncedSearch: debouncedStockMin } = useSearchDebounce(500)
  const { search: stockMax, debouncedSearch: debouncedStockMax } = useSearchDebounce(500)
  const belowMin = ref(false)
  const projected = ref(false)

  const filterState = computed<ProductFilterState>(() => ({
    search: debouncedSearch.value,
    category: categoryFilter.value,
    type: typeFilter.value,
    tags: tagFilter.value,
    warehouse: warehouseFilter.value,
    status: activeFilter.value,
    supplierIds: supplierFilter.value,
    noSupplier: noSupplier.value,
    stockMin: debouncedStockMin.value,
    stockMax: debouncedStockMax.value,
    belowMin: belowMin.value,
    projected: projected.value,
  }))
  const filters = computed(() => (
    source === 'till'
      ? tillCatalogParams(filterState.value, opts.stockWarehouseId?.())
      : productListParams(filterState.value, { seesSuppliers })
  ))
  const hasActiveFilters = computed(() => hasActiveProductFilters(filterState.value, { seesSuppliers }))

  /** "Out of stock" is the range at 0 (FR-28.3): on while that is exactly what is set. */
  const outOfStockOn = computed(() => isOutOfStockRange({ stockMin: debouncedStockMin.value, stockMax: debouncedStockMax.value }))
  function toggleOutOfStock() {
    if (outOfStockOn.value) {
      stockMax.value = ''
    } else {
      stockMin.value = ''
      stockMax.value = '0'
    }
  }
  // A supplier or "no supplier", not both: together they match nothing, so choosing one clears the other.
  watch(noSupplier, (on) => { if (on) supplierFilter.value = [] })

  // ── paging ──
  const defaultSize = opts.defaultSize ?? 10
  const defaultSortBy = opts.defaultSortBy ?? 'createdAt'
  const defaultSortOrder = opts.defaultSortOrder ?? 'desc'
  const items = ref<ProductRow[]>([])
  const loading = ref(false)
  const pagination = ref<PaginationState>({
    page: 0, size: defaultSize, sortBy: defaultSortBy, sortOrder: defaultSortOrder, total: 0, totalPages: 0,
  })

  // FR-05 (#12): grid state in the querystring. The filters are declared first, so they are hydrated before the
  // paging's own watcher registers and nothing fires a spurious page reset and second fetch on mount.
  if (opts.urlSync && source === 'products') {
    useListQueryState([
      { key: 'q', ref: search, mirror: debouncedSearch },
      { key: 'category', ref: categoryFilter },
      { key: 'type', ref: typeFilter },
      { key: 'tags', ref: tagFilter, codec: 'csv' },
      { key: 'warehouse', ref: warehouseFilter },
      // The default is declared, so a bare URL stays bare and means "active articles".
      { key: 'status', ref: activeFilter, default: 'active', sanitize: (v) => ((ACTIVE_FILTERS as readonly string[]).includes(v) ? v : undefined) },
      // FR-28.3: what to buy again. A bound that is no number is dropped from the URL, as the server drops it.
      { key: 'supplier', ref: supplierFilter, codec: 'csv' },
      { key: 'noSupplier', ref: noSupplier, codec: 'bool' },
      { key: 'stockMin', ref: stockMin, mirror: debouncedStockMin, sanitize: (v) => (Number.isFinite(Number(v)) ? String(v) : undefined) },
      { key: 'stockMax', ref: stockMax, mirror: debouncedStockMax, sanitize: (v) => (Number.isFinite(Number(v)) ? String(v) : undefined) },
      { key: 'belowMin', ref: belowMin, codec: 'bool' },
      { key: 'projected', ref: projected, codec: 'bool' },
    ])
    // The paging, in the URL's own terms (`page` is 1-based there). The same four keys `usePaginatedTable` declares.
    const pageUrl = computed({ get: () => pagination.value.page + 1, set: (v: number) => { pagination.value.page = Math.max(0, (Number(v) || 1) - 1) } })
    const sizeUrl = computed({ get: () => pagination.value.size, set: (v: number) => { pagination.value.size = v } })
    const sortByUrl = computed({ get: () => pagination.value.sortBy, set: (v: string) => { pagination.value.sortBy = v } })
    const sortOrderUrl = computed({ get: () => pagination.value.sortOrder, set: (v: 'asc' | 'desc') => { pagination.value.sortOrder = v } })
    useListQueryState([
      { key: 'page', ref: pageUrl as any, codec: 'int', default: 1, sanitize: (v) => (v >= 1 ? v : undefined) },
      { key: 'size', ref: sizeUrl as any, codec: 'int', default: defaultSize, sanitize: (v) => ([10, 25, 50, 100, -1].includes(v) ? v : undefined) },
      { key: 'sortBy', ref: sortByUrl as any, default: defaultSortBy, sanitize: (v) => (/^[A-Za-z0-9_.]{1,60}$/.test(v) ? v : undefined) },
      { key: 'sortOrder', ref: sortOrderUrl as any, default: defaultSortOrder, sanitize: (v) => (v === 'asc' || v === 'desc' ? v : undefined) },
    ])
  }

  const url = computed(() => (source === 'till' ? `${opts.orgUrl()}/trade/pos/catalog` : `${opts.orgUrl()}/warehouse/product`))

  /**
   * One request in flight per set of parameters, and only the newest answer counts. A table asks for its page
   * when it mounts (Vuetify's first `update:options`) and its owner asks for it when it opens; those are one
   * request, not two (FR-28.29 counts them). A slower answer for earlier filters never overwrites the current one.
   */
  let requestSeq = 0
  let inFlight: Promise<void> | null = null
  let inFlightKey = ''
  let inFlightSeq = 0
  async function fetchItems(): Promise<void> {
    const endpoint = url.value
    if (!endpoint || endpoint.includes('/undefined')) return
    // Vuetify uses -1 for "All": the server takes size 0 for "no paging". The till's catalog has no "All".
    const wireSize = source === 'till'
      ? Math.min(200, Math.max(1, pagination.value.size > 0 ? pagination.value.size : 24))
      : (pagination.value.size === -1 ? 0 : pagination.value.size)
    const params: Record<string, any> = {
      page: pagination.value.page,
      size: wireSize,
      sortBy: pagination.value.sortBy,
      sortOrder: pagination.value.sortOrder,
      ...filters.value,
    }
    const key = JSON.stringify([endpoint, params])
    if (inFlight && inFlightKey === key) return inFlight
    const mine = ++requestSeq
    inFlightKey = key
    inFlightSeq = mine
    loading.value = true
    const run = (async () => {
      try {
        const { data } = await httpClient.get(endpoint, { params })
        if (mine !== requestSeq) return
        const rows: any[] = data.products || data.items || []
        items.value = source === 'till' ? rows.map(tillRow) : rows
        pagination.value.total = data.total ?? 0
        pagination.value.totalPages = data.totalPages ?? 0
      } finally {
        if (mine === requestSeq) loading.value = false
        // Only the request that is still THE one in flight clears the marker (a newer one has replaced it).
        if (inFlightSeq === mine) { inFlight = null; inFlightKey = '' }
      }
    })()
    inFlight = run
    return run
  }

  /** Handler for a Vuetify server table's `@update:options`: its pages are 1-based, the API's 0-based. */
  function onUpdateOptions(o: any) {
    pagination.value.page = (o.page ?? 1) - 1
    pagination.value.size = o.itemsPerPage ?? defaultSize
    if (o.sortBy?.length) {
      pagination.value.sortBy = o.sortBy[0].key
      pagination.value.sortOrder = o.sortBy[0].order || 'desc'
    }
    return fetchItems()
  }

  /** While a dialog is being reset to what it opens with, the filter watcher must not fetch what the open fetches. */
  let quiet = false
  watch(filters, () => {
    if (quiet) return
    pagination.value.page = 0
    void fetchItems()
  }, { deep: true })

  // ── what the cells say: stock, supply, suppliers ──
  const stockMap = ref<Record<string, StockBadge[]>>({})
  const supplyMap = ref<Record<string, SupplyTotals>>({})
  const supplierMap = ref<Record<string, SupplierFact[]>>({})
  const supplierCounts = ref<Record<string, number>>({})
  /** The last call for supplier facts failed: the cells say so, instead of a dash that would read "nobody". */
  const supplierFailed = ref(false)

  // After each page loads, badge the visible products' per-warehouse stock — and what is reserved and on order
  // (FR-22.45) — in one bulk call. With a warehouse chosen (the filter, or the screen's own), all of it is that
  // warehouse's. A slower answer for an earlier page never overwrites the current one.
  let stockRequest = 0
  async function fetchStockBadges() {
    if (source === 'till') return
    const ids = items.value.map((p) => p._id).filter(Boolean)
    const mine = ++stockRequest
    if (!ids.length) { stockMap.value = {}; supplyMap.value = {}; return }
    try {
      const params: Record<string, string> = { productIds: ids.join(',') }
      const warehouseId = warehouseFilter.value || opts.stockWarehouseId?.()
      if (warehouseId) params.warehouseId = warehouseId
      const { data } = await httpClient.get(`${opts.orgUrl()}/warehouse/stock-level/by-products`, { params })
      if (mine !== stockRequest) return
      stockMap.value = data.stock || {}
      supplyMap.value = data.supply || {}
    } catch {
      if (mine !== stockRequest) return
      stockMap.value = {}
      supplyMap.value = {}
    }
  }

  // FR-28.6: one call per page, like the stock badges; a page of "All" goes in chunks of the API's cap. A failure
  // leaves the list usable, and the cells say they could not be loaded: a dash would say "nobody".
  let factsRequest = 0
  async function fetchSupplierFacts() {
    if (!seesSuppliers || (opts.wantSupplierFacts && !opts.wantSupplierFacts())) return
    const ids = items.value.map((p) => p._id).filter(Boolean)
    const mine = ++factsRequest
    supplierFailed.value = false
    supplierMap.value = {}
    supplierCounts.value = {}
    if (!ids.length) return
    try {
      const chunks: string[][] = []
      for (let i = 0; i < ids.length; i += SUPPLIER_CALL_SIZE) chunks.push(ids.slice(i, i + SUPPLIER_CALL_SIZE))
      const answers = await Promise.all(chunks.map((c) => httpClient.get(`${opts.orgUrl()}/warehouse/product-supplier/by-products`, { params: { productIds: c.join(',') } })))
      if (mine !== factsRequest) return
      const suppliers: Record<string, SupplierFact[]> = {}
      const counts: Record<string, number> = {}
      for (const { data } of answers) {
        Object.assign(suppliers, data.suppliers || {})
        Object.assign(counts, data.counts || {})
      }
      supplierMap.value = suppliers
      supplierCounts.value = counts
    } catch {
      if (mine === factsRequest) supplierFailed.value = true
    }
  }
  watch(items, () => { void fetchStockBadges() })
  watch(items, () => { void fetchSupplierFacts() })

  // ── the choices the filters offer ──
  const categoryOptions = ref<string[]>([])
  const warehouseOptions = ref<any[]>([])
  const supplierSearch = ref('')
  const supplierOptions = ref<Array<{ _id: string; name: string }>>([])
  const loadingSuppliers = ref(false)

  async function fetchCategories() {
    try {
      const { data } = await httpClient.get(`${opts.orgUrl()}/warehouse/product-category`, { params: { isActive: 'true' } })
      categoryOptions.value = (data.productCategories || []).map((c: { name: string }) => c.name)
    } catch { /* */ }
  }
  async function fetchWarehouses() {
    try {
      const { data } = await httpClient.get(`${opts.orgUrl()}/warehouse/warehouse`, { params: { size: 0 } })
      warehouseOptions.value = data.warehouses || []
    } catch { /* */ }
  }

  // The supplier filter's choices: the first suppliers, then whatever is typed (server-side, so a thousand suppliers
  // are never loaded). The ids a pasted URL carries are named one by one, since the search may not return them.
  const contactName = (c: any): string => c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c._id
  function addSupplierOptions(rows: any[]) {
    const known = new Map(supplierOptions.value.map((o) => [o._id, o]))
    for (const c of rows) if (c?._id) known.set(c._id, { _id: c._id, name: contactName(c) })
    supplierOptions.value = [...known.values()]
  }
  let supplierSearchRequest = 0
  let supplierSearchTimer: ReturnType<typeof setTimeout> | null = null
  async function searchSuppliers(q: string) {
    const mine = ++supplierSearchRequest
    loadingSuppliers.value = true
    try {
      const { data } = await httpClient.get(`${opts.orgUrl()}/invoicing/contact`, {
        params: { type: 'supplier', size: 20, sortBy: 'companyName', sortOrder: 'asc', ...(q ? { search: q } : {}) },
      })
      if (mine === supplierSearchRequest) addSupplierOptions(data.contacts || [])
    } catch { /* the filter keeps what it has */ } finally {
      if (mine === supplierSearchRequest) loadingSuppliers.value = false
    }
  }
  watch(supplierSearch, (q) => {
    if (supplierSearchTimer) clearTimeout(supplierSearchTimer)
    supplierSearchTimer = setTimeout(() => searchSuppliers(q || ''), 300)
  })
  async function nameChosenSuppliers() {
    const missing = supplierFilter.value.filter((id) => !supplierOptions.value.some((o) => o._id === id))
    await Promise.all(missing.map(async (id) => {
      try {
        const { data } = await httpClient.get(`${opts.orgUrl()}/invoicing/contact/${id}`)
        addSupplierOptions([data.contact])
      } catch { /* an id that is no contact keeps its id as its name */ }
    }))
  }
  let suppliersLoaded_ = false
  /** The supplier filter's first choices, once. The page asks at once; the dialog asks when the filter is first used. */
  async function ensureSupplierOptions() {
    if (!seesSuppliers || suppliersLoaded_) return
    suppliersLoaded_ = true
    await Promise.all([searchSuppliers(''), nameChosenSuppliers()])
  }
  let optionsLoaded = false
  /** The categories and warehouses the filters offer, once per list. */
  async function loadOptions() {
    if (optionsLoaded) return
    optionsLoaded = true
    await Promise.all([fetchCategories(), source === 'products' ? fetchWarehouses() : Promise.resolve()])
  }

  /** The page's start: its first page, and what its filters offer. */
  function start() {
    void fetchItems()
    void loadOptions()
    if (seesSuppliers) void ensureSupplierOptions()
  }

  /**
   * A dialog opens FRESH (filters as the screen has them, a typed search carried in, the first page) and asks for
   * exactly one page. The filter watcher is held until the reset has settled, so what changes the filters does not
   * also fetch.
   */
  function openFresh(init: { search?: string } = {}) {
    quiet = true
    const text = init.search ?? ''
    search.value = text
    debouncedSearch.value = text
    categoryFilter.value = null
    typeFilter.value = null
    tagFilter.value = []
    warehouseFilter.value = null
    activeFilter.value = 'active'
    supplierFilter.value = []
    noSupplier.value = false
    stockMin.value = ''
    debouncedStockMin.value = ''
    stockMax.value = ''
    debouncedStockMax.value = ''
    belowMin.value = false
    projected.value = false
    pagination.value.page = 0
    pagination.value.sortBy = defaultSortBy
    pagination.value.sortOrder = defaultSortOrder
    void nextTick(() => { quiet = false })
    void fetchItems()
    void loadOptions()
  }

  // ── what a cell says ──
  const fmtPrice = (amount: number, currency?: string) => formatUnitPrice(amount, currency || opts.baseCurrency() || 'EUR', opts.locale())
  const fmtDate = (iso: string) => (iso ? new Date(iso).toLocaleDateString(opts.locale()) : '')
  const fmtQty = (n: number) => new Intl.NumberFormat(opts.locale(), { maximumFractionDigits: 3 }).format(n || 0)
  const stockFor = (id: string): StockBadge[] => (stockMap.value[id] || []).filter((s) => (s.quantity || 0) !== 0)
  const supplyFor = (id: string): SupplyTotals => supplyMap.value[id] || NO_SUPPLY
  const factsOf = (id: string): SupplierFact[] => supplierMap.value[id] || []
  const suppliersLoaded = (id: string): boolean => id in supplierMap.value
  /** The suppliers beyond the ones named in the cell: the server's count, not just what it sent (five at most). */
  const moreSuppliers = (id: string): number => Math.max(0, (supplierCounts.value[id] ?? factsOf(id).length) - SUPPLIERS_SHOWN)

  /**
   * What to order to be back at the maximum (the minimum when there is none): `target − position`, where the
   * position is on hand − reserved + on order, scoped as the list is (the warehouse filter). Only an article at or
   * below its minimum has anything to order, and a service never does. The order dialog of FR-28.16 starts from
   * the same figure (`max(1, target − position)`).
   */
  function toOrder(item: ProductRow): number | null {
    const min = Number(item.minStockLevel) || 0
    const max = Number(item.maxStockLevel) || 0
    if (item.trackInventory === false || (!min && !max)) return null
    const onHand = (stockMap.value[item._id] || []).reduce((sum, s) => sum + (s.quantity || 0), 0)
    const supply = supplyFor(item._id)
    const position = onHand - supply.reserved + supply.incoming
    if (min > 0 && position >= min) return null
    const quantity = (max > 0 ? max : min) - position
    return quantity > 0 ? quantity : null
  }

  return reactive({
    source,
    seesSuppliers,
    // filters
    search, debouncedSearch, categoryFilter, typeFilter, tagFilter, warehouseFilter, activeFilter,
    supplierFilter, noSupplier, supplierSearch, stockMin, stockMax, belowMin, projected,
    outOfStockOn, toggleOutOfStock, filters, hasActiveFilters,
    // the table
    items, loading, pagination, fetchItems, onUpdateOptions,
    // the choices the filters offer
    categoryOptions, warehouseOptions, supplierOptions, loadingSuppliers, loadOptions, ensureSupplierOptions,
    // lifecycle
    start, openFresh,
    // what a cell says
    supplierFailed, fetchSupplierFacts, fmtPrice, fmtDate, fmtQty, stockFor, supplyFor, factsOf, suppliersLoaded, moreSuppliers, toOrder,
  })
}

export type ProductList = ReturnType<typeof useProductList>
