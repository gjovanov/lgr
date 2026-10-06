import { createRouter, createWebHistory } from 'vue-router'
import { consumeTokenHandoff, portalHref } from 'ui-shared/nav/navigate'
import { hasOrgSession, isPersonOnly } from 'ui-shared/session/session'

const routes = [
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

      // ── External Orders (ORDO) — route paths kept stable across the rename ──
      { path: 'orders', name: 'invoicing.orders', component: () => import('../views/OrdersView.vue'), meta: { breadcrumb: [{ title: 'External Orders' }] } },
      { path: 'orders/new', name: 'invoicing.orders.new', component: () => import('../views/OrderFormView.vue'), meta: { breadcrumb: [{ title: 'External Orders', to: '/orders' }, { title: 'New' }] } },
      { path: 'orders/:id/edit', name: 'invoicing.orders.edit', component: () => import('../views/OrderFormView.vue'), meta: { breadcrumb: [{ title: 'External Orders', to: '/orders' }, { title: 'Edit' }] } },

      // ── Internal Orders (ORDI) ──
      { path: 'internal-orders', name: 'invoicing.internalOrders', component: () => import('../views/InternalOrdersView.vue'), meta: { breadcrumb: [{ title: 'Internal Orders' }] } },
      { path: 'internal-orders/new', name: 'invoicing.internalOrders.new', component: () => import('../views/InternalOrderFormView.vue'), meta: { breadcrumb: [{ title: 'Internal Orders', to: '/internal-orders' }, { title: 'New' }] } },
      { path: 'internal-orders/:id/edit', name: 'invoicing.internalOrders.edit', component: () => import('../views/InternalOrderFormView.vue'), meta: { breadcrumb: [{ title: 'Internal Orders', to: '/internal-orders' }, { title: 'Edit' }] } },

      // ── Reservations (RES) ──
      { path: 'reservations', name: 'invoicing.reservations', component: () => import('../views/ReservationsView.vue'), meta: { breadcrumb: [{ title: 'Reservations' }] } },

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
