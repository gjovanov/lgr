import { config } from 'config'
import type { UserTokenized } from './auth.service.js'

/**
 * What a request presents as its session, and what counts as one. Used by the eight auth plugins
 * (`portal-api/src/auth/auth.service.ts` and `services/http/app-auth.service.ts`, the one domain plugin (FR-24.30)), so the rule
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
 * Whether a request comes from another origin of the same site: a sibling subdomain's page.
 *
 * Such a request never authenticates by cookie (FR-20.72). An org's address is same-site with
 * lgrai.app, so its pages could otherwise make the person's browser send their lgrai.app session
 * along.
 *   - `Sec-Fetch-Site` decides when the browser sends it, which every current one does; page script
 *     cannot forge it.
 *   - A browser that sends none falls back to `Origin`: another origin of the site the SPAs are
 *     served from (`appOrigin`, `OAUTH_FRONTEND_URL`) is refused the same way. `Origin` comes with
 *     every credentialed cross-origin fetch and every cross-origin write.
 *   - A client that sends neither (a script) is unaffected, and so is a cross-site top-level
 *     navigation such as the OAuth callback.
 */
export function isSameSiteRequest(
  headers: Record<string, string | undefined> | undefined,
  appOrigin: string = config.oauth.frontendUrl,
): boolean {
  const fetchSite = (headers?.['sec-fetch-site'] ?? '').trim().toLowerCase()
  if (fetchSite) return fetchSite === 'same-site'
  const origin = headers?.origin
  return origin ? isOtherOriginOfSameSite(origin, appOrigin) : false
}

/**
 * `origin` is not `appOrigin` but shares its site: the same host on another scheme or port, or a
 * subdomain of the app's host. ⚠ The app's host is taken as the site, which holds for lgrai.app (an
 * apex domain). Served from `www.` it would also need the sibling subdomains of the parent.
 */
export function isOtherOriginOfSameSite(origin: string, appOrigin: string): boolean {
  let o: URL, a: URL
  try { o = new URL(origin); a = new URL(appOrigin) } catch { return false }
  if (o.origin === a.origin) return false
  return o.hostname === a.hostname || o.hostname.endsWith(`.${a.hostname}`)
}

/**
 * The session cookie a request presents: `__Host-auth`, and nothing at all on a same-site request.
 *
 * ⚠ The plain `auth` name is no longer read (P0a-8 release N+1, 2026-10-24): a subdomain CAN plant
 * a plain cookie for lgrai.app, which is why this had to ship before any org address serves a
 * master (plan P3-4). Release N wrote both names for one release, so no live session lost its cookie.
 */
export function sessionCookieValue(
  cookie: Record<string, { value?: unknown } | undefined> | undefined,
  headers: Record<string, string | undefined> | undefined,
): unknown {
  if (isSameSiteRequest(headers)) return undefined
  return cookie?.[SESSION_COOKIE]?.value
}

/**
 * The token a request presents.
 *
 * ⚠ A NON-EMPTY `Authorization` header is used exclusively. The session cookie is only a fallback
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
