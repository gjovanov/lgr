# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LGR (Leger)** is a full-stack multi-tenant ERP system built as a Bun monorepo. Stack: Elysia.js + MongoDB/Mongoose + Vue 3/Vuetify 3 + Pinia.

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
docker compose up -d         # Start MongoDB (no auth, port 27017)
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

- `.env` — development (MongoDB at `localhost:27017/lgr`, no auth)
- `.env.test` — testing (overridden by mongodb-memory-server)
- API `packages/api/package.json` scripts use `--env-file=../../.env` to load root env
- Docker: `docker-compose.yml` runs MongoDB 7 without authentication

## ERP Modules

Accounting (accounts, journal entries, fiscal years/periods, fixed assets, bank accounts, reconciliation, tax returns, exchange rates) · Invoicing (contacts, invoices, payment orders, cash orders) · Warehouse (products, warehouses, stock levels, stock movements, inventory counts, price lists) · Payroll (employees, payroll runs, payslips, timesheets) · HR (departments, leave types/requests/balances, business trips, employee documents) · CRM (leads, deals, pipelines, activities) · ERP (BOM, production orders, construction projects, POS)
