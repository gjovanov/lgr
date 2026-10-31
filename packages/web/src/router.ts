import { defineComponent, h } from 'vue'
import { createRouter, createWebHistory, RouterView, type RouteRecordRaw } from 'vue-router'
import { consumeTokenHandoff, signInHref } from 'ui-shared/nav/navigate'
import { hasOrgSession } from 'ui-shared/session/session'
import { getI18n } from 'ui-shared/plugins'
import { portalGuard, portalRoutes } from '../../portal-ui/src/routes'
import { pinOffered } from '../../invoicing-ui/src/pos/composables/useTillPin'
import { MODULES, moduleOf } from './modules'
import { staleNavigation } from './stale'

/** A module's shell record renders its routes in place: the layout above it is the one shell. */
const ModuleOutlet = defineComponent({ name: 'ModuleOutlet', render: () => h(RouterView) })

/**
 * FR-24.10/24.11: the one SPA's routes. The portal's as they are, every module's outside routes (a
 * PIN pad has no session yet), and ONE shell record with each module under it at its base. The
 * URLs and route names are the eight SPAs' own, so deep links, saved columns and specs carry over.
 */
export const routes: RouteRecordRaw[] = [
  ...MODULES.flatMap(m => (m.outside ?? []).map(r => ({ ...r, path: `${m.base}/${r.path}` }) as RouteRecordRaw)),
  ...portalRoutes,
  {
    path: '/',
    component: () => import('./OneShell.vue'),
    children: MODULES.map(m => ({
      path: m.base.slice(1),
      component: ModuleOutlet,
      meta: { module: m.id },
      children: m.routes,
    })),
  },
]

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
 * module's route needs an org session in this tab, as each domain router asked, and a POS route
 * offers the till's PIN pad where the server does. The PIN pad itself is outside every rule.
 */
router.beforeEach(async (to, from, next) => {
  if (consumeTokenHandoff(to.query)) return
  if (staleNavigation(to, from)) return next(false)
  if (to.name === 'pos.pin') return next()

  const module = moduleOf(to)
  if (!module) return portalGuard(to, next)
  if (!hasOrgSession()) {
    if (module.id === 'pos' && (await pinOffered())) return next({ name: 'pos.pin', query: { to: to.fullPath } })
    return next(signInHref(to.fullPath))
  }
  next()
})

/** FR-24.19: the tab's title is the module's, from its manifest. */
router.afterEach((to) => {
  const module = moduleOf(to)
  document.title = module ? `LGR ${getI18n().global.t(module.titleKey)}` : 'LGR'
})
