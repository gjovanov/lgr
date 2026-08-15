<template>
  <ListScaffold
    :title="$t('nav.reservations')"
    :headers="headers"
    :items="items"
    :loading="loading"
    :pagination="pagination"
    :has-active-filters="hasActiveFilters"
    :empty="{ icon: 'mdi-lock-clock', title: $t('list.empty.reservations'), description: $t('list.empty.reservationsHint') }"
    :empty-filtered="{ title: $t('list.noMatches'), description: $t('list.adjustFilters') }"
    @update:options="onUpdateOptions"
  >
    <template #filters>
      <FilterBar v-model:search="search">
        <v-col cols="12" sm="6" md="3">
          <StatusMultiselect v-model="statusFilter" :items="statusOptions" :label="$t('common.status')" />
        </v-col>
      </FilterBar>
    </template>

    <template #item.number="{ item }">
      <span class="font-weight-medium">{{ item.number }}</span>
      <v-icon v-if="item.shortage" size="14" color="error" class="ml-1" :title="$t('invoicing.stockShortage')">mdi-alert</v-icon>
    </template>
    <template #item.productName="{ item }">
      <div>{{ item.productName || '—' }}</div>
      <div v-if="item.productSku" class="text-caption text-medium-emphasis">{{ item.productSku }}</div>
    </template>
    <template #item.contactName="{ item }">{{ item.contactName }}</template>
    <template #item.source="{ item }">
      <v-chip v-if="item.source === 'order'" size="x-small" variant="tonal" color="info">
        {{ item.orderNumber || 'ORDO' }}
      </v-chip>
      <v-chip v-else size="x-small" variant="tonal">{{ $t('invoicing.sourceStock') }}</v-chip>
      <div class="text-caption text-medium-emphasis">{{ item.warehouseName }}</div>
    </template>
    <template #item.internalOrderNumber="{ item }">
      <router-link v-if="item.internalOrderId" :to="`/internal-orders/${item.internalOrderId}/edit`">
        {{ item.internalOrderNumber }}
      </router-link>
      <span v-else class="text-medium-emphasis">—</span>
    </template>
    <template #item.quantities="{ item }">
      {{ item.quantity }} / {{ item.invoicedQuantity || 0 }} / {{ item.dispatchedQuantity || 0 }}
    </template>
    <template #item.dates="{ item }">
      <div v-if="item.expectedDate" class="text-caption">
        {{ $t('invoicing.expectedDate') }}: {{ item.expectedDate?.split('T')[0] }}
        <v-icon v-if="item.late" size="14" color="error" :title="$t('invoicing.lateDelivery')">mdi-clock-alert-outline</v-icon>
      </div>
      <div v-if="item.requestedDeliveryDate" class="text-caption">
        {{ $t('invoicing.requestedDeliveryDate') }}: {{ item.requestedDeliveryDate?.split('T')[0] }}
      </div>
    </template>
    <template #item.status="{ item }">
      <StatusChip :status="item.status" :history="item.statusHistory" :color-fn="statusColor" />
    </template>
    <template #item.actions="{ item }">
      <v-btn
        v-if="item.status === 'active'"
        icon="mdi-close"
        size="small"
        variant="text"
        color="error"
        :title="$t('invoicing.cancelReservation')"
        :aria-label="$t('invoicing.cancelReservation')"
        @click="confirmCancel(item)"
      />
    </template>

    <v-dialog v-model="cancelDialog" max-width="420">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('invoicing.cancelReservationConfirm', { number: selected?.number }) }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="cancelDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" @click="doCancel">{{ $t('invoicing.cancelReservation') }}</v-btn>
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
import StatusChip from 'ui-shared/components/StatusChip'
import ListScaffold from 'ui-shared/components/ListScaffold.vue'
import FilterBar from 'ui-shared/components/FilterBar.vue'
import StatusMultiselect from '../components/StatusMultiselect.vue'

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const { search, debouncedSearch } = useSearchDebounce()
const statusFilter = ref<string[]>([])
const cancelDialog = ref(false)
const selected = ref<any>(null)

const statusOptions = computed(() => [
  { value: 'active', title: t('invoicing.status.active') },
  { value: 'fulfilled', title: t('invoicing.status.fulfilled') },
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

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/invoicing/reservations`),
  entityKey: 'reservations',
  filters,
})

const headers = computed(() => [
  { title: t('invoicing.reservationNumber'), key: 'number', sortable: true },
  { title: t('invoicing.product'), key: 'productName', sortable: false },
  { title: t('invoicing.customer'), key: 'contactName', sortable: false },
  { title: t('invoicing.source'), key: 'source', sortable: false },
  { title: t('invoicing.internalOrder'), key: 'internalOrderNumber', sortable: false },
  { title: `${t('invoicing.qty')} / ${t('invoicing.invoicedQty')} / ${t('invoicing.dispatchedQty')}`, key: 'quantities', sortable: false, align: 'end' as const },
  { title: t('invoicing.dates'), key: 'dates', sortable: false },
  { title: t('common.status'), key: 'status' },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function statusColor(s: string) {
  return ({ active: 'primary', fulfilled: 'success', cancelled: 'error' }[s] || 'grey')
}

function confirmCancel(item: any) { selected.value = item; cancelDialog.value = true }
async function doCancel() {
  try {
    await httpClient.post(`${appStore.orgUrl()}/invoicing/reservations/${selected.value._id}/cancel`, {})
    showSuccess(t('common.savedSuccessfully'))
    cancelDialog.value = false
    await fetchItems()
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => {
  statusFilter.value = statusOptions.value.map(o => o.value)
  fetchItems()
})
</script>
