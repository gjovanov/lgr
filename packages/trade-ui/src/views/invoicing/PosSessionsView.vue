<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">POS Sessions</h1>
    </div>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="2">
            <v-select
              v-model="statusFilter"
              :label="$t('common.status')"
              :items="statusOptions"
              clearable
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="12" md="2">
            <v-text-field v-model="dateFrom" :label="$t('invoicing.dateFrom')" type="date" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-text-field v-model="dateTo" :label="$t('invoicing.dateTo')" type="date" clearable hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <!-- Data Table -->
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
          <template #item.status="{ item }">
            <v-chip size="small" label :color="statusColor(item.status)">{{ item.status }}</v-chip>
          </template>
          <template #item.openingBalance="{ item }">
            {{ fmtCurrency(item.openingBalance) }}
          </template>
          <template #item.totalSales="{ item }">
            {{ fmtCurrency(item.totalSales) }}
          </template>
          <template #item.totalReturns="{ item }">
            {{ fmtCurrency(item.totalReturns) }}
          </template>
          <template #item.openedAt="{ item }">
            {{ formatDateTime(item.openedAt) }}
          </template>
          <template #item.closedAt="{ item }">
            {{ item.closedAt ? formatDateTime(item.closedAt) : '-' }}
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'

const { t } = useI18n()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

const statusFilter = ref<string | null>(null)
const dateFrom = ref<string | null>(null)
const dateTo = ref<string | null>(null)

const statusOptions = ['open', 'closed']

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (statusFilter.value) f.status = statusFilter.value
  if (dateFrom.value) f.dateFrom = dateFrom.value
  if (dateTo.value) f.dateTo = dateTo.value
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/trade/pos/session`),
  entityKey: 'sessions',
  filters,
})

const headers = computed(() => [
  { title: 'Session #', key: 'sessionNumber', sortable: true },
  { title: t('common.status'), key: 'status', sortable: true },
  { title: 'Opening Balance', key: 'openingBalance', align: 'end' as const, sortable: true },
  { title: 'Total Sales', key: 'totalSales', align: 'end' as const, sortable: true },
  { title: 'Total Returns', key: 'totalReturns', align: 'end' as const, sortable: true },
  { title: 'Transactions', key: 'transactionCount', align: 'end' as const, sortable: true },
  { title: 'Opened At', key: 'openedAt', sortable: true },
  { title: 'Closed At', key: 'closedAt', sortable: true },
])

function fmtCurrency(amount: number, currency?: string) {
  return formatCurrency(amount, currency || baseCurrency.value, localeCode.value)
}

function formatDateTime(dateStr: string) {
  if (!dateStr) return '-'
  const d = new Date(dateStr)
  return d.toLocaleString()
}

function statusColor(s: string) {
  const map: Record<string, string> = {
    open: 'success',
    closed: 'grey',
  }
  return map[s] || 'grey'
}

onMounted(() => {
  fetchItems()
})
</script>
