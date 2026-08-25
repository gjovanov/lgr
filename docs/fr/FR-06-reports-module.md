# FR-06 — Reports: one app module for reporting

**Goal:** today "reporting" is scattered across five apps — an export page in Invoicing, three
statement views in Accounting, a valuation view in Inventory, payslip/payroll exports, the SUPTO
(НАП) tables behind an admin-only API with no UI, plus a per-grid Export button on every list.
There is no single place a user can go to answer "what reports does this system have?".

This FR introduces a **Reports app module** (`/reports/`, its own UI package, its own API
controllers, its own App Hub tile) that becomes the *single* home for the **trade-side reports
that exist today** — sales, purchase, inventory, receivables, and fiscal/SUPTO — surfaced there
without breaking the existing routes, endpoints or per-grid exports. **Accounting and payroll
reports are excluded by scope decision** (they stay first-class pages in their own apps — §3).

**Future reports are deliberately not enumerated here.** The deliverable of this FR is the
*module and its registry*: the mechanism that makes adding the next report one registry entry
plus one handler (FR-6.6). Which reports those are is decided later, per report, in its own
issue — this FR neither designs nor commits to them.

Status: **APPROVED — tracked in [gjovanov/lgr#14](https://github.com/gjovanov/lgr/issues/14)** ·
Date: 2026-08-24 · Depends on: — none blocking (FR-01 unified document types and FR-05 URL grid
state both landed with the 2026-08 batch, PR #13: the sales/purchase report definitions target
the merged document model, and `useListQueryState` already exists in `ui-shared`) · Feeds: —

> **Review note.** Section 1 is code-grounded fact, not proposal. Items marked **[CONFIRM]**
> are open decisions, mirrored in §8; none of them blocks P1.

---

## 1. Current state — where reporting lives today

### 1.1 Dedicated report/export **pages**

| Where | Route | View | What it does |
|---|---|---|---|
| Invoicing | `/invoicing/reporting/export` | `ReportingExportView.vue` + `ReportingTabGrid.vue` | 3 tabs (outgoing / incoming / cash_register), date range + status + column picker, XLSX or PDF |
| Invoicing | `/invoicing/aging-report` | `InvoiceAgingView.vue` | AR aging buckets |
| Invoicing | `/invoicing/contacts/:id/ledger` | `ContactLedgerView.vue` | Per-contact running balance |
| Accounting | `/accounting/financial-statements` | `FinancialStatementsView.vue` | P&L / balance sheet (PDF via `reporting/pdf/financial-statement.pdf.ts`) |
| Accounting | `/accounting/general-ledger` | `GeneralLedgerView.vue` | GL by account/period |
| Accounting | `/accounting/journal-analysis` | `JournalAnalysisView.vue` | Journal analytics |
| Accounting | `/accounting/tax-returns` | `TaxReturnsView.vue` | VAT return records |
| Inventory | `/inventory/inventory-valuation` | `InventoryValuationView.vue` | Valuation totals (`getStockValuationTotals`) |
| Inventory | `/inventory/products/:id/{ledger,movements,levels}` | `ProductStockView.vue` | Per-product stock reports |
| Portal | `/dashboard` | `DashboardView.vue` | KPI tiles + AR-aging chart (`dashboard.controller.ts` `/summary`) |
| — | *none* | — | **SUPTO tables 18.1–18.9 have API only, no UI** |

### 1.2 Report/export **endpoints**

- `POST /org/:orgId/invoicing/export` (list) · `POST …/export/kind/:kind` (outgoing / incoming /
  cash_register, `aggregated` pivot) · `GET …/export/:id` (single doc + `?doc=` companion) —
  `packages/invoicing-api/src/controllers/invoice-export.controller.ts`
- `GET /org/:orgId/invoicing/order/:id/export` — order sheet XLSX/PDF (`order.controller.ts:594`)
- `GET /org/:orgId/supto/export/tables` and `GET …/export/:tableId` — tables 18.1–18.9,
  `admin` + `nra_auditor` only (`portal-api/src/controllers/supto-export.controller.ts`)
- `GET /org/:orgId/export/:module/{excel,pdf}` — generic per-module stub
  (`portal-api/src/controllers/export.controller.ts`) — **currently returns a descriptor, not a file**
- `GET /org/:orgId/dashboard/summary`, `GET …/invoices/summary`, `GET …/contacts/:id/summary` — KPI reads

### 1.3 Generation layer (already shared, already good)

`packages/reporting/` — ExcelJS + Puppeteer/md-to-pdf generators with a common base
(`excel/base.excel.ts`, `pdf/base.pdf.ts`), 4-locale i18n (`i18n.ts`), org letterhead
(`pdf/logo.ts`) and the software-credit page-foot (`product-credit.ts`).
**This FR adds no new rendering stack — the Reports module is a consumer of it.**

### 1.4 Per-grid export (stays where it is)

`ui-shared/components/ExportDialog.vue` + `useExportColumns.ts` power the Export button on every
`ListScaffold` grid. FR-02 set their defaults. **Non-goal:** removing these. A report module and a
"export what I'm looking at" button serve different needs.

### 1.5 Gaps this FR closes

1. No cross-app "Reports" entry point; a user must know which app hides which report.
2. SUPTO/НАП tables are unreachable from the UI (compliance risk during an inspection).
3. Every report page re-implements its own period picker, filter bar, run/export buttons.
4. No saved report configurations, no scheduling, no report-run audit trail.
5. `export.controller.ts` is a half-built generic export that nothing uses.

---

## 2. Requirements — the module

Language: **MUST** = required for acceptance · **SHOULD** = expected, deviations noted in the PR ·
**MAY** = optional/future.

### 2.1 The app

- **FR-6.1 (MUST)** New app id `reports` in `packages/config/src/constants.ts`: added to
  `APP_IDS`, `MODULES`, and `APP_REGISTRY` (`path: '/reports/'`, `devPort: 4101`,
  `icon: 'mdi-chart-box-outline'`, `requiredPermission: 'reports.read'`). `PLAN_APP_LIMITS`
  bumped from 5 to 6.
- **FR-6.2 (MUST)** New permissions `reports.read` and `reports.export` in `PERMISSIONS`, wired
  into `DEFAULT_ROLE_PERMISSIONS`: admin/manager/accountant get both; `member` gets
  `reports.read`; `nra_auditor` gets both (**it needs the SUPTO tables**); `warehouse_manager`
  gets both but only sees inventory-scoped reports (per-report permission, FR-6.7).
- **FR-6.3 (MUST)** New UI package `packages/reports-ui/` — same shape as the other domain UIs
  (Vue 3 + Vuetify, own router/store, imports `ui-shell` + `ui-shared`), served at `/reports/`
  by `unified.ts` (`uiModules` + the static-asset table), with `dev:reports-ui` /
  `build:reports-ui` root scripts and inclusion in `bun run dev` / `bun run build`.
- **FR-6.4 (MUST)** New API package `packages/reports-api/` with controllers mounted by
  `unified.ts` under `/org/:orgId/reports/*`. It **owns no new data model for report content** —
  it reads through existing services/DAOs.
- **FR-6.5 (MUST)** `PAGE_REGISTRY` (`ui-shared/src/nav/page-registry.ts`) gains an
  `APP_NAV_META.reports` entry plus one `page('reports', …)` row per report, so every report is
  individually favouritable and reachable from the global ★ menu.

### 2.2 Report registry (the heart of it)

- **FR-6.6 (MUST)** A single declarative registry — `packages/services/src/biz/report-registry.ts`
  — where each report is one entry:
  ```ts
  { id, category, labelKey, descriptionKey, icon,
    permission,            // e.g. 'invoicing.read'
    roles?,                // optional role restriction ON TOP of permission —
                           //   the SUPTO tables are ['admin','nra_auditor'] (a manager holds
                           //   every module permission yet must NOT see them)
    params: ParamDef[],    // period | contact | warehouse | product | account | status | currency | …
    outputs: ('table'|'chart'|'xlsx'|'pdf')[],
    handler,               // (orgId, params) => { columns, rows, totals, meta }
    drilldown?             // row → target app route
  }
  ```
  **Adding a report = adding one registry entry + one handler.** No new view, no new route.
  ⚠ **Server-only module.** Handlers reach Mongo through services/DAOs, so the UI must never
  import this file (it would pull mongoose into the browser bundle) — the UI's only source of
  report metadata is the catalog endpoint (FR-6.7), which serializes everything the runner view
  needs (labels as i18n keys, `params`, `outputs`, drilldown route). If a type-only share is
  wanted, the entry *types* may live in a `report-registry.types.ts` both sides import.
- **FR-6.7 (MUST)** The catalog endpoint `GET /org/:orgId/reports/catalog` returns only the
  reports whose `permission` the caller holds AND whose `roles` restriction (when present)
  includes the caller's role — exactly the gate `supto-export.controller.ts` enforces today.
  The runner and export endpoints re-check the same gate (the catalog is a view, not the
  security boundary). The UI never renders a report it cannot run.
- **FR-6.8 (MUST)** One generic runner endpoint `POST /org/:orgId/reports/:id/run`
  (params in, `{columns, rows, totals, meta}` out) and one export endpoint
  `POST /org/:orgId/reports/:id/export` (`format: xlsx|pdf`, same params + column selection),
  reusing `packages/reporting/` generators and the existing column-picker contract from
  `useExportColumns`.
- **FR-6.9 (MUST)** One generic UI shell: `/reports` (catalog, grouped by category, searchable)
  and `/reports/:id` (a `ReportRunner` view that builds its filter bar from `params`, renders the
  result grid via `ListScaffold`, and offers Export → `ExportDialog`). Report params + grid state
  live in the URL via the existing `useListQueryState` (`ui-shared`, shipped with FR-05), so a
  configured report is a shareable link.
- **FR-6.10 (SHOULD)** Row-level **drill-down**: clicking a result row navigates to the source
  document in its own app (invoice → `/invoicing/invoices/:id`, product → `/inventory/products/:id/edit`).

### 2.3 Cross-cutting behaviour

- **FR-6.11 (MUST)** Every report is org-scoped, honours `tenantPlugin`, and takes a period
  (presets: today / this week / this month / last month / this quarter / this year / custom).
- **FR-6.12 (MUST)** Full i18n ×4 (en/bg/de/mk) for every report label, description, column
  header and parameter — matching the existing `reporting/i18n.ts` locale set.
- **FR-6.13 (MUST)** Reports are **read-only**. No report handler may write, and none may be
  reached by a role without the underlying module's read permission.
- **FR-6.14 (SHOULD)** Handlers are **aggregation-first** (Mongo `$group`/`$facet`), never
  materialise a whole collection in memory. Precedent: the dashboard `/summary` regression fixed
  by `getStockValuationTotals` (1.6s → 25ms).
- **FR-6.15 (SHOULD)** Result cap + explicit "narrow the period" message rather than a silent
  truncation; exports stream rather than buffer beyond a threshold. **[CONFIRM]** cap value —
  proposed 50 000 rows for XLSX, 5 000 for PDF.
- **FR-6.16 (MAY)** **Saved reports** — a `SavedReport` model (`{orgId, reportId, name, params,
  columns, ownerId, shared}`) so a configured report can be re-run in one click.
- **FR-6.17 (MAY)** **Scheduled reports** — reuse `BackgroundTask` + the existing task runner to
  e-mail/store a report on a cron. Depends on FR-6.16.
- **FR-6.18 (MAY)** **Report-run audit** — one audit-log entry per run/export (who, which report,
  which period). Cheap, and useful for the SUPTO tables specifically.

---

## 3. The report catalog — the existing reports

This is the **complete** scope of the catalog for this FR: the reports that already exist, each
MUST appear in the Reports catalog. **The old route keeps working** (it either stays as a
first-class page in its own app, or redirects to `/reports/<id>` — column "Old route").

Anything not in this table is out of scope here. A future report is added by writing its registry
entry and handler (FR-6.6) under its own issue — no change to this module is required to accept it.

Deliberately absent despite appearing in §1.1 (scope decision, 2026-08-24):

- **Accounting reports** — general ledger, financial statements, journal analysis, tax returns.
  They stay first-class pages in the Accounting app and are NOT added to the catalog.
- **Payroll reports** — payroll summary, payslips. Same: they stay in the Payroll app.
- The Portal **dashboard** (an interactive KPI page, not a run-and-export report).

Any of these can join the catalog later as its own registry entry under its own issue —
excluding them now costs nothing architecturally.

| # | Report id | Category | Source today | Old route |
|---|---|---|---|---|
| 1 | `sales-documents` | Sales | export kind `outgoing` | stays + catalog entry |
| 2 | `purchase-documents` | Purchase | export kind `incoming` | stays + catalog entry |
| 3 | `cash-register` | Sales | export kind `cash_register` (incl. FR-03 aggregated pivot) | stays + catalog entry |
| 4 | `ar-aging` | Receivables | `InvoiceAgingView` | redirect → `/reports/ar-aging` |
| 5 | `contact-ledger` | Receivables | `ContactLedgerView` | stays (contact-scoped) + catalog entry with contact param |
| 6 | `inventory-valuation` | Inventory | `InventoryValuationView` | stays + catalog entry |
| 7 | `stock-levels` | Inventory | `StockLevelsView` grid | catalog entry (report flavour, with below-min filter) |
| 8 | `stock-movements` | Inventory | `MovementsView` grid | catalog entry |
| 9 | `product-ledger` | Inventory | product `ledger` tab | catalog entry with product param |
| 10 | `order-sheet` | Purchase | `order.controller.ts:594` | stays (per-order) + catalog entry |
| 11 | `supto-18-1` … `supto-18-9` | Fiscal / НАП | `supto-export.controller.ts` | **new UI — 9 catalog entries, `admin`+`nra_auditor` only** |

- **FR-6.19 (MUST)** Every route replaced by a redirect keeps its **route name** (Playwright and
  `useGridColumns` key off route names — see README global constraint 3).
- **FR-6.20 (MUST)** All endpoints listed in §1.2 stay mounted and byte-compatible; the module
  calls them or shares their services. Migration CLI skills must not break.
- **FR-6.21 (SHOULD)** The now-unused `portal-api/src/controllers/export.controller.ts` stub is
  either deleted or reimplemented as the generic runner of FR-6.8. **[CONFIRM]**

---

## 4. Non-goals

- **Designing or building any report that does not exist today.** The registry (FR-6.6) is the
  extension point; each future report gets its own issue when it is actually wanted. This FR
  neither enumerates nor commits to a backlog of them.
- **Accounting and payroll reports** (general ledger, financial statements, journal analysis,
  tax returns, payroll summary, payslips) — scope decision 2026-08-24; they remain first-class
  pages in the Accounting and Payroll apps, untouched.
- Replacing the per-grid Export button (§1.4) or the per-document PDF print.
- A user-authored/ad-hoc query builder ("build your own report"). **[CONFIRM]** — if this is
  actually the ambition, the design changes substantially and belongs in its own FR.
- Changing the `packages/reporting/` rendering stack, letterheads or the invoice document layout.
- BI-tool export (Metabase/PowerBI connectors).

---

## 5. Migration & compatibility notes

1. Adding an app id touches: `APP_REGISTRY`, `PLAN_APP_LIMITS`, `MODULES`, `PERMISSIONS`,
   `DEFAULT_ROLE_PERMISSIONS`, `OrgApp` activation rows, `unified.ts` (`uiModules` + static
   table + SPA fallback), root `package.json`, `scripts/dev.ts`, `page-registry.ts`,
   and the App Hub tile list.
2. **Existing orgs** need the new app enabled — a one-off idempotent script
   (`scripts/enable-reports-app.ts`) upserting an `OrgApp` row per org, plus a permission backfill
   adding `reports.read`/`reports.export` to existing users' stored permission sets. **JWTs
   already issued won't carry the new permission until re-login** — the backfill must be run
   before the deploy is announced.
3. `desktop-ui` is a single SPA with all modules; the Reports routes MUST be registered there too,
   or explicitly deferred. **[CONFIRM]** — proposal: defer desktop to a follow-up.
4. The prod overlay ships two images; nothing here changes the deploy shape, but the UI bundle
   count goes 6 → 7 (build time and image size grow accordingly).

---

## 6. Acceptance criteria

1. `/reports/` loads for a user with `reports.read`; the App Hub shows a Reports tile; the app
   switcher lists it.
2. The catalog lists every report from §3, grouped by category, filtered by permission —
   an `nra_auditor` sees the 9 SUPTO tables; a `warehouse_manager` (inventory permissions only)
   sees the inventory reports but no sales/receivables report; nobody sees an accounting or
   payroll entry, because none exists in the catalog.
3. Any catalog entry can be opened, parameterised, run, and exported in every format its registry
   entry declares in `outputs` (most reports offer both XLSX and PDF; SUPTO tables are XLSX-only,
   as today), with the org letterhead and the correct locale.
4. Every old report route still resolves (directly or by redirect) and every endpoint in §1.2
   still returns what it returned before — verified by the existing export test suite
   (`invoice-export*.test.ts`, `reporting-export.flow.test.ts`, `cash-agg-export.flow.test.ts`,
   `order-sheet-export.test.ts`, `e2e/tests/invoicing-export.spec.ts` all green, unmodified).
5. `bun run test` green · `bun run build` green for all 7 UIs · `bun run test:e2e` green, plus a
   new e2e spec covering catalog → run → export.
6. New tests: unit tests for the registry (permission filtering, param validation) and one
   integration test per report handler in §3 asserting shape + totals.
7. No report handler issues a write; no handler materialises an unbounded collection (review item).

---

## 7. Suggested phasing

| Phase | Content | Ships value |
|---|---|---|
| **P1** | App skeleton: config/permissions/package/routing/App Hub + registry + runner + catalog UI, with 3 reports wired (`sales-documents`, `inventory-valuation`, `ar-aging`) | The module exists and is real |
| **P2** | The rest of §3 — every remaining existing report, incl. the **SUPTO 18.1–18.9 UI** | Compliance gap closed; the module is complete |
| **P3** | Saved reports (FR-6.16), scheduling (FR-6.17), run audit (FR-6.18), desktop parity | Convenience layer |

---

## 8. Open questions

Also listed on issue #14 as "Decisions still open" — resolvable during P1 without blocking the
skeleton:

1. **Own app vs. section** — is a full app module (own tile, own package, `/reports/`) right, or
   would you rather have a "Reports" *nav group inside each existing app*? This FR assumes the
   former, per your "one section (app module)" wording.
2. **Ad-hoc report builder** — out of scope (§4) or the real goal?
3. **Desktop (`desktop-ui`) parity** — now or follow-up?
4. **Saved + scheduled reports** — in the first issue as MAY items, or split into their own?
5. Row caps (FR-6.15) and the fate of the `export.controller.ts` stub (FR-6.21).
