import { createRouter, createWebHistory } from 'vue-router'
import { consumeTokenHandoff } from 'ui-shared/nav/navigate'
import { portalGuard, portalRoutes } from '../routes'

export const router = createRouter({
  history: createWebHistory(),
  // FR-05 (#12): Back/Forward restore the saved scroll offset; fresh navigations start at top.
  scrollBehavior(_to, _from, savedPosition) {
    return savedPosition || { top: 0 }
  },
  routes: portalRoutes,
})

router.beforeEach((to, _from, next) => {
  // Accept a token from URL params ONLY on a local dev origin (FR-14.24) — on any other
  // origin it is stripped and ignored. A full reload follows either way so Pinia
  // re-initializes from the tab's session.
  //
  // ⚠ There is deliberately no exemption for the OAuth callback any more. It used to need one,
  // because it received the session JWT as `?token=` — which is exactly what made
  // `…/auth/oauth-callback?token=<attacker's JWT>` a working sign-in for someone else's account
  // while every other route was gated. The callback now reads nothing from the URL (its
  // credential is the httpOnly `oauth_handoff` cookie), so this route is covered like the rest.
  if (consumeTokenHandoff(to.query)) return

  portalGuard(to, next)
})
