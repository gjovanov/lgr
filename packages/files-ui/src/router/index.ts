import { createRouter, createWebHistory } from 'vue-router'
import { consumeTokenHandoff, portalHref } from 'ui-shared/nav/navigate'
import { hasOrgSession, isPersonOnly } from 'ui-shared/session/session'

const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', name: 'files.hub', component: () => import('../views/FilesHubView.vue'), meta: { breadcrumb: [{ title: 'Files' }] } },
      { path: 'upload', name: 'files.upload', component: () => import('../views/FileUploadView.vue'), meta: { breadcrumb: [{ title: 'Files', to: '/' }, { title: 'Upload' }] } },
      { path: 'documents', name: 'files.documents', component: () => import('../views/DocumentsView.vue'), meta: { breadcrumb: [{ title: 'Files', to: '/' }, { title: 'Documents' }] } },
      { path: 'audit', name: 'files.audit', component: () => import('../views/UploadAuditView.vue'), meta: { breadcrumb: [{ title: 'Files', to: '/' }, { title: 'Audit' }] } },
      // FR-13.42 (#24) — the archive index. Reachable by `nra_auditor` (Приложение 29 т. 19);
      // the server's `readGate` is the control, this route carries no gate of its own.
      { path: 'archives', name: 'files.archives', component: () => import('../views/ArchivesView.vue'), meta: { breadcrumb: [{ title: 'Files', to: '/' }, { title: 'Archives' }] } },
    ],
  },
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

  // An org session, in THIS tab. A person signed in without one yet picks an org on the portal.
  if (!hasOrgSession()) {
    window.location.href = portalHref(isPersonOnly() ? '/orgs' : '/')
    return
  }
  next()
})
