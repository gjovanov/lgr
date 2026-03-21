import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: { name: 'purchase.orders' } },
      { path: 'orders', name: 'purchase.orders', component: () => import('../views/purchase/PurchaseOrdersView.vue') },
      { path: 'orders/new', name: 'purchase.orders.new', component: () => import('../views/purchase/PurchaseOrderFormView.vue') },
      { path: 'orders/:id/edit', name: 'purchase.orders.edit', component: () => import('../views/purchase/PurchaseOrderFormView.vue') },
      { path: 'agreements', name: 'purchase.agreements', component: () => import('../views/purchase/BlanketOrdersView.vue') },
      { path: 'reorder-rules', name: 'purchase.reorder-rules', component: () => import('../views/purchase/ReorderRulesView.vue') },
    ],
  },
]

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

router.beforeEach((to, _from, next) => {
  const urlToken = to.query.token as string | undefined
  const urlOrg = to.query.org as string | undefined
  if (urlToken) {
    localStorage.setItem('lgr_token', urlToken)
    if (urlOrg) localStorage.setItem('lgr_org', urlOrg)
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
