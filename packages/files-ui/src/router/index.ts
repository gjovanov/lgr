import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', name: 'files.hub', component: () => import('../views/FilesHubView.vue'), meta: { breadcrumb: [{ title: 'Files' }] } },
      { path: 'upload', name: 'files.upload', component: () => import('../views/FileUploadView.vue'), meta: { breadcrumb: [{ title: 'Files', to: '/' }, { title: 'Upload' }] } },
      { path: 'documents', name: 'files.documents', component: () => import('../views/DocumentsView.vue'), meta: { breadcrumb: [{ title: 'Files', to: '/' }, { title: 'Documents' }] } },
      { path: 'audit', name: 'files.audit', component: () => import('../views/UploadAuditView.vue'), meta: { breadcrumb: [{ title: 'Files', to: '/' }, { title: 'Audit' }] } },
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
