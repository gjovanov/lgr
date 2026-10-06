import { createRouter, createWebHistory } from 'vue-router'
import { consumeTokenHandoff, portalHref } from 'ui-shared/nav/navigate'
import { hasOrgSession, isPersonOnly } from 'ui-shared/session/session'

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
