<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.stockLevels') }}</h1>
      <v-spacer />
      <export-menu class="mr-2" @export="onExport" />
    </div>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="3">
            <v-select v-model="warehouseFilter" :label="$t('warehouse.warehouse')" :items="warehouses" item-title="name" item-value="_id" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="categoryFilter" :label="$t('warehouse.category')" :items="categoryOptions" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <v-switch v-model="lowStockOnly" :label="$t('warehouse.lowStockOnly')" color="warning" hide-details density="compact" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

    <!-- Stock Matrix -->
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
          <template #item.quantity="{ item }">
            <span
              :class="{
                'text-error font-weight-bold': item.quantity <= (item.reorderLevel || 0),
                'text-success': item.quantity > (item.reorderLevel || 0),
              }"
            >
              {{ item.quantity }}
            </span>
          </template>
          <template #item.reorderLevel="{ item }">
            <span>{{ item.reorderLevel || '-' }}</span>
          </template>
          <template #item.value="{ item }">
            {{ fmtCurrency(item.quantity * (item.unitCost || 0)) }}
          </template>
          <template #item.status="{ item }">
            <v-chip
              size="small"
              label
              :color="item.quantity <= 0 ? 'error' : item.quantity <= (item.reorderLevel || 0) ? 'warning' : 'success'"
            >
              {{ item.quantity <= 0 ? $t('warehouse.outOfStock') : item.quantity <= (item.reorderLevel || 0) ? $t('warehouse.lowStock') : $t('warehouse.inStock') }}
            </v-chip>
          </template>
        </v-data-table-server>
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
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import ExportMenu from 'ui-shared/components/ExportMenu'

interface Warehouse { _id: string; name: string }

const { t } = useI18n()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const warehouses = ref<Warehouse[]>([])
const warehouseFilter = ref<string | null>(null)
const categoryFilter = ref<string | null>(null)
const categoryOptions = ref<string[]>([])
const lowStockOnly = ref(false)

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (warehouseFilter.value) f.warehouseId = warehouseFilter.value
  if (categoryFilter.value) f.category = categoryFilter.value
  if (lowStockOnly.value) f.lowStockOnly = true
  return f
})

const url = computed(() => `${appStore.orgUrl()}/warehouse/stock-level`)
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'stockLevels',
  filters,
})

const headers = computed(() => [
  { title: t('warehouse.sku'), key: 'productSku', sortable: true },
  { title: t('warehouse.product'), key: 'productName', sortable: true },
  { title: t('warehouse.warehouse'), key: 'warehouseName', sortable: true },
  { title: t('warehouse.quantity'), key: 'quantity', align: 'end' as const, sortable: true },
  { title: t('warehouse.reorderLevel'), key: 'reorderLevel', align: 'end' as const },
  { title: t('warehouse.value'), key: 'value', align: 'end' as const },
  { title: t('common.status'), key: 'status' },
])

function fmtCurrency(amount: number) { return formatCurrency(amount, baseCurrency.value, localeCode.value) }
function onExport(format: string) { console.log('Export stock levels as', format) }

async function fetchWarehouses() {
  try { const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/warehouse`); warehouses.value = data.warehouses || [] } catch { /* */ }
}

onMounted(() => { fetchItems(); fetchWarehouses() })
</script>
