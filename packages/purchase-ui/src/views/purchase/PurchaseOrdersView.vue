<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('purchase.orders') }}</h1>
      <v-spacer />
      <v-btn color="primary" prepend-icon="mdi-plus" :to="{ name: 'purchase.orders.new' }">{{ $t('common.create') }}</v-btn>
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="4">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <v-select
              v-model="stateFilter"
              :label="$t('common.state')"
              :items="stateOptions"
              item-title="text"
              item-value="value"
              clearable
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="12" md="2">
            <v-text-field v-model="startDate" :label="$t('common.from')" type="date" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-text-field v-model="endDate" :label="$t('common.to')" type="date" clearable hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <v-card>
      <v-card-text>
        <v-data-table-server
          :headers="headers"
          :items="items"
          :items-length="pagination.total"
          :loading="loading"
          :page="pagination.page + 1"
          :items-per-page="pagination.size"
          @update:options="onUpdateOptions"
          item-value="_id"
          hover
        >
          <template #item.name="{ item }">
            <entity-link :label="item.name" :to="{ name: 'purchase.orders.edit', params: { id: item._id || item.id } }" />
          </template>
          <template #item.vendor="{ item }">
            {{ item.vendor?.companyName || item.vendor?.name || '-' }}
          </template>
          <template #item.state="{ item }">
            <v-chip :color="stateColor(item.state)" size="small" variant="tonal">{{ $t(`purchase.state.${item.state}`) }}</v-chip>
          </template>
          <template #item.amountTotal="{ item }">{{ fmtCurrency(item.amountTotal) }}</template>
          <template #item.receiptStatus="{ item }">
            <v-chip v-if="item.receiptStatus" size="small" variant="outlined">{{ $t(`purchase.receiptStatus.${item.receiptStatus}`) }}</v-chip>
          </template>
          <template #item.invoiceStatus="{ item }">
            <v-chip v-if="item.invoiceStatus" size="small" variant="outlined">{{ $t(`purchase.invoiceStatus.${item.invoiceStatus}`) }}</v-chip>
          </template>
          <template #item.datePlanned="{ item }">
            {{ item.datePlanned ? new Date(item.datePlanned).toLocaleDateString() : '-' }}
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'purchase.orders.edit', params: { id: item._id || item.id } }" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" :disabled="item.state !== 'draft'" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('purchase.deleteOrderConfirm') }}</v-card-text>
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
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import EntityLink from 'ui-shared/components/EntityLink'

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

const { search, debouncedSearch } = useSearchDebounce()
const deleteDialog = ref(false)
const selectedId = ref('')
const stateFilter = ref<string | null>(null)
const startDate = ref<string | null>(null)
const endDate = ref<string | null>(null)

const stateOptions = [
  { value: 'draft', text: t('purchase.state.draft') },
  { value: 'sent', text: t('purchase.state.sent') },
  { value: 'to_approve', text: t('purchase.state.to_approve') },
  { value: 'confirmed', text: t('purchase.state.confirmed') },
  { value: 'done', text: t('purchase.state.done') },
  { value: 'cancelled', text: t('purchase.state.cancelled') },
]

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (stateFilter.value) f.state = stateFilter.value
  if (startDate.value) f.startDate = startDate.value
  if (endDate.value) f.endDate = endDate.value
  return f
})

const url = computed(() => `${appStore.orgUrl()}/purchase/orders`)
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'purchaseOrders',
  filters,
})

const headers = computed(() => [
  { title: t('common.name'), key: 'name', sortable: true },
  { title: t('purchase.vendor'), key: 'vendor', sortable: false },
  { title: t('common.state'), key: 'state', sortable: true },
  { title: t('common.total'), key: 'amountTotal', sortable: true, align: 'end' as const },
  { title: t('purchase.receiptStatus.label'), key: 'receiptStatus', sortable: false },
  { title: t('purchase.invoiceStatus.label'), key: 'invoiceStatus', sortable: false },
  { title: t('purchase.datePlanned'), key: 'datePlanned', sortable: true },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function fmtCurrency(amount: number) {
  return formatCurrency(amount, baseCurrency.value, localeCode.value)
}

function stateColor(state: string): string {
  switch (state) {
    case 'draft': return 'grey'
    case 'sent': return 'info'
    case 'to_approve': return 'warning'
    case 'confirmed': return 'success'
    case 'done': return 'primary'
    case 'cancelled': return 'error'
    default: return 'grey'
  }
}

function confirmDelete(item: any) {
  selectedId.value = item._id || item.id
  deleteDialog.value = true
}

async function doDelete() {
  try {
    await httpClient.delete(`${appStore.orgUrl()}/purchase/orders/${selectedId.value}`)
    await fetchItems()
    deleteDialog.value = false
    showSuccess(t('common.deletedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}

onMounted(() => { fetchItems() })
</script>
