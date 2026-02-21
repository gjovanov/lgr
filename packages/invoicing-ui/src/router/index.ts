import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: '/invoicing/contacts' },
      // Invoicing routes
      { path: 'invoicing/contacts', name: 'invoicing.contacts', component: () => import('../views/invoicing/ContactsView.vue') },
      { path: 'invoicing/contacts/new', name: 'invoicing.contacts.new', component: () => import('../views/invoicing/ContactFormView.vue') },
      { path: 'invoicing/contacts/:id/edit', name: 'invoicing.contacts.edit', component: () => import('../views/invoicing/ContactFormView.vue') },
      { path: 'invoicing/sales-invoices', name: 'invoicing.sales', component: () => import('../views/invoicing/SalesInvoicesView.vue') },
      { path: 'invoicing/purchase-invoices', name: 'invoicing.purchases', component: () => import('../views/invoicing/PurchaseInvoicesView.vue') },
      { path: 'invoicing/invoices/new', name: 'invoicing.sales.new', component: () => import('../views/invoicing/InvoiceFormView.vue') },
      { path: 'invoicing/invoices/:id/edit', name: 'invoicing.sales.edit', component: () => import('../views/invoicing/InvoiceFormView.vue') },
      { path: 'invoicing/proforma-invoices', name: 'invoicing.proforma', component: () => import('../views/invoicing/ProformaInvoicesView.vue') },
      { path: 'invoicing/credit-notes', name: 'invoicing.credit-notes', component: () => import('../views/invoicing/CreditNotesView.vue') },
      { path: 'invoicing/payment-orders', name: 'invoicing.payment-orders', component: () => import('../views/invoicing/PaymentOrdersView.vue') },
      { path: 'invoicing/cash-orders', name: 'invoicing.cash-orders', component: () => import('../views/invoicing/CashOrdersView.vue') },
    ],
  },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to, _from, next) => {
  const token = localStorage.getItem('lgr_token')
  if (!token) {
    // Redirect to Portal for login
    const portalUrl = window.location.hostname === 'localhost' ? 'http://localhost:4001' : '/'
    window.location.href = portalUrl
    return
  }
  next()
})
