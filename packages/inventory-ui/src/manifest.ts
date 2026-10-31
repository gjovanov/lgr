import type { ModuleManifest } from 'ui-shell/module'

/**
 * FR-24.3: the inventory module as data. Paths are relative to the module (`/inventory`), never to a
 * router's base: the router composes them under the module's shell record (`moduleRoutes`).
 */
export const manifest: ModuleManifest = {
  id: 'inventory',
  base: '/inventory',
  titleKey: 'apps.inventory',
  pendingChanges: true,
  menu: [
  {
    labelKey: 'nav.products',
    icon: 'mdi-package-variant',
    children: [
      { labelKey: 'nav.products', icon: 'mdi-package-variant', to: '/products' },
      { labelKey: 'nav.categories', icon: 'mdi-shape', to: '/categories' },
    ],
  },
  {
    labelKey: 'nav.warehouse',
    icon: 'mdi-warehouse',
    children: [
      { labelKey: 'nav.warehouses', icon: 'mdi-warehouse', to: '/warehouses' },
      { labelKey: 'nav.stockLevels', icon: 'mdi-chart-box', to: '/stock-levels' },
      { labelKey: 'nav.stockMovements', icon: 'mdi-swap-horizontal', to: '/movements' },
      { labelKey: 'nav.inventoryCount', icon: 'mdi-clipboard-check', to: '/inventory-counts' },
      { labelKey: 'nav.inventoryValuation', icon: 'mdi-chart-areaspline', to: '/inventory-valuation' },
      { labelKey: 'nav.openingStock', icon: 'mdi-database-import-outline', to: '/opening-stock' },
    ],
  },
  {
    labelKey: 'nav.priceLists',
    icon: 'mdi-tag-multiple',
    children: [
      { labelKey: 'nav.priceLists', icon: 'mdi-tag-multiple', to: '/price-lists' },
      { labelKey: 'nav.bulkPricing', icon: 'mdi-percent', to: '/bulk-pricing' },
    ],
  },
],
  routes: [
      { path: '', redirect: { name: 'inventory.products' } },

      // ── Products (flat tabbed routes) ──
      { path: 'products', name: 'inventory.products', component: () => import('./views/ProductsView.vue'), meta: { breadcrumb: [{ title: 'Products' }] } },
      { path: 'products/new', redirect: '/products/new/edit' },
      { path: 'products/new/:tab(edit|pricing|settings)', name: 'inventory.products.new', component: () => import('./views/ProductFormView.vue'), meta: { breadcrumb: [{ title: 'Products', to: '/products' }, { title: 'New' }] } },
      { path: 'products/:id', redirect: (to) => ({ path: `/products/${to.params.id}/edit` }) },
      { path: 'products/:id/:tab(edit|pricing|settings)', name: 'inventory.products.edit', component: () => import('./views/ProductFormView.vue'), meta: { breadcrumb: [{ title: 'Products', to: '/products' }, { title: 'Edit' }] } },
      { path: 'products/:id/:tab(stock|ledger|movements|levels)', name: 'inventory.products.stock', component: () => import('./views/ProductStockView.vue'), meta: { breadcrumb: [{ title: 'Products', to: '/products' }, { title: 'Stock' }] } },
      { path: 'opening-stock', name: 'inventory.opening-stock', component: () => import('./views/OpeningStockImportView.vue'), meta: { breadcrumb: [{ title: 'Opening Stock Import' }] } },
      { path: 'categories', name: 'inventory.categories', component: () => import('./views/CategoriesView.vue'), meta: { breadcrumb: [{ title: 'Categories' }] } },
      { path: 'categories/new', name: 'inventory.categories.new', component: () => import('./views/CategoryFormView.vue'), meta: { breadcrumb: [{ title: 'Categories', to: '/categories' }, { title: 'New' }] } },
      { path: 'categories/:id/edit', name: 'inventory.categories.edit', component: () => import('./views/CategoryFormView.vue'), meta: { breadcrumb: [{ title: 'Categories', to: '/categories' }, { title: 'Edit' }] } },

      // ── Warehouses ──
      { path: 'warehouses', name: 'inventory.warehouses', component: () => import('./views/WarehousesView.vue'), meta: { breadcrumb: [{ title: 'Warehouses' }] } },
      { path: 'warehouses/new', name: 'inventory.warehouses.new', component: () => import('./views/WarehouseFormView.vue'), meta: { breadcrumb: [{ title: 'Warehouses', to: '/warehouses' }, { title: 'New' }] } },
      { path: 'warehouses/:id/edit', name: 'inventory.warehouses.edit', component: () => import('./views/WarehouseFormView.vue'), meta: { breadcrumb: [{ title: 'Warehouses', to: '/warehouses' }, { title: 'Edit' }] } },

      // ── Operations ──
      { path: 'movements', name: 'inventory.movements', component: () => import('./views/MovementsView.vue'), meta: { breadcrumb: [{ title: 'Movements' }] } },
      { path: 'movements/new', name: 'inventory.movements.new', component: () => import('./views/MovementFormView.vue'), meta: { breadcrumb: [{ title: 'Movements', to: '/movements' }, { title: 'New' }] } },
      { path: 'movements/:id', name: 'inventory.movements.view', component: () => import('./views/MovementFormView.vue'), meta: { breadcrumb: [{ title: 'Movements', to: '/movements' }, { title: 'View' }] } },
      { path: 'stock-levels', name: 'inventory.stock-levels', component: () => import('./views/StockLevelsView.vue'), meta: { breadcrumb: [{ title: 'Stock Levels' }] } },
      { path: 'inventory-counts', name: 'inventory.inventory-counts', component: () => import('./views/InventoryCountView.vue'), meta: { breadcrumb: [{ title: 'Inventory Counts' }] } },
      { path: 'inventory-counts/new', name: 'inventory.inventory-counts.new', component: () => import('./views/InventoryCountFormView.vue'), meta: { breadcrumb: [{ title: 'Inventory Counts', to: '/inventory-counts' }, { title: 'New' }] } },
      { path: 'inventory-counts/:id/edit', name: 'inventory.inventory-counts.edit', component: () => import('./views/InventoryCountFormView.vue'), meta: { breadcrumb: [{ title: 'Inventory Counts', to: '/inventory-counts' }, { title: 'Edit' }] } },
      { path: 'inventory-valuation', name: 'inventory.valuation', component: () => import('./views/InventoryValuationView.vue'), meta: { breadcrumb: [{ title: 'Inventory Valuation' }] } },

      // ── Pricing ──
      { path: 'price-lists', name: 'inventory.price-lists', component: () => import('./views/PriceListsView.vue'), meta: { breadcrumb: [{ title: 'Price Lists' }] } },
      { path: 'price-lists/new', name: 'inventory.price-lists.new', component: () => import('./views/PriceListFormView.vue'), meta: { breadcrumb: [{ title: 'Price Lists', to: '/price-lists' }, { title: 'New' }] } },
      { path: 'price-lists/:id/edit', name: 'inventory.price-lists.edit', component: () => import('./views/PriceListFormView.vue'), meta: { breadcrumb: [{ title: 'Price Lists', to: '/price-lists' }, { title: 'Edit' }] } },
      { path: 'bulk-pricing', name: 'inventory.bulk-pricing', component: () => import('./views/BulkPriceAdjustmentView.vue'), meta: { breadcrumb: [{ title: 'Bulk Pricing' }] } },
    ],
}
