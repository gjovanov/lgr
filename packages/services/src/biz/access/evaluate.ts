import { accessRuleFor, can as grantCan, compileLegacy, sortRefusal as fieldSortRefusal, type CapabilityId, type Grant, type LegacyClaims } from 'config/access'
import { orgRouteRest, permissionRefusal, pinScopeRefusal } from '../route-permission'

/**
 * FR-27.2 — the one evaluator (#529).
 *
 * Phase 0: a session's grant is compiled from its token's legacy claims (`compileLegacy`), so it decides exactly
 * what `route-permission.ts#permissionRefusal` decides. It runs beside it in shadow (`./shadow.ts`), and the
 * controllers' own checks move onto `can()` slice by slice. Phase 1 resolves the grant from the person's role.
 *
 * Import-pure apart from config: no Elysia, no database.
 */

export interface AccessCaller extends LegacyClaims {
  amr?: readonly string[]
  /** FR-27.5: the grant of the session's role, attached by the auth plugins for an org on `roles` (`./live.ts`). */
  readonly access?: Grant
}

const MAX_MEMO = 5_000
const memo = new Map<string, Grant>()

/** The grant a session's claims compile to, memoised: the auth plugins ask on every request. */
export function grantOf(user: AccessCaller | null | undefined): Grant {
  if (!user) return compileLegacy(null)
  // An org on `roles`: the role's grant, read live. Otherwise what the token's claims compile to.
  if (user.access) return user.access
  const key = `${user.role ?? ''}|${(user.permissions ?? []).join(',')}|${Array.isArray(user.areas) ? user.areas.join(',') : '*'}`
  let grant = memo.get(key)
  if (!grant) {
    if (memo.size >= MAX_MEMO) memo.clear()
    grant = compileLegacy(user)
    memo.set(key, grant)
  }
  return grant
}

/** May this session do this? The one question controllers ask (FR-27.2). */
export function can(user: AccessCaller | null | undefined, cap: CapabilityId | readonly CapabilityId[]): boolean {
  return !!user && grantCan(grantOf(user), cap)
}

export type AccessRefusal =
  | { message: string; code: 'permission_required'; capabilities?: readonly CapabilityId[] }
  | { message: string; code: 'pin_session_scope' }

/**
 * Why this session may not make this request, or null when it may. The same exemptions as `permissionRefusal`:
 * routes outside an org, a request without a caller (the 401 is the auth plugin's) and an OPTIONS preflight.
 * A PIN session's scope first, unchanged (FR-20.40).
 */
export function accessRefusal(user: AccessCaller | null | undefined, method: string, route: string): AccessRefusal | null {
  const pin = pinScopeRefusal(user, method, route)
  if (pin) return pin
  const m = method.toUpperCase()
  if (!user || m === 'OPTIONS') return null
  const path = route.startsWith('/api/') ? route : `/api${route.startsWith('/') ? '' : '/'}${route}`
  const rest = orgRouteRest(path)
  if (rest === null) return null
  const grant = grantOf(user)
  if (grant.all) return null
  const rule = accessRuleFor(m, rest)
  if (!rule) return { message: 'This route has no permission rule', code: 'permission_required' }
  if (!('anyOf' in rule) || grantCan(grant, rule.anyOf)) return null
  return { message: `Not part of your role: ${rule.anyOf.join(' or ')}`, code: 'permission_required', capabilities: rule.anyOf }
}

/**
 * The one decision the auth plugins take on every request (FR-27.5): an org on `roles` (a session carrying its
 * role's `access`) is decided by the evaluator; any other by the legacy rules, as before Phase 1.
 */
/**
 * FR-27.11.C.3: a list sorted by a figure the session's role does not see is refused, on every route, by the auth
 * plugins (so no list route can forget it). The legacy model grants every level: only a role is ever refused.
 */
export function sortAccessRefusal(user: AccessCaller | null | undefined, url: string) {
  if (!user) return null
  let sortBy: string | null = null
  try { sortBy = new URL(url, 'http://local').searchParams.get('sortBy') } catch { return null }
  return sortBy ? fieldSortRefusal(grantOf(user), sortBy) : null
}

/**
 * S-28's order for a route whose controller decides (`self`): a caller holding none of the rule's `floor` is refused
 * here, before the body is validated, so it never learns the body's shape from a 422. Asked of the session's grant,
 * the one the controllers' `can()` asks, in either model. Null where the rule names no floor.
 */
export function floorRefusal(user: AccessCaller | null | undefined, method: string, route: string): AccessRefusal | null {
  if (!user || method.toUpperCase() === 'OPTIONS') return null
  const path = route.startsWith('/api/') ? route : `/api${route.startsWith('/') ? '' : '/'}${route}`
  const rest = orgRouteRest(path)
  if (rest === null) return null
  const rule = accessRuleFor(method, rest)
  if (!rule || !('self' in rule) || !rule.floor?.length) return null
  const grant = grantOf(user)
  if (grant.all || grantCan(grant, rule.floor)) return null
  return { message: `Not part of your role: ${rule.floor.join(' or ')}`, code: 'permission_required', capabilities: rule.floor }
}

export function decideAccess(user: AccessCaller | null | undefined, method: string, route: string) {
  return user?.access ? accessRefusal(user, method, route) : permissionRefusal(user as any, method, route)
}
