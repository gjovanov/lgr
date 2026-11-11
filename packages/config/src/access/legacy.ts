import { DEFAULT_ROLE_AREAS, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, mergeAreas, type Area, type Permission, type Role } from '../constants'
import type { CapabilityId, FeatureId } from './catalogue'
import { ALL, type Grant } from './grant'
// FR-27.11: every price level. Legacy grants them all with any product read, as it grants the costs.
import { PRICE_LEVEL_CAPS } from './fields'

/**
 * FR-27 §4 — today's grant, as capabilities: the Phase 0 oracle, and in Phase 1 the migration's engine.
 *
 * `compileLegacy(claims)` gives a session what its token's role, permissions and areas give it today, route by
 * route and page by page. `access-differential.flow.test.ts` proves it for every permission, role and area over the
 * real route table and the page registry. Change a row here and that test says which routes moved.
 *
 * Why it can be checked one permission at a time: today a route needs ANY of its permissions, and a page any of
 * its own, so the answer for several permissions is the OR of their answers. The compiled grant is the union of the
 * permissions' capabilities, so the same holds for it. Roles and areas are tested in every combination.
 */

type Cap = CapabilityId

const each = (features: readonly FeatureId[], action: string): Cap[] => features.map(f => `${f}.${action}` as Cap)
const work = (features: readonly FeatureId[]): Cap[] => [...each(features, 'create'), ...each(features, 'edit'), ...each(features, 'delete')]

const INVENTORY_FEATURES = ['products', 'categories', 'warehouses', 'movements', 'stock-levels', 'inventory-counts', 'valuation', 'opening-stock', 'price-lists', 'bulk-pricing'] as const
const INVENTORY_WRITABLE = ['products', 'categories', 'warehouses', 'movements', 'inventory-counts', 'opening-stock', 'price-lists', 'bulk-pricing'] as const
const ACCOUNTING_FEATURES = ['accounts', 'bank-accounts', 'journal', 'ledgers', 'vat', 'accounting-setup', 'exchange-rates', 'reconciliation', 'fixed-assets'] as const
const ACCOUNTING_WRITABLE = ['bank-accounts', 'journal', 'vat', 'accounting-setup', 'exchange-rates', 'reconciliation', 'fixed-assets'] as const

/** Whoever holds anything but the till's: the portal's Organization and Users pages (BACK_OFFICE). */
const BACK_OFFICE: Cap[] = ['org-settings.view', 'users.view']

/** Every invoicing permission reads the invoicing app (INVOICING in route-permission.ts). */
const INVOICING_READS: Cap[] = [
  'sales-docs.view', 'sales-docs.totals', 'bills.totals', 'proforma.view', 'bills.view', 'orders.view', 'payments.view', 'contacts.view', 'cash-sales.view',
  'dashboard.view', 'pricing.read', 'doc-import.read', ...BACK_OFFICE,
]

/** What every inventory permission reads (INVENTORY in route-permission.ts); `view` is `inventory.read`'s alone. */
const INVENTORY_LOOKUPS: Cap[] = [...each(INVENTORY_FEATURES, 'lookup'), 'pricing.read', 'doc-import.read', ...BACK_OFFICE]
/** The inventory permissions READ_WITH_INVENTORY and READ_DASHBOARD name: all but `inventory.transfer`. */
const INVENTORY_OPENS: Cap[] = ['orders.browse', 'contacts.browse', 'dashboard.view']

const ACCOUNTING_LOOKUPS: Cap[] = [...each(ACCOUNTING_FEATURES, 'lookup'), ...BACK_OFFICE]

/** Pos permissions: the till, its journal, the devices page and what the terminal picks. BACK_OFFICE leaves them out. */
const POS_READS: Cap[] = ['till.view', 'cash-sales.view', 'devices.view', 'contacts.lookup', 'pricing.read']

export const LEGACY_BRIDGE: Readonly<Record<Permission, readonly Cap[]>> = {
  'invoicing.read': [...INVOICING_READS, 'sales-docs.export', 'stock-availability.check'],
  'invoicing.write': [
    ...INVOICING_READS, 'sales-docs.export',
    ...work(['sales-docs', 'proforma', 'bills', 'orders', 'payments', 'contacts']), 'sales-docs.import',
    'stock-availability.transfer', 'doc-import.extract', 'tags.edit',
  ],
  // ⚠ Opens reads only: no route and no controller checks `invoicing.send`, and `canExport` ignores it.
  'invoicing.send': [...INVOICING_READS],

  // `products.export`: the Products page's export, which ProductsView offers whoever holds `catalogExport` (FR-26).
  'inventory.read': [...INVENTORY_LOOKUPS, ...each(INVENTORY_FEATURES, 'view'), ...INVENTORY_OPENS, 'stock-availability.check', 'products.export'],
  'inventory.write': [...INVENTORY_LOOKUPS, ...INVENTORY_OPENS, ...work(INVENTORY_WRITABLE), 'doc-import.extract', 'tags.edit'],
  // ⚠ Opens reads only: nothing checks `inventory.adjust` beyond the read lists.
  'inventory.adjust': [...INVENTORY_LOOKUPS, ...INVENTORY_OPENS],
  // FR-26.7: transfers, and the reads; not the Orders or Contacts page, nor the Dashboard's.
  'inventory.transfer': [...INVENTORY_LOOKUPS, 'movements.create:transfer', 'orders.lookup', 'contacts.lookup', 'dashboard.lookup'],

  'pos.read': [...POS_READS],
  'pos.write': [...POS_READS, 'till.sell'],

  'accounting.read': [...ACCOUNTING_LOOKUPS, ...each(ACCOUNTING_FEATURES, 'view'), 'dashboard.view'],
  'accounting.write': [...ACCOUNTING_LOOKUPS, ...work(ACCOUNTING_WRITABLE), 'accounts.edit', 'accounts.delete', 'dashboard.view'],
  'accounting.post': [...ACCOUNTING_LOOKUPS, 'journal.post', 'dashboard.view'],
  // Not READ_DASHBOARD's: the dashboard's data, not its page.
  'accounting.file': [...ACCOUNTING_LOOKUPS, 'vat.file', 'dashboard.lookup'],
  'accounting.import': ['books-import.run', ...BACK_OFFICE],

  'payroll.read': ['payroll-runs.view', ...BACK_OFFICE],
  'payroll.write': ['payroll-runs.lookup', ...work(['payroll-runs']), 'payroll-people.edit', ...BACK_OFFICE],
  'payroll.approve': ['payroll-runs.lookup', 'payroll-runs.approve', ...BACK_OFFICE],
  'payroll.personal': ['payroll-people.view', 'payroll-people.reveal', ...BACK_OFFICE],
  'payroll.import': ['payroll-import.run', ...BACK_OFFICE],

  'reports.read': ['reports.view', ...BACK_OFFICE],
  'reports.export': ['reports.export', ...BACK_OFFICE],

  // ⚠ Checked by nothing today (FR-27 §1.3).
  'admin.users': [...BACK_OFFICE],
  // The pages (`.view`, a portal page each) and what their controllers ask (`.manage`, no area).
  'admin.settings': ['files.view', 'files.manage', 'desktops.view', 'desktops.manage', 'servers.view', 'servers.manage', 'numbering.manage', 'roles.view', ...BACK_OFFICE],
  'admin.audit': ['audit-log.view', 'audit-log.lookup', ...BACK_OFFICE],
}

/**
 * What a role's NAME gives, whatever its permissions: the checks that decide by role today. `admin` is not here: it
 * holds everything. Used by the controllers' own checks and the pages that name `roles`; no route rule reads them.
 */
export const LEGACY_ROLE_CAPS: Readonly<Partial<Record<string, readonly Cap[]>>> = {
  // FISCAL_ADMIN_ROLES runs the devices; Z-reports and time sync are admin's and manager's (fiscal-device.controller).
  manager: [
    'devices.view', 'devices.edit', 'devices.report', 'devices.z-report', 'devices.sync-time',
    // STORNO_ROLES, a session another cashier opened (pos.controller), the sequence configuration.
    'cash-sales.storno', 'cash-sales.settle', 'till.manage-sessions', 'sequences.view', 'sequences.edit',
  ],
  warehouse_manager: ['devices.view', 'devices.edit', 'devices.report'],
  // account.controller: a new account is the admin's or the accountant's.
  accountant: ['accounts.create'],
  // SUPTO_ROLES, and the Files archives (file.controller).
  nra_auditor: ['supto.view', 'supto.export', 'files.archives'],
}

/**
 * FR-26 §2.3, as capabilities: what a session whose `areas` list lacks an area loses. A whole feature, or one
 * action of it where the area carves a page out but not its data (`stock-levels.view`: the product page still
 * reads the levels).
 */
export const AREA_OF: Readonly<Record<string, Area>> = {
  bills: 'purchases',
  orders: 'orders',
  payments: 'payments',
  'price-lists': 'pricing',
  'bulk-pricing': 'pricing',
  'inventory-counts': 'stockControl',
  valuation: 'stockControl',
  'opening-stock': 'stockControl',
  'stock-levels.view': 'stockControl',
  'products.export': 'catalogExport',
  dashboard: 'portal',
  'org-settings.view': 'portal',
  'users.view': 'portal',
  'desktops.view': 'portal',
  'servers.view': 'portal',
  'audit-log.view': 'portal',
}

export function areaOfCap(cap: string): Area | undefined {
  return AREA_OF[cap] ?? AREA_OF[cap.slice(0, cap.indexOf('.'))]
}

/**
 * #493 items 2, 4, 5 (FR-27 D-8: catalogue entries on the Phase 0 evaluator, not areas). What a session whose
 * claim carries an `areas` list does not get: the invoices' totals strip and `GET invoices/summary`, the Import
 * button on the invoices list, and changing organization. Item 2's own rule: sessions without a list keep the
 * strip. The lists today are the Seller's and the Sales Consultant's, as a role or as a set. No rule of today's
 * reads these capabilities, so the differential test is untouched.
 */
export const NOT_WITH_AN_AREAS_LIST: readonly Cap[] = ['sales-docs.totals', 'bills.totals', 'sales-docs.import', 'org.switch']

/**
 * FR-27.6 (D-5): whoever reads a product today reads its costs, so the legacy model grants `products.costs` with any
 * capability that opens a product route (`warehouse/product`'s read rule). A role may leave it out; the legacy
 * model cannot (`LEGACY_CANNOT_WITHHOLD`), so such a role's projection is not exact (`needsRelease`).
 */
const PRODUCT_READERS: readonly Cap[] = ['products.view', 'products.lookup', 'sales-docs.view', 'till.view']

/** What no legacy claim can withhold where it grants its feature: the projection holds it even when the role does not. */
export const LEGACY_CANNOT_WITHHOLD: readonly Cap[] = ['products.costs', ...PRICE_LEVEL_CAPS]

/** What a token says today: its role, its permissions, and FR-26's areas (absent: every area). */
export interface LegacyClaims {
  role?: string
  permissions?: readonly string[] | null
  areas?: readonly string[] | null
}

/** A permission set as `tokenize()` reads it. */
export interface LegacySet {
  permissions?: readonly string[] | null
  isAdmin?: boolean
  areas?: readonly string[] | null
  ownRecordsOnly?: Record<string, boolean | undefined> | null
}

/**
 * What `tokenize()` puts in a token today (`services/biz/auth.service.ts`), from a membership and the permission
 * sets of ITS org that it names: the one function both use, so FR-27's migration reads a person exactly as their
 * token does.
 *
 * Sets, when any resolves: the union of their permissions (every permission for an `isAdmin` set), their areas
 * merged (`mergeAreas`), and "own records only" for a module only when every set says so. Otherwise the role's
 * defaults, plus the user's own list, and the role's areas.
 */
export function legacyClaimsOf(
  user: { role: string; permissions?: readonly string[] | null },
  sets: readonly LegacySet[],
): { role: string; permissions: string[]; areas?: string[]; ownRecordsModules: string[] } {
  if (!sets.length) {
    const roleDefaults = DEFAULT_ROLE_PERMISSIONS[user.role as Role] || DEFAULT_ROLE_PERMISSIONS.member
    const areas = DEFAULT_ROLE_AREAS[user.role as Role]
    return {
      role: user.role,
      permissions: [...new Set([...roleDefaults, ...(user.permissions || [])])],
      ownRecordsModules: [],
      ...(areas ? { areas: [...areas] } : {}),
    }
  }
  const all = new Set<string>()
  for (const set of sets) for (const p of set.permissions ?? []) all.add(p)
  // "Own records only" for a module when a set says so, unless another set says it is not (most permissive wins).
  const own: string[] = []
  for (const set of sets) for (const [mod, on] of Object.entries(set.ownRecordsOnly ?? {})) if (on && !own.includes(mod)) own.push(mod)
  for (const set of sets) for (const [mod, on] of Object.entries(set.ownRecordsOnly ?? {})) if (!on && own.includes(mod)) own.splice(own.indexOf(mod), 1)
  const permissions = sets.some(s => s.isAdmin) ? [...PERMISSIONS] : [...all]
  const areas = mergeAreas(sets)
  return { role: user.role, permissions, ownRecordsModules: own, ...(areas ? { areas } : {}) }
}

/** Today's grant of these claims, as capabilities. `admin` holds everything, as on every route today. */
export function compileLegacy(claims: LegacyClaims | null | undefined): Grant {
  if (!claims) return { caps: new Set() }
  if (claims.role === 'admin') return ALL
  const caps = new Set<Cap>()
  for (const p of claims.permissions ?? []) for (const c of LEGACY_BRIDGE[p as Permission] ?? []) caps.add(c)
  for (const c of LEGACY_ROLE_CAPS[claims.role ?? ''] ?? []) caps.add(c)
  caps.add('org.switch')
  if (PRODUCT_READERS.some(c => caps.has(c))) for (const c of ['products.costs', ...PRICE_LEVEL_CAPS] as Cap[]) caps.add(c)
  if (Array.isArray(claims.areas)) {
    for (const c of [...caps]) {
      const area = areaOfCap(c)
      if (area && !claims.areas.includes(area)) caps.delete(c)
    }
    for (const c of NOT_WITH_AN_AREAS_LIST) caps.delete(c)
  }
  return { caps }
}
