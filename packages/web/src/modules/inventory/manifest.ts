import { withPageRules, type ModuleManifest } from 'ui-shell/module'

/**
 * FR-24.3: the inventory module as data. Paths are relative to the module (`/inventory`), never to a
 * router's base: the one SPA's router composes them under the module's shell record.
 */
export const manifest: ModuleManifest = {
  id: 'inventory',
  base: '/inventory',
  titleKey: 'apps.inventory',
  pendingChanges: true,
  // FR-26.8.2: each entry through `canOpenPage`, as the invoicing menu: a Seller sees no price lists.
  menu: withPageRules('/inventory', [
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
]),
  routes: [
      { path: '', redirect: { name: 'inventory.products' } },

      // ── Products (flat tabbed routes) ──
      { path: 'products', name: 'inventory.products', component: () => import('./views/ProductsView.vue') },
      // FR-24.4: redirects by NAME; a path here would name the router's base.
      { path: 'products/new', redirect: { name: 'inventory.products.new', params: { tab: 'edit' } } },
      { path: 'products/new/:tab(edit|pricing|settings)', name: 'inventory.products.new', component: () => import('./views/ProductFormView.vue') },
      { path: 'products/:id', redirect: (to) => ({ name: 'inventory.products.edit', params: { id: to.params.id, tab: 'edit' } }) },
      { path: 'products/:id/:tab(edit|pricing|settings)', name: 'inventory.products.edit', component: () => import('./views/ProductFormView.vue') },
      // FR-28.7: `suppliers` joins the flat tab route — who the article was bought from.
      { path: 'products/:id/:tab(stock|ledger|movements|levels|suppliers)', name: 'inventory.products.stock', component: () => import('./views/ProductStockView.vue') },
      { path: 'opening-stock', name: 'inventory.opening-stock', component: () => import('./views/OpeningStockImportView.vue') },
      { path: 'categories', name: 'inventory.categories', component: () => import('./views/CategoriesView.vue') },
      { path: 'categories/new', name: 'inventory.categories.new', component: () => import('./views/CategoryFormView.vue') },
      { path: 'categories/:id/edit', name: 'inventory.categories.edit', component: () => import('./views/CategoryFormView.vue') },

      // ── Warehouses ──
      { path: 'warehouses', name: 'inventory.warehouses', component: () => import('./views/WarehousesView.vue') },
      { path: 'warehouses/new', name: 'inventory.warehouses.new', component: () => import('./views/WarehouseFormView.vue') },
      { path: 'warehouses/:id/edit', name: 'inventory.warehouses.edit', component: () => import('./views/WarehouseFormView.vue') },

      // ── Operations ──
      { path: 'movements', name: 'inventory.movements', component: () => import('./views/MovementsView.vue') },
      { path: 'movements/new', name: 'inventory.movements.new', component: () => import('./views/MovementFormView.vue') },
      { path: 'movements/:id', name: 'inventory.movements.view', component: () => import('./views/MovementFormView.vue') },
      { path: 'stock-levels', name: 'inventory.stock-levels', component: () => import('./views/StockLevelsView.vue') },
      { path: 'inventory-counts', name: 'inventory.inventory-counts', component: () => import('./views/InventoryCountView.vue') },
      { path: 'inventory-counts/new', name: 'inventory.inventory-counts.new', component: () => import('./views/InventoryCountFormView.vue') },
      { path: 'inventory-counts/:id/edit', name: 'inventory.inventory-counts.edit', component: () => import('./views/InventoryCountFormView.vue') },
      { path: 'inventory-valuation', name: 'inventory.valuation', component: () => import('./views/InventoryValuationView.vue') },

      // ── Pricing ──
      { path: 'price-lists', name: 'inventory.price-lists', component: () => import('./views/PriceListsView.vue') },
      { path: 'price-lists/new', name: 'inventory.price-lists.new', component: () => import('./views/PriceListFormView.vue') },
      { path: 'price-lists/:id/edit', name: 'inventory.price-lists.edit', component: () => import('./views/PriceListFormView.vue') },
      { path: 'bulk-pricing', name: 'inventory.bulk-pricing', component: () => import('./views/BulkPriceAdjustmentView.vue') },
    ],
}
