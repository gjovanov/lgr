import { ref } from 'vue'
import type { RouteLocationNormalized, Router } from 'vue-router'
import { httpClient } from 'ui-shared/composables/useHttpClient'
import { fiscalBridgeStatus } from 'ui-shared/composables/fiscalBridgeStatus'
import { hasUnsavedWork } from 'ui-shared/session/switch-guards'

/**
 * FR-24.14: stale code. Crossing between the eight SPAs used to reload the page now and then by
 * accident; inside one SPA nothing does, and a till tab can live for days. So:
 *  - the build's id is in `index.html` (`<meta name="lgr-build">`) and the server sends its own on
 *    every answer (`x-lgr-build`). A different one means a deploy happened;
 *  - the next navigation then loads the page, unless the tab holds work (`holdsWork`): the shell
 *    then offers the reload (`newBuild`, App.vue) and never forces it;
 *  - a move that FAILED has one rule, `installChunkRecovery`, the only one there is.
 *
 * ⚠ These are the one SPA's deliberate page loads (unit/navigation-seam.test.ts lists this file).
 */

/** This page's build. */
function mine(): string {
  return typeof document !== 'undefined'
    ? document.querySelector('meta[name="lgr-build"]')?.getAttribute('content') ?? ''
    : ''
}

/** A newer build is being served; the shell offers to load it. */
export const newBuild = ref(false)

/** A move could not reach its page and the server is not answering; the shell says so. */
export const moveFailed = ref(false)

/** The first navigation failed and no page load is coming, so nothing is on screen; App.vue says so. */
export const deadStart = ref(false)

function note(served: unknown) {
  if (mine() && typeof served === 'string' && served && served !== mine()) newBuild.value = true
}

/** What a page load would cost this tab: a form's edits, a sale in flight, the printer's port. */
function holdsWork(): boolean {
  return hasUnsavedWork() || fiscalBridgeStatus.value !== 'disconnected'
}

/** Read the server's build id off every API answer. */
export function watchBuild(): void {
  httpClient.interceptors.response.use(
    (res) => { note(res.headers?.['x-lgr-build']); return res },
    (err) => { note(err?.response?.headers?.['x-lgr-build']); return Promise.reject(err) },
  )
}

/**
 * Called first by the router guard. True when it has started a page load to `to` (the caller
 * cancels the push): a newer build is served, this is not the first navigation, and the tab holds
 * no work.
 */
export function staleNavigation(to: RouteLocationNormalized, from: RouteLocationNormalized): boolean {
  if (!newBuild.value || from.matched.length === 0) return false
  if (holdsWork()) return false
  window.location.assign(to.fullPath)
  return true
}

/** The reload the shell offers. */
export function reloadNow(): void {
  window.location.reload()
}

/**
 * The script or the stylesheet of a lazy chunk did not arrive, in the words of each engine and of
 * Vite's preload helper. The words are all there is: `TypeError` is what a bug throws too, and a
 * bare `Failed to fetch` is an API call's.
 */
function isChunkError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err)
  return /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS/i.test(msg)
}

/** How long the server gets. One that takes the question and never answers is a server that is down. */
const HEALTH_MS = 5000

/**
 * A page load is only any use if something will answer it: else it replaces a working page. And
 * the answer says which build is served, which is the one thing that says a deploy happened.
 */
async function askServer(): Promise<{ up: boolean; build: string | null }> {
  try {
    const res = await fetch('/api/health', { cache: 'no-store', signal: AbortSignal.timeout(HEALTH_MS) })
    return { up: res.ok, build: res.headers.get('x-lgr-build') }
  } catch {
    return { up: false, build: null }
  }
}

/** Each build gets one page load, so a page that cannot load never loops. False once it is spent. */
function spendPageLoad(): boolean {
  try {
    const key = `lgr_chunk_reload_${mine()}`
    if (sessionStorage.getItem(key)) return false
    sessionStorage.setItem(key, '1')
    return true
  } catch {
    return false // no storage to count in, so no way to know this is the first
  }
}

/** How long the router gets to report what Vite announced: a few ticks, in practice. */
export const ROUTER_GRACE_MS = 50

/**
 * The one rule for a move that failed, as against one a guard refused. A deploy takes the hashed
 * files of every page this tab has not opened, a push there rejects, and only a page load brings
 * the build being served. But that load replaces whatever is on screen and closes the printer's
 * port, so:
 *  - only for a chunk that did not arrive (`isChunkError`), never for a thrown guard, a bug or an API
 *    call: those reach `onError` too, and a load cures none of them;
 *  - only with the server answering: with it down a load is the browser's error page, where a
 *    working page stood. The tab stays, and says so;
 *  - only with no work in the tab, as FR-24.14 asks: with a printer up, a sale in flight or a dirty
 *    form the shell offers the reload, and the person says when;
 *  - once per build. After that it offers too;
 *  - offered as a new version only when the server says it serves another build. A chunk that failed
 *    with the same build is a blip: the tab says the page did not load, and the same click may work;
 *  - never for a move the person has since replaced, or a page they have since reached. Asking the
 *    server takes a while, so what the person did meanwhile is read after it. The newest failure is
 *    the one answered.
 * A first navigation that fails has nothing on screen to protect, and nothing to fall back on: if
 * no load comes of it the tab says so (`deadStart`), rather than stay blank.
 *
 * Both ways a chunk fails come here: `onError` for a move, which knows where it was going and who
 * replaced it, and `vite:preloadError` for a lazy part of a page. Vite announces a move's chunk too,
 * ahead of the router, so the event waits to see whether the router reports it. It never calls
 * `preventDefault`, which would let the import go on and the page render without its stylesheet.
 */
export function installChunkRecovery(router: Router): void {
  /** The move under way. */
  let moving = ''
  /** The newest failure. An answer that finds itself out of date leaves it to that one. */
  let latest = 0
  /** The failures the router has reported, which the event need not. */
  const reported = new WeakSet<object>()
  const isObject = (err: unknown): err is object => typeof err === 'object' && err !== null

  router.beforeEach((to) => { moving = to.fullPath })
  router.afterEach((to, _from, failure) => {
    if (to.fullPath === moving) moving = ''
    if (!failure) deadStart.value = false
  })

  async function answer(err: unknown, href: string | null) {
    const ticket = ++latest
    const blank = () => router.currentRoute.value.matched.length === 0
    if (!isChunkError(err)) {
      if (blank()) deadStart.value = true
      return
    }
    const from = router.currentRoute.value.fullPath
    const { up, build } = await askServer()
    note(build)
    if (ticket !== latest || router.currentRoute.value.fullPath !== from || (moving && moving !== href)) return
    if (up && !holdsWork() && spendPageLoad()) {
      // Nothing is on screen on a first navigation, and the address is already the page's.
      if (href && !blank()) window.location.assign(href)
      else window.location.reload()
    } else if (blank()) deadStart.value = true
    else if (!newBuild.value) moveFailed.value = true // a new build is the shell's to offer: it now does
  }

  router.onError((err, to, from) => {
    console.error(err) // the router logs nothing itself once it has a listener
    if (isObject(err)) reported.add(err)
    const replaced = router.currentRoute.value.fullPath !== from.fullPath || (moving && moving !== to.fullPath)
    if (replaced) return
    moving = ''
    void answer(err, to.fullPath)
  })

  window.addEventListener('vite:preloadError', (event) => {
    const err = (event as Event & { payload?: unknown }).payload
    setTimeout(() => {
      if (!isObject(err) || !reported.has(err)) void answer(err, moving || null)
    }, ROUTER_GRACE_MS)
  })
}
