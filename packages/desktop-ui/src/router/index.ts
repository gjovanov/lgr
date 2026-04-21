import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  // Auth (public)
  {
    path: '/auth/login',
    name: 'auth.login',
    component: () => import('../views/auth/LoginView.vue'),
    meta: { public: true },
  },

  // Protected routes — all modules under one layout
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: { name: 'accounting.accounts' } },

      // Accounting
      { path: 'accounting/accounts', name: 'accounting.accounts', component: () => import('accounting-ui/src/views/accounting/AccountsView.vue') },
      { path: 'accounting/journal-entries', name: 'accounting.journal-entries', component: () => import('accounting-ui/src/views/accounting/JournalEntriesView.vue') },
      { path: 'accounting/journal-entries/new', name: 'accounting.journal-entry-new', component: () => import('accounting-ui/src/views/accounting/JournalEntryFormView.vue') },
      { path: 'accounting/journal-entries/:id/edit', name: 'accounting.journal-entry-edit', component: () => import('accounting-ui/src/views/accounting/JournalEntryFormView.vue') },
      { path: 'accounting/financial-statements', name: 'accounting.financial-statements', component: () => import('accounting-ui/src/views/accounting/FinancialStatementsView.vue') },
      { path: 'accounting/general-ledger', name: 'accounting.general-ledger', component: () => import('accounting-ui/src/views/accounting/GeneralLedgerView.vue') },
      { path: 'accounting/fixed-assets', name: 'accounting.fixed-assets', component: () => import('accounting-ui/src/views/accounting/FixedAssetsView.vue') },
      { path: 'accounting/bank-accounts', name: 'accounting.bank-accounts', component: () => import('accounting-ui/src/views/accounting/BankAccountsView.vue') },
      { path: 'accounting/reconciliation', name: 'accounting.reconciliation', component: () => import('accounting-ui/src/views/accounting/ReconciliationView.vue') },
      { path: 'accounting/tax-returns', name: 'accounting.tax-returns', component: () => import('accounting-ui/src/views/accounting/TaxReturnsView.vue') },
      { path: 'accounting/exchange-rates', name: 'accounting.exchange-rates', component: () => import('accounting-ui/src/views/accounting/ExchangeRatesView.vue') },

      // Invoicing
      { path: 'invoicing/contacts', name: 'invoicing.contacts', component: () => import('invoicing-ui/src/views/ContactsView.vue') },
      { path: 'invoicing/contacts/new', name: 'invoicing.contacts.new', component: () => import('invoicing-ui/src/views/ContactFormView.vue') },
      { path: 'invoicing/contacts/:id/edit', name: 'invoicing.contacts.edit', component: () => import('invoicing-ui/src/views/ContactFormView.vue') },
      { path: 'invoicing/sales-invoices', name: 'invoicing.sales', component: () => import('invoicing-ui/src/views/SalesInvoicesView.vue') },
      { path: 'invoicing/purchase-invoices', name: 'invoicing.purchases', component: () => import('invoicing-ui/src/views/PurchaseInvoicesView.vue') },
      { path: 'invoicing/invoices/new', name: 'invoicing.sales.new', component: () => import('invoicing-ui/src/views/InvoiceFormView.vue') },
      { path: 'invoicing/invoices/:id/edit', name: 'invoicing.sales.edit', component: () => import('invoicing-ui/src/views/InvoiceFormView.vue') },
      { path: 'invoicing/proforma-invoices', name: 'invoicing.proforma', component: () => import('invoicing-ui/src/views/ProformaInvoicesView.vue') },
      { path: 'invoicing/credit-notes', name: 'invoicing.credit-notes', component: () => import('invoicing-ui/src/views/CreditNotesView.vue') },
      { path: 'invoicing/payment-orders', name: 'invoicing.payment-orders', component: () => import('invoicing-ui/src/views/PaymentOrdersView.vue') },
      { path: 'invoicing/cash-orders', name: 'invoicing.cash-orders', component: () => import('invoicing-ui/src/views/CashOrdersView.vue') },

      // Inventory (Warehouse)
      { path: 'warehouse/products', name: 'inventory.products', component: () => import('inventory-ui/src/views/ProductsView.vue') },
      { path: 'warehouse/products/new', redirect: '/warehouse/products/new/edit' },
      { path: 'warehouse/products/new/:tab(edit|pricing|settings)', name: 'inventory.products.new', component: () => import('inventory-ui/src/views/ProductFormView.vue') },
      { path: 'warehouse/products/:id', redirect: (to) => ({ path: `/warehouse/products/${to.params.id}/edit` }) },
      { path: 'warehouse/products/:id/:tab(edit|pricing|settings)', name: 'inventory.products.edit', component: () => import('inventory-ui/src/views/ProductFormView.vue') },
      { path: 'warehouse/products/:id/:tab(stock|ledger|movements|levels)', name: 'inventory.products.stock', component: () => import('inventory-ui/src/views/ProductStockView.vue') },
      { path: 'warehouse/warehouses', name: 'inventory.warehouses', component: () => import('inventory-ui/src/views/WarehousesView.vue') },
      { path: 'warehouse/stock-levels', name: 'inventory.stock-levels', component: () => import('inventory-ui/src/views/StockLevelsView.vue') },
      { path: 'warehouse/movements', name: 'inventory.movements', component: () => import('inventory-ui/src/views/MovementsView.vue') },
      { path: 'warehouse/inventory-counts', name: 'inventory.inventory-counts', component: () => import('inventory-ui/src/views/InventoryCountView.vue') },
      { path: 'warehouse/price-lists', name: 'inventory.price-lists', component: () => import('inventory-ui/src/views/PriceListsView.vue') },

      // Payroll
      { path: 'payroll/employees', name: 'payroll.employees', component: () => import('payroll-ui/src/views/payroll/EmployeesView.vue') },
      { path: 'payroll/employees/new', name: 'payroll.employee-new', component: () => import('payroll-ui/src/views/payroll/EmployeeFormView.vue') },
      { path: 'payroll/employees/:id/edit', name: 'payroll.employee-edit', component: () => import('payroll-ui/src/views/payroll/EmployeeFormView.vue') },
      { path: 'payroll/runs', name: 'payroll.runs', component: () => import('payroll-ui/src/views/payroll/PayrollRunsView.vue') },
      { path: 'payroll/payslips', name: 'payroll.payslips', component: () => import('payroll-ui/src/views/payroll/PayslipsView.vue') },
      { path: 'payroll/timesheets', name: 'payroll.timesheets', component: () => import('payroll-ui/src/views/payroll/TimesheetsView.vue') },

      // POS
      { path: 'pos', name: 'pos.terminal', component: () => import('pos-ui/src/views/PosTerminalView.vue') },
    ],
  },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to, _from, next) => {
  const isPublic = to.matched.some(r => r.meta.public)
  const token = localStorage.getItem('lgr_token')

  if (!isPublic && !token) {
    next({ name: 'auth.login' })
  } else if (to.name === 'auth.login' && token) {
    next('/')
  } else {
    next()
  }
})
