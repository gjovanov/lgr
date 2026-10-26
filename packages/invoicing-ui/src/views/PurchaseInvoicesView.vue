<template>
  <ListScaffold
    :title="$t('nav.purchaseDocs')"
    :headers="headers"
    :items="items"
    :loading="loading"
    :pagination="pagination"
    :kpis="kpis"
    :view="viewMode"
    :has-active-filters="hasActiveFilters"
    :empty="{ icon: 'mdi-receipt-text-outline', title: $t('list.empty.bills'), description: $t('list.empty.billsHint') }"
    :empty-filtered="{ title: $t('list.noMatches'), description: $t('list.adjustFilters') }"
    @update:options="onUpdateOptions"
    @kpi-click="applyKpiFilter"
  >
    <template #actions>
      <ViewSwitcher v-model="viewMode" :views="['list', 'kanban']" />
      <v-btn variant="outlined" prepend-icon="mdi-download" :loading="exportLoading" @click="showExportDialog = true">{{ $t('common.export') }}</v-btn>
      <v-btn variant="outlined" prepend-icon="mdi-file-upload-outline" @click="showImportDialog = true">{{ $t('docImport.importBtn') }}</v-btn>
      <responsive-btn color="primary" icon="mdi-plus" :to="{ name: 'invoicing.purchases.new' }">
        {{ $t('common.create') }}
      </responsive-btn>
    </template>

    <template #filters>
      <FilterBar v-model:search="search">
        <v-col cols="12" sm="6" md="2">
          <StatusMultiselect v-model="typeFilter" :items="typeOptions" :label="$t('invoicing.documentType')" :all-label="$t('common.allTypes')" />
        </v-col>
        <v-col cols="12" sm="6" md="2">
          <StatusMultiselect v-model="statusFilter" :items="statusOptions" :label="$t('common.status')" />
        </v-col>
        <v-col cols="12" sm="6" md="2">
          <DateField v-model="dateFrom" :label="$t('invoicing.dateFrom')" />
        </v-col>
        <v-col cols="12" sm="6" md="2">
          <DateField v-model="dateTo" :label="$t('invoicing.dateTo')" />
        </v-col>
        <v-col cols="12" sm="6" md="3">
          <TagInput v-model="tagFilter" type="invoice" :org-url="appStore.orgUrl()" :label="$t('common.filterByTags')" />
        </v-col>
      </FilterBar>
    </template>

    <template #empty-actions>
      <responsive-btn color="primary" icon="mdi-plus" :to="{ name: 'invoicing.purchases.new' }">
        {{ $t('common.create') }}
      </responsive-btn>
    </template>

    <!-- Cell renderers -->
    <template #item.number="{ item }">
      <entity-link :label="item.number" :to="{ name: 'invoicing.purchases.edit', params: { id: item._id } }" />
    </template>
    <template #item.type="{ item }">
      <v-chip size="x-small" label :color="TYPE_COLORS[item.type] || 'grey'">
        {{ $t(`invoicing.docType.${item.type}`) }}
      </v-chip>
    </template>
    <template #item.relatedInvoiceNumber="{ item }">
      <entity-link
        v-if="item.relatedInvoiceId"
        :label="item.relatedInvoiceNumber || ''"
        :to="{ name: 'invoicing.purchases.edit', params: { id: item.relatedInvoiceId } }"
      />
    </template>
    <template #item.contactName="{ item }">
      <entity-link v-if="item.contactId" :label="item.contactName" :to="{ name: 'invoicing.contacts.edit', params: { id: item.contactId } }" />
      <span v-else>{{ item.contactName }}</span>
    </template>
    <template #item.issueDate="{ item }">{{ item.issueDate?.split('T')[0] }}</template>
    <template #item.dueDate="{ item }">{{ item.dueDate?.split('T')[0] }}</template>
    <template #item.status="{ item }">
      <StatusChip :status="item.status" :history="item.statusHistory" :color-fn="statusColor" />
    </template>
    <template #item.taxTotal="{ item }">{{ fmtCurrency(item.taxTotal, item.currency) }}</template>
    <template #item.total="{ item }">{{ fmtCurrency(item.total, item.currency) }}</template>
    <template #item.actions="{ item }">
      <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'invoicing.purchases.edit', params: { id: item._id } }" :title="$t('common.edit')" :aria-label="$t('common.edit')" />
      <v-btn
        v-if="item.status === 'draft'"
        icon="mdi-package-down"
        size="small"
        variant="text"
        color="primary"
        :title="$t('invoicing.receive')"
        :aria-label="$t('invoicing.receive')"
        @click="receiveInvoice(item)"
      />
      <v-btn
        v-if="item.status === 'draft' || item.status === 'received'"
        icon="mdi-cash"
        size="small"
        variant="text"
        color="success"
        :title="$t('invoicing.recordPayment')"
        :aria-label="$t('invoicing.recordPayment')"
        @click="openPaymentDialog(item)"
      />
      <v-btn icon="mdi-delete" size="small" variant="text" color="error" :title="$t('common.delete')" :aria-label="$t('common.delete')" @click="confirmDelete(item)" />
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
                :to="{ name: 'invoicing.purchases.edit', params: { id: inv._id } }"
                class="text-subtitle-2 font-weight-bold text-decoration-none"
              >
                {{ inv.number }}
              </router-link>
              <span class="text-body-2 font-weight-medium">{{ fmtCurrency(inv.total, inv.currency) }}</span>
            </div>
            <span class="text-body-2 text-medium-emphasis">{{ inv.contactName }}</span>
            <div class="d-flex align-center ga-1 mt-1">
              <v-chip size="x-small" variant="tonal">
                {{ inv.dueDate?.split('T')[0] || '-' }}
              </v-chip>
            </div>
          </div>
        </template>
      </KanbanBoard>
    </template>

    <!-- Dialogs -->
    <ExportDialog v-model="showExportDialog" :loading="exportLoading" doc-type="bill" default-format="pdf" @confirm="onExport" />

    <DocImportDialog
      v-model="showImportDialog"
      :org-url="appStore.orgUrl()"
      target="bill"
      mode="batch"
      @committed="onImported"
    />

    <RecordPaymentDialog v-model="paymentDialog" :document="paymentDoc" @recorded="refresh" />

    <!-- Delete Confirmation -->
    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('invoicing.deleteInvoiceConfirm') }}</v-card-text>
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
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { useListQueryState, allOptionsParam } from 'ui-shared/composables/useListQueryState'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import TagInput from 'ui-shared/components/TagInput.vue'
import DateField from 'ui-shared/components/DateField.vue'
import EntityLink from 'ui-shared/components/EntityLink'
import ViewSwitcher from 'ui-shared/components/ViewSwitcher.vue'
import KanbanBoard from 'ui-shared/components/KanbanBoard.vue'
import StatusChip from 'ui-shared/components/StatusChip'
import ExportDialog from 'ui-shared/components/ExportDialog'
import DocImportDialog from 'ui-shared/components/DocImportDialog.vue'
import ListScaffold from 'ui-shared/components/ListScaffold.vue'
import FilterBar from 'ui-shared/components/FilterBar.vue'
import type { StatCardDef } from 'ui-shared/components/StatCard.vue'
import StatusMultiselect from 'ui-shared/components/StatusMultiselect.vue'
import { useInvoicingExport } from 'ui-shared/composables/useInvoicingExport'
import RecordPaymentDialog from '../components/RecordPaymentDialog.vue'
interface Invoice { _id: string; number: string; type: string; supplierInvoiceNumber?: string; contactName: string; contactId?: string; issueDate: string; dueDate: string; status: string; total: number; amountPaid?: number; paymentMethod?: string; currency: string; exchangeRate?: number; notes?: string; lines?: any[] }

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const { search, debouncedSearch } = useSearchDebounce()
const viewMode = ref('list')
const deleteDialog = ref(false)
const paymentDialog = ref(false)
const paymentDoc = ref<Invoice | null>(null)
const selectedId = ref('')
// FR-22.15: exactly the statuses a purchase document can reach — received, paid in part or in
// full, overdue, voided. Nothing ever cancels one, so „Отказана" (cancelled) is not offered.
const STATUSES = ['draft', 'received', 'partially_paid', 'paid', 'overdue', 'voided'] as const
/** The list offered before FR-22.15: a bookmark carrying all of it means every status. */
const LEGACY_ALL_STATUSES = [...STATUSES, 'cancelled']
const statusFilter = ref<string[]>([...STATUSES])
const dateFrom = ref('')
const dateTo = ref('')
const tagFilter = ref<string[]>([])
// FR-01: merged purchase grid — bill + incoming credit note + incoming debit note.
const PURCHASE_TYPES = ['invoice', 'credit_note', 'debit_note'] as const
const TYPE_COLORS: Record<string, string> = { invoice: 'primary', credit_note: 'warning', debit_note: 'error' }
const typeFilter = ref<string[]>([...PURCHASE_TYPES])

const statusOptions = computed(() => STATUSES.map((v) => ({ value: v, title: t(`invoicing.status.${v}`) })))

// FR-22.14: the message names the document that was received.
const RECEIVED_KEY: Record<string, string> = {
  invoice: 'invoicing.invoiceReceived',
  credit_note: 'invoicing.creditNoteReceived',
  debit_note: 'invoicing.debitNoteReceived',
}
const allStatusesSelected = computed(() =>
  statusFilter.value.length === 0 || statusFilter.value.length === statusOptions.value.length,
)

const typeOptions = computed(() =>
  PURCHASE_TYPES.map((v) => ({ value: v, title: t(`invoicing.docType.${v}`) })),
)
const allTypesSelected = computed(() =>
  typeFilter.value.length === 0 || typeFilter.value.length === PURCHASE_TYPES.length,
)
/** Always sent — the incoming direction alone would drift if more types ever land there. */
const activeTypes = computed(() =>
  (allTypesSelected.value ? [...PURCHASE_TYPES] : typeFilter.value).join(','),
)

const hasActiveFilters = computed(() =>
  !!debouncedSearch.value || !allStatusesSelected.value || !allTypesSelected.value || !!dateFrom.value || !!dateTo.value || tagFilter.value.length > 0,
)

const filters = computed(() => {
  const f: Record<string, any> = { direction: 'incoming', types: activeTypes.value }
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (!allStatusesSelected.value) f.status = statusFilter.value.join(',')
  if (dateFrom.value) f.startDate = dateFrom.value
  if (dateTo.value) f.endDate = dateTo.value
  if (tagFilter.value.length) f.tags = tagFilter.value.join(',')
  return f
})

// FR-05 (#12): grid state in the querystring; declared before usePaginatedTable.
useListQueryState([
  { key: 'q', ref: search, mirror: debouncedSearch },
  allOptionsParam('type', typeFilter, PURCHASE_TYPES),
  allOptionsParam('status', statusFilter, STATUSES, LEGACY_ALL_STATUSES),
  { key: 'from', ref: dateFrom, codec: 'date' },
  { key: 'to', ref: dateTo, codec: 'date' },
  { key: 'tags', ref: tagFilter, codec: 'csv' },
  { key: 'view', ref: viewMode, default: 'list' },
])

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/invoices`),
  entityKey: 'invoices',
  filters,
  urlSync: true,
})

// ── KPI summary ────────────────────────────────────────────────────────────
const summary = ref<any>(null)
const summaryLoading = ref(false)

async function fetchSummary() {
  summaryLoading.value = true
  try {
    const params: Record<string, any> = { direction: 'incoming', type: 'invoice' }
    if (dateFrom.value) params.startDate = dateFrom.value
    if (dateTo.value) params.endDate = dateTo.value
    if (tagFilter.value.length) params.tags = tagFilter.value.join(',')
    const { data } = await httpClient.get(`${appStore.orgUrl()}/invoices/summary`, { params })
    summary.value = data.summary
  } catch {
    /* KPIs are non-critical — never block the list */
  } finally {
    summaryLoading.value = false
  }
}

function statusFilterEquals(target: string[]): boolean {
  return statusFilter.value.length === target.length && target.every((s) => statusFilter.value.includes(s))
}

const kpis = computed<StatCardDef[]>(() => {
  const s = summary.value
  return [
    {
      key: 'outstanding',
      label: t('kpi.payable'),
      value: fmtCurrency(s?.outstanding?.amount || 0, baseCurrency.value),
      icon: 'mdi-clock-alert-outline',
      color: 'info',
      loading: summaryLoading.value,
      active: statusFilterEquals(['received', 'partially_paid', 'overdue']),
      filter: { status: ['received', 'partially_paid', 'overdue'] },
    },
    {
      key: 'overdue',
      label: t('kpi.overdue'),
      value: fmtCurrency(s?.overdue?.amount || 0, baseCurrency.value),
      icon: 'mdi-alert-circle-outline',
      color: 'error',
      loading: summaryLoading.value,
      active: statusFilterEquals(['overdue']),
      filter: { status: ['overdue'] },
    },
    {
      key: 'paid30d',
      label: t('kpi.paid30d'),
      value: fmtCurrency(s?.paid30d?.amount || 0, baseCurrency.value),
      icon: 'mdi-check-circle-outline',
      color: 'success',
      loading: summaryLoading.value,
      active: statusFilterEquals(['paid']),
      filter: { status: ['paid'] },
    },
    {
      key: 'drafts',
      label: t('kpi.drafts'),
      value: s?.drafts?.count ?? 0,
      icon: 'mdi-file-document-edit-outline',
      color: 'secondary',
      loading: summaryLoading.value,
      active: statusFilterEquals(['draft']),
      filter: { status: ['draft'] },
    },
  ]
})

function applyKpiFilter(kpi: StatCardDef) {
  const target = kpi.filter?.status as string[] | undefined
  if (!target) return
  // Toggle: clicking the active card resets to "all statuses".
  statusFilter.value = statusFilterEquals(target) ? statusOptions.value.map((o) => o.value) : target
}

// Re-fetch the list AND the KPI summary after any mutation.
async function refresh() {
  await fetchItems()
  fetchSummary()
}

const headers = computed(() => [
  { title: t('invoicing.invoiceNumber'), key: 'number', sortable: true },
  { title: t('invoicing.documentType'), key: 'type' },
  { title: t('invoicing.supplierInvoiceNumber'), key: 'reference' },
  { title: t('invoicing.supplier'), key: 'contactName', sortable: true },
  { title: t('invoicing.relatedInvoice'), key: 'relatedInvoiceNumber' },
  { title: t('invoicing.issueDate'), key: 'issueDate', sortable: true },
  { title: t('invoicing.dueDate'), key: 'dueDate', sortable: true },
  { title: t('common.currency'), key: 'currency' },
  { title: t('invoicing.tax'), key: 'taxTotal', align: 'end' as const, sortable: true },
  { title: t('common.total'), key: 'total', align: 'end' as const },
  { title: t('common.status'), key: 'status' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

const kanbanColumns = computed(() => [
  { id: 'draft', title: t('invoicing.status.draft'), color: 'grey' },
  { id: 'received', title: t('invoicing.status.received'), color: 'blue' },
  { id: 'paid', title: t('invoicing.status.paid'), color: 'green' },
])

const kanbanItems = computed(() => {
  const grouped: Record<string, any[]> = { draft: [], received: [], paid: [] }
  for (const inv of items.value) {
    const s = inv.status
    if (s === 'draft') grouped.draft.push(inv)
    else if (s === 'received' || s === 'partially_paid') grouped.received.push(inv)
    else if (s === 'paid') grouped.paid.push(inv)
  }
  return grouped
})

function fmtCurrency(amount: number, currency?: string) {
  return formatCurrency(amount, currency || baseCurrency.value, localeCode.value)
}

function statusColor(s: string) {
  return ({ draft: 'grey', received: 'info', partially_paid: 'warning', paid: 'success', overdue: 'error', voided: 'error', cancelled: 'grey-darken-1' }[s] || 'grey')
}

/** FR-22.7: the dialog opens on what the row still owes, by the method the row is paid with. */
function openPaymentDialog(item: Invoice) {
  paymentDoc.value = item
  paymentDialog.value = true
}

async function receiveInvoice(item: Invoice) {
  try {
    const { data } = await httpClient.post(`${appStore.orgUrl()}/invoices/${item._id}/receive`)
    // A bill made from goods receipts books no stock: its receipts did (FR-22.31).
    showSuccess(t(data?.invoice?.stockSource?.marker ? 'invoicing.linkDelivery.received' : (RECEIVED_KEY[item.type] || RECEIVED_KEY.invoice)))
    await refresh()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

function confirmDelete(item: Invoice) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() {
  try {
    await httpClient.delete(`${appStore.orgUrl()}/invoices/${selectedId.value}`)
    showSuccess(t('common.deletedSuccessfully'))
    await refresh()
    deleteDialog.value = false
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

async function onExport(opts: { format: 'xlsx' | 'pdf'; mode: 'compact' | 'detailed'; columns?: string[] }) {
  try {
    await exportList('bill', opts.format, opts.mode, {
      types: activeTypes.value,
      status: allStatusesSelected.value ? undefined : statusFilter.value.join(','),
      startDate: dateFrom.value || undefined,
      endDate: dateTo.value || undefined,
      tags: tagFilter.value.length ? tagFilter.value.join(',') : undefined,
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

// KPI summary tracks the structural scope (dates/tags), not the status filter.
watch([dateFrom, dateTo, tagFilter], fetchSummary, { deep: true })

onMounted(() => {
  fetchItems()
  fetchSummary()
})
</script>
