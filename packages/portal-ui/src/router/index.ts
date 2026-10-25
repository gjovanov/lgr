import { createRouter, createWebHistory } from 'vue-router'
import { consumeTokenHandoff } from 'ui-shared/nav/navigate'
import { getToken, hasOrgSession } from 'ui-shared/session/session'

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
      // The person's own account: password, sign-in methods (multi-org sign-in, Phase 4).
      { path: 'account', name: 'account', component: () => import('../views/account/AccountView.vue') },

      // Settings
      { path: 'settings/organization', name: 'settings.organization', component: () => import('../views/settings/OrganizationView.vue') },
      { path: 'settings/users', name: 'settings.users', component: () => import('../views/settings/UsersView.vue') },
      { path: 'settings/invites', name: 'settings.invites', component: () => import('../views/settings/InvitesView.vue') },
      { path: 'settings/billing', name: 'settings.billing', component: () => import('../views/settings/BillingView.vue') },
      { path: 'settings/permission-sets', name: 'settings.permissionSets', component: () => import('../views/settings/PermissionSetsView.vue') },
      // FR-14.23 (#57). Route name is load-bearing (Playwright navigation) - named once, never renamed.
      { path: 'settings/desktops', name: 'settings.desktops', component: () => import('../views/settings/DesktopsView.vue') },
      { path: 'settings/servers', name: 'settings.servers', component: () => import('../views/settings/ServersView.vue') },

      // Admin
      { path: 'admin/audit-log', name: 'admin.audit-log', component: () => import('../views/admin/AuditLogView.vue') },
      // FR-13.27 (#24) — beside audit-log, NOT under settings/: that group is the org owner's
      // self-service area and restoring is not self-service. ⚠ No client-side gate here on
      // purpose — portal routes have none, and pretending otherwise would suggest the screen
      // is protected by something other than the server's allow-list. It is not.
      { path: 'admin/backup', name: 'admin.backup', component: () => import('../views/admin/BackupView.vue') },
    ],
  },
  // The person's orgs: where a sign-in that has not entered an org lands, and the "All
  // organizations" page of the org menu. The one screen an identity-only session may use.
  {
    path: '/orgs',
    component: () => import('../layouts/AuthLayout.vue'),
    children: [{ path: '', name: 'orgs', component: () => import('../views/OrgPickerView.vue'), meta: { person: true } }],
  },
  {
    path: '/auth',
    component: () => import('../layouts/AuthLayout.vue'),
    children: [
      { path: 'login', name: 'auth.login', component: () => import('../views/auth/LoginView.vue'), meta: { public: true } },
      { path: 'register', name: 'auth.register', component: () => import('../views/auth/RegisterView.vue'), meta: { public: true } },
      { path: 'oauth-callback', name: 'auth.oauth-callback', component: () => import('../views/auth/OAuthCallbackView.vue'), meta: { public: true } },
      // S-06 — where an activation email lands. Like `desktop-redeem` below, its code rides in the
      // URL FRAGMENT, so `consumeTokenHandoff` never sees it and no server log records it.
      { path: 'activate', name: 'auth.activate', component: () => import('../views/auth/ActivateView.vue'), meta: { public: true } },
      // Phase 4 — forgot password. The reset link carries its token in the URL FRAGMENT, like activation.
      { path: 'forgot-password', name: 'auth.forgot-password', component: () => import('../views/auth/ForgotPasswordView.vue'), meta: { public: true } },
      { path: 'reset-password', name: 'auth.reset-password', component: () => import('../views/auth/ResetPasswordView.vue'), meta: { public: true } },
      // FR-14.14 — where `lgr-web` lands after an OAuth sign-in that ran in the system browser.
      // ⚠ Its credentials are in the URL FRAGMENT, which the router never sees and no log
      // records; `consumeTokenHandoff` below is unaffected because there is no `?token=` here.
      { path: 'desktop-redeem', name: 'auth.desktop-redeem', component: () => import('../views/auth/DesktopRedeemView.vue'), meta: { public: true } },
    ],
  },
]

export const router = createRouter({
  history: createWebHistory(),
  // FR-05 (#12): Back/Forward restore the saved scroll offset; fresh navigations start at top.
  scrollBehavior(_to, _from, savedPosition) {
    return savedPosition || { top: 0 }
  },
  routes,
})

router.beforeEach((to, _from, next) => {
  // Accept a token from URL params ONLY on a local dev origin (FR-14.24) — on any other
  // origin it is stripped and ignored. A full reload follows either way so Pinia
  // re-initializes from the tab's session.
  //
  // ⚠ There is deliberately no exemption for the OAuth callback any more. It used to need one,
  // because it received the session JWT as `?token=` — which is exactly what made
  // `…/auth/oauth-callback?token=<attacker's JWT>` a working sign-in for someone else's account
  // while every other route was gated. The callback now reads nothing from the URL (its
  // credential is the httpOnly `oauth_handoff` cookie), so this route is covered like the rest.
  if (consumeTokenHandoff(to.query)) return

  const isPublic = to.matched.some(r => r.meta.public)
  const isGuest = to.matched.some(r => r.meta.guest)
  const forPerson = to.matched.some(r => r.meta.person)
  const signedIn = !!getToken()
  if (!isPublic && !signedIn) {
    next({ name: 'landing' })
  } else if (signedIn && !isPublic && !forPerson && !hasOrgSession()) {
    // Signed in as a person who has not entered an org yet: every other screen needs one.
    next({ name: 'orgs' })
  } else if (isGuest && signedIn) {
    const pendingInvite = sessionStorage.getItem('lgr_invite_code')
    if (pendingInvite) {
      next({ name: 'invite', params: { code: pendingInvite } })
    } else {
      next(hasOrgSession() ? { name: 'apps' } : { name: 'orgs' })
    }
  } else {
    next()
  }
})
