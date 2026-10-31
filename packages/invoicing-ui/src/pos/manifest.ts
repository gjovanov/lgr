import { ref } from 'vue'
import type { ModuleManifest } from 'ui-shell/module'
import { pinOffered } from './composables/useTillPin'

/** FR-20.40: the next operator signs in with a PIN, where the server offers one. Asked once. */
const pinAtTill = ref(false)
let asked = false
function pinShown(): boolean {
  if (!asked) {
    asked = true
    pinOffered().then(v => { pinAtTill.value = v })
  }
  return pinAtTill.value
}

/**
 * FR-24.3: the POS module as data. Served by the invoicing SPA since FR-24 Phase 0, at
 * `/invoicing/pos/*`; the paths here are relative to the module, so the router names them under
 * the module's shell record (`/pos`) and nothing here knows that.
 */
export const manifest: ModuleManifest = {
  id: 'pos',
  base: '/invoicing/pos',
  titleKey: 'apps.pos',
  pendingChanges: true,
  // FR-20.40: the till's PIN pad, outside the shell: whoever stands at it has no session yet.
  outside: [
    { path: 'pin', name: 'pos.pin', component: () => import('./views/PosPinView.vue') },
  ],
  menu: [
    {
      labelKey: 'nav.pos',
      icon: 'mdi-point-of-sale',
      children: [
        { labelKey: 'nav.terminal', icon: 'mdi-point-of-sale', to: '/terminal' },
        { labelKey: 'pos.pin.switchOperator', icon: 'mdi-account-switch', to: '/pin', when: pinShown },
      ],
    },
    {
      labelKey: 'nav.orders',
      icon: 'mdi-receipt',
      children: [
        { labelKey: 'cashRegister.title', icon: 'mdi-receipt', to: '/orders' },
      ],
    },
    {
      labelKey: 'nav.sessions',
      icon: 'mdi-clock-outline',
      children: [
        { labelKey: 'nav.sessions', icon: 'mdi-clock-outline', to: '/sessions' },
      ],
    },
    {
      labelKey: 'nav.configuration',
      icon: 'mdi-cog',
      children: [
        { labelKey: 'nav.devices', icon: 'mdi-printer-pos', to: '/devices' },
      ],
    },
  ],
  routes: [
    { path: '', redirect: { name: 'pos.terminal' } },
    { path: 'terminal', name: 'pos.terminal', component: () => import('./views/PosTerminalView.vue'), meta: { breadcrumb: [{ title: 'Terminal' }] } },
    { path: 'orders', name: 'pos.orders', component: () => import('./views/PosTransactionsView.vue'), meta: { breadcrumb: [{ title: 'Orders' }] } },
    { path: 'orders/:id', name: 'pos.orders.detail', component: () => import('./views/PosTransactionDetailView.vue'), meta: { breadcrumb: [{ title: 'Orders', to: '/orders' }, { title: 'Detail' }] } },
    { path: 'sessions', name: 'pos.sessions', component: () => import('./views/PosSessionsView.vue'), meta: { breadcrumb: [{ title: 'Sessions' }] } },
    { path: 'devices', name: 'pos.devices', component: () => import('./views/PosDevicesView.vue'), meta: { breadcrumb: [{ title: 'Devices' }] } },
    { path: 'devices/new', name: 'pos.devices.new', component: () => import('./views/PosDeviceDetailView.vue'), meta: { breadcrumb: [{ title: 'Devices', to: '/devices' }, { title: 'New' }] } },
    { path: 'devices/:id', name: 'pos.devices.detail', component: () => import('./views/PosDeviceDetailView.vue'), meta: { breadcrumb: [{ title: 'Devices', to: '/devices' }, { title: 'Detail' }] } },
  ],
}
