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

### Desktop Mode (Offline-First)

A single unified Elysia.js API runs all modules in one process, backed by SQLite via `bun:sqlite`. A Tauri 2 shell wraps the app with system tray, auto-updates, and archive scheduling.

```
┌─────────────────────────────────┐
│  Tauri 2 Shell (Rust)           │
│  ┌───────────────────────────┐  │
│  │  Desktop UI (Vue 3 SPA)   │  │
│  └───────────┬───────────────┘  │
│              │ HTTP/WS          │
│  ┌───────────▼───────────────┐  │
│  │  Desktop API (Bun sidecar)│  │
│  │  Elysia + dal-sqlite      │  │
│  └───────────┬───────────────┘  │
│              │                  │
│  ┌───────────▼───────────────┐  │
│  │  SQLite (WAL mode)        │  │
│  └───────────────────────────┘  │
└─────────────────────────────────┘
```

## Data Abstraction Layer (DAL)

Business logic never imports Mongoose or bun:sqlite directly. All data access goes through the DAL:

```
packages/services/src/biz/*.service.ts
         │
         ▼
packages/dal/           → Repository interfaces + types
         │
    ┌────┴────┐
    ▼         ▼
dal-mongo    dal-sqlite
(Mongoose)   (bun:sqlite)
```

See [dal.md](dal.md) for details.

## Package Dependency Flow

```
config ← dal ← dal-mongo ← [cloud APIs]
              ← dal-sqlite ← desktop-api
         ← services ← [all APIs]
         ← sync
```

## Monorepo Structure

```
packages/
  config/          Shared constants, enums, permissions
  dal/             Repository interfaces + entity types
  dal-mongo/       MongoDB implementations
  dal-sqlite/      SQLite implementations
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

  desktop-api/     Unified offline API (all modules)
  desktop-ui/      Unified offline frontend
  desktop/         Tauri 2 shell (Rust)
  sync/            Change tracking, sync protocol, migration

  ui-shell/        Shared app shell components
  ui-shared/       Shared composables, plugins

  tests/           Integration tests
  e2e/             Playwright E2E tests
```

## Multi-Tenancy

Every data model has an `orgId` field. In MongoDB, the `tenantPlugin` auto-filters queries. In SQLite, repositories filter by `org_id` column. All API routes are scoped under `/api/org/:orgId/`.

## Authentication

- **Cloud**: Portal issues JWT, domain apps verify only
- **Desktop**: Local `DesktopAuthService` issues and verifies JWTs using the same shared secret
- JWT payload: `{ id, email, username, firstName, lastName, role, orgId, permissions }`
