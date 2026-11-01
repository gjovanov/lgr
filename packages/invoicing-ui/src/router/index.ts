import { createRouter, createWebHistory } from 'vue-router'
import { consumeTokenHandoff, goTo, signInHref } from 'ui-shared/nav/navigate'
import { hasOrgSession } from 'ui-shared/session/session'
import { moduleRoutes } from 'ui-shell/module'
import { manifest } from '../manifest'
import { manifest as posManifest } from '../pos/manifest'
import { pinOffered } from '../pos/composables/useTillPin'

/**
 * FR-24 Phase 0: the POS module is served by this SPA, under `/pos` (its manifest), so moving
 * between the till and invoicing is a router push and the tab's Web Serial port (the printer)
 * stays open. Its route NAMES are unchanged (`pos.*`): Playwright and `useGridColumns` key on them.
 * The old `/pos/*` URLs answer 302 to `/invoicing/pos/*` from the server, because desktops hold
 * `startPath: /pos/` (FR-14.16).
 */
const routes = [
  ...moduleRoutes(posManifest, () => import('../pos/PosLayout.vue'), import.meta.env.BASE_URL),
  ...moduleRoutes(manifest, () => import('../layouts/DefaultLayout.vue'), import.meta.env.BASE_URL),
]
export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  // FR-05 (#12): Back/Forward restore the saved scroll offset; fresh navigations start at top.
  scrollBehavior(_to, _from, savedPosition) {
    return savedPosition || { top: 0 }
  },
  routes,
})

router.beforeEach(async (to, _from, next) => {
  // Accept a token from URL params ONLY on a local dev origin (FR-14.24) — on any other
  // origin it is stripped and ignored. A full reload follows either way so Pinia
  // re-initializes from the tab's session.
  if (consumeTokenHandoff(to.query)) return

  if (to.name === 'pos.pin') return next()

  // An org session, in THIS tab. Without one: the portal's sign-in (or its org picker, for a person
  // signed in without an org), which brings the tab back to this page afterwards (FR-22.53).
  if (!hasOrgSession()) {
    // At a till paired with an on-prem server, the operator signs in on the POS pages with a PIN.
    const isPos = to.matched.some(r => r.meta?.module === 'pos')
    if (isPos && (await pinOffered())) return next({ name: 'pos.pin', query: { to: to.fullPath } })
    goTo(signInHref(router.options.history.base + to.fullPath))
    return
  }
  next()
})
