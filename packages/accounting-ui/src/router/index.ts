import { createRouter, createWebHistory } from 'vue-router'
import { consumeTokenHandoff, signInHref } from 'ui-shared/nav/navigate'
import { hasOrgSession } from 'ui-shared/session/session'

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
      // FR-13.38 (#24) — `locked` gates document archiving and blocks a Replace restore, and
      // until this screen existed it was reachable only through the API or Mongo.
      { path: 'fiscal-years', name: 'accounting.fiscal-years', component: () => import('../views/accounting/FiscalYearsView.vue') },
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
  // Accept a token from URL params ONLY on a local dev origin (FR-14.24) — on any other
  // origin it is stripped and ignored. A full reload follows either way so Pinia
  // re-initializes from the tab's session.
  if (consumeTokenHandoff(to.query)) return

  // An org session, in THIS tab. Without one: the portal's sign-in (or its org picker, for a person
  // signed in without an org), which brings the tab back to this page afterwards (FR-22.53).
  if (!hasOrgSession()) {
    window.location.href = signInHref(router.options.history.base + to.fullPath)
    return
  }
  next()
})
