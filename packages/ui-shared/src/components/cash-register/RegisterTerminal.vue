<template>
  <!-- FR-21.29: one selling surface for every cash-register document — the till's
       (`/invoicing/cash-sales/new`) and the back-office form a saved sale opens on
       (`/invoicing/cash-sales/:id/edit`). Each keeps what is its own (the till: session, fiscal
       bridge, last sale, payment; the form: the document header) and hands it in through the slots. -->
  <v-row ref="terminalRoot" dense class="register-terminal">
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
            @keydown.f4.prevent="openDetails"
          />
          <!-- FR-28.25: the grid stays the till's search; "Details" is the Products list in a window, reading this
               catalog (active articles, this warehouse's stock), for the article the grid does not show. -->
          <ProductDetailsButton class="align-self-center" @click="openDetails" />
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
        <!-- One article a row, the full width: its name on the first line; its code, its price and its stock
             on the second, the price and the stock lined up down the right edge. The stock's colour is the
             out-of-stock signal (the box itself is no longer tinted: a page of red rows reads as an error).
             Beside the cart the list scrolls in its own box (see the style). -->
        <div v-else ref="listEl" class="register-list" data-testid="register-list">
          <v-card
            v-for="p in products"
            :key="p.productId"
            class="register-card px-3"
            variant="tonal"
            data-testid="register-card"
            @click="pick([p])"
          >
            <div class="register-card-name text-body-1 font-weight-medium text-truncate" :title="p.productName" data-testid="register-card-name">{{ p.productName }}</div>
            <div class="register-card-meta">
              <span class="register-card-sku text-caption text-medium-emphasis text-truncate" data-testid="register-card-sku">{{ p.sku }}</span>
              <span class="register-card-price font-weight-bold" data-testid="register-card-price">{{ fmt(p.unitPrice || 0, 4) }}</span>
              <v-chip
                v-if="p.stockAvailable != null"
                :color="p.stockAvailable > 0 ? 'success' : 'error'"
                variant="flat"
                density="compact"
                class="register-card-stock"
                data-testid="register-card-stock"
              >
                {{ $t('pos.stock') }}: {{ p.stockAvailable }}
              </v-chip>
            </div>
          </v-card>
          <div v-if="!products.length && !catalogLoading" class="text-center text-disabled pa-8">
            {{ $t('common.noData') }}
          </div>
        </div>
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
                  <!-- #145: a large quantity is typed, not clicked. A pick leaves the cursor here (`pick`);
                       Enter hands it back to the search, and the move away commits what was typed. -->
                  <v-text-field
                    :key="qtyResets[idx] || 0"
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
                    @change="(e: Event) => onQuantityTyped(idx, (e.target as HTMLInputElement).value)"
                    @focus="($event.target as HTMLInputElement)?.select()"
                    @keydown.enter.prevent="focusSearch(true)"
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

    <!-- FR-28.26: a pick adds one unit, as a card click does; several ticked add one of each. -->
    <ProductPickerDialog
      v-if="!readonly"
      v-model="detailsOpen"
      source="till"
      multiple
      :org-url="orgUrl"
      :base-currency="currency"
      :locale="localeTag"
      :stock-warehouse-id="warehouseId"
      :initial-search="detailsText"
      @select="(p: any) => pick([p])"
      @select-many="pick"
    />
  </v-row>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, toRaw, watch, type ComponentPublicInstance } from 'vue'
import { useI18n } from 'vue-i18n'
import { useDisplay } from 'vuetify'
import { httpClient } from '../../composables/useHttpClient'
import TagInput from '../TagInput.vue'
import PriceSelectButton from '../PriceSelectButton.vue'
import ProductDetailsButton from '../ProductDetailsButton.vue'
import ProductPickerDialog from '../ProductPickerDialog.vue'

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
   * door computes them: it holds the lines.
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

const { t, locale } = useI18n()

/** The app's language as a BCP 47 tag, for the figures the dialog prints. */
const localeTag = computed(() => ({ en: 'en-US', bg: 'bg-BG', de: 'de-DE', mk: 'mk-MK' } as Record<string, string>)[String(locale.value)] || 'en-US')

// ── FR-28.25: Details ──
const detailsOpen = ref(false)
/** What was typed in the grid's search when Details was asked for: the dialog opens searching for it. */
const detailsText = ref('')
function openDetails() {
  detailsText.value = search.value || ''
  detailsOpen.value = true
}

// ── A pick leaves the cursor in its line's quantity (goran, 2026-11-12) ──
//
// A click on an article, or a pick in Details, adds it (the door's `add`: a new line, or one more on
// the line that holds it) and puts the cursor in THAT line's quantity with its figure selected, so
// the clerk types how many at once. Several picked at once: the last one's line.
//
// Not the scanner's Enter in the search (`addTypedCode`): the next scan must land in the search
// again (FR-22.55). And not while the cart sits under the catalog (a phone): the cursor would pull
// the page down to the cart, away from the article just tapped, on every tap.
const terminalRoot = ref<ComponentPublicInstance | null>(null)
const { mdAndUp: cartBesideCatalog } = useDisplay()

async function pick(ps: RegisterCatalogProduct[]) {
  const last = ps[ps.length - 1]
  if (!last) return
  const before = new Map<RegisterLine, number>(props.lines.map((l) => [toRaw(l), Number(l.quantity)]))
  for (const p of ps) emit('add', p)
  if (!cartBesideCatalog.value) return
  // Both doors place the article before `add` returns; its line is on screen after this tick.
  await nextTick()
  // The line the door put it on: one that was not in the cart before, else the one whose quantity
  // grew. Neither (a door that refused it: a sale on its way) leaves the cursor where it was.
  const lines = props.lines
  let idx = lines.findIndex((l) => l.productId === last.productId && !before.has(toRaw(l)))
  if (idx < 0) idx = lines.findIndex((l) => l.productId === last.productId && Number(l.quantity) > (before.get(toRaw(l)) ?? Infinity))
  if (idx >= 0) focusQuantity(idx)
}

function focusQuantity(idx: number) {
  const root = terminalRoot.value?.$el as HTMLElement | undefined
  const input = root?.querySelectorAll<HTMLInputElement>('.register-qty input')[idx]
  if (!input) return
  input.focus()
  // Already focused (no focus event to select it): the figure is selected all the same.
  input.select()
}

/** The cursor back in the search; `select` so the next text typed or scanned replaces the last one. */
function focusSearch(select = false) {
  searchField.value?.focus()
  if (select) searchField.value?.select?.()
}

/**
 * Per line, bumped to put its quantity field back to the line's figure (the field is mounted anew).
 * A field shows what was typed in it until its line's quantity changes, so an entry that did NOT
 * change the quantity would otherwise stay on screen as if it had.
 */
const qtyResets = ref<Record<number, number>>({})
function resetQuantityField(idx: number) {
  qtyResets.value[idx] = (qtyResets.value[idx] || 0) + 1
}

/**
 * A whole number this long is a barcode, not a quantity. With the cursor left in a quantity after a
 * click, the next scan types its code there and ends with Enter, which as a quantity would sell
 * billions of units. It goes where a scan goes: to the search's lookup, which adds the article.
 */
const SCANNED_CODE = /^\d{8,}$/

function onQuantityTyped(idx: number, typed: string) {
  const line = props.lines[idx]
  if (!line) return
  const before = line.quantity
  const code = typed.trim()
  if (SCANNED_CODE.test(code)) {
    resetQuantityField(idx)
    search.value = code
    onSearchEnter()
    return
  }
  setQuantity(idx, typed)
  // The door kept the quantity it had (an unusable entry, or a sale on its way): show it, not the typing.
  if (props.lines[idx] === line && line.quantity === before && String(before) !== typed) resetQuantityField(idx)
}

function fmt(n: number, decimals = 2) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: props.currency || 'EUR', minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(n || 0)
}

/**
 * #145: a typed quantity. Decimals are allowed (metres, kilograms); zero removes the line, which is
 * what the minus button does at 1; an empty, negative or non-numeric entry goes back to 1 rather
 * than leaving a line the server would refuse.
 */
function setQuantity(idx: number, value: unknown) {
  // A number field reports a cleared entry, and one it cannot read, as '': `Number('')` is 0, which
  // removed the line. With the cursor left in the quantity after every pick, a stray Backspace did.
  if (typeof value === 'string' && !value.trim()) value = 1
  const q = Number(value)
  if (q === 0 || (typeof value === 'number' && value <= 0)) { emit('remove', idx); return }
  emit('quantity', idx, Number.isFinite(q) && q > 0 ? Math.round(q * 1000) / 1000 : 1)
}

// ── The catalog ─────────────────────────────────────────────────────────────
const search = ref('')
const searchField = ref<{ focus: () => void; select?: () => void } | null>(null)
const categoryFilter = ref<string | null>(null)
const typeFilter = ref<string | null>(null)
const tagFilter = ref<string[]>([])
const categoryOptions = ref<{ title: string; value: string }[]>([])
const typeOptions = [
  { title: t('warehouse.goods'), value: 'goods' },
  { title: t('warehouse.service'), value: 'service' },
]
const products = ref<RegisterCatalogProduct[]>([])
const listEl = ref<HTMLElement | null>(null)
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
    // A new search or page starts at its first article, not where the last list was scrolled to.
    if (listEl.value) listEl.value.scrollTop = 0
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
.register-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
/* A row keeps its height when the list is capped (below): a flex item would shrink to fit instead. */
.register-list > * {
  flex-shrink: 0;
}
/* Beside the cart (md and up, as the columns) the list scrolls in its own box: the page, and the cart
   with it, stay where they are while the clerk looks down the list, so the cursor a pick puts in the
   cart (`pick`) does not pull the page back up to it, and the pager stays in view. 358px is what the
   till has above and below the list at 1366x768: the app bar, its title, the filters and the pager. */
@media (min-width: 960px) {
  .register-list {
    max-height: max(300px, calc(100vh - 358px));
    overflow-y: auto;
    padding-right: 4px;
  }
}
/* Two lines in under 50px: a laptop's list shows seven rows and more. */
.register-card {
  cursor: pointer;
  user-select: none;
  transition: transform 0.05s ease;
  padding-top: 3px;
  padding-bottom: 3px;
}
.register-card:active {
  transform: scale(0.995);
}
.register-card-name {
  line-height: 1.3;
}
/* The code takes what the price and the stock leave, and gives way first. */
.register-card-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.register-card-sku {
  flex: 1 1 auto;
  min-width: 0;
}
.register-card-price {
  flex: none;
  white-space: nowrap;
  font-size: 0.9375rem;
  font-variant-numeric: tabular-nums;
}
/* One width for every badge, so the prices beside them line up down the list. */
.register-card .register-card-stock {
  flex: none;
  height: 22px;
  min-width: 8.5rem;
  justify-content: center;
  font-variant-numeric: tabular-nums;
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
