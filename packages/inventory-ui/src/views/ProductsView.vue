<template>
  <ListScaffold
    :title="$t('nav.products')"
    :headers="headers"
    :items="list.items"
    :loading="list.loading"
    :pagination="list.pagination"
    :has-active-filters="list.hasActiveFilters"
    :empty="{ icon: 'mdi-package-variant-closed', title: $t('list.empty.products'), description: $t('list.empty.productsHint') }"
    :empty-filtered="{ title: $t('list.noMatches'), description: $t('list.adjustFilters') }"
    @update:options="list.onUpdateOptions"
  >
    <template #actions>
      <!-- FR-26.8.7: the Export menu only for a session with the catalog's export area. -->
      <export-menu v-if="exportsCatalog" @export="onExport" />
      <responsive-btn v-if="writes" color="primary" icon="mdi-plus" :to="{ name: 'inventory.products.new', params: { tab: 'edit' } }">{{ $t('common.create') }}</responsive-btn>
    </template>

    <!-- FR-28.22: the filters are the product list's own (`ProductFilterBar`), the same two rows the product dialog shows. -->
    <template #filters>
      <v-card class="mb-4">
        <v-card-text class="pb-4">
          <ProductFilterBar :list="list" :org-url="appStore.orgUrl()" />
        </v-card-text>
      </v-card>
    </template>

    <template #item.name="{ item }">
      <entity-link :label="item.name" :to="{ name: 'inventory.products.edit', params: { id: item._id, tab: 'edit' } }" />
    </template>
    <!-- Every other cell is the product list's own (`ProductCell`): the dialog draws the same ones. The page's
         figures for what is reserved and on order open the article's stock tab (`linkable`). -->
    <template v-for="key in PRODUCT_CELL_KEYS" #[`item.${key}`]="{ item }">
      <ProductCell :column="key" :item="item" :list="list" linkable />
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
import { ref, onMounted, toRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { holdsArea } from 'config/constants'
import { sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import { writesInventory } from 'ui-shared/nav/page-registry'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useProductList } from 'ui-shared/composables/product-list/useProductList'
import { useProductColumns, PRODUCT_CELL_KEYS } from 'ui-shared/composables/product-list/useProductColumns'
import type { ProductRow } from 'ui-shared/composables/product-list/types'
import ProductFilterBar from 'ui-shared/components/product-list/ProductFilterBar.vue'
import ProductCell from 'ui-shared/components/product-list/ProductCell.vue'
import ListScaffold from 'ui-shared/components/ListScaffold'
import ExportMenu from 'ui-shared/components/ExportMenu'
import ResponsiveBtn from 'ui-shared/components/ResponsiveBtn'
import EntityLink from 'ui-shared/components/EntityLink'
import RowActionsMenu, { type RowAction } from 'ui-shared/components/RowActionsMenu.vue'
import { useProductDocActions } from '../composables/useProductDocActions'

const { t } = useI18n()
const appStore = useAppStore()
const { showSuccess, showError } = useSnackbar()
const deleteDialog = ref(false)
const selectedId = ref('')

// FR-28.22: the filters, the request and its paging, the three side calls that fill a page's cells (stock and
// supply, supplier facts) and what a cell says are the product list's own (`useProductList`), shared with the
// product dialog. This page keeps what is its own: the URL (FR-05), the row menu, delete and export.
const list = useProductList({
  orgUrl: () => appStore.orgUrl(),
  baseCurrency: () => appStore.currentOrg?.baseCurrency || 'EUR',
  locale: () => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale as string] || 'en-US'),
  urlSync: true,
})

// FR-22.46 (#4.1): stock before unit, and what is reserved and on order right after the stock.
// A user who reordered the columns keeps their order; the two new ones join it after „Наличност"
// (useGridColumns). The three stock columns sort by the figure the cell shows, over every filtered article
// (the server computes them, `product-stock-sort.ts`); a dash goes last either way. With the price tiers
// shown the list is wider than a 1366 px screen, so the name and the row menu stay put while the prices scroll
// sideways (`fixed`). The columns themselves are `useProductColumns`, which the dialog uses too.
const { headers } = useProductColumns({ seesSuppliers: list.seesSuppliers, activeFilter: toRef(list, 'activeFilter') })

const { actionsFor } = useProductDocActions()
// FR-26.8.7: without `inventory.write` (a Seller) the page reads, and offers no New, Save or Delete.
const writes = writesInventory(sessionViewer())
const exportsCatalog = holdsArea(sessionViewer(), 'catalogExport')

function stockTab(item: ProductRow) { return { name: 'inventory.products.stock', params: { id: item._id, tab: 'stock' } } }

/**
 * A row's menu: the article's two pages, then what it starts (FR-22.47) — each offered only to a
 * role whose Save the form's API takes, never receiving or reserving a service, and selling or
 * reserving a deactivated article disabled with the reason — then Delete, apart.
 */
function rowActions(item: ProductRow): RowAction[] {
  const documents: RowAction[] = actionsFor(item as any).map((a, i) => ({
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

function confirmDelete(item: ProductRow) { selectedId.value = item._id; deleteDialog.value = true }
async function doDelete() {
  try {
    await httpClient.delete(`${appStore.orgUrl()}/warehouse/product/${selectedId.value}`)
    await list.fetchItems()
    deleteDialog.value = false
    showSuccess(t('common.deletedSuccessfully'))
  } catch (e: any) {
    showError(e?.response?.data?.message || t('common.operationFailed'))
  }
}
function onExport(format: string) { console.log('Export products as', format) }

onMounted(() => list.start())
</script>
