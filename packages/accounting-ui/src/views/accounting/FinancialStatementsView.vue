<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('accounting.financialStatements') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <export-menu module="accounting" />
      </div>
    </div>

    <v-tabs v-model="activeTab" class="mb-4">
      <v-tab value="trial-balance">{{ $t('accounting.trialBalance') }}</v-tab>
      <v-tab value="pnl">{{ $t('accounting.profitAndLoss') }}</v-tab>
      <v-tab value="bs">{{ $t('accounting.balanceSheet') }}</v-tab>
    </v-tabs>

    <!-- Date Filters -->
    <v-card class="mb-4">
      <v-card-text>
        <v-row>
          <template v-if="activeTab === 'pnl'">
            <v-col cols="12" md="4">
              <v-text-field
                v-model="dateFrom"
                :label="$t('common.dateFrom')"
                type="date"
              />
            </v-col>
            <v-col cols="12" md="4">
              <v-text-field
                v-model="dateTo"
                :label="$t('common.dateTo')"
                type="date"
              />
            </v-col>
          </template>
          <template v-else>
            <v-col cols="12" md="3">
              <v-text-field
                v-model="asOfDate"
                :label="$t('accounting.asOfDate')"
                type="date"
              />
            </v-col>
            <template v-if="activeTab === 'trial-balance'">
              <v-col cols="12" md="3">
                <v-select
                  v-model="selectedFiscalYear"
                  :label="$t('accounting.fiscalYear')"
                  :items="store.fiscalYears"
                  item-title="name"
                  item-value="_id"
                  clearable
                />
              </v-col>
              <v-col cols="12" md="3">
                <v-select
                  v-model="selectedFiscalPeriod"
                  :label="$t('accounting.fiscalPeriod')"
                  :items="selectedFiscalYear ? store.fiscalPeriods : []"
                  :disabled="!selectedFiscalYear"
                  item-title="name"
                  item-value="_id"
                  clearable
                />
              </v-col>
            </template>
          </template>
          <v-col cols="12" md="3" class="d-flex align-center">
            <v-btn color="primary" :loading="loading" @click="fetchReport">
              {{ $t('common.generate') }}
            </v-btn>
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <!-- Trial Balance Tab -->
    <v-card v-if="activeTab === 'trial-balance'">
      <v-card-text>
        <v-data-table
          v-if="store.trialBalance.length > 0"
          :headers="trialBalanceHeaders"
          :items="store.trialBalance"
          :items-per-page="-1"
          item-value="accountId"
          hide-default-footer
        >
          <template #item.name="{ item }">
            <entity-link :label="item.name" :to="{ name: 'accounting.accounts' }" />
          </template>
          <template #item.debit="{ item }">
            {{ item.debit ? formatCurrency(item.debit, currency, localeCode) : '' }}
          </template>
          <template #item.credit="{ item }">
            {{ item.credit ? formatCurrency(item.credit, currency, localeCode) : '' }}
          </template>
          <template #item.balance="{ item }">
            {{ formatCurrency(item.debit - item.credit, currency, localeCode) }}
          </template>
          <!-- ⚠ Not #bottom: that slot sits outside the <table>, so its cells stack up at the left under no column. -->
          <template #tfoot>
            <tfoot>
              <tr class="font-weight-bold bg-grey-lighten-4">
                <td colspan="2" class="py-3">{{ $t('common.total') }}</td>
                <td class="text-end py-3">
                  {{ formatCurrency(store.totalDebits, currency, localeCode) }}
                </td>
                <td class="text-end py-3">
                  {{ formatCurrency(store.totalCredits, currency, localeCode) }}
                </td>
                <td class="text-end py-3">
                  {{ formatCurrency(store.totalDebits - store.totalCredits, currency, localeCode) }}
                </td>
              </tr>
            </tfoot>
          </template>
        </v-data-table>
        <div v-else class="text-center text-medium-emphasis pa-8">
          {{ $t('accounting.generateReport') }}
        </div>
      </v-card-text>
    </v-card>

    <!-- Profit & Loss Tab -->
    <v-card v-if="activeTab === 'pnl'">
      <v-card-text>
        <div v-if="pnlData">
          <h3 class="text-h6 mb-2">{{ $t('accounting.revenue') }}</h3>
          <v-table density="compact" class="mb-4">
            <thead>
              <tr>
                <th>{{ $t('accounting.account') }}</th>
                <th class="text-end">{{ $t('accounting.debit') }}</th>
                <th class="text-end">{{ $t('accounting.credit') }}</th>
                <th class="text-end">{{ $t('common.amount') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in pnlData.revenue" :key="row.account">
                <td><entity-link :label="row.account" :to="{ name: 'accounting.accounts' }" /></td>
                <td class="text-end">{{ formatCurrency(row.debit, currency, localeCode) }}</td>
                <td class="text-end">{{ formatCurrency(row.credit, currency, localeCode) }}</td>
                <td class="text-end">{{ formatCurrency(row.amount, currency, localeCode) }}</td>
              </tr>
              <tr class="font-weight-bold">
                <td>{{ $t('accounting.totalRevenue') }}</td>
                <td class="text-end">{{ formatCurrency(sideTotal(pnlData.revenue, 'debit'), currency, localeCode) }}</td>
                <td class="text-end">{{ formatCurrency(sideTotal(pnlData.revenue, 'credit'), currency, localeCode) }}</td>
                <td class="text-end">{{ formatCurrency(pnlData.totalRevenue, currency, localeCode) }}</td>
              </tr>
            </tbody>
          </v-table>

          <h3 class="text-h6 mb-2">{{ $t('accounting.expenses') }}</h3>
          <v-table density="compact" class="mb-4">
            <thead>
              <tr>
                <th>{{ $t('accounting.account') }}</th>
                <th class="text-end">{{ $t('accounting.debit') }}</th>
                <th class="text-end">{{ $t('accounting.credit') }}</th>
                <th class="text-end">{{ $t('common.amount') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in pnlData.expenses" :key="row.account">
                <td><entity-link :label="row.account" :to="{ name: 'accounting.accounts' }" /></td>
                <td class="text-end">{{ formatCurrency(row.debit, currency, localeCode) }}</td>
                <td class="text-end">{{ formatCurrency(row.credit, currency, localeCode) }}</td>
                <td class="text-end">{{ formatCurrency(row.amount, currency, localeCode) }}</td>
              </tr>
              <tr class="font-weight-bold">
                <td>{{ $t('accounting.totalExpenses') }}</td>
                <td class="text-end">{{ formatCurrency(sideTotal(pnlData.expenses, 'debit'), currency, localeCode) }}</td>
                <td class="text-end">{{ formatCurrency(sideTotal(pnlData.expenses, 'credit'), currency, localeCode) }}</td>
                <td class="text-end">{{ formatCurrency(pnlData.totalExpenses, currency, localeCode) }}</td>
              </tr>
            </tbody>
          </v-table>

          <v-divider class="my-4" />
          <div class="d-flex justify-space-between text-h6">
            <span>{{ $t('accounting.netIncome') }}</span>
            <span :class="pnlData.netIncome >= 0 ? 'text-success' : 'text-error'">
              {{ formatCurrency(pnlData.netIncome, currency, localeCode) }}
            </span>
          </div>
        </div>
        <div v-else class="text-center text-medium-emphasis pa-8">
          {{ $t('accounting.selectDateRange') }}
        </div>
      </v-card-text>
    </v-card>

    <!-- Balance Sheet Tab -->
    <v-card v-if="activeTab === 'bs'">
      <v-card-text>
        <div v-if="bsData">
          <h3 class="text-h6 mb-2">{{ $t('accounting.assets') }}</h3>
          <v-table density="compact" class="mb-4">
            <tbody>
              <tr v-for="row in bsData.assets" :key="row.account">
                <td><entity-link :label="row.account" :to="{ name: 'accounting.accounts' }" /></td>
                <td class="text-end">{{ formatCurrency(row.balance, currency, localeCode) }}</td>
              </tr>
              <tr class="font-weight-bold">
                <td>{{ $t('accounting.totalAssets') }}</td>
                <td class="text-end">{{ formatCurrency(bsData.totalAssets, currency, localeCode) }}</td>
              </tr>
            </tbody>
          </v-table>

          <h3 class="text-h6 mb-2">{{ $t('accounting.liabilities') }}</h3>
          <v-table density="compact" class="mb-4">
            <tbody>
              <tr v-for="row in bsData.liabilities" :key="row.account">
                <td><entity-link :label="row.account" :to="{ name: 'accounting.accounts' }" /></td>
                <td class="text-end">{{ formatCurrency(row.balance, currency, localeCode) }}</td>
              </tr>
              <tr class="font-weight-bold">
                <td>{{ $t('accounting.totalLiabilities') }}</td>
                <td class="text-end">{{ formatCurrency(bsData.totalLiabilities, currency, localeCode) }}</td>
              </tr>
            </tbody>
          </v-table>

          <h3 class="text-h6 mb-2">{{ $t('accounting.equity') }}</h3>
          <v-table density="compact" class="mb-4">
            <tbody>
              <tr v-for="row in bsData.equity" :key="row.account">
                <td v-if="row.unclosedResult">{{ $t('accounting.unclosedResult') }}</td>
                <td v-else><entity-link :label="row.account" :to="{ name: 'accounting.accounts' }" /></td>
                <td class="text-end">{{ formatCurrency(row.balance, currency, localeCode) }}</td>
              </tr>
              <tr class="font-weight-bold">
                <td>{{ $t('accounting.totalEquity') }}</td>
                <td class="text-end">{{ formatCurrency(bsData.totalEquity, currency, localeCode) }}</td>
              </tr>
            </tbody>
          </v-table>

          <v-divider class="my-4" />
          <div class="d-flex justify-space-between text-h6">
            <span>{{ $t('accounting.totalLiabilitiesAndEquity') }}</span>
            <span>
              {{ formatCurrency(bsData.totalLiabilitiesAndEquity, currency, localeCode) }}
            </span>
          </div>
        </div>
        <div v-else class="text-center text-medium-emphasis pa-8">
          {{ $t('accounting.selectDate') }}
        </div>
      </v-card-text>
    </v-card>
    <!-- Charts Section -->
    <v-card v-if="pnlData && activeTab === 'pnl'" class="mt-4">
      <v-card-title class="text-subtitle-1">Revenue vs Expenses</v-card-title>
      <v-card-text>
        <ChartView
          type="bar"
          :data="pnlChartData"
          :height="300"
        />
      </v-card-text>
    </v-card>

    <v-card v-if="bsData && activeTab === 'bs'" class="mt-4">
      <v-card-title class="text-subtitle-1">Balance Sheet Composition</v-card-title>
      <v-card-text>
        <ChartView
          type="pie"
          :data="bsChartData"
          :height="300"
        />
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { useAccountingStore } from '../../store/accounting.store'
import { formatCurrency } from 'ui-shared/composables/useCurrency'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import ExportMenu from 'ui-shared/components/ExportMenu'
import EntityLink from 'ui-shared/components/EntityLink'
import ChartView from 'ui-shared/components/ChartView.vue'

interface ProfitLossRow {
  account: string
  amount: number
  debit: number
  credit: number
}

interface BalanceSheetRow {
  account: string
  balance: number
  unclosedResult?: boolean
}

const { t } = useI18n()
const appStore = useAppStore()
const store = useAccountingStore()
const { showError } = useSnackbar()

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => {
  const map: Record<string, string> = { en: 'en-US', mk: 'mk-MK', de: 'de-DE' }
  return map[appStore.locale] || 'en-US'
})

const activeTab = ref('trial-balance')
const dateFrom = ref('')
const dateTo = ref('')
const asOfDate = ref(new Date().toISOString().split('T')[0])
const selectedFiscalYear = ref<string | null>(null)
const selectedFiscalPeriod = ref<string | null>(null)
const loading = ref(false)

const pnlData = ref<{
  revenue: ProfitLossRow[]
  expenses: ProfitLossRow[]
  totalRevenue: number
  totalExpenses: number
  netIncome: number
} | null>(null)

const bsData = ref<{
  assets: BalanceSheetRow[]
  liabilities: BalanceSheetRow[]
  equity: BalanceSheetRow[]
  totalAssets: number
  totalLiabilities: number
  totalEquity: number
  totalLiabilitiesAndEquity: number
} | null>(null)

const trialBalanceHeaders = computed(() => [
  { title: t('accounting.accountCode'), key: 'code' },
  { title: t('accounting.account'), key: 'name' },
  { title: t('accounting.debit'), key: 'debit', align: 'end' as const },
  { title: t('accounting.credit'), key: 'credit', align: 'end' as const },
  { title: t('common.balance'), key: 'balance', align: 'end' as const },
])

/** A side's turnover: the rows carry it, and the totals the API sends are of the net. */
function sideTotal(rows: ProfitLossRow[], side: 'debit' | 'credit') {
  return rows.reduce((sum, row) => sum + row[side], 0)
}

// A period belongs to its year: choosing another year drops the period and loads that year's.
watch(selectedFiscalYear, (year) => {
  selectedFiscalPeriod.value = null
  if (year) store.fetchFiscalPeriods(year)
})

async function fetchReport() {
  loading.value = true
  try {
    if (activeTab.value === 'trial-balance') {
      await store.getTrialBalance({
        asOf: asOfDate.value || undefined,
        fiscalYearId: selectedFiscalYear.value || undefined,
        fiscalPeriodId: selectedFiscalPeriod.value || undefined,
      })
    } else if (activeTab.value === 'pnl') {
      pnlData.value = await store.getProfitLoss({
        startDate: dateFrom.value || undefined,
        endDate: dateTo.value || undefined,
      })
    } else {
      bsData.value = await store.getBalanceSheet({
        asOf: asOfDate.value || undefined,
      })
    }
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  store.fetchFiscalYears()
})

// Chart data computeds
const pnlChartData = computed(() => {
  if (!pnlData.value) return { labels: [], datasets: [] }
  return {
    labels: ['Revenue', 'Expenses', 'Net Income'],
    datasets: [{
      label: 'Amount',
      data: [pnlData.value.totalRevenue, pnlData.value.totalExpenses, pnlData.value.netIncome],
      backgroundColor: ['rgba(76,175,80,0.6)', 'rgba(244,67,54,0.6)', pnlData.value.netIncome >= 0 ? 'rgba(33,150,243,0.6)' : 'rgba(255,152,0,0.6)'],
    }],
  }
})

const bsChartData = computed(() => {
  if (!bsData.value) return { labels: [], datasets: [] }
  return {
    labels: ['Assets', 'Liabilities', 'Equity'],
    datasets: [{
      label: 'Amount',
      data: [bsData.value.totalAssets, bsData.value.totalLiabilities, bsData.value.totalEquity],
      backgroundColor: ['rgba(33,150,243,0.7)', 'rgba(244,67,54,0.7)', 'rgba(76,175,80,0.7)'],
    }],
  }
})
</script>
