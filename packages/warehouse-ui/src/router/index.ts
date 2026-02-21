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
  const token = localStorage.getItem('lgr_token')
  if (!token) {
    // Redirect to Portal for login
    const portalUrl = window.location.hostname === 'localhost' ? 'http://localhost:4001' : '/'
    window.location.href = portalUrl
    return
  }
  next()
})
