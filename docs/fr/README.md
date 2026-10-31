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
| [FR-19](FR-19-global-accounts-org-switcher.md) | One account per person (Identity + per-org memberships), sign-in without an org, an org menu in every app's top bar, each browser tab in its own org, join / found an org, change and reset your password | PRs #83–#102, #103 (UI) |
| [FR-21](FR-21-cash-register-pos-and-cash-sales.md) | One cash register: POS transactions (`/pos/orders`) and cash sales (`/invoicing/cash-sales`) become one cash-register document (`Invoice` `cash_sale` + `cash_storno` + a `register` block), shown in one journal at both paths and written through one service. Five releases (read side, write side, freeze, contract, one terminal); the migration keeps every sale's `_id`, number and УНП, and each release can be rolled back. Implementer: Atanas. R1 built in #244 → #247 → #248; state and next steps in the [handover](FR-21-HANDOVER.md) | [gjovanov/lgr#171](https://github.com/gjovanov/lgr/issues/171) |
| [FR-22](FR-22-daily-paths-ux.md) | Daily paths — the regal staff's seven everyday pages cost fewer clicks and offer the next step on the same screen: a click-budget walk per path (`packages/e2e/tests/ux-budgets`, measured before and asserted after every slice), the 18 defects the walks found (a receipt with product update that cannot be saved, a bill that books received goods twice, a proforma conversion that burns an invoice number, a credit note that ignores the discount, an order conversion that invoices goods not yet received), and seven slices from those fixes to a „+ Нов" menu. Draft, awaiting the owner's decisions D-1…D-8 | — (opened on approval) |
| [FR-24](FR-24-one-app.md) | One app: the eight SPAs become one Vite build at the same URLs, so moving between modules stops being a page load and stops dropping the browser's printer; the seven copies of the auth plugin become one; and what a second pod needs: a bridge that reconnects, presence rows, and each fiscal request forwarded to the pod holding its printer. Measured: one build 22 s against 134 s, 9 MB against 52 MB, first load +12 KB gzipped. ⚠ `replicas: 2` breaks tills until its Phase 6 ships | [gjovanov/lgr#402](https://github.com/gjovanov/lgr/issues/402) |
| [FR-23](FR-23-cash-invoice-receipts.md) | A fiscal receipt for every cash payment on an invoice: at issue, paid later, paid in parts, and on a debit note. A credit note's cash refund prints a storno of one of those receipts, partial when the refund is smaller, and a refund with no receipt to storno is refused. The till gets partial storno. Each receipt is a cash-register document of its own kind, linked to the invoice, carrying money and fiscal facts only: the invoice moves the stock (owner, Q-1) | [gjovanov/lgr#363](https://github.com/gjovanov/lgr/issues/363) (partial storno) |

## LGR Desktop

| Doc | Title | Tracking |
|---|---|---|
| [FR-14](FR-14-lgr-desktop-app-server-mode.md) | LGR Desktop, **a server-mode client**. It covers: a rebuilt release pipeline, signed with **roomler's identity** on Windows, macOS and Linux; auto-update with roomler's safety rules; Overview + **Open LGR** (OAuth through the system browser); the native fiscal bridge; registration and a Desktops page; retiring the local-mode prototype; CI, e2e and vmtest field lanes. Two live web exposures are fixed first: `/ws/fiscal-bridge` accepts unauthenticated bridges, and the SPAs accept any `?token=` (login fixation). | [gjovanov/lgr#57](https://github.com/gjovanov/lgr/issues/57) |

**What was dropped.** A local mode was specified on 2026-09-28 as FR-15–FR-18 (commit
`bc48d04`), and dropped the same day after review: a SQLite replica with PCON+-style hub↔desktop
sync, a separate registration FR, a Sync page and a test FR. The desktop only opens the cloud
app. The parts a server-only client still needs are folded into FR-14: registration (whose
credential authenticates the native fiscal bridge), the Desktops page, and the tests and field
lanes.

**Constraints this adds to the global list below**

- No token in a URL. A socket authenticates in its first message.
- Desktop releases are signed with roomler's identity. A rotation in `roomler-ai` is repeated in
  `lgr` the same day (FR-14.3).

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
