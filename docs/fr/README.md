# Functional Requirements — 2026-08 batches

FR documents, one per requested function, written for an implementing developer with full
repo access. All file paths are repo-relative; line numbers are **anchors, not gospel** —
FR-01..05 reference master @ `38d468e` (2026-08-21), FR-06..10 reference master @
`dc1422c` (2026-08-25).

## First batch (FR-01..05 — SHIPPED 2026-08-23, PR #13, issues #8–#12 closed)

| Doc | Title | Main surfaces |
|---|---|---|
| [FR-01](FR-01-unified-document-types-sales-purchase.md) | Unified document types for Sales & Purchase documents (invoice / credit note / debit note in one table, one prefix, one sequence) | `invoicing-api`, `services` (sequence registry, stock, JE, ledger), `invoicing-ui` |
| [FR-02](FR-02-export-dialog-defaults.md) | Export dialog defaults (Status/Currency off, PaymentMethod on, PDF default) | `ui-shared` (ExportDialog, useExportColumns), `invoicing-ui` |
| [FR-03](FR-03-cash-sales-outgoing-pos-layout-aggregated-export.md) | Cash sales: move to Outgoing Documents, POS-style detail page, aggregated export | `invoicing-ui`, `invoicing-api` (export), nav |
| [FR-04](FR-04-product-tabs-movements-inventory-counts.md) | Product tab renames + document links, inventory count ⇄ adjustment movement marriage, "Stock Movement Documents" rename | `inventory-ui`, `warehouse-api`, `db` |
| [FR-05](FR-05-grid-url-state-hover-menus-drag-drop-columns.md) | Grid state in the URL, hover-open menus, drag & drop column reorder | `ui-shared`, `ui-shell`, all `*-ui` |

## Second batch (FR-06..10 — from „Spravki ledger.docx" + the Reports app, 2026-08-25)

| Doc | Title | Issue | Main surfaces |
|---|---|---|---|
| [FR-06](FR-06-reports-module.md) | Reports app module („Справки") — card hub, report registry, move export + aging from invoicing | #14 | `config`, new `reports-ui`/`reports-api`, `services` (report-registry), `unified.ts`, `ui-shared` nav, `invoicing-ui` (redirects) |
| [FR-07](FR-07-warehouse-operations-report.md) | „Складови операции" — per-product purchases/sales report (registry entry) | see issue link in doc header once created | `services` (handler), `reporting`, rides FR-06 |
| [FR-08](FR-08-sales-history-report.md) | „История на продажбите" — sales history / cash reconciliation (registry entry) | ″ | `services` (handler over Invoice ∪ POSTransaction), `reporting`, rides FR-06 |
| [FR-09](FR-09-cash-register-day-close.md) | „Каса и приключване" — end-of-day close with counted amounts + fiscal Z-report | ″ | `invoicing-api` (pos.controller), `db` (POSSession), `fiscal`, `pos-ui` |
| [FR-10](FR-10-invoice-email.md) | Email an outgoing invoice (PDF attachment via SendGrid) | ″ | `services` (email.service), `db` (EmailLog, Invoice), `invoicing-api` (export controller), `invoicing-ui`, `ui-shared` |

**Second-batch order:** FR-06 first (FR-07/FR-08 land inside its registry; FR-09's
optional „Каса" card links into it). FR-10 is independent and can ship anytime. FR-09's
backend is independent of FR-06; only its card placement waits.

The authoritative Bulgarian requirement wording from „Spravki ledger.docx" is embedded
verbatim in each FR's appendix; the docx (repo root, untracked) additionally carries 4
screenshots of the legacy PlusMinus screens worth viewing before UI work.

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
