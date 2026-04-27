<template>
  <v-dialog
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
    max-width="1400"
    scrollable
  >
    <v-card>
      <v-toolbar color="surface" flat density="compact">
        <v-toolbar-title class="text-body-1 font-weight-bold">
          {{ $t('invoicing.searchProduct') }}
        </v-toolbar-title>
        <v-spacer />
        <v-btn icon="mdi-close" variant="text" size="small" @click="emit('update:modelValue', false)" />
      </v-toolbar>

      <v-card-text class="pa-3">
        <v-row dense class="mb-2">
          <v-col cols="12" md="6">
            <v-text-field
              v-model="search"
              prepend-inner-icon="mdi-magnify"
              :placeholder="$t('common.search')"
              clearable
              hide-details
              density="compact"
              variant="outlined"
              autofocus
            />
          </v-col>
          <v-col cols="12" md="3">
            <v-select
              v-model="categoryFilter"
              :label="$t('warehouse.category')"
              :items="categoryOptions"
              clearable
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
          <v-col cols="12" md="3">
            <v-select
              v-model="typeFilter"
              :label="$t('common.type')"
              :items="['goods', 'service']"
              clearable
              hide-details
              density="compact"
              variant="outlined"
            />
          </v-col>
        </v-row>

        <v-data-table-server
          :headers="headers"
          :items="items"
          :items-length="pagination.total"
          :loading="loading"
          :page="pagination.page + 1"
          :items-per-page="pagination.size"
          :items-per-page-options="[10, 25, 50, 100]"
          @update:options="onUpdateOptions"
          item-value="_id"
          density="compact"
          hover
          @click:row="onRowClick"
          class="picker-table"
        >
          <template #item.purchasePrice="{ item }">{{ fmtCurrency(item.purchasePrice) }}</template>
          <template #item.sellingPrice="{ item }">{{ fmtCurrency(item.sellingPrice) }}</template>
        </v-data-table-server>
      </v-card-text>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from '../composables/useHttpClient'
import { useCurrency } from '../composables/useCurrency'
import { usePaginatedTable } from '../composables/usePaginatedTable'
import { useSearchDebounce } from '../composables/useSearchDebounce'

export interface PickerProduct {
  _id: string
  sku: string
  name: string
  category: string
  type: string
  unit: string
  purchasePrice: number
  sellingPrice: number
  taxRate: number
}

const props = defineProps<{
  modelValue: boolean
  orgUrl: string
  baseCurrency?: string
  locale?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  'select': [product: PickerProduct]
}>()

const { t } = useI18n()
const { formatCurrency } = useCurrency()

const { search, debouncedSearch } = useSearchDebounce()
const categoryFilter = ref<string | null>(null)
const typeFilter = ref<string | null>(null)
const categoryOptions = ref<string[]>([])

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (categoryFilter.value) f.category = categoryFilter.value
  if (typeFilter.value) f.type = typeFilter.value
  return f
})

const url = computed(() => `${props.orgUrl}/warehouse/product`)
const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'products',
  filters,
  defaultSize: 25,
})

const headers = computed(() => [
  { title: t('warehouse.sku'), key: 'sku', sortable: true },
  { title: t('common.name'), key: 'name', sortable: true },
  { title: t('warehouse.category'), key: 'category', sortable: true },
  { title: t('common.type'), key: 'type' },
  { title: t('warehouse.unit'), key: 'unit' },
  { title: t('warehouse.purchasePrice'), key: 'purchasePrice', align: 'end' as const },
  { title: t('warehouse.sellingPrice'), key: 'sellingPrice', align: 'end' as const },
])

function fmtCurrency(amount: number) {
  return formatCurrency(amount, props.baseCurrency || 'EUR', props.locale || 'en-US')
}

function onRowClick(_e: Event, row: { item: PickerProduct }) {
  emit('select', row.item)
  emit('update:modelValue', false)
}

async function fetchCategories() {
  try {
    const { data } = await httpClient.get(`${props.orgUrl}/warehouse/product`, { params: { size: 0 } })
    categoryOptions.value = [...new Set((data.products || []).map((p: PickerProduct) => p.category).filter(Boolean))] as string[]
  } catch { /* */ }
}

// Lazy-fetch on first open
watch(() => props.modelValue, open => {
  if (open) {
    fetchItems()
    if (categoryOptions.value.length === 0) fetchCategories()
  }
})
</script>

<style scoped>
.picker-table :deep(tbody tr) {
  cursor: pointer;
}
</style>
