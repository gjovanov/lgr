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
  ['integration', { self: 'admin role' }],
  ['logo', { self: 'admin role' }],
]

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
