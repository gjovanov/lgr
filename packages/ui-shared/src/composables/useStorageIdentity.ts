/**
 * Per-user / per-org identity derived from what the SPA already persists in localStorage,
 * with no Pinia/app-store coupling — safe to import from ui-shared AND ui-shell.
 *
 * userId comes from the JWT payload in `lgr_token`; orgId from the persisted `lgr_org`.
 * These are the discriminators for per-user UI preference keys of the form
 * `lgr:<feature>:<userId>:<orgId>[:<...>]` (grid columns, app favorites, default warehouse…).
 */

export function jwtUserId(): string {
  try {
    const token = localStorage.getItem('lgr_token') || ''
    const payload = token.split('.')[1]
    if (!payload) return 'anon'
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')))
    return json.id || json._id || 'anon'
  } catch {
    return 'anon'
  }
}

export function orgIdFromStorage(): string {
  try {
    return JSON.parse(localStorage.getItem('lgr_org') || 'null')?.id || 'no-org'
  } catch {
    return 'no-org'
  }
}
