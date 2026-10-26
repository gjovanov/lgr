<template>
  <ListScaffold
    :title="$t('nav.products')"
    :headers="headers"
    :items="items"
    :loading="loading"
    :pagination="pagination"
    :has-active-filters="hasActiveFilters"
    :empty="{ icon: 'mdi-package-variant-closed', title: $t('list.empty.products'), description: $t('list.empty.productsHint') }"
    :empty-filtered="{ title: $t('list.noMatches'), description: $t('list.adjustFilters') }"
    @update:options="onUpdateOptions"
  >
    <template #actions>
      <export-menu @export="onExport" />
      <responsive-btn color="primary" icon="mdi-plus" :to="{ name: 'inventory.products.new', params: { tab: 'edit' } }">{{ $t('common.create') }}</responsive-btn>
    </template>

    <template #filters>
      <v-card class="mb-4">
        <v-card-text class="pb-4">
          <v-row>
            <v-col cols="12" md="3">
              <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
            </v-col>
            <v-col cols="12" md="3">
              <v-autocomplete
                v-model="warehouseFilter"
                :items="warehouseOptions"
                item-title="name"
                item-value="_id"
                :label="$t('warehouse.warehouse')"
                prepend-inner-icon="mdi-warehouse"
                clearable
                hide-details
                density="compact"
              />
            </v-col>
            <v-col cols="12" md="2">
              <v-select v-model="categoryFilter" :label="$t('warehouse.category')" :items="categoryOptions" clearable hide-details density="compact" />
            </v-col>
            <v-col cols="12" md="2">
              <v-select v-model="typeFilter" :label="$t('common.type')" :items="productTypeItems(['goods', 'service'])" clearable hide-details density="compact" />
            </v-col>
            <v-col cols="12" md="2">
              <TagInput v-model="tagFilter" type="product" :org-url="appStore.orgUrl()" :label="$t('common.filterByTags')" />
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>
    </template>

    <template #item.name="{ item }">
      <entity-link :label="item.name" :to="{ name: 'inventory.products.edit', params: { id: item._id, tab: 'edit' } }" />
    </template>
    <template #item.type="{ item }">{{ productTypeLabel(item.type) }}</template>
    <template #item.stock="{ item }">
      <div class="d-flex flex-wrap ga-1 py-1">
        <v-chip
          v-for="s in stockFor(item._id)"
          :key="s.warehouseId"
          size="x-small"
          :color="s.quantity > 0 ? 'success' : 'error'"
          variant="tonal"
          :title="s.warehouseName"
        >
          {{ s.warehouseName }}: {{ fmtQty(s.quantity) }}
        </v-chip>
        <span v-if="!stockFor(item._id).length" class="text-disabled text-caption">—</span>
      </div>
    </template>
    <template #item.purchasePrice="{ item }">{{ fmtCurrency(item.purchasePrice) }}</template>
    <template #item.sellingPrice="{ item }">{{ fmtCurrency(item.sellingPrice) }}</template>
    <template #item.isActive="{ item }">
      <v-icon :color="item.isActive !== false ? 'success' : 'grey'">
        {{ item.isActive !== false ? 'mdi-check-circle' : 'mdi-close-circle' }}
      </v-icon>
    </template>
    <template #item.actions="{ item }">
      <v-btn icon="mdi-chart-box" size="small" variant="text" color="info" :title="$t('warehouse.productStock')" :to="{ name: 'inventory.products.stock', params: { id: item._id, tab: 'stock' } }" />
      <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'inventory.products.edit', params: { id: item._id, tab: 'edit' } }" />
      <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
    </template>

    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('warehouse.deleteProductConfirm') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" @click="doDelete">{{ $t('common.delete') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </ListScaffold>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { useListQueryState } from 'ui-shared/composables/useListQueryState'
import { useProductTypes } from 'ui-shared/composables/useProductTypes'
import ListScaffold from 'ui-shared/components/ListScaffold'
import ExportMenu from 'ui-shared/components/ExportMenu'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import TagInput from 'ui-shared/components/TagInput.vue'
import EntityLink from 'ui-shared/components/EntityLink'

interface Product { _id: string; sku: string; name: string; category: string; type: string; unit: string; purchasePrice: number; sellingPrice: number; isActive: boolean }
interface StockBadge { warehouseId: string; warehouseName: string; quantity: number; availableQuantity: number }

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()
const { productTypeLabel, productTypeItems } = useProductTypes()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

const { search, debouncedSearch } = useSearchDebounce()
const deleteDialog = ref(false)
const selectedId = ref('')

const categoryFilter = ref<string | null>(null)
const typeFilter = ref<string | null>(null)
const tagFilter = ref<string[]>([])
const warehouseFilter = ref<string | null>(null)
const categoryOptions = ref<string[]>([])
const warehouseOptions = ref<any[]>([])
const stockMap = ref<Record<string, StockBadge[]>>({})

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (categoryFilter.value) f.category = categoryFilter.value
  if (typeFilter.value) f.type = typeFilter.value
  if (tagFilter.value.length) f.tags = tagFilter.value.join(',')
  if (warehouseFilter.value) f.warehouseId = warehouseFilter.value
  return f
})

const hasActiveFilters = computed(() =>
  !!(debouncedSearch.value || categoryFilter.value || typeFilter.value || tagFilter.value.length || warehouseFilter.value),
)

const url = computed(() => `${appStore.orgUrl()}/warehouse/product`)
// FR-05 (#12): grid state in the querystring; declared before usePaginatedTable.
useListQueryState([
  { key: 'q', ref: search, mirror: debouncedSearch },
  { key: 'category', ref: categoryFilter },
  { key: 'type', ref: typeFilter },
  { key: 'tags', ref: tagFilter, codec: 'csv' },
  { key: 'warehouse', ref: warehouseFilter },
])

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'products',
  filters,
  urlSync: true,
})

const headers = computed(() => [
  { title: t('warehouse.sku'), key: 'sku', sortable: true },
  { title: t('common.name'), key: 'name', sortable: true },
  { title: t('warehouse.category'), key: 'category', sortable: true },
  { title: t('common.type'), key: 'type' },
  { title: t('warehouse.unit'), key: 'unit' },
  { title: t('warehouse.stock'), key: 'stock', sortable: false },
  { title: t('warehouse.purchasePrice'), key: 'purchasePrice', align: 'end' as const },
  { title: t('warehouse.sellingPrice'), key: 'sellingPrice', align: 'end' as const },
  { title: t('common.active'), key: 'isActive', align: 'center' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function fmtCurrency(amount: number) { return formatCurrency(amount, baseCurrency.value, localeCode.value) }
function fmtQty(n: number) { return new Intl.NumberFormat(localeCode.value, { maximumFractionDigits: 3 }).format(n || 0) }
function stockFor(id: string): StockBadge[] { return (stockMap.value[id] || []).filter((s) => (s.quantity || 0) !== 0) }

// After each page loads, badge the visible products' per-warehouse stock in one bulk call.
async function fetchStockBadges() {
  const ids = (items.value as Product[]).map((p) => p._id).filter(Boolean)
  if (!ids.length) { stockMap.value = {}; return }
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/stock-level/by-products`, { params: { productIds: ids.join(',') } })
    stockMap.value = data.stock || {}
  } catch { stockMap.value = {} }
}
watch(items, fetchStockBadges)

function confirmDelete(item: Product) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() {
  try {
    await httpClient.delete(`${appStore.orgUrl()}/warehouse/product/${selectedId.value}`)
    await fetchItems()
    deleteDialog.value = false
    showSuccess(t('common.deletedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}
function onExport(format: string) { console.log('Export products as', format) }

async function fetchCategories() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product-category`, { params: { isActive: 'true' } })
    categoryOptions.value = (data.productCategories || []).map((c: { name: string }) => c.name)
  } catch { /* */ }
}

async function fetchWarehouses() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/warehouse`, { params: { size: 0 } })
    warehouseOptions.value = data.warehouses || []
  } catch { /* */ }
}

onMounted(() => { fetchItems(); fetchCategories(); fetchWarehouses() })
</script>
