import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: { name: 'subscriptions.list' } },
      { path: 'subscriptions', name: 'subscriptions.list', component: () => import('../views/subscriptions/SubscriptionsView.vue') },
      { path: 'subscriptions/new', name: 'subscriptions.new', component: () => import('../views/subscriptions/SubscriptionFormView.vue') },
      { path: 'subscriptions/:id', name: 'subscriptions.edit', component: () => import('../views/subscriptions/SubscriptionFormView.vue') },
      { path: 'dashboard', name: 'subscriptions.dashboard', component: () => import('../views/subscriptions/SubscriptionDashboardView.vue') },
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
