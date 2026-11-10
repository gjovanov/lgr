<template>
  <v-dialog
    :model-value="modelValue"
    @update:model-value="emit('update:modelValue', $event)"
    max-width="1400"
    scrollable
  >
    <v-card data-testid="product-picker">
      <v-toolbar color="surface" flat density="compact">
        <v-toolbar-title class="text-body-1 font-weight-bold">
          {{ $t('invoicing.productDialog.title') }}
        </v-toolbar-title>
        <v-spacer />
        <v-btn
          icon="mdi-cog"
          size="small"
          variant="text"
          :color="colsCustomized ? 'primary' : undefined"
          :title="$t('grid.columns')"
          :aria-label="$t('grid.columns')"
          data-testid="product-picker-columns"
          @click="colDialogOpen = true"
        />
        <v-btn icon="mdi-close" variant="text" size="small" :aria-label="$t('common.close')" data-testid="product-picker-close" @click="close" />
      </v-toolbar>

      <v-card-text class="pa-3">
        <!-- FR-28.22: the Products list's own filters, and its own columns below. -->
        <ProductFilterBar
          ref="filterBar"
          :list="list"
          :org-url="orgUrl"
          :variant="source === 'till' ? 'till' : 'products'"
          autofocus-search
          @search-keydown="onSearchKeydown"
        />

        <GridColumnPickerDialog
          v-model="colDialogOpen"
          :entries="colEntries"
          @toggle="toggleCol"
          @reorder="reorderCols"
          @reset="resetCols"
        />

        <v-data-table-server
          v-model="selectedIds"
          :show-select="multiple"
          :headers="effectiveHeaders"
          :items="list.items"
          :items-length="list.pagination.total"
          :loading="list.loading"
          :page="list.pagination.page + 1"
          :items-per-page="list.pagination.size"
          :items-per-page-options="pageSizes"
          :row-props="rowProps"
          item-value="_id"
          density="compact"
          hover
          class="picker-table"
          @update:options="list.onUpdateOptions"
          @click:row="onRowClick"
          @dblclick:row="onRowDblClick"
        >
          <template #item.name="{ item }">
            <span class="d-inline-flex align-center ga-1">
              {{ item.name }}
              <!-- FR-28.28: what the document already holds is marked, not hidden: a line may well be wanted twice. -->
              <v-icon
                v-if="onDocument(item._id)"
                size="small"
                color="success"
                :title="$t('invoicing.productDialog.alreadyThere')"
                data-testid="product-on-document"
              >mdi-check-circle-outline</v-icon>
            </span>
          </template>
          <template v-for="key in PRODUCT_CELL_KEYS" #[`item.${key}`]="{ item }">
            <ProductCell :column="key" :item="item" :list="list" />
          </template>
        </v-data-table-server>
      </v-card-text>

      <v-card-actions v-if="multiple" class="px-4 pb-3">
        <span class="text-body-2 text-medium-emphasis" data-testid="product-picker-selected">
          {{ selectedIds.length ? $t('invoicing.productDialog.selected', { n: selectedIds.length }) : $t('invoicing.productDialog.tickHint') }}
        </span>
        <v-spacer />
        <v-btn variant="text" data-testid="product-picker-cancel" @click="close">{{ $t('common.cancel') }}</v-btn>
        <v-btn
          color="primary"
          variant="flat"
          :disabled="!selectedIds.length"
          data-testid="product-picker-add"
          @click="confirm"
        >
          {{ $t('invoicing.productDialog.add', selectedIds.length) }}
        </v-btn>
      </v-card-actions>
    </v-card>
  </v-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, toRef, watch } from 'vue'
import { useGridColumns } from '../composables/useGridColumns'
import { useProductList } from '../composables/product-list/useProductList'
import { useProductColumns, PRODUCT_CELL_KEYS } from '../composables/product-list/useProductColumns'
import ProductFilterBar from './product-list/ProductFilterBar.vue'
import ProductCell from './product-list/ProductCell.vue'
import GridColumnPickerDialog from './GridColumnPickerDialog.vue'

/**
 * FR-28.23 — the product dialog is the Products list in a window ("Details").
 *
 * Its filters, its columns (and the user's own choice of them, kept under the list's key), its page sizes, its
 * cells and its request are the list's: `useProductList`, `ProductFilterBar`, `useProductColumns` and `ProductCell`
 * are shared with the Products page, so the two cannot drift. What is the dialog's own: it opens FRESH on a typed
 * search, sorts by name, lists active articles, and picks — one article, or several (`multiple`).
 *
 * `stockWarehouseId` SCOPES the stock figures and never restricts the rows (a receipt adds articles that have no
 * stock there yet). `source="till"` reads the cash register's catalog instead (active articles, the session
 * warehouse's stock) and hands back the catalog's own row, as a card click does.
 */

const props = withDefaults(defineProps<{
  modelValue: boolean
  orgUrl: string
  baseCurrency?: string
  /** A BCP 47 tag (`en-US`). */
  locale?: string
  /** A tick column and "Add N articles": the screen takes several at once (FR-28.28). */
  multiple?: boolean
  /** The warehouse whose stock the cells show. Scopes the figures, never the rows. */
  stockWarehouseId?: string | null
  /** The price the screen starts a line from: shown by default even where the list hides it (the user's choice still wins). */
  priceField?: 'sellingPrice' | 'purchasePrice' | null
  /** What the screen already holds: marked in the table, not hidden from it. */
  existingProductIds?: readonly string[]
  /** What the user had typed in the screen's field: the dialog opens searching for it. */
  initialSearch?: string
  /** `till`: the cash register's catalog. */
  source?: 'products' | 'till'
}>(), { multiple: false, source: 'products', existingProductIds: () => [] })

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  /** One article, in single mode. */
  'select': [product: any]
  /** The ticked articles, in the order they were ticked (`multiple`). */
  'select-many': [products: any[]]
}>()

const list = useProductList({
  orgUrl: () => props.orgUrl,
  baseCurrency: () => props.baseCurrency || 'EUR',
  locale: () => props.locale || 'en-US',
  source: props.source,
  // It opens sorted by name, as the inline search does, and lists active articles.
  defaultSize: 25,
  defaultSortBy: 'name',
  defaultSortOrder: 'asc',
  stockWarehouseId: () => props.stockWarehouseId,
  // The Suppliers column's facts are asked for only while the column is shown (the cog can hide it).
  wantSupplierFacts: () => suppliersShown.value,
  active: () => props.modelValue,
})

const { headers: listHeaders } = useProductColumns({
  seesSuppliers: list.seesSuppliers,
  activeFilter: toRef(list, 'activeFilter'),
  withActions: false,
  shownByDefault: () => (props.priceField ? [props.priceField] : []),
  source: props.source,
})
// The same columns as the list, and a dialog is narrower than a page: a code with no break in it must not be wrapped
// letter by letter over five lines. (The titles and keys — what the user's saved choice names — are the list's.)
const headers = computed(() => listHeaders.value.map((h: any) => (h.key === 'sku' ? { ...h, minWidth: '120px' } : h)))

// D-8: the SAME per-user choice as the Products list (`lgr:grid-cols:<userId>:<orgId>:inventory.products`), so a user
// sets their columns once. The till's catalog has columns of its own, and keeps its own choice.
const colDialogOpen = ref(false)
const {
  effectiveHeaders,
  entries: colEntries,
  toggle: toggleCol,
  reorder: reorderCols,
  reset: resetCols,
  customized: colsCustomized,
} = useGridColumns({
  headers,
  gridId: () => (props.source === 'till' ? 'pos.catalog-picker' : 'inventory.products'),
})

const suppliersShown = computed(() => effectiveHeaders.value.some((h: any) => h.key === 'suppliers'))
watch(suppliersShown, (shown) => { if (shown && props.modelValue) void list.fetchSupplierFacts() })

/** "All" only where the server can answer it: the till's catalog pages at 200 at most. */
const pageSizes = computed(() => [
  { value: 10, title: '10' },
  { value: 25, title: '25' },
  { value: 50, title: '50' },
  { value: 100, title: '100' },
  ...(props.source === 'till' ? [] : [{ value: -1, title: '$vuetify.dataFooter.itemsPerPageAll' }]),
])

// ── what is ticked, and what the keyboard has under it ──
const selectedIds = ref<string[]>([])
/** Every article this dialog has shown since it opened: a tick on page 1 still names its article on page 3. */
const seen = new Map<string, any>()
watch(() => list.items, (rows) => { for (const r of rows) seen.set(r._id, r) }, { immediate: true })
const highlighted = ref(0)
watch(() => list.items, () => { highlighted.value = 0 })

const existing = computed(() => new Set((props.existingProductIds || []).map(String)))
const onDocument = (id: string) => existing.value.has(String(id))

/** What a pick hands back: the product as its endpoint answered it (the till's catalog row, as a card click does). */
const payload = (row: any) => row?.raw ?? row

function rowProps({ index }: { index: number }) {
  return { class: index === highlighted.value ? 'picker-row--active' : '' }
}

function close() {
  emit('update:modelValue', false)
}
function pickOne(row: any) {
  if (props.multiple) emit('select-many', [payload(row)])
  else emit('select', payload(row))
  close()
}
function confirm() {
  const rows = selectedIds.value.map((id) => seen.get(id)).filter(Boolean)
  if (!rows.length) return
  emit('select-many', rows.map(payload))
  close()
}

function toggle(id: string) {
  selectedIds.value = selectedIds.value.includes(id) ? selectedIds.value.filter((x) => x !== id) : [...selectedIds.value, id]
}
function onRowClick(_e: Event, row: { item: any }) {
  // One article, picked by clicking it. With several wanted, a click ticks the row (the checkbox does the same).
  if (props.multiple) toggle(row.item._id)
  else pickOne(row.item)
}
/** A double click picks just this article, ticked or not. */
function onRowDblClick(_e: Event, row: { item: any }) {
  if (props.multiple) pickOne(row.item)
}

/** The search has answered for what is typed: nothing is waiting on the debounce or on the request. */
async function settled(timeoutMs = 1500) {
  const until = Date.now() + timeoutMs
  while ((list.search !== list.debouncedSearch || list.loading) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 40))
  }
}
async function onSearchKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    highlighted.value = Math.min(Math.max(0, list.items.length - 1), highlighted.value + 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    highlighted.value = Math.max(0, highlighted.value - 1)
  } else if (e.key === 'Enter') {
    e.preventDefault()
    // "Type, then Enter": wait for the list that the typed text is asking for, then take its first (highlighted) row.
    await settled()
    if (props.multiple && selectedIds.value.length) confirm()
    else if (list.items[highlighted.value]) pickOne(list.items[highlighted.value])
  }
}

// Opens FRESH, and asks for exactly one page (`useProductList.openFresh`).
const filterBar = ref<{ focusSearch: () => void } | null>(null)
watch(() => props.modelValue, (open) => {
  if (!open) return
  selectedIds.value = []
  seen.clear()
  highlighted.value = 0
  list.openFresh({ search: props.initialSearch || '' })
  // The cursor goes in the search box once the dialog is on screen (a dialog that stays mounted ignores `autofocus`).
  void nextTick(() => setTimeout(() => filterBar.value?.focusSearch(), 60))
})
</script>

<style scoped>
/* The list's headers (AppShell styles every table inside the app): a dialog is teleported out of it, so it says it again. */
.picker-table :deep(th) {
  font-weight: 700 !important;
  text-transform: uppercase;
  font-size: 0.75rem !important;
  letter-spacing: 0.05em;
}
.picker-table :deep(tbody tr) {
  cursor: pointer;
}
.picker-table :deep(tbody tr.picker-row--active) {
  background: rgba(var(--v-theme-primary), 0.08);
}
</style>
