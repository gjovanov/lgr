<template>
  <ListScaffold
    fit
    :title="$t('nav.salesDocs')"
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
      <v-btn variant="outlined" prepend-icon="mdi-file-upload-outline" @click="showImportDialog = true">{{ $t('docImport.importBtn') }}</v-btn>
      <!-- FR-22.50 (D-8): says what it creates; the notes beside it. A list filtered to one kind
           of note creates that note. -->
      <CreateButton :label="create.label" :to="create.to" :more="create.more" :more-label="$t('invoicing.createOther')" />
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
      <CreateButton :label="create.label" :to="create.to" :more="create.more" :more-label="$t('invoicing.createOther')" />
    </template>

    <!-- Cell renderers -->
    <template #item.number="{ item }">
      <entity-link :label="item.number" :to="{ name: 'invoicing.sales.edit', params: { id: item._id } }" />
      <!-- #171: issued for a cash sale — its stock and money are that sale's. -->
      <v-chip
        v-if="item.cashSaleNumber"
        size="x-small"
        variant="tonal"
        class="ml-1"
        prepend-icon="mdi-cash-register"
        :to="{ name: 'invoicing.cash-sales.edit', params: { id: item.cashSaleId } }"
        :title="$t('invoicing.cashSaleInvoice.forCashSale', { number: item.cashSaleNumber })"
      >
        {{ item.cashSaleNumber }}
      </v-chip>
    </template>
    <template #item.type="{ item }">
      <v-chip size="x-small" label :color="TYPE_COLORS[item.type] || 'grey'">
        {{ $t(`invoicing.docType.${item.type}`) }}
      </v-chip>
    </template>
    <!-- FR-22.23: the invoice a note corrects, or the proforma an invoice came from — one column
         where there were two, each empty on most rows. -->
    <template #item.relatedDocument="{ item }">
      <entity-link
        v-if="item.relatedInvoiceId"
        :label="item.relatedInvoiceNumber || ''"
        :to="{ name: 'invoicing.sales.edit', params: { id: item.relatedInvoiceId } }"
      />
      <entity-link v-if="item.proformaId" :label="item.proformaNumber || ''" :to="{ name: 'invoicing.proforma.edit', params: { id: item.proformaId } }" />
      <span v-else-if="item.proformaNumber">{{ item.proformaNumber }}</span>
    </template>
    <template #item.contactName="{ item }">
      <!-- FR-22.23: a long name is cut short on the row, whole on hover. -->
      <entity-link v-if="item.contactId" class="cell-clip" :title="item.contactName" :label="item.contactName" :to="{ name: 'invoicing.contacts.edit', params: { id: item.contactId } }" />
      <span v-else class="cell-clip" :title="item.contactName">{{ item.contactName }}</span>
    </template>
    <template #item.issueDate="{ item }">{{ item.issueDate?.split('T')[0] }}</template>
    <template #item.dueDate="{ item }">{{ item.dueDate?.split('T')[0] }}</template>
    <template #item.status="{ item }">
      <StatusChip :status="item.status" :history="item.statusHistory" :color-fn="statusColor" />
    </template>
    <template #item.taxTotal="{ item }">{{ fmtCurrency(item.taxTotal, item.currency) }}</template>
    <template #item.total="{ item }">{{ fmtCurrency(item.total, item.currency) }}</template>
    <template #item.actions="{ item }">
      <!-- FR-22.23/.24: every action of the row in one menu, offered exactly when the API takes it. -->
      <RowActionsMenu :actions="rowActions(item)" />
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
    <ExportDialog v-model="showExportDialog" :loading="exportLoading" doc-type="invoice" default-format="pdf" @confirm="onExport" />

    <DocImportDialog
      v-model="showImportDialog"
      :org-url="appStore.orgUrl()"
      target="sales_invoice"
      mode="batch"
      @committed="onImported"
    />

    <RecordPaymentDialog v-model="paymentDialog" :document="paymentDoc" @recorded="refresh" />

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

    <!-- FR-22.23: voiding is offered on issued documents now — it reverses what they did, so it asks. -->
    <v-dialog v-model="voidDialog" max-width="440">
      <v-card data-testid="void-dialog">
        <v-card-title>{{ $t('invoicing.void') }}</v-card-title>
        <v-card-text>{{ $t('invoicing.voidConfirm', { number: voidTarget?.number || '' }) }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="voidDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" :loading="loading" @click="doVoid">{{ $t('invoicing.void') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <StockTransferDialog
      v-model="transferDialog"
      :shortfalls="transferShortfalls"
      :proposals="transferProposals"
      :all-resolvable="transferAllResolvable"
      :confirming="transferConfirming"
      @confirm="confirmTransfers"
    />

    <!-- FR-10 (#19): one dialog for the whole grid, driven by the row the user clicked. -->
    <SendEmailDialog
      v-model="emailDialog"
      :default-to="emailTo"
      :default-subject="emailSubject"
      :document-number="emailDocNumber"
      :loading="emailLoading"
      @confirm="sendRowEmail"
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
import { useListQueryState, allOptionsParam } from 'ui-shared/composables/useListQueryState'
import CreateButton from 'ui-shared/components/CreateButton.vue'
import RowActionsMenu, { type RowAction } from 'ui-shared/components/RowActionsMenu.vue'
import TagInput from 'ui-shared/components/TagInput.vue'
import DateField from 'ui-shared/components/DateField.vue'
import StockTransferDialog from 'ui-shared/components/StockTransferDialog.vue'
import EntityLink from 'ui-shared/components/EntityLink'
import ViewSwitcher from 'ui-shared/components/ViewSwitcher.vue'
import KanbanBoard from 'ui-shared/components/KanbanBoard.vue'
import StatusChip from 'ui-shared/components/StatusChip'
import ExportDialog from 'ui-shared/components/ExportDialog'
import DocImportDialog from 'ui-shared/components/DocImportDialog.vue'
import SendEmailDialog from 'ui-shared/components/SendEmailDialog.vue'
import ListScaffold from 'ui-shared/components/ListScaffold.vue'
import FilterBar from 'ui-shared/components/FilterBar.vue'
import type { StatCardDef } from 'ui-shared/components/StatCard.vue'
import StatusMultiselect from 'ui-shared/components/StatusMultiselect.vue'
import { useInvoicingExport } from 'ui-shared/composables/useInvoicingExport'
import { useRowEmail } from '../composables/useRowEmail'
import { useDocumentIssue } from '../composables/useDocumentIssue'
import { useRowPrint } from '../composables/useRowPrint'
import * as can from '../composables/document-row-actions'
import RecordPaymentDialog from '../components/RecordPaymentDialog.vue'

interface Invoice {
  _id: string
  number: string
  type: string
  /** #171: an invoice issued for a cash sale. */
  cashSaleId?: string
  contactName: string
  contactId?: string
  issueDate: string
  dueDate: string
  currency: string
  exchangeRate?: number
  total: number
  status: string
  amountPaid?: number
  paymentMethod?: string
}

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

// FR-10 (#19): the row-level "send by email" action.
const {
  dialogOpen: emailDialog,
  loading: emailLoading,
  defaultTo: emailTo,
  defaultSubject: emailSubject,
  documentNumber: emailDocNumber,
  open: openRowEmail,
  send: sendRowEmail,
} = useRowEmail()
const { printRow } = useRowPrint()

const { search, debouncedSearch } = useSearchDebounce()
const viewMode = ref('list')
const deleteDialog = ref(false)
const paymentDialog = ref(false)
const paymentDoc = ref<Invoice | null>(null)
const selectedId = ref('')
// FR-22.15: exactly the statuses a sales document can reach — issued (sent), paid in part or in
// full, overdue, voided. All of them is the default, so the list's bare URL stays bare.
const STATUSES = ['draft', 'sent', 'partially_paid', 'paid', 'overdue', 'voided'] as const
const statusFilter = ref<string[]>([...STATUSES])
const dateFrom = ref('')
const dateTo = ref('')
const tagFilter = ref<string[]>([])
// FR-01: merged sales grid — invoice + credit note + debit note, filterable by type.
const SALES_TYPES = ['invoice', 'credit_note', 'debit_note'] as const
const TYPE_COLORS: Record<string, string> = { invoice: 'primary', credit_note: 'warning', debit_note: 'error' }
const typeFilter = ref<string[]>([...SALES_TYPES])

const statusOptions = computed(() => STATUSES.map((v) => ({ value: v, title: t(`invoicing.status.${v}`) })))

const allStatusesSelected = computed(() =>
  statusFilter.value.length === 0 || statusFilter.value.length === statusOptions.value.length,
)

const typeOptions = computed(() =>
  SALES_TYPES.map((v) => ({ value: v, title: t(`invoicing.docType.${v}`) })),
)
const allTypesSelected = computed(() =>
  typeFilter.value.length === 0 || typeFilter.value.length === SALES_TYPES.length,
)
/** Always sent — outgoing direction alone would also match proformas and cash sales. */
const activeTypes = computed(() =>
  (allTypesSelected.value ? [...SALES_TYPES] : typeFilter.value).join(','),
)

const hasActiveFilters = computed(() =>
  !!debouncedSearch.value || !allStatusesSelected.value || !allTypesSelected.value || !!dateFrom.value || !!dateTo.value || tagFilter.value.length > 0,
)

const filters = computed(() => {
  const f: Record<string, any> = { direction: 'outgoing', types: activeTypes.value }
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (!allStatusesSelected.value) f.status = statusFilter.value.join(',')
  if (dateFrom.value) f.startDate = dateFrom.value
  if (dateTo.value) f.endDate = dateTo.value
  if (tagFilter.value.length) f.tags = tagFilter.value.join(',')
  return f
})

// FR-05 (#12): the grid state lives in the querystring — Back restores the exact view.
// Declared BEFORE usePaginatedTable so its filters-watcher sees hydrated values.
useListQueryState([
  { key: 'q', ref: search, mirror: debouncedSearch },
  allOptionsParam('type', typeFilter, SALES_TYPES),
  allOptionsParam('status', statusFilter, STATUSES),
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

// FR-22.14: the message names the document that was acted on — a credit note is not „Фактурата".
const VOIDED_KEY: Record<string, string> = {
  invoice: 'invoicing.invoiceVoided',
  credit_note: 'invoicing.creditNoteVoided',
  debit_note: 'invoicing.debitNoteVoided',
}

const headers = computed(() => [
  { title: t('invoicing.invoiceNumber'), key: 'number', sortable: true },
  { title: t('invoicing.documentType'), key: 'type' },
  { title: t('invoicing.contact'), key: 'contactName', sortable: true },
  { title: t('invoicing.relatedDocument'), key: 'relatedDocument', sortable: false },
  { title: t('invoicing.issueDate'), key: 'issueDate', sortable: true },
  { title: t('invoicing.dueDate'), key: 'dueDate', sortable: true },
  // FR-22.23: every amount is printed with its currency, so this column is offered on the cog.
  { title: t('common.currency'), key: 'currency', defaultHidden: true },
  { title: t('invoicing.tax'), key: 'taxTotal', align: 'end' as const, sortable: true },
  { title: t('common.total'), key: 'total', align: 'end' as const },
  { title: t('common.status'), key: 'status' },
  // FR-22.23: one menu button, so the column is as narrow as its title.
  { title: '', key: 'actions', sortable: false, align: 'end' as const, width: 48 },
])

const kanbanColumns = computed(() => [
  { id: 'draft', title: t('invoicing.status.draft'), color: 'grey' },
  { id: 'sent', title: t('invoicing.status.sent'), color: 'blue' },
  { id: 'paid', title: t('invoicing.status.paid'), color: 'green' },
  { id: 'overdue', title: t('invoicing.status.overdue'), color: 'red' },
])

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

// FR-22.17: issuing — the stock check, the transfer dialog, `/send` — is shared with the document
// form (composables/useDocumentIssue), which issues too now. Same requests, same messages.
const {
  transfer: {
    open: transferDialog,
    shortfalls: transferShortfalls,
    proposals: transferProposals,
    allResolvable: transferAllResolvable,
    confirming: transferConfirming,
  },
  issue,
  confirmTransfers,
} = useDocumentIssue({ loading, onIssued: refresh })

function sendInvoice(item: Invoice) {
  return issue(item)
}

/** FR-22.7: the dialog opens on what the row still owes, by the method the row is paid with. */
function openPaymentDialog(item: Invoice) {
  paymentDoc.value = item
  paymentDialog.value = true
}

async function voidInvoice(item: Invoice) {
  loading.value = true
  try {
    await httpClient.post(`${appStore.orgUrl()}/invoices/${item._id}/void`)
    showSuccess(t(VOIDED_KEY[item.type] || VOIDED_KEY.invoice))
    await refresh()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

const voidDialog = ref(false)
const voidTarget = ref<Invoice | null>(null)
function confirmVoid(item: Invoice) {
  voidTarget.value = item
  voidDialog.value = true
}
async function doVoid() {
  if (voidTarget.value) await voidInvoice(voidTarget.value)
  voidDialog.value = false
}

// ── FR-22.50 (D-8): what the list's Create makes ──
const NEW_DOC: Record<string, { key: string; icon: string }> = {
  invoice: { key: 'invoicing.newInvoice', icon: 'mdi-file-document-outline' },
  credit_note: { key: 'invoicing.newCreditNote', icon: 'mdi-file-undo' },
  debit_note: { key: 'invoicing.newDebitNote', icon: 'mdi-file-plus-outline' },
}
const newDocRoute = (type: string) => ({ name: 'invoicing.sales.new', query: type === 'invoice' ? {} : { type } })
/** An invoice — or, on a list filtered to one kind of note, that note. The others beside it. */
const create = computed(() => {
  const only = !allTypesSelected.value && typeFilter.value.length === 1 ? typeFilter.value[0] : 'invoice'
  return {
    label: t(NEW_DOC[only].key),
    to: newDocRoute(only),
    more: SALES_TYPES.filter((type) => type !== only).map((type) => ({ label: t(NEW_DOC[type].key), to: newDocRoute(type), icon: NEW_DOC[type].icon })),
  }
})

/** FR-22.23/.24: a row's actions — each offered exactly when the API takes it (`document-row-actions`). */
function rowActions(item: Invoice): RowAction[] {
  const row = { type: item.type, direction: 'outgoing', status: item.status, cashSaleId: item.cashSaleId }
  const note = (type: string) => ({ name: 'invoicing.sales.new', query: { type, relatedInvoiceId: item._id } })
  return [
    { key: 'open', label: t('common.open'), icon: 'mdi-open-in-app', to: { name: 'invoicing.sales.edit', params: { id: item._id } } },
    { key: 'issue', label: t('invoicing.issueFlow.issue'), icon: 'mdi-send-check', show: can.canIssue(row), handler: () => sendInvoice(item) },
    { key: 'print', label: t('common.print'), icon: 'mdi-printer', handler: () => printRow(item) },
    { key: 'payment', label: t('invoicing.recordPayment'), icon: 'mdi-cash', show: can.canRecordPayment(row), handler: () => openPaymentDialog(item) },
    { key: 'email', label: t('invoicing.sendEmail.action'), icon: 'mdi-email-arrow-right-outline', show: can.canEmail(row), handler: () => openRowEmail(item) },
    { key: 'credit-note', label: t('invoicing.docType.credit_note'), icon: 'mdi-file-undo', show: can.canCorrect(row), to: note('credit_note') },
    { key: 'debit-note', label: t('invoicing.docType.debit_note'), icon: 'mdi-file-plus-outline', show: can.canCorrect(row), to: note('debit_note') },
    {
      key: 'copy', label: t('common.copy'), icon: 'mdi-content-copy', show: can.canCopy(row),
      to: { name: 'invoicing.sales.new', query: { ...(item.type !== 'invoice' ? { type: item.type } : {}), copyOf: item._id } },
    },
    { key: 'void', label: t('invoicing.void'), icon: 'mdi-cancel', color: 'error', divider: true, show: can.canVoid(row), handler: () => confirmVoid(item) },
    { key: 'delete', label: t('common.delete'), icon: 'mdi-delete', color: 'error', divider: true, show: can.canDelete(row), handler: () => confirmDelete(item) },
  ]
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
    await exportList('invoice', opts.format, opts.mode, {
      direction: 'outgoing',
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
