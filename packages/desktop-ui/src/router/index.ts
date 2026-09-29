import { createRouter, createWebHistory } from 'vue-router'

/**
 * The shell's own pages — and nothing else (FR-14.8).
 *
 * ⚠ This router used to mount ~50 routes importing views straight out of `accounting-ui`,
 * `invoicing-ui`, `inventory-ui`, `payroll-ui`, `pos-ui` and `reports-ui`, so the desktop was a
 * second, hand-maintained copy of the whole web app. It also carried a login form pre-filled with
 * `my-company` / `admin` for the sidecar's demo org. Local mode is gone (FR-14.34), and with it
 * the reason for any of that: the cloud app opens in the `lgr-web` window (FR-14.13), served by
 * the cloud, and sign-in happens inside it with the portal's own login.
 *
 * What is left is the five views the shell owns, which are bundled into the binary and **work
 * with no network** — when the server is down, this is the whole product (FR-14.31).
 *
 * ⚠ They are placeholders in this chunk, deliberately. FR-14.30–14.33 (Overview with Open LGR,
 * Settings, Onboarding, Logs, Diagnostics) is its own chunk; what matters here is that
 * `desktop-ui` builds as part of `bun run build`, so the bit-rot that broke it unnoticed for four
 * days in August cannot recur.
 *
 * No `?token=` handling, and none is ever to be added (FR-14.24): the shell never hands a
 * credential to a page.
 */
const routes = [
  { path: '/', redirect: { name: 'overview' } },
  { path: '/overview', name: 'overview', component: () => import('../views/OverviewView.vue') },
  { path: '/settings', name: 'settings', component: () => import('../views/SettingsView.vue') },
  { path: '/onboarding', name: 'onboarding', component: () => import('../views/OnboardingView.vue') },
  { path: '/logs', name: 'logs', component: () => import('../views/LogsView.vue') },
  { path: '/diagnostics', name: 'diagnostics', component: () => import('../views/DiagnosticsView.vue') },
  // Anything else is a stale deep link from the local-mode build.
  { path: '/:pathMatch(.*)*', redirect: { name: 'overview' } },
]

export const router = createRouter({
  history: createWebHistory(),
  scrollBehavior(_to, _from, savedPosition) {
    return savedPosition || { top: 0 }
  },
  routes,
})
