import { createRouter, createWebHistory } from 'vue-router'
import { consumeTokenHandoff, signInHref } from 'ui-shared/nav/navigate'
import { hasOrgSession } from 'ui-shared/session/session'
import { pinOffered } from '../pos/composables/useTillPin'

/**
 * FR-24 Phase 0: the POS app's pages, moved here from pos-ui. One document serves both apps, so
 * moving between the till and invoicing is a router push and the tab's Web Serial port (the
 * printer) stays open. The route NAMES are unchanged (`pos.*`): Playwright and `useGridColumns`
 * key on them. The old `/pos/*` URLs answer 302 to `/invoicing/pos/*` from the server, because
 * desktops hold `startPath: /pos/` (FR-14.16).
 */
const posRoutes = [
  // FR-20.40: the till's PIN pad, outside the shell: whoever stands at it has no session yet.
  { path: '/pos/pin', name: 'pos.pin', component: () => import('../pos/views/PosPinView.vue') },
  {
    path: '/pos',
    component: () => import('../pos/PosLayout.vue'),
    children: [
      { path: '', redirect: { name: 'pos.terminal' } },
      { path: 'terminal', name: 'pos.terminal', component: () => import('../pos/views/PosTerminalView.vue'), meta: { breadcrumb: [{ title: 'Terminal' }] } },
      { path: 'orders', name: 'pos.orders', component: () => import('../pos/views/PosTransactionsView.vue'), meta: { breadcrumb: [{ title: 'Orders' }] } },
      { path: 'orders/:id', name: 'pos.orders.detail', component: () => import('../pos/views/PosTransactionDetailView.vue'), meta: { breadcrumb: [{ title: 'Orders', to: '/pos/orders' }, { title: 'Detail' }] } },
      { path: 'sessions', name: 'pos.sessions', component: () => import('../pos/views/PosSessionsView.vue'), meta: { breadcrumb: [{ title: 'Sessions' }] } },
      { path: 'devices', name: 'pos.devices', component: () => import('../pos/views/PosDevicesView.vue'), meta: { breadcrumb: [{ title: 'Devices' }] } },
      { path: 'devices/new', name: 'pos.devices.new', component: () => import('../pos/views/PosDeviceDetailView.vue'), meta: { breadcrumb: [{ title: 'Devices', to: '/pos/devices' }, { title: 'New' }] } },
      { path: 'devices/:id', name: 'pos.devices.detail', component: () => import('../pos/views/PosDeviceDetailView.vue'), meta: { breadcrumb: [{ title: 'Devices', to: '/pos/devices' }, { title: 'Detail' }] } },
    ],
  },
]

const routes = [
  ...posRoutes,
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: { name: 'invoicing.sales' } },

      // ── Contacts ──
      { path: 'contacts', name: 'invoicing.contacts', component: () => import('../views/ContactsView.vue'), meta: { breadcrumb: [{ title: 'Contacts' }] } },
      { path: 'contacts/new', name: 'invoicing.contacts.new', component: () => import('../views/ContactFormView.vue'), meta: { breadcrumb: [{ title: 'Contacts', to: '/contacts' }, { title: 'New' }] } },
      { path: 'contacts/:id/edit', name: 'invoicing.contacts.edit', component: () => import('../views/ContactFormView.vue'), meta: { breadcrumb: [{ title: 'Contacts', to: '/contacts' }, { title: 'Edit' }] } },
      { path: 'contacts/:id/ledger', name: 'invoicing.contacts.ledger', component: () => import('../views/ContactLedgerView.vue'), meta: { breadcrumb: [{ title: 'Contacts', to: '/contacts' }, { title: 'Ledger' }] } },

      // ── Invoices (Sales) ──
      { path: 'invoices', name: 'invoicing.sales', component: () => import('../views/SalesInvoicesView.vue'), meta: { breadcrumb: [{ title: 'Invoices' }] } },
      { path: 'invoices/new', name: 'invoicing.sales.new', component: () => import('../views/InvoiceFormView.vue'), meta: { breadcrumb: [{ title: 'Invoices', to: '/invoices' }, { title: 'New' }] } },
      { path: 'invoices/:id/edit', name: 'invoicing.sales.edit', component: () => import('../views/InvoiceFormView.vue'), meta: { breadcrumb: [{ title: 'Invoices', to: '/invoices' }, { title: 'Edit' }] } },

      // ── Purchase Invoices (Bills) ──
      { path: 'bills', name: 'invoicing.purchases', component: () => import('../views/PurchaseInvoicesView.vue'), meta: { breadcrumb: [{ title: 'Purchase Invoices' }] } },
      // The standalone batch-import page moved onto the list itself (the Import button).
      // Kept as a redirect so bookmarks and the old nav link still land somewhere useful.
      { path: 'bills/import', redirect: { name: 'invoicing.purchases' } },
      { path: 'bills/new', name: 'invoicing.purchases.new', component: () => import('../views/PurchaseInvoiceFormView.vue'), meta: { breadcrumb: [{ title: 'Purchase Invoices', to: '/bills' }, { title: 'New' }] } },
      { path: 'bills/:id/edit', name: 'invoicing.purchases.edit', component: () => import('../views/PurchaseInvoiceFormView.vue'), meta: { breadcrumb: [{ title: 'Purchase Invoices', to: '/bills' }, { title: 'Edit' }] } },

      // ── Outgoing Orders (ORDO; "external" until #203) — route paths and names kept stable ──
      { path: 'orders', name: 'invoicing.orders', component: () => import('../views/OrdersView.vue'), meta: { breadcrumb: [{ title: 'Outgoing Orders' }] } },
      { path: 'orders/new', name: 'invoicing.orders.new', component: () => import('../views/OrderFormView.vue'), meta: { breadcrumb: [{ title: 'Outgoing Orders', to: '/orders' }, { title: 'New' }] } },
      { path: 'orders/:id/edit', name: 'invoicing.orders.edit', component: () => import('../views/OrderFormView.vue'), meta: { breadcrumb: [{ title: 'Outgoing Orders', to: '/orders' }, { title: 'Edit' }] } },

      // ── Incoming Orders (ORDI; "internal" until #203) ──
      { path: 'internal-orders', name: 'invoicing.internalOrders', component: () => import('../views/InternalOrdersView.vue'), meta: { breadcrumb: [{ title: 'Incoming Orders' }] } },
      { path: 'internal-orders/new', name: 'invoicing.internalOrders.new', component: () => import('../views/InternalOrderFormView.vue'), meta: { breadcrumb: [{ title: 'Incoming Orders', to: '/internal-orders' }, { title: 'New' }] } },
      { path: 'internal-orders/:id/edit', name: 'invoicing.internalOrders.edit', component: () => import('../views/InternalOrderFormView.vue'), meta: { breadcrumb: [{ title: 'Incoming Orders', to: '/internal-orders' }, { title: 'Edit' }] } },

      // ── Reservations (RES) ──
      { path: 'reservations', name: 'invoicing.reservations', component: () => import('../views/ReservationsView.vue'), meta: { breadcrumb: [{ title: 'Reservations' }] } },
      // FR-22.37: a new reservation is made in a dialog ON the list. This path („+ Нов", ★) opens
      // it there: a redirect, so the grid keeps its own route name — the key of its column
      // preferences and of its remembered filters. `?productId=` comes along to pre-fill it.
      { path: 'reservations/new', name: 'invoicing.reservations.new', redirect: (to) => ({ name: 'invoicing.reservations', query: { ...to.query, new: '1' } }) },
      { path: 'reservations/:id', name: 'invoicing.reservations.detail', component: () => import('../views/ReservationDetailView.vue'), meta: { breadcrumb: [{ title: 'Reservations', to: '/reservations' }, { title: 'Reservation' }] } },

      // ── Proforma ──
      { path: 'proforma', name: 'invoicing.proforma', component: () => import('../views/ProformaInvoicesView.vue'), meta: { breadcrumb: [{ title: 'Proforma' }] } },
      { path: 'proforma/new', name: 'invoicing.proforma.new', component: () => import('../views/ProformaInvoiceFormView.vue'), meta: { breadcrumb: [{ title: 'Proforma', to: '/proforma' }, { title: 'New' }] } },
      { path: 'proforma/:id/edit', name: 'invoicing.proforma.edit', component: () => import('../views/ProformaInvoiceFormView.vue'), meta: { breadcrumb: [{ title: 'Proforma', to: '/proforma' }, { title: 'Edit' }] } },

      // ── Credit / Debit Notes (FR-01: merged into the sales grid + form) ──
      // Named redirects: old links, ★ favorites and router.push({ name }) callers keep working.
      { path: 'credit-notes', name: 'invoicing.credit-notes', redirect: { name: 'invoicing.sales', query: { type: 'credit_note' } } },
      { path: 'credit-notes/new', name: 'invoicing.credit-notes.new', redirect: { name: 'invoicing.sales.new', query: { type: 'credit_note' } } },
      { path: 'credit-notes/:id/edit', name: 'invoicing.credit-notes.edit', redirect: (to) => ({ name: 'invoicing.sales.edit', params: { id: to.params.id } }) },
      { path: 'debit-notes', name: 'invoicing.debit-notes', redirect: { name: 'invoicing.sales', query: { type: 'debit_note' } } },
      { path: 'debit-notes/new', name: 'invoicing.debit-notes.new', redirect: { name: 'invoicing.sales.new', query: { type: 'debit_note' } } },
      { path: 'debit-notes/:id/edit', name: 'invoicing.debit-notes.edit', redirect: (to) => ({ name: 'invoicing.sales.edit', params: { id: to.params.id } }) },

      // ── Cash Sales ──
      { path: 'cash-sales', name: 'invoicing.cash-sales', component: () => import('../views/CashSalesView.vue'), meta: { breadcrumb: [{ title: 'Cash Sales' }] } },
      { path: 'cash-sales/new', name: 'invoicing.cash-sales.new', component: () => import('../views/CashSaleFormView.vue'), meta: { breadcrumb: [{ title: 'Cash Sales', to: '/cash-sales' }, { title: 'New' }] } },
      { path: 'cash-sales/:id/edit', name: 'invoicing.cash-sales.edit', component: () => import('../views/CashSaleFormView.vue'), meta: { breadcrumb: [{ title: 'Cash Sales', to: '/cash-sales' }, { title: 'Edit' }] } },
      // FR-21.13: a till sale the journal lists that is not a document yet (until R2 copies it).
      { path: 'cash-sales/:id/view', name: 'invoicing.cash-sales.view', component: () => import('../views/CashSaleJournalDocumentView.vue'), meta: { breadcrumb: [{ title: 'Cash Sales', to: '/cash-sales' }, { title: 'Detail' }] } },

      // ── Payments ──
      { path: 'payment-orders', name: 'invoicing.payment-orders', component: () => import('../views/PaymentOrdersView.vue'), meta: { breadcrumb: [{ title: 'Payment Orders' }] } },
      { path: 'cash-orders', name: 'invoicing.cash-orders', component: () => import('../views/CashOrdersView.vue'), meta: { breadcrumb: [{ title: 'Cash Orders' }] } },
      // ── Moved to the Reports app (FR-06 #14) ──
      // Both pages now live at /reports/*. These stubs keep the OLD ROUTE NAMES alive (the
      // repo-wide constraint: Playwright navigates by name and useGridColumns keys column
      // prefs by route name) and forward the query string, so old bookmarks carrying grid
      // state land on the moved page with that state intact. A router `redirect` cannot be
      // used — /reports is a separate SPA.
      { path: 'aging-report', name: 'invoicing.aging-report', component: () => import('../views/MovedToReportsView.vue'), props: { to: '/aging' }, meta: { breadcrumb: [{ title: 'Aging Report' }] } },
      { path: 'reporting/export', name: 'invoicing.reporting.export', component: () => import('../views/MovedToReportsView.vue'), props: { to: '/export' }, meta: { breadcrumb: [{ title: 'Reporting' }, { title: 'Export' }] } },

      // ── Configuration ──
      { path: 'configuration/sequences', name: 'invoicing.configuration.sequences', component: () => import('../views/SequencesConfigView.vue'), meta: { breadcrumb: [{ title: 'Configuration' }, { title: 'Sequences' }] } },
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
    // At a till paired with an on-prem server, the operator signs in on the POS pages with a PIN.
    const isPos = to.matched.some(r => r.path === '/pos')
    if (isPos && (await pinOffered())) return next({ name: 'pos.pin', query: { to: to.fullPath } })
    window.location.href = signInHref(router.options.history.base + to.fullPath)
    return
  }
  next()
})
