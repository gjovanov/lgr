<template>
  <v-autocomplete
    v-model="selectedProduct"
    v-model:search="searchQuery"
    v-model:menu="menuOpen"
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
    :menu-props="{ closeOnContentClick: false, maxHeight: 320 }"
    @update:model-value="onSelect"
  >
    <template #selection="{ item }">
      <v-chip size="small" label closable @click:close="onSelect(null)">{{ item.raw.name || item.raw.displayName }}</v-chip>
    </template>
    <!-- The name above, the SKU and unit below: the SKU once, not again in the title. -->
    <template #item="{ item, props: itemProps }">
      <v-list-item v-bind="itemProps" :title="item.raw.name || item.raw.displayName">
        <template #subtitle>{{ item.raw.sku }} &mdash; {{ item.raw.unit }}</template>
      </v-list-item>
    </template>
    <template #no-data>
      <template v-if="searchQuery && searchQuery.length >= 2">
        <v-list-item>
          <v-list-item-title class="text-grey">{{ $t('invoicing.noProductsFound') }}</v-list-item-title>
        </v-list-item>
        <v-list-item v-if="allowCreate && answered" class="text-primary" data-testid="product-search-create" @click="createProduct">
          <v-list-item-title>{{ $t('warehouse.quickProduct.option', { name: searchQuery.trim() }) }}</v-list-item-title>
        </v-list-item>
      </template>
    </template>
    <!-- FR-22.30: a search that finds articles, but not this one, can still create it. -->
    <template v-if="offerCreateBelowResults" #append-item>
      <v-divider />
      <v-list-item class="text-primary" data-testid="product-search-create" @click="createProduct">
        <v-list-item-title>{{ $t('warehouse.quickProduct.option', { name: searchQuery.trim() }) }}</v-list-item-title>
      </v-list-item>
    </template>
  </v-autocomplete>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
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
  /** Offer „+ Нов продукт „…"" for what was typed (FR-22.30): the parent opens the dialog. */
  allowCreate?: boolean
}>()

const emit = defineEmits<{
  'product-selected': [product: ProductResult]
  'product-cleared': []
  /** The user asked to create the article they typed. */
  'create-product': [name: string]
}>()

const searchQuery = ref('')
const products = ref<ProductResult[]>([])
const loading = ref(false)
const menuOpen = ref(false)
const selectedProduct = ref<ProductResult | null>(null)
let debounceTimer: ReturnType<typeof setTimeout> | null = null

/**
 * The catalog has answered for exactly what is typed now. Until then the list is the previous
 * query's (or empty), and offering to create the article would invite creating one that exists:
 * a quick click on „+ Нов продукт „PRD-0013"" before the search returned PRD-0013 itself.
 */
const answeredFor = ref('')
const answered = computed(() => !loading.value && answeredFor.value === String(searchQuery.value || '').trim())

/** Results came back, but none is called what was typed: the new article is still one click away. */
const offerCreateBelowResults = computed(() => {
  const q = String(searchQuery.value || '').trim().toLocaleLowerCase()
  if (!props.allowCreate || !answered.value || q.length < 2 || !products.value.length) return false
  // A result called — or coded — what was typed is the article; and the box also echoes a picked
  // article's title ("name (SKU)"). Neither is a request for a new one.
  const named = (p: (ProductResult & { barcode?: string }) | null) =>
    [p?.name, p?.displayName, p?.sku, p?.barcode].some(n => String(n || '').trim().toLocaleLowerCase() === q)
  return !named(selectedProduct.value) && !products.value.some(named)
})

function createProduct() {
  const name = String(searchQuery.value || '').trim()
  if (!name) return
  menuOpen.value = false
  emit('create-product', name)
}

// Sync selection from the parent: initial edit value or an external pick (e.g. ProductPickerDialog).
// The picked product must also be present in `products`, otherwise the autocomplete cannot resolve
// the selection and renders no chip.
function syncFromInitial(p: { _id: string; name: string } | null | undefined) {
  if (!p?._id) {
    selectedProduct.value = null
    return
  }
  if (selectedProduct.value?._id === p._id) return
  const init = { sku: '', unit: '', sellingPrice: 0, purchasePrice: 0, taxRate: 0, ...p, displayName: p.name } as ProductResult
  selectedProduct.value = init
  if (!products.value.some(x => x._id === init._id)) products.value = [init, ...products.value]
}
syncFromInitial(props.initialProduct)
watch(() => props.initialProduct, (p) => syncFromInitial(p))

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
    answeredFor.value = query.trim()
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
