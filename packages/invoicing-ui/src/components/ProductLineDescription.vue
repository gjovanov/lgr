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
      @keydown="onKeydown"
    />
    <v-menu
      v-model="menuOpen"
      :activator="inputRef?.$el"
      :close-on-content-click="false"
      :close-on-back="true"
      :open-on-focus="false"
      offset-y
      :min-width="menuWidth"
      :width="menuWidth"
      :max-width="menuWidth"
      max-height="320"
    >
      <v-list density="compact" class="product-menu-list">
        <v-list-item
          v-for="(p, i) in filteredProducts"
          :key="p._id"
          :active="i === highlightedIndex"
          @click="selectProduct(p)"
          @mousemove="highlightedIndex = i"
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
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
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
const highlightedIndex = ref(-1)
const products = ref<Product[]>([])
const linkedProductName = ref('')
const searchText = ref('')
const menuWidth = ref(280)
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let resizeObserver: ResizeObserver | null = null

function syncMenuWidth() {
  // Match the dropdown to the input width so multi-line product names don't wrap awkwardly
  // and short forms don't show a 280px-wide popup overflowing the cell.
  const root = inputRef.value?.$el as HTMLElement | undefined
  if (!root) return
  const w = root.offsetWidth
  if (w > 0) menuWidth.value = w
}

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
    highlightedIndex.value = products.value.length > 0 ? 0 : -1
    // Recompute width right before opening so the menu matches the current input rendering
    // (the field could have been resized by parent layout changes since mount).
    syncMenuWidth()
    menuOpen.value = products.value.length > 0
  } catch { /* */ }
}

function scrollHighlightedIntoView() {
  // The menu content is teleported to the overlay container; only one product menu is
  // ever open, so a class-scoped query is unambiguous.
  nextTick(() => {
    document
      .querySelector('.product-menu-list .v-list-item--active')
      ?.scrollIntoView({ block: 'nearest' })
  })
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    // stopPropagation keeps Vuetify's menu-activator keydown from stealing focus
    // into the overlay (which blurs the input and closes the menu).
    e.preventDefault()
    e.stopPropagation()
    if (!menuOpen.value && filteredProducts.value.length > 0) {
      menuOpen.value = true
      return
    }
    if (filteredProducts.value.length === 0) return
    highlightedIndex.value = Math.min(filteredProducts.value.length - 1, highlightedIndex.value + 1)
    scrollHighlightedIntoView()
  } else if (e.key === 'ArrowUp') {
    if (!menuOpen.value) return
    e.preventDefault()
    e.stopPropagation()
    highlightedIndex.value = Math.max(0, highlightedIndex.value - 1)
    scrollHighlightedIntoView()
  } else if (e.key === 'Enter') {
    if (!menuOpen.value) return
    // Select the highlighted product; preventDefault also stops the implicit form submit.
    e.preventDefault()
    const p = filteredProducts.value[highlightedIndex.value]
    if (p) selectProduct(p)
  } else if (e.key === 'Escape') {
    if (!menuOpen.value) return
    e.preventDefault()
    e.stopPropagation()
    menuOpen.value = false
  }
}

function onFocus() {
  syncMenuWidth()
  if (searchText.value.length >= 2 && filteredProducts.value.length > 0) {
    menuOpen.value = true
  }
}

function onBlur() {
  // Close the product dropdown when focus leaves (e.g. Tab to the next cell). Delayed so a
  // menu-item click — which blurs the input first — still registers via selectProduct().
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
  await nextTick()
  syncMenuWidth()
  // Track input resize so the dropdown re-aligns after layout shifts (window resize, sidebar
  // toggle, viewport orientation change).
  if (typeof ResizeObserver !== 'undefined' && inputRef.value?.$el) {
    resizeObserver = new ResizeObserver(syncMenuWidth)
    resizeObserver.observe(inputRef.value.$el)
  }
})

onBeforeUnmount(() => {
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  if (debounceTimer) clearTimeout(debounceTimer)
})
</script>
