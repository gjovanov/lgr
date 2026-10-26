import { claims, getOrg } from '../session/session'
import type { PageViewer } from '../nav/page-registry'

/**
 * Per-user / per-org identity derived from this tab's session, with no Pinia/app-store
 * coupling — safe to import from ui-shared AND ui-shell.
 *
 * userId comes from the session token's payload; orgId from the session's org.
 * These are the discriminators for per-user UI preference keys of the form
 * `lgr:<feature>:<userId>:<orgId>[:<...>]` (grid columns, app favorites, default warehouse…).
 */

export function jwtUserId(): string {
  const c = claims()
  return c?.id || c?._id || 'anon'
}

/**
 * The signed-in user's role, straight from the JWT.
 *
 * The app store's `user` is populated by `login()` and by an explicit `/auth/me` call, so it is
 * `null` on a fresh page load — a view that gates admin-only controls on it would disable them
 * for an admin who simply reloaded. The token is the durable source. Returns '' when unknown;
 * the server re-checks the role on every mutation regardless.
 */
export function jwtRole(): string {
  return claims()?.role || ''
}

export function orgIdFromStorage(): string {
  return getOrg()?.id || 'no-org'
}

/**
 * Who `canOpenPage` asks about: the role, permissions and sign-in method the token carries.
 * Read from the token for the same reason as `jwtRole`. Null when signed out.
 */
export function sessionViewer(): PageViewer | null {
  const c = claims()
  if (!c) return null
  return {
    role: c.role,
    permissions: Array.isArray(c.permissions) ? c.permissions : [],
    amr: Array.isArray(c.amr) ? (c.amr as string[]) : undefined,
  }
}
