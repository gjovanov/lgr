<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('accounting.financialStatements') }}</h1>
      <v-spacer />
      <export-menu module="accounting" class="mr-2" />
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
            <v-col cols="12" md="4">
              <v-text-field
                v-model="asOfDate"
                :label="$t('accounting.asOfDate')"
                type="date"
              />
            </v-col>
            <v-col v-if="activeTab === 'trial-balance'" cols="12" md="4">
              <v-select
                v-model="selectedFiscalYear"
                :label="$t('accounting.fiscalYear')"
                :items="store.fiscalYears"
                item-title="name"
                item-value="_id"
                clearable
              />
            </v-col>
          </template>
          <v-col cols="12" md="4" class="d-flex align-center">
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
          item-value="accountId"
        >
          <template #item.debit="{ item }">
            {{ item.debit ? formatCurrency(item.debit, currency, localeCode) : '' }}
          </template>
          <template #item.credit="{ item }">
            {{ item.credit ? formatCurrency(item.credit, currency, localeCode) : '' }}
          </template>
          <template #item.balance="{ item }">
            {{ formatCurrency(item.balance, currency, localeCode) }}
          </template>
          <template #bottom>
            <tr class="font-weight-bold bg-grey-lighten-4">
              <td colspan="2" class="pa-3">{{ $t('common.total') }}</td>
              <td class="text-end pa-3">
                {{ formatCurrency(store.totalDebits, currency, localeCode) }}
              </td>
              <td class="text-end pa-3">
                {{ formatCurrency(store.totalCredits, currency, localeCode) }}
              </td>
              <td class="text-end pa-3">
                {{ formatCurrency(store.totalDebits - store.totalCredits, currency, localeCode) }}
              </td>
            </tr>
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
            <tbody>
              <tr v-for="row in pnlData.revenue" :key="row.accountId">
                <td>{{ row.accountCode }} - {{ row.accountName }}</td>
                <td class="text-end">{{ formatCurrency(row.amount, currency, localeCode) }}</td>
              </tr>
              <tr class="font-weight-bold">
                <td>{{ $t('accounting.totalRevenue') }}</td>
                <td class="text-end">{{ formatCurrency(pnlData.totalRevenue, currency, localeCode) }}</td>
              </tr>
            </tbody>
          </v-table>

          <h3 class="text-h6 mb-2">{{ $t('accounting.expenses') }}</h3>
          <v-table density="compact" class="mb-4">
            <tbody>
              <tr v-for="row in pnlData.expenses" :key="row.accountId">
                <td>{{ row.accountCode }} - {{ row.accountName }}</td>
                <td class="text-end">{{ formatCurrency(row.amount, currency, localeCode) }}</td>
              </tr>
              <tr class="font-weight-bold">
                <td>{{ $t('accounting.totalExpenses') }}</td>
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
              <tr v-for="row in bsData.assets" :key="row.accountId">
                <td>{{ row.accountCode }} - {{ row.accountName }}</td>
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
              <tr v-for="row in bsData.liabilities" :key="row.accountId">
                <td>{{ row.accountCode }} - {{ row.accountName }}</td>
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
              <tr v-for="row in bsData.equity" :key="row.accountId">
                <td>{{ row.accountCode }} - {{ row.accountName }}</td>
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
              {{ formatCurrency(bsData.totalLiabilities + bsData.totalEquity, currency, localeCode) }}
            </span>
          </div>
        </div>
        <div v-else class="text-center text-medium-emphasis pa-8">
          {{ $t('accounting.selectDate') }}
        </div>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAppStore } from '../../store/app.store'
import { useAccountingStore } from '../../store/accounting.store'
import { formatCurrency } from 'ui-shared/composables/useCurrency'
import ExportMenu from 'ui-shared/components/ExportMenu'

interface StatementRow {
  accountId: string
  accountCode: string
  accountName: string
  amount?: number
  balance?: number
}

const appStore = useAppStore()
const store = useAccountingStore()

const currency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => {
  const map: Record<string, string> = { en: 'en-US', mk: 'mk-MK', de: 'de-DE' }
  return map[appStore.locale] || 'en-US'
})

const activeTab = ref('trial-balance')
const dateFrom = ref('')
const dateTo = ref('')
const asOfDate = ref(new Date().toISOString().split('T')[0])
const selectedFiscalYear = ref('')
const loading = ref(false)

const pnlData = ref<{
  revenue: StatementRow[]
  expenses: StatementRow[]
  totalRevenue: number
  totalExpenses: number
  netIncome: number
} | null>(null)

const bsData = ref<{
  assets: StatementRow[]
  liabilities: StatementRow[]
  equity: StatementRow[]
  totalAssets: number
  totalLiabilities: number
  totalEquity: number
} | null>(null)

const trialBalanceHeaders = [
  { title: 'Code', key: 'accountCode' },
  { title: 'Account', key: 'accountName' },
  { title: 'Debit', key: 'debit', align: 'end' as const },
  { title: 'Credit', key: 'credit', align: 'end' as const },
  { title: 'Balance', key: 'balance', align: 'end' as const },
]

async function fetchReport() {
  loading.value = true
  try {
    if (activeTab.value === 'trial-balance') {
      await store.fetchTrialBalance({
        date: asOfDate.value || undefined,
        fiscalYearId: selectedFiscalYear.value || undefined,
      })
    } else if (activeTab.value === 'pnl') {
      pnlData.value = await store.fetchProfitLoss({
        startDate: dateFrom.value,
        endDate: dateTo.value,
      })
    } else {
      bsData.value = await store.fetchBalanceSheet({
        date: asOfDate.value,
      })
    }
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  store.fetchFiscalYears()
})
</script>
