import { APP_NAV_META, type PageDef } from './page-registry'

/**
 * Navigate to a page that may live in a DIFFERENT app (each domain UI is its own SPA).
 * - Production / unified dev (same origin, port 4001): plain same-origin location change.
 * - Local per-app Vite dev (ports 40xx): cross-origin → target that app's own dev server,
 *   carrying token+org in the query (localStorage isn't shared cross-origin). Mirrors the
 *   logic in AppHubView.navigateToApp.
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
  const { hostname, port } = window.location
  const meta = APP_NAV_META[appId]
  const isViteDev = hostname === 'localhost' && port !== '4001' && !!meta
  if (!isViteDev) return path
  const token = localStorage.getItem('lgr_token') || ''
  const org = localStorage.getItem('lgr_org') || ''
  const sep = path.includes('?') ? '&' : '?'
  return `http://localhost:${meta.devPort}${path}${sep}token=${encodeURIComponent(token)}&org=${encodeURIComponent(org)}`
}
