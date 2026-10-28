import { createRouter, createWebHistory } from 'vue-router'
import { consumeTokenHandoff, signInHref } from 'ui-shared/nav/navigate'
import { hasOrgSession } from 'ui-shared/session/session'
import { pinOffered } from '../composables/useTillPin'

const routes = [
  // FR-20.40: the till's PIN pad, outside the shell: whoever stands at it has no session yet.
  { path: '/pin', name: 'pos.pin', component: () => import('../views/PosPinView.vue') },
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

router.beforeEach(async (to, _from, next) => {
  // Accept a token from URL params ONLY on a local dev origin (FR-14.24) — on any other
  // origin it is stripped and ignored. A full reload follows either way so Pinia
  // re-initializes from the tab's session.
  if (consumeTokenHandoff(to.query)) return

  if (to.name === 'pos.pin') return next()

  // An org session, in THIS tab. Without one: the portal's sign-in (or its org picker, for a person
  // signed in without an org), which brings the tab back to this page afterwards (FR-22.53).
  if (!hasOrgSession()) {
    // At a till paired with an on-prem server, the operator signs in here, with their PIN.
    if (await pinOffered()) return next({ name: 'pos.pin', query: { to: to.fullPath } })
    window.location.href = signInHref(router.options.history.base + to.fullPath)
    return
  }
  next()
})
