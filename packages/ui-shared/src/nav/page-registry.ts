import { NOTHING, PAGE_ACCESS, can, canOpen, type CapabilityId, type Grant } from 'config/access'

/**
 * Cross-app registry of the favouritable PAGES/functions surfaced by the global top-bar ★ menu.
 * Mirrors each app's top-menu `menuItems` (same i18n label key + mdi icon + `to`). The `path`
 * is the full app-prefixed URL (app base + `to`, e.g. "/invoicing/invoices") and doubles as the
 * globally-unique `id`, so favorites/usage span every app.
 *
 * The app base paths, permissions and colours below duplicate `APP_REGISTRY`
 * (packages/config/src/constants.ts), and `unit/page-registry.test.ts` fails when they drift.
 */

export interface PageDef {
  id: string // full app-prefixed path, plus the query of a variant: "/invoicing/invoices/new?type=credit_note"
  appId: string
  labelKey: string // i18n key, e.g. "nav.salesInvoices"
  icon: string
  path: string // navigation target (same value as id)
  /** A page of the till, inside the invoicing app: all a PIN session reaches (`canOpenPage`). */
  till?: boolean
  // FR-27 P3-6 (#529): who opens a page is `config/access/pages.ts#PAGE_ACCESS`, by its id. The legacy `need`,
  // `roles`, `alsoNeed` and `area` are gone with the oracle that read them (`legacyCanOpenPage`).
}

/** Each app's base path, name, permission and colour. Every app is a module of the one SPA (FR-24.21). */
export const APP_NAV_META: Record<string, { base: string; nameKey: string; permission: string; color: string }> = {
  invoicing: { base: '/invoicing', nameKey: 'apps.invoicing', permission: 'invoicing.read', color: '#2196f3' },
  inventory: { base: '/inventory', nameKey: 'apps.inventory', permission: 'inventory.read', color: '#ff9800' },
  accounting: { base: '/accounting', nameKey: 'apps.accounting', permission: 'accounting.read', color: '#4caf50' },
  payroll: { base: '/payroll', nameKey: 'apps.payroll', permission: 'payroll.read', color: '#9c27b0' },
  reports: { base: '/reports', nameKey: 'apps.reports', permission: 'reports.read', color: '#8e24aa' },
  files: { base: '/files', nameKey: 'apps.files', permission: 'admin.settings', color: '#607d8b' },
}

/** FR-27: the capability that opens each app's first page, for `landingWithoutPortal`. */
const APP_OPENED_BY: Readonly<Record<string, CapabilityId>> = {
  invoicing: 'sales-docs.view',
  inventory: 'products.view',
  accounting: 'accounts.view',
  payroll: 'payroll-runs.view',
  reports: 'reports.view',
  files: 'files.view',
}

function page(appId: string, to: string, labelKey: string, icon: string): PageDef {
  const path = APP_NAV_META[appId].base + to
  return { id: path, appId, labelKey, icon, path }
}

function tillPage(to: string, labelKey: string, icon: string): PageDef {
  return { ...page('invoicing', to, labelKey, icon), till: true }
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
  page('invoicing', '/offer', 'nav.offers', 'mdi-file-sign'),
  page('invoicing', '/bills', 'nav.purchaseDocs', 'mdi-receipt-text'),
  tillPage('/cash-sales', 'nav.crSales', 'mdi-cash-register'),
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
  page('invoicing', '/invoices/new', 'nav.newDocPage.salesInvoice', 'mdi-receipt-text-plus-outline'),
  page('invoicing', '/invoices/new?type=credit_note', 'nav.newDocPage.creditNote', 'mdi-receipt-text-minus-outline'),
  page('invoicing', '/invoices/new?type=debit_note', 'nav.newDocPage.debitNote', 'mdi-receipt-text-arrow-right-outline'),
  page('invoicing', '/proforma/new', 'nav.newDocPage.proforma', 'mdi-file-document-plus-outline'),
  page('invoicing', '/offer/new', 'nav.newDocPage.offer', 'mdi-file-sign'),
  // The till's terminal: a cash sale is rung up there.
  tillPage('/cash-sales/new', 'nav.csTerminal', 'mdi-point-of-sale'),
  page('invoicing', '/bills/new', 'nav.newDocPage.bill', 'mdi-receipt-text-arrow-left-outline'),
  // FR-26.8.6: the form makes every type, and a transfer-only session (a Seller) saves transfers.
  page('inventory', '/movements/new', 'nav.newDocPage.stockMovement', 'mdi-truck-delivery-outline'),
  page('invoicing', '/internal-orders/new', 'nav.newDocPage.customerOrder', 'mdi-clipboard-account-outline'),
  page('invoicing', '/orders/new', 'nav.newDocPage.supplierOrder', 'mdi-clipboard-arrow-right-outline'),
  // FR-22.37: the Reservations list with its create dialog open (a redirect to `?new=1`).
  page('invoicing', '/reservations/new', 'nav.newDocPage.reservation', 'mdi-lock-plus-outline'),
  // ── Accounting ──
  page('accounting', '/accounts', 'nav.accounts', 'mdi-chart-bar'),
  page('accounting', '/analytics', 'nav.analytics', 'mdi-file-tree-outline'),
  page('accounting', '/product-groups', 'nav.productGroups', 'mdi-tag-multiple-outline'),
  page('accounting', '/journal-entries', 'nav.journalEntries', 'mdi-book-open-variant'),
  page('accounting', '/general-ledger', 'nav.generalLedger', 'mdi-book-multiple'),
  page('accounting', '/financial-statements', 'nav.financialStatements', 'mdi-file-chart'),
  page('accounting', '/tax-returns', 'nav.taxReturns', 'mdi-file-document'),
  page('accounting', '/journal-analysis', 'nav.journalAnalysis', 'mdi-chart-timeline-variant'),
  page('accounting', '/bank-accounts', 'nav.bankAccounts', 'mdi-bank'),
  page('accounting', '/reconciliation', 'nav.reconciliation', 'mdi-bank-check'),
  page('accounting', '/exchange-rates', 'nav.exchangeRates', 'mdi-currency-usd'),
  page('accounting', '/fixed-assets', 'nav.fixedAssets', 'mdi-office-building'),
  // ── The till, inside Invoicing ──
  tillPage('/cash-register/sessions', 'nav.crSessions', 'mdi-clock-outline'),
  tillPage('/configuration/devices', 'nav.devices', 'mdi-printer-pos'),
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
  page('reports', '/accounting-trial-balance', 'reports.accountingTrialBalance.label', 'mdi-scale-balance'),
  page('reports', '/accounting-analytic-balance', 'reports.accountingAnalyticBalance.label', 'mdi-file-tree-outline'),
  page('reports', '/accounting-main-book', 'reports.accountingMainBook.label', 'mdi-book-open-page-variant-outline'),
  page('reports', '/accounting-chronology', 'reports.accountingChronology.label', 'mdi-timeline-text-outline'),
  page('reports', '/accounting-documents', 'reports.accountingDocuments.label', 'mdi-file-document-multiple-outline'),
  // The nine SUPTO tables. Listed individually because an auditor looks for "18.3", not
  // for a page called SUPTO — and because each is a separate catalog card.
  ...['18.1', '18.2', '18.3', '18.4', '18.5', '18.6', '18.7', '18.8', '18.9'].map(tbl =>
    page('reports', `/supto/${tbl}`, `reports.supto.t${tbl.replace('.', '_')}.label`, 'mdi-shield-check-outline'),
  ),
]

/**
 * FR-6.5: a page's `id` IS its path, so moving a page orphans every ★ favorite pinned to
 * the old URL. The first two moved with FR-06, the rest when POS moved into Invoicing; the
 * favorites composable rewrites stored ids through this table on load, so a user who had starred
 * one of these pages keeps the star. One hop only: each old id names the page's final home.
 *
 * Safe to delete once no stored favorites can plausibly still carry the old ids.
 */
export const LEGACY_PAGE_IDS: Record<string, string> = {
  '/invoicing/aging-report': '/reports/aging',
  '/invoicing/reporting/export': '/reports/export',
  '/pos/terminal': '/invoicing/cash-sales/new',
  '/pos/orders': '/invoicing/cash-sales',
  '/pos/sessions': '/invoicing/cash-register/sessions',
  '/pos/devices': '/invoicing/configuration/devices',
  // FR-24 Phase 0 had them under `/invoicing/pos/*`, and rewrote stored ids to that.
  '/invoicing/pos/terminal': '/invoicing/cash-sales/new',
  '/invoicing/pos/orders': '/invoicing/cash-sales',
  '/invoicing/pos/sessions': '/invoicing/cash-register/sessions',
  '/invoicing/pos/devices': '/invoicing/configuration/devices',
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

/** What `canOpenPage` needs to know about the person: the session's grant (`sessionViewer`). */
export interface PageViewer {
  /** How the session was made; `['pin']` for a till's PIN sign-in. */
  amr?: readonly string[]
  /** FR-27.5: the session's live grant from its role. Until it is known the viewer holds nothing. */
  grant?: Grant
  /** FR-27.4: the page id its role starts it on. */
  landing?: string
}

/** FR-27 (#529): the viewer's grant: its role's, live. Until it is known the viewer holds nothing. */
export function grantOfViewer(who: PageViewer | null | undefined): Grant {
  return who?.grant ?? NOTHING
}

/**
 * What puts the portal (the App Hub, the Dashboard, Settings, Admin) in a role: anything of its pages. A role holding
 * none of it (the Seller, the Sales Consultant: FR-26.8.4) has no Portal tile and lands in its first app. FR-26's
 * `portal` area until FR-27 P3-6, now the capabilities that area was made of.
 */
export const PORTAL_CAPS: readonly CapabilityId[] = [
  'dashboard.view', 'dashboard.lookup', 'org-settings.view', 'users.view', 'desktops.view', 'servers.view', 'audit-log.view',
]

/** Whether this session's role has the portal (`PORTAL_CAPS`). */
export function holdsPortal(who: PageViewer | null | undefined): boolean {
  return !!who && can(grantOfViewer(who), PORTAL_CAPS)
}

/** Whether this session exports the catalog from the Products list (#493; FR-26's `catalogExport` until P3-6). */
export function exportsCatalog(who: PageViewer | null | undefined): boolean {
  return !!who && can(grantOfViewer(who), 'products.export')
}

/**
 * May this person open the page? ★ and „+ Нов" list only what this answers yes to (FR-22 §5.8).
 *
 * FR-27.2: one line on the grant (`config/access/pages.ts`), a PIN session the till only. Hiding an entry is
 * presentation: the server still answers every request on its own.
 *
 * ⚠ The ONE rule for who may open what. ★, „+ Нов", the menus, the till's guard and the landing after a PIN and
 * after an org switch all ask it, so none of them can come to another answer.
 */
export function canOpenPage(page: PageDef, who: PageViewer | null | undefined): boolean {
  return !!who && canOpen(page.id, grantOfViewer(who), who.amr)
}

// The portal's pages are no rows of the registry; `PAGE_ACCESS` names what opens each, by its path.
const portalPage = (path: string): PageDef => ({ id: path, appId: 'portal', labelKey: '', icon: '', path })

/**
 * The portal's own pages. No ★ pins one and no app menu lists one, so they are no rows of the registry, and
 * `canOpenPage` answers for them as for any other.
 * ⚠ Presentation, as ever: portal routes have no guard, and the server answers every request on its own.
 */
export const PORTAL_PAGES: PageDef[] = [
  portalPage('/dashboard'),
  portalPage('/settings/organization'),
  portalPage('/settings/users'),
  portalPage('/settings/roles'),
  portalPage('/settings/invites'),
  portalPage('/settings/desktops'),
  portalPage('/settings/servers'),
  portalPage('/settings/server'),
  portalPage('/settings/billing'),
  portalPage('/admin/audit-log'),
]

/** What the portal's side menu offers this person: the pages `canOpenPage` lets them open. */
export function portalPagesFor(who: PageViewer | null | undefined): string[] {
  return PORTAL_PAGES.filter(p => canOpenPage(p, who)).map(p => p.path)
}

/**
 * Who has the till and nothing else of the invoicing app: a PIN session, whatever its role (the
 * server holds it to the till, `pinScopeRefusal`), and a role holding the till with nothing that
 * opens another page of it. The invoicing router takes them to the till from any other page.
 */
export function isTillOnly(who: PageViewer | null | undefined): boolean {
  if (!who) return false
  if (who.amr?.includes('pin')) return true
  const grant = grantOfViewer(who)
  // What opens the back office of the invoicing app: its documents, or its contacts for an inventory role.
  return !can(grant, PAGE_ACCESS['/invoicing/contacts'].anyOf) && can(grant, 'till.view')
}

/**
 * FR-26.7: whether this session writes stock movements as transfers only (`movements.create:transfer`, not
 * `movements.create`). The movement form offers it Transfer alone, as the server accepts.
 */
export function isTransferOnly(who: PageViewer | null | undefined): boolean {
  if (!who) return false
  const grant = grantOfViewer(who)
  return can(grant, 'movements.create:transfer') && !can(grant, 'movements.create')
}

/** Whether this session writes the inventory's records (products, categories, warehouses): `products.edit`. */
export function writesInventory(who: PageViewer | null | undefined): boolean {
  return !!who && can(grantOfViewer(who), 'products.edit')
}

/**
 * Whether this session runs the fiscal devices: adds and edits them, programs their operators and prints their
 * reports: `devices.edit`, as `fiscal-device.controller.ts` asks (the roles named `FISCAL_ADMIN_ROLES` until FR-27
 * P3-6). A cashier sells and runs none. Anyone else who opens the Devices page reads it (FR-26 D-8).
 */
export function runsDevices(who: PageViewer | null | undefined): boolean {
  return !!who && can(grantOfViewer(who), 'devices.edit')
}

/**
 * Whether this session reads the documents, `/invoices` and its prints. A till-only session does
 * not, and neither does someone in on the till and inventory: a till sale's page is all they read
 * of it, not the back-office form.
 */
export function readsDocuments(who: PageViewer | null | undefined): boolean {
  return canOpenPage(pageById('/invoicing/invoices')!, who)
}

/**
 * FR-22.49: what „+ Нов" offers, in the groups the menu separates with a divider: selling, the
 * till, buying, orders. Each entry names a PAGE_REGISTRY row, which carries the path,
 * the icon and the permission the menu filters on. The label is the document alone ("Изходяща
 * фактура"): the menu itself already says "new".
 *
 * Reservations join once FR-22.37 gives them a create form.
 */
export const NEW_DOCUMENT_MENU: ReadonlyArray<ReadonlyArray<{ pageId: string; labelKey: string; transferOnlyLabelKey?: string }>> = [
  [
    { pageId: '/invoicing/invoices/new', labelKey: 'nav.newDoc.salesInvoice' },
    { pageId: '/invoicing/invoices/new?type=credit_note', labelKey: 'nav.newDoc.creditNote' },
    { pageId: '/invoicing/proforma/new', labelKey: 'nav.newDoc.proforma' },
    { pageId: '/invoicing/offer/new', labelKey: 'nav.newDoc.offer' },
  ],
  [{ pageId: '/invoicing/cash-sales/new', labelKey: 'nav.newDoc.cashSale' }],
  [
    { pageId: '/invoicing/bills/new', labelKey: 'nav.newDoc.bill' },
    // FR-26.8.6: whoever can make a receipt keeps the receipt's name; a transfer-only session sees "stock movement".
    { pageId: '/inventory/movements/new', labelKey: 'nav.newDoc.goodsReceipt', transferOnlyLabelKey: 'nav.newDoc.stockMovement' },
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
    group.flatMap(({ pageId, labelKey, transferOnlyLabelKey }) => {
      const p = pageById(pageId)
      if (!p || !canOpenPage(p, who)) return []
      return [{ page: p, labelKey: transferOnlyLabelKey && isTransferOnly(who) ? transferOnlyLabelKey : labelKey }]
    }),
  ).filter((group) => group.length > 0)
}

/**
 * FR-26.8.4: the portal's pages a session without the portal (`holdsPortal`) does not reach: the App Hub,
 * Dashboard, Settings and Admin. `/account`, `/orgs`, an invite and the sign-in pages stay.
 */
export function isPortalAreaPath(path: string): boolean {
  const p = path.replace(/\/+$/, '') || '/'
  return p === '/' || p === '/apps' || p === '/dashboard' || p.startsWith('/settings/') || p === '/settings' || p.startsWith('/admin/') || p === '/admin'
}

/**
 * Where a session without the portal (`holdsPortal`) lands instead of the App Hub: Products, where it opens them (#493
 * item 3: what a Seller and a Sales Consultant use most), else the first app it opens, in the order of
 * `APP_NAV_META` (Invoicing first), else its own account page.
 */
export function landingWithoutPortal(who: PageViewer | null | undefined): string {
  // FR-27.4: the role's own landing first, unless it is one of the portal's pages this session is sent out of.
  const own = ownLanding(who)
  if (own && !isPortalAreaPath(own)) return own
  const products = pageById('/inventory/products')
  if (products && canOpenPage(products, who)) return products.path
  if (!who) return '/account'
  const grant = grantOfViewer(who)
  for (const [appId, meta] of Object.entries(APP_NAV_META)) {
    if (APP_OPENED_BY[appId] && can(grant, APP_OPENED_BY[appId])) return `${meta.base}/`
  }
  return '/account'
}

/** FR-27.4: the role's landing page, where this session opens it, else null. */
function ownLanding(who: PageViewer | null | undefined): string | null {
  const id = who?.landing
  if (!id) return null
  const page = pageById(id) ?? PORTAL_PAGES.find(p => p.id === id) ?? null
  return page && canOpenPage(page, who) ? page.path : null
}

/**
 * FR-27.4: where a session starts, after signing in or entering the org, and where "Not available for your role"
 * sends it: its role's landing, else the Dashboard, else (no portal) `landingWithoutPortal`.
 */
export function startPage(who: PageViewer | null | undefined): string {
  const own = ownLanding(who)
  if (own) return own
  // FR-27.7: "else the first page it may open": the Dashboard only for a role that opens it (its summary answers
  // anyone else 403). A role without the portal is sent out of it.
  const dashboard = PORTAL_PAGES.find(p => p.id === '/dashboard')
  return holdsPortal(who) && dashboard && canOpenPage(dashboard, who!) ? '/dashboard' : landingWithoutPortal(who)
}

/**
 * FR-27.7: the page a route shows, for "Not available for your role": a registry page at its own path (a list, a
 * new-document form), or one of the portal's under Settings or Admin, with what lies under it. Null: the route
 * shows, and the server decides.
 *
 * ⚠ A module's RECORD route (`/inventory/products/:id/edit`) is never one: other apps link to records (an invoice's
 * product, a bill's receipt) for people whose role opens no list there, and the server serves them through the
 * feature's `lookup`. Never the Dashboard either, where everyone lands (`portalGuard` sends a session without it on).
 */
export function pageAt(pathname: string, search = ''): PageDef | null {
  const path = pathname.replace(/\/+$/, '')
  const hit = matchPage(pathname, search)
  if (hit) return hit.path.split('?')[0] === path ? hit : null
  let best: PageDef | null = null
  for (const page of PORTAL_PAGES) {
    if (page.path === '/dashboard') continue
    if ((path === page.path || path.startsWith(page.path + '/')) && (!best || page.path.length > best.path.length)) best = page
  }
  return best
}
