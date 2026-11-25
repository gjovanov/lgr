<template>
  <!-- Results render as a plain teleported overlay (NOT a v-menu): a v-menu binds a keydown
       handler on its activator that, on ArrowDown, moves DOM focus INTO the list — which blurs
       this input and trips the close-on-blur path. Owning the overlay ourselves keeps focus on
       the input, so ↑/↓ only move `highlightedIndex` and the list stays open until click/Enter/Esc.
       While it's open, the shared productSearchMenuOpen flag makes the line-table grid navigation
       yield ↑/↓/Enter/Esc to us (see the menuOpen watcher). -->
  <div ref="rootRef" class="product-line-description" data-testid="product-field" style="position:relative">
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
          <!-- FR-28.24: SKU · unit · stock · price, the same row as every other product search. -->
          <div class="pld-item-sub">{{ hitLine(p) }}</div>
        </div>
        <div v-if="products.length === 0" class="pld-item pld-item--empty">
          {{ $t('invoicing.noProductsFound') }}
        </div>
        <!-- FR-28.25: more articles match than the ten shown — the dialog has them all, with the typed text. -->
        <div
          v-if="showAll"
          class="pld-item pld-item--all"
          :class="{ 'pld-item--active': highlightedIndex === products.length }"
          data-testid="product-show-all"
          @mousemove="highlightedIndex = products.length"
          @click="showAllResults"
        >
          {{ $t('invoicing.productHit.showAll', { n: total }) }}
        </div>
        <!-- FR-22.30: what was typed is not in the catalog — create it from the line. -->
        <div
          v-if="offerCreate"
          class="pld-item pld-item--create"
          :class="{ 'pld-item--active': highlightedIndex === createIndex }"
          data-testid="product-line-create"
          @mousemove="highlightedIndex = createIndex"
          @click="createProduct"
        >
          {{ $t('warehouse.quickProduct.option', { name: searchText.trim() }) }}
        </div>
      </div>
    </Teleport>
    <!-- The linked article hangs UNDER the field. The row's other fields do not move for it: a line grid's cells
         start at the top with the control line (ui-shared/styles/line-grid.css), so this only makes the row taller. -->
    <div v-if="linkedProductName" class="pld-linked">
      <v-chip
        size="x-small"
        closable
        color="primary"
        :title="linkedProductName"
        @click:close="clearProduct"
      >
        {{ linkedProductName }}
      </v-chip>
    </div>
  </div>
</template>

<script setup lang="ts">
import { formatNumber, intlLocale } from 'ui-shared/format'
import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAppStore } from '../store/app.store'
import { getProduct } from '../api/products'
import { setProductSearchMenuOpen } from 'ui-shared/composables/useProductSearchMenu'
import { useFieldSearch } from 'ui-shared/composables/field-search'
import {
  SEARCH_DEBOUNCE_MS, SEARCH_MIN_CHARS, hitPriceText, hitStockText, hitSubtitle, loadHitStock, searchProductHits, type HitStock,
} from 'ui-shared/composables/product-hit'

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
  /** Offer „+ Нов продукт „…"" for what was typed (FR-22.30): the parent opens the dialog. */
  allowCreate?: boolean
  /** The warehouse whose stock the hits show (the document's); none: the sum over the warehouses. */
  stockWarehouseId?: string | null
  /**
   * FR-30.10: the article as the document's read named it (`GET /invoices/:id` gives each line its article's name). Used
   * while the line holds that article, so a saved document reads no article per line; another article is read.
   */
  known?: { id: string; name: string } | null
}>()

const emit = defineEmits<{
  'update:description': [value: string]
  'update:productId': [value: string | undefined]
  'product-selected': [product: Product]
  'product-cleared': []
  /** The user asked to create the article they typed. */
  'create-product': [name: string]
  /** FR-28.25: F4, or "Show all N results": the parent opens the product dialog, searching for what was typed. */
  'details': [text: string]
}>()

const appStore = useAppStore()
const { t } = useI18n()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => intlLocale(appStore.locale))

const rootRef = ref<HTMLElement>()
const inputRef = ref<any>()
const menuOpen = ref(false)
const highlightedIndex = ref(-1)
const products = ref<Product[]>([])
/** How many articles match in all: more than the hits shown means "Show all N results". */
const total = ref(0)
const hitStock = ref<Record<string, HitStock>>({})
const stockLoading = ref(false)
const linkedProductName = ref('')
const searchText = ref('')
const overlayStyle = ref<Record<string, string>>({})

/**
 * FR-31.4: only the answer to the latest search reaches the list. A slow answer to an earlier word used to replace
 * the matches of what the field holds, with its first row highlighted: Enter then put that article on the line.
 * An answer to a text the field no longer holds is dropped too, and Enter takes only an answer to what the field
 * holds (FR-33.12, `onKeydown`).
 */
const orgUrl = () => `/org/${appStore.currentOrg?.id}`
const field = useFieldSearch({
  search: async (signal, query: string) => {
    if (!appStore.currentOrg?.id) throw new Error('No organization to search in')
    return searchProductHits(orgUrl(), query, signal)
  },
  onAnswer: (found, query) => {
    products.value = found.products
    total.value = found.total
    void loadStockOfHits(orgUrl(), query)
    highlightedIndex.value = products.value.length || props.allowCreate ? 0 : -1
    menuOpen.value = products.value.length > 0 || (!!props.allowCreate && query.length >= 2)
    if (menuOpen.value) nextTick(positionOverlay)
  },
  minChars: SEARCH_MIN_CHARS,
  debounceMs: SEARCH_DEBOUNCE_MS,
})
const loading = field.loading

/**
 * The catalog has answered for exactly what is typed now. Until then the rows are the previous
 * query's, and offering to create the article would invite creating one that exists.
 */
const answeredFor = field.answeredFor

/** The typed text names no article the search found: offer to create it, as the last row. */
const offerCreate = computed(() => {
  const q = searchText.value.trim().toLocaleLowerCase()
  if (!props.allowCreate || q.length < 2 || loading.value || answeredFor.value !== searchText.value.trim()) return false
  // A result called — or coded — what was typed is the article, not a new one.
  return !products.value.some((p: any) => [p.name, p.sku, p.barcode].some((n) => String(n || '').trim().toLocaleLowerCase() === q))
})
/** More articles match than the ten shown: the last hit opens the dialog with all of them (FR-28.25). */
const showAll = computed(() => products.value.length > 0 && total.value > products.value.length)
/** Where the create row sits among the rows the keyboard walks: the results, then "show all", then create. */
const createIndex = computed(() => products.value.length + (showAll.value ? 1 : 0))
/** Rows the keyboard walks: the results, "show all", then the create row. */
const rowCount = computed(() => products.value.length + (showAll.value ? 1 : 0) + (offerCreate.value ? 1 : 0))

function showAllResults() {
  menuOpen.value = false
  emit('details', searchText.value)
}

function createProduct() {
  const name = searchText.value.trim()
  if (!name) return
  menuOpen.value = false
  emit('create-product', name)
}

// Fixed-position the teleported overlay directly under the input. Uses viewport coords so it
// escapes the table's overflow clipping (the reason we teleport to body). Repositioned on any
// ancestor scroll / window resize while open (capture-phase scroll catches inner table scroll).
function positionOverlay() {
  const el = inputRef.value?.$el as HTMLElement | undefined
  if (!el) return
  const r = el.getBoundingClientRect()
  // The list lives in the room it has: under the field when there is room for a useful list, above it when a
  // document's lines have run to the bottom of the screen (there is more room there). Either way it is never
  // taller than that room, so its own scroll reaches the last row — "Show all N results" is the last row, and a
  // list that ran past the bottom of the window hid it (FR-28.25).
  const margin = 8
  const below = window.innerHeight - r.bottom - 2 - margin
  const above = r.top - 2 - margin
  const placeAbove = below < 160 && above > below
  const room = Math.max(96, Math.min(320, placeAbove ? above : below))
  overlayStyle.value = {
    position: 'fixed',
    ...(placeAbove ? { bottom: `${window.innerHeight - r.top + 2}px` } : { top: `${r.bottom + 2}px` }),
    left: `${r.left}px`,
    width: `${Math.max(r.width, 260)}px`,
    maxHeight: `${room}px`,
    zIndex: '2500',
  }
}

const fmtQty = (n: number) => formatNumber(n || 0, { lang: localeCode.value, maxDecimals: 3 })

/** FR-28.24: the hit's second line — SKU · unit · stock · price. The stock fills in when its call has answered. */
function hitLine(p: Product): string {
  const known = hitStock.value[p._id]
  const stock = !known && stockLoading.value
    ? '…'
    : hitStockText(known, { fmtQty, reservedLabel: (n) => t('invoicing.productHit.reserved', { n }), named: !!props.stockWarehouseId })
  return hitSubtitle({ sku: p.sku, unit: p.unit, stock, price: hitPriceText(p, props.priceField, baseCurrency.value, localeCode.value) })
}

// Plain input event → a request every time. ≥2 chars triggers the debounced server search.
function onInput(val: string) {
  searchText.value = val ?? ''
  emit('update:description', searchText.value)
  if (field.input(searchText.value)) return
  // A search still on its way answers a question nobody asks any more: it must not reopen the list.
  products.value = []
  total.value = 0
  menuOpen.value = false
}

/** The stock of the hits just shown: a second, small call. A newer search leaves an older answer unused. */
let stockSeq = 0
async function loadStockOfHits(orgUrl: string, forQuery: string) {
  const mine = ++stockSeq
  stockLoading.value = true
  const stock = await loadHitStock(orgUrl, products.value.map((p) => p._id), props.stockWarehouseId)
  if (mine !== stockSeq || answeredFor.value !== forQuery) return
  hitStock.value = { ...hitStock.value, ...stock }
  stockLoading.value = false
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
  // FR-28.25: F4 is "Details" on every product field.
  if (e.key === 'F4') {
    e.preventDefault()
    e.stopPropagation()
    menuOpen.value = false
    emit('details', searchText.value)
    return
  }
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    e.stopPropagation()
    if (!menuOpen.value && rowCount.value) { menuOpen.value = true; nextTick(positionOverlay); return }
    if (!rowCount.value) return
    highlightedIndex.value = Math.min(rowCount.value - 1, highlightedIndex.value + 1)
    scrollHighlightedIntoView()
  } else if (e.key === 'ArrowUp') {
    if (!menuOpen.value) return
    e.preventDefault()
    e.stopPropagation()
    highlightedIndex.value = Math.max(0, highlightedIndex.value - 1)
    scrollHighlightedIntoView()
  } else if (e.key === 'Enter') {
    // FR-33.12: the rows on screen answer an earlier text while the answer to what was typed is on its way. Enter
    // waits for that answer and takes its first row; it never takes a row of the earlier text's list. A search that
    // failed leaves nothing on its way, and Enter then takes nothing.
    const text = searchText.value
    if (field.unanswered(text)) {
      if (!field.waiting.value) return
      e.preventDefault()
      e.stopPropagation()
      void field.enter(text).then((took) => {
        if (took && searchText.value === text) takeHighlighted()
      })
      return
    }
    if (!menuOpen.value || !rowCount.value) return
    e.preventDefault()
    e.stopPropagation()
    takeHighlighted()
  } else if (e.key === 'Escape') {
    if (!menuOpen.value) return
    e.preventDefault()
    e.stopPropagation()
    menuOpen.value = false
  }
}

/** Enter on the open list: the highlighted row (a fresh answer highlights its first). */
function takeHighlighted() {
  if (!menuOpen.value || !rowCount.value) return
  if (showAll.value && highlightedIndex.value === products.value.length) { showAllResults(); return }
  if (offerCreate.value && highlightedIndex.value === createIndex.value) { createProduct(); return }
  const p = products.value[highlightedIndex.value]
  if (p) selectProduct(p)
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
  if (props.known && props.known.id === String(pid)) { linkedProductName.value = props.known.name; return }
  try {
    if (!appStore.currentOrg?.id) return
    const { product } = await getProduct(pid)
    linkedProductName.value = product.name || ''
  } catch { linkedProductName.value = '' }
}

watch(() => props.productId, (pid) => resolveProductName(pid), { immediate: true })
watch(() => props.description, (d) => { searchText.value = d ?? '' })

// Tell the line-table grid navigation to stop stealing ↑/↓/Enter while our menu is open.
// flush:'sync' so the flag flips in the same tick menuOpen does — no window where the
// menu is visibly open but the flag hasn't been set yet. Also (un)wire reposition listeners.
// FR-33.12: also while an answer to what was typed is on its way, so that Enter in that pause is the field's (it waits
// for the answer) and not the grid's, which would move to the next row before the list is even open.
const holdsKeys = computed(() => menuOpen.value || field.waiting.value)
watch(holdsKeys, (held, was) => {
  if (held !== was) setProductSearchMenuOpen(held)
}, { flush: 'sync' })
watch(menuOpen, (open, was) => {
  if (open === was) return
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
  field.cancel()
  window.removeEventListener('scroll', positionOverlay, true)
  window.removeEventListener('resize', positionOverlay)
  // Don't leak the count on unmount. `cancel()` lowers `waiting`, and the sync watcher has given that share back
  // already: give back only what is still held (an open list).
  if (holdsKeys.value) setProductSearchMenuOpen(false)
})
</script>

<style scoped>
/* A flex row, so the chip is a box of its own height (20 px) and not a line of the cell's text: a line grid's cells
   carry the control line's height as their line height. The chip ends where the row ends, as it did before the
   fields lined up: a row with a chip is no taller than it was. */
.pld-linked {
  display: flex;
  min-width: 0;
  margin-top: 2px;
  line-height: 1.5;
}
/* A name longer than its place (an order's tree, a phone) is cut with an ellipsis INSIDE the chip. Cut by the chip's
   own `overflow: hidden`, it lost its close button together with the end of the name. */
.pld-linked :deep(.v-chip__content) {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
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
.pld-item--all {
  color: rgb(var(--v-theme-primary));
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.pld-item--create {
  color: rgb(var(--v-theme-primary));
  border-top: 1px solid rgba(var(--v-border-color), var(--v-border-opacity));
}
.pld-item-title {
  font-size: 0.875rem;
}
.pld-item-sub {
  font-size: 0.75rem;
  color: rgba(var(--v-theme-on-surface), 0.6);
}
</style>
