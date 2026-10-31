import { loadRouteLocation, type Router } from 'vue-router'
import { APP_NAV_META, type PageDef } from './page-registry'
import { appHref } from './navigate'

/** The app a router serves, from its history base ("/invoicing"); null for the portal's router. */
export function routerAppId(base: string): string | null {
  const b = base.replace(/\/+$/, '')
  for (const [id, meta] of Object.entries(APP_NAV_META)) {
    if (meta.base === b) return id
  }
  return null
}

/** The SPA that serves an app's pages: its own, or the one named by `spa` (POS → invoicing, FR-24). */
export function spaOf(appId: string): string {
  return APP_NAV_META[appId]?.spa ?? appId
}

/**
 * The page's path inside the SPA that serves it ("/invoices/new?type=credit_note", or
 * "/pos/terminal" for a POS page), as that SPA's router names it.
 */
export function appRelativePath(page: Pick<PageDef, 'appId' | 'path'>): string {
  const base = APP_NAV_META[spaOf(page.appId)]?.base ?? ''
  if (!base || !page.path.startsWith(base)) return page.path
  return page.path.slice(base.length) || '/'
}

/**
 * A full path ("/invoicing/pos/terminal") as THIS router names it ("/pos/terminal"), or null when
 * another SPA serves it. What an app tile or a restore uses to stay inside the document: a page
 * load closes the tab's Web Serial port, the printer the till prints on (FR-24).
 */
export function routerPathFor(path: string, router: Router): string | null {
  const base = router.options.history.base.replace(/\/+$/, '')
  if (!base || (path !== base && !path.startsWith(`${base}/`))) return null
  const rel = path.slice(base.length) || '/'
  return router.resolve(rel).matched.length ? rel : null
}

type RouteLike = { matched: ReadonlyArray<{ components?: Record<string, unknown> | null }> }

function leafView(route: RouteLike): unknown {
  return route.matched[route.matched.length - 1]?.components?.default
}

/**
 * Open a registry page from wherever the person is (★, „+ Нов", a favourite tile).
 *
 * Inside the same SPA it is a router push, with no page load. Into another SPA it is a page load
 * through `appHref`, which carries the dev handoff where one is needed.
 *
 * ⚠ One same-SPA case loads the page anyway: a target that renders the SAME view component as
 * the current route — from /invoices/123/edit to /invoices/new, or from a new invoice to a new
 * credit note. Vue Router keeps that component instance, so the "new" form would go on showing
 * the document that was open. A page load gives a blank form, and the form's `beforeunload` keeps
 * any unsaved edits under Pending changes, as on every hop to another app.
 */
export async function openPage(page: PageDef, router?: Router | null): Promise<void> {
  if (router && routerAppId(router.options.history.base) === spaOf(page.appId)) {
    try {
      const target = router.resolve(appRelativePath(page))
      const current = router.currentRoute.value
      if (target.fullPath === current.fullPath) return
      if (target.matched.length) {
        await loadRouteLocation(target)
        if (leafView(target) !== leafView(current)) {
          await router.push(target.fullPath)
          return
        }
      }
    } catch {
      // Could not resolve or load the route here: the page load below still gets there.
    }
  }
  window.location.href = appHref(page.appId, page.path)
}
