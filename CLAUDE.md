# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

**What this file holds** (FR-32.13, #797): the commands, the layout, the contracts that do not move, and the
traps (⚠) that are not one area's. It stays at most 800 lines: `packages/tests/src/unit/claude-md.test.ts` fails
above that.
- **Each area's traps** are in a path-scoped rule file, `.claude/rules/<area>.md`, which loads when a session
  touches that area's files. **What was built**, release by release, is in `docs/history/<area>.md`. The table
  under "Areas" names them.
- ⚠ **Add to the right place.** A trap of one area goes in its rule file, its story in its history; only a rule
  every session needs goes here. History written here is what made this file 5 700 lines.
- A code comment that says "see CLAUDE.md" may mean a section that now lives in one of those files: search
  `.claude/rules/` and `docs/history/` for its words.
- `bun scripts/claude-md-warnings.ts [<ref>]` lists every ⚠ of `CLAUDE.md` at a git ref that is in neither this
  file nor a rule file now.

## Issue workflow: assign before you implement

An agent does not write code for a GitHub issue until the issue is assigned:

1. Read the issue **and its comments** first. An owner's hold ("wait until X merges") blocks the work
   just as an assignee does.
2. If the issue is assigned to someone else, stop and ask the human you work for. Don't implement it.
3. Otherwise assign it to the human you work for (the account `gh` is signed in as), then begin:
   `gh issue edit <n> -R gjovanov/lgr --add-assignee @me`
4. Confirm it took (`gh issue view <n> -R gjovanov/lgr --json assignees`), then branch, and put
   `Closes #<n>` in the PR.

Assigning first stops two agents from working the same issue in parallel. It applies to issues in
`gjovanov/lgr-deploy` too.

## Project Overview

**LGR (Ledger)** is a full-stack multi-tenant ERP system built as a Bun monorepo. Stack: Elysia.js + MongoDB/Mongoose + Vue 3/Vuetify 3 + Pinia.

The system follows a **multi-app architecture** (Google Workspace model): a Portal app handles auth, tenant management, and an App Hub that links to 6 domain apps. Since FR-24 it is one app in the tree too: ONE API package (`packages/api`, a single process on one port) and ONE web app (`packages/web`), each domain a folder in both.

## Commands

```bash
# Development
bun run dev                  # Unified API (4001) + the web app's Vite server (4200, proxies /api and /ws); `bun run dev -- api` = API only
bun run start                # Production: unified API (4001) serving the built web app
bun run build                # Build the web app (packages/web: the portal + every module) and desktop-ui
bun run check:web            # The web app's bundle budget (FR-24.15)
bun run typecheck            # tsc + vue-tsc against scripts/typecheck/*.baseline.json (FR-32.2); CI's `typecheck` job.
                             # A new error fails; so does a fixed one until `bun run typecheck --update` shrinks the baseline
bun run lint                 # oxlint, 4 rules (.oxlintrc.json), against scripts/lint/baseline.json the same way (FR-32.5)
bun run seed                 # Seed database (Acme Corp + Beta Inc)
bun run migrate              # Apply pending versioned migrations (--status lists them; FR-20.19)

# Desktop (a server-mode client - it opens the cloud app; no local mode, no local data)
bun run dev:desktop-ui       # The shell's own pages (4081)
bun run tauri:dev            # Tauri desktop shell
bun run tauri:build          # Build Tauri app

# Testing
bun run test                 # All integration tests (mongodb-memory-server)
bun test packages/tests/src/integration/auth.flow.test.ts  # Single test file
bun run test:e2e             # Playwright E2E tests
bun packages/tests/src/with-test-mongo.ts bun packages/e2e/scripts/nightly.ts --grep @smoke --retries=0
                             # The PR smoke (FR-32.6, e2e-smoke.yml): the five `@smoke` tests, on a pull request touching the UI
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
  services/            → Business logic (biz/), the four DAOs left (dao/: org, user, invite, code), background tasks, events, mixins, logger
  reporting/           → Excel (ExcelJS) + PDF (HTML or markdown, printed by Chrome) export generators
  fiscal/              → Fiscal printer abstraction (IFiscalPrinter, Datecs protocol, device manager, NTP sync, VAT groups)

  # ── DAL (Data Abstraction Layer) ──
  dal/                 → DAL interface definitions (backend-agnostic)
  dal-mongo/           → MongoDB DAL implementation (cloud)

  # ── The API: ONE package, one process on port 4001 (FR-24.31) ──
  api/                 → Elysia. src/ is the portal: unified.ts (the entry point) mounts ALL controllers
                         (api.ts), and the portal's own: auth, oauth, org, user, invite, stripe, file,
                         notification, app-hub, export, tag, fiscal-device, workstation, supto-export
                         (src/controllers/), plus auth/, front/, lib/, tunnel/, websocket/
    src/accounting/    → 14 accounting controllers
    src/invoicing/     → 16 invoicing controllers (invoices, orders, reservations, POS, document import, …)
    src/warehouse/     → 15 warehouse controllers (includes pricing, bulk-pricing, ledgers)
    src/payroll/       → 4 payroll controllers
    src/reports/       → 1 reports controller (catalog + generic runner + generic export)
    src/files/         → 1 files controller (document ingest, FR-12)
                         Each domain: controllers/, auth/, and lib/ where it has one. Until FR-24.31 these were
                         the packages portal-api and <domain>-api; the files kept their names.

  # ── Other packages ──
  migrations/          → Versioned data migrations, `bun run migrate` (FR-20.19)
  ocr-server/          → OCR + AI drafting sidecar (its own Deployment, `Dockerfile.ocr`)

  # ── The web app: ONE Vue 3 + Vuetify 3 SPA (FR-24.21) ──
  web/                 → index.html, main.ts, the router composing every module (routes.ts, router.ts, modules.ts),
                         the one shell (OneShell.vue → ui-shell ModuleLayout), stale-build handling (stale.ts)
  # ── Its modules, in web/src/modules/<id> (FR-24.31; the <id>-ui packages until then, files unchanged):
  #    views, stores and a manifest each (manifest.ts) ──
    modules/portal/    → Login, register, oauth-callback, app-hub, settings, admin, billing, audit log (routes.ts)
    modules/inventory/ → Products, stock, movements, valuations (/inventory/*)
    modules/invoicing/ → Contacts, invoices, bills, cash sales, payments, and the till (sources in pos/):
                         terminal, sessions, fiscal devices, PIN pad (/invoicing/*)
    modules/accounting/ → 10 accounting views + store
    modules/payroll/   → 5 payroll views + store
    modules/files/     → Document ingest: upload, analyze, commit, reconcile (/files/*)
    modules/reports/   → Report card hub + generic runner + the two moved invoicing report pages (/reports/*)

  # ── Shared UI library ──
  ui-shell/            → AppShell, AppSwitcher, OrgSwitcher (top-bar org menu), NewOrgDialog, OrgSelector, UserMenu, NotificationBell, sidebar
  ui-shared/           → Shared composables (useHttpClient, useSnackbar, …), i18n, vuetify plugin, shared components (PriceExplainButton, TagInput, etc.);
                         a file nothing imports fails `unit/unimported-shared-files.test.ts` (FR-32.10)

  # -- Desktop (a server-mode client, FR-14) --
  desktop-ui/          -> The shell's own pages: Overview, Settings, Onboarding, Logs, Diagnostics
  desktop/             -> Tauri 2 shell (Rust). Opens the cloud app in an lgr-web window.

  # ── Testing ──
  tests/               → Bun integration tests with mongodb-memory-server
  e2e/                 → Playwright E2E tests
```

### Unified API (single process)

All controllers (portal + 7 domains) are mounted in a single Elysia server at `packages/api/src/unified.ts`:
- **Port 4001** — single process, single MongoDB connection
- All routes under `/api` (e.g., `/api/org/:orgId/accounting/accounts`)
- Serves the built web app (`packages/web/dist`, or a server package's `ui/web`): its files under `/ui/`
- SPA fallback answers every non-API, non-asset path with its `index.html`: a module's path gets the
  variant without lgrai.app's analytics tag (FR-24.18), `/pos/*` a 302 to the till's pages in Invoicing
- Swagger docs at `/swagger` (`api/src/api-docs.ts`, S-11): on global outside production; under
  `NODE_ENV=production` only with `SWAGGER_ENABLED=true`; never on a master (FR-20 AC 66)
- WebSocket server for real-time updates

Each domain's folder (`api/src/accounting/`, `api/src/invoicing/`, …) exports controllers that `api.ts` imports by relative path.

### Package dependency flow
`config` ← `db` ← `services` ← `fiscal` ← `api` (its domains' controllers are folders of it)
Each module in `web/src/modules/` imports `ui-shell` + `ui-shared`; `web` composes the modules' manifests and routes and
talks HTTP/WS to the unified API on its own origin

## Areas: rules and history

| Area | Traps (loads with the area's files) | What was built |
|------|-------------------------------------|----------------|
| Access: people, orgs, sessions, roles (FR-27) | [`.claude/rules/access.md`](.claude/rules/access.md) | [`docs/history/access.md`](docs/history/access.md) |
| Accounting, payroll, sealed personal data | [`.claude/rules/accounting.md`](.claude/rules/accounting.md) | [`docs/history/accounting.md`](docs/history/accounting.md) |
| Deployment and the cluster | [`.claude/rules/deployment.md`](.claude/rules/deployment.md) | [`docs/history/deployment.md`](docs/history/deployment.md) |
| Files, document import, storage, backups | [`.claude/rules/files.md`](.claude/rules/files.md) | [`docs/history/files.md`](docs/history/files.md) |
| Fiscal devices, the till, SUPTO | [`.claude/rules/fiscal.md`](.claude/rules/fiscal.md) | [`docs/history/fiscal.md`](docs/history/fiscal.md) |
| Invoicing documents | [`.claude/rules/invoicing.md`](.claude/rules/invoicing.md) | [`docs/history/invoicing.md`](docs/history/invoicing.md) |
| Nodes: masters, supervisor, mirror, desktops (FR-20) | [`.claude/rules/nodes.md`](.claude/rules/nodes.md) | [`docs/history/nodes.md`](docs/history/nodes.md) |
| Platform: module catalogue, plans, resolved known issues | [`.claude/rules/platform.md`](.claude/rules/platform.md) | [`docs/history/platform.md`](docs/history/platform.md) |
| Reports, exports, PDFs, the digest | [`.claude/rules/reporting.md`](.claude/rules/reporting.md) | [`docs/history/reporting.md`](docs/history/reporting.md) |
| Warehouse, products, pricing, orders | [`.claude/rules/warehouse.md`](.claude/rules/warehouse.md) | [`docs/history/warehouse.md`](docs/history/warehouse.md) |
| The web app and its lists (FR-24) | [`.claude/rules/web-app.md`](.claude/rules/web-app.md) | [`docs/history/web-app.md`](docs/history/web-app.md) |

Before changing an area, read its rule file: it loads only once a file it names is opened. The specs are
`docs/fr/FR-*.md`, the architecture pages `docs/architecture/`.

## Multi-Tenancy

Every data model uses `tenantPlugin`, which adds an indexed, required `orgId` field — **and nothing else**. It does **not** filter queries (`packages/db/src/plugins/tenant.plugin.ts`). A `Model.find({})` returns every org's rows; passing `{ orgId }` is on the caller.

All API routes are scoped: `/api/org/:orgId/[module]/[resource]`, and **that is where tenancy is enforced**. `isForeignOrg` (`packages/services/src/biz/tenant-guard.ts`) is registered as a `beforeHandle` hook by `AuthService` and by `AppAuthService` (`services/http/app-auth.service.ts`, one copy since FR-24.30, re-exported by each domain's `api/src/<domain>/auth/`), so every authenticated route whose path carries `:orgId` rejects a caller whose JWT names a different org with **403**. It is applied by default — there is nothing for a new controller to opt into, and no exception list (gjovanov/lgr#41). The property is asserted over the real route table by `packages/tests/src/integration/tenant-isolation.flow.test.ts`.

**A write needs the capability its route names** (S-28, FR-27.2). Every non-GET route under `/api/org/:orgId` resolves to a rule in `packages/config/src/access/routes.ts`: the capabilities it needs (`anyOf`: `sales-docs.create`, `journal.post`, …), `self` (the controller guards itself, e.g. `canAccessReport`; its `floor` is refused first) or `member` (any member, e.g. a note). The two auth plugins (`AuthService`, `AppAuthService`) enforce it in a **transform** hook (`access/evaluate.ts#decideAccess`, on the person's role), so a caller without it gets 403 before the body is validated; the Administrator (`grant.all`) always passes. (FR-27 P3-6: the legacy permission rules of `route-permission.ts` and `permissionRefusal` are gone.) ⚠ A new write route fails `route-permission.flow.test.ts` until it has a rule, and is refused at runtime meanwhile. ⚠ The refusal is THROWN (a transform hook cannot return one), and `spaErrorHandler` passes a thrown status through; anything else it is handed becomes a 500.

**A 500 says only what `api/src/lib/server-error.ts` lets through** (S-12). The server's own words pass (`throw new Error('Insufficient stock for …')`, and every class of ours), and the UI shows them. The machinery's never do: the runtime's (`TypeError`…), Mongoose's and the driver's, the OS's (`ENOENT`…), and any message quoting a server path become `Internal server error (ref <10 hex>)`. A schema rejection and a duplicate key are said as field names. Every 500 carries `ref`, and the log line has the same `ref` with the method, path and whole error: find a user's report by it. ⚠ To tell a person something, throw an `Error` written for them; a driver's or Mongoose's text never reaches them. ⚠ A controller that catches and answers `status(500, { message: e.message })` itself bypasses all of this: rethrow instead.

**No answer carries a secret** (S-14). `no-secrets-in-responses.flow.test.ts` puts a marker in every secret-looking field of every model (a password, a verifier, a token or its hash, an OAuth link's provider tokens) and calls every route as an admin: a route that answers with one fails it. A user leaves the server through `USER_PUBLIC_PROJECTION` / `publicUser` (`services/dao/user.dao.ts`). ⚠ `User.password` is deliberately NOT `select: false`: backups, org moves and FR-20's replication read `User` through Mongoose and must carry the hash. **An anonymous caller gets 401 before validation** (S-15): all four auth plugins refuse in their transform hook, so a route's schema is never described to someone without a credential; a new auth plugin needs the same. **A password a person sets has at least 12 characters** (S-09): a body field named like a password either sets one with `minLength: 12` or is listed in `password-minimum.flow.test.ts` as only proving one.

**So does a read** (S-29). Every GET under an org resolves to a read rule in `config/access/routes.ts` (`READ_PREFIXES`, `EXACT_READS`), the same three kinds, enforced by the same hook.

**A document names records of its own org only** (S-35). `db/plugins/reference-guard.ts`, installed by `tenantPlugin` beside the home guard, reads the reference fields from the schemas (`ref:`) and refuses a write made inside a request whose NEW references name a record of another org: 422 `{ code: 'foreign_reference', path }`. It sees create/save, insertMany, the update queries (`$set` on dotted paths, `$setOnInsert`, `$push`, `$addToSet`, plain fields) and bulkWrite, and a saved document only in the paths the save changes. ⚠ An id that names NO record passes: old documents keep references to deleted records (many on production), and a transaction may name what it created a moment ago. ⚠ It is off outside a request (scripts, migrations and the test-org copy job write as trusted code), and raw driver writes pass, as with the home guard. The views that resolve a stored id (a list's contact names, an invoice's contact) filter by the org too: `foreign-references.flow.test.ts` tests each side alone, and fails on a controller `findMany({ id: { $in } })` that names no org.
- A feature's reads accept its `view`, `browse` and `lookup`, since a role that works on it reads it.
- Reference data that another app reads also accepts that app's capability, and its comment names the app. For example, the invoicing app's cash and payment orders read `accounting/account` and `accounting/bank-account`, and the inventory app's supplier picker reads `invoicing/contact`.
- ⚠ A new GET route fails `read-permission.flow.test.ts` until it has a rule. When an app starts reading another module's route, widen the rule and add the read to the test's `APP_READS`, the test that holds each built-in role to what its apps read.
- The audit trail is `audit-log.view`'s (`auditReadScope`). Anyone else reads the history of ONE record (`entityType` + `entityId`), and only entries of modules they read: that is what the history and notes panels need.
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
- The auth plugins run `services/biz/home-gate.ts#homeGate` right after `isForeignOrg` (both plugins, no
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

## Outbound calls have deadlines (FR-20.53)

`fetch` has none: a host that accepts and never answers holds the request forever. Every call to
another server goes through **`services/biz/outbound-fetch.ts#fetchWithTimeout`** (or passes its own
`signal`): `until: 'body'` (default) bounds the whole exchange, `until: 'headers'` only the wait for the
response, for a body streamed on to a client (the installer download). ⚠ `unit/outbound-timeouts.test.ts`
scans server code and fails on any `fetch(` call without one.

## Auth Pattern

`AuthService` is an Elysia plugin (`packages/api/src/auth/auth.service.ts`) that:
- Derives `user` from the `Authorization: Bearer` header, or from the session cookie only when no
  header is sent (S-22: a non-empty Bearer is used exclusively, and an invalid one is never rescued
  by the cookie). Rules in `services/biz/session-token.ts`, shared by both auth plugins.
- ⚠ **The session cookie is `__Host-auth`** (FR-20.72, P0a-8), and so are the OAuth flow cookies
  (`__Host-oauth_state` / `_handoff` / `_pending`, `api/src/auth/oauth-cookies.ts`): an
  org's address `<slug>.lgrai.app` is a sibling subdomain, and the prefix is what stops it planting
  them. Always `Secure` + `Path=/`, and cleared with explicit attributes, **never `remove()`**
  (it sends no Path/Secure, so the browser ignores it). **A same-site request never authenticates
  by cookie** (`isSameSiteRequest`: `Sec-Fetch-Site: same-site`, or, from a browser that sends
  none, an `Origin` that is another origin of `OAUTH_FRONTEND_URL`'s site); `oauth_state` is
  exempt (the callback is same-site against a localhost fake provider). ⚠ **The plain names
  (`auth`, `oauth_*`) are neither written nor read** since release N+1 (2026-10-24): a subdomain
  CAN plant a plain cookie for lgrai.app, so never add a fallback to them.
- `api/src/isolation-headers.ts` puts `Cross-Origin-Resource-Policy: same-origin` and
  `Origin-Agent-Cluster: ?1` on every response. ⚠ Elysia's `onRequest` takes a handler ONLY: an
  options object passed first (`{ as: 'global' }`) is registered AS the hook and every request
  throws. Request hooks are always global.
- Provides `{ isSignIn: true }` macro for route protection
- JWT payload: `{ id, email, username, firstName, lastName, orgId, operatorCode?, rid?, rv?, iid?, tv?, amr? }`. ⚠ FR-27 P3-5:
  no `role`, `permissions` or `areas`: what a person may do is their role, read live on every request (`grantOf`, `can`),
  and the SPA gets it from the sign-in answer and `/auth/me` (`access`). Never add a reader of the token's legacy claims.
- Single JWT issued by Portal, validated by all controllers in the same process

There is also `app-auth.service.ts` (verify-only variant) for use if domain APIs run standalone.

A person and their memberships (multi-org sign-in), each browser tab keeping its own org (⚠ never read
`lgr_token` / `lgr_org` yourself), OAuth and FR-27's roles: [`.claude/rules/access.md`](.claude/rules/access.md).

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

**A body never chooses a field the server sets** (S-36). A route either declares its body (`t.Object({...})`: Elysia drops what a schema does not declare, a field or a `lines.0.cost` path) or, if it stores the body as the document, passes it through `services/biz/server-owned.ts`: `clientCreate(model, body, initial)` on a create, `clientUpdate(model, body, stored)` on a save. Twelve controllers do the second (bank-account, exchange-rate, fiscal-period, fiscal-year, fixed-asset, reconciliation, cash-order, payment-order, payslip, timesheet, inventory-count, price-list).
- `SERVER_OWNED` lists, per model, what only the server sets: a number it allocates, who did something (`createdBy`, `completedBy`, `approvedBy`), a step with its own route (a count's `completed` is `POST /:id/complete`, a payment order's `executed` is `POST /:id/execute`), a seal, a ledger link. `_id`, `orgId` and the timestamps are the server's on every model.
- A body may RESTATE such a field (what a new document starts with, or what the stored one holds), so a document sent back as it was loaded still saves. Choosing one answers 422 `{ code: 'server_owned_field', path }`. Refused, never dropped: a caller that asked for `status: 'completed'` and got 200 would believe it.
- ⚠ Update syntax in a body (`$set`, `lines.0.varianceCost`) is refused too. `updateInOrg` puts a body in a `$set`, where a dotted key writes inside a field the handler has just computed.
- ⚠ A status the screens change with a plain save stays the body's (a fiscal year's lock, a timesheet's approval, a fixed asset's disposal). The stamp beside it is the server's, and the controller sets it as the status changes (`approvedBy`, `reconciledBy` / `reconciledAt`, a price list's `deactivatedAt`).
- `unit/server-owned.test.ts` holds the table to the schemas, fails on a new stamp field (`…By`, `…At`) that is neither listed nor waived, and fails on a controller that hands a body to the store without being reviewed for it. `integration/server-owned-fields.flow.test.ts` runs every field over the real routes.

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

## Frontend Conventions

- **Plugin order is critical**: i18n → vuetify → pinia → router (vuetify locale adapter requires i18n)
- **Vuetify i18n**: `$vuetify.*` keys merged into i18n messages from `vuetify/lib/locale/`
- **Views** make direct `httpClient` calls or use Pinia store actions — URLs must match controller prefixes exactly
- **Organization interface** uses `id` (not `_id`): `appStore.currentOrg?.id`
- Each module (`web/src/modules/<id>`) imports `ui-shell` for the shared app shell (top bar, app switcher, org selector, user menu)
- Each module imports `ui-shared` for composables, Vuetify/i18n plugins
- Each module declares its routes in its manifest; `web` composes them into the one router
- Each module has its own Pinia stores

### App Hub (Portal UI)

The Portal's main authenticated view is the **App Hub** — a grid of available apps (like Google's app launcher). Clicking a tile navigates to the domain app's URL path (e.g., `/accounting/`).

**App availability** is determined by:
1. Org subscription plan (free = 2 apps, starter = 4, professional = all, enterprise = all + priority)
2. User permissions (user with `accounting.read` sees Accounting app tile; `pos.read` opens the Invoicing tile too, where the till lives)
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

⚠ **E2E gotchas** (numbered: specs cite them as "E2E gotcha N"; the story is in `docs/history/files.md`, Document Import):
1. Playwright spawns its workers with `process.execPath`. Under `bunx` on a machine with no **Node** on PATH, every
   worker dies with `code=143` before the browser launches. Install Node, or run E2E on CI.
2. A **spec** file cannot `import type` from `@playwright/test` (the build fails with an opaque `BuildMessage {}`);
   a **helper** module can. That is why no spec type-imports.
3. **Vuetify `v-switch` has role `checkbox`, not `switch`.** `getByRole('switch')` matches nothing; use `getByLabel(/…/i)`.
4. **Ad-hoc Playwright scripts run under `node`, not `bun`**: `chromium.launch()` under Bun hangs until the 180 s
   launch timeout. The `bunx playwright test` runner is fine.
5. The default `workers: 4` can overwhelm a dev laptop: re-run serially before believing a mass failure.
6. **A v-select is not opened by clicking the combobox you found it with**: the click times out with "intercepts
   pointer events". Use `tests/helpers/vuetify.ts#openSelect` / `chooseOption`, and assert a select's value with
   `toHaveValue`, never `toHaveText` (an `<input>`'s text is always `""`).
7. **`locator.isVisible({ timeout })` does not wait**: use `tests/helpers/vuetify.ts#appears`.
8. **"Passed on its second try" is not "flaky" until it is counted**: a retried test may fail every time on the
   faster runner. The nightly opens an issue naming a retried or failed test.

## Environment

- **Bun is pinned: `.bun-version` (1.4.4).** Every workflow's setup-bun reads it, the Dockerfile's
  base image is that tag pinned by digest, `package.json#packageManager` names it, and `bun.lock` is
  committed and installed `--frozen-lockfile`. `unit/bun-pin.test.ts` fails on any drift. To bump:
  change all four together, regenerate `bun.lock` with the new Bun, run the full suite. ⚠ Until
  2026-10-23 production and CI ran 1.3.10 and dev machines 1.4.x, and three bugs lived only in
  the runtime nobody ran locally.
- `.env` — development (MongoDB at `localhost:27018/lgr`, no auth)
- `.env.test` — testing (overridden by mongodb-memory-server)
- API `packages/api/package.json` scripts use `--env-file=../../.env` to load root env
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
| Frontend (views, stores, composables) | `bun run build` | TypeScript + Vite build (the web app + desktop-ui) |
| Full-flow (auth, routes, UI+API) | `bun run test:e2e` | Playwright E2E tests |

Run the **most specific** command first. If a backend change also affects the frontend, run both.

## Soft-Delete Pattern

Nomenclature models use `isActive: boolean` + `deactivatedAt?: Date` instead of hard-delete. DELETE endpoints set `isActive: false` + `deactivatedAt: new Date()`. Applies to: Product, Contact, Warehouse, PriceList, ProductCategory, User, FiscalDevice, Workstation, Equipment, Vehicle, Employee, JobPosition.

## Startup & Shutdown

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

## Cross-Module Event Bus (implemented)

In-process typed event bus at `packages/services/src/events/event-bus.ts`. Handlers registered at startup in `unified.ts` via `registerEventHandlers()`.

**Active event flows** (the actual `DomainEvent` union): `invoice.posted` → Accounting `JournalEntry`; `payment.recorded` → payment `JournalEntry`; `stock.movement.confirmed` → valuation `JournalEntry`; `pos.session.closed` → batch dispatch + `JournalEntry`.

**Planned event flows (not yet implemented):** `sales.order.confirmed` / `purchase.order.confirmed` / `approval.*` / `production.completed`. Order↔reservation sync is deliberately NOT event-driven — it's direct `syncOrderForInvoice` calls from the invoice controller.

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

The lgr image is ~1.7 GB (it was ~7.5 GB before FR-24's one SPA); builds once accumulated to 50+ GB and exhausted the disk on the build host (mid-push), leaving the registry with a partial image. **Always run `./scripts/prune-docker-tags.sh --apply` before building.** It keeps the two most-recently-created versioned tags (current + previous for rollback), drops everything else (`build-*`, older `vYYYYMMDD-*`, `final`/`p2-p3`/named scratch tags), runs `docker image prune -f` for the dangling layers and trims the build cache to a budget (`docker builder prune -af --keep-storage`, 20 GB unless `LGR_BUILD_CACHE_KEEP` says otherwise). Dry-run by default; pass `--apply` to actually untag.

⚠ **Never `docker builder prune -af` without `--keep-storage` on the build host.** That was this script until 2026-11: it emptied the cache before every build, so nothing was ever reused, and it emptied every other project's cache on that host with it.

Note: First request after pod restart has ~6s cold start (Bun JIT + Mongoose compilation). Subsequent requests are ~70ms.

## Known Issues

- [MEDIUM] [2026-07-19] Cluster pod external DNS is INTERMITTENT: CoreDNS forwards to 10.10.20.1 (zeus virbr1 dnsmasq — answers fine locally) and periodically times out (CoreDNS logs `read udp 10.244.x→10.10.20.1:53: i/o timeout`; zeus shows no explicit 10.244.0.0/16 return route) → ArgoCD sync intermittently fails with ComparisonError "server misbehaving" on github.com, then succeeds on retry minutes later (observed 2026-07-19: first sync Error, queued retry completed → Synced). Workaround when stuck: `kubectl apply -k k8s/overlays/prod` from the mars `~/lgr-deploy` checkout (live state converges with git). Root-cause hunt belongs in k8s-cluster-multi (zeus WG/libvirt routing). Also: argocd CLI token on mars is expired — trigger syncs via `kubectl -n argocd patch application lgr --type merge --patch '{"operation":{"sync":{}}}'` or re-login. — Status: OPEN
- [LOW] [2026-03-10, re-checked 2026-11-10] `bun audit` reports 2 transitive advisories, neither reachable (S-16 in `docs/security/2026-09-21-security-review.md`): `zod` 3.25.76 through `chromium-bidi` and `@scalar/types` (LGR validates requests with TypeBox; the PDF renderer drives Chrome over CDP, not BiDi), and `uuid` 8.3.2 through `exceljs` (the flaw is in `v3`/`v5`/`v6` given a buffer; exceljs calls `v4`). Both wait for their parents to accept the fixed major. The March four (minimatch, immutable) had left the tree; on 2026-11-10 `vue-i18n` went 9.14.5 → 11.4.18 (9.x is end of life; its two advisories need `escapeParameter`, never enabled) and `follow-redirects` 1.16.1 → 1.16.2. ⚠ vue-i18n 11 interprets messages (JIT) on the web too, as the desktop shell already did: every message of the catalogs renders the same text as on 9 (74,236 renderings compared). — Status: OPEN
- [MEDIUM] [2026-03-10] VerifyVAT integration tests hit live API with 50 req/month quota — tests flaky/failing — Status: OPEN

Standing rules from resolved entries (each entry, whole: `docs/history/platform.md`, "Known Issues, resolved"):
- ⚠ **Never `.rejects` / `.resolves` in `packages/tests`.** On Windows one deadlocks after MongoDB I/O, the shared
  mongod is reaped, and every later file fails with ECONNREFUSED. Use `helpers/capture-rejection.ts`
  (`captureRejection`, `expectRejection`) and plain `await`. When sweeping, scan recursively (`dal/repos/`, `unit/biz/`).
- ⚠ `bunfig.toml`'s `[test] timeout` is not read by Bun: `setup.ts` calls `setDefaultTimeout(120_000)`, so a bare
  `bun test <file>` gets the same limit as `bun run test`.
- ⚠ A `TODO`/`FIXME` names its issue or spec item: `unit/payroll-says-what-it-computes.test.ts` fails otherwise.
- ⚠ Deleting a file deletes its bytes since FR-32.11. Files whose row was deleted before that still have their
  bytes on disk; removing those is the owner's decision (FR-32 §4).
- An entry stays here only while it is open. Once resolved it moves, whole, to that history.
