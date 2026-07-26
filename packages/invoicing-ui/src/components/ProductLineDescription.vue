<template>
  <div class="product-line-description">
    <!-- v-combobox: free-text description + server-searched product menu with NATIVE
         keyboard handling (↑/↓/Enter/Esc). Its input carries aria-expanded, which is
         the contract useGridNavigation's capture handler defers to while the menu is
         open — a hand-rolled v-menu breaks that and the grid steals the arrow keys. -->
    <v-combobox
      ref="comboRef"
      :model-value="description"
      :items="products"
      item-title="name"
      item-value="_id"
      no-filter
      auto-select-first
      density="compact"
      hide-details
      variant="underlined"
      menu-icon=""
      :placeholder="$t('invoicing.searchProduct')"
      :loading="loading"
      @update:model-value="onModelChange"
      @update:search="onSearch"
    >
      <template #item="{ item, props: ip }">
        <v-list-item v-bind="ip" :title="item.raw.name" :subtitle="`${item.raw.sku} — ${fmtPrice(item.raw)}`" />
      </template>
      <template #no-data>
        <v-list-item disabled>
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
let debounceTimer: ReturnType<typeof setTimeout> | null = null

function fmtPrice(p: Product) {
  return formatCurrency(p[props.priceField], p.currency || baseCurrency.value, localeCode.value)
}

/** Typing in the field: free text flows to the parent; ≥2 chars triggers the server search. */
function onSearch(val: string | null) {
  const text = val ?? ''
  if (text === props.description) return // selection echo / prop sync — not a user query
  emit('update:description', text)
  if (debounceTimer) clearTimeout(debounceTimer)
  if (text.length < 2) {
    products.value = []
    return
  }
  debounceTimer = setTimeout(() => fetchProducts(text), 300)
}

/** Menu selection commits an object; Enter/blur on free text commits a string. */
function onModelChange(val: Product | string | null) {
  if (val && typeof val === 'object') {
    linkedProductName.value = val.name
    emit('update:description', val.name)
    emit('update:productId', val._id)
    emit('product-selected', val)
  } else if (typeof val === 'string') {
    if (val !== props.description) emit('update:description', val)
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
