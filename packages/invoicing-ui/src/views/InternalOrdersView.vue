<template>
  <ListScaffold
    :title="$t('nav.internalOrders')"
    :subtitle="$t('nav.internalOrdersHint')"
    :headers="headers"
    :items="items"
    :loading="loading"
    :pagination="pagination"
    :has-active-filters="hasActiveFilters"
    :empty="{ icon: 'mdi-account-clock-outline', title: $t('list.empty.internalOrders'), description: $t('list.empty.internalOrdersHint') }"
    :empty-filtered="{ title: $t('list.noMatches'), description: $t('list.adjustFilters') }"
    @update:options="onUpdateOptions"
  >
    <template #actions>
      <responsive-btn color="primary" icon="mdi-plus" :to="{ name: 'invoicing.internalOrders.new' }">
        {{ $t('common.create') }}
      </responsive-btn>
    </template>

    <template #filters>
      <FilterBar v-model:search="search">
        <v-col cols="12" sm="6" md="3">
          <StatusMultiselect v-model="statusFilter" :items="statusOptions" :label="$t('common.status')" />
        </v-col>
      </FilterBar>
    </template>

    <template #empty-actions>
      <responsive-btn color="primary" icon="mdi-plus" :to="{ name: 'invoicing.internalOrders.new' }">
        {{ $t('common.create') }}
      </responsive-btn>
    </template>

    <template #item.number="{ item }">
      <entity-link :label="item.number" :to="{ name: 'invoicing.internalOrders.edit', params: { id: item._id } }" />
    </template>
    <template #item.contactName="{ item }">{{ item.contactName }}</template>
    <template #item.issueDate="{ item }">{{ item.issueDate?.split('T')[0] }}</template>
    <template #item.requestedDeliveryDate="{ item }">
      <span :class="item.late ? 'text-error font-weight-medium' : ''">
        {{ item.requestedDeliveryDate?.split('T')[0] }}
        <v-icon v-if="item.late" size="14" color="error">mdi-alert-circle-outline</v-icon>
      </span>
    </template>
    <template #item.priority="{ item }">
      <v-chip size="x-small" label variant="tonal" :color="priorityColor(item.priority)">
        {{ $t(`invoicing.priority.${item.priority || 'normal'}`) }}
      </v-chip>
    </template>
    <template #item.coverage="{ item }">
      <v-chip size="x-small" label variant="tonal" :color="coverageColor(item.reservationCoverage)">
        {{ $t(`invoicing.coverage.${item.reservationCoverage}`) }}<span v-if="item.shortQuantity > 0"> (−{{ item.shortQuantity }})</span>
      </v-chip>
    </template>
    <template #item.delivered="{ item }">
      <span :class="item.deliveredQuantity >= item.orderedQuantity && item.orderedQuantity > 0 ? 'text-success' : ''">
        {{ item.deliveredQuantity }} / {{ item.orderedQuantity }}
      </span>
    </template>
    <template #item.status="{ item }">
      <StatusChip :status="item.status" :history="item.statusHistory" :color-fn="statusColor" />
    </template>
    <template #item.actions="{ item }">
      <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'invoicing.internalOrders.edit', params: { id: item._id } }" :title="$t('common.edit')" :aria-label="$t('common.edit')" />
      <v-btn v-if="item.status === 'draft'" icon="mdi-check" size="small" variant="text" color="primary" :title="$t('invoicing.confirmOrder')" :aria-label="$t('invoicing.confirmOrder')" @click="confirmOrder(item)" />
      <v-btn v-if="item.status === 'draft'" icon="mdi-delete" size="small" variant="text" color="error" :title="$t('common.delete')" :aria-label="$t('common.delete')" @click="confirmDelete(item)" />
    </template>

    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('invoicing.deleteInternalOrderConfirm') }}</v-card-text>
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
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { useListQueryState } from 'ui-shared/composables/useListQueryState'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import EntityLink from 'ui-shared/components/EntityLink'
import StatusChip from 'ui-shared/components/StatusChip'
import ListScaffold from 'ui-shared/components/ListScaffold.vue'
import FilterBar from 'ui-shared/components/FilterBar.vue'
import StatusMultiselect from 'ui-shared/components/StatusMultiselect.vue'

interface Item {
  _id: string
  number: string
  contactName: string
  issueDate: string
  requestedDeliveryDate: string
  priority: string
  status: string
  orderedQuantity: number
  deliveredQuantity: number
  reservationCoverage: string
  shortQuantity: number
  late: boolean
  statusHistory?: any[]
}

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const { search, debouncedSearch } = useSearchDebounce()
const deleteDialog = ref(false)
const selectedId = ref('')
const statusFilter = ref<string[]>([])

const statusOptions = computed(() => [
  { value: 'draft', title: t('invoicing.status.draft') },
  { value: 'confirmed', title: t('invoicing.status.confirmed') },
  { value: 'partially_delivered', title: t('invoicing.status.partially_delivered') },
  { value: 'delivered', title: t('invoicing.status.delivered') },
  { value: 'completed', title: t('invoicing.status.completed') },
  { value: 'cancelled', title: t('invoicing.status.cancelled') },
])
const allStatusesSelected = computed(() =>
  statusFilter.value.length === 0 || statusFilter.value.length === statusOptions.value.length,
)
const hasActiveFilters = computed(() => !!debouncedSearch.value || !allStatusesSelected.value)

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (!allStatusesSelected.value) f.status = statusFilter.value.join(',')
  return f
})

// FR-05 (#12): grid state in the querystring; declared before usePaginatedTable.
useListQueryState([
  { key: 'q', ref: search, mirror: debouncedSearch },
  { key: 'status', ref: statusFilter, codec: 'csv' },
])

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/invoicing/internal-orders`),
  entityKey: 'internalOrders',
  filters,
  urlSync: true,
})

const headers = computed(() => [
  { title: t('invoicing.orderNumber'), key: 'number', sortable: true },
  { title: t('invoicing.customer'), key: 'contactName', sortable: false },
  { title: t('invoicing.issueDate'), key: 'issueDate', sortable: true },
  { title: t('invoicing.requestedDeliveryDate'), key: 'requestedDeliveryDate', sortable: true },
  { title: t('invoicing.priority.label'), key: 'priority', sortable: false },
  { title: t('invoicing.coverage.label'), key: 'coverage', sortable: false },
  { title: t('invoicing.deliveredQty'), key: 'delivered', sortable: false, align: 'end' as const },
  { title: t('common.status'), key: 'status' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function statusColor(s: string) {
  return ({ draft: 'grey', confirmed: 'info', partially_delivered: 'warning', delivered: 'primary', completed: 'success', cancelled: 'error' }[s] || 'grey')
}
function priorityColor(p: string) {
  return ({ low: 'grey', normal: undefined, high: 'warning', urgent: 'error' } as Record<string, string | undefined>)[p]
}
function coverageColor(c: string) {
  return ({ none: 'error', partial: 'warning', full: 'success' }[c] || 'grey')
}

async function confirmOrder(item: Item) {
  loading.value = true
  try {
    await httpClient.post(`${appStore.orgUrl()}/invoicing/internal-orders/${item._id}/confirm`)
    showSuccess(t('invoicing.orderConfirmed'))
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

function confirmDelete(item: Item) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() {
  try {
    await httpClient.delete(`${appStore.orgUrl()}/invoicing/internal-orders/${selectedId.value}`)
    showSuccess(t('common.deletedSuccessfully'))
    await fetchItems()
    deleteDialog.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => {
  if (!statusFilter.value.length) statusFilter.value = statusOptions.value.map(o => o.value)
  fetchItems()
})
</script>
