import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', name: 'project.projects', component: () => import('../views/project/ProjectsView.vue') },
      { path: 'projects/new', name: 'project.projects.new', component: () => import('../views/project/ProjectFormView.vue') },
      { path: 'projects/:id/edit', name: 'project.projects.edit', component: () => import('../views/project/ProjectFormView.vue') },
      { path: 'projects/:id', name: 'project.projects.detail', component: () => import('../views/project/ProjectDetailView.vue') },
      { path: 'projects/:projectId/tasks', name: 'project.tasks', component: () => import('../views/project/TasksView.vue') },
      { path: 'projects/:projectId/tasks/new', name: 'project.tasks.new', component: () => import('../views/project/TaskFormView.vue') },
      { path: 'projects/:projectId/tasks/:id/edit', name: 'project.tasks.edit', component: () => import('../views/project/TaskFormView.vue') },
      { path: 'timesheets', name: 'project.timesheets', component: () => import('../views/project/TimesheetsView.vue') },
      { path: 'field-service', name: 'project.fieldService', component: () => import('../views/project/FieldServiceView.vue') },
    ],
  },
]

export const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
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
