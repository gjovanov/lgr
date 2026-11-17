import { claims, getOrg } from '../session/session'
import type { PageViewer } from '../nav/page-registry'
import { liveGrant, liveLanding } from '../access/live-grant'

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

export function orgIdFromStorage(): string {
  return getOrg()?.id || 'no-org'
}

/**
 * Who `canOpenPage` asks about: the session's grant and how it was signed in (`amr`). Null when signed out.
 *
 * FR-27 P3-5 (#529): the grant is the role's, live, as the sign-in answer and `/auth/me` last said (reactive: menus
 * follow an edit). The token carries no `role`, `permissions` or `areas` any more, and none is read from it: until
 * the grant is known (`accessSettled`) the viewer holds nothing, and the router waits for it (`whenAccessSettled`).
 */
export function sessionViewer(): PageViewer | null {
  const c = claims()
  const live = liveGrant()
  const landing = liveLanding()
  if (!c) return null
  return {
    amr: Array.isArray(c.amr) ? (c.amr as string[]) : undefined,
    ...(live ? { grant: live } : {}),
    // FR-27.4: the role's landing page.
    ...(landing ? { landing } : {}),
  }
}
