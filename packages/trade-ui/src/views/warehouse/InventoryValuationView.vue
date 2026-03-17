<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('warehouse.inventoryValuation') }}</h1>
      <v-spacer />
      <div class="d-flex ga-2">
        <export-menu @export="onExport" />
      </div>
    </div>

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
            <div class="text-h5 font-weight-bold">{{ items.length }}</div>
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
          :items="items"
          :loading="loading"
          hover
          item-value="productId"
        >
          <template #item.productName="{ item }">
            <entity-link :label="item.name" :to="{ name: 'warehouse.products.edit', params: { id: item.productId } }" />
          </template>
          <template #item.costingMethod="{ item }">
            <v-chip size="small" label>{{ item.costingMethod.toUpperCase() }}</v-chip>
          </template>
          <template #item.avgCost="{ item }">{{ fmtCurrency(item.avgCost) }}</template>
          <template #item.totalValue="{ item }">{{ fmtCurrency(item.totalValue) }}</template>
        </v-data-table>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import ExportMenu from 'ui-shared/components/ExportMenu'
import EntityLink from 'ui-shared/components/EntityLink'

const { t } = useI18n()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

const loading = ref(false)
const items = ref<any[]>([])
const totalValue = ref(0)
const totalQty = computed(() => items.value.reduce((sum, i) => sum + i.totalQty, 0))

function fmtCurrency(val: number) { return formatCurrency(val, baseCurrency.value, localeCode.value) }
function orgUrl() { return `/org/${appStore.currentOrg?.id}` }

const headers = computed(() => [
  { title: t('warehouse.product'), key: 'productName', sortable: true },
  { title: t('warehouse.costingMethod'), key: 'costingMethod' },
  { title: t('warehouse.quantity'), key: 'totalQty', align: 'end' as const },
  { title: t('warehouse.avgCost'), key: 'avgCost', align: 'end' as const },
  { title: t('warehouse.totalValue'), key: 'totalValue', align: 'end' as const },
])

async function fetchValuation() {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${orgUrl()}/warehouse/cost-layer/valuation`)
    items.value = data.items || []
    totalValue.value = data.totalValue || 0
  } catch { /* */ }
  finally { loading.value = false }
}

function onExport(format: string) { console.log('Export valuation as', format) }

onMounted(fetchValuation)
</script>
