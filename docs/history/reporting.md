# History: Reports, exports, PDFs and the digest

What was built in this area, release by release: the Reports module and catalog, list/report PDFs, printed pages, the daily digest.

Moved here whole from `CLAUDE.md` by FR-32.13 (#797), section by section and word for word, so "below" and
"above" in it speak of the file it came from. The traps and the never/always rules of these sections are also in
the rule file [`.claude/rules/reporting.md`](../../.claude/rules/reporting.md), which a session loads when it touches
this area's files. A new trap goes there (or in `CLAUDE.md` if it is not one area's); what was built goes here.

## Reporting → Export (2026-04-21)

New `POST /api/org/:orgId/invoicing/export/kind/:kind` endpoint with `kind ∈ {outgoing, incoming, cash_register}`.
- **outgoing** = invoice + credit_note + debit_note, direction=outgoing (shared SALES_DOC numbering)
- **incoming** = bills (type=invoice, direction=incoming)
- **cash_register** = cash_sale (separate numbering)

Empty result set → 200 with header-only workbook (not 404). UI at `/invoicing/reporting/export` — 3 cards with date range + Excel/PDF + column picker (reuses `ExportDialog`).

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
`web/src/modules/reports/types/report.ts` **mirrors** the wire types deliberately rather than importing
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
- (Then) **Cross-SPA links had to be hrefs**, via `appHref(appId, path)` (`ui-shared/nav/navigate`). Since
  FR-24.21 one SPA serves every module, so route names work too, and `appHref` returns the path.
- **Favorites**: moving a page re-keys its ★ favorite (`id === path`). `LEGACY_PAGE_IDS` in
  `page-registry.ts` remaps the two old ids on load (`usePageFavorites.syncFromStorage`), so
  stars and usage counts survive.
- **Only ONE `ReportingTabGrid` is mounted at a time** (keyed on the active tab, no `v-window`):
  three live grids would fight over the same FR-05 querystring keys. The tab itself is in the URL.
- **NOT done in P1** (recorded, deliberate): `desktop-ui` parity deferred; the dead
  `api/src/controllers/export.controller.ts` stub (FR-6.21, zero consumers, returns a
  "not yet implemented" descriptor) left mounted; `/invoicing/reports/aging` still answers
  **anonymously** (pre-existing, and byte-compat per FR-6.20 — worth its own fix).
- Touch points for the next app: see "Adding a module" under FR-24 (a manifest and its registry rows;
  ⚠ the `apps.*` **and** legacy `appHub.*` i18n blocks ×4, since a missing key renders literally).

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
- **Shared by EVERY PDF, forms included (2026-11-08, #578):** the side margins,
  `PAGE_SIDE_MARGIN` = 18 mm in `pdf/page-margins.ts` (1.5 × the old 12 mm; build a page's
  margin with `pageMargin(top, bottom)`, top/bottom stay per document). The forms' line grid is
  `pdf/line-grid.ts`: the grid's box runs margin to margin and its first and last columns' text
  sits `GRID_EDGE_PADDING_PX` (5px, never less) inside it — flush, as #578 first printed it, put
  the line numbers and amounts against the ends of the heading band; the invoice's amount in
  words follows the line numbers. Every column but the free text fitted to its widest entry
  (`fit`), one 10px gutter (8px let „1000" + „9999.99" read as one figure), free text
  `overflow-wrap: anywhere` (an unbroken name made Chrome shrink the whole page). The parties
  band above the grid (invoice + companions, 2026-11-10) takes the same rules per half: titles
  and keys one inset in (in line with the line numbers), a 10px gutter before the value, values
  ending one inset short; the invoice's keys take 13% like the companions' (at 11% ДОСТАВУВАЧ
  plus its padding unbalanced the two halves by 20px). ⚠ The band row sets only `padding-top`/
  `-bottom`: its old `padding: 3px 0` shorthand outranked the keys' inset, which is why the
  titles printed flush. ⚠ A Puppeteer footer template spans the whole sheet: it insets itself by the same
  margin and must keep `width:100%` (Chrome lays it out in a flex row, where it shrinks to its
  text). `unit/pdf-page-layout.test.ts` measures the grid and the band as Chrome prints them.

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
- **FR-6.21 resolved**: the dead `api/src/controllers/export.controller.ts` stub is
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

## A printed page runs nothing and fetches nothing (2026-11-16)

Every printed form is built from text people typed (a name, an article, a note), and Chrome obeys
markup wherever it finds it. Two locks, both in `packages/reporting/src/pdf/`:

- **The builders print typed text as text.** HTML-built forms use `escHtml`. Markdown-built ones
  (the order sheets, the payslip, the statements) use **`mdText`**, which also keeps the text from
  being read as markdown (`![…](…)` is an image to the parser) and turns its own line breaks into
  `<br>`.
  - ⚠ A new builder never interpolates a stored value bare.
  - ⚠ A stored value never goes into an attribute. The letterhead is the one that does, and
    `resolveLogo` lets through only an inline PNG, JPEG or WebP (`data:image/…;base64,`); anything
    else (an address, a path, other data) prints the bundled logo. `Org.logo` is free text an
    admin can set, so the pattern is what keeps it inside its attribute.
- **`lockPage` (`base.pdf.ts`) stands behind them**, for the place a builder forgets:
  - no script runs, neither a script element nor an `on…` attribute;
  - every request the page makes is cancelled unless it is a `data:` URL. Cancelled as `aborted`:
    any other reason puts Chrome's error page in place of a document that tried to send itself
    elsewhere;
  - Chrome is started with a proxy that is not there (`NO_NETWORK_ARGS`), because a
    `<link rel="prefetch">` is fetched by the browser itself and never passes the page's
    interception.
  So a form carries everything inline: a remote image, font or stylesheet never loads.
- ⚠ **A locked page fires no timer** (`setTimeout`, `requestAnimationFrame`): an expression given
  to `evaluateRenderedPage` that waits on one never settles. Wait on an animation's `finished`.
- The previous renderer and its `PDF_RENDERER=md-to-pdf` switch are gone (it printed pages
  unlocked). `md-to-pdf` remains only as the parity test's reference page.
- Proven in the production image and with the masters' `chrome-headless-shell`, not only here:
  the same hostile page, nothing run, nothing requested, render time unchanged.
- Tests: `unit/pdf-page-lock.test.ts` (one page that tries every way against a listener that
  counts; the sheets through the markdown parser; the letterhead). ⚠ A stalled render can no
  longer be made with a server that never answers, so `pdf-render-deadline.test.ts` awaits a
  promise the page never settles.
