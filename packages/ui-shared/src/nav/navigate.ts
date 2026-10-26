import { APP_NAV_META, type PageDef } from './page-registry'
import { orgPickerPath, signInPath } from './return-path'
import { getOrg, getToken, isPersonOnly, onSignedOutElsewhere, setSession, type SessionOrg } from '../session/session'

/**
 * Navigate to a page that may live in a DIFFERENT app (each domain UI is its own SPA).
 * - Production / unified dev (one origin serves every app): plain same-origin location change.
 * - Local per-app Vite dev (ports 40xx): cross-origin → target that app's own dev server,
 *   carrying this tab's session in the query (storage isn't shared cross-origin).
 */
export function navigateToPage(page: PageDef) {
  window.location.href = appHref(page.appId, page.path)
}

/**
 * The same resolution as `navigateToPage`, but returning the URL instead of going there —
 * for `<a href>`/`EntityLink :href`, where a click handler would be the wrong tool.
 *
 * `path` is the full app-prefixed path ("/invoicing/invoices/123/edit"), matching PageDef.
 * In per-app Vite dev the target lives on another origin, so the token+org handoff rides
 * along in the query exactly as it does for a programmatic hop.
 */
export function appHref(appId: string, path: string): string {
  const meta = APP_NAV_META[appId]
  if (!onViteDevServer() || !meta) return path
  return `http://localhost:${meta.devPort}${path}${handoffQuery(path)}`
}

/**
 * This page is served by one of the per-app Vite dev servers (the portal's on 4000, or a domain
 * app's), where every app is a different origin. Anywhere else (production, the unified server
 * on 4001, or a test server on any other port) one origin serves every app.
 */
function onViteDevServer(): boolean {
  const { hostname, port } = window.location
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') return false
  return port === PORTAL_VITE_PORT || Object.values(APP_NAV_META).some(m => String(m.devPort) === port)
}

const PORTAL_VITE_PORT = '4000'

/** This tab's session as the dev handoff's query (`?token=…&org=…`), for a cross-origin hop. */
function handoffQuery(path: string): string {
  const token = getToken()
  const org = getOrg()
  const sep = path.includes('?') ? '&' : '?'
  return `${sep}token=${encodeURIComponent(token)}&org=${encodeURIComponent(org ? JSON.stringify(org) : '')}`
}

/**
 * A portal page (`/apps`, `/orgs`, `/account`, `/auth/login`) from wherever this runs. On a
 * domain app's Vite dev server the portal is another origin, the unified server on
 * `localhost:4001`, and this tab's session rides along in the handoff query (a sign-in page
 * needs none, so it gets none). Everywhere else it is a path on this origin.
 */
export function portalHref(path = '/'): string {
  const onAppDevServer = onViteDevServer() && window.location.port !== PORTAL_VITE_PORT
  if (!onAppDevServer) return path
  if (path.startsWith('/auth/') || !getToken()) return `http://localhost:4001${path}`
  return `http://localhost:4001${path}${handoffQuery(path)}`
}

/**
 * Where an app sends a tab that has no org session: the sign-in page, or the org picker for a
 * person signed in without an org. Either comes back to `returnTo` afterwards (FR-22.53).
 */
export function signInHref(returnTo?: string | null): string {
  return portalHref(isPersonOnly() ? orgPickerPath(returnTo) : signInPath(returnTo))
}

/** Where an app tile or the app switcher goes: the app's home, in this tab's org. */
export function appHomeHref(app: { id: string; path: string; devPort?: number }): string {
  const crossOrigin = onViteDevServer() && !!app.devPort && String(app.devPort) !== window.location.port
  return crossOrigin ? `http://localhost:${app.devPort}${app.path}${handoffQuery(app.path)}` : app.path
}

// A sign-out in another tab of the same person lands this one on the sign-in page.
onSignedOutElsewhere(() => {
  window.location.href = portalHref('/auth/login')
})

// ── The receiving half of the dev token handoff (FR-14.24) ──────────────────────────────
//
// Every `*-ui` router used to take a `?token=` from the URL and write it straight into
// `localStorage`, on ANY origin. Only the SENDING side above was ever limited to the Vite dev
// ports, so `https://lgrai.app/apps?token=<attacker's JWT>` silently signed the visitor's
// browser into the attacker's account AND org — a login-fixation hole reachable from a link,
// a bookmark or a chat message.
//
// The condition below is the receiving mirror of that limit. It is deliberately NOT the same
// expression as `isViteDev` above, because the two answer different questions:
//   · `isViteDev` asks "is the TARGET app a different origin from here?" — which is why it
//     excludes 4001, where every SPA is same-origin and no handoff is needed;
//   · `isDevTokenHandoffOrigin` asks "is THIS origin one of our dev servers?" — and 4001 IS
//     one, because the domain apps' "back to Portal" hop targets `localhost:4001/apps` and
//     arrives cross-origin from :4021 & co.
// Both are localhost-only, which is what actually closes the hole.

/** Every port a local dev server of ours listens on: portal, the unified server, per-app Vite. */
const DEV_HANDOFF_PORTS: ReadonlySet<string> = new Set<string>([
  '4000', // portal-ui (Vite)
  '4001', // unified API + all built UIs — the "back to Portal" target in dev
  ...Object.values(APP_NAV_META).map(m => String(m.devPort)),
])

/** True only on a local dev origin, where a cross-origin token handoff is the intended flow. */
export function isDevTokenHandoffOrigin(loc: Pick<Location, 'hostname' | 'port'> = window.location): boolean {
  const { hostname, port } = loc
  if (hostname !== 'localhost' && hostname !== '127.0.0.1') return false
  return DEV_HANDOFF_PORTS.has(port)
}

/** What a router should do about the `token`/`org` query parameters it was handed. */
export type TokenHandoff =
  /** No handoff present — carry on routing. */
  | { action: 'none' }
  /** A dev-origin handoff: store these, then reload without them. */
  | { action: 'accept'; token: string; org?: string }
  /** A token on a non-dev origin: store NOTHING, strip it, reload. */
  | { action: 'reject' }

/**
 * Classify a `?token=`/`?org=` pair. Pure, so the decision is unit-testable without a browser.
 *
 * ⚠ There is no per-route exemption, on purpose. The one route that needed one was the OAuth
 * callback, which received the session JWT as `?token=` — and being exempt is precisely what
 * kept `…/auth/oauth-callback?token=<attacker's JWT>` working as a sign-in for someone else's
 * account after every other route was gated. The callback now reads nothing from the URL, so
 * nothing needs an exemption, and an escape hatch nobody uses is one somebody would reach for.
 */
export function classifyTokenHandoff(
  query: Record<string, unknown>,
  opts: { loc?: Pick<Location, 'hostname' | 'port'> } = {},
): TokenHandoff {
  const token = typeof query.token === 'string' ? query.token : undefined
  const org = typeof query.org === 'string' ? query.org : undefined
  if (!token && !org) return { action: 'none' }
  if (!isDevTokenHandoffOrigin(opts.loc ?? window.location)) return { action: 'reject' }
  // `org` alone carries no credential, but it points the app at an org; it rides the same gate.
  if (!token) return { action: 'reject' }
  return { action: 'accept', token, org }
}

/**
 * Apply `classifyTokenHandoff` to the real window.
 *
 * Returns true when a full reload is in flight and the caller must stop routing. Both the
 * accept and the reject path reload without the parameters — stripping alone would leave the
 * token in `localStorage`, and ignoring alone would leave it in the address bar, in history
 * and in anything the user copies from there.
 */
export function consumeTokenHandoff(query: Record<string, unknown>): boolean {
  const handoff = classifyTokenHandoff(query)
  if (handoff.action === 'none') return false
  if (handoff.action === 'accept') setSession(handoff.token, parseHandoffOrg(handoff.org))
  const url = new URL(window.location.href)
  url.searchParams.delete('token')
  url.searchParams.delete('org')
  window.location.replace(url.toString())
  return true
}

function parseHandoffOrg(raw?: string): SessionOrg | null {
  if (!raw) return null
  try {
    const org = JSON.parse(raw)
    return org && typeof org === 'object' && typeof org.id === 'string' ? org : null
  } catch {
    return null
  }
}
