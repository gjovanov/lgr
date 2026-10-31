# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LGR (Ledger)** is a full-stack multi-tenant ERP system built as a Bun monorepo. Stack: Elysia.js + MongoDB/Mongoose + Vue 3/Vuetify 3 + Pinia.

The system follows a **multi-app architecture** (Google Workspace model): a Portal app handles auth, tenant management, and an App Hub that links to 7 domain app UIs. All APIs run as a **single unified process** on one port, while each domain has its own UI package.

## Commands

```bash
# Development
bun run dev                  # Unified API (4001) + the 7 UI dev servers (portal + 6 SPAs; POS is in invoicing); `bun run dev -- api portal` starts a subset
bun run start                # Production: unified API (4001) serving all built UIs
bun run build                # Build all 8 UIs (portal, the 6 domain SPAs, desktop-ui)
bun run seed                 # Seed database (Acme Corp + Beta Inc)
bun run migrate              # Apply pending versioned migrations (--status lists them; FR-20.19)

# Individual UI dev servers (each proxies /api → unified API on 4001)
bun run dev:portal-ui        # Portal UI (port 4000)
bun run dev:accounting-ui    # Accounting UI (port 4011)
bun run dev:invoicing-ui     # Invoicing UI (port 4021)
bun run dev:inventory-ui     # Inventory UI (port 4031)
bun run dev:payroll-ui       # Payroll UI (port 4041)
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
  (pos)                → POS lives in invoicing-ui/src/pos since FR-24 Phase 0, served at /invoicing/pos/*;
                         /pos/* answers 302 there (desktops hold startPath /pos/). Still its own App Hub
                         app (pos.read, OrgApp, the PIN scope): APP_NAV_META.pos.spa = 'invoicing'
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
- **The lock** (`__lock__`, owner `host:pid:uuid`) lapses after 10 min. A start waits for it for up to 15 min.
  - ⚠ A run whose holder is a process on THIS machine that no longer exists takes the lock over at
    once (`holderIsGone`).
  - The first 0.1.4 rollback lane showed why: the update helper stopped a version one second into its
    boot-time migrations, and the version it went back to waited ten minutes, alive and not serving.
  - Another host's holder (global's pods) still lapses on its own. A pid that exists (a reused one, or
    this process's own) is waited for: never a second run beside a live one.

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
  - ⚠ A registration stamped `console` on a master makes the founder ACTIVE, with no activation
    mail (FR-20.17, #350). The console exists only during setup, on loopback, behind the one-time
    token. An invite through it still needs the email. Gated on `nodeRole() === 'master'` AND
    `frontSource()`, which is `undefined` with no front, so a forged header on global does nothing.
- **Setup is the supervisor's** (`packages/server/src/setup.rs`, its page `setup_page.html`, served
  at `/__lgr/setup/app` on the console, never by the API). It chooses the link level, opens the LAN,
  sets the backup copy, then writes `state/setup-complete`, which closes the console and opens the
  tunnel. Its choices live in `state/setup.json`, UNDER `config/api.env` (the operator's line wins,
  and setup never edits that file). It applies them by restarting the supervisor IN ITS OWN PROCESS
  (`supervisor::RELOAD`), so the service manager counts no restart (#369). The control socket's
  `GET /setup` tells it which orgs are homed here (their owners become `BACKUP_SYS_ADMINS`) and how
  many desktops are paired. `lgr-server setup reset` reopens it with a new token.
  - ⚠ A console session is derived from the token (`front::setup_session`) so that it survives
    that restart. Never the token itself in the cookie.
  - ⚠ Never run `cargo fmt` in `packages/server`. There is no rustfmt config, CI runs only clippy,
    and the crate is written in long lines: fmt rewrites all 36 files.
- **`source=lan` needs a paired desktop:** `X-LGR-Desktop-Token`, verified and then re-read through
  `loadActiveDesktop`, so a revocation takes effect at once.
  - Exempt: `GET /api/health` and `POST /api/desktop/v1/{enroll,token}`, matched EXACTLY. A variant
    such as `/api/health/` is gated: an exemption fails closed.
  - ⚠ This is the one `X-LGR-*` header the LAN ingress carries over from the client. It is a
    credential the API verifies, never a stamp it trusts.
- **`clientIp()` behind the front** returns `x-lgr-client-ip` only. There is no nginx in front of a
  master, so `X-Real-IP` and `X-Forwarded-For` are the client's own text.
- **Every audit entry says where it came from (FR-20.48)**, so an auditor can tell a till from a
  remote session. The field is `AuditLog.via`:
  - `lan:<desktopId>`: a till, by its credential;
  - `lan`: the shop's network without a credential;
  - `tunnel`: the org's address;
  - `loopback`: the console, and the server's own work (a tick, or a job outside any request).

  How it is set:
  - `requestVia` (`front-guard.ts`) derives it, and `api.ts`'s synchronous `onTransform` puts it
    in the request context.
  - `auditDoc` stamps it on every entry, so none of the ~240 call sites changed.
  - A socket's own event has no request context, so it passes `via` itself (the fiscal bridge's
    takeover).
  - lgrai.app records none.
  - The audit page names the till (`viaDesktop`; strings `admin.via.*` ×4).
- **The control socket** (`control-socket.ts`): HTTP over AF_UNIX (`Bun.serve({ unix })`), and every
  request carries the front secret.
  - `GET /status`: schedulers, `fiscalInFlight`, `posOpen`, requests and sockets in flight.
  - `GET /setup`: the orgs homed here with owner and admins (addresses and an active flag only), and
    the paired desktops. For setup's console.
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
- **State survives a power cut** (`config::write_durable`, 2026-10-28): every file the supervisor
  keeps in `state/` and `keys/` is written as `<name>.tmp`, given its mode, flushed, renamed over,
  and on Unix the directory flushed too. `write_private` is that with 0600.
  - ⚠ A bare tmp + rename survives a crash, not a power cut. ext4 (delayed allocation) and NTFS put
    the rename on disk before the data, so a cut seconds after a first start left an empty
    `node.json` or a half `api-secrets.env`, and either is exit 7 for good.
  - New state goes through `write_durable`.
- **Another machine with this server's address** (#356, `arp.rs`, Linux): RFC 5227 probes for
  `certs::lan_ip`, plus every ARP packet on its interface. A sender MAC that is none of this
  machine's, naming this address, is a conflict.
  - It goes in `state/address-conflict.json` and the status, NEVER `clone.json`. That one locks legal
    numbering, and only the TLS proof may write it.
  - Detection only: the supervisor never announces the address.
  - ⚠ **A copy at THIS address is read off the wire** (#380, `mdns_wire.rs`).
    - Its mDNS comes from this machine's own address, which the kernel drops as a martian
      (`accept_local=0`) before any socket of the IP stack. `advert::browse` can never hear it.
    - A second packet socket reads it: IPv4 UDP to 5353, with a BPF filter attached BEFORE the bind.
      An advert is kept only from the MAC that claims the address over ARP, and naming this node from
      another start, it makes the conflict `probableClone`.
    - A new conflict makes the DNS-SD advert announce again (`advert::announce_again`, mdns-sd's
      re-`register`). A copy never hears a query from here (martian both ways), so only an
      announcement tells it who this server is.
    - ⚠ The veth tests need `lo` up in the far namespace. mdns-sd binds its signal socket on
      127.0.0.1, and does not start without it.
  - The conflict rides in the health frame (`address`). lgrai.app raises `address_conflict` while it
    was seen in the last 15 minutes (`node-alarms.ts`, `detail: probable_clone`), and the master's own
    status page shows it.
  - ⚠ `CAP_NET_RAW` is a FILE capability of the binary, never the unit's. Root writes it as it
    installs a version or a home (`arp::grant_file_capability`, in `install_bundle_checked` and
    `service install`).
    - ⚠ The INSTALLING version writes it. A 0.1.5 installed by 0.1.4's `update apply` or helper has
      none. Applying the same bundle again with its own `update apply` writes it
      (`Installed::Already`, no switch, no restart), and the watch comes on at the next start.
    - Children are other files and inherit nothing, and a rollback to a version from before it runs
      no watch rather than a wider one.
    - ⚠ It is `cap_net_raw=p`, NEVER `+ep`: with the effective flag the kernel refuses to EXECUTE the
      binary wherever the bounding set lacks `CAP_NET_RAW` (a pod that drops ALL, `--cap-drop
      NET_RAW`), so the server would not start at all.
    - The supervisor raises it, opens the socket once per process (a `OnceLock`, for every start in
      the process), and drops it at the top of `run_supervisor_blocking`, before the runtime has a
      thread.
    - `NoNewPrivileges=`, or a directive that implies it, turns it off: the unit test refuses those.
- **The update helper watches a switch for CRASHES, never restarts** (`helper.rs` `Watch`, #369, 0.1.4).
  - Linux counts systemd's `NRestarts`. A `systemctl restart` (an administrator's, or needrestart's after
    every library unattended-upgrades installs on Ubuntu) never moves it.
  - Windows counts a process only when it was seen STOPPED with an error, which the SCM's recovery
    (5/30/60 s) holds long enough for a once-a-second look. Never "an orderly stop was seen": our stop
    lasts about a second and is easy to miss.
  - Before #369 any new PID counted. The first update lane lost a good 0.1.3 to needrestart, and it
    was then never switched to again on that machine.
  - ⚠ The helper runs the LAST KNOWN GOOD version, never the one it watches. A fix to the helper
    guards only switches made after it is the last known good version: the lanes proved #369 with a
    test-only 0.1.5 over 0.1.4.
- **"Clean" is the API SERVING, by its own account** (`helper.rs` `health_from`, 0.1.4).
  - It reads `api.ok` and `api.uptimeSecs` from the API's `/status` over its control socket, which
    exists only once the API serves. It never reads whether the API child's process runs.
  - The first 0.1.4 rollback lane's helper reported "the previous version runs" while that API sat
    behind a migration lock, alive and serving nothing. A version whose API never answers is now
    never confirmed: it reaches the 20-minute deadline instead.
- **A library a security update replaced runs from a restart IN PLACE, at night** (`night_restart.rs`, #370).
  - The .deb's conffile `/etc/needrestart/conf.d/lgr-server.conf` tells needrestart never to restart
    lgr-server.
  - Instead, the supervisor finds deleted executable mappings under `/usr`, `/lib` and `/lib64` in itself and
    every process under it. Inside `UPDATE_WINDOW` (no till session, no fiscal command, no watched switch,
    once a night) it stops its children as a service stop does and execs itself.
  - ⚠ It execs `/proc/self/exe`, NEVER `current`. A version a package switched to must run from the
    service's next START, where the update helper watches it.
  - The main PID stays, so `NRestarts` never moves. The unit's user `lgr` may not `systemctl restart`
    anything.
  - **Seven nights kept out by open tills raise an alarm** (#373, `Blocked`, the update gate's
    `ALARM_WINDOWS`).
    - Only a till, a fiscal command or an API that cannot say (`Decision::Busy`) counts its night.
    - It shows as `blockedNights`/`alarm` in the status, in the health frame (`nightRestart`), on the
      master's status page and on the server's row on lgrai.app, plus one WARN.
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
    rustls-native-certs), so a TLS-inspecting middlebox whose root came by GPO is trusted, plus the
    CA the service's `LGR_SERVER_EXTRA_CA` names: ⚠ the API calls global ITSELF (the feeds, the
    outbox, a move), so a root only the supervisor trusted left the API's calls failing.

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
replicate(schema, { class: 'R' })  // FR-20.62: what replicates (R, S, N or G): required
export const Foo = model<IFoo>('Foo', schema)
```

⚠ **Every model decides what replicates** (FR-20.62, `db/replication/declare.ts`): `R` the whole document
from its home, `S` split by field owner (home / global / node, on dotted paths, the most specific
wins), `N` never leaves the node, `G` people's or everyone's. Then `bun run gen:replication-meta` and
commit `db/replication/meta.generated.ts`: `unit/replication-meta.test.ts` fails the build on a model
with no decision, a stale file, or a split field with no single owner.

Models export both the interface (`IFoo`) and the model (`Foo`) from `db/models` barrel.

## One app, step by step (FR-24, #402)

`docs/fr/FR-24-one-app.md`. Phase 0 put POS inside invoicing; Phase 1 made every module the same pieces:
- **One app store** (`ui-shared/stores/app.store.ts`, the portal's superset). Each package's
  `store/app.store.ts` only re-exports it. `logout` / `fetchProfile` keep each side's behaviour
  (`onPortal()`): a domain page goes to the portal's sign-in, the portal's router handles its own.
- **A module is a manifest** (`<pkg>/src/manifest.ts`, POS: `invoicing-ui/src/pos/manifest.ts`;
  type `ui-shell/module`): id, base, menu (i18n keys, data), routes, `outside` routes, pendingChanges.
  Routers are `moduleRoutes(manifest, layout, BASE_URL)`; each `DefaultLayout.vue` is `<ModuleLayout>`.
- ⚠ **Paths in routes, menus, breadcrumbs and back-to are relative to the MODULE** (`/orders`), never
  to a router base. `inModule(route, to)` adds the path of the module's shell record (`meta.module`).
  `unit/module-manifests.test.ts` resolves every one of them against its module's own routes.
- ⚠ **Every move goes through `ui-shared/nav/navigate.ts#goTo`**: a router push when this SPA serves
  the path, a page load otherwise. A page load drops a browser till's printer. Plain `<a href>` into
  this SPA follows the router (`installInAppLinks`, from `registerPlugins`). `unit/navigation-seam.test.ts`
  fails on any `window.location` assignment outside its list of deliberate page loads.
- `openPage` to the same view is a push plus a remount (`viewKey`), never a page load.
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
  - ⚠ **A report never touches a receipt the driver is still printing** (2026-10-31): X, Z and the fiscal-memory
    reports read the status, deal with an open receipt and print in ONE turn of the command queue. A receipt THIS
    driver is printing (`receipt` / `textReceipt`) refuses the report (`busy` → HTTP 409 `receipt_open`): they used
    to clear it like a new sale does, and the POS and the device page share the driver, so an X pressed mid-sale
    voided the sale, or cash-completed it once part-paid. One it is NOT printing (server stopped, bridge dropped
    mid-sale; a reconnect is a new driver) is cleared as a sale clears it (`clearOpenReceipt`) and the report
    prints: refusing it stranded the till, whose close runs this Z. ⚠ Only the driver's own state tells the two
    apart (`fiscalOperation()` counts, it does not lock): a receipt is counted BEFORE its 90h/26h is sent, and let
    go once closed, voided, or (text) a line fails. A POS close whose Z is refused this way answers 409
    `receipt_open`, leaves the device's status alone and puts the session back to `open` with no failure on it:
    closing again once the sale has finished works. Every other Z failure stays 503 `fiscal_error` + device `error`.
  - v1.1.7 has NO command to read an operator back (66h only sets one), no operator report and no КЛЕН print —
    never add a method that pretends. Operators 1–16; payment slots P N C D I J K L M Q R (35h/55h).
  - **Cash on delivery** = `FiscalPaymentType` `cash_on_delivery` → reserve slot **`R`**, named „НАЛОЖЕН
    ПЛАТЕЖ" from the device page (55h, admin only). Every other driver refuses it via `paymentCode()` — the
    drivers' old `table[type] || 'P'` printed any unmapped payment as cash.
- **The till's tender** (`invoicing-api/lib/cash-register-till.ts`, 2026-10-31) is checked BEFORE anything is
  written, so a refused sale draws no number and no УНП, at every door that prints: the till's sale, both storno
  routes, and the back-office sale joined to a session (D-13).
  - ⚠ `toFiscalPaymentType` has **no default** (`FiscalPaymentMethodError`). Everything unknown used to print as
    cash, so a bank transfer on a joined sale was recorded by the device as cash taken. `mobile` stays card;
    `check` is gone (no document can hold it, and at the till it would have burned a CS number at the insert).
    A method no receipt can carry is 422 `payment_method_not_fiscal`. The tender's `method` is a plain string in
    the till's schemas on purpose: a schema union would answer that with its own generic 422.
  - **Cash on delivery at the till** tenders exactly the total and nothing beside it (422
    `cod_amount_mismatch`): a short tender would be booked as cash taken (`keptByMethod` calls the rest of a total
    cash), and an over-tender would give change out of a drawer that took nothing. A device without
    `capabilities.cashOnDelivery` refuses it (422 `cod_not_supported`), on a text receipt too; a joined sale that
    asks for no receipt prints nothing, so nothing refuses it.
  - ⚠ The courier holds that money, so it is **never in the drawer**: `POSSession.totalCashOnDelivery`, its own
    bucket, out of expected cash. The close's `cash_on_delivery` line carries `expected` only (no `counted`, no
    `difference`), and only when there is something to expect. The session report has its own line
    (`cashOnDeliveryOf`). The session JE leaves it in "POS Other" on the receivable account, unchanged. The back
    office's cash-sale form still does not offer it (`usePaymentMethods({ cashOnDelivery: false })`).
- **`capabilities.ts`** — what each DRIVER can do (which reports, operator read/program, text receipts,
  payment-name programming, COD, max operators), resolved from manufacturer × connection type exactly as
  `createPrinter` / `createBridgePrinter` choose the class. Served on `GET /fiscal/device[/:id]`; the device page
  disables what is off with its reason (`protocol` / `driver` / `no_driver`). ⚠ `unit/fiscal-capabilities.test.ts`
  holds the table to the classes: a feature is on ⇔ the class has its methods — add the method, then the flag.
- **`errors.ts`** — `fiscalFailure(e)`: a driver error as an HTTP answer (input 400, unsupported 400, device
  refused / receipt open 409, unreadable answer 502, not connected 503, timeout 504). The device endpoints used
  to answer 500 to everything.
- **`device-command.ts`** — `onDevice` and `printDeviceReport`: one command on a device, and the X, fiscal-memory,
  КЛЕН and operator reports, as an API answers them. In `fiscal` because two controllers print them and
  `invoicing-api` cannot import `portal-api`. ⚠ It has no Z: on the device page that is its own route, and from
  POS Sessions it does not exist (a Z outside the close makes the next close print zeros).
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
- **POS Sessions prints a device's reports**: `POST /trade/pos/session/:id/device-report` (`kind`: `x`, `fm_date`,
  `fm_number`, `ej`, `operator`), and `GET` of the same path for what the menu offers. A closed session prints on
  its `fiscalDeviceId`; an open one on its warehouse's device, found as the close finds it (`resolveFiscalDeviceForClose`).
  An X is for an open session only (409 `session_not_open`: it reads the device's day as it stands). Roles are the
  device page's, so `sales` gets 403, and the route has its own `self` rule in `route-permission` because
  `warehouse_manager` runs devices with no `pos.write`. Capability first (400 `unsupported`, nothing sent), then
  input, then 409 `fiscal_device_not_connected`; driver errors through `fiscalFailure`. Audited on the session.
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
  - The device page's commands — `/x-report`, `/fm-report`, `/operator-report`, `/ej-report`, `/program-operator`,
    `/read-operator`, `GET|POST /payment-names` (POST admin only) — go through `onDevice()`: a feature the driver
    lacks is 400 `unsupported` with the reason and nothing sent, then input checks (400 `bad_input`), then 503 when
    nothing holds the device; a driver failure maps through `fiscal/errors`. Tested in
    `integration/fiscal-device-reports.flow.test.ts` (HTTP answer AND what reached the simulator).
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
  `bridged_by_desktop`, `desktop_revoked`, `key_rotated`, `org_moved`). ⚠ An unauthenticated socket is closed
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

### One app, several pods (FR-24, planned)

The direction is the opposite of splitting the API by domain: `docs/fr/FR-24-one-app.md` merges the eight SPAs into one build at the same URLs, and makes the one API process safe to run as several pods. The domain `*-api` packages have no server of their own.

⚠ **`replicas` must stay 1 until FR-24 Phase 6 ships.** A bridged printer lives on one pod, and `getFiscalContext` reads "not connected in this process" as offline: with two pods, sales landing on the other pod are refused by the printer gate, or go through with no receipt where the gate is off.

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

- **Per-user grid columns** (visibility + reorder) on EVERY `ListScaffold` grid: `ui-shared/composables/useGridColumns.ts` (localStorage `lgr:grid-cols:<userId>:<orgId>:<gridId>`, gridId = route name) + `GridColumnPickerDialog.vue`; a cog in the results header opens it. userId read from the JWT in localStorage (no app-store coupling). Grids NOT on ListScaffold (e.g. `StockLevelsView`) don't get it yet. ⚠ A saved order exists only after a MOVE and then wins, so a new default order reaches only users who never reordered; a column the saved order has never seen goes right after its catalog predecessor (`orderColumnKeys`, FR-22.46).
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
- **Availability precision** (`invoicing.service.ts` + `stock-transfer.service.ts`): reservation-backed lines are exempt via a per-RES **budget per validation call** (`loadReservationBudgets`: the RES's hold — open = qty − dispatched, and for an order-source RES also capped by its allocation's received − Σdispatched, 0 while the ORDO isn't holding, one pool per allocation — shared across the doc's lines: N lines on one RES can't each claim the full hold; excess competes for free stock). ⚠ Until FR-22.5 an order-source budget ignored receipt, so an invoice dispatched a sent-but-unreceived ORDO's units: stock 404 → −10 (B-7). `checkCrossWarehouseAvailability` + `/stock-availability/check` accept per-line `reservationId` (both UI callers send it). Invoice POST/PUT guard `validateReservationLineRefs`: only outgoing sales invoices may reference reservations (bills/cash sales/notes → 422) and Σ live invoiced per RES ≤ RES.quantity (422 with remainder).
- **Controllers**: `order.controller.ts` — CRUD + `/send` `/cancel` (live-invoice check spans doc orderId + line orderRef.orderId + RES invoiceIds; cascades RES with `external_order_cancelled`, returns `affectedInternalOrders`) `/complete` (releases open RES remainders) `/release` (legacy alias → RES cancel) `/convert {contactId}` (over RES docs via shared `lib/reservation-convert.ts` builder — same `planConversion` rule as the ORDI convert) `/peek-next` `/export` (internal sheet reads `ctx.reservations` grouped by allocationId); PUT guards allocations against Σ non-cancelled RES (409). `internal-order.controller.ts` — CRUD + `/confirm` `/complete` `/cancel` `/convert` (open RES → one draft invoice, doc `internalOrderId`, per-line full orderRef incl. `orderId`; only what can be dispatched: `planConversion` caps an order-source RES at its allocation's received − dispatched − what live drafts claim, returns the rest as `waiting`, and answers 422 `awaiting_receipt` instead of an empty draft) `/reserve-available` `/suggestions` `/generate-external` `/peek-next`; PUT guards lines vs Σ RES/delivered. `reservation.controller.ts` — list (enriched names + computed late/shortage flags) + create/cancel/preempt. All mounted in `unified.ts`.
- **Invoice model**: doc `orderId`/`orderGroupId`/`internalOrderId`; per-line `orderRef {orderId?,groupId?,lineId?,allocationId?,reservationId?,internalOrderId?,internalOrderLineId?}` (all-optional) + `sourceText`; indexes on `{orgId,orderId}`, `{orgId,internalOrderId}`, `{orgId,'lines.orderRef.reservationId'}`. The form round-trips orderRef verbatim (document-payload).
- **Migration**: `scripts/migrate-order-reservations.ts` — preflight (embedded `_id` uniqueness, loud failure; display-sentinel copy) → `--execute` UPSERT (RES doc per embedded subdoc, **preserving the subdoc `_id`** so historic `orderRef.reservationId` resolve; closed orders normalise qty to max(invoiced, dispatched); qty-0 `/release` leftovers → cancelled('released'); re-runs refresh counters) → deploy → `--strip` (re-upserts, verifies per-(product,WH) hold parity, empties embedded arrays, re-materialises StockLevels). Zero hold-loss sequence: execute → deploy → strip.
- **ORDO-aware purchase import**: unchanged mechanics — `POST /bills/import/draft` accepts `orderId`; ladder alias → exact → AI-vs-order-candidates; bills carry `orderRef {groupId,lineId,allocationId}` (NEVER reservationId — 422). Skill `.claude/skills/import-purchase-invoices/` + `scripts/import-purchase-invoices.ts` are prefix-agnostic (resolve by number search). **Ops:** ORDO-received deliveries must not ALSO be booked by the daily `receive-stock` import.
- **UI** (labels renamed 2026-10-25, see the next section: Internal → **Incoming**, External → **Outgoing**): nav group "Orders" → Internal Orders (`/internal-orders`, InternalOrdersView + InternalOrderFormView with coverage chips, Reserve-from-stock, Cover-shortages dialog (free stock / incoming / preempt with confirm), Generate-external dialog with supplier hints), External Orders (`/orders` — paths/route names unchanged for e2e; OrderFormView: allocation editor + read-only RES panel + per-allocation Reserve-for-client dialog; convert dialog fed by linked RES), Reservations (`/reservations`, ReservationsView with source/late/shortage indicators + cancel). Sequences page groups: order/internal_order/reservation. i18n ×4 (en/bg/de/mk): nav keys, `invoicing.status.{confirmed,partially_delivered,delivered,active,fulfilled}`, priority/coverage/preempt blocks.
- **Tests**: `order-reservations.flow` (7-case behavioral contract over RES docs), `order-import.flow`, `order-sheet-export`, `reservation-migration.flow` (preserved ids, upsert refresh, hold parity, strip), `internal-order.flow` (budgeted exemption incl. N-lines-one-RES, delivered statuses, void-after-complete no zombie hold, cascades), `reservation-preempt.flow` (partial/concurrent preempt, suggestions ranking, generate-external rollback, cross-WH exemption).

## Orders: client reservations where the order is (2026-10-25, #203)

- **Names.** In all four UI languages the ORDI is an **incoming order** (bg „Входяща поръчка", de
  „Eingehende Bestellung", mk „Влезна нарачка": the client's order comes IN) and the ORDO an
  **outgoing order** („Изходяща поръчка": ours goes OUT to the supplier); the API's messages say the
  same. ⚠ Only words changed: the models (`InternalOrder` / `Order`), the paths
  (`/internal-orders`, `/orders`), the route names, the i18n KEYS (`nav.internalOrders`,
  `nav.externalOrders`), the counters and the ORDI/ORDO prefixes are untouched.
- **Reservations are staged in the ORDO form and saved with the order** — the form no longer posts
  each one at once, which is why a NEW order could not take any. `POST`/`PUT /invoicing/orders`
  accept `reservationChanges: {create[], update[], cancel[]}`
  (`services/biz/order-reservations.service.ts#saveOrderWithReservations`) — ⚠ not
  `reservations`, the deprecated embedded array the controller still ignores. A create names its
  allocation by `allocationId`, or by the `clientKey` of an allocation added in the same save:
  `assignSubdocIds` gives the new subdocuments their ids before the write so the reservation can
  point at one. One transaction holds the order and every change; a refused change saves nothing.
  - `planOrderReservations` (pure) keeps an allocation at or above what its live reservations hold:
    untouched in this save → the legacy **409** message ("…cancel or preempt them before shrinking"),
    changed in this save → **422** naming the allocation.
  - The form keeps `staged {creates, updates, cancels}` and shows them in each line's own
    **client-reservations grid**, a nested, collapsible row under the line, separate from the
    allocation editor, grouped by allocation with „Резервирай за клиент" per group. Its status column
    reads "new" / "cancelled on save". A line holding live reservations opens that grid by itself.
    The open/closed state of both expanders survives the reload after a save (`wasOpen` in
    `loadOrder`), and neither counts as an edit (`_expanded` / `_resExpanded` are kept out of the
    pending-changes snapshot). The P7-who walk reads the grid as the row right under the line. ⚠ After a save
    the staged changes go **in the same tick** the reloaded reservations arrive
    (`loadOrder(id, { clearStaged: true })`): clearing them before the request left the allocation
    empty while the order reloaded, and whatever was typed in that window was lost — the e2e caught
    it. Complete / Cancel order drop them too (a closed order can never save them); Send keeps them.
- **Change, and reserve again.** `POST /invoicing/reservations/:id/update {quantity?, contactId?}`
  (`updateReservation`): never below the consumed `max(invoiced, dispatched)`, raised only within
  free stock / the allocation's free room / the ORDI line's open demand; the client changes only
  while nothing is consumed and no ORDI fixes it. `POST /:id/repeat` (`repeatReservation`) makes a
  cancelled reservation again as a NEW numbered one carrying `repeatOf`. ⚠ The unique partial
  index `{orgId, repeatOf}` is what makes that once-only: a second click answers the first copy
  with `created: false`.
- **Where a product stands**: `GET /invoicing/product-supply/:productId`
  (`services/biz/product-supply.service.ts`; read rule: invoicing OR inventory read) → per warehouse
  onHand / reserved / available / incoming / reservedIncoming / planned, the expected deliveries (sent
  or partly received ORDO lines, outstanding quantity, the clients holding it) and the product's
  reservations. A draft ORDO is `planned`, never `incoming`: nothing was ordered yet. Shown on the
  product's Stock tab (`inventory-ui ProductStockView`), linking into invoicing via `appHref`.
- **On the Products list** (FR-22.45/.46/.48): `GET /warehouse/stock-level/by-products`, the call the
  list already made for its stock badges, also returns `supply: {[productId]: {reserved, incoming,
  reservedIncoming, planned}}` from `getProductsSupplyTotals`. It runs the stock tab's own steps
  (`loadSupplyDocs → incomingAllocations → warehouseFigures`), so there is no second definition of
  "reserved" or "incoming", and three queries serve a page of any size. With `warehouseId` the badges
  AND the totals describe that warehouse only. „Резервирано" / „Поръчано" follow „Наличност", which
  now precedes „Мярка"; each non-zero figure opens the stock tab. `GET /warehouse/product?isActive=
  true|false` (`true` is `$ne: false`: a product without the flag is active); without it, both, as
  every picker expects. The list defaults to active articles (`status` in the URL, a declared
  default), and shows its „Активен" column only when deactivated ones can be listed: that width is
  what keeps the row actions inside 1366 px. Tests: `integration/products-supply-list.flow.test.ts`
  (parity with `getProductSupply`, 5 queries for 5 or 50 products), `unit/grid-column-order.test.ts`;
  the P1 walk goes 6 → 5 clicks through the figure's link.
- **Lists and the ORDI form.** ReservationsView: Source is the ORDO number (linked) or "Stock", the
  ORDI is linked, quantity edit (`ReservationQuantityDialog`) and reserve again, `source` filter in
  the URL. InternalOrderFormView: each line's reservations in a sub-row; a reservation action
  refreshes only the reservations and the derived quantities (`refreshReservations`) — the
  whole-form reload it used threw unsaved line edits away.
- `DELETE /orders/:id` (drafts only) cancels the draft's reservations (`external_order_cancelled`)
  instead of leaving them pointing at a deleted order.
- **A reservation has a screen (FR-22.37).** Made on the Reservations list
  (`ReservationCreateDialog`), opened at `/reservations/:id` (`ReservationDetailView`, fed by
  `GET /reservations/:id` → `{reservation, detail}`: order + allocation, ORDI + line, every invoice
  naming it in any status with the quantity it takes, repeat-of / repeated-as, preempted from / to,
  user names). Every RES number links there, the product's stock tab through `appHref`.
  - The dialog offers only `GET /reservations/sources?productId=&contactId=`
    (`getReservationSources`), computed by the create's own rules: free stock per active warehouse,
    room on allocations of sent / partly received ORDOs, the client's open ORDI lines.
  - ⚠ `/reservations/new` (the „+ Нов" entry) is a REDIRECT to the list with `?new=1`, which the
    list strips once the dialog is open. A route rendering the list itself would give the grid
    another route name: the key of its column preferences and of its remembered filters.
  - Refusals carry a code: `ReservationOpsError(status, message, {code, …figure})`, spread into
    the body and said through `invoicing.reservations.errors.<code>` (`reservation-errors.ts`),
    inside the dialog. The English message is unchanged. `unit/reservation-screen.test.ts` fails when
    the service sends a code the UI does not know.
  - A release is `/cancel` with an explicit quantity, so one that raced an invoice is refused rather
    than freeing something else. All of an unconsumed reservation cancels it; anything less lowers
    it. Buttons „Не" / „Освободи резервацията", the same dialog in the ORDI form (no `confirm()`).
  - `POST /:id/repeat` takes the changes D-4 routes through it (another warehouse, client or
    order): a body naming `source` replaces the supply, one naming `contactId` / `internalOrderId`
    the demand (a client alone drops the ORDI link). Never the product, and still once. A one-click
    repeat refused for a shortage opens the create dialog in repeat mode, the shortage named (§5.7).
- **The order forms (FR-22 slice 4b).**
  - **Coverage has one rule**, `config/order-coverage` (`lineCoverage` / `orderCoverage`), used by
    the ORDI list, the ORDI GET and the form: `full` when what is HELD covers the line, `ordered`
    („Поръчана") when the reservations cover it but part waits on a DRAFT ORDO, else `partial` /
    `none`. A sent ORDO's reservation counts as held. ⚠ `onUnsentOrderQuantity` (per line),
    `reservationCoverage` and `shortQuantity` are derived on READ (`onUnsentOrders` in the
    controller), never stored: sending the ORDO changes them without touching the ORDI.
  - ⚠ **What the server derives per ORDI line (reserved, on unsent orders, invoiced, delivered)
    lives in `lineFigures`, OUTSIDE `form`.** The pending-changes snapshot is the form; a reservation
    action or Convert changes those figures with no edit, and inside the form they made an untouched
    order read „Незапазени промени" (FR-22.13). Both order forms re-take the snapshot after every load
    (`snapshot()` of `usePendingChanges`); the ORDO form only while nothing is staged.
  - The ORDI form opens a blank line once the last one gets an article; lines without an article
    are never sent (`productId` is required). „Резервирай от склад" names the lines it could not
    cover from the response's `short[]`, also when nothing at all was free.
  - `POST /internal-orders/:id/generate-external {orderId?}` appends to a DRAFT ORDO of any supplier
    (a new supplier gets its own group; a target that is not a draft answers 422 `order_not_draft`). The dialog
    preselects the newest draft carrying every supplier of its rows (`order-generate.ts`), else a
    new order, and shows each row's warehouse: the ORDI's, else the default one.
  - Hand-offs land on the next document (FR-22.35): generating opens the ORDO, Convert opens the new
    draft invoice and its message still says what stays reserved. Both forms list their invoices
    from `lookup.invoices` (`OrderInvoicesCard`, FR-22.36), each opening in its own form.
  - Cancel and Complete confirm first (FR-22.41, `OrderCascadeDialog`) with what they release,
    counted by `order-cascade.ts` on the server's rule (`reservationReleasable` > 0 on a reservation
    not cancelled): an ORDO names the ORDIs it lets down, an ORDI says what sits on stock and names
    the ORDOs. Cancel always asks; Complete asks when it releases something (the ORDO: or when
    changes are staged). Both still run through `doAction`, which drops staged changes.
  - The ORDI and ORDO actions pass the service's `{code, …figure}` through like the reservation
    endpoints; the ORDO's own cancel refusal is `order_has_invoices` (`ORDER_ERROR_CODES`).
  - The Reservations list's `search` matches the RES number, and the clients, articles (name or
    SKU) and ORDO / ORDI numbers it matches first — each resolved to at most 500 ids.
- **Tests**: `integration/order-form-reservations.flow.test.ts` (12), `integration/reservation-screen.flow.test.ts`
  (10), `integration/order-screens.flow.test.ts` (6), `e2e/tests/orders-reservations.spec.ts` (3),
  `e2e/tests/reservations-page.spec.ts` (5), `e2e/tests/order-forms.spec.ts` (10). The FR-22
  walks take the shorter routes and assert them (`e2e/tests/ux-budgets/p7-*`):
  P7-chain 27 → 26 clicks (the ORDO number is a link on the ORDI) → 18 (slice 4b: an article opens
  the next line, each hand-off lands on the next document, the invoice is issued on its own form),
  P7-repeat 4 → 3 („Резервирай отново" on the row), P7-who 2 + a second page → 1 (answered on the
  ORDO), P7-new 4 (a reservation made on the list). `e2e/tests/orders-product-autocomplete.spec.ts` (in `invoicing-inventory` since
  2026-10-27) checks the product search on both order forms: server search, ↓ keeps the results
  open, Enter picks. The invoice form's copy is `invoicing-product-autocomplete.spec.ts`.

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
then set `stockSource.marker`, which is what `movesNoStock` reads to stop a re-dispatch. Since
2026-10-28 that repair is a button: „Към касова продажба…" on the invoice attaches it to the day's
cash sale (FR-21 §11, see "Invoice for a cash sale").
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
7. **`locator.isVisible({ timeout })` does not wait.** Playwright ignores the option and answers
   at once, so a guard on it skips its test, or drops its step, whenever the page is still
   rendering, and the run stays green. Use `tests/helpers/vuetify.ts#appears`. A green run says
   what it skipped and what only passed on a retry in its job summary
   (`e2e/scripts/night-summary.ts`): read it. #408 tracks the 94 conditional sites left.

## DIN/ISO Fastener Catalog + Product Tagging (2026-08-03)

Global reference collection **`din_catalog`** (model `DinCatalog`, no tenantPlugin — like ExchangeRate; explicit collection name) holds 165 DIN↔ISO/EN rows in 12 Bulgarian categories from the „DIN ↔ ISO/EN разширен каталог крепежни елементи" DOCX; data committed at `scripts/data/din-catalog.json`. `scripts/seed-din-catalog.ts` upserts it and (with `--org`) creates the 12 `ProductCategory` docs. `scripts/assign-din-tags.ts` derives **product tags from NAMES** — `DIN 933` (+whitelisted variants 7504-K/M/N/O/P/R, 125-A/B, 7380-1/2, 976-1; junk-proof against "- K 8.8" class markers), catalog cross-tags (`DIN 933`→`ISO 4017`, `EN 14399-4`→`DIN 6914`), canonical Cyrillic dimensions (`М8Х25`/`Ф90Х529`/`6Х70`, pipe fractions `1/2Х3/8` excluded), coating/material/strength (`ZN`/`BL`/`HDG`/`YELLOW ZINC`/`A2`/`A4`/`МЕСИНГ`/`6.8|8.8|10.9|12.9`) — via `$addToSet` + Tag vocabulary upserts, and **recategorizes** catalog-DIN products (first DIN wins; only out of „Общи"/the 12 unless `--force-category`; sets category+categoryId+categoryLower explicitly since bulkWrite bypasses loweredFieldsPlugin). Extraction: `packages/services/src/biz/fastener-tags.utils.ts` (import-pure; tests `packages/tests/src/unit/fastener-tags.test.ts`). ProductsView category filter now loads from `/warehouse/product-category` (was: derived from first page of products). Ops: re-run assign-din-tags after `receive-new-products`; after `seed-products --clean` re-run BOTH scripts (clean wipes tags+categories). Skill: `.claude/skills/assign-din-tags/`. ⚠ Bun transpiles Cyrillic regex literals to `\uXXXX` — never send them to Mongo as `$regex` (PCRE2 error 51091); query tags by equality.

⚠ **A product carries its category twice**: `categoryId`, which the form edits, and the `category` name that lists, reports and imports read. Some articles carry only the NAME: on 2026-10-26, every product of the `regal` org and of the acme seed. On load, `ProductFormView` links such a name to the one category that carries it. Otherwise it shows the name as the field's placeholder and keeps it on save, and only clearing the field drops it. Until 2026-10-26, saving such an article wrote `category: ''` (regression test: `e2e/tests/product-category.spec.ts`).

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
  on a fiscal error. The one exception is a Z the driver refused because a sale is printing on
  it: nothing failed, so 409 `receipt_open`, the device untouched, and no failure on the session.
- `fiscalStatus: 'skipped'` when the warehouse has **no** active device (regal may run without
  one). A device that exists but fails is never silently skipped — only `closeWithoutFiscal`
  bypasses it, and only for admin/manager.
- Model: `closingBreakdown[{method,expected,counted?,difference?}]`, `fiscalStatus`,
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
- UI: `invoicing-ui/src/pos/components/CloseSessionDialog.vue` — per-method expected/counted/difference
  rows modeled on the legacy screen, three visually distinct outcomes.
- `erp.service.closePOSSession` was the old duplicate, `@deprecated` with only its own tests as
  callers. It and the other `erp.service` POS functions were deleted in FR-21 R3, once
  `postransactions` was frozen.

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

## Invoice for a cash sale (2026-10-25, #171 / #203, FR-21 D-14 / §3.9)

„Издай фактура" on a paid cash sale issues the customer's invoice for it:
`GET`/`POST /org/:orgId/invoices/:id/to-invoice`, `services/biz/cash-sale-invoice.service.ts`, the dialog
`invoicing-ui/src/components/CashSaleInvoiceDialog.vue`.

- The cash sale moved the goods and took the money; the invoice is the tax document of that sale.
  So it **moves no stock** (`stockSource` = `cash_sale:<number>`), is **born paid** (payment rows
  with `origin: 'cash_register'`, no `payment.recorded`) and **posts no journal entry** (`/send`
  emits no `invoice.posted` for it; the handler and `syncCashSettlement` skip it too).
- ⚠ **Only the invoice stores the link** (`cashSaleRef`, `lines[].cashSaleLineId`). Nothing is ever
  written to the cash sale (FR-20.51): its invoices are a query on `{orgId, 'cashSaleRef.cashSaleId'}`.
  ⚠ The DAL's entity mapper drops nested `_id`s, so cash-sale line ids come from Mongoose, never
  from `getRepos()` documents (`invoicingByCashSale` takes ids for that reason).
- Quantities: a cash sale that **names a customer is invoiced whole, once**; one without (an imported
  till day, a walk-in) **in parts**, never beyond what was sold. Each line is a budget across live
  invoices, drafts included. Claims are inserted under a `~pending:` number and checked in `_id`
  order — the earlier claim wins, a later one that does not fit deletes itself — so nothing locks
  the sale and a refused request burns no SALES_DOC number.
- ⚠ **Every reader counts the sale once** (`services/biz/sale-counting.ts`): totals count the cash
  sale and skip invoices with `cashSaleRef`; per customer the invoice counts for its customer and
  the cash sale stops counting for its own contact. Applied in sales history, the digest (KPIs,
  FR-11.10, FR-11.11), the product and contact ledgers and the dashboard's paid-30d. The sales
  register keeps the invoice (new `cashSale` column, `meta.forCashSales`). **A new reader of
  sales must use the helper**, or it counts an invoiced cash sale twice.
- Credit and debit notes against such an invoice are **ordinary** (owner, 2026-10-25): a credit note
  returns the goods and counts negative. `cashSaleRef` is only ever on type `invoice`.
- Guards: an issued one keeps the sale's lines and dates (customer and text may change); a draft may
  invoice less; `/void` accepts `paid` and releases the quantities; a cash sale's lines cannot
  change while an invoice points at them (409 `cash_sale_invoiced`); the Files rollback of such a
  sale is blocked; `POST`/`PUT /invoices` strip the link from any other document.
- The PDF prints „Към касова продажба № … / дата" and `taxEventDate` (the sale's date) as
  „Дата на данъчното събитие". „Словом" is written server-side (`config/amount-in-words`).
- Also fixed on the way: every document form took its "clean" snapshot on a 500 ms timer, so a slow
  load counted as an edit and leaving an untouched document asked about unsaved changes —
  `loadDocument` now re-snapshots when it finishes.
- **Attaching an invoice that already exists** (2026-10-28, FR-21 §11): „Към касова продажба…" on
  an issued sales invoice written before the day's till export arrived — the till sold the goods,
  the invoice dispatched them again. `GET /invoices/:id/cash-sale-candidates` (the cash sales of
  its day it fits), `POST /invoices/:id/attach-to-cash-sale {cashSaleId}`, the dialog
  `invoicing-ui/src/components/AttachToCashSaleDialog.vue`. Attached, it becomes what R0 issues:
  its dispatch comes back ONCE (a reversal at cost, noted „Attached to cash sale …"), then it
  carries `cashSaleRef` and the `stockSource` marker, is paid by the till (`cash_register`
  payments replace `cash_on_issue`/`card_on_issue`, whose entries are retired), and its
  `taxEventDate` is the sale's date. Its number and amounts never change.
  - It fits a sale of the SAME day (UTC date) that sold every one of its lines, within what that
    sale has not invoiced yet. Against a single sale (till or back office) a line must match the
    article, price (½ cent), discount and VAT. ⚠ **An imported till day matches on article and VAT
    only**: it carries one line per article at the day's AVERAGE price (1,899 of 3,418 regal lines
    are priced beyond the cent), so 9 of the 82 snapshot-verified overlaps (2026-10-28) differed in
    price from their own invoice. With that rule all 82 fit.
  - ⚠ **Its claim comes LAST** (`fitsAsLast`), not in `_id` order: the invoice existed before the
    claim, so its older `_id` would let it in over a newer conversion (`overClaimed` checks a
    claim only against older ones).
  - ⚠ **Overlaps repaired by hand before this button attach too**: dispatch reversed, then
    `stockSource.marker` set to the till day's `reference` (`salesAnalysis:<date>`). They need it,
    because without `cashSaleRef` every total counts those sales twice (83 such invoices on
    2026-10-28: 82 in regal-sf, 1 in regal-pz). Such an invoice attaches to that day only and nothing is reversed again. If its
    dispatch is not all back, it is refused (`attach_needs_attention`): with a marker set,
    `reverseInvoiceStockMovement` does not even run (`movesNoStock`). The old marker and its
    arbitration note go into the audit entry.
  - Refused, never guessed: a draft (issue from the sale instead), a payment entered by hand, an
    invoice that serves an order or moves no stock for any other reason, and one whose OWN journal
    entry is posted (`invoice_in_ledger`: void it first). ⚠ A payment's entry carries the invoice as its
    `sourceId` too, so `ownEntriesOf` leaves out the entries the invoice's payments name; an own
    entry still in draft is voided on attach.
  - Claim (with `leaseUntil` on the invoice) → storno re-read → fit → reverse → finish. A retry of
    the same pair resumes once the lease lapses; a dispatch that is partly back already refuses
    (`attach_needs_attention`) rather than reversing twice. ⚠ There is no detach. A void frees the
    sale's quantities but moves nothing (the dispatch came back on attach), so an invoice attached
    by mistake — a separate sale after all — needs a new invoice that dispatches its goods.
- Tests: `integration/cash-sale-invoice.flow` (16), `cash-sale-invoice-readers.flow` (6),
  `unit/cash-sale-invoice` (12), `e2e/tests/cash-sale-invoice.spec.ts` (3); the attach:
  `integration/cash-sale-attach.flow` (10), `unit/cash-sale-attach` (9).

## A receipt first, then its bill (2026-10-26, FR-22 slice 3: FR-22.28–.33, #168)

Goods arrive before the supplier's invoice: a receipt books them, the bill comes days later. A bill
receives its own goods, so a bill typed in for them booked the stock twice (FR-22 B-4).
`services/biz/receipt-bill.service.ts`, routes `/org/:orgId/invoicing/bills/{from-receipt,
billable-receipts,:id/link-receipts}`.

- „Входяща фактура" on a completed receipt with a supplier makes a DRAFT bill from it (one bill may
  cover several receipts of ONE supplier, D-2). The bill carries `stockSource { marker:
  'movement:<ids>', detectedBy: 'manual' }`, so receive, issue, void and the Files rollback move no
  stock (`movesNoStock`). The receipt's `invoiceId` is the CLAIM, a compare-and-set: a receipt is
  billed once (409), and the product ledger names the bill next to it.
- ⚠ Void and DELETE of such a bill give the receipts back (`releaseReceiptLinks`, only the claims
  that bill still holds). A Files rollback of a receipt a live document stands on is blocked — for
  ANY `stockSource` link (§5.4).
- ⚠ PUT keeps the bill to what was received (D-2: billed once and whole): every stock-tracked
  quantity must equal the receipts' (422 `receipt_quantity_mismatch`), the supplier cannot change.
  Prices, text and lines that hold no stock (a fee, a service) stay free.
- Receiving it moves `purchasePrice` to the billed price for future receipts — only where it still
  equals the receipts' cost (a newer price stays); avgCost and cost layers are never re-costed, and
  posting is unchanged (FR-22's D-2 note).
- `POST`/`PUT /invoices` strip `stockSource` (Elysia's schema already drops it; this is defence in
  depth). `link-receipts` takes only an EMPTY draft: lines already on a bill would silently never be
  received once it is linked.
- ⚠ The warehouse report and the digest date a billed receipt by its OWN date
  (`warehouse-operations.report.ts#EFFECTIVE_DATE`): the bill's issueDate would move the delivery to
  the day its invoice came, and the digest would count it twice.
- „+ Нов продукт „…"" on a receipt or bill line: `POST /warehouse/product/quick`
  (`quick-product.service.ts`), built by doc-import's own `newProductDoc` (next SKU, tier template)
  at the org's currency and VAT, in „Общи" (made when the org has none). A name the catalog has, or
  has but for separators, is 409 with that article. The search offers creation only once it has
  answered for what is typed — offered earlier, a quick click created an existing article.
- Receipt form: „Към склад" from the user's pinned document warehouse (`lgr:default-wh:…`) else the
  org default; the product-update switch remembered (`lgr:gr-with-update:<user>:<org>`, both via
  `ui-shared/composables/useUserDefaults`); „Запази и потвърди" first; „Наличност" reads the
  destination on a receipt. `useGridNavigation` lives in ui-shared now.
- Tests: `integration/receipt-bill.flow` (13), `quick-product.flow` (2); walks P2 (17 clicks · 12
  typed · 0 hops) and P3 (3 · 1 · 1, stock unchanged).

## Issue, print and get paid on the document (2026-10-26, FR-22 slice 2a: FR-22.16–.22)

A sales document is finished on its own form: „Издай и печатай" saves it, issues it, settles a card
or cash sale and prints it — one click (P5-invoice 20 → 14 clicks, 2 dialogs → 0).

- **Save stays on the document** (every invoicing document form but the cash sale, which FR-21
  owns): a new one moves onto its own edit route. The views key `DocumentForm` on
  `document-form/useDocumentRouteKey`: a different document remounts the form (Vue Router reuses the
  view when only the id or query changes, so A's form used to stay up under B's address), and the
  form's own create keeps it (`onCreated` → `adopt`) — it goes on issuing or printing what it made.
  ⚠ `usePendingChanges`' leave guard now FOLLOWS the route record: `onBeforeRouteLeave` binds to
  the record of the moment, and after new → edit in the same form it never ran again. `markClean()`
  (called by `loadDocument`) re-arms it after a save that stays.
- **One issue path** (FR-22.17): `invoicing-ui/composables/document-issue.ts` holds the requests (the
  document, `/stock-availability/check`, `create-transfers`, `/send`) with no Vue in it — the
  integration test drives the same functions — and `useDocumentIssue` adds the transfer dialog, the
  idempotent `/send` and the messages. The sales list's „Изпрати", the form's „Издай" / „Запази и
  издай" / „Издай и печатай" and the cash-sale form's pre-create check (`useStockTransfer`) use it.
  A proforma is never stock-checked, nor is a credit note: its return brings the goods in. Refused, or the transfer dialog closed: nothing prints, and the
  draft says why (`issueError`).
- **„Печат" prints in one click** with the user's last settings (`lgr:doc-print:<user>:<org>`:
  format, mode, columns — never the companion documents); „Печат с настройки…" beside it opens the
  dialog on them (`ExportDialog` `initialColumns`). An edited document is saved first. A printed
  draft says ЧЕРНОВА, as one copy, without its DRF- number (`invoice.pdf.ts`).
- **Card is paid on issue like cash** (D-3): `syncCashSettlement` records `card_on_issue`; cash ↔
  card moves the automatic payment; hand-recorded payments are untouched; bank transfer and cash on
  delivery stay open. Card invoices issued earlier are settled by `scripts/settle-cash-invoices.ts`. It takes every
  method settled on issue, or one via `--method`, and is a dry-run by default; run it after this deploys. On 2026-10-26 that is
  regal-pz 173 and regal-sf 195, €23.8k shown as owed.
- **A proforma is issued** from the PROFORMA series and moves no stock on any path (`movesNoStock`),
  announces no `invoice.posted`; `/convert` carries the payment method, place of deal and tags, and
  Convert (form and list) lands on the new invoice's form.
- **A note from its invoice** (FR-22.21): „Кредитно известие" / „Дебитно известие" on an issued
  invoice or bill open `…/new?type=credit_note|debit_note&relatedInvoiceId=`, which starts as the
  invoice (`noteFromInvoice`: customer, the invoice, currency and rate, payment method, lines as
  sold). ⚠ The customer is set without `onContactChange`: its price re-resolution would replace the
  prices the invoice charged.
- Tests: `integration/cash-settlement.flow` (+7 card), `proforma-issue.flow` (6),
  `document-form-flow.flow` (6), `unit/invoice-pdf-form` (+4); walks P5-invoice 14 · 6 · 0 dialogs,
  P5-credit 5 · 1, P6 12 · 5 · 0.

## Document lists: one row menu, fit 1366 px, a Create that says what (2026-10-26, FR-22 slice 2b: FR-22.23–.27, .50)

- **One menu per row** (FR-22.23/.24): `ui-shared/RowActionsMenu` (⋮, `row-action-<key>`). The
  rules are `invoicing-ui/composables/document-row-actions.ts` — pure, and
  `integration/document-row-actions.flow` holds each one against the real routes. ⚠ Void is offered
  on an ISSUED document (`sent`/`received`; an invoice for a cash sale when `paid`) and asks first;
  Delete on a DRAFT only. The lists had it the other way round („Анулирай" on drafts only, Delete on
  every row). A row also offers Печат (one click, the last print settings —
  `composables/print-settings.ts`, shared with the form), Копирай (`?copyOf=` → `copyOfDocument`:
  partner, terms, lines; dated today, numbered on save) and, on an issued invoice, the credit and
  debit note. A paid cash sale offers no Void any more (the till's storno is FR-21's).
- **Fits 1366 px** (`ListScaffold` `fit`): one line per row, 8 px gutters, a long name `cell-clip`ped
  (12em, or `--cell-clip`; the whole text in `title`). ⚠ On the sales list „Свързана фактура" and
  „Проформа #" are ONE column, „Свързан документ"; Currency is `defaultHidden` on all three lists
  (every amount is printed with its currency) and so is a bill's „Свързана фактура".
  `useGridColumns` knows `defaultHidden` (the cog shows it again; `shown` in the saved pref). With
  the widest rows (a 60-character name, a partly paid note, a converted proforma) the bg tables need
  1135 / 1143 of 1300 px; de shortened two labels to fit. Measure before adding a column.
- **Partner picker** (FR-22.25): `GET /invoicing/contact?prefer=customer|supplier` (without
  `sortBy`) answers the side's partners of the last 365 days' documents, most recent first, then the
  rest of that side, then everyone else (`services/biz/contact-picker.service.ts`). Recency is the
  org's, not the user's.
- **Remembered per user and document type** (FR-22.26): the payment method
  (`lgr:pay-method:<docType>:<user>:<org>`), written when a NEW document is saved — editing an old
  one changes nothing; a cash sale's method is fixed and never remembered. „Последна цена за
  клиента" (`lgr:last-price:<docType>`) on the invoice and, now, the proforma.
- **Place of deal** (FR-22.27, D-7): every outgoing document but the cash sale. A new one starts at
  its warehouse's `address.city`, else the org's default address city, and follows the warehouse
  until the user types one. `/convert` carries it from the proforma.
- **Create says what it creates** (FR-22.50): `ui-shared/CreateButton` (`create-button`, ▾
  `create-more` for the others). The sales and bills lists offer the notes beside the invoice, and a
  list filtered to one kind creates that kind. The cash-sales list keeps „Създай" (FR-21's screen).
- Tests: `integration/contact-picker.flow` (5), `document-row-actions.flow` (8);
  `unit/grid-columns-default-hidden` (5), `unit/document-payload` (+3, `copyOfDocument`); e2e
  `document-lists.spec` (5). Walks P5-invoice and P6 assert the remembered method, the place of
  deal and the 1366 fit; P7-chain issues through ⋮ → „Издай", one click more than the old row icon,
  until the client order links its invoice (FR-22.35).

## FR-21 — one cash register (#171; R1–R5 on production 2026-10-27)

⚠ **R2 (#272–#274) is on master since 2026-10-26 and NOT deployed: the next deploy of master ships
it, whoever runs it.** That deploy needs four more steps (handover §5):
- the field check's baseline BEFORE it (`scripts/cash-register-field-check.ts`);
- `bun run migrate` on the build host after it (`0008-cash-register-copy`; `MIGRATIONS_AUTO` is
  off);
- the field check again;
- a device test in `acme-corp`.

FR-21 is Atanas's (@lazarovski) since 2026-10-26: `docs/fr/FR-21-HANDOVER.md` §0.

POS transactions (`/pos/orders`) and cash sales (`/invoicing/cash-sales`) are becoming one
cash-register document. The spec is `docs/fr/FR-21-cash-register-pos-and-cash-sales.md`; #171
tracks the steps. R1a (the correctness fixes the merge's parity checks depend on) has landed:

- ⚠ **One counting rule, `services/biz/cash-register/counting.ts`**: a sale counts whether or not it
  was stornoed, a storno counts negative, nothing voided counts. A POS sale is `cancelled` only by
  its storno, so skipping `cancelled` rows AND subtracting the storno took the sale out twice — the
  session JE and the sales history both did. `keptByMethod` is what a row left in the drawer: card
  and other as paid, cash the rest of the total (change goes back in cash). Every new reader that
  sums cash-register rows uses both.
- **The session JE** (`createPOSSessionJournalEntry`) balances by construction: revenue
  `total − taxTotal`, VAT `taxTotal`, money from `keptByMethod`. Over/short posts only against
  `settings.accounting.cashOverShortAccountId` (no UI sets it yet, like the other accounting
  defaults), as a balanced pair.
- **VAT has its own account** (#362): `settings.accounting.defaultOutputVatAccountId` takes the
  VAT of a sales document and of the session close, `defaultInputVatAccountId` a bill's. Unset, the
  tax line goes to the revenue / expense account, as it did before (no UI sets them yet either).
- ⚠ **No `POS-OUT` batch movement any more.** It was written `completed` without
  `confirmMovement`, moved nothing, and made SUPTO 18.8, FR-07 and FR-11.7c count every POS sale
  twice. Migration `0006` marks the old ones `recordOnly: true` and those readers skip the flag.
  A movement reader that sums quantities must skip `recordOnly` too.
- ⚠ **A cash sale's `lineTotal` is GROSS**, as everywhere the UI writes it. The till imports wrote
  the net; migration `0007` converts them, deciding per DOCUMENT (net lines sum to `subtotal`).
- **SUPTO periods are Bulgarian days** (`suptoPeriod`, `services/biz/local-day.ts`): `dateTo` used
  to parse as 00:00 UTC, the start of its day, so the POS tables lost the whole last day.

R1 — R1a, R1b (the read side: every reader counts a till sale once, whichever store holds it) and
R1c (one journal page in both apps) — is on production since 2026-10-26 (`v20261026-ee6cc3b78103`,
migrations `0006`/`0007` applied). What remains is in `docs/fr/FR-21-HANDOVER.md`.

- ⚠ **Till sales are read through `loadPosRows`** (`cash-register/pos-union.ts`), never from
  `postransactions` (R4, FR-21.27): the till's documents (`register.origin: 'pos'`) read back as
  the POS rows they stand for. Only migrations and the restore read `postransactions`, through the
  driver. A reader that ALSO reads cash-sale documents must exclude `register.origin: 'pos'` there,
  or it counts a till sale twice.
- ⚠ **The cash register refuses until it may read that way** (FR-21.28,
  `cash-register/freeze-check.ts`): the till's routes, the journal and SUPTO 18.1–18.5 answer 503
  `cash_register_not_migrated` while `postransactions` holds a row and `0009-cash-register-freeze`
  is not recorded. An empty `postransactions` (a new database or master) needs no migration. Checked
  at startup, then every 15 s until ready. A test seeding legacy POS rows runs
  `helpers/migrate-till.ts#migrateTill` (the copy + the 0009 record) before it reads.
- ⚠ **`cash_storno` is a document type, stored POSITIVE.** Every invoice-side reader of cash sales
  (digest, documents report, export, product/contact ledgers, invoice summary, sales history) takes
  it with sign −1. Nothing writes one before R2; a new reader must learn it anyway.
- ⚠ **Till documents and stornos are immutable** (D-8, `cash-register/immutability.ts`): `PUT`,
  `DELETE`, `/void` answer 409 `register_document_immutable`, and the Files rollback skips them.
  Back-office cash sales behave as before.
- **Keyed retries find their sale on its document**: a key an older release put on a POS row
  travelled with it into its copy (0008/0009), so `lib/cash-register-till.ts#findKeyedTillDocument`
  and `POST /invoices` look in `invoices` only (R4); a different request with that key is 422.
- **The journal**: `GET /org/:orgId/cash-register/documents` and `/:id`
  (`cash-register/journal.service.ts`), gated on `pos.read || invoicing.read` and readable by a
  PIN till. One component, `ui-shared/components/cash-register/CashRegisterJournal.vue`, is
  `/pos/orders` and `/invoicing/cash-sales` (route names unchanged); a till row that is not a
  document yet opens at `invoicing.cash-sales.view`. Its column choices live under ONE grid id
  (`ListScaffold`'s `gridId` prop), and headers may be `defaultHidden` (`useGridColumns`).
  It also carries #249's invoices for a cash sale: the `invoiced=yes|no` filter (sales only),
  `invoices` and `invoicingState` on document sale rows (`invoicingByCashSale`), the Invoice column and
  invoicing's „Издай фактура" action in its row slot.
- ⚠ **`exchangeRate` is the base-currency value of ONE unit of the document's currency**
  (`totalBase = total × exchangeRate`): a BGN till session in an EUR org maps to 1/1.95583, not
  1.95583 (`cash-register/mapping.ts#exchangeRateFor`).
- ⚠ **The POS terminal rings into the user's OWN open session** (owner, 2026-10-27, FR-21 R5):
  `PosTerminalView.vue#fetchSessions` asks `GET /trade/pos/session?cashierId=<me>`, and a sale into
  another cashier's session is 403 `session_not_yours` (a keyed retry of a sale already made is
  answered first). Until R5 it took the first open session in the org.
- **A back-office cash sale joins its author's open session** (FR-21.31, D-13): `POST /invoices`
  writes it with `register.origin: 'pos'`, `joinedFrom: 'backoffice'` and the session, so it counts
  in the drawer's totals, the close JE and SUPTO, is immutable and is reversed by a storno through a
  till. Its lines keep their warehouses. It prints on the session's device only when the request
  says `receipt: 'fiscal' | 'text'`. An imported day never joins. Test fixtures: `till-world`'s
  `backOfficeSale` posts as a clerk with no session, `cashierBackOfficeSale` as the till's cashier.
- **One selling surface** (FR-21.29): `ui-shared/components/cash-register/RegisterTerminal.vue` is
  the catalog, the cart and the totals of `/pos/terminal` AND `/invoicing/cash-sales/new`; each app
  hands in its own parts through slots (the till: session, bridge, last sale, payment; the form:
  header, `PriceCombobox`, notes, receipt, Save). It takes `totals`/`lineGross` as props: ui-shared
  does not depend on `config`.
- ⚠ **One totals function** (FR-21.30): a cash sale is totalled with `config/pos-totals#computePosTotals`
  everywhere — the till, the form (`document-payload.ts#computeTotals` branches on `cash_sale`), and
  `POST /invoices`, which refuses a back-office cash sale off by more than 0.02 (422
  `cash_sale_total_mismatch`) and stores its own figures. Other document types keep their
  components-first rounding. An imported till day keeps its file's totals.
- ⚠ **Since R2 the till writes cash-register documents, never `POSTransaction`.** The steps live
  in `services/biz/cash-register/register.service.ts` (insert → number → УНП → print once →
  session totals → stock → complete → audit), on the `Invoice` row's `register` block. `services`
  must not import `fiscal/*` (which imports it), so the till hands the service a
  `RegisterPrinter` port built in `invoicing-api/src/lib/cash-register-till.ts`. A new till
  sale IS the copy of the POS row it would have been (`tillSaleDocument` maps a virtual row
  through `fromPosTransaction`): one mapping, so the R1 readers and an R1 rollback read both alike.
  - ⚠ **One failure rule**: a failure removes the document only until the sale reached the device
    (receipt `pending`/`printed`/`unknown`) or the drawer (`sessionTotalsApplied`); after that
    it is recorded (`register.stockError`/`receiptError`).
  - **Numbers**: till sales AND stornos are `CASH_SALE` (`sequenceGroupFor('cash_storno')` fell
    through to SALES_DOC before R2); `TXN` is a `closed` registry row (allocates nothing, not on
    the sequences page); session numbers are the registry's `POS` row
    (`nextRegistryNumber(orgId, 'pos_session')`).
  - **Stock goes through `createInvoiceStockMovement`** (the movement carries `invoiceId`), whose
    numbering now retries a taken `SM-` number like the till's did (`createNumberedMovement`).
  - ⚠ **The till's stock check is `settings.cashRegister.allowNegativeStock`** (unset = allowed),
    run before the receipt. NOT `settings.inventory.allowNegativeStock`: it defaults to false and
    nothing read it, so wiring the till to it would have refused sales in every org.
  - **Storno** (D-2): a `cash_storno` document, positive; the sale stays `paid` with
    `register.stornoState: 'full'` + `stornoedBy` (claimed atomically). One door for the till route
    and the journal's `POST /cash-register/documents/:id/storno` (session-less for a back-office
    sale). Refused: an imported day, an INVOICED sale (its credit note corrects it), a storno. A
    POS-row sale is stornoed as its copy (0008/0009; R2's on-the-spot `copyPosRow` went in R4); the
    frozen row is never written.
  - ⚠ **The storno's return restocks at the cost the goods LEFT at** (the dispatch line's
    `resolvedUnitCost`), through `confirmMovement`. Not `reverseInvoiceStockMovement`: on a void
    it restores the consumed layers AND confirms a receipt that layers them again, at the sale
    price — layer-costed (FIFO/LIFO) goods counted twice, and WAC's `avgCost` pulled toward the selling
    price. That void path is still open (#276).
- ⚠ **`postransactions` is frozen (R3, FR-21.26)**: the `POSTransaction` model carries
  `db/plugins/frozen.plugin.ts`, so every write through it (save, insertMany, query writes,
  bulkWrite) throws `FrozenCollectionError`. Migration `0009-cash-register-freeze` copied the last
  rows and proved parity. A test that needs a legacy row inserts it raw: `createTestPOSTransaction`
  builds it with the model and writes `POSTransaction.collection.insertOne`. R4 removed what still
  read it at runtime: `GET /trade/pos/transactions*` (the journal replaces it), the DAL's
  `posTransactions` repository, the journal's POS side and R2's on-the-spot copy (FR-21.27).
- ⚠ **A body field the route's schema does not declare never reaches the handler**: Elysia's
  normalize drops it without a word. `POST /invoices` read `pendingTransferIds` without declaring
  it, so the cash-sale form's transfer-then-sell answered 400 for want of stock and left its draft
  transfer behind (FR-21.24, `cash-register-sale.flow`). The ids are the client's:
  `confirmTransferMovements(orgId, ids)` confirms only draft TRANSFERS of that org, and
  `checkPendingTransfers` refuses the whole list (422 `pending_transfer_invalid`) before a sale
  draws its number.

## An article starts its documents: „Заприходи", „Продай", „Резервирай" (2026-10-26, FR-22.47)

- **Where**: the Products list's row menu (one ⋮ now — Edit, Stock, the three, Delete apart) and the
  article's page header on every tab (`inventory-ui/ProductDocActions`, in `EntityFormShell`'s
  `#header-actions` slot and in the stock view's header). The page reads the article AS STORED: its
  „Активен" switch means nothing until it is saved.
- **Rules**: `inventory-ui/composables/product-doc-actions.ts` (pure, `unit/product-doc-actions.test`).
  Each action IS the „+ Нов" form's PAGE_REGISTRY row, so it is offered exactly to whom that form's
  Save is (§5.8: Заприходи `inventory.write`; Продай and Резервирай `invoicing.write`). A service
  (`trackInventory: false`) is never received or reserved; a deactivated article's Продай and
  Резервирай are listed disabled, the reason in a tooltip; Заприходи stays. Into another app the
  action is an `href` from `appHref`, in this one a route (`useProductDocActions`); `RowActionsMenu`
  takes `href`, `disabled` and `hint` for that.
- ⚠ **The `?productId=` contract**: a NEW document opened with it starts with that article on its
  first line, filled by the very handler a pick on the line calls — never a hand-built line, which
  would skip the pricing chain, the stock shown or the staged product update. It runs after the
  form's own defaults, so the line sits in the right warehouse, and stays in the URL (as `copyOf`
  does): a reload starts the same document again.
  - `/inventory/movements/new?productId=` (receipt): `onLineProductSelected` — the purchase price as
    the cost, what the DESTINATION holds, the product update when that switch is on, the next blank
    line, the cursor in the quantity. A movement line has no unit.
  - `/invoicing/<document>/new?productId=` (every `useDocumentForm` form): `onProductSelected` —
    unit, VAT, the price the chain resolves (a purchase document's is the purchase price, B-10), the
    document-wide or last-customer price when on, the next blank line. `copyOf` and
    `relatedInvoiceId` win over it; it is part of a new document's `useDocumentRouteKey`.
  - `/invoicing/reservations/new?productId=` (slice 4a): the list with its create dialog open on
    the article; the list then takes both parameters out of the URL.
- Tests: `unit/product-doc-actions` (7), e2e `product-actions.spec` (10: both places × three
  landings, deactivated, service, two roles, the list at 1366 px); walk P1-act: the row menu →
  „Продай", 2 clicks · 0 typed · 1 page load (the invoice is another app).

## Known Issues

- [MEDIUM] [2026-07-19] Cluster pod external DNS is INTERMITTENT: CoreDNS forwards to 10.10.20.1 (zeus virbr1 dnsmasq — answers fine locally) and periodically times out (CoreDNS logs `read udp 10.244.x→10.10.20.1:53: i/o timeout`; zeus shows no explicit 10.244.0.0/16 return route) → ArgoCD sync intermittently fails with ComparisonError "server misbehaving" on github.com, then succeeds on retry minutes later (observed 2026-07-19: first sync Error, queued retry completed → Synced). Workaround when stuck: `kubectl apply -k k8s/overlays/prod` from the mars `~/lgr-deploy` checkout (live state converges with git). Root-cause hunt belongs in k8s-cluster-multi (zeus WG/libvirt routing). Also: argocd CLI token on mars is expired — trigger syncs via `kubectl -n argocd patch application lgr --type merge --patch '{"operation":{"sync":{}}}'` or re-login. — Status: OPEN
- [MEDIUM] [2026-08-25] `integration/pos-transaction.flow.test.ts` — 9 of 21 tests fail on Windows (test 13 hangs ~150s, then 14–20 each time out at exactly 60s). It is the `.rejects` deadlock below, not a regression: **verified by stashing the only change on that path and reproducing the identical failure on unmodified code**. The file has 6 `.rejects`/`.resolves` usages; test 13 is the first one. Convert them to try/catch capture, or run the file on Linux/mars. — **Status: RESOLVED 2026-09-15** — all 6 converted with the sweep below; the file passes in the full run.
- [MEDIUM] [2026-07-19] Bun 1.3.12 on Windows: `expect(p).rejects` deadlocks when the rejection follows MongoDB driver I/O — the pending op hangs ~45s, mongod gets reaped ("killed N dangling processes") → cascading ECONNREFUSED + segfault. Workaround: try/catch capture (see `bill-with-update.flow.test.ts` `captureRejection`); ~60 `.rejects` usages across 23 test files can hang on Windows — run those files on Linux/mars, or convert as touched. **2026-07-26**: `.resolves` is affected too (proven by minimal probe: same promise via plain await = instant, via `.resolves` matcher = deadlock + hook-timeout cascade that poisons every later test in the process); which files trip it is module-graph/timing sensitive. `invoice-stock-validation.flow.test.ts` converted (all `.rejects`→captureRejection, `.resolves`→plain await) → 15/15 in 4s. Convert BOTH matcher kinds as touched. — **Status: RESOLVED 2026-09-15.** "As touched" was the mistake: the matchers were hit one at a time for two months while `bun run test` was, on Windows, not slow but COMPLETELY BLOCKED. `accounting.flow.test.ts` is the first file the runner reaches and line 124 used `.rejects`, so the shared mongod was reaped before any other file ran and all ~125 that followed cascaded into ECONNREFUSED — the suite never reported at all. All 58 remaining call sites across 19 files are now converted to the shared `helpers/capture-rejection.ts` (`captureRejection` + `expectRejection`), which replaces the three private copies that had grown in different files. `bun run test` completes: **1505 tests / 126 files in ~5m, 1493 pass / 7 skip / 5 fail** (the 5 are real pre-existing failures in `app-hub.flow`, `compare-snapshot` and `org-logo` that the hang had been hiding). ⚠ **Never reintroduce `.rejects`/`.resolves` in this suite** — one is enough to block everything again. ⚠ When sweeping, scan RECURSIVELY: `dal/repos/` (named `dal/parity/` until 2026-09-29) and `unit/biz/` are two levels down and a `unit/*.test.ts` glob silently misses 23 sites.
- [HIGH] [2026-10-26] **Voiding a DRAFT outgoing invoice books a receipt for goods that never left.** `POST /invoices/:id/void` accepts `draft`, and `reverseInvoiceStockMovement` reverses the lines whether or not a dispatch ever happened: a 4-piece draft voided took stock 10 → 14 (one `receipt` movement). The sales list offered „Анулирай" on drafts ONLY. Found during FR-22 slice 2; the row menu of slice 2b offers Delete on drafts instead, but the route itself needs its own decision (reverse only what the document's movements dispatched, or refuse a draft void). — **Status: RESOLVED 2026-10-26**: `reverseInvoiceStockMovement` reverses nothing for a draft that carries no completed movement. That covers the void route and the Files rollback alike, and leaves issued documents exactly as they were. On prod, one draft void had done it: `regal` DRF-INV-2026-00002, +1,257 units, not corrected. regal-pz and regal-sf had none. Regression test in `invoice-stock-validation.flow`. **Widened 2026-10-27 (#322):** a document of ANY status reverses only a booking it carries (a completed movement with its `invoiceId`). A cash sale imported with `skipStockMovement` keeps no trace of the flag, and 41 invoices of the July 2026 migration never moved stock: on prod 44 issued documents would have put back goods that never left (or, for a bill, taken out goods that never came in).
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
  - ⚠ **And on a master, a location on the disk the uploads are on is `failed` too**
    (`localDisk.sameAsData`, `stat().dev`; the volume on Windows). On Linux an unplugged drive
    leaves its mount point behind, an empty folder on the system disk, and "is it there?" passed
    it: the copy landed beside the database, read back fine and said `reached` every night.
    Tests whose folders all share one disk stand a second disk in through that seam (`freshLocal`).
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
  - The till's `/invoicing/pos/pin` (`PosPinView`) opens when a tab has no session there, and from the POS menu
    ("Switch operator");
  - a "Till PIN" card under the portal's account (`TillPinCard`, hidden on a 404).
  - ⚠ Those calls use plain `fetch` (`invoicing-ui/src/pos/composables/useTillPin.ts`), never the shared
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

## Masters registered with global (2026-10-25, FR-20.2, plan step P2-1)

Global keeps a registry of the masters that link to it: `ServerNode` (`nodes`, keyed by the master's
own `master-<16 base32>` id) and `NodeEnrollment*` / `NodeAssertion`. The model is
`docs/architecture/nodes.md`.
- **The Servers page** (`/settings/servers`, `admin.settings`) mints a 10-minute code. The master
  redeems it at `POST /api/node/v1/enroll`, together with a `proof` signed by the key it registers,
  then trades assertions at `/api/node/v1/token` for 15-minute tokens. `NodeAuth` denies by default
  and re-reads the row on every request.
- ⚠ **Every node route is 404 on a master**, and `NODE_TOKEN_SECRET` is required in production on
  global only. It is sealed in `lgr-secret` (lgr-deploy 7d7d29a). Without it global refuses to
  start.
- ⚠ **Revocation is per org.** `POST /org/:orgId/nodes/:id/revoke` takes only that org off. The node
  is revoked with its last org (an ephemeral one is deleted), and each step is conditional on the
  row as read.
- ⚠ **`GLOBAL_STATE_WRITES` (route-class.ts) is the home gate's one exception**: routes under
  `/org/:orgId/` that write global's registry, never org data, so they work while the org's home is
  the master being revoked. The models carry no tenant plugin. They are node state, never bundled.
- Reusable keys for the field lanes need `Org.settings.node.ephemeralKeysEnabled`. Their nodes are
  reaped after 24 h of silence (`NODE_REAPER_INTERVAL_MS`, 0 in tests), and never a permanent node.
- **A master registers itself** with `lgr-server register --code XXXX-XXXX` (P2-1b).
  - The running service does the work; the command only passes the code.
  - Its key is `keys/node.key`: DPAPI at machine scope on Windows, a `0600` file elsewhere.
    ⚠ A key that does not open is a refusal, never a new key, since a new key would leave the master
    registered with one it no longer holds.
  - Global is reached through the machine's proxy rules and the OS trust store (`https.rs`).
  - What global answered is kept in `state/registration.json` and shown by `lgr-server status`.

## The uplink, global's side (2026-10-25, FR-20.52, plan step P2-2a)

`/api/node/v1/uplink?ch=interactive|bulk` (`portal-api/src/websocket/uplink.ts`) is a registered
master's socket to global. It is mounted on global only. The protocol is in
`docs/architecture/nodes.md`.
- **Authentication:** the first frame is `hello` (a node token, the channel, a `bootNonce`), within
  10 s. Global answers `welcome`.
- **Liveness and revocation:** pings every 30 s; the node row is re-read every 30 s (4403 revoked,
  4401 a new key); 75 s of silence closes the socket (4408).
- ⚠ **`node_presence` (unique per node and channel) is the clone check.**
  - The same `bootNonce` is the same supervisor reconnecting, and takes its place back (4409 to the
    old socket).
  - A second LIVE connection with another `bootNonce` raises `clone-alarm` on both sockets and on
    the node (`ServerNode.cloneAlarm`). That stands until an admin re-registers the node.
- Pages and tunnel traffic (P3) must check `isTrusted(ws)` AND that the org is in the node's
  `orgIds`.
- **The supervisor holds both sockets** (`packages/server/src/uplink.rs`, P2-2b), one task per
  channel.
  - It is woken by `lgr-server register`.
  - The socket rides the TLS stream `https.rs` makes, through the machine's proxy rules and the OS
    trust store.
  - ⚠ 4403 stops the uplink until the master registers again. It never stops the shop: the
    supervisor and the API keep running.
  - `lgr-server status` shows each channel's state, and `CLONE ALARM`.
- **Control (P2-3a).**
  - The master sends `health` every 60 s on the interactive socket.
  - Global keeps it sanitised on `ServerNode.health`. ⚠ Only known fields, bounded, with undefined
    dropped: a Mixed field would store each undefined as null. At most one per 20 s.
  - `master_outdated` answers a master below `NODE_MIN_MASTER_VERSION`, or naming no version. It
    stays connected for its update; nothing else trusts it.
  - `/api/admin/nodes` (the "All servers" page) lists every master across orgs, for the
    `BACKUP_SYS_ADMINS` allow-list only. The licence waits on Q4.
- ⚠ `ServerNode.cloneAlarm` is a single nested subdocument with `default: undefined`. As a nested
  path holding an array it defaulted to `{bootNonces: []}` on every node, and every hello read as an
  alarm.

## Desktop updates through the master (2026-10-25, FR-20.56, plan step P2-7)

A master keeps its tills' desktop release (`docs/architecture/nodes.md`).
- The supervisor (`desktop_releases.rs`, every 6 h) reads `/api/node/v1/desktop-release` with its node
  token. That is global's configured version, its files and the updater signatures. The bytes come
  from the public download endpoint into `<data>/desktop-releases/`.
- The master's API serves `/update`, `latest-release` and the downloads from there, on its LAN address.
- ⚠ `current.json` names a version only once every file is whole, at its listed size.
  `release-cache.ts` serves only listed release files at their recorded size, inside the
  directory. A part-file or a leftover is never served.
- On global the route is 204 until a release can be served: `DESKTOP_RELEASE_VERSION` set and
  `DESKTOP_RELEASE_GITHUB_TOKEN` sealed.

## Licences on a master (2026-10-25, FR-20.55, plan step P2-3b)

An org on its own server runs under a licence global signs (`docs/architecture/nodes.md#licences-fr-2055`).
- Global: `services/biz/licence/licence-issue.service.ts` (who is entitled: a paid Enterprise
  subscription or a sys-admin's pilot, `OrgLicence`) signs with `LICENCE_SIGNING_KEY` (sealed). The
  uplink sends it in `welcome` and in `entitlements` frames. Sys-admins: `/admin/licences` (pilots,
  and a licence FILE for an air-gapped master).
- The keys a master accepts are `packages/config/src/licence-keys.json`, read by the API AND the
  supervisor (`include_str!`). ⚠ A production master accepts those and nothing else; outside
  production a process also accepts the key it signs with (`allowInDevelopment`).
- The master: the supervisor keeps `state/licences/<orgId>.jws` (`licence.rs`;
  `lgr-server licence import <file>`), and the API verifies it again on every change
  (`master-licence.service.ts`). It must name this org AND this master.
- **What it stops**, from the local midnight after paid-through + 30 days (or after a 30-day
  evaluation when there is no licence): opening a till session, a new invoice / proforma / cash sale,
  a new client order, and the three converts (`licence-gate.ts`, 402 `licence_expired`). Nothing else.
- ⚠ **The auth plugins never read a body** for this: naming `body` in a shared Elysia hook makes
  every route parse its body, and the Stripe webhook needs its raw one. `POST /invoices`, which
  decides on its body (credit notes go through), asks `licenceGate` in its handler.
- `OrgLicence` is NODE STATE (`home/node-state.ts`): never in an org's bundle.

## Mail through lgrai.app (2026-10-25, FR-20.59/86, plan step P2-6)

A master's mail is sent by global on its behalf (`docs/architecture/nodes.md#mail-through-lgraiapp-fr-2059-fr-2086`).
- On a master `sendEmail` QUEUES (`Outbox`, node state) and answers `{ok: true, queued: true}`.
  ⚠ Callers must say "queued", never "sent": the invoice email route answers 202, the digest run
  says `queued`, and an invoice's `emailedTo` changes only when the mail has gone.
- `relay/outbox-worker.ts` drains it to `POST /api/node/v1/relay/mail` with the supervisor's node
  token (`state/node-token.json`, `LGR_NODE_TOKEN_FILE`). `OUTBOX_INTERVAL_MS=0` disables it.
- Global (`relay/mail-relay.service.ts`) relays only what the org's admin turned on for that server
  (`ServerNode.relays[]`, per org; unset = on at Full, off at Control), with fixed caps and a
  7-day receipt per outbox id (`RelayReceipt`).

## Sign in with LGR (2026-10-25, FR-20.39, plan step P2-4)

A master signs its people in with their lgrai.app identity (`docs/architecture/nodes.md#sign-in-with-lgr-fr-2039`).
- Global: `services/biz/idp/idp.service.ts` (`/api/idp/client`, `/api/idp/authorize`; identity-only
  sessions may use them) issues 60-second single-use codes (`IdpCode`, node state) bound to the
  server, the redirect and an S256 challenge; `POST /api/node/v1/idp/redeem` turns one into a
  5-minute assertion signed with `IDP_SIGNING_KEY` (sealed, lgr-deploy 0a22ec0).
- The master: `/api/auth/idp/config` and `/api/auth/idp/redeem` (public, 404 on global) redeem
  with the supervisor's node token (`state/node-token.json`) and verify with the BUILT-IN keys
  (`config/src/idp-keys.json`, kid `S6iuZQxKWBBlip1p`), then `enterOrg(…, 'lgr')`.
- ⚠ The identity keys are not the licence keys, and the JWS types differ (`lgr-idp+jws`): an
  assertion can never pass for a licence. Both use `services/biz/crypto/ed-jws.ts`.
- UI: `views/idp/IdpAuthorizeView.vue` (lgrai.app), `views/auth/IdpCallbackView.vue` and the button on
  `LoginView` (a master). The verifier stays in the tab (`views/auth/idp.ts`).
- Not yet: the desktop's `lgr://login` path for a master, local credentials set on lgrai.app and
  their delivery (`cred-sync`), and the identity feed (P2-5).

## The identity feed (2026-10-25, FR-20.43/44, plan step P2-5)

A master pulls its people's changes from lgrai.app (`docs/architecture/nodes.md#the-identity-feed-fr-2043-fr-2044`).
- `services/biz/identity/identity-feed.service.ts`: global's `identityChangesFor` behind
  `GET /api/node/v1/identity-changes` (members of the node's orgs, by an `updatedAt|_id` cursor), and
  the master's `identityFeedTick` (every 30 s, `IDENTITY_FEED_INTERVAL_MS=0` disables it) applying
  them with `forgetIdentity`, so a password change or a deactivation ends the person's sessions there.
- ⚠ The payload is email, names, `tokenVersion` and active, nothing else (FR-20.44). A new field
  there needs the same care: `identity-feed.flow` scans for hash and token shapes.
- `NodeState` (`node_state`): a master's own small records by name. No `orgId`, so never bundled.

## The server packages (2026-10-25, FR-20.10, plan step P1-7)

`.github/workflows/server-release.yml` builds what a shop installs (`docs/guides/server-install.md`):
a signed per-machine **MSI** (`packages/server/wix/main.wxs`), a **.deb** (`packaging/nfpm.yaml`) and a
**tarball**, from a home `scripts/assemble-server-home.ts` lays out. Signed like roomlerd: roomler's
`sign-windows` (G ROX LTD) on `lgr-server.exe` BEFORE the MSI is built and on the MSI after; roomler's
release GPG key on every asset; SLSA provenance. A `server-v*` tag publishes (a prerelease for now);
a pull request touching it builds unsigned and installs.
- Bun and `mongod` are pinned by their vendors' sha256 (`packages/server/runtime.lock.json`, mongod =
  global's 7.0.30); Chrome by `pdf-browser.lock.json`. On Windows the VC++ runtime ships app-local,
  for `mongod`, inside the version.
- ⚠ **`lgr-server.exe` is built with a static CRT** (`RUSTFLAGS=-C target-feature=+crt-static`), and a
  release step refuses an EXE that names the C runtime. The MSI runs the installer's own copy
  (`update install-bundle`) BEFORE any version, with its app-local runtime, is unpacked. server-v0.1.0
  linked it dynamically: the first field lane (vmtest T-3, a clean Win11) failed the install with 1603,
  STATUS_DLL_NOT_FOUND. The release runner has the runtime installed, so CI's own MSI install passed.
- ⚠ **The preflight looks for that runtime where `mongod` loads it** (`preflight::vc_runtime_in`): the
  version's `bin\` first, then System32, DLL by DLL. It used to look in System32 alone, so on a clean
  Windows the supervisor refused every start (exit 7, which the event log renders as "The storage
  control blocks were destroyed") while all three DLLs sat in `bin\`. Found by the same lane, on
  0.1.1's first build. `install::runtime_bin` answers for `installer\lgr-server.exe`, which has no
  `bin\`.
- **The installers refuse a machine below FR-20.13's floor, and install nothing** (AC 14, 0.1.2). The
  MSI runs `Preflight` from `lgr_server_msi.dll` (`src/msi.rs`, the package's `[lib]` cdylib, which
  compiles `preflight.rs` in as it is) as an IMMEDIATE action before InstallInitialize: the reason
  goes through `MsiProcessMessage` (a message box with a UI, the log either way). The .deb's
  `packaging/linux/preinst` mirrors the checks in shell, held equal by
  `preflight::tests::the_preinst_mirrors_the_checks`. A first install only, never an upgrade.
  - ⚠ `preflight.rs` must stay a LEAF (no `crate::`): `msi.rs` compiles it on its own.
  - ⚠ An EXE custom action could not say why: its failure is the installer's generic "a program run
    as part of the setup did not finish as expected".
- ⚠ **Memory is measured against `MIN_USABLE_RAM` (3.25 GiB), never 4 GiB.** A 4096 MB VM reads
  3.8 GB, so the old `>= 4 GiB` refused every 4 GB machine; the `master-ubuntu-4gb` lane found it.
- ⚠ **At start, the supervisor refuses only what makes running impossible or unsafe**
  (`preflight::blocks_start`: cpu, location, vc-runtime). Below the memory or disk floor it starts and
  warns. It used to refuse any failed check, so a master whose disk dropped under 20 GB free would
  have stopped at its next reboot.
- ⚠ The MSI creates the service with a deferred custom action, `service install --no-start`, and
  starts it with ServiceControl. `install` is idempotent (an upgrade runs it again).
- ⚠ The .deb's postinst never starts, stops or enables anything. `packaging/linux/lgr-server.service`
  must equal `service::systemd_unit` (a Rust test holds it).
- CI installs each one before it ships: the MSI on the runner (service account, files, firewall rule,
  the API up, a clean uninstall that keeps the data), the .deb in Ubuntu 22.04 and 24.04 containers
  (every library resolves; the supervisor runs as lgr).

## The mirror: capture, pages, the apply (2026-10-25, FR-20.61–20.67, plan steps P3-1, P3-2a, P3-2b)

A master journals its own writes and sends them to lgrai.app's mirror of the org as pages
(`services/biz/replication/`). What replicates is each model's `replicate()` decision (P3-1a).
- **Capture** (`capture.ts`, `engine.ts`, P3-1b): one change stream → `repl_journal`, one row per
  document (its latest seq), in one transaction per batch with the resume token. Lost history raises
  the journal epoch and journals everything again. Masters only, and it follows the link: on while the
  supervisor's registration (`LGR_REGISTRATION_FILE`) says Full, stopped when it goes down (the
  journal stays); `LGR_REPLICATION=on|off` overrides.
- **Pages** (`pages.ts`): the rows above global's watermark, each document as it is NOW (one snapshot
  read), or a tombstone. Split documents carry their home's parts only (`project.ts#homePart`). BSON
  per document inside the page, zstd around it, at most 1,000 documents or 4 MB.
  - ⚠ Documents are read and decoded with `promoteValues: false`. A JavaScript round trip turns an
    integral `Double` into an `Int32` and a `Long` into a number: the hash would not match, and the
    mirror would hold other types than the home.
  - ⚠ A page is built only once the org's seeding at the current journal epoch has finished
    (`ReplOrg.seededEpoch`): seeding hands out seqs outside the tailer's transactions, so before it
    ends a lower seq can appear below a page already sent.
  - ⚠ The master continues only from a page it built itself (`ReplOrg.pages`, the last 32). Global
    may tell it the chain hash it holds, but only to pick among those: a restored, reverted or cloned
    master that adopted global's hash would pass for the one whose history it lost (FR-20.51).
- **The apply** (`apply.ts`, on global): refused whole, with an alarm in `mirror_state.alarms`,
  unless the hash matches, the sender is registered for the org (not revoked, no clone alarm, linked
  at Full: FR-20.54's Control sends no business data, and global enforces it) and its home at the
  page's epoch, and every row is a replicated collection of that org with stored file
  paths under it. Then ONE transaction of raw driver writes, the watermark and chain last.
  - ⚠ A split document is written with ONE `$replaceWith` pipeline (`mirrorPipeline`): the page's
    home parts plus the mirror's own parts as they are on the server. A `$set` of the home's fields
    would keep a field the home removed (`User.deactivatedAt` after a reactivation), and a
    read-then-write would lose a Stripe webhook's write in between.
  - ⚠ A duplicate key ABORTS a MongoDB transaction, so a collision is resolved by trying again with
    the stale same-org document deleted first, and `resend {coll, ids}` asks the master for it again
    (`rejournal`). A key or `_id` another org holds is never written over or deleted: that
    document is SET ASIDE (below).
  - **One document never stops the org** (P3-2c, FR-20.65; `replication/dead-letters.ts`,
    `mirror_dead_letters`, node state): a document whose `_id` another org holds (found before the
    first attempt, one `$in` a collection, not one retry each), whose unique key another org holds,
    or that the database refuses (a server code that is the document's: not 11000, not a
    transient/server-state code, no `TransientTransactionError` label) is left out of the next
    attempt and recorded `open`, with a `dead_letter` alarm the first time; the rest of the page
    applies. More than `DEAD_MAX` (100) in one page fail it (`page-error`). An open one rides the
    org's next acknowledgement as `resend` once its `retryAt` comes (5 min, doubling to a day),
    and the page that writes it resolves it, so a conflict someone removes heals by itself. The
    Servers page's "Files on lgrai.app" card lists them (×4), and the move back waits on them
    (`mirror_whole`): a set-aside document would keep its digest from ever matching.
    The isolation refusals (another org's row, a collection that does not replicate, a file outside
    the org) still refuse the whole page: those are not one document's trouble.
  - ⚠ A stale SPLIT document is parked (its key set to `~stale~<id>`), never deleted: its global
    and node fields travel in no page, so a resent membership would come back with no person and,
    looking new, without its sanctioned link.
  - ⚠ The chain hash proves a page whole, not who sent it: authorship is the node token, the
    registry and the home check. Never trust a page's own `nodeId`.
  - A `User` naming a person the mirror's copy does not already name is applied WITHOUT `identityId`
    (FR-20.63), with an alarm. A membership new to the mirror gets inert person fields
    (`<id>@inert.invalid`), because `email` and the names are global's and `{email, orgId}` is unique.
- **The transport** (P3-2b: `control.ts`, `websocket/uplink.ts`, the supervisor's `replication.rs`):
  the supervisor asks the API's control socket for a page (`POST /replication/page {orgId, after,
  afterHash}` → the bytes, 204, or 409 with the reason) and sends it as ONE binary frame on the bulk
  socket. Global answers `page-ack` / `page-refused` / `page-error`; a `resend`'s ids travel as EJSON
  to `POST /replication/resend`. The bulk `welcome` says where each mirror stands (FR-20.67). One page
  in flight per org; `behind`/`gap` start again from global's watermark; another history, an older
  epoch or an unknown chain STOPS that org (a re-seed is P3-7's, and a person's call); the rest waits
  10 minutes. A NEWER journal epoch that continues the chain is applied and reconciled (P3-7f, below).
  - ⚠ The supervisor never reads a page, and global takes the node from the token, never the page.
  - ⚠ A page is read at the snapshot (majority-committed) point, which can trail a `local` read by
    the batch that just committed: "nothing to send" then is not "caught up". The pump looks again
    after 2 s; a test waits for the journal's head (`replication-pages.flow`'s end-to-end case).
  - **Paced on the shop's upstream** (FR-20.52, FR-20.68, P3-2c; `packages/server/src/pacing.rs`). Two
    sockets keep a catch-up from queueing in front of a click inside the supervisor, not on the LINE:
    behind a router with a deep buffer every bulk byte waits in front of the interactive socket's. So:
    while bulk has work the interactive socket pings every 2 s, one at a time, NUMBERED (global echoes
    `n` in its pong; an older global's unnumbered pong times only a ping alone in flight; one
    unanswered for 10 s is a 10 s sample already); its round trip less the least of ten minutes is the
    line's queue. Over 150 ms the bulk rate falls by a fifth (by half past 600 ms), at most once a
    round trip or two; under it, it grows by a quarter only if bulk used two fifths of what the rate
    allowed (an idle line is no evidence); floor 8 KB/s (the mirror never stops). At the floor two
    minutes with the delay unmoved, the queue is a slower route, not ours: the base starts again from
    the last minute. Pages (`maxBytes`) and chunks (`length`) are asked for in a quarter of a second
    of the rate (16 KB to 1 MB; an older API ignores both), spaced by a token bucket in the pump's own
    task (the socket loop never waits on it). `lgr-server status` shows `bulk.pacing`;
    `LGR_BULK_PACING=off` turns it off. ⚠ The real-process proof is `mirror-e2e`'s shared-uplink
    section, the chaos proxy's `uplink(Bps)` (ONE unbounded FIFO for every connection, a bloated
    router): a click through the same 64 KB/s line during a 3,000-document + 2 MB catch-up went from
    p50 4.7 s / p95 over 60 s (timeouts) unpaced to p50 223 ms / p95 559 ms, the catch-up 50 → 59 s.
    A per-connection `throttle` cannot show it: nothing queues behind anything there.
- `mirror_state` (global) and `node_instance` (master) are node state, never in a bundle.
- Tests: `replication-capture.flow`, `replication-pages.flow` (two databases on one replica set: the
  master's and the mirror), `replication-transport.flow` (the control socket, the bulk socket),
  `unit/replication-meta`, `unit/replication-project`, and Rust `replication::tests` + the uplink's bulk
  session test. The whole path with a real supervisor, a cut link and a slow one:
  `bun packages/tests/src/two-node/mirror-e2e.script.ts` (after `cargo build`, `bun run build`,
  `bun run build:server`). ⚠ That script runs T-1's TLS front and chaos proxy IN its own process:
  never `Bun.spawnSync` the CLI there, or the blocked event loop forwards nothing and every supervisor
  call to global times out (it looks like a slow WinHTTP proxy lookup, and is not).

## Moving an org to its master (2026-10-25, FR-20.79, plan step P3-6a)

The Servers page's "Move here" (server at Full) → `/api/org/:orgId/moves` (`move.controller.ts`:
`preflight`, start, `current`, `:id/abort`; `admin.settings`, global only). lgrai.app runs it
(`services/biz/move/move.service.ts`, `org_moves`, node state: freezing → copying → verifying → done
| aborted); the master takes it (`move-worker.service.ts`, every 10 s on `GET /api/node/v1/moves`,
then `…/:id/bundle`, `…/files`, `POST …/copied {digests, people, credentials}` or `…/failed`).
Operator page: `docs/architecture/nodes.md#moving-an-org-to-its-master-fr-2079`.
- **Freeze**: `OrgHome.state: 'freezing'`; the copy waits 2 × `HOME_CACHE_MS` (10 s), then revokes the
  desktop enrollment codes/keys and builds `move-bundle.ts`'s copy (+ the org-rooted files sidecar).
- ⚠ **The copy carries the org's PEOPLE** (`$people`, `PEOPLE_FIELDS`: who they are, never a password,
  OAuth link or other org) **and their local credentials sealed to the master's seal key**
  (`$credentials`, `sealedCredentialsForMove`). A master's sign-in needs its own `Identity` row, and
  BOTH feeds skip people a master does not hold and move their cursors past them: without these
  sections nobody signs in at the site, and the credentials would wait for the next daily full pass.
  After the import `forgetFeedCursors()` makes both feeds run from the start once.
- ⚠ Canonical EJSON per document read with `promoteValues: false` (the mirror's type rule), and the
  digests are a function of the DATABASE (`collectionDigests`), computed by both sides over the same
  projection; the flip waits for them and for the people/credential counts.
- **Flip** (one transaction): `OrgHome {home: node, epoch+1, active}`, `Org.homeEpochHighWater`, the
  org's `mirror_state` deleted (the master's first pages re-send the copy, idempotent, on a new chain);
  then `rewelcomeNode()` closes the node's bulk socket (4410 `home_changed`; other pods notice in their
  30 s tick) because the pump pages only the orgs its welcome named.
- ⚠ **The audit trail is org data**, refused like any other write once the org is frozen or gone: the
  start's entry is AWAITED before the freeze (`recordAuditEntry`, so it is in the copy), an abort's
  after the unfreeze, and the master writes the arrival once the org is home there.
- ⚠ **Global's own org-scoped records are refused by the write guard during the freeze too**
  (`DesktopEnrollmentCode/Key` carry `tenantPlugin`): those revocations, `homeEpochHighWater` and
  `mirror_state` are raw writes, listed in `home-write-guard.flow`'s `RAW_WRITE_SITES`.
- **The master**: frozen at the new epoch, then an import into an EMPTY org only (refuses data already
  there, or a person whose email another holds); a person it holds already keeps their record, with
  `tokenVersion` only raised; the people it adds are recorded in `node_state` (`move:<id>`) BEFORE
  they are inserted, so an abort removes exactly those still unreferenced. A lost `copied` report is
  sent again without importing again; only global's answer moves the move on.
- A flip is claimed INSIDE its transaction: a report sent again after a crash between `verifying` and
  the flip finishes it, one after the flip is answered done, and a late second flip changes nothing
  (it would otherwise delete the mirror's new chain).
- The desktops follow (P3-6b, below), the org can move back (P3-6c, below), a lost server's copy
  can be promoted (P3-6d, below), and a fenced server's work reaches lgrai.app and is brought into
  the books (P3-6e, below). A number issued twice is kept and corrected (AC 51, below).
  - ⚠ `collectionDigests` hashes canonical EJSON in STORED field order, and the mirror's apply
    reorders a split document (`$mergeObjects: [home, kept]` puts global's fields last). So the move
    back compares with `homeDigests` instead, which is order-insensitive.
- Tests: `move.flow` (12: the copy's types and contents, tampering and a forged password refused,
  preflight, freeze → copy → flip with the bulk re-welcome, mismatch and abort, a flip cut short, the
  master's import, activation, a lost report, the abort's people rule, the refusals, and the routes) and
  `bun packages/tests/src/two-node/move-e2e.script.ts` (real processes, as `mirror-e2e`: 18 checks
  from preflight through the flip to the mirror equal again).

## Desktops follow their org's home (2026-10-26, FR-20.82, plan step P3-6b)

After a move to a master, global tells each of the org's desktops where the master answers and which
CA to pin there; the desktop keeps its id and its key (its registry row moved with the org, FR-20.63),
so nothing is re-enrolled. Global's half: `services/biz/desktop/repoint.service.ts#movedFor`.
- **Alarms (FR-20.101, P3-8a; `services/biz/node/node-alarms.ts`).** The health frame also carries
  `disk.totalBytes`, `oplogWindowSecs` (the supervisor reads `local.oplog.rs` as the
  administrator, `mongod::OplogWindow`: the API's user cannot; ⚠ ONLY once the oplog is 90 % of its
  max size: until it wraps its first entry is just the server's first day, and a new install would
  read as a short window for a week), `clock` (global keeps `clockSkewSecs`, master minus global at
  receipt) and the API's `lastBackupAt` / `fenced` / `outboxQueued`
  (`services/biz/node/master-health.ts`, through the control socket's status). `nodeAlarms`: the
  mirror over an hour behind while bulk is up (the master's reported head past the watermark AND
  no page for an hour; caught up is never lag), a backup over 26 h (none at all only a day after
  enrolment, and only for a server that writes an org), disk under 10 %, oplog under 7 days, fenced,
  clock over ±2 min. ⚠ A health frame older than ten minutes raises nothing: away is the
  connection's to say. `alarmsOfNodes` batches presence, homes and mirrors; the org's Servers
  list carries `alarms` (a lag only that org's) and `/admin/nodes` everyone's, with link and last
  backup (`useNodeAlarms` formats both, durations through `Intl`, ×4), and `supto_waiting` (P3-8c, below).
- **A SUPTO version travels only once declared (FR-20.50, P3-8c).** `packages/config/src/supto.json`
  holds this source's SUPTO version and the versions declared to НАП (a JSON file so the build host
  reads it with `jq` and the supervisor with `include_str!`; `config/supto` is its reading for the
  code). ⚠ Bump `version` by hand in the commit that changes Прил. 29 functionality or the database
  structure (чл. 52в(3), (3а)); add to `declared` in the commit that records the declaration.
  - **Not enforced while `declared` is empty** — LGR is not on НАП's list yet, and nothing waits.
    Once it is not: a declared version travels, so does a build within the running version, and
    anything else waits. A release naming no version waits too (it cannot be shown declared).
  - **Masters:** the release publishes `lgr-server-<v>.supto` and the home's `HOME.json` carries
    `supto`; global's offer adds `supto {version, declared, enforced}`, declared-ness computed at
    read time against global's own build (a declaration needs no new release). The supervisor does not
    wake the helper for a waiting one (`update.suptoWaiting`, the `supto_waiting` alarm); the
    helper asks the same rule, and after the download checks the bundle's `HOME.json` against the
    offer's claim — the signed bytes, not the offer, decide.
  - **lgrai.app's own deploys:** `deploy-prod.sh`'s `supto_gate` reads the checkout's file and the
    pod's own copy (`kubectl exec … cat`; `SUPTO_RUNNING=<v>` when the pod cannot say) and refuses a
    build of an undeclared new version. A `--tag` redeploy builds nothing and is not gated.
  - The master's status page shows the SUPTO version that runs, and Прил. 32 lists it.
- **Home records fail closed on lgrai.app (FR-20.3, AC 55, P3-8d; `services/biz/home/home-hold.service.ts`).**
  `homeOf` already DERIVES a hold from the record (a missing row after a move, a row that disagrees
  with `homeEpochHighWater`); these are the holds global TAKES, stored as `OrgHome.hold {reason,
  since, from, claim?}`:
  - **`higher_epoch`**: a master registered for the org reports, in its minute org-state report
    (now with `epoch` + `state` per org), a newer home record than global's — global's database is
    older than the org's last move. ⚠ Only an `active` row is a claim: during a move the master
    writes its row at the NEW epoch as `frozen` before global flips (move-worker), and holding then
    would break the move's own flip precondition. Not from a revoked server, nor for an org it is not
    registered for.
  - **`dr_restore`**: the runbook's step right after a Layer-1 restore (lgr-deploy
    `docs/BACKUP-RUNBOOK.md` §4 step 2b): every org with a server, or a high-water mark, or a row.
    Released by its home server reporting the SAME record; an org homed on global, or a newer record,
    waits for a sys-admin.
  - Settled on the sys-admin Nodes page ("Organizations on hold", `/admin/nodes/held`): **release**
    (global's record stands; the high-water mark is made to agree) or **adopt** (the server's claimed
    record becomes global's, only from a server still registered). ⚠ The routes take `:id`, never
    `:orgId`: the tenant guard and the home gate key on that name and would refuse a sys-admin
    settling an org on hold. Global's audit log cannot take it (the org is on hold): the row keeps
    `released`, and the log line says who. The Nodes page raises `home_hold` per server.
- **An org's address on the internet (FR-20.72, P3-4a; `services/biz/address/org-address.service.ts`).**
  `OrgAddress {label, orgId, state: requested | active | refused | retired}`, global's record about the
  org: node state, never in a bundle, no `tenantPlugin` (so the write guard does not see it).
  - **The label is the org's slug WHEN REQUESTED**; a rename does not move it. It must be a DNS label of
    at most 63 characters, with no punycode, and not reserved (the built-in list plus
    `ORG_ADDRESS_RESERVED`).
  - At approval the label must also have **no record of its own in the zone**: no CNAME, MX or TXT,
    and no A record that differs from a random label's (that one is the wildcard).
  - **The org's licence must include on-prem** (`entitlementsOf`).
  - **The flow.** The org admin asks on the Servers page (`POST /org/:orgId/address`). That route is
    in `GLOBAL_STATE_WRITES`, because the org is usually homed on its server. A sys-admin then
    approves, refuses or retires it on the Nodes page (`/admin/addresses/:id/…`, `:id` never
    `:orgId`). A refusal needs a reason and frees the label.
  - ⚠ **A label is issued once.** The unique index covers requested, active and retired. A retired
    address answers with a notice for 12 months and is never issued again.
  - **"Sign in with LGR"** now returns a person only to an ACTIVE address of the server's orgs
    (`activeLabelsOf`), no longer to any slug.
  - **The edge** (mars' Docker nginx, `gjovanov/nginx`; P3-4e, lgr-deploy#27, live since 2026-10-27)
    holds a ZeroSSL certificate for `*.lgrai.app`, and the zone a wildcard A record beside the
    server block `org-addresses.lgrai.app.conf`. ⚠ A name with its own record (`qa`) wins over
    the wildcard. `harvex` was retired the same day: its record and vhost are gone, so the name now
    reaches LGR and answers the unknown-label 404.
- **The tunnel, lgrai.app's side (FR-20.72–20.74, FR-20.78, P3-4b; `portal-api/src/tunnel/`).** A
  global-only `onRequest`, registered FIRST in `unified.ts`, handles every `Host` of the form
  `<label>.<ORG_ADDRESS_APEX>` whose label is not reserved. Such a request belongs to the org's
  server, never to lgrai.app: once a hook returns a `Response`, none of lgrai.app's later hooks,
  headers or cookies run (measured).
  - **Routing** (cached 10 s):
    - an ACTIVE address of an org homed on a master REGISTERED for it tunnels;
    - a requested or refused address, no address, or an org homed on lgrai.app answers exactly like
      an unknown label: 404 (a page, or JSON for an API client);
    - a retired address answers 410 for its 12 months;
    - a server that is not connected gets a 503 static notice, never a sign-in page (FR-20.75).
  - **The edge** (FR-20.78). A credential is a non-empty bearer token or a non-empty `__Host-`
    cookie; global checks only that one is present, and the master validates it. Without one, only
    these pass: GETs outside `/api/`, `/api/auth/idp/*`, and WebSocket upgrades. Anything else is
    401. Anonymous requests are limited per address (600/min) and per client (120/min), counted per pod.
  - **The wire** (`services/biz/tunnel/tunnel-frame.ts`; the supervisor mirrors it). It runs on the
    INTERACTIVE uplink, and only over a socket `isTrusted` accepts.
    - Frames: JSON control frames `tun-open`, `tun-credit`, `tun-cancel`, `tun-head`, `tun-error`,
      `tun-ws-open` and `tun-ws-close`; binary `LGRT` data frames of at most 64 KB.
    - Each stream gets a 256 KB credit window in each direction, used whole and never exceeded.
    - An HTTP stream idle for 120 s is closed (504); WebSockets are not timed.
    - A link drop fails its streams. A GET or HEAD with no answer yet is retried once, on the server's
      next socket.
    - Headers: request headers cross without hop-by-hop headers, `X-LGR-*`, forwarding headers or
      the WebSocket handshake's own. A response's `Set-Cookie` loses any `Domain`.
  - ⚠ **Elysia's WebSocket wrapper turns anything but a Buffer into text.** Binary goes out through
    `raw.sendBinary`.
  - ⚠ **The browser's WebSocket is upgraded inside `onRequest`**, with `server.upgrade(req, {data:
    handlers})` (Elysia dispatches to `ws.data.*`), and the hook returns a 101.
  - **Across pods** (P3-4d; `forward.ts`, `hop.ts`, `pod.ts`). A request may land on a pod that does
    not hold the server's interactive socket. That pod forwards it to the pod that does, found by the
    uplink's presence row, which now records `podAddr`.
    - `podAddr` is `LGR_POD_ADDR`, else `http://<POD_IP or the first non-internal IPv4>:<PORT>`.
    - The row must be fresh (75 s), must not be under a clone alarm, and must name another pod.
    - HTTP is streamed both ways, byte for byte (`decompress: false`). A WebSocket is accepted here
      and opened there.
    - The forward is a HOP: `X-LGR-Hop: <ts>.<HMAC>` over the time, the method, the `Host`, the path
      and `X-LGR-Hop-Client`, keyed from `JWT_SECRET` and valid for 30 s.
    - A hop has passed the edge already and keeps the browser's address. ⚠ It is NEVER forwarded
      again: a socket gone from both pods answers offline instead of bouncing.
    - A hop that does not verify is the client's own request, so the edge applies. Every `X-LGR-*`
      is dropped before the server either way.
    - The other pod unreachable: offline. Only an `offline` failure forwards, since nothing of the
      request was sent; a link lost mid-request never does.
- **The tunnel, the server's side (FR-20.73, P3-4c; `packages/server/src/tunnel.rs`).** The supervisor
  carries the streams on its INTERACTIVE uplink only, and not while that socket is suspended or
  outdated. A clone alarm ends the tunnel along with every stream in it.
  - **One task per stream.** An HTTP stream goes to the API's loopback port. The request body is
    passed on as global sends it, and credit goes back as the API takes each chunk. The answer goes
    out only within the credit global grants. A WebSocket stream opens its own socket to the API and
    carries whole messages, up to 1 MB each.
  - **Stamped exactly like a LAN request** (`ingress::stamp`, `Source::Tunnel`):
    - the client's `X-LGR-*` and forwarding headers are dropped (global drops them too);
    - the front secret, the source and the client's address are stamped;
    - the org's address is the `Host`.
  - ⚠ **The API answers `<label>.<ORG_ADDRESS_APEX>` ONLY for the `tunnel` source**
    (`front-guard.ts#isOrgAddressHost`). The same name from the LAN is 403 `host_not_allowed`. The
    tunnel source is never held to the LAN's desktop-credential rule, and creating an org stays the
    console's.
  - ⚠ The session loop drains the socket's outbound channel, so nothing in it may wait on that
    channel. An immediate answer goes out through a spawned send.
  - Proven end to end in `two-node/move-e2e.script.ts`: a master-signed session, a write, a bundle
    larger than one window, a WebSocket, a forged stamp dropped, and a 404 once the org has moved back.
- **A master's own status page (FR-20.98, FR-20.50, P3-8b; `/settings/server`).** The supervisor
  writes its status every 30 s to `state/status.json` (`status_file.rs`: atomic, with the volume and
  the oplog's reach beside it; nothing secret is in a supervisor status), beside the node token, so
  the API finds it at `dirname(LGR_NODE_TOKEN_FILE)`. `services/biz/node/server-status.ts` joins it to
  what this database holds of the org (home, journal head, last backup, outbox, fiscal devices,
  desktops online) and to lgrai.app's last `/self` (`lastSelfAnswer`, kept by the link-alarm tick:
  the mirror's watermark), and adds the Прил. 32 fields ready to copy (т. 5, 7, 10–13: re-filed
  within 7 days of a change, чл. 52з(1)). `GET /org/:orgId/server/status`: admin or
  `admin.settings`, **404 on lgrai.app**; `GET …/server/here` answers any member whether to show
  the nav entry, 200 either way. ⚠ One server may hold several orgs: the licence is projected to
  THIS org's (plan, paid through, grace, error), never the supervisor's whole list. A file older than
  two minutes says the supervisor is not writing.
- **Where an inspector reaches the server (FR-20.47, P3-8e; `node/inspection.service.ts`).** Н-18
  чл. 52и(1): every device of the СУПТО, servers included, reachable "незабавно".
  - **The declaration**, per org (`NodeState` `inspection:<orgId>`, node state, never mirrored or
    bundled): the server stands in the shop (inspected there, no path asked), or off the premises.
    Off the premises it needs a path:
    - `tunnel`, the org's address, refused (409) without the Full link (`link_not_full`) or without
      an issued address (`no_address`);
    - `overlay`, the roomler overlay, with the address an inspector uses;
    - `vpn`, the company's VPN, with the address an inspector uses.
  - `PUT /org/:orgId/server/inspection`: admin or `admin.settings`, on the server only (404 on
    lgrai.app, and the home gate's 409 before that for an org written on a server). The change is
    audited (`entityType: 'server'`).
  - **lgrai.app's `/self` now names each org's address** (`orgs[].address`), which is how the server
    knows the tunnel's.
  - **The status page's Прил. 32 panel** shows the path, and a hint while it is undeclared, missing,
    or broken (e.g. the link went down to Control). An admin declares it there.
  - `docs/supto/FUNCTIONAL-DESCRIPTION.md` §13 is the on-prem variant the spec asks for.
- **The digest's on-prem lines (FR-20.100, P3-8b; `buildServerSection`).** An org's digest is built
  on its home (FR-20.85), so on a master it gains a `server` section: lgrai.app's copy (behind by how
  much, the last page's age, from `lastSelfAnswer`), the last backup there, and what waits in the
  outbox, each red past FR-20.101's threshold (`ALARM_AT`): `unheard` (no `/self` for an hour, or
  never by an API up that long; ⚠ never just after a start, when the first tick has not run),
  `mirror_lag`, `backup_stale` / `backup_none` (only once the org's home is 26 h old),
  `queued_old`. Any alarm keeps the day off "all clear". `settings.dailyDigest.sections.server`
  (default on); never built on lgrai.app.
- **Where the master answers**: the supervisor's health frame carries `lan {url, caFingerprint}` from
  `state/lan.json` (only while the LAN ingress is on); `sanitizeHealth` keeps it only in the shape a
  desktop takes (`LAN_URL`, `CA_PIN` in `repoint-token.ts`).
- **A re-point** (`desktop:repoint {instruction, node, name}` on `/ws/desktop`): an EdDSA JWS, typ
  `lgr-repoint+jws`, for ONE desktop (`sub`), its org, the master and the move's epoch, the
  master's LAN URL and CA pin; 30 days. Signed with `REPOINT_SIGNING_KEY` (sealed in lgr-secret),
  verified by the desktop against `config/src/repoint-keys.json` built into it. ⚠ The signature is
  the point: a till reaches lgrai.app through the machine's trust store, so a TLS-inspecting middlebox
  it trusts could otherwise send it to a server of its own, pinned from then on.
- **`desktop:moved {node, name}`** instead when global cannot say where (no `health.lan`, the node
  removed, no key): the shell says the org moved and offers to pair.
- **When**: at the flip (`repointOrgDesktops`, after `copied`), at every later authentication, and
  on the heartbeat (a flip on another process), each followed by `desktop:error {code: 'org_moved'}`
  and a close: a shell older than P3-6b takes that as any refusal. ⚠ Nothing of a moved org's desktop
  is written on global (`lastSeenAt` would be refused: the rows are the mirror's now).
- A moved org's desktop on the fiscal bridge is refused `org_moved` before its device is marked
  online, and a write a desktop route makes (`PUT /desktop/v1/self`) answers the home gate's 409
  (`spaErrorHandler` maps `HomeElsewhereError`, which was a 500).
- Global only: the move back (P3-6c) is the master's to announce.
- **The shell** (`packages/desktop/src-tauri/src/repoint.rs`, `main.rs#follow_repoint`): believes
  an instruction only under a key built into it (`include_str!` of `repoint-keys.json`), for its
  own desktop id and org (`registration.json`), above `settings.homeEpoch` (a replay cannot send
  it back), with a LAN origin `trust::may_pin` allows and the dates within a day of its CORRECTED
  clock; then `trust::confirm`s the master's CA against the pin, saves server + pin + epoch, and
  RESTARTS (`prepare_exit` + `app.restart()` from a thread: Tauri then runs `RunEvent::Exit`, where
  the single-instance plugin releases its mutex before the relaunch). Not followed: `status.orgMoved`
  and the Overview's `org-moved` banner; the next connection brings the instruction again.
  ⚠ `save_settings` keeps the on-disk `homeEpoch`, as it keeps `master`.
- ⚠ The shell and global verify ONE vector (`desktop/src-tauri/src/repoint-vector.json`, signed by
  global's own signer with a throwaway key): change either verifier and the other's test says so.
- Tests: `desktop-repoint.flow` (9), Rust `repoint::tests` + `presence::tests`, `uplink::tests`
  (the lan in health). ⚠ Not yet walked with a real shell: this PC holds a real enrolled desktop
  (a second shell hands off to it), so the walk is owed to the VM lane before the next desktop release.

## Moving an org back to lgrai.app (2026-10-27, FR-20.80, plan step P3-6c)

The org admin starts it on lgrai.app's Servers page ("Move back to lgrai.app" on the org's home
server; `POST /api/org/:orgId/moves/preflight` and `POST /moves/` with `{ to: 'global' }`). The
org's data never travels as a copy: global's mirror already holds it, and the move waits until the
mirror holds ALL of it. Global: `services/biz/move/move-back.service.ts`; the master:
`move-worker.service.ts#moveBack`. `org_moves` with `kind: 'to_global'`, `from` the master.
- **Preflight**, every check at once:
  - the org's home is one of its servers, which is registered, at Full, with no clone alarm,
    connected on both sockets and healthy;
  - no till open and no fiscal command in flight there (its health frame's `posOpen` and
    `fiscalInFlight`; unknown is not 0) and no open session among the mirrored rows;
  - a live mirror (no reconcile running: `mirror_state.reconcile` done, or none), and a whole one
    (no document set aside, `mirror_whole`, P3-2c);
  - every file the mirror's rows name is on lgrai.app or on its way. A file the server cannot send
    blocks the move unless the admin leaves it behind (`allowMissingFiles`).
- **Asked** (`freezing`): global records the move and re-welcomes the master, so a records-only
  org's files travel now (`movingBack`). The master's worker (every 10 s) refuses while a till is
  open, a fiscal command prints or a job runs (`failed`). Otherwise it writes the move into the
  org's audit trail (here, the org's home) and freezes the org: `OrgHome.state: 'freezing'` at the
  same epoch. ⚠ The capture never disables an org, so a frozen org's last pages and files still go.
- **Drained** (`copying`). From `DRAIN_AFTER_MS` after the freeze (twice the home cache, plus a
  capture round), the master reports its journal head (`POST /api/node/v1/moves/:id/drained`) on
  every tick. Global answers what it still waits for:
  - `pages`: the mirror's watermark below the head;
  - `files`: `mirrorFilesStatus` not complete;
  - then `need: 'digests'`: the master sends `homeDigests` (at most once a minute);
  - `wait: 'digests'` with the collections that differ, until they are equal.
  - ⚠ A mismatch WAITS (a page may still be on its way); only the timeouts abort: 30 min to freeze,
    6 h to drain.
- **Verified** (`verifying`). Global's move-back tick puts every file back where its row says
  (`placeFilesBack`: from the content store, a file already there with the right bytes stays, one
  with other bytes is replaced; idempotent), because global reads an org homed here BY PATH. Then
  the flip.
- **The flip**, in one transaction that first claims the move:
  - the epoch up by one, the home global, `homeEpochHighWater`;
  - the org's `mirror_state` deleted.

  After it, the content store (`dropMirrorBlobs`) goes, and the master is re-welcomed.
- **The master** hears `done` (from `drained` or its moves) and sets its home record to
  `{home: 'global', epoch}`. It keeps a read-only copy (its home gate refuses writes). ⚠ A later move
  to that master needs the copy removed first: the import refuses an org with data.
- **Its desktops follow** (FR-20.82, the second step):
  - `drained`'s `done` answer carries one CLOUD re-point per active desktop of the org
    (`cloudRepointsFor`): the same JWS as P3-6b's, signed afresh on every answer with
    `REPOINT_SIGNING_KEY`, but with `node: 'global'`, `server` = global's own public https origin
    (`OAUTH_BASE_URL`) and NO `fp`;
  - the master keeps them (`keepCloudRepoints`, `NodeState cloud-repoint:<org>`), asking global
    again if the answer was lost;
  - its `movedFor` hands each desktop its own instruction (`desktop:repoint`), or `desktop:moved`
    for one global signed nothing for;
  - the shell (`repoint.rs`) believes a pinless one ONLY for the cloud built into it (`CLOUD`, `https://lgrai.app` unless
    `LGR_CLOUD_URL` at build time): anything else is `not_our_cloud`, and a cloud one carrying a pin
    is `bad_claims`. Followed, it drops the master's pin, saves the cloud and the epoch, and restarts.
    ⚠ Without that rule a pinless instruction would send the till wherever its signer said, trusted
    through the OS store.
  - ⚠ Both verifiers test the cloud cases against the one vector (`repoint-vector.json`, regenerated
    with a new throwaway key: `jwsParts`, `cloudJwsParts`, `cloudOtherJwsParts`,
    `cloudPinnedJwsParts`).
  - Until a desktop release carries the shell's half, the desktops show the org-moved banner and
    re-pair by hand.
- **An abort** (the admin, a refusal, a timeout) leaves the home where it was; the master unfreezes on
  its next report. Global writes no audit entry for it: the org's trail lives on its master.
- `homeDigests` (`move/home-digest.ts`): per collection, over `homePart` (what pages carry, never
  global's or a node's own parts), canonical EJSON with keys sorted at every level (arrays keep their
  order), type-exact (`promoteValues: false`).
- Tests:
  - `move-back.flow` (7): the digest, the preflight, the drain from pages to files to digests, the
    placement and flip, a wrong file replaced, abort and timeouts, and the master's freeze, report,
    leave, refusals and unfreeze;
  - `two-node/move-e2e.script.ts`: the forward move, then BACK with a real `lgr-server` (a file the
    shop made comes home by content and lands at its stored path; global writes the org again).

## Promoting lgrai.app's copy of a lost server (2026-10-27, FR-20.81, plan step P3-6d)

When an org's server is gone for good, the org admin makes lgrai.app's mirror its home: "Promote
lgrai.app's copy" on the Servers page, on the home server's row while it is not connected
(`POST /api/org/:orgId/moves/promote/preflight`, `POST /moves/promote`). Global:
`services/biz/move/promote.service.ts`; `org_moves` with `kind: 'promote'`.
- ⚠ **The danger is not lost data, it is a server that is only cut off**: still issuing invoices in
  the shop above the mirror's counters, while lgrai.app issues the same numbers to other customers.
  So a promotion takes EVIDENCE, and freezes the legal series after it:
  - preflight: the home is one of the org's servers, no other move, the server connected on neither
    socket (one that answers is moved back instead), and a mirror to promote;
  - the attestation: the server is off or destroyed, its tills are disconnected, and the slug typed;
  - 24 h of silence (`SILENCE_MS`, from `ServerNode.lastSeenAt`) unless destroyed is attested
    (`not_silent_long_enough`);
  - the dialog states the loss window (`lossFrom` = `mirror_state.lastPageAt`) AND the
    duplicate-number risk, and how many files lgrai.app lacks.
- **The flip** is the move back's. The move is created `verifying` (no copy, no drain; it takes
  whatever files global holds, `allowMissingFiles`), and `moveBackTick` places the files and flips in
  one transaction: epoch + 1, home global, `homeEpochHighWater`, `mirror_state` deleted, and
  `OrgHome.seriesFrozen {since, reason: 'promoted', moveId}`. Then the content store goes, and the
  org's audit trail (here from now on) records the promotion and its evidence.
- **The legal series** (`LEGAL_SERIES`: `SALES_DOC`, `CASH_SALE`, and every `UNP-<device>`, in
  `sequence.service.ts`) stay frozen until a person records the last number the site issued in each,
  read off the last printed documents and the fiscal device's daily report (`GET`/`POST
  /api/org/:orgId/numbering/last-numbers`, on every node since P3-7; the Servers page's card).
  - Every series lgrai.app knows must be given, so none opens by omission (`series_missing`).
  - Each resumes above the higher of the site's number and the mirror's (`ensureSequenceAtLeast`,
    never lowered). Then `seriesFrozen` is unset, and the change audited.
  - `getNextNumber` (legal prefixes) and `generateUNP` refuse while frozen (`SeriesFrozenError` →
    409 `series_frozen`, in `spaErrorHandler`). Drafts, proformas, bills, orders and journal entries
    go on.
  - ⚠ **Every issuing path refuses BEFORE it moves anything** (`issuableRefusal`):
    - `/send` before its claim and its dispatch;
    - `insertRegisterDocument` before the insert (a storno gives its claim back);
    - an invoice for a cash sale before its placeholder;
    - an import's conversion before its number (one carrying its own number goes on).

    Refused at the allocation alone, a `/send` would leave a draft that had already dispatched.
- **The old server, if it comes back**, learns of the move from its moves (`movesForNode` lists a
  promotion of an org it was home of) and FENCES itself (`move-worker.service.ts#fenceHere`): home
  global at the new epoch, `state: 'fenced'`, `fenceCutoff` = the mirror's watermark at the
  promotion. It writes nothing more of the org and never resumes on its own; what it captured above
  the cutoff is exported to lgrai.app for review (FR-20.84, P3-6e, below). Global's welcome names the
  org `home: 'global'`, so the pump sends nothing of it.
  - ⚠ A done promotion stays in `movesForNode` however old (the others drop out after 30 days): a
    server back after a month must still fence.
  - ⚠ A REVOKED server is never told: its token is refused, and it goes on selling at the site. Revoke
    a server that was stolen, never one that may come back on its own.
- **Replacing a dead server** is a promotion followed by a move to the new machine (FR-20.79): a new
  node with new keys, its desktops paired again (a dead server re-points nothing). ⚠ A till session
  the lost server left open is in the copy, and the move's `no_till_open` refuses until it is closed
  (an admin closes it without the fiscal device: `closeWithoutFiscal`).
- Banners (P3-5): `home.seriesFrozen` on lgrai.app while frozen, `home.fenced` on the old server.
- Tests: `promote.flow` (4: the evidence; the flip, the freeze and the last numbers; the old
  server fencing itself; every issuing path refused before it moves anything) and
  `bun packages/tests/src/two-node/move-e2e.script.ts --promote` (real processes, 32 checks: the move
  to a real `lgr-server`, a file the shop made, the supervisor stopped, the promotion, numbering frozen
  then resumed above the site's number, and the restarted server fenced at exactly the cutoff).

## A master whose database went back locks its legal series (2026-10-27, FR-20.51, plan step P3-7, first slice)

A restore, a reverted snapshot or a clone can make a master issue a legal number the site already
gave a customer. So, on a master, for an org written there, the legal series LOCK
(`OrgHome.seriesFrozen`, the lock a promotion sets) until a person records the last numbers.
`services/biz/home/series-lock.service.ts`; `assertSeriesOpen` and the issuing paths' early refusals
(P3-6d) enforce it.
- **What locks them** (reason `restored` | `went_back` | `clone`, with a detail):
  - an in-app **Replace** restore (`applyRestore`), right before its first write, and only on a
    server lgrai.app never knew (below): a restore refused by a check locks nothing, one that fails
    mid-way stays locked. A **Merge** locks nothing: it only inserts what is missing and clamps every
    counter upwards;
  - the journal below its own high-water mark (`journalHwmTick`): the per-org `repl_orgs.seq` only
    grows in a database never rewound, and the mark lives OUTSIDE it, in `journal-hwm.json` beside
    the node token. Checked at the API's start, BEFORE it serves, and every minute
    (`series-lock-tick`, masters, its first run at start);
  - the journal below **lgrai.app's watermark** (`linkAlarmsTick`; `/self`'s `mirrors`): the other
    mark kept outside, by global. A healthy master is never behind the pages it sent. ⚠ This is the
    one that catches a reverted VM snapshot: its own mark went back with the disk;
  - lgrai.app holding pages of the org **past the newest this database ever built** (`buildPage`,
    when the pump asks: `chain_unknown` with `wentBack`): a restored database whose chain the
    master can no longer continue. ⚠ Its pump stops that org WITHOUT telling global, so this is the
    master's own finding; global never records a refusal for it. Below the newest page built here an
    unknown chain concludes nothing (global may be the one restored);
  - what lgrai.app says of the master (`linkAlarmsTick`, every minute): a clone alarm, or its pages
    refused as a history that went back (`instance_changed`, `stale_journal`, `diverged`) more
    recently than its last applied page. `GET /api/node/v1/self` carries `cloneAlarm`, `wentBack`
    and `mirrors` (per org with a chain: `watermark`, `lastPageAt`);
  - **a clone on the shop's network** (AC 50; `packages/server/src/lan_clone.rs` →
    `state/clone.json` → `lanCloneTick`, at the API's start and every minute). The LAN advert
    carries this start's nonce (`boot`, the uplink's `bootNonce`); every 5 minutes the supervisor
    browses `_lgr-server._tcp` for this node from ANOTHER start at ANOTHER address, and PROBES it: a
    TLS handshake with its LAN ingress that trusts only this server's own LAN CA and checks no name.
    ⚠ The probe is what makes it evidence: an advert is anyone's to send, and a crash leaves this
    machine's own TXT record in caches for up to 75 minutes (RFC 6762), after a DHCP change at another
    address; only a copy of this disk completes that handshake (a clone re-issues its certificate for
    its own address, under the same CA). The record's `at` is renewed at every sighting, so a clone
    still answering after the unlock locks again. Only while the LAN ingress is on (nothing advertises
    otherwise).
- ⚠ **A history that went back is RECORDED once** (`noteWentBack`, `repl_orgs.wentBack {at, reason,
  detail}`; reason `mirror_ahead` or the mirror's refusal), and numbering locks with the record,
  never with the sign. The pump sends the refused history again on every new session and lgrai.app
  dates each refusal anew, so a sign seen again after a person recorded the numbers must find the
  record and change nothing. The re-seed from the mirror is what clears it.
- **The anchor is never evicted** (`buildPage`): `repl_orgs.pages` keeps the 32 newest pages AND
  the one global last said it stands on, and a page built again with the same rows is recorded once.
  ⚠ Before, 32 retries while global could not apply (it errs every 5 s) pushed the anchor out, and
  the org stopped for good on `chain_unknown`, which now would also read as a database gone back.
- **lgrai.app is told** (`reportOrgState`, every minute, `POST /api/node/v1/org-state` →
  `recordOrgState` → `ServerNode.orgState`): per org written there, the journal's head, the
  went-back record and the numbering lock with its reason. Kept for the orgs the server is registered
  for only, known reasons only, text cut short, no date after now; `orgStateFor` puts ONE org's on the
  Servers page (chips "Database went back", "Numbering locked" with the reason as a tooltip, ×4).
  The master's word, shown to the admin: nothing on lgrai.app decides on it.
- ⚠ **A Replace restore is REFUSED on a master lgrai.app knows** (`replaceRefusedHere`, before
  anything is read or written, no `RestoreRun` row): registered at any link level, capturing, or with
  pages of the org built. Its deletes and rewrites are journaled like any other write, so its pages
  would carry the backup's state to the mirror and delete there what the backup lacks (AC 36's "cannot
  overwrite the mirror"). The way back to a backup is a move to lgrai.app and a restore there; Merge
  stays available.
- **The unlock** (`numbering.controller.ts`, `GET`/`POST /api/org/:orgId/numbering/last-numbers`,
  admin, every node; the card on the Servers page, with the reason):
  - each series resumes above the person's reading and, on a master that can ask, the mirror's
    numbers (`GET /api/node/v1/legal-series?orgId=`, `mirrorLegalSeries`; ⚠ a query parameter: a
    path with `:orgId` is a user's org route to the tenant guard); with the link down,
    the person's reading stands alone;
  - it records `seriesUnlockedAt` and resets the mark.
  - ⚠ A sign seen again does not lock again: replication stays refused until a re-seed, and the
    journal may stay below its marks a while. The went-back record decides that (above); a clone
    alarm counts only when it is newer than `seriesUnlockedAt`.
- ⚠ An org arriving by a move resets the mark (`activate`): an org that left and came back starts a
  new journal, which its old mark would read as a rewind.
- **The fiscal device as a witness** (AC 49; `home/device-witness.service.ts`). While numbering
  waits, `GET /numbering/last-numbers` asks each active device of the org for its last document
  (`getLastReceiptNumber`, 5 s). Beside it is the last fiscal receipt this database recorded on the
  device (`register.fiscalReceiptNumber` by `register.fiscalDeviceNumber`), and how many documents
  the device printed since. The `POST` reads them again and keeps them in its audit entry
  (`fiscal device <number>: last document`, the database's receipt → the device's word).
  - ⚠ **Evidence, never a lock or a floor.** An Eltrade's 71h counts every document: receipts,
    stornos, text receipts, X and Z reports, and the keyboard's. So a device ahead is normal after a
    Z-report, and no LGR series steps with it. Locking on it wants the device: what its counter
    counts, and whether it moves when the device sells on its own.
  - States: `read`; `unsupported` (Tremol); `not_connected` (no bridge here: another pod or
    process); `error` (including no answer in 5 s). Nothing asks a device while numbering is open.
  - Tests: `device-witness.flow` (3).
- Bringing a re-seed's kept sales into the books is P3-7g (below).
- Tests: `series-lock.flow` (7: the mark and the unlock; global's alarms, the mirror's floor, no
  re-lock, a refusal dated anew after the unlock locking nothing; the journal below global's
  watermark, no re-lock until the record is cleared; `nodeSelf`; a Replace locking before its first
  write where lgrai.app never knew the server, a refused one or a Merge locking nothing; a Replace
  refused where it knows the server; the report and what lgrai.app keeps of it; a clone on the LAN
  locking, not again after the unlock, again while it goes on answering); `lan_clone.rs` (4: what is a
  candidate; what is recorded; a real handshake: a copy of this disk completes it with a certificate
  re-issued for its own address, another CA and nothing listening do not);
  `replication-pages.flow` (+2: the anchor through 40 rebuilds and the chain going on from it, a
  mirror past every page built here; `pageFor` recording and locking once).

## Re-seeding a server from lgrai.app's copy (2026-10-27, FR-20.71, AC 36, plan step P3-7)

A server whose database went back underneath the mirror (above) can no longer continue its chain,
and its numbering is locked. The mirror is the newest complete copy there is and knows every delete
made since the backup, so the org admin re-seeds the server FROM it: its copy of the org is REPLACED,
never merged ("only what it lacks or holds older" would bring back what was deleted since).
`org_moves {kind: 'reseed'}`, home and epoch unchanged. Global: `services/biz/move/reseed.service.ts`;
the server: `move-worker.service.ts#reseedHere`.
- **Preflight** (`POST /api/org/:orgId/moves/reseed/preflight`, admin): home the server, active; no
  other move; registered at Full, no clone alarm (decide which machine is real first), its seal key;
  both sockets, healthy, room, no till open, no fiscal command; the mirror has a chain; and the
  server's database WENT BACK: its org-state report says so, or the mirror refused its history since
  its last page. ⚠ Re-seeding a server that did not go back replaces newer data with older.
  ⚠ Both routes are for an org written ELSEWHERE, so the home gate must let them through: the
  preflight is in `READ_ONLY_WRITES`, the start in `GLOBAL_STATE_WRITES` (`route-class.ts`). Missing,
  both answered 409 `org_home_elsewhere`; only the real-process e2e saw it, the services-level tests
  call past the gate (`reseed.flow` has an HTTP test for it now).
- **Start** (`POST /moves/reseed {slug}`): created `copying` with `buildingAt: new Date(0)`, so
  `moveTick` takes it at once as "a build that died long ago"; it builds the move bundle of global's
  MIRROR (credentials sealed to the server's key) and `buildMirrorFilesSidecar` (every file the
  mirror's rows name, read from the content store by hash, at its row's path; `buildFilesSidecar` now
  takes explicit `entries`). Nothing freezes on global, and global writes none of the org's trail.
- **The server**, whatever global's preflight said, re-seeds only if `repl_orgs.wentBack` is set;
  else it reports `failed`. Then: the org `frozen` (same epoch) and `repl_orgs.pages` cleared, so
  no page continues the old chain; after 2 × `HOME_CACHE_MS`, everything the org holds is KEPT ONCE,
  for good, at `<org>/docs/reseed/<move>.ndjson.zst` (under `docs/`, so its backups carry it: what
  the server wrote that lgrai.app never received exists only there and on paper), with what the copy
  lacks (`notInCopy`: documents only there, issued sales and their numbers); then
  `discardMoveImport` + `importMoveBundle` + the files + `forgetFeedCursors`, and `copied` with
  `replaced`. A failed round is tried again; the org stays frozen.
- **The flip** (`reseedCopied`): the server's digests are compared with the COPY's (`m.digests`),
  never with the mirror's as it is now (global's own fields of a split document may change
  meanwhile); equal, one transaction claims the move and deletes `mirror_state`, and the server's
  bulk socket is welcomed again. Its pages start a new chain from 0: what the mirror holds, re-sent
  unchanged, and tombstones only for what it never held, so nothing on the mirror is deleted.
- **Done** on the server: unfrozen, the went-back record cleared, the mark reset, the re-seed in the
  org's trail. ⚠ Legal numbering STAYS LOCKED: what the server issued between its last page and the
  failure is on paper and in the fiscal device only, so a person still records the last numbers.
- **Aborted**: the server puts back what it replaced from the kept copy, then unfreezes (a rollback
  that fails leaves it frozen, loudly). An abort before anything was replaced only unfreezes.
- The Servers page offers "Re-seed from lgrai.app's copy" on the home server's row while it is
  connected and says its database went back; the dialog runs the preflight, says what is replaced and
  kept, and wants the slug. The move banner says, when done, how many documents were kept and the
  issued sales among those lgrai.app lacked (×4).
- **The kept sales into the books (P3-7g; `move/kept-import.service.ts`).** On the server's status
  page an org's admin asks once (`GET /org/:orgId/server/kept`, `POST …/kept/:moveId/import`: admin
  or `admin.settings`, on the server only, for a re-seed that FINISHED, i.e. phase `active`). The
  server's `kept-import-tick` then runs the kept file under the fenced import's own rules: the
  shared `Ctx` now carries `runId` and `source`, and `importedFrom.kind` is `reseed_kept`.
  - **The candidates.** The file is read once. Its documents are checked against the org as it is
    now, in batches of 1,000 ids. Only those it holds no longer are candidates, plus this run's own
    earlier imports, so a run cut short finishes and records them.
  - **Brought in:**
    - every NON-DRAFT invoice, booked here (stock below zero if need be, the journal entry, the
      payments' entries);
    - the till sessions they name, journaled at the end once all their sales are in;
    - movements of their own that moved stock;
    - the contacts, products, categories and stores these NAME.
  - ⚠ **Master data only when named.** Nothing in the app hard-deletes it, so a named one is new
    work. An unnamed one might be something a raw script deleted after the restore point, so it is
    counted in `keptOnly` and never resurrected.
  - **Left for a person:** drafts (`kept_draft`), and what names something neither copy holds. A
    number the copy gave to another document comes in flagged (AC 51, below).
  - **Never touched:** what the copy holds.
  - **Bookkeeping.** Rows in `fenced_import_items` with the re-seed's id as the run, state in
    `NodeState` `kept-import:<moveId>` (lease 10 min), audited. Numbering continues above every
    number brought in (no lock check: it is a raw counter bump, never an issue).
- Tests: `reseed.flow` (7: the preflight and its went-back evidence; the copy of the mirror with its
  files and the flip, the mirror losing nothing; the routes through the home gate over HTTP; a
  differing copy aborted; the server freezing, keeping, replacing and unfreezing with numbering
  still locked; a server that did not go back refusing; an abort rolling back from the kept copy);
  real-process `two-node/move-e2e.script.ts --reseed` (a real master's documents, journal and
  outside mark taken back to a snapshot, the mirror ahead: found by the master itself, recorded,
  locked, told; re-seeded; what was made since back, what was deleted since gone, the mirror
  untouched, a new chain caught up).

## Reconciling lgrai.app's copy after a master lost the record of its changes (2026-10-27, FR-20.70, plan step P3-7f)

Lost history (FR-20.61: the oplog no longer reaches the saved resume token, a token that no longer
parses, an invalidate, a captured collection DROPPED) raises the master's journal epoch, and the
tailer journals every document it HAS again (`seedOrg(…, 'upsert')`). What it DELETED in the gap is
in no row. Until P3-7f global refused the new epoch (`reconcile_required`) and the pump stopped the
org: the mirror stalled for good. Now (`services/biz/replication/reconcile.ts`, `apply.ts`):
- **Global applies the epoch's first page if it continues the chain** from the watermark
  (`decide` → `reconcile`): the master still holds the page global stands on, so its database did
  not go back under the mirror (that is the re-seed's, above). `mirror_state.reconcile
  {journalEpoch, since, deleted, kept[], head?, doneAt?}` follows it.
- **The master drives the id pass** (`mirrorReconcileTick`, every minute, master only, at Full): for
  an org written there whose journal is whole at an epoch above `repl_orgs.reconciledEpoch` (set at
  the FIRST seeding; absent means 1), it asks `GET /api/node/v1/reconcile/ids?orgId=&coll=&after=`
  (EJSON, the ids keep their types; 1,000 a page, 50 pages a tick) and journals each id again
  (`rejournal`: as it is here, or as GONE). Where it stands is `repl_orgs.reconcile`, so a cut tick
  goes on from there. With every id asked it reports `POST /reconcile/done {orgId, journalEpoch,
  head, asked}` and marks the epoch reconciled; global sets `doneAt` once its watermark reaches
  `head` (checked against the watermark as it is NOW: a page applied meanwhile read no head).
- ⚠ Global answers only the org's home, registered for it at Full, with no clone alarm, and only the
  ids of ITS copy of that org (FR-20.66). The org's own document is never asked.
- ⚠ **No page deletes an issued sale** (FR-20.51; `issued-sales.ts`: an invoice with a number that
  is not a draft, any till transaction): a tombstone for one the copy holds is not applied, the copy
  keeps it, with a `sale_kept` alarm and on the reconcile's `kept` list. Nothing on a home deletes
  one (a draft only), so a home without it lost it, and the copy may be its only record.
- Numbering is NOT locked: the master lost a record of its changes, not its data. The move back
  waits while a reconcile runs (`mirror_live`). The Servers page's "Files on lgrai.app" card says
  the copy is being made equal to the server again, then when it was, how many documents went, and
  the issued sales it kept (×4).
- Not yet: the reconcile on demand, and after the journal's tombstones are pruned (nothing prunes them).
  ⚠ A kept sale also holds a move back (the copy then differs from the server, and P3-6c waits on a
  mismatch): bringing it back onto the server is the same audited import the re-seed's kept sales
  wait for.
- Tests: `mirror-reconcile.flow` (7: the copy made equal, what the gap deleted gone, what it changed
  come, an issued sale kept; only a chain-continuing page raises the epoch; the master's word before
  the first page; no page deletes an issued sale; the ids to the org's home only, page by page; a
  first seeding needs none; a cut tick goes on); real-process `two-node/move-e2e.script.ts --reconcile`
  (a captured collection dropped on a real master and an issued sale deleted unseen: a new epoch,
  taken by lgrai.app, the copy made equal but for the sale it keeps, numbering open).

## What a fenced server did after the cutoff (2026-10-27, FR-20.84, plan step P3-6e)

A server that comes back after a promotion fences itself (above), then EXPORTS everything its
journal captured above the cutoff and sends it to lgrai.app, where a person reviews it and brings it
into the books through the audited import (second half, below). Nothing is imported on its own. `services/biz/move/fenced-export.service.ts`; the master's half is
`move-worker.service.ts#exportFenced`.
- **What it holds** (`lgr-fenced/1`, one zstd stream):
  - every document behind a `repl_journal` row above `fenceCutoff`, as a move carries it
    (`moveProjection`);
  - ⚠ also every row of another journal epoch than the cutoff's (`OrgMove.fenceJournalEpoch`, from
    the mirror at the promotion): a lost history journaled them again, and whether global saw them
    is unknown;
  - a document gone since, as a deletion;
  - the bytes of the files those rows name (`DocFile.currentPath`, a local `File.storagePath`),
    inline, so the evidence is one artifact; a file not on disk is counted (`missingFiles`);
  - a header (org, node, promotion, cutoff, epoch, journal head) and a trailer with every section's
    count and sha256.
- **Built once and kept** under the org's `docs/fenced/fenced-<moveId>.ndjson.zst`, on the master and
  on global alike, so both sides' backups carry it. ⚠ Never discarded, whatever its state: it is the
  evidence the audited import keeps (Прил. 42: full, unchanged, with source and time).
- **Sent in chunks** of at most 4 MB (`PUT /api/node/v1/moves/:id/fenced-export?offset=&size=&sha256=`,
  `GET` the same for where global stands), 16 a tick. A chunk anywhere but where global stands is
  answered 409 `offset` with that offset, so a cut link resumes.
  - The first chunk fixes size and sha256 for good: another is 409 `export_changed`.
  - Global writes at the offset and NEVER truncates: a slow retry of an earlier chunk must not cut off
    the ones after it.
- **Checked when whole**: the sha256 against the announced one, then `readFencedExport`, every section
  against the trailer. Either failing makes it `refused`, kept on both sides (`fenced_exports`, node
  state, records its arrival).
  - ⚠ One org's (AC 38): a document of another org, a collection a move does not carry, or a file path
    outside the org's tree refuses the bundle.
- **The review** (`GET /api/org/:orgId/moves/fenced-exports`, admin; a card per export on the Servers
  page): counts per collection, deletions, files, and the sales and invoices by number, each checked
  against lgrai.app NOW:
  - `absent`: new here;
  - `same_id`: made before the cutoff, changed after;
  - `collision`: lgrai.app gave its number to another document, which the import will resolve by a
    credit note and a re-issue (FR-20.51), never by an edit.
- Tests:
  - `fenced-export.flow` (6): what it holds, AC 38, the chunked receipt, refused and kept, the
    review's three cases, and the worker exporting once and sending until global has it, across a
    cut link;
  - `move-e2e.script.ts --promote` (43): the shop's link CUT by the chaos proxy, two sales made while
    cut, the promotion, and on the link's return the fence, the export with exactly those sales and
    their customer, the same bytes on both sides, the review naming the collision, and the import.

### The audited import (second half)

"Bring into the books" on the review card (`POST /api/org/:orgId/moves/fenced-exports/:id/import`,
admin, asked once) sets `FencedExport.import`. Global's `fenced-import-tick` (every 10 s) runs it in
batches of 200 under a 2-minute lease, phase by phase:
- what a sale names (contacts, product categories, products, warehouses, tags);
- till sessions;
- sales;
- stock movements;
- documents and their files;
- the site's audit trail.

`services/biz/move/fenced-import.service.ts`.
- **Kept as it was** (Прил. 42): a document new to lgrai.app is inserted with its own `_id`, number,
  dates and content. A sale gets `Invoice.importedFrom` {kind, exportId, moveId, nodeId, at, by}. What
  it points at that stays behind is dropped: `journalEntryId`, each payment's `journalEntryId`,
  `register.movementId`.
- **Booked here as lgrai.app would have** (`bookSale`):
  - an issued sale: `createInvoiceStockMovement` with `allowNegative` (the goods left), its entry
    (`postInvoiceJournal`), each payment's entry (`postPaymentJournal`, on THAT payment), and
    `syncOrderForInvoice`;
  - an invoice for a cash sale books nothing of its own (#171);
  - a bill: its receipt and its orders, no entry (as `/receive`);
  - a till sale: its stock, `register.movementId` set to it. Its entry is its session's: an imported
    closed session drops the site's `journalEntryId` and is posted at the end
    (`postPosSessionJournal`), only if EVERY sale of it came in;
  - a stock movement of its own (a delivery, a transfer, a write-off) that the site applied
    (`completed`/`confirmed`): inserted as a draft, then `confirmMovement`. A movement number lgrai.app
    has since used gets the next one (`importedFrom.number` keeps the site's).
- **All or nothing per document**: a sale whose stock cannot be booked is taken out again (`failed`).
- **Left for a person, each with why** (`fenced_import_items`, node state, one row per document):
  - `same_id`: changed here as well;
  - `number_taken`: only before migration 0010, or a third document for a number already
    issued twice (since AC 51 a second one comes in flagged, `imported:number_clash`);
  - `missing_reference`: a sale naming a product, warehouse or customer lgrai.app does not hold;
  - `made_by_its_sale`: a movement its sale's import makes again;
  - `unique_conflict`;
  - `deletion` (never applied);
  - `not_imported_kind`: everything else, journal entries and payment/cash orders included.
  - A draft's number is no legal number: a taken one gets the next draft number.
- **Numbering continues above** every number imported (`ensureSequenceAtLeast`), the УНП of each
  device included.
- **Resumable**: a document already ours (`importedFrom.exportId`) is booked on, never inserted
  again, and every booking checks what it would create first: a stock movement for the sale, its
  `journalEntryId`, each payment's, the session's.
- ⚠ `postInvoiceJournal`/`postPosSessionJournal` are the event handlers' bodies, exported unchanged
  (refactor only). `invoice.posted` itself is NOT idempotent: the import checks `journalEntryId` first.
- ⚠ The repository's invoice carries its payments WITHOUT their `_id`s or entries:
  `postPaymentJournal` reads the invoice raw and stamps the one payment with a positional `$set`.
- ⚠ `confirmMovement` leaves `completed`, not `confirmed`: test for both.
- The review shows, per sale, what the import did; the server's name comes with the export, so a
  removed server shows its name, not its id. Count labels are plural-free ("Files: 1") in all four
  languages.
- **A legal number issued twice (AC 51, FR-20.51; `services/biz/number-clash.service.ts`).** Both
  documents are on paper, so both are in the books under the number. The second to reach the database
  carries `numberClash {withId, withNumber, source, at}`.
  - ⚠ **The unique key is `{orgId, invoiceNumber, numberClash.withId}`** (`INVOICE_NUMBER_KEY`,
    migration `0010-invoice-number-clash`, which replaced `orgId_1_invoiceNumber_1`). Every
    ordinary invoice has no `numberClash` and the key reads it as null, so `(org, number)` stays
    exactly as unique for them. The pair's second fits; a third never does.
  - ⚠ **`numberClash` is a SINGLE NESTED SUBDOCUMENT**, like `cashSaleRef`. A nested-path object
    would be materialised on every invoice (as `stockSource` is), and the key would no longer read
    null for ordinary documents.
  - ⚠ **A partial index cannot do this:** `partialFilterExpression` takes no `$exists: false`.
  - **Remedy** (spec §5.5, ЗДДС чл. 116): the LATER of the pair is annulled by a credit note and
    re-issued under a new number, never edited or deleted. "Prepare the correction"
    (`POST /org/:orgId/invoicing/number-clashes/:id/prepare`, `invoicing.write`; listed by
    `GET …/number-clashes`) makes two DRAFTS for a person to issue:
    - a credit note (`relatedInvoiceId` = the later document) and its re-issue;
    - both carry `stockSource.marker` `number_clash:<id>`, so neither moves stock;
    - neither copies the lines' `orderRef`;
    - payments stay on the annulled document, for a person to allocate.
  - Only an outgoing invoice is prepared. A cash sale's legal number is its УНП, so a cash-sale pair
    is corrected by a person.
  - The Sales invoices list shows the banner and the dialog (`NumberClashBanner.vue`, ×4).
  - Rollout: `bun run migrate` on prod after the deploy. Until it runs, the old key refuses the
    pair and the imports leave it `number_taken`, as before.
- Tests: `number-clash.flow` (5: the key; the migration twice; the correction, of either
  document, stock-free and once; a cash sale refused; the routes), and the fenced and kept imports'
  flags.
- Tests: `fenced-import.flow` (3: the real export of a second database playing the site, imported to
  the end and checked against the books; a crash repeating nothing; the refusals).

## Read-only where the org is not written (2026-10-27, FR-20.75, plan step P3-5, first half)

Above every page of every app, `ui-shell/HomeBanner.vue` says when the org is not written here. It
reads `GET /api/org/:orgId/home` (`services/biz/home/home-status.service.ts`, `home.controller.ts`):
any member of the org may, nothing in it is secret, and it is in the PIN scope too.
- **On lgrai.app, an org homed on one of its servers** (`home: 'master'`) is a read-only copy:
  - the server's name, and whether it holds both sockets now;
  - while it does not, since when (`lastSeenAt`);
  - as of when the copy holds (`mirror_state.lastPageAt`).
  - Online it is an info banner; offline, a warning.
- **On a master, an org that went back to lgrai.app** (`home: 'global'`): the read-only copy it keeps.
- **A move under way** (`moving`: the home record not `active`, or a live `org_moves` row): nothing can
  be written until it ends.
- **After a promotion** (P3-6d): `seriesFrozen` on `home: 'here'`, a warning until the site's last
  numbers are recorded; and `state: 'fenced'` on the server it replaced, which is no move (`moving`
  leaves it out) but a server that writes nothing more of the org.
- An org written here: nothing shows (`home: 'here'`).
- Polled every two minutes, so a server going offline, or coming back, shows without a reload.
  The page that changes where the org is written says so at once (`ui-shared/useHomeChanged`:
  the Servers page when a move starts or ends, and when a promotion's last numbers are saved), or
  the banner went on saying "numbering waits" under "numbering resumes" for up to two minutes.
- **A refused write says why, in the reader's language.**
  - `setRefusalTranslator` (`ui-shared/useHttpClient`): the shell registers its words for a 409 the
    server names by code, and the interceptor rewrites `data.message`, which is what every view already
    shows. The client itself has no i18n.
  - `org_home_elsewhere` → `home.writeRefused`, `series_frozen` → `home.seriesFrozen`. Strings:
    `home.*`, ×4.
- The org's own address (P3-4) shows a static notice while its server is offline, never a sign-in
  (`portal-api/src/tunnel/notice.ts`).
- Tests: `home-status.flow` (4).

## The mirror's files (2026-10-27, FR-20.66, FR-20.69, plan step P3-3)

An org homed on a master sends its files to lgrai.app's mirror behind its documents, on the bulk
socket. Global stores and reads them BY CONTENT, per org: `<UPLOAD_DIR>/<orgId>/blobs/<sha256>`,
recorded in `mirror_blobs` (`MirrorBlob`, node state). ⚠ Never where a mirrored row says: the
row's path is the master's to choose.
- **Who asks for what** (`services/biz/replication/mirror-blobs.ts#wantBlobs`): once an org's pages
  are caught up, the supervisor sends `blob-sync {orgId}`. Global answers `blob-want {want: [{sha256,
  offset, size}], more, files}`: the contents ITS rows of that org name and it does not hold
  (`DocFile.currentChecksum` of a document not in an archive, `File.sha256` of local rows, and
  `ArchiveUnit.sha256`), 64 at a time.
  - ⚠ Computed per org and from nothing the master lists. A store shared across orgs, or an answer
    from the master's own list, would tell any master whether another org holds some file (AC 52).
    Two orgs with the same bytes hold two rows and two files.
  - This replaces the plan's `blob-have {sha256[]}`: the master lists nothing.
- **Chunks** (`blob-frame.ts`): `LGRB` + version + a JSON header `{orgId, sha256, offset, size}`
  + at most 1 MB. The magic is not zstd's, so a chunk is never taken for a page.
  - The master's API reads them (`blob-source.ts#blobFor`, `POST /replication/blob` on the control
    socket): the org's rows with that hash (current documents, versions, deleted ones, imports,
    archive units), and only if the org is homed here at Full. At offset 0 it hashes the whole file
    first, so bytes that are not what their row says never leave (`hash_mismatch`).
  - Global (`acceptChunk`) takes a chunk only from the org's home (registered, Full, no clone
    alarm), only for a content it asked for, and only at its own offset. Anything else is answered
    with where to resume. The file grows as `<sha256>.part` and is named `<sha256>` once whole AND
    hashing to its name. A bad file is dropped and asked for again after a growing wait (10 min,
    doubling, at most a day).
  - `blob-unavailable`: the master holds no readable bytes for a content global asked for. Asked
    again after 6 h, and counted as **missing on the master**, which there is lost data.
- **The supervisor** (`replication.rs`): pages first, then a page is asked for before every chunk.
  While files wait, every other turn is theirs, so a busy shop's pages cannot starve them. It asks
  again after pages brought rows (at most every 10 s), and every 10 minutes regardless.
  - Files only where the welcome says `files: 'all'`. A global older than P3-3 says nothing, and
    gets nothing.
  - ⚠ `not_ready`, `not_full` and `not_home` from the API wait 10 s, never the 10 minutes of other
    refusals (`LAGGING`). The API reads the link level and the home through 5-second caches, so right
    after a registration at Full it may still say `not_full`. That stalled a fresh master's first pages
    for ten minutes; the mirror e2e caught it.
  - `lgr-server status` shows `bulk.replication.<org>.files`.
- **Global's own copy from before a move** is taken, never asked for. A file at a mirrored row's
  stored path, under the org and outside `blobs/`, that hashes to the row's content is COPIED into
  the store (a reflink where the filesystem has them, never a hard link: the original stays global's
  own). Bounded per ask (200 files / 512 MB). The same happens on read, one file at a time, so such a
  file opens even for an org that mirrors its records only.
- **Read by content** (`readsByContent`: on global, an org whose home is not global):
  - `resolveDownload`: the current file by `currentChecksum`; `?version=` by the version's `File`
    row; an archived document out of its unit's blob, checked against the row's checksum, and NEVER
    written back.
  - `getVersions` from the `File` rows, never `readdir`.
  - The compare dump is refused: it is made where the org lives.
  - A file not there answers 404 `file_not_mirrored`, or `files_not_mirrored` for a records-only
    org. The Files app says either in words (`mirror.*`, ×4).
- **Records only** (the metadata-only option): `Org.settings.node.mirrorFiles: false`, global's own
  part of the org, which no page overwrites. Set on the Servers page ("Files on lgrai.app", shown
  while a server is the org's home) through `GET/PUT /api/org/:orgId/nodes/mirror` (admin.settings,
  `GLOBAL_STATE_WRITES`). The PUT re-welcomes the master (`rewelcomeNode`), whose pump reads the
  choice from its welcome. Files already on the mirror stay and keep opening.
- **`mirrorFilesStatus`**: referenced, held, arriving, waiting, missing on the master, failing, and
  `complete`, which is what a move back (P3-6c, FR-20.80) must wait for.
- `MIRROR_FILES_MAX_GB` (50 by default) caps one org's files on the mirror. Past it, global asks for
  no more and raises an alarm: a master could otherwise fill the disk every org shares.
- Indexes: `File {orgId, sha256}` (partial), `DocFile {orgId, currentChecksum}`.
- ⚠ The mirror's own writes on a GET (taking a pre-move copy, re-asking for a file the disk lost) are
  global's node state (`mirror_blobs` and `blobs/`), never the org's data.
- ⚠ Global writing its own part of a mirrored org passes `{ timestamps: false }`. Mongoose would
  otherwise set `updatedAt`, which is the home's field, and the mirror would differ from the home
  until the master next sends the org. The e2e's digest caught it.
- Not yet:
  - removing blobs no row names any more;
  - pacing against the interactive socket (P3-2c);
  - putting blobs back at their stored paths when an org comes home to global (P3-6c, P3-6d).
- Tests:
  - `mirror-files.flow` (9): the lane, isolation, records only, pre-move copies, reads by content
    (AC 63), and an end to end through `blobFor` and the uplink;
  - Rust `replication::tests` (6 new);
  - `two-node/mirror-e2e.script.ts`, with a real supervisor: two files, one in three chunks, reach
    global and open there; records only stops a new file, and switching back sends it.
