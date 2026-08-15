import { createRouter, createWebHistory } from 'vue-router'

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
      { path: 'bills/import', name: 'invoicing.purchases.import', component: () => import('../views/PurchaseInvoiceBatchImportView.vue'), meta: { breadcrumb: [{ title: 'Purchase Invoices', to: '/bills' }, { title: 'Batch Import' }] } },
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

      // ── Credit Notes ──
      { path: 'credit-notes', name: 'invoicing.credit-notes', component: () => import('../views/CreditNotesView.vue'), meta: { breadcrumb: [{ title: 'Credit Notes' }] } },
      { path: 'credit-notes/new', name: 'invoicing.credit-notes.new', component: () => import('../views/CreditNoteFormView.vue'), meta: { breadcrumb: [{ title: 'Credit Notes', to: '/credit-notes' }, { title: 'New' }] } },
      { path: 'credit-notes/:id/edit', name: 'invoicing.credit-notes.edit', component: () => import('../views/CreditNoteFormView.vue'), meta: { breadcrumb: [{ title: 'Credit Notes', to: '/credit-notes' }, { title: 'Edit' }] } },

      // ── Debit Notes ──
      { path: 'debit-notes', name: 'invoicing.debit-notes', component: () => import('../views/DebitNotesView.vue'), meta: { breadcrumb: [{ title: 'Debit Notes' }] } },
      { path: 'debit-notes/new', name: 'invoicing.debit-notes.new', component: () => import('../views/DebitNoteFormView.vue'), meta: { breadcrumb: [{ title: 'Debit Notes', to: '/debit-notes' }, { title: 'New' }] } },
      { path: 'debit-notes/:id/edit', name: 'invoicing.debit-notes.edit', component: () => import('../views/DebitNoteFormView.vue'), meta: { breadcrumb: [{ title: 'Debit Notes', to: '/debit-notes' }, { title: 'Edit' }] } },

      // ── Cash Sales ──
      { path: 'cash-sales', name: 'invoicing.cash-sales', component: () => import('../views/CashSalesView.vue'), meta: { breadcrumb: [{ title: 'Cash Sales' }] } },
      { path: 'cash-sales/new', name: 'invoicing.cash-sales.new', component: () => import('../views/CashSaleFormView.vue'), meta: { breadcrumb: [{ title: 'Cash Sales', to: '/cash-sales' }, { title: 'New' }] } },
      { path: 'cash-sales/:id/edit', name: 'invoicing.cash-sales.edit', component: () => import('../views/CashSaleFormView.vue'), meta: { breadcrumb: [{ title: 'Cash Sales', to: '/cash-sales' }, { title: 'Edit' }] } },

      // ── Payments ──
      { path: 'payment-orders', name: 'invoicing.payment-orders', component: () => import('../views/PaymentOrdersView.vue'), meta: { breadcrumb: [{ title: 'Payment Orders' }] } },
      { path: 'cash-orders', name: 'invoicing.cash-orders', component: () => import('../views/CashOrdersView.vue'), meta: { breadcrumb: [{ title: 'Cash Orders' }] } },
      { path: 'aging-report', name: 'invoicing.aging-report', component: () => import('../views/InvoiceAgingView.vue'), meta: { breadcrumb: [{ title: 'Aging Report' }] } },

      // ── Reporting ──
      { path: 'reporting/export', name: 'invoicing.reporting.export', component: () => import('../views/ReportingExportView.vue'), meta: { breadcrumb: [{ title: 'Reporting' }, { title: 'Export' }] } },

      // ── Configuration ──
      { path: 'configuration/sequences', name: 'invoicing.configuration.sequences', component: () => import('../views/SequencesConfigView.vue'), meta: { breadcrumb: [{ title: 'Configuration' }, { title: 'Sequences' }] } },
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
