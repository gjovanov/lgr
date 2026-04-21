# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**LGR (Ledger)** is a full-stack multi-tenant ERP system built as a Bun monorepo. Stack: Elysia.js + MongoDB/Mongoose + Vue 3/Vuetify 3 + Pinia.

The system follows a **multi-app architecture** (Google Workspace model): a Portal app handles auth, tenant management, and an App Hub that links to 7 domain app UIs. All APIs run as a **single unified process** on one port, while each domain has its own UI package.

## Commands

```bash
# Development (unified — recommended)
bun run dev                  # Unified API (4001) + all 8 UI Vite dev servers
bun run start                # Production: unified API (4001) serving all built UIs
bun run build                # Build all 8 UIs (portal + 7 domain)
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

Every data model uses `tenantPlugin` which adds `orgId` and auto-filters all queries. All API routes are scoped: `/api/org/:orgId/[module]/[resource]`.

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

Deployment configuration lives in a **separate repo**: https://github.com/gjovanov/lgr-deploy (typically cloned as a sibling folder `../lgr-deploy/`). This repo contains Docker Compose, reverse proxy configs, CI/CD pipelines, and environment-specific settings for staging/production deployments.

The production infrastructure runs on **Kubernetes**, managed via: https://github.com/gjovanov/k8s-cluster-multi (typically cloned as a sibling folder `../k8s-cluster-multi/`). This repo contains K8s manifests, Helm charts, and cluster configuration.

When working on deployment or infrastructure tasks, reference or modify files in those sibling repos.

## Post-Implementation Testing

After every feature or fix, verify your changes:

| Change type | Command | What it checks |
|-------------|---------|----------------|
| Backend (models, services, controllers) | `bun run test` | Integration tests (mongodb-memory-server) |
| Frontend (views, stores, composables) | `bun run build` | TypeScript + Vite build (all 8 UIs) |
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

**Active event flows:**
- `sales.order.confirmed` → Warehouse creates draft dispatch `StockMovement` + links to SO
- `purchase.order.confirmed` → Warehouse creates draft receipt `StockMovement` + links to PO
- `approval.requested` / `approval.decided` → (wired, handlers TBD)

**Planned event flows (not yet implemented):**
- `invoice.posted` → Accounting creates `JournalEntry`
- `payment.recorded` → Accounting creates payment `JournalEntry`
- `production.completed` → Warehouse adjusts stock (consume raw, add finished)

### State Machine Mixin (implemented)

Reusable state machine at `packages/services/src/mixins/state-machine.ts`. Used by:
- **SalesOrder**: draft → sent → confirmed → invoiced → done (+ cancel)
- **PurchaseOrder**: draft → sent → to_approve → confirmed → received → billed → done (+ cancel, reject)

### Independent Deployment (not yet implemented)

The architecture supports splitting the unified API into independently deployable services per domain if needed for scaling. Each domain API package can already run standalone on its own port (legacy mode). The planned approach would use a reverse proxy to route `/api/org/:orgId/{module}/*` to the appropriate service.

---

## Deployment Workflow

To deploy changes to production K8s:
```bash
git push origin master                                    # Push code
cd ../lgr-deploy && ./scripts/build-image.sh              # Build Docker image → SCP to worker → import into containerd (~6min)
KUBECONFIG=../k8s-cluster-multi/files/kubeconfig kubectl rollout restart deployment/lgr -n lgr  # Restart pod
```
Note: First request after pod restart has ~6s cold start (Bun JIT + Mongoose compilation). Subsequent requests are ~70ms.

## Last Health Check

Date: 2026-04-21
Result: PASSED
Summary: 386/393 tests pass (7 skipped). All 6 UIs build green (portal, accounting, inventory, invoicing, pos, payroll). Phases shipped 2026-04-21: trade-ui deletion, Product.priceTiers[] schema + resolvePrice tier step + backfill, invoicing sidebar reorg (5 workflow groups), flat 7-tab product route, Reporting→Export (outgoing/incoming/cash_register), 10-tier pricing UI + GR-with-product-update (atomic via Mongo transaction, replica set enabled in both Docker and test setup).

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
- [RESOLVED] [2026-03-15] Purchase invoices "Supplier Invoice #" column empty — mapped to `reference` field
- [RESOLVED] [2026-03-15] Proforma "Valid Until" column empty — mapped to `dueDate` field
- [RESOLVED] [2026-03-15] Credit notes missing Send/Issue button — added for draft status
- [RESOLVED] [2026-03-15] Credit note `relatedInvoiceId` not saved — added to POST/PUT body schemas
- [RESOLVED] [2026-03-15] Stock movement list slow with size=0 — capped at 1000, stripped lines from response
