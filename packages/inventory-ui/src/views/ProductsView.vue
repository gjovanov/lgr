<template>
  <ListScaffold
    :title="$t('nav.products')"
    :headers="headers"
    :items="list.items"
    :loading="list.loading"
    :pagination="list.pagination"
    :has-active-filters="list.hasActiveFilters"
    selectable
    v-model:selected="selection.ticked"
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

    <!-- FR-28.14 / .15: what is ticked, and what to do with it: a supplier order or a customer order from the ticked
         articles, or from "all that match the filter" (which travels as the filter). -->
    <template #bulk-bar>
      <div v-if="selection.offerSelectAll || selection.isMatching || selection.count" class="mb-3" data-testid="selection-bar">
        <v-alert
          v-if="selection.offerSelectAll"
          type="info"
          variant="tonal"
          density="compact"
          class="mb-2"
          data-testid="select-all-banner"
        >
          <div class="d-flex align-center ga-3 flex-wrap">
            <span>{{ $t('productOrders.banner.page', { n: list.items.length }) }}</span>
            <v-btn size="small" variant="text" color="primary" data-testid="select-all-matching" @click="selection.selectAll()">
              {{ $t('productOrders.banner.selectAll', { total: list.pagination.total }) }}
            </v-btn>
          </div>
        </v-alert>
        <v-alert
          v-else-if="selection.isMatching && selection.matchingCurrent"
          type="info"
          variant="tonal"
          density="compact"
          class="mb-2"
          data-testid="all-matching-banner"
        >
          {{ $t('productOrders.banner.all', { total: list.pagination.total }) }}
        </v-alert>
        <div v-if="selection.count" class="d-flex align-center ga-2 flex-wrap">
          <v-chip color="primary" variant="tonal" data-testid="selection-count">
            {{ $t('productOrders.bar.selected', { n: selection.count }) }}
            <span v-if="selection.outside" class="ms-1" data-testid="selection-outside">({{ $t('productOrders.bar.outside', { n: selection.outside }) }})</span>
            <span v-else-if="selection.isMatching && !selection.matchingCurrent" class="ms-1" data-testid="selection-earlier">({{ $t('productOrders.bar.earlierFilter') }})</span>
          </v-chip>
          <template v-if="canCreateOrders">
            <v-tooltip :disabled="!selection.overCap" location="bottom">
              <template #activator="{ props: tip }">
                <span v-bind="tip">
                  <v-btn color="primary" variant="flat" prepend-icon="mdi-truck-delivery-outline" :disabled="selection.overCap" data-testid="create-supplier-order" @click="openOrderDialog('supplier')">
                    {{ $t('productOrders.bar.supplierOrder') }}
                  </v-btn>
                </span>
              </template>
              {{ $t('productOrders.bar.tooMany', { max: selection.max }) }}
            </v-tooltip>
            <v-tooltip :disabled="!selection.overCap" location="bottom">
              <template #activator="{ props: tip }">
                <span v-bind="tip">
                  <v-btn color="primary" variant="outlined" prepend-icon="mdi-account-arrow-left-outline" :disabled="selection.overCap" data-testid="create-customer-order" @click="openOrderDialog('customer')">
                    {{ $t('productOrders.bar.customerOrder') }}
                  </v-btn>
                </span>
              </template>
              {{ $t('productOrders.bar.tooMany', { max: selection.max }) }}
            </v-tooltip>
          </template>
          <v-btn variant="text" data-testid="selection-clear" @click="selection.clear()">{{ $t('productOrders.bar.clear') }}</v-btn>
          <span v-if="selection.overCap" class="text-body-2 text-error" data-testid="selection-too-many">{{ $t('productOrders.bar.tooMany', { max: selection.max }) }}</span>
        </div>
      </div>
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

    <OrderFromProductsDialog
      v-if="canCreateOrders"
      v-model="orderDialog"
      :kind="orderKind"
      :org-url="appStore.orgUrl()"
      :selection="orderSelection"
      :locale="intlLocale()"
      @created="onOrderCreated"
    />

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
import { computed, ref, onMounted, toRef } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { sessionViewer } from 'ui-shared/composables/useStorageIdentity'
import { viewerHoldsArea, writesInventory } from 'ui-shared/nav/page-registry'
import { useAppStore } from '../store/app.store'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { useSnackbar } from 'ui-shared/composables/useSnackbar'
import { useProductList } from 'ui-shared/composables/product-list/useProductList'
import { useProductSelection } from 'ui-shared/composables/product-list/useProductSelection'
import { useAccess } from 'ui-shared/access/useAccess'
import OrderFromProductsDialog from 'ui-shared/components/product-list/OrderFromProductsDialog.vue'
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
const router = useRouter()
const appStore = useAppStore()
const { showSuccess, showError, showSnackbar } = useSnackbar()
const deleteDialog = ref(false)
const selectedId = ref('')

// FR-28.22: the filters, the request and its paging, the three side calls that fill a page's cells (stock and
// supply, supplier facts) and what a cell says are the product list's own (`useProductList`), shared with the
// product dialog. This page keeps what is its own: the URL (FR-05), the row menu, delete and export.
const intlLocale = () => ({ en: 'en-US', mk: 'mk-MK', de: 'de-DE', bg: 'bg-BG' }[appStore.locale as string] || 'en-US')
const list = useProductList({
  orgUrl: () => appStore.orgUrl(),
  baseCurrency: () => appStore.currentOrg?.baseCurrency || 'EUR',
  locale: intlLocale,
  urlSync: true,
})

// FR-28.13 / .14: the ticked articles — ids, across pages, sorts, columns and filter changes — and "all that match the
// filter", which travels as the filter. Not in the URL. The two order dialogs start from it (FR-28.19); a created order
// clears it, and closing a dialog keeps it. The buttons are for a role that may create an order (FR-28.15).
const selection = useProductSelection(list, () => appStore.orgUrl())
const canCreateOrders = useAccess().can('orders.create')
const orderDialog = ref(false)
const orderKind = ref<'supplier' | 'customer'>('supplier')
const orderSelection = ref<{ productIds?: string[]; filter?: Record<string, string>; warehouseId?: string }>({})
function openOrderDialog(kind: 'supplier' | 'customer') {
  // The selection as it is NOW: the dialog works on this, whatever the list does behind it.
  orderSelection.value = selection.body()
  orderKind.value = kind
  orderDialog.value = true
}
function onOrderCreated(result: { kind: 'supplier' | 'customer'; order: { _id: string }; skipped: unknown[] }) {
  selection.clear()
  if (result.skipped.length) showSnackbar(t('productOrders.dialog.skipped', { n: result.skipped.length }), 'warning')
  // FR-22.35: the new draft opens; its number does not live only in a snackbar.
  void router.push(result.kind === 'supplier' ? '/invoicing/orders/' + result.order._id + '/edit' : '/invoicing/internal-orders/' + result.order._id + '/edit')
}

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
// FR-26.8.7 / FR-27.5: `products.export` on a role, live; the token's `catalogExport` area otherwise.
const exportsCatalog = computed(() => viewerHoldsArea(sessionViewer(), 'catalogExport'))

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
