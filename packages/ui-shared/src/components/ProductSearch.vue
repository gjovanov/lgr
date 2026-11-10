<template>
  <v-autocomplete
    ref="autocomplete"
    data-testid="product-field"
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
    <!-- FR-28.24: the name above; below it SKU · unit · stock · price, the same row as every other product search. -->
    <template #item="{ item, props: itemProps }">
      <v-list-item v-bind="itemProps" :title="item.raw.name || item.raw.displayName">
        <template #subtitle>{{ hitLine(item.raw) }}</template>
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
    <!-- FR-28.25: more articles match than the ten shown — the dialog has them all, with the typed text.
         FR-22.30: a search that finds articles, but not this one, can still create it. -->
    <template v-if="showAll || offerCreateBelowResults" #append-item>
      <v-divider />
      <v-list-item v-if="showAll" class="text-primary" data-testid="product-show-all" @click="showAllResults">
        <v-list-item-title>{{ $t('invoicing.productHit.showAll', { n: total }) }}</v-list-item-title>
      </v-list-item>
      <v-list-item v-if="offerCreateBelowResults" class="text-primary" data-testid="product-search-create" @click="createProduct">
        <v-list-item-title>{{ $t('warehouse.quickProduct.option', { name: searchQuery.trim() }) }}</v-list-item-title>
      </v-list-item>
    </template>
  </v-autocomplete>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAccess } from '../access/useAccess'
import { useI18n } from 'vue-i18n'
import {
  SEARCH_DEBOUNCE_MS, SEARCH_MIN_CHARS, hitPriceText, hitStockText, hitSubtitle, loadHitStock, searchProductHits, type HitStock,
} from '../composables/product-hit'

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
  /** The price a line starts from, shown in each hit: a movement starts from the cost. None: no price. */
  priceField?: 'sellingPrice' | 'purchasePrice' | null
  /** The warehouse whose stock the hits show; none: the sum over the warehouses. */
  stockWarehouseId?: string | null
  baseCurrency?: string
  /** A BCP 47 tag (`en-US`). */
  locale?: string
}>()

const emit = defineEmits<{
  'product-selected': [product: ProductResult]
  'product-cleared': []
  /** The user asked to create the article they typed. */
  'create-product': [name: string]
  /** FR-28.25: F4, or "Show all N results": the parent opens the product dialog, searching for what was typed. */
  'details': [text: string]
}>()

const { t } = useI18n()

const searchQuery = ref('')
const products = ref<ProductResult[]>([])
/** How many articles match in all: more than the hits shown means "Show all N results". */
const total = ref(0)
const hitStock = ref<Record<string, HitStock>>({})
const stockLoading = ref(false)
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

/** More articles match than the ten shown: the last hit opens the dialog with all of them (FR-28.25). */
const showAll = computed(() => answered.value && products.value.length > 0 && total.value > products.value.length)

function showAllResults() {
  menuOpen.value = false
  emit('details', String(searchQuery.value || ''))
}

// ── FR-28.24: the hit's second line — SKU · unit · stock · price ──
const resolvedLocale = computed(() => props.locale || 'en-US')
const fmtQty = (n: number) => new Intl.NumberFormat(resolvedLocale.value, { maximumFractionDigits: 3 }).format(n || 0)
// FR-27.11.D: a price the role does not see is no price to show: the purchase price needs the cost figures, the selling
// price its level.
const access = useAccess()
const priceField = computed(() => {
  const wanted = props.priceField === undefined ? 'purchasePrice' : props.priceField
  if (wanted === 'purchasePrice' && !access.can('products.costs')) return null
  if (wanted === 'sellingPrice' && !access.can('products.price:selling')) return null
  return wanted
})

function hitLine(p: ProductResult): string {
  const known = hitStock.value[p._id]
  const stock = !known && stockLoading.value
    ? '…'
    : hitStockText(known, { fmtQty, reservedLabel: (n) => t('invoicing.productHit.reserved', { n }), named: !!props.stockWarehouseId })
  return hitSubtitle({ sku: p.sku, unit: p.unit, stock, price: hitPriceText(p as any, priceField.value, props.baseCurrency || 'EUR', resolvedLocale.value) })
}

/** The stock of the hits just shown: a second, small call. A newer search leaves an older answer unused. */
let stockSeq = 0
async function loadStockOfHits(forQuery: string) {
  const mine = ++stockSeq
  stockLoading.value = true
  const stock = await loadHitStock(props.orgUrl, products.value.map((p) => p._id), props.stockWarehouseId)
  if (mine !== stockSeq || answeredFor.value !== forQuery) return
  hitStock.value = { ...hitStock.value, ...stock }
  stockLoading.value = false
}

// FR-28.25: F4 is "Details" on every product field. A capture listener on the field's own root sees the key before
// the autocomplete does, and leaves the autocomplete's own markup and key handling alone.
const autocomplete = ref<{ $el?: HTMLElement } | null>(null)
function onFieldKeydown(e: KeyboardEvent) {
  if (e.key !== 'F4') return
  e.preventDefault()
  e.stopPropagation()
  menuOpen.value = false
  emit('details', String(searchQuery.value || ''))
}
onMounted(() => autocomplete.value?.$el?.addEventListener('keydown', onFieldKeydown, true))
onBeforeUnmount(() => autocomplete.value?.$el?.removeEventListener('keydown', onFieldKeydown, true))

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
  if (!q || q.length < SEARCH_MIN_CHARS) {
    products.value = selectedProduct.value ? [selectedProduct.value] : []
    total.value = 0
    return
  }
  debounceTimer = setTimeout(() => fetchProducts(q), SEARCH_DEBOUNCE_MS)
})

async function fetchProducts(query: string) {
  loading.value = true
  try {
    const found = await searchProductHits(props.orgUrl, query)
    products.value = found.products.map((p: any) => ({
      ...p,
      displayName: `${p.name} (${p.sku})`,
    }))
    total.value = found.total
    answeredFor.value = query.trim()
    void loadStockOfHits(query.trim())
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
