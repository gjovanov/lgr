import type { ModuleManifest } from 'ui-shell/module'

/**
 * FR-24.3: the accounting module as data. Paths are relative to the module (`/accounting`), never to a
 * router's base: the one SPA's router composes them under the module's shell record.
 */
export const manifest: ModuleManifest = {
  id: 'accounting',
  base: '/accounting',
  titleKey: 'apps.accounting',
  pendingChanges: true,
  menu: [
  {
    labelKey: 'accounting.accounts',
    icon: 'mdi-chart-bar',
    children: [
      { labelKey: 'nav.accounts', icon: 'mdi-chart-bar', to: '/accounts' },
      { labelKey: 'nav.journalEntries', icon: 'mdi-book-open-variant', to: '/journal-entries' },
      { labelKey: 'nav.generalLedger', icon: 'mdi-book-multiple', to: '/general-ledger' },
      { labelKey: 'nav.fiscalYears', icon: 'mdi-calendar-range', to: '/fiscal-years' },
    ],
  },
  {
    labelKey: 'nav.reporting',
    icon: 'mdi-file-chart',
    children: [
      { labelKey: 'nav.financialStatements', icon: 'mdi-file-chart', to: '/financial-statements' },
      { labelKey: 'nav.taxReturns', icon: 'mdi-file-document', to: '/tax-returns' },
      { labelKey: 'nav.journalAnalysis', icon: 'mdi-chart-timeline-variant', to: '/journal-analysis' },
    ],
  },
  {
    labelKey: 'nav.bankAccounts',
    icon: 'mdi-bank',
    children: [
      { labelKey: 'nav.bankAccounts', icon: 'mdi-bank', to: '/bank-accounts' },
      { labelKey: 'nav.reconciliation', icon: 'mdi-bank-check', to: '/reconciliation' },
      { labelKey: 'nav.exchangeRates', icon: 'mdi-currency-usd', to: '/exchange-rates' },
    ],
  },
  {
    labelKey: 'nav.fixedAssets',
    icon: 'mdi-office-building',
    to: '/fixed-assets',
  },
],
  routes: [
      { path: '', redirect: { name: 'accounting.accounts' } },
      { path: 'accounts', name: 'accounting.accounts', component: () => import('./views/accounting/AccountsView.vue') },
      { path: 'accounts/new', name: 'accounting.account-new', component: () => import('./views/accounting/AccountFormView.vue') },
      { path: 'accounts/:id/edit', name: 'accounting.account-edit', component: () => import('./views/accounting/AccountFormView.vue') },
      { path: 'journal-entries', name: 'accounting.journal-entries', component: () => import('./views/accounting/JournalEntriesView.vue') },
      { path: 'journal-entries/new', name: 'accounting.journal-entry-new', component: () => import('./views/accounting/JournalEntryFormView.vue') },
      { path: 'journal-entries/:id/edit', name: 'accounting.journal-entry-edit', component: () => import('./views/accounting/JournalEntryFormView.vue') },
      { path: 'financial-statements', name: 'accounting.financial-statements', component: () => import('./views/accounting/FinancialStatementsView.vue') },
      { path: 'general-ledger', name: 'accounting.general-ledger', component: () => import('./views/accounting/GeneralLedgerView.vue') },
      { path: 'fixed-assets', name: 'accounting.fixed-assets', component: () => import('./views/accounting/FixedAssetsView.vue') },
      { path: 'fixed-assets/new', name: 'accounting.fixed-asset-new', component: () => import('./views/accounting/FixedAssetFormView.vue') },
      { path: 'fixed-assets/:id/edit', name: 'accounting.fixed-asset-edit', component: () => import('./views/accounting/FixedAssetFormView.vue') },
      { path: 'bank-accounts', name: 'accounting.bank-accounts', component: () => import('./views/accounting/BankAccountsView.vue') },
      { path: 'bank-accounts/new', name: 'accounting.bank-account-new', component: () => import('./views/accounting/BankAccountFormView.vue') },
      { path: 'bank-accounts/:id/edit', name: 'accounting.bank-account-edit', component: () => import('./views/accounting/BankAccountFormView.vue') },
      { path: 'reconciliation', name: 'accounting.reconciliation', component: () => import('./views/accounting/ReconciliationView.vue') },
      { path: 'tax-returns', name: 'accounting.tax-returns', component: () => import('./views/accounting/TaxReturnsView.vue') },
      { path: 'tax-returns/new', name: 'accounting.tax-return-new', component: () => import('./views/accounting/TaxReturnFormView.vue') },
      { path: 'tax-returns/:id/edit', name: 'accounting.tax-return-edit', component: () => import('./views/accounting/TaxReturnFormView.vue') },
      { path: 'exchange-rates', name: 'accounting.exchange-rates', component: () => import('./views/accounting/ExchangeRatesView.vue') },
      { path: 'exchange-rates/new', name: 'accounting.exchange-rate-new', component: () => import('./views/accounting/ExchangeRateFormView.vue') },
      { path: 'exchange-rates/:id/edit', name: 'accounting.exchange-rate-edit', component: () => import('./views/accounting/ExchangeRateFormView.vue') },
      { path: 'journal-analysis', name: 'accounting.journal-analysis', component: () => import('./views/accounting/JournalAnalysisView.vue') },
      // FR-13.38 (#24) — `locked` gates document archiving and blocks a Replace restore, and
      // until this screen existed it was reachable only through the API or Mongo.
      { path: 'fiscal-years', name: 'accounting.fiscal-years', component: () => import('./views/accounting/FiscalYearsView.vue') },
    ],
}
