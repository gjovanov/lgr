<template>
  <!-- Results render as a plain teleported overlay (NOT a v-menu): a v-menu binds a keydown
       handler on its activator that, on ArrowDown, moves DOM focus INTO the list — which blurs
       this input and trips the close-on-blur path. Owning the overlay ourselves keeps focus on
       the input, so ↑/↓ only move `highlightedIndex` and the list stays open until click/Enter/Esc.
       While it's open, the shared productSearchMenuOpen flag makes the line-table grid navigation
       yield ↑/↓/Enter/Esc to us (see the menuOpen watcher). -->
  <div ref="rootRef" class="product-line-description" style="position:relative">
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
    <Teleport to="body">
      <div
        v-if="menuOpen && (products.length > 0 || searchText.length >= 2)"
        class="pld-overlay"
        :style="overlayStyle"
        @mousedown.prevent
      >
        <div
          v-for="(p, i) in products"
          :key="p._id"
          class="pld-item"
          :class="{ 'pld-item--active': i === highlightedIndex }"
          @mousemove="highlightedIndex = i"
          @click="selectProduct(p)"
        >
          <div class="pld-item-title">{{ p.name }}</div>
          <div class="pld-item-sub">{{ p.sku }} &mdash; {{ fmtPrice(p) }}</div>
        </div>
        <div v-if="products.length === 0" class="pld-item pld-item--empty">
          {{ $t('invoicing.noProductsFound') }}
        </div>
      </div>
    </Teleport>
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

const rootRef = ref<HTMLElement>()
const inputRef = ref<any>()
const menuOpen = ref(false)
const highlightedIndex = ref(-1)
const products = ref<Product[]>([])
const loading = ref(false)
const linkedProductName = ref('')
const searchText = ref('')
const overlayStyle = ref<Record<string, string>>({})
let debounceTimer: ReturnType<typeof setTimeout> | null = null

// Fixed-position the teleported overlay directly under the input. Uses viewport coords so it
// escapes the table's overflow clipping (the reason we teleport to body). Repositioned on any
// ancestor scroll / window resize while open (capture-phase scroll catches inner table scroll).
function positionOverlay() {
  const el = inputRef.value?.$el as HTMLElement | undefined
  if (!el) return
  const r = el.getBoundingClientRect()
  overlayStyle.value = {
    position: 'fixed',
    top: `${r.bottom + 2}px`,
    left: `${r.left}px`,
    width: `${Math.max(r.width, 260)}px`,
    zIndex: '2500',
  }
}

function fmtPrice(p: Product) {
  return formatCurrency(p[props.priceField], p.currency || baseCurrency.value, localeCode.value)
}

// Plain input event → a request every time. ≥2 chars triggers the debounced server search.
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
    menuOpen.value = products.value.length > 0
    if (menuOpen.value) nextTick(positionOverlay)
  } catch { /* */ } finally {
    loading.value = false
  }
}

function onFocus() {
  if (products.value.length > 0 && searchText.value.length >= 2) {
    menuOpen.value = true
    nextTick(positionOverlay)
  }
}

function onBlur() {
  // Item clicks use @mousedown.prevent (they never blur the input), so a real blur here means
  // focus genuinely left the widget (Tab away / click elsewhere) → safe to close. Small delay
  // to be defensive against transient blur/refocus ordering.
  setTimeout(() => { menuOpen.value = false }, 150)
}

function scrollHighlightedIntoView() {
  nextTick(() => {
    document.querySelector('.pld-overlay .pld-item--active')?.scrollIntoView({ block: 'nearest' })
  })
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    e.stopPropagation()
    if (!menuOpen.value && products.value.length) { menuOpen.value = true; nextTick(positionOverlay); return }
    if (!products.value.length) return
    highlightedIndex.value = Math.min(products.value.length - 1, highlightedIndex.value + 1)
    scrollHighlightedIntoView()
  } else if (e.key === 'ArrowUp') {
    if (!menuOpen.value) return
    e.preventDefault()
    e.stopPropagation()
    highlightedIndex.value = Math.max(0, highlightedIndex.value - 1)
    scrollHighlightedIntoView()
  } else if (e.key === 'Enter') {
    if (!menuOpen.value || !products.value.length) return
    e.preventDefault()
    e.stopPropagation()
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
// menu is visibly open but the flag hasn't been set yet. Also (un)wire reposition listeners.
watch(menuOpen, (open, was) => {
  if (open === was) return
  setProductSearchMenuOpen(open)
  if (open) {
    window.addEventListener('scroll', positionOverlay, true)
    window.addEventListener('resize', positionOverlay)
  } else {
    window.removeEventListener('scroll', positionOverlay, true)
    window.removeEventListener('resize', positionOverlay)
  }
}, { flush: 'sync' })

onMounted(() => {
  searchText.value = props.description || ''
})

onBeforeUnmount(() => {
  if (debounceTimer) clearTimeout(debounceTimer)
  window.removeEventListener('scroll', positionOverlay, true)
  window.removeEventListener('resize', positionOverlay)
  if (menuOpen.value) setProductSearchMenuOpen(false) // don't leak the count on unmount
})
</script>

<style scoped>
.pld-overlay {
  background: rgb(var(--v-theme-surface));
  border: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
  border-radius: 4px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.28);
  max-height: 320px;
  overflow-y: auto;
  padding: 4px 0;
}
.pld-item {
  padding: 4px 12px;
  cursor: pointer;
  line-height: 1.25;
}
.pld-item--active,
.pld-item:hover {
  background: rgba(var(--v-theme-primary), 0.12);
}
.pld-item--empty {
  cursor: default;
  color: rgba(var(--v-theme-on-surface), 0.5);
}
.pld-item--empty:hover {
  background: transparent;
}
.pld-item-title {
  font-size: 0.875rem;
}
.pld-item-sub {
  font-size: 0.75rem;
  color: rgba(var(--v-theme-on-surface), 0.6);
}
</style>
