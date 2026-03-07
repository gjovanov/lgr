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
      { path: 'invoicing/contacts', name: 'invoicing.contacts', component: () => import('invoicing-ui/src/views/invoicing/ContactsView.vue') },
      { path: 'invoicing/contacts/new', name: 'invoicing.contacts.new', component: () => import('invoicing-ui/src/views/invoicing/ContactFormView.vue') },
      { path: 'invoicing/contacts/:id/edit', name: 'invoicing.contacts.edit', component: () => import('invoicing-ui/src/views/invoicing/ContactFormView.vue') },
      { path: 'invoicing/sales-invoices', name: 'invoicing.sales', component: () => import('invoicing-ui/src/views/invoicing/SalesInvoicesView.vue') },
      { path: 'invoicing/purchase-invoices', name: 'invoicing.purchases', component: () => import('invoicing-ui/src/views/invoicing/PurchaseInvoicesView.vue') },
      { path: 'invoicing/invoices/new', name: 'invoicing.sales.new', component: () => import('invoicing-ui/src/views/invoicing/InvoiceFormView.vue') },
      { path: 'invoicing/invoices/:id/edit', name: 'invoicing.sales.edit', component: () => import('invoicing-ui/src/views/invoicing/InvoiceFormView.vue') },
      { path: 'invoicing/proforma-invoices', name: 'invoicing.proforma', component: () => import('invoicing-ui/src/views/invoicing/ProformaInvoicesView.vue') },
      { path: 'invoicing/credit-notes', name: 'invoicing.credit-notes', component: () => import('invoicing-ui/src/views/invoicing/CreditNotesView.vue') },
      { path: 'invoicing/payment-orders', name: 'invoicing.payment-orders', component: () => import('invoicing-ui/src/views/invoicing/PaymentOrdersView.vue') },
      { path: 'invoicing/cash-orders', name: 'invoicing.cash-orders', component: () => import('invoicing-ui/src/views/invoicing/CashOrdersView.vue') },

      // Warehouse
      { path: 'warehouse/products', name: 'warehouse.products', component: () => import('warehouse-ui/src/views/warehouse/ProductsView.vue') },
      { path: 'warehouse/products/new', name: 'warehouse.products.new', component: () => import('warehouse-ui/src/views/warehouse/ProductFormView.vue') },
      { path: 'warehouse/products/:id/edit', name: 'warehouse.products.edit', component: () => import('warehouse-ui/src/views/warehouse/ProductFormView.vue') },
      { path: 'warehouse/warehouses', name: 'warehouse.warehouses', component: () => import('warehouse-ui/src/views/warehouse/WarehousesView.vue') },
      { path: 'warehouse/stock-levels', name: 'warehouse.stock-levels', component: () => import('warehouse-ui/src/views/warehouse/StockLevelsView.vue') },
      { path: 'warehouse/movements', name: 'warehouse.movements', component: () => import('warehouse-ui/src/views/warehouse/MovementsView.vue') },
      { path: 'warehouse/inventory-counts', name: 'warehouse.inventory-counts', component: () => import('warehouse-ui/src/views/warehouse/InventoryCountView.vue') },
      { path: 'warehouse/price-lists', name: 'warehouse.price-lists', component: () => import('warehouse-ui/src/views/warehouse/PriceListsView.vue') },

      // Payroll
      { path: 'payroll/employees', name: 'payroll.employees', component: () => import('payroll-ui/src/views/payroll/EmployeesView.vue') },
      { path: 'payroll/employees/new', name: 'payroll.employee-new', component: () => import('payroll-ui/src/views/payroll/EmployeeFormView.vue') },
      { path: 'payroll/employees/:id/edit', name: 'payroll.employee-edit', component: () => import('payroll-ui/src/views/payroll/EmployeeFormView.vue') },
      { path: 'payroll/runs', name: 'payroll.runs', component: () => import('payroll-ui/src/views/payroll/PayrollRunsView.vue') },
      { path: 'payroll/payslips', name: 'payroll.payslips', component: () => import('payroll-ui/src/views/payroll/PayslipsView.vue') },
      { path: 'payroll/timesheets', name: 'payroll.timesheets', component: () => import('payroll-ui/src/views/payroll/TimesheetsView.vue') },

      // HR
      { path: 'hr/departments', name: 'hr.departments', component: () => import('hr-ui/src/views/hr/DepartmentsView.vue') },
      { path: 'hr/leave', name: 'hr.leave', component: () => import('hr-ui/src/views/hr/LeaveManagementView.vue') },
      { path: 'hr/business-trips', name: 'hr.business-trips', component: () => import('hr-ui/src/views/hr/BusinessTripsView.vue') },
      { path: 'hr/documents', name: 'hr.documents', component: () => import('hr-ui/src/views/hr/EmployeeDocumentsView.vue') },

      // CRM
      { path: 'crm/leads', name: 'crm.leads', component: () => import('crm-ui/src/views/crm/LeadsView.vue') },
      { path: 'crm/deals', name: 'crm.deals', component: () => import('crm-ui/src/views/crm/DealsView.vue') },
      { path: 'crm/activities', name: 'crm.activities', component: () => import('crm-ui/src/views/crm/ActivitiesView.vue') },

      // ERP
      { path: 'erp/bom', name: 'erp.bom', component: () => import('erp-ui/src/views/erp/BillOfMaterialsView.vue') },
      { path: 'erp/production-orders', name: 'erp.production-orders', component: () => import('erp-ui/src/views/erp/ProductionOrdersView.vue') },
      { path: 'erp/construction-projects', name: 'erp.construction-projects', component: () => import('erp-ui/src/views/erp/ConstructionProjectsView.vue') },
      { path: 'erp/pos', name: 'erp.pos', component: () => import('erp-ui/src/views/erp/POSView.vue') },
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
