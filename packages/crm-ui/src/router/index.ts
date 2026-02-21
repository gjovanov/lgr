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
  history: createWebHistory(),
  routes,
})

router.beforeEach((to, _from, next) => {
  const token = localStorage.getItem('lgr_token')
  if (!token) {
    // Redirect to Portal for login
    const portalUrl = window.location.hostname === 'localhost' ? 'http://localhost:4001' : '/'
    window.location.href = portalUrl
    return
  }
  next()
})
