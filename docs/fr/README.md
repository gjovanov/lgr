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
| [FR-21](FR-21-cash-register-pos-and-cash-sales.md) | One cash register: POS transactions (`/pos/orders`) and cash sales (`/invoicing/cash-sales`) become one cash-register document (`Invoice` `cash_sale` + `cash_storno` + a `register` block), shown in one journal at both paths and written through one service. Five releases (read side, write side, freeze, contract, one terminal); the migration keeps every sale's `_id`, number and УНП, and each release can be rolled back. Implementer: @lazarovski. R1 built in #244 → #247 → #248; state and next steps in the [handover](FR-21-HANDOVER.md) | [gjovanov/lgr#171](https://github.com/gjovanov/lgr/issues/171) |
| [FR-22](FR-22-daily-paths-ux.md) | Daily paths — the regal staff's seven everyday pages cost fewer clicks and offer the next step on the same screen: a click-budget walk per path (`packages/e2e/tests/ux-budgets`, measured before and asserted after every slice), the 18 defects the walks found (a receipt with product update that cannot be saved, a bill that books received goods twice, a proforma conversion that burns an invoice number, a credit note that ignores the discount, an order conversion that invoices goods not yet received), and seven slices from those fixes to a „+ Нов" menu. Draft, awaiting the owner's decisions D-1…D-8 | — (opened on approval) |
| [FR-24](FR-24-one-app.md) | One app: the eight SPAs become one Vite build at the same URLs, so moving between modules stops being a page load and stops dropping the browser's printer; the seven copies of the auth plugin become one; and what a second pod needs: a bridge that reconnects, presence rows, and each fiscal request forwarded to the pod holding its printer. Measured: one build 22 s against 134 s, 9 MB against 52 MB, first load +12 KB gzipped. ⚠ `replicas: 2` breaks tills until its Phase 6 ships | [gjovanov/lgr#402](https://github.com/gjovanov/lgr/issues/402) |
| [FR-23](FR-23-cash-invoice-receipts.md) | A fiscal receipt for every cash payment on an invoice: at issue, paid later, paid in parts, and on a debit note. A credit note's cash refund prints a storno of one of those receipts, partial when the refund is smaller, and a refund with no receipt to storno is refused. The till gets partial storno. Each receipt is a cash-register document of its own kind, linked to the invoice, carrying money and fiscal facts only: the invoice moves the stock (owner, Q-1) | [gjovanov/lgr#363](https://github.com/gjovanov/lgr/issues/363) (partial storno) |
| [FR-25](FR-25-books-payroll-and-bg-filings.md) | One set of books and one payroll for a legal entity: where the real books are (a third PlusMinus, typed by hand, goods by accounting group), importing them as booked, posting forward by group in a shadow ledger, payroll with its own personal-data controls, and the Bulgarian filings produced byte for byte for a person to file. Plan only; nothing built | [gjovanov/lgr#471](https://github.com/gjovanov/lgr/issues/471) |
| [FR-25a](FR-25a-books-schema-reconciliation.md) | The books' schema against the accountant's database: every property the source carries set against ours, each meaning read off the whole journal by cross-tabulation (payment codes, links, dates, the register's document types), the relevant ones added to `JournalEntry`, `AccountingAnalytic`, `FixedAsset`, `Contact` and `Org` and filled by the books import, the rest deferred with reasons, and the UI CRUD plan entity by entity (planned, not built) | `db` models, `accounting-books` import, `books-import`/`contact`/`org` routes |
| [FR-26](FR-26-seller-and-sales-consultant-roles.md) | Two roles for counter staff, Seller and Sales Consultant: Invoicing without orders (the consultant keeps them), incoming documents, payments or sequences, and Inventory with read-only products and Transfer-only stock movements, kept out of Portal, Accounting, Payroll, Reports and Files. They work through **areas** on a permission set (absent means unrestricted, so nothing existing changes) and a new `inventory.transfer`. The spec also closes three ways a role and its sets disagree today: a role change keeps the sets, an invite gets the org's default set, and a token keeps its permissions for 24 h. The reports API starts checking `reports.read`. Also: an Administrator who does not see Reports, which does not reproduce from data or code. Implementer: @lazarovski | [gjovanov/lgr#493](https://github.com/gjovanov/lgr/issues/493) |
| [FR-28](FR-28-supplier-facts-product-search-order-tree.md) | Buying from the product list. A product knows which suppliers it came from, **read from bills and receipts and never stored**, and the Products list filters by supplier and by quantity (*Below minimum* included). Articles selected there become a draft supplier order or customer order in one step. Every screen that picks a product gets the same autocomplete and a Details dialog that is the Products list (one engine, the list's filters and columns). Bills, invoices and proformas lose the title lines of their banner and put the party, the number and the date on one row, with the notes where they belong. Supplier orders, customer orders and reservations show their allocations and reservations as a collapsible tree with totals on each parent; a one-day spike decides between Vuetify's grouped table and a tree of our own. Seven slices, three of them independent of the products work | [gjovanov/lgr#622](https://github.com/gjovanov/lgr/issues/622) |

## Audit batch (2026-11-16)

The owner asked for the technical debts, code smells, performance bottlenecks and suboptimal UX
aspects of the app, with a solution for each. `origin/master` at `cb7d18c5` was read, and then run
on a throwaway local copy with the seeded demo organization filled to about one shop-year (23 050
products, 46 120 stock levels, 10 020 invoices, 5 000 movements), in a real browser at 1366x768
with the database profiler on. Production was only read anonymously (its public sign-in page).

The audit produced **53 findings**. Each has an id (**R** defects and reliability, **P**
performance, **U** user experience, **T** technical debt, **C** code smells) and sits in exactly
one of four FRs. Nothing is built yet.

| Doc | Title | Findings | Tracking |
|---|---|---|---|
| [FR-29](FR-29-atomic-bookings-records-runtime.md) | Bookings that are all-or-nothing, records that always exist, and a server that says when it is degraded. A stock booking, the issue of a document and the journal entry it owes are stored whole or not at all, and a retry finishes what an earlier attempt left. Audit entries keep their content and exist for what the system does. A lookup that fails, an index that did not build and a query that never ends are reported | R1, R2, R3, R4, R7, R8, R9, P12, P13, T6, C7 (11) | [gjovanov/lgr#794](https://github.com/gjovanov/lgr/issues/794) |
| [FR-30](FR-30-speed-at-shop-volume.md) | Speed at shop volume: lists, searches, reports, heavy screens, PDFs and the first load. Every item has a measured budget, and for most the fix was measured too: a list's first page from about 200 ms to 2 ms with an index, a product search from up to 390 ms to under 35 ms, the stock-levels report from about 4 s to 0.25 s | P1 to P11, P14, U12 (13) | [gjovanov/lgr#795](https://github.com/gjovanov/lgr/issues/795) |
| [FR-31](FR-31-forms-and-lists-that-do-not-lose-or-mislead.md) | Forms and lists that do not lose or mislead, in one format and one language. Part A: an edit after the first Save that is dropped without a question, a late search answer that offers the wrong article, a document that failed to load and looks like an empty draft, pickers that know only the first ten, an Export that does nothing. Part B: one number, money and date format, no English in another language's session, lists that keep their place, room at 1366x768, named icon buttons, a jump to a document by its number | R5, R6, R10, R11, U1 to U11, C6, T7 (17) | [gjovanov/lgr#796](https://github.com/gjovanov/lgr/issues/796) |
| [FR-32](FR-32-code-health.md) | Code health: a type-check and a linter in CI against a baseline that only shrinks, a browser smoke on pull requests that touch the UI, dead code out, entity types that come from the schemas, write routes that declare what they accept, and the largest handlers and forms in smaller pieces | T1, T2, T3, T4, T5, T8, T9, C1 to C5 (12) | [gjovanov/lgr#797](https://github.com/gjovanov/lgr/issues/797) |

**Finding to FR**

| Ids | Where |
|---|---|
| R1 to R4, R7 to R9 | FR-29 |
| R5, R6, R10, R11 | FR-31 |
| P1 to P11, P14 | FR-30 |
| P12, P13 | FR-29 |
| U1 to U11 | FR-31 |
| U12 | FR-30 |
| T1 to T5, T8, T9 | FR-32 |
| T6 | FR-29 |
| T7 | FR-31 |
| C1 to C5 | FR-32 |
| C6 | FR-31 |
| C7 | FR-29 |

Each FR's §0 maps its findings to requirement numbers.

**How the four depend on each other**

- FR-32.14 (the repository takes `select` and `session`) is small and comes first: FR-29 slice A
  and FR-30 slice B wait for it.
- FR-31.4 (the latest question wins) and FR-30.6 (one request per list open) change the same
  function and ship together.
- FR-31.12 (lines keep their identity) comes before FR-30.10 (a document opens with a fixed
  number of requests).
- Inside FR-29, lookups that tell "failed" from "not there" (.23) come before query time limits
  (.26).

**Suggested order**

1. FR-32.14, and FR-32 slice A (the gates): every later change is safer with them.
2. FR-29 slices A and B: stock that moves twice is the costliest thing found.
3. FR-31 slices A1 to A3: lost edits, a wrong article on a line, a failure that looks like a draft.
4. FR-30 slice A: the list indexes, the cheapest speed-up in the batch.
5. The rest by slice, as each FR's §5 orders it.

**Checked and found sound**

- Key parity between the four language catalogues. Search boxes are debounced. The first load's
  JavaScript is inside its budget.
- Production serves HTTP/2 with brotli and HSTS. Secrets fail fast in production.
- The per-request sign-in lookups are cached per process.
- A stock level and a cost layer are each one atomic write, and the lost-update fix (#460) holds.
- Leases and request ids on issue, payments, the till's open and close, and a count's completion.
- Background tasks keep their owner across pods (heartbeat, orphan reaper). The migration lock.
- The PDF renderer's deadline, kill of a stalled browser, retry and network lock.
- Excel exports stream to a file and are capped.
- The till's selling surface, the keyboard grid of the document line table, the save shortcuts.
- Stale-build detection and chunk-error recovery in the SPA.

**Not looked at**

- The till's payment, session and fiscal flow; the document import dialog; the files app; the
  reports runner; Settings → Servers; the desktop shell.
- Widths below 1366 px, keyboard-only use and screen readers.
- The accounting reports, the reservation queries and the journal queries against their indexes.
- The production database's own plans and sizes, pod memory limits, the deploy repository.

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
