import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: '/accounting/accounts' },
      // Accounting routes
      { path: 'accounting/accounts', name: 'accounting.accounts', component: () => import('../views/accounting/AccountsView.vue') },
      { path: 'accounting/journal-entries', name: 'accounting.journal-entries', component: () => import('../views/accounting/JournalEntriesView.vue') },
      { path: 'accounting/journal-entries/new', name: 'accounting.journal-entry-new', component: () => import('../views/accounting/JournalEntryFormView.vue') },
      { path: 'accounting/journal-entries/:id/edit', name: 'accounting.journal-entry-edit', component: () => import('../views/accounting/JournalEntryFormView.vue') },
      { path: 'accounting/financial-statements', name: 'accounting.financial-statements', component: () => import('../views/accounting/FinancialStatementsView.vue') },
      { path: 'accounting/general-ledger', name: 'accounting.general-ledger', component: () => import('../views/accounting/GeneralLedgerView.vue') },
      { path: 'accounting/fixed-assets', name: 'accounting.fixed-assets', component: () => import('../views/accounting/FixedAssetsView.vue') },
      { path: 'accounting/bank-accounts', name: 'accounting.bank-accounts', component: () => import('../views/accounting/BankAccountsView.vue') },
      { path: 'accounting/reconciliation', name: 'accounting.reconciliation', component: () => import('../views/accounting/ReconciliationView.vue') },
      { path: 'accounting/tax-returns', name: 'accounting.tax-returns', component: () => import('../views/accounting/TaxReturnsView.vue') },
      { path: 'accounting/exchange-rates', name: 'accounting.exchange-rates', component: () => import('../views/accounting/ExchangeRatesView.vue') },
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
