<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.stockMovements') }}</h1>
      <v-spacer />
      <div class="d-flex align-center ga-2">
        <ViewSwitcher v-model="displayMode" :views="['list', 'kanban']" class="mr-2" />
        <export-menu @export="onExport" />
        <v-btn variant="outlined" prepend-icon="mdi-file-upload-outline" @click="showImportDialog = true">{{ $t('docImport.importBtn') }}</v-btn>
        <!-- FR-22.50: says what it creates — the form opens as a goods receipt. -->
        <CreateButton :label="$t('nav.newDocPage.goodsReceipt')" :to="{ name: 'inventory.movements.new' }" />
      </div>
    </div>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="2">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-select v-model="typeFilter" :label="$t('common.type')" :items="movementTypeItems" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <!-- `completed` is what confirmMovement leaves behind, so it belongs here. -->
            <v-select v-model="statusFilter" :label="$t('common.status')" :items="statusItems" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-select v-model="warehouseIdFilter" :label="$t('warehouse.warehouse')" :items="warehouses" item-title="name" item-value="_id" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <DateField v-model="dateFrom" :label="$t('invoicing.dateFrom')" hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <DateField v-model="dateTo" :label="$t('invoicing.dateTo')" hide-details density="compact" />
          </v-col>
        </v-row>
        <!-- The Products list's search and filters, for the articles a movement carries: the
             movements holding any article they find there (`buildProductListFilter`). -->
        <v-row>
          <v-col cols="12" md="3">
            <v-text-field v-model="productSearch" prepend-inner-icon="mdi-package-variant-closed" :label="$t('warehouse.movementProducts.search')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-select v-model="productCategory" :label="$t('warehouse.category')" :items="categoryOptions" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-select v-model="productType" :label="$t('warehouse.movementProducts.type')" :items="productTypeItems(['goods', 'service'])" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <TagInput v-model="productTags" type="product" :org-url="appStore.orgUrl()" :label="$t('common.filterByTags')" />
          </v-col>
          <v-col cols="12" md="2">
            <v-select v-model="productStatus" :label="$t('warehouse.movementProducts.status')" :items="productStatusItems" hide-details density="compact" />
          </v-col>
        </v-row>
        <v-row>
          <v-col cols="12" md="4">
            <v-autocomplete
              v-model="selectedProducts"
              v-model:search="productSearchQuery"
              :items="productSearchResults"
              :loading="productSearchLoading"
              item-title="displayName"
              item-value="_id"
              return-object
              multiple
              chips
              closable-chips
              :placeholder="$t('warehouse.movementProducts.pick')"
              density="compact"
              hide-details
              variant="underlined"
              clearable
              no-filter
            />
          </v-col>
          <v-col v-if="selectedProducts.length === 1" cols="12" md="4" class="d-flex align-center">
            <v-btn-toggle v-model="viewMode" mandatory density="compact" color="primary">
              <v-btn value="movements" size="small" prepend-icon="mdi-swap-horizontal">{{ $t('nav.stockMovements') }}</v-btn>
              <v-btn value="ledger" size="small" prepend-icon="mdi-book-open-variant">{{ $t('warehouse.productLedger') }}</v-btn>
            </v-btn-toggle>
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-card v-if="(viewMode === 'movements' || selectedProducts.length !== 1) && displayMode === 'list'">
      <v-card-text>
        <v-data-table-server
          :headers="headers"
          :items="items"
          :items-length="pagination.total"
          :loading="loading"
          :page="pagination.page + 1"
          :items-per-page="pagination.size"
          @update:options="onUpdateOptions"
          item-value="_id"
          hover
        >
          <template #item.date="{ item }">{{ item.date?.split('T')[0] }}</template>
          <template #item.type="{ item }">
            <v-chip size="small" label :color="typeColor(item.type)">{{ typeLabel(item.type) }}</v-chip>
          </template>
          <template #item.contactName="{ item }">
            <entity-link v-if="item.contactId" :label="item.contactName || ''" :href="`/invoicing/contacts/${item.contactId}/edit`" />
            <span v-else>{{ item.contactName }}</span>
          </template>
          <template #item.status="{ item }">
            <StatusChip :status="item.status" :color-fn="statusColor" />
            <!-- FR-22.31: a receipt its supplier's bill already pays for — the bill, one click away. -->
            <v-chip
              v-if="item.bill"
              :href="appHref('invoicing', `/invoicing/bills/${item.bill.id}/edit`)"
              size="x-small"
              color="primary"
              variant="tonal"
              class="ml-1"
              prepend-icon="mdi-receipt-text-check-outline"
              :title="item.bill.number"
              data-testid="movement-billed"
            >
              {{ $t('warehouse.billed') }}
            </v-chip>
          </template>
          <template #item.total="{ item }">{{ fmtCurrency(item.total || 0) }}</template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-eye" size="small" variant="text" :to="{ name: 'inventory.movements.view', params: { id: item._id } }" />
            <v-btn v-if="item.status === 'draft'" icon="mdi-check" size="small" variant="text" color="success" :title="$t('warehouse.confirm')" @click="confirmMovement(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <KanbanBoard
      v-if="(viewMode === 'movements' || selectedProducts.length !== 1) && displayMode === 'kanban'"
      :columns="kanbanColumns"
      :items="kanbanItems"
      item-key="_id"
      @move="handleKanbanMove"
    >
      <template #card="{ item }">
        <div class="d-flex flex-column ga-1">
          <span class="font-weight-bold text-body-2">{{ item.number || item._id.slice(-6) }}</span>
          <v-chip size="x-small" label :color="typeColor(item.type)">{{ typeLabel(item.type) }}</v-chip>
          <span v-if="item.contactName" class="text-caption">{{ item.contactName }}</span>
          <span class="text-caption text-medium-emphasis">{{ item.date?.split('T')[0] }}</span>
          <span class="text-body-2 font-weight-medium">{{ fmtCurrency(item.total || 0) }}</span>
        </div>
      </template>
    </KanbanBoard>

    <v-card v-if="viewMode === 'ledger' && selectedProducts.length === 1">
      <v-card-title class="d-flex align-center">
        {{ $t('warehouse.productLedger') }}: {{ selectedProducts[0]?.name || '' }}
        <v-spacer />
        <v-btn variant="outlined" size="small" prepend-icon="mdi-open-in-new" :to="{ name: 'inventory.products.stock', params: { id: selectedProducts[0]?._id, tab: 'stock' } }">{{ $t('warehouse.fullView') }}</v-btn>
      </v-card-title>
      <v-card-text>
        <ProductLedgerTable
          :product-id="selectedProducts[0]?._id || ''"
          :org-url="appStore.orgUrl()"
          :base-currency="baseCurrency"
          :locale-code="localeCode"
          :warehouses="warehouses"
        />
      </v-card-text>
    </v-card>


    <!-- This view predates ListScaffold, so the dialog is mounted by hand. -->
    <DocImportDialog
      v-model="showImportDialog"
      :org-url="appStore.orgUrl()"
      target="movement"
      mode="batch"
      @committed="onImported"
    />
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { stockRefusalMessage } from 'ui-shared/composables/stock-refusals'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { useListQueryState } from 'ui-shared/composables/useListQueryState'
import ExportMenu from 'ui-shared/components/ExportMenu'
import CreateButton from 'ui-shared/components/CreateButton.vue'
import ProductLedgerTable from 'ui-shared/components/ProductLedgerTable.vue'
import EntityLink from 'ui-shared/components/EntityLink'
import StatusChip from 'ui-shared/components/StatusChip'
import DateField from 'ui-shared/components/DateField.vue'
import ViewSwitcher from 'ui-shared/components/ViewSwitcher.vue'
import KanbanBoard from 'ui-shared/components/KanbanBoard.vue'
import DocImportDialog from 'ui-shared/components/DocImportDialog.vue'
import TagInput from 'ui-shared/components/TagInput.vue'
import { useProductTypes } from 'ui-shared/composables/useProductTypes'
import { appHref } from 'ui-shared/nav/navigate'

interface Item { _id: string; number?: string; type: string; date: string; fromWarehouseName?: string; toWarehouseName?: string; fromWarehouseId?: string; toWarehouseId?: string; contactName?: string; contactId?: string; status: string; total?: number; lines?: any[]; notes?: string; bill?: { id: string; number: string } }
interface Warehouse { _id: string; name: string }
interface Contact { _id: string; name: string; companyName?: string; firstName?: string; lastName?: string }
const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const warehouses = ref<Warehouse[]>([])
const contacts = ref<Contact[]>([])
const { search, debouncedSearch } = useSearchDebounce()
const typeFilter = ref<string | null>(null)
const statusFilter = ref<string | null>(null)
const warehouseIdFilter = ref<string | null>(null)
const selectedProducts = ref<any[]>([])
const productSearchQuery = ref('')
const productSearchResults = ref<any[]>([])
const productSearchLoading = ref(false)
let productDebounceTimer: ReturnType<typeof setTimeout> | null = null
const viewMode = ref<'movements' | 'ledger'>('movements')
const displayMode = ref<'list' | 'kanban'>('list')
const dateFrom = ref('')
const dateTo = ref('')

// The Products list's filters, for the articles on a movement's lines. Its status filter starts at
// "all" here: a deactivated article's movements are still movements.
const { productTypeItems } = useProductTypes()
const { search: productSearch, debouncedSearch: debouncedProductSearch } = useSearchDebounce()
const productCategory = ref<string | null>(null)
const productType = ref<string | null>(null)
const productTags = ref<string[]>([])
const PRODUCT_STATUSES = ['all', 'active', 'inactive'] as const
type ProductStatus = (typeof PRODUCT_STATUSES)[number]
const productStatus = ref<ProductStatus>('all')
const categoryOptions = ref<string[]>([])
const productStatusItems = computed(() => [
  { title: t('common.all'), value: 'all' },
  { title: t('warehouse.activeFilter.active'), value: 'active' },
  { title: t('warehouse.activeFilter.inactive'), value: 'inactive' },
])

// A movement's statuses, named as the list's status chips name them (FR-22.11: they were
// English in every language, in the status filter and as the board's column titles).
const MOVEMENT_STATUSES = ['draft', 'confirmed', 'completed', 'cancelled'] as const
const statusItems = computed(() => MOVEMENT_STATUSES.map(value => ({ title: t(`invoicing.status.${value}`), value })))

const kanbanColumns = computed(() => [
  { id: 'draft', title: t('invoicing.status.draft'), color: 'grey' },
  { id: 'confirmed', title: t('invoicing.status.confirmed'), color: 'blue' },
  { id: 'completed', title: t('invoicing.status.completed'), color: 'green' },
  { id: 'cancelled', title: t('invoicing.status.cancelled'), color: 'red' },
])

const kanbanItems = computed(() => {
  const grouped: Record<string, any[]> = { draft: [], confirmed: [], completed: [], cancelled: [] }
  for (const m of items.value) {
    const status = m.status || 'draft'
    if (grouped[status]) grouped[status].push(m)
  }
  return grouped
})

async function handleKanbanMove(itemId: string, from: string, to: string) {
  if (from === 'draft' && to === 'confirmed') {
    try {
      // FR-04 (#11): same createCount opt-in as the list/form confirm actions.
      const item = items.value.find((m: any) => m._id === itemId)
      await httpClient.post(
        `${appStore.orgUrl()}/warehouse/movement/${itemId}/confirm`,
        (item as any)?.type === 'adjustment' ? { createCount: true } : {},
      )
      showSuccess(t('common.completedSuccessfully'))
      await fetchItems()
    } catch (e: any) {
      showError(e?.response?.data?.message || t('common.operationFailed'))
    }
  }
}


const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (typeFilter.value) f.type = typeFilter.value
  if (statusFilter.value) f.status = statusFilter.value
  if (warehouseIdFilter.value) f.warehouseId = warehouseIdFilter.value
  if (selectedProducts.value.length) f.productId = selectedProducts.value.map(p => p._id).join(',')
  if (dateFrom.value) f.dateFrom = dateFrom.value
  if (dateTo.value) f.dateTo = dateTo.value
  if (debouncedProductSearch.value) f.productSearch = debouncedProductSearch.value
  if (productCategory.value) f.productCategory = productCategory.value
  if (productType.value) f.productType = productType.value
  if (productTags.value.length) f.productTags = productTags.value.join(',')
  if (productStatus.value !== 'all') f.productActive = productStatus.value === 'active' ? 'true' : 'false'
  return f
})

const url = computed(() => `${appStore.orgUrl()}/warehouse/movement`)
// FR-05 (#12): grid state in the querystring; declared before usePaginatedTable.
useListQueryState([
  { key: 'q', ref: search, mirror: debouncedSearch },
  { key: 'type', ref: typeFilter },
  { key: 'status', ref: statusFilter },
  { key: 'warehouse', ref: warehouseIdFilter },
  { key: 'from', ref: dateFrom, codec: 'date' },
  { key: 'to', ref: dateTo, codec: 'date' },
  // NB: viewMode here is the movements/ledger toggle, not the list/kanban switcher.
  { key: 'view', ref: viewMode, default: 'movements' },
  { key: 'pq', ref: productSearch, mirror: debouncedProductSearch },
  { key: 'pcategory', ref: productCategory },
  { key: 'ptype', ref: productType },
  { key: 'ptags', ref: productTags, codec: 'csv' },
  { key: 'pstatus', ref: productStatus, default: 'all', sanitize: (v) => (PRODUCT_STATUSES.includes(v) ? v : undefined) },
])

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'stockMovements',
  filters,
  urlSync: true,
})

const showImportDialog = ref(false)

/** Imported движения land in this list, so refresh once the batch is booked. */
function onImported(results: any[]) {
  const created = (results || []).filter((r: any) => r.ok).length
  if (created) showSuccess(t('docImport.committedN', { n: created }))
  fetchItems()
}

const headers = computed(() => [
  { title: '#', key: 'number', sortable: true },
  { title: t('common.type'), key: 'type' },
  { title: t('common.date'), key: 'date', sortable: true },
  { title: t('warehouse.fromWarehouse'), key: 'fromWarehouseName' },
  { title: t('warehouse.toWarehouse'), key: 'toWarehouseName' },
  { title: t('invoicing.contact'), key: 'contactName' },
  { title: t('common.status'), key: 'status' },
  { title: t('common.total'), key: 'total', align: 'end' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function fmtCurrency(amount: number) { return formatCurrency(amount, baseCurrency.value, localeCode.value) }
const MOVEMENT_TYPES = ['receipt', 'dispatch', 'transfer', 'adjustment', 'return', 'production_in', 'production_out']
const movementTypeItems = computed(() => MOVEMENT_TYPES.map(value => ({ title: typeLabel(value), value })))
function typeLabel(type: string) { return t(`warehouse.movementTypes.${type}`, type) }
function typeColor(t: string) { return ({ receipt: 'success', dispatch: 'error', transfer: 'info', adjustment: 'warning' }[t] || 'grey') }
function statusColor(s: string) { return ({ draft: 'grey', confirmed: 'info', completed: 'success', cancelled: 'error' } as Record<string, string>)[s] || 'grey' }
watch(productSearchQuery, (q) => {
  if (productDebounceTimer) clearTimeout(productDebounceTimer)
  if (!q || q.length < 2) {
    productSearchResults.value = [...selectedProducts.value]
    return
  }
  productDebounceTimer = setTimeout(async () => {
    productSearchLoading.value = true
    try {
      const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product`, { params: { search: q, size: 10 } })
      const results = (data.products || []).map((p: any) => ({ ...p, displayName: `${p.name} (${p.sku})` }))
      // Merge with already selected products to keep them in the list
      const selectedIds = new Set(selectedProducts.value.map(p => p._id))
      productSearchResults.value = [...selectedProducts.value, ...results.filter((r: any) => !selectedIds.has(r._id))]
    } catch { /* */ } finally {
      productSearchLoading.value = false
    }
  }, 300)
})

watch(selectedProducts, (prods) => {
  if (prods.length !== 1) viewMode.value = 'movements'
})
function onExport(format: string) { console.log('Export movements as', format) }

async function confirmMovement(item: Item) {
  try {
    // FR-04 (#11): manual adjustments auto-create their completed inventory count.
    await httpClient.post(
      `${appStore.orgUrl()}/warehouse/movement/${item._id}/confirm`,
      (item as any).type === 'adjustment' ? { createCount: true } : {},
    )
    await fetchItems()
    showSuccess(t('common.completedSuccessfully'))
  } catch (e: any) {
    showError(stockRefusalMessage(e, t))
  }
}

async function fetchWarehouses() {
  try { const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/warehouse`); warehouses.value = data.warehouses || [] } catch { /* */ }
}

function contactDisplayName(c: any): string {
  if (c.companyName) return c.companyName
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c._id
}

async function fetchContacts() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/invoicing/contact`)
    contacts.value = (data.contacts || []).map((c: any) => ({ ...c, name: contactDisplayName(c) }))
  } catch { /* */ }
}

async function fetchCategories() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product-category`, { params: { isActive: 'true' } })
    categoryOptions.value = (data.productCategories || []).map((c: { name: string }) => c.name)
  } catch { /* */ }
}

onMounted(() => { fetchItems(); fetchWarehouses(); fetchContacts(); fetchCategories() })
</script>
