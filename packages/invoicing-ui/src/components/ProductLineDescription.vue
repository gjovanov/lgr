<template>
  <div class="product-line-description">
    <!-- v-combobox in search-box mode: model-value stays null, `v-model:search` owns the
         visible text. Binding model-value to the description string (previous impl) made
         Vuetify reset its internal search from the prop on every keystroke, so typing never
         advanced and no request fired. `v-model:search` is the proven mechanism (ProductSearch).
         The combobox still sets aria-expanded, so useGridNavigation defers while the menu is
         open and ↑/↓/Enter/Esc work natively. Free text is preserved (combobox, not autocomplete). -->
    <v-combobox
      ref="comboRef"
      :model-value="null"
      v-model:search="searchText"
      :items="products"
      item-title="name"
      return-object
      no-filter
      density="compact"
      hide-details
      variant="underlined"
      menu-icon=""
      :placeholder="$t('invoicing.searchProduct')"
      :loading="loading"
      :menu-props="{ maxHeight: 320 }"
      @update:model-value="onPick"
    >
      <template #item="{ item, props: ip }">
        <v-list-item v-bind="ip" :title="item.raw.name" :subtitle="`${item.raw.sku} — ${fmtPrice(item.raw)}`" />
      </template>
      <template #no-data>
        <v-list-item disabled>
          <v-list-item-title class="text-grey">{{ $t(searchText && searchText.length >= 2 ? 'invoicing.noProductsFound' : 'invoicing.searchProduct') }}</v-list-item-title>
        </v-list-item>
      </template>
    </v-combobox>
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
import { ref, computed, onBeforeUnmount, watch } from 'vue'
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
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

const comboRef = ref()
const products = ref<Product[]>([])
const loading = ref(false)
const linkedProductName = ref('')
const searchText = ref(props.description || '')
// Set true while WE programmatically change searchText (selection / external prop sync) so the
// watcher doesn't treat it as a user query and fire a redundant fetch.
let suppressFetch = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null

function fmtPrice(p: Product) {
  return formatCurrency(p[props.priceField], p.currency || baseCurrency.value, localeCode.value)
}

// Typing: the visible text is the free-text description; ≥2 chars triggers the server search.
watch(searchText, (val) => {
  const text = val ?? ''
  emit('update:description', text)
  if (suppressFetch) { suppressFetch = false; return }
  if (debounceTimer) clearTimeout(debounceTimer)
  if (text.length < 2) { products.value = []; return }
  debounceTimer = setTimeout(() => fetchProducts(text), 300)
})

// Keep the box in sync if the parent changes the description externally (ledger add, restore).
watch(() => props.description, (d) => {
  if ((d ?? '') !== (searchText.value ?? '')) { suppressFetch = true; searchText.value = d ?? '' }
})

// Menu selection commits the product object; typing free text + Enter commits a string.
function onPick(val: Product | string | null) {
  if (val && typeof val === 'object') {
    linkedProductName.value = val.name
    suppressFetch = true
    searchText.value = val.name
    emit('update:description', val.name)
    emit('update:productId', val._id)
    emit('product-selected', val)
  } else if (typeof val === 'string') {
    emit('update:description', val)
  }
}

async function fetchProducts(query: string) {
  loading.value = true
  try {
    const orgId = appStore.currentOrg?.id
    if (!orgId) return
    const { data } = await httpClient.get(`/org/${orgId}/warehouse/product`, { params: { search: query, size: 10 } })
    products.value = data.products || []
  } catch { /* */ } finally {
    loading.value = false
  }
}

function clearProduct() {
  linkedProductName.value = ''
  emit('update:productId', undefined)
  emit('product-cleared')
}

async function resolveProductName(pid: string | undefined) {
  if (!pid) { linkedProductName.value = ''; return }
  const found = products.value.find((p) => p._id === pid)
  if (found) { linkedProductName.value = found.name; return }
  try {
    const orgId = appStore.currentOrg?.id
    if (!orgId) return
    const { data } = await httpClient.get(`/org/${orgId}/warehouse/product/${pid}`)
    const p = data.product || data
    linkedProductName.value = p.name || ''
  } catch { linkedProductName.value = '' }
}

watch(() => props.productId, (pid) => resolveProductName(pid), { immediate: true })

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
})
</script>
