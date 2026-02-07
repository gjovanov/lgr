<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.stockLevels') }}</h1>
      <v-spacer />
      <export-menu class="mr-2" @export="onExport" />
    </div>

    <!-- Filters -->
    <v-card class="mb-4">
      <v-card-text class="pb-0">
        <v-row>
          <v-col cols="12" md="3">
            <v-select v-model="warehouseFilter" :label="$t('warehouse.warehouse')" :items="warehouses" item-title="name" item-value="_id" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="categoryFilter" :label="$t('warehouse.category')" :items="categories" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
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
        <v-data-table :headers="headers" :items="filteredItems" :search="search" :loading="loading" :no-data-text="$t('common.noData')" item-value="_id" hover>
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
        </v-data-table>
      </v-card-text>
    </v-card>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from '../../composables/useHttpClient'
import { useCurrency } from '../../composables/useCurrency'
import ExportMenu from '../../components/shared/ExportMenu.vue'

interface StockLevel { _id: string; productSku: string; productName: string; productCategory?: string; warehouseId: string; warehouseName: string; quantity: number; reorderLevel: number; unitCost: number }
interface Warehouse { _id: string; name: string }

const { t } = useI18n()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const search = ref('')
const loading = ref(false)
const items = ref<StockLevel[]>([])
const warehouses = ref<Warehouse[]>([])
const warehouseFilter = ref<string | null>(null)
const categoryFilter = ref<string | null>(null)
const lowStockOnly = ref(false)

const categories = computed(() => [...new Set(items.value.map(i => i.productCategory).filter(Boolean))])

const headers = computed(() => [
  { title: t('warehouse.sku'), key: 'productSku', sortable: true },
  { title: t('warehouse.product'), key: 'productName', sortable: true },
  { title: t('warehouse.warehouse'), key: 'warehouseName', sortable: true },
  { title: t('warehouse.quantity'), key: 'quantity', align: 'end' as const, sortable: true },
  { title: t('warehouse.reorderLevel'), key: 'reorderLevel', align: 'end' as const },
  { title: t('warehouse.value'), key: 'value', align: 'end' as const },
  { title: t('common.status'), key: 'status' },
])

const filteredItems = computed(() => {
  let r = items.value
  if (warehouseFilter.value) r = r.filter(i => i.warehouseId === warehouseFilter.value)
  if (categoryFilter.value) r = r.filter(i => i.productCategory === categoryFilter.value)
  if (lowStockOnly.value) r = r.filter(i => i.quantity <= (i.reorderLevel || 0))
  return r
})

function fmtCurrency(amount: number) { return formatCurrency(amount, baseCurrency.value, localeCode.value) }
function orgUrl() { return `/org/${appStore.currentOrg?.id}` }
function onExport(format: string) { console.log('Export stock levels as', format) }

async function fetchItems() {
  loading.value = true
  try { const { data } = await httpClient.get(`${orgUrl()}/stock-levels`); items.value = data.stockLevels || [] }
  finally { loading.value = false }
}

async function fetchWarehouses() {
  try { const { data } = await httpClient.get(`${orgUrl()}/warehouses`); warehouses.value = data.warehouses || [] } catch { /* */ }
}

onMounted(() => { fetchItems(); fetchWarehouses() })
</script>
