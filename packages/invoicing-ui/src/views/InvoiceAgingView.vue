<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.agingReport') }}</h1>
    </div>

    <v-row class="mb-4">
      <v-col cols="12" md="3">
        <v-text-field v-model="asOfDate" label="As of Date" type="date" density="compact" hide-details />
      </v-col>
      <v-col cols="12" md="3">
        <v-select v-model="direction" :items="[{title:'Receivable',value:'outgoing'},{title:'Payable',value:'incoming'}]" label="Direction" density="compact" hide-details />
      </v-col>
      <v-col cols="12" md="2">
        <v-btn color="primary" @click="fetchData" :loading="loading">Apply</v-btn>
      </v-col>
    </v-row>

    <PivotTable :data="data" :rows="['contactName']" :measures="measures" />
  </v-container>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import PivotTable from 'ui-shared/components/PivotTable'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useAppStore } from '../store/app.store'

const appStore = useAppStore()

const asOfDate = ref('')
const direction = ref('outgoing')
const loading = ref(false)
const data = ref<any[]>([])

const measures = [
  { field: 'current', aggregate: 'sum', label: 'Current' },
  { field: 'days1to30', aggregate: 'sum', label: '1-30' },
  { field: 'days31to60', aggregate: 'sum', label: '31-60' },
  { field: 'days61to90', aggregate: 'sum', label: '61-90' },
  { field: 'days90plus', aggregate: 'sum', label: '90+' },
  { field: 'totalOutstanding', aggregate: 'sum', label: 'Total Outstanding' },
]

async function fetchData() {
  if (!appStore.currentOrg?.id) return
  loading.value = true
  try {
    const params = new URLSearchParams()
    if (asOfDate.value) params.set('asOfDate', asOfDate.value)
    if (direction.value) params.set('direction', direction.value)
    const { data: res } = await httpClient.get(`/org/${appStore.currentOrg.id}/invoicing/reports/aging?${params}`)
    data.value = res.data || res
  } catch (e) {
    console.error('Failed to fetch aging report', e)
    data.value = []
  } finally {
    loading.value = false
  }
}
</script>
