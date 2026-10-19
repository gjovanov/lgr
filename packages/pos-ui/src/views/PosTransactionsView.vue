<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">POS Transactions</h1>
    </div>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="2">
            <v-text-field
              v-model="search"
              prepend-inner-icon="mdi-magnify"
              :label="$t('common.search')"
              clearable
              hide-details
              density="compact"
            />
          </v-col>
          <v-col cols="12" md="2">
            <v-select
              v-model="typeFilter"
              label="Type"
              :items="typeOptions"
              clearable
              hide-details
              density="compact"
            />
          </v-col>
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
            <v-select
              v-model="fiscalFilter"
              label="Fiscal"
              :items="fiscalOptions"
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
          <template #item.transactionNumber="{ item }">
            <entity-link :label="item.transactionNumber" :to="{ name: 'pos.orders.detail', params: { id: item._id || item.id } }" />
          </template>
          <template #item.type="{ item }">
            <v-chip size="small" label :color="typeColor(item.type)">{{ item.type }}</v-chip>
          </template>
          <template #item.status="{ item }">
            <v-chip size="small" label :color="statusColor(item.status)">{{ item.status }}</v-chip>
          </template>
          <template #item.total="{ item }">
            {{ fmtCurrency(item.total) }}
          </template>
          <template #item.paymentMethod="{ item }">
            {{ primaryPaymentMethod(item) }}
          </template>
          <template #item.isFiscal="{ item }">
            <v-chip size="small" label :color="item.isFiscal ? 'success' : 'grey'">{{ item.isFiscal ? 'Yes' : 'No' }}</v-chip>
          </template>
          <template #item.createdAt="{ item }">
            {{ item.createdAt?.split('T')[0] }}
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-eye" size="small" variant="text" :to="{ name: 'pos.orders.detail', params: { id: item._id || item.id } }" />
            <!-- #145: STORNO straight from the journal. -->
            <v-btn
              v-if="canStorno(item)"
              size="small"
              variant="tonal"
              color="error"
              class="ml-1"
              prepend-icon="mdi-undo-variant"
              data-testid="storno-button"
              @click="openStorno(item)"
            >
              {{ $t('pos.storno.button') }}
            </v-btn>
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <StornoDialog v-model="stornoOpen" :transaction="stornoTarget" @done="onStornoDone" />
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import EntityLink from 'ui-shared/components/EntityLink'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import StornoDialog from '../components/StornoDialog.vue'
import { canStornoTransaction } from '../composables/storno'

const { t } = useI18n()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

const { search, debouncedSearch } = useSearchDebounce()
const typeFilter = ref<string | null>(null)
const statusFilter = ref<string | null>(null)
const fiscalFilter = ref<string | null>(null)
const dateFrom = ref<string | null>(null)
const dateTo = ref<string | null>(null)

const typeOptions = ['sale', 'return', 'exchange', 'storno']
const statusOptions = ['completed', 'cancelled']
const fiscalOptions = [
  { title: 'Yes', value: 'true' },
  { title: 'No', value: 'false' },
]

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (typeFilter.value) f.type = typeFilter.value
  if (statusFilter.value) f.status = statusFilter.value
  if (fiscalFilter.value) f.isFiscal = fiscalFilter.value
  if (dateFrom.value) f.dateFrom = dateFrom.value
  if (dateTo.value) f.dateTo = dateTo.value
  return f
})

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url: computed(() => `${appStore.orgUrl()}/trade/pos/transactions`),
  entityKey: 'transactions',
  filters,
})

const headers = computed(() => [
  { title: 'Transaction #', key: 'transactionNumber', sortable: true },
  { title: 'Type', key: 'type', sortable: true },
  { title: t('common.status'), key: 'status', sortable: true },
  { title: 'UNP', key: 'unpNumber', sortable: false },
  { title: t('common.total'), key: 'total', align: 'end' as const, sortable: true },
  { title: 'Payment', key: 'paymentMethod', sortable: false },
  { title: 'Fiscal', key: 'isFiscal', sortable: true },
  { title: 'Created', key: 'createdAt', sortable: true },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function fmtCurrency(amount: number, currency?: string) {
  return formatCurrency(amount, currency || baseCurrency.value, localeCode.value)
}

function typeColor(type: string) {
  const map: Record<string, string> = {
    sale: 'success',
    return: 'warning',
    exchange: 'info',
    storno: 'error',
  }
  return map[type] || 'grey'
}

function statusColor(s: string) {
  const map: Record<string, string> = {
    completed: 'success',
    cancelled: 'grey-darken-1',
  }
  return map[s] || 'grey'
}

function primaryPaymentMethod(item: any) {
  if (!item.payments || item.payments.length === 0) return '-'
  return item.payments[0].method
}

// ── #145: STORNO ────────────────────────────────────────────────────────────────────────────
const { showSuccess, showSnackbar } = useSnackbar()
const stornoOpen = ref(false)
const stornoTarget = ref<any | null>(null)

function canStorno(item: any) {
  return canStornoTransaction(item, appStore.user?.role)
}

function openStorno(item: any) {
  stornoTarget.value = item
  stornoOpen.value = true
}

function onStornoDone(result: { transaction: any; receiptError?: string; stockError?: string }) {
  const warnings = [
    result.stockError && t('pos.stockNotMoved', { reason: result.stockError }),
  ].filter(Boolean)
  if (warnings.length) showSnackbar(warnings.join(' · '), 'warning', 10000)
  else showSuccess(t('pos.storno.done', { number: result.transaction?.transactionNumber || '' }))
  void fetchItems()
}

onMounted(() => {
  fetchItems()
})
</script>
