/**
 * The cookie that carries a one-time sign-in handoff code from the OAuth callback to the SPA.
 *
 * Two controllers share it — `oauth.controller` sets it, `auth.controller` consumes it — so the
 * name and the options live in one place. A handoff whose setter and reader disagree about the
 * path fails silently, as a login that "just doesn't finish".
 */

/** ⚠ Renaming this breaks any redirect already in flight. There is no reason to. */
export const HANDOFF_COOKIE = 'oauth_handoff'

/**
 * ⚠ `path: '/api/auth'` — so the cookie is sent ONLY to the redeem endpoint and rides on no
 * other request on the site. That is also why the redeem lives under `/api/auth/...` rather
 * than beside the rest of the OAuth routes: a cookie scoped to `/api/auth` is not sent to
 * `/api/oauth`.
 *
 * ⚠ `sameSite: 'lax'`, matching `oauth_state` and for the same reason: it is set on a redirect
 * that arrives as a top-level navigation, and it is read by a same-origin POST. `'strict'`
 * would be withheld on the navigation that sets it up.
 *
 * Two minutes: one redirect plus one POST. A flow nobody finishes must not leave a redeemable
 * code in the browser, and the server-side record expires on the same clock.
 */
export const handoffCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/api/auth',
  maxAge: 120,
}
