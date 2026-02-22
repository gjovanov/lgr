import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: '/warehouse/products' },
      // Warehouse routes
      { path: 'warehouse/products', name: 'warehouse.products', component: () => import('../views/warehouse/ProductsView.vue') },
      { path: 'warehouse/products/new', name: 'warehouse.products.new', component: () => import('../views/warehouse/ProductFormView.vue') },
      { path: 'warehouse/products/:id/edit', name: 'warehouse.products.edit', component: () => import('../views/warehouse/ProductFormView.vue') },
      { path: 'warehouse/warehouses', name: 'warehouse.warehouses', component: () => import('../views/warehouse/WarehousesView.vue') },
      { path: 'warehouse/stock-levels', name: 'warehouse.stock-levels', component: () => import('../views/warehouse/StockLevelsView.vue') },
      { path: 'warehouse/movements', name: 'warehouse.movements', component: () => import('../views/warehouse/MovementsView.vue') },
      { path: 'warehouse/inventory-counts', name: 'warehouse.inventory-counts', component: () => import('../views/warehouse/InventoryCountView.vue') },
      { path: 'warehouse/price-lists', name: 'warehouse.price-lists', component: () => import('../views/warehouse/PriceListsView.vue') },
    ],
  },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to, _from, next) => {
  // Accept token from URL params (Portal passes it for cross-origin navigation)
  const urlToken = to.query.token as string | undefined
  const urlOrg = to.query.org as string | undefined
  if (urlToken) {
    localStorage.setItem('lgr_token', urlToken)
    if (urlOrg) localStorage.setItem('lgr_org', urlOrg)
    // Full reload so Pinia store re-initializes with the new localStorage values
    const url = new URL(window.location.href)
    url.searchParams.delete('token')
    url.searchParams.delete('org')
    window.location.replace(url.toString())
    return
  }

  const token = localStorage.getItem('lgr_token')
  if (!token) {
    const portalUrl = window.location.hostname === 'localhost' ? 'http://localhost:4001' : '/'
    window.location.href = portalUrl
    return
  }
  next()
})
