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

    <!-- Summary Charts -->
    <v-row v-if="items.length > 0" class="mb-4">
      <v-col cols="12" md="6">
        <v-card>
          <v-card-title class="text-subtitle-1">Payment Distribution</v-card-title>
          <v-card-text>
            <ChartView type="pie" :data="paymentPieData" :height="250" />
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="12" md="6">
        <v-card>
          <v-card-title class="text-subtitle-1">Session Sales</v-card-title>
          <v-card-text>
            <ChartView type="bar" :data="salesBarData" :height="250" />
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

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
            <StatusPipeline :steps="['open', 'closed']" :current="item.status" />
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
          <!-- The session's own cash-register documents: the journal, filtered to this session. -->
          <template #item.transactionCount="{ item }">
            <entity-link
              :label="String(item.transactionCount ?? 0)"
              :to="{ name: 'pos.orders', query: { session: item._id || item.id } }"
              :aria-label="$t('pos.sessionDocuments', { number: item.sessionNumber })"
              data-testid="session-documents"
            />
          </template>
          <template #item.openedAt="{ item }">
            {{ formatDateTime(item.openedAt) }}
          </template>
          <template #item.closedAt="{ item }">
            {{ item.closedAt ? formatDateTime(item.closedAt) : '-' }}
          </template>
          <!-- The session's report: what its close printed after the Z-report, and a reprint. -->
          <template #item.actions="{ item }">
            <v-btn
              icon="mdi-file-chart-outline"
              size="small"
              variant="text"
              :title="$t('pos.sessionReport.view')"
              :aria-label="$t('pos.sessionReport.view')"
              data-testid="session-report-open"
              @click="openReport(item)"
            />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <v-dialog v-model="reportOpen" max-width="520">
      <v-card>
        <v-card-title>{{ $t('pos.sessionReport.title') }}</v-card-title>
        <v-card-text>
          <v-progress-linear v-if="reportLoading" indeterminate class="mb-2" />
          <v-alert v-if="reportError" type="warning" variant="tonal" density="compact" class="mb-2">
            {{ $t('pos.sessionReport.notPrinted', { error: reportError }) }}
          </v-alert>
          <SessionReportCard v-if="report" :report="report" />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn v-if="report" variant="outlined" prepend-icon="mdi-printer" :loading="reportPrinting" @click="printReport">
            {{ $t('pos.sessionReport.print') }}
          </v-btn>
          <v-btn variant="text" @click="reportOpen = false">{{ $t('common.close') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import ChartView from 'ui-shared/components/ChartView.vue'
import EntityLink from 'ui-shared/components/EntityLink'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import StatusPipeline from 'ui-shell/components/StatusPipeline'
import SessionReportCard, { type SessionReportData } from '../components/SessionReportCard.vue'

const { t } = useI18n()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const { showSuccess, showError } = useSnackbar()
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
  { title: '', key: 'actions', sortable: false, align: 'end' as const },
])

// ── The session's report ──
const reportOpen = ref(false)
const reportLoading = ref(false)
const reportPrinting = ref(false)
const report = ref<SessionReportData | null>(null)
const reportError = ref('')
const reportSessionId = ref('')

async function openReport(item: any) {
  reportSessionId.value = item._id || item.id
  report.value = null
  reportError.value = ''
  reportOpen.value = true
  reportLoading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/trade/pos/session/${reportSessionId.value}/report`)
    report.value = data.report
    reportError.value = data.error || ''
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    reportLoading.value = false
  }
}

async function printReport() {
  reportPrinting.value = true
  try {
    await httpClient.post(`${appStore.orgUrl()}/trade/pos/session/${reportSessionId.value}/report/print`)
    reportError.value = ''
    showSuccess(t('pos.sessionReport.printed'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    reportPrinting.value = false
  }
}

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

// Chart data computeds
const paymentPieData = computed(() => {
  const totalCash = items.value.reduce((s: number, i: any) => s + (i.totalCash || 0), 0)
  const totalCard = items.value.reduce((s: number, i: any) => s + (i.totalCard || 0), 0)
  const other = items.value.reduce((s: number, i: any) => s + (i.totalSales || 0), 0) - totalCash - totalCard
  return {
    labels: ['Cash', 'Card', 'Other'],
    datasets: [{
      data: [Math.max(0, totalCash), Math.max(0, totalCard), Math.max(0, other)],
      backgroundColor: ['rgba(76,175,80,0.7)', 'rgba(33,150,243,0.7)', 'rgba(255,152,0,0.7)'],
    }],
  }
})

const salesBarData = computed(() => {
  const last10 = items.value.slice(0, 10).reverse()
  return {
    labels: last10.map((s: any) => s.sessionNumber || `#${s.id?.slice(-4)}`),
    datasets: [{
      label: 'Sales',
      data: last10.map((s: any) => s.totalSales || 0),
      backgroundColor: 'rgba(33,150,243,0.6)',
    }],
  }
})
</script>
