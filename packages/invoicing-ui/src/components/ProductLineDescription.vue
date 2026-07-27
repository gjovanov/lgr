<template>
  <!-- While the results menu is open, the shared productSearchMenuOpen flag makes the
       line-table grid navigation yield ↑/↓/Enter/Esc to this component (see the menuOpen watcher). -->
  <div class="product-line-description" style="position:relative">
    <v-text-field
      ref="inputRef"
      :model-value="description"
      density="compact"
      hide-details
      variant="underlined"
      :placeholder="$t('invoicing.searchProduct')"
      :loading="loading"
      autocomplete="off"
      @update:model-value="onInput"
      @focus="onFocus"
      @blur="onBlur"
      @keydown="onKeydown"
    />
    <v-menu
      v-model="menuOpen"
      :activator="inputRef?.$el"
      :close-on-content-click="false"
      :open-on-focus="false"
      :open-on-click="false"
      offset-y
      :min-width="menuWidth"
      :max-width="menuWidth"
      max-height="320"
    >
      <v-list density="compact" class="product-menu-list">
        <v-list-item
          v-for="(p, i) in products"
          :key="p._id"
          :active="i === highlightedIndex"
          @mousemove="highlightedIndex = i"
          @click="selectProduct(p)"
        >
          <v-list-item-title>{{ p.name }}</v-list-item-title>
          <v-list-item-subtitle>{{ p.sku }} &mdash; {{ fmtPrice(p) }}</v-list-item-subtitle>
        </v-list-item>
        <v-list-item v-if="products.length === 0" disabled>
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
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useCurrency } from 'ui-shared/composables/useCurrency'
import { setProductSearchMenuOpen } from '../composables/useProductSearchMenu'

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

const inputRef = ref<any>()
const menuOpen = ref(false)
const highlightedIndex = ref(-1)
const products = ref<Product[]>([])
const loading = ref(false)
const linkedProductName = ref('')
const searchText = ref('')
const menuWidth = ref(320)
let debounceTimer: ReturnType<typeof setTimeout> | null = null

function syncMenuWidth() {
  const root = inputRef.value?.$el as HTMLElement | undefined
  if (root && root.offsetWidth > 0) menuWidth.value = root.offsetWidth
}

function fmtPrice(p: Product) {
  return formatCurrency(p[props.priceField], p.currency || baseCurrency.value, localeCode.value)
}

// Plain input event → a request every time (this is what reliably fired before the combobox
// experiments broke it). ≥2 chars triggers the debounced server search.
function onInput(val: string) {
  searchText.value = val ?? ''
  emit('update:description', searchText.value)
  if (debounceTimer) clearTimeout(debounceTimer)
  if (searchText.value.length < 2) {
    products.value = []
    menuOpen.value = false
    return
  }
  debounceTimer = setTimeout(() => fetchProducts(searchText.value), 300)
}

async function fetchProducts(query: string) {
  loading.value = true
  try {
    const orgId = appStore.currentOrg?.id
    if (!orgId) return
    const { data } = await httpClient.get(`/org/${orgId}/warehouse/product`, { params: { search: query, size: 10 } })
    products.value = data.products || []
    highlightedIndex.value = products.value.length ? 0 : -1
    syncMenuWidth()
    menuOpen.value = products.value.length > 0
  } catch { /* */ } finally {
    loading.value = false
  }
}

function onFocus() {
  syncMenuWidth()
  if (products.value.length > 0 && searchText.value.length >= 2) menuOpen.value = true
}

function onBlur() {
  // Delay so a menu-item click (which blurs the input first) still registers.
  setTimeout(() => { menuOpen.value = false }, 200)
}

function scrollHighlightedIntoView() {
  nextTick(() => {
    document.querySelector('.product-menu-list .v-list-item--active')?.scrollIntoView({ block: 'nearest' })
  })
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (!menuOpen.value && products.value.length) { menuOpen.value = true; return }
    if (!products.value.length) return
    highlightedIndex.value = Math.min(products.value.length - 1, highlightedIndex.value + 1)
    scrollHighlightedIntoView()
  } else if (e.key === 'ArrowUp') {
    if (!menuOpen.value) return
    e.preventDefault()
    highlightedIndex.value = Math.max(0, highlightedIndex.value - 1)
    scrollHighlightedIntoView()
  } else if (e.key === 'Enter') {
    if (!menuOpen.value || !products.value.length) return
    e.preventDefault()
    const p = products.value[highlightedIndex.value]
    if (p) selectProduct(p)
  } else if (e.key === 'Escape') {
    if (!menuOpen.value) return
    e.preventDefault()
    e.stopPropagation()
    menuOpen.value = false
  }
}

function selectProduct(p: Product) {
  linkedProductName.value = p.name
  searchText.value = p.name
  emit('update:description', p.name)
  emit('update:productId', p._id)
  emit('product-selected', p)
  menuOpen.value = false
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
watch(() => props.description, (d) => { searchText.value = d ?? '' })

// Tell the line-table grid navigation to stop stealing ↑/↓/Enter while our menu is open.
// flush:'sync' so the flag flips in the same tick menuOpen does — no window where the
// menu is visibly open but the flag hasn't been set yet.
watch(menuOpen, (open, was) => {
  if (open === was) return
  setProductSearchMenuOpen(open)
}, { flush: 'sync' })

onMounted(() => {
  searchText.value = props.description || ''
  nextTick(syncMenuWidth)
})

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
  if (menuOpen.value) setProductSearchMenuOpen(false) // don't leak the count on unmount
})
</script>
