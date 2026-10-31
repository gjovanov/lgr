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
 *  - the next navigation then loads the page, when no form is dirty and this tab holds no printer;
 *    otherwise the shell offers the reload (`newBuild`, App.vue) and never forces it;
 *  - a lazy chunk that failed to load (gone after a deploy) loads the target page, once per build;
 *    with a printer up it asks instead.
 *
 * ⚠ These are the one SPA's deliberate page loads (unit/navigation-seam.test.ts lists this file).
 */

const mine = typeof document !== 'undefined'
  ? document.querySelector('meta[name="lgr-build"]')?.getAttribute('content') ?? ''
  : ''

/** A newer build is being served; the shell offers to load it. */
export const newBuild = ref(false)

function note(served: unknown) {
  if (mine && typeof served === 'string' && served && served !== mine) newBuild.value = true
}

function holdsPrinter(): boolean {
  return fiscalBridgeStatus.value !== 'disconnected'
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
 * cancels the push): a newer build is served, this is not the first navigation, no form is dirty
 * and no printer is held.
 */
export function staleNavigation(to: RouteLocationNormalized, from: RouteLocationNormalized): boolean {
  if (!newBuild.value || from.matched.length === 0) return false
  if (hasUnsavedWork() || holdsPrinter()) return false
  window.location.assign(to.fullPath)
  return true
}

/** The reload the shell offers. */
export function reloadNow(): void {
  window.location.reload()
}

function isChunkError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err)
  return /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to fetch/i.test(msg)
}

/** A lazy chunk that failed loads the target as a page, once per build; with a printer up, asks. */
export function installChunkRecovery(router: Router): void {
  router.onError((err, to) => {
    if (!isChunkError(err)) return
    const key = `lgr_chunk_reload_${mine}`
    if (sessionStorage.getItem(key) || holdsPrinter()) {
      newBuild.value = true
      return
    }
    sessionStorage.setItem(key, '1')
    window.location.assign(to.fullPath)
  })
}
