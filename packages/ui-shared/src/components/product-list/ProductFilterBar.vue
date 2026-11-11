<template>
  <!-- FR-28.22 — the filters of the product list: the Products page and the product dialog show these same two
       rows, so what a user filters by in one is what they filter by in the other. The till's catalog has the
       first row's four (search, category, type, tags): it is active articles only, in one warehouse. -->
  <div class="product-filter-bar">
    <v-row v-if="variant === 'till'">
      <v-col cols="12" md="4">
        <v-text-field ref="searchField" v-model="list.search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" :autofocus="autofocusSearch" data-testid="filter-search" @keydown="$emit('search-keydown', $event)" />
      </v-col>
      <v-col cols="12" md="3">
        <v-select v-model="list.categoryFilter" :label="$t('warehouse.category')" :items="list.categoryOptions" clearable hide-details density="compact" />
      </v-col>
      <v-col cols="12" md="2">
        <v-select v-model="list.typeFilter" :label="$t('common.type')" :items="productTypeItems(['goods', 'service'])" clearable hide-details density="compact" />
      </v-col>
      <v-col cols="12" md="3">
        <TagInput v-model="list.tagFilter" type="product" :org-url="orgUrl" :label="$t('common.filterByTags')" />
      </v-col>
    </v-row>

    <template v-else>
      <v-row>
        <v-col cols="12" md="2">
          <v-text-field ref="searchField" v-model="list.search" prepend-inner-icon="mdi-magnify" :label="$t('common.search')" clearable hide-details density="compact" :autofocus="autofocusSearch" data-testid="filter-search" @keydown="$emit('search-keydown', $event)" />
        </v-col>
        <v-col cols="12" md="2">
          <v-autocomplete
            v-model="list.warehouseFilter"
            :items="list.warehouseOptions"
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
          <v-select v-model="list.categoryFilter" :label="$t('warehouse.category')" :items="list.categoryOptions" clearable hide-details density="compact" />
        </v-col>
        <v-col cols="12" md="2">
          <v-select v-model="list.typeFilter" :label="$t('common.type')" :items="productTypeItems(['goods', 'service'])" clearable hide-details density="compact" />
        </v-col>
        <!-- Less padding on this one column: at 1366 px „Филтриране по тагове" was cut to "…таг…" in Bulgarian, five
             pixels short of its room, and the field is 16 px wider without it (`product-search.spec` asserts it). -->
        <v-col cols="12" md="2" class="px-1">
          <TagInput v-model="list.tagFilter" type="product" :org-url="orgUrl" :label="$t('common.filterByTags')" />
        </v-col>
        <v-col cols="12" md="2">
          <!-- FR-22.48: a deactivated article stays out of the list unless this asks for it. -->
          <v-select v-model="list.activeFilter" :label="$t('common.status')" :items="activeFilterItems" hide-details density="compact" />
        </v-col>
      </v-row>
      <!-- FR-28.3: who we buy it from, and how much of it there is. The quantity is the Stock column's own
           figure; "below minimum" is the Reports rule, and "out of stock" is the range at 0. Supplier facts are
           incoming-document data (FR-28.6): a role that may not read bills is not offered them. -->
      <v-row class="mt-1 align-center" data-testid="stock-filters">
        <v-col v-if="list.seesSuppliers" cols="12" md="3">
          <!-- The list is what the server found for the text typed (`no-filter`: the search also reads tax numbers,
               which a name filter would hide). A chosen supplier is a chip and is not offered again
               (`hide-selected`), so what is listed is only what the typing matches. -->
          <v-autocomplete
            v-model="list.supplierFilter"
            v-model:search="list.supplierSearch"
            :items="list.supplierOptions"
            item-title="name"
            item-value="_id"
            :label="$t('warehouse.supplierFacts.filterSupplier')"
            prepend-inner-icon="mdi-truck-delivery-outline"
            multiple
            chips
            closable-chips
            clearable
            no-filter
            hide-selected
            hide-details
            density="compact"
            :loading="list.loadingSuppliers"
            :disabled="list.noSupplier"
            data-testid="filter-supplier"
            @focus="list.ensureSupplierOptions()"
          />
        </v-col>
        <!-- These three take the width their content needs, and the chips take what is left. A twelfth of the row
             (about 86 px at 1366) cut "Stock from" to "Stoc…", and „Наличност от" the same: a field of 150 px leaves
             its label room in all four languages (`product-search.spec` asserts the label is not cut). -->
        <v-col v-if="list.seesSuppliers" cols="12" md="auto">
          <v-checkbox v-model="list.noSupplier" :label="$t('warehouse.supplierFacts.noSupplier')" hide-details density="compact" data-testid="filter-no-supplier" />
        </v-col>
        <v-col cols="6" md="auto">
          <v-text-field v-model="list.stockMin" :label="$t('warehouse.supplierFacts.stockFrom')" type="number" hide-details density="compact" class="stock-bound" data-testid="filter-stock-min" />
        </v-col>
        <v-col cols="6" md="auto">
          <v-text-field v-model="list.stockMax" :label="$t('warehouse.supplierFacts.stockTo')" type="number" hide-details density="compact" class="stock-bound" data-testid="filter-stock-max" />
        </v-col>
        <v-col cols="12" md class="d-flex align-center flex-wrap ga-2">
          <v-chip
            :variant="list.belowMin ? 'flat' : 'outlined'"
            :color="list.belowMin ? 'primary' : undefined"
            :prepend-icon="list.belowMin ? 'mdi-check' : undefined"
            data-testid="filter-below-min"
            @click="list.belowMin = !list.belowMin"
          >
            {{ $t('warehouse.supplierFacts.belowMinimum') }}
          </v-chip>
          <v-chip
            :variant="list.outOfStockOn ? 'flat' : 'outlined'"
            :color="list.outOfStockOn ? 'primary' : undefined"
            :prepend-icon="list.outOfStockOn ? 'mdi-check' : undefined"
            data-testid="filter-out-of-stock"
            @click="list.toggleOutOfStock()"
          >
            {{ $t('warehouse.supplierFacts.outOfStock') }}
          </v-chip>
          <v-checkbox v-model="list.projected" :label="$t('warehouse.supplierFacts.countOpenOrders')" hide-details density="compact" class="flex-grow-0" data-testid="filter-projected" />
        </v-col>
      </v-row>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import TagInput from '../TagInput.vue'
import { useProductTypes } from '../../composables/useProductTypes'
import type { ProductList } from '../../composables/product-list/useProductList'

defineProps<{
  list: ProductList
  orgUrl: string
  /** `till`: the cash register's catalog has the four filters of the first row. */
  variant?: 'products' | 'till'
  /** A dialog puts the cursor in the search box; the page does not. */
  autofocusSearch?: boolean
}>()

defineEmits<{
  /** The search box's keys: the dialog walks the rows with ↑ ↓ and picks with Enter. */
  'search-keydown': [event: KeyboardEvent]
}>()

const { t } = useI18n()
const searchField = ref<{ focus: () => void } | null>(null)
/** A dialog puts the cursor in the search box when it opens. */
defineExpose({ focusSearch: () => searchField.value?.focus() })
const { productTypeItems } = useProductTypes()

const activeFilterItems = computed(() => [
  { title: t('warehouse.activeFilter.active'), value: 'active' },
  { title: t('warehouse.activeFilter.inactive'), value: 'inactive' },
  { title: t('common.all'), value: 'all' },
])
</script>

<style scoped>
/* The two bounds of the stock range: room for their labels (see the row's comment), and never wider than a phone's column. */
.stock-bound {
  width: 150px;
  max-width: 100%;
}
</style>
