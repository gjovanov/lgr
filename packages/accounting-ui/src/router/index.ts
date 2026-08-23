import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: { name: 'accounting.accounts' } },
      { path: 'accounts', name: 'accounting.accounts', component: () => import('../views/accounting/AccountsView.vue') },
      { path: 'accounts/new', name: 'accounting.account-new', component: () => import('../views/accounting/AccountFormView.vue') },
      { path: 'accounts/:id/edit', name: 'accounting.account-edit', component: () => import('../views/accounting/AccountFormView.vue') },
      { path: 'journal-entries', name: 'accounting.journal-entries', component: () => import('../views/accounting/JournalEntriesView.vue') },
      { path: 'journal-entries/new', name: 'accounting.journal-entry-new', component: () => import('../views/accounting/JournalEntryFormView.vue') },
      { path: 'journal-entries/:id/edit', name: 'accounting.journal-entry-edit', component: () => import('../views/accounting/JournalEntryFormView.vue') },
      { path: 'financial-statements', name: 'accounting.financial-statements', component: () => import('../views/accounting/FinancialStatementsView.vue') },
      { path: 'general-ledger', name: 'accounting.general-ledger', component: () => import('../views/accounting/GeneralLedgerView.vue') },
      { path: 'fixed-assets', name: 'accounting.fixed-assets', component: () => import('../views/accounting/FixedAssetsView.vue') },
      { path: 'fixed-assets/new', name: 'accounting.fixed-asset-new', component: () => import('../views/accounting/FixedAssetFormView.vue') },
      { path: 'fixed-assets/:id/edit', name: 'accounting.fixed-asset-edit', component: () => import('../views/accounting/FixedAssetFormView.vue') },
      { path: 'bank-accounts', name: 'accounting.bank-accounts', component: () => import('../views/accounting/BankAccountsView.vue') },
      { path: 'bank-accounts/new', name: 'accounting.bank-account-new', component: () => import('../views/accounting/BankAccountFormView.vue') },
      { path: 'bank-accounts/:id/edit', name: 'accounting.bank-account-edit', component: () => import('../views/accounting/BankAccountFormView.vue') },
      { path: 'reconciliation', name: 'accounting.reconciliation', component: () => import('../views/accounting/ReconciliationView.vue') },
      { path: 'tax-returns', name: 'accounting.tax-returns', component: () => import('../views/accounting/TaxReturnsView.vue') },
      { path: 'tax-returns/new', name: 'accounting.tax-return-new', component: () => import('../views/accounting/TaxReturnFormView.vue') },
      { path: 'tax-returns/:id/edit', name: 'accounting.tax-return-edit', component: () => import('../views/accounting/TaxReturnFormView.vue') },
      { path: 'exchange-rates', name: 'accounting.exchange-rates', component: () => import('../views/accounting/ExchangeRatesView.vue') },
      { path: 'exchange-rates/new', name: 'accounting.exchange-rate-new', component: () => import('../views/accounting/ExchangeRateFormView.vue') },
      { path: 'exchange-rates/:id/edit', name: 'accounting.exchange-rate-edit', component: () => import('../views/accounting/ExchangeRateFormView.vue') },
      { path: 'journal-analysis', name: 'accounting.journal-analysis', component: () => import('../views/accounting/JournalAnalysisView.vue') },
    ],
  },
]

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  // FR-05 (#12): Back/Forward restore the saved scroll offset; fresh navigations start at top.
  scrollBehavior(_to, _from, savedPosition) {
    return savedPosition || { top: 0 }
  },
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
