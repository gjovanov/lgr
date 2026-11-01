import type { NavigationGuardNext, RouteLocationNormalized, RouteRecordRaw } from 'vue-router'
import { servedByMaster } from 'ui-shared/nav/node-role'
import { getToken, hasOrgSession } from 'ui-shared/session/session'

/**
 * Where a visitor nobody signed in goes first (gjovanov/lgr#384). On lgrai.app, the landing page.
 * On a master, which marks its shell (`servedByMaster`), its own sign-in page: the landing page is
 * lgrai.app's marketing (pricing, a free sign-up), and a shop's till opened on it, with no
 * sign-in form, when it first showed its own server.
 */
const onMaster = servedByMaster()
const signedOutHome = onMaster ? 'auth.login' : 'landing'

/** The portal's routes: its own router's, and the one SPA's (FR-24 Phase 2). */
export const portalRoutes: RouteRecordRaw[] = [
  {
    path: '/landing',
    name: 'landing',
    component: () => import('./views/LandingView.vue'),
    meta: { public: true, guest: true },
    // The legal pages link back here, and so do bookmarks: a master has no landing page.
    beforeEnter: () => (onMaster ? { name: 'auth.login' } : true),
  },
  {
    path: '/privacy',
    name: 'privacy',
    component: () => import('./views/legal/PrivacyPolicyView.vue'),
    meta: { public: true },
  },
  {
    path: '/terms',
    name: 'terms',
    component: () => import('./views/legal/TermsView.vue'),
    meta: { public: true },
  },
  {
    path: '/',
    component: () => import('./layouts/DefaultLayout.vue'),
    children: [
      { path: '', redirect: '/apps' },
      { path: 'apps', name: 'apps', component: () => import('./views/AppHubView.vue') },
      { path: 'dashboard', name: 'dashboard', component: () => import('./views/dashboard/DashboardView.vue') },
      { path: 'invite/:code', name: 'invite', component: () => import('./views/invite/InviteLandingView.vue'), meta: { public: true } },
      // The person's own account: password, sign-in methods (multi-org sign-in, Phase 4).
      { path: 'account', name: 'account', component: () => import('./views/account/AccountView.vue') },

      // Settings
      { path: 'settings/organization', name: 'settings.organization', component: () => import('./views/settings/OrganizationView.vue') },
      { path: 'settings/users', name: 'settings.users', component: () => import('./views/settings/UsersView.vue') },
      { path: 'settings/invites', name: 'settings.invites', component: () => import('./views/settings/InvitesView.vue') },
      { path: 'settings/billing', name: 'settings.billing', component: () => import('./views/settings/BillingView.vue') },
      { path: 'settings/permission-sets', name: 'settings.permissionSets', component: () => import('./views/settings/PermissionSetsView.vue') },
      // FR-14.23 (#57). Route name is load-bearing (Playwright navigation) - named once, never renamed.
      { path: 'settings/desktops', name: 'settings.desktops', component: () => import('./views/settings/DesktopsView.vue') },
      { path: 'settings/servers', name: 'settings.servers', component: () => import('./views/settings/ServersView.vue') },
      // FR-20.98 (P3-8b): a master's own status page; on lgrai.app it says where its servers are shown.
      { path: 'settings/server', name: 'settings.server', component: () => import('./views/settings/ServerStatusView.vue') },

      // Admin
      { path: 'admin/audit-log', name: 'admin.audit-log', component: () => import('./views/admin/AuditLogView.vue') },
      // FR-13.27 (#24) — beside audit-log, NOT under settings/: that group is the org owner's
      // self-service area and restoring is not self-service. ⚠ No client-side gate here on
      // purpose — portal routes have none, and pretending otherwise would suggest the screen
      // is protected by something other than the server's allow-list. It is not.
      { path: 'admin/backup', name: 'admin.backup', component: () => import('./views/admin/BackupView.vue') },
      { path: 'admin/nodes', name: 'admin.nodes', component: () => import('./views/admin/NodesView.vue') },
      { path: 'admin/licences', name: 'admin.licences', component: () => import('./views/admin/LicencesView.vue') },
    ],
  },
  // The person's orgs: where a sign-in that has not entered an org lands, and the "All
  // organizations" page of the org menu. The one screen an identity-only session may use.
  {
    path: '/orgs',
    component: () => import('./layouts/AuthLayout.vue'),
    children: [{ path: '', name: 'orgs', component: () => import('./views/OrgPickerView.vue'), meta: { person: true } }],
  },
  // FR-20.39 (P2-4): lgrai.app's "Sign in with LGR" authorize page. Public: it finds this tab's
  // session itself, and sends a signed-out person to sign in first and back.
  { path: '/idp/authorize', name: 'idp.authorize', component: () => import('./views/idp/IdpAuthorizeView.vue'), meta: { public: true } },
  {
    path: '/auth',
    component: () => import('./layouts/AuthLayout.vue'),
    children: [
      // FR-20.39 (P2-4): where lgrai.app sends the person back to on a master.
      { path: 'idp/callback', name: 'auth.idp-callback', component: () => import('./views/auth/IdpCallbackView.vue'), meta: { public: true } },
      // FR-20.39 (P2-4b): where the desktop shell finishes it, the code and verifier in the FRAGMENT.
      { path: 'idp/desktop', name: 'auth.idp-desktop', component: () => import('./views/auth/IdpDesktopView.vue'), meta: { public: true } },
      { path: 'login', name: 'auth.login', component: () => import('./views/auth/LoginView.vue'), meta: { public: true } },
      { path: 'register', name: 'auth.register', component: () => import('./views/auth/RegisterView.vue'), meta: { public: true } },
      { path: 'oauth-callback', name: 'auth.oauth-callback', component: () => import('./views/auth/OAuthCallbackView.vue'), meta: { public: true } },
      // S-06 — where an activation email lands. Like `desktop-redeem` below, its code rides in the
      // URL FRAGMENT, so no server log records it.
      { path: 'activate', name: 'auth.activate', component: () => import('./views/auth/ActivateView.vue'), meta: { public: true } },
      // Phase 4 — forgot password. The reset link carries its token in the URL FRAGMENT, like activation.
      { path: 'forgot-password', name: 'auth.forgot-password', component: () => import('./views/auth/ForgotPasswordView.vue'), meta: { public: true } },
      { path: 'reset-password', name: 'auth.reset-password', component: () => import('./views/auth/ResetPasswordView.vue'), meta: { public: true } },
      // FR-14.14 — where `lgr-web` lands after an OAuth sign-in that ran in the system browser.
      // ⚠ Its credentials are in the URL FRAGMENT, which the router never sees and no log
      // records.
      { path: 'desktop-redeem', name: 'auth.desktop-redeem', component: () => import('./views/auth/DesktopRedeemView.vue'), meta: { public: true } },
    ],
  },
]

/**
 * The portal's rules for a route of its own: public, guest and person-only pages (FR-24.12 merges
 * them with the modules' org-session check in the one SPA).
 */
export function portalGuard(to: RouteLocationNormalized, next: NavigationGuardNext): void {
  const isPublic = to.matched.some(r => r.meta.public)
  const isGuest = to.matched.some(r => r.meta.guest)
  const forPerson = to.matched.some(r => r.meta.person)
  const signedIn = !!getToken()
  if (!isPublic && !signedIn) {
    next({ name: signedOutHome })
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
}
