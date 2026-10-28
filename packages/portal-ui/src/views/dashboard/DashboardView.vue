<template>
  <v-container fluid class="pa-4 pa-md-6">
    <h1 class="text-h4 mb-4">{{ $t('dashboard.title') }}</h1>

    <!-- FR-22.51: the pages pinned with ★, one click away. -->
    <FavoriteTiles class="mb-4" />

    <!-- Headline KPI cards -->
    <v-row dense>
      <v-col cols="12" sm="6" lg="3">
        <StatCard
          :label="$t('dashboard.totalRevenue')"
          :value="money(data?.revenue.totalRevenue)"
          icon="mdi-cash-multiple"
          color="success"
          :loading="loading"
          clickable
          @click="go('/accounting/')"
        />
      </v-col>
      <v-col cols="12" sm="6" lg="3">
        <StatCard
          :label="$t('dashboard.outstandingInvoices')"
          :value="money(data?.invoices.outstanding.amount)"
          icon="mdi-receipt-text"
          color="warning"
          :loading="loading"
          clickable
          @click="go('/invoicing/')"
        />
      </v-col>
      <v-col cols="12" sm="6" lg="3">
        <StatCard
          :label="$t('dashboard.stockValue')"
          :value="money(data?.stock.totalValue)"
          icon="mdi-package-variant"
          color="info"
          :loading="loading"
          clickable
          @click="go('/inventory/')"
        />
      </v-col>
      <v-col cols="12" sm="6" lg="3">
        <StatCard
          :label="$t('dashboard.activeEmployees')"
          :value="data?.employees.active ?? 0"
          icon="mdi-account-group"
          color="secondary"
          :loading="loading"
          clickable
          @click="go('/payroll/')"
        />
      </v-col>
    </v-row>

    <!-- Secondary KPI strip -->
    <v-row dense class="mt-1">
      <v-col cols="12" sm="4">
        <StatCard :label="$t('kpi.overdue')" :value="money(data?.invoices.overdue.amount)" icon="mdi-alert-circle-outline" color="error" :loading="loading" />
      </v-col>
      <v-col cols="12" sm="4">
        <StatCard :label="$t('kpi.drafts')" :value="data?.invoices.drafts.count ?? 0" icon="mdi-file-document-edit-outline" color="grey" :loading="loading" />
      </v-col>
      <v-col cols="12" sm="4">
        <StatCard :label="$t('kpi.paid30d')" :value="money(data?.invoices.paid30d.amount)" icon="mdi-check-circle-outline" color="success" :loading="loading" />
      </v-col>
    </v-row>

    <!-- Recent activity + AR aging chart -->
    <v-row class="mt-1">
      <v-col cols="12" md="7">
        <v-card class="h-100">
          <v-card-title class="text-subtitle-1">{{ $t('dashboard.recentActivity') }}</v-card-title>
          <v-divider />
          <v-skeleton-loader v-if="loading" type="list-item-two-line@4" />
          <EmptyState v-else-if="!recentActivity.length" :title="$t('dashboard.noActivity')" icon="mdi-history" />
          <v-list v-else density="compact" lines="two">
            <v-list-item v-for="a in recentActivity" :key="a._id">
              <template #prepend>
                <v-chip size="x-small" label :color="actionColor(a.action)" variant="tonal" class="me-2">{{ a.action }}</v-chip>
              </template>
              <v-list-item-title class="text-body-2">{{ a.entityName || a.entityType }}</v-list-item-title>
              <v-list-item-subtitle>{{ a.userName }} · {{ fmtTime(a.timestamp) }}</v-list-item-subtitle>
            </v-list-item>
          </v-list>
        </v-card>
      </v-col>
      <v-col cols="12" md="5">
        <v-card class="h-100">
          <v-card-title class="text-subtitle-1">{{ $t('dashboard.arAging') }}</v-card-title>
          <v-divider />
          <v-card-text>
            <v-skeleton-loader v-if="loading" type="image" />
            <EmptyState v-else-if="!hasAging" :title="$t('common.noData')" icon="mdi-chart-bar" />
            <ChartView v-else type="bar" :data="chartData" :height="260" />
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import StatCard from 'ui-shared/components/StatCard.vue'
import ChartView from 'ui-shared/components/ChartView.vue'
import EmptyState from 'ui-shared/components/EmptyState.vue'
import FavoriteTiles from 'ui-shell/components/FavoriteTiles'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { formatCurrency } from 'ui-shared/composables/useCurrency'
import { useAppStore } from '../../store/app.store'

interface ActivityRow {
  _id: string
  userName: string
  action: string
  module: string
  entityType: string
  entityId: string
  entityName: string
  timestamp: string
}
interface DashboardSummary {
  revenue: { totalRevenue: number; totalExpenses: number; netIncome: number; periodStart: string; periodEnd: string }
  invoices: {
    outstanding: { amount: number; count: number }
    overdue: { amount: number; count: number }
    paid30d: { amount: number; count: number }
    drafts: { count: number }
  }
  stock: { totalValue: number; itemCount: number }
  employees: { active: number }
  recentActivity: ActivityRow[]
  aging: { asOfDate: string; buckets: { label: string; amount: number }[] }
}

const { t } = useI18n()
const appStore = useAppStore()

const data = ref<DashboardSummary | null>(null)
const loading = ref(true)

const cur = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const loc = computed(() => appStore.currentOrg?.locale || appStore.locale)
function money(n?: number): string { return formatCurrency(n ?? 0, cur.value, loc.value) }

const recentActivity = computed<ActivityRow[]>(() => data.value?.recentActivity ?? [])
const hasAging = computed(() => (data.value?.aging.buckets ?? []).some(b => b.amount > 0))

const BUCKET_COLORS = ['#26A69A', '#66BB6A', '#FFA726', '#EF5350', '#B71C1C']
const chartData = computed(() => {
  const buckets = data.value?.aging.buckets ?? []
  return {
    labels: buckets.map(b => (b.label === 'current' ? t('dashboard.agingBuckets.current') : b.label)),
    datasets: [{
      label: t('dashboard.arAging'),
      data: buckets.map(b => b.amount),
      backgroundColor: BUCKET_COLORS,
      borderRadius: 4,
    }],
  }
})

function actionColor(action: string): string {
  if (action === 'create') return 'success'
  if (action === 'update') return 'info'
  if (action === 'delete') return 'error'
  return 'grey'
}

function fmtTime(ts?: string): string {
  if (!ts) return ''
  try { return new Date(ts).toLocaleString(loc.value) } catch { return ts }
}

// Domain UIs are separate SPAs served at their own path → hard navigate.
function go(path: string) { window.location.href = path }

async function load() {
  if (!appStore.currentOrg?.id) { loading.value = false; return }
  loading.value = true
  try {
    const { data: res } = await httpClient.get(`${appStore.orgUrl()}/dashboard/summary`)
    data.value = res
  } catch {
    data.value = null
  } finally {
    loading.value = false
  }
}

onMounted(load)
</script>
