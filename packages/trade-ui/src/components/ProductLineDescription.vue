<template>
  <div class="product-line-description" style="position:relative">
    <v-text-field
      ref="inputRef"
      :model-value="description"
      density="compact"
      hide-details
      variant="underlined"
      :placeholder="$t('invoicing.searchProduct')"
      @update:model-value="onInput"
      @focus="onFocus"
      @blur="onBlur"
    />
    <v-menu
      v-model="menuOpen"
      :activator="inputRef?.$el"
      :close-on-content-click="true"
      offset-y
      max-height="250"
      min-width="280"
    >
      <v-list density="compact">
        <v-list-item
          v-for="p in filteredProducts"
          :key="p._id"
          @mousedown.prevent="selectProduct(p)"
        >
          <v-list-item-title>{{ p.name }}</v-list-item-title>
          <v-list-item-subtitle>{{ p.sku }} &mdash; {{ fmtPrice(p) }}</v-list-item-subtitle>
        </v-list-item>
        <v-list-item v-if="filteredProducts.length === 0" disabled>
          <v-list-item-title class="text-grey">{{ $t('invoicing.noProductsFound') }}</v-list-item-title>
        </v-list-item>
      </v-list>
    </v-menu>
    <v-chip
      v-if="linkedProductName"
      size="x-small"
      closable
      color="primary"
      class="mt-1"
      @click:close="clearProduct"
    >
      {{ linkedProductName }}
    </v-chip>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'

interface Product {
  _id: string
  name: string
  sku: string
  unit: string
  sellingPrice: number
  purchasePrice: number
  taxRate: number
  currency: string
}

const props = defineProps<{
  description: string
  productId?: string
  priceField: 'sellingPrice' | 'purchasePrice'
}>()

const emit = defineEmits<{
  'update:description': [value: string]
  'update:productId': [value: string | undefined]
  'product-selected': [product: Product]
  'product-cleared': []
}>()

const appStore = useAppStore()
const { formatCurrency } = useCurrency()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE' }[appStore.locale] || 'en-US'))

const inputRef = ref()
const menuOpen = ref(false)
const products = ref<Product[]>([])
const linkedProductName = ref('')
const searchText = ref('')
let debounceTimer: ReturnType<typeof setTimeout> | null = null

const filteredProducts = computed(() => products.value)

function fmtPrice(p: Product) {
  return formatCurrency(p[props.priceField], p.currency || baseCurrency.value, localeCode.value)
}

function onInput(val: string) {
  searchText.value = val
  emit('update:description', val)
  if (debounceTimer) clearTimeout(debounceTimer)
  if (val.length < 2) {
    products.value = []
    menuOpen.value = false
    return
  }
  debounceTimer = setTimeout(() => fetchProducts(val), 300)
}

async function fetchProducts(query: string) {
  try {
    const orgId = appStore.currentOrg?.id
    if (!orgId) return
    const { data } = await httpClient.get(`/org/${orgId}/warehouse/product`, { params: { search: query, size: 10 } })
    products.value = data.products || []
    menuOpen.value = products.value.length > 0
  } catch { /* */ }
}

function onFocus() {
  if (searchText.value.length >= 2 && filteredProducts.value.length > 0) {
    menuOpen.value = true
  }
}

function onBlur() {
  setTimeout(() => { menuOpen.value = false }, 150)
}

function selectProduct(p: Product) {
  linkedProductName.value = p.name
  emit('update:description', p.name)
  emit('update:productId', p._id)
  emit('product-selected', p)
  menuOpen.value = false
  searchText.value = p.name
}

function clearProduct() {
  linkedProductName.value = ''
  emit('update:productId', undefined)
  emit('product-cleared')
}

async function resolveProductName(pid: string | undefined) {
  if (!pid) { linkedProductName.value = ''; return }
  // Check in already loaded products first
  const found = products.value.find((p) => p._id === pid)
  if (found) { linkedProductName.value = found.name; return }
  // Fetch the single product to resolve its name
  try {
    const orgId = appStore.currentOrg?.id
    if (!orgId) return
    const { data } = await httpClient.get(`/org/${orgId}/warehouse/product/${pid}`)
    const p = data.product || data
    linkedProductName.value = p.name || ''
  } catch { linkedProductName.value = '' }
}

watch(() => props.productId, (pid) => resolveProductName(pid))

onMounted(async () => {
  searchText.value = props.description
  await resolveProductName(props.productId)
})
</script>
