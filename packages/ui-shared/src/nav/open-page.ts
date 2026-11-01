import { loadRouteLocation, type Router } from 'vue-router'
import { APP_NAV_META, type PageDef } from './page-registry'
import { ref } from 'vue'
import { goTo, routerPathFor } from './navigate'

export { routerPathFor } from './navigate'

/** The route meta a module's shell record carries (FR-24.3): `{ module: '<app id>' }`. */
type MatchedLike = { path: string; meta?: Record<string | number | symbol, unknown> }

/**
 * FR-24.4: an app-relative path ("/orders", from a menu, a breadcrumb or a back-to) as the router
 * names it here. The prefix is the path of the module's shell record in the current route: "" for
 * a module that is its own SPA, and "/invoicing" once every module is one SPA. So no menu or
 * breadcrumb names its router's base. A path that is not absolute, and a route outside any module,
 * pass through.
 */
export function inModule(route: { matched: ReadonlyArray<MatchedLike> }, to: string): string {
  if (!to.startsWith('/')) return to
  const shell = route.matched.find(r => typeof r.meta?.module === 'string')
  const prefix = !shell || shell.path === '/' ? '' : shell.path.replace(/\/+$/, '')
  return prefix + to
}

/**
 * FR-24.7: where a Pending-changes entry reopens. `routePath` was the route's path in the app it
 * was made in ("/devices/1" under /pos, which the server still answers) and, since FR-24, may be the
 * path inside a bigger SPA ("/pos/devices/1" under /invoicing, which that router redirects) or a full
 * one; every form lands on the same page.
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
 * It is a router push, with no page load: one SPA serves every page (FR-24.21).
 *
 * A target that renders the SAME view component as the current route (from /invoices/123/edit to
 * /invoices/new) is a push too, followed by a remount (`viewKey`): Vue Router keeps the component
 * instance, so the "new" form would otherwise go on showing the document that was open. The form's
 * leave guard has already put any unsaved edits under Pending changes. It used to be a page load,
 * which drops the till's printer (FR-24).
 */
export async function openPage(page: PageDef, router?: Router | null): Promise<void> {
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
  goTo(page.path, { router })
}