import { FISCAL_ADMIN_ROLES, PERMISSIONS, holdsArea, type Area } from 'config/constants'

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
  /**
   * Who may open it: any one of these permissions (an `admin` always may). Unset means the app's
   * own permission, the one its App Hub tile is shown for. A new-document form names the WRITE
   * permission its Save needs (`services/biz/route-permission.ts`), so nobody is offered a form
   * the server would refuse to save (FR-22 §5.8).
   */
  need?: readonly string[]
  /** Who may open it by role, whatever they hold, where the server's own rule is a role. */
  roles?: readonly string[]
  /** A page of the till, inside the invoicing app: all a PIN session reaches (`canOpenPage`). */
  till?: boolean
  /**
   * FR-26: the area the page belongs to (`config/constants#AREAS`). A session whose `areas` claim
   * lacks it does not open the page, as the server refuses its routes (`route-permission.ts#AREA_PREFIXES`).
   */
  area?: Area
}

/**
 * Each app's base path, name, permission and colour. Every app is a module of the one SPA (FR-24.21).
 * `reads`: every permission the server reads the app for, where that is more than its tile's
 * (`route-permission.ts#PREFIX_READ_RULES`).
 */
export const APP_NAV_META: Record<string, { base: string; nameKey: string; permission: string; color: string; reads?: readonly string[] }> = {
  invoicing: { base: '/invoicing', nameKey: 'apps.invoicing', permission: 'invoicing.read', color: '#2196f3', reads: ['invoicing.read', 'invoicing.write', 'invoicing.send'] },
  inventory: { base: '/inventory', nameKey: 'apps.inventory', permission: 'inventory.read', color: '#ff9800' },
  accounting: { base: '/accounting', nameKey: 'apps.accounting', permission: 'accounting.read', color: '#4caf50' },
  payroll: { base: '/payroll', nameKey: 'apps.payroll', permission: 'payroll.read', color: '#9c27b0' },
  reports: { base: '/reports', nameKey: 'apps.reports', permission: 'reports.read', color: '#8e24aa' },
  files: { base: '/files', nameKey: 'apps.files', permission: 'admin.settings', color: '#607d8b' },
}

function page(appId: string, to: string, labelKey: string, icon: string, need?: readonly string[]): PageDef {
  const path = APP_NAV_META[appId].base + to
  return need ? { id: path, appId, labelKey, icon, path, need } : { id: path, appId, labelKey, icon, path }
}

// FR-25 §3.11: what the server reads these for. Without it `payroll.read` still opens the app, at its totals.
const READ_PEOPLE = ['payroll.personal'] as const
const WRITE_INVOICING = ['invoicing.write'] as const
// FR-26.7: `inventory.transfer` saves a movement too, a transfer only (`route-permission.ts`).
const WRITE_MOVEMENT = ['inventory.write', 'inventory.transfer'] as const
// The till's pages, each named for what the server asks of it (`route-permission.ts`). An app's
// own `invoicing.read` would hide them from a till-only role and show them to an accountant.
const WRITE_TILL = ['pos.write'] as const
const READ_TILL = ['pos.read', 'pos.write'] as const
const READ_JOURNAL = [...APP_NAV_META.invoicing.reads!, ...READ_TILL] as const
// What the server reads for the inventory app too (`route-permission.ts`): the orders a delivery is
// booked against, and the contacts it picks a supplier from.
const READ_WITH_INVENTORY = [...APP_NAV_META.invoicing.reads!, 'inventory.read', 'inventory.write', 'inventory.adjust'] as const

/** A page of an area (FR-26 §2.3). */
function inArea(def: PageDef, area: Area): PageDef {
  return { ...def, area }
}

function tillPage(to: string, labelKey: string, icon: string, need: readonly string[], roles?: readonly string[]): PageDef {
  return { ...page('invoicing', to, labelKey, icon, need), till: true, ...(roles ? { roles } : {}) }
}

export const PAGE_REGISTRY: PageDef[] = [
  // ── Invoicing ──
  // FR-01: credit/debit notes merged into the sales/purchase document grids; their old
  // paths redirect, so stale favorites keep working while the rows themselves are gone.
  page('invoicing', '/invoices', 'nav.salesDocs', 'mdi-receipt-text-outline'),
  inArea(page('invoicing', '/orders', 'nav.externalOrders', 'mdi-clipboard-list-outline', READ_WITH_INVENTORY), 'orders'),
  inArea(page('invoicing', '/internal-orders', 'nav.internalOrders', 'mdi-account-clock-outline'), 'orders'),
  inArea(page('invoicing', '/reservations', 'nav.reservations', 'mdi-lock-clock'), 'orders'),
  page('invoicing', '/proforma', 'nav.proforma', 'mdi-file-document-outline'),
  inArea(page('invoicing', '/bills', 'nav.purchaseDocs', 'mdi-receipt-text'), 'purchases'),
  tillPage('/cash-sales', 'nav.crSales', 'mdi-cash-register', READ_JOURNAL),
  inArea(page('invoicing', '/payment-orders', 'nav.paymentOrders', 'mdi-bank-transfer'), 'payments'),
  inArea(page('invoicing', '/cash-orders', 'nav.cashOrders', 'mdi-cash'), 'payments'),
  // FR-06 (#14): the aging report and the export page moved to the Reports app — their rows
  // are under "Reports" below. The old paths still resolve (redirect stubs), and existing
  // favorites on them are remapped on load, see LEGACY_PAGE_IDS.
  page('invoicing', '/contacts', 'nav.contacts', 'mdi-contacts', READ_WITH_INVENTORY),
  // FR-26.8.3: the server lets admin and manager in (`route-permission.ts`), and nobody else.
  { ...page('invoicing', '/configuration/sequences', 'nav.sequences', 'mdi-numeric', []), roles: ['admin', 'manager'] },
  // ── Inventory ──
  page('inventory', '/products', 'nav.products', 'mdi-package-variant'),
  page('inventory', '/categories', 'nav.categories', 'mdi-shape'),
  page('inventory', '/warehouses', 'nav.warehouses', 'mdi-warehouse'),
  inArea(page('inventory', '/stock-levels', 'nav.stockLevels', 'mdi-chart-box'), 'stockControl'),
  page('inventory', '/movements', 'nav.stockMovements', 'mdi-swap-horizontal'),
  inArea(page('inventory', '/inventory-counts', 'nav.inventoryCount', 'mdi-clipboard-check'), 'stockControl'),
  inArea(page('inventory', '/inventory-valuation', 'nav.inventoryValuation', 'mdi-chart-areaspline'), 'stockControl'),
  inArea(page('inventory', '/opening-stock', 'nav.openingStock', 'mdi-database-import-outline'), 'stockControl'),
  inArea(page('inventory', '/price-lists', 'nav.priceLists', 'mdi-tag-multiple'), 'pricing'),
  inArea(page('inventory', '/bulk-pricing', 'nav.bulkPricing', 'mdi-percent'), 'pricing'),
  // ── New documents (FR-22.49, FR-22.51) ──
  // The daily forms, blank: ★ can pin one, and „+ Нов" lists them (NEW_DOCUMENT_MENU below).
  // `matchPage` prefers these over their lists, so a pin made on /invoicing/invoices/new pins
  // the form. A credit or debit note is the invoice form opened with `?type=`.
  page('invoicing', '/invoices/new', 'nav.newDocPage.salesInvoice', 'mdi-receipt-text-plus-outline', WRITE_INVOICING),
  page('invoicing', '/invoices/new?type=credit_note', 'nav.newDocPage.creditNote', 'mdi-receipt-text-minus-outline', WRITE_INVOICING),
  page('invoicing', '/invoices/new?type=debit_note', 'nav.newDocPage.debitNote', 'mdi-receipt-text-arrow-right-outline', WRITE_INVOICING),
  page('invoicing', '/proforma/new', 'nav.newDocPage.proforma', 'mdi-file-document-plus-outline', WRITE_INVOICING),
  // The till's terminal: a cash sale is rung up there.
  tillPage('/cash-sales/new', 'nav.csTerminal', 'mdi-point-of-sale', WRITE_TILL),
  inArea(page('invoicing', '/bills/new', 'nav.newDocPage.bill', 'mdi-receipt-text-arrow-left-outline', WRITE_INVOICING), 'purchases'),
  // FR-26.8.6: the form makes every type, and a transfer-only session (a Seller) saves transfers.
  page('inventory', '/movements/new', 'nav.newDocPage.stockMovement', 'mdi-truck-delivery-outline', WRITE_MOVEMENT),
  inArea(page('invoicing', '/internal-orders/new', 'nav.newDocPage.customerOrder', 'mdi-clipboard-account-outline', WRITE_INVOICING), 'orders'),
  inArea(page('invoicing', '/orders/new', 'nav.newDocPage.supplierOrder', 'mdi-clipboard-arrow-right-outline', WRITE_INVOICING), 'orders'),
  // FR-22.37: the Reservations list with its create dialog open (a redirect to `?new=1`).
  inArea(page('invoicing', '/reservations/new', 'nav.newDocPage.reservation', 'mdi-lock-plus-outline', WRITE_INVOICING), 'orders'),
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
  // ── The till, inside Invoicing ──
  tillPage('/cash-register/sessions', 'nav.crSessions', 'mdi-clock-outline', READ_TILL),
  // The server reads `fiscal` for any member and writes it by role: who runs a device holds no `pos.*`.
  tillPage('/configuration/devices', 'nav.devices', 'mdi-printer-pos', READ_TILL, FISCAL_ADMIN_ROLES),
  // ── Payroll ──
  page('payroll', '/employees', 'payroll.employees', 'mdi-account-multiple', READ_PEOPLE),
  page('payroll', '/runs', 'payroll.payrollRuns', 'mdi-cash-register'),
  page('payroll', '/payslips', 'payroll.payslips', 'mdi-file-document-outline', READ_PEOPLE),
  page('payroll', '/timesheets', 'payroll.timesheets', 'mdi-clock-outline', READ_PEOPLE),
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

/** What `canOpenPage` needs to know about the person: the session token's claims. */
export interface PageViewer {
  role?: string
  permissions?: readonly string[]
  /** How the session was made; `['pin']` for a till's PIN sign-in. */
  amr?: readonly string[]
  /** FR-26: the only areas the session opens; absent = every area. */
  areas?: readonly string[]
}

/**
 * May this person open the page? ★ and „+ Нов" list only what this answers yes to (FR-22 §5.8).
 *
 * It mirrors the server rather than deciding anything: the read rule for an app's pages, the
 * write rule for a new-document form, an `admin` always (as `route-permission.ts#writeRefusal`),
 * and a PIN session the till only, whatever its role (`pinScopeRefusal`). Hiding an entry is
 * presentation — the server still answers every request on its own.
 *
 * ⚠ The ONE rule for who may open what. ★, „+ Нов", the invoicing menu, the till's guard and the
 * landing after a PIN and after an org switch all ask it, so none of them can come to another answer.
 */
export function canOpenPage(page: PageDef, who: PageViewer | null | undefined): boolean {
  if (!who) return false
  if (who.amr?.includes('pin') && !page.till) return false
  if (who.role === 'admin') return true
  if (page.area && !holdsArea(who, page.area)) return false
  if (who.role && page.roles?.includes(who.role)) return true
  const need = page.need ?? APP_NAV_META[page.appId]?.reads ?? [APP_NAV_META[page.appId]?.permission]
  const held = who.permissions ?? []
  return need.some((p) => !!p && held.includes(p))
}

/** Whoever holds anything but the till's own: a member reads the org and its people on the server (pickers, the shell), and a till needs neither page. */
const BACK_OFFICE = PERMISSIONS.filter(p => !p.startsWith('pos.'))
const READ_DASHBOARD = ['invoicing.read', 'invoicing.write', 'invoicing.send', 'accounting.read', 'accounting.write', 'accounting.post', 'inventory.read', 'inventory.write', 'inventory.adjust'] as const

// FR-26: every portal page is of the `portal` area: a Seller has none of them.
const portalPage = (path: string, need: readonly string[]): PageDef => ({ id: path, appId: 'portal', labelKey: '', icon: '', path, need, area: 'portal' })

/**
 * The portal's own pages. No ★ pins one and no app menu lists one, so they are no rows of the registry, and
 * `canOpenPage` answers for them as for any other, each naming what the server asks of it
 * (`route-permission.ts`). An empty `need` is an admin's alone: billing and invites are the server's admin role.
 * ⚠ Presentation, as ever: portal routes have no guard, and the server answers every request on its own.
 */
export const PORTAL_PAGES: PageDef[] = [
  portalPage('/dashboard', READ_DASHBOARD),
  portalPage('/settings/organization', BACK_OFFICE),
  portalPage('/settings/users', BACK_OFFICE),
  // Writing a set is assigning access, which is the server's admin role (`permission-set.controller`).
  portalPage('/settings/permission-sets', []),
  portalPage('/settings/invites', []),
  portalPage('/settings/desktops', ['admin.settings']),
  portalPage('/settings/servers', ['admin.settings']),
  portalPage('/settings/server', ['admin.settings']),
  portalPage('/settings/billing', []),
  portalPage('/admin/audit-log', ['admin.audit']),
]

/** What the portal's side menu offers this person: the pages `canOpenPage` lets them open. */
export function portalPagesFor(who: PageViewer | null | undefined): string[] {
  return PORTAL_PAGES.filter(p => canOpenPage(p, who)).map(p => p.path)
}

/**
 * Who has the till and nothing else of the invoicing app: a PIN session, whatever its role (the
 * server holds it to the till, `pinScopeRefusal`), and someone holding `pos.*` with no right that
 * opens another page of it. The invoicing router takes them to the till from any other page. An
 * `admin` is refused nothing, whatever its set says.
 */
export function isTillOnly(who: PageViewer | null | undefined): boolean {
  if (!who) return false
  if (who.amr?.includes('pin')) return true
  if (who.role === 'admin') return false
  const held = who.permissions ?? []
  const reads = (ps: readonly string[]) => ps.some((p) => held.includes(p))
  return !reads(READ_WITH_INVENTORY) && reads(READ_TILL)
}

/**
 * FR-26.7: whether this session writes stock movements as transfers only: it holds
 * `inventory.transfer` and not `inventory.write`, and is no `admin`. The movement form offers it
 * Transfer alone, as the server accepts.
 */
export function isTransferOnly(who: PageViewer | null | undefined): boolean {
  if (!who || who.role === 'admin') return false
  const held = who.permissions ?? []
  return held.includes('inventory.transfer') && !held.includes('inventory.write')
}

/** Whether this session writes the inventory's records (products, categories, warehouses): `inventory.write`, or `admin`. */
export function writesInventory(who: PageViewer | null | undefined): boolean {
  if (!who) return false
  return who.role === 'admin' || (who.permissions ?? []).includes('inventory.write')
}

/**
 * Whether this session runs the fiscal devices: adds and edits them, programs their operators and prints their
 * reports. The server decides by role, never by permission (`FISCAL_ADMIN_ROLES`, `fiscal-device.controller.ts`):
 * a cashier holds `pos.write` and runs none, and a warehouse manager runs them without it. Anyone else who opens
 * the Devices page reads it (FR-26 D-8).
 */
export function runsDevices(who: PageViewer | null | undefined): boolean {
  return !!who?.role && FISCAL_ADMIN_ROLES.includes(who.role)
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
 * FR-26.8.4: the portal's pages a session without the `portal` area does not reach: the App Hub,
 * Dashboard, Settings and Admin. `/account`, `/orgs`, an invite and the sign-in pages stay.
 */
export function isPortalAreaPath(path: string): boolean {
  const p = path.replace(/\/+$/, '') || '/'
  return p === '/' || p === '/apps' || p === '/dashboard' || p.startsWith('/settings/') || p === '/settings' || p.startsWith('/admin/') || p === '/admin'
}

/**
 * Where a session without the `portal` area lands instead of the App Hub: the first app it opens,
 * in the order of `APP_NAV_META` (Invoicing first), else its own account page.
 */
export function landingWithoutPortal(who: PageViewer | null | undefined): string {
  for (const [, meta] of Object.entries(APP_NAV_META)) {
    const need = meta.reads ?? [meta.permission]
    if (who && (who.role === 'admin' || need.some(p => (who.permissions ?? []).includes(p)))) return `${meta.base}/`
  }
  return '/account'
}
