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
  reports: { base: '/reports', devPort: 4101, nameKey: 'apps.reports' },
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
  // FR-06 (#14): the aging report and the export page moved to the Reports app — their rows
  // are under "Reports" below. The old paths still resolve (redirect stubs), and existing
  // favorites on them are remapped on load, see LEGACY_PAGE_IDS.
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
  // ── Reports (FR-06 #14) ──
  // FR-6.5: one row per registry report, so every report is ★-favouritable and shows up in
  // the global page search. The labels are the registry's own label keys — a row here and an
  // entry there must name the same thing.
  page('reports', '/export', 'nav.export', 'mdi-download'),
  page('reports', '/aging', 'nav.agingReport', 'mdi-clock-alert-outline'),
  page('reports', '/sales-documents', 'reports.salesDocuments.label', 'mdi-file-document-outline'),
  page('reports', '/purchase-documents', 'reports.purchaseDocuments.label', 'mdi-file-import-outline'),
  page('reports', '/cash-register', 'reports.cashRegister.label', 'mdi-cash-register'),
  page('reports', '/contact-ledger', 'reports.contactLedger.label', 'mdi-account-details-outline'),
  page('reports', '/inventory-valuation', 'reports.inventoryValuation.label', 'mdi-chart-areaspline'),
  page('reports', '/stock-levels', 'reports.stockLevels.label', 'mdi-warehouse'),
  page('reports', '/stock-movements', 'reports.stockMovements.label', 'mdi-transfer'),
  page('reports', '/product-ledger', 'reports.productLedger.label', 'mdi-book-open-variant'),
  page('reports', '/warehouse-operations', 'reports.warehouseOps.label', 'mdi-swap-horizontal'),
  page('reports', '/sales-history', 'reports.salesHistory.label', 'mdi-cash-clock'),
  page('reports', '/order-sheet', 'reports.orderSheet.label', 'mdi-clipboard-list-outline'),
  // The nine SUPTO tables. Listed individually because an auditor looks for "18.3", not
  // for a page called SUPTO — and because each is a separate catalog card.
  ...['18.1', '18.2', '18.3', '18.4', '18.5', '18.6', '18.7', '18.8', '18.9'].map(tbl =>
    page('reports', `/supto/${tbl}`, `reports.supto.t${tbl.replace('.', '_')}.label`, 'mdi-shield-check-outline'),
  ),
]

/**
 * FR-6.5: a page's `id` IS its path, so moving a page orphans every ★ favorite pinned to
 * the old URL. These two moved with FR-06; the favorites composable rewrites stored ids
 * through this table on load, so a user who had starred either page keeps the star.
 *
 * Safe to delete once no stored favorites can plausibly still carry the old ids.
 */
export const LEGACY_PAGE_IDS: Record<string, string> = {
  '/invoicing/aging-report': '/reports/aging',
  '/invoicing/reporting/export': '/reports/export',
}

/** Map a stored page id onto its current one. Unknown ids pass through untouched. */
export function currentPageId(id: string): string {
  return LEGACY_PAGE_IDS[id] || id
}

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
