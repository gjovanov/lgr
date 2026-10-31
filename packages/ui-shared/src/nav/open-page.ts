import { loadRouteLocation, type Router } from 'vue-router'
import { APP_NAV_META, type PageDef } from './page-registry'
import { ref } from 'vue'
import { appHref, goTo, routerPathFor } from './navigate'

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

export { routerPathFor } from './navigate'

/** The route meta a module's shell record carries (FR-24.3): `{ module: '<app id>' }`. */
type MatchedLike = { path: string; meta?: Record<string | number | symbol, unknown> }

/**
 * FR-24.4: an app-relative path ("/orders", from a menu, a breadcrumb or a back-to) as the router
 * names it here. The prefix is the path of the module's shell record in the current route: "" for
 * a module that is its own SPA, "/pos" for POS inside invoicing, and "/invoicing" once every module
 * is one SPA. So no menu or breadcrumb names its router's base. A path that is not absolute, and a
 * route outside any module, pass through.
 */
export function inModule(route: { matched: ReadonlyArray<MatchedLike> }, to: string): string {
  if (!to.startsWith('/')) return to
  const shell = route.matched.find(r => typeof r.meta?.module === 'string')
  const prefix = !shell || shell.path === '/' ? '' : shell.path.replace(/\/+$/, '')
  return prefix + to
}

/**
 * FR-24.7: where a Pending-changes entry reopens. `routePath` was the route's path in the app it
 * was made in ("/devices/1" under /pos) and, since FR-24, may be the path inside a bigger SPA
 * ("/pos/devices/1" under /invoicing) or a full one; every form lands on the same page.
 */
export function pendingRestoreUrl(entry: { appId: string; routePath?: string; id: string }): string | null {
  if (!entry.routePath) return null
  const base = APP_NAV_META[entry.appId]?.base ?? `/${entry.appId}`
  const path = entry.routePath === base || entry.routePath.startsWith(`${base}/`) ? entry.routePath : base + entry.routePath
  return `${path}${path.includes('?') ? '&' : '?'}restore=${encodeURIComponent(entry.id)}`
}

type RouteLike = { matched: ReadonlyArray<{ components?: Record<string, unknown> | null }> }

function leafView(route: RouteLike): unknown {
  return route.matched[route.matched.length - 1]?.components?.default
}

/**
 * FR-24.6: the key of the shell's `<router-view>`. `openPage` bumps it after a push that kept the
 * same view component, so the view mounts afresh rather than going on showing the document that
 * was open.
 */
export const viewKey = ref(0)

/**
 * Open a registry page from wherever the person is (★, „+ Нов", a favourite tile).
 *
 * Inside the same SPA it is a router push, with no page load. Into another SPA it is a page load
 * through `goTo`/`appHref`, which carries the dev handoff where one is needed.
 *
 * A target that renders the SAME view component as the current route (from /invoices/123/edit to
 * /invoices/new) is a push too, followed by a remount (`viewKey`): Vue Router keeps the component
 * instance, so the "new" form would otherwise go on showing the document that was open. The form's
 * leave guard has already put any unsaved edits under Pending changes. It used to be a page load,
 * which drops the till's printer (FR-24).
 */
export async function openPage(page: PageDef, router?: Router | null): Promise<void> {
  // This router serves the page: its own module, POS inside invoicing, or every page in one SPA.
  const inHere = router ? routerPathFor(page.path, router) : null
  if (router && inHere) {
    try {
      const target = router.resolve(inHere)
      const current = router.currentRoute.value
      if (target.fullPath === current.fullPath) return
      if (target.matched.length) {
        await loadRouteLocation(target)
        const sameView = leafView(target) === leafView(current)
        const failure = await router.push(target.fullPath)
        // Refused (a leave guard said cancel) or redundant: nothing to remount.
        if (sameView && !failure) viewKey.value++
        return
      }
    } catch {
      // Could not resolve or load the route here: the move below still gets there.
    }
  }
  goTo(appHref(page.appId, page.path), { router })
}