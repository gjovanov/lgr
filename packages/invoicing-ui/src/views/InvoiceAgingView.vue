<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('invoicing.aging.title') }}</h1>
    </div>

    <!-- Filters -->
    <FilterBar :searchable="false">
      <v-col cols="12" sm="6" md="3">
        <v-text-field v-model="asOfDate" :label="$t('invoicing.aging.asOfDate')" type="date" clearable />
      </v-col>
      <v-col cols="12" sm="6" md="3">
        <v-select v-model="direction" :items="directionOptions" :label="$t('invoicing.aging.direction')" />
      </v-col>
      <v-col cols="12" sm="auto" class="d-flex align-center">
        <v-btn color="primary" prepend-icon="mdi-refresh" :loading="loading" @click="fetchData">
          {{ $t('invoicing.aging.apply') }}
        </v-btn>
      </v-col>
    </FilterBar>

    <!-- Aging table -->
    <v-card>
      <v-card-text>
        <v-data-table
          :headers="headers"
          :items="rows"
          :loading="loading"
          density="compact"
          items-per-page="-1"
          hide-default-footer
        >
          <template #item.contactName="{ item }">
            <entity-link
              v-if="item.contactId && item.contactId !== 'unknown'"
              :label="item.contactName"
              :to="{ name: 'invoicing.contacts.edit', params: { id: item.contactId } }"
            />
            <span v-else>{{ item.contactName }}</span>
          </template>
          <template #item.current="{ item }">{{ fmt(item.current) }}</template>
          <template #item.d1_30="{ item }">{{ fmt(item.d1_30) }}</template>
          <template #item.d31_60="{ item }">{{ fmt(item.d31_60) }}</template>
          <template #item.d61_90="{ item }">{{ fmt(item.d61_90) }}</template>
          <template #item.d90plus="{ item }">{{ fmt(item.d90plus) }}</template>
          <template #item.totalOutstanding="{ item }">
            <span class="font-weight-bold">{{ fmt(item.totalOutstanding) }}</span>
          </template>

          <template #body.append>
            <tr v-if="rows.length" class="font-weight-bold totals-row">
              <td>{{ $t('common.total') }}</td>
              <td class="text-end">{{ fmt(totals.current) }}</td>
              <td class="text-end">{{ fmt(totals.d1_30) }}</td>
              <td class="text-end">{{ fmt(totals.d31_60) }}</td>
              <td class="text-end">{{ fmt(totals.d61_90) }}</td>
              <td class="text-end">{{ fmt(totals.d90plus) }}</td>
              <td class="text-end">{{ fmt(totals.totalOutstanding) }}</td>
            </tr>
          </template>

          <template #no-data>
            <EmptyState
              icon="mdi-cash-clock"
              :title="$t('invoicing.aging.empty')"
              :description="$t('invoicing.aging.emptyHint')"
            />
          </template>
        </v-data-table>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import EntityLink from 'ui-shared/components/EntityLink'
import EmptyState from 'ui-shared/components/EmptyState.vue'
import FilterBar from 'ui-shared/components/FilterBar.vue'
import { useAppStore } from '../store/app.store'

interface AgingRow {
  contactId: string
  contactName: string
  current: number
  d1_30: number
  d31_60: number
  d61_90: number
  d90plus: number
  totalOutstanding: number
}

const { t } = useI18n()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()

const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))
function fmt(val: number | undefined) { return formatCurrency(val || 0, baseCurrency.value, localeCode.value) }

const asOfDate = ref('')
const direction = ref('outgoing')
const loading = ref(false)
const rows = ref<AgingRow[]>([])

const directionOptions = computed(() => [
  { title: t('invoicing.aging.receivable'), value: 'outgoing' },
  { title: t('invoicing.aging.payable'), value: 'incoming' },
])

const headers = computed(() => [
  { title: t('invoicing.aging.contact'), key: 'contactName', sortable: true },
  { title: t('invoicing.aging.current'), key: 'current', align: 'end' as const },
  { title: t('invoicing.aging.days1to30'), key: 'd1_30', align: 'end' as const },
  { title: t('invoicing.aging.days31to60'), key: 'd31_60', align: 'end' as const },
  { title: t('invoicing.aging.days61to90'), key: 'd61_90', align: 'end' as const },
  { title: t('invoicing.aging.days90plus'), key: 'd90plus', align: 'end' as const },
  { title: t('invoicing.aging.totalOutstanding'), key: 'totalOutstanding', align: 'end' as const },
])

const totals = computed(() => {
  const acc = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90plus: 0, totalOutstanding: 0 }
  for (const r of rows.value) {
    acc.current += r.current
    acc.d1_30 += r.d1_30
    acc.d31_60 += r.d31_60
    acc.d61_90 += r.d61_90
    acc.d90plus += r.d90plus
    acc.totalOutstanding += r.totalOutstanding
  }
  return acc
})

async function fetchData() {
  if (!appStore.currentOrg?.id) return
  loading.value = true
  try {
    const params = new URLSearchParams()
    if (asOfDate.value) params.set('asOfDate', asOfDate.value)
    if (direction.value) params.set('direction', direction.value)
    const { data: res } = await httpClient.get(`${appStore.orgUrl()}/invoicing/reports/aging?${params}`)
    const list = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : [])
    rows.value = list.map((r: any) => ({
      contactId: r.contactId || 'unknown',
      contactName: r.contactName || t('invoicing.aging.unknownContact'),
      current: r.current || 0,
      d1_30: r['1-30'] || 0,
      d31_60: r['31-60'] || 0,
      d61_90: r['61-90'] || 0,
      d90plus: r['90+'] || 0,
      totalOutstanding: r.totalOutstanding || 0,
    }))
  } catch (e) {
    console.error('Failed to fetch aging report', e)
    rows.value = []
  } finally {
    loading.value = false
  }
}

onMounted(fetchData)
</script>

<style scoped>
.totals-row {
  border-top: 2px solid rgba(var(--v-border-color), var(--v-border-opacity));
  background: rgba(var(--v-theme-surface-variant), 0.06);
}
</style>
