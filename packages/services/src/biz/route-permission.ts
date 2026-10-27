import type { Permission } from 'config/constants'

/**
 * What a write needs, by route (S-28).
 *
 * Until this module a role's permissions were enforced by the UI alone. Every route checked the
 * session, the org in the URL (#41) and the home (FR-20.4), and the accounting, invoicing, payroll
 * and warehouse controllers checked nothing more: a `member` or an `nra_auditor`, read-only by
 * design, could post journal entries, payroll runs and stock movements through the API.
 *
 * Every write under `/api/org/:orgId` resolves here to one of:
 *   - `need`: the caller must hold one of these permissions;
 *   - `self`: the controller guards the route itself, and the reason says how;
 *   - `member`: any member of the org may, and the reason says why.
 *
 * The auth plugins enforce `need` before the body is validated (`writeRefusal`), so a caller
 * without the permission learns nothing about the route's schema either. A write that resolves to
 * nothing is refused. `route-permission.flow.test.ts` walks the real route table and fails on such
 * a route, so a new controller cannot ship without a decision here.
 *
 * Import-pure: no Elysia, no database.
 */
export type WriteRule =
  | { readonly need: readonly Permission[] }
  | { readonly self: string }
  | { readonly member: string }

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const ORG_PREFIX = '/api/org/:orgId/'

/** `METHOD rest`, where `rest` is the route after `/api/org/:orgId/` with no trailing slash. */
export const EXACT_WRITE_RULES: ReadonlyMap<string, WriteRule> = new Map<string, WriteRule>([
  // The permission named for the step, where one exists.
  ['POST accounting/journal/:id/post', { need: ['accounting.post'] }],
  ['POST accounting/journal/:id/void', { need: ['accounting.post'] }],
  ['POST payroll/run/:id/approve', { need: ['payroll.approve'] }],

  // Reads sent as POSTs (`route-class.ts#READ_ONLY_WRITES`) and writes that decide for themselves.
  ['POST reports/:id/run', { self: 'canAccessReport: the report\'s own permission and roles; 404 for a report the caller may not see' }],
  ['POST reports/:id/export', { self: 'canExportReport, on top of canAccessReport' }],
  ['POST invoicing/export/list', { self: 'canExport' }],
  ['POST invoicing/export/kind/:kind', { self: 'canExport' }],
  ['POST invoicing/export/:id/email', { self: 'canWrite, and outgoing issued documents only' }],
  ['POST invoicing/stock-availability/check', { need: ['invoicing.read', 'inventory.read'] }],
  // FR-21.18: the journal's storno, from the POS app's /pos/orders or invoicing's /cash-sales. The
  // route also requires a storno role (admin, manager, warehouse_manager), as the till's does.
  ['POST cash-register/documents/:id/storno', { need: ['pos.write', 'invoicing.write'] }],
  ['POST doc-import/extract', { need: ['invoicing.write', 'inventory.write'] }],
  ['POST doc-import/analyze', { self: 'PERMISSION_BY_TARGET: the write permission of the surface imported into' }],
  ['POST doc-import/commit', { self: 'PERMISSION_BY_TARGET: the write permission of the surface imported into' }],
  ['POST doc-import/convert', { self: 'PERMISSION_BY_TARGET: the write permission of the surface imported into' }],

  // Shared vocabulary on products and contacts.
  ['POST tags', { need: ['invoicing.write', 'inventory.write'] }],
  ['PUT tags/:id', { need: ['invoicing.write', 'inventory.write'] }],
  ['DELETE tags/:id', { need: ['invoicing.write', 'inventory.write'] }],

  // What every member does for themselves.
  ['POST audit-logs', { member: 'a note on a record, attributed to its author; the controller accepts action `note` and nothing else' }],
  ['PUT notification/:id/read', { member: 'the caller\'s own notifications only (filtered on userId)' }],
  ['PUT notification/read-all', { member: 'the caller\'s own notifications only (filtered on userId)' }],
  ['POST file', { member: 'records the metadata of an upload; the row is the caller\'s own org\'s' }],
  // No UI removes a File row; it is housekeeping, and the row is evidence of what was uploaded.
  ['DELETE file/:id', { need: ['admin.settings'] }],

  // The org itself.
  ['PUT ', { self: 'admin role (org.controller)' }],
])

/** Route prefixes (after `/api/org/:orgId/`), longest first where they nest. */
export const PREFIX_WRITE_RULES: ReadonlyArray<readonly [string, WriteRule]> = [
  ['accounting', { need: ['accounting.write'] }],
  ['invoices', { need: ['invoicing.write'] }],
  // Includes `stock-availability/create-transfers`: the invoice form moves stock between
  // warehouses before it sells, and `sales` holds invoicing.write but not inventory.write.
  ['invoicing', { need: ['invoicing.write'] }],
  ['bills/import', { need: ['invoicing.write'] }],
  ['warehouse', { need: ['inventory.write'] }],
  ['payroll', { need: ['payroll.write'] }],
  ['trade/pos', { need: ['pos.write'] }],
  ['pos', { need: ['pos.write'] }],
  ['files', { self: 'files-api: admin, or admin.settings' }],
  ['fiscal', { self: 'FISCAL_ADMIN_ROLES: admin, manager, warehouse_manager' }],
  ['user', { self: 'admin role (S-21)' }],
  ['invite', { self: 'admin role' }],
  ['permission-sets', { self: 'admin role, or admin.settings' }],
  ['apps', { self: 'admin role' }],
  ['digest', { self: 'admin role' }],
  ['backup', { self: 'requireSysAdmin' }],
  ['desktops', { self: 'admin role, or admin.settings' }],
  ['nodes', { self: 'admin role, or admin.settings (FR-20.2; global only, 404 on a master)' }],
  ['moves', { self: 'admin role, or admin.settings (FR-20.79; global only, 404 on a master)' }],
  ['address', { self: 'admin role, or admin.settings (FR-20.72: asking for the org\x27s address on lgrai.app; global only, 404 on a master)' }],
  ['numbering', { self: 'admin role, or admin.settings (FR-20.51: the last numbers issued at a site; every node)' }],
  ['integration', { self: 'admin role' }],
  ['logo', { self: 'admin role' }],
]

const ACCOUNTING = ['accounting.read', 'accounting.write', 'accounting.post'] as const
const INVENTORY = ['inventory.read', 'inventory.write', 'inventory.adjust'] as const
const INVOICING = ['invoicing.read', 'invoicing.write', 'invoicing.send'] as const
const POS = ['pos.read', 'pos.write'] as const
const PAYROLL = ['payroll.read', 'payroll.write', 'payroll.approve'] as const

/**
 * What a read needs, by route (S-29), in the same three kinds as a write.
 *
 * Until these rules a role's permissions were enforced on reads by the UI alone, as they had been on
 * writes before S-28: any member of an org read its payroll, its ledgers and its audit trail through
 * the API, including a cashier (`sales`) and the tax inspector's account (`nra_auditor`).
 *
 * A module's reads name every permission of the module, since a role allowed to write it reads it.
 * Reference data that another app reads names that app's module too, and says which app: the
 * invoice form reads products, warehouses and bank accounts, the inventory app reads its suppliers,
 * the cash-sale terminal reads the POS catalog. Those were found by scanning every `*-ui` package
 * for the routes it calls; `read-permission.flow.test.ts` holds each default role to the reads its
 * apps make.
 *
 * Prefixes (after `/api/org/:orgId/`), longest first where they nest; a GET that resolves to nothing
 * is refused, and the flow test fails on it.
 */
export const PREFIX_READ_RULES: ReadonlyArray<readonly [string, WriteRule]> = [
  ['', { member: 'the org itself, as the app shell shows it (integration tokens are never serialised)' }],

  // Cash orders and payment orders in the invoicing app pick an account and a bank account.
  ['accounting/account', { need: [...ACCOUNTING, ...INVOICING] }],
  ['accounting/bank-account', { need: [...ACCOUNTING, ...INVOICING] }],
  ['accounting', { need: ACCOUNTING }],

  ['payroll', { need: PAYROLL }],

  // The supplier picker in inventory, the contact pickers of the reports, a POS customer.
  ['invoicing/contact', { need: [...INVOICING, ...INVENTORY, ...POS] }],
  // The import dialog (also opened from inventory's movements) offers an ORDO to book against.
  ['invoicing/orders', { need: [...INVOICING, ...INVENTORY] }],
  // #203: a product's stock, holds and incoming goods, on the inventory app's product page.
  ['invoicing/product-supply', { need: [...INVOICING, ...INVENTORY] }],
  ['invoicing/export', { self: 'canExport' }],
  ['invoicing/sequences', { self: 'admin or manager: the sequence configuration' }],
  ['invoicing', { need: INVOICING }],
  ['invoices', { need: INVOICING }],

  // The invoice form, the cash-sale terminal, the POS terminal and the report pickers.
  ['warehouse/product-category', { need: [...INVENTORY, ...INVOICING, ...POS] }],
  ['warehouse/product-ledger', { need: [...INVENTORY, ...INVOICING] }],
  ['warehouse/product', { need: [...INVENTORY, ...INVOICING, ...POS] }],
  ['warehouse/warehouse', { need: [...INVENTORY, ...INVOICING, ...POS] }],
  // A contact's stock movements, opened from the invoicing app.
  ['warehouse/movement', { need: [...INVENTORY, ...INVOICING] }],
  ['warehouse', { need: INVENTORY }],

  // The cash-sale terminal in the invoicing app sells from the POS catalog.
  ['trade/pos/catalog', { need: [...POS, ...INVOICING] }],
  // FR-21.12: the cash-register journal is the POS app's /pos/orders AND invoicing's /cash-sales.
  ['cash-register', { need: [...POS, ...INVOICING] }],
  ['trade/pos', { need: POS }],
  ['pos', { need: POS }],
  ['pricing', { need: [...INVOICING, ...POS, ...INVENTORY] }],

  ['stats/product', { need: [...INVENTORY, ...INVOICING] }],
  ['stats', { need: INVOICING }],
  ['dashboard', { need: [...INVOICING, ...ACCOUNTING, ...INVENTORY] }],
  ['doc-import', { need: [...INVOICING, ...INVENTORY] }],

  ['audit-logs', { self: 'auditReadScope: the whole trail needs admin.audit; anyone else reads the history of one record, of a module they read' }],
  ['reports', { self: 'canAccessReport: the catalog lists only what the caller may run' }],
  ['supto', { self: 'admin or nra_auditor' }],
  ['fiscal', { member: 'device names and states, for the tills; connection details only for FISCAL_ADMIN_ROLES (sanitizeDevice)' }],
  ['file', { need: ['admin.settings'] }],
  ['files', { self: 'files-api: admin, or admin.settings; the archives also for nra_auditor' }],
  ['digest', { self: 'admin role (FR-11): admin.settings deliberately does not suffice' }],
  ['backup', { self: 'requireSysAdmin' }],
  ['desktops', { self: 'admin role, or admin.settings' }],
  ['nodes', { self: 'admin role, or admin.settings (FR-20.2; global only, 404 on a master)' }],
  ['moves', { self: 'admin role, or admin.settings (FR-20.79; global only, 404 on a master)' }],
  ['address', { self: 'admin role, or admin.settings (FR-20.72: the org\x27s address on lgrai.app; global only, 404 on a master)' }],
  ['numbering', { self: 'admin role, or admin.settings (FR-20.51: whether legal numbering waits, and the series; every node)' }],
  ['server', { self: "admin role, or admin.settings (FR-20.98: a master's own status page, 404 on lgrai.app); `here` tells any member only whether to show it" }],
  ['integration', { self: 'admin role' }],
  ['invite', { self: 'admin role' }],
  ['permission-sets', { self: 'admin role, or admin.settings' }],

  ['apps', { member: 'the app hub, filtered by what the caller may open' }],
  ['licence', { member: "this server's licence for the org, for the banner and the till (FR-20.55); nothing in it is secret" }],
  ['home', { member: 'where the org lives and whether it is written here, for the read-only banner (FR-20.75); nothing in it is secret' }],
  ['notification', { member: "the caller's own notifications only (filtered on userId)" }],
  ['tags', { member: 'the tag vocabulary products and contacts share' }],
  ['logo', { member: "the org's logo in the app shell" }],
  ['user', { member: "colleagues' names and roles, for pickers and assignments; credentials are projected out (FR-11.3)" }],
]

/** A route a prefix would give too much, checked before the prefixes. */
export const EXACT_READ_RULES: ReadonlyMap<string, WriteRule> = new Map<string, WriteRule>([
  // A contact's amounts due and paid: the invoicing app's, not the pickers'.
  ['invoicing/contact/:id/summary', { need: INVOICING }],
])

/** The rule for a read route; `undefined` when there is none (refused, and a failing test). */
export function readRuleFor(route: string): WriteRule | undefined {
  const rest = orgRouteRest(route)
  if (rest === null) return undefined
  const exact = EXACT_READ_RULES.get(rest)
  if (exact) return exact
  for (const [prefix, rule] of PREFIX_READ_RULES) {
    if (prefix === '' ? rest === '' : rest === prefix || rest.startsWith(`${prefix}/`)) return rule
  }
  return undefined
}

/** The part of an org route after `/api/org/:orgId/`, without a trailing slash; null off org routes. */
export function orgRouteRest(route: string): string | null {
  const path = route.startsWith('/api/') ? route : `/api${route.startsWith('/') ? '' : '/'}${route}`
  if (path === '/api/org/:orgId' || path === '/api/org/:orgId/') return ''
  if (!path.startsWith(ORG_PREFIX)) return null
  return path.slice(ORG_PREFIX.length).replace(/\/+$/, '')
}

/** The rule for a write route; `undefined` when there is none (refused, and a failing test). */
export function writeRuleFor(method: string, route: string): WriteRule | undefined {
  const rest = orgRouteRest(route)
  if (rest === null) return undefined
  const exact = EXACT_WRITE_RULES.get(`${method.toUpperCase()} ${rest}`)
  if (exact) return exact
  for (const [prefix, rule] of PREFIX_WRITE_RULES) {
    if (rest === prefix || rest.startsWith(`${prefix}/`)) return rule
  }
  return undefined
}

interface Caller {
  role?: string
  permissions?: readonly string[]
}

/**
 * Why this caller may not make this request, or null when they may. Reads, routes outside an org,
 * and requests without a caller (the 401 is the auth plugin's) are never refused here.
 *
 * ⚠ `admin` always passes, as in `canWrite`: a permission set that lacked a write would otherwise
 * lock an org's owner out of their own data, with nobody left who could fix the set.
 */
export function writeRefusal(
  user: Caller | null | undefined,
  method: string,
  route: string,
): { message: string; code: 'permission_required'; permissions?: readonly string[] } | null {
  if (!user || READ_METHODS.has(method.toUpperCase())) return null
  if (orgRouteRest(route) === null) return null
  if (user.role === 'admin') return null
  const rule = writeRuleFor(method, route)
  if (!rule) return { message: 'This route has no permission rule', code: 'permission_required' }
  if (!('need' in rule)) return null
  const held = user.permissions ?? []
  if (rule.need.some(p => held.includes(p))) return null
  return { message: `Permission required: ${rule.need.join(' or ')}`, code: 'permission_required', permissions: rule.need }
}

/** The methods a read rule governs. OPTIONS carries no session (a CORS preflight), so it is not one. */
const GUARDED_READS = new Set(['GET', 'HEAD'])

/**
 * Why this caller may not make this READ, or null when they may (S-29). The same shape and the
 * same exemptions as `writeRefusal`: routes outside an org, requests without a caller, and `admin`.
 */
export function readRefusal(
  user: Caller | null | undefined,
  method: string,
  route: string,
): { message: string; code: 'permission_required'; permissions?: readonly string[] } | null {
  if (!user || !GUARDED_READS.has(method.toUpperCase())) return null
  if (orgRouteRest(route) === null) return null
  if (user.role === 'admin') return null
  const rule = readRuleFor(route)
  if (!rule) return { message: 'This route has no permission rule', code: 'permission_required' }
  if (!('need' in rule)) return null
  const held = user.permissions ?? []
  if (rule.need.some(p => held.includes(p))) return null
  return { message: `Permission required: ${rule.need.join(' or ')}`, code: 'permission_required', permissions: rule.need }
}

/**
 * What a PIN session reaches (FR-20.40, plan step P1-5): the till, and nothing else.
 *
 * A PIN is six digits typed at a counter, where anyone may see it. It must not open what the
 * person's password opens: the read rules (S-29) are per module, and a manager's PIN would
 * otherwise read the ledgers. So a session the PIN made (`amr: ['pin']`) reaches the POS terminal's
 * routes only, whatever the role, `admin` included. Its role still counts inside them, so a
 * manager's PIN can authorise a storno.
 *
 * ⚠ Outside the org routes only `me` and `logout`: `/auth/switch` would mint a FULL session in
 * another org from a PIN session.
 */
export const PIN_SCOPE_ORG: readonly string[] = [
  '', 'apps', 'notification', 'logo', 'licence', 'home', 'trade/pos', 'pos', 'fiscal', 'pricing', 'tags',
  'warehouse/product-category', 'warehouse/warehouse',
  // FR-21.12: the till's own journal (/pos/orders), and its storno (FR-21.18): a manager's PIN
  // reverses a sale there as it does at the till, the role still checked by the route.
  'cash-register',
]
// The PIN pad itself too: the next operator signs in while the last one's PIN session is attached.
export const PIN_SCOPE_OTHER: ReadonlySet<string> = new Set([
  'GET /api/auth/me', 'POST /api/auth/logout', 'GET /api/auth/local/methods', 'POST /api/auth/local/pin',
])

interface ScopedCaller extends Caller {
  amr?: readonly string[]
}

export function pinScopeRefusal(
  user: ScopedCaller | null | undefined,
  method: string,
  route: string,
): { message: string; code: 'pin_session_scope' } | null {
  if (!user?.amr?.includes('pin')) return null
  const m = method.toUpperCase()
  const path = route.startsWith('/api/') ? route : `/api${route.startsWith('/') ? '' : '/'}${route}`
  if (PIN_SCOPE_OTHER.has(`${m} ${path}`)) return null
  const rest = orgRouteRest(path)
  if (rest !== null && PIN_SCOPE_ORG.some(p => (p === '' ? rest === '' && READ_METHODS.has(m) : rest === p || rest.startsWith(`${p}/`)))) {
    return null
  }
  return { message: 'A PIN signs in to the till only. Sign in with your password for the rest.', code: 'pin_session_scope' }
}

/**
 * The one check the auth plugins run on every request: a PIN session's scope first, then the read
 * rules for a read, else the write rules.
 */
export function permissionRefusal(
  user: ScopedCaller | null | undefined,
  method: string,
  route: string,
): { message: string; code: 'permission_required' | 'pin_session_scope'; permissions?: readonly string[] } | null {
  return pinScopeRefusal(user, method, route)
    ?? (READ_METHODS.has(method.toUpperCase()) ? readRefusal(user, method, route) : writeRefusal(user, method, route))
}

/** The modules of an audit entry (`AuditLog.module`) and what reading them needs. */
const AUDIT_MODULE_READ: Readonly<Record<string, readonly Permission[]>> = {
  accounting: ACCOUNTING,
  invoicing: INVOICING,
  warehouse: INVENTORY,
  payroll: PAYROLL,
  pos: POS,
  // The merged trade module wrote the POS storno, and the fiscal devices are run by the tills.
  trade: [...POS, ...INVOICING, ...INVENTORY],
  fiscal: [...POS, ...INVENTORY],
}

/**
 * What of the audit trail this caller may read: all of it (`admin`, or `admin.audit`), or the
 * history of single records in these modules. Entries of `admin`, `auth`, `files` and `system`
 * are the trail's own business and appear only in the whole of it.
 */
export function auditReadScope(user: Caller | null | undefined): 'all' | string[] {
  if (!user) return []
  if (user.role === 'admin' || (user.permissions ?? []).includes('admin.audit')) return 'all'
  const held = user.permissions ?? []
  return Object.entries(AUDIT_MODULE_READ).filter(([, need]) => need.some(p => held.includes(p))).map(([m]) => m)
}
