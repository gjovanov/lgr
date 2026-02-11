import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/landing',
    name: 'landing',
    component: () => import('../views/LandingView.vue'),
    meta: { public: true, guest: true },
  },
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: '/dashboard' },
      { path: 'invite/:code', name: 'invite', component: () => import('../views/invite/InviteLandingView.vue'), meta: { public: true } },
      { path: 'dashboard', name: 'dashboard', component: () => import('../views/dashboard/DashboardView.vue') },

      // Accounting
      { path: 'accounting/accounts', name: 'accounting.accounts', component: () => import('../views/accounting/AccountsView.vue') },
      { path: 'accounting/journal-entries', name: 'accounting.journal-entries', component: () => import('../views/accounting/JournalEntriesView.vue') },
      { path: 'accounting/journal-entries/new', name: 'accounting.journal-entries.new', component: () => import('../views/accounting/JournalEntryFormView.vue') },
      { path: 'accounting/journal-entries/:id', name: 'accounting.journal-entries.edit', component: () => import('../views/accounting/JournalEntryFormView.vue') },
      { path: 'accounting/general-ledger', name: 'accounting.general-ledger', component: () => import('../views/accounting/GeneralLedgerView.vue') },
      { path: 'accounting/financial-statements', name: 'accounting.financial-statements', component: () => import('../views/accounting/FinancialStatementsView.vue') },
      { path: 'accounting/fixed-assets', name: 'accounting.fixed-assets', component: () => import('../views/accounting/FixedAssetsView.vue') },
      { path: 'accounting/bank-accounts', name: 'accounting.bank-accounts', component: () => import('../views/accounting/BankAccountsView.vue') },
      { path: 'accounting/reconciliation', name: 'accounting.reconciliation', component: () => import('../views/accounting/ReconciliationView.vue') },
      { path: 'accounting/tax-returns', name: 'accounting.tax-returns', component: () => import('../views/accounting/TaxReturnsView.vue') },
      { path: 'accounting/exchange-rates', name: 'accounting.exchange-rates', component: () => import('../views/accounting/ExchangeRatesView.vue') },

      // Invoicing
      { path: 'invoicing/sales', name: 'invoicing.sales', component: () => import('../views/invoicing/SalesInvoicesView.vue') },
      { path: 'invoicing/sales/new', name: 'invoicing.sales.new', component: () => import('../views/invoicing/InvoiceFormView.vue') },
      { path: 'invoicing/sales/:id', name: 'invoicing.sales.edit', component: () => import('../views/invoicing/InvoiceFormView.vue') },
      { path: 'invoicing/purchases', name: 'invoicing.purchases', component: () => import('../views/invoicing/PurchaseInvoicesView.vue') },
      { path: 'invoicing/proforma', name: 'invoicing.proforma', component: () => import('../views/invoicing/ProformaInvoicesView.vue') },
      { path: 'invoicing/credit-notes', name: 'invoicing.credit-notes', component: () => import('../views/invoicing/CreditNotesView.vue') },
      { path: 'invoicing/payment-orders', name: 'invoicing.payment-orders', component: () => import('../views/invoicing/PaymentOrdersView.vue') },
      { path: 'invoicing/cash-orders', name: 'invoicing.cash-orders', component: () => import('../views/invoicing/CashOrdersView.vue') },
      { path: 'invoicing/contacts', name: 'invoicing.contacts', component: () => import('../views/invoicing/ContactsView.vue') },
      { path: 'invoicing/contacts/new', name: 'invoicing.contacts.new', component: () => import('../views/invoicing/ContactFormView.vue') },
      { path: 'invoicing/contacts/:id', name: 'invoicing.contacts.edit', component: () => import('../views/invoicing/ContactFormView.vue') },

      // Warehouse
      { path: 'warehouse/products', name: 'warehouse.products', component: () => import('../views/warehouse/ProductsView.vue') },
      { path: 'warehouse/products/new', name: 'warehouse.products.new', component: () => import('../views/warehouse/ProductFormView.vue') },
      { path: 'warehouse/products/:id', name: 'warehouse.products.edit', component: () => import('../views/warehouse/ProductFormView.vue') },
      { path: 'warehouse/warehouses', name: 'warehouse.warehouses', component: () => import('../views/warehouse/WarehousesView.vue') },
      { path: 'warehouse/stock-levels', name: 'warehouse.stock-levels', component: () => import('../views/warehouse/StockLevelsView.vue') },
      { path: 'warehouse/movements', name: 'warehouse.movements', component: () => import('../views/warehouse/MovementsView.vue') },
      { path: 'warehouse/inventory-count', name: 'warehouse.inventory-count', component: () => import('../views/warehouse/InventoryCountView.vue') },
      { path: 'warehouse/price-lists', name: 'warehouse.price-lists', component: () => import('../views/warehouse/PriceListsView.vue') },

      // Payroll
      { path: 'payroll/employees', name: 'payroll.employees', component: () => import('../views/payroll/EmployeesView.vue') },
      { path: 'payroll/employees/new', name: 'payroll.employees.new', component: () => import('../views/payroll/EmployeeFormView.vue') },
      { path: 'payroll/employees/:id', name: 'payroll.employees.edit', component: () => import('../views/payroll/EmployeeFormView.vue') },
      { path: 'payroll/runs', name: 'payroll.runs', component: () => import('../views/payroll/PayrollRunsView.vue') },
      { path: 'payroll/payslips', name: 'payroll.payslips', component: () => import('../views/payroll/PayslipsView.vue') },
      { path: 'payroll/timesheets', name: 'payroll.timesheets', component: () => import('../views/payroll/TimesheetsView.vue') },

      // HR
      { path: 'hr/departments', name: 'hr.departments', component: () => import('../views/hr/DepartmentsView.vue') },
      { path: 'hr/leave-management', name: 'hr.leave-management', component: () => import('../views/hr/LeaveManagementView.vue') },
      { path: 'hr/business-trips', name: 'hr.business-trips', component: () => import('../views/hr/BusinessTripsView.vue') },
      { path: 'hr/documents', name: 'hr.documents', component: () => import('../views/hr/EmployeeDocumentsView.vue') },

      // CRM
      { path: 'crm/leads', name: 'crm.leads', component: () => import('../views/crm/LeadsView.vue') },
      { path: 'crm/deals', name: 'crm.deals', component: () => import('../views/crm/DealsView.vue') },
      { path: 'crm/activities', name: 'crm.activities', component: () => import('../views/crm/ActivitiesView.vue') },

      // ERP
      { path: 'erp/bom', name: 'erp.bom', component: () => import('../views/erp/BillOfMaterialsView.vue') },
      { path: 'erp/production', name: 'erp.production', component: () => import('../views/erp/ProductionOrdersView.vue') },
      { path: 'erp/construction', name: 'erp.construction', component: () => import('../views/erp/ConstructionProjectsView.vue') },
      { path: 'erp/pos', name: 'erp.pos', component: () => import('../views/erp/POSView.vue') },

      // Settings
      { path: 'settings/organization', name: 'settings.organization', component: () => import('../views/settings/OrganizationView.vue') },
      { path: 'settings/users', name: 'settings.users', component: () => import('../views/settings/UsersView.vue') },
      { path: 'settings/invites', name: 'settings.invites', component: () => import('../views/settings/InvitesView.vue') },
      { path: 'settings/billing', name: 'settings.billing', component: () => import('../views/settings/BillingView.vue') },

      // Admin
      { path: 'admin/audit-log', name: 'admin.audit-log', component: () => import('../views/admin/AuditLogView.vue') },
    ],
  },
  {
    path: '/auth',
    component: () => import('../layouts/AuthLayout.vue'),
    children: [
      { path: 'login', name: 'auth.login', component: () => import('../views/auth/LoginView.vue'), meta: { public: true } },
      { path: 'register', name: 'auth.register', component: () => import('../views/auth/RegisterView.vue'), meta: { public: true } },
      { path: 'oauth-callback', name: 'auth.oauth-callback', component: () => import('../views/auth/OAuthCallbackView.vue'), meta: { public: true } },
    ],
  },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to, _from, next) => {
  const isPublic = to.matched.some(r => r.meta.public)
  const isGuest = to.matched.some(r => r.meta.guest)
  const token = localStorage.getItem('lgr_token')
  if (!isPublic && !token) {
    next({ name: 'landing' })
  } else if (isGuest && token) {
    const pendingInvite = sessionStorage.getItem('pending_invite_code')
    if (pendingInvite) {
      sessionStorage.removeItem('pending_invite_code')
      next({ name: 'invite', params: { code: pendingInvite } })
    } else {
      next({ name: 'dashboard' })
    }
  } else {
    next()
  }
})
