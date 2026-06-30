<template>
  <ListScaffold
    :title="$t('nav.invoices')"
    :headers="headers"
    :items="items"
    :loading="loading"
    :pagination="pagination"
    :kpis="kpis"
    :view="viewMode"
    :has-active-filters="hasActiveFilters"
    :empty="{ icon: 'mdi-file-document-outline', title: $t('list.empty.invoices'), description: $t('list.empty.invoicesHint') }"
    :empty-filtered="{ title: $t('list.noMatches'), description: $t('list.adjustFilters') }"
    @update:options="onUpdateOptions"
    @kpi-click="applyKpiFilter"
  >
    <template #actions>
      <ViewSwitcher v-model="viewMode" :views="['list', 'kanban']" />
      <v-btn variant="outlined" prepend-icon="mdi-download" :loading="exportLoading" @click="showExportDialog = true">{{ $t('common.export') }}</v-btn>
      <responsive-btn color="primary" icon="mdi-plus" :to="{ name: 'invoicing.sales.new' }">
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
        <v-col cols="12" sm="6" md="3">
          <TagInput v-model="tagFilter" type="invoice" :org-url="appStore.orgUrl()" :label="$t('common.filterByTags')" />
        </v-col>
      </FilterBar>
    </template>

    <template #empty-actions>
      <responsive-btn color="primary" icon="mdi-plus" :to="{ name: 'invoicing.sales.new' }">
        {{ $t('common.create') }}
      </responsive-btn>
    </template>

    <!-- Cell renderers -->
    <template #item.number="{ item }">
      <entity-link :label="item.number" :to="{ name: 'invoicing.sales.edit', params: { id: item._id } }" />
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
    <template #item.proformaNumber="{ item }">
      <entity-link v-if="item.proformaId" :label="item.proformaNumber || ''" :to="{ name: 'invoicing.proforma.edit', params: { id: item.proformaId } }" />
      <span v-else-if="item.proformaNumber">{{ item.proformaNumber }}</span>
    </template>
    <template #item.actions="{ item }">
      <v-btn icon="mdi-eye" size="small" variant="text" :to="{ name: 'invoicing.sales.edit', params: { id: item._id } }" :title="$t('common.edit')" :aria-label="$t('common.edit')" />
      <v-btn
        v-if="item.status === 'draft'"
        icon="mdi-send"
        size="small"
        variant="text"
        color="info"
        :title="$t('invoicing.send')"
        :aria-label="$t('invoicing.send')"
        @click="sendInvoice(item)"
      />
      <v-btn
        v-if="item.status === 'sent' || item.status === 'partially_paid'"
        icon="mdi-cash"
        size="small"
        variant="text"
        color="success"
        :title="$t('invoicing.recordPayment')"
        :aria-label="$t('invoicing.recordPayment')"
        @click="openPaymentDialog(item)"
      />
      <v-btn
        v-if="item.status === 'draft'"
        icon="mdi-cancel"
        size="small"
        variant="text"
        color="error"
        :title="$t('invoicing.void')"
        :aria-label="$t('invoicing.void')"
        @click="voidInvoice(item)"
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
                :to="{ name: 'invoicing.sales.edit', params: { id: inv._id } }"
                class="text-subtitle-2 font-weight-bold text-decoration-none"
              >
                {{ inv.number }}
              </router-link>
              <span class="text-body-2 font-weight-medium">{{ fmtCurrency(inv.total, inv.currency) }}</span>
            </div>
            <span class="text-body-2 text-medium-emphasis">{{ inv.contactName }}</span>
            <div class="d-flex align-center ga-1 mt-1">
              <v-chip size="x-small" :color="isOverdue(inv) ? 'error' : 'default'" variant="tonal">
                {{ inv.dueDate?.split('T')[0] || '-' }}
              </v-chip>
            </div>
          </div>
        </template>
      </KanbanBoard>
    </template>

    <!-- Dialogs -->
    <ExportDialog v-model="showExportDialog" :loading="exportLoading" doc-type="invoice" @confirm="onExport" />

    <v-dialog v-model="paymentDialog" max-width="500">
      <v-card>
        <v-card-title>{{ $t('invoicing.recordPayment') }}</v-card-title>
        <v-card-text>
          <v-form ref="paymentFormRef">
            <v-text-field
              v-model.number="paymentForm.amount"
              :label="$t('common.amount')"
              type="number"
              :rules="[rules.required]"
            />
            <v-select
              v-model="paymentForm.method"
              :label="$t('invoicing.paymentMethod')"
              :placeholder="$t('invoicing.paymentMethod')"
              :items="paymentMethods"
              item-title="text"
              item-value="value"
              persistent-placeholder
              :rules="[rules.required]"
            />
            <v-text-field
              v-model="paymentForm.date"
              :label="$t('common.date')"
              type="date"
              :rules="[rules.required]"
            />
            <v-text-field v-model="paymentForm.reference" :label="$t('invoicing.reference')" />
          </v-form>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="paymentDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" :loading="loading" @click="recordPayment">{{ $t('common.save') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

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

    <StockTransferDialog
      v-model="transferDialog"
      :shortfalls="transferShortfalls"
      :proposals="transferProposals"
      :all-resolvable="transferAllResolvable"
      :confirming="transferConfirming"
      @confirm="confirmTransferAndSend"
    />
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
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import TagInput from 'ui-shared/components/TagInput.vue'
import DateField from 'ui-shared/components/DateField.vue'
import StockTransferDialog from 'ui-shared/components/StockTransferDialog.vue'
import EntityLink from 'ui-shared/components/EntityLink'
import ViewSwitcher from 'ui-shared/components/ViewSwitcher.vue'
import KanbanBoard from 'ui-shared/components/KanbanBoard.vue'
import StatusChip from 'ui-shared/components/StatusChip'
import ExportDialog from 'ui-shared/components/ExportDialog'
import ListScaffold from 'ui-shared/components/ListScaffold.vue'
import FilterBar from 'ui-shared/components/FilterBar.vue'
import type { StatCardDef } from 'ui-shared/components/StatCard.vue'
import StatusMultiselect from '../components/StatusMultiselect.vue'
import { useInvoicingExport } from 'ui-shared/composables/useInvoicingExport'
import { usePaymentMethods } from 'ui-shared/composables/usePaymentMethods'

interface Invoice {
  _id: string
  number: string
  contactName: string
  contactId?: string
  issueDate: string
  dueDate: string
  currency: string
  exchangeRate?: number
  total: number
  status: string
  paidAmount?: number
}

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()
const paymentMethods = usePaymentMethods()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const { search, debouncedSearch } = useSearchDebounce()
const viewMode = ref('list')
const deleteDialog = ref(false)
const paymentDialog = ref(false)
const selectedId = ref('')
const statusFilter = ref<string[]>([])
// initialized in onMounted from statusOptions to "all selected"
const dateFrom = ref('')
const dateTo = ref('')
const tagFilter = ref<string[]>([])
const paymentFormRef = ref()

const transferDialog = ref(false)
const transferShortfalls = ref<any[]>([])
const transferProposals = ref<any[]>([])
const transferAllResolvable = ref(false)
const transferConfirming = ref(false)
const transferInvoiceId = ref('')

const statusOptions = computed(() => [
  { value: 'draft',          title: t('invoicing.status.draft') },
  { value: 'sent',           title: t('invoicing.status.sent') },
  { value: 'partially_paid', title: t('invoicing.status.partially_paid') },
  { value: 'paid',           title: t('invoicing.status.paid') },
  { value: 'overdue',        title: t('invoicing.status.overdue') },
  { value: 'voided',         title: t('invoicing.status.voided') },
])

const allStatusesSelected = computed(() =>
  statusFilter.value.length === 0 || statusFilter.value.length === statusOptions.value.length,
)

const hasActiveFilters = computed(() =>
  !!debouncedSearch.value || !allStatusesSelected.value || !!dateFrom.value || !!dateTo.value || tagFilter.value.length > 0,
)

const filters = computed(() => {
  const f: Record<string, any> = { direction: 'outgoing', type: 'invoice' }
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (!allStatusesSelected.value) f.status = statusFilter.value.join(',')
  if (dateFrom.value) f.startDate = dateFrom.value
  if (dateTo.value) f.endDate = dateTo.value
  if (tagFilter.value.length) f.tags = tagFilter.value.join(',')
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/invoices`),
  entityKey: 'invoices',
  filters,
})

// ── KPI summary ────────────────────────────────────────────────────────────
const summary = ref<any>(null)
const summaryLoading = ref(false)

async function fetchSummary() {
  summaryLoading.value = true
  try {
    const params: Record<string, any> = { direction: 'outgoing', type: 'invoice' }
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
      label: t('kpi.outstanding'),
      value: fmtCurrency(s?.outstanding?.amount || 0, baseCurrency.value),
      icon: 'mdi-clock-alert-outline',
      color: 'info',
      loading: summaryLoading.value,
      active: statusFilterEquals(['sent', 'partially_paid', 'overdue']),
      filter: { status: ['sent', 'partially_paid', 'overdue'] },
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

const paymentForm = ref({
  amount: 0,
  method: 'bank_transfer',
  date: new Date().toISOString().split('T')[0],
  reference: '',
})

const rules = {
  required: (v: string | number) => (v !== '' && v !== null && v !== 0) || t('validation.required'),
}

const headers = computed(() => [
  { title: t('invoicing.invoiceNumber'), key: 'number', sortable: true },
  { title: t('invoicing.contact'), key: 'contactName', sortable: true },
  { title: t('invoicing.issueDate'), key: 'issueDate', sortable: true },
  { title: t('invoicing.dueDate'), key: 'dueDate', sortable: true },
  { title: t('common.currency'), key: 'currency' },
  { title: t('invoicing.tax'), key: 'taxTotal', align: 'end' as const, sortable: true },
  { title: t('common.total'), key: 'total', align: 'end' as const },
  { title: t('common.status'), key: 'status' },
  { title: t('invoicing.proformaRef'), key: 'proformaNumber' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

const kanbanColumns = [
  { id: 'draft', title: t('invoicing.status.draft'), color: 'grey' },
  { id: 'sent', title: t('invoicing.status.sent'), color: 'blue' },
  { id: 'paid', title: t('invoicing.status.paid'), color: 'green' },
  { id: 'overdue', title: t('invoicing.status.overdue'), color: 'red' },
]

const kanbanItems = computed(() => {
  const grouped: Record<string, any[]> = { draft: [], sent: [], paid: [], overdue: [] }
  for (const inv of items.value) {
    const s = inv.status
    if (s === 'draft') grouped.draft.push(inv)
    else if (s === 'sent' || s === 'partially_paid') grouped.sent.push(inv)
    else if (s === 'paid') grouped.paid.push(inv)
    else if (s === 'overdue') grouped.overdue.push(inv)
  }
  return grouped
})

function isOverdue(inv: Invoice): boolean {
  if (!inv.dueDate) return false
  return new Date(inv.dueDate) < new Date() && inv.status !== 'paid'
}

function fmtCurrency(amount: number, currency?: string) {
  return formatCurrency(amount, currency || baseCurrency.value, localeCode.value)
}

function statusColor(s: string) {
  const map: Record<string, string> = {
    draft: 'grey',
    sent: 'info',
    partially_paid: 'warning',
    paid: 'success',
    overdue: 'error',
    voided: 'grey-darken-1',
  }
  return map[s] || 'grey'
}

async function sendInvoice(item: Invoice) {
  loading.value = true
  try {
    // First fetch full invoice to get lines with warehouseId
    const { data: invoiceData } = await httpClient.get(`${appStore.orgUrl()}/invoices/${item._id}`)
    const invoice = invoiceData.invoice
    const lines = (invoice.lines || []).filter((l: any) => l.productId && l.warehouseId)

    if (lines.length > 0 && invoice.direction === 'outgoing') {
      // Check stock availability
      const { data: stockResult } = await httpClient.post(`${appStore.orgUrl()}/invoicing/stock-availability/check`, {
        lines: lines.map((l: any) => ({ productId: l.productId, warehouseId: l.warehouseId, quantity: l.quantity })),
      })

      if (!stockResult.sufficient) {
        // Show transfer dialog
        transferShortfalls.value = stockResult.shortfalls
        transferProposals.value = stockResult.proposals
        transferAllResolvable.value = stockResult.allResolvable
        transferInvoiceId.value = item._id
        transferDialog.value = true
        loading.value = false
        return
      }
    }

    // Stock sufficient — send directly
    await httpClient.post(`${appStore.orgUrl()}/invoices/${item._id}/send`)
    showSuccess(t('invoicing.invoiceSent'))
    await refresh()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

async function confirmTransferAndSend(proposals: any[]) {
  transferConfirming.value = true
  try {
    // Create transfer movements
    const { data: transferResult } = await httpClient.post(`${appStore.orgUrl()}/invoicing/stock-availability/create-transfers`, { proposals })

    // Send invoice with pending transfer IDs (backend confirms transfers first)
    await httpClient.post(`${appStore.orgUrl()}/invoices/${transferInvoiceId.value}/send`, { pendingTransferIds: transferResult.transferIds })
    showSuccess(t('invoicing.invoiceSent'))
    transferDialog.value = false
    await refresh()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    transferConfirming.value = false
  }
}

function openPaymentDialog(item: Invoice) {
  selectedId.value = item._id
  paymentForm.value = {
    amount: (item.total || 0) - (item.paidAmount || 0),
    method: 'bank_transfer',
    date: new Date().toISOString().split('T')[0],
    reference: '',
  }
  paymentDialog.value = true
}

async function recordPayment() {
  const { valid } = await paymentFormRef.value.validate()
  if (!valid) return
  loading.value = true
  try {
    await httpClient.post(`${appStore.orgUrl()}/invoices/${selectedId.value}/payments`, paymentForm.value)
    showSuccess(t('invoicing.paymentRecorded'))
    paymentDialog.value = false
    await refresh()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

async function voidInvoice(item: Invoice) {
  loading.value = true
  try {
    await httpClient.post(`${appStore.orgUrl()}/invoices/${item._id}/void`)
    showSuccess(t('invoicing.invoiceVoided'))
    await refresh()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

function confirmDelete(item: Invoice) {
  selectedId.value = item._id
  deleteDialog.value = true
}

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
const { loading: exportLoading, exportList } = useInvoicingExport(() => appStore.orgUrl())

async function onExport(opts: { format: 'xlsx' | 'pdf'; mode: 'compact' | 'detailed'; columns?: string[] }) {
  try {
    await exportList('invoice', opts.format, opts.mode, {
      direction: 'outgoing',
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
  statusFilter.value = statusOptions.value.map((o) => o.value)
  fetchItems()
  fetchSummary()
})
</script>
