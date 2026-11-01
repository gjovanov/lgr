import type { ModuleManifest } from 'ui-shell/module'

/**
 * FR-24.3: the reports module as data. Paths are relative to the module (`/reports`), never to a
 * router's base: the one SPA's router composes them under the module's shell record.
 */
export const manifest: ModuleManifest = {
  id: 'reports',
  base: '/reports',
  titleKey: 'apps.reports',
  pendingChanges: false,
  menu: null,
  routes: [
      { path: '', name: 'reports.hub', component: () => import('./views/ReportsHubView.vue'), meta: { breadcrumb: [{ title: 'Reports' }] } },

      // ── Moved from invoicing-ui (FR-6.19) ──
      { path: 'export', name: 'reports.export', component: () => import('./views/ReportingExportView.vue'), meta: { breadcrumb: [{ title: 'Reports', to: '/' }, { title: 'Export' }] } },
      { path: 'aging', name: 'reports.aging', component: () => import('./views/InvoiceAgingView.vue'), meta: { breadcrumb: [{ title: 'Reports', to: '/' }, { title: 'Aging Report' }] } },

      // ── SUPTO / НАП tables 18.1–18.9 (FR-06 P2) ──
      // One view, nine catalog cards. It drives the existing `/supto/export/:tableId`
      // endpoint because those workbooks are legally prescribed — see supto.report.ts.
      { path: 'supto/:table', name: 'reports.supto', component: () => import('./views/SuptoTableView.vue'), meta: { breadcrumb: [{ title: 'Reports', to: '/' }, { title: 'SUPTO' }] } },

      // ── Registry-driven (FR-6.9) ──
      { path: ':id', name: 'reports.runner', component: () => import('./views/ReportRunnerView.vue'), meta: { breadcrumb: [{ title: 'Reports', to: '/' }, { title: 'Report' }] } },
    ],
}
