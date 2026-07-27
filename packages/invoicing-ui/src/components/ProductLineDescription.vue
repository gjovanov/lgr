<template>
  <div class="product-line-description">
    <!-- Mirrors ui-shared/ProductSearch (proven working on /inventory/movements/new):
         two-way v-model on a COMPONENT-OWNED ref + v-model:search. The prior impls forced
         model-value (":model-value=description" then ":model-value=null"), which made Vuetify
         reset the combobox's internal search every render → typing never advanced, no request
         fired. Combobox (not autocomplete) keeps free-text descriptions; it sets aria-expanded
         so useGridNavigation defers and ↑/↓/Enter/Esc work natively. -->
    <v-combobox
      ref="comboRef"
      v-model="model"
      v-model:search="searchText"
      :items="products"
      item-title="name"
      item-value="_id"
      return-object
      no-filter
      hide-details
      density="compact"
      variant="underlined"
      menu-icon=""
      :placeholder="$t('invoicing.searchProduct')"
      :loading="loading"
      :menu-props="{ closeOnContentClick: false, maxHeight: 320 }"
      @update:model-value="onSelect"
    >
      <template #item="{ item, props: ip }">
        <v-list-item v-bind="ip" :title="item.raw.name" :subtitle="`${item.raw.sku} — ${fmtPrice(item.raw)}`" />
      </template>
      <template #no-data>
        <v-list-item v-if="searchText && searchText.length >= 2" disabled>
          <v-list-item-title class="text-grey">{{ $t('invoicing.noProductsFound') }}</v-list-item-title>
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
// v-model (committed value): a product object when picked, a string for free text, null when empty.
const model = ref<Product | string | null>(props.description || null)
// v-model:search (live input text) — this is what fires the search, exactly like ProductSearch.
const searchText = ref(props.description || '')
// Set while WE change searchText programmatically (selection / prop sync) so the watcher
// doesn't fire a redundant fetch for a value the user didn't type.
let syncing = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null

function fmtPrice(p: Product) {
  return formatCurrency(p[props.priceField], p.currency || baseCurrency.value, localeCode.value)
}

watch(searchText, (val) => {
  const text = val ?? ''
  emit('update:description', text)
  if (syncing) { syncing = false; return }
  if (debounceTimer) clearTimeout(debounceTimer)
  if (text.length < 2) { products.value = []; return }
  debounceTimer = setTimeout(() => fetchProducts(text), 300)
})

// External description changes (ledger add / pending-changes restore) sync the box.
watch(() => props.description, (d) => {
  if ((d ?? '') !== (searchText.value ?? '')) { syncing = true; searchText.value = d ?? '' }
})

// Menu selection → object; free text + Enter/blur → string; clear → null.
function onSelect(val: Product | string | null) {
  if (val && typeof val === 'object') {
    linkedProductName.value = val.name
    syncing = true
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
