import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: { name: 'pos.terminal' } },

      // ── POS ──
      { path: 'terminal', name: 'pos.terminal', component: () => import('../views/PosTerminalView.vue'), meta: { breadcrumb: [{ title: 'Terminal' }] } },
      { path: 'orders', name: 'pos.orders', component: () => import('../views/PosTransactionsView.vue'), meta: { breadcrumb: [{ title: 'Orders' }] } },
      { path: 'orders/:id', name: 'pos.orders.detail', component: () => import('../views/PosTransactionDetailView.vue'), meta: { breadcrumb: [{ title: 'Orders', to: '/orders' }, { title: 'Detail' }] } },
      { path: 'sessions', name: 'pos.sessions', component: () => import('../views/PosSessionsView.vue'), meta: { breadcrumb: [{ title: 'Sessions' }] } },
      { path: 'devices', name: 'pos.devices', component: () => import('../views/PosDevicesView.vue'), meta: { breadcrumb: [{ title: 'Devices' }] } },
      { path: 'devices/new', name: 'pos.devices.new', component: () => import('../views/PosDeviceDetailView.vue'), meta: { breadcrumb: [{ title: 'Devices', to: '/devices' }, { title: 'New' }] } },
      { path: 'devices/:id', name: 'pos.devices.detail', component: () => import('../views/PosDeviceDetailView.vue'), meta: { breadcrumb: [{ title: 'Devices', to: '/devices' }, { title: 'Detail' }] } },
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
