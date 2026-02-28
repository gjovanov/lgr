import { ref, isRef, watch, type Ref } from 'vue'
import { httpClient } from './useHttpClient'

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

  function getUrl(): string {
    return typeof options.url === 'string' ? options.url : options.url.value
  }

  async function fetchItems() {
    const url = getUrl()
    if (!url || url.includes('/undefined')) return
    loading.value = true
    try {
      const params: Record<string, any> = {
        page: pagination.value.page,
        size: pagination.value.size,
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
