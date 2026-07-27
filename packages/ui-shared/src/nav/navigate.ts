import { APP_NAV_META, type PageDef } from './page-registry'

/**
 * Navigate to a page that may live in a DIFFERENT app (each domain UI is its own SPA).
 * - Production / unified dev (same origin, port 4001): plain same-origin location change.
 * - Local per-app Vite dev (ports 40xx): cross-origin → target that app's own dev server,
 *   carrying token+org in the query (localStorage isn't shared cross-origin). Mirrors the
 *   logic in AppHubView.navigateToApp.
 */
export function navigateToPage(page: PageDef) {
  const { hostname, port } = window.location
  const meta = APP_NAV_META[page.appId]
  const isViteDev = hostname === 'localhost' && port !== '4001' && !!meta
  if (isViteDev) {
    const token = localStorage.getItem('lgr_token') || ''
    const org = localStorage.getItem('lgr_org') || ''
    const params = `?token=${encodeURIComponent(token)}&org=${encodeURIComponent(org)}`
    window.location.href = `http://localhost:${meta.devPort}${page.path}${params}`
  } else {
    window.location.href = page.path
  }
}
