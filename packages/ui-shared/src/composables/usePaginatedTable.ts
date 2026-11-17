import { ref, isRef, watch, computed, type Ref } from 'vue'
import { httpClient } from './useHttpClient'
import { latestOnly } from './latest-only'
import { loadFailureOf, type LoadFailure } from './load-failure'
import { useListQueryState, ALLOWED_PAGE_SIZES } from './useListQueryState'
import { ALL_ROWS, LARGEST_PAGE_SIZE, pageSizeFromUrl } from './page-sizes'
import { capsOfSortKey, sortRefusal } from 'config/access'
import { accessGrant } from '../access/useAccess'

/**
 * A sort key from the address bar: well formed, and (FR-27.11.D) one the role may sort by. A `sortBy=tier_3` left in an
 * old URL by a role that no longer sees Цена 3 is dropped, and the list opens on its default sort.
 */
function sortKeyFromUrl(v: string): string | undefined {
  if (!/^[A-Za-z0-9_.]{1,60}$/.test(v)) return undefined
  return sortRefusal(accessGrant(), v) ? undefined : v
}

export interface PaginationState {
  page: number
  size: number
  sortBy: string
  sortOrder: 'asc' | 'desc'
  total: number
  totalPages: number
  /** FR-31.7: why the last request did not answer with rows (`ListScaffold` says so, with Retry); null when it did. */
  loadError?: LoadFailure | null
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
  /**
   * FR-30.7: ask for the list's rows (`fields=list`) instead of whole documents. Only for an endpoint that declares a
   * list projection (`config/list-rows`) and a grid whose cells and row actions read nothing it leaves out.
   */
  listFields?: boolean
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
    loadError: null,
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
      // FR-30.9: a remembered or bookmarked "All" opens at the largest page; "All" is offered again for a small list.
      { key: 'size', ref: sizeUrl as unknown as Ref<any>, codec: 'int', default: defaultSize, sanitize: v => pageSizeFromUrl(v, ALLOWED_PAGE_SIZES) },
      { key: 'sortBy', ref: sortByUrl as unknown as Ref<any>, default: defaultSortBy, sanitize: sortKeyFromUrl },
      { key: 'sortOrder', ref: sortOrderUrl as unknown as Ref<any>, default: defaultSortOrder, sanitize: v => (v === 'asc' || v === 'desc' ? v : undefined) },
    ])
  }

  function getUrl(): string {
    return typeof options.url === 'string' ? options.url : options.url.value
  }

  /**
   * FR-31.4: only the answer to the latest request fills the table. A slow answer to an earlier filter, page or sort
   * used to replace the rows of the one the screen shows; it is dropped now, its request aborted, and its error says
   * nothing. One wrapper per table.
   */
  const request = latestOnly((signal, url: string, params: Record<string, any>) => httpClient.get(url, { params, signal }))

  /**
   * FR-30.6: one request per list open. Vuetify's table asks for its page when it mounts (`update:options`) and the view
   * asks again in `onMounted`. The second call is the latest question (FR-31.4): it aborts the first before axios has
   * sent it, so the browser sends one request (`e2e/list-requests.spec.ts` counts them on every list the walk opens).
   */
  async function fetchItems() {
    const url = getUrl()
    if (!url || url.includes('/undefined')) return
    loading.value = true
    // Vuetify uses -1 for "All": the server takes size 0 for "All", up to its ceiling (FR-30.8).
    const wireSize = pagination.value.size === ALL_ROWS ? 0 : pagination.value.size
    const params: Record<string, any> = {
      page: pagination.value.page,
      size: wireSize,
      sortBy: pagination.value.sortBy,
      sortOrder: pagination.value.sortOrder,
      ...(filters?.value || {}),
      ...(options.listFields ? { fields: 'list' } : {}),
    }
    let answer
    try {
      answer = await request(url, params)
    } catch (e: any) {
      loading.value = false
      // FR-27.11.C.3 / D: a sort on a price the role does not see, refused by the server: the default sort instead.
      const sortBy = pagination.value.sortBy
      if (e?.response?.status === 403 && e.response.data?.code === 'capability_required' && sortBy !== defaultSortBy && capsOfSortKey(sortBy).length > 0) {
        pagination.value.sortBy = defaultSortBy
        queueMicrotask(() => void fetchItems())
        return
      }
      // FR-31.7: a list whose request failed or was refused says so, with Retry (`ListScaffold`), and never shows the
      // "no rows" state. The error used to be thrown into a call nobody awaits, and the list looked empty.
      items.value = []
      pagination.value.total = 0
      pagination.value.totalPages = 0
      pagination.value.loadError = loadFailureOf(e)
      return
    }
    // A newer request owns the rows and the spinner.
    if (!answer.latest) return
    const { data } = answer.value
    // FR-30.9: "All" on a list that grew past the ceiling was cut: the largest page instead, from the first.
    if (data.truncated && pagination.value.size === ALL_ROWS) {
      pagination.value.size = LARGEST_PAGE_SIZE
      pagination.value.page = 0
      queueMicrotask(() => void fetchItems())
      return
    }
    items.value = data[entityKey] || data.items || []
    pagination.value.total = data.total ?? 0
    pagination.value.totalPages = data.totalPages ?? 0
    pagination.value.loadError = null
    loading.value = false
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
    void fetchItems() // never rejects: a failure is `pagination.loadError`
  }

  if (isRef(options.url)) {
    watch(options.url, (newUrl, oldUrl) => {
      if (newUrl && !newUrl.includes('/undefined') && newUrl !== oldUrl) {
        pagination.value.page = 0
        void fetchItems()
      }
    })
  }

  if (filters) {
    watch(filters, () => {
      pagination.value.page = 0
      void fetchItems()
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
