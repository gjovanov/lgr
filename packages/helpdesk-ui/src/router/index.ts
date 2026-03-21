import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', name: 'helpdesk.tickets', component: () => import('../views/helpdesk/TicketsView.vue') },
      { path: 'tickets/new', name: 'helpdesk.tickets.new', component: () => import('../views/helpdesk/TicketFormView.vue') },
      { path: 'tickets/:id', name: 'helpdesk.tickets.detail', component: () => import('../views/helpdesk/TicketDetailView.vue') },
      { path: 'teams', name: 'helpdesk.teams', component: () => import('../views/helpdesk/TeamsView.vue') },
      { path: 'sla-policies', name: 'helpdesk.slaPolicies', component: () => import('../views/helpdesk/SLAPoliciesView.vue') },
      { path: 'knowledge', name: 'helpdesk.knowledge', component: () => import('../views/helpdesk/KnowledgeBaseView.vue') },
      { path: 'knowledge/new', name: 'helpdesk.knowledge.new', component: () => import('../views/helpdesk/KnowledgeArticleFormView.vue') },
      { path: 'knowledge/:id/edit', name: 'helpdesk.knowledge.edit', component: () => import('../views/helpdesk/KnowledgeArticleFormView.vue') },
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
