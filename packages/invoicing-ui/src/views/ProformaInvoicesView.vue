<template>
  <ListScaffold
    fit
    :title="$t('nav.proforma')"
    :headers="headers"
    :items="items"
    :loading="loading"
    :pagination="pagination"
    :view="viewMode"
    :has-active-filters="hasActiveFilters"
    :empty="{ icon: 'mdi-file-document-outline', title: $t('list.empty.proforma'), description: $t('list.empty.proformaHint') }"
    :empty-filtered="{ title: $t('list.noMatches'), description: $t('list.adjustFilters') }"
    @update:options="onUpdateOptions"
  >
    <template #actions>
      <ViewSwitcher v-model="viewMode" :views="['list', 'kanban']" />
      <v-btn variant="outlined" prepend-icon="mdi-download" :loading="exportLoading" @click="showExportDialog = true">{{ $t('common.export') }}</v-btn>
      <!-- FR-22.50: says what it creates. -->
      <CreateButton :label="$t('invoicing.newProformaInvoice')" :to="{ name: 'invoicing.proforma.new' }" />
    </template>

    <template #filters>
      <FilterBar v-model:search="search">
        <v-col cols="12" sm="6" md="2">
          <StatusMultiselect v-model="statusFilter" :items="statusOptions" :label="$t('common.status')" />
        </v-col>
        <v-col cols="12" sm="6" md="3">
          <TagInput v-model="tagFilter" type="invoice" :org-url="appStore.orgUrl()" :label="$t('common.filterByTags')" />
        </v-col>
      </FilterBar>
    </template>

    <template #empty-actions>
      <!-- FR-22.50: says what it creates. -->
      <CreateButton :label="$t('invoicing.newProformaInvoice')" :to="{ name: 'invoicing.proforma.new' }" />
    </template>

    <!-- Cell renderers -->
    <template #item.number="{ item }">
      <entity-link :label="item.number" :to="{ name: 'invoicing.proforma.edit', params: { id: item._id } }" />
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
    <template #item.total="{ item }">{{ fmtCurrency(item.total, item.currency) }}</template>
    <template #item.convertedInvoiceNumber="{ item }">
      <entity-link v-if="item.convertedInvoiceId" :label="item.convertedInvoiceNumber || ''" :to="{ name: 'invoicing.sales.edit', params: { id: item.convertedInvoiceId } }" />
      <span v-else-if="item.convertedInvoiceNumber">{{ item.convertedInvoiceNumber }}</span>
    </template>
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
                :to="{ name: 'invoicing.proforma.edit', params: { id: inv._id } }"
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
    <ExportDialog v-model="showExportDialog" :loading="exportLoading" doc-type="proforma" @confirm="onExport" />

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

    <!-- FR-22.23: an issued proforma can be voided; it asks first. -->
    <v-dialog v-model="voidDialog" max-width="440">
      <v-card data-testid="void-dialog">
        <v-card-title>{{ $t('invoicing.void') }}</v-card-title>
        <v-card-text>{{ $t('invoicing.voidConfirmProforma', { number: voidTarget?.number || '' }) }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="voidDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" :loading="loading" @click="doVoid">{{ $t('invoicing.void') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

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
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
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
import EntityLink from 'ui-shared/components/EntityLink'
import ViewSwitcher from 'ui-shared/components/ViewSwitcher.vue'
import KanbanBoard from 'ui-shared/components/KanbanBoard.vue'
import StatusChip from 'ui-shared/components/StatusChip'
import ExportDialog from 'ui-shared/components/ExportDialog'
import ListScaffold from 'ui-shared/components/ListScaffold.vue'
import SendEmailDialog from 'ui-shared/components/SendEmailDialog.vue'
import FilterBar from 'ui-shared/components/FilterBar.vue'
import StatusMultiselect from 'ui-shared/components/StatusMultiselect.vue'
import { useInvoicingExport } from 'ui-shared/composables/useInvoicingExport'
import { useRowEmail } from '../composables/useRowEmail'
import { useDocumentIssue } from '../composables/useDocumentIssue'
import { useRowPrint } from '../composables/useRowPrint'
import * as can from '../composables/document-row-actions'
interface Item { _id: string; number: string; type?: string; contactName: string; contactId?: string; issueDate: string; validUntil: string; status: string; total: number; currency: string; exchangeRate?: number; notes?: string; lines?: any[]; convertedInvoiceId?: string; convertedInvoiceNumber?: string }

const { t } = useI18n()
const router = useRouter()
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
const selectedId = ref('')
// FR-22.15: exactly the statuses a proforma can reach — issued (sent), converted into an invoice,
// voided. „Приета" and „Изтекла" (accepted / expired) are not statuses the model has, so filtering
// on them only ever found nothing. All of them is the default, so a bare URL stays bare.
const STATUSES = ['draft', 'sent', 'converted', 'voided'] as const
/** The list offered before FR-22.15: a bookmark carrying all of it means every status. */
const LEGACY_ALL_STATUSES = ['draft', 'sent', 'accepted', 'converted', 'expired']
const statusFilter = ref<string[]>([...STATUSES])
const tagFilter = ref<string[]>([])
const statusOptions = computed(() => STATUSES.map((v) => ({ value: v, title: t(`invoicing.status.${v}`) })))
const allStatusesSelected = computed(() =>
  statusFilter.value.length === 0 || statusFilter.value.length === statusOptions.value.length,
)

const hasActiveFilters = computed(() =>
  !!debouncedSearch.value || !allStatusesSelected.value || tagFilter.value.length > 0,
)

const filters = computed(() => {
  const f: Record<string, any> = { type: 'proforma' }
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (!allStatusesSelected.value) f.status = statusFilter.value.join(',')
  if (tagFilter.value.length) f.tags = tagFilter.value.join(',')
  return f
})

// FR-05 (#12): grid state in the querystring; declared before usePaginatedTable.
useListQueryState([
  { key: 'q', ref: search, mirror: debouncedSearch },
  allOptionsParam('status', statusFilter, STATUSES, LEGACY_ALL_STATUSES),
  { key: 'tags', ref: tagFilter, codec: 'csv' },
  { key: 'view', ref: viewMode, default: 'list' },
])

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/invoices`),
  entityKey: 'invoices',
  filters,
  urlSync: true,
})

const headers = computed(() => [
  { title: t('invoicing.invoiceNumber'), key: 'number', sortable: true },
  { title: t('invoicing.contact'), key: 'contactName', sortable: true },
  { title: t('invoicing.issueDate'), key: 'issueDate', sortable: true },
  { title: t('invoicing.validUntil'), key: 'dueDate', sortable: true },
  // FR-22.23: every amount is printed with its currency, so this column is offered on the cog.
  { title: t('common.currency'), key: 'currency', defaultHidden: true },
  { title: t('common.total'), key: 'total', align: 'end' as const },
  { title: t('common.status'), key: 'status' },
  { title: t('invoicing.invoiceRef'), key: 'convertedInvoiceNumber' },
  // FR-22.23: one menu button, so the column is as narrow as its title.
  { title: '', key: 'actions', sortable: false, align: 'end' as const, width: 48 },
])

const kanbanColumns = computed(() => [
  { id: 'draft', title: t('invoicing.status.draft'), color: 'grey' },
  { id: 'sent', title: t('invoicing.status.sent'), color: 'blue' },
  { id: 'converted', title: t('invoicing.status.converted'), color: 'green' },
])

const kanbanItems = computed(() => {
  const grouped: Record<string, any[]> = { draft: [], sent: [], converted: [] }
  for (const inv of items.value) {
    const s = inv.status
    if (s === 'draft') grouped.draft.push(inv)
    else if (s === 'sent') grouped.sent.push(inv)
    else if (s === 'converted') grouped.converted.push(inv)
  }
  return grouped
})

function fmtCurrency(amount: number, currency?: string) { return formatCurrency(amount, currency || baseCurrency.value, localeCode.value) }
function statusColor(s: string) { return ({ draft: 'grey', sent: 'info', converted: 'success', voided: 'error' }[s] || 'grey') }

/**
 * FR-22.22: the invoice the proforma becomes opens at once, ready to be issued. The list used to
 * stay where it was, the new invoice only a link in the row's „Фактура #" column.
 */
async function convert(item: Item) {
  loading.value = true
  try {
    const { data } = await httpClient.post(`${appStore.orgUrl()}/invoices/${item._id}/convert`)
    showSuccess(t('invoicing.convertedToInvoice'))
    const invoiceId = data?.invoice?.id || data?.invoice?._id
    if (invoiceId) await router.push({ name: 'invoicing.sales.edit', params: { id: String(invoiceId) } })
    else await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { loading.value = false }
}

// FR-22.22: a proforma is issued (its PRF number) through the path every document issues by; it
// asks no stock question — an offer moves none.
const { issue } = useDocumentIssue({ loading, onIssued: () => fetchItems() })

const voidDialog = ref(false)
const voidTarget = ref<Item | null>(null)
function confirmVoid(item: Item) {
  voidTarget.value = item
  voidDialog.value = true
}
async function doVoid() {
  const item = voidTarget.value
  if (!item) return
  loading.value = true
  try {
    await httpClient.post(`${appStore.orgUrl()}/invoices/${item._id}/void`)
    showSuccess(t('invoicing.proformaVoided'))
    voidDialog.value = false
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

/** FR-22.23/.24: a row's actions — each offered exactly when the API takes it (`document-row-actions`). */
function rowActions(item: Item): RowAction[] {
  const row = { type: 'proforma', direction: 'outgoing', status: item.status }
  return [
    { key: 'open', label: t('common.open'), icon: 'mdi-open-in-app', to: { name: 'invoicing.proforma.edit', params: { id: item._id } } },
    { key: 'issue', label: t('invoicing.issueFlow.issue'), icon: 'mdi-send-check', show: can.canIssue(row), handler: () => issue({ _id: item._id, type: 'proforma' }) },
    { key: 'print', label: t('common.print'), icon: 'mdi-printer', handler: () => printRow(item) },
    { key: 'email', label: t('invoicing.sendEmail.action'), icon: 'mdi-email-arrow-right-outline', show: can.canEmail(row), handler: () => openRowEmail(item) },
    { key: 'convert', label: t('invoicing.convertToInvoice'), icon: 'mdi-swap-horizontal', show: can.canConvert(row), handler: () => convert(item) },
    { key: 'copy', label: t('common.copy'), icon: 'mdi-content-copy', to: { name: 'invoicing.proforma.new', query: { copyOf: item._id } } },
    { key: 'void', label: t('invoicing.void'), icon: 'mdi-cancel', color: 'error', divider: true, show: can.canVoid(row), handler: () => confirmVoid(item) },
    { key: 'delete', label: t('common.delete'), icon: 'mdi-delete', color: 'error', divider: true, show: can.canDelete(row), handler: () => confirmDelete(item) },
  ]
}

function confirmDelete(item: Item) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() {
  try {
    await httpClient.delete(`${appStore.orgUrl()}/invoices/${selectedId.value}`)
    showSuccess(t('common.deletedSuccessfully'))
    await fetchItems()
    deleteDialog.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}
const showExportDialog = ref(false)
const { loading: exportLoading, exportList } = useInvoicingExport(() => appStore.orgUrl())

async function onExport(opts: { format: 'xlsx' | 'pdf'; mode: 'compact' | 'detailed'; columns?: string[] }) {
  try {
    await exportList('proforma', opts.format, opts.mode, {
      status: allStatusesSelected.value ? undefined : statusFilter.value.join(','),
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

onMounted(() => {
  fetchItems()
})
</script>
