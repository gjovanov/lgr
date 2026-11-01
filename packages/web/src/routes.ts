import { defineComponent, h } from 'vue'
import { RouterView, type RouteRecordRaw } from 'vue-router'
import { portalRoutes } from '../../portal-ui/src/routes'
import { MODULES } from './modules'

/** A module's shell record renders its routes in place: the layout above it is the one shell. */
const ModuleOutlet = defineComponent({ name: 'ModuleOutlet', render: () => h(RouterView) })

/**
 * FR-24.10/24.11: the one SPA's routes. The portal's as they are, every module's outside routes (a
 * PIN pad has no session yet), and ONE shell record with each module under it at its base. The
 * route names are the eight SPAs' own, so saved columns and specs carry over, and a page that moved
 * keeps its name at its new address.
 *
 * Apart from the router (`router.ts`), which needs a browser, so a test can walk this table.
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
