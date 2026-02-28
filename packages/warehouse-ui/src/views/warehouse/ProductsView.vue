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
            <v-btn icon="mdi-pencil" size="small" variant="text" :to="{ name: 'warehouse.products.edit', params: { id: item._id } }" />
            <v-btn icon="mdi-delete" size="small" variant="text" color="error" @click="confirmDelete(item)" />
          </template>
        </v-data-table-server>
      </v-card-text>
    </v-card>

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
import ExportMenu from 'ui-shared/components/ExportMenu'

interface Product { _id: string; sku: string; name: string; category: string; type: string; unit: string; purchasePrice: number; sellingPrice: number; isActive: boolean }

const { t } = useI18n()
const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

const search = ref('')
const deleteDialog = ref(false)
const selectedId = ref('')
const categoryFilter = ref<string | null>(null)
const typeFilter = ref<string | null>(null)
const categoryOptions = ref<string[]>([])

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (search.value) f.search = search.value
  if (categoryFilter.value) f.category = categoryFilter.value
  if (typeFilter.value) f.type = typeFilter.value
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
async function doDelete() { await httpClient.delete(`${appStore.orgUrl()}/warehouse/product/${selectedId.value}`); await fetchItems(); deleteDialog.value = false }
function onExport(format: string) { console.log('Export products as', format) }

async function fetchCategories() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product`, { params: { pageSize: 0 } })
    categoryOptions.value = [...new Set((data.products || []).map((i: Product) => i.category).filter(Boolean))] as string[]
  } catch { /* */ }
}

onMounted(() => { fetchItems(); fetchCategories() })
</script>
