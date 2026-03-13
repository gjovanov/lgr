# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LGR (Ledger)** is a full-stack multi-tenant ERP system built as a Bun monorepo. Stack: Elysia.js + MongoDB/Mongoose + Vue 3/Vuetify 3 + Pinia.

## Commands

```bash
# Development
bun run dev:api              # API with watch mode (port 4001)
bun run dev:ui               # Vite dev server (port 4000)
bun run build:ui             # Production UI build
bun run start                # Production API (serves built UI)
bun run seed                 # Seed database (Acme Corp + Beta Inc)

# Testing
bun run test                 # All integration tests (mongodb-memory-server)
bun test packages/tests/src/integration/auth.flow.test.ts  # Single test file
bun run test:e2e             # Playwright E2E tests
cd packages/e2e && bunx playwright test tests/warehouse.spec.ts  # Single E2E file

# Infrastructure
docker compose up -d         # Start MongoDB (no auth, port 27018)
```

## Architecture

```
packages/
  config/    → Shared config (env vars) + constants (roles, permissions, modules, enums)
  db/        → Mongoose models (48) + tenant plugin + connection management
  services/  → Business logic (biz/), DAOs (dao/), background tasks, logger
  api/       → Elysia controllers (35) + JWT auth plugin + WebSocket + tenant middleware
  reporting/ → Excel (ExcelJS) + PDF (md-to-pdf) export generators
  ui/        → Vue 3 + Vuetify 3 + Vite 7 frontend (11 Pinia stores, 13 view modules)
  tests/     → Bun integration tests with mongodb-memory-server
  e2e/       → Playwright E2E tests
```

### Package dependency flow
`config` ← `db` ← `services` ← `api` (+ `reporting`)
`ui` is standalone (communicates via HTTP/WS to `api`)

## Multi-Tenancy

Every data model uses `tenantPlugin` which adds `orgId` and auto-filters all queries. All API routes are scoped: `/api/org/:orgId/[module]/[resource]`.

## Auth Pattern

`AuthService` is an Elysia plugin (`packages/api/src/auth/auth.service.ts`) that:
- Derives `user` from cookie or `Authorization: Bearer` header
- Provides `{ isSignIn: true }` macro for route protection
- JWT payload: `{ id, email, username, firstName, lastName, role, orgId, permissions }`

Login requires `orgSlug` (case-insensitive). Seed credentials: `acme-corp` / `admin` / `test123`.

### OAuth Social Login

OAuth controller at `/api/oauth/:provider` supports Google, Facebook, GitHub, LinkedIn, Microsoft.

**Flow**: `GET /api/oauth/:provider?org_slug=xxx` → redirect to provider → callback at `/api/oauth/callback/:provider` → create/link user → JWT cookie → redirect to frontend.

**Callback URLs** (register in provider apps):
```
http://localhost:4001/api/oauth/callback/google
http://localhost:4001/api/oauth/callback/facebook
http://localhost:4001/api/oauth/callback/github
http://localhost:4001/api/oauth/callback/linkedin
http://localhost:4001/api/oauth/callback/microsoft
```

**Env vars**: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `FACEBOOK_CLIENT_ID`, `FACEBOOK_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `OAUTH_BASE_URL`, `OAUTH_FRONTEND_URL`.

OAuth users have `oauthProviders[]` on User model and `password` is optional (OAuth-only users have no password).

## Controller Pattern

```typescript
// Route prefix: /org/:orgId/[module]/[resource]
export const fooController = new Elysia({ prefix: '/org/:orgId/module/foo' })
  .use(AuthService)
  .get('/', handler, { isSignIn: true })    // List (returns { foos: data, total, page, pageSize })
  .post('/', handler, { isSignIn: true, body: t.Object({...}) })  // Create
  .get('/:id', handler, { isSignIn: true }) // Get one
  .put('/:id', handler, { isSignIn: true, body: t.Object({...}) })  // Update
  .delete('/:id', handler, { isSignIn: true }) // Delete
```

**Store response contract**: List endpoints must return a named key matching the store's expectation (e.g., `{ products: data, total }` not `{ data, total }`). Each Pinia store destructures a specific key.

## DB Model Pattern

```typescript
const schema = new Schema<IFoo>({ /* fields */ }, { timestamps: true })
schema.plugin(tenantPlugin)  // Adds orgId + auto-filter
schema.index({ orgId: 1, someField: 1 }, { unique: true })
export const Foo = model<IFoo>('Foo', schema)
```

Models export both the interface (`IFoo`) and the model (`Foo`) from `db/models` barrel.

## Frontend Conventions

- **Plugin order is critical**: i18n → vuetify → pinia → router (vuetify locale adapter requires i18n)
- **Vuetify i18n**: `$vuetify.*` keys merged into i18n messages from `vuetify/lib/locale/`
- **Views** make direct `httpClient` calls or use Pinia store actions — URLs must match controller prefixes exactly
- **Organization interface** uses `id` (not `_id`): `appStore.currentOrg?.id`

## Test Setup

**Integration tests** (`packages/tests/`):
- `mongodb-memory-server` for isolated DB per test run
- `setupTestDB()` / `teardownTestDB()` / `clearCollections()` helpers
- Tests import business services directly, not HTTP

**E2E tests** (`packages/e2e/`):
- Playwright against `http://localhost:4001`
- Auto-starts API via `webServer` config
- For Vuetify v-select: use `getByRole('combobox', { name: /label/i })` not `getByLabel()` (clearable icon causes strict mode violations)

## Environment

- `.env` — development (MongoDB at `localhost:27018/lgr`, no auth)
- `.env.test` — testing (overridden by mongodb-memory-server)
- API `packages/api/package.json` scripts use `--env-file=../../.env` to load root env
- Docker: `docker-compose.yml` runs MongoDB 7 without authentication

## Deployment

Deployment configuration lives in a **separate repo**: https://github.com/gjovanov/lgr-deploy (typically cloned as a sibling folder `../lgr-deploy/`). This repo contains Docker Compose, reverse proxy configs, CI/CD pipelines, and environment-specific settings for staging/production deployments.

The production infrastructure runs on **Kubernetes**, managed via: https://github.com/gjovanov/k8s-cluster-multi (typically cloned as a sibling folder `../k8s-cluster-multi/`). This repo contains K8s manifests, Helm charts, and cluster configuration.

When working on deployment or infrastructure tasks, reference or modify files in those sibling repos.

## Post-Implementation Testing

After every feature or fix, verify your changes:

| Change type | Command | What it checks |
|-------------|---------|----------------|
| Backend (models, services, controllers) | `bun run test` | Integration tests (mongodb-memory-server) |
| Frontend (views, stores, composables) | `bun run build:ui` | TypeScript + Vite build |
| Full-flow (auth, routes, UI+API) | `bun run test:e2e` | Playwright E2E tests |

Run the **most specific** command first. If a backend change also affects the frontend, run both.

## ERP Modules

Accounting (accounts, journal entries, fiscal years/periods, fixed assets, bank accounts, reconciliation, tax returns, exchange rates) · Invoicing (contacts, invoices, payment orders, cash orders) · Warehouse (products, warehouses, stock levels, stock movements, inventory counts, price lists) · Payroll (employees, payroll runs, payslips, timesheets) · HR (departments, leave types/requests/balances, business trips, employee documents) · CRM (leads, deals, pipelines, activities) · ERP (BOM, production orders, construction projects, POS)

---

## Goal: Multi-Tenant × Multi-App Architecture

### Vision

Refactor LGR from a monolithic multi-tenant ERP into a **multi-app ecosystem** (Google Workspace model). Each ERP module becomes an independent app with its own API, UI, tests, and deployment. A central **Portal app** handles authentication, tenant management, and app navigation — connecting all child apps through shared identity and a unified app-switching experience.

```
┌─────────────────────────────────────────────────────────────────┐
│                        LGR Workspace                            │
│                                                                 │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │  Portal   │  │Accounting│  │Invoicing │  │Warehouse │       │
│  │  (Auth,   │  │   App    │  │   App    │  │   App    │       │
│  │  Tenant,  │  │          │  │          │  │          │       │
│  │  AppHub)  │  └──────────┘  └──────────┘  └──────────┘       │
│  └──────────┘  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│                │  Payroll  │  │    HR    │  │   CRM    │       │
│                │   App     │  │   App    │  │   App    │       │
│                │           │  │          │  │          │       │
│                └──────────┘  └──────────┘  └──────────┘       │
│                ┌──────────┐                                     │
│                │   ERP    │                                     │
│                │   App    │                                     │
│                │(Mfg+POS) │                                     │
│                └──────────┘                                     │
└─────────────────────────────────────────────────────────────────┘
```

### Architecture: 8 Apps (1 Portal + 7 Domain Apps)

#### Portal App (gateway + identity)
- **Auth**: login, register, OAuth (Google/Facebook/GitHub/LinkedIn/Microsoft), JWT issuance
- **Tenant management**: org creation, settings, subscription/billing (Stripe), user/role management, invites
- **App Hub**: grid/list of available apps per org (based on subscription plan + permissions)
- **Shared UI shell**: top bar with app switcher (like Google's 9-dot grid), org selector, user menu, notifications
- **Models owned**: Org, User, Invite, AuditLog, Notification, BackgroundTask, File
- **Services owned**: auth, oauth, stripe, file, cloud-storage, ai-recognition, currency
- **Port**: 4000 (UI) / 4001 (API)

#### Domain Apps (7 independent apps)

| App | Module | Models | Controllers | Views | Cross-Module Dependencies |
|-----|--------|--------|-------------|-------|---------------------------|
| **Accounting** | accounting | Account, FiscalYear, FiscalPeriod, JournalEntry, FixedAsset, BankAccount, BankReconciliation, TaxReturn, ExchangeRate (9) | 9 | 10 | None (source of truth for chart of accounts) |
| **Invoicing** | invoicing | Contact, Invoice, PaymentOrder, CashOrder (4) | 4 | 9 | → Accounting (payment creates journal entries) |
| **Warehouse** | warehouse | Product, Warehouse, StockLevel, StockMovement, InventoryCount, PriceList (6) | 6 | 7 | None (source of truth for stock) |
| **Payroll** | payroll | Employee, PayrollRun, Payslip, Timesheet (4) | 4 | 5 | None |
| **HR** | hr | Department, LeaveType, LeaveRequest, LeaveBalance, BusinessTrip, EmployeeDocument (6) | 6 | 4 | None |
| **CRM** | crm | Lead, Deal, Pipeline, Activity (4) | 4 | 3 | None |
| **ERP** | erp | BillOfMaterials, ProductionOrder, ConstructionProject, POSSession, POSTransaction (5) | 4 | 4 | → Warehouse (production consumes/produces stock) |

### Monorepo Structure (target)

```
packages/
  # ── Shared foundation (unchanged concept, refined scope) ──
  config/              → Constants, enums, permissions, module registry
  db/                  → Mongoose models, tenant plugin, connection (ALL models stay here)
  services/            → ALL DAOs + ALL biz services (shared data layer)
  reporting/           → Excel/PDF generators (shared, consumed by app APIs)

  # ── Portal app ──
  portal-api/          → Elysia: auth, oauth, org, user, invite, stripe, file, notification, ws
  portal-ui/           → Vue: login, register, oauth-callback, app-hub, settings, admin, billing

  # ── Domain apps (each is an independent API + UI pair) ──
  accounting-api/      → Elysia: 9 accounting controllers + report endpoints
  accounting-ui/       → Vue: 10 accounting views + accounting store

  invoicing-api/       → Elysia: 4 invoicing controllers
  invoicing-ui/        → Vue: 9 invoicing views + invoicing store

  warehouse-api/       → Elysia: 6 warehouse controllers
  warehouse-ui/        → Vue: 7 warehouse views + warehouse store

  payroll-api/         → Elysia: 4 payroll controllers
  payroll-ui/          → Vue: 5 payroll views + payroll store

  hr-api/              → Elysia: 6 HR controllers
  hr-ui/               → Vue: 4 HR views + hr store

  crm-api/             → Elysia: 4 CRM controllers
  crm-ui/              → Vue: 3 CRM views + crm store

  erp-api/             → Elysia: 4 ERP controllers (BOM, production, construction, POS)
  erp-ui/              → Vue: 4 ERP views + erp store

  # ── Shared UI library ──
  ui-shell/            → App shell: top bar, app switcher, org selector, sidebar, layout components
  ui-shared/           → Shared composables (useHttpClient, useSnackbar, useWebSocket), i18n, vuetify plugin

  # ── Testing ──
  tests/               → Integration tests (per-app suites + cross-app flows)
  e2e/                 → Playwright E2E (per-app specs + cross-app journeys)
```

### Shared Identity & Auth (SSO across apps)

All apps share a single JWT issued by the Portal. Each domain app validates the JWT but does NOT issue tokens.

```
Portal API (port 4001)          — issues JWT, manages sessions
Accounting API (port 4010)      — validates JWT, serves accounting data
Invoicing API (port 4020)       — validates JWT, serves invoicing data
Warehouse API (port 4030)       — validates JWT, serves warehouse data
Payroll API (port 4040)         — validates JWT, serves payroll data
HR API (port 4050)              — validates JWT, serves HR data
CRM API (port 4060)             — validates JWT, serves CRM data
ERP API (port 4070)             — validates JWT, serves ERP data
```

**Auth flow**:
1. User navigates to any app → if no valid JWT, redirect to Portal login
2. Portal authenticates → issues JWT cookie (domain-scoped for all apps in dev, shared domain in prod)
3. JWT payload (unchanged): `{ id, email, username, firstName, lastName, role, orgId, permissions }`
4. Each domain API has a slim `AuthService` plugin that **verifies** (not issues) the JWT
5. App switching: Portal UI's app-hub grid links to each app's URL — JWT cookie travels with the request

**Shared AuthService refactor**:
- Extract `AuthService` into two variants:
  - `portal-auth.service.ts` — full auth (login, register, OAuth, token issuance)
  - `app-auth.service.ts` — verification-only (validate JWT, derive `user`, `isSignIn` macro)
- Both live in a shared package or are copied into each app API

### Cross-Module Communication

Two modules have cross-boundary dependencies that must be decoupled:

**1. Invoicing → Accounting** (payment recording creates journal entries)
- **Pattern**: Event-based via shared MongoDB collection or lightweight event bus
- **Implementation**: `invoicing.service.recordPayment()` emits a `payment.recorded` event with payload `{ invoiceId, amount, date, method, orgId }`
- **Accounting** subscribes and creates the corresponding `JournalEntry`
- **Fallback (simpler)**: Invoicing API calls Accounting API via internal HTTP (`http://localhost:4010/api/internal/...`) with a shared service key

**2. ERP → Warehouse** (production consumes/produces stock)
- **Pattern**: Same event-based or internal HTTP approach
- **Implementation**: `erp.service.completeProduction()` emits `production.completed` event
- **Warehouse** subscribes and calls `adjustStock()` accordingly

**Cross-module event contract**:
```typescript
// packages/config/src/events.ts
interface CrossAppEvent {
  type: 'payment.recorded' | 'production.completed' | 'production.started'
  orgId: string
  payload: Record<string, unknown>
  timestamp: Date
  sourceApp: string
}
```

### App Hub (Portal UI)

The Portal's main authenticated view is the **App Hub** — a grid of available apps (like Google's app launcher).

```
┌─────────────────────────────────────────┐
│  LGR Workspace          [Org ▾] [User] │
├─────────────────────────────────────────┤
│                                         │
│  ┌─────────┐  ┌─────────┐  ┌────────┐  │
│  │    📊   │  │   🧾    │  │   📦   │  │
│  │Accounting│  │Invoicing│  │Warehouse│  │
│  └─────────┘  └─────────┘  └────────┘  │
│  ┌─────────┐  ┌─────────┐  ┌────────┐  │
│  │    💰   │  │   👥    │  │   📈   │  │
│  │ Payroll │  │   HR    │  │  CRM   │  │
│  └─────────┘  └─────────┘  └────────┘  │
│  ┌─────────┐                            │
│  │    🏭   │                            │
│  │   ERP   │                            │
│  └─────────┘                            │
│                                         │
│  [Settings]  [Users]  [Billing]         │
└─────────────────────────────────────────┘
```

**App availability** is determined by:
1. Org subscription plan (free = 2 apps, starter = 4, professional = all, enterprise = all + priority)
2. User permissions (user with `accounting.read` sees Accounting app tile)
3. Org-level app activation (admin enables/disables apps in settings)

**New model**: `OrgApp` — tracks which apps an org has enabled:
```typescript
{ orgId, appId: 'accounting' | 'invoicing' | ..., enabled: boolean, activatedAt: Date }
```

**New config constant**: `APP_REGISTRY` — metadata for all apps:
```typescript
const APP_REGISTRY = {
  accounting: { name: 'Accounting', icon: 'mdi-chart-bar', color: '#4caf50', port: 4010, requiredPermission: 'accounting.read' },
  invoicing: { name: 'Invoicing', icon: 'mdi-receipt-text', color: '#ff9800', port: 4020, requiredPermission: 'invoicing.read' },
  warehouse: { name: 'Warehouse', icon: 'mdi-package-variant', color: '#2196f3', port: 4030, requiredPermission: 'warehouse.read' },
  payroll: { name: 'Payroll', icon: 'mdi-cash-multiple', color: '#9c27b0', port: 4040, requiredPermission: 'payroll.read' },
  hr: { name: 'HR', icon: 'mdi-account-group', color: '#00bcd4', port: 4050, requiredPermission: 'hr.read' },
  crm: { name: 'CRM', icon: 'mdi-trending-up', color: '#e91e63', port: 4060, requiredPermission: 'crm.read' },
  erp: { name: 'ERP', icon: 'mdi-factory', color: '#795548', port: 4070, requiredPermission: 'erp.read' },
}
```

### Each App's UI Structure

Every domain app UI is a standalone Vue 3 + Vuetify 3 SPA that:

1. **Imports `ui-shell`** for the shared app shell (top bar with app switcher, org selector, user menu)
2. **Imports `ui-shared`** for composables (`useHttpClient`, `useSnackbar`, `useWebSocket`), Vuetify plugin, i18n
3. **Has its own router** with only its module's routes (e.g., Accounting UI only has `/accounts`, `/journal-entries`, etc.)
4. **Has its own Pinia store** (moved from the monolithic `ui/src/store/`)
5. **Runs on its own Vite dev server** (unique port per app)

**Shared app shell (`ui-shell`) provides**:
- `<AppShell>` layout component with slots for sidebar and content
- `<AppSwitcher>` — the 9-dot grid menu that lists all available apps (fetched from Portal API)
- `<OrgSelector>` — switch between orgs the user belongs to
- `<UserMenu>` — profile, preferences, logout (calls Portal API)
- `<NotificationBell>` — notification dropdown (fetches from Portal API)

### Implementation Phases

#### Phase 1: Foundation (shared packages + Portal)
1. Create `APP_REGISTRY` in `config/constants.ts` and `OrgApp` model in `db/models`
2. Extract auth into `portal-auth.service.ts` (full) and `app-auth.service.ts` (verify-only)
3. Create `portal-api/` — move auth, oauth, org, user, invite, stripe, file, notification, export controllers
4. Create `portal-ui/` — move auth views, settings, admin, billing, landing, dashboard + app.store
5. Create `ui-shell/` — extract AppShell, AppSwitcher, OrgSelector, UserMenu, NotificationBell
6. Create `ui-shared/` — extract useHttpClient, useSnackbar, useWebSocket, Vuetify/i18n plugins
7. Build the App Hub view in portal-ui
8. Integration tests: auth flows, org management, app activation
9. E2E tests: login → app hub → navigate to app → return to hub

#### Phase 2: First domain app (Accounting — zero cross-module deps)
1. Create `accounting-api/` — move 9 accounting controllers + report endpoints
2. Create `accounting-ui/` — move 10 accounting views + accounting store
3. Wire `app-auth.service.ts` for JWT verification
4. Integration tests: all accounting CRUD + posting/voiding journal entries
5. E2E tests: full accounting workflows (create account → create JE → post → view reports)

#### Phase 3: Remaining independent apps (Warehouse, Payroll, HR, CRM)
1. Extract each app following Phase 2 pattern (4 apps in parallel since no cross-deps)
2. Integration tests per app
3. E2E tests per app

#### Phase 4: Dependent apps (Invoicing, ERP) + cross-module events
1. Implement cross-module event system (event bus or internal HTTP)
2. Extract `invoicing-api/` + `invoicing-ui/` — payment recording emits event → Accounting consumes
3. Extract `erp-api/` + `erp-ui/` — production completion emits event → Warehouse consumes
4. Integration tests: cross-app event flows
5. E2E tests: invoice payment → verify journal entry created; production complete → verify stock adjusted

#### Phase 5: Cleanup + production readiness
1. Remove old monolithic `api/` and `ui/` packages
2. Update `docker-compose.yml` for multi-service setup
3. Add reverse proxy config (development: Vite proxy; production: nginx/Caddy)
4. Update seed script to seed all apps
5. Comprehensive cross-app E2E suite

### Testing Strategy

#### Integration Tests (per-app + cross-app)
```
packages/tests/src/
  portal/          → auth.flow.test.ts, org.test.ts, invite.test.ts, app-activation.test.ts
  accounting/      → accounts.test.ts, journal.test.ts, fiscal.test.ts, reports.test.ts
  invoicing/       → invoices.test.ts, payments.test.ts, contacts.test.ts
  warehouse/       → products.test.ts, movements.test.ts, stock.test.ts, inventory.test.ts
  payroll/         → employees.test.ts, runs.test.ts, payslips.test.ts
  hr/              → departments.test.ts, leave.test.ts, trips.test.ts
  crm/             → leads.test.ts, deals.test.ts, pipelines.test.ts
  erp/             → production.test.ts, bom.test.ts, pos.test.ts, construction.test.ts
  cross-app/       → invoicing-accounting.test.ts, erp-warehouse.test.ts
```

#### E2E Tests (per-app + cross-app journeys)
```
packages/e2e/tests/
  portal/          → login.spec.ts, register.spec.ts, oauth.spec.ts, app-hub.spec.ts, settings.spec.ts
  accounting/      → accounts.spec.ts, journal-entries.spec.ts, reports.spec.ts
  invoicing/       → invoices.spec.ts, payments.spec.ts, contacts.spec.ts
  warehouse/       → products.spec.ts, movements.spec.ts, inventory.spec.ts
  payroll/         → employees.spec.ts, payroll-runs.spec.ts
  hr/              → leave.spec.ts, departments.spec.ts
  crm/             → leads.spec.ts, deals.spec.ts
  erp/             → production.spec.ts, pos.spec.ts
  cross-app/       → app-switching.spec.ts, invoice-to-journal.spec.ts, production-to-stock.spec.ts
```

### Dev Commands (target)

```bash
# Run everything
bun run dev                  # All 8 APIs + all 8 UIs concurrently

# Run individual apps
bun run dev:portal           # Portal API (4001) + Portal UI (4000)
bun run dev:accounting       # Accounting API (4010) + Accounting UI (4011)
bun run dev:invoicing        # Invoicing API (4020) + Invoicing UI (4021)
bun run dev:warehouse        # Warehouse API (4030) + Warehouse UI (4031)
bun run dev:payroll          # Payroll API (4040) + Payroll UI (4041)
bun run dev:hr               # HR API (4050) + HR UI (4051)
bun run dev:crm              # CRM API (4060) + CRM UI (4061)
bun run dev:erp              # ERP API (4070) + ERP UI (4071)

# Testing
bun run test                 # All integration tests
bun run test:portal          # Portal integration tests only
bun run test:accounting      # Accounting integration tests only
bun run test:cross-app       # Cross-app integration tests
bun run test:e2e             # All E2E tests
bun run test:e2e:portal      # Portal E2E only
```

### Key Principles

1. **Shared data layer**: `db/` and `services/` remain shared — all apps read/write the same MongoDB via the same models and DAOs. No database-per-app split.
2. **Independent deployment**: Each app API can be deployed and scaled independently. Each app UI is a separate build artifact.
3. **Shared identity**: Single JWT from Portal, verified by all apps. No re-authentication when switching apps.
4. **Loose coupling**: Cross-module dependencies use events or internal HTTP — never direct model imports across app boundaries.
5. **Progressive extraction**: Migrate one app at a time. Old monolithic API/UI can coexist with new apps during transition.
6. **Test coverage**: Every app must have its own integration + E2E tests. Cross-app flows get dedicated test suites.

---

## Last Health Check

Date: 2026-03-10
Result: PASSED_WITH_WARNINGS
Summary: 655/661 tests pass (6 failures from external API rate limiting). Fixed N+1 queries in accounting and invoicing services, removed live API token from .env.test, pinned Dockerfile to stable Bun version.

## Known Issues

- [HIGH] [2026-03-10] 18 compact DAO controllers missing Elysia body validation schemas (arbitrary field injection risk) — Status: OPEN
- [HIGH] [2026-03-10] BaseDao read methods missing .lean() (Mongoose document overhead on all DAO reads) — Status: OPEN
- [HIGH] [2026-03-10] N+1 in findBelowMinStock() — product.dao.ts queries stock levels per product in loop — Status: OPEN
- [HIGH] [2026-03-10] N+1 in approvePayroll() — payroll.service.ts creates payslips sequentially — Status: OPEN
- [HIGH] [2026-03-10] 4 npm vulnerabilities: minimatch ReDoS (via md-to-pdf/exceljs), immutable prototype pollution (via sass) — Status: OPEN
- [MEDIUM] [2026-03-10] VerifyVAT integration tests hit live API with 50 req/month quota — tests flaky/failing — Status: OPEN
- [MEDIUM] [2026-03-10] file.controller.ts TODO: file deletion from storage not implemented — Status: OPEN
- [MEDIUM] [2026-03-10] payroll.service.ts overtime hardcoded to 0 (not calculated from timesheets) — Status: OPEN
- [LOW] [2026-03-10] 17 TODO/FIXME comments across codebase (mostly payroll export stubs) — Status: OPEN
- [RESOLVED] [2026-03-10] Live API token (sk_live_...) in .env.test — replaced with placeholder
- [RESOLVED] [2026-03-10] N+1 in postJournalEntry() and voidJournalEntry() — batch-loaded accounts
- [RESOLVED] [2026-03-10] N+1 in validateStockAvailability() — batch-loaded stock levels
- [RESOLVED] [2026-03-10] Dockerfile used oven/bun:canary-slim — pinned to oven/bun:1.3.10-slim
