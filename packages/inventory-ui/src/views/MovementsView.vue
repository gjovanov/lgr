<template>
  <v-container fluid>
    <!-- The title and its buttons wrap, as on a `ListScaffold` page: on a phone the buttons go under the title, and
         among themselves, where one row of them was wider than the screen and the whole page scrolled sideways. -->
    <div class="d-flex align-center mb-4 ga-2 flex-wrap" data-testid="movements-header">
      <h1 class="text-h5">{{ $t('nav.stockMovements') }}</h1>
      <v-spacer />
      <div class="d-flex align-center ga-2 flex-wrap justify-end">
        <ViewSwitcher v-model="displayMode" :views="['list', 'kanban']" class="mr-2" />
        <!-- FR-31.11: the list's report, which exports to Excel and PDF, on the list's filters. -->
        <ReportExportButton report="stock-movements" :query="reportQuery" />
        <!-- FR-26: an import writes receipts (`movements.create`); a transfer-only or read-only session imports nothing. -->
        <v-btn v-cap="'movements.create'" variant="outlined" prepend-icon="mdi-file-upload-outline" @click="showImportDialog = true">{{ $t('docImport.importBtn') }}</v-btn>
        <!-- FR-22.50: says what it creates — the form opens as a goods receipt. -->
        <CreateButton :label="$t('nav.newDocPage.stockMovement')" :to="{ name: 'inventory.movements.new' }" />
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
            <!-- An external warehouse is offered too: the transfers that name it are found by it. -->
            <v-select v-model="warehouseIdFilter" :label="$t('warehouse.warehouse')" :items="warehouseFilterItems" item-title="name" item-value="_id" clearable hide-details density="compact" />
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

    <!-- `list-fit` (FR-22.23): a row is one line and the gutters are 8 px, so the list fits 1366 px with its tick
         column. The names that can run long are clipped, the whole name in their `title`. -->
    <v-card v-if="(viewMode === 'movements' || selectedProducts.length !== 1) && displayMode === 'list'" class="list-fit">
      <v-card-text>
        <!-- The ticked movements by e-mail, each as its printed sheet: to its contact, or all to one address, which is
             how a transfer reaches the people of the other site. The shared bar and dialog, told the warehouse's two routes. -->
        <BatchEmailBar
          v-model:selected="ticked"
          kind="movement"
          :org-url="appStore.orgUrl()"
          preview-path="/warehouse/movement/email/preview"
          email-path="/warehouse/movement/email"
          :may-email="mailsTicked"
          :org-name="appStore.currentOrg?.name"
          :locale="appStore.locale"
        />
        <!-- `item-value` makes a tick the movement's ID, never the row: it holds across pages, sorts and filters. -->
        <v-data-table-server
          show-select
          :model-value="ticked"
          :headers="headers"
          :items="items"
          :items-length="pagination.total"
          :loading="loading"
          :page="pagination.page + 1"
          :items-per-page="pagination.size"
          @update:options="onUpdateOptions"
          @update:model-value="onTicked"
          item-value="_id"
          hover
        >
          <!-- FR-31.7: a request that failed or was refused is said, with Retry; never "no data". -->
          <template v-if="pagination.loadError" #no-data>
            <ListLoadError :failure="pagination.loadError" @retry="fetchItems" />
          </template>
          <template #item.date="{ item }">{{ item.date?.split('T')[0] }}</template>
          <template #item.type="{ item }">
            <v-chip size="small" label :color="typeColor(item.type)">{{ typeLabel(item.type) }}</v-chip>
          </template>
          <!-- An external side is another site's warehouse: the movement books nothing there, and says so. -->
          <template #item.fromWarehouseName="{ item }">
            <span class="cell-clip movement-warehouse" :title="item.fromWarehouseName">{{ item.fromWarehouseName }}</span>
            <v-chip v-if="item.fromExternal" size="x-small" label color="info" variant="tonal" class="ml-1" data-testid="movement-external-side">{{ $t('warehouse.external') }}</v-chip>
          </template>
          <template #item.toWarehouseName="{ item }">
            <span class="cell-clip movement-warehouse" :title="item.toWarehouseName">{{ item.toWarehouseName }}</span>
            <v-chip v-if="item.toExternal" size="x-small" label color="info" variant="tonal" class="ml-1" data-testid="movement-external-side">{{ $t('warehouse.external') }}</v-chip>
          </template>
          <template #item.contactName="{ item }">
            <entity-link v-if="item.contactId" class="cell-clip movement-contact" :title="item.contactName" :label="item.contactName || ''" :href="`/invoicing/contacts/${item.contactId}/edit`" />
            <span v-else class="cell-clip movement-contact" :title="item.contactName">{{ item.contactName }}</span>
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
            <!-- FR-22.61: a dispatch a sales invoice holds (made from it, or booked by it): the invoice, one click
                 away. A dispatch without the mark is a stock note nobody has invoiced yet. -->
            <v-chip
              v-if="item.sale"
              :href="appHref('invoicing', `/invoicing/invoices/${item.sale.id}/edit`)"
              size="x-small"
              color="primary"
              variant="tonal"
              class="ml-1"
              prepend-icon="mdi-receipt-text-check-outline"
              :title="item.sale.number"
              data-testid="movement-invoiced"
            >
              {{ $t('warehouse.invoiced') }}
            </v-chip>
          </template>
          <template #item.total="{ item }">{{ fmtCurrency(item.total || 0) }}</template>
          <template #item.actions="{ item }">
            <!-- One row of icons: with Print beside View, a row no longer fits them wrapped in the column's width.
                 Each is the size of a document list's row menu (`RowActionsMenu`): a draft's four take the room
                 the tick column needs, and a row stays as tall as its one line of text. -->
            <div class="d-flex flex-nowrap">
              <v-btn icon="mdi-eye" size="small" density="comfortable" variant="text" :to="{ name: 'inventory.movements.view', params: { id: item._id } }" />
              <!-- The movement as a document, for whoever may read it: it goes with the goods and carries no price. -->
              <v-btn icon="mdi-printer" size="small" density="comfortable" variant="text" :title="$t('common.print')" :loading="printing === item._id" data-testid="movement-print" @click="printMovement(item)" />
              <v-btn v-if="writesMovement(item)" icon="mdi-check" size="small" density="comfortable" variant="text" color="success" :title="$t('warehouse.confirm')" data-testid="movement-confirm" @click="confirmMovement(item)" />
              <!-- #448: a draft saved by mistake can go. The API refuses one another document names. -->
              <v-btn v-if="writesMovement(item)" icon="mdi-delete" size="small" density="comfortable" variant="text" color="error" :title="$t('common.delete')" data-testid="movement-delete" @click="askDelete(item)" />
            </div>
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
          <span v-if="seesCosts" class="text-body-2 font-weight-medium" data-cap="products.costs">{{ fmtCurrency(item.total || 0) }}</span>
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
          :warehouses="stockWarehouses"
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

    <v-dialog v-model="deleteDialog" max-width="420">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ deleteTarget?.number }} — {{ $t('warehouse.deleteMovementConfirm') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" :loading="deleting" data-testid="movement-delete-confirm" @click="doDelete">{{ $t('common.delete') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import ListLoadError from 'ui-shared/components/ListLoadError.vue'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { sortableHeaders } from 'config/list-sorts'
import { latestOnly } from 'ui-shared/composables/latest-only'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { stockRefusalMessage } from 'ui-shared/composables/stock-refusals'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { useListQueryState } from 'ui-shared/composables/useListQueryState'
import ReportExportButton from 'ui-shared/components/ReportExportButton.vue'
import { periodQuery } from 'ui-shared/components/report-export'
import CreateButton from 'ui-shared/components/CreateButton.vue'
import ProductLedgerTable from 'ui-shared/components/ProductLedgerTable.vue'
import EntityLink from 'ui-shared/components/EntityLink'
import StatusChip from 'ui-shared/components/StatusChip'
import DateField from 'ui-shared/components/DateField.vue'
import ViewSwitcher from 'ui-shared/components/ViewSwitcher.vue'
import KanbanBoard from 'ui-shared/components/KanbanBoard.vue'
import DocImportDialog from 'ui-shared/components/DocImportDialog.vue'
import BatchEmailBar from 'ui-shared/components/BatchEmailBar.vue'
import TagInput from 'ui-shared/components/TagInput.vue'
import { useProductTypes } from 'ui-shared/composables/useProductTypes'
import { appHref } from 'ui-shared/nav/navigate'
import { isTransferOnly } from 'ui-shared/nav/page-registry'
import { sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import { useAccess } from 'ui-shared/access/useAccess'
import { useMovementPrint } from '../composables/useMovementPrint'
import { mailsMovements } from '../composables/movement-email-access'

interface Item { _id: string; number?: string; type: string; date: string; fromWarehouseName?: string; toWarehouseName?: string; fromWarehouseId?: string; toWarehouseId?: string; fromExternal?: boolean; toExternal?: boolean; contactName?: string; contactId?: string; status: string; total?: number; lines?: any[]; notes?: string; bill?: { id: string; number: string }; sale?: { id: string; number: string } }
interface Warehouse { _id: string; name: string; isExternal?: boolean }
interface Contact { _id: string; name: string; companyName?: string; firstName?: string; lastName?: string }
const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()

/**
 * FR-26.7: a Seller or a Sales Consultant (`inventory.transfer` without `inventory.write`) confirms and
 * deletes draft transfers only, as the server allows (`movement.controller#transferRefusal`).
 */
const transferOnly = isTransferOnly(sessionViewer())
function writesMovement(item: { status: string; type: string }): boolean {
  return item.status === 'draft' && (!transferOnly || item.type === 'transfer')
}

// The ticked rows by e-mail: their ids, so a tick holds across pages, sorts and filters. Every role ticks and
// clears; the button is for a role the request would not answer 403 (`movement-email-access`), and follows the
// role when it is edited, as the Total column does.
const ticked = ref<string[]>([])
const mailsTicked = computed(mailsMovements)
function onTicked(ids: unknown) {
  ticked.value = (Array.isArray(ids) ? ids : []).map(String)
}
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const warehouses = ref<Warehouse[]>([])
/** The filter's choices: every warehouse a movement can name, an external one said to be one. */
const warehouseFilterItems = computed(() => warehouses.value.map(w => ({
  _id: w._id,
  name: w.isExternal ? t('warehouse.externalName', { name: w.name }) : w.name,
})))
/** The warehouses that keep stock: the only ones a product's ledger has rows for. */
const stockWarehouses = computed(() => warehouses.value.filter(w => !w.isExternal))
const { printing, printMovement } = useMovementPrint()
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
    const item = items.value.find((m: any) => m._id === itemId)
    if (!item || !writesMovement(item)) return
    try {
      // FR-04 (#11): same createCount opt-in as the list/form confirm actions.
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

/**
 * FR-31.11: Export is the `stock-movements` report on the list's filters, where the report has the same parameter: the
 * period, the type, the status, the warehouse, and the article when exactly one is chosen (the report takes one).
 */
const reportQuery = computed(() => ({
  ...periodQuery('period', dateFrom.value, dateTo.value),
  types: typeFilter.value || undefined,
  statuses: statusFilter.value || undefined,
  warehouseId: warehouseIdFilter.value || undefined,
  productId: selectedProducts.value.length === 1 ? selectedProducts.value[0]._id : undefined,
}))

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

const seesCosts = computed(() => useAccess().can('products.costs'))

// FR-30.2: a sort only on a column the list's server sorts by (`config/list-sorts`).
const headers = computed(() => sortableHeaders('movements', [
  { title: '#', key: 'number', sortable: true },
  { title: t('common.type'), key: 'type' },
  { title: t('common.date'), key: 'date', sortable: true },
  { title: t('warehouse.fromWarehouse'), key: 'fromWarehouseName' },
  { title: t('warehouse.toWarehouse'), key: 'toWarehouseName' },
  { title: t('invoicing.contact'), key: 'contactName' },
  { title: t('common.status'), key: 'status' },
  // FR-27.11.C.2: a movement's total is its lines' costs summed; the server sends it only with `products.costs`.
  ...(seesCosts.value ? [{ title: t('common.total'), key: 'total', align: 'end' as const }] : []),
  { title: t('common.actions'), key: 'actions', sortable: false },
]))

function fmtCurrency(amount: number) { return formatCurrency(amount, baseCurrency.value, localeCode.value) }
const MOVEMENT_TYPES = ['receipt', 'dispatch', 'transfer', 'adjustment', 'return', 'production_in', 'production_out']
const movementTypeItems = computed(() => MOVEMENT_TYPES.map(value => ({ title: typeLabel(value), value })))
function typeLabel(type: string) { return t(`warehouse.movementTypes.${type}`, type) }
function typeColor(t: string) { return ({ receipt: 'success', dispatch: 'error', transfer: 'info', adjustment: 'warning' }[t] || 'grey') }
function statusColor(s: string) { return ({ draft: 'grey', confirmed: 'info', completed: 'success', cancelled: 'error' } as Record<string, string>)[s] || 'grey' }
watch(productSearchQuery, (q) => {
  if (productDebounceTimer) clearTimeout(productDebounceTimer)
  if (!q || q.length < 2) {
    productLookup.cancel()
    productSearchLoading.value = false
    productSearchResults.value = [...selectedProducts.value]
    return
  }
  productDebounceTimer = setTimeout(async () => {
    productSearchLoading.value = true
    try {
      const answer = await productLookup(q)
      // FR-31.4: a slow answer to an earlier word is dropped; the newer search owns the list and the spinner.
      if (!answer.latest) return
      const results = (answer.value.products || []).map((p: any) => ({ ...p, displayName: `${p.name} (${p.sku})` }))
      // Merge with already selected products to keep them in the list
      const selectedIds = new Set(selectedProducts.value.map(p => p._id))
      productSearchResults.value = [...selectedProducts.value, ...results.filter((r: any) => !selectedIds.has(r._id))]
      productSearchLoading.value = false
    } catch {
      productSearchLoading.value = false
    }
  }, 300)
})
const productLookup = latestOnly(async (signal, q: string) => {
  const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product`, { params: { search: q, size: 10 }, signal })
  return data
})

watch(selectedProducts, (prods) => {
  if (prods.length !== 1) viewMode.value = 'movements'
})

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

const deleteDialog = ref(false)
const deleteTarget = ref<Item | null>(null)
const deleting = ref(false)
function askDelete(item: Item) { deleteTarget.value = item; deleteDialog.value = true }
async function doDelete() {
  if (!deleteTarget.value) return
  deleting.value = true
  try {
    const gone = deleteTarget.value._id
    await httpClient.delete(`${appStore.orgUrl()}/warehouse/movement/${gone}`)
    deleteDialog.value = false
    // A deleted draft is no longer ticked: the bar would count a movement that is not there.
    ticked.value = ticked.value.filter(id => id !== gone)
    await fetchItems()
    showSuccess(t('common.deletedSuccessfully'))
  } catch (e: any) {
    // The API names what holds it: the document it belongs to, or a confirm under way.
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    deleting.value = false
  }
}

async function fetchWarehouses() {
  // ⚠ `external: 'include'`: unasked, the route answers only the warehouses that keep stock. And every
  // one of them: the route's own page size is 10, which left the eleventh warehouse out of the filter.
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/warehouse`, { params: { size: 1000, external: 'include' } })
    warehouses.value = data.warehouses || []
  } catch { /* Reference data: a refusal leaves the choice empty, and the HTTP client says a network failure or a 5xx. */ }
}

function contactDisplayName(c: any): string {
  if (c.companyName) return c.companyName
  return [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c._id
}

async function fetchContacts() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/invoicing/contact`)
    contacts.value = (data.contacts || []).map((c: any) => ({ ...c, name: contactDisplayName(c) }))
  } catch { /* Reference data: a refusal leaves the choice empty, and the HTTP client says a network failure or a 5xx. */ }
}

async function fetchCategories() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product-category`, { params: { isActive: 'true' } })
    categoryOptions.value = (data.productCategories || []).map((c: { name: string }) => c.name)
  } catch { /* Reference data: a refusal leaves the choice empty, and the HTTP client says a network failure or a 5xx. */ }
}

onMounted(() => { fetchItems(); fetchWarehouses(); fetchContacts(); fetchCategories() })
</script>

<style scoped>
/* A row names two warehouses and a contact, where a document list names one partner: each is clipped sooner than
   `list-fit`'s 12em, so that the three fit 1366 px beside a draft's four icons and a status with its mark. */
.movement-warehouse {
  --cell-clip: 9em;
}
.movement-contact {
  --cell-clip: 10em;
}
</style>
