import { createRouter, createWebHistory } from 'vue-router'
import { signInHref } from 'ui-shared/nav/navigate'
import { hasOrgSession } from 'ui-shared/session/session'
import { whenAccessSettled } from 'ui-shared/access/live-grant'
import { useAppStore } from 'ui-shared/stores/app.store'
import { getI18n } from 'ui-shared/plugins'
import { portalGuard } from './modules/portal/routes'
import { tillRedirect } from './modules/invoicing/pos/till-rules'
import { moduleOf } from './modules'
import { routes } from './routes'
import { staleNavigation } from './stale'

export const router = createRouter({
  history: createWebHistory('/'),
  // FR-05 (#12): Back/Forward restore the saved scroll offset; fresh navigations start at top.
  scrollBehavior(_to, _from, savedPosition) {
    return savedPosition || { top: 0 }
  },
  routes,
})

/**
 * FR-24.12: one guard. A portal route follows the portal's rules (public, guest, person-only); a
 * module's route needs an org session in this tab, after the till's rules. The PIN pad itself is
 * outside every rule.
 */
router.beforeEach(async (to, from, next) => {
  // AC 7: a `?token=` never signs anyone in (nothing reads it). It is dropped from the address all the
  // same, in place, so a planted one cannot survive into a bookmark, the history or a shared link.
  if ('token' in to.query) {
    const { token: _dropped, ...query } = to.query
    return next({ path: to.path, query, hash: to.hash, replace: true })
  }
  if (staleNavigation(to, from)) return next(false)
  if (to.name === 'pos.pin') return next()
  // FR-27 P3-5 (#529): the token says nothing of what the role allows, so a page load or a new tab learns the grant
  // (`/auth/me`, once) before the first decision that reads it: the till's, the portal's and every page's.
  if (hasOrgSession()) {
    useAppStore() // registers how to ask `/auth/me` (`setAccessRefetch`)
    await whenAccessSettled()
  }

  const module = moduleOf(to)
  if (!module) return portalGuard(to, next)
  const till = await tillRedirect(to)
  if (till) return next(till)
  if (!hasOrgSession()) return next(signInHref(to.fullPath))
  next()
})

/** FR-24.19: the tab's title is the module's, from its manifest. */
router.afterEach((to) => {
  const module = moduleOf(to)
  document.title = module ? `LGR ${getI18n().global.t(module.titleKey)}` : 'LGR'
})
