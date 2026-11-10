<template>
  <ListScaffold
    :title="$t('nav.products')"
    :headers="headers"
    :items="items"
    :loading="loading"
    :pagination="pagination"
    :has-active-filters="hasActiveFilters"
    :empty="{ icon: 'mdi-package-variant-closed', title: $t('list.empty.products'), description: $t('list.empty.productsHint') }"
    :empty-filtered="{ title: $t('list.noMatches'), description: $t('list.adjustFilters') }"
    @update:options="onUpdateOptions"
  >
    <template #actions>
      <!-- FR-26.8.7: the Export menu only for a session with the catalog's export area. -->
      <export-menu v-if="exportsCatalog" @export="onExport" />
      <responsive-btn v-if="writes" color="primary" icon="mdi-plus" :to="{ name: 'inventory.products.new', params: { tab: 'edit' } }">{{ $t('common.create') }}</responsive-btn>
    </template>

    <template #filters>
      <v-card class="mb-4">
        <v-card-text class="pb-4">
          <v-row>
            <v-col cols="12" md="2">
              <v-text-field v-model="search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" />
            </v-col>
            <v-col cols="12" md="2">
              <v-autocomplete
                v-model="warehouseFilter"
                :items="warehouseOptions"
                item-title="name"
                item-value="_id"
                :label="$t('warehouse.warehouse')"
                prepend-inner-icon="mdi-warehouse"
                clearable
                hide-details
                density="compact"
              />
            </v-col>
            <v-col cols="12" md="2">
              <v-select v-model="categoryFilter" :label="$t('warehouse.category')" :items="categoryOptions" clearable hide-details density="compact" />
            </v-col>
            <v-col cols="12" md="2">
              <v-select v-model="typeFilter" :label="$t('common.type')" :items="productTypeItems(['goods', 'service'])" clearable hide-details density="compact" />
            </v-col>
            <v-col cols="12" md="2">
              <TagInput v-model="tagFilter" type="product" :org-url="appStore.orgUrl()" :label="$t('common.filterByTags')" />
            </v-col>
            <v-col cols="12" md="2">
              <!-- FR-22.48: a deactivated article stays out of the list unless this asks for it. -->
              <v-select v-model="activeFilter" :label="$t('common.status')" :items="activeFilterItems" hide-details density="compact" />
            </v-col>
          </v-row>
          <!-- FR-28.3: who we buy it from, and how much of it there is. The quantity is the Stock column's own
               figure; "below minimum" is the Reports rule, and "out of stock" is the range at 0. Supplier facts are
               incoming-document data (FR-28.6): a role that may not read bills is not offered them. -->
          <v-row class="mt-1 align-center" data-testid="stock-filters">
            <v-col v-if="seesSuppliers" cols="12" md="3">
              <v-autocomplete
                v-model="supplierFilter"
                v-model:search="supplierSearch"
                :items="supplierOptions"
                item-title="name"
                item-value="_id"
                :label="$t('warehouse.supplierFacts.filterSupplier')"
                prepend-inner-icon="mdi-truck-delivery-outline"
                multiple
                chips
                closable-chips
                clearable
                no-filter
                hide-details
                density="compact"
                :loading="loadingSuppliers"
                :disabled="noSupplier"
                data-testid="filter-supplier"
              />
            </v-col>
            <v-col v-if="seesSuppliers" cols="12" md="2">
              <v-checkbox v-model="noSupplier" :label="$t('warehouse.supplierFacts.noSupplier')" hide-details density="compact" data-testid="filter-no-supplier" />
            </v-col>
            <v-col cols="6" md="1">
              <v-text-field v-model="stockMin" :label="$t('warehouse.supplierFacts.stockFrom')" type="number" hide-details density="compact" data-testid="filter-stock-min" />
            </v-col>
            <v-col cols="6" md="1">
              <v-text-field v-model="stockMax" :label="$t('warehouse.supplierFacts.stockTo')" type="number" hide-details density="compact" data-testid="filter-stock-max" />
            </v-col>
            <v-col cols="12" md="5" class="d-flex align-center flex-wrap ga-2">
              <v-chip
                :variant="belowMin ? 'flat' : 'outlined'"
                :color="belowMin ? 'primary' : undefined"
                :prepend-icon="belowMin ? 'mdi-check' : undefined"
                data-testid="filter-below-min"
                @click="belowMin = !belowMin"
              >
                {{ $t('warehouse.supplierFacts.belowMinimum') }}
              </v-chip>
              <v-chip
                :variant="outOfStockOn ? 'flat' : 'outlined'"
                :color="outOfStockOn ? 'primary' : undefined"
                :prepend-icon="outOfStockOn ? 'mdi-check' : undefined"
                data-testid="filter-out-of-stock"
                @click="toggleOutOfStock"
              >
                {{ $t('warehouse.supplierFacts.outOfStock') }}
              </v-chip>
              <v-checkbox v-model="projected" :label="$t('warehouse.supplierFacts.countOpenOrders')" hide-details density="compact" class="flex-grow-0" data-testid="filter-projected" />
            </v-col>
          </v-row>
        </v-card-text>
      </v-card>
    </template>

    <!-- A code with no break in it (E2E-CSP-1793022750769) must not widen the list past 1366 px. -->
    <template #item.sku="{ item }"><span style="overflow-wrap: anywhere">{{ item.sku }}</span></template>
    <template #item.name="{ item }">
      <entity-link :label="item.name" :to="{ name: 'inventory.products.edit', params: { id: item._id, tab: 'edit' } }" />
    </template>
    <template #item.type="{ item }">{{ productTypeLabel(item.type) }}</template>
    <template #item.stock="{ item }">
      <div class="d-flex flex-wrap ga-1 py-1">
        <v-chip
          v-for="s in stockFor(item._id)"
          :key="s.warehouseId"
          size="x-small"
          :color="s.quantity > 0 ? 'success' : 'error'"
          variant="tonal"
          :title="s.warehouseName"
        >
          {{ s.warehouseName }}: {{ fmtQty(s.quantity) }}
        </v-chip>
        <span v-if="!stockFor(item._id).length" class="text-disabled text-caption">—</span>
      </div>
    </template>
    <!--
      FR-22.45 (#203.8, #4.5): held for clients, and ordered from suppliers but not yet here. Each
      figure opens the article's stock tab, which lists the reservations and the orders behind it.
    -->
    <template #item.reserved="{ item }">
      <entity-link
        v-if="supplyFor(item._id).reserved"
        :label="fmtQty(supplyFor(item._id).reserved)"
        :to="stockTab(item)"
        :aria-label="`${$t('warehouse.supply.reserved')}: ${fmtQty(supplyFor(item._id).reserved)}`"
      />
      <span v-else class="text-disabled">—</span>
    </template>
    <template #item.onOrder="{ item }">
      <template v-if="supplyFor(item._id).incoming">
        <entity-link
          :label="fmtQty(supplyFor(item._id).incoming)"
          :to="stockTab(item)"
          :aria-label="`${$t('warehouse.supply.onOrder')}: ${fmtQty(supplyFor(item._id).incoming)}`"
        />
        <div v-if="supplyFor(item._id).reservedIncoming" class="text-caption text-medium-emphasis text-no-wrap">
          {{ $t('warehouse.supply.reservedIncoming') }}: {{ fmtQty(supplyFor(item._id).reservedIncoming) }}
        </div>
      </template>
      <span v-else class="text-disabled">—</span>
    </template>
    <!--
      FR-28.6: which suppliers the article was bought from — the two most recent, "+N" for the rest, and every
      one with its last purchase in the tooltip. Read from the received bills and the receipts that name a
      supplier, one call per page. A dash is "nobody", never "not loaded yet" (that is an ellipsis).
    -->
    <template v-if="seesSuppliers" #item.suppliers="{ item }">
      <v-icon v-if="supplierFailed" size="small" color="warning" :title="$t('warehouse.supplierFacts.loadFailed')" data-testid="product-suppliers-failed">mdi-alert-circle-outline</v-icon>
      <div v-else-if="!suppliersLoaded(item._id)" class="text-disabled" data-testid="product-suppliers-loading">…</div>
      <div v-else-if="!factsOf(item._id).length" class="suppliers-cell text-disabled" data-testid="product-suppliers">—</div>
      <div v-else data-testid="product-suppliers" class="suppliers-cell">
        <!-- One line per name, cut with an ellipsis: the tooltip has them whole. -->
        <div v-for="f in factsOf(item._id).slice(0, 2)" :key="f.supplierId" class="text-truncate">{{ f.supplierName || '—' }}</div>
        <v-chip v-if="moreSuppliers(item._id) > 0" size="x-small" variant="tonal">+{{ moreSuppliers(item._id) }}</v-chip>
        <v-tooltip activator="parent" location="top" max-width="420">
          <div v-for="f in factsOf(item._id)" :key="f.supplierId">
            <strong>{{ f.supplierName || '—' }}</strong>: {{ fmtDate(f.lastPurchasedAt) }}<template v-if="f.lastUnitPrice !== undefined"> · {{ fmtPrice(f.lastUnitPrice, f.currency) }}</template>
          </div>
          <div v-if="moreSuppliers(item._id) > factsOf(item._id).length - 2" class="text-caption mt-1">
            {{ $t('warehouse.supplierFacts.andMore', { n: moreSuppliers(item._id) - (factsOf(item._id).length - 2) }) }}
          </div>
        </v-tooltip>
      </div>
    </template>
    <template v-if="seesSuppliers" #item.lastPurchase="{ item }">
      <span v-if="factsOf(item._id).length" class="text-no-wrap">{{ fmtDate(factsOf(item._id)[0].lastPurchasedAt) }}</span>
      <span v-else class="text-disabled">—</span>
    </template>
    <template v-if="seesSuppliers" #item.lastCost="{ item }">
      <span v-if="factsOf(item._id)[0]?.lastUnitPrice !== undefined" class="text-no-wrap">{{ fmtPrice(factsOf(item._id)[0].lastUnitPrice!, factsOf(item._id)[0].currency) }}</span>
      <span v-else class="text-disabled">—</span>
    </template>
    <template #item.minStockLevel="{ item }">
      <span v-if="item.minStockLevel">{{ fmtQty(item.minStockLevel) }}</span>
      <span v-else class="text-disabled">—</span>
    </template>
    <!-- What to order to be back at the maximum (the minimum when there is none): the figure the order dialog of
         FR-28.16 starts from. Only for an article at or below its minimum. -->
    <template #item.toOrder="{ item }">
      <span v-if="toOrder(item) !== null" class="font-weight-medium">{{ fmtQty(toOrder(item)!) }}</span>
      <span v-else class="text-disabled">—</span>
    </template>
    <template #item.purchasePrice="{ item }">{{ fmtPrice(item.purchasePrice) }}</template>
    <template #item.sellingPrice="{ item }">{{ fmtPrice(item.sellingPrice) }}</template>
    <!-- The price tiers, a column per slot (product-price-columns.ts). An article with no price at
         a tier's level shows a dash, as it shows nothing reserved. -->
    <template v-for="col in TIER_COLUMNS" #[`item.${col.key}`]="{ item }">
      <span v-if="tierPrice(item.priceTiers, col.name) === null" class="text-disabled">—</span>
      <template v-else>{{ fmtPrice(tierPrice(item.priceTiers, col.name)!) }}</template>
    </template>
    <template #item.isActive="{ item }">
      <v-icon :color="item.isActive !== false ? 'success' : 'grey'">
        {{ item.isActive !== false ? 'mdi-check-circle' : 'mdi-close-circle' }}
      </v-icon>
    </template>
    <template #item.actions="{ item }">
      <!-- FR-22.23 / .47: the row's actions in one menu — the article's pages, the documents it
           starts („Заприходи", „Продай", „Резервирай"), and Delete apart. -->
      <RowActionsMenu :actions="rowActions(item)" />
    </template>

    <v-dialog v-model="deleteDialog" max-width="400">
      <v-card>
        <v-card-title>{{ $t('common.confirm') }}</v-card-title>
        <v-card-text>{{ $t('warehouse.deleteProductConfirm') }}</v-card-text>
        <v-card-actions>
          <v-spacer />
          <v-btn @click="deleteDialog = false">{{ $t('common.cancel') }}</v-btn>
          <v-btn color="error" @click="doDelete">{{ $t('common.delete') }}</v-btn>
        </v-card-actions>
      </v-card>
    </v-dialog>
  </ListScaffold>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { holdsArea } from 'config/constants'
import { sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import { writesInventory } from 'ui-shared/nav/page-registry'
import { useAccess } from 'ui-shared/access/useAccess'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { usePaginatedTable } from 'ui-shared/composables/usePaginatedTable'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useSearchDebounce } from 'ui-shared/composables/useSearchDebounce'
import { useListQueryState } from 'ui-shared/composables/useListQueryState'
import { useProductTypes } from 'ui-shared/composables/useProductTypes'
import ListScaffold from 'ui-shared/components/ListScaffold'
import ExportMenu from 'ui-shared/components/ExportMenu'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import TagInput from 'ui-shared/components/TagInput.vue'
import EntityLink from 'ui-shared/components/EntityLink'
import RowActionsMenu, { type RowAction } from 'ui-shared/components/RowActionsMenu.vue'
import { useProductDocActions } from '../composables/useProductDocActions'
import { TIER_COLUMNS, tierPrice, formatUnitPrice, type TierLike } from '../composables/product-price-columns'

interface Product { _id: string; sku: string; name: string; category: string; type: string; unit: string; purchasePrice: number; sellingPrice: number; priceTiers?: TierLike[]; isActive: boolean; trackInventory?: boolean; minStockLevel?: number; maxStockLevel?: number }
/** `GET /warehouse/product-supplier/by-products` — the wire shape (`SupplierFact` in product-suppliers.service). */
interface SupplierFact { supplierId: string; supplierName: string; lastPurchasedAt: string; lastUnitPrice?: number; currency?: string; quantity: number; documents: number }
/** How many suppliers a cell names before "+N". */
const SUPPLIERS_SHOWN = 2
/** The API's cap on articles per supplier call; a page of "All" goes in chunks. */
const SUPPLIER_CALL_SIZE = 100
interface StockBadge { warehouseId: string; warehouseName: string; quantity: number; availableQuantity: number }
/** `getProductsSupplyTotals` — the definitions of the product's stock tab, summed. */
interface SupplyTotals { reserved: number; incoming: number; reservedIncoming: number; planned: number }
const NO_SUPPLY: SupplyTotals = { reserved: 0, incoming: 0, reservedIncoming: 0, planned: 0 }

/** FR-22.48: which articles the list shows. A deactivated one only when asked for. */
const ACTIVE_FILTERS = ['active', 'inactive', 'all'] as const
type ActiveFilter = (typeof ACTIVE_FILTERS)[number]

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const { productTypeLabel, productTypeItems } = useProductTypes()
const baseCurrency = computed(() => appStore.currentOrg?.baseCurrency || 'EUR')
const localeCode = computed(() => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale] || 'en-US'))

const { search, debouncedSearch } = useSearchDebounce()
const deleteDialog = ref(false)
const selectedId = ref('')

const categoryFilter = ref<string | null>(null)
const typeFilter = ref<string | null>(null)
const tagFilter = ref<string[]>([])
const warehouseFilter = ref<string | null>(null)
const activeFilter = ref<ActiveFilter>('active')
const categoryOptions = ref<string[]>([])
const warehouseOptions = ref<any[]>([])
const stockMap = ref<Record<string, StockBadge[]>>({})
const supplyMap = ref<Record<string, SupplyTotals>>({})

// FR-28.6: supplier facts are incoming-document data (`bills.view`, the server's rule too): a role without it is
// offered no Suppliers, Last purchase or Last cost column, and no supplier filter. The price is a cost figure,
// which FR-27 will give its own right (`products.costs`); until the catalogue has it, whoever reads bills reads it.
const access = useAccess()
const seesSuppliers = access.can('bills.view')
const supplierMap = ref<Record<string, SupplierFact[]>>({})
const supplierCounts = ref<Record<string, number>>({})
/** The last call for supplier facts failed: the cells say so, instead of a dash that would read "nobody". */
const supplierFailed = ref(false)

// The new filters (FR-28.3). The supplier ids and the two stock bounds are what the user chose; the bounds are
// typed, so they are debounced like the search is.
const supplierFilter = ref<string[]>([])
const noSupplier = ref(false)
const supplierSearch = ref('')
const supplierOptions = ref<Array<{ _id: string; name: string }>>([])
const loadingSuppliers = ref(false)
const { search: stockMin, debouncedSearch: debouncedStockMin } = useSearchDebounce(500)
const { search: stockMax, debouncedSearch: debouncedStockMax } = useSearchDebounce(500)
const belowMin = ref(false)
const projected = ref(false)
/** "Out of stock" is the range at 0 (FR-28.3): on while that is exactly what is set. */
const outOfStockOn = computed(() => debouncedStockMax.value === '0' && debouncedStockMin.value === '')
function toggleOutOfStock() {
  if (outOfStockOn.value) {
    stockMax.value = ''
  } else {
    stockMin.value = ''
    stockMax.value = '0'
  }
}
// A supplier or "no supplier", not both: together they match nothing, so choosing one clears the other.
watch(noSupplier, (on) => { if (on) supplierFilter.value = [] })

const activeFilterItems = computed(() => [
  { title: t('warehouse.activeFilter.active'), value: 'active' },
  { title: t('warehouse.activeFilter.inactive'), value: 'inactive' },
  { title: t('common.all'), value: 'all' },
])

const filters = computed(() => {
  const f: Record<string, any> = {}
  if (debouncedSearch.value) f.search = debouncedSearch.value
  if (categoryFilter.value) f.category = categoryFilter.value
  if (typeFilter.value) f.type = typeFilter.value
  if (tagFilter.value.length) f.tags = tagFilter.value.join(',')
  if (warehouseFilter.value) f.warehouseId = warehouseFilter.value
  if (activeFilter.value !== 'all') f.isActive = activeFilter.value === 'active' ? 'true' : 'false'
  // FR-28.3. A URL that carries a supplier filter to a role that may not read bills is ignored, not refused:
  // the server would answer 403, and the list would not open.
  if (seesSuppliers) {
    if (supplierFilter.value.length) f.supplierId = supplierFilter.value.join(',')
    if (noSupplier.value) f.noSupplier = 'true'
  }
  if (debouncedStockMin.value !== '') f.stockMin = debouncedStockMin.value
  if (debouncedStockMax.value !== '') f.stockMax = debouncedStockMax.value
  if (belowMin.value) f.belowMin = 'true'
  if (projected.value) f.basis = 'projected'
  return f
})

const hasActiveFilters = computed(() =>
  !!(debouncedSearch.value || categoryFilter.value || typeFilter.value || tagFilter.value.length || warehouseFilter.value || activeFilter.value !== 'active'
    || (seesSuppliers && (supplierFilter.value.length || noSupplier.value))
    || debouncedStockMin.value !== '' || debouncedStockMax.value !== '' || belowMin.value),
)

const url = computed(() => `${appStore.orgUrl()}/warehouse/product`)
// FR-05 (#12): grid state in the querystring; declared before usePaginatedTable.
useListQueryState([
  { key: 'q', ref: search, mirror: debouncedSearch },
  { key: 'category', ref: categoryFilter },
  { key: 'type', ref: typeFilter },
  { key: 'tags', ref: tagFilter, codec: 'csv' },
  { key: 'warehouse', ref: warehouseFilter },
  // The default is declared, so a bare URL stays bare and means "active articles".
  { key: 'status', ref: activeFilter, default: 'active', sanitize: (v) => (ACTIVE_FILTERS.includes(v) ? v : undefined) },
  // FR-28.3: what to buy again. A bound that is no number is dropped from the URL, as the server drops it.
  { key: 'supplier', ref: supplierFilter, codec: 'csv' },
  { key: 'noSupplier', ref: noSupplier, codec: 'bool' },
  { key: 'stockMin', ref: stockMin, mirror: debouncedStockMin, sanitize: (v) => (Number.isFinite(Number(v)) ? String(v) : undefined) },
  { key: 'stockMax', ref: stockMax, mirror: debouncedStockMax, sanitize: (v) => (Number.isFinite(Number(v)) ? String(v) : undefined) },
  { key: 'belowMin', ref: belowMin, codec: 'bool' },
  { key: 'projected', ref: projected, codec: 'bool' },
])

const { items, loading, pagination, fetchItems, onUpdateOptions } = usePaginatedTable({
  url,
  entityKey: 'products',
  filters,
  urlSync: true,
})

// FR-22.46 (#4.1): stock before unit, and what is reserved and on order right after the stock.
// A user who reordered the columns keeps their order; the two new ones join it after „Наличност"
// (useGridColumns).
//
// The three stock columns sort by the figure the cell shows, over every filtered article (the
// server computes them, `product-stock-sort.ts`); a dash goes last either way.
//
// With the price tiers shown the list is wider than a 1366 px screen, so the name and the row
// menu stay put while the prices scroll sideways (`fixed`), and the name keeps a readable width
// instead of shrinking to a word per line. The price columns take FR-22.23's 8 px gutters, which
// is what lets the whole list fit 1920 px in Bulgarian. „Покупна цена" waits on the cog: it is
// „Доставна цена" again wherever the tiers are kept.
const PRICE_CELL = { headerProps: { class: 'px-2' }, cellProps: { class: 'px-2' } }
const headers = computed(() => [
  { title: t('warehouse.sku'), key: 'sku', sortable: true },
  { title: t('common.name'), key: 'name', sortable: true, fixed: 'start' as const, minWidth: '180px' },
  { title: t('warehouse.category'), key: 'category', sortable: true },
  { title: t('common.type'), key: 'type' },
  { title: t('warehouse.stock'), key: 'stock' },
  { title: t('warehouse.supply.reserved'), key: 'reserved', align: 'end' as const },
  { title: t('warehouse.supply.onOrder'), key: 'onOrder', align: 'end' as const },
  // FR-28.6: who sold it to us, right after what is on order — where "what do we do about it" is asked. None of
  // these sorts: they are read from the documents, not a field of the article. The supplier names are shown;
  // the last purchase and its cost, the minimum and what to order wait on the cog (`defaultHidden`), so a
  // user's saved columns neither lose the names nor gain the rest.
  ...(seesSuppliers ? [
    // The names are cut inside a capped box and the column takes the price columns' 8 px gutters: with it shown by
    // default the list still fits 1366 px without the tiers (FR-22.23, product-actions.spec).
    { title: t('warehouse.supplierFacts.column'), key: 'suppliers', sortable: false, ...PRICE_CELL },
    { title: t('warehouse.supplierFacts.lastPurchase'), key: 'lastPurchase', sortable: false, defaultHidden: true },
    { title: t('warehouse.supplierFacts.lastCost'), key: 'lastCost', sortable: false, align: 'end' as const, defaultHidden: true, ...PRICE_CELL },
  ] : []),
  { title: t('warehouse.supplierFacts.minimum'), key: 'minStockLevel', align: 'end' as const, defaultHidden: true },
  { title: t('warehouse.supplierFacts.toOrder'), key: 'toOrder', sortable: false, align: 'end' as const, defaultHidden: true },
  { title: t('warehouse.unit'), key: 'unit' },
  { title: t('warehouse.purchasePrice'), key: 'purchasePrice', align: 'end' as const, defaultHidden: true, ...PRICE_CELL },
  { title: t('warehouse.sellingPrice'), key: 'sellingPrice', align: 'end' as const, ...PRICE_CELL },
  // A column per price tier, headed by the tier's name and sorted by its price (the server reads
  // the tier out of `tier_<slot>`); the slots regal prices by are shown, the rest wait on the cog.
  ...TIER_COLUMNS.map((c) => ({ title: c.name, key: c.key, align: 'end' as const, defaultHidden: c.defaultHidden, ...PRICE_CELL })),
  // FR-22.48: only when the list can hold deactivated articles. Among active ones it says "yes"
  // on every row, and its width is what keeps the row actions inside 1366 px.
  ...(activeFilter.value === 'active' ? [] : [{ title: t('common.active'), key: 'isActive', align: 'center' as const }]),
  { title: t('common.actions'), key: 'actions', sortable: false, fixed: 'end' as const },
])

function fmtPrice(amount: number, currency?: string) { return formatUnitPrice(amount, currency || baseCurrency.value, localeCode.value) }
function fmtDate(iso: string) { return iso ? new Date(iso).toLocaleDateString(localeCode.value) : '' }
function fmtQty(n: number) { return new Intl.NumberFormat(localeCode.value, { maximumFractionDigits: 3 }).format(n || 0) }
function stockFor(id: string): StockBadge[] { return (stockMap.value[id] || []).filter((s) => (s.quantity || 0) !== 0) }
function supplyFor(id: string): SupplyTotals { return supplyMap.value[id] || NO_SUPPLY }
function stockTab(item: Product) { return { name: 'inventory.products.stock', params: { id: item._id, tab: 'stock' } } }

// After each page loads, badge the visible products' per-warehouse stock — and what is reserved
// and on order (FR-22.45) — in one bulk call. With a warehouse chosen, all of it is that
// warehouse's. A slower answer for an earlier page never overwrites the current one.
let stockRequest = 0
async function fetchStockBadges() {
  const ids = (items.value as Product[]).map((p) => p._id).filter(Boolean)
  const mine = ++stockRequest
  if (!ids.length) { stockMap.value = {}; supplyMap.value = {}; return }
  try {
    const params: Record<string, string> = { productIds: ids.join(',') }
    if (warehouseFilter.value) params.warehouseId = warehouseFilter.value
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/stock-level/by-products`, { params })
    if (mine !== stockRequest) return
    stockMap.value = data.stock || {}
    supplyMap.value = data.supply || {}
  } catch {
    if (mine !== stockRequest) return
    stockMap.value = {}
    supplyMap.value = {}
  }
}
watch(items, fetchStockBadges)

// ── FR-28.6: the Suppliers column ──
function factsOf(id: string): SupplierFact[] { return supplierMap.value[id] || [] }
function suppliersLoaded(id: string): boolean { return id in supplierMap.value }
/** The suppliers beyond the ones named in the cell: the server's count, not just what it sent (five at most). */
function moreSuppliers(id: string): number { return Math.max(0, (supplierCounts.value[id] ?? factsOf(id).length) - SUPPLIERS_SHOWN) }

/**
 * What to order to be back at the maximum (the minimum when there is none): `target − position`, where the
 * position is on hand − reserved + on order, scoped as the list is (the warehouse filter). Only an article at or
 * below its minimum has anything to order, and a service never does. The order dialog of FR-28.16 starts from
 * the same figure (`max(1, target − position)`).
 */
function toOrder(item: Product): number | null {
  const min = Number(item.minStockLevel) || 0
  const max = Number(item.maxStockLevel) || 0
  if (item.trackInventory === false || (!min && !max)) return null
  const onHand = (stockMap.value[item._id] || []).reduce((sum, s) => sum + (s.quantity || 0), 0)
  const supply = supplyFor(item._id)
  const position = onHand - supply.reserved + supply.incoming
  if (min > 0 && position >= min) return null
  const quantity = (max > 0 ? max : min) - position
  return quantity > 0 ? quantity : null
}

// One call per page, like the stock badges; a page of "All" goes in chunks of the API's cap. A slower answer for
// an earlier page never overwrites the current one. A failure leaves the list usable, and the cells say they could
// not be loaded: a dash would say "nobody".
let factsRequest = 0
async function fetchSupplierFacts() {
  if (!seesSuppliers) return
  const ids = (items.value as Product[]).map((p) => p._id).filter(Boolean)
  const mine = ++factsRequest
  supplierFailed.value = false
  supplierMap.value = {}
  supplierCounts.value = {}
  if (!ids.length) return
  try {
    const chunks: string[][] = []
    for (let i = 0; i < ids.length; i += SUPPLIER_CALL_SIZE) chunks.push(ids.slice(i, i + SUPPLIER_CALL_SIZE))
    const answers = await Promise.all(chunks.map((c) => httpClient.get(`${appStore.orgUrl()}/warehouse/product-supplier/by-products`, { params: { productIds: c.join(',') } })))
    if (mine !== factsRequest) return
    const suppliers: Record<string, SupplierFact[]> = {}
    const counts: Record<string, number> = {}
    for (const { data } of answers) {
      Object.assign(suppliers, data.suppliers || {})
      Object.assign(counts, data.counts || {})
    }
    supplierMap.value = suppliers
    supplierCounts.value = counts
  } catch {
    if (mine === factsRequest) supplierFailed.value = true
  }
}
watch(items, fetchSupplierFacts)

// The supplier filter's choices: the first suppliers, then whatever is typed (server-side, so a thousand suppliers
// are never loaded). The ids a pasted URL carries are named one by one, since the search may not return them.
const contactName = (c: any): string => c.companyName || [c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c._id
function addSupplierOptions(rows: any[]) {
  const known = new Map(supplierOptions.value.map((o) => [o._id, o]))
  for (const c of rows) if (c?._id) known.set(c._id, { _id: c._id, name: contactName(c) })
  supplierOptions.value = [...known.values()]
}
let supplierSearchRequest = 0
let supplierSearchTimer: ReturnType<typeof setTimeout> | null = null
async function searchSuppliers(q: string) {
  const mine = ++supplierSearchRequest
  loadingSuppliers.value = true
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/invoicing/contact`, {
      params: { type: 'supplier', size: 20, sortBy: 'companyName', sortOrder: 'asc', ...(q ? { search: q } : {}) },
    })
    if (mine === supplierSearchRequest) addSupplierOptions(data.contacts || [])
  } catch { /* the filter keeps what it has */ } finally {
    if (mine === supplierSearchRequest) loadingSuppliers.value = false
  }
}
watch(supplierSearch, (q) => {
  if (supplierSearchTimer) clearTimeout(supplierSearchTimer)
  supplierSearchTimer = setTimeout(() => searchSuppliers(q || ''), 300)
})
async function nameChosenSuppliers() {
  const missing = supplierFilter.value.filter((id) => !supplierOptions.value.some((o) => o._id === id))
  await Promise.all(missing.map(async (id) => {
    try {
      const { data } = await httpClient.get(`${appStore.orgUrl()}/invoicing/contact/${id}`)
      addSupplierOptions([data.contact])
    } catch { /* an id that is no contact keeps its id as its name */ }
  }))
}

const { actionsFor } = useProductDocActions()
// FR-26.8.7: without `inventory.write` (a Seller) the page reads, and offers no New, Save or Delete.
const writes = writesInventory(sessionViewer())
const exportsCatalog = holdsArea(sessionViewer(), 'catalogExport')

/**
 * A row's menu: the article's two pages, then what it starts (FR-22.47) — each offered only to a
 * role whose Save the form's API takes, never receiving or reserving a service, and selling or
 * reserving a deactivated article disabled with the reason — then Delete, apart.
 */
function rowActions(item: Product): RowAction[] {
  const documents: RowAction[] = actionsFor(item).map((a, i) => ({
    key: a.key,
    label: t(a.labelKey),
    icon: a.icon,
    to: a.to,
    href: a.href,
    divider: i === 0,
    disabled: !!a.disabledKey,
    hint: a.disabledKey ? t(a.disabledKey) : undefined,
  }))
  return [
    { key: 'edit', label: writes ? t('common.edit') : t('common.view'), icon: writes ? 'mdi-pencil' : 'mdi-eye', to: { name: 'inventory.products.edit', params: { id: item._id, tab: 'edit' } } },
    { key: 'stock', label: t('warehouse.tabStock'), icon: 'mdi-chart-box', to: stockTab(item) },
    ...documents,
    ...(writes ? [{ key: 'delete', label: t('common.delete'), icon: 'mdi-delete', color: 'error', divider: true, handler: () => confirmDelete(item) }] : []),
  ]
}

function confirmDelete(item: Product) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() {
  try {
    await httpClient.delete(`${appStore.orgUrl()}/warehouse/product/${selectedId.value}`)
    await fetchItems()
    deleteDialog.value = false
    showSuccess(t('common.deletedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}
function onExport(format: string) { console.log('Export products as', format) }

async function fetchCategories() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/product-category`, { params: { isActive: 'true' } })
    categoryOptions.value = (data.productCategories || []).map((c: { name: string }) => c.name)
  } catch { /* */ }
}

async function fetchWarehouses() {
  try {
    const { data } = await httpClient.get(`${appStore.orgUrl()}/warehouse/warehouse`, { params: { size: 0 } })
    warehouseOptions.value = data.warehouses || []
  } catch { /* */ }
}

onMounted(() => {
  fetchItems(); fetchCategories(); fetchWarehouses()
  if (seesSuppliers) { searchSuppliers(''); nameChosenSuppliers() }
})
</script>

<style scoped>
/*
 * A supplier's name can be as long as a company's: it is cut here (the tooltip has it whole) instead of widening the
 * list or making the row tall. On a laptop the column never grows past its own header, which is what keeps the list
 * inside 1366 px with the tiers hidden (FR-22.23); a wide screen has room for more of the name.
 */
.suppliers-cell {
  max-width: 100px;
}
@media (min-width: 1600px) {
  .suppliers-cell {
    max-width: 220px;
  }
}
</style>
