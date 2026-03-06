<template>
  <v-container fluid>
    <div class="d-flex align-center mb-4">
      <h1 class="text-h5">{{ $t('nav.products') }}</h1>
      <v-spacer />
      <export-menu class="mr-2" @export="onExport" />
      <v-btn color="primary" prepend-icon="mdi-plus" :to="{ name: 'warehouse.products.new' }">{{ $t('common.create') }}</v-btn>
    </div>

    <v-card class="mb-4">
      <v-card-text class="pb-4">
        <v-row>
          <v-col cols="12" md="4">
            <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <v-select v-model="categoryFilter" :label="$t('warehouse.category')" :items="categoryOptions" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="2">
            <v-select v-model="typeFilter" :label="$t('common.type')" :items="['goods', 'service']" clearable hide-details density="compact" />
          </v-col>
          <v-col cols="12" md="3">
            <TagInput v-model="tagFilter" type="product" :org-url="appStore.orgUrl()" :label="$t('common.filterByTags')" />
          </v-col>
        </v-row>
      </v-card-text>
    </v-card>

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
          <template #item.purchasePrice="{ item }">{{ fmtCurrency(item.purchasePrice) }}</template>
          <template #item.sellingPrice="{ item }">{{ fmtCurrency(item.sellingPrice) }}</template>
          <template #item.isActive="{ item }">
            <v-icon :color="item.isActive !== false ? 'success' : 'grey'">
              {{ item.isActive !== false ? 'mdi-check-circle' : 'mdi-close-circle' }}
            </v-icon>
          </template>
          <template #item.actions="{ item }">
            <v-btn icon="mdi-chart-box" size="small" variant="text" color="info" :title="$t('warehouse.productStock')" @click="openProductStock(item)" />
            <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'warehouse.products.edit', params: { id: item._id } }" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

    <!-- Product Stock Dialog -->
    <v-dialog v-model="stockDialog" max-width="1200">
      <v-card>
        <v-card-title>{{ $t('warehouse.productStock') }}: {{ stockProduct?.name }}</v-card-title>
        <v-card-text>
          <v-tabs v-model="stockTab">
            <v-tab value="levels">{{ $t('warehouse.stockLevels') }}</v-tab>
            <v-tab value="ledger">{{ $t('warehouse.productLedger') }}</v-tab>
            <v-tab value="movements">{{ $t('nav.stockMovements') }}</v-tab>
            <v-tab value="counts">{{ $t('nav.inventoryCount') }}</v-tab>
          </v-tabs>
          <v-tabs-window v-model="stockTab">
            <v-tabs-window-item value="levels">
              <v-data-table :headers="stockLevelHeaders" :items="stockLevels" :loading="stockLoading" density="compact" class="mt-2">
                <template #item.quantity="{ item }">{{ item.quantity }}</template>
                <template #item.avgCost="{ item }">{{ fmtCurrency(item.avgCost || 0) }}</template>
              </v-data-table>
            </v-tabs-window-item>
            <v-tabs-window-item value="ledger">
              <ProductLedgerTable
                v-if="stockProduct"
                :product-id="stockProduct._id"
                :org-url="appStore.orgUrl()"
                :base-currency="baseCurrency"
                :locale-code="localeCode"
                :warehouses="ledgerWarehouses"
                class="mt-2"
              />
            </v-tabs-window-item>
            <v-tabs-window-item value="movements">
              <v-data-table :headers="stockMovementHeaders" :items="stockMovements" :loading="stockLoading" density="compact" class="mt-2">
                <template #item.date="{ item }">{{ item.date?.split('T')[0] }}</template>
              </v-data-table>
            </v-tabs-window-item>
            <v-tabs-window-item value="counts">
              <v-data-table :headers="stockCountHeaders" :items="stockCounts" :loading="stockLoading" density="compact" class="mt-2" />
            </v-tabs-window-item>
          </v-tabs-window>
        </v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="stockDialog = false">{{ $t('common.close') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>

    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('warehouse.deleteProductConfirm') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" @click="doDelete">{{ $t('common.delete') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </v-container>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import ExportMenu from 'ui-shared/components/ExportMenu'
import TagInput from 'ui-shared/components/TagInput.vue'
import ProductLedgerTable from 'ui-shared/components/ProductLedgerTable.vue'

interface Product { _id: string; sku: string; name: string; category: string; type: string; unit: string; purchasePrice: number; sellingPrice: number; isActive: boolean }

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

const search = ref('')
const deleteDialog = ref(false)
const selectedId = ref('')
const stockDialog = ref(false)
const stockTab = ref('levels')
const stockProduct = ref<Product | null>(null)
const stockLoading = ref(false)
const stockLevels = ref<any[]>([])
const stockMovements = ref<any[]>([])
const stockCounts = ref<any[]>([])

const ledgerWarehouses = computed(() =>
  stockLevels.value.map((sl: any) => ({ _id: sl.warehouseId, name: sl.warehouseName })).filter((w: any) => w._id && w.name),
)

const stockLevelHeaders = computed(() => [
  { title: t('warehouse.warehouse'), key: 'warehouseName' },
  { title: t('warehouse.quantity'), key: 'quantity', align: 'end' as const },
  { title: t('warehouse.unitCost'), key: 'avgCost', align: 'end' as const },
])
const stockMovementHeaders = computed(() => [
  { title: '#', key: 'movementNumber' },
  { title: t('common.type'), key: 'type' },
  { title: t('common.date'), key: 'date' },
  { title: t('common.status'), key: 'status' },
])
const stockCountHeaders = computed(() => [
  { title: '#', key: 'countNumber' },
  { title: t('warehouse.warehouse'), key: 'warehouseName' },
  { title: t('common.status'), key: 'status' },
])

async function openProductStock(product: Product) {
  stockProduct.value = product
  stockDialog.value = true
  stockTab.value = 'levels'
  stockLoading.value = true
  try {
    const [levelsRes, movementsRes, countsRes] = await Promise.all([
      httpClient.get(`${appStore.orgUrl()}/warehouse/stock-level`, { params: { productId: product._id, size: 0 } }),
      httpClient.get(`${appStore.orgUrl()}/warehouse/movement`, { params: { productId: product._id, size: 0 } }),
      httpClient.get(`${appStore.orgUrl()}/warehouse/inventory-count`, { params: { productId: product._id, size: 0 } }),
    ])
    stockLevels.value = levelsRes.data.stockLevels || []
    stockMovements.value = movementsRes.data.stockMovements || []
    stockCounts.value = countsRes.data.inventoryCounts || []
  } catch { /* */ }
  stockLoading.value = false
}
const categoryFilter = ref<string | null>(null)
const typeFilter = ref<string | null>(null)
const tagFilter = ref<string[]>([])
const categoryOptions = ref<string[]>([])

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (search.value) f.search = search.value
  if (categoryFilter.value) f.category = categoryFilter.value
  if (typeFilter.value) f.type = typeFilter.value
  if (tagFilter.value.length) f.tags = tagFilter.value.join(',')
  return f
})

const url = computed(() => `${appStore.orgUrl()}/warehouse/product`)
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'products',
  filters,
})

const headers = computed(() => [
  { title: t('warehouse.sku'), key: 'sku', sortable: true },
  { title: t('common.name'), key: 'name', sortable: true },
  { title: t('warehouse.category'), key: 'category', sortable: true },
  { title: t('common.type'), key: 'type' },
  { title: t('warehouse.unit'), key: 'unit' },
  { title: t('warehouse.purchasePrice'), key: 'purchasePrice', align: 'end' as const },
  { title: t('warehouse.sellingPrice'), key: 'sellingPrice', align: 'end' as const },
  { title: t('common.active'), key: 'isActive', align: 'center' as const },
  { title: t('common.actions'), key: 'actions', sortable: false },
])

function fmtCurrency(amount: number) { return formatCurrency(amount, baseCurrency.value, localeCode.value) }

function confirmDelete(item: Product) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() {
  try {
    await httpClient.delete(`${appStore.orgUrl()}/warehouse/product/${selectedId.value}`)
    await fetchItems()
    deleteDialog.value = false
    showSuccess(t('common.deletedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}
function onExport(format: string) { console.log('Export products as', format) }

async function fetchCategories() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product`, { params: { pageSize: 0 } })
    categoryOptions.value = [...new Set((data.products || []).map((i: Product) => i.category).filter(Boolean))] as string[]
  } catch { /* */ }
}

onMounted(() => { fetchItems(); fetchCategories() })
</script>
