# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LGR (Ledger)** is a full-stack multi-tenant ERP system built as a Bun monorepo. Stack: Elysia.js + MongoDB/Mongoose + Vue 3/Vuetify 3 + Pinia.

The system follows a **multi-app architecture** (Google Workspace model): a Portal app handles auth, tenant management, and an App Hub that links to 7 domain app UIs. All APIs run as a **single unified process** on one port, while each domain has its own UI package.

## Commands

```bash
# Development (unified — recommended)
bun run dev                  # Unified API (4001) + all 7 UI Vite dev servers
bun run start                # Production: unified API (4001) serving all built UIs
bun run build                # Build all 7 UIs (portal + 6 domain)
bun run seed                 # Seed database (Acme Corp + Beta Inc)

# Individual UI dev servers (each proxies /api → unified API on 4001)
bun run dev:portal-ui        # Portal UI (port 4000)
bun run dev:accounting-ui    # Accounting UI (port 4011)
bun run dev:invoicing-ui     # Invoicing UI (port 4021)
bun run dev:warehouse-ui     # Warehouse UI (port 4031)
bun run dev:payroll-ui       # Payroll UI (port 4041)
bun run dev:hr-ui            # HR UI (port 4051)
bun run dev:crm-ui           # CRM UI (port 4061)
bun run dev:erp-ui           # ERP UI (port 4071)
bun run dev:reports-ui       # Reports UI (port 4101)

# Legacy (separate API per domain — deprecated, still functional)
bun run dev:legacy           # 8 separate API servers + 8 UI servers
bun run dev:accounting       # Accounting API (4010) + UI (4011)

# Monolith (very old — deprecated)
bun run dev:api-monolith     # Old monolithic API
bun run dev:ui-monolith      # Old monolithic UI

# Desktop (offline-first, SQLite backend)
bun run dev:desktop          # Desktop API (4080) + Desktop UI (4081)
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
  db/                  → Mongoose models (83) + tenant plugin + connection management
  services/            → Business logic (biz/), DAOs (dao/), background tasks, events, mixins, logger
  reporting/           → Excel (ExcelJS) + PDF (md-to-pdf) export generators
  fiscal/              → Fiscal printer abstraction (IFiscalPrinter, Datecs protocol, device manager, NTP sync, VAT groups)

  # ── DAL (Data Abstraction Layer) ──
  dal/                 → DAL interface definitions (backend-agnostic)
  dal-mongo/           → MongoDB DAL implementation (cloud)
  dal-sqlite/          → SQLite DAL implementation (desktop)

  # ── Unified Cloud API (single process, port 4001) ──
  portal-api/          → Elysia: unified.ts mounts ALL controllers (portal + 16 domains)
                         Also contains portal-only controllers: auth, oauth, org, user, invite,
                         stripe, file, notification, app-hub, export, tag,
                         fiscal-device, workstation, supto-export

  # ── Domain API packages (controllers only, imported by unified.ts) ──
  accounting-api/      → 10 accounting controllers
  invoicing-api/       → 6 invoicing controllers (includes contact-ledger, stock-availability)
  warehouse-api/       → 9 warehouse controllers (includes pricing, bulk-pricing)
  sales-api/           → 2 sales controllers (orders, quotation templates)
  purchase-api/        → 3 purchase controllers (orders, blanket orders, reorder rules)
  project-api/         → 4 project controllers (projects, tasks, milestones, timesheets)
  helpdesk-api/        → 3 helpdesk controllers (tickets, teams, SLA policies)
  documents-api/       → 3 documents controllers (workspaces, files, e-signatures)
  subscriptions-api/   → 1 subscription controller (CRUD + activate/pause/resume/cancel/generate)
  approvals-api/       → 2 approval controllers (types config, requests + approve/reject)
  planning-api/        → 3 planning controllers (shifts, templates, appointments + types)
  fleet-api/           → 2 fleet controllers (vehicles, costs)
  payroll-api/         → 4 payroll controllers
  hr-api/              → 6 HR controllers
  crm-api/             → 4 CRM controllers
  erp-api/             → 4 ERP controllers (BOM, production, construction, POS)
  reports-api/         → 1 reports controller (catalog + generic runner + generic export)

  # ── UI packages (each is a standalone Vue 3 + Vuetify 3 SPA) ──
  portal-ui/           → Login, register, oauth-callback, app-hub, settings, admin, billing, audit log
  inventory-ui/        → Products, stock, movements, valuations (served at /inventory/*)
  invoicing-ui/        → Contacts, invoices, bills, cash sales, payments (served at /invoicing/*)
  accounting-ui/       → 10 accounting views + store
  pos-ui/              → Point-of-sale terminal, transactions, devices (served at /pos/*)
  payroll-ui/          → 5 payroll views + store
  hr-ui/               → 4 HR views + store
  crm-ui/              → 3 CRM views + store
  erp-ui/              → 4 ERP views + store
  reports-ui/          → Report card hub + generic runner + the two moved invoicing report
                         pages (served at /reports/*)

  # ── Shared UI library ──
  ui-shell/            → AppShell, AppSwitcher, OrgSelector, UserMenu, NotificationBell, sidebar
  ui-shared/           → Shared composables (useHttpClient, useSnackbar, useWebSocket, usePriceResolver), i18n, vuetify plugin, shared components (PriceExplainButton, TagInput, etc.)

  # ── Desktop (offline-first) ──
  desktop-api/         → Unified Elysia server (port 4080, SQLite backend via dal-sqlite)
  desktop-ui/          → Unified desktop SPA (all 7 modules, sidebar navigation)
  desktop/             → Tauri 2 shell (Rust: sidecar, tray, archive/backup)
  sync/                → Sync engine (change tracking, conflict resolution, LAN discovery)

  # ── Legacy (deprecated, not used by default commands) ──
  api/                 → Old monolithic API
  ui/                  → Old monolithic UI

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

## Auth Pattern

`AuthService` is an Elysia plugin (`packages/portal-api/src/auth/auth.service.ts`) that:
- Derives `user` from cookie or `Authorization: Bearer` header
- Provides `{ isSignIn: true }` macro for route protection
- JWT payload: `{ id, email, username, firstName, lastName, role, orgId, permissions, operatorCode? }`
- Single JWT issued by Portal, validated by all controllers in the same process

There is also `app-auth.service.ts` (verify-only variant) for use if domain APIs run standalone.

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
- **SQLite migration v2**: `product_tag_prices` table, `name` on `product_custom_prices`, `price_explanation` on line tables
- **SQLite migration v5**: `product_price_tiers` child table (per-product 10 slots)
- **Backfill**: `bun run scripts/backfill-price-tiers.ts [--execute] [--org slug]` — idempotent, seeds 10 default slots with `percent=0, finalPrice=sellingPrice`, no filters

---

## SUPTO / Bulgarian Fiscal Compliance

LGR implements СУПТО (Софтуер за Управление на Продажбите в Търговски Обект) per **Ordinance Н-18, Appendix 29**. Target deployment: `regal` org (BGN, `bg` locale, `Europe/Sofia`, 20% VAT).

### Fiscal Package (`packages/fiscal/`)

- **`IFiscalPrinter`** interface — abstract over Datecs/Daisy/Tremol/Incotex manufacturers
- **`DatecsFiscalPrinter`** — binary protocol (STX/LEN/SEQ/CMD/DATA/BCC/ETX) over TCP
- **`WebSocketFiscalPrinter`** — routes Datecs frames through WebSocket to browser (Web Serial API)
- **`fiscal-device.service.ts`** — in-memory connection manager (`connect`, `disconnect`, `getPrinter`, `registerPrinter`, `unregisterPrinter`)
- **`fiscal-bridge.ts`** (portal-api/websocket/) — WebSocket endpoint `/ws/fiscal-bridge` for browser-connected printers
- **`bridge.ts`** — standalone serial-to-TCP bridge script for non-browser setups (`bun run packages/fiscal/src/bridge.ts`)
- **`time-sync.service.ts`** — NTP verification + fiscal device clock sync (periodic, default 6h)
- **`vat-groups.ts`** — Bulgarian VAT groups: А=20% goods, Б=20% services, В=9%, Г=0%
- TCP transport implemented; serial/USB via bridge script; **browser transport** via Web Serial API (Chrome/Edge 89+)
- Tremol + Daisy mapped to Datecs driver (same Bulgarian fiscal protocol)

### SequenceService (`packages/services/src/biz/sequence.service.ts`)

Atomic counter using MongoDB `findOneAndUpdate` with `$inc`. Race-condition safe. Uses Mongoose directly (not DAL).

- `getNextNumber(orgId, prefix, padLength?, year?)` → `"INV-2026-00001"`, `"POS-2026-000001"`
- `generateUNP(orgId, fiscalDeviceNumber, operatorCode)` → `"XXXXXXXX-ZZZZ-0000001"` (Appendix 29 format)
- `getDisplayPrefix(orgId, prefix)` → admin override (year=0 sentinel) or canonical prefix
- `setDisplayPrefix(orgId, prefix, displayPrefix|null)` → org-global prefix override (future allocations only)
- `listSequencesForOrg(orgId)` → all counter rows + overrides, used by the configuration UI

### SUPTO Models

- **FiscalDevice** — `deviceNumber` (8-char), `manufacturer`, `connectionType`/`connectionParams`, `warehouseId`, `status` (online/offline/error), `isActive`/`deactivatedAt`
- **Workstation** — `code`, `name`, `warehouseId`, `fiscalDeviceId`, `isActive`/`deactivatedAt`
- **Sequence** — `orgId` + `prefix` + `year` → `lastNumber` (atomic counter)

### SUPTO Controller Endpoints

- **Fiscal devices**: `GET/POST/PUT/DELETE /api/org/:orgId/fiscal/device` + `/connect`, `/disconnect`, `/status`, `/z-report`, `/sync-time` — restricted to admin/manager/warehouse_manager. Connection types: `tcp`, `serial`, `usb`, `browser`
- **Fiscal bridge WebSocket**: `ws[s]://host/ws/fiscal-bridge` — browser connects with Web Serial API to USB fiscal printer, relays commands from LGR server. Protocol: `fiscal:bridge:register` → `fiscal:command` / `fiscal:response`
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

Drafts use per-type DRAFT_* counters (DRAFT_INV/PRF/CN/DN/BILL); cash sales skip drafts (CS direct). On `/send` or `/receive`, the controller allocates a new issued number from the canonical SALES_DOC/PROFORMA/BILL counter, sets `draftNumber = previousInvoiceNumber`, replaces `invoiceNumber`, and appends to `numberHistory[]`. Display prefix override (per-org-global) lives on the Sequence year=0 sentinel doc; future allocations only. Edit-sent guard: PUT now blocks when a posted JournalEntry references the invoice (`sourceModule:'invoicing', sourceId, status:'posted'`) → 409 with credit-note remediation. DELETE keeps draft-only guard. Configuration page at `/invoicing/configuration/sequences` (admin/manager only).

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
(destination untracked) · sklisk `adjustment`/from/− · storeOperations XLSX `receipt`/to/+.
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

## Known Issues

- [MEDIUM] [2026-07-19] Cluster pod external DNS is INTERMITTENT: CoreDNS forwards to 10.10.20.1 (zeus virbr1 dnsmasq — answers fine locally) and periodically times out (CoreDNS logs `read udp 10.244.x→10.10.20.1:53: i/o timeout`; zeus shows no explicit 10.244.0.0/16 return route) → ArgoCD sync intermittently fails with ComparisonError "server misbehaving" on github.com, then succeeds on retry minutes later (observed 2026-07-19: first sync Error, queued retry completed → Synced). Workaround when stuck: `kubectl apply -k k8s/overlays/prod` from the mars `~/lgr-deploy` checkout (live state converges with git). Root-cause hunt belongs in k8s-cluster-multi (zeus WG/libvirt routing). Also: argocd CLI token on mars is expired — trigger syncs via `kubectl -n argocd patch application lgr --type merge --patch '{"operation":{"sync":{}}}'` or re-login. — Status: OPEN
- [MEDIUM] [2026-08-25] `integration/pos-transaction.flow.test.ts` — 9 of 21 tests fail on Windows (test 13 hangs ~150s, then 14–20 each time out at exactly 60s). It is the `.rejects` deadlock below, not a regression: **verified by stashing the only change on that path and reproducing the identical failure on unmodified code**. The file has 6 `.rejects`/`.resolves` usages; test 13 is the first one. Convert them to try/catch capture, or run the file on Linux/mars. — **Status: RESOLVED 2026-09-15** — all 6 converted with the sweep below; the file passes in the full run.
- [MEDIUM] [2026-07-19] Bun 1.3.12 on Windows: `expect(p).rejects` deadlocks when the rejection follows MongoDB driver I/O — the pending op hangs ~45s, mongod gets reaped ("killed N dangling processes") → cascading ECONNREFUSED + segfault. Workaround: try/catch capture (see `bill-with-update.flow.test.ts` `captureRejection`); ~60 `.rejects` usages across 23 test files can hang on Windows — run those files on Linux/mars, or convert as touched. **2026-07-26**: `.resolves` is affected too (proven by minimal probe: same promise via plain await = instant, via `.resolves` matcher = deadlock + hook-timeout cascade that poisons every later test in the process); which files trip it is module-graph/timing sensitive. `invoice-stock-validation.flow.test.ts` converted (all `.rejects`→captureRejection, `.resolves`→plain await) → 15/15 in 4s. Convert BOTH matcher kinds as touched. — **Status: RESOLVED 2026-09-15.** "As touched" was the mistake: the matchers were hit one at a time for two months while `bun run test` was, on Windows, not slow but COMPLETELY BLOCKED. `accounting.flow.test.ts` is the first file the runner reaches and line 124 used `.rejects`, so the shared mongod was reaped before any other file ran and all ~125 that followed cascaded into ECONNREFUSED — the suite never reported at all. All 58 remaining call sites across 19 files are now converted to the shared `helpers/capture-rejection.ts` (`captureRejection` + `expectRejection`), which replaces the three private copies that had grown in different files. `bun run test` completes: **1505 tests / 126 files in ~5m, 1493 pass / 7 skip / 5 fail** (the 5 are real pre-existing failures in `app-hub.flow`, `compare-snapshot` and `org-logo` that the hang had been hiding). ⚠ **Never reintroduce `.rejects`/`.resolves` in this suite** — one is enough to block everything again. ⚠ When sweeping, scan RECURSIVELY: `dal/parity/` and `unit/biz/` are two levels down and a `unit/*.test.ts` glob silently misses 23 sites.
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
