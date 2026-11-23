---
paths:
  - "packages/reporting/**"
  - "packages/api/src/reports/**"
  - "packages/web/src/modules/reports/**"
  - "packages/services/src/biz/reports/**"
  - "packages/services/src/biz/report-registry*"
  - "packages/services/src/biz/digest/**"
  - "packages/api/src/controllers/export*"
---

# Rules and traps: Reports, exports, PDFs and the digest

Every ⚠ and every never/always rule of this area's history, copied whole with the bullet it sits in, by section.
Why each one exists, and what was built around it: [`docs/history/reporting.md`](../../docs/history/reporting.md).
`unit/claude-md.test.ts` fails when a ⚠ of that history is in neither this file nor `CLAUDE.md`.

## Reports app module — FR-06 / #14 P1 (2026-08-25)

- ⚠ **`isSignIn` does not actually reject anonymous callers** on these controllers — verified
  against the running server. Every endpoint that answers 401 does so from an explicit
  `if (!user) return status(401)` in the handler. All three reports routes carry that check;
  it is load-bearing, not defensive.

- Touch points for the next app: see "Adding a module" under FR-24 (a manifest and its registry rows;
  ⚠ the `apps.*` **and** legacy `appHub.*` i18n blocks ×4, since a missing key renders literally).

## FR-07 / FR-08 — the first two registry reports (2026-08-25)

- **The date lies.** `createInvoiceStockMovement` stamps `date: new Date()` — booking time.
  Effective date = the linked invoice's `issueDate`, else the movement's `date`, so the
  period filter runs **after** the `$lookup`. A ±45-day pre-filter on `movement.date` keeps
  the scan sane; it is an optimisation, never the real filter.

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

## One house style for every list/report PDF (2026-08-25)

- ⚠ **The meta block is `position:absolute`, so it adds nothing to its container's height.**
  With the usual three rows that is invisible (the title block is taller); a report adding
  filter lines overflowed and printed *over* the table header. `buildTopBar` now sets an
  explicit `min-height` once the meta block has more than 3 rows — documents with 3 or fewer
  are byte-identical to before.

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

- ⚠ **`STATUS_OPTIONS` mirrors the Invoice enum exactly.** Offering `completed` (which some
  list views still show) is a filter that can only ever return nothing — the model's enum is
  `draft|sent|received|partially_paid|paid|overdue|voided|cancelled|converted`.

- **FR-6.2 permissions landed**: `reports.read` / `reports.export` are real, and the App Hub
  tile is gated on `reports.read` instead of the P1 stand-in `invoicing.read`. Export is a
  separate right — a read-only `member` can run a report and read it on screen but gets 403
  on download (`canExportReport`, layered ON TOP of `canAccessReport` so it can never reveal a
  report whose module permission the caller lacks). ⚠ **OPS ORDER: deploy → run
  `scripts/backfill-reports-permissions.ts --execute` → tell people to re-login.** A JWT
  carries the permission list it was issued with; admins are exempt because `tokenize()`
  expands an `isAdmin` set to every PERMISSION. Symptom of skipping it: the Reports tile
  silently disappears from the App Hub.

- ⚠ **Superseded 2026-09-29 (FR-14.34):** `desktop-ui` IS in `bun run build` now, precisely so
  that cannot happen again — see "Desktop: local mode retired" below. The sentence above is kept
  as the record of why it was added.

## FR-11 — daily digest email (2026-08-26)

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

- Endpoints (`api/src/controllers/digest.controller.ts`, admin-only via the raw role guard):
  `POST /digest/test` (**sends to the caller only**, never the recipient list; 503 when
  unconfigured), `GET /digest/preview`, `GET /digest/last-run`.

## A printed page runs nothing and fetches nothing (2026-11-16)

- ⚠ A new builder never interpolates a stored value bare.

- ⚠ A stored value never goes into an attribute. The letterhead is the one that does, and
  `resolveLogo` lets through only an inline PNG, JPEG or WebP (`data:image/…;base64,`); anything
  else (an address, a path, other data) prints the bundled logo. `Org.logo` is free text an
  admin can set, so the pattern is what keeps it inside its attribute.

- Chrome is started with a proxy that is not there (`NO_NETWORK_ARGS`), because a
  `<link rel="prefetch">` is fetched by the browser itself and never passes the page's
  interception.
So a form carries everything inline: a remote image, font or stylesheet never loads.

- ⚠ **A locked page fires no timer** (`setTimeout`, `requestAnimationFrame`): an expression given
  to `evaluateRenderedPage` that waits on one never settles. Wait on an animation's `finished`.

- Tests: `unit/pdf-page-lock.test.ts` (one page that tries every way against a listener that
  counts; the sheets through the markdown parser; the letterhead). ⚠ A stalled render can no
  longer be made with a server that never answers, so `pdf-render-deadline.test.ts` awaits a
  promise the page never settles.
