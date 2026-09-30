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

/**
 * The cookie that carries a one-time SIGN-UP handoff code from the OAuth callback (register
 * mode) to the register form. It replaced `…/auth/register?oauth_token=<JWT>`.
 *
 * ⚠ Renaming this breaks any sign-up already in flight. There is no reason to.
 */
export const PENDING_COOKIE = 'oauth_pending'

/**
 * ⚠ `path: '/api/oauth/pending'`: the cookie is sent ONLY to the register form's two requests
 * (`GET` the prefill, `POST …/register`) and rides on nothing else on the site.
 *
 * ⚠ `sameSite: 'lax'`, for the same reason as `oauth_handoff`: it is set on the callback, which
 * arrives as a top-level navigation from the provider, and read by same-origin requests.
 *
 * Thirty minutes, matching `PENDING_REGISTRATION_TTL_MS`: a person fills in a form in between,
 * which a two-minute sign-in handoff would not survive. The server-side record expires on the
 * same clock, and the cookie is cleared as soon as the sign-up completes.
 */
export const pendingCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,
  path: '/api/oauth/pending',
  maxAge: 30 * 60,
}
