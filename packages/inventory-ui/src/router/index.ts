import { createRouter, createWebHistory } from 'vue-router'
import { consumeTokenHandoff, portalHref } from 'ui-shared/nav/navigate'
import { hasOrgSession, isPersonOnly } from 'ui-shared/session/session'

const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: { name: 'inventory.products' } },

      // ── Products (flat tabbed routes) ──
      { path: 'products', name: 'inventory.products', component: () => import('../views/ProductsView.vue'), meta: { breadcrumb: [{ title: 'Products' }] } },
      { path: 'products/new', redirect: '/products/new/edit' },
      { path: 'products/new/:tab(edit|pricing|settings)', name: 'inventory.products.new', component: () => import('../views/ProductFormView.vue'), meta: { breadcrumb: [{ title: 'Products', to: '/products' }, { title: 'New' }] } },
      { path: 'products/:id', redirect: (to) => ({ path: `/products/${to.params.id}/edit` }) },
      { path: 'products/:id/:tab(edit|pricing|settings)', name: 'inventory.products.edit', component: () => import('../views/ProductFormView.vue'), meta: { breadcrumb: [{ title: 'Products', to: '/products' }, { title: 'Edit' }] } },
      { path: 'products/:id/:tab(stock|ledger|movements|levels)', name: 'inventory.products.stock', component: () => import('../views/ProductStockView.vue'), meta: { breadcrumb: [{ title: 'Products', to: '/products' }, { title: 'Stock' }] } },
      { path: 'opening-stock', name: 'inventory.opening-stock', component: () => import('../views/OpeningStockImportView.vue'), meta: { breadcrumb: [{ title: 'Opening Stock Import' }] } },
      { path: 'categories', name: 'inventory.categories', component: () => import('../views/CategoriesView.vue'), meta: { breadcrumb: [{ title: 'Categories' }] } },
      { path: 'categories/new', name: 'inventory.categories.new', component: () => import('../views/CategoryFormView.vue'), meta: { breadcrumb: [{ title: 'Categories', to: '/categories' }, { title: 'New' }] } },
      { path: 'categories/:id/edit', name: 'inventory.categories.edit', component: () => import('../views/CategoryFormView.vue'), meta: { breadcrumb: [{ title: 'Categories', to: '/categories' }, { title: 'Edit' }] } },

      // ── Warehouses ──
      { path: 'warehouses', name: 'inventory.warehouses', component: () => import('../views/WarehousesView.vue'), meta: { breadcrumb: [{ title: 'Warehouses' }] } },
      { path: 'warehouses/new', name: 'inventory.warehouses.new', component: () => import('../views/WarehouseFormView.vue'), meta: { breadcrumb: [{ title: 'Warehouses', to: '/warehouses' }, { title: 'New' }] } },
      { path: 'warehouses/:id/edit', name: 'inventory.warehouses.edit', component: () => import('../views/WarehouseFormView.vue'), meta: { breadcrumb: [{ title: 'Warehouses', to: '/warehouses' }, { title: 'Edit' }] } },

      // ── Operations ──
      { path: 'movements', name: 'inventory.movements', component: () => import('../views/MovementsView.vue'), meta: { breadcrumb: [{ title: 'Movements' }] } },
      { path: 'movements/new', name: 'inventory.movements.new', component: () => import('../views/MovementFormView.vue'), meta: { breadcrumb: [{ title: 'Movements', to: '/movements' }, { title: 'New' }] } },
      { path: 'movements/:id', name: 'inventory.movements.view', component: () => import('../views/MovementFormView.vue'), meta: { breadcrumb: [{ title: 'Movements', to: '/movements' }, { title: 'View' }] } },
      { path: 'stock-levels', name: 'inventory.stock-levels', component: () => import('../views/StockLevelsView.vue'), meta: { breadcrumb: [{ title: 'Stock Levels' }] } },
      { path: 'inventory-counts', name: 'inventory.inventory-counts', component: () => import('../views/InventoryCountView.vue'), meta: { breadcrumb: [{ title: 'Inventory Counts' }] } },
      { path: 'inventory-counts/new', name: 'inventory.inventory-counts.new', component: () => import('../views/InventoryCountFormView.vue'), meta: { breadcrumb: [{ title: 'Inventory Counts', to: '/inventory-counts' }, { title: 'New' }] } },
      { path: 'inventory-counts/:id/edit', name: 'inventory.inventory-counts.edit', component: () => import('../views/InventoryCountFormView.vue'), meta: { breadcrumb: [{ title: 'Inventory Counts', to: '/inventory-counts' }, { title: 'Edit' }] } },
      { path: 'inventory-valuation', name: 'inventory.valuation', component: () => import('../views/InventoryValuationView.vue'), meta: { breadcrumb: [{ title: 'Inventory Valuation' }] } },

      // ── Pricing ──
      { path: 'price-lists', name: 'inventory.price-lists', component: () => import('../views/PriceListsView.vue'), meta: { breadcrumb: [{ title: 'Price Lists' }] } },
      { path: 'price-lists/new', name: 'inventory.price-lists.new', component: () => import('../views/PriceListFormView.vue'), meta: { breadcrumb: [{ title: 'Price Lists', to: '/price-lists' }, { title: 'New' }] } },
      { path: 'price-lists/:id/edit', name: 'inventory.price-lists.edit', component: () => import('../views/PriceListFormView.vue'), meta: { breadcrumb: [{ title: 'Price Lists', to: '/price-lists' }, { title: 'Edit' }] } },
      { path: 'bulk-pricing', name: 'inventory.bulk-pricing', component: () => import('../views/BulkPriceAdjustmentView.vue'), meta: { breadcrumb: [{ title: 'Bulk Pricing' }] } },
    ],
  },
]

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  // FR-05 (#12): Back/Forward restore the saved scroll offset; fresh navigations start at top.
  scrollBehavior(_to, _from, savedPosition) {
    return savedPosition || { top: 0 }
  },
  routes,
})

router.beforeEach((to, _from, next) => {
  // Accept a token from URL params ONLY on a local dev origin (FR-14.24) — on any other
  // origin it is stripped and ignored. A full reload follows either way so Pinia
  // re-initializes from the tab's session.
  if (consumeTokenHandoff(to.query)) return

  // An org session, in THIS tab. A person signed in without one yet picks an org on the portal.
  if (!hasOrgSession()) {
    window.location.href = portalHref(isPersonOnly() ? '/orgs' : '/')
    return
  }
  next()
})
