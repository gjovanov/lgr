<template>
  <ListScaffold
    :title="$t('invoicing.cashSales')"
    :headers="headers"
    :items="items"
    :loading="loading"
    :pagination="pagination"
    :view="viewMode"
    :has-active-filters="hasActiveFilters"
    :empty="{ icon: 'mdi-cash-register', title: $t('list.empty.cashSales'), description: $t('list.empty.cashSalesHint') }"
    :empty-filtered="{ title: $t('list.noMatches'), description: $t('list.adjustFilters') }"
    @update:options="onUpdateOptions"
  >
    <template #actions>
      <ViewSwitcher v-model="viewMode" :views="['list', 'kanban']" />
      <v-btn variant="outlined" prepend-icon="mdi-download" :loading="exportLoading" @click="showExportDialog = true">{{ $t('common.export') }}</v-btn>
      <v-btn variant="outlined" prepend-icon="mdi-file-upload-outline" @click="showImportDialog = true">{{ $t('docImport.importBtn') }}</v-btn>
      <responsive-btn color="primary" icon="mdi-plus" :to="{ name: 'invoicing.cash-sales.new' }">
        {{ $t('common.create') }}
      </responsive-btn>
    </template>

    <template #filters>
      <FilterBar v-model:search="search">
        <v-col cols="12" sm="6" md="2">
          <StatusMultiselect v-model="statusFilter" :items="statusOptions" :label="$t('common.status')" />
        </v-col>
        <v-col cols="12" sm="6" md="2">
          <DateField v-model="dateFrom" :label="$t('invoicing.dateFrom')" />
        </v-col>
        <v-col cols="12" sm="6" md="2">
          <DateField v-model="dateTo" :label="$t('invoicing.dateTo')" />
        </v-col>
      </FilterBar>
    </template>

    <template #empty-actions>
      <responsive-btn color="primary" icon="mdi-plus" :to="{ name: 'invoicing.cash-sales.new' }">
        {{ $t('common.create') }}
      </responsive-btn>
    </template>

    <!-- Cell renderers -->
    <template #item.number="{ item }">
      <entity-link :label="item.number" :to="{ name: 'invoicing.cash-sales.edit', params: { id: item._id } }" />
    </template>
    <!-- FR-8: a cash sale is an Invoice — it has `issueDate`, never a top-level `date`
         (only `payments[].date`), so the old `date` column rendered blank AND sorted on a
         field that does not exist. The list endpoint aliases `number`, but not the date. -->
    <template #item.issueDate="{ item }">{{ item.issueDate?.split('T')[0] }}</template>
    <template #item.status="{ item }">
      <StatusChip :status="item.status" :history="item.statusHistory" :color-fn="statusColor" />
    </template>
    <template #item.total="{ item }">{{ fmtCurrency(item.total, item.currency) }}</template>
    <template #item.actions="{ item }">
      <v-btn icon="mdi-eye" size="small" variant="text" :to="{ name: 'invoicing.cash-sales.edit', params: { id: item._id } }" :title="$t('common.edit')" :aria-label="$t('common.edit')" />
      <v-btn v-if="item.status === 'paid'" icon="mdi-cancel" size="small" variant="text" color="warning" :title="$t('invoicing.void')" :aria-label="$t('invoicing.void')" @click="voidCashSale(item)" />
      <v-btn v-if="item.status === 'draft'" icon="mdi-delete" size="small" variant="text" color="error" :title="$t('common.delete')" :aria-label="$t('common.delete')" @click="confirmDelete(item)" />
    </template>

    <!-- Kanban view -->
    <template #view>
      <KanbanBoard
        :columns="kanbanColumns"
        :items="kanbanItems"
        item-key="_id"
        :drag-enabled="false"
      >
        <template #card="{ item: inv }">
          <div class="d-flex flex-column ga-1">
            <div class="d-flex align-center justify-space-between">
              <router-link
                :to="{ name: 'invoicing.cash-sales.edit', params: { id: inv._id } }"
                class="text-subtitle-2 font-weight-bold text-decoration-none"
              >
                {{ inv.number }}
              </router-link>
              <span class="text-body-2 font-weight-medium">{{ fmtCurrency(inv.total, inv.currency) }}</span>
            </div>
            <div class="d-flex align-center ga-1 mt-1">
              <v-chip size="x-small" variant="tonal">
                {{ inv.issueDate?.split('T')[0] || '-' }}
              </v-chip>
            </div>
          </div>
        </template>
      </KanbanBoard>
    </template>

    <!-- Dialogs -->
    <ExportDialog
      v-model="showExportDialog"
      :loading="exportLoading"
      doc-type="cash_sale"
      default-format="pdf"
      show-aggregate
      default-aggregate
      @confirm="onExport"
    />

    <DocImportDialog
      v-model="showImportDialog"
      :org-url="appStore.orgUrl()"
      target="cash_sale"
      mode="batch"
      @committed="onImported"
    />

    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('invoicing.deleteCashSaleConfirm') }}</v-card-text>
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
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { useListQueryState } from 'ui-shared/composables/useListQueryState'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import EntityLink from 'ui-shared/components/EntityLink'
import ViewSwitcher from 'ui-shared/components/ViewSwitcher.vue'
import KanbanBoard from 'ui-shared/components/KanbanBoard.vue'
import StatusChip from 'ui-shared/components/StatusChip'
import ExportDialog from 'ui-shared/components/ExportDialog'
import DocImportDialog from 'ui-shared/components/DocImportDialog.vue'
import ListScaffold from 'ui-shared/components/ListScaffold.vue'
import FilterBar from 'ui-shared/components/FilterBar.vue'
import DateField from 'ui-shared/components/DateField.vue'
import StatusMultiselect from 'ui-shared/components/StatusMultiselect.vue'
import { useInvoicingExport } from 'ui-shared/composables/useInvoicingExport'
interface Item { _id: string; number: string; contactName: string; contactId?: string; date: string; status: string; total: number; currency: string; exchangeRate?: number; notes?: string; lines?: any[]; paymentMethod?: string }

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

const { search, debouncedSearch } = useSearchDebounce()
const viewMode = ref('list')
const dateFrom = ref<string | null>(null)
const dateTo = ref<string | null>(null)
const deleteDialog = ref(false)
const selectedId = ref('')
const statusFilter = ref<string[]>([])
const statusOptions = computed(() => [
  { value: 'draft',     title: t('invoicing.status.draft') },
  { value: 'completed', title: t('invoicing.status.completed') },
  { value: 'paid',      title: t('invoicing.status.paid') },
])
const allStatusesSelected = computed(() =>
  statusFilter.value.length === 0 || statusFilter.value.length === statusOptions.value.length,
)

const hasActiveFilters = computed(() =>
  !!debouncedSearch.value || !allStatusesSelected.value || !!dateFrom.value || !!dateTo.value,
)

const filters = computed(() => {
  const f: Record<string, any> = { type: 'cash_sale' }
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (!allStatusesSelected.value) f.status = statusFilter.value.join(',')
  if (dateFrom.value) f.startDate = dateFrom.value
  if (dateTo.value) f.endDate = dateTo.value
  return f
})

// FR-05 (#12): grid state in the querystring; declared before usePaginatedTable.
useListQueryState([
  { key: 'q', ref: search, mirror: debouncedSearch },
  { key: 'status', ref: statusFilter, codec: 'csv' },
  { key: 'from', ref: dateFrom, codec: 'date' },
  { key: 'to', ref: dateTo, codec: 'date' },
  { key: 'view', ref: viewMode, default: 'list' },
])

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/invoices`),
  entityKey: 'invoices',
  filters,
  urlSync: true,
})

const headers = computed(() => [
  { title: '#', key: 'number', sortable: true },
  { title: t('common.date'), key: 'issueDate', sortable: true },
  { title: t('common.currency'), key: 'currency' },
  { title: t('common.total'), key: 'total', align: 'end' as const },
  { title: t('common.status'), key: 'status' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

const kanbanColumns = computed(() => [
  { id: 'draft', title: t('invoicing.status.draft'), color: 'grey' },
  { id: 'completed', title: t('invoicing.status.completed'), color: 'green' },
])

const kanbanItems = computed(() => {
  const grouped: Record<string, any[]> = { draft: [], completed: [] }
  for (const inv of items.value) {
    const s = inv.status
    if (s === 'draft') grouped.draft.push(inv)
    else if (s === 'paid') grouped.completed.push(inv)
  }
  return grouped
})

function fmtCurrency(amount: number, currency?: string) { return formatCurrency(amount, currency || baseCurrency.value, localeCode.value) }
function statusColor(s: string) { return ({ paid: 'success', voided: 'error', draft: 'grey' }[s] || 'grey') }

async function voidCashSale(item: Item) {
  try {
    await httpClient.post(`${appStore.orgUrl()}/invoices/${item._id}/void`)
    showSuccess(t('invoicing.cashSaleVoided'))
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

function confirmDelete(item: Item) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() {
  try {
    await httpClient.delete(`${appStore.orgUrl()}/invoices/${selectedId.value}`)
    showSuccess(t('common.deletedSuccessfully'))
    await fetchItems(); deleteDialog.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}
const showExportDialog = ref(false)
const showImportDialog = ref(false)

/** Imported documents land in this list, so refresh once the batch is written. */
function onImported(results: any[]) {
  const created = (results || []).filter((r: any) => r.ok).length
  if (created) showSuccess(t('docImport.committedN', { n: created }))
  fetchItems()
}
const { loading: exportLoading, exportList } = useInvoicingExport(() => appStore.orgUrl())

async function onExport(opts: { format: 'xlsx' | 'pdf'; mode: 'compact' | 'detailed'; columns?: string[]; aggregated?: boolean }) {
  try {
    await exportList('cash_sale', opts.format, opts.mode, {
      status: allStatusesSelected.value ? undefined : statusFilter.value.join(','),
      startDate: dateFrom.value || undefined,
      endDate: dateTo.value || undefined,
      // FR-03: per-product pivot — one row per product, no document headers.
      aggregated: opts.aggregated || undefined,
    }, {
      sortBy: pagination.value.sortBy,
      sortOrder: pagination.value.sortOrder,
      columns: opts.columns,
      locale: appStore.locale,
    })
    showExportDialog.value = false
    showSuccess(t('export.success'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('export.failed'))
  }
}

onMounted(() => {
  if (!statusFilter.value.length) statusFilter.value = statusOptions.value.map(o => o.value)
  fetchItems()
})
</script>
