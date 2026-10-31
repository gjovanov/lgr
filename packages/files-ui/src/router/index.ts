import { createRouter, createWebHistory } from 'vue-router'
import { consumeTokenHandoff, goTo, signInHref } from 'ui-shared/nav/navigate'
import { hasOrgSession } from 'ui-shared/session/session'
import { moduleRoutes } from 'ui-shell/module'
import { manifest } from '../manifest'

const routes = [
  ...moduleRoutes(manifest, () => import('../layouts/DefaultLayout.vue'), import.meta.env.BASE_URL),
]

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  scrollBehavior(_to, _from, savedPosition) {
    return savedPosition || { top: 0 }
  },
  routes,
})

router.beforeEach((to, _from, next) => {
  // Accept a token from URL params ONLY on a local dev origin (FR-14.24) — on any other
  // origin it is stripped and ignored. A full reload follows either way so Pinia
  // re-initializes from the tab's session.
  if (consumeTokenHandoff(to.query)) return

  // An org session, in THIS tab. Without one: the portal's sign-in (or its org picker, for a person
  // signed in without an org), which brings the tab back to this page afterwards (FR-22.53).
  if (!hasOrgSession()) {
    goTo(signInHref(router.options.history.base + to.fullPath))
    return
  }
  next()
})
