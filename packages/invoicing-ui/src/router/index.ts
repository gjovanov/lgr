import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: { name: 'invoicing.contacts' } },
      { path: 'contacts', name: 'invoicing.contacts', component: () => import('../views/invoicing/ContactsView.vue') },
      { path: 'contacts/new', name: 'invoicing.contacts.new', component: () => import('../views/invoicing/ContactFormView.vue') },
      { path: 'contacts/:id/edit', name: 'invoicing.contacts.edit', component: () => import('../views/invoicing/ContactFormView.vue') },
      { path: 'sales-invoices', name: 'invoicing.sales', component: () => import('../views/invoicing/SalesInvoicesView.vue') },
      { path: 'purchase-invoices', name: 'invoicing.purchases', component: () => import('../views/invoicing/PurchaseInvoicesView.vue') },
      { path: 'invoices/new', name: 'invoicing.sales.new', component: () => import('../views/invoicing/InvoiceFormView.vue') },
      { path: 'invoices/:id/edit', name: 'invoicing.sales.edit', component: () => import('../views/invoicing/InvoiceFormView.vue') },
      { path: 'proforma-invoices', name: 'invoicing.proforma', component: () => import('../views/invoicing/ProformaInvoicesView.vue') },
      { path: 'credit-notes', name: 'invoicing.credit-notes', component: () => import('../views/invoicing/CreditNotesView.vue') },
      { path: 'payment-orders', name: 'invoicing.payment-orders', component: () => import('../views/invoicing/PaymentOrdersView.vue') },
      { path: 'cash-orders', name: 'invoicing.cash-orders', component: () => import('../views/invoicing/CashOrdersView.vue') },
    ],
  },
]

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
})

router.beforeEach((to, _from, next) => {
  // Accept token from URL params (Portal passes it for cross-origin navigation)
  const urlToken = to.query.token as string | undefined
  const urlOrg = to.query.org as string | undefined
  if (urlToken) {
    localStorage.setItem('lgr_token', urlToken)
    if (urlOrg) localStorage.setItem('lgr_org', urlOrg)
    // Full reload so Pinia store re-initializes with the new localStorage values
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
