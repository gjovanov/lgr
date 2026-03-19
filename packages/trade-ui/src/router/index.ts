import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: { name: 'warehouse.products' } },

      // ── Warehouse ──
      { path: 'products', name: 'warehouse.products', component: () => import('../views/warehouse/ProductsView.vue') },
      { path: 'products/new', name: 'warehouse.products.new', component: () => import('../views/warehouse/ProductFormView.vue') },
      { path: 'products/:id/edit', name: 'warehouse.products.edit', component: () => import('../views/warehouse/ProductFormView.vue') },
      { path: 'products/:id/stock', name: 'warehouse.products.stock', component: () => import('../views/warehouse/ProductStockView.vue') },
      { path: 'categories', name: 'warehouse.categories', component: () => import('../views/warehouse/CategoriesView.vue') },
      { path: 'warehouses', name: 'warehouse.warehouses', component: () => import('../views/warehouse/WarehousesView.vue') },
      { path: 'stock-levels', name: 'warehouse.stock-levels', component: () => import('../views/warehouse/StockLevelsView.vue') },
      { path: 'movements', name: 'warehouse.movements', component: () => import('../views/warehouse/MovementsView.vue') },
      { path: 'inventory-counts', name: 'warehouse.inventory-counts', component: () => import('../views/warehouse/InventoryCountView.vue') },
      { path: 'price-lists', name: 'warehouse.price-lists', component: () => import('../views/warehouse/PriceListsView.vue') },
      { path: 'bulk-pricing', name: 'warehouse.bulk-pricing', component: () => import('../views/warehouse/BulkPriceAdjustmentView.vue') },
      { path: 'inventory-valuation', name: 'warehouse.valuation', component: () => import('../views/warehouse/InventoryValuationView.vue') },

      // ── Invoicing ──
      { path: 'contacts', name: 'invoicing.contacts', component: () => import('../views/invoicing/ContactsView.vue') },
      { path: 'contacts/new', name: 'invoicing.contacts.new', component: () => import('../views/invoicing/ContactFormView.vue') },
      { path: 'contacts/:id/edit', name: 'invoicing.contacts.edit', component: () => import('../views/invoicing/ContactFormView.vue') },
      { path: 'contacts/:id/ledger', name: 'invoicing.contacts.ledger', component: () => import('../views/invoicing/ContactLedgerView.vue') },
      { path: 'sales-invoices', name: 'invoicing.sales', component: () => import('../views/invoicing/SalesInvoicesView.vue') },
      { path: 'purchase-invoices', name: 'invoicing.purchases', component: () => import('../views/invoicing/PurchaseInvoicesView.vue') },
      { path: 'purchase-invoices/new', name: 'invoicing.purchases.new', component: () => import('../views/invoicing/PurchaseInvoiceFormView.vue') },
      { path: 'purchase-invoices/:id/edit', name: 'invoicing.purchases.edit', component: () => import('../views/invoicing/PurchaseInvoiceFormView.vue') },
      { path: 'invoices/new', name: 'invoicing.sales.new', component: () => import('../views/invoicing/InvoiceFormView.vue') },
      { path: 'invoices/:id/edit', name: 'invoicing.sales.edit', component: () => import('../views/invoicing/InvoiceFormView.vue') },
      { path: 'proforma-invoices', name: 'invoicing.proforma', component: () => import('../views/invoicing/ProformaInvoicesView.vue') },
      { path: 'proforma-invoices/new', name: 'invoicing.proforma.new', component: () => import('../views/invoicing/ProformaInvoiceFormView.vue') },
      { path: 'proforma-invoices/:id/edit', name: 'invoicing.proforma.edit', component: () => import('../views/invoicing/ProformaInvoiceFormView.vue') },
      { path: 'credit-notes', name: 'invoicing.credit-notes', component: () => import('../views/invoicing/CreditNotesView.vue') },
      { path: 'credit-notes/new', name: 'invoicing.credit-notes.new', component: () => import('../views/invoicing/CreditNoteFormView.vue') },
      { path: 'credit-notes/:id/edit', name: 'invoicing.credit-notes.edit', component: () => import('../views/invoicing/CreditNoteFormView.vue') },
      { path: 'debit-notes', name: 'invoicing.debit-notes', component: () => import('../views/invoicing/DebitNotesView.vue') },
      { path: 'debit-notes/new', name: 'invoicing.debit-notes.new', component: () => import('../views/invoicing/DebitNoteFormView.vue') },
      { path: 'debit-notes/:id/edit', name: 'invoicing.debit-notes.edit', component: () => import('../views/invoicing/DebitNoteFormView.vue') },
      { path: 'cash-sales', name: 'invoicing.cash-sales', component: () => import('../views/invoicing/CashSalesView.vue') },
      { path: 'cash-sales/new', name: 'invoicing.cash-sales.new', component: () => import('../views/invoicing/CashSaleFormView.vue') },
      { path: 'cash-sales/:id/edit', name: 'invoicing.cash-sales.edit', component: () => import('../views/invoicing/CashSaleFormView.vue') },
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
