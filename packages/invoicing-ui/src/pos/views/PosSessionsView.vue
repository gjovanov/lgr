<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.crSessions') }}</h1>
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
          <v-card-title class="text-subtitle-1">{{ $t('pos.sessions.paymentDistribution') }}</v-card-title>
          <v-card-text>
            <ChartView type="pie" :data="paymentPieData" :height="250" />
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="12" md="6">
        <v-card>
          <v-card-title class="text-subtitle-1">{{ $t('pos.sessions.sales') }}</v-card-title>
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
            <StatusPipeline :steps="[$t('pos.sessions.states.open'), $t('pos.sessions.states.closed')]" :current="$t(`pos.sessions.states.${item.status}`)" />
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
              :to="{ name: 'invoicing.cash-sales', query: { session: item._id || item.id } }"
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
            <div class="d-flex justify-end">
              <v-btn
                icon="mdi-file-chart-outline"
                size="small"
                variant="text"
                :title="$t('pos.sessionReport.view')"
                :aria-label="$t('pos.sessionReport.view')"
                data-testid="session-report-open"
                @click="openReport(item)"
              />
              <!-- FR-23: a close that died in its Z leaves the session here, and the terminal offers only an
                   open one: this is the way back to it. -->
              <v-btn
                v-if="closeDied(item)"
                icon="mdi-cash-register"
                size="small"
                variant="text"
                color="warning"
                :title="$t('pos.close.closeAgain')"
                :aria-label="$t('pos.close.closeAgain')"
                data-testid="session-close-again"
                @click="closeAgain(item)"
              />
              <!-- The device's own reports, for whoever runs the devices. No Z: it runs only through
                   a session's close, and one printed here would make that close print zeros. -->
              <v-menu v-if="runsDevices" @update:model-value="(open: boolean) => open && loadReportDevice(item)">
                <template #activator="{ props: menu }">
                  <v-btn
                    v-bind="menu"
                    icon="mdi-printer-pos-outline"
                    size="small"
                    variant="text"
                    :title="$t('pos.deviceReport.menu')"
                    :aria-label="$t('pos.deviceReport.menu')"
                    data-testid="session-device-report"
                  />
                </template>
                <v-list density="compact" min-width="280" max-width="380" data-testid="session-device-report-menu">
                  <v-list-item v-if="deviceLoading"><v-progress-linear indeterminate /></v-list-item>
                  <v-list-item v-else-if="!reportDevice" disabled :title="$t('pos.deviceReport.noDevice')" data-testid="device-report-none" />
                  <template v-else>
                    <v-list-subheader>
                      {{ reportDevice.connected ? reportDevice.name : $t('pos.deviceReport.notConnected', { name: reportDevice.name }) }}
                    </v-list-subheader>
                    <!-- A page of zeros from a device not yet fiscalized is no failure: say so before it prints. -->
                    <v-list-item v-if="notOnDeviceText" data-testid="device-report-not-on-device">
                      <v-alert type="info" variant="tonal" density="compact" class="text-body-2">{{ notOnDeviceText }}</v-alert>
                    </v-list-item>
                    <v-list-item
                      v-for="choice in reportChoices(item)"
                      :key="choice.kind"
                      :title="$t(choice.label)"
                      :data-testid="`device-report-${choice.kind}`"
                      @click="chooseReport(choice.kind, item)"
                    />
                  </template>
                </v-list>
              </v-menu>
            </div>
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
          <v-btn v-if="report && canPrintReport" variant="outlined" prepend-icon="mdi-printer" :loading="reportPrinting" @click="printReport">
            {{ $t('pos.sessionReport.print') }}
          </v-btn>
          <v-btn variant="text" @click="reportOpen = false">{{ $t('common.close') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <CloseSessionDialog
      v-if="closing"
      v-model="closeOpen"
      :session-id="closing._id || closing.id"
      :org-url="`/org/${appStore.currentOrg?.id}`"
      :currency="closing.currency"
      :can-skip-fiscal="canSkipFiscal"
      @closed="onClosedAgain"
    />

    <!-- What a report reads, prefilled from the session. An X reads nothing and prints at once. -->
    <v-dialog v-model="paramsOpen" max-width="420">
      <v-card v-if="paramsKind" data-testid="device-report-params">
        <v-card-title>{{ $t(REPORT_LABEL[paramsKind]) }}</v-card-title>
        <v-card-text>
          <v-alert v-if="notOnDeviceText" type="info" variant="tonal" density="compact" class="mb-3 text-body-2" data-testid="device-report-params-not-on-device">
            {{ notOnDeviceText }}
          </v-alert>
          <template v-if="paramsKind === 'fm_date' || paramsKind === 'ej'">
            <v-text-field v-model="params.startDate" :label="$t('invoicing.dateFrom')" type="date" density="compact" data-testid="device-report-from" />
            <v-text-field v-model="params.endDate" :label="$t('invoicing.dateTo')" type="date" density="compact" data-testid="device-report-to" />
          </template>
          <template v-if="paramsKind === 'fm_number'">
            <v-text-field v-model.number="params.startNumber" :label="$t('pos.deviceReport.numberFrom')" type="number" min="1" density="compact" data-testid="device-report-from" />
            <v-text-field v-model.number="params.endNumber" :label="$t('pos.deviceReport.numberTo')" type="number" min="1" density="compact" data-testid="device-report-to" />
          </template>
          <v-switch
            v-if="paramsKind === 'fm_date' || paramsKind === 'fm_number'"
            v-model="params.detailed"
            :label="$t('pos.deviceReport.detailed')"
            color="primary"
            density="compact"
            hide-details
          />
          <v-select
            v-if="paramsKind === 'operator'"
            v-model="params.operatorNumber"
            :items="operatorOptions"
            :label="$t('pos.deviceReport.operatorNumber')"
            density="compact"
            hide-details
          />
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn variant="text" @click="paramsOpen = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="primary" variant="flat" prepend-icon="mdi-printer" :loading="deviceReportPrinting" data-testid="device-report-print" @click="printDeviceReport">
            {{ $t('pos.deviceReport.print') }}
          </v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { FISCAL_ADMIN_ROLES } from 'config/constants'
import { useAppStore } from '../../store/app.store'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import ChartView from 'ui-shared/components/ChartView.vue'
import EntityLink from 'ui-shared/components/EntityLink'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { jwtRole, sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import { canOpenPage, pageById } from 'ui-shared/nav/page-registry'
import StatusPipeline from 'ui-shell/components/StatusPipeline'
import SessionReportCard, { type SessionReportData } from '../components/SessionReportCard.vue'
import CloseSessionDialog from '../components/CloseSessionDialog.vue'

const { t } = useI18n()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const { showSuccess, showError } = useSnackbar()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

const statusFilter = ref<string | null>(null)
const dateFrom = ref<string | null>(null)
const dateTo = ref<string | null>(null)

const statusOptions = computed(() => ['open', 'closed'].map(value => ({ title: t(`pos.sessions.states.${value}`), value })))

// A session whose close died in its Z: the dialog asks the server, which puts it back and says what to do.
const closing = ref<any>(null)
const closeOpen = ref(false)
const canSkipFiscal = computed(() => ['admin', 'manager'].includes(jwtRole() ?? ''))
/** Its lease lapsed, or it has none, from before there was one: the server has the last word on that. */
const closeDied = (item: any) => item.status === 'closing_control' && (!item.closeLeaseUntil || new Date(item.closeLeaseUntil).getTime() < Date.now())
function closeAgain(item: any) {
  closing.value = item
  closeOpen.value = true
}
function onClosedAgain() {
  closing.value = null
  void fetchItems()
}

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
  { title: t('pos.sessions.number'), key: 'sessionNumber', sortable: true },
  { title: t('common.status'), key: 'status', sortable: true },
  { title: t('pos.openingBalance'), key: 'openingBalance', align: 'end' as const, sortable: true },
  { title: t('pos.totalSales'), key: 'totalSales', align: 'end' as const, sortable: true },
  { title: t('pos.sessions.totalReturns'), key: 'totalReturns', align: 'end' as const, sortable: true },
  { title: t('pos.sessions.transactions'), key: 'transactionCount', align: 'end' as const, sortable: true },
  { title: t('pos.sessions.openedAt'), key: 'openedAt', sortable: true },
  { title: t('pos.sessions.closedAt'), key: 'closedAt', sortable: true },
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

// ── The device's own reports ──
type ReportKind = 'x' | 'fm_date' | 'fm_number' | 'ej' | 'operator'
interface ReportDevice { name: string; connected: boolean; capabilities: { features: Record<string, boolean>; maxOperators: number } }

/** A reprint writes to the till, as a sale does: `pos.read` reads the report and prints nothing. The server refuses it too. */
const canPrintReport = canOpenPage(pageById('/invoicing/cash-sales/new')!, sessionViewer())

/** The roles of the device page's report routes: not a cashier. The server refuses them too. */
const runsDevices = computed(() => FISCAL_ADMIN_ROLES.includes(appStore.user?.role || jwtRole()))

const REPORT_LABEL: Record<ReportKind, string> = {
  x: 'pos.deviceReport.x',
  fm_date: 'pos.deviceReport.fmByDate',
  fm_number: 'pos.deviceReport.fmByNumber',
  ej: 'pos.deviceReport.ej',
  operator: 'pos.deviceReport.operator',
}

const reportDevice = ref<ReportDevice | null>(null)
/** The session's text receipts, which the device's reports leave out: they move none of its counters. */
const reportNotOnDevice = ref<{ receipts: number; amount: number | null; currency?: string } | null>(null)
const notOnDeviceText = computed(() => {
  const left = reportNotOnDevice.value
  if (!left) return ''
  return left.amount === null
    ? t('pos.deviceReport.notOnDeviceCount', { receipts: left.receipts })
    : t('pos.deviceReport.notOnDevice', { receipts: left.receipts, amount: fmtCurrency(left.amount, left.currency) })
})
const deviceLoading = ref(false)
const deviceReportPrinting = ref(false)
const reportSession = ref<any>(null)

const paramsOpen = ref(false)
const paramsKind = ref<ReportKind | null>(null)
const params = ref<Record<string, any>>({})
const operatorOptions = computed(() => [
  { title: t('pos.deviceReport.allOperators'), value: 0 },
  ...Array.from({ length: reportDevice.value?.capabilities.maxOperators || 0 }, (_, i) => ({ title: String(i + 1), value: i + 1 })),
])

/** The row whose menu was opened last: an answer for another row, landing after it, is dropped. */
let reportFor = ''

/** The device this session's reports print on, as the server resolves it, asked when the menu opens. */
async function loadReportDevice(item: any) {
  const id = String(item._id || item.id)
  reportFor = id
  reportDevice.value = null
  reportNotOnDevice.value = null
  deviceLoading.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/trade/pos/session/${id}/device-report`)
    if (reportFor !== id) return
    reportDevice.value = data.device
    reportNotOnDevice.value = data.notOnDevice ?? null
  } catch (e: any) {
    if (reportFor === id) showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    if (reportFor === id) deviceLoading.value = false
  }
}

/** What this row offers: what the device can do, and an X only while its day is the session's. */
function reportChoices(item: any): { kind: ReportKind; label: string }[] {
  const has = (feature: string) => !!reportDevice.value?.capabilities.features[feature]
  const offered: [ReportKind, boolean][] = [
    ['x', item.status === 'open' && has('xReport')],
    ['fm_date', has('fmReportByDate')],
    ['fm_number', has('fmReportByNumber')],
    ['ej', has('electronicJournal')],
    ['operator', has('operatorReport')],
  ]
  return offered.filter(([, on]) => on).map(([kind]) => ({ kind, label: REPORT_LABEL[kind] }))
}

/** The calendar day of an instant on the org's clock, else this browser's, as a date field holds it. */
function orgDay(at: string | Date): string {
  const parts = (timeZone?: string) => new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(at))
  let found: Intl.DateTimeFormatPart[]
  try {
    found = parts((appStore.currentOrg as any)?.settings?.timezone || undefined)
  } catch {
    found = parts() // a zone the browser does not know
  }
  const part = (type: string) => found.find(p => p.type === type)?.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

/** Prefilled from the session: its days, its Z-report. */
function chooseReport(kind: ReportKind, item: any) {
  reportSession.value = item
  paramsKind.value = kind
  if (kind === 'x') {
    params.value = {}
    void printDeviceReport()
    return
  }
  const z = Number(item.zReportNumber) || null
  params.value = {
    startDate: orgDay(item.openedAt),
    endDate: orgDay(item.closedAt || new Date()),
    startNumber: z,
    endNumber: z,
    detailed: false,
    operatorNumber: 0,
  }
  paramsOpen.value = true
}

async function printDeviceReport() {
  deviceReportPrinting.value = true
  try {
    const id = reportSession.value._id || reportSession.value.id
    await httpClient.post(`${appStore.orgUrl()}/trade/pos/session/${id}/device-report`, { kind: paramsKind.value, ...params.value })
    paramsOpen.value = false
    showSuccess(t('pos.deviceReport.printed'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    deviceReportPrinting.value = false
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
      label: t('pos.sessions.salesSeries'),
      data: last10.map((s: any) => s.totalSales || 0),
      backgroundColor: 'rgba(33,150,243,0.6)',
    }],
  }
})
</script>
