import { isSameSiteRequest } from 'services/biz/session-token'

/**
 * The three cookies an OAuth flow carries between its requests: the `state` nonce, the sign-in
 * handoff code and the sign-up handoff code. Two controllers share them (`oauth.controller` sets
 * them, `oauth.controller` and `auth.controller` consume them), so the names and the options live
 * in one place. A cookie whose setter and reader disagree fails silently, as a login that "just
 * doesn't finish".
 *
 * ## `__Host-`, and what it costs (FR-20.72, plan step P0a-8)
 *
 * Each is written as `__Host-<name>`: `Secure`, `Path=/`, no `Domain`. A page on a subdomain of
 * lgrai.app (an org's address) can then neither plant nor overwrite one. A planted handoff code
 * would sign the visitor into the planter's account, and everything they then entered would land
 * there.
 *
 * The price is the narrow paths these cookies used to have (`/api/oauth`, `/api/auth`,
 * `/api/oauth/pending`): the prefix requires `Path=/`, so for their few minutes of life they ride on
 * every request to lgrai.app. They are httpOnly, `SameSite=Lax` and single use, so that buys an
 * attacker nothing that planting would not have bought more.
 *
 * ⚠ For ONE release (P0a-8 release N) each is also written and read under its old plain name and
 * path, so a flow that starts before a deploy (or a rollback) and ends after it still finishes.
 * Release N+1 drops the plain names.
 *
 * ## `SameSite=Lax`, never `Strict`
 *
 * The callback arrives as a top-level navigation from the provider's domain, a cross-site request,
 * and a strict cookie is withheld on exactly those. The flow would fail for every legitimate user
 * while a lax cookie rides along on the GET navigation as intended. The two handoff cookies are SET
 * on that navigation and read by same-origin requests from the SPA.
 */
export interface FlowCookie {
  /** The `__Host-` name, written with `Secure` and `Path=/`, as the prefix requires. */
  readonly name: string
  /** The plain name and the path it had, written and read for one release only. */
  readonly legacy: string
  readonly legacyPath: string
  readonly maxAge: number
  /**
   * Whether a same-site request may present it. The handoff codes are read only by lgrai.app's own
   * pages (same-origin), so a sibling subdomain's request never gets to spend one. The `state`
   * nonce is read on the provider's redirect, which is cross-site in production but same-site
   * against a local fake provider; it is compared with the `state` the provider echoes, so it
   * cannot be spent anyway.
   */
  readonly sameSiteAllowed: boolean
}

/** The nonce that makes `state` mean something. Ten minutes: consumed by the callback. */
export const OAUTH_STATE: FlowCookie = {
  name: '__Host-oauth_state', legacy: 'oauth_state', legacyPath: '/api/oauth', maxAge: 600, sameSiteAllowed: true,
}

/**
 * The one-time sign-in handoff code, from the callback to `POST /api/auth/oauth-code/redeem`.
 * Two minutes: one redirect plus one POST. A flow nobody finishes must not leave a redeemable code
 * in the browser, and the server-side record expires on the same clock.
 */
export const OAUTH_HANDOFF: FlowCookie = {
  name: '__Host-oauth_handoff', legacy: 'oauth_handoff', legacyPath: '/api/auth', maxAge: 120, sameSiteAllowed: false,
}

/**
 * The one-time sign-UP handoff code, from the callback (register mode) to the register form. It
 * replaced `…/auth/register?oauth_token=<JWT>`. Thirty minutes, matching
 * `PENDING_REGISTRATION_TTL_MS`: a person fills in a form in between.
 */
export const OAUTH_PENDING: FlowCookie = {
  name: '__Host-oauth_pending', legacy: 'oauth_pending', legacyPath: '/api/oauth/pending', maxAge: 30 * 60, sameSiteAllowed: false,
}

/** An Elysia cookie jar, as far as these helpers need it. */
type CookieJar = Record<string, { value?: unknown; set: (options: Record<string, unknown>) => unknown }>

const legacySecure = () => process.env.NODE_ENV === 'production'

export function setFlowCookie(cookie: CookieJar, c: FlowCookie, value: string): void {
  cookie[c.name].set({ value, httpOnly: true, sameSite: 'lax', secure: true, path: '/', maxAge: c.maxAge })
  cookie[c.legacy].set({ value, httpOnly: true, sameSite: 'lax', secure: legacySecure(), path: c.legacyPath, maxAge: c.maxAge })
}

/** The value a request presents, `__Host-` name first. */
export function readFlowCookie(
  cookie: CookieJar,
  c: FlowCookie,
  headers: Record<string, string | undefined> | undefined,
): string | undefined {
  if (!c.sameSiteAllowed && isSameSiteRequest(headers)) return undefined
  const host = cookie[c.name]?.value
  if (typeof host === 'string' && host) return host
  const plain = cookie[c.legacy]?.value
  return typeof plain === 'string' && plain ? plain : undefined
}

/**
 * Expire both names, each with the attributes it was set with.
 *
 * ⚠ Never `cookie.x.remove()`: it sends no `Path` and no `Secure`. A browser ignores a `__Host-`
 * cookie without them, and applies a plain one to the request's default path, which is another
 * cookie when the route sits elsewhere.
 */
export function clearFlowCookie(cookie: CookieJar, c: FlowCookie): void {
  const gone = { value: '', httpOnly: true, sameSite: 'lax', maxAge: 0, expires: new Date(0) }
  cookie[c.name].set({ ...gone, secure: true, path: '/' })
  cookie[c.legacy].set({ ...gone, secure: legacySecure(), path: c.legacyPath })
}
