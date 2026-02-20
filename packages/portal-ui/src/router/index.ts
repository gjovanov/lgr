import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/landing',
    name: 'landing',
    component: () => import('../views/LandingView.vue'),
    meta: { public: true, guest: true },
  },
  {
    path: '/',
    component: () => import('../layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: '/apps' },
      { path: 'apps', name: 'apps', component: () => import('../views/AppHubView.vue') },
      { path: 'dashboard', name: 'dashboard', component: () => import('../views/dashboard/DashboardView.vue') },
      { path: 'invite/:code', name: 'invite', component: () => import('../views/invite/InviteLandingView.vue'), meta: { public: true } },

      // Settings
      { path: 'settings/organization', name: 'settings.organization', component: () => import('../views/settings/OrganizationView.vue') },
      { path: 'settings/users', name: 'settings.users', component: () => import('../views/settings/UsersView.vue') },
      { path: 'settings/invites', name: 'settings.invites', component: () => import('../views/settings/InvitesView.vue') },
      { path: 'settings/billing', name: 'settings.billing', component: () => import('../views/settings/BillingView.vue') },

      // Admin
      { path: 'admin/audit-log', name: 'admin.audit-log', component: () => import('../views/admin/AuditLogView.vue') },
    ],
  },
  {
    path: '/auth',
    component: () => import('../layouts/AuthLayout.vue'),
    children: [
      { path: 'login', name: 'auth.login', component: () => import('../views/auth/LoginView.vue'), meta: { public: true } },
      { path: 'register', name: 'auth.register', component: () => import('../views/auth/RegisterView.vue'), meta: { public: true } },
      { path: 'oauth-callback', name: 'auth.oauth-callback', component: () => import('../views/auth/OAuthCallbackView.vue'), meta: { public: true } },
    ],
  },
]

export const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.beforeEach((to, _from, next) => {
  const isPublic = to.matched.some(r => r.meta.public)
  const isGuest = to.matched.some(r => r.meta.guest)
  const token = localStorage.getItem('lgr_token')
  if (!isPublic && !token) {
    next({ name: 'landing' })
  } else if (isGuest && token) {
    const pendingInvite = sessionStorage.getItem('pending_invite_code')
    if (pendingInvite) {
      sessionStorage.removeItem('pending_invite_code')
      next({ name: 'invite', params: { code: pendingInvite } })
    } else {
      next({ name: 'apps' })
    }
  } else {
    next()
  }
})
