<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('warehouse.inventoryValuation') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <export-menu @export="onExport" />
      </div>
    </div>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="4">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="warehouseFilter" :label="$t('warehouse.warehouse')" :items="warehouses" item-title="name" item-value="_id" clearable hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <!-- Summary Cards -->
    <v-row class="mb-4">
      <v-col cols="12" sm="4">
        <v-card>
          <v-card-text class="text-center">
            <div class="text-h5 font-weight-bold">{{ fmtCurrency(totalValue) }}</div>
            <div class="text-caption text-medium-emphasis">{{ $t('warehouse.totalValue') }}</div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="12" sm="4">
        <v-card>
          <v-card-text class="text-center">
            <div class="text-h5 font-weight-bold">{{ filteredItems.length }}</div>
            <div class="text-caption text-medium-emphasis">{{ $t('warehouse.totalProducts') }}</div>
          </v-card-text>
        </v-card>
      </v-col>
      <v-col cols="12" sm="4">
        <v-card>
          <v-card-text class="text-center">
            <div class="text-h5 font-weight-bold">{{ totalQty }}</div>
            <div class="text-caption text-medium-emphasis">{{ $t('warehouse.totalUnits') }}</div>
          </v-card-text>
        </v-card>
      </v-col>
    </v-row>

    <!-- Table -->
    <v-card>
      <v-card-text>
        <v-data-table
          :headers="headers"
          :items="filteredItems"
          :loading="loading"
          :search="search"
          hover
          item-value="productId"
        >
          <template #item.productName="{ item }">
            <entity-link :label="item.name" :to="{ name: 'warehouse.products.stock', params: { id: item.productId } }" />
          </template>
          <template #item.costingMethod="{ item }">
            <v-chip size="small" label>{{ costingLabel(item.costingMethod) }}</v-chip>
          </template>
          <template #item.avgCost="{ item }">{{ fmtCurrency(item.avgCost) }}</template>
          <template #item.totalValue="{ item }">{{ fmtCurrency(item.totalValue) }}</template>
        </v-data-table>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import ExportMenu from 'ui-shared/components/ExportMenu'
import EntityLink from 'ui-shared/components/EntityLink'

interface Warehouse { _id: string; name: string }

const { t } = useI18n()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

const loading = ref(false)
const items = ref<any[]>([])
const totalValue = ref(0)
const search = ref('')
const warehouseFilter = ref<string | null>(null)
const warehouses = ref<Warehouse[]>([])

const filteredItems = computed(() => items.value)
const totalQty = computed(() => filteredItems.value.reduce((sum, i) => sum + i.totalQty, 0))

function fmtCurrency(val: number) { return formatCurrency(val, baseCurrency.value, localeCode.value) }

function costingLabel(method: string) {
  const labels: Record<string, string> = {
    wac: t('warehouse.costingWAC'),
    fifo: 'FIFO',
    lifo: 'LIFO',
    fefo: 'FEFO',
    standard: t('warehouse.costingStandard'),
  }
  return labels[method] || method.toUpperCase()
}

const headers = computed(() => [
  { title: t('warehouse.product'), key: 'productName', sortable: true },
  { title: t('warehouse.costingMethod'), key: 'costingMethod' },
  { title: t('warehouse.quantity'), key: 'totalQty', align: 'end' as const, sortable: true },
  { title: t('warehouse.avgCost'), key: 'avgCost', align: 'end' as const, sortable: true },
  { title: t('warehouse.totalValue'), key: 'totalValue', align: 'end' as const, sortable: true },
])

async function fetchValuation() {
  loading.value = true
  try {
    const params: Record<string, string> = {}
    if (warehouseFilter.value) params.warehouseId = warehouseFilter.value
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/cost-layer/valuation`, { params })
    items.value = data.items || []
    totalValue.value = data.totalValue || 0
  } catch { /* */ }
  finally { loading.value = false }
}

async function fetchWarehouses() {
  try { const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/warehouse`); warehouses.value = data.warehouses || [] } catch { /* */ }
}

function onExport(format: string) { console.log('Export valuation as', format) }

watch(warehouseFilter, fetchValuation)
onMounted(() => { fetchValuation(); fetchWarehouses() })
</script>
