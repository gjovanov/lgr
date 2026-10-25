# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LGR (Ledger)** is a full-stack multi-tenant ERP system built as a Bun monorepo. Stack: Elysia.js + MongoDB/Mongoose + Vue 3/Vuetify 3 + Pinia.

The system follows a **multi-app architecture** (Google Workspace model): a Portal app handles auth, tenant management, and an App Hub that links to 7 domain app UIs. All APIs run as a **single unified process** on one port, while each domain has its own UI package.

## Commands

```bash
# Development
bun run dev                  # Unified API (4001) + the 8 UI dev servers (portal + 7 apps); `bun run dev -- api portal` starts a subset
bun run start                # Production: unified API (4001) serving all built UIs
bun run build                # Build all 9 UIs (portal, the 7 apps, desktop-ui)
bun run seed                 # Seed database (Acme Corp + Beta Inc)
bun run migrate              # Apply pending versioned migrations (--status lists them; FR-20.19)

# Individual UI dev servers (each proxies /api → unified API on 4001)
bun run dev:portal-ui        # Portal UI (port 4000)
bun run dev:accounting-ui    # Accounting UI (port 4011)
bun run dev:invoicing-ui     # Invoicing UI (port 4021)
bun run dev:inventory-ui     # Inventory UI (port 4031)
bun run dev:payroll-ui       # Payroll UI (port 4041)
bun run dev:pos-ui           # POS UI (port 4091)
bun run dev:reports-ui       # Reports UI (port 4101)
bun run dev:files-ui         # Files UI (port 4111)

# Desktop (a server-mode client - it opens the cloud app; no local mode, no local data)
bun run dev:desktop-ui       # The shell's own pages (4081)
bun run tauri:dev            # Tauri desktop shell
bun run tauri:build          # Build Tauri app

# Testing
bun run test                 # All integration tests (mongodb-memory-server)
bun test packages/tests/src/integration/auth.flow.test.ts  # Single test file
bun run test:e2e             # Playwright E2E tests
cd packages/e2e && bunx playwright test tests/warehouse.spec.ts  # Single E2E file

# Infrastructure
docker compose up -d         # Start MongoDB (no auth, port 27018)
```

## Architecture (Current — Implemented)

```
packages/
  # ── Shared foundation ──
  config/              → Shared config (env vars) + constants (roles, permissions, modules, enums, APP_REGISTRY)
  db/                  → Mongoose models (71) + tenant plugin + connection management
  services/            → Business logic (biz/), DAOs (dao/), background tasks, events, mixins, logger
  reporting/           → Excel (ExcelJS) + PDF (md-to-pdf) export generators
  fiscal/              → Fiscal printer abstraction (IFiscalPrinter, Datecs protocol, device manager, NTP sync, VAT groups)

  # ── DAL (Data Abstraction Layer) ──
  dal/                 → DAL interface definitions (backend-agnostic)
  dal-mongo/           → MongoDB DAL implementation (cloud)

  # ── Unified Cloud API (single process, port 4001) ──
  portal-api/          → Elysia: unified.ts mounts ALL controllers (portal + the 6 domain API packages)
                         Also contains portal-only controllers: auth, oauth, org, user, invite,
                         stripe, file, notification, app-hub, export, tag,
                         fiscal-device, workstation, supto-export

  # ── Domain API packages (controllers only, imported by unified.ts) ──
  accounting-api/      → 14 accounting controllers
  invoicing-api/       → 16 invoicing controllers (invoices, orders, reservations, POS, document import, …)
  warehouse-api/       → 15 warehouse controllers (includes pricing, bulk-pricing, ledgers)
  payroll-api/         → 4 payroll controllers
  reports-api/         → 1 reports controller (catalog + generic runner + generic export)
  files-api/           → 1 files controller (document ingest, FR-12)

  # ── Other packages ──
  migrations/          → Versioned data migrations, `bun run migrate` (FR-20.19)
  ocr-server/          → OCR + AI drafting sidecar (its own Deployment, `Dockerfile.ocr`)

  # ── UI packages (each is a standalone Vue 3 + Vuetify 3 SPA) ──
  portal-ui/           → Login, register, oauth-callback, app-hub, settings, admin, billing, audit log
  inventory-ui/        → Products, stock, movements, valuations (served at /inventory/*)
  invoicing-ui/        → Contacts, invoices, bills, cash sales, payments (served at /invoicing/*)
  accounting-ui/       → 10 accounting views + store
  pos-ui/              → Point-of-sale terminal, transactions, devices (served at /pos/*)
  payroll-ui/          → 5 payroll views + store
  files-ui/            → Document ingest: upload, analyze, commit, reconcile (served at /files/*)
  reports-ui/          → Report card hub + generic runner + the two moved invoicing report
                         pages (served at /reports/*)

  # ── Shared UI library ──
  ui-shell/            → AppShell, AppSwitcher, OrgSwitcher (top-bar org menu), NewOrgDialog, OrgSelector, UserMenu, NotificationBell, sidebar
  ui-shared/           → Shared composables (useHttpClient, useSnackbar, useWebSocket, usePriceResolver), i18n, vuetify plugin, shared components (PriceExplainButton, TagInput, etc.)

  # -- Desktop (a server-mode client, FR-14) --
  desktop-ui/          -> The shell's own pages: Overview, Settings, Onboarding, Logs, Diagnostics
  desktop/             -> Tauri 2 shell (Rust). Opens the cloud app in an lgr-web window.

  # ── Testing ──
  tests/               → Bun integration tests with mongodb-memory-server
  e2e/                 → Playwright E2E tests
```

### Unified API (single process)

All controllers (portal + 7 domains) are mounted in a single Elysia server at `packages/portal-api/src/unified.ts`:
- **Port 4001** — single process, single MongoDB connection
- All routes under `/api` (e.g., `/api/org/:orgId/accounting/accounts`)
- Serves all 8 built UIs as static files: Portal at `/`, domain UIs at `/{module}/`
- SPA fallback routes non-API, non-asset requests to the correct `index.html`
- Swagger docs at `/swagger`
- WebSocket server for real-time updates

Domain API packages (`accounting-api/`, `invoicing-api/`, etc.) export controllers that `unified.ts` imports directly. They can also run standalone on separate ports (legacy mode) but this is deprecated.

### Package dependency flow
`config` ← `db` ← `services` ← `fiscal` ← `portal-api` (imports domain API controllers)
Each `*-ui` imports `ui-shell` + `ui-shared`, communicates via HTTP/WS to unified API

## Multi-Tenancy

Every data model uses `tenantPlugin`, which adds an indexed, required `orgId` field — **and nothing else**. It does **not** filter queries (`packages/db/src/plugins/tenant.plugin.ts`). A `Model.find({})` returns every org's rows; passing `{ orgId }` is on the caller.

All API routes are scoped: `/api/org/:orgId/[module]/[resource]`, and **that is where tenancy is enforced**. `isForeignOrg` (`packages/services/src/biz/tenant-guard.ts`) is registered as a `beforeHandle` hook by `AuthService` and by all seven `AppAuthService` copies, so every authenticated route whose path carries `:orgId` rejects a caller whose JWT names a different org with **403**. It is applied by default — there is nothing for a new controller to opt into, and no exception list (gjovanov/lgr#41). The property is asserted over the real route table by `packages/tests/src/integration/tenant-isolation.flow.test.ts`.

**A write needs the permission its route names** (S-28). Every non-GET route under `/api/org/:orgId` resolves to a rule in `packages/services/src/biz/route-permission.ts`: the permission(s) it needs (`invoicing.write`, `accounting.post`, …), `self` (the controller guards itself, e.g. `canAccessReport`, admin-only routes) or `member` (any member, e.g. a note). The eight auth plugins enforce it in a **transform** hook, so a caller without the permission gets 403 before the body is validated; `admin` always passes. ⚠ A new write route fails `route-permission.flow.test.ts` until it has a rule, and is refused at runtime meanwhile. ⚠ The refusal is THROWN (a transform hook cannot return one), and `spaErrorHandler` passes a thrown status through; anything else it is handed becomes a 500.

**So does a read** (S-29). Every GET under an org resolves to a rule in `PREFIX_READ_RULES`, the same three kinds, enforced by the same hook (`permissionRefusal`).
- A module's reads accept any permission of that module (`payroll.read`, `.write` or `.approve`), since a role that writes it reads it.
- Reference data that another app reads also accepts that app's module, and its comment names the app. For example, the invoicing app's cash and payment orders read `accounting/account` and `accounting/bank-account`, and the inventory app's supplier picker reads `invoicing/contact`.
- ⚠ A new GET route fails `read-permission.flow.test.ts` until it has a rule. When an app starts reading another module's route, widen the rule and add the read to the test's `APP_READS`, the test that holds each default role to what its apps read.
- The audit trail is `admin.audit`'s (`auditReadScope`). Anyone else reads the history of ONE record (`entityType` + `entityId`), and only entries of modules they read: that is what the history and notes panels need.
- An org is never serialised with its integration fields' tokens: `orgForClient` / `settingsForClient` on `GET /org/:orgId` and `/auth/me`.

⚠ **The guard checks the URL's `:orgId`, not the id after it.** A route that takes a document id
from its URL loads and writes it with the repository's **`findByIdInOrg` / `updateInOrg` /
`deleteInOrg`** (`{_id, orgId}`), never `findById` / `update` / `delete`, which take no org
(FR-20.7). `updateInOrg` also drops `orgId` from the data, so a document never changes org; a PUT
without a full body schema carries `t.Object({ orgId: t.Optional(t.Never()) }, { additionalProperties: true })`.
`tenant-isolation.flow.test.ts` probes every by-id route with another org's document and fails on
a controller that passes a URL id to an unscoped method.

## Secrets and node role (S-02, #157, FR-20.1/FR-20.17)

- `config.requiredSecret` refuses in production: an empty value, the dev fallback, anything under 32
  characters, and **every secret value published in `.env.example`, `docker-compose.yml` and
  `deploy/ocr/ocr-secret.example.yaml`** (`PUBLISHED_EXAMPLE_SECRETS`, SHA-256 only, never the values).
  ⚠ Adding an example secret to any of those files fails `unit/published-secrets.test.ts` until its
  hash is added to the list.
- `LGR_NODE_ROLE` = `global` (default) or `master`; anything else refuses to start. Feature code asks
  `nodeRole()` from `config`, never a host name or another variable.

## Org homes: only the home writes (FR-20.3/FR-20.4, plan step P0b-2)

Every org has one **home** that writes its data: `global` or an on-prem master. `org_homes` (`OrgHome`,
node state — no `tenantPlugin`, excluded from backup bundles) holds the row; **no row = `global`, epoch 0**,
which is every org today. `db/home/home.ts`: `homeOf` (5 s cache, `forgetHome`) and `isHomeHere`.
- **Bundles carry no node state** (FR-20.3, P0b-10): `db/home/node-state.ts#NODE_STATE_MODELS` (`OrgHome`,
  `BackgroundTask`, whose `owner` names a process) is left out of every bundle, and a restore SKIPS such a
  section with a warning even when an older bundle has it. ⚠ A new model with an `orgId` fails
  `backup-node-state.flow.test.ts` until it is classified as org data, operational or node state.
- ⚠ It **fails closed**: a row that disagrees with `Org.homeEpochHighWater`, or no row once that is set,
  is `hold`; only `active` writes.
- The auth plugins run `services/biz/home-gate.ts#homeGate` right after `isForeignOrg` (all eight, no
  exception list): off its home, an org's **writing** routes answer **409 `org_home_elsewhere`**. What
  writes is `services/biz/route-class.ts`: a GET reads, anything else writes, except the POSTs listed in
  `READ_ONLY_WRITES` (reports, list exports). ⚠ A route added there must write NOTHING.
- **Below the routes, `tenantPlugin` installs a write guard** (`db/home/write-guard.ts`): save, insertMany,
  every update/delete/findOneAnd*, `bulkWrite`, and an update that moves documents INTO an org are refused
  (`HomeElsewhereError`) when that org's home is elsewhere — services, sweeps and scripts included. A write
  that does not name its org is resolved from the data only when some org is away from home (never on
  global today). `Sequence` writes (every legal number) read the home **fresh**, never the cache.
- ⚠ **Raw driver writes (`Model.collection.*`) bypass it.** Each is listed in
  `home-write-guard.flow.test.ts#RAW_WRITE_SITES`, guarded by `assertHomeIsHere(orgId)` or exempt with a
  reason; a new one fails that test.
- **Writes that fan out across orgs use `homeScope()`** (FR-20.5, `db/home/home.ts`): `{}` on global
  today, `{orgId: {$nin: away}}` once an org moves, `{orgId: {$in: mine}}` on a master. ⚠ Merge it into
  any `updateMany`/sweep that is not scoped to one org (`{ ...filter, ...(await homeScope()) }`): unscoped,
  the write guard refuses the whole write as soon as one org lives elsewhere — after earlier steps of
  the same flow already ran. Used by the identity fan-outs, the boot fiscal reset
  (`services/biz/fiscal-status-reset.ts`), retention and the migrations runner (`orgFilter`). Joining an
  org (invite, registration, OAuth) and desktop enrollment REFUSE an org homed elsewhere instead.
  **Schedulers too** (FR-20.85, P0b-5): the digest, backup, desktop-reaper and orphaned-task loops take
  only the orgs homed here. A loop over `Org` itself scopes `_id`: `homeScope('_id')`.
- **A master is home of the orgs it creates** (FR-20.18). `homeNewOrg()` (`db/home/home.ts`) gives an org
  created on a master an `OrgHome` row (this node, epoch 1, active), right after `Org.create`. It runs
  in all three creators: register, `POST /auth/orgs` and the OAuth sign-up, all console-only on a master.
  ⚠ Without it the org is global's, and its own first user is refused.
  - ⚠ A master's identity is `LGR_NODE_ID`: `master-<16 base32>`, made once by the supervisor in
    `state/node.json`.
  - It NEVER changes, because every `OrgHome` row on the master names it.
  - With no id, `isHomeHere()` is false for every org, and creating one is refused. Until 2026-10-25 a
    master had none: it could write nothing.
- **Reads that write** (FR-20.6, P0b-4): every API request runs in a context (`db/home/request-context.ts`,
  entered by a SYNCHRONOUS `onTransform` in `createApiApp()` and reset `onAfterResponse`) naming its route
  and org. A write inside a read-only route is recorded in `readOnlyWrites`; off the org's home it is
  REFUSED unless the route is in `route-class.ts#GET_WRITERS`, each of which checks the home itself (the
  companion-number print answers 409 on a mirror; the App Hub inserts no `OrgApp` rows there). At home an
  unlisted one is only warned about, and `reads-that-write.flow.test.ts` walks every GET route and fails
  on it. ⚠ Prefer making a new writer a POST over adding it to `GET_WRITERS`.
- **Scripts** (FR-20.4, P0b-6): a script that opens the database checks the home BEFORE it writes, through
  `scripts/lib/home-guard.ts`: `assertScriptHome(org._id)` for a `--org` script (exit 2, nothing written),
  `keepHomeOrgs(orgs, { named })` for one that walks every org (skips the away ones; a NAMED one stops),
  `tenantHomeScope()` for a collection sweep, `assertAllOrgsHome()` for the identity migration. A script run
  from a pod path checks `db/home/home` directly. `unit/scripts-home-guard.test.ts` fails any `scripts/*.ts`
  that opens the database without one (read-only ones are listed there with a reason).

## Stored file paths (FR-20.24, plan step P0b-8)

`File.storagePath` and `DocFile.currentPath` hold a path RELATIVE to `UPLOAD_DIR`: `<orgId>/…`, `/`
separators (`services/biz/files/stored-path.ts`). Rows written before release N+1 hold the absolute path the
process wrote (`/app/uploads/<orgId>/…`, or `uploads/<orgId>/…` relative to the cwd in dev), which points
nowhere on a server with another root; migration `0003-relative-file-paths` rewrites them.
- **Every reader goes through `resolveStored(stored, orgId)`** (release N, #177), which takes either form,
  maps a legacy absolute path from a known root (this server's, `/app/uploads`, `UPLOAD_LEGACY_ROOTS`) onto
  this root, refuses `..`, drive letters and another org's tree, and returns the absolute path. ⚠
  `unit/stored-path.test.ts` fails on any file operation applied to a stored path directly.
- **Every writer stores `toStored(absolutePath)`** (release N+1). `POST /org/:orgId/file` normalises a local
  path and refuses one outside the caller's org; a restore writes both fields in the relative form.
- **A `File` row follows its bytes** (#180): the OCR move out of `inbox/`, a re-upload's `versions/`, a
  deletion's `_deleted/`. A move that fails is logged, and both rows keep naming the bytes.
- ⚠ **0003 reads the files**: run `bun run migrate` where the uploads volume is mounted (it refuses where the
  upload root is missing). It repoints a `File` row the inbox move left behind to its document, and LISTS rows
  with no bytes and no document, never deletes them.
- ⚠ **Once 0003 has run, roll back only to a release that has #177's readers.**
- `File.sha256` is recorded at upload; migration `0002-file-sha256` backfills it from the bytes on disk
  (a file whose bytes are missing is left without one).

## Data migrations (FR-20.19, plan step P0b-7)

A data change a release needs is a **versioned migration** in `packages/migrations`, not a hand-run
`scripts/migrate-*.ts`: a master has no operator. `src/registry.ts` lists them in order (`NNNN-kebab-name`,
append only); `runner.ts` runs the pending ones under a lock in `_migrations` and records `appliedAt`,
`durationMs`, `appVersion`, `checksum`. The server runs it before `listen` when `MIGRATIONS_AUTO=true` (off by
default, the kill switch); `bun run migrate` runs it by hand.
- ⚠ **Never edit a released migration.** The runner refuses to start when an applied one's FILE changed;
  a fix is a new migration (`--accept-changed <id>` only for a harmless edit).
- ⚠ **The checksum is the file's fingerprint, never `up.toString()`** (`src/fingerprints.json`, P0b-9). A
  bundle prints `up` differently: a bundled runner read 5 of 6 released migrations as changed and would
  not start. A NEW migration adds its line with `bun run packages/migrations/src/fingerprint.ts --write`;
  `unit/migration-fingerprints.test.ts` fails until it does. A record made under the old checksum is
  re-recorded by the first SOURCE run (`Re-recorded … under its file fingerprint`); a bundle cannot
  recompute the old one, so a database meets a source runner of this version before a bundled one.
- **Idempotent** (AC 8: every registered migration is re-run on a seeded DB in
  `migrations.flow.test.ts` and must change nothing), **expand-then-contract** across a release, and scoped
  by `ctx.orgFilter` (every org today; P0b-3 narrows it to the orgs whose home is this node).
- The backup FR-20.19 asks for comes from whoever runs it (the master supervisor, the nightly backup on
  global), not from server start.

## The server package (FR-20.25/FR-20.26, plan step P0b-9)

What a master runs: `bun run build && bun run build:server && bun run check:package` →
`dist/lgr-server/` = `server-manifest.json` (commit, Bun, every file's sha256, no build clock) +
`app/server.js` + `app/migrate.js` + `app/scripts/<name>.js` (`SCRIPT_ALLOW_LIST`) + `ui/<module>/`.
Run it with `LGR_UI_ROOT=<package>/ui`. Shared definitions: `scripts/lib/server-package.ts`. CI builds,
checks, boots (`integration/server-package.flow.test.ts` with `LGR_SERVER_PACKAGE`) and rebuilds it
(identical manifest). `check-package.ts` refuses an unlisted/changed file, an ignored path, `.secrets/`,
a seal key, `.env*`, a cloud secret name (in a bundle: one given a VALUE), another origin in a built
SPA (AC 66), a packaged script whose import graph touches `Invoice`/`POSTransaction`/`CashOrder`
(AC 67), and a bundle with NODE_ENV inlined.
- ⚠ **`Bun.build` inlines `process.env.NODE_ENV` as "development"**, even with `env: 'disable'`: every
  production guard compiles to false (the bundle STARTED with no `JWT_SECRET`). Server code is only ever
  bundled through `serverBuildOptions()`, which defines it to itself.
- ⚠ **A bundle has nothing beside the source.** An asset is IMPORTED: CSS/text `with { type: 'text' }`,
  a binary `with { type: 'file' }` resolved against `import.meta.dir` (relative once bundled), data as a
  JSON import. Never `readFileSync(new URL('../x', import.meta.url))` or `createRequire().resolve()`:
  every PDF failed with ENOENT on `assets/markdown.css`. One file cannot be imported as text AND as code
  in one bundle ("No matching export").
- **lgrai.app's analytics tag is added by the server** to the portal shell, on `global` only
  (`spa-fallback.ts#portalShellFor`); `portal-ui/index.html` carries no origin, so no build does. Swagger
  (its page loads Scalar from a CDN) is served on `global` only. Both are AC 66: a master serves no
  third-party script.
- The static plugins are **awaited** before `listen`: unawaited, every asset answered 404 for ~180 ms
  after `/api/health` said ready.
- `bun build --compile --target=bun-windows-x64-baseline` (2026-10-24 spike): one 127 MB executable,
  booted from an empty directory, served the SPAs, signed in and printed an invoice. Chrome and the
  fonts are not in the package yet (P1).

## The two-node harness (FR-20 plan Part F.2, step T-1)

`packages/tests/src/two-node/harness.ts` boots a `global` and a `master`, each its own process on its
own `MongoMemoryReplSet` with its own keys and no schedulers. Between them sit `chaos-proxy.ts`
(`drop` · `blackhole` · `down`/`up` · `delay` · `throttle` · `flapAt`, raw TCP) and `tls-front.ts`
(TLS/WSS terminator; a test CA minted per run by `openssl`, so no key is ever committed). The
master's side reaches global at `uplinkUrl` with the run's CA. With `LGR_SERVER_PACKAGE` both nodes
run the package. `two-node.test.ts` runs only with `LGR_TWO_NODE=1` (CI, after the package is built).
- ⚠ WebSocket close codes 1005/1006/1015 are only ever REPORTED: passing one to `close()` throws, and
  in the front's close handler that broke the next upgrade. `tls-front.ts#sendable` maps them.
- ⚠ Lifting a blackhole closes the connections that went silent, or a client's pooled connection
  hangs its next request: a blackholed TCP connection is dead to its client.

## The synthetic field-test org (FR-20.112/113, plan step T-2)

A throwaway instance gets its data from `scripts/seed-fieldtest.ts` and nothing else (AC 45):
`bun run scripts/seed-fieldtest.ts --org lgr-fieldtest-<name> --seed <n> --preset small|regal --server <url> --execute`.
- It writes only into `lgr-fieldtest` / `lgr-fieldtest-<name>` (exit 2 otherwise), nothing without
  `--execute`, and over an existing org only with `--replace`. The admin is `admin` with
  `FIELDTEST_ADMIN_PASSWORD`, or a generated password in `.secrets/fieldtest-<org>.password`.
- Phase 1 (MONGODB_URI): the org through `register()`, then warehouse, categories, tags, products and
  contacts in bulk, ids from the seed (`scripts/lib/fieldtest-data.ts`, import-pure). Phase 2
  (`--server`): receipts confirmed, then invoices issued, through the API, so numbering, stock and
  dispatch are the server's. Phase 3: the server's own invoice PDFs and Excel exports, uploaded.
- `regal` is regal-pz's shape: 23k Cyrillic fastener products tagged as `assign-din-tags` tags them,
  2k contacts, 350 receipts + 550 invoices (900 movements), 1.5k files. `small` takes ~11 s.
- ⚠ Nothing real: names from word lists, ЕИКs with a deliberately WRONG check digit, every e-mail
  under `.invalid`. A new org has no accounting defaults (`settings.accounting`), so the event
  handlers journal nothing: no entries, as for an org that only invoices.
- `scripts/data-scan.ts`: `--export` against production (native driver, so no index builds) lists
  every org but the synthetic ones (field-test, `acme-corp`, `beta-inc`); `--denylist <file>` against
  a throwaway refuses on any of their ids (as ObjectIds or inside strings) or slugs (as words).
  ⚠ The DEMO seed creates an org with the slug `regal`, a real customer's: never run it on a
  throwaway, the scan rightly flags it.

## The API behind the supervisor (FR-20 plan step P1-3)

On a master the API answers the supervisor alone (`portal-api/src/front/`). The supervisor sets
`LGR_FRONT_SECRET` (per boot, ≥ 32 characters), `LGR_FRONT_HOSTS` and `LGR_CONTROL_SOCKET`. With no
secret (global, a developer's machine, the tests) the front checks are off, and no `X-LGR-*` header
is ever read as a stamp.
- **`frontRefusal`** runs in the root app's `onRequest`: before routing, and for WebSocket upgrades
  too (Elysia 1.4.30 refuses an upgrade from there). In order:
  - the front secret (`x-lgr-front`, constant time), else 403;
  - `Host` on the list, else 403. Any IP literal and `localhost` are on it, since DNS rebinding
    always arrives under a name;
  - the source stamp, `x-lgr-source` ∈ `lan | tunnel | console`, else 403.
- **On EVERY master, front or not:**
  - `/internal/*` and `/api/setup/*` answer 404 over HTTP, matched on the normalized path (decoded,
    lowercased, single slashes, no trailing slash);
  - the three routes that create an org (`POST /api/auth/register`, `POST /api/auth/orgs`,
    `POST /api/oauth/pending/register`) answer 404 unless `source=console` (FR-20.18).
- **`source=lan` needs a paired desktop:** `X-LGR-Desktop-Token`, verified and then re-read through
  `loadActiveDesktop`, so a revocation takes effect at once.
  - Exempt: `GET /api/health` and `POST /api/desktop/v1/{enroll,token}`, matched EXACTLY. A variant
    such as `/api/health/` is gated: an exemption fails closed.
  - ⚠ This is the one `X-LGR-*` header the LAN ingress carries over from the client. It is a
    credential the API verifies, never a stamp it trusts.
- **`clientIp()` behind the front** returns `x-lgr-client-ip` only. There is no nginx in front of a
  master, so `X-Real-IP` and `X-Forwarded-For` are the client's own text.
- **The control socket** (`control-socket.ts`): HTTP over AF_UNIX (`Bun.serve({ unix })`), and every
  request carries the front secret.
  - `GET /status`: schedulers, `fiscalInFlight`, `posOpen`, requests and sockets in flight.
  - `POST /stop`.
  - ⚠ Bun 1.4.4 on Windows serves HTTP on an AF_UNIX path, but not on a named pipe (ENOENT). A
    path longer than 108 bytes fails with ENAMETOOLONG.
- **One graceful stop** (`graceful-stop.ts`), for SIGTERM, SIGINT and the socket alike:
  1. stop listening, but keep the open WebSockets (a receipt printing through a bridge needs its
     socket);
  2. halt the schedulers;
  3. wait up to `LGR_STOP_WAIT_MS` (25 s) for the fiscal operations and the requests in flight;
  4. disconnect the devices;
  5. exit 0.

  ⚠ On Windows, CTRL_BREAK ends Bun at once with `0xC000013A` and runs no handler. Under the
  supervisor, the socket is the only graceful stop.
- **Fiscal in flight** (`fiscal/in-flight.ts`):
  - `getPrinter()` hands out a counted view of the printer: one per printer, stable across calls,
    and NOT the object that was registered;
  - a POS sale's and a storno's whole print sequence is one `fiscalOperation`, so a stop never lands
    between "open receipt" and "close receipt".

## The supervisor, `lgr-server` (FR-20 plan step P1-1)

`packages/server` (Rust, own `Cargo.lock`, toolchain 1.98) is what a master runs: it starts the
API from the server package (`<home>/package/app/server.js` under `<home>/bin/bun` or `bun`), keeps it
up, and answers a local control channel. `lgr-server run` (foreground) · `service install|uninstall|run`
· `status [--json]` · `restart <child>` · `stop` · `diagnostics` · `run-script <name>` (only what the
package manifest's `scripts` lists) · `setup-token`. `backup now` and `update-helper` answer "not
yet" (exit 2) until P1-9 / P1-8.
- **Backoff** (`backoff.rs`, roomler's numbers): 2 s doubling to 60 s, reset after 30 s up. Exit
  **7** (configuration) and **8** (refused on purpose) are never retried, by it or by systemd
  (`RestartPreventExitStatus=7 8`); a clean `0` is a failure like any other.
- **The API's environment is built, never inherited** (`config.rs`): OS basics, then `HOST`/`PORT`
  /`UPLOAD_DIR` defaults, then `<data>/config/api.env`, then the API's own keys
  (`<data>/keys/api-secrets.env`, made on first boot, never rotated here), then what nobody
  overrides: `NODE_ENV=production`, `LGR_NODE_ROLE=master`, `LGR_UI_ROOT`. A master never gets the
  cloud's secrets (D-12).
- **Children run in a Job Object (Windows) / their own session (Unix)**, so Chrome's helpers die with
  the API. ⚠ A test child must die of an ordinary stop: `ping` takes Ctrl+Break as "print
  statistics" and carries on (the tests re-run their own binary as `child_sleeps`).
- **Stopping (FR-20.23):** the ingresses close first, then the children stop in REVERSE start order,
  each fully before the next — the API while its database still answers, `mongod` last. Each says
  how it is asked (`child::Stop`) and how long it has (`ChildSpec::grace`):
  - the API through its control socket (`POST /stop`, P1-3), with its own `LGR_STOP_WAIT_MS` + 15 s,
    since it waits for a receipt in flight;
  - `mongod` through its own `shutdown` command as its administrator, with 30 s for its last
    checkpoint.

  Both are clean on every OS, console or not, and a signal is the fallback. ⚠ Under the SCM there is
  no console, so CTRL_BREAK cannot be sent and that fallback is the job, at once. Stopping
  everything at once let `mongod` go first, under the API's last writes.
- **Control channel** (`ipc.rs`): NDJSON over `\\.\pipe\lgr-server` (a pool of 4, the first
  `first_pipe_instance`, so a squatter or a second supervisor stops it: exit 8) or
  `/run/lgr-server/control.sock` (0600; systemd's `RuntimeDirectory=`). Admins and the service only.
- **Data** (FR-20.14): `%ProgramData%\LGR`, `/var/lib/lgr`, `/Library/Application Support/LGR`,
  readable by the service and administrators only (Windows: inheritance removed, the service,
  SYSTEM and Administrators granted by SID). Windows service: `LGRServer` as `NT SERVICE\LGRServer`,
  recovery 5/30/60 s, 24 h reset. Linux: `lgr-server.service`, `User=lgr`. macOS: LaunchDaemon
  `ai.lgrai.server` as `_lgrserver` (P1-7 creates the user).
- **`mongod` (P1-2, FR-20.15, `mongod.rs`):** started first, on 127.0.0.1 only (port 27118, never
  27017, which another MongoDB may own), `--replSet rs0`, `--keyFile keys/mongo.keyfile`, cache
  0.5/1/2 GB by RAM (<8 / <16 / more GB), oplog 2 GB. The API is listed `pending` until the
  bootstrap returns its URI. `MONGODB_URI` in `config/api.env` means "my own database": no `mongod`.
  - ⚠ The bootstrap is idempotent and crash-safe: the passwords go into `keys/mongo.env` BEFORE the
    users exist, then `replSetInitiate` + the admin user via the localhost exception, then the API's
    user as admin. Users that `keys/mongo.env` does not open (keys lost or replaced) are a REFUSAL,
    exit 8, never a reset: only restoring the keys brings the data back.
  - ⚠ mongod exits 1 at once, saying so only on its console, when its `--logpath` directory is
    missing. Its console goes to `logs/mongod.console.log`.
- **Preflight (FR-20.13, `preflight.rs`, `lgr-server preflight`):** AVX (or ARMv8.2-A, `dpb`), ≥ 4 GB
  RAM, ≥ 20 GB free, a local fixed disk (no UNC, mapped share, removable, RAM disk, NFS/SMB/FUSE,
  tmpfs, roaming profile), and on Windows the VC++ runtime. The supervisor runs it before starting
  anything: a failure is exit 7, with each reason in words.
- **The front (P1-3b, FR-20.16, `front.rs`), made at every boot:**
  - the front secret, kept in memory and given to the API in its environment;
  - the API's loopback port, picked free;
  - the control socket, `<data>/run/api.sock`. AF_UNIX on every OS, so a data path that makes it
    longer than 100 bytes is exit 7;
  - the names `Host` may carry: the machine's, `<machine>.local` and `LGR_LAN_NAMES`.

  The API's `HOST` (127.0.0.1) and `PORT` are forced: the API answers the supervisor alone (see "The
  API behind the supervisor"). `control.rs` talks HTTP over the socket, through `uds_windows` on
  Windows, where tokio has no AF_UNIX client.
- **Ingresses (`ingress.rs`, hyper 1):**
  - each strips the client's `X-LGR-*`, its hop-by-hop headers and the forwarding headers a client
    can write (`X-Real-IP`, `X-Forwarded-*`, `Forwarded`);
  - each stamps the secret, the source, the peer's address and `X-Forwarded-Proto`;
  - the only client header carried over is the LAN's `X-LGR-Desktop-Token`;
  - a WebSocket upgrade becomes a byte pipe after the API's 101, and an API that is down is 502.
- **The setup console (FR-20.18):** `127.0.0.1:SETUP_PORT` (4480), only until `state/setup-complete`
  exists, then it closes itself. It answers its own address in `Host` only.
  - `lgr-server setup-token` prints `http://127.0.0.1:4480/__lgr/setup#<token>`
    (`keys/setup-token`). It is made on first use, so it works before the first start.
  - The page trades the fragment's token for an `HttpOnly; SameSite=Strict` cookie `lgr_setup`,
    which is stripped before the API sees the request.
  - ⚠ Cookies ignore ports: any other server on 127.0.0.1 receives `lgr_setup` too. That is
    acceptable for a session that only opens setup on loopback, never for a longer-lived credential.
- **The LAN ingress (P1-3c, FR-20.30, `certs.rs`):** HTTPS on `0.0.0.0:LAN_PORT` (4443), only with
  `LAN_INGRESS=on`: a master with no desktops opens nothing on the LAN.
  - It serves the master's own certificate: a CA made once at first start, ECDSA P-256 for 20 years
    (`keys/lan-ca.*`, what desktops pin, so never replaced here), signing a server certificate for
    397 days (`keys/lan-server.*`).
  - The server certificate names the machine, `<machine>.local`, `LGR_LAN_NAMES`, every LAN
    address, `localhost`, 127.0.0.1 and ::1. Every 60 s it is re-issued if those names changed
    (DHCP), and 30 days before it expires; the next handshake serves the new one.
  - The CA's name derives from its own key (the digest's first 6 bytes, hex), so later certificates
    are signed from the key alone. rcgen, rustls and ring throughout: never aws-lc-rs, which needs cmake.
  - ⚠ A port the bind cannot get is a loud error, never a fatal one: the console and the API stay
    up for whoever fixes it. On Windows, PID 4 (System, http.sys reservations) can hold a port.
- **Pairing (P1-6a, FR-20.29) is FR-14's enrollment, against the master.** The fingerprint has ONE
  written form, `sha256:<base64url of the CA SPKI's SHA-256>`, everywhere.
  - With the LAN ingress open, the API is given `LGR_LAN_URL` and `LGR_LAN_CA_FINGERPRINT`.
    `LGR_LAN_URL` is the default route's source address (`certs::default_route_v4`, a UDP `connect`
    that sends nothing). ⚠ Not the first private address: here a Hyper-V switch, 192.168.128.1,
    sorts before the real LAN.
  - A code minted there names that address, whatever address the admin is on (the console is
    127.0.0.1). Its link carries `&fp=…`, and it comes with six words for a code typed by hand: the
    first 66 bits of the digest, 11 a word, from BIP-39 English
    (`services/biz/desktop/fingerprint-words.txt`, MIT, sha256 `2f5eed53…`, kept LF by
    `.gitattributes`). The desktop shell reads the same file.
  - `GET /__lgr/ca.pem` on the LAN ingress answers the CA itself, never the API, with no desktop
    credential. A pairing desktop fetches it untrusted, checks it against `fp` (or a person checks the
    words), then trusts that CA alone.
- **The shell trusts a master by its pin (P1-6b, FR-20.31, `desktop/src-tauri/src/trust.rs`):** one
  client per server for everything the shell sends (enrollment, tokens, `/self`, the manifest,
  presence, the bridge, the updater).
  - lgrai.app: native-tls, the OS store and the system proxy, as before. A paired master: rustls
    with a root store holding only its CA, never a proxy, and `X-LGR-Desktop-Token` on every request
    and WebSocket upgrade.
  - The pin is `settings.master` (`origin`, `caPem`, `fingerprint`), written by enrollment only:
    `save_settings` keeps it whatever the page sends. Enrollment fetches the CA again itself and
    checks it against the fingerprint the page names (`trust::confirm`).
  - ⚠ **A pin applies only to a name no public CA can certify** (`trust::may_pin`): a private,
    loopback, link-local or shared (100.64/10) address, a single label, `.local`, `.home.arpa`,
    `.internal`, `.localhost`. A deep link is attacker-controlled, and
    `server=https://lgrai.app&fp=<theirs>` plus someone in the middle of the shop's network would
    otherwise pin the cloud's own name to their CA, while the window still showed the real site.
  - ⚠ `tungstenite`'s `MaybeTlsStream` is `non_exhaustive`, so every match on it needs one arm per
    transport. The bridge's read-timeout match fell to `_ => {}` for rustls: a loop blocked in `read`
    for ever, past `stop` and past revocation.
  - The updater plugin builds its own reqwest 0.13 client: the pin goes in through
    `configure_client`, which needs the plugin's `rustls-tls` feature (ring). native-tls stays the
    default backend when both are on, for reqwest 0.12 and 0.13 alike.
  - The Rust and TypeScript server-URL rules answer to one table,
    `desktop-ui/src/server-url.cases.json`; they disagreed about `[::1]` and the rest of 127/8.
- **The window reaches a master through a loopback proxy (P1-6c, FR-20.32,
  `desktop/src-tauri/src/proxy.rs`):** `lgr-web` loads `http://127.0.0.1:<settings.proxyPort>`, and
  the proxy forwards to the master over the pinned TLS with `X-LGR-Desktop-Token` (minted by the
  shell, kept 10 minutes, minted again when the master answers a `desktop_*` 401).
  - Only the window gets in. `Host` must be exactly `127.0.0.1:<port>`, `Origin` (when sent) the
    proxy's, and a per-launch secret must ride in the `HttpOnly; SameSite=Strict` cookie
    `lgr_launch`. The window gets it from `/__lgr/boot#<secret>`: the page posts the fragment and
    drops it from the address. ⚠ It is never forwarded and never logged (`web::loggable` strips it
    from the "opened url=" line).
  - `Host`, `Origin` and `Referer` move to the master's origin, and a `Location` back to the proxy's.
    One upstream connection per request: no keep-alive the master closed while idle can swallow a
    POST.
  - The port is the installation's, so the SPAs' per-origin storage survives a restart.
    `settings.webServer` records whose session that storage holds; a window opened for another
    server clears it first. ⚠ An empty value (every install before this) clears nothing: wiping it
    on an update would sign out every till at once.
  - A master never opens in the system browser: a browser would send the launch cookie to every
    server on 127.0.0.1 (cookies ignore ports).
  - Measured in Chrome: `__Host-auth` (`Secure`) is kept on `http://127.0.0.1`, so the master's
    cookies need no rewriting.
  - ⚠ Found on the way: the unreachable page's Retry and Diagnostics were refused on Windows, whose
    bundle is `http://tauri.localhost` (read as a remote page). `act_on_shell_request` now asks
    `is_bundled_host`.
- **Finding a master (P1-6d, FR-20.28):** the supervisor advertises its LAN ingress as
  `_lgr-server._tcp` (`server/src/advert.rs`), with `v`, `node`, `fp` (the CA desktops pin), `name`
  and `ip` in TXT. It is re-registered when DHCP moves the address. The shell browses it
  (`desktop/src-tauri/src/discovery.rs`): the onboarding's "On this network" list, and a paired
  desktop that has stopped reaching its master.
  - On Windows both sides use the OS's own DNS-SD (`DnsServiceRegister` / `DnsServiceBrowse` +
    `DnsServiceResolve`): a per-user app cannot open the firewall for its own multicast listener.
    `mdns-sd` elsewhere.
  - ⚠ Windows answers address queries for the machine's own name ONLY: an advert pointing at a
    name of its own never resolves (the resolve waits until cancelled, status 1223). And it answers
    that name with whichever interface the query came in on: measured, the WireGuard overlay's
    100.65.0.5, not the LAN's 192.168.8.115. Hence `ip` in TXT, which the shell prefers.
  - ⚠ An advert proves nothing. A chosen server is probed and pinned as a typed one is. A server
    whose certificate is not the one its advert claimed is refused, with no tick to override it.
  - **"By identity, not by address":** after three unreachable presence attempts in a row (at most
    every two minutes), the shell looks for its pin's fingerprint (`discovery::locate`). It moves
    only to an address the pinned TLS proves, and moves everything with it: settings, pin,
    `webServer` (the same master's session is not cleared), the proxy via `Running::retarget`
    (same port, so the window keeps its sessions), and presence. The bridge needs a restart, as on
    any re-point.
- **The egress (P1-3d, FR-20.53, `egress.rs`):** on a master the API makes no direct internet call.
  Bun's `fetch` has its own CA bundle and no PAC. The API is given:
  - `HTTPS_PROXY` / `HTTP_PROXY`: `http://lgr:<per-boot secret>@127.0.0.1:<port>`. Any process can
    reach a loopback port; only the API knows the credential. Without it the answer is 407;
  - `NO_PROXY`: loopback;
  - `NODE_EXTRA_CA_CERTS`: the OS's trusted roots, exported at each start (`run/os-roots.pem`,
    rustls-native-certs), so a TLS-inspecting middlebox whose root came by GPO is trusted.

  Bun 1.4.4 honours all four, credentials included (measured). Upstream, per CONNECT:
  1. `EGRESS_PROXY` (+ `EGRESS_PROXY_AUTH` for Basic);
  2. on Windows, WinHTTP's machine setting, then WPAD/PAC (`EGRESS_PAC`), cached 5 min, "no WPAD"
     10 min;
  3. direct. `EGRESS_BYPASS` and WinHTTP's bypass list go direct.

  CONNECT only: plain HTTP is a 501, never sent direct behind its back. The egress stops LAST, after
  the API, which may still need it while it finishes. ⚠ Not yet: Negotiate (Kerberos/NTLM) proxy
  authentication, and PAC off Windows.
- **`status`** carries `front` (port, socket, names, console, `lan` with the CA's SPKI fingerprint,
  `egress`; never a secret), and `api`, the API's own `/status`: schedulers, `fiscalInFlight`,
  `posOpen`.
- CI: clippy + `cargo test` on Linux, and the real-`mongod` bootstrap test runs wherever
  `LGR_SERVER_TEST_MONGOD` names a binary (mongodb-memory-server's cache has one). ⚠ Since the
  driver (rustls → `ring`) needs a C compiler for its target, clippy with `--target` from Windows no
  longer works: Linux is checked by CI natively. Installing the service for real is a vmtest cell
  (T-3), not CI.

## Outbound calls have deadlines (FR-20.53)

`fetch` has none: a host that accepts and never answers holds the request forever. Every call to
another server goes through **`services/biz/outbound-fetch.ts#fetchWithTimeout`** (or passes its own
`signal`): `until: 'body'` (default) bounds the whole exchange, `until: 'headers'` only the wait for the
response, for a body streamed on to a client (the installer download). ⚠ `unit/outbound-timeouts.test.ts`
scans server code and fails on any `fetch(` call without one.

## Auth Pattern

`AuthService` is an Elysia plugin (`packages/portal-api/src/auth/auth.service.ts`) that:
- Derives `user` from the `Authorization: Bearer` header, or from the session cookie only when no
  header is sent (S-22: a non-empty Bearer is used exclusively, and an invalid one is never rescued
  by the cookie). Rules in `services/biz/session-token.ts`, shared by all eight auth plugins.
- ⚠ **The session cookie is `__Host-auth`** (FR-20.72, P0a-8), and so are the OAuth flow cookies
  (`__Host-oauth_state` / `_handoff` / `_pending`, `portal-api/src/auth/oauth-cookies.ts`): an
  org's address `<slug>.lgrai.app` is a sibling subdomain, and the prefix is what stops it planting
  them. Always `Secure` + `Path=/`, and cleared with explicit attributes, **never `remove()`**
  (it sends no Path/Secure, so the browser ignores it). **A same-site request never authenticates
  by cookie** (`isSameSiteRequest`: `Sec-Fetch-Site: same-site`, or, from a browser that sends
  none, an `Origin` that is another origin of `OAUTH_FRONTEND_URL`'s site); `oauth_state` is
  exempt (the callback is same-site against a localhost fake provider). ⚠ **The plain names
  (`auth`, `oauth_*`) are neither written nor read** since release N+1 (2026-10-24): a subdomain
  CAN plant a plain cookie for lgrai.app, so never add a fallback to them.
- `portal-api/src/isolation-headers.ts` puts `Cross-Origin-Resource-Policy: same-origin` and
  `Origin-Agent-Cluster: ?1` on every response. ⚠ Elysia's `onRequest` takes a handler ONLY: an
  options object passed first (`{ as: 'global' }`) is registered AS the hook and every request
  throws. Request hooks are always global.
- Provides `{ isSignIn: true }` macro for route protection
- JWT payload: `{ id, email, username, firstName, lastName, role, orgId, permissions, operatorCode?, iid?, tv? }`
- Single JWT issued by Portal, validated by all controllers in the same process

There is also `app-auth.service.ts` (verify-only variant) for use if domain APIs run standalone.

### People and their orgs (multi-org sign-in, 2026-10)

A person is an **`Identity`** (global: email, password, OAuth links); each org's `User` is their
**membership** there (`identityId`). A session is still ORG-SCOPED (`tokenize()` of one membership),
so the tenant guard and every permission check are unchanged. Plan:
`~/.claude/plans/scalable-seeking-summit.md`; model page `docs/models/core/identity.md`.
- **Login** (`POST /api/auth/login`): `username` takes a username or an email. Without `orgSlug` it
  names a person and lands in the org this browser was last in (`preferredOrgId`), their last org,
  or their only one; otherwise it answers `needsOrgChoice` with an **identity-only token** (no
  `id`/`orgId`) that reaches only `services/biz/identity-routes.ts` (`GET /auth/orgs`,
  `POST /auth/switch`). A username several people use is **409 `ambiguous_login`**. `orgSlug`
  keeps the legacy one-org path that scripts, skills and the old UI use.
- ⚠ A linked membership signs in with its **person's** password, never its legacy per-org
  `User.password` copy.
- `iid`/`tv` on a session tie it to the person: a password change bumps `tokenVersion` and every
  session they hold stops working (`liveSessionUser`, cached a minute per process).
- An org admin never sets the password, email or name of someone active in another org
  (`identity_shared`), and never creates a user at an address that is already someone's
  (`identity_exists`: they invite instead).
- Seed credentials: `admin@acme.com` / `test123` (org-less `admin` is ambiguous between acme-corp
  and beta-inc, by design), or `acme-corp` / `admin` / `test123` on the org path.
  `multi@lgr.test` / `test123` works in both demo orgs.
- **The person's own account** (`services/biz/identity/account.service.ts`):
  - `POST /auth/password`: change it, proving the current one;
  - `POST /auth/password/forgot` + `/reset`: by email. The token is stored only as a SHA-256 in
    `auth_tokens` and rides in the link's fragment;
  - `POST /auth/orgs`: found an org;
  - `POST /invite/:code/accept`: join one.
  The last two need a credential the person OWNS (rule 3, `own_password_required`): a password
  set by an admin or carried over by the migration must be changed first, while provider-only
  sign-in passes.
- **Backups carry the people.** Each org bundle has an `Identity` section with the persons its
  users point at, password hash included (`backup-bundle.service.ts#PEOPLE_MODEL`). ⚠ A restore
  only ever INSERTS a missing person. It never updates, deletes or remaps one, in either mode,
  because the person is shared with other orgs and the live row holds the current password and
  `tokenVersion`. A rollback removes only the people that restore added.

### Each browser tab keeps its own org (the SPAs, Phase 3)

- ⚠ **Never read `lgr_token` / `lgr_org` yourself.** Every SPA reads and writes its session
  through `ui-shared/src/session/session.ts` (`getToken`, `getOrg`, `claims`, `setSession`,
  `logoutEverywhere`), and `unit/session-keys.test.ts` fails if any other UI source names the
  keys. A tab's session is in `sessionStorage`; `localStorage` only holds what a NEW tab starts in
  (adopted once, never read live). A tab reading localStorage directly would act in whichever
  org another tab switched to last, with a valid token: requests succeed, in the wrong org.
- **Switching** (`ui-shell/OrgSwitcher.vue`, `ui-shared/session/useOrgSession.ts`) moves THIS tab
  only: `POST /auth/switch`, then a full reload into the other org. It is refused while the tab
  holds something a reload would orphan (`session/switch-guards.ts`: a POS sale, a bridged fiscal
  printer) and asks first over unsaved form edits.
- **Downloads go through the session, never a plain link** (`useSessionDownload.ts`): an
  `<a href="/api/…">` carries only the session cookie (`__Host-auth`), which names the org this
  browser entered LAST, in any tab.
- **A 401 signs out this tab only**; a sign-out signs out every tab of the same person
  (BroadcastChannel). An identity-only session (no org chosen yet) may use only `/orgs`.
- Portal pages: `/auth/login` (no org field until asked for), `/orgs` (picker), `/account`,
  `/auth/forgot-password`, `/auth/reset-password#token=…`. The OAuth callback redirects to
  `/auth/login?error=<code>`, and the page translates only codes it knows.
- ⚠ A session issued before its membership was linked to a person carries no `iid`: it sees only
  its own org (`/auth/orgs`) and cannot switch until it signs in again. That is deliberate: such a
  token has no `tv`, so letting it mint switched sessions would bypass revocation.

### OAuth Social Login

OAuth controller at `/api/oauth/:provider` supports Google, Facebook, GitHub, LinkedIn, Microsoft.

**Flow**: `GET /api/oauth/:provider` (optionally `?org_slug=xxx` for the one-org path, `?prefer=<orgId>` for where to land) → redirect to provider → callback at `/api/oauth/callback/:provider` → find the person → handoff cookie → `/auth/oauth-callback` (an org session, or the org picker). Which buttons the login page shows comes from `GET /api/oauth/providers`.

**Callback URLs** (register in provider apps):
```
http://localhost:4001/api/oauth/callback/google
http://localhost:4001/api/oauth/callback/facebook
http://localhost:4001/api/oauth/callback/github
http://localhost:4001/api/oauth/callback/linkedin
http://localhost:4001/api/oauth/callback/microsoft
```

**Env vars**: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `FACEBOOK_CLIENT_ID`, `FACEBOOK_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `OAUTH_BASE_URL`, `OAUTH_FRONTEND_URL`. Production values live on mars at `gjovanov@mars:/home/gjovanov/.lgr.oauth`.

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
- Each domain UI imports `ui-shell` for the shared app shell (top bar, app switcher, org selector, user menu)
- Each domain UI imports `ui-shared` for composables, Vuetify/i18n plugins
- Each domain UI has its own router with only its module's routes
- Each domain UI has its own Pinia store

### App Hub (Portal UI)

The Portal's main authenticated view is the **App Hub** — a grid of available apps (like Google's app launcher). Clicking a tile navigates to the domain app's URL path (e.g., `/accounting/`).

**App availability** is determined by:
1. Org subscription plan (free = 2 apps, starter = 4, professional = all, enterprise = all + priority)
2. User permissions (user with `accounting.read` sees Accounting app tile)
3. Org-level app activation (admin enables/disables apps in settings)

**`APP_REGISTRY`** in `config/` defines metadata for all apps (name, icon, color, path, requiredPermission).

**`OrgApp`** model tracks which apps an org has enabled: `{ orgId, appId, enabled, activatedAt }`.

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

- **Bun is pinned: `.bun-version` (1.4.4).** Every workflow's setup-bun reads it, the Dockerfile's
  base image is that tag pinned by digest, `package.json#packageManager` names it, and `bun.lock` is
  committed and installed `--frozen-lockfile`. `unit/bun-pin.test.ts` fails on any drift. To bump:
  change all four together, regenerate `bun.lock` with the new Bun, run the full suite. ⚠ Until
  2026-10-23 production and CI ran 1.3.10 and dev machines 1.4.x, and three bugs lived only in
  the runtime nobody ran locally.
- `.env` — development (MongoDB at `localhost:27018/lgr`, no auth)
- `.env.test` — testing (overridden by mongodb-memory-server)
- API `packages/portal-api/package.json` scripts use `--env-file=../../.env` to load root env
- Docker: `docker-compose.yml` runs MongoDB 7 as a **single-node replica set `rs0`** without auth. The healthcheck idempotently runs `rs.initiate()` on first startup. App connects via `mongodb://mongo:27017/lgr?replicaSet=rs0&directConnection=true`. The replica set is required for **multi-document transactions** (used by the goods-receipt-with-product-update flow).
- For local dev (outside Docker), either run the Docker mongo or add `?replicaSet=rs0` to your local URI if your local server is configured accordingly. `mongodb-memory-server` in tests supports replica-set mode — see `setupTestDB()` for the flag.
- `SUPTO_MODE` — `production` (enforces fiscal receipts, immutability) or `development` (default)
- `SUPTO_TIME_SYNC_INTERVAL_MS` — NTP/fiscal device sync interval (default: 6h)

## Deployment

**Repos & remote checkouts:**
- **Source**: https://github.com/gjovanov/lgr — this repo; also checked out on the build host at `gjovanov@mars:/home/gjovanov/lgr` (used for image builds)
- **Deploy**: https://github.com/gjovanov/lgr-deploy — checked out at `gjovanov@mars:/home/gjovanov/lgr-deploy` (k8s cluster manifests)
- **tmux on mars** (`ssh mars`): sessions named `lgr` and `lgr-deploy` for working in the two checkouts
- **OAuth keys**: `gjovanov@mars:/home/gjovanov/.lgr.oauth` — OAuth provider client IDs/secrets (not in git)

Deployment configuration lives in a **separate repo**: https://github.com/gjovanov/lgr-deploy (typically cloned as a sibling folder `../lgr-deploy/`). This repo contains Kustomize manifests (`k8s/base/` + `k8s/overlays/prod/`), Ansible playbooks (host-level only), and legacy Docker Compose for local dev.

The production infrastructure runs on **Kubernetes**, managed via: https://github.com/gjovanov/k8s-cluster-multi. Cluster-wide infra (VMs, WireGuard, CNI, coturn) belongs here; per-app deploys belong in `lgr-deploy`.

**GitOps**: ArgoCD at [argocd.roomler.ai](https://argocd.roomler.ai) reconciles the `lgr` Application from `github.com/gjovanov/lgr-deploy @ master` path `k8s/overlays/prod`. Sync policy is **automated** (`prune` + `selfHeal`, 60s reconcile) — pushing the tag bump deploys it; `kubectl set image`/`kubectl edit` on the cluster is reverted by selfHeal.

**Image registry**: `registry.roomler.ai` (self-hosted Docker Registry v2 on mars). Pull secret `regcred` exists in the `lgr` namespace.

Secrets (`lgr-secret`, `mongodb-secret`, `mongodb-keyfile`) are sealed via Bitnami SealedSecrets and committed to git under `k8s/base/sealed/`.

## Post-Implementation Testing

After every feature or fix, verify your changes:

| Change type | Command | What it checks |
|-------------|---------|----------------|
| Backend (models, services, controllers) | `bun run test` | Integration tests (mongodb-memory-server) |
| Frontend (views, stores, composables) | `bun run build` | TypeScript + Vite build (all 7 UIs) |
| Full-flow (auth, routes, UI+API) | `bun run test:e2e` | Playwright E2E tests |

Run the **most specific** command first. If a backend change also affects the frontend, run both.

## ERP Modules

Accounting (accounts, journal entries, fiscal years/periods, fixed assets, bank accounts, reconciliation, tax returns, exchange rates) · **Sales** (quotations, sales orders with state machine, quotation templates, auto-invoice from SO, event-driven stock dispatch) · **Purchase** (RFQs, purchase orders with approval workflow, blanket orders, reorder rules, auto-receipt from PO, vendor bill creation) · **Project** (projects with Kanban stages, tasks with subtasks/dependencies, milestones, timesheets with auto-sync, profitability tracking) · **Helpdesk** (tickets with SLA tracking, auto-assignment round-robin/least-busy, state machine transitions, SLA breach detection, customer ratings, multi-channel intake) · **Documents** (workspaces with hierarchy, document versioning, access control private/workspace/public, sharing, archive, entity linking, e-signatures with sequential/parallel signing, audit trail, expiry) · **Subscriptions** (recurring billing with MRR tracking, auto-invoice generation, pause/resume/cancel lifecycle) · **Approvals** (configurable multi-step approval workflows, cross-module: PO, leave, expense) · **Planning** (shift scheduling with open shifts, shift templates, appointments with custom questions, auto-confirm, reminders) · **Recruitment** (job positions with publish/close lifecycle, applicant pipeline with stage transitions, hire tracking) · **Appraisals** (employee performance reviews, self/manager evaluation, goal tracking) · **Fleet** (vehicle management with odometer, fuel/service costs, insurance tracking) · **Maintenance** (equipment MTBF/MTTR, corrective/preventive requests, recurring scheduling) · **Knowledge** (articles with versioning, nested hierarchy, access control, sharing, publishing, full-text search) · **Field Service** (on-site tasks with scheduling, parts tracking, labor/parts cost computation, customer/technician signatures, GPS location) · **Advanced MRP** (work centers with capacity/cost, manufacturing routings with ordered steps) · **PLM** (Engineering Change Orders with review/approve/apply workflow) · **POS Restaurant** (floor plans with positioned tables, kitchen display orders with per-line state tracking) · **Trade** (merged warehouse + invoicing: products, warehouses, stock levels, stock movements, inventory counts, price lists, **tag-based pricing**, **bulk pricing**, contacts, invoices, cash sales, proforma, credit notes, payment/cash orders, **contact ledger**, **cross-warehouse transfers**) · Payroll (employees, payroll runs, payslips, timesheets) · HR (departments, leave types/requests/balances, business trips, employee documents) · CRM (leads, deals, pipelines, activities) · ERP (BOM, production orders, construction projects, POS)

### Tag-Based Pricing

Products support custom pricing based on contact tags. Each custom price entry can have:
- **Name** (required), **price**, optional **minQuantity**, **validFrom/validTo**
- **Contact** (specific customer) and/or **Tags** (multiselect contact tags)

**Price resolution chain** (each step overrides previous): base selling price → category price → tag price (lowest match) → **price tier (filtered slot)** → contact custom price → user override.

- **API**: `GET /api/org/:orgId/pricing/resolve?productId=...&contactId=...&quantity=...` returns `{ finalPrice, steps[] }`
- **Service**: `packages/services/src/biz/pricing.service.ts` — `resolvePrice()`
- **UI**: `PriceExplainButton` (info icon on invoice line items) opens dialog showing the full price derivation chain
- **Product form**: Unified "Custom Prices" tab with contact autocomplete + tags multiselect (TagInput)
- **Data model**: **`Product.priceTiers[]`** (canonical since 2026-04-21, 10-slot cap) — each tier `{ name, percent, finalPrice, manualOverride, contactIds?, tags?, minQuantity?, validFrom?, validTo? }`. Tiers with filters participate in resolution; filterless slots are storage-only (used as `price1..price10` columns in goods-receipt flow). **LEGACY**: `Product.tagPrices[]` + `Product.customPrices[]` — still read by `resolvePrice()` for backward compat; UI no longer writes them. Existing records continue to work; new pricing flows through `priceTiers[]`.
- **Tier-name tags convention**: seeded sales tiers carry `tags: [<tier name>]` (e.g. `"Цена 4"`) — tagging a contact with the same name selects that tier via resolution step 4 (legacy per-client price groups). The cost tier (`Доставна цена`) and zero-price slots stay filterless (display-only). Wiring: `scripts/assign-price-group-tags.ts` (tags tiers + derives contact groups from imported invoices; dry-run default). PriceCombobox never overwrites a loaded line's stored historical price (`auto-apply-resolved=false` for `line.loaded`); `listPriceOptions` mirrors `resolvePrice` for its resolvedKey.
- **Product form "Pricing" tab**: 10-row compact tier table. Always-visible columns: Name / % / Final Price. Filter chips (Contact, Tags, Min Qty, Validity) reveal optional columns. Editing `purchasePrice` cascades into all non-overridden tiers; editing a tier's `finalPrice` sets `manualOverride=true` (shown with lock icon).
- **Goods-receipt with product update**: `POST /warehouse/movement/with-update` — atomic via Mongo transaction. Updates product fields (purchasePrice, sellingPrice, priceTiers, type, category, unit) AND creates the stock movement in one session. Requires replica set. On failure, transaction aborts → full rollback, no partial state. Audit-log: one entry per product update + one for the movement, correlated by movement id.
- **Invoice lines**: `priceExplanation: IPriceStep[]` persisted for audit trail (types: `base | category | tag | contact | tier | override`)
- **Backfill**: `bun run scripts/backfill-price-tiers.ts [--execute] [--org slug]` — idempotent, seeds 10 default slots with `percent=0, finalPrice=sellingPrice`, no filters

---

## SUPTO / Bulgarian Fiscal Compliance

LGR implements СУПТО (Софтуер за Управление на Продажбите в Търговски Обект) per **Ordinance Н-18, Appendix 29**. Target deployment: `regal` org (BGN, `bg` locale, `Europe/Sofia`, 20% VAT).

### Fiscal Package (`packages/fiscal/`)

- **`IFiscalPrinter`** interface — abstract over Datecs/Daisy/Tremol/Eltrade/Incotex manufacturers
- **`DatecsFiscalPrinter`** / **`WebSocketFiscalPrinter`** — Datecs over TCP / browser. ⚠ Never proven on hardware:
  its frame is wrong (LEN one short, CMD sent +20h, UTF-8 text) — the correct ISL framing is `isl-frame.ts`
- **Tremol** — own ZFP driver (`tremol.ts` / `ws-tremol-printer.ts`), field-tested on a non-fiscalized M20
- **Eltrade** (`eltrade.ts`, 2026-09-24) — A1/A3/A6/B1/B3 KL ECRs + FP printers. ISL framing (`isl-frame.ts`),
  CP1251 (`cp1251.ts`). Opens fiscal receipts with **90h `<name>,<УНП>`**; card = payment code `L`; a storno
  carries the **original** УНП with positive lines. Fails only on per-command bits (syntax / invalid / not
  allowed / overflow, + no paper for printing commands) — "general error" and the NRA-link bit stay raised on
  healthy devices (ErpNet.FP #166). Serializes commands, primes a random SEQ (a same-SEQ frame is replayed,
  not executed), voids a receipt an interrupted sale left open. Built against
  `tests/helpers/eltrade-simulator.ts` (from the protocol PDF); field-verified 2026-09-26 on a NON-fiscalized A3
  (status, diagnostics, clock, a non-fiscal sale through prod) — fiscal receipts still unproven on hardware.
  Field guide: **`docs/guides/eltrade-fiscal-device.md`**
- **`fiscal-device.service.ts`** — in-memory connection manager (`connect`, `disconnect`, `getPrinter`, `registerPrinter`, `unregisterPrinter`)
- **`fiscal-bridge.ts`** (portal-api/websocket/) — WebSocket endpoint `/ws/fiscal-bridge`, with **two
  kinds of bridge**: a browser tab over Web Serial, and (since FR-14.26) a registered **LGR Desktop**
  relaying its till's own serial port in Rust. ⚠ Elysia wraps each ws event in a NEW `ElysiaWS` —
  per-connection maps are keyed by `ws.raw` (keyed by the wrapper, the close handler never ran).
  Commands may carry `protocol: 'isl'` + `timeoutMs`, which the Web Serial relay (`useFiscalBridge`)
  and the Rust transport both use to frame answers (SEQ-matched, SYN-aware)
  - ⚠ **Registration routes on the SIGNATURE, never on a claim.** The two credentials are signed
    with different secrets (`DESKTOP_TOKEN_SECRET` vs `JWT_SECRET`), so `verifyDesktopToken` is tried
    first and the user path is the fall-through. Reading `aud` out of an unverified payload to decide
    "this is a desktop" would let the caller pick which verifier runs.
  - ⚠ **`BRIDGEABLE_CONNECTION_TYPES` is DISJOINT per kind, and the device LOOKUP filters on it**:
    `user → ['browser']`, `desktop → ['desktop']`. A browser asking for a desktop-bridged device
    never finds the row, so there is no window in which both could hold the port. It is told
    `bridged_by_desktop` rather than "not found".
  - ⚠ **A desktop can never evict.** `BridgePrincipal` is a discriminated union so that is a thing
    the compiler agrees with, not an accident of an empty `permissions` array. Only an admin with
    `admin.settings` and an explicit `takeover: true` evicts, and it is audit-logged.
  - Revoking or rotating a desktop's key calls **`stopDesktopBridges`**, which drops the socket from
    the SERVER side and runs `handleClose` explicitly — a bridge re-reads nothing until it
    reconnects, so revocation must not depend on the till cooperating.
  - The Rust side is `packages/desktop/src-tauri/src/{bridge,framing}.rs`. ⚠ **The transport is
    Rust, never Bun**: Bun + `serialport` on Windows opens the port and writes but never delivers
    received bytes, which made the Eltrade A3 look dead for two days in September. The drivers stay
    on the hub and УНП allocation stays there too — the shell only moves bytes.
- **`bridge.ts`** — standalone serial-to-TCP bridge script for non-browser setups (`bun run packages/fiscal/src/bridge.ts`)
- **`time-sync.service.ts`** — fiscal device clock sync (periodic, default 6h). Device clocks
  are Bulgarian time: format through `zoned-time.ts`, never `getHours()` (the pod is UTC).
  ⚠ **No unverified clock reaches a device** (FR-20.22, AC 58, P1-10). `clock.ts` checks the server
  against HTTPS sources: Cloudflare's trace (ms) and Google's `Date` (1 s), read at the round
  trip's midpoint.
  - A check that reaches none is **unknown, never drift 0**.
  - The sync sets a device only when the clock was verified within 24 h of MONOTONIC time, was off
    by ≤ 2 min, and has not jumped since; and only when the device's own clock (`readDateTime`) would
    move by ≤ 2 min. Anything else is held, with the reason.
  - A person confirms with `POST /fiscal/device/:id/sync-time`. It answers 409
    `clock_unconfirmed` with both times, and sets the clock on `{ confirm: true }` (audit-logged).
  - Until 2026-10-25 the check asked worldtimeapi.org over plain HTTP, and reported 0 on failure.
    That host now resets every connection, so every check "passed", and the sync set every device
    regardless.
- **`vat-groups.ts`** — Н-18 чл. 27(1): **А = 0 %/exempt, Б = 20 %, В = liquid fuels, Г = 9 %** (until 2026-09-24
  this mapped 20 % → А, i.e. booked taxable sales as exempt; unnoticed because the POS printed non-fiscal text)
- POS prices are NET; fiscal devices take VAT-inclusive prices — `fiscalUnitPrice()` in `pos.controller.ts`
- The POS "Non-fiscal" toggle decides: ON = text on a service receipt (for non-fiscalized devices), OFF = real
  fiscal receipt. A print failure returns `receiptError` (the sale is still saved) instead of a silent success.
  The text receipt prints amounts in the **session's** currency (the org's `baseCurrency` printed BGN on a EUR till)
- **POS requests are idempotent** (#155, FR-20.37): session open/close, sale and storno take an
  `Idempotency-Key` header (`ui-shared/composables/idempotency` makes one per attempt and keeps it only
  while the outcome is unknown). The key is stored ON the document (`clientKey` + `requestHash`, unique
  per org): same key + same body → the first outcome, different body → 422, no key → the old behaviour.
  A sale/storno is resumable steps recorded on the transaction (УНП, receipt `fiscal.state`, session
  totals in one Mongo transaction, stock found again by its note), held by a 2-minute lease; duplicates
  wait for the holder. ⚠ **A receipt is never printed twice**: before printing, the device's last document
  number goes on the record (`IFiscalPrinter.getLastReceiptNumber`, Eltrade only); a resumed print
  compares it — same → print, +1 → that was ours, otherwise (or Tremol, which cannot say) `unknown`,
  never reprinted. The УНП is drawn after the row exists, so racing duplicates never draw one.
  The invoicing half takes the same header: `POST /invoices` (a keyed **cash sale** is inserted under
  a `~pending:<key>` number and only the winner draws its CS number — no gaps), `/:id/send` (an atomic
  `issue` claim on the draft — with or without a key two Issue clicks no longer both dispatch and
  number it; a failure releases it) and `/:id/payments` (ONE aggregation-pipeline update appends the
  payment and derives `amountPaid`/`amountDue`/`status`/`paidAt`/history in the database; the key rides
  on `payments[].clientKey`. Read-modify-write lost a payment when two were recorded at once).
- POS totals come from ONE function, `config/pos-totals` → `computePosTotals`. Both the terminal and the
  server's `validateTotals` use it. Gross is rounded once per VAT rate, VAT is taken back out per rate the
  way a fiscal device does it, and the net is what remains, so the printed figures always add up. The
  terminal used to round VAT per line: it asked for 21.48 while the receipt said 21.47 with 0.01 change.
  `changeDue` is never negative, and `session.totalCash` is the cash KEPT (tendered − change).
- Web Serial gives a COM port to ONE tab. A second tab's CONNECT fails with Chrome's NetworkError "Failed to
  open serial port". `useFiscalBridge` maps that to `errorCode: 'port_in_use'`, never status `error`: an
  `error` status marks the device record `error`, and the server then 503s every sale once no bridge holds
  the device. `GET /fiscal/device` returns a live `connected` flag, and the terminal shows "connected in
  another tab" (sales print through the tab that holds it). A POS tab left open reconnects by itself when
  the device is switched on, so a forgotten tab can be the one holding the port
- POS sale / storno stock movements are numbered **latest `SM-<year>-NNNNN` + 1** (retried on a duplicate), like
  every other movement path — never from a `getNextNumber('SM')` counter, which nothing else advances. Until
  2026-09-26 that counter pointed at taken numbers in any org with prior movements: the unique index refused
  every POS movement, the error was only logged, and sales never left stock. A failure now returns `stockError`
- **The two-hour rule (Прил. 29 т. 8, FR-20.49, `fiscal/device-reach.ts`):** in SUPTO production mode a NEW fiscal
  sale answers 409 `fiscal_device_unreached` when none of the warehouse's active devices was reached within 2 h
  AND none answers a status read now. A keyed retry is a sale that already opened and is never refused.
  - `lastCommunicationAt` is kept by every command a device answers (`getPrinter`'s counted view →
    `noteAnswered`, at most one write a minute per device). ⚠ It used to be written only when a bridge
    registered, so a till printing all day read "not reached since 07:00" by 09:00, and the rule would have
    stopped a working shop.
  - ⚠ **`SUPTO_MODE=production` enforced NOTHING before this:** it only logged a banner saying fiscal receipts
    are required. A fiscal sale on a warehouse whose device is not connected still completes without a receipt
    (`getFiscalContext` → null). That is the §2.8 SUPTO-compliance work, not done here. Prod runs `development`.
- TCP transport implemented; serial/USB via bridge script; **browser transport** via Web Serial API (Chrome/Edge 89+)

### SequenceService (`packages/services/src/biz/sequence.service.ts`)

Atomic counter using MongoDB `findOneAndUpdate` with `$inc`. Race-condition safe. Uses Mongoose directly (not DAL).

- `getNextNumber(orgId, prefix, padLength?, year?)` → `"INV-2026-00001"`, `"POS-2026-000001"`
- `generateUNP(orgId, fiscalDeviceNumber, operatorCode)` → `"XXXXXXXX-ZZZZ-0000001"` (Appendix 29 format).
  ⚠ **One counter per fiscal device** (`UNP-<device>`, т. 9), shared by every operator — until #156 it
  was per device AND operator, so two operators issued the same numbers. Migration `0001-unp-per-device`
  seeds it above every number issued; until it has run, a device with old counters REFUSES to allocate
  rather than restart at 1. For one release the old per-operator counters and the new one `$max` each
  other on every allocation, so a binary rollback (and the re-upgrade after it) never repeats a number.
- `getDisplayPrefix(orgId, prefix)` → admin override (year=0 sentinel) or canonical prefix
- `setDisplayPrefix(orgId, prefix, displayPrefix|null)` → org-global prefix override (future allocations only)
- `listSequencesForOrg(orgId)` → all counter rows + overrides, used by the configuration UI

### SUPTO Models

- **FiscalDevice** — `deviceNumber` (8-char), `manufacturer`, `connectionType`/`connectionParams`, `warehouseId`, `status` (online/offline/error), `isActive`/`deactivatedAt`
  - `connectionType` is `serial | tcp | usb | browser | desktop`. **`desktop`** (FR-14.27) means a
    registered LGR Desktop holds the port; `connectionParams` then carries `port`, `baudRate` and an
    optional **`bridgeDesktopId`** that PINS the device to one desktop (unset = any desktop the
    device is assigned to may bridge it). ⚠ Rollback per device is `connectionType` back to
    `browser`.
- **Workstation** — `code`, `name`, `warehouseId`, `fiscalDeviceId`, `isActive`/`deactivatedAt`
- **Sequence** — `orgId` + `prefix` + `year` → `lastNumber` (atomic counter)

### SUPTO Controller Endpoints

- **Fiscal devices**: `GET/POST/PUT/DELETE /api/org/:orgId/fiscal/device` + `/connect`, `/disconnect`, `/status`, `/z-report`, `/sync-time` — restricted to admin/manager/warehouse_manager. Connection types: `tcp`, `serial`, `usb`, `browser`, `desktop`
  - ⚠ **`/connect` REFUSES `browser` and `desktop` with 422**, before attempting anything. Those
    transports are opened by a tab or by a till, never by the server — and the catch path marks the
    device `status: 'error'`, which makes the server 503 every sale once no bridge holds it. An admin
    idly pressing Connect used to take the till out of service.
  - `GET /fiscal/device` returns a live `connected` flag **and `bridgedBy`** (`{kind, label,
    desktopId?}`), read from the live socket map — which is what the POS renders as
    "connected via Till 2".
- **Fiscal bridge WebSocket**: `ws[s]://host/ws/fiscal-bridge` — a browser tab (Web Serial) or a
  registered LGR Desktop (Rust `serialport`) relays commands from the LGR server to a USB fiscal
  printer. Protocol: `fiscal:bridge:register` → `fiscal:command` / `fiscal:response`, with
  `fiscal:bridge:evicted` and `fiscal:bridge:error` codes (`bridge_in_use`, `device_not_assigned`,
  `bridged_by_desktop`, `desktop_revoked`, `key_rotated`). ⚠ An unauthenticated socket is closed
  after 10 s.
- **Workstations**: `GET/POST/PUT/DELETE /api/org/:orgId/fiscal/workstation`
- **SUPTO export**: `GET /api/org/:orgId/supto/export/tables` (list), `GET /supto/export/:tableId?dateFrom=&dateTo=` (XLSX download) — tables 18.1–18.9, restricted to admin/nra_auditor

### NRA Auditor Role

Role `nra_auditor` — read-only access for Bulgarian tax inspectors: `accounting.read`, `trade.read`, `erp.read`, `admin.audit`. Can view all sales data, audit logs, and SUPTO exports. Cannot create/modify/delete.

### Soft-Delete Pattern

Nomenclature models use `isActive: boolean` + `deactivatedAt?: Date` instead of hard-delete. DELETE endpoints set `isActive: false` + `deactivatedAt: new Date()`. Applies to: Product, Contact, Warehouse, PriceList, ProductCategory, User, FiscalDevice, Workstation, Equipment, Vehicle, Employee, JobPosition.

### User Model Extensions (SUPTO)

- `middleName` — Bulgarian three-part names (from identity document)
- `operatorCode` — 4-digit fiscal operator code (unique per org, atomic assignment, included in JWT)
- `position` — job title
- `roleHistory[]` — `{ role, startDate, endDate, assignedBy, assignedAt }` for audit trail

### Startup & Shutdown

- **Startup**: Reset stale fiscal device statuses to `offline`, NTP time verification, schedule periodic time sync
- **Schedulers start independently** (FR-20.23): `unified.ts` hands them to
  `services/scheduler/registry.ts#startSchedulers`, each in its own `try`, each tick caught, each with a
  health record (`schedulerHealth()`). ⚠ They used to share one `try { } catch { }`, so a failed NTP check
  at boot silently left backup, digest and retention unstarted. A new scheduler goes in that list.
- **Background tasks have an owner** (`services/background/task-owner.ts`): `{process, pod, heartbeatAt}`,
  refreshed every 30 s by the process running them. Any process fails open tasks whose owner went
  quiet for 2 minutes (or, for tasks recorded before owners, started over an hour ago) — never every
  `processing` task at boot, which would fail the tasks of the pods still running.
- **Shutdown**: SIGTERM/SIGINT → disconnect all fiscal devices via `disconnectAll()`

### NRA Documentation

`docs/supto/` contains: functional description (Bulgarian), database schema (Bulgarian), 42-point compliance checklist, NRA submission guide.

---

## Planned: Future Work

### Cross-Module Event Bus (implemented)

In-process typed event bus at `packages/services/src/events/event-bus.ts`. Handlers registered at startup in `unified.ts` via `registerEventHandlers()`.

**Active event flows** (the actual `DomainEvent` union): `invoice.posted` → Accounting `JournalEntry`; `payment.recorded` → payment `JournalEntry`; `stock.movement.confirmed` → valuation `JournalEntry`; `pos.session.closed` → batch dispatch + `JournalEntry`.

**Planned event flows (not yet implemented):** `sales.order.confirmed` / `purchase.order.confirmed` / `approval.*` / `production.completed`. Order↔reservation sync is deliberately NOT event-driven — it's direct `syncOrderForInvoice` calls from the invoice controller.

### State Machine Mixin (implemented, unused)

Reusable state machine at `packages/services/src/mixins/state-machine.ts` — working but has zero instantiations (ORDO/ORDI transitions are hand-rolled in their controllers). There is no `packages/sales-api` SalesOrder module; the shipped order documents are the invoicing ORDO/ORDI pair above.

### Independent Deployment (not yet implemented)

The architecture supports splitting the unified API into independently deployable services per domain if needed for scaling. Each domain API package can already run standalone on its own port (legacy mode). The planned approach would use a reverse proxy to route `/api/org/:orgId/{module}/*` to the appropriate service.

---

## Deployment Workflow

The whole pipeline is scripted — see the **`deploy-prod` skill** (`.claude/skills/deploy-prod/`)
for the full runbook (backgrounded remote invocation, rollback, gotchas).

```bash
# 1. Code commit (the build host deploys what's on origin/master)
git push origin master

# 2. Build → push → gitops bump → ArgoCD → rollout wait → smoke check, on master-node
ssh -o IdentitiesOnly=yes -i ~/.ssh/id_ed25519 mars   # the `mars` ssh-config key needs a passphrase
cd ~/lgr && git pull --ff-only origin master && ./scripts/deploy-prod.sh
#   --ocr / --ocr-only   also (or only) rebuild the lgr-ocr sidecar image
#   --tag <existing>     no build: redeploy or roll back to a tag already in the registry
#   --dry-run            print every mutating step, run none
```

Manual equivalent of step 2 (prune → build → tag → push → bump → sync) is in the skill.
⚠ The prod overlay lists **two** images (`lgr` and `registry.roomler.ai/lgr-ocr`), each with
its own `newTag`: a blanket `sed -i "s|newTag:.*|...|"` clobbers both and breaks the OCR
sidecar. Bump the `newTag` line inside the matching `- name:` block only, and verify both
lines still match `newTag: v[0-9]{8}-[0-9a-f]{12}$` before committing.

### Disk hygiene: max 2 image tags retained locally

The lgr image is ~7.5 GB; previous builds accumulated to 50+ GB and once exhausted disk on the build host (mid-push), leaving the registry with a partial image. **Always run `./scripts/prune-docker-tags.sh --apply` before building.** It keeps the two most-recently-created versioned tags (current + previous for rollback), drops everything else (`build-*`, older `vYYYYMMDD-*`, `final`/`p2-p3`/named scratch tags), and runs `docker image prune -f` + `docker builder prune -af` for the dangling layers and build cache. Dry-run by default; pass `--apply` to actually untag.

Note: First request after pod restart has ~6s cold start (Bun JIT + Mongoose compilation). Subsequent requests are ~70ms.

## Last Health Check

Date: 2026-04-29
Result: PASSED
Summary: All 6 UIs build green. Phases shipped 2026-04-29: single-line `StatusMultiselect` shared component renders one summary chip ("All statuses" or "{N} selected") across all 6 invoicing list views; `useProductUnits` composable extracted to ui-shared (UOM_CODES + uomOptions) and consumed by ProductFormView + invoice line items; all 6 invoice forms get Unit v-autocomplete (DDL) column when active in column-picker, default `[emptyLine()]` on create, auto-add empty row when product picked on the last line, and a `filledLines` computed that filters productId-less rows out of subtotal/taxTotal/total + payload; ExportDialog accepts optional `title` + `icon` props; per-form view buttons render as **Print** / `mdi-printer` while list-view export stays as Export / `mdi-download`; Org schema gains `addresses[]` + `bankDetails[]` + `taxNumber/vatNumber/email/phone/website`, exposed via `/auth/me`, editable in Settings → Organization (3 new cards: Company Identity / Addresses / Bank Details); `OrgPartyBlock.vue` + `BankInfoRow.vue` rendered on all 6 invoice forms; credit/debit notes get `dueDate` (default + 30d) + `paymentMethod`; purchase invoice gets `paymentMethod`. Strict 4-col responsive grid restructure of forms deferred to a follow-up. Earlier 2026-04-28 phases shipped: Cyrillic-safe search via lowered mirror fields, DAL pagination "All" support, invoicing menu reorg, ProductPickerDialog wide modal, ContactFormView compact density, leave-confirm dialog, right-panel auto-collapse, Draft+Issued sequences with per-type DRAFT_* counters and posted-JE edit guard.

## Line Items Column Picker + Status Translatability (2026-04-28; defaults reworked 2026-07-26)

`ui-shared/composables/useInvoiceLineColumns(docType, { userId, orgId })` exposes 9-column catalog (description anchor, qty, unit, unitPrice, discount, **lineSubtotal** = qty×unitPrice net, taxRate, warehouse, lineTotal); per-doc-type localStorage key `lgr:invoice-line-cols:<userId>:<orgId>:<docType>` (falls back to the legacy `anon` key); Discount `defaultOn:false`; `discount` only on `invoice` + `proforma`. **Since 2026-07-26**: `lineSubtotal` defaultOn, `taxRate`/`warehouse`/`lineTotal` default OFF — the form shows doc-level single-value controls instead (TaxRateCombobox + WH autocomplete above the table, apply-to-all + seed for new lines; WH pin button persists a per-user default at `lgr:default-wh:<userId>:<orgId>`, init priority: loaded uniform → user default → org isDefault). Totals card shows "Tax Total (X%)" (`invoicing.taxTotalWithRate`) when all filled lines share one rate. Contact pickers in all 6 forms search server-side (debounced `search` + `size:20`; `contact.controller` `type` filter is `$in [type,'both']` so both-typed contacts appear as customer AND supplier). `LineColumnPickerDialog.vue` renders the checkbox grid with Select all / Clear / Reset Defaults. Cog button next to "+ Add line" on all 6 invoice form views drives `activeColumns` for thead/tbody. `usePaymentMethods()` in ui-shared returns translated `[{ value, text }]` from `pos.cash/card/bankTransfer/check`; v-selects use `item-title="text" item-value="value" persistent-placeholder` so labels render and placeholder stays visible. `StatusChip.vue` translates via `invoicing.status.<status>` with `te()` fallback to raw string. Status filter dropdowns (Sales/Purchase/Proforma/CreditNotes/DebitNotes/PaymentOrders) and kanban column titles migrated from raw string arrays / `statusDraft`-style flat keys to nested `invoicing.status.draft|sent|received|partially_paid|paid|overdue|voided|cancelled|completed|converted|issued|applied|approved|executed|accepted|expired` (16 keys × 4 locales).

## Cyrillic-Safe Search (2026-04-28)

`packages/db/src/plugins/lowered-fields.plugin.ts` maintains `*Lower` mirror fields via Mongoose pre-save / pre-insertMany / pre-(findOneAndUpdate|updateOne|updateMany) hooks (locale='bg'). `buildSearchFilter(search, fields, { lowered: { name: 'nameLower', ... } })` lowercases the keyword and queries the mirrors without `$options:'i'`. Backfill: `bun run scripts/backfill-search-lowercase.ts --execute`. Models with mirrors: Product (name/sku/barcode/description/category), Contact (companyName/firstName/lastName/email/taxId/vatNumber), Warehouse (name/code), ProductCategory (name/description).

## Draft+Issued Invoice Numbering (2026-04-28)

Drafts use per-type DRAFT_* counters (DRAFT_INV/PRF/CN/DN/BILL); cash sales skip drafts (CS direct). On `/send` or `/receive`, the controller allocates a new issued number from the canonical SALES_DOC/PROFORMA/BILL counter, sets `draftNumber = previousInvoiceNumber`, replaces `invoiceNumber`, and appends to `numberHistory[]`. Display prefix override (per-org-global) lives on the Sequence year=0 sentinel doc; future allocations only. **Documents are editable in EVERY status** — PUT applies no status or posting check. The edit-sent guard (409 when a posted JournalEntry referenced the invoice, with credit-note remediation) was **removed**; ⚠ an edit to a posted document does NOT re-post, so the JournalEntry keeps its pre-edit amounts and trial balance / P&L / balance sheet report the stale figures with nothing marking them so — repost is manual. DELETE keeps its draft-only guard. Configuration page at `/invoicing/configuration/sequences` (admin/manager only).

## Generic grid column picker + price-select + Словом + perf (2026-07-26)

- **Per-user grid columns** (visibility + reorder) on EVERY `ListScaffold` grid: `ui-shared/composables/useGridColumns.ts` (localStorage `lgr:grid-cols:<userId>:<orgId>:<gridId>`, gridId = route name) + `GridColumnPickerDialog.vue`; a cog in the results header opens it. userId read from the JWT in localStorage (no app-store coupling). Grids NOT on ListScaffold (e.g. `ProductsView`) don't get it yet.
- **Price-select icon** (`ui-shared/PriceSelectButton.vue`) left of every invoice-line Unit Price: lists selling + all named tiers via `GET /pricing/options?...&all=true` (new `all` mode in `listPriceOptions` offers filterless Цена slots too); `onLinePriceSelected` sets price + base→chosen explanation.
- **Amount-in-words (Словом)**: `ui-shared/composables/useAmountInWords.ts` (`amountInWords` / `upsertAmountInWords`) — deterministic en/bg/de/mk converter, client-side, written into notes on save of every OUTGOING doc (gated `config.direction === 'outgoing'` in `useDocumentForm.buildPayload`) + orders, in the user's UI language, de-duped on re-save. Legacy format: `Словом : … евро и NN цента, Данъчна основа X.XX €`. Unit-tested (`amount-in-words.test.ts`).
- **Bottom Save/Print bar** on all doc forms (`DocumentForm.vue`) + order form.
- **billingAddress fully optional** (model `addressSchema` + all POST/PUT body schemas) — saving without postal code no longer 500s.
- **Perf**: dashboard `/summary` stock uses `getStockValuationTotals` ($group aggregation, ~25ms) not the 23k-doc materialisation (~1.6s). **CoreDNS upstream** was switched from the cluster dnsmasq forwarder (~6s first external lookup → slow OAuth/Google) to public resolvers (8.8.8.8/1.1.1.1) — cluster-infra change, lives in kube-system configmap `coredns` (backup on master-node `/tmp/coredns-backup-*.yaml`); belongs in k8s-cluster-multi long-term.
- Invoice POST/PUT accept `orderId`/`orderGroupId` (API clients can link bills to orders).

## Orders: ORDO (external) + ORDI (internal) + RES reservations (2026-07-26; split 2026-08-15)

Three linked invoicing document families (none is an Invoice `type`):

```
ORDI (InternalOrder, client demand)          ORDO (Order, supplier supply)
  lines[{product, qty, deadline}]              supplierGroups→lines→allocations
        ▲                                            ▲
        └────────── RES (Reservation) ───────────────┘
          source: 'stock' (free WH stock) | 'order' (ORDO allocation)
                        │ orderRef.reservationId on invoice lines
          conversion sales invoice → dispatch → delivered
```

- **ORDO** (`packages/db/src/models/order.model.ts`, model name `Order`): supplier groups → lines (product, qty, expectedUnitPrice) → warehouse **allocations**. Counter keys `ORDER`/`DRAFT_ORD` **unchanged** across the ORD→ORDO rename — numbering continues, display prefixes now `ORDO`/`DRF-ORDO` (historic ORD- numbers untouched; migration copies any legacy year-0 `ORD`/`DRF-ORD` display sentinel onto the counter keys). Status: draft → sent → partially_received → received → completed/cancelled. Embedded `reservations[]` subdocs are DEPRECATED (read only by the migration; strip phase empties them).
- **ORDI** (`internal-order.model.ts`, `InternalOrder`): client order for future delivery — `contactId`, `requestedDeliveryDate` (drives priority; rank = urgent>high>normal>low, then earliest deadline, then createdAt; no-ORDI reservations rank last), optional preferred `warehouseId`, flat lines `{productId (req), quantity, expectedUnitPrice?}` + derived per-line `reservedQuantity/invoicedQuantity/deliveredQuantity`. Sequences `INTERNAL_ORDER`/`ORDI` + `DRAFT_ORDI`/`DRF-ORDI`. Status: draft → confirmed (number issued) → partially_delivered → delivered (derived from dispatch) → completed (manual, releases open RES) / cancelled (draft/confirmed only, cascades RES).
- **RES** (`reservation.model.ts`, `Reservation`): numbered hold (`RESERVATION`/`RES`, direct issue) linking demand (contactId, optional internalOrderId/LineId) to supply (`source: 'stock' | 'order'` + warehouseId; order-source carries orderId/groupId/lineId/allocationId). Derived `invoicedQuantity/dispatchedQuantity/invoiceIds` from LIVE outgoing type-'invoice' docs only (converted proformas/bills never count). Status active ↔ fulfilled (auto), cancelled terminal with `cancelReason: manual|preempted|internal_order_cancelled|external_order_cancelled|released` + `preemptedBy`. Holds: stock-source = `qty − dispatched` while active (availability-validated at create); order-source = old formula `min(Σ(qty−dispatched), received−Σdispatched)` per allocation, only while the ORDO is sent/partially_received/received (draft-ORDO RES records intent, holds nothing). Reopen rule: a void only reactivates a fulfilled RES if its ORDI is still live — closed demand shrinks instead (no zombie holds).
- **Sync engine** (`services/biz/reservation.service.ts`): decomposed into `recomputeOrderReceipts` / `recomputeReservations` / `recomputeInternalOrder` / `syncReservedQuantities` (now reads the Reservation collection). Public entry points kept: `syncOrderDerivedState(orgId, orderId)` and `syncOrderForInvoice(orgId, invoice)` — the latter walks doc `orderId`/`internalOrderId` AND line `orderRef.{orderId,internalOrderId,reservationId}` (mixed-source conversion invoices may have no doc orderId). Invoice hooks: POST create (after the cash-sale rollback block), PUT, DELETE, send, receive, void, proforma-convert, bill-import convert. `applyReservationCancel`/`reservationReleasable` implement release semantics (fully-open cancel keeps quantity for audit; partially-consumed shrinks to consumed).
- **Ops layer** (`services/biz/reservation-ops.service.ts`, throws `ReservationOpsError{statusCode}`): `createReservation` (validates availability / allocation capacity / ORDI line open demand / contact match), `cancelReservation {quantity?}` (releasable = qty − max(invoiced, dispatched)), `preemptReservation` (Mongo txn, releasable re-checked on the session read → concurrent preempts serialize, loser gets 422; beneficiary RES inherits the supply source), `reserveAvailableForInternalOrder` (one-click stock cover, preferred-WH first), `getInternalOrderSuggestions` (per short line: freeStock / unreserved incoming (+`late` vs deadline) / preemptable ranked most-deferrable first with equal/higher-priority demand excluded, caps 20 + totals, supplierHint from the latest ORDO carrying the product), `completeInternalOrder`, `cancelInternalOrder`, `generateExternalOrder` (txn: new/append-to draft ORDO grouped by supplier + order-source RES per line).
- **Availability precision** (`invoicing.service.ts` + `stock-transfer.service.ts`): reservation-backed lines are exempt via a per-RES **budget per validation call** (`loadReservationBudgets`: open = qty − dispatched, shared across the doc's lines — N lines on one RES can't each claim the full hold; excess competes for free stock). `checkCrossWarehouseAvailability` + `/stock-availability/check` accept per-line `reservationId` (both UI callers send it). Invoice POST/PUT guard `validateReservationLineRefs`: only outgoing sales invoices may reference reservations (bills/cash sales/notes → 422) and Σ live invoiced per RES ≤ RES.quantity (422 with remainder).
- **Controllers**: `order.controller.ts` — CRUD + `/send` `/cancel` (live-invoice check spans doc orderId + line orderRef.orderId + RES invoiceIds; cascades RES with `external_order_cancelled`, returns `affectedInternalOrders`) `/complete` (releases open RES remainders) `/release` (legacy alias → RES cancel) `/convert {contactId}` (over RES docs via shared `lib/reservation-convert.ts` builder) `/peek-next` `/export` (internal sheet reads `ctx.reservations` grouped by allocationId); PUT guards allocations against Σ non-cancelled RES (409). `internal-order.controller.ts` — CRUD + `/confirm` `/complete` `/cancel` `/convert` (ALL open RES → one draft invoice, doc `internalOrderId`, per-line full orderRef incl. `orderId`) `/reserve-available` `/suggestions` `/generate-external` `/peek-next`; PUT guards lines vs Σ RES/delivered. `reservation.controller.ts` — list (enriched names + computed late/shortage flags) + create/cancel/preempt. All mounted in `unified.ts`.
- **Invoice model**: doc `orderId`/`orderGroupId`/`internalOrderId`; per-line `orderRef {orderId?,groupId?,lineId?,allocationId?,reservationId?,internalOrderId?,internalOrderLineId?}` (all-optional) + `sourceText`; indexes on `{orgId,orderId}`, `{orgId,internalOrderId}`, `{orgId,'lines.orderRef.reservationId'}`. The form round-trips orderRef verbatim (document-payload).
- **Migration**: `scripts/migrate-order-reservations.ts` — preflight (embedded `_id` uniqueness, loud failure; display-sentinel copy) → `--execute` UPSERT (RES doc per embedded subdoc, **preserving the subdoc `_id`** so historic `orderRef.reservationId` resolve; closed orders normalise qty to max(invoiced, dispatched); qty-0 `/release` leftovers → cancelled('released'); re-runs refresh counters) → deploy → `--strip` (re-upserts, verifies per-(product,WH) hold parity, empties embedded arrays, re-materialises StockLevels). Zero hold-loss sequence: execute → deploy → strip.
- **ORDO-aware purchase import**: unchanged mechanics — `POST /bills/import/draft` accepts `orderId`; ladder alias → exact → AI-vs-order-candidates; bills carry `orderRef {groupId,lineId,allocationId}` (NEVER reservationId — 422). Skill `.claude/skills/import-purchase-invoices/` + `scripts/import-purchase-invoices.ts` are prefix-agnostic (resolve by number search). **Ops:** ORDO-received deliveries must not ALSO be booked by the daily `receive-stock` import.
- **UI**: nav group "Orders" → Internal Orders (`/internal-orders`, InternalOrdersView + InternalOrderFormView with coverage chips, Reserve-from-stock, Cover-shortages dialog (free stock / incoming / preempt with confirm), Generate-external dialog with supplier hints), External Orders (`/orders` — paths/route names unchanged for e2e; OrderFormView: allocation editor + read-only RES panel + per-allocation Reserve-for-client dialog; convert dialog fed by linked RES), Reservations (`/reservations`, ReservationsView with source/late/shortage indicators + cancel). Sequences page groups: order/internal_order/reservation. i18n ×4 (en/bg/de/mk): nav keys, `invoicing.status.{confirmed,partially_delivered,delivered,active,fulfilled}`, priority/coverage/preempt blocks.
- **Tests**: `order-reservations.flow` (7-case behavioral contract over RES docs), `order-import.flow`, `order-sheet-export`, `reservation-migration.flow` (preserved ids, upsert refresh, hold parity, strip), `internal-order.flow` (budgeted exemption incl. N-lines-one-RES, delivered statuses, void-after-complete no zombie hold, cascades), `reservation-preempt.flow` (partial/concurrent preempt, suggestions ranking, generate-external rollback, cross-WH exemption).

## Flat 7-tab Product Route (2026-04-21)

Routes: `/inventory/products/:id/:tab` where `tab ∈ {edit|pricing|settings|stock|ledger|movements|levels}`. `/products/:id` redirects to `/edit`, `/products/new` to `/new/edit`. Shared `ProductTabBar.vue` component at top of both ProductFormView and ProductStockView navigates between siblings via named routes (works in both inventory-ui and desktop-ui). `new` mode disables stock/ledger/movements/levels tabs with "save first" tooltip.

## Reporting → Export (2026-04-21)

New `POST /api/org/:orgId/invoicing/export/kind/:kind` endpoint with `kind ∈ {outgoing, incoming, cash_register}`.
- **outgoing** = invoice + credit_note + debit_note, direction=outgoing (shared SALES_DOC numbering)
- **incoming** = bills (type=invoice, direction=incoming)
- **cash_register** = cash_sale (separate numbering)

Empty result set → 200 with header-only workbook (not 404). UI at `/invoicing/reporting/export` — 3 cards with date range + Excel/PDF + column picker (reuses `ExportDialog`).

## Invoicing Sidebar (2026-04-21)

Top menu reorganized into 5 workflow-based groups:
- **Outgoing Documents** (file-export icon): Sales Invoices, Proforma, Credit Notes, Debit Notes (all share SALES_DOC numbering)
- **Incoming Documents** (file-import icon): Bills
- **Cash Register** (cash-register icon): Cash Sales (separate numbering)
- **Payments**: Payment Orders, Cash Orders
- **Contacts**: Contacts, Invoice Aging

Debit Notes moved from Vendors group (outgoing-direction) to Outgoing Documents. i18n keys `nav.outgoingDocs`, `nav.incomingDocs`, `nav.cashRegister` added across en/bg/de/mk.

## Document Import (2026-08-21)

The standalone `/invoicing/bills/import` wizard is **gone** (route now redirects to `/bills`;
nav entry + `PAGE_REGISTRY` row + `bills.batchImport.*` i18n removed). Importing lives on the
list and detail pages of every surface that accepts documents:

- **List page → batch.** Import button next to Export on `SalesInvoicesView`,
  `PurchaseInvoicesView`, `CashSalesView` (all `ListScaffold #actions`) and `MovementsView`
  (hand-placed — that view predates `ListScaffold`).
- **Detail page → single.** An Import `FormAction` + bottom-bar button on `DocumentForm`
  (all six invoicing types) and `MovementFormView`. Visibility mirrors Save exactly. **No
  `DRF-` draft is created** — the user reviews a field-by-field diff and the accepted subset
  is merged into the open form, which they then save.

**Engine** — `packages/services/src/biz/doc-import/`:
`types` · `detect` (doc kind + direction) · `matching` (alias → exact → whitespace-tolerant →
AI-vs-candidates; batched `$in` queries, one regex per leftover) · `parse-text` (deterministic
raw-text fields) · `xlsx` (salesAnalysis / storeOperations parsers + sniffer) ·
`map-invoice` / `map-cash-sale` / `map-movement` (**mapping only, no writes**) ·
`dedupe` · `analyze` · `commit` · `persist` / `persist-movement` · `ocr-client`.
`invoicing-api/src/lib/bill-import.ts` is now a re-export shim.

**API** — `/org/:orgId/doc-import/`: `POST /extract` (multipart, PDF→sidecar or XLSX→parser,
`forceOcr`, 4-way concurrency, per-file timeouts) · `POST /analyze` → job (**persists
nothing**) · `GET /task/:taskId` (falls back to the `BackgroundTask` row when the in-memory
`taskStore` is gone) · `POST /commit` → job · `POST /convert`. Permission-gated
(`invoicing.write` / `inventory.write`). **`/bills/import/{extract,draft,convert}` stays
mounted and byte-compatible** — the five migration CLI skills drive it against the deployed API.

**Movements** — kind → type/side/sign: stokrazp `receipt`/to/+ · `2000 КОРЕКЦИЯ` splits into
`receipt`(+) + `adjustment`(−) so the sign rides on the type · sklrazp `transfer`/from/−
(destination untracked) · sklisk `adjustment`/from/− · storeOperations XLSX **`Операция: Доставки`
only** → `receipt`/to/+.

⚠ **`store_operations` is the one docType that does not determine its own target** (2026-10-02).
„Складови операции" is a GENERIC report and its `Операция:` filter decides the meaning — and both
variants are live: `Доставки` (Тип на док. СТ) is a delivery, stock IN, a movement; **`Продажби`
(СР) is a day of till takings, stock OUT, a CASH SALE** — the same business document as a
`salesAnalysis` export in a different layout (`Име/Мярка/Количество/Цена/Стойност` vs
`Артикул/Количество/Стойност`). regal-pz sent three `Доставки` files in July; regal-sf exports its
register this way daily. So `targetForDocType` is refined by `targetForItem(declared, item)` AFTER
the sheet is parsed (`StoreOperationsResult.books`), the analyzed target is persisted and preferred
over the docType on read-back, and `typeOrder` sorts the export with the receipts or the sales
documents accordingly. `mapCashSaleExport` serves **both** layouts (its parameter asks for
`{rows}`, not a whole result) and the reference stays **`salesAnalysis:<date>`** whichever file
produced it — the key names the DAY, so a day arriving in both formats collides instead of double
booking, and the guard on every already-booked cash sale keeps working. An operation that is
neither is refused, not guessed: read as receipts a sales day invents stock, read as sales a
delivery dispatches stock that just arrived.

⚠ **A till sale can ALSO be invoiced, and then the invoice must not dispatch** (2026-10-02). A
counter shop rings the sale on the till and prints a фактура when asked, so the day's till export
already carries it — booking the invoice's dispatch too takes the same goods out twice. regal-sf's
first day had 3 of 46 invoices like this (17 lines, two products driven negative); regal-pz had
0 of 44. **PlusMinus is the arbiter, not the documents**: `snapshot − LGR == invoice quantity` on
every affected line means it deducted once, so the till is the stock-mover. Repair = reverse via
`reverseInvoiceStockMovement` (restores the WAC layers, unlike a hand-rolled compensating entry)
then set `stockSource.marker`, which is what `movesNoStock` reads to stop a re-dispatch.
`doc-import/till-overlap.ts` detects the containment at analyze time and **only warns** — the
message carries "VERIFY before committing", which is the `BLOCKING` pattern the Files review uses.
It must never suppress: containment is not proof (the till may simply have sold as much of every
article independently), the only reliable arbiter arrives with the next snapshot, and the errors
are asymmetric — a missed overlap shows up in tomorrow's reconciliation, a false hit silently
leaves stock in LGR that is no longer on the shelf and nothing catches it. It runs as a second pass
over the batch, because a day is uploaded whole and the till export's own mapping does not exist
until every document in the batch has been analyzed.
**Costing rule:** existing product → `unitCost = current avgCost` (confirm-time WAC recompute
is a no-op); new product → разписка `Цена` opens its avgCost.
**Pricing rule (2026-08-29):** a разписка prices what we SELL. `Цена` → `sellingPrice`;
`Цена N` → the tier named `Цена N`, and only the N the document carries. `purchasePrice` and the
cost tiers (`Доставна цена`, `Цена на едро`, `Цена 0` — `PROTECTED_TIERS`) are **never written**
by an import; they belong to the storeAvailability re-baseline. A NEW product is the exception —
nothing to protect, so `Цена` still opens its `purchasePrice`/avgCost. Two traps this closed:
the staged `priceTiers` array REPLACED the product's on commit and was built from a blank slate
(wiping every slot the document didn't carry — it now merges by name from the product's current
tiers), and `persistMovement` strips `purchasePrice` from any staged payload so a pre-rule
analysis can't reintroduce the old write.
**Idempotency** lives in `notes` (`stokrazp:` / `corr:` / `sklrazp:` / `sklisk:` /
`storeOperations:`) — the markers `check-doc-sequences` verifies. `StockMovement.reference`
carries the same document as a real field (`sklrazp_0000012698`), shown in the product ledger
after Invoice and searchable in the movements list; backfill via
`scripts/backfill-movement-reference.ts` (marker → DocFile → `INV-<10 digits>`, 772/813 on
regal-pz; the rest are genuinely document-less). Unmatched lines can't be booked, so the review step offers
inline product creation (SKU sequence continued, `buildTiers`/`repriceTiers` with tier-name
tags; new products land in „Общи" → re-run `assign-din-tags`).

**OCR sidecar** — `POST /draft` gained `profile` (`invoice` | `goods_receipt` | `stock_note`),
auto-detected from the header when omitted and echoed back in the response. Two new skills:
`draft-goods-receipt` (Кол / Цена / Цена 1..N columns + the КОРЕКЦИЯ signed variant) and
`draft-stock-note`. `validateExtraction(ext, profile)` is kind-aware — stock notes get
number/date/quantity checks instead of the VAT/totals ones. ⚠ The sidecar image must be
rebuilt for the new skills: `./scripts/deploy-prod.sh --ocr`.

**Prefixes are never hardcoded.** `services/biz/sequence-registry.ts` is the single table
behind `/invoicing/configuration/sequences` AND every allocation path
(`invoice-numbering.service`, order / internal-order / reservation / companion numbering).
`resolveDocPrefix(orgId, type, direction, variant)` returns the org's configured prefix;
`dedupe.ts` builds its "already imported?" patterns from it rather than from a literal `INV`.

**Fixed along the way:** the bill form's required "Supplier Invoice #" bound to
`supplierInvoiceNumber`, which the model and controller schema don't have — it now also
emits `reference` (where it actually persists, and what the Bills list renders) · movement
type `shipment` → `dispatch` (the backend enum) and `completed` added to the status filter ·
`priceTiers` truncated to 10 in the GR paths while the model allows 13 (`MAX_PRICE_TIERS`).

**Tests:** `packages/tests/src/integration/doc-import.flow.test.ts` (23),
`unit/doc-import-xlsx.test.ts` (8), `e2e/tests/doc-import.spec.ts` +
`e2e/scripts/ocr-stub.ts` (a `Bun.serve` stand-in so E2E needs no Claude token).

⚠ **E2E gotchas** (both cost real time to find):
1. Playwright spawns its workers with `process.execPath`. Under `bunx` on a machine with no
   **Node** on PATH, every worker dies with `code=143` before the browser launches — for
   every spec in the package, not just the new one. Install Node, or run E2E on CI/mars.
2. A **spec** file cannot `import type` from `@playwright/test` under this setup (the build
   fails with an opaque `BuildMessage {}`); a **helper** module can. That is why no spec in
   this repo type-imports, and why the doc-import helpers live in `tests/helpers/doc-import.ts`.
3. **Vuetify `v-switch` has role `checkbox`, not `switch`** — it renders a plain
   `<input type="checkbox">` carrying an `aria-label`. `getByRole('switch')` matches nothing;
   use `getByLabel(/…/i)`. Same family as the v-select/combobox gotcha above.
4. **Ad-hoc Playwright scripts must run under `node`, not `bun`** — `chromium.launch()` under
   Bun hangs until the 180s launch timeout. The `bunx playwright test` runner is fine (it
   spawns its workers with `process.execPath` → Node); only direct driver use in a Bun script
   breaks.
5. The default `workers: 4` can overwhelm a dev laptop: a whole spec file failed with blank
   pages that all passed at `--workers=1`. Re-run serially before believing a mass failure.
6. **A v-select cannot be opened by clicking the combobox you found it with.**
   `getByRole('combobox', {name}).click()` resolves the real `<input>`, which is painted under
   its own `.v-field__input` wrapper — the click times out with "intercepts pointer events",
   naming the interceptor rather than the cause, so it reads like a flake. Find by role, click
   the wrapper: `tests/helpers/vuetify.ts#openSelect`. Its options live in a detached overlay
   at the end of `<body>` (never inside the card you scoped to) and a `multiple` select stays
   open after a choice — `chooseOption` handles both. And assert a select's value with
   `toHaveValue`, never `toHaveText`: an `<input>`'s text content is always `""`, so a
   `toHaveText` assertion passes against every value.

## DIN/ISO Fastener Catalog + Product Tagging (2026-08-03)

Global reference collection **`din_catalog`** (model `DinCatalog`, no tenantPlugin — like ExchangeRate; explicit collection name) holds 165 DIN↔ISO/EN rows in 12 Bulgarian categories from the „DIN ↔ ISO/EN разширен каталог крепежни елементи" DOCX; data committed at `scripts/data/din-catalog.json`. `scripts/seed-din-catalog.ts` upserts it and (with `--org`) creates the 12 `ProductCategory` docs. `scripts/assign-din-tags.ts` derives **product tags from NAMES** — `DIN 933` (+whitelisted variants 7504-K/M/N/O/P/R, 125-A/B, 7380-1/2, 976-1; junk-proof against "- K 8.8" class markers), catalog cross-tags (`DIN 933`→`ISO 4017`, `EN 14399-4`→`DIN 6914`), canonical Cyrillic dimensions (`М8Х25`/`Ф90Х529`/`6Х70`, pipe fractions `1/2Х3/8` excluded), coating/material/strength (`ZN`/`BL`/`HDG`/`YELLOW ZINC`/`A2`/`A4`/`МЕСИНГ`/`6.8|8.8|10.9|12.9`) — via `$addToSet` + Tag vocabulary upserts, and **recategorizes** catalog-DIN products (first DIN wins; only out of „Общи"/the 12 unless `--force-category`; sets category+categoryId+categoryLower explicitly since bulkWrite bypasses loweredFieldsPlugin). Extraction: `packages/services/src/biz/fastener-tags.utils.ts` (import-pure; tests `packages/tests/src/unit/fastener-tags.test.ts`). ProductsView category filter now loads from `/warehouse/product-category` (was: derived from first page of products). Ops: re-run assign-din-tags after `receive-new-products`; after `seed-products --clean` re-run BOTH scripts (clean wipes tags+categories). Skill: `.claude/skills/assign-din-tags/`. ⚠ Bun transpiles Cyrillic regex literals to `\uXXXX` — never send them to Mongo as `$regex` (PCRE2 error 51091); query tags by equality.

## Reports app module — FR-06 / #14 P1 (2026-08-25)

Sixth app `reports` (`/reports/`, dev port **4101**, `mdi-file-chart`, `#8e24aa`) whose home is
a **card grid like the portal App Hub — no top menu bar** (`DefaultLayout` deliberately omits
the `#menu-bar` slot). Gated on **`invoicing.read`**, not a new `reports.read`: that is exactly
today's audience (admin/manager/accountant/member/**nra_auditor**; not warehouse_manager) and
needs no PermissionSet backfill nor a re-login for issued JWTs. Dedicated `reports.*` is
deferred to P2 with the SUPTO UI. `OrgApp` rows lazy-create on the first `GET /org/:id/apps`,
so no enablement migration exists or is needed.

**The registry is the extension point.** `services/biz/report-registry.ts` (SERVER-ONLY —
handlers touch Mongo; a UI import would bundle mongoose) holds the entries + handlers;
`report-registry.types.ts` is import-pure and holds the types **plus** the gate
(`canAccessReport`), the validator (`validateParams`) and the wire projection
(`toReportMeta`) — that split is why the registry unit test boots nothing.
`reports-ui/src/types/report.ts` **mirrors** the wire types deliberately rather than importing
them (no other `*-ui` depends on `services`). **Adding a report = one entry + one handler.**

- **Endpoints** `/org/:orgId/reports/`: `GET /catalog` · `POST /:id/run` · `POST /:id/export`
  (`xlsx|pdf`). Same gate on all three (`permission` exact-match + optional `roles` ON TOP —
  the P2 SUPTO case, where a manager holds every permission yet must be shut out). The catalog
  is a **view** of the gate, not the boundary. An inaccessible report answers **404, not 403**.
- ⚠ **`isSignIn` does not actually reject anonymous callers** on these controllers — verified
  against the running server. Every endpoint that answers 401 does so from an explicit
  `if (!user) return status(401)` in the handler. All three reports routes carry that check;
  it is load-bearing, not defensive.
- **P1 entries**: `export` + `aging` (`view: 'custom'` — the moved pages keep their own richer
  views) and `inventory-valuation` (`view: 'runner'`, aggregation-first `$group`, proves the
  runner end to end). FR-07/FR-08 land as pure registry entries.
- **Generic renderers**: `reporting/excel/report.excel.ts` + `reporting/pdf/report.pdf.ts`.
  Column **headers are passed in already localized** — the registry names columns by i18n key
  and only the UI catalogue resolves those, so the UI sends `labels`.
- **Row caps** (FR-6.15): 1 000 table / 50 000 xlsx / 5 000 pdf; handlers fetch `cap + 1` and
  set `meta.truncated`, and the runner shows "narrow the period" instead of truncating silently.
- **Moved out of invoicing-ui**: `ReportingExportView` + `ReportingTabGrid` → `/reports/export`
  (`reports.export`), `InvoiceAgingView` → `/reports/aging` (`reports.aging`).
  `StatusMultiselect` promoted to **ui-shared** (7 invoicing views re-pointed). Old paths keep
  their **old route names** via `MovedToReportsView.vue` stubs that `window.location.replace`
  and **forward the query string** (a router redirect cannot cross SPAs). Invoicing's
  "Reporting" nav group is gone — both children moved.
- **Cross-SPA links must be hrefs, never route names.** New helper `appHref(appId, path)` in
  `ui-shared/nav/navigate` returns what `navigateToPage` would navigate to, including the
  per-app Vite dev port + token/org handoff.
- **Favorites**: moving a page re-keys its ★ favorite (`id === path`). `LEGACY_PAGE_IDS` in
  `page-registry.ts` remaps the two old ids on load (`usePageFavorites.syncFromStorage`), so
  stars and usage counts survive.
- **Only ONE `ReportingTabGrid` is mounted at a time** (keyed on the active tab, no `v-window`):
  three live grids would fight over the same FR-05 querystring keys. The tab itself is in the URL.
- **NOT done in P1** (recorded, deliberate): `desktop-ui` parity deferred; the dead
  `portal-api/src/controllers/export.controller.ts` stub (FR-6.21, zero consumers, returns a
  "not yet implemented" descriptor) left mounted; `/invoicing/reports/aging` still answers
  **anonymously** (pre-existing, and byte-compat per FR-6.20 — worth its own fix).
- Touch points for the next app: `APP_IDS`/`MODULES`/`APP_REGISTRY`/`PLAN_APP_LIMITS`,
  `unified.ts` (`uiModules` + `moduleUiConfig` + import/mount), root `package.json`,
  `scripts/dev.ts`, `Dockerfile` (RUN + COPY), `page-registry.ts`, `apps.*` **and** the legacy
  `appHub.*` i18n twin block ×4 (a missing key renders literally — there is no fallback), and
  `e2e/tests/app-hub.spec.ts`'s `APP_COUNT`.

## FR-07 / FR-08 — the first two registry reports (2026-08-25)

Both are pure registry entries: **one entry + one handler each**, no view, no route, no
endpoint. They are the proof that FR-06's extension point works. Handlers live in
`services/src/biz/reports/`.

**FR-07 `warehouse-operations`** („Складови операции", #16) — purchases/sales per article
from **StockMovements** (not invoices: at regal most purchases exist only as imported
receipt movements with no bill). Two traps it is written around, both regression-tested:
- **The date lies.** `createInvoiceStockMovement` stamps `date: new Date()` — booking time.
  Effective date = the linked invoice's `issueDate`, else the movement's `date`, so the
  period filter runs **after** the `$lookup`. A ±45-day pre-filter on `movement.date` keeps
  the scan sane; it is an optimisation, never the real filter.
- **`lines[].unitCost` is the SALE price on dispatches** (same function assigns
  `unitCost = unitPrice`). Perfect for the Цена/Стойност columns, fatal as a cost basis —
  cost falls back `costAllocations[].totalCost` → `resolvedUnitCost × qty` → `product.avgCost
  × qty` (approximation, flagged in `meta.costBasis`).
- Families: purchases = `receipt` + `return` with `fromWarehouseId`; sales = `dispatch` +
  `return` with `toWarehouseId`. Returns are **negative**. `transfer`/`adjustment`/
  `production_*` are excluded by design. Category filter includes descendants
  (`ProductCategory.parentId`, depth-guarded against cycles). `groupBy: 'document'` gives the
  per-operation drill-down; no-invoice rows get pseudo doc-types `receipt_note`/`dispatch_note`.

**FR-08 `sales-history`** („История на продажбите", #17) — the **union** of `Invoice`
documents and `POSTransaction` rows (nothing links them; `POSTransaction.invoiceId` is
declared but never written), plus a per-currency reconciliation summary.
- ⚠ **The payment-method precedence lives here because the existing code is wrong and frozen.**
  `buildPaymentMethodFilter` ORs `payments.method` against header `paymentMethod` (so one doc
  matches BOTH cash and card — a naive split double-counts), and the export controller infers
  `cash` for any cash-sale with `amountPaid > 0` **even when the header says `card`** — which
  is exactly how regal records its card days. `effectiveMethods()` implements: `payments[]` →
  header `paymentMethod` → infer cash for a paid cash-sale. Money is attributed **per method**,
  not per document, so split tender feeds two buckets. The export controller was NOT changed.
- Windows asymmetrically and says so in `meta.windowing`: documents on `issueDate` (business
  day), POS rows on `createdAt` (real time). Imported CSR day-aggregates carry **no time** —
  blanked, counted in `meta.rowsWithoutTime`, footnoted in the UI.

**Runner upgrades that came with them** (`reports-ui`): new `ReportParamField.vue` renders
every entity param as a **debounced server-searched autocomplete** (contact/product/category/
warehouse/user — they previously fell through to a plain text box, unusable against 23k
products); new `multiselect` ParamType (URL codec `csv`); `contactSideFrom` flips the contact
picker between customers and suppliers when Purchases/Sales toggles; any handler whose `meta`
carries a `summary` array gets the reconciliation card for free.

## One house style for every list/report PDF (2026-08-25)

`packages/reporting/src/pdf/house-style.ts` is the single source of the printed look:
`HOUSE_CSS`, `HOUSE_MARGIN`, `buildTopBar()` (letterhead + centred title/org + the floating
meta block), `buildMetaRows()`, `periodText()`, `footerTemplate()`.

`invoicing-list.pdf.ts` and `cash-agg.pdf.ts` had grown **byte-identical copies** of that CSS,
of `footerTemplate` and of `periodText`, and the FR-06 report renderer arrived with a third,
different look (grey grid, 8pt, no meta block). All three import from here now; each appends
only its own extras (the list's totals box and per-document bands, cash-agg's currency row).
`invoicing-list.pdf.ts` re-exports `footerTemplate` because tests import it from there.

- **Rendering is unchanged** for the existing exports — the CSS moved verbatim. Proven by the
  export suites passing unmodified.
- `report.pdf.ts` exports `buildReportHtml()`, matching the `buildListHtml` / `buildCashAggHtml`
  contract: assert the layout without launching Chromium.
- ⚠ **The meta block is `position:absolute`, so it adds nothing to its container's height.**
  With the usual three rows that is invisible (the title block is taller); a report adding
  filter lines overflowed and printed *over* the table header. `buildTopBar` now sets an
  explicit `min-height` once the meta block has more than 3 rows — documents with 3 or fewer
  are byte-identical to before.
- Reports print their active filters in the header block (`extraMeta`), and the meta labels
  are passed in from the UI (`labels_meta`) for the same reason column headers are: the
  message catalogue lives in the UI, not the renderer. Entity-id params are deliberately
  omitted — "Warehouse: 6a8d…bbcd" helps nobody.
- NOT covered: the per-document forms (invoice, companion docs) — fixed-layout facsimiles of
  printed paperwork with their own CSS, deliberately.

## FR-09 — POS end-of-day close (2026-08-25)

`POST /trade/pos/session/:id/close` was bookkeeping only: one `closingBalance` number, session
set `closed` unconditionally, **zero fiscal-device interaction** — a day could read as closed
in LGR while the device still had it open.

- **Order is the point**: claim the session (conditional `findOneAndUpdate {status:'open'} →
  'closing_control'`, replacing a read-then-write race where two tills each fired a Z-report)
  → resolve the device → **run the Z-report** → only on success persist `closed`.
- **Any fiscal failure reverts the session to `open`**, records `fiscalStatus:'failed'` +
  `fiscalError`, flips the device to `error`, and returns **503 `{code:'fiscal_error'}`** with
  a message distinguishing a connection failure from a device error. The day is never closed
  on a fiscal error.
- `fiscalStatus: 'skipped'` when the warehouse has **no** active device (regal may run without
  one). A device that exists but fails is never silently skipped — only `closeWithoutFiscal`
  bypasses it, and only for admin/manager.
- Model: `closingBreakdown[{method,expected,counted,difference}]`, `fiscalStatus`,
  `fiscalError`, `zReportNumber`, `fiscalClosedAt`, `fiscalDeviceId`, and **`totalOther`**
  (mobile/voucher were accepted per transaction but never summed, so the close screen had no
  expected value for them). `closingBalance`/`expectedBalance`/`difference` keep their
  cash-only meaning — the JE overage/shortage handler reads them.
- **Legacy `{ closingBalance }` body still works** (maps to `counted.cash`).
- `resolveFiscalDeviceForClose` prefers a *connected* device (a warehouse may have two);
  unlike `getFiscalContext` it returns the configured device even when offline, because an
  unreachable device must produce a loud error rather than a silent skip.
- Tremol returns `reportNumber: 'unknown'` — stored as nothing, so the UI says "the fiscal day
  is closed" without printing a bogus number.
- `GET /session/:id/close-preview` feeds the dialog: expected per method, the device and its
  connection state, and how many other sessions are open on the warehouse (a Z-report zeroes
  the **device's** day, not one session).
- UI: `pos-ui/src/components/CloseSessionDialog.vue` — per-method expected/counted/difference
  rows modeled on the legacy screen, three visually distinct outcomes.
- `erp.service.closePOSSession` is the old duplicate; marked `@deprecated` (its only callers
  are its own tests) rather than deleted.

## FR-10 — email an outgoing invoice (2026-08-25)

- **`sendEmail` no longer returns `void`.** It returned nothing and swallowed both failure
  modes (missing key → warn+return; non-2xx → warn+return), so a caller could not tell a
  delivered invoice from one that vanished. Now returns
  `{ok:true} | {ok:false, reason:'not_configured'|'provider_error', detail?}`; the two
  fire-and-forget auth callers are unaffected. Attachments map to SendGrid v3
  (`content` base64, `disposition:'attachment'`), capped at 20 MB.
- `EmailLog` gains `status`/`error`/`entityType`/`entityId`/`attachmentNames` and logs
  **failures too**. Attachment CONTENT is never stored (asserted in a test).
- `POST /invoicing/export/:id/email` — sibling of the single export, sharing
  `lib/invoice-pdf.ts#renderInvoicePdf` so the attachment is byte-identical to Print (the
  extraction is refactor-only; the 46 export tests stay green unmodified).
  Guards: `canWrite` (read-only roles incl. `nra_auditor` → 403), outgoing only (422),
  **draft blocked** (422 — a `DRF-` number in a customer inbox is worse than no email),
  60s duplicate-send guard (429), `not_configured` → **503, never a fake success**,
  provider failure → 502.
- ⚠ **Naming landmine**: `POST /invoices/:id/send` already means *issue the document*. The
  email action never uses "send" in a route. ⚠ **i18n landmine**: `invoicing.email` is an
  existing *string* key — the new keys live under `invoicing.sendEmail.*` (the seeding script
  asserts this before writing).
- `.env.example` now documents `SENDGRID_API_KEY` + `FROM_EMAIL`. **Ops: `FROM_EMAIL` must be
  a SendGrid-verified sender** or every send 502s; prod's `lgr-secret` already carries the key.

## FR-06 P2 — the rest of the report catalog (2026-08-26)

P1 shipped the module; P2 fills it. The registry now holds **22 entries** and the claim
"adding a report = one entry + one handler" is paid for: eight new reports needed no route,
no view and no endpoint.

- **New handlers** in `services/src/biz/reports/`: `documents.report.ts` (ONE factory, THREE
  entries — `sales-documents` / `purchase-documents` / `cash-register`, the same three
  populations as `POST /invoicing/export/kind/:kind`, which stays frozen and byte-compatible),
  `contact-ledger` + `product-ledger` (thin adapters over the *existing* services behind
  `/invoicing/contacts/:id/ledger` and `/inventory/products/:id/ledger` — two implementations
  of "what did we sell this customer" would drift inside a release), `stock-levels` (per
  warehouse, `belowMin` reorder filter, roll-up mode), `stock-movements` (the raw journal —
  unlike FR-07 it hides nothing: transfers, adjustments and production are the point),
  `order-sheet` (ORDO lines with ordered/received/outstanding — NOT the per-order supplier
  sheet at `/orders/:id/export`, which is a document and untouched).
- ⚠ **`STATUS_OPTIONS` mirrors the Invoice enum exactly.** Offering `completed` (which some
  list views still show) is a filter that can only ever return nothing — the model's enum is
  `draft|sent|received|partially_paid|paid|overdue|voided|cancelled|converted`.
- **SUPTO 18.1–18.9 are the one deliberate exception to "everything is a handler."** Their
  XLSX layout is prescribed by Приложение 29 and already implemented in
  `reporting/excel/supto.excel.ts`; rendering them through the generic renderer would produce
  a prettier, *non-compliant* workbook. So the nine entries are `view: 'custom'` + a single
  `SuptoTableView.vue` driving the unchanged `/supto/export/:tableId`. There is no table
  preview on purpose — an approximation of a document a tax inspector is about to receive is
  worse than none. `roles: ['admin','nra_auditor']` on top of `permission: 'admin.audit'` is
  what keeps a *manager* (who holds every module permission) out; 18.9 takes no period.
- **FR-6.2 permissions landed**: `reports.read` / `reports.export` are real, and the App Hub
  tile is gated on `reports.read` instead of the P1 stand-in `invoicing.read`. Export is a
  separate right — a read-only `member` can run a report and read it on screen but gets 403
  on download (`canExportReport`, layered ON TOP of `canAccessReport` so it can never reveal a
  report whose module permission the caller lacks). ⚠ **OPS ORDER: deploy → run
  `scripts/backfill-reports-permissions.ts --execute` → tell people to re-login.** A JWT
  carries the permission list it was issued with; admins are exempt because `tokenize()`
  expands an `isAdmin` set to every PERMISSION. Symptom of skipping it: the Reports tile
  silently disappears from the App Hub.
- **FR-6.21 resolved**: the dead `portal-api/src/controllers/export.controller.ts` stub is
  deleted and unmounted — the generic runner is what it was a placeholder for.
- **FR-6.5**: `PAGE_REGISTRY` has a row per report (all 22), so each is ★-favouritable.
- **Desktop parity done** (migration note 3): `desktop-ui` mounts the same reports-ui views at
  `/reports/*`. Doing so surfaced that **desktop-ui had not built since FR-01 (#8)** — its
  router still imported the deleted `CreditNotesView.vue`; now a named redirect, matching the
  web app. `desktop-ui` is NOT part of `bun run build`, which is why nobody noticed.
  - ⚠ **Superseded 2026-09-29 (FR-14.34):** `desktop-ui` IS in `bun run build` now, precisely so
    that cannot happen again — see "Desktop: local mode retired" below. The sentence above is kept
    as the record of why it was added.
- **Runner**: a required entity param (the two ledgers) suppresses the auto-run and disables
  Run with a "choose X" hint, instead of auto-running into a 422. New `contactSide` on
  `ParamDef` fixes a picker to customers or suppliers (`contactSideFrom` still wins when both
  are present).
- **Tests**: `integration/reports-p2.flow.test.ts` (31) — one per handler plus both new gates.
  The 68 export tests AC 4 names pass **unmodified**.

## FR-11 — daily digest email (2026-08-26)

One mail per configured recipient every morning, covering the previous day, in the org's
locale and on the org's clock. `services/src/biz/digest/`: `daily-digest.types.ts` (import-pure
shape) · `daily-digest.service.ts` (server-only builder) · `daily-digest.render.ts` (HTML +
`DIGEST_I18N` ×4) · `digest-time.ts` (import-pure calendar math) · `digest-runner.service.ts`
(claim → send → record).

- **The unique `{orgId, date}` index on `DigestRun` IS the lock.** There is no cron, no queue
  and no lease primitive in this codebase, and FR-11 deliberately did not add one: the
  scheduler claims a day by INSERTING the run document, first writer wins, everyone else takes
  E11000 and walks away. Correct across restarts and across pods. `BackgroundTask` was rejected
  (requires a `userId`; 7-day TTL). Semantics: **catch-up within the day** (`localHour >= hour`,
  not `===`), **never resend**, **no multi-day backfill**, stale claim (no `completedAt`, older
  than 30 min) taken over.
- ⚠ **Two dates are in play and conflating them is the easy bug**: a run is CLAIMED under the
  day it is sent and REPORTS on the day before. `runDigestForOrg(orgId, sendDate)`.
- **`Org.settings.timezone` was read by NOTHING before this.** FR-11 is its first consumer, so
  `digest-time.ts` is defensive (missing/invalid zone → UTC, never throws) and table-tested
  against DST, midnight and year/month boundaries. ⚠ **regal-pz had it unset** — set to
  `Europe/Sofia` on 2026-08-26; other orgs may still be unset and would run on UTC.
- **Scheduler is `unified.ts`, time-sync template**: `config.digest.checkIntervalMs`, **0
  disables it entirely** (`.env.test` sets 0 so no test ever mails). ⚠ It runs an **immediate
  first tick on startup** — starting a dev server after the configured hour sends for real.
- **Content**: KPIs (reusing FR-08's exported `effectiveMethods`/`bucketFor` — no second
  precedence rule) · document register + **sequence continuity per family** (prefixes via
  `sequence-registry`, never hardcoded; absent numbers inside the day's range flagged, voided
  listed not gap-flagged, drafts outside the sequence) · materials sold/transferred/loaded
  (ONE aggregation, not three calls into the FR-07 handler — that report windows via `$lookup`
  and excludes transfers by design; FR-07's effective-date rule is kept, which is what makes
  the numbers reconcile) · stock ≤ 0 · corrections with the sign rule (`fromWarehouseId ⇒
  −|qty|`) · sales with no linked movement · duplicate suspects · edited-after-issue · ops.
- Every section is independently `.catch()`-degraded (dashboard fan-out pattern); an empty day
  still sends.
- **Security rider (FR-11.3)**: `GET /org/:orgId/user` had no projection and `password` has no
  `select: false` — it was returning **bcrypt hashes to any signed-in caller**. Fixed with an
  additive `select` option on `paginateQuery`; regression test asserts both directions.
- New indexes: `StockMovement {orgId, invoiceId}` (also speeds the pre-existing reverse reads),
  `EmailLog {orgId, status, createdAt}`.
- Endpoints (portal-api `digest.controller.ts`, admin-only via the raw role guard):
  `POST /digest/test` (**sends to the caller only**, never the recipient list; 503 when
  unconfigured), `GET /digest/preview`, `GET /digest/last-run`.
- Ops scripts: `scripts/configure-daily-digest.ts` (resolves recipient EMAILS → userIds, can
  set the timezone, dry-run by default) and `scripts/preview-daily-digest.ts` (renders a day to
  an HTML file — no send, no claim).
- Reconciliation verified on regal-pz 2026-07-30: digest sales+cash `1465.19` = sales-history
  report `1465.19`; materials product counts = warehouse-operations (114 sold / 36 loaded).

## Desktop: local mode retired (2026-09-29, FR-14.34)

The desktop is being rebuilt as a **server-mode client** — it opens the LGR cloud app in its own
window, and that is its only mode. `docs/architecture/desktop.md` is the current picture; the spec
is `docs/fr/FR-14-lgr-desktop-app-server-mode.md` (issue #57).

**Deleted, not deprecated:** `packages/desktop-api` (the Bun sidecar), `packages/sync` (imported by
nothing), `packages/dal-sqlite`, the shell's `sidecar.rs` + `archive.rs` and its ten unused
`invoke` commands, `desktop-ui`'s ~50 routes into six other UI packages, `OFFLINE-MODE-PLAN.md`,
and the prototype's five docs.

- ⚠ **`packages/dal` and `packages/dal-mongo` stay.** `DalBackend` is now the single member
  `'mongo'`, and `packages/tests/src/dal/` keeps all 70 repository test bodies — they exercise the
  `dal` INTERFACE, not `dal-mongo`, which is why they are not redundant with the integration
  suites. The directory was renamed **`dal/parity/` → `dal/repos/`** (`*.parity.test.ts` →
  `*.repo.test.ts`): with one backend, "parity" named nothing.
- ⚠ **`desktop-ui` is now in `bun run build`.** That is the point: it was NOT built before and
  bit-rotted unnoticed — a deleted view broke it from 2026-08-22 to 2026-08-26. Its five views are
  placeholders until FR-14.30–14.33.
- The sidecar's `admin` / `admin123` default account and its `'lgr-dev-secret'` token signing are
  gone, along with the release-notes line that published the password. ⚠ `lgr-dev-secret` still
  exists in `packages/config` as the **dev-only** JWT fallback that is fatal in production (S-02) —
  that is a different thing and stays.
- Gone from the scripts: `dev:desktop`, `dev:desktop-api`, `start:desktop`. `dev:desktop-ui`,
  `build:desktop`, `tauri:dev` and `tauri:build` remain.
- ⚠ The `SQLite Type` columns in `docs/models/**` are **historical** and nothing implements them.
  The per-entity `## SQLite Schema` sections, which cited deleted files, were removed; the table
  columns were left alone rather than risk mangling 49 reference docs by script.

## Known Issues

- [MEDIUM] [2026-07-19] Cluster pod external DNS is INTERMITTENT: CoreDNS forwards to 10.10.20.1 (zeus virbr1 dnsmasq — answers fine locally) and periodically times out (CoreDNS logs `read udp 10.244.x→10.10.20.1:53: i/o timeout`; zeus shows no explicit 10.244.0.0/16 return route) → ArgoCD sync intermittently fails with ComparisonError "server misbehaving" on github.com, then succeeds on retry minutes later (observed 2026-07-19: first sync Error, queued retry completed → Synced). Workaround when stuck: `kubectl apply -k k8s/overlays/prod` from the mars `~/lgr-deploy` checkout (live state converges with git). Root-cause hunt belongs in k8s-cluster-multi (zeus WG/libvirt routing). Also: argocd CLI token on mars is expired — trigger syncs via `kubectl -n argocd patch application lgr --type merge --patch '{"operation":{"sync":{}}}'` or re-login. — Status: OPEN
- [MEDIUM] [2026-08-25] `integration/pos-transaction.flow.test.ts` — 9 of 21 tests fail on Windows (test 13 hangs ~150s, then 14–20 each time out at exactly 60s). It is the `.rejects` deadlock below, not a regression: **verified by stashing the only change on that path and reproducing the identical failure on unmodified code**. The file has 6 `.rejects`/`.resolves` usages; test 13 is the first one. Convert them to try/catch capture, or run the file on Linux/mars. — **Status: RESOLVED 2026-09-15** — all 6 converted with the sweep below; the file passes in the full run.
- [MEDIUM] [2026-07-19] Bun 1.3.12 on Windows: `expect(p).rejects` deadlocks when the rejection follows MongoDB driver I/O — the pending op hangs ~45s, mongod gets reaped ("killed N dangling processes") → cascading ECONNREFUSED + segfault. Workaround: try/catch capture (see `bill-with-update.flow.test.ts` `captureRejection`); ~60 `.rejects` usages across 23 test files can hang on Windows — run those files on Linux/mars, or convert as touched. **2026-07-26**: `.resolves` is affected too (proven by minimal probe: same promise via plain await = instant, via `.resolves` matcher = deadlock + hook-timeout cascade that poisons every later test in the process); which files trip it is module-graph/timing sensitive. `invoice-stock-validation.flow.test.ts` converted (all `.rejects`→captureRejection, `.resolves`→plain await) → 15/15 in 4s. Convert BOTH matcher kinds as touched. — **Status: RESOLVED 2026-09-15.** "As touched" was the mistake: the matchers were hit one at a time for two months while `bun run test` was, on Windows, not slow but COMPLETELY BLOCKED. `accounting.flow.test.ts` is the first file the runner reaches and line 124 used `.rejects`, so the shared mongod was reaped before any other file ran and all ~125 that followed cascaded into ECONNREFUSED — the suite never reported at all. All 58 remaining call sites across 19 files are now converted to the shared `helpers/capture-rejection.ts` (`captureRejection` + `expectRejection`), which replaces the three private copies that had grown in different files. `bun run test` completes: **1505 tests / 126 files in ~5m, 1493 pass / 7 skip / 5 fail** (the 5 are real pre-existing failures in `app-hub.flow`, `compare-snapshot` and `org-logo` that the hang had been hiding). ⚠ **Never reintroduce `.rejects`/`.resolves` in this suite** — one is enough to block everything again. ⚠ When sweeping, scan RECURSIVELY: `dal/repos/` (named `dal/parity/` until 2026-09-29) and `unit/biz/` are two levels down and a `unit/*.test.ts` glob silently misses 23 sites.
- [HIGH] [2026-03-10] 18 compact DAO controllers missing Elysia body validation schemas (arbitrary field injection risk) — Status: OPEN
- [HIGH] [2026-03-10] BaseDao read methods missing .lean() (Mongoose document overhead on all DAO reads) — Status: OPEN
- [RESOLVED] [2026-03-10] "N+1 in findBelowMinStock()" — the entry was stale on two counts, verified 2026-08-26 while implementing FR-11: there is no `findBelowMinStock`, the method is `findLowStock` in `services/src/dao/warehouse/product.dao.ts`, and it has been a single batched `$in` query (not a per-product loop) since before this entry was written. Nothing to fix.
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
- [RESOLVED] [2026-03-15] Purchase invoices "Supplier Invoice #" column empty — mapped to `reference` field
- [RESOLVED] [2026-03-15] Proforma "Valid Until" column empty — mapped to `dueDate` field
- [RESOLVED] [2026-03-15] Credit notes missing Send/Issue button — added for draft status
- [RESOLVED] [2026-03-15] Credit note `relatedInvoiceId` not saved — added to POST/PUT body schemas
- [RESOLVED] [2026-03-15] Stock movement list slow with size=0 — capped at 1000, stripped lines from response

## K8s deployment placement

Cluster has three zones via `topology.kubernetes.io/zone`: `mars`,
`zeus`, `jupiter` (one master + one worker VM per bare-metal host).
Apps are split by tier (added 2026-05-01 after a mars-host overload
incident):

  - `tier=high-performance` (zeus + jupiter workers): this app, plus
    roomler / roomler-ai / oxmux / lgr / purestat / tickytack / clawui
    (when migrated to K8s).
  - `tier=utility` (mars worker): bauleiter, regal, monitoring stack,
    docker registry, image builds.

Enforced via a Kustomize patch in `lgr-deploy/k8s/overlays/prod/
kustomization.yaml` that puts a required `nodeAffinity` on every
Deployment + StatefulSet. Hostname pins in `base/` are retained where
the StatefulSet PVC uses node-local storage; the tier requirement is
an *additional* constraint — both must match.

## Google Drive: one owned root folder (2026-09-09; split 2026-09-15)

> Operator guide — which env vars, where they live on prod, and what happens each night:
> **`docs/guides/google-drive-backup.md`**.

The off-site backup destination (FR-13.48–13.59) writes to exactly one folder in
the connected Drive and nothing beside it:

    LGR/Backups/<org slug>/<kind>/lgr-<slug>-<kind>-<date>.ndjson.zst.sealed
    LGR/Archive/<org slug>/<fiscal year>/lgr-archive-<year>.ndjson.zst.sealed

⚠ The SECTION sits above the org. Backups and archives rotate on completely
different rules — 14 kept generations against a ten-year legal retention (ЗСч
чл. 12; payroll fifty) — and the split is what stops a prune, or a human tidying
the Drive, treating a fiscal year's only cold copy as an old backup.

`BACKUP_GOOGLE_DRIVE_FOLDER` renames the root; it must be a **single folder
name**. Empty, `/`, or a value containing `/` used to resolve to My Drive root —
`driveRootFolder()` (backup-destinations.service.ts) and `ensureFolder()`
(cloud-storage.service.ts) both refuse it now, so a misconfiguration fails the
destination instead of scattering sealed bundles across the account.

The scope is `drive.file`: per-file access to what this app created. It cannot
read anything else in the account, and files a human drops into `LGR/` are
invisible to it. ⚠ That also means the document-import side of
`CloudStorageAdapter` can only ever list what the backup job itself uploaded.

Connecting it (run where there is a browser, as a **dedicated** Google account):

```bash
bun --env-file=.env scripts/google-drive-consent.ts --append-env .env   # token + client pair
bun --env-file=.env scripts/backup-drive-smoke.ts                       # prove the real Drive
```

The consent script takes the OAuth client from `.secrets/google-oauth-client.json`
(gitignored) unless `BACKUP_GOOGLE_DRIVE_CLIENT_ID`/`_SECRET` are already set, and
`--append-env` writes that pair next to the refresh token. ⚠ A refresh token is
bound to the client that issued it: sealing the token without its client leaves the
app refreshing with `GOOGLE_CLIENT_ID` and failing `invalid_client` on the first
nightly run. Requires the Drive API enabled on the client's project.

## Object storage: the tier Drive cannot be (2026-09-15, FR-13.58)

Drive has **no object-lock** — the credential that writes can also delete — and the
artifact that has to survive a leaked token is the ten-year archive, not last
night's bundle. `backup/s3-client.ts` is a hand-rolled SigV4 client over `fetch`
(no SDK, four operations) against any S3-compatible endpoint (B2, R2, Hetzner,
MinIO, AWS), and `pushBundleToS3` seals with the same key the Drive push uses.

- `BACKUP_S3_SCOPE` defaults to **`archive`**: the yearly cold tier only. `all`
  also ships every nightly bundle — into a bucket whose objects are retained and
  cannot be deleted until their lock expires, which is a bill, not a policy.
- `BACKUP_S3_OBJECT_LOCK_MODE=COMPLIANCE|GOVERNANCE` sends the retention headers.
  ⚠ Object Lock must be enabled **when the bucket is created**; most providers
  cannot add it afterwards, and COMPLIANCE retention cannot be shortened by anyone.
- Archives are never pruned from this tier, whatever `keep` says, and retention is
  skipped entirely under a lock (the delete would be refused anyway).
- Nothing uploads without `BACKUP_ENCRYPTION_PUBLIC_KEY`, same rule as Drive.
- Prove a real bucket with `bun --env-file=.env scripts/backup-s3-smoke.ts`
  (`--prove-lock` writes one undeletable object and watches the delete be refused).
  The unit tests stub `fetch` and cannot prove a signature a real S3 accepts.

## A master's own backups (2026-10-25, FR-20.21, plan step P1-9)

A master has no mars: nothing like the Layer-1 rsync of the uploads PV backs its files up, and
its database is on the same disk as everything else.

- **The nightly run is `full` on a master** (`nodeRole() === 'master'` and no variant asked
  for). Its files sidecar is ORG-ROOTED: the whole `<UPLOAD_DIR>/<orgId>/` tree, `backups/`
  aside, in format `lgr-backup-files-2`.
  - ⚠ A format of its own, so a reader that only knows `-1` (paths under `docs/`) refuses it
    rather than putting files where they never lived.
  - The restore anchors at whichever root the header names, and never writes into `backups/`:
    a crafted entry there could otherwise overwrite the bundles a later restore needs.
    `restoreTarget` judges every path, on the RESOLVED form (`./backups/x` passed a check of
    the raw string, and on Windows so did `Backups/x` and `backups./x`).
  - The cloud's `full` is unchanged (`docs/` only, `-1`).
- **Every sidecar is read back before the run is called complete** (`verifyFilesSidecar`, the
  files' `verifyBundle`): each entry decoded and checksummed, each path one the restore accepts,
  the count the writer recorded, and the bytes on disk hashed in the same streamed pass. A
  sidecar that fails fails the run. On a master it is the only copy of the uploads.
  - ⚠ **Read sidecar lines through `splitLines`, never `chunk.toString()` per chunk.** A chunk
    boundary inside a Cyrillic character turned it into U+FFFD, and the restore wrote the file
    under a name nothing points at: 3 of 3000 `фактура-*.pdf` paths on a real zstd stream (16 KB
    and 8 KB chunks). The checksum covers the content, not the name, so nothing said so.
- **`BACKUP_LOCAL_PATH`:** a second disk, a USB drive or a NAS path. Each night's bundle and its
  sidecar are copied to `<path>/LGR/Backups/<org>/<kind>/`.
  - **Streamed** in and out: the sidecar is projected at gigabytes.
  - **Read back and re-hashed every night**, then pruned to `BACKUP_LOCAL_KEEP` generations
    (default `BACKUP_KEEP_PER_ORG`), touching only files it wrote.
  - **Not sealed:** FR-20.21 seals what goes off-site, and this stays in the shop.
  - ⚠ A location that is not there is a `failed` destination, never a failed run, and it is
    never created: a "copy" made on the master's own disk would be no copy at all.
- **Off-site only to Bulgaria or the EU** (FR-20.97, Н-18 чл. 52з(14), 52к(1)). On a master:
  - object storage must be NAMED EU (`s3InEu`: an `eu`/`eu-*` label, or a Hetzner, Scaleway or
    OVH EU site) or attested (`BACKUP_S3_EU=true`);
  - Drive needs `BACKUP_GOOGLE_DRIVE_EU=true` (a Workspace data region; a personal Drive cannot
    choose one).
  - Otherwise the destination is `skipped`, before any network call.
  - ⚠ The region alone proves little: `us-east-1` is SigV4's default answer.
  - ⚠ **The cloud is told, not stopped.** FR-20.97 binds its copies too (§2.8). Enforcing it the
    day this deployed would have stopped production's off-site backups until someone attested a
    region, which is the owner's decision. It logs a warning once a process.
- The cloud vault sealed with the org's own key pair is P2's.

## Till PINs on a master (2026-10-25, FR-20.40, plan step P1-5)

An operator signs in at a till with **operator code + PIN** (6–12 digits, `pinRuleViolation`
refuses runs and repeats). Routes are under `/api/auth/local`, and **every one answers 404 off a
master** (`portal-api/src/controllers/local-auth.controller.ts`).
- **Where.** Only a paired desktop on the LAN ingress (`x-lgr-source: lan` plus its token: the
  desktop's org is the org signed in to), or the console. ⚠ Never the tunnel. `frontSource` is the
  supervisor's stamp, and a master with no front offers no PIN at all.
- **Stored** in `local_credentials` (`identityId`, `kind`, argon2id `verifier`, `tvAtSet`): node
  state, no `orgId`, never in a bundle. ⚠ Never on `Identity`, which travels in every bundle of
  the person's orgs.
- **Set by its person** with their password (`PUT /pin`); a PIN session may not. A
  `tokenVersion` bump (a password change, a sign-out everywhere) invalidates it: `pin_not_set`.
- **Backs off, never locks** (trap 32): 3 free tries, then 1 s doubling to 60 s, per person
  (persisted) and per desktop (in memory). During the wait the answer is 429 with `Retry-After`,
  and the PIN is not checked. Every attempt costs one argon2 verify, decoy included, as `login()`
  does.
- ⚠ **A PIN session (`amr: ['pin']`, 12 h) reaches the till only** (`pinScopeRefusal`, first in
  `permissionRefusal`, so `admin` too): the POS routes, the shell's `me`/`logout`, and the PIN pad
  itself (the next operator signs in over the last one's session). Inside them the role still
  counts, so a manager's PIN authorises a storno. A new route the POS terminal calls must be added
  to `PIN_SCOPE_ORG`, or a till breaks on it. ⚠ Keep `/auth/switch` out: it would mint a FULL
  session from a PIN session.
- **The UI** (P1-5b) appears only where `GET /auth/local/methods` says `pin: true`:
  - pos-ui's `/pin` (`PosPinView`) opens when a tab has no session there, and from the POS menu
    ("Switch operator");
  - a "Till PIN" card under the portal's account (`TillPinCard`, hidden on a 404).
  - ⚠ Those calls use plain `fetch` (`pos-ui/src/composables/useTillPin.ts`), never the shared
    HTTP client. They run with no session, or with the last operator's, and the client's 401
    recovery would sign the tab out or send it to the portal.
- ⚠ **A master's PASSWORD sign-in backs off too.** There the password is the person's local
  credential, so `/auth/login`'s S-08 throttle uses the PIN's curve once a counter reaches its
  limit, never the cloud's 15-minute lock. A lock would let anyone at a till lock the admin out
  for an outage. Password-reset requests still lock: that only stops a mail flood. The cloud is
  unchanged.
- Not yet: local passwords delivered from lgrai.app, and refusing person edits on a linked master
  (P2, with the link).

## The LAN CA rotates with a week's notice (2026-10-25, FR-20.30, plan step P1-4)

Desktops pin a master's own CA (FR-20.31), so it is never replaced silently.
`lgr-server ca rotate` (`--in <seconds>`, a week by default) announces the change:
- **The next CA is made at once and served beside the current one** at `/__lgr/ca.json`, on the LAN
  ingress. A paired desktop reads it hourly through the TLS it already trusts (`trust::follow`),
  adds the next CA to its pin and saves it (`settings.master.next*`). The window's proxy re-trusts
  in place (`Running::retrust`), so the switch drops nobody who came by during the week.
- **At the switch** (`switch_if_due`, checked each minute) the next CA signs a new server
  certificate and becomes the current one. Desktops then promote it and drop the old one. A
  desktop that never came by pairs again.
- ⚠ **The switch is resumable.** `lan-ca-rotation.json` is marked `switching` before a file moves,
  and `ensure` finishes a started switch BEFORE it reads the CA. Cut off between the two CA files,
  they belong to different CAs until it does.
- ⚠ **A next CA is only ever taken from `ca.json` read through the pinned TLS.** Unpinned, the same
  document proves nothing, since anyone on the LAN could serve one. `follow` returns `Unknown` for
  a current CA the pin has never heard of.
- **`state/lan.json`** (`LGR_LAN_STATE_FILE`) is what a pairing code names and pins, kept current
  by the supervisor. The API reads it (`currentLan`), so a rotation or a DHCP move needs no
  restart; the environment's values are only the fallback. A new address used to leave codes
  naming the old one until the API restarted.
- A connection kept from before the switch, or a TLS session resumed from one, still carries the
  old certificate, legitimately: only that master holds the session. A probe of the old CA must
  make a full handshake (a fresh client) to see it refused.

## A master prints with its own Chrome (2026-10-25, FR-20.25)

A master renders its PDFs with **`chrome-headless-shell`**, at the build the repo's puppeteer pins.
`bun scripts/fetch-pdf-browser.ts --platform <win64|linux|mac|mac_arm> --out <home>` puts it in
`<home>/chrome/`, and `lgr-server` hands it to the API as `PUPPETEER_EXECUTABLE_PATH`.
- **Override:** `LGR_SERVER_CHROME`, or `PUPPETEER_EXECUTABLE_PATH` in `api.env`. The second is how a
  Linux ARM master names its distribution's Chromium, since Chrome for Testing publishes no Linux ARM
  build.
- **Without one the master starts, warns, and prints nothing** (503). It never falls back to another
  Chrome.
- ⚠ **Never the machine's Edge or Chrome.** A Windows browser with an update pending
  (`new_msedge.exe` beside it, which is how an update waits while anyone has the browser open)
  swaps and RELAUNCHES itself on start. Puppeteer sees "Failed to launch the browser process:
  Code: 0", and the relaunched headless browser runs on with nobody to close it, three per PDF.
  74 were left behind by a handful of test renders on 2026-10-25.
- ⚠ **`packages/server/pdf-browser.lock.json` pins the unpacked TREE** of each platform (every
  path and its sha256), not the archive, and the fetch refuses anything else. After a puppeteer
  bump, `unit/pdf-browser.test.ts` fails until `--update-lock` is run and its four digests
  reviewed.
- CI's package boot prints its invoice with the Linux build. A Linux master still needs the
  libraries the tree's `deb.deps` lists, and fonts with Cyrillic (P1-7's packages).
