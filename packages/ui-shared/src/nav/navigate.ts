import type { Router } from 'vue-router'
import type { PageDef } from './page-registry'
import { orgPickerPath, signInPath } from './return-path'
import { isPersonOnly, onSignedOutElsewhere } from '../session/session'

// ── FR-24.5: the one seam that moves a person ──────────────────────────────────────────────
//
// ⚠ One page load is all it takes to drop the till's printer: it closes the tab's Web Serial port.
// So every move goes through `goTo`, which is a router push whenever the router can take the path,
// and a page load only when the move leaves the SPA (the API, a provider, another origin).
// `unit/navigation-seam.test.ts` fails on a `window.location` assignment anywhere else in the UI,
// apart from the moves it lists as page loads on purpose (sign-out, OAuth, a session change).

/** The SPA's router, set once by `installInAppLinks` (`registerPlugins`). */
let appRouter: Router | null = null

/** A full path as the router names it, or null when no route of the router takes it. */
export function routerPathFor(path: string, router: Router | null = appRouter): string | null {
  if (!router || !path.startsWith('/') || path.startsWith('//')) return null
  try {
    return router.resolve(path).matched.length ? path : null
  } catch {
    return null
  }
}

/**
 * Move to `url`: a router push (or replace) when this SPA serves it, else a page load. A full URL
 * on another origin (a per-app Vite dev server, a provider) always loads.
 */
export function goTo(url: string, opts: { router?: Router | null; replace?: boolean } = {}): void {
  const router = opts.router ?? appRouter
  const inHere = routerPathFor(url, router)
  if (router && inHere) {
    void (opts.replace ? router.replace(inHere) : router.push(inHere))
    return
  }
  if (opts.replace) window.location.replace(url)
  else window.location.href = url
}

/**
 * Plain links (`<a :href="appHref(…)">`, `v-btn :href`) into a page this SPA serves follow the
 * router instead of loading the document. They keep their real `href`, so a middle click, a
 * Ctrl/⌘ click or "open in new tab" still opens a tab. Installed once, by each SPA's `main.ts`.
 */
export function installInAppLinks(router: Router): void {
  appRouter = router
  if (typeof document === 'undefined') return
  document.addEventListener('click', (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download')) return
    const url = new URL(a.href, window.location.href)
    if (url.origin !== window.location.origin) return
    const inHere = routerPathFor(url.pathname + url.search + url.hash, router)
    if (!inHere) return
    e.preventDefault()
    void router.push(inHere)
  })
}

/** Navigate to a page of any module: one SPA serves them all (FR-24.21), so this is a router push. */
export function navigateToPage(page: PageDef) {
  goTo(page.path)
}

/**
 * A page's URL, for `<a href>` / `EntityLink :href`: the full path ("/invoicing/invoices/123/edit"),
 * matching PageDef. One origin and one SPA serve every module, so the path is the URL, and
 * `installInAppLinks` turns a plain click on it into a router push. `appId` stays in the signature
 * for the callers that name the module they link into.
 */
export function appHref(_appId: string, path: string): string {
  return path
}

/** A portal page (`/apps`, `/orgs`, `/account`, `/auth/login`): a path of the one SPA. */
export function portalHref(path = '/'): string {
  return path
}

/**
 * Where an app sends a tab that has no org session: the sign-in page, or the org picker for a
 * person signed in without an org. Either comes back to `returnTo` afterwards (FR-22.53).
 */
export function signInHref(returnTo?: string | null): string {
  return portalHref(isPersonOnly() ? orgPickerPath(returnTo) : signInPath(returnTo))
}

/** Where an app tile or the app switcher goes: the app's home, in this tab's org. */
export function appHomeHref(app: { id: string; path: string }): string {
  return app.path
}

// A sign-out in another tab of the same person lands this one on the sign-in page.
onSignedOutElsewhere(() => {
  window.location.href = portalHref('/auth/login')
})

// FR-24.21: nothing reads a session token from a query string any more (AC 7). The per-app Vite dev
// servers, whose cross-origin hops carried `?token=&org=` (and the receiving half that stored it,
// FR-14.24), are gone: one SPA, one origin, and the session lives in this tab's storage.

