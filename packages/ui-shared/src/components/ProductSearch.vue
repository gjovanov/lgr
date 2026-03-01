<template>
  <v-autocomplete
    v-model="selectedProduct"
    v-model:search="searchQuery"
    :items="products"
    :loading="loading"
    item-title="displayName"
    item-value="_id"
    return-object
    :placeholder="$t('invoicing.searchProduct')"
    density="compact"
    hide-details
    variant="underlined"
    clearable
    :disabled="disabled"
    no-filter
    @update:model-value="onSelect"
  >
    <template #item="{ item, props: itemProps }">
      <v-list-item v-bind="itemProps">
        <template #subtitle>{{ item.raw.sku }} &mdash; {{ item.raw.unit }}</template>
      </v-list-item>
    </template>
    <template #no-data>
      <v-list-item v-if="searchQuery && searchQuery.length >= 2">
        <v-list-item-title class="text-grey">{{ $t('invoicing.noProductsFound') }}</v-list-item-title>
      </v-list-item>
    </template>
  </v-autocomplete>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { httpClient } from '../composables/useHttpClient'

export interface ProductResult {
  _id: string
  name: string
  sku: string
  unit: string
  sellingPrice: number
  purchasePrice: number
  taxRate: number
  displayName?: string
}

const props = defineProps<{
  orgUrl: string
  disabled?: boolean
  initialProduct?: { _id: string; name: string } | null
}>()

const emit = defineEmits<{
  'product-selected': [product: ProductResult]
  'product-cleared': []
}>()

const searchQuery = ref('')
const products = ref<ProductResult[]>([])
const loading = ref(false)
const selectedProduct = ref<ProductResult | null>(null)
let debounceTimer: ReturnType<typeof setTimeout> | null = null

// Set initial product if editing
if (props.initialProduct) {
  const init = { ...props.initialProduct, sku: '', unit: '', sellingPrice: 0, purchasePrice: 0, taxRate: 0, displayName: props.initialProduct.name } as ProductResult
  selectedProduct.value = init
  products.value = [init]
}

watch(searchQuery, (q) => {
  if (debounceTimer) clearTimeout(debounceTimer)
  if (!q || q.length < 2) {
    products.value = selectedProduct.value ? [selectedProduct.value] : []
    return
  }
  debounceTimer = setTimeout(() => fetchProducts(q), 300)
})

async function fetchProducts(query: string) {
  loading.value = true
  try {
    const { data } = await httpClient.get(`${props.orgUrl}/warehouse/product`, { params: { search: query, size: 10 } })
    products.value = (data.products || []).map((p: any) => ({
      ...p,
      displayName: `${p.name} (${p.sku})`,
    }))
  } catch { /* */ } finally {
    loading.value = false
  }
}

function onSelect(product: ProductResult | null) {
  if (product) {
    emit('product-selected', product)
  } else {
    emit('product-cleared')
  }
}
</script>
