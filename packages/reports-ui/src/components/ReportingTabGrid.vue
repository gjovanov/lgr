<template>
  <v-card variant="outlined">
    <v-card-text>
      <p v-if="description" class="text-body-2 text-medium-emphasis mb-3">{{ description }}</p>

      <!-- Filter bar -->
      <v-row dense>
        <v-col cols="12" md="3">
          <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
        </v-col>
        <v-col cols="12" md="3">
          <StatusMultiselect v-model="statusFilter" :items="statusOptions" :label="$t('common.status')" />
        </v-col>
        <v-col cols="12" md="3">
          <DateField v-model="dateFrom" :label="$t('invoicing.dateFrom')" hide-details density="compact" />
        </v-col>
        <v-col cols="12" md="3">
          <DateField v-model="dateTo" :label="$t('invoicing.dateTo')" hide-details density="compact" />
        </v-col>
        <v-col cols="12" md="3">
          <StatusMultiselect
            v-model="paymentMethodFilter"
            :items="paymentMethodOptions"
            :label="$t('invoicing.paymentMethod')"
            :all-label="$t('common.allPaymentMethods')"
          />
        </v-col>
        <v-col cols="12" md="3">
          <TagInput v-model="tagFilter" type="invoice" :org-url="appStore.orgUrl()" :label="$t('common.filterByTags')" />
        </v-col>
      </v-row>

      <!-- Action row -->
      <div class="d-flex align-center mt-3 mb-2">
        <span class="text-body-2 text-medium-emphasis">{{ pagination.total }} {{ $t('common.results') }}</span>
        <v-spacer />
        <v-btn color="primary" variant="flat" prepend-icon="mdi-download" :loading="exportLoading" @click="showExportDialog = true">
          {{ $t('common.export') }}
        </v-btn>
      </div>

      <!-- Grid -->
      <v-data-table-server
        :headers="headers"
        :items="items"
        :items-length="pagination.total"
        :loading="loading"
        :page="pagination.page + 1"
        :items-per-page="pagination.size"
        item-value="_id"
        density="compact"
        hover
        @update:options="onUpdateOptions"
      >
        <template #item.number="{ item }">
          <entity-link :label="item.number" :href="numberLinkHref(item)" />
        </template>
        <template #item.issueDate="{ item }">{{ item.issueDate?.split('T')[0] || item.date?.split('T')[0] }}</template>
        <template #item.contactName="{ item }">{{ item.contactName }}</template>
        <template #item.status="{ item }">
          <StatusChip :status="item.status" />
        </template>
        <template #item.total="{ item }">{{ formatCurrency(item.total || 0, item.currency || baseCurrency) }}</template>
        <template #no-data>
          <EmptyState
            icon="mdi-file-search-outline"
            :title="$t('list.noMatches')"
            :description="$t('list.adjustFilters')"
          />
        </template>
      </v-data-table-server>

      <ExportDialog
        v-model="showExportDialog"
        :doc-type="docType"
        :loading="exportLoading"
        default-format="pdf"
        :show-aggregate="kind === 'cash_register'"
        :default-aggregate="kind === 'cash_register'"
        @confirm="onExport"
      />
    </v-card-text>
  </v-card>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useListQueryState } from 'ui-shared/composables/useListQueryState'
import { appHref } from 'ui-shared/nav/navigate'
import { usePaymentMethods } from 'ui-shared/composables/usePaymentMethods'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import EntityLink from 'ui-shared/components/EntityLink'
import StatusChip from 'ui-shared/components/StatusChip'
import TagInput from 'ui-shared/components/TagInput.vue'
import DateField from 'ui-shared/components/DateField.vue'
import ExportDialog from 'ui-shared/components/ExportDialog.vue'
import { decodeBlobError } from 'ui-shared/composables/useInvoicingExport'
import EmptyState from 'ui-shared/components/EmptyState.vue'
import StatusMultiselect from 'ui-shared/components/StatusMultiselect.vue'
import type { DocType } from 'ui-shared/composables/useExportColumns'

type Kind = 'outgoing' | 'incoming' | 'cash_register'

const props = defineProps<{
  kind: Kind
  docType: DocType
  statusOptions: { value: string; title: string }[]
  description?: string
}>()

const { t } = useI18n()
const appStore = useAppStore()
const { showError, showSuccess } = useSnackbar()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')

const { search, debouncedSearch } = useSearchDebounce()
const statusFilter = ref<string[]>([])
const paymentMethodFilter = ref<string[]>([])
const tagFilter = ref<string[]>([])

// Payment methods are matched against `payments[].method` (and the doc-level
// `paymentMethod` for documents recorded without a payment line).
const paymentMethods = usePaymentMethods()
const paymentMethodOptions = computed(() => [
  ...paymentMethods.value.map(m => ({ value: m.value, title: m.text })),
  { value: 'other', title: t('common.other') },
])
const allPaymentMethodsSelected = computed(() =>
  paymentMethodFilter.value.length === 0 || paymentMethodFilter.value.length === paymentMethodOptions.value.length,
)
const dateFrom = ref('')
const dateTo = ref('')

const allStatusesSelected = computed(() =>
  statusFilter.value.length === 0 || statusFilter.value.length === props.statusOptions.length,
)

/**
 * FR-6.19 brings this grid up to the FR-05 convention it predates: filters + pagination
 * live in the querystring, so a configured export is a shareable link and Back restores it.
 * Declared BEFORE usePaginatedTable so its deep filters-watcher registers against the
 * already-hydrated values instead of firing a spurious reset + second fetch on mount.
 *
 * Only ONE grid is mounted at a time (ReportingExportView keys it on the active tab), so
 * these plain, unprefixed keys cannot collide between the three kinds.
 */
useListQueryState([
  { key: 'q', ref: search, mirror: debouncedSearch },
  { key: 'status', ref: statusFilter, codec: 'csv' },
  { key: 'pm', ref: paymentMethodFilter, codec: 'csv' },
  { key: 'tags', ref: tagFilter, codec: 'csv' },
  { key: 'from', ref: dateFrom, codec: 'date' },
  { key: 'to', ref: dateTo, codec: 'date' },
])

const filters = computed(() => {
  const f: Record<string, any> = {}
  // Server-side filters (mapped on the listing endpoint by kind)
  if (props.kind === 'outgoing') { f.direction = 'outgoing'; f.types = 'invoice,credit_note,debit_note' }
  // FR-01: the incoming side is merged too — bills + incoming credit/debit notes.
  else if (props.kind === 'incoming') { f.direction = 'incoming'; f.types = 'invoice,credit_note,debit_note' }
  else if (props.kind === 'cash_register') { f.type = 'cash_sale' }

  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (!allStatusesSelected.value) f.status = statusFilter.value.join(',')
  if (dateFrom.value) f.startDate = dateFrom.value
  if (dateTo.value) f.endDate = dateTo.value
  if (tagFilter.value.length) f.tags = tagFilter.value.join(',')
  if (!allPaymentMethodsSelected.value) f.paymentMethod = paymentMethodFilter.value.join(',')
  return f
})

// Server list endpoint:
//  - outgoing/incoming/cash_register all hit /invoices
//  - outgoing uses `types` (comma-separated) handled by the controller
//  - incoming/cash_register use `type` singular
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/invoices`),
  entityKey: 'invoices',
  filters,
  urlSync: true,
})

const headers = computed(() => [
  { title: t('invoicing.invoiceNumber'), key: 'number',      sortable: true },
  { title: t('invoicing.issueDate'),     key: 'issueDate',   sortable: true },
  { title: t('invoicing.contact'),       key: 'contactName', sortable: false },
  { title: t('common.status'),           key: 'status',      sortable: true },
  { title: t('common.currency'),         key: 'currency',    sortable: false },
  { title: t('common.total'),            key: 'total',       sortable: true, align: 'end' as const },
])

/**
 * FR-6.19: this grid now lives in the Reports SPA, so the document links must be absolute
 * HREFs into the invoicing app — Vue Router cannot cross SPAs, and the route names these
 * used to push (`invoicing.sales.edit` & co) do not exist in this router at all.
 *
 * FR-01: every type opens in the merged form of its side.
 */
function numberLinkHref(item: any) {
  if (props.kind === 'cash_register') return appHref('invoicing', `/invoicing/cash-sales/${item._id}/edit`)
  if (props.kind === 'incoming')      return appHref('invoicing', `/invoicing/bills/${item._id}/edit`)
  return appHref('invoicing', `/invoicing/invoices/${item._id}/edit`)
}

// Export dialog
const showExportDialog = ref(false)
const exportLoading = ref(false)

async function onExport(opts: { format: 'xlsx' | 'pdf'; mode: 'compact' | 'detailed'; columns: string[]; aggregated?: boolean }) {
  exportLoading.value = true
  try {
    const url = `${appStore.orgUrl()}/invoicing/export/kind/${props.kind}`
    const res = await httpClient.post(url, {
      format: opts.format,
      mode: opts.mode,
      columns: opts.columns,
      aggregated: opts.aggregated || undefined,
      search: debouncedSearch.value || undefined,
      status: allStatusesSelected.value ? undefined : statusFilter.value.join(','),
      tags: tagFilter.value.length ? tagFilter.value.join(',') : undefined,
      paymentMethod: allPaymentMethodsSelected.value ? undefined : paymentMethodFilter.value.join(','),
      startDate: dateFrom.value || undefined,
      endDate: dateTo.value || undefined,
      locale: appStore.locale,
      sortBy: pagination.value.sortBy,
      sortOrder: pagination.value.sortOrder,
    }, { responseType: 'blob' })

    const blob = new Blob([res.data], { type: res.headers['content-type'] })
    const dispo = res.headers['content-disposition'] as string | undefined
    const match = dispo?.match(/filename="([^"]+)"/)
    const filename = match?.[1] || `reporting-${props.kind}.${opts.format}`

    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = filename
    link.click()
    URL.revokeObjectURL(link.href)
    showSuccess(t('common.downloadStarted'))
    showExportDialog.value = false
  } catch (e: any) {
    // Server errors arrive as a Blob of JSON under responseType:'blob' — decode in place first.
    await decodeBlobError(e).catch(() => {})
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    exportLoading.value = false
  }
}

onMounted(() => {
  // "Everything selected" is the default, but it must not clobber a selection the URL
  // carried in — an empty ref means the querystring said nothing about this filter.
  if (!statusFilter.value.length) statusFilter.value = props.statusOptions.map(o => o.value)
  if (!paymentMethodFilter.value.length) paymentMethodFilter.value = paymentMethodOptions.value.map(o => o.value)
  fetchItems()
})
</script>
