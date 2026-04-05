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

      // ── Sales Invoices ──
      { path: 'sales-invoices', name: 'invoicing.sales', component: () => import('../views/SalesInvoicesView.vue'), meta: { breadcrumb: [{ title: 'Sales Invoices' }] } },
      { path: 'invoices/new', name: 'invoicing.sales.new', component: () => import('../views/InvoiceFormView.vue'), meta: { breadcrumb: [{ title: 'Sales Invoices', to: '/sales-invoices' }, { title: 'New' }] } },
      { path: 'invoices/:id/edit', name: 'invoicing.sales.edit', component: () => import('../views/InvoiceFormView.vue'), meta: { breadcrumb: [{ title: 'Sales Invoices', to: '/sales-invoices' }, { title: 'Edit' }] } },

      // ── Purchase Invoices ──
      { path: 'purchase-invoices', name: 'invoicing.purchases', component: () => import('../views/PurchaseInvoicesView.vue'), meta: { breadcrumb: [{ title: 'Purchase Invoices' }] } },
      { path: 'purchase-invoices/new', name: 'invoicing.purchases.new', component: () => import('../views/PurchaseInvoiceFormView.vue'), meta: { breadcrumb: [{ title: 'Purchase Invoices', to: '/purchase-invoices' }, { title: 'New' }] } },
      { path: 'purchase-invoices/:id/edit', name: 'invoicing.purchases.edit', component: () => import('../views/PurchaseInvoiceFormView.vue'), meta: { breadcrumb: [{ title: 'Purchase Invoices', to: '/purchase-invoices' }, { title: 'Edit' }] } },

      // ── Proforma Invoices ──
      { path: 'proforma-invoices', name: 'invoicing.proforma', component: () => import('../views/ProformaInvoicesView.vue'), meta: { breadcrumb: [{ title: 'Proforma Invoices' }] } },
      { path: 'proforma-invoices/new', name: 'invoicing.proforma.new', component: () => import('../views/ProformaInvoiceFormView.vue'), meta: { breadcrumb: [{ title: 'Proforma Invoices', to: '/proforma-invoices' }, { title: 'New' }] } },
      { path: 'proforma-invoices/:id/edit', name: 'invoicing.proforma.edit', component: () => import('../views/ProformaInvoiceFormView.vue'), meta: { breadcrumb: [{ title: 'Proforma Invoices', to: '/proforma-invoices' }, { title: 'Edit' }] } },

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
