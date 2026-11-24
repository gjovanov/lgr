<template>
  <!-- FR-31.19: on the shared list shell, so the list has the column picker and remembers its columns (keyed by the
       route name, `inventory.stock-levels`, which does not change). -->
  <ListScaffold
    :title="$t('nav.stockLevels')"
    :headers="headers"
    :items="items"
    :loading="loading"
    :pagination="pagination"
    :has-active-filters="hasActiveFilters"
    :empty="{ icon: 'mdi-warehouse', title: $t('list.empty.stockLevels'), description: $t('list.empty.stockLevelsHint') }"
    :empty-filtered="{ title: $t('list.noMatches'), description: $t('list.adjustFilters') }"
    @update:options="onUpdateOptions"
  >
    <template #actions>
      <!-- FR-31.11: the list's report, which exports to Excel and PDF, on the list's filters. -->
      <ReportExportButton report="stock-levels" :query="{ warehouseId: warehouseFilter, belowMin: lowStockOnly }" />
    </template>

    <template #filters>
      <v-card class="mb-4">
        <v-card-text class="pb-4">
          <v-row>
            <v-col cols="12" md="3">
              <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
            </v-col>
            <v-col cols="12" md="2">
              <v-select v-model="warehouseFilter" :label="$t('warehouse.warehouse')" :items="warehouses" item-title="name" item-value="_id" clearable hide-details density="compact" />
            </v-col>
            <v-col cols="12" md="2">
              <v-select v-model="categoryFilter" :label="$t('warehouse.category')" :items="categoryOptions" clearable hide-details density="compact" />
            </v-col>
            <v-col cols="12" md="3">
              <TagInput v-model="tagFilter" type="product" :org-url="appStore.orgUrl()" :label="$t('common.filterByTags')" />
            </v-col>
            <v-col cols="12" md="2">
              <v-switch v-model="lowStockOnly" :label="$t('warehouse.lowStockOnly')" color="warning" hide-details density="compact" />
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>
    </template>

    <template #item.productName="{ item }">
      <entity-link v-if="item.productId" :label="item.productName" :to="{ name: 'inventory.products.stock', params: { id: item.productId, tab: 'stock' } }" />
      <span v-else>{{ item.productName }}</span>
    </template>
    <template #item.quantity="{ item }">
      <span
        :class="{
          'text-error font-weight-bold': item.quantity <= (item.reorderLevel || 0),
          'text-success': item.quantity > (item.reorderLevel || 0),
        }"
      >
        {{ item.quantity }}
      </span>
    </template>
    <template #item.reorderLevel="{ item }">
      <span>{{ item.reorderLevel || '-' }}</span>
    </template>
    <template #item.value="{ item }">
      {{ fmtCurrency(item.quantity * (item.avgCost || 0)) }}
    </template>
    <template #item.status="{ item }">
      <v-chip
        size="small"
        label
        :color="item.quantity <= 0 ? 'error' : item.quantity <= (item.reorderLevel || 0) ? 'warning' : 'success'"
      >
        {{ item.quantity <= 0 ? $t('warehouse.outOfStock') : item.quantity <= (item.reorderLevel || 0) ? $t('warehouse.lowStock') : $t('warehouse.inStock') }}
      </v-chip>
    </template>
  </ListScaffold>
</template>

<script setup lang="ts">
import { intlLocale } from 'ui-shared/format'
import { ref, computed, onMounted } from 'vue'
import { useAccess } from 'ui-shared/access/useAccess'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { listWarehouses } from '../api/warehouses'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import ListScaffold from 'ui-shared/components/ListScaffold.vue'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { sortableHeaders } from 'config/list-sorts'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { useListQueryState } from 'ui-shared/composables/useListQueryState'
import ReportExportButton from 'ui-shared/components/ReportExportButton.vue'
import TagInput from 'ui-shared/components/TagInput.vue'
import EntityLink from 'ui-shared/components/EntityLink'

interface Warehouse { _id: string; name: string }

const { t } = useI18n()
// FR-27.11.D: cost figures only for a role that holds them (the server sends none otherwise).
const seesCosts = computed(() => useAccess().can('products.costs'))
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => intlLocale(appStore.locale))

const warehouses = ref<Warehouse[]>([])
const { search, debouncedSearch } = useSearchDebounce()
const warehouseFilter = ref<string | null>(null)
const categoryFilter = ref<string | null>(null)
const categoryOptions = ref<string[]>([])
const tagFilter = ref<string[]>([])
const lowStockOnly = ref(false)

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (warehouseFilter.value) f.warehouseId = warehouseFilter.value
  if (categoryFilter.value) f.category = categoryFilter.value
  if (tagFilter.value.length) f.tags = tagFilter.value.join(',')
  if (lowStockOnly.value) f.lowStockOnly = true
  return f
})
/** Any filter narrows the list: an empty answer is then "no matches", not "nothing here yet". */
const hasActiveFilters = computed(() => Object.keys(filters.value).length > 0)

const url = computed(() => `${appStore.orgUrl()}/warehouse/stock-level`)
// FR-05 (#12): grid state in the querystring; declared before usePaginatedTable.
useListQueryState([
  { key: 'q', ref: search, mirror: debouncedSearch },
  { key: 'warehouse', ref: warehouseFilter },
  { key: 'category', ref: categoryFilter },
  { key: 'tags', ref: tagFilter, codec: 'csv' },
  { key: 'low', ref: lowStockOnly, codec: 'bool', default: false },
])

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'stockLevels',
  filters,
  urlSync: true,
  // FR-30.7: rows, not whole documents.
  listFields: true,
})

// FR-30.2: a sort only on a column the list's server sorts by (`config/list-sorts`).
const headers = computed(() => sortableHeaders('stockLevels', [
  { title: t('warehouse.sku'), key: 'productSku' },
  { title: t('warehouse.product'), key: 'productName' },
  { title: t('warehouse.warehouse'), key: 'warehouseName' },
  { title: t('warehouse.quantity'), key: 'quantity', align: 'end' as const, sortable: true },
  { title: t('warehouse.reorderLevel'), key: 'reorderLevel', align: 'end' as const },
  // FR-27.11.D: the value is quantity × average cost, a cost figure.
  ...(seesCosts.value ? [{ title: t('warehouse.value'), key: 'value', align: 'end' as const }] : []),
  { title: t('common.status'), key: 'status' },
]))

function fmtCurrency(amount: number) { return formatCurrency(amount, baseCurrency.value, localeCode.value) }

async function fetchWarehouses() {
  try { warehouses.value = (await listWarehouses()).warehouses } catch { /* Reference data: a refusal leaves the choice empty, and the HTTP client says a network failure or a 5xx. */ }
}

onMounted(() => { fetchItems(); fetchWarehouses() })
</script>
