import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: '/erp/bom' },
      // ERP routes
      { path: 'erp/bom', name: 'erp.bom', component: () => import('../views/erp/BillOfMaterialsView.vue') },
      { path: 'erp/production-orders', name: 'erp.production-orders', component: () => import('../views/erp/ProductionOrdersView.vue') },
      { path: 'erp/construction-projects', name: 'erp.construction-projects', component: () => import('../views/erp/ConstructionProjectsView.vue') },
      { path: 'erp/pos', name: 'erp.pos', component: () => import('../views/erp/POSView.vue') },
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
