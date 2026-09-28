# Functional Requirements — 2026-08 batch

Five FR documents, one per requested function. Written for an implementing developer with
full repo access. All file paths are repo-relative; **line numbers reference master @
`38d468e` (2026-08-21)** and may drift — treat them as anchors, not gospel.

| Doc | Title | Main surfaces |
|---|---|---|
| [FR-01](FR-01-unified-document-types-sales-purchase.md) | Unified document types for Sales & Purchase documents (invoice / credit note / debit note in one table, one prefix, one sequence) | `invoicing-api`, `services` (sequence registry, stock, JE, ledger), `invoicing-ui` |
| [FR-02](FR-02-export-dialog-defaults.md) | Export dialog defaults (Status/Currency off, PaymentMethod on, PDF default) | `ui-shared` (ExportDialog, useExportColumns), `invoicing-ui` |
| [FR-03](FR-03-cash-sales-outgoing-pos-layout-aggregated-export.md) | Cash sales: move to Outgoing Documents, POS-style detail page, aggregated export | `invoicing-ui`, `invoicing-api` (export), nav |
| [FR-04](FR-04-product-tabs-movements-inventory-counts.md) | Product tab renames + document links, inventory count ⇄ adjustment movement marriage, "Stock Movement Documents" rename | `inventory-ui`, `warehouse-api`, `db` |
| [FR-05](FR-05-grid-url-state-hover-menus-drag-drop-columns.md) | Grid state in the URL, hover-open menus, drag & drop column reorder | `ui-shared`, `ui-shell`, all `*-ui` |

## Post-batch additions

| Doc | Title | Tracking |
|---|---|---|
| [FR-06](FR-06-reports-module.md) | Reports app module — the existing trade-side reports (sales/purchase/inventory/receivables/SUPTO) in one place via a registry + generic runner; SUPTO 18.1–18.9 get their first UI. Accounting & payroll reports excluded by scope decision | [gjovanov/lgr#14](https://github.com/gjovanov/lgr/issues/14) |
| [FR-11](FR-11-daily-digest-email.md) | Daily digest email — yesterday's KPIs + reconciliation anomalies (minus-sign corrections, zero stock, sales without stock docs, duplicates, post-issue edits, failed imports) to per-org admin-configured recipients via SendGrid | [gjovanov/lgr#21](https://github.com/gjovanov/lgr/issues/21) |
| [FR-12](FR-12-files-app-document-ingest.md) | Files app — in-app document ingest: upload → OCR → analyze → commit → reconcile | [gjovanov/lgr#23](https://github.com/gjovanov/lgr/issues/23) |
| [FR-13](FR-13-backup-archive.md) | Backup (nightly full + hourly oplog delta, zstd, three destinations, restore-verified), a **sys-admin** manual backup / restore-from-file screen, Google Drive as an off-site destination (OAuth, completing the in-tree adapter stub), and archiving (locked-fiscal-year file archive with UI rehydration, non-fiscal retention rules). Includes the measured regal-pz growth model and a compressor benchmark on the real production dump | [gjovanov/lgr#24](https://github.com/gjovanov/lgr/issues/24) |

## LGR Desktop

Epic: EPIC_REF. The desktop is revived with two modes:

- **Server mode** opens the cloud app in a desktop window, like roomler-desktop's "Open Roomler".
- **Local mode** runs against a SQLite copy of the org's data. It syncs two-way with the cloud on
  a PCON+-style hub/spoke engine, using **MongoDB change streams over the oplog** where PCON+
  uses SQL Server CDC.

Every desktop is a registered `Desktop` of its org, and one Sync page shows them all. The
architecture reference is [`docs/architecture/sync.md`](../architecture/sync.md), rewritten as
the target. Every current-state fact was verified against master @ `81b5fe5` and production on
2026-09-28.

| Doc | Title | Tracking |
|---|---|---|
| [FR-14](FR-14-lgr-desktop-app-server-mode.md) | The app: rebuilt and signed release pipeline, auto-update with roomler's safety rules, Overview + **Open LGR** (server mode, OAuth through the system browser), native fiscal bridge, local-mode shell. Two live web exposures are fixed in P1: `/ws/fiscal-bridge` accepts unauthenticated bridges, and the SPAs accept any `?token=` (login fixation). | FR14_REF |
| [FR-15](FR-15-desktop-registration.md) | Registration: single-use codes, ephemeral keys, an Ed25519 key in the OS keystore, presence, assignment, pause / revoke / wipe | FR15_REF |
| [FR-16](FR-16-local-mode-sync-engine.md) | Local mode + sync engine: SQLite document store, offline route manifest with parity gate, oplog journal, pull/push, projections, number bands, conflicts, dead letters, reconcile, drift | FR16_REF |
| [FR-17](FR-17-sync-page.md) | Sync page: `/settings/sync` (the org's desktops and sync health), `/admin/sync` (engine), the desktop's own Sync view, a digest section | FR17_REF |
| [FR-18](FR-18-desktop-tests-field-automation.md) | Quality gates: CI, integration suites, multi-desktop simulation harness, Playwright incl. the Tauri app, automated field testing on the vmtest hosts, fleet checks, release gate | FR18_REF |

**Suggested order**

1. FR-15 + FR-14 P1 + FR-18 T1: registration, then the rebuilt, signed app with server mode.
   Two web fixes go **first**, because both are exposures in production today:
   - FR-14.26: authenticate `/ws/fiscal-bridge`;
   - FR-14.14: accept `?token=` on the Vite dev ports only.
2. FR-17: the Desktops tab, the register dialog and the approval page.
3. FR-14 P2: the native fiscal bridge. This ends the till's one-tab, Chrome-only Web Serial
   limits.
4. FR-16 P1 + FR-18 T3: journal, pull and read-only local mode, plus the remaining FR-17 tabs.
5. FR-16 P2: offline selling (push, projections, bands), and only once the accountant has
   agreed the band plan.
6. FR-16 P3–P4, FR-18 T4.

**Constraints this batch adds to the global list below**

- No token in a URL. A socket authenticates in its first message.
- Hub-side change capture is the oplog. Nothing in sync relies on Mongoose middleware seeing a
  write.
- A route joins the offline manifest only together with its import-graph test and its parity
  test.
- Legal numbers issued offline come from admin-confirmed bands, and the hub allocator is
  band-aware.

## Requirement language

- **MUST** — required for acceptance.
- **SHOULD** — expected unless there is a concrete reason not to; note the reason in the PR.
- **MAY** — optional / future.

Every FR has: current state (code-grounded), requirements, edge cases, integration
constraints, migration notes, acceptance criteria, and a field-test script for the
production deployment (`https://lgrai.app`, org `regal` — Bulgarian data, BGN, bg locale).

## Suggested implementation order

1. **FR-02** — smallest, independent, immediately useful.
2. **FR-01** — the big one; changes the sales/purchase list + form views that FR-03/FR-05 touch.
3. **FR-03** — nav move depends on FR-01's menu restructure; aggregated export builds on FR-02's dialog work.
4. **FR-04** — independent of the others; can run in parallel with FR-01..03.
5. **FR-05** — last (or in parallel by a second developer), so URL-sync and hover menus are
   built against the final (merged) views rather than views about to be replaced.

## Global regression constraints (apply to every FR)

These are load-bearing external contracts. Breaking any of them breaks nightly production
imports or the e2e suite:

1. **`POST /org/:orgId/bills/import/{extract,draft,convert}` must stay byte-compatible** —
   five migration CLI skills drive it against the deployed API (`CLAUDE.md` → Document Import).
2. **`POST /org/:orgId/invoices` payload contract must stay backward-compatible** — the
   `import-sales-invoices` and `import-cash-register-sales` skills post invoices/cash sales
   directly (incl. `skipStockMovement` / `allowNegativeStock` flags).
3. **Route names are load-bearing twice**: Playwright e2e navigates by them, and
   `useGridColumns` keys per-user column prefs by `gridId = route.name`
   (`packages/ui-shared/src/composables/useGridColumns.ts:39`). Keep existing list-route
   names (`invoicing.sales`, `invoicing.purchases`, …) even where labels change.
4. **Sequence/prefix logic is registry-driven** — never hardcode a document prefix; extend
   `packages/services/src/biz/sequence-registry.ts` instead.
5. Post-implementation verification per `CLAUDE.md`: backend → `bun run test`; frontend →
   `bun run build`; full-flow → `bun run test:e2e`. On Windows, convert any new test using
   `.rejects`/`.resolves` to try/catch capture (known Bun deadlock — `CLAUDE.md` Known Issues).
