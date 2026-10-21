# LGR Architecture Overview

LGR (Ledger) is a multi-tenant ERP. It has three parts:
- **one API server**;
- **one Vue single-page app per module**;
- **a desktop shell** that opens the cloud app.

There is no offline-first desktop and no local database on a workstation.

## Deployment

### The API: one process

`packages/portal-api/src/unified.ts` starts one Elysia server (`config.port`, 4001 by default)
with one MongoDB connection. MongoDB runs as a replica set (`rs0`), which multi-document
transactions need.

```
browser / LGR Desktop
        │ HTTPS
        ▼
unified API (portal-api, :4001) ─────── MongoDB (replica set rs0)
  /api/*      portal + every domain package's controllers
  /ws/*       tasks · fiscal-bridge · desktop
  /swagger    API docs
  /           portal-ui
  /<module>/  accounting · inventory · invoicing · pos · payroll · reports · files
```

- **The route table** is `createApiApp()` in `portal-api/src/api.ts`. The integration tests mount
  that same table.
- **Every route lives under `/api`**, and org-scoped routes under `/api/org/:orgId/…`.
- **Before serving:**
  - pending data migrations run first when `MIGRATIONS_AUTO=true`; by hand otherwise,
    `bun run migrate`. See [nodes.md](nodes.md);
  - the cross-module event handlers are registered, so posting an invoice or recording a
    payment creates its journal entry.
- **WebSockets:**
  - `/ws/tasks`: background-task progress for the signed-in user;
  - `/ws/fiscal-bridge`: a browser tab or a registered desktop relaying a fiscal device;
  - `/ws/desktop`: desktop presence.

  Each authenticates in its first message.
- **The built SPAs** are served by the same process: the portal at `/`, and each module UI at its
  prefix. The SPA fallback is `portal-api/src/spa-fallback.ts`.

The domain API packages export controllers and nothing else. None of them starts a server of its
own.

### The UIs

Each module has its own Vue 3 + Vuetify SPA, with its own router and Pinia store:
- portal-ui: sign-in, the app hub, settings;
- accounting-ui, inventory-ui, invoicing-ui, pos-ui, payroll-ui, reports-ui and files-ui.

`ui-shell` holds the shared top bar, app switcher and org menu, and `ui-shared` the shared
composables and components.

**A tab keeps its own session.** Its bearer token and org are in `sessionStorage`, and
`ui-shared/src/session/session.ts` is the only code that reads them. That is what lets two tabs
work in two orgs.

### Desktop (server-mode client)

A Tauri 2 shell that **opens the LGR cloud app** in its own window. There is no local mode, no
local data and no sync. It adds what a browser tab cannot:
- a native fiscal bridge that owns the till's serial port;
- autostart with open-on-launch;
- auto-update and a tray;
- registration as a known, revocable machine of the org.

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

See [desktop.md](desktop.md) for how its parts work, and for the offline-first prototype it
replaced (deleted on 2026-09-29, FR-14.34).

## Data Abstraction Layer (DAL)

Business logic goes through repository interfaces instead of Mongoose where it can:

```
packages/services/src/biz/*.service.ts
         │
         ▼
packages/dal/           → Repository interfaces + types
         ▼
dal-mongo               → the one implementation (Mongoose)
```

See [dal.md](dal.md) for details.

## Package dependency flow

| Package | Depends on |
|---|---|
| `config` | nothing |
| `db` (models, tenant plugin, org homes) | `config` |
| `dal` | `config` |
| `dal-mongo` | `config`, `dal`, `db` |
| `services` | `config`, `dal`, `db` |
| `reporting` | `config`, `db` |
| `fiscal`, `migrations` | `config`, `db`, `services` |
| `accounting-api`, `warehouse-api`, `payroll-api`, `reports-api` | `config`, `db`, `dal-mongo`, `services`, `reporting` |
| `invoicing-api` | the same, plus `fiscal` |
| `files-api` | `config`, `db`, `dal-mongo`, `services` |
| `portal-api` (the unified server) | all of the above |

## Monorepo structure

```
packages/
  config/          Shared configuration, constants, enums, permissions
  db/              Mongoose models, tenant plugin, org homes and the write guard
  dal/             Repository interfaces + entity types
  dal-mongo/       The MongoDB implementation
  services/        Business logic
  migrations/      Versioned data migrations (bun run migrate)
  reporting/       Excel and PDF export
  fiscal/          Fiscal device drivers (Datecs, Tremol, Eltrade)

  portal-api/      The unified server, auth, orgs, people, desktops, the app hub
  accounting-api/  Accounting controllers
  invoicing-api/   Invoicing, orders, reservations, POS
  warehouse-api/   Products, stock, movements, pricing
  payroll-api/     Payroll controllers
  reports-api/     The report catalog and runner
  files-api/       Document ingest

  portal-ui/       Portal frontend
  accounting-ui/   Accounting frontend
  inventory-ui/    Inventory frontend
  invoicing-ui/    Invoicing frontend
  pos-ui/          Point-of-sale frontend
  payroll-ui/      Payroll frontend
  reports-ui/      Reports frontend
  files-ui/        Files frontend
  ui-shell/        Shared app shell components
  ui-shared/       Shared composables, components, the tab session

  desktop/         LGR Desktop, the Tauri 2 shell (Rust)
  desktop-ui/      The shell's own pages

  ocr-server/      The OCR sidecar for document import

  tests/           Integration and unit tests (bun test)
  e2e/             Playwright E2E tests
```

## Multi-Tenancy

Every data model has an `orgId` field. The `tenantPlugin` **adds that field and nothing else**:
it does not filter queries, so passing `{ orgId }` is the caller's job.

All API routes are scoped under `/api/org/:orgId/`, and that is where tenancy is enforced.
`isForeignOrg` (`packages/services/src/biz/tenant-guard.ts`) runs as a `beforeHandle` hook in
`AuthService` and every `AppAuthService`. Any request whose path `:orgId` differs from the
caller's JWT gets a 403 before the handler runs. That holds on every route, by default
(gjovanov/lgr#41).

Right after it, the home gate answers 409 to a write for an org whose home is another node. No
org has one today. See [nodes.md](nodes.md).

## Authentication

- **One sign-in, many orgs.** A person is an `Identity`, and each org's `User` is their
  membership there.
- **A session belongs to one org.** It is a JWT the portal issues, and `POST /api/auth/switch`
  moves a tab to another of the person's orgs.
- **One rule for reading the session.** `AuthService` (`portal-api/src/auth/auth.service.ts`) and
  the verify-only `AppAuthService` copy in each domain package share
  `services/biz/session-token.ts`:
  - a non-empty `Authorization: Bearer` header is used exclusively;
  - the `auth` cookie counts only when no header is sent.
- **The JWT payload** is `{ id, email, username, firstName, lastName, role, orgId, permissions,
  ownRecordsModules, operatorCode? }`. A membership linked to a person adds `iid` and `tv`,
  which let a password change end every session that person holds.
- **Desktops authenticate as machines, separately.** An Ed25519 client assertion is exchanged
  for a 15-minute desktop token, signed with `DESKTOP_TOKEN_SECRET` (audience `lgr-desktop`).
  `/api/desktop/v1/*`, `/ws/desktop` and the desktop's fiscal bridge use it. People still sign
  in inside the desktop's `lgr-web` window with the portal's normal login.
