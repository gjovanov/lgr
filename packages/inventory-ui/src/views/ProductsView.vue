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
            <v-col cols="12" md="2">
              <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
            </v-col>
            <v-col cols="12" md="2">
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
            <v-col cols="12" md="2">
              <!-- FR-22.48: a deactivated article stays out of the list unless this asks for it. -->
              <v-select v-model="activeFilter" :label="$t('common.status')" :items="activeFilterItems" hide-details density="compact" />
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
    <!--
      FR-22.45 (#203.8, #4.5): held for clients, and ordered from suppliers but not yet here. Each
      figure opens the article's stock tab, which lists the reservations and the orders behind it.
    -->
    <template #item.reserved="{ item }">
      <entity-link
        v-if="supplyFor(item._id).reserved"
        :label="fmtQty(supplyFor(item._id).reserved)"
        :to="stockTab(item)"
        :aria-label="`${$t('warehouse.supply.reserved')}: ${fmtQty(supplyFor(item._id).reserved)}`"
      />
      <span v-else class="text-disabled">—</span>
    </template>
    <template #item.onOrder="{ item }">
      <template v-if="supplyFor(item._id).incoming">
        <entity-link
          :label="fmtQty(supplyFor(item._id).incoming)"
          :to="stockTab(item)"
          :aria-label="`${$t('warehouse.supply.onOrder')}: ${fmtQty(supplyFor(item._id).incoming)}`"
        />
        <div v-if="supplyFor(item._id).reservedIncoming" class="text-caption text-medium-emphasis text-no-wrap">
          {{ $t('warehouse.supply.reservedIncoming') }}: {{ fmtQty(supplyFor(item._id).reservedIncoming) }}
        </div>
      </template>
      <span v-else class="text-disabled">—</span>
    </template>
    <template #item.purchasePrice="{ item }">{{ fmtCurrency(item.purchasePrice) }}</template>
    <template #item.sellingPrice="{ item }">{{ fmtCurrency(item.sellingPrice) }}</template>
    <template #item.isActive="{ item }">
      <v-icon :color="item.isActive !== false ? 'success' : 'grey'">
        {{ item.isActive !== false ? 'mdi-check-circle' : 'mdi-close-circle' }}
      </v-icon>
    </template>
    <template #item.actions="{ item }">
      <!-- FR-22.23 / .47: the row's actions in one menu — the article's pages, the documents it
           starts („Заприходи", „Продай", „Резервирай"), and Delete apart. -->
      <RowActionsMenu :actions="rowActions(item)" />
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
import RowActionsMenu, { type RowAction } from 'ui-shared/components/RowActionsMenu.vue'
import { useProductDocActions } from '../composables/useProductDocActions'

interface Product { _id: string; sku: string; name: string; category: string; type: string; unit: string; purchasePrice: number; sellingPrice: number; isActive: boolean; trackInventory?: boolean }
interface StockBadge { warehouseId: string; warehouseName: string; quantity: number; availableQuantity: number }
/** `getProductsSupplyTotals` — the definitions of the product's stock tab, summed. */
interface SupplyTotals { reserved: number; incoming: number; reservedIncoming: number; planned: number }
const NO_SUPPLY: SupplyTotals = { reserved: 0, incoming: 0, reservedIncoming: 0, planned: 0 }

/** FR-22.48: which articles the list shows. A deactivated one only when asked for. */
const ACTIVE_FILTERS = ['active', 'inactive', 'all'] as const
type ActiveFilter = (typeof ACTIVE_FILTERS)[number]

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
const activeFilter = ref<ActiveFilter>('active')
const categoryOptions = ref<string[]>([])
const warehouseOptions = ref<any[]>([])
const stockMap = ref<Record<string, StockBadge[]>>({})
const supplyMap = ref<Record<string, SupplyTotals>>({})

const activeFilterItems = computed(() => [
  { title: t('warehouse.activeFilter.active'), value: 'active' },
  { title: t('warehouse.activeFilter.inactive'), value: 'inactive' },
  { title: t('common.all'), value: 'all' },
])

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (categoryFilter.value) f.category = categoryFilter.value
  if (typeFilter.value) f.type = typeFilter.value
  if (tagFilter.value.length) f.tags = tagFilter.value.join(',')
  if (warehouseFilter.value) f.warehouseId = warehouseFilter.value
  if (activeFilter.value !== 'all') f.isActive = activeFilter.value === 'active' ? 'true' : 'false'
  return f
})

const hasActiveFilters = computed(() =>
  !!(debouncedSearch.value || categoryFilter.value || typeFilter.value || tagFilter.value.length || warehouseFilter.value || activeFilter.value !== 'active'),
)

const url = computed(() => `${appStore.orgUrl()}/warehouse/product`)
// FR-05 (#12): grid state in the querystring; declared before usePaginatedTable.
useListQueryState([
  { key: 'q', ref: search, mirror: debouncedSearch },
  { key: 'category', ref: categoryFilter },
  { key: 'type', ref: typeFilter },
  { key: 'tags', ref: tagFilter, codec: 'csv' },
  { key: 'warehouse', ref: warehouseFilter },
  // The default is declared, so a bare URL stays bare and means "active articles".
  { key: 'status', ref: activeFilter, default: 'active', sanitize: (v) => (ACTIVE_FILTERS.includes(v) ? v : undefined) },
])

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'products',
  filters,
  urlSync: true,
})

// FR-22.46 (#4.1): stock before unit, and what is reserved and on order right after the stock.
// A user who reordered the columns keeps their order; the two new ones join it after „Наличност"
// (useGridColumns).
const headers = computed(() => [
  { title: t('warehouse.sku'), key: 'sku', sortable: true },
  { title: t('common.name'), key: 'name', sortable: true },
  { title: t('warehouse.category'), key: 'category', sortable: true },
  { title: t('common.type'), key: 'type' },
  { title: t('warehouse.stock'), key: 'stock', sortable: false },
  { title: t('warehouse.supply.reserved'), key: 'reserved', sortable: false, align: 'end' as const },
  { title: t('warehouse.supply.onOrder'), key: 'onOrder', sortable: false, align: 'end' as const },
  { title: t('warehouse.unit'), key: 'unit' },
  { title: t('warehouse.purchasePrice'), key: 'purchasePrice', align: 'end' as const },
  { title: t('warehouse.sellingPrice'), key: 'sellingPrice', align: 'end' as const },
  // FR-22.48: only when the list can hold deactivated articles. Among active ones it says "yes"
  // on every row, and its width is what keeps the row actions inside 1366 px.
  ...(activeFilter.value === 'active' ? [] : [{ title: t('common.active'), key: 'isActive', align: 'center' as const }]),
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function fmtCurrency(amount: number) { return formatCurrency(amount, baseCurrency.value, localeCode.value) }
function fmtQty(n: number) { return new Intl.NumberFormat(localeCode.value, { maximumFractionDigits: 3 }).format(n || 0) }
function stockFor(id: string): StockBadge[] { return (stockMap.value[id] || []).filter((s) => (s.quantity || 0) !== 0) }
function supplyFor(id: string): SupplyTotals { return supplyMap.value[id] || NO_SUPPLY }
function stockTab(item: Product) { return { name: 'inventory.products.stock', params: { id: item._id, tab: 'stock' } } }

// After each page loads, badge the visible products' per-warehouse stock — and what is reserved
// and on order (FR-22.45) — in one bulk call. With a warehouse chosen, all of it is that
// warehouse's. A slower answer for an earlier page never overwrites the current one.
let stockRequest = 0
async function fetchStockBadges() {
  const ids = (items.value as Product[]).map((p) => p._id).filter(Boolean)
  const mine = ++stockRequest
  if (!ids.length) { stockMap.value = {}; supplyMap.value = {}; return }
  try {
    const params: Record<string, string> = { productIds: ids.join(',') }
    if (warehouseFilter.value) params.warehouseId = warehouseFilter.value
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/stock-level/by-products`, { params })
    if (mine !== stockRequest) return
    stockMap.value = data.stock || {}
    supplyMap.value = data.supply || {}
  } catch {
    if (mine !== stockRequest) return
    stockMap.value = {}
    supplyMap.value = {}
  }
}
watch(items, fetchStockBadges)

const { actionsFor } = useProductDocActions()

/**
 * A row's menu: the article's two pages, then what it starts (FR-22.47) — each offered only to a
 * role whose Save the form's API takes, never receiving or reserving a service, and selling or
 * reserving a deactivated article disabled with the reason — then Delete, apart.
 */
function rowActions(item: Product): RowAction[] {
  const documents: RowAction[] = actionsFor(item).map((a, i) => ({
    key: a.key,
    label: t(a.labelKey),
    icon: a.icon,
    to: a.to,
    href: a.href,
    divider: i === 0,
    disabled: !!a.disabledKey,
    hint: a.disabledKey ? t(a.disabledKey) : undefined,
  }))
  return [
    { key: 'edit', label: t('common.edit'), icon: 'mdi-pencil', to: { name: 'inventory.products.edit', params: { id: item._id, tab: 'edit' } } },
    { key: 'stock', label: t('warehouse.tabStock'), icon: 'mdi-chart-box', to: stockTab(item) },
    ...documents,
    { key: 'delete', label: t('common.delete'), icon: 'mdi-delete', color: 'error', divider: true, handler: () => confirmDelete(item) },
  ]
}

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
