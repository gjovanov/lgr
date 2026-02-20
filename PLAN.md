# Phase 1 Implementation Plan: Foundation (Shared Packages + Portal)

## Overview

Break the monolithic `api/` + `ui/` into a Portal app + shared UI libraries while keeping the old monolith running unchanged. The approach is **copy-first, delete-later** — no existing code is removed until Phase 5.

**New packages created in this phase (6):**
- `packages/portal-api/` — Portal backend (auth, tenant, billing, app hub)
- `packages/portal-ui/` — Portal frontend (login, register, app hub, settings)
- `packages/ui-shared/` — Shared composables, plugins, components
- `packages/ui-shell/` — App shell layout (top bar, app switcher, sidebar)

**Existing packages modified (2):**
- `packages/config/` — add `APP_REGISTRY`, `AppId` type
- `packages/db/` — add `OrgApp` model

**Existing packages unchanged:**
- `packages/api/` — stays as-is (monolith coexists during transition)
- `packages/ui/` — stays as-is (monolith coexists during transition)
- `packages/services/` — stays as-is (shared, consumed by both old API and portal-api)
- `packages/reporting/` — stays as-is

---

## Step 1: Config — APP_REGISTRY + AppId type

**File: `packages/config/src/constants.ts`**

Add at the end:

```typescript
export const APP_IDS = ['accounting', 'invoicing', 'warehouse', 'payroll', 'hr', 'crm', 'erp'] as const
export type AppId = (typeof APP_IDS)[number]

export const APP_REGISTRY: Record<AppId, {
  name: string
  icon: string
  color: string
  port: number
  uiPort: number
  requiredPermission: string
  description: string
}> = {
  accounting: { name: 'Accounting', icon: 'mdi-chart-bar', color: '#4caf50', port: 4010, uiPort: 4011, requiredPermission: 'accounting.read', description: 'Chart of accounts, journal entries, financial statements' },
  invoicing:  { name: 'Invoicing',  icon: 'mdi-receipt-text', color: '#ff9800', port: 4020, uiPort: 4021, requiredPermission: 'invoicing.read', description: 'Contacts, invoices, payments, cash orders' },
  warehouse:  { name: 'Warehouse',  icon: 'mdi-package-variant', color: '#2196f3', port: 4030, uiPort: 4031, requiredPermission: 'warehouse.read', description: 'Products, stock levels, movements, inventory' },
  payroll:    { name: 'Payroll',    icon: 'mdi-cash-multiple', color: '#9c27b0', port: 4040, uiPort: 4041, requiredPermission: 'payroll.read', description: 'Employees, payroll runs, payslips, timesheets' },
  hr:         { name: 'HR',         icon: 'mdi-account-group', color: '#00bcd4', port: 4050, uiPort: 4051, requiredPermission: 'hr.read', description: 'Departments, leave management, documents' },
  crm:        { name: 'CRM',        icon: 'mdi-trending-up', color: '#e91e63', port: 4060, uiPort: 4061, requiredPermission: 'crm.read', description: 'Leads, deals, pipelines, activities' },
  erp:        { name: 'ERP',        icon: 'mdi-factory', color: '#795548', port: 4070, uiPort: 4071, requiredPermission: 'erp.read', description: 'Manufacturing, production, POS' },
}

// Plan-based app limits
export const PLAN_APP_LIMITS: Record<string, number> = {
  free: 2,
  starter: 4,
  pro: 7,
  professional: 7,
  enterprise: 7,
}
```

**Verification:** `bun run test` (existing tests still pass — additive change only)

---

## Step 2: DB — OrgApp model

**New file: `packages/db/src/models/org-app.model.ts`**

```typescript
import { Schema, model, type Document } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IOrgApp extends Document {
  orgId: Schema.Types.ObjectId
  appId: string  // AppId from config/constants
  enabled: boolean
  activatedAt: Date
  activatedBy: Schema.Types.ObjectId
}

const schema = new Schema<IOrgApp>({
  appId:       { type: String, required: true },
  enabled:     { type: Boolean, default: true },
  activatedAt: { type: Date, default: Date.now },
  activatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true })

schema.plugin(tenantPlugin)
schema.index({ orgId: 1, appId: 1 }, { unique: true })

export const OrgApp = model<IOrgApp>('OrgApp', schema)
```

**Edit: `packages/db/src/models/index.ts`**

Add to the Core section:
```typescript
export { OrgApp, type IOrgApp } from './org-app.model.js'
```

**Verification:** `bun run test` (existing tests still pass)

---

## Step 3: Services — OrgApp DAO + app-hub service

**New file: `packages/services/src/dao/org-app.dao.ts`**

Standard DAO extending BaseDao for OrgApp CRUD. Key methods:
- `findByOrgId(orgId)` — list all enabled apps for an org
- `activateApp(orgId, appId, userId)` — create/enable
- `deactivateApp(orgId, appId)` — set enabled=false
- `isAppEnabled(orgId, appId)` — check single app

**New file: `packages/services/src/biz/app-hub.service.ts`**

Business logic:
- `getAvailableApps(orgId, userPermissions)` — returns APP_REGISTRY entries filtered by org plan limits + user permissions + OrgApp enabled status
- `activateApp(orgId, appId, userId)` — validates plan limits before activating
- `deactivateApp(orgId, appId)` — deactivates

**Verification:** `bun run test` (additive, existing tests still pass)

---

## Step 4: portal-api package

**New: `packages/portal-api/package.json`**
```json
{
  "name": "portal-api",
  "type": "module",
  "scripts": {
    "dev": "bun --env-file=../../.env --watch src/index.ts",
    "start": "bun --env-file=../../.env src/index.ts"
  },
  "dependencies": {
    "config": "workspace:*",
    "db": "workspace:*",
    "services": "workspace:*",
    "reporting": "workspace:*",
    "elysia": "^1.3.0",
    "@elysiajs/jwt": "^1.3.0",
    "@elysiajs/cors": "^1.3.0",
    "@elysiajs/swagger": "^1.3.0",
    "@elysiajs/static": "^1.3.0",
    "@sinclair/typebox": "^0.34.0"
  }
}
```

**Structure:**
```
packages/portal-api/src/
  index.ts              ← Elysia entry, port 4001
  auth/
    auth.service.ts     ← Full auth (copy from api/src/auth/auth.service.ts — unchanged)
  middleware/
    tenant.middleware.ts ← Copy from api/src/middleware/
  controllers/
    auth.controller.ts      ← Copy from api/src/controllers/
    oauth.controller.ts     ← Copy from api/src/controllers/
    org.controller.ts       ← Copy from api/src/controllers/
    user.controller.ts      ← Copy from api/src/controllers/
    invite.controller.ts    ← Copy from api/src/controllers/
    stripe.controller.ts    ← Copy from api/src/controllers/
    file.controller.ts      ← Copy from api/src/controllers/
    notification.controller.ts ← Copy from api/src/controllers/
    export.controller.ts    ← Copy from api/src/controllers/
    app-hub.controller.ts   ← NEW: GET /org/:orgId/apps, POST activate/deactivate
  websocket/
    ws.server.ts         ← Copy from api/src/websocket/
```

**New controller: `app-hub.controller.ts`**
```
Prefix: /org/:orgId/apps
  GET /           → list available apps for this org+user (uses app-hub.service)
  POST /:appId/activate   → admin-only, activate app for org
  POST /:appId/deactivate → admin-only, deactivate app for org
```

**`portal-api/src/index.ts`** — same pattern as api/index.ts but:
- Only registers portal controllers (not accounting, invoicing, etc.)
- Port: `config.port` (defaults to 4001, same as old API for now — will diverge later)
- Static file serving: `../portal-ui/dist` instead of `../ui/dist`
- SPA fallback paths: `/`, `/landing`, `/auth/*`, `/dashboard`, `/settings/*`, `/admin/*`, `/invite/*`
- Swagger tag: `Portal`

**Key: `auth.service.ts` remains identical** — same JWT secret, same cookie name, same derive logic. This ensures token compatibility with the old monolith during coexistence.

**Verification:** Start portal-api on a different port (e.g., PORT=4002), verify all auth/org/user/invite endpoints work.

---

## Step 5: app-auth.service.ts (verify-only auth for domain apps)

**New file: `packages/portal-api/src/auth/app-auth.service.ts`**

Slim version of AuthService — **verify only, never issue tokens**:
```typescript
export const AppAuthService = new Elysia({ name: 'Service.AppAuth' })
  .use(jwt({ name: 'jwt', secret: config.jwt.secret }))
  .derive({ as: 'scoped' }, async ({ cookie, headers, jwt }) => {
    // Same token extraction logic as AuthService
    const token = cookie?.auth?.value || ...
    const payload = await jwt.verify(token)
    const user = payload ? (payload as unknown as UserTokenized) : null
    return { user }
  })
  .macro(({ onBeforeHandle }) => ({
    isSignIn(_value?: boolean) {
      onBeforeHandle(({ user, status }) => {
        if (!user) return status(401, { message: 'Unauthorized' })
      })
    },
  }))
```

Functionally identical to AuthService but:
- Named `'Service.AppAuth'` to distinguish
- Will be the canonical auth plugin for all domain apps (Phase 2+)
- No token issuance endpoints — only verification

**This file lives in portal-api/ for now** but will be copied to each domain-api in later phases. Alternatively, could live in a shared `auth-shared/` package — but that's premature for Phase 1.

---

## Step 6: ui-shared package

**New: `packages/ui-shared/package.json`**
```json
{
  "name": "ui-shared",
  "type": "module",
  "exports": {
    "./composables/*": "./src/composables/*.ts",
    "./plugins/*": "./src/plugins/*.ts",
    "./components/*": "./src/components/*.vue",
    "./locales/*": "./src/locales/*.json"
  },
  "dependencies": {
    "vue": "^3.5.21",
    "vuetify": "^3.10.0",
    "vue-router": "^4.5.1",
    "pinia": "^3.0.3",
    "vue-i18n": "^9.14.0",
    "axios": "^1.7.0",
    "@mdi/font": "^7.4.0"
  }
}
```

**Structure:**
```
packages/ui-shared/src/
  composables/
    useHttpClient.ts   ← Refactored: accepts baseURL param, defaults to '/api'
    useSnackbar.ts     ← Copy as-is (module singleton)
    useWebSocket.ts    ← Copy as-is (module singleton)
    useCurrency.ts     ← Copy as-is (pure utility)
  plugins/
    i18n.ts            ← Factory: createI18nPlugin(localeMessages) — parameterized
    vuetify.ts         ← Factory: createVuetifyPlugin(i18n) — parameterized
    index.ts           ← registerPlugins(app, { localeMessages })
  components/
    DataTable.vue      ← Copy from ui/src/components/shared/
    ExportMenu.vue     ← Copy
    CurrencyInput.vue  ← Copy
    FileUpload.vue     ← Copy
    AuditTrail.vue     ← Copy
  locales/
    en.json            ← Copy shared keys (app, nav, common, auth, validation, settings, admin)
    mk.json, de.json, bg.json ← Same shared subset
```

**Key refactoring: `useHttpClient.ts`**

Change from:
```typescript
const httpClient = axios.create({ baseURL: '/api' })
```
To:
```typescript
let _httpClient: AxiosInstance | null = null

export function createHttpClient(baseURL = '/api'): AxiosInstance {
  // Same interceptor logic
  _httpClient = axios.create({ baseURL })
  // ... add interceptors
  return _httpClient
}

export function useHttpClient() {
  if (!_httpClient) _httpClient = createHttpClient()
  return { http: _httpClient }
}

export { _httpClient as httpClient }
```

Each app calls `createHttpClient('/api')` (portal) or `createHttpClient('http://localhost:4010/api')` (accounting) in its main.ts.

**Key refactoring: `i18n.ts` and `vuetify.ts`**

Convert from module-level singletons to factory functions:
```typescript
// i18n.ts
export function createI18nPlugin(additionalMessages?: Record<string, any>) { ... }

// vuetify.ts
export function createVuetifyPlugin(i18nInstance: I18n) { ... }
```

Each app calls these factories in its own `main.ts` / `plugins/index.ts`, passing app-specific locale messages.

**Locale splitting strategy:**
- `ui-shared/locales/en.json` contains keys: `app`, `nav`, `common`, `auth`, `validation`, `settings`, `admin`
- Domain apps have their own locale files with module-specific keys (e.g., `accounting-ui/locales/en.json` has only `accounting` keys)
- The app's `createI18nPlugin()` call merges shared + app-specific messages

---

## Step 7: ui-shell package

**New: `packages/ui-shell/package.json`**
```json
{
  "name": "ui-shell",
  "type": "module",
  "exports": {
    "./components/*": "./src/components/*.vue",
    "./layouts/*": "./src/layouts/*.vue"
  },
  "dependencies": {
    "vue": "^3.5.21",
    "vuetify": "^3.10.0",
    "vue-router": "^4.5.1",
    "pinia": "^3.0.3",
    "ui-shared": "workspace:*"
  }
}
```

**Structure:**
```
packages/ui-shell/src/
  layouts/
    AppShell.vue         ← Extracted from DefaultLayout.vue (parameterized)
    AuthLayout.vue       ← Copy from ui/src/layouts/ (minimal, reusable)
  components/
    AppSwitcher.vue      ← NEW: 9-dot grid menu showing available apps
    OrgSelector.vue      ← Extracted from DefaultLayout.vue org display
    UserMenu.vue         ← Extracted from DefaultLayout.vue user avatar/menu
    NotificationBell.vue ← Copy from ui/src/components/shared/
    ThemeToggle.vue      ← Extracted from DefaultLayout.vue theme button
    LocaleSwitcher.vue   ← Extracted from DefaultLayout.vue locale dropdown
```

**`AppShell.vue`** — the key component. Extracted from current `DefaultLayout.vue`:

```vue
<template>
  <v-app>
    <v-navigation-drawer v-model="drawer" :rail="rail">
      <slot name="sidebar" />
    </v-navigation-drawer>

    <v-app-bar>
      <v-app-bar-nav-icon @click="drawer = !drawer" />
      <OrgSelector />
      <v-spacer />
      <AppSwitcher />
      <LocaleSwitcher />
      <ThemeToggle />
      <NotificationBell />
      <UserMenu />
    </v-app-bar>

    <v-main>
      <slot />
    </v-main>
  </v-app>
</template>
```

**Props:** `appName` (string), `sidebarItems` (array of nav items for this app)

**`AppSwitcher.vue`** — the Google-style 9-dot grid:
- Fetches available apps from Portal API: `GET /api/org/:orgId/apps`
- Renders a grid of app tiles (icon + name + color)
- Each tile links to `http://localhost:{app.uiPort}` (dev) or the app's production URL
- Caches the app list in sessionStorage
- Highlights the current app

**`OrgSelector.vue`**:
- Displays current org name/slug
- Future: dropdown to switch orgs (if user belongs to multiple)

**`UserMenu.vue`**:
- Avatar with initials + fullName
- Dropdown: Profile, Preferences, Logout
- Logout calls Portal API `POST /api/auth/logout` and clears localStorage

---

## Step 8: portal-ui package

**New: `packages/portal-ui/package.json`**
```json
{
  "name": "portal-ui",
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build" },
  "dependencies": {
    "vue": "^3.5.21", "vuetify": "^3.10.0", "vue-router": "^4.5.1",
    "pinia": "^3.0.3", "vue-i18n": "^9.14.0", "axios": "^1.7.0",
    "date-fns": "^4.0.0", "@mdi/font": "^7.4.0",
    "ui-shared": "workspace:*", "ui-shell": "workspace:*"
  },
  "devDependencies": {
    "vite": "^7.1.5", "@vitejs/plugin-vue": "^5.2.0",
    "vite-plugin-vuetify": "^2.1.0", "sass": "^1.80.0"
  }
}
```

**`packages/portal-ui/vite.config.ts`**
- Port: 4000
- Proxy: `/api` → `http://localhost:4001`, `/ws` → `ws://localhost:4001`
- Alias: `@` → `src/`

**Structure:**
```
packages/portal-ui/src/
  main.ts
  App.vue                         ← Root app with snackbar
  plugins/
    index.ts                      ← registerPlugins using ui-shared factories
    router.ts                     ← Portal-only routes
  store/
    app.store.ts                  ← Copy from ui/ (auth + UI state)
    notification.store.ts         ← Copy from ui/
    invite.store.ts               ← Copy from ui/
    settings.store.ts             ← Implement (was stub)
    admin.store.ts                ← Implement (was stub)
  views/
    auth/
      LoginView.vue               ← Copy from ui/
      RegisterView.vue            ← Copy from ui/
      OAuthCallbackView.vue       ← Copy from ui/
    LandingView.vue               ← Copy from ui/
    AppHubView.vue                ← NEW: app grid (replaces DashboardView)
    invite/
      InviteLandingView.vue       ← Copy from ui/
    settings/
      OrganizationView.vue        ← Copy from ui/
      UsersView.vue               ← Copy from ui/
      InvitesView.vue             ← Copy from ui/
      BillingView.vue             ← Copy from ui/
    admin/
      AuditLogView.vue            ← Copy from ui/
  locales/
    en.json                       ← Portal-specific keys (merged with ui-shared locales)
    mk.json, de.json, bg.json
```

**Router (`portal-ui/src/plugins/router.ts`):**
```
/landing             → LandingView (public, guest)
/auth/login          → LoginView (public)
/auth/register       → RegisterView (public)
/auth/oauth-callback → OAuthCallbackView (public)
/invite/:code        → InviteLandingView (public)
/                    → AppHubView (auth required, default redirect)
/dashboard           → redirect to /
/settings/organization → OrganizationView
/settings/users        → UsersView
/settings/invites      → InvitesView
/settings/billing      → BillingView
/admin/audit-log       → AuditLogView
```

**`AppHubView.vue`** — the central app grid:
```vue
<template>
  <AppShell app-name="LGR Portal">
    <template #sidebar>
      <!-- Portal nav: Dashboard, Settings, Admin -->
    </template>

    <v-container>
      <h1>{{ $t('appHub.title') }}</h1>
      <v-row>
        <v-col v-for="app in availableApps" :key="app.id" cols="12" sm="6" md="4" lg="3">
          <v-card :href="app.url" class="text-center pa-6" hover>
            <v-icon :icon="app.icon" :color="app.color" size="48" />
            <v-card-title>{{ app.name }}</v-card-title>
            <v-card-subtitle>{{ app.description }}</v-card-subtitle>
          </v-card>
        </v-col>
      </v-row>

      <!-- Settings shortcuts -->
      <v-divider class="my-6" />
      <v-row>
        <v-btn to="/settings/organization">Settings</v-btn>
        <v-btn to="/settings/users">Users</v-btn>
        <v-btn to="/settings/billing">Billing</v-btn>
      </v-row>
    </v-container>
  </AppShell>
</template>
```

Fetches apps from `GET /api/org/:orgId/apps` via httpClient.

---

## Step 9: Root package.json scripts

**Edit: `/package.json`** — add:
```json
{
  "scripts": {
    "dev:portal-api": "cd packages/portal-api && bun run dev",
    "dev:portal-ui":  "cd packages/portal-ui && bun run dev",
    "dev:portal":     "concurrently \"bun run dev:portal-api\" \"bun run dev:portal-ui\"",
    "test:portal":    "bun test packages/tests/src/integration/portal --env-file=.env.test --timeout 120000"
  }
}
```

Existing `dev:api`, `dev:ui`, `test`, `test:e2e` remain unchanged.

---

## Step 10: Integration tests

**New test files in `packages/tests/src/integration/portal/`:**

### `app-activation.test.ts`
- Test OrgApp CRUD via DAO
- Test plan-based limits (free org can only activate 2 apps)
- Test `getAvailableApps()` filtering by permissions
- Test activate/deactivate flow
- Test duplicate activation (idempotent)

### `auth.flow.test.ts` (portal-specific copy)
- Existing auth tests continue to work against services directly
- No changes needed — same biz services, same test setup

### `org-app.dao.test.ts`
- Unit test for OrgApp DAO methods

**Verification:** `bun test packages/tests/src/integration/portal --env-file=.env.test`

---

## Step 11: E2E tests

**New test files in `packages/e2e/tests/portal/`:**

### `app-hub.spec.ts`
- Login → lands on App Hub (not old dashboard)
- Verify app tiles rendered with correct icons/colors
- Click an app tile → navigates to app URL
- Admin: activate/deactivate app → tile appears/disappears

### `login.spec.ts`
- Standard login flow against Portal UI (port 4000 or 4001 in production)
- OAuth redirect flow

**E2E config:** Extend `playwright.config.ts` to add a portal project:
```typescript
projects: [
  { name: 'portal', use: { baseURL: 'http://localhost:4001' } },
  { name: 'monolith', use: { baseURL: 'http://localhost:4001' } },
]
```

---

## Step 12: Seed update

**Edit: `packages/tests/src/helpers/seed.ts`**

Add OrgApp seed data — activate all 7 apps for Acme Corp, 3 for Beta Inc, 2 for Regal (free plan).

---

## Execution Order

| # | Step | Dependencies | Verification |
|---|------|-------------|--------------|
| 1 | Config: APP_REGISTRY | None | `bun run test` (all pass) |
| 2 | DB: OrgApp model | Step 1 | `bun run test` (all pass) |
| 3 | Services: OrgApp DAO + app-hub service | Steps 1-2 | `bun run test` (all pass) |
| 4 | portal-api package | Steps 1-3 | Start on alt port, curl endpoints |
| 5 | app-auth.service.ts | Step 4 | Included in portal-api |
| 6 | ui-shared package | None (parallel with 1-5) | Import test from portal-ui |
| 7 | ui-shell package | Step 6 | Import test from portal-ui |
| 8 | portal-ui package | Steps 4, 6, 7 | `bun run dev:portal-ui`, manual test |
| 9 | Root scripts | Steps 4, 8 | `bun run dev:portal` |
| 10 | Integration tests | Steps 1-3 | `bun run test:portal` |
| 11 | E2E tests | Steps 4, 8 | Portal E2E suite |
| 12 | Seed update | Steps 1-2 | `bun run seed` |

**Total new files: ~40**
**Total modified files: ~5** (config/constants.ts, db/models/index.ts, root package.json, seed.ts, playwright.config.ts)

---

## Key Decisions

1. **Copy, don't move** — old `api/` and `ui/` remain fully functional. Zero regression risk.
2. **Same JWT secret + cookie name** — Portal and monolith accept each other's tokens. Users can switch between them seamlessly.
3. **Portal API on port 4001** (same as old API during dev) — in production, a reverse proxy routes requests. During dev, run one or the other, or run portal-api on 4002.
4. **ui-shared uses factory functions** — `createI18nPlugin()`, `createVuetifyPlugin()`, `createHttpClient()` — so each app can parameterize.
5. **AppSwitcher fetches from Portal API** — domain apps call Portal's `/api/org/:orgId/apps` for the app list, cached in sessionStorage.
6. **Tests remain in `packages/tests/`** — portal-specific tests go in a `portal/` subdirectory. Shared setup and factories are reused.
