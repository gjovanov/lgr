/**
 * Cross-app registry of the favouritable PAGES/functions surfaced by the global top-bar ★ menu.
 * Mirrors each app's top-menu `menuItems` (same i18n label key + mdi icon + `to`). The `path`
 * is the full app-prefixed URL (app base + `to`, e.g. "/invoicing/invoices") and doubles as the
 * globally-unique `id`, so favorites/usage span every app.
 *
 * ui-shared has no dependency on the `config` package, so the app base paths, dev ports,
 * permissions and colours below intentionally duplicate `APP_REGISTRY`
 * (packages/config/src/constants.ts). `unit/page-registry.test.ts` fails when they drift.
 */

export interface PageDef {
  id: string // full app-prefixed path, plus the query of a variant: "/invoicing/invoices/new?type=credit_note"
  appId: string
  labelKey: string // i18n key, e.g. "nav.salesInvoices"
  icon: string
  path: string // navigation target (same value as id)
  /**
   * Who may open it: any one of these permissions (an `admin` always may). Unset means the app's
   * own permission, the one its App Hub tile is shown for. A new-document form names the WRITE
   * permission its Save needs (`services/biz/route-permission.ts`), so nobody is offered a form
   * the server would refuse to save (FR-22 §5.8).
   */
  need?: readonly string[]
}

/**
 * Each app's base path, name, permission and colour. Every app is a module of the one SPA (FR-24.21).
 * POS is still its own app (its App Hub tile, `pos.read`, the PIN session's scope), with its pages
 * under `/invoicing/pos/*` since FR-24 Phase 0.
 */
export const APP_NAV_META: Record<string, { base: string; nameKey: string; permission: string; color: string }> = {
  invoicing: { base: '/invoicing', nameKey: 'apps.invoicing', permission: 'invoicing.read', color: '#2196f3' },
  inventory: { base: '/inventory', nameKey: 'apps.inventory', permission: 'inventory.read', color: '#ff9800' },
  accounting: { base: '/accounting', nameKey: 'apps.accounting', permission: 'accounting.read', color: '#4caf50' },
  pos: { base: '/invoicing/pos', nameKey: 'apps.pos', permission: 'pos.read', color: '#e91e63' },
  payroll: { base: '/payroll', nameKey: 'apps.payroll', permission: 'payroll.read', color: '#9c27b0' },
  reports: { base: '/reports', nameKey: 'apps.reports', permission: 'reports.read', color: '#8e24aa' },
  files: { base: '/files', nameKey: 'apps.files', permission: 'admin.settings', color: '#607d8b' },
}

function page(appId: string, to: string, labelKey: string, icon: string, need?: readonly string[]): PageDef {
  const path = APP_NAV_META[appId].base + to
  return need ? { id: path, appId, labelKey, icon, path, need } : { id: path, appId, labelKey, icon, path }
}

const WRITE_INVOICING = ['invoicing.write'] as const
const WRITE_INVENTORY = ['inventory.write'] as const

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
  // ── New documents (FR-22.49, FR-22.51) ──
  // The daily forms, blank: ★ can pin one, and „+ Нов" lists them (NEW_DOCUMENT_MENU below).
  // `matchPage` prefers these over their lists, so a pin made on /invoicing/invoices/new pins
  // the form. A credit or debit note is the invoice form opened with `?type=`.
  page('invoicing', '/invoices/new', 'nav.newDocPage.salesInvoice', 'mdi-receipt-text-plus-outline', WRITE_INVOICING),
  page('invoicing', '/invoices/new?type=credit_note', 'nav.newDocPage.creditNote', 'mdi-receipt-text-minus-outline', WRITE_INVOICING),
  page('invoicing', '/invoices/new?type=debit_note', 'nav.newDocPage.debitNote', 'mdi-receipt-text-arrow-right-outline', WRITE_INVOICING),
  page('invoicing', '/proforma/new', 'nav.newDocPage.proforma', 'mdi-file-document-plus-outline', WRITE_INVOICING),
  page('invoicing', '/cash-sales/new', 'nav.newDocPage.cashSale', 'mdi-cash-register', WRITE_INVOICING),
  page('invoicing', '/bills/new', 'nav.newDocPage.bill', 'mdi-receipt-text-arrow-left-outline', WRITE_INVOICING),
  page('inventory', '/movements/new', 'nav.newDocPage.goodsReceipt', 'mdi-truck-delivery-outline', WRITE_INVENTORY),
  page('invoicing', '/internal-orders/new', 'nav.newDocPage.customerOrder', 'mdi-clipboard-account-outline', WRITE_INVOICING),
  page('invoicing', '/orders/new', 'nav.newDocPage.supplierOrder', 'mdi-clipboard-arrow-right-outline', WRITE_INVOICING),
  // FR-22.37: the Reservations list with its create dialog open (a redirect to `?new=1`).
  page('invoicing', '/reservations/new', 'nav.newDocPage.reservation', 'mdi-lock-plus-outline', WRITE_INVOICING),
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
  page('pos', '/orders', 'cashRegister.title', 'mdi-receipt'),
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
  // FR-24 Phase 0: the POS pages moved into the invoicing SPA.
  '/pos/terminal': '/invoicing/pos/terminal',
  '/pos/orders': '/invoicing/pos/orders',
  '/pos/sessions': '/invoicing/pos/sessions',
  '/pos/devices': '/invoicing/pos/devices',
}

/** Map a stored page id onto its current one. Unknown ids pass through untouched. */
export function currentPageId(id: string): string {
  return LEGACY_PAGE_IDS[id] || id
}

const byId = new Map(PAGE_REGISTRY.map((p) => [p.id, p]))

export function pageById(id: string): PageDef | null {
  return byId.get(id) || null
}

function splitPath(path: string): { pathname: string; params: [string, string][] } {
  const q = path.indexOf('?')
  if (q < 0) return { pathname: path, params: [] }
  return { pathname: path.slice(0, q), params: [...new URLSearchParams(path.slice(q + 1))] }
}

const split = new Map(PAGE_REGISTRY.map((p) => [p.id, splitPath(p.path)]))

/**
 * Longest-prefix match of a full pathname against registry paths, so a detail/sub route
 * (e.g. /invoicing/invoices/123/edit) resolves to its list page (/invoicing/invoices).
 * A match needs an exact hit or a "/" boundary after the registry path — so
 * /invoicing/invoices never matches a hypothetical /invoicing/invoices-archive.
 *
 * A row with a query (the invoice form opened as a credit note) matches only its exact path
 * carrying those parameters, and beats the same path without them. `search` is
 * `location.search`; without it such rows never match.
 */
export function matchPage(pathname: string, search = ''): PageDef | null {
  if (!pathname) return null
  const query = new URLSearchParams(search)
  let best: PageDef | null = null
  let bestLength = -1
  let bestParams = -1
  for (const p of PAGE_REGISTRY) {
    const { pathname: base, params } = split.get(p.id)!
    if (params.length) {
      if (pathname !== base || !params.every(([k, v]) => query.get(k) === v)) continue
    } else if (pathname !== base && !pathname.startsWith(base + '/')) {
      continue
    }
    if (base.length > bestLength || (base.length === bestLength && params.length > bestParams)) {
      best = p
      bestLength = base.length
      bestParams = params.length
    }
  }
  return best
}

/** What `canOpenPage` needs to know about the person: the session token's claims. */
export interface PageViewer {
  role?: string
  permissions?: readonly string[]
  /** How the session was made; `['pin']` for a till's PIN sign-in. */
  amr?: readonly string[]
}

/**
 * May this person open the page? ★ and „+ Нов" list only what this answers yes to (FR-22 §5.8).
 *
 * It mirrors the server rather than deciding anything: the App Hub's rule for an app's pages, the
 * write rule for a new-document form, an `admin` always (as `route-permission.ts#writeRefusal`),
 * and a PIN session the till only, whatever its role (`pinScopeRefusal`). Hiding an entry is
 * presentation — the server still answers every request on its own.
 */
export function canOpenPage(page: PageDef, who: PageViewer | null | undefined): boolean {
  if (!who) return false
  if (who.amr?.includes('pin') && page.appId !== 'pos') return false
  if (who.role === 'admin') return true
  const need = page.need ?? [APP_NAV_META[page.appId]?.permission]
  const held = who.permissions ?? []
  return need.some((p) => !!p && held.includes(p))
}

/**
 * FR-22.49: what „+ Нов" offers, in the groups the menu separates with a divider: selling, the
 * back-office till, buying, orders. Each entry names a PAGE_REGISTRY row, which carries the path,
 * the icon and the permission the menu filters on. The label is the document alone ("Изходяща
 * фактура"): the menu itself already says "new".
 *
 * Reservations join once FR-22.37 gives them a create form.
 */
export const NEW_DOCUMENT_MENU: ReadonlyArray<ReadonlyArray<{ pageId: string; labelKey: string }>> = [
  [
    { pageId: '/invoicing/invoices/new', labelKey: 'nav.newDoc.salesInvoice' },
    { pageId: '/invoicing/invoices/new?type=credit_note', labelKey: 'nav.newDoc.creditNote' },
    { pageId: '/invoicing/proforma/new', labelKey: 'nav.newDoc.proforma' },
  ],
  [{ pageId: '/invoicing/cash-sales/new', labelKey: 'nav.newDoc.cashSale' }],
  [
    { pageId: '/invoicing/bills/new', labelKey: 'nav.newDoc.bill' },
    { pageId: '/inventory/movements/new', labelKey: 'nav.newDoc.goodsReceipt' },
  ],
  [
    { pageId: '/invoicing/internal-orders/new', labelKey: 'nav.newDoc.customerOrder' },
    { pageId: '/invoicing/orders/new', labelKey: 'nav.newDoc.supplierOrder' },
    { pageId: '/invoicing/reservations/new', labelKey: 'nav.newDoc.reservation' },
  ],
]

export interface NewDocumentItem {
  page: PageDef
  labelKey: string
}

/** „+ Нов" as this person sees it: entries they may not open are left out, and so are empty groups. */
export function newDocumentMenu(who: PageViewer | null | undefined): NewDocumentItem[][] {
  return NEW_DOCUMENT_MENU.map((group) =>
    group.flatMap(({ pageId, labelKey }) => {
      const p = pageById(pageId)
      return p && canOpenPage(p, who) ? [{ page: p, labelKey }] : []
    }),
  ).filter((group) => group.length > 0)
}
