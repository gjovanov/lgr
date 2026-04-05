<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.journalAnalysis') }}</h1>
      <v-spacer />
      <ViewSwitcher v-model="viewMode" :views="['pivot', 'chart']" />
    </div>

    <!-- Date range filter -->
    <v-row class="mb-4">
      <v-col cols="12" md="3">
        <v-text-field v-model="dateFrom" label="From" type="date" density="compact" hide-details />
      </v-col>
      <v-col cols="12" md="3">
        <v-text-field v-model="dateTo" label="To" type="date" density="compact" hide-details />
      </v-col>
      <v-col cols="12" md="2">
        <v-btn color="primary" @click="fetchData" :loading="loading">Apply</v-btn>
      </v-col>
    </v-row>

    <PivotTable v-if="viewMode === 'pivot'" :data="data" :rows="['accountCode', 'accountName']" :columns="['month']" :measures="measures" expandable />

    <ChartView v-else type="bar" :data="chartData" :height="400" />

    <div v-if="!loading && !data.length" class="text-center pa-8 text-medium-emphasis">No data for selected period</div>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed } from 'vue'
import ViewSwitcher from 'ui-shared/components/ViewSwitcher'
import PivotTable from 'ui-shared/components/PivotTable'
import ChartView from 'ui-shared/components/ChartView'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from '../../store/app.store'

const appStore = useAppStore()

const viewMode = ref('pivot')
const dateFrom = ref('')
const dateTo = ref('')
const loading = ref(false)
const data = ref<any[]>([])

const measures = [
  { field: 'totalDebit', aggregate: 'sum', label: 'Debit' },
  { field: 'totalCredit', aggregate: 'sum', label: 'Credit' },
  { field: 'balance', aggregate: 'sum', label: 'Balance' },
]

const chartData = computed(() => {
  const months = [...new Set(data.value.map((d: any) => d.month))].sort()
  const debitByMonth = months.map(m => data.value.filter((d: any) => d.month === m).reduce((sum: number, d: any) => sum + (d.totalDebit || 0), 0))
  const creditByMonth = months.map(m => data.value.filter((d: any) => d.month === m).reduce((sum: number, d: any) => sum + (d.totalCredit || 0), 0))

  return {
    labels: months,
    datasets: [
      { label: 'Debit', data: debitByMonth, backgroundColor: 'rgba(33,150,243,0.6)' },
      { label: 'Credit', data: creditByMonth, backgroundColor: 'rgba(244,67,54,0.6)' },
    ],
  }
})

async function fetchData() {
  if (!appStore.currentOrg?.id) return
  loading.value = true
  try {
    const params = new URLSearchParams()
    if (dateFrom.value) params.set('dateFrom', dateFrom.value)
    if (dateTo.value) params.set('dateTo', dateTo.value)
    const { data: res } = await httpClient.get(`/org/${appStore.currentOrg.id}/accounting/reports/journal-analysis?${params}`)
    data.value = res.data || res
  } catch (e) {
    console.error('Failed to fetch journal analysis', e)
    data.value = []
  } finally {
    loading.value = false
  }
}
</script>
