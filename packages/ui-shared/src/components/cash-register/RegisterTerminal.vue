<template>
  <!-- FR-21.29: one selling surface for every cash-register document — the till's
       (`/pos/terminal`) and the back office's (`/invoicing/cash-sales/new`). Each app keeps what is
       its own (the till: session, fiscal bridge, last sale, payment; the back office: the document
       header and its save) and hands it in through the slots. -->
  <v-row dense class="register-terminal">
    <!-- ── Left: the catalog ── -->
    <v-col v-if="!readonly" cols="12" md="7">
      <v-card variant="outlined" class="pa-3 register-catalog">
        <div class="d-flex ga-2 mb-3 flex-wrap">
          <v-text-field
            ref="searchField"
            v-model="search"
            :label="searchLabel || $t('pos.searchProducts')"
            prepend-inner-icon="mdi-magnify"
            single-line
            hide-details
            clearable
            autofocus
            style="min-width: 200px; flex: 2 1 220px"
            @update:model-value="onSearchChange"
            @keydown.enter.prevent="onSearchEnter"
          />
          <v-select
            v-model="categoryFilter"
            :items="categoryOptions"
            :label="$t('warehouse.category')"
            clearable
            hide-details
            density="compact"
            style="min-width: 150px; flex: 1 1 150px"
            @update:model-value="fetchCatalog(0)"
          />
          <v-select
            v-if="filters?.type"
            v-model="typeFilter"
            :items="typeOptions"
            :label="$t('common.type')"
            clearable
            hide-details
            density="compact"
            style="min-width: 130px; flex: 1 1 130px"
            @update:model-value="fetchCatalog(0)"
          />
          <TagInput
            v-if="filters?.tags"
            v-model="tagFilter"
            type="product"
            :org-url="orgUrl"
            :label="$t('pos.filterByTags')"
            style="min-width: 200px; flex: 2 1 200px"
            @update:model-value="fetchCatalog(0)"
          />
        </div>

        <div v-if="catalogLoading && !products.length" class="d-flex justify-center py-8">
          <v-progress-circular indeterminate color="primary" />
        </div>
        <v-row v-else dense>
          <v-col v-for="p in products" :key="p.productId" cols="6" sm="4" lg="3">
            <v-card
              class="pa-2 register-card text-center"
              variant="tonal"
              :color="p.stockAvailable !== null && p.stockAvailable <= 0 ? 'error' : undefined"
              data-testid="register-card"
              @click="emit('add', p)"
            >
              <div class="text-body-2 font-weight-medium register-card-name">{{ p.productName }}</div>
              <div v-if="p.sku" class="text-caption text-medium-emphasis text-truncate">{{ p.sku }}</div>
              <div class="text-body-2 font-weight-bold mt-1">{{ fmt(p.unitPrice || 0, 4) }}</div>
              <div v-if="p.stockAvailable !== null" class="text-caption text-medium-emphasis">
                {{ $t('pos.stock') }}: {{ p.stockAvailable }}
              </div>
            </v-card>
          </v-col>
          <v-col v-if="!products.length && !catalogLoading" cols="12" class="text-center text-disabled pa-8">
            {{ $t('common.noData') }}
          </v-col>
        </v-row>
        <div v-if="totalPages > 1" class="d-flex justify-center mt-4">
          <v-pagination v-model="page" :length="totalPages" :total-visible="5" density="compact" @update:model-value="(p: number) => fetchCatalog(p - 1)" />
        </div>
      </v-card>
    </v-col>

    <!-- ── Right: the cart, its totals, and the door's own actions ── -->
    <v-col cols="12" :md="readonly ? 12 : 5">
      <v-card variant="outlined">
        <v-card-title>{{ $t('pos.cart') }} ({{ lines.length }})</v-card-title>
        <v-card-text>
          <slot name="cart-top" />
          <v-list v-if="lines.length" density="compact">
            <v-list-item v-for="(line, idx) in lines" :key="idx" :data-testid="`cart-line-${idx}`">
              <v-list-item-title class="register-line-name">{{ line.name ?? line.description }}</v-list-item-title>
              <v-list-item-subtitle class="d-flex align-center ga-1 flex-wrap">
                <template v-if="!readonly">
                  <slot name="line-price" :line="line" :idx="idx">
                    <span>{{ line.quantity }} x {{ fmt(line.unitPrice, 4) }}</span>
                    <span v-if="line.priceName" class="text-caption">({{ line.priceName }})</span>
                    <PriceSelectButton
                      :product-id="line.productId"
                      :contact-id="contactId"
                      :quantity="line.quantity"
                      :org-url="orgUrl"
                      :currency="currency"
                      @select="emit('price', idx, $event)"
                    />
                  </slot>
                </template>
                <span v-else>{{ line.quantity }} × {{ fmt(line.unitPrice, 4) }}</span>
              </v-list-item-subtitle>
              <template v-if="!readonly" #prepend>
                <div class="d-flex align-center mr-2">
                  <v-btn icon="mdi-minus" size="x-small" variant="text" :aria-label="$t('pos.decreaseQty')" @click="setQuantity(idx, Number(line.quantity || 0) - 1)" />
                  <!-- #145: a large quantity is typed, not clicked. -->
                  <v-text-field
                    :model-value="line.quantity"
                    type="number"
                    inputmode="decimal"
                    min="0"
                    hide-details
                    density="compact"
                    variant="outlined"
                    class="register-qty mx-1"
                    :aria-label="$t('pos.quantity')"
                    data-testid="cart-qty"
                    @change="(e: Event) => setQuantity(idx, (e.target as HTMLInputElement).value)"
                    @focus="($event.target as HTMLInputElement)?.select()"
                  />
                  <v-btn icon="mdi-plus" size="x-small" variant="text" :aria-label="$t('pos.increaseQty')" @click="setQuantity(idx, Number(line.quantity || 0) + 1)" />
                </div>
              </template>
              <template #append>
                <span class="text-body-2 font-weight-bold mr-2">{{ fmt(lineGross(line)) }}</span>
                <v-btn v-if="!readonly" icon="mdi-close" size="x-small" variant="text" color="error" :aria-label="$t('common.delete')" @click="emit('remove', idx)" />
              </template>
            </v-list-item>
          </v-list>
          <div v-else-if="!$slots['cart-top']" class="text-center text-disabled pa-8">{{ $t('pos.emptyCart') }}</div>
        </v-card-text>
        <v-divider />
        <!-- FR-21.30: one totals function for every cash-register document — the till's, the server's
             check and the fiscal device's: gross rounded once per VAT rate. -->
        <v-card-text>
          <div class="d-flex justify-space-between mb-1"><span>{{ $t('pos.subtotal') }}</span><span data-testid="register-subtotal">{{ fmt(totals.subtotal) }}</span></div>
          <div class="d-flex justify-space-between mb-1"><span>{{ $t('pos.tax') }}</span><span data-testid="register-tax">{{ fmt(totals.taxTotal) }}</span></div>
          <v-divider class="my-2" />
          <div class="d-flex justify-space-between text-h6"><span>{{ $t('pos.total') }}</span><span data-testid="register-total">{{ fmt(totals.total) }}</span></div>
        </v-card-text>
        <v-card-text v-if="$slots['cart-actions']">
          <slot name="cart-actions" :totals="totals" />
        </v-card-text>
      </v-card>
    </v-col>
  </v-row>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { httpClient } from '../../composables/useHttpClient'
import TagInput from '../TagInput.vue'
import PriceSelectButton from '../PriceSelectButton.vue'

/** A cart line as either door holds it: the till's cart item, or a document line. */
export interface RegisterLine {
  productId: string
  name?: string
  description?: string
  quantity: number
  unitPrice: number
  taxRate?: number
  discount?: number
  priceName?: string
}

/** An article as `/trade/pos/catalog` answers it. */
export interface RegisterCatalogProduct {
  productId: string
  productName: string
  sku?: string
  barcode?: string
  unitPrice: number
  taxRate: number
  unit?: string
  type?: string
  category?: string
  stockAvailable: number | null
}

// ⚠ A boolean prop that is not passed is `false`, not `undefined` (Vue's boolean casting): without
// the default, a door that never passes `active` (the back office) never loaded its catalog.
const props = withDefaults(defineProps<{
  orgUrl: string
  currency: string
  /** The warehouse whose stock and prices the catalog shows: the session's, or the document's. */
  warehouseId?: string | null
  lines: RegisterLine[]
  /** A saved document: the cart only, no catalog, nothing editable. */
  readonly?: boolean
  /** Whether the catalog is live (the till's: only with an open session). */
  active?: boolean
  searchLabel?: string
  /** The till's extra filters. */
  filters?: { type?: boolean; tags?: boolean }
  /** The customer, for prices that depend on one. */
  contactId?: string
  /**
   * FR-21.30: the cart's totals and each line's gross, from `config/pos-totals#computePosTotals` —
   * the one function the till, the server's check and the fiscal device's arithmetic share. The
   * app computes them (ui-shared does not depend on `config`).
   */
  totals: { subtotal: number; taxTotal: number; total: number }
  lineGross: (line: RegisterLine) => number
}>(), { active: true, readonly: false })

const emit = defineEmits<{
  (e: 'add', product: RegisterCatalogProduct): void
  (e: 'quantity', idx: number, quantity: number): void
  (e: 'remove', idx: number): void
  (e: 'price', idx: number, option: any): void
}>()

const { t } = useI18n()

function fmt(n: number, decimals = 2) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: props.currency || 'EUR', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n || 0)
}

/**
 * #145: a typed quantity. Decimals are allowed (metres, kilograms); zero removes the line, which is
 * what the minus button does at 1; an empty, negative or non-numeric entry goes back to 1 rather
 * than leaving a line the server would refuse.
 */
function setQuantity(idx: number, value: unknown) {
  const q = Number(value)
  if (q === 0 || (typeof value === 'number' && value <= 0)) { emit('remove', idx); return }
  emit('quantity', idx, Number.isFinite(q) && q > 0 ? Math.round(q * 1000) / 1000 : 1)
}

// ── The catalog ─────────────────────────────────────────────────────────────
const search = ref('')
const searchField = ref<{ focus: () => void } | null>(null)
const categoryFilter = ref<string | null>(null)
const typeFilter = ref<string | null>(null)
const tagFilter = ref<string[]>([])
const categoryOptions = ref<{ title: string; value: string }[]>([])
const typeOptions = [
  { title: t('warehouse.goods'), value: 'goods' },
  { title: t('warehouse.service'), value: 'service' },
]
const products = ref<RegisterCatalogProduct[]>([])
const page = ref(1)
const totalPages = ref(1)
const catalogLoading = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null

/** The grid's own parameters, besides the search: a code looked up on Enter is counted with them. */
function gridParams(): Record<string, any> {
  const params: Record<string, any> = {}
  if (props.warehouseId) params.warehouseId = props.warehouseId
  // The catalog filters `Product.category` by NAME. The till sent the category's id, so its filter
  // matched nothing; one component, one value.
  if (categoryFilter.value) params.category = categoryFilter.value
  if (typeFilter.value) params.type = typeFilter.value
  if (tagFilter.value.length) params.tags = tagFilter.value.join(',')
  return params
}

function onSearchChange() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => fetchCatalog(0), 300)
}

/** Catalog requests made, and the newest of them whose answer is on screen. */
let catalogSeq = 0
let catalogShown = 0
/** The search text of the grid on screen, or of the request about to replace it. */
let gridSearch = ''

async function fetchCatalog(p = 0) {
  if (props.readonly || props.active === false) return
  const seq = ++catalogSeq
  const text = search.value || ''
  gridSearch = text
  catalogLoading.value = true
  try {
    const params: Record<string, any> = { page: p, size: 24, ...gridParams() }
    if (text) params.search = text
    const { data } = await httpClient.get(`${props.orgUrl}/trade/pos/catalog`, { params })
    // An answer older than the one on screen (a debounced search answering after Enter has added
    // the article and cleared the search) must not put back a grid the user has left.
    if (seq < catalogShown) return
    catalogShown = seq
    products.value = data.products || []
    totalPages.value = data.totalPages || 1
    page.value = (data.page || 0) + 1
  } catch {
    if (seq >= catalogShown) { catalogShown = seq; products.value = [] }
  } finally {
    if (seq >= catalogShown) catalogLoading.value = false
  }
}

async function fetchCategories() {
  try {
    const { data } = await httpClient.get(`${props.orgUrl}/warehouse/product-category`, { params: { size: 0 } })
    const cats = data.productCategories || data.categories || []
    categoryOptions.value = cats.map((c: any) => ({ title: c.name, value: c.name }))
  } catch { categoryOptions.value = [] }
}

// ── FR-22.55: Enter adds the article the search names ───────────────────────
//
// A barcode scanner types the code and presses Enter within milliseconds, before the 300 ms
// debounce has even filtered the grid, so the grid cannot say what was scanned: the server resolves
// the code (`/catalog/lookup`: the exact barcode, else the exact SKU, else the only article the
// search finds). Nothing unambiguous: nothing is added, the grid shows the search.
//
// Enters run in turn. A second scan typed while the first is still being looked up lands behind it
// in the search; the first takes only its own text out, so the second finds just its code.
let enterQueue: Promise<void> = Promise.resolve()
function onSearchEnter() {
  enterQueue = enterQueue.then(addTypedCode, addTypedCode)
}

async function addTypedCode() {
  const typed = search.value || ''
  const code = typed.trim()
  if (!code || props.readonly || props.active === false) return
  if (searchTimer) { clearTimeout(searchTimer); searchTimer = null }
  let product: RegisterCatalogProduct | null = null
  try {
    const { data } = await httpClient.get(`${props.orgUrl}/trade/pos/catalog/lookup`, { params: { ...gridParams(), code } })
    product = data?.product ?? null
  } catch { /* the grid is the answer */ }
  if (product) {
    emit('add', product)
    const now = search.value || ''
    search.value = now.startsWith(typed) ? now.slice(typed.length) : now
    searchField.value?.focus()
  }
  if ((search.value || '') !== gridSearch) await fetchCatalog(0)
}

watch(() => [props.warehouseId, props.active], () => fetchCatalog(0))

onMounted(() => {
  if (props.readonly) return
  void fetchCategories()
  void fetchCatalog(0)
})

/** What a door does after a sale: an empty search, the cursor in it, the stock figures fresh. */
function reset() {
  search.value = ''
  searchField.value?.focus()
  return fetchCatalog(0)
}

defineExpose({ refresh: () => fetchCatalog(page.value - 1), reset, focusSearch: () => searchField.value?.focus() })
</script>

<style scoped>
.register-card {
  cursor: pointer;
  user-select: none;
  transition: transform 0.05s ease;
}
.register-card:active {
  transform: scale(0.97);
}
.register-card-name {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  min-height: 2.6em;
  line-height: 1.3em;
}
.register-line-name {
  white-space: normal;
  word-break: break-word;
}
.register-catalog {
  min-height: 420px;
}
/* #145: wide enough for a 5-digit quantity with decimals, narrow enough to keep the line on one row. */
.register-qty {
  width: 84px;
  flex: 0 0 84px;
}
.register-qty :deep(input) {
  text-align: center;
}
</style>
