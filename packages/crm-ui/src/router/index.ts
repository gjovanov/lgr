import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: '/crm/leads' },
      // CRM routes
      { path: 'crm/leads', name: 'crm.leads', component: () => import('../views/crm/LeadsView.vue') },
      { path: 'crm/deals', name: 'crm.deals', component: () => import('../views/crm/DealsView.vue') },
      { path: 'crm/activities', name: 'crm.activities', component: () => import('../views/crm/ActivitiesView.vue') },
    ],
  },
]

export const router = createRouter({
  history: createWebHistory('/'),
  routes,
})

router.beforeEach((to, _from, next) => {
  // Accept token from URL params (Portal passes it for cross-origin navigation)
  const urlToken = to.query.token as string | undefined
  const urlOrg = to.query.org as string | undefined
  if (urlToken) {
    localStorage.setItem('lgr_token', urlToken)
    if (urlOrg) localStorage.setItem('lgr_org', urlOrg)
    // Full reload so Pinia store re-initializes with the new localStorage values
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
