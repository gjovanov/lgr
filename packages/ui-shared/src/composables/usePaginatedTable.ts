import { ref, isRef, watch, computed, type Ref } from 'vue'
import { httpClient } from './useHttpClient'
import { useListQueryState, ALLOWED_PAGE_SIZES } from './useListQueryState'

export interface PaginationState {
  page: number
  size: number
  sortBy: string
  sortOrder: 'asc' | 'desc'
  total: number
  totalPages: number
}

export interface UsePaginatedTableOptions {
  url: string | Ref<string>
  entityKey: string
  defaultSize?: number
  defaultSortBy?: string
  defaultSortOrder?: 'asc' | 'desc'
  filters?: Ref<Record<string, any>>
  /**
   * FR-05 (#12): reflect page/size/sortBy/sortOrder in the querystring (page is 1-based in
   * the URL). Opt-in for LIST VIEWS only — picker dialogs must never touch the URL.
   * Declare filter refs (useListQueryState) BEFORE calling this so the deep filters-watcher
   * registers against already-hydrated values.
   */
  urlSync?: boolean
}

export function usePaginatedTable(options: UsePaginatedTableOptions) {
  const {
    entityKey,
    defaultSize = 10,
    defaultSortBy = 'createdAt',
    defaultSortOrder = 'desc',
    filters,
  } = options

  const items = ref<any[]>([])
  const loading = ref(false)
  const pagination = ref<PaginationState>({
    page: 0,
    size: defaultSize,
    sortBy: defaultSortBy,
    sortOrder: defaultSortOrder,
    total: 0,
    totalPages: 0,
  })

  if (options.urlSync) {
    // Adapters expose the URL-facing shapes (1-based page) over the internal state.
    const pageUrl = computed({
      get: () => pagination.value.page + 1,
      set: (v: number) => { pagination.value.page = Math.max(0, (Number(v) || 1) - 1) },
    })
    const sizeUrl = computed({
      get: () => pagination.value.size,
      set: (v: number) => { pagination.value.size = v },
    })
    const sortByUrl = computed({
      get: () => pagination.value.sortBy,
      set: (v: string) => { pagination.value.sortBy = v },
    })
    const sortOrderUrl = computed({
      get: () => pagination.value.sortOrder,
      set: (v: 'asc' | 'desc') => { pagination.value.sortOrder = v },
    })
    useListQueryState([
      { key: 'page', ref: pageUrl as unknown as Ref<any>, codec: 'int', default: 1, sanitize: v => (v >= 1 ? v : undefined) },
      { key: 'size', ref: sizeUrl as unknown as Ref<any>, codec: 'int', default: defaultSize, sanitize: v => (ALLOWED_PAGE_SIZES.includes(v) ? v : undefined) },
      { key: 'sortBy', ref: sortByUrl as unknown as Ref<any>, default: defaultSortBy, sanitize: v => (/^[A-Za-z0-9_.]{1,60}$/.test(v) ? v : undefined) },
      { key: 'sortOrder', ref: sortOrderUrl as unknown as Ref<any>, default: defaultSortOrder, sanitize: v => (v === 'asc' || v === 'desc' ? v : undefined) },
    ])
  }

  function getUrl(): string {
    return typeof options.url === 'string' ? options.url : options.url.value
  }

  async function fetchItems() {
    const url = getUrl()
    if (!url || url.includes('/undefined')) return
    loading.value = true
    try {
      // Vuetify uses -1 for "All". Send size=0 over the wire so the server returns
      // the unbounded result set (DAL treats size <= 0 as no-pagination).
      const wireSize = pagination.value.size === -1 ? 0 : pagination.value.size
      const params: Record<string, any> = {
        page: pagination.value.page,
        size: wireSize,
        sortBy: pagination.value.sortBy,
        sortOrder: pagination.value.sortOrder,
        ...(filters?.value || {}),
      }
      const { data } = await httpClient.get(url, { params })
      items.value = data[entityKey] || data.items || []
      pagination.value.total = data.total ?? 0
      pagination.value.totalPages = data.totalPages ?? 0
    } finally {
      loading.value = false
    }
  }

  /**
   * Handler for v-data-table-server @update:options event.
   * Vuetify uses 1-indexed pages; API uses 0-indexed.
   */
  function onUpdateOptions(opts: any) {
    pagination.value.page = (opts.page ?? 1) - 1
    pagination.value.size = opts.itemsPerPage ?? defaultSize
    if (opts.sortBy?.length) {
      pagination.value.sortBy = opts.sortBy[0].key
      pagination.value.sortOrder = opts.sortBy[0].order || 'desc'
    }
    fetchItems()
  }

  if (isRef(options.url)) {
    watch(options.url, (newUrl, oldUrl) => {
      if (newUrl && !newUrl.includes('/undefined') && newUrl !== oldUrl) {
        pagination.value.page = 0
        fetchItems()
      }
    })
  }

  if (filters) {
    watch(filters, () => {
      pagination.value.page = 0
      fetchItems()
    }, { deep: true })
  }

  return {
    items,
    loading,
    pagination,
    fetchItems,
    onUpdateOptions,
  }
}
