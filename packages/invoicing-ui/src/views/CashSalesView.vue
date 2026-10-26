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
        <v-col cols="12" sm="6" md="2">
          <v-select
            v-model="invoicedFilter"
            :items="invoicedOptions"
            :label="$t('invoicing.cashSaleInvoice.filterInvoiced')"
            density="compact"
            hide-details
            clearable
          />
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
    <!-- #171: the invoices issued for the sale, read back from them. -->
    <template #item.invoices="{ item }">
      <div class="d-flex flex-wrap ga-1">
        <v-chip
          v-for="inv in item.invoices || []"
          :key="inv.id"
          size="x-small"
          variant="tonal"
          :color="item.invoicingState === 'full' ? 'primary' : 'warning'"
          :to="{ name: 'invoicing.sales.edit', params: { id: inv.id } }"
          :title="item.invoicingState === 'partial' ? $t('invoicing.cashSaleInvoice.statePartial') : $t('invoicing.cashSaleInvoice.stateFull')"
        >
          {{ inv.number }}
        </v-chip>
      </div>
    </template>
    <template #item.actions="{ item }">
      <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'invoicing.cash-sales.edit', params: { id: item._id } }" :title="$t('common.edit')" :aria-label="$t('common.edit')" />
      <v-btn
        v-if="item.status === 'paid' && item.invoicingState !== 'full'"
        icon="mdi-file-document-plus-outline"
        size="small"
        variant="text"
        color="primary"
        :title="$t('invoicing.cashSaleInvoice.action')"
        :aria-label="$t('invoicing.cashSaleInvoice.action')"
        @click="openInvoiceDialog(item)"
      />
      <!-- FR-10 (#19): email from the row. Tooltip on a wrapper span — a disabled v-btn has
           `pointer-events: none`, so a tooltip on the button itself never fires. -->
      <v-tooltip
        location="top"
        :text="canEmail(item) ? $t('invoicing.sendEmail.action') : $t('invoicing.sendEmail.draftBlocked')"
      >
        <template #activator="{ props: tip }">
          <span v-bind="tip">
            <v-btn
              icon="mdi-email-arrow-right-outline"
              size="small"
              variant="text"
              :disabled="!canEmail(item)"
              :aria-label="$t('invoicing.sendEmail.action')"
              @click="openRowEmail(item)"
            />
          </span>
        </template>
      </v-tooltip>
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

    <CashSaleInvoiceDialog v-if="invoiceFor" v-model="invoiceDialog" :cash-sale-id="invoiceFor" @issued="onInvoiceIssued" />

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
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { useListQueryState, allOptionsParam } from 'ui-shared/composables/useListQueryState'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import EntityLink from 'ui-shared/components/EntityLink'
import ViewSwitcher from 'ui-shared/components/ViewSwitcher.vue'
import KanbanBoard from 'ui-shared/components/KanbanBoard.vue'
import StatusChip from 'ui-shared/components/StatusChip'
import ExportDialog from 'ui-shared/components/ExportDialog'
import DocImportDialog from 'ui-shared/components/DocImportDialog.vue'
import ListScaffold from 'ui-shared/components/ListScaffold.vue'
import SendEmailDialog from 'ui-shared/components/SendEmailDialog.vue'
import FilterBar from 'ui-shared/components/FilterBar.vue'
import DateField from 'ui-shared/components/DateField.vue'
import StatusMultiselect from 'ui-shared/components/StatusMultiselect.vue'
import { useInvoicingExport } from 'ui-shared/composables/useInvoicingExport'
import { useRowEmail } from '../composables/useRowEmail'
import { useRouter } from 'vue-router'
import CashSaleInvoiceDialog from '../components/CashSaleInvoiceDialog.vue'
interface Item {
  _id: string; number: string; contactName: string; contactId?: string; date: string; status: string; total: number; currency: string
  exchangeRate?: number; notes?: string; lines?: any[]; paymentMethod?: string
  /** #171: the invoices issued for the sale, and how far it is invoiced. */
  invoices?: Array<{ id: string; number: string; status: string }>; invoicingState?: 'none' | 'partial' | 'full'
}

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

// FR-10 (#19): the row-level "send by email" action.
const {
  dialogOpen: emailDialog,
  loading: emailLoading,
  defaultTo: emailTo,
  defaultSubject: emailSubject,
  documentNumber: emailDocNumber,
  canEmail,
  open: openRowEmail,
  send: sendRowEmail,
} = useRowEmail()

const { search, debouncedSearch } = useSearchDebounce()
const viewMode = ref('list')
const dateFrom = ref<string | null>(null)
const dateTo = ref<string | null>(null)
const deleteDialog = ref(false)
const selectedId = ref('')
// FR-22.15: exactly the statuses a cash sale can have. It is paid the moment it is made (there is
// no draft cash sale), and removing its source document voids it; „Завършена" (completed) is not
// a status the model has. All of them is the default, so a bare URL stays bare.
const STATUSES = ['paid', 'voided'] as const
/** The list offered before FR-22.15: a bookmark carrying all of it means every status. */
const LEGACY_ALL_STATUSES = ['draft', 'completed', 'paid']
const statusFilter = ref<string[]>([...STATUSES])
const statusOptions = computed(() => STATUSES.map((v) => ({ value: v, title: t(`invoicing.status.${v}`) })))
const allStatusesSelected = computed(() =>
  statusFilter.value.length === 0 || statusFilter.value.length === statusOptions.value.length,
)

const hasActiveFilters = computed(() =>
  !!debouncedSearch.value || !allStatusesSelected.value || !!dateFrom.value || !!dateTo.value,
)

// #171: invoiced or not — the link lives on the invoices, so the server resolves it.
const invoicedFilter = ref<'' | 'yes' | 'no' | null>(null)
const invoicedOptions = computed(() => [
  { value: 'yes', title: t('common.yes') },
  { value: 'no', title: t('common.no') },
])

const filters = computed(() => {
  const f: Record<string, any> = { type: 'cash_sale' }
  if (invoicedFilter.value) f.invoiced = invoicedFilter.value
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (!allStatusesSelected.value) f.status = statusFilter.value.join(',')
  if (dateFrom.value) f.startDate = dateFrom.value
  if (dateTo.value) f.endDate = dateTo.value
  return f
})

// FR-05 (#12): grid state in the querystring; declared before usePaginatedTable.
useListQueryState([
  { key: 'q', ref: search, mirror: debouncedSearch },
  allOptionsParam('status', statusFilter, STATUSES, LEGACY_ALL_STATUSES),
  { key: 'from', ref: dateFrom, codec: 'date' },
  { key: 'to', ref: dateTo, codec: 'date' },
  { key: 'invoiced', ref: invoicedFilter, sanitize: (v: any) => (v === 'yes' || v === 'no' ? v : undefined) },
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
  { title: t('invoicing.cashSaleInvoice.column'), key: 'invoices', sortable: false },
  { title: t('common.status'), key: 'status' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

// ── #171: „Издай фактура" from the row ──
const router = useRouter()
const invoiceDialog = ref(false)
const invoiceFor = ref('')
function openInvoiceDialog(item: Item) {
  invoiceFor.value = item._id
  invoiceDialog.value = true
}
function onInvoiceIssued(invoice: any) {
  router.push({ name: 'invoicing.sales.edit', params: { id: invoice.id || invoice._id } })
}

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
  fetchItems()
})
</script>
