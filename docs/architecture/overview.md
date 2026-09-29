# LGR Architecture Overview

LGR (Ledger) is a full-stack multi-tenant ERP system that runs both as a cloud SaaS and an offline-first desktop application.

## Deployment Modes

### Cloud Mode (Multi-App)

Eight independent Elysia.js APIs share a single MongoDB database via Mongoose. A central Portal handles authentication, tenant management, and app switching.

```
Portal API (4001)  ─┐
Accounting (4010)   │
Invoicing (4020)    │── MongoDB (27018)
Warehouse (4030)    │
Payroll (4040)      │
HR (4050)           │
CRM (4060)          │
ERP (4070)         ─┘
```

Each app has its own Vue 3 SPA frontend. JWT cookies are shared across apps for SSO.

### Desktop Mode (server-mode client)

A Tauri 2 shell that **opens the LGR cloud app** in its own window. There is no local mode, no
local data and no sync. It adds what a browser tab cannot: a native fiscal bridge that owns the
till's serial port, autostart with open-on-launch, auto-update, a tray, and registration as a
known, revocable machine of the org.

```
+------------- LGR Desktop --------------+
|  Tauri 2 Shell (Rust) - the whole app  |
|  +----------------------------------+  |
|  |  Shell pages (desktop-ui)        |  |
|  |  Overview . Settings . Logs ...  |  |
|  +----------------------------------+  |
|  +----------------------------------+  |
|  |  lgr-web -> https://lgrai.app/   |  |
|  |  the cloud app, no IPC           |  |
|  +----------------------------------+  |
+----------------------------------------+
     no sidecar . no Bun . no SQLite
```

⚠ It used to be offline-first: a Bun `desktop-api` sidecar over SQLite plus a LAN sync engine.
That prototype was **deleted on 2026-09-29** (FR-14.34) - see [desktop.md](desktop.md) for what
went and why.

## Data Abstraction Layer (DAL)

Business logic never imports Mongoose directly. All data access goes through the DAL:

```
packages/services/src/biz/*.service.ts
         │
         ▼
packages/dal/           → Repository interfaces + types
         ▼
dal-mongo               -> the one implementation (Mongoose)
```

See [dal.md](dal.md) for details.

## Package Dependency Flow

```
config ← dal ← dal-mongo ← [cloud APIs]
         ← services ← [all APIs]
```

## Monorepo Structure

```
packages/
  config/          Shared constants, enums, permissions
  dal/             Repository interfaces + entity types
  dal-mongo/       MongoDB implementations
  db/              Mongoose models (cloud only)
  services/        Business logic (DAL-based)
  reporting/       Excel/PDF export

  portal-api/      Auth, org management, app hub
  portal-ui/       Portal frontend
  accounting-api/  9 accounting controllers
  accounting-ui/   Accounting frontend
  invoicing-api/   4 invoicing controllers
  invoicing-ui/    Invoicing frontend
  warehouse-api/   7 warehouse controllers
  warehouse-ui/    Warehouse frontend
  payroll-api/     4 payroll controllers
  payroll-ui/      Payroll frontend
  hr-api/          6 HR controllers
  hr-ui/           HR frontend
  crm-api/         4 CRM controllers
  crm-ui/          CRM frontend
  erp-api/         4 ERP controllers
  erp-ui/          ERP frontend

  desktop-ui/      Unified offline frontend
  desktop/         Tauri 2 shell (Rust)

  ui-shell/        Shared app shell components
  ui-shared/       Shared composables, plugins

  tests/           Integration tests
  e2e/             Playwright E2E tests
```

## Multi-Tenancy

Every data model has an `orgId` field. The `tenantPlugin` **adds that field and nothing else** -- it does not filter queries; passing `{ orgId }` is the caller's job.

All API routes are scoped under `/api/org/:orgId/`, and that is where tenancy is enforced: `isForeignOrg` (`packages/services/src/biz/tenant-guard.ts`) runs as a `beforeHandle` hook in `AuthService`/`AppAuthService`, so any request whose path `:orgId` differs from the caller's JWT gets a 403 before the handler runs — on every route, by default (gjovanov/lgr#41).

## Authentication

- **Cloud**: Portal issues JWT, domain apps verify only
- **Desktop**: Local `DesktopAuthService` issues and verifies JWTs using the same shared secret
- JWT payload: `{ id, email, username, firstName, lastName, role, orgId, permissions }`
