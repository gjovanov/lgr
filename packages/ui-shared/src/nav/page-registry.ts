/**
 * Cross-app registry of the favouritable PAGES/functions surfaced by the global top-bar ★ menu.
 * Mirrors each app's top-menu `menuItems` (same i18n label key + mdi icon + `to`). The `path`
 * is the full app-prefixed URL (app base + `to`, e.g. "/invoicing/invoices") and doubles as the
 * globally-unique `id`, so favorites/usage span every app.
 *
 * ui-shared has no dependency on the `config` package, so the app base paths / dev ports below
 * intentionally duplicate `APP_REGISTRY` (packages/config/src/constants.ts) — keep them in sync.
 */

export interface PageDef {
  id: string // full app-prefixed path, e.g. "/invoicing/invoices"
  appId: string
  labelKey: string // i18n key, e.g. "nav.salesInvoices"
  icon: string
  path: string // navigation target (same value as id)
}

export const APP_NAV_META: Record<string, { base: string; devPort: number; nameKey: string }> = {
  invoicing: { base: '/invoicing', devPort: 4021, nameKey: 'apps.invoicing' },
  inventory: { base: '/inventory', devPort: 4031, nameKey: 'apps.inventory' },
  accounting: { base: '/accounting', devPort: 4011, nameKey: 'apps.accounting' },
  pos: { base: '/pos', devPort: 4091, nameKey: 'apps.pos' },
  payroll: { base: '/payroll', devPort: 4041, nameKey: 'apps.payroll' },
}

function page(appId: string, to: string, labelKey: string, icon: string): PageDef {
  const path = APP_NAV_META[appId].base + to
  return { id: path, appId, labelKey, icon, path }
}

export const PAGE_REGISTRY: PageDef[] = [
  // ── Invoicing ──
  // FR-01: credit/debit notes merged into the sales/purchase document grids; their old
  // paths redirect, so stale favorites keep working while the rows themselves are gone.
  page('invoicing', '/invoices', 'nav.salesDocs', 'mdi-receipt-text-outline'),
  page('invoicing', '/orders', 'nav.externalOrders', 'mdi-clipboard-list-outline'),
  page('invoicing', '/internal-orders', 'nav.internalOrders', 'mdi-account-clock-outline'),
  page('invoicing', '/reservations', 'nav.reservations', 'mdi-lock-clock'),
  page('invoicing', '/proforma', 'nav.proforma', 'mdi-file-document-outline'),
  page('invoicing', '/bills', 'nav.purchaseDocs', 'mdi-receipt-text'),
  page('invoicing', '/cash-sales', 'invoicing.cashSales', 'mdi-cash-register'),
  page('invoicing', '/payment-orders', 'nav.paymentOrders', 'mdi-bank-transfer'),
  page('invoicing', '/cash-orders', 'nav.cashOrders', 'mdi-cash'),
  page('invoicing', '/aging-report', 'nav.agingReport', 'mdi-clock-alert-outline'),
  page('invoicing', '/reporting/export', 'nav.export', 'mdi-download'),
  page('invoicing', '/contacts', 'nav.contacts', 'mdi-contacts'),
  page('invoicing', '/configuration/sequences', 'nav.sequences', 'mdi-numeric'),
  // ── Inventory ──
  page('inventory', '/products', 'nav.products', 'mdi-package-variant'),
  page('inventory', '/categories', 'nav.categories', 'mdi-shape'),
  page('inventory', '/warehouses', 'nav.warehouses', 'mdi-warehouse'),
  page('inventory', '/stock-levels', 'nav.stockLevels', 'mdi-chart-box'),
  page('inventory', '/movements', 'nav.stockMovements', 'mdi-swap-horizontal'),
  page('inventory', '/inventory-counts', 'nav.inventoryCount', 'mdi-clipboard-check'),
  page('inventory', '/inventory-valuation', 'nav.inventoryValuation', 'mdi-chart-areaspline'),
  page('inventory', '/opening-stock', 'nav.openingStock', 'mdi-database-import-outline'),
  page('inventory', '/price-lists', 'nav.priceLists', 'mdi-tag-multiple'),
  page('inventory', '/bulk-pricing', 'nav.bulkPricing', 'mdi-percent'),
  // ── Accounting ──
  page('accounting', '/accounts', 'nav.accounts', 'mdi-chart-bar'),
  page('accounting', '/journal-entries', 'nav.journalEntries', 'mdi-book-open-variant'),
  page('accounting', '/general-ledger', 'nav.generalLedger', 'mdi-book-multiple'),
  page('accounting', '/financial-statements', 'nav.financialStatements', 'mdi-file-chart'),
  page('accounting', '/tax-returns', 'nav.taxReturns', 'mdi-file-document'),
  page('accounting', '/journal-analysis', 'nav.journalAnalysis', 'mdi-chart-timeline-variant'),
  page('accounting', '/bank-accounts', 'nav.bankAccounts', 'mdi-bank'),
  page('accounting', '/reconciliation', 'nav.reconciliation', 'mdi-bank-check'),
  page('accounting', '/exchange-rates', 'nav.exchangeRates', 'mdi-currency-usd'),
  page('accounting', '/fixed-assets', 'nav.fixedAssets', 'mdi-office-building'),
  // ── POS ──
  page('pos', '/terminal', 'nav.terminal', 'mdi-point-of-sale'),
  page('pos', '/orders', 'nav.transactions', 'mdi-receipt'),
  page('pos', '/sessions', 'nav.sessions', 'mdi-clock-outline'),
  page('pos', '/devices', 'nav.devices', 'mdi-printer-pos'),
  // ── Payroll ──
  page('payroll', '/employees', 'payroll.employees', 'mdi-account-multiple'),
  page('payroll', '/runs', 'payroll.payrollRuns', 'mdi-cash-register'),
  page('payroll', '/payslips', 'payroll.payslips', 'mdi-file-document-outline'),
  page('payroll', '/timesheets', 'payroll.timesheets', 'mdi-clock-outline'),
]

const byId = new Map(PAGE_REGISTRY.map((p) => [p.id, p]))

export function pageById(id: string): PageDef | null {
  return byId.get(id) || null
}

/**
 * Longest-prefix match of a full pathname against registry paths, so a detail/sub route
 * (e.g. /invoicing/invoices/123/edit) resolves to its list page (/invoicing/invoices).
 * A match needs an exact hit or a "/" boundary after the registry path — so
 * /invoicing/invoices never matches a hypothetical /invoicing/invoices-archive.
 */
export function matchPage(pathname: string): PageDef | null {
  if (!pathname) return null
  let best: PageDef | null = null
  for (const p of PAGE_REGISTRY) {
    if (pathname === p.path || pathname.startsWith(p.path + '/')) {
      if (!best || p.path.length > best.path.length) best = p
    }
  }
  return best
}
