<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.stockMovements') }}</h1>
      <v-spacer />
      <div class="d-flex align-center ga-2">
        <ViewSwitcher v-model="displayMode" :views="['list', 'kanban']" class="mr-2" />
        <export-menu @export="onExport" />
        <v-btn variant="outlined" prepend-icon="mdi-file-upload-outline" @click="showImportDialog = true">{{ $t('docImport.importBtn') }}</v-btn>
        <responsive-btn color="primary" icon="mdi-plus" :to="{ name: 'inventory.movements.new' }">{{ $t('common.create') }}</responsive-btn>
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
            <v-select v-model="typeFilter" :label="$t('common.type')" :items="['receipt', 'dispatch', 'transfer', 'adjustment', 'return', 'production_in', 'production_out']" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <!-- `completed` is what confirmMovement leaves behind, so it belongs here. -->
            <v-select v-model="statusFilter" :label="$t('common.status')" :items="['draft', 'confirmed', 'completed', 'cancelled']" clearable hide-details density="compact" />
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
              :placeholder="$t('invoicing.searchProduct')"
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
            <v-chip size="small" label :color="typeColor(item.type)">{{ item.type }}</v-chip>
          </template>
          <template #item.contactName="{ item }">
            <entity-link v-if="item.contactId" :label="item.contactName || ''" :href="`/invoicing/contacts/${item.contactId}/edit`" />
            <span v-else>{{ item.contactName }}</span>
          </template>
          <template #item.status="{ item }">
            <StatusChip :status="item.status" :color-fn="statusColor" />
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
          <v-chip size="x-small" label :color="typeColor(item.type)">{{ item.type }}</v-chip>
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
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { useListQueryState } from 'ui-shared/composables/useListQueryState'
import ExportMenu from 'ui-shared/components/ExportMenu'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import ProductLedgerTable from 'ui-shared/components/ProductLedgerTable.vue'
import EntityLink from 'ui-shared/components/EntityLink'
import StatusChip from 'ui-shared/components/StatusChip'
import DateField from 'ui-shared/components/DateField.vue'
import ViewSwitcher from 'ui-shared/components/ViewSwitcher.vue'
import KanbanBoard from 'ui-shared/components/KanbanBoard.vue'
import DocImportDialog from 'ui-shared/components/DocImportDialog.vue'

interface Item { _id: string; number?: string; type: string; date: string; fromWarehouseName?: string; toWarehouseName?: string; fromWarehouseId?: string; toWarehouseId?: string; contactName?: string; contactId?: string; status: string; total?: number; lines?: any[]; notes?: string }
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

const kanbanColumns = [
  { id: 'draft', title: 'Draft', color: 'grey' },
  { id: 'confirmed', title: 'Confirmed', color: 'blue' },
  { id: 'completed', title: 'Completed', color: 'green' },
  { id: 'cancelled', title: 'Cancelled', color: 'red' },
]

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
    showError(e?.response?.data?.message || t('common.operationFailed'))
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

onMounted(() => { fetchItems(); fetchWarehouses(); fetchContacts() })
</script>
