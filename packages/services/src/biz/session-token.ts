import type { UserTokenized } from './auth.service.js'

/**
 * What a request presents as its session, and what counts as one. Used by the eight auth plugins
 * (`portal-api/src/auth/auth.service.ts` and the seven `app-auth.service.ts` copies), so the rule
 * cannot drift between them. Import-pure: no Elysia, no database.
 */

/**
 * The session cookie's name (FR-20.72, plan step P0a-8).
 *
 * `__Host-` makes the browser accept the cookie only from this host, `Secure`, with `Path=/` and no
 * `Domain`. A page on a subdomain of lgrai.app (an org's address, `<org slug>.lgrai.app`, which a
 * customer's own server answers) can therefore neither plant nor overwrite it.
 */
export const SESSION_COOKIE = '__Host-auth'

/**
 * ⚠ The plain name, read and written for ONE release (P0a-8 release N): a session issued before it
 * keeps working, and a rollback keeps its sessions. Release N+1 stops both, and must ship before any
 * org address serves a master (plan P3-4): a subdomain CAN plant a plain cookie for lgrai.app.
 */
export const LEGACY_SESSION_COOKIE = 'auth'

/**
 * Whether a request comes from another origin of the same site: a sibling subdomain's page.
 *
 * Such a request never authenticates by cookie (FR-20.72). An org's address is same-site with
 * lgrai.app, so its pages could otherwise make the person's browser send their lgrai.app session
 * along. `Sec-Fetch-Site` is set by the browser and page script cannot forge it. A client that sends
 * none (an older browser, a script) is unaffected, and neither is a cross-site top-level navigation
 * such as the OAuth callback.
 */
export function isSameSiteRequest(headers: Record<string, string | undefined> | undefined): boolean {
  return (headers?.['sec-fetch-site'] ?? '').trim().toLowerCase() === 'same-site'
}

/**
 * The session cookie a request presents: `__Host-auth`, else (for one release) the plain `auth`,
 * and nothing at all on a same-site request.
 */
export function sessionCookieValue(
  cookie: Record<string, { value?: unknown } | undefined> | undefined,
  headers: Record<string, string | undefined> | undefined,
): unknown {
  if (isSameSiteRequest(headers)) return undefined
  const host = cookie?.[SESSION_COOKIE]?.value
  if (typeof host === 'string' && host) return host
  return cookie?.[LEGACY_SESSION_COOKIE]?.value
}

/**
 * The token a request presents.
 *
 * ⚠ A NON-EMPTY `Authorization` header is used exclusively. The `auth` cookie is only a fallback
 * for a request that sends no header at all (a top-level navigation, the desktop redeem). The order
 * used to be the reverse, `cookie || header`: every SPA sends a bearer token from its own storage,
 * no UI ever calls `POST /auth/logout`, so an old cookie silently replaced the token the caller had
 * chosen and the request ran as whoever the cookie named. Two orgs in two tabs, each with its own
 * token and one shared cookie, cannot work on top of that.
 *
 * ⚠ An invalid or expired bearer token is NOT rescued by the cookie. It answers 401, so a token the
 * caller chose is never swapped for one they did not.
 *
 * An empty `Bearer ` (some scripts send it on login) counts as no header. A header without the
 * `Bearer ` prefix is taken as the raw token, as before.
 */
export function pickSessionToken(authorization: string | undefined, cookieValue: unknown): string {
  const raw = (authorization ?? '').trim()
  const fromHeader = /^bearer\s/i.test(raw) ? raw.slice(7).trim() : /^bearer$/i.test(raw) ? '' : raw
  if (fromHeader) return fromHeader
  return typeof cookieValue === 'string' ? cookieValue : ''
}

/**
 * The claims of a verified token, if they are a SESSION's, else `null`.
 *
 * A valid signature says the token came from this server, not that it is a session: until S-19 the
 * `oauth_pending` JWT, signed with the same secret and carrying neither `id` nor `orgId`, passed
 * every guard as a signed-in user. A session has a string `id` and `orgId`, and no `type`, which is
 * the field other token kinds carry.
 */
export function asSessionUser(payload: unknown): UserTokenized | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  if (typeof p.id !== 'string' || !p.id) return null
  if (typeof p.orgId !== 'string' || !p.orgId) return null
  if ('type' in p) return null
  return p as unknown as UserTokenized
}
