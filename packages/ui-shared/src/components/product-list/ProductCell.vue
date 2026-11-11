<template>
  <!-- FR-28.22 — one cell of the product list, for the Products page and the product dialog alike. The name and
       the row menu are the page's own; everything else is drawn here, once. A code with no break in it
       (E2E-CSP-1793022750769) must not widen the list past 1366 px. -->
  <span v-if="column === 'sku'" style="overflow-wrap: anywhere">{{ item.sku }}</span>

  <template v-else-if="column === 'type'">{{ productTypeLabel(item.type) }}</template>

  <div v-else-if="column === 'stock'" class="d-flex flex-wrap ga-1 py-1">
    <v-chip
      v-for="s in list.stockFor(item._id)"
      :key="s.warehouseId"
      size="x-small"
      :color="s.quantity > 0 ? 'success' : 'error'"
      variant="tonal"
      :title="s.warehouseName"
    >
      {{ s.warehouseName }}: {{ list.fmtQty(s.quantity) }}
    </v-chip>
    <span v-if="!list.stockFor(item._id).length" class="text-disabled text-caption">—</span>
  </div>

  <!--
    FR-22.45 (#203.8, #4.5): held for clients, and ordered from suppliers but not yet here. On the page each figure
    opens the article's stock tab, which lists the reservations and the orders behind it; in a dialog it is a figure
    (a link would take the user off the document they are filling in).
  -->
  <template v-else-if="column === 'reserved'">
    <template v-if="list.supplyFor(item._id).reserved">
      <entity-link
        v-if="linkable"
        :label="list.fmtQty(list.supplyFor(item._id).reserved)"
        :to="stockTab"
        :aria-label="`${$t('warehouse.supply.reserved')}: ${list.fmtQty(list.supplyFor(item._id).reserved)}`"
      />
      <span v-else>{{ list.fmtQty(list.supplyFor(item._id).reserved) }}</span>
    </template>
    <span v-else class="text-disabled">—</span>
  </template>

  <template v-else-if="column === 'onOrder'">
    <template v-if="list.supplyFor(item._id).incoming">
      <entity-link
        v-if="linkable"
        :label="list.fmtQty(list.supplyFor(item._id).incoming)"
        :to="stockTab"
        :aria-label="`${$t('warehouse.supply.onOrder')}: ${list.fmtQty(list.supplyFor(item._id).incoming)}`"
      />
      <span v-else>{{ list.fmtQty(list.supplyFor(item._id).incoming) }}</span>
      <div v-if="list.supplyFor(item._id).reservedIncoming" class="text-caption text-medium-emphasis text-no-wrap">
        {{ $t('warehouse.supply.reservedIncoming') }}: {{ list.fmtQty(list.supplyFor(item._id).reservedIncoming) }}
      </div>
    </template>
    <span v-else class="text-disabled">—</span>
  </template>

  <!--
    FR-28.6: which suppliers the article was bought from — the two most recent, "+N" for the rest, and every
    one with its last purchase in the tooltip. Read from the received bills and the receipts that name a
    supplier, one call per page. A dash is "nobody", never "not loaded yet" (that is an ellipsis).
  -->
  <template v-else-if="column === 'suppliers'">
    <v-icon v-if="list.supplierFailed" size="small" color="warning" :title="$t('warehouse.supplierFacts.loadFailed')" data-testid="product-suppliers-failed">mdi-alert-circle-outline</v-icon>
    <div v-else-if="!list.suppliersLoaded(item._id)" class="text-disabled" data-testid="product-suppliers-loading">…</div>
    <div v-else-if="!list.factsOf(item._id).length" class="suppliers-cell text-disabled" data-testid="product-suppliers">—</div>
    <div v-else data-testid="product-suppliers" class="suppliers-cell">
      <!-- One line per name, cut with an ellipsis: the tooltip has them whole. -->
      <div v-for="f in list.factsOf(item._id).slice(0, 2)" :key="f.supplierId" class="text-truncate">{{ f.supplierName || '—' }}</div>
      <v-chip v-if="list.moreSuppliers(item._id) > 0" size="x-small" variant="tonal">+{{ list.moreSuppliers(item._id) }}</v-chip>
      <v-tooltip activator="parent" location="top" max-width="420">
        <div v-for="f in list.factsOf(item._id)" :key="f.supplierId">
          <strong>{{ f.supplierName || '—' }}</strong>: <template v-if="f.lastPurchasedAt">{{ list.fmtDate(f.lastPurchasedAt) }}</template><template v-else>{{ $t('warehouse.recordedSuppliers.noDocuments') }}</template><template v-if="f.lastUnitPrice !== undefined"> · {{ list.fmtPrice(f.lastUnitPrice, f.currency) }}</template>
        </div>
        <div v-if="list.moreSuppliers(item._id) > list.factsOf(item._id).length - 2" class="text-caption mt-1">
          {{ $t('warehouse.supplierFacts.andMore', { n: list.moreSuppliers(item._id) - (list.factsOf(item._id).length - 2) }) }}
        </div>
      </v-tooltip>
    </div>
  </template>

  <template v-else-if="column === 'lastPurchase'">
    <span v-if="list.factsOf(item._id)[0]?.lastPurchasedAt" class="text-no-wrap">{{ list.fmtDate(list.factsOf(item._id)[0].lastPurchasedAt) }}</span>
    <span v-else class="text-disabled">—</span>
  </template>

  <template v-else-if="column === 'lastCost'">
    <span v-if="list.factsOf(item._id)[0]?.lastUnitPrice !== undefined" class="text-no-wrap" data-cap="products.costs">{{ list.fmtPrice(list.factsOf(item._id)[0].lastUnitPrice!, list.factsOf(item._id)[0].currency) }}</span>
    <span v-else class="text-disabled">—</span>
  </template>

  <template v-else-if="column === 'minStockLevel'">
    <span v-if="item.minStockLevel">{{ list.fmtQty(item.minStockLevel) }}</span>
    <span v-else class="text-disabled">—</span>
  </template>

  <!-- What to order to be back at the maximum (the minimum when there is none): the figure the order dialog of
       FR-28.16 starts from. Only for an article at or below its minimum. -->
  <template v-else-if="column === 'toOrder'">
    <span v-if="list.toOrder(item) !== null" class="font-weight-medium">{{ list.fmtQty(list.toOrder(item)!) }}</span>
    <span v-else class="text-disabled">—</span>
  </template>

  <!-- FR-27.11.D: a gated figure carries what gates it; the column is offered only to a role that holds it. -->
  <template v-else-if="column === 'purchasePrice'"><span data-cap="products.costs">{{ list.fmtPrice(item.purchasePrice) }}</span></template>
  <template v-else-if="column === 'sellingPrice'">{{ list.fmtPrice(item.sellingPrice) }}</template>

  <!-- The price tiers, a column per slot (product-price-columns.ts). An article with no price at a tier's level
       shows a dash, as it shows nothing reserved. -->
  <template v-else-if="tier">
    <span v-if="tierPrice(item.priceTiers, tier.name) === null" class="text-disabled">—</span>
    <template v-else>{{ list.fmtPrice(tierPrice(item.priceTiers, tier.name)!) }}</template>
  </template>

  <v-icon v-else-if="column === 'isActive'" :color="item.isActive !== false ? 'success' : 'grey'">
    {{ item.isActive !== false ? 'mdi-check-circle' : 'mdi-close-circle' }}
  </v-icon>

  <!-- The till's catalog: what the session's warehouse has. A service has no figure. -->
  <template v-else-if="column === 'stockAvailable'">
    <span v-if="item.stockAvailable === null || item.stockAvailable === undefined" class="text-disabled">—</span>
    <span v-else :class="item.stockAvailable <= 0 ? 'text-error' : ''">{{ list.fmtQty(item.stockAvailable) }}</span>
  </template>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import EntityLink from '../EntityLink.vue'
import { useProductTypes } from '../../composables/useProductTypes'
import { TIER_COLUMNS, tierPrice } from '../../composables/product-price-columns'
import type { ProductList } from '../../composables/product-list/useProductList'
import type { ProductRow } from '../../composables/product-list/types'

const props = withDefaults(defineProps<{
  column: string
  item: ProductRow
  list: ProductList
  /** The page's figures open the article's stock tab. A dialog's do not. */
  linkable?: boolean
}>(), { linkable: false })

const { productTypeLabel } = useProductTypes()
const tier = computed(() => TIER_COLUMNS.find((c) => c.key === props.column))
const stockTab = computed(() => ({ name: 'inventory.products.stock', params: { id: props.item._id, tab: 'stock' } }))
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
