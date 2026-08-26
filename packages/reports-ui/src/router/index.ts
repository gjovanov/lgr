import { createRouter, createWebHistory } from 'vue-router'

/**
 * FR-06 (#14). Two kinds of route live here:
 *
 *  - the hub (`/`) and the generic runner (`/:id`), which are driven entirely by the
 *    registry's catalog — a new report needs NO route;
 *  - the two pages moved out of invoicing-ui, which keep their own richer views at fixed
 *    paths. Their registry entries are `view: 'custom'` and point the hub card here.
 *
 * The runner is declared LAST so `/export` and `/aging` win over `/:id`.
 */
const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', name: 'reports.hub', component: () => import('../views/ReportsHubView.vue'), meta: { breadcrumb: [{ title: 'Reports' }] } },

      // ── Moved from invoicing-ui (FR-6.19) ──
      { path: 'export', name: 'reports.export', component: () => import('../views/ReportingExportView.vue'), meta: { breadcrumb: [{ title: 'Reports', to: '/' }, { title: 'Export' }] } },
      { path: 'aging', name: 'reports.aging', component: () => import('../views/InvoiceAgingView.vue'), meta: { breadcrumb: [{ title: 'Reports', to: '/' }, { title: 'Aging Report' }] } },

      // ── SUPTO / НАП tables 18.1–18.9 (FR-06 P2) ──
      // One view, nine catalog cards. It drives the existing `/supto/export/:tableId`
      // endpoint because those workbooks are legally prescribed — see supto.report.ts.
      { path: 'supto/:table', name: 'reports.supto', component: () => import('../views/SuptoTableView.vue'), meta: { breadcrumb: [{ title: 'Reports', to: '/' }, { title: 'SUPTO' }] } },

      // ── Registry-driven (FR-6.9) ──
      { path: ':id', name: 'reports.runner', component: () => import('../views/ReportRunnerView.vue'), meta: { breadcrumb: [{ title: 'Reports', to: '/' }, { title: 'Report' }] } },
    ],
  },
]

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  // FR-05 (#12): Back/Forward restore the saved scroll offset; fresh navigations start at top.
  scrollBehavior(_to, _from, savedPosition) {
    return savedPosition || { top: 0 }
  },
  routes,
})

router.beforeEach((to, _from, next) => {
  const urlToken = to.query.token as string | undefined
  const urlOrg = to.query.org as string | undefined
  if (urlToken) {
    localStorage.setItem('lgr_token', urlToken)
    if (urlOrg) localStorage.setItem('lgr_org', urlOrg)
    const url = new URL(window.location.href)
    url.searchParams.delete('token')
    url.searchParams.delete('org')
    window.location.replace(url.toString())
    return
  }

  const token = localStorage.getItem('lgr_token')
  if (!token) {
    const portalUrl = window.location.hostname === 'localhost' ? 'http://localhost:4001' : '/'
    window.location.href = portalUrl
    return
  }
  next()
})
