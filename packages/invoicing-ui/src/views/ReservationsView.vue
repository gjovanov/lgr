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
        <v-col cols="12" sm="6" md="3">
          <v-select
            v-model="sourceFilter"
            :items="sourceOptions"
            :label="$t('invoicing.source')"
            density="compact"
            hide-details
            clearable
          />
        </v-col>
      </FilterBar>
    </template>

    <template #item.number="{ item }">
      <span class="text-no-wrap"><EntityLink :label="item.number" :to="{ name: 'invoicing.reservations.detail', params: { id: item._id } }" /></span>
      <v-icon v-if="item.shortage" size="14" color="error" class="ml-1" :title="$t('invoicing.stockShortage')">mdi-alert</v-icon>
      <div v-if="item.repeatOf" class="text-caption text-medium-emphasis">{{ $t('invoicing.reservations.repeatOf') }}</div>
    </template>
    <template #item.productName="{ item }">
      <div>{{ item.productName || '—' }}</div>
      <div v-if="item.productSku" class="text-caption text-medium-emphasis">{{ item.productSku }}</div>
    </template>
    <template #item.contactName="{ item }">{{ item.contactName }}</template>
    <!-- #203: where the goods come from — the shelf, or the outgoing order (ORDO) it waits for, by number. -->
    <template #item.source="{ item }">
      <router-link v-if="item.source === 'order' && item.orderId" class="text-no-wrap" :to="{ name: 'invoicing.orders.edit', params: { id: item.orderId } }">
        {{ item.orderNumber || '…' }}
      </router-link>
      <v-chip v-else size="x-small" variant="tonal">{{ $t('invoicing.sourceStock') }}</v-chip>
      <div class="text-caption text-medium-emphasis">
        <template v-if="item.source === 'order'">{{ $t('invoicing.reservations.fromOutgoingOrder') }} · </template>{{ item.warehouseName }}
      </div>
    </template>
    <template #item.internalOrderNumber="{ item }">
      <router-link v-if="item.internalOrderId" class="text-no-wrap" :to="{ name: 'invoicing.internalOrders.edit', params: { id: item.internalOrderId } }">
        {{ item.internalOrderNumber }}
      </router-link>
      <span v-else class="text-medium-emphasis">—</span>
    </template>
    <template #item.quantities="{ item }">
      {{ item.quantity }} / {{ item.invoicedQuantity || 0 }} / {{ item.dispatchedQuantity || 0 }}
    </template>
    <template #item.dates="{ item }">
      <div v-if="item.expectedDate" class="text-caption">
        {{ $t('invoicing.expectedDate') }}: <span class="text-no-wrap">{{ item.expectedDate?.split('T')[0] }}</span>
        <v-icon v-if="item.late" size="14" color="error" :title="$t('invoicing.lateDelivery')">mdi-clock-alert-outline</v-icon>
      </div>
      <div v-if="item.requestedDeliveryDate" class="text-caption">
        {{ $t('invoicing.requestedDeliveryDate') }}: <span class="text-no-wrap">{{ item.requestedDeliveryDate?.split('T')[0] }}</span>
      </div>
    </template>
    <template #item.status="{ item }">
      <StatusChip :status="item.status" :history="item.statusHistory" :color-fn="statusColor" />
    </template>
    <template #item.actions="{ item }">
      <template v-if="item.status === 'active'">
        <v-btn
          icon="mdi-pencil"
          size="small"
          variant="text"
          :title="$t('invoicing.reservations.changeQuantity')"
          :aria-label="$t('invoicing.reservations.changeQuantity')"
          @click="openEdit(item)"
        />
        <v-btn
          v-if="(item.releasable || 0) > 0"
          icon="mdi-close"
          size="small"
          variant="text"
          color="error"
          :title="$t('invoicing.reservations.release')"
          :aria-label="$t('invoicing.reservations.release')"
          @click="openRelease(item)"
        />
      </template>
      <!-- #203: a cancelled reservation can be made again directly — once. -->
      <v-btn
        v-else-if="item.status === 'cancelled'"
        icon="mdi-restore"
        size="small"
        variant="text"
        color="primary"
        :loading="repeating === item._id"
        :title="$t('invoicing.reservations.reserveAgain')"
        :aria-label="$t('invoicing.reservations.reserveAgain')"
        @click="reserveAgain(item)"
      />
    </template>

    <ReservationReleaseDialog
      v-model="releaseDialog"
      :reservation="selected"
      :subtitle="selected ? `${selected.productName || ''} · ${selected.contactName || ''}` : ''"
      @released="fetchItems"
    />

    <ReservationQuantityDialog
      v-model="editDialog"
      :reservation="selected"
      :subtitle="selected ? `${selected.productName || ''} · ${selected.contactName || ''}` : ''"
      @saved="fetchItems"
    />

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
import StatusChip from 'ui-shared/components/StatusChip'
import EntityLink from 'ui-shared/components/EntityLink'
import ListScaffold from 'ui-shared/components/ListScaffold.vue'
import FilterBar from 'ui-shared/components/FilterBar.vue'
import StatusMultiselect from 'ui-shared/components/StatusMultiselect.vue'
import ReservationQuantityDialog from '../components/ReservationQuantityDialog.vue'
import ReservationReleaseDialog from '../components/ReservationReleaseDialog.vue'
import { reservationErrorMessage } from '../composables/reservation-errors'

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()

const { search, debouncedSearch } = useSearchDebounce()
const statusFilter = ref<string[]>([])
const sourceFilter = ref<'stock' | 'order' | null>(null)
const releaseDialog = ref(false)
const editDialog = ref(false)
const repeating = ref('')
const selected = ref<any>(null)

const statusOptions = computed(() => [
  { value: 'active', title: t('invoicing.status.active') },
  { value: 'fulfilled', title: t('invoicing.status.fulfilled') },
  { value: 'cancelled', title: t('invoicing.status.cancelled') },
])
const sourceOptions = computed(() => [
  { value: 'stock', title: t('invoicing.sourceStock') },
  { value: 'order', title: t('invoicing.reservations.fromOutgoingOrder') },
])
const allStatusesSelected = computed(() =>
  statusFilter.value.length === 0 || statusFilter.value.length === statusOptions.value.length,
)
const hasActiveFilters = computed(() => !!debouncedSearch.value || !allStatusesSelected.value || !!sourceFilter.value)

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (!allStatusesSelected.value) f.status = statusFilter.value.join(',')
  if (sourceFilter.value) f.source = sourceFilter.value
  return f
})

// FR-05 (#12): grid state in the querystring; declared before usePaginatedTable.
useListQueryState([
  { key: 'q', ref: search, mirror: debouncedSearch },
  { key: 'status', ref: statusFilter, codec: 'csv' },
  { key: 'source', ref: sourceFilter, sanitize: (v: any) => (v === 'stock' || v === 'order' ? v : undefined) },
])

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/invoicing/reservations`),
  entityKey: 'reservations',
  filters,
  urlSync: true,
})

const headers = computed(() => [
  { title: t('invoicing.reservationNumber'), key: 'number', sortable: true },
  { title: t('invoicing.product'), key: 'productName', sortable: false },
  { title: t('invoicing.customer'), key: 'contactName', sortable: false },
  // #203: which orders — the outgoing one it waits for (its source), the incoming one it serves.
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

function openRelease(item: any) {
  selected.value = item
  releaseDialog.value = true
}

function openEdit(item: any) {
  selected.value = item
  editDialog.value = true
}

async function reserveAgain(item: any) {
  repeating.value = item._id
  try {
    const { data } = await httpClient.post(`${appStore.orgUrl()}/invoicing/reservations/${item._id}/repeat`, {})
    showSuccess(data.created
      ? t('invoicing.reservations.reservedAgain', { number: data.reservation.reservationNumber })
      : t('invoicing.reservations.alreadyReservedAgain', { number: data.reservation.reservationNumber }))
    await fetchItems()
  } catch (e: any) {
    showError(reservationErrorMessage(e, t))
  } finally {
    repeating.value = ''
  }
}

onMounted(() => {
  if (!statusFilter.value.length) statusFilter.value = statusOptions.value.map(o => o.value)
  fetchItems()
})
</script>
