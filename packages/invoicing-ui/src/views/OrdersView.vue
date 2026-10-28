<template>
  <ListScaffold
    :title="$t('nav.externalOrders')"
    :subtitle="$t('nav.externalOrdersHint')"
    :headers="headers"
    :items="items"
    :loading="loading"
    :pagination="pagination"
    :has-active-filters="hasActiveFilters"
    :empty="{ icon: 'mdi-clipboard-list-outline', title: $t('list.empty.orders'), description: $t('list.empty.ordersHint') }"
    :empty-filtered="{ title: $t('list.noMatches'), description: $t('list.adjustFilters') }"
    @update:options="onUpdateOptions"
  >
    <template #actions>
      <CreateButton :label="$t('invoicing.newOrder')" :to="{ name: 'invoicing.orders.new' }" />
    </template>

    <template #filters>
      <FilterBar v-model:search="search">
        <v-col cols="12" sm="6" md="3">
          <StatusMultiselect v-model="statusFilter" :items="statusOptions" :label="$t('common.status')" />
        </v-col>
      </FilterBar>
    </template>

    <template #empty-actions>
      <CreateButton :label="$t('invoicing.newOrder')" :to="{ name: 'invoicing.orders.new' }" />
    </template>

    <template #item.number="{ item }">
      <entity-link :label="item.number" :to="{ name: 'invoicing.orders.edit', params: { id: item._id } }" />
    </template>
    <template #item.issueDate="{ item }">{{ item.issueDate?.split('T')[0] }}</template>
    <template #item.supplierNames="{ item }">
      <v-chip v-for="name in item.supplierNames" :key="name" size="x-small" variant="tonal" class="mr-1">{{ name }}</v-chip>
    </template>
    <template #item.received="{ item }">
      <span :class="item.receivedQuantity >= item.orderedQuantity && item.orderedQuantity > 0 ? 'text-success' : ''">
        {{ item.receivedQuantity }} / {{ item.orderedQuantity }}
      </span>
    </template>
    <template #item.status="{ item }">
      <StatusChip :status="item.status" :history="item.statusHistory" :color-fn="statusColor" />
    </template>
    <template #item.actions="{ item }">
      <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'invoicing.orders.edit', params: { id: item._id } }" :title="$t('common.edit')" :aria-label="$t('common.edit')" />
      <v-btn v-if="item.status === 'draft'" icon="mdi-send" size="small" variant="text" color="primary" :title="$t('invoicing.sendOrder')" :aria-label="$t('invoicing.sendOrder')" @click="sendOrder(item)" />
      <v-btn v-if="item.status === 'draft'" icon="mdi-delete" size="small" variant="text" color="error" :title="$t('common.delete')" :aria-label="$t('common.delete')" @click="confirmDelete(item)" />
    </template>

    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('invoicing.deleteOrderConfirm') }}</v-card-text>
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
import { useListQueryState, allOptionsParam } from 'ui-shared/composables/useListQueryState'
import CreateButton from 'ui-shared/components/CreateButton.vue'
import EntityLink from 'ui-shared/components/EntityLink'
import StatusChip from 'ui-shared/components/StatusChip'
import ListScaffold from 'ui-shared/components/ListScaffold.vue'
import FilterBar from 'ui-shared/components/FilterBar.vue'
import StatusMultiselect from 'ui-shared/components/StatusMultiselect.vue'

interface Item { _id: string; number: string; supplierNames: string[]; issueDate: string; status: string; orderedQuantity: number; receivedQuantity: number; statusHistory?: any[] }

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const { search, debouncedSearch } = useSearchDebounce()
const deleteDialog = ref(false)
const selectedId = ref('')

// FR-22.15: exactly the statuses a supplier order can have; all of them is the declared default, so a
// bare URL stays bare (the list used to write every status into it on load).
const STATUSES = ['draft', 'sent', 'partially_received', 'received', 'completed', 'cancelled'] as const
const statusFilter = ref<string[]>([...STATUSES])
const statusOptions = computed(() => STATUSES.map((value) => ({ value, title: t(`invoicing.status.${value}`) })))
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
  allOptionsParam('status', statusFilter, STATUSES),
])

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/invoicing/orders`),
  entityKey: 'orders',
  filters,
  urlSync: true,
})

const headers = computed(() => [
  { title: t('invoicing.orderNumber'), key: 'number', sortable: true },
  { title: t('invoicing.issueDate'), key: 'issueDate', sortable: true },
  { title: t('invoicing.suppliers'), key: 'supplierNames', sortable: false },
  { title: t('invoicing.receivedQty'), key: 'received', sortable: false, align: 'end' as const },
  { title: t('common.status'), key: 'status' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function statusColor(s: string) {
  return ({ draft: 'grey', sent: 'info', partially_received: 'warning', received: 'primary', completed: 'success', cancelled: 'error' }[s] || 'grey')
}

async function sendOrder(item: Item) {
  loading.value = true
  try {
    await httpClient.post(`${appStore.orgUrl()}/invoicing/orders/${item._id}/send`)
    showSuccess(t('invoicing.orderSent'))
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
    await httpClient.delete(`${appStore.orgUrl()}/invoicing/orders/${selectedId.value}`)
    showSuccess(t('common.deletedSuccessfully'))
    await fetchItems()
    deleteDialog.value = false
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => {
  fetchItems()
})
</script>
