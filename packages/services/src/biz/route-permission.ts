import { NOTHING, can, type CapabilityId, type Grant } from 'config/access'

/**
 * What an org route needs is `config/access/routes.ts`, asked by `access/evaluate.ts#accessRefusal` (FR-27.2). This
 * module keeps what is not a route rule: an org route's path (`orgRouteRest`), a PIN session's scope (FR-20.40), and
 * the two questions a controller asks of a session's grant here (`holdsPersonal`, `auditReadScope`).
 *
 * FR-27 P3-6 (#529): the legacy rule lists (`EXACT_*` / `PREFIX_*_RULES`, by permission), FR-26's area prefixes and
 * `permissionRefusal` are gone with the legacy model. `route-permission.flow` and `read-permission.flow` hold every
 * route to a capability rule instead.
 *
 * Import-pure: no Elysia, no database.
 */

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const ORG_PREFIX = '/api/org/:orgId/'

/** The part of an org route after `/api/org/:orgId/`, without a trailing slash; null off org routes. */
export function orgRouteRest(route: string): string | null {
  const path = route.startsWith('/api/') ? route : `/api${route.startsWith('/') ? '' : '/'}${route}`
  if (path === '/api/org/:orgId' || path === '/api/org/:orgId/') return ''
  if (!path.startsWith(ORG_PREFIX)) return null
  return path.slice(ORG_PREFIX.length).replace(/\/+$/, '')
}

interface Caller {
  /** A session's person and org, and its role's grant (FR-27 P3-5). */
  id?: string
  orgId?: string
  access?: Grant
}

/**
 * The session's grant, as `access/evaluate.ts#grantOf` reads it (not imported: evaluate imports this file): the
 * role's, attached by the auth plugins; a session without one holds nothing.
 */
function grantOfCaller(user: Caller | null | undefined): Grant {
  return user?.access ?? NOTHING
}

/**
 * FR-25 §3.11: may this caller see or change anything about one person? `payroll.read` is a run's
 * totals and answers no. For what a route's rule cannot say: a field of a response, a write that
 * needs this on top of `payroll.write`. FR-27 P3-5: the grant's `payroll-people.view`.
 */
export function holdsPersonal(user: Caller): boolean {
  return can(grantOfCaller(user), 'payroll-people.view')
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
  // FR-21.12: the till's own journal (/invoicing/cash-sales), and its storno (FR-21.18): a manager's PIN
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
 * The modules of an audit entry (`AuditLog.module`) and what reading them needs, as capabilities (FR-27 P3-5, #529):
 * what each legacy permission group gave every holder (`config/access/legacy.ts#LEGACY_BRIDGE`), so a built-in role
 * reads the same modules as before.
 */
const INVENTORY_READS: readonly CapabilityId[] = (['products', 'categories', 'warehouses', 'movements', 'stock-levels', 'inventory-counts', 'valuation', 'opening-stock', 'price-lists', 'bulk-pricing'] as const)
  .flatMap(f => [`${f}.view`, `${f}.lookup`] as CapabilityId[])
const AUDIT_MODULE_CAPS: Readonly<Record<string, readonly CapabilityId[]>> = {
  accounting: (['accounts', 'bank-accounts', 'journal', 'ledgers', 'vat', 'accounting-setup', 'exchange-rates', 'reconciliation', 'fixed-assets'] as const)
    .flatMap(f => [`${f}.view`, `${f}.lookup`] as CapabilityId[]),
  invoicing: ['sales-docs.view', 'proforma.view', 'bills.view', 'orders.view', 'payments.view', 'contacts.view'],
  warehouse: INVENTORY_READS,
  payroll: ['payroll-runs.view', 'payroll-runs.lookup'],
  pos: ['till.view'],
  // The merged trade module wrote the POS storno, and the fiscal devices are run by the tills.
  trade: ['till.view', 'sales-docs.view', 'proforma.view', 'bills.view', 'orders.view', 'payments.view', 'contacts.view', ...INVENTORY_READS],
  fiscal: ['till.view', ...INVENTORY_READS],
}

/**
 * What of the audit trail this caller may read: all of it (`audit-log.view`; the Administrator), or the history of
 * single records in these modules. Entries of `admin`, `auth`, `files` and `system` are the trail's own business and
 * appear only in the whole of it. FR-27 P3-5: asked of the session's grant.
 */
export function auditReadScope(user: Caller | null | undefined): 'all' | string[] {
  if (!user) return []
  const grant = grantOfCaller(user)
  if (can(grant, 'audit-log.view')) return 'all'
  return Object.entries(AUDIT_MODULE_CAPS).filter(([, need]) => can(grant, need)).map(([m]) => m)
}
