<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.debitNotes') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2 align-center">
        <ViewSwitcher v-model="viewMode" :views="['list', 'kanban']" class="mr-2" />
        <v-btn variant="outlined" prepend-icon="mdi-download" @click="showExportDialog = true" :loading="exportLoading">{{ $t('common.export') }}</v-btn>
        <responsive-btn color="primary" icon="mdi-plus" :to="{ name: 'invoicing.debit-notes.new' }">{{ $t('common.create') }}</responsive-btn>
      </div>
    </div>
    <ExportDialog v-model="showExportDialog" :loading="exportLoading" doc-type="debit_note" @confirm="onExport" />

    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="4">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="statusFilter" :label="$t('common.status')" :items="statusOptions" item-title="title" item-value="value" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <TagInput v-model="tagFilter" type="invoice" :org-url="appStore.orgUrl()" :label="$t('common.filterByTags')" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <!-- Data Table (list view) -->
    <v-card v-if="viewMode === 'list'">
      <v-card-text>
        <v-data-table-server :headers="headers" :items="items" :items-length="pagination.total" :loading="loading" :page="pagination.page + 1" :items-per-page="pagination.size" @update:options="onUpdateOptions" item-value="_id" hover>
          <template #item.number="{ item }">
            <entity-link :label="item.number" :to="{ name: 'invoicing.debit-notes.edit', params: { id: item._id } }" />
          </template>
          <template #item.contactName="{ item }">
            <entity-link v-if="item.contactId" :label="item.contactName" :to="{ name: 'invoicing.contacts.edit', params: { id: item.contactId } }" />
            <span v-else>{{ item.contactName }}</span>
          </template>
          <template #item.issueDate="{ item }">{{ item.issueDate?.split('T')[0] }}</template>
          <template #item.status="{ item }">
            <StatusChip :status="item.status" :history="item.statusHistory" :color-fn="statusColor" />
          </template>
          <template #item.total="{ item }">{{ fmtCurrency(item.total, item.currency) }}</template>
          <template #item.relatedInvoiceNumber="{ item }">
            <entity-link v-if="item.relatedInvoiceId" :label="item.relatedInvoiceNumber || ''" :to="{ name: 'invoicing.sales.edit', params: { id: item.relatedInvoiceId } }" />
            <span v-else-if="item.relatedInvoiceNumber">{{ item.relatedInvoiceNumber }}</span>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'invoicing.debit-notes.edit', params: { id: item._id } }" />
            <v-btn
              v-if="item.status === 'draft'"
              icon="mdi-send"
              size="small"
              variant="text"
              color="info"
              :title="$t('invoicing.send')"
              @click="sendDebitNote(item)"
            />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Kanban view -->
    <KanbanBoard
      v-if="viewMode === 'kanban'"
      :columns="kanbanColumns"
      :items="kanbanItems"
      item-key="_id"
      :drag-enabled="false"
    >
      <template #card="{ item: inv }">
        <div class="d-flex flex-column ga-1">
          <div class="d-flex align-center justify-space-between">
            <router-link
              :to="{ name: 'invoicing.debit-notes.edit', params: { id: inv._id } }"
              class="text-subtitle-2 font-weight-bold text-decoration-none"
            >
              {{ inv.number }}
            </router-link>
            <span class="text-body-2 font-weight-medium">{{ fmtCurrency(inv.total, inv.currency) }}</span>
          </div>
          <span class="text-body-2 text-medium-emphasis">{{ inv.contactName }}</span>
          <div class="d-flex align-center ga-1 mt-1">
            <v-chip size="x-small" variant="tonal">
              {{ inv.issueDate?.split('T')[0] || '-' }}
            </v-chip>
          </div>
        </div>
      </template>
    </KanbanBoard>

    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('invoicing.deleteDebitNoteConfirm') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" @click="doDelete">{{ $t('common.delete') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
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
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import TagInput from 'ui-shared/components/TagInput.vue'
import EntityLink from 'ui-shared/components/EntityLink'
import ViewSwitcher from 'ui-shared/components/ViewSwitcher.vue'
import KanbanBoard from 'ui-shared/components/KanbanBoard.vue'
import StatusChip from 'ui-shared/components/StatusChip'
import ExportDialog from 'ui-shared/components/ExportDialog'
import { useInvoicingExport } from 'ui-shared/composables/useInvoicingExport'
interface Item { _id: string; number: string; contactName: string; contactId?: string; relatedInvoiceId?: string; relatedInvoiceNumber?: string; issueDate?: string; date: string; status: string; total: number; currency: string; exchangeRate?: number; reason?: string; lines?: any[] }

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const { search, debouncedSearch } = useSearchDebounce()
const viewMode = ref('list')
const deleteDialog = ref(false)
const selectedId = ref('')
const statusFilter = ref<string | null>(null)
const tagFilter = ref<string[]>([])
const statusOptions = computed(() => [
  { value: 'draft',   title: t('invoicing.status.draft') },
  { value: 'issued',  title: t('invoicing.status.issued') },
  { value: 'applied', title: t('invoicing.status.applied') },
  { value: 'voided',  title: t('invoicing.status.voided') },
])

const filters = computed(() => {
  const f: Record<string, any> = { type: 'debit_note' }
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (statusFilter.value) f.status = statusFilter.value
  if (tagFilter.value.length) f.tags = tagFilter.value.join(',')
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/invoices`),
  entityKey: 'invoices',
  filters,
})

const headers = computed(() => [
  { title: t('invoicing.invoiceNumber'), key: 'number', sortable: true },
  { title: t('invoicing.contact'), key: 'contactName', sortable: true },
  { title: t('invoicing.relatedInvoice'), key: 'relatedInvoiceNumber' },
  { title: t('common.date'), key: 'issueDate', sortable: true },
  { title: t('common.currency'), key: 'currency' },
  { title: t('common.total'), key: 'total', align: 'end' as const },
  { title: t('common.status'), key: 'status' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

const kanbanColumns = [
  { id: 'draft', title: t('invoicing.status.draft'), color: 'grey' },
  { id: 'sent', title: t('invoicing.status.sent'), color: 'blue' },
  { id: 'paid', title: t('invoicing.status.paid'), color: 'green' },
]

const kanbanItems = computed(() => {
  const grouped: Record<string, any[]> = { draft: [], sent: [], paid: [] }
  for (const inv of items.value) {
    const s = inv.status
    if (s === 'draft') grouped.draft.push(inv)
    else if (s === 'issued') grouped.sent.push(inv)
    else if (s === 'applied') grouped.paid.push(inv)
  }
  return grouped
})

function fmtCurrency(amount: number, currency?: string) { return formatCurrency(amount, currency || baseCurrency.value, localeCode.value) }
function statusColor(s: string) { return ({ draft: 'grey', issued: 'info', applied: 'success', voided: 'error' }[s] || 'grey') }
function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

async function sendDebitNote(item: Item) {
  loading.value = true
  try {
    await httpClient.post(`${orgUrl()}/invoices/${item._id}/send`)
    showSuccess(t('invoicing.debitNoteIssued') || t('invoicing.invoiceSent'))
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally { loading.value = false }
}

function confirmDelete(item: Item) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() {
  try {
    await httpClient.delete(`${orgUrl()}/invoices/${selectedId.value}`)
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
    await exportList('debit_note', opts.format, opts.mode, {
      status: statusFilter.value || undefined,
      tags: tagFilter.value.length ? tagFilter.value.join(',') : undefined,
    }, {
      sortBy: pagination.value.sortBy,
      sortOrder: pagination.value.sortOrder,
      columns: opts.columns,
    })
    showExportDialog.value = false
    showSuccess(t('export.success'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('export.failed'))
  }
}

onMounted(() => { fetchItems() })
</script>
