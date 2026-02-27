import { createRouter, createWebHistory } from 'vue-router'

const routes = [
  {
    path: '/landing',
    name: 'landing',
    component: () => import('../views/LandingView.vue'),
    meta: { public: true, guest: true },
  },
  {
    path: '/privacy',
    name: 'privacy',
    component: () => import('../views/legal/PrivacyPolicyView.vue'),
    meta: { public: true },
  },
  {
    path: '/terms',
    name: 'terms',
    component: () => import('../views/legal/TermsView.vue'),
    meta: { public: true },
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
  // Accept token from URL params (domain apps pass it for cross-origin navigation)
  // Skip OAuth callback route — it uses `token` for a different purpose
  const isOAuthCallback = to.name === 'auth.oauth-callback'
  const urlToken = to.query.token as string | undefined
  const urlOrg = to.query.org as string | undefined
  if (urlToken && !isOAuthCallback) {
    localStorage.setItem('lgr_token', urlToken)
    if (urlOrg) localStorage.setItem('lgr_org', urlOrg)
    // Full reload so Pinia store re-initializes with the new localStorage values
    const url = new URL(window.location.href)
    url.searchParams.delete('token')
    url.searchParams.delete('org')
    window.location.replace(url.toString())
    return
  }

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
