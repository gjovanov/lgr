import type { ModuleManifest } from 'ui-shell/module'
import { pinShown, withTillRules } from './pos/till-rules'

/**
 * FR-24.3: the invoicing module as data. Paths are relative to the module (`/invoicing`), never to a
 * router's base: the one SPA's router composes them under the module's shell record.
 *
 * The till is part of it (goran, 2026-10-31): its sources stay in `src/pos/`, its routes are here.
 * `meta.till` marks the till's pages, the ones a PIN signs in to and all a till-only session sees
 * (`pos/till-rules.ts`). They keep their `pos.*` names: a pending change and a saved grid preference
 * name them.
 */
export const manifest: ModuleManifest = {
  id: 'invoicing',
  base: '/invoicing',
  titleKey: 'apps.invoicing',
  pendingChanges: true,
  // FR-20.40: the till's PIN pad, outside the shell: whoever stands at it has no session yet.
  outside: [
    { path: 'pin', name: 'pos.pin', component: () => import('./pos/views/PosPinView.vue'), meta: { till: true } },
  ],
  menu: withTillRules([
  {
    labelKey: 'nav.outgoingDocs',
    icon: 'mdi-file-export-outline',
    children: [
      // FR-01: invoices + credit/debit notes live in one merged grid.
      { labelKey: 'nav.salesDocs', icon: 'mdi-receipt-text-outline', to: '/invoices' },
      { labelKey: 'nav.proforma', icon: 'mdi-file-document-outline', to: '/proforma' },
      // FR-03: cash sales are outgoing documents too — the Cash Register group is gone, and the till
      // lives here since POS stopped being an app of its own.
      { labelKey: '', divider: true },
      { labelKey: 'nav.csTerminal', icon: 'mdi-point-of-sale', to: '/cash-sales/new' },
      { labelKey: 'nav.crSales', icon: 'mdi-cash-register', to: '/cash-sales' },
      { labelKey: 'nav.crSessions', icon: 'mdi-clock-outline', to: '/cash-register/sessions' },
      { labelKey: 'pos.pin.switchOperator', icon: 'mdi-account-switch', to: '/pin', when: pinShown },
    ],
  },
  {
    labelKey: 'nav.orders',
    icon: 'mdi-clipboard-list-outline',
    children: [
      { labelKey: 'nav.internalOrders', subtitleKey: 'nav.internalOrdersHint', icon: 'mdi-account-clock-outline', to: '/internal-orders' },
      { labelKey: 'nav.externalOrders', subtitleKey: 'nav.externalOrdersHint', icon: 'mdi-clipboard-list-outline', to: '/orders' },
      { labelKey: 'nav.reservations', icon: 'mdi-lock-clock', to: '/reservations' },
    ],
  },
  {
    labelKey: 'nav.incomingDocs',
    icon: 'mdi-file-import-outline',
    children: [
      { labelKey: 'nav.purchaseDocs', icon: 'mdi-receipt-text', to: '/bills' },
    ],
  },
  {
    labelKey: 'nav.payments',
    icon: 'mdi-bank-transfer',
    children: [
      { labelKey: 'nav.paymentOrders', icon: 'mdi-bank-transfer', to: '/payment-orders' },
      { labelKey: 'nav.cashOrders', icon: 'mdi-cash', to: '/cash-orders' },
    ],
  },
  // FR-06 (#14): the "Reporting" group held exactly these two items, and both moved to the
  // Reports app — so the group is gone. The App Hub tile (and the app switcher) replaces it.
  {
    labelKey: 'nav.configuration',
    icon: 'mdi-cog-outline',
    children: [
      { labelKey: 'nav.contacts', icon: 'mdi-contacts', to: '/contacts' },
      { labelKey: 'nav.sequences', icon: 'mdi-numeric', to: '/configuration/sequences' },
      { labelKey: 'nav.devices', icon: 'mdi-printer-pos', to: '/configuration/devices' },
    ],
  },
]),
  routes: [
      { path: '', redirect: { name: 'invoicing.sales' } },

      // ── Contacts ──
      { path: 'contacts', name: 'invoicing.contacts', component: () => import('./views/ContactsView.vue'), meta: { breadcrumb: [{ title: 'Contacts' }] } },
      { path: 'contacts/new', name: 'invoicing.contacts.new', component: () => import('./views/ContactFormView.vue'), meta: { breadcrumb: [{ title: 'Contacts', to: '/contacts' }, { title: 'New' }] } },
      { path: 'contacts/:id/edit', name: 'invoicing.contacts.edit', component: () => import('./views/ContactFormView.vue'), meta: { breadcrumb: [{ title: 'Contacts', to: '/contacts' }, { title: 'Edit' }] } },
      { path: 'contacts/:id/ledger', name: 'invoicing.contacts.ledger', component: () => import('./views/ContactLedgerView.vue'), meta: { breadcrumb: [{ title: 'Contacts', to: '/contacts' }, { title: 'Ledger' }] } },

      // ── Invoices (Sales) ──
      { path: 'invoices', name: 'invoicing.sales', component: () => import('./views/SalesInvoicesView.vue'), meta: { breadcrumb: [{ title: 'Invoices' }] } },
      { path: 'invoices/new', name: 'invoicing.sales.new', component: () => import('./views/InvoiceFormView.vue'), meta: { breadcrumb: [{ title: 'Invoices', to: '/invoices' }, { title: 'New' }] } },
      { path: 'invoices/:id/edit', name: 'invoicing.sales.edit', component: () => import('./views/InvoiceFormView.vue'), meta: { breadcrumb: [{ title: 'Invoices', to: '/invoices' }, { title: 'Edit' }] } },

      // ── Purchase Invoices (Bills) ──
      { path: 'bills', name: 'invoicing.purchases', component: () => import('./views/PurchaseInvoicesView.vue'), meta: { breadcrumb: [{ title: 'Purchase Invoices' }] } },
      // The standalone batch-import page moved onto the list itself (the Import button).
      // Kept as a redirect so bookmarks and the old nav link still land somewhere useful.
      { path: 'bills/import', redirect: { name: 'invoicing.purchases' } },
      { path: 'bills/new', name: 'invoicing.purchases.new', component: () => import('./views/PurchaseInvoiceFormView.vue'), meta: { breadcrumb: [{ title: 'Purchase Invoices', to: '/bills' }, { title: 'New' }] } },
      { path: 'bills/:id/edit', name: 'invoicing.purchases.edit', component: () => import('./views/PurchaseInvoiceFormView.vue'), meta: { breadcrumb: [{ title: 'Purchase Invoices', to: '/bills' }, { title: 'Edit' }] } },

      // ── Outgoing Orders (ORDO; "external" until #203) — route paths and names kept stable ──
      { path: 'orders', name: 'invoicing.orders', component: () => import('./views/OrdersView.vue'), meta: { breadcrumb: [{ title: 'Outgoing Orders' }] } },
      { path: 'orders/new', name: 'invoicing.orders.new', component: () => import('./views/OrderFormView.vue'), meta: { breadcrumb: [{ title: 'Outgoing Orders', to: '/orders' }, { title: 'New' }] } },
      { path: 'orders/:id/edit', name: 'invoicing.orders.edit', component: () => import('./views/OrderFormView.vue'), meta: { breadcrumb: [{ title: 'Outgoing Orders', to: '/orders' }, { title: 'Edit' }] } },

      // ── Incoming Orders (ORDI; "internal" until #203) ──
      { path: 'internal-orders', name: 'invoicing.internalOrders', component: () => import('./views/InternalOrdersView.vue'), meta: { breadcrumb: [{ title: 'Incoming Orders' }] } },
      { path: 'internal-orders/new', name: 'invoicing.internalOrders.new', component: () => import('./views/InternalOrderFormView.vue'), meta: { breadcrumb: [{ title: 'Incoming Orders', to: '/internal-orders' }, { title: 'New' }] } },
      { path: 'internal-orders/:id/edit', name: 'invoicing.internalOrders.edit', component: () => import('./views/InternalOrderFormView.vue'), meta: { breadcrumb: [{ title: 'Incoming Orders', to: '/internal-orders' }, { title: 'Edit' }] } },

      // ── Reservations (RES) ──
      { path: 'reservations', name: 'invoicing.reservations', component: () => import('./views/ReservationsView.vue'), meta: { breadcrumb: [{ title: 'Reservations' }] } },
      // FR-22.37: a new reservation is made in a dialog ON the list. This path („+ Нов", ★) opens
      // it there: a redirect, so the grid keeps its own route name — the key of its column
      // preferences and of its remembered filters. `?productId=` comes along to pre-fill it.
      { path: 'reservations/new', name: 'invoicing.reservations.new', redirect: (to) => ({ name: 'invoicing.reservations', query: { ...to.query, new: '1' } }) },
      { path: 'reservations/:id', name: 'invoicing.reservations.detail', component: () => import('./views/ReservationDetailView.vue'), meta: { breadcrumb: [{ title: 'Reservations', to: '/reservations' }, { title: 'Reservation' }] } },

      // ── Proforma ──
      { path: 'proforma', name: 'invoicing.proforma', component: () => import('./views/ProformaInvoicesView.vue'), meta: { breadcrumb: [{ title: 'Proforma' }] } },
      { path: 'proforma/new', name: 'invoicing.proforma.new', component: () => import('./views/ProformaInvoiceFormView.vue'), meta: { breadcrumb: [{ title: 'Proforma', to: '/proforma' }, { title: 'New' }] } },
      { path: 'proforma/:id/edit', name: 'invoicing.proforma.edit', component: () => import('./views/ProformaInvoiceFormView.vue'), meta: { breadcrumb: [{ title: 'Proforma', to: '/proforma' }, { title: 'Edit' }] } },

      // ── Credit / Debit Notes (FR-01: merged into the sales grid + form) ──
      // Named redirects: old links, ★ favorites and router.push({ name }) callers keep working.
      { path: 'credit-notes', name: 'invoicing.credit-notes', redirect: { name: 'invoicing.sales', query: { type: 'credit_note' } } },
      { path: 'credit-notes/new', name: 'invoicing.credit-notes.new', redirect: { name: 'invoicing.sales.new', query: { type: 'credit_note' } } },
      { path: 'credit-notes/:id/edit', name: 'invoicing.credit-notes.edit', redirect: (to) => ({ name: 'invoicing.sales.edit', params: { id: to.params.id } }) },
      { path: 'debit-notes', name: 'invoicing.debit-notes', redirect: { name: 'invoicing.sales', query: { type: 'debit_note' } } },
      { path: 'debit-notes/new', name: 'invoicing.debit-notes.new', redirect: { name: 'invoicing.sales.new', query: { type: 'debit_note' } } },
      { path: 'debit-notes/:id/edit', name: 'invoicing.debit-notes.edit', redirect: (to) => ({ name: 'invoicing.sales.edit', params: { id: to.params.id } }) },

      // ── Cash Sales ──
      { path: 'cash-sales', name: 'invoicing.cash-sales', component: () => import('./views/CashSalesView.vue'), meta: { till: true, breadcrumb: [{ title: 'Cash Sales' }] } },
      // A new cash sale is rung up on the till. The back-office form lives on for a sale that exists,
      // and for a draft left on it when it stood at `new`: `tillRedirect` brings `?restore=` here.
      { path: 'cash-sales/new', name: 'invoicing.cash-sales.new', component: () => import('./pos/views/PosTerminalView.vue'), meta: { till: true, breadcrumb: [{ title: 'Cash Sales', to: '/cash-sales' }, { title: 'Terminal' }] } },
      { path: 'cash-sales/draft', name: 'invoicing.cash-sales.draft', component: () => import('./views/CashSaleFormView.vue'), meta: { breadcrumb: [{ title: 'Cash Sales', to: '/cash-sales' }, { title: 'New' }] } },
      { path: 'cash-sales/:id/edit', name: 'invoicing.cash-sales.edit', component: () => import('./views/CashSaleFormView.vue'), meta: { breadcrumb: [{ title: 'Cash Sales', to: '/cash-sales' }, { title: 'Edit' }] } },
      // FR-21.13: a till sale the journal lists that is not a document yet (until R2 copies it).
      { path: 'cash-sales/:id/view', name: 'invoicing.cash-sales.view', component: () => import('./views/CashSaleJournalDocumentView.vue'), meta: { till: true, breadcrumb: [{ title: 'Cash Sales', to: '/cash-sales' }, { title: 'Detail' }] } },
      { path: 'cash-register/sessions', name: 'pos.sessions', component: () => import('./pos/views/PosSessionsView.vue'), meta: { till: true, breadcrumb: [{ title: 'Sessions' }] } },

      // ── Payments ──
      { path: 'payment-orders', name: 'invoicing.payment-orders', component: () => import('./views/PaymentOrdersView.vue'), meta: { breadcrumb: [{ title: 'Payment Orders' }] } },
      { path: 'cash-orders', name: 'invoicing.cash-orders', component: () => import('./views/CashOrdersView.vue'), meta: { breadcrumb: [{ title: 'Cash Orders' }] } },
      // ── Moved to the Reports app (FR-06 #14) ──
      // Both pages now live at /reports/*. These redirects keep the OLD ROUTE NAMES alive (the
      // repo-wide constraint: Playwright navigates by name and useGridColumns keys column
      // prefs by route name) and keep the query string, so old bookmarks carrying grid state
      // land on the moved page with that state intact. One SPA serves /reports too, so a router
      // redirect does it with no page load (FR-24.21 replaced the `MovedToReportsView` stub).
      { path: 'aging-report', name: 'invoicing.aging-report', redirect: to => ({ name: 'reports.aging', query: to.query, hash: to.hash }) },
      { path: 'reporting/export', name: 'invoicing.reporting.export', redirect: to => ({ name: 'reports.export', query: to.query, hash: to.hash }) },

      // ── Configuration ──
      { path: 'configuration/sequences', name: 'invoicing.configuration.sequences', component: () => import('./views/SequencesConfigView.vue'), meta: { breadcrumb: [{ title: 'Configuration' }, { title: 'Sequences' }] } },
      { path: 'configuration/devices', name: 'pos.devices', component: () => import('./pos/views/PosDevicesView.vue'), meta: { till: true, breadcrumb: [{ title: 'Configuration' }, { title: 'Devices' }] } },
      { path: 'configuration/devices/new', name: 'pos.devices.new', component: () => import('./pos/views/PosDeviceDetailView.vue'), meta: { till: true, breadcrumb: [{ title: 'Devices', to: '/configuration/devices' }, { title: 'New' }] } },
      { path: 'configuration/devices/:id', name: 'pos.devices.detail', component: () => import('./pos/views/PosDeviceDetailView.vue'), meta: { till: true, breadcrumb: [{ title: 'Devices', to: '/configuration/devices' }, { title: 'Detail' }] } },

      // ── The till's first home here, `/invoicing/pos/*` (FR-24 Phase 0) ──
      // Named redirects, as the credit notes' above: a bookmark, a desktop's start path, a sign-in's
      // return and the three names no page carries any more all still land. `/pos/*` is the server's
      // to answer (`portal-api/src/lib/pos-redirect.ts`), and it sends each to the same page.
      { path: 'pos', redirect: { name: 'invoicing.cash-sales.new' } },
      { path: 'pos/terminal', name: 'pos.terminal', redirect: { name: 'invoicing.cash-sales.new' } },
      { path: 'pos/orders', name: 'pos.orders', redirect: { name: 'invoicing.cash-sales' } },
      { path: 'pos/orders/:id', name: 'pos.orders.detail', redirect: { name: 'invoicing.cash-sales.view' } },
      { path: 'pos/sessions', redirect: { name: 'pos.sessions' } },
      { path: 'pos/devices', redirect: { name: 'pos.devices' } },
      { path: 'pos/devices/new', redirect: { name: 'pos.devices.new' } },
      { path: 'pos/devices/:id', redirect: { name: 'pos.devices.detail' } },
      { path: 'pos/pin', redirect: { name: 'pos.pin' } },
      { path: 'pos/:rest(.*)', redirect: { name: 'invoicing.cash-sales.new', params: {} } },
    ],
}
