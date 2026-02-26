import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: { name: 'accounting.accounts' } },
      { path: 'accounts', name: 'accounting.accounts', component: () => import('../views/accounting/AccountsView.vue') },
      { path: 'journal-entries', name: 'accounting.journal-entries', component: () => import('../views/accounting/JournalEntriesView.vue') },
      { path: 'journal-entries/new', name: 'accounting.journal-entry-new', component: () => import('../views/accounting/JournalEntryFormView.vue') },
      { path: 'journal-entries/:id/edit', name: 'accounting.journal-entry-edit', component: () => import('../views/accounting/JournalEntryFormView.vue') },
      { path: 'financial-statements', name: 'accounting.financial-statements', component: () => import('../views/accounting/FinancialStatementsView.vue') },
      { path: 'general-ledger', name: 'accounting.general-ledger', component: () => import('../views/accounting/GeneralLedgerView.vue') },
      { path: 'fixed-assets', name: 'accounting.fixed-assets', component: () => import('../views/accounting/FixedAssetsView.vue') },
      { path: 'bank-accounts', name: 'accounting.bank-accounts', component: () => import('../views/accounting/BankAccountsView.vue') },
      { path: 'reconciliation', name: 'accounting.reconciliation', component: () => import('../views/accounting/ReconciliationView.vue') },
      { path: 'tax-returns', name: 'accounting.tax-returns', component: () => import('../views/accounting/TaxReturnsView.vue') },
      { path: 'exchange-rates', name: 'accounting.exchange-rates', component: () => import('../views/accounting/ExchangeRatesView.vue') },
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
