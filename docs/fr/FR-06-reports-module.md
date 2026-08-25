# FR-06 — Reports app module („Справки") — trade-side reports in one place

**Goal:** A new domain app **`reports`** (`/reports/`, own UI package, own App Hub tile)
whose home is a **card grid like the portal App Hub (`/apps`)** — cards, not top menus.
Every report is a card; clicking opens the report page. The two existing invoicing report
pages **move** into it (`/invoicing/reporting/export` → `/reports/export`,
`/invoicing/aging-report` → `/reports/aging`, old URLs redirect). Under the hood, a
**declarative report registry** makes every next report one registry entry + one handler —
FR-07 („Складови операции") and FR-08 („История на продажбите") land as exactly that.

Status: draft for implementation · Date: 2026-08-25 · Tracking issue: **#14** (this doc is
the spec it links to; requirement IDs below match the issue's checklist) · Depends on:
nothing (FR-01/FR-05 shipped with PR #13) · Feeds: FR-07, FR-08, (optionally) FR-09's
„Каса" card.

**App naming (i18n ×4):** en **Reports** · bg **Справки** · de **Berichte** ·
mk **Извештаи**.

---

## 1. Current state (master @ `dc1422c` — verified 2026-08-25)

**Apps machinery.** `packages/config/src/constants.ts`: `APP_IDS = ['accounting',
'inventory', 'invoicing', 'pos', 'payroll']` + `AppId` union (`:69-70`); `APP_REGISTRY`
entries `{name, icon, color, devPort, path, requiredPermission, description}` (`:72-85`;
dev ports 4011/4021/4031/4041/4091 — **4101 is free**). `PLAN_APP_LIMITS` (`:88-94`, all
plans = 5) has **ZERO consumers** — grep-verified dead config; a 6th app hides nothing
(the earlier handover's warning was wrong). Bump it to 6 for hygiene only.

**Enablement is automatic.** `app-hub.service.ts:20-38` **lazy-creates missing `OrgApp`
rows on every `GET /org/:id/apps`** („freemium model") — adding `reports` to `APP_IDS`
auto-enables it for regal and every other org on next hub load. No migration script
needed. Registration also auto-creates all apps (`auth.service.ts:136-141`). The hub
filters **server-side by `requiredPermission` only** (`app-hub.service.ts:42-51`, exact
string match on the JWT's permissions; legacy `trade.*` is pre-expanded by the auth
services); the `enabled` flag is returned and **ignored by the UI** — `AppHubView.vue:26`
hard-codes the enabled style. Admin activate/deactivate endpoints exist
(`app-hub.controller.ts:14-43`) but **have no UI**.

**Hub card grid** (`portal-ui/src/views/AppHubView.vue`): `v-row`/`v-col` (12/6/4/3),
`v-card height=200`, avatar with `app.color`/`app.icon` from the registry, but **name and
description render from i18n**: `$t(\`apps.${app.id}\`)` — the `|| app.name` fallback is
unreachable (vue-i18n returns the key string on a miss, which is truthy). **The
`apps.reports`/`apps.reportsDesc` keys are mandatory in all four locales** or users see
the literal key. A legacy duplicate `appHub.*` block also exists — keep it in sync.
`navigateToApp` does `window.location.href = app.path` (dev branch keys off port
`'4000'` + `?token/org` handoff).

**UI scaffold clone target = `pos-ui`** (leanest, 11 src files): router with the
`?token`/`?org` `beforeEach` handoff + FR-05 `scrollBehavior`; boilerplate `app.store`
(`orgUrl()`); `DefaultLayout.vue` passing `layout="topmenu"` + `#menu-bar` slot
(**omit the slot for reports** — `AppShell` renders nothing for an empty slot, leaving a
clean top bar) and hard-coding its own dev port in `handleAppNavigate` (`'4091'` →
`'4101'`); `vite.config.ts` `{base: '/pos/', port: 4091, proxy /api→4001}`; `main.ts` =
`registerPlugins(app, { router })`.

**Serving** — `portal-api/src/unified.ts`, three touch points: `uiModules` array (`:105`,
drives both index.html pre-read and the **onError NOT_FOUND SPA fallback** `:122-144` —
adding `'reports'` there gives the fallback for free), and `moduleUiConfig` static mounts
(`:263-286`). Root `package.json` `dev`/`build` **enumerate the 6 UI packages by hand**;
the Dockerfile enumerates them **twice** (RUN builds `:9-14`, COPY dists `:29-34`) — two
lines to add. e2e `webServer` runs `bun run start` against prebuilt dists (no change);
Playwright `projects` use explicit `testMatch` lists — a new spec must be registered.

**Nav/favorites** — `ui-shared/src/nav/page-registry.ts`: `APP_NAV_META` (base/devPort/
nameKey per app) + `page()` rows; **`id === path`**, so moving the two rows
(`:45-46` → `page('invoicing','/aging-report',…)`, `page('invoicing','/reporting/export',…)`)
**orphans existing user favorites** keyed by the old URLs. Consumer =
`NavFavoritesMenu.vue` (the global ★ menu) via `matchPage`/`navigateToPage`.
`navigate.ts:navigateToPage` is the cross-SPA navigation helper (dev-port + token
handoff; full `window.location.href` — Vue Router cannot cross apps).

**The two moving pages** (invoicing-ui):
- Router: `invoicing.aging-report` (`router/index.ts:64`), `invoicing.reporting.export`
  (`:67`). Nav „Reporting" group `DefaultLayout.vue:99-106` contains **exactly these two
  items** — removing both deletes the group.
- `ReportingExportView.vue` — pure shell over `ReportingTabGrid.vue`; **100% portable**.
- `ReportingTabGrid.vue` — everything from ui-shared except: the boilerplate app store
  (identical clone), local `StatusMultiselect.vue` (60 lines, zero deps — **promote to
  ui-shared**), and 🔴 `numberLinkTo()` (`:179-185`) returning **invoicing-local route
  names** into `<entity-link :to>` — breaks in another SPA; `EntityLink` supports `href`
  (`EntityLink.vue:2-3`) → convert to absolute `/invoicing/...` hrefs. Also: it predates
  FR-05 (`usePaginatedTable` without `urlSync`).
- `InvoiceAgingView.vue` — portable; 🔴 one `:to="{name:'invoicing.contacts.edit'}"`
  (`:37`) → href. Backend endpoints stay put: `POST /invoicing/export/kind/:kind`
  (`canExport` gate), `GET /invoicing/reports/aging` (**`isSignIn` only — no permission
  check today**).
- **No e2e spec touches either page** (grep-verified). But `e2e/tests/app-hub.spec.ts`
  hard-codes `toBe(5)` apps (`:44,48,84`) — **will break**; `tests/integration/
  app-hub.flow.test.ts` is `APP_IDS.length`-relative — self-adjusting.

**Permissions.** `PERMISSIONS` tuple (`constants.ts:4-12`) has **no `reports.*`**;
`DEFAULT_ROLE_PERMISSIONS` spreads all non-admin perms to admin/manager but lists
accountant/member/nra_auditor explicitly. The export endpoints hard-require
`invoicing.*`/`trade.*`/admin server-side (`export-access.ts` — deliberately includes
read-only `member`/`nra_auditor`: an NRA inspector must never be told Forbidden).

**Reporting stack** (`packages/reporting/` — ExcelJS + PDF + 4-locale i18n + letterhead
incl. the PR #15 org logo) is a finished library; this module only consumes it.

## 2. Scope

**P1 (this FR's MUST core):** app skeleton + card hub + registry/runner plumbing + the
two moved pages as the first cards (+ redirects). **P2:** the full existing-report catalog
from issue #14 incl. the SUPTO 18.1–18.9 UI. **P3 (MAY):** saved/scheduled reports, run
audit, desktop parity. FR-07/FR-08 are separate issues that land as registry entries once
P1 merges. Accounting and payroll reports are **excluded** (issue #14 scope decision
2026-08-24 — they stay first-class pages in their own apps).

## 3. Requirements

### 3.1 The app (issue FR-6.1 … FR-6.5)

- **FR-6.1 (MUST)** New app id `reports` in `constants.ts`: `APP_IDS`, `MODULES`,
  `APP_REGISTRY` → `{name: 'Reports', icon: 'mdi-file-chart', color: <unused hex, e.g.
  '#8e24aa'>, devPort: 4101, path: '/reports/', requiredPermission: <FR-6.2>,
  description: 'Reports & exports'}`; `PLAN_APP_LIMITS` 5 → 6 (hygiene — verified dead).
- **FR-6.2 (MUST — decide before P1, recorded in the PR)** App permission, two options:
  - **(a) `invoicing.read` — recommended for P1**: zero migration, the tile appears for
    exactly the audience the two moved pages serve today (admin, manager, accountant,
    member, **nra_auditor**; hidden from warehouse_manager), and the server-side
    `canExport` gate already matches.
  - **(b) `reports.read`/`reports.export` (issue #14's target)**: requires extending
    `PERMISSIONS`, explicit additions to accountant/member/nra_auditor role lists, a
    PermissionSet backfill for existing orgs, `canExport` extension — and **already-issued
    JWTs lack the permission until re-login**. Defer to P2 if (a) is chosen; the
    registry's per-report `permission`/`roles` (FR-6.6/6.7) is the real content gate
    either way.
- **FR-6.3 (MUST)** New `packages/reports-ui/` cloned from the pos-ui scaffold: vite
  `{base: '/reports/', port: 4101}`, token/org router handoff + `scrollBehavior`,
  boilerplate app store, `DefaultLayout` with `layout="topmenu"` and **no `#menu-bar`
  slot** (card hub instead of menus — the user's explicit requirement), dev-port constant
  `'4101'` in `handleAppNavigate`. Root `package.json`: `dev:reports-ui`/
  `build:reports-ui` + appended to the aggregate `dev`/`build`. CLAUDE.md command list
  updated.
- **FR-6.4 (MUST)** Backend package `packages/reports-api/` mounted in `unified.ts` under
  `/api` with prefix `/org/:orgId/reports` (catalog + runner + export, FR-6.7/6.8). It
  owns **no data models** — handlers read through existing services/DAOs. (The moved
  pages' existing endpoints stay in invoicing-api untouched.)
- **FR-6.5 (MUST)** `page-registry.ts`: `APP_NAV_META.reports = {base: '/reports',
  devPort: 4101, nameKey: 'apps.reports'}` + `page()` rows `('reports','/export',
  'nav.export','mdi-download')` and `('reports','/aging','nav.agingReport',
  'mdi-clock-alert-outline')` (FR-07/08 add theirs later). ⚠ `id === path`: existing
  favorites on the old URLs orphan — add a one-line remap in `NavFavoritesMenu`'s load
  path (old id → new id) or accept the loss (record the choice; remap is ~5 lines).

### 3.2 Report registry — the heart (issue FR-6.6 … FR-6.10)

- **FR-6.6 (MUST)** Declarative registry `packages/services/src/biz/report-registry.ts`:
  ```ts
  { id, category, labelKey, descriptionKey, icon,
    permission,            // e.g. 'invoicing.read' — content gate, exact-match on JWT perms
    roles?,                // optional restriction ON TOP (SUPTO: ['admin','nra_auditor'])
    params: ParamDef[],    // period | contact | warehouse | product | category | select | bool …
    outputs: ('table'|'xlsx'|'pdf')[],
    handler,               // (orgId, params) => { columns, rows, totals?, meta }
    drilldown?             // row → target app URL (href, cross-SPA)
  }
  ```
  **Adding a report = one entry + one handler.** ⚠ **Server-only module** (handlers touch
  Mongo) — the UI must never import it; share a type-only `report-registry.types.ts`.
- **FR-6.7 (MUST)** `GET /reports/catalog` → entries the caller may see (`permission`
  held AND `roles` matches when present). Runner + export **re-check the same gate** —
  the catalog is a view, not the boundary. This also **fixes the aging report's missing
  permission check** (today `isSignIn` only): the runner gate applies `invoicing.read`.
- **FR-6.8 (MUST)** Generic `POST /reports/:id/run` (params → `{columns, rows, totals,
  meta}`; row cap FR-6.15) and `POST /reports/:id/export` (`xlsx|pdf` via
  `packages/reporting`, reusing the column-picker contract).
- **FR-6.9 (MUST)** Generic UI:
  - **`/reports` — the card hub**: card grid **modeled on `AppHubView.vue`** (v-row/v-col
    12/6/4/3, icon avatar + name + description from `reports.<id>.*` i18n), grouped by
    category, permission-filtered by the catalog response, searchable (MAY). **P1 renders
    two cards** (Export, Aging) — the moved pages keep their own full views rather than
    the generic runner (they are richer than the runner's v1; converting them to registry
    handlers is P2-optional).
  - **`/reports/:id` — `ReportRunner`** for registry-driven reports (FR-07/08): filter
    bar from `params`, results in `ListScaffold` (column cog = post-generation
    show/hide/reorder for free), `ExportDialog`, params + grid state in the URL via
    `useListQueryState` — a configured report is a shareable link.
- **FR-6.10 (SHOULD)** Row drill-down via cross-app `href`s (never route names — separate
  SPAs).

### 3.3 The move (P1 deliverable)

- **FR-6.19 (MUST)** Move `ReportingExportView` + `ReportingTabGrid` + `InvoiceAgingView`
  into reports-ui at `/reports/export` (route name `reports.export`) and `/reports/aging`
  (`reports.aging`), with: `StatusMultiselect` **promoted to ui-shared** (it's generic),
  the **3 route-name links converted to `href`** (`/invoicing/invoices/:id/edit` family +
  `/invoicing/contacts/:id/edit`; accept the dev-port rough edge or route through
  `navigateToPage`), and `ReportingTabGrid` upgraded to the FR-05 convention
  (`useListQueryState` + `urlSync: true`) while moving. **Grid column prefs re-key** (new
  `gridId` = new route name) — note it, no migration.
- **FR-6.19a (MUST)** Invoicing keeps **redirect stubs**: old paths + old route names
  (`invoicing.aging-report`, `invoicing.reporting.export`) mount a tiny component doing
  `window.location.href = '/reports/…'` (Vue-Router redirects can't cross SPAs). The nav
  „Reporting" group in invoicing's `DefaultLayout` is **removed** (both children moved —
  FR-01 removed groups before, users adapted; the hub tile replaces it).
- **FR-6.20 (MUST)** Every backend endpoint stays mounted and byte-compatible:
  `/invoicing/export/*` (list/kind/:id), `/invoicing/reports/aging`, `/supto/export/*` —
  proven by the **unmodified** export suites (`invoice-export*.test.ts`,
  `cash-agg-export.flow.test.ts`, `order-sheet-export`, `e2e/invoicing-export.spec.ts`).
- **FR-6.21 (SHOULD)** The unused `portal-api/src/controllers/export.controller.ts` stub:
  delete or absorb into FR-6.8 (decide in PR).

### 3.4 Cross-cutting (issue FR-6.11 … FR-6.18)

- **FR-6.11 (MUST)** Org-scoped throughout; period presets (today/week/month/last
  month/quarter/year/custom) in the runner's period param.
- **FR-6.12 (MUST)** i18n ×4: `apps.reports`/`apps.reportsDesc` (+ the legacy `appHub.*`
  twin block), `reports.*` card/param/column keys, nav keys. **Missing keys render
  literally — they are not optional** (§1).
- **FR-6.13 (MUST)** Handlers are read-only. **FR-6.14 (SHOULD)** aggregation-first
  (dashboard `getStockValuationTotals` precedent: 1.6 s → 25 ms). **FR-6.15 (SHOULD)**
  row caps (proposal: 50 000 XLSX / 5 000 PDF / 1 000 table page) with an explicit
  „narrow the period" message. **FR-6.16/6.17/6.18 (MAY, P3)** saved reports · scheduled
  via `BackgroundTask` · run-audit entries.

## 4. Edge cases

1. **First hub load after deploy** auto-creates the OrgApp row (lazy path) — verify the
   tile appears for regal without any script.
2. **User without the app permission** deep-links `/reports/...` — the SPA loads (static
   serving is unauthenticated, as for every app) but the catalog/runner return
   401/403-filtered data; the hub tile is absent. Same model as all apps today.
3. **Old bookmarks / e2e by route name** hit the invoicing redirect stubs — full-page
   hop, state in the URL survives (`useListQueryState` params ride along if the stub
   forwards `location.search` — **MUST forward the query string**).
4. **Favorites** on old paths: remap or orphan per FR-6.5 decision.
5. **Dev mode**: `/reports` on port 4101 with `?token/org` handoff; portal AppHub's
   dev-branch port check (`'4000'`) already covers it (registry `devPort`).
6. **SPA fallback prefix looseness** (`startsWith('/reports')`) — consistent with
   existing apps; no path in other apps starts with `/reports`.
7. **Six-app hub layout** — 6 cards render 3+3 on `lg` (4-col grid); nothing to do.

## 5. Integration & regression constraints

1. Global constraints from `docs/fr/README.md` apply (route names, `/bills/import/*`,
   POST `/invoices` payload, sequence registry, gates).
2. `e2e/tests/app-hub.spec.ts:44,48,84` hard-codes 5 apps — update to 6 (or
   `APP_IDS.length`); add an assertion that the reports tile appears for `accountant`
   (holds `invoicing.read`). `tests/integration/app-hub.flow.test.ts` self-adjusts.
3. New Playwright spec (registered in a `projects` `testMatch`): hub renders the cards →
   each card opens → old invoicing URLs redirect. New unit tests: registry permission
   filtering + param validation; integration: catalog gate matrix (member vs
   warehouse_manager vs nra_auditor).
4. Dockerfile gains the RUN + COPY pair; `bun run build` builds 7 UIs; image grows
   accordingly (prune before building per deploy skill).
5. `desktop-ui` parity: **deferred** (single-SPA desktop registers no reports routes for
   now — record in the PR).

## 6. Migration / rollout

1. No DB migration: OrgApp lazy-creates; permissions migrate only if FR-6.2(b) is chosen
   (then: PermissionSet backfill + re-login caveat — run before announcing).
2. Deploy = normal `deploy-prod.sh` (no `--ocr`). After deploy: open `/apps` as regal
   admin → tile appears; open `/reports` → cards; old URLs redirect.
3. Rollback = previous image tag; no data written.

## 7. Acceptance criteria

- [ ] App Hub shows the **Справки/Reports** tile (icon+color from registry, name/desc from i18n ×4) for users with the chosen permission; hidden from `warehouse_manager`.
- [ ] `/reports` renders the card hub (no top menus); cards open `/reports/export` and `/reports/aging`, fully functional (tabs, filters, export downloads, aging table) — now with URL-synced state on the export grids.
- [ ] `/invoicing/reporting/export` and `/invoicing/aging-report` redirect (query string preserved); invoicing's Reporting menu group is gone; document links inside the moved grids still open the right documents in `/invoicing/`.
- [ ] `GET /reports/catalog` filters by permission (+ roles when present); run/export re-check the gate; aging data is no longer reachable without `invoicing.read`.
- [ ] Registry + runner work end-to-end for at least one registry-driven demo entry (FR-07 lands the first real one).
- [ ] All existing export/aging suites pass **unmodified**; app-hub e2e updated to 6; `bun run test`, `bun run build` (7 UIs), `bun run test:e2e` green.
- [ ] ★ Favorites: new pages favoritable; old-favorite decision implemented as recorded.

## 8. Field test (lgrai.app / regal, after deploy)

1. `/apps` → Справки tile (bg locale text, correct icon/color) → card hub renders.
2. Export card: run an outgoing export for a real month (PDF + XLSX download, Cyrillic
   OK); reload mid-filter → URL restores the tab + filters; column cog works.
3. Aging card: table renders; contact links open the contact in the invoicing app.
4. Old bookmarks: both legacy URLs redirect with filters intact.
5. As a member-role user (or nra_auditor if seeded): tile visible, exports work; as
   warehouse_manager: no tile, direct `/reports` catalog returns nothing gated.
6. Favorites: star `/reports/export`, navigate away, jump back via the ★ menu.

---

## Appendix — driving requirement (user, 2026-08-24)

> "Those new Reports need to be added in a new App called Reports (translated in all
> languages — Use Справки for Bulgarian). Also move there the existing reports from
> invoicing app: https://lgrai.app/invoicing/reporting/export and
> https://lgrai.app/invoicing/aging-report. Reporting app should look more like the
> portal: https://lgrai.app/apps with cards instead of menu's."

Plus issue #14 (2026-08-24) for the registry architecture, the P2 catalog (incl. SUPTO
18.1–18.9 UI) and the P1/P2/P3 phasing.
