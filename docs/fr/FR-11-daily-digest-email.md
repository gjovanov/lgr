# FR-11 — Daily digest email (KPIs + reconciliation anomalies, per-org recipients)

**Goal:** Every morning LGR emails a configurable list of users a **daily digest** for the
previous day: headline numbers (sales, documents issued, payments) plus the
**reconciliation anomalies the accountant currently compiles by hand** — corrections and
write-offs booked with a minus sign, products at zero/negative stock, sales without a
stock document, suspected duplicate sales, documents edited after issue, failed
imports/emails. An **admin configures recipients, send hour and sections per org**
(Odoo-digest style); delivery goes through the existing SendGrid integration
(`email.service.ts` — hardened by FR-10, so daily-limit concerns of built-in mail servers
do not apply; volume is `recipients × 1/day`).

Status: draft for implementation · Date: 2026-08-26 · Depends on: nothing (FR-10's email
hardening is already on master; the Reports app is unrelated — a digest is org settings +
a scheduled job, not a report card) · Feeds: nothing.

Driving input: goran's 2026-08-26 request + the pasted daily reconciliation list
(verbatim in Appendix A, with a line-by-line mapping to digest sections) + the Odoo
digest-email pattern (admin-picked recipients, daily frequency, KPI content).

---

## 1. Current state (master @ `89e68b4` — verified 2026-08-26)

**No digest, newsletter, or scheduled-email code exists anywhere** (grep-verified). The
only periodic job in the unified server is the SUPTO time-sync: `unified.ts:349-370` —
`setTimeout(…,100)` after listen, dynamic import, `setInterval` with a config-driven
interval, `.catch()` per tick, best-effort `try/catch` around the block. **No cron
library, no task runner/queue** (`services/background/task.service.ts` only *records*
progress of request-triggered jobs into `BackgroundTask`; nothing dispatches), **no lease
or run-once primitive** (the time-sync tick has no guard — it is idempotent by nature; a
digest is not). MongoDB runs as a replica set, so unique-index/`findOneAndUpdate` claims
are available.

**Org settings** (`org.model.ts:131-178`): scalars `baseCurrency, fiscalYearStart,
dateFormat, timezone (default 'Europe/Berlin'; regal seeds 'Europe/Sofia'), locale
(default 'en'; regal 'bg')` + blocks (`accounting` is the precedent shape). ⚠ **`timezone`
is read by nothing** — no UTC→org-tz conversion exists in the codebase; the digest is its
first consumer. Update path: `PUT /org/:orgId` (`org.controller.ts:16-84`) — **raw
`user.role !== 'admin'` guard** (`admin.settings` permission does not suffice), body
schema **whitelists** the settings sub-object (`:57-81` — `accounting`/`integrations` are
already silently stripped; a new block must be added there), and the DAO does
`findByIdAndUpdate` — **a partial `settings` object replaces the whole subdocument**
(the UI compensates by always sending the full block, `OrganizationView.vue:389-415`).

**Settings UI**: `portal-ui/src/views/settings/OrganizationView.vue` — one form of 9
cards; a new card slots at line 225 (between Modules and the read-only Subscription),
with matching edits in the `form` reactive (`:378`), `save()` payload (`:399-414`) and
`onMounted` hydration (`:449`). Routes/nav have **no client-side role gating**; the
server 403s non-admins.

**Recipients source**: `GET /org/:orgId/user` (`user.controller.ts:22-33`) — signed-in
only, returns active users by default, `{users, total, …}`. ⚠ **It applies no projection
and `password` has no `select: false` — the endpoint returns bcrypt hashes today.**
`User.preferences.locale` exists in the schema but nothing ever writes it; the only
usable locale is the org's.

**Email**: `sendEmail(opts): Promise<SendEmailResult>` (`email.service.ts:35-77`) —
result-typed (`ok | not_configured | provider_error`), attachments supported (20 MB cap),
`entityType`/`entityId` threading, **HTML-only, exactly one recipient per call** → N
recipients = N calls = N `EmailLog` rows. ⚠ `not_configured` early-returns **before**
`logEmail` — an unconfigured server leaves no EmailLog trace; a digest run record must
capture that itself. `EmailLog` has `status/'failed'` + error + entity fields and **no
TTL, no tenantPlugin, no `{orgId,…}` standalone index**. The only HTML-email builder is
`buildEmailHtml` + `EMAIL_BODY_I18N` (×4, `invoice-export.controller.ts:68-107`), with
the governing house rule in its doc comment: minimal inline-styled strings, **no
templating engine**. An EmailLog-based resend guard exists as precedent (`:824-831`).

**Detectability of the pasted anomalies** (verbatim anchors):

- **Zero/negative stock** — `StockLevel` `{quantity, availableQuantity, avgCost}`;
  indexes only `{orgId}` + unique `{orgId,productId,warehouseId}` (`stock-level.model.ts:31-32`).
  A `$match {orgId(oid), quantity:{$lte:0}}` aggregation is the ~25 ms class of
  `getStockValuationTotals` (`warehouse.service.ts:153-164`), NOT the 1.6 s
  materialisation — join product names **after** the match, cap rows.
  `StockLevel.quantity` **can go negative** (no floor in `warehouse.service.ts:121-126`;
  `allowNegative` bypasses `validateStockAvailability`, `invoicing.service.ts:277-279`).
  No history model — "went ≤0 yesterday" is not directly recorded; "is ≤0 now" is.
- **Minus-sign corrections/write-offs** — sign rides on movement type/side, quantities
  stored absolute on import (`map-movement.ts:208-222`); „2000 КОРЕКЦИЯ" splits into
  `receipt(+)` + `adjustment(−)` (`:260-264`); markers in `notes`:
  `stokrazp:/corr:/sklrazp:/sklisk:/storeOperations:` (`:58-69`). ⚠ Inventory-count
  adjustments carry **signed** quantities on the to-side (`inventory-count.controller.ts:162-179`);
  the sign rule is `fromWarehouseId ⇒ −|qty|`, else signed qty
  (`product-ledger.service.ts:242-252`). Index `{orgId,type,date:-1}` fits the query;
  `LIVE_STATUSES = ['confirmed','completed']` (`reports/warehouse-operations.report.ts:33-34`).
- **Sales without a stock document** — `skipStockMovement`/`allowNegativeStock` are
  **transient** request flags, deleted before persist (`invoice.controller.ts:426-432`);
  the durable proxies are `reference: 'salesAnalysis:<date>'` +
  `tags: ['cash-register-import']`. The invoice→movement link is `StockMovement.invoiceId`
  (**unindexed**; reverse reads exist at `invoicing.service.ts:328`). Lines without
  `productId`+`warehouseId` legitimately move nothing (`invoicing.service.ts:242-245`);
  drafts never move stock.
- **Edited after issue** — allowed until a posted JE exists (`invoice.controller.ts:649-665`,
  409 otherwise); every PUT writes an AuditLog `update` entry with `diffChanges` (`:720`).
  `AuditLog`'s date field is **`timestamp`** (not createdAt), indexes
  `{orgId,module,timestamp}` / `{orgId,action,timestamp}` fit; `queryAuditLogs(orgId,
  {modules, actions, dateFrom, dateTo, size})` is reusable (default size 25 — pass an
  explicit size; ⚠ its `entityIds` option force-casts to ObjectId and throws on strings).
- **Import outcomes** — `BackgroundTask` (`type: 'doc-import-analyze'|'doc-import-commit'|
  'opening-stock'|'bill-ocr-draft'`, `result.created/failed` persisted at
  `doc-import.controller.ts:270-275`), **7-day TTL**, `userId` required.
- **Duplicates** — no DB-level heuristic exists; dedupe.ts is import-marker-based. At
  regal a cash day is ONE aggregated `cash_sale` doc, so the realistic duplicate is the
  same product+qty appearing in a CSR **and** an invoice the same day.
- **KPIs** — nothing computes an org-wide "yesterday": `getInvoiceSummary` is
  point-in-time-ish (windowing narrows all facets), `plTotals`/`aggregateAging` are
  module-private to the dashboard controller. The dashboard's `Promise.all` with
  per-source `.catch()` degradation (`dashboard.controller.ts:92-104`) is the assembly
  pattern to copy. Aggregations must cast `orgId` to ObjectId manually.

## 2. Requirements

### 2.1 Configuration (admin, per org)

- **FR-11.1 (MUST)** New `Org.settings.dailyDigest` block:
  ```ts
  dailyDigest: {
    enabled:    { type: Boolean, default: false },
    hour:       { type: Number, default: 7 },          // 0-23, org-local (settings.timezone)
    recipients: [{ userId: { type: Schema.Types.ObjectId, ref: 'User' } }],
    sections:   { kpis, stock, corrections, undocumentedSales, duplicates,
                  editedAfterIssue, ops: { type: Boolean, default: true } × each },
    locale:     String,                                // default: org settings.locale
  }
  ```
  Added to the interface, the schema, **and the PUT body-schema whitelist**
  (`org.controller.ts:57-81`) — without the last one Elysia strips it silently.
- **FR-11.2 (MUST)** Settings UI: a „Daily digest / Дневен отчет" card in
  `OrganizationView.vue` (insert at `:225`, before Subscription): enable switch, hour
  select, recipients **multi-select of org users** (name + email, active only, loaded
  from `GET /org/:orgId/user?size=0`), section checkboxes, plus a **„Send test now"**
  button and a read-only „last run" line (status + timestamp + per-recipient outcome from
  FR-11.6). Wire the three sibling edits (form/save/hydrate) — remember the save payload
  must carry the **full** settings block (subdocument-replacement semantics, §1).
- **FR-11.3 (MUST — security rider)** The recipients picker sits on
  `GET /org/:orgId/user`, which currently returns **password hashes**. Add a projection
  (mirror `findByIdSafe`) excluding `password` (and `oauthProviders` tokens if present)
  from the list route. Tiny, unconditional fix shipping with this FR.

### 2.2 Scheduling & idempotency

- **FR-11.4 (MUST)** New model `DigestRun`: `{ orgId, date: 'YYYY-MM-DD' (org-local),
  status: 'sent'|'partial'|'failed'|'skipped', reason?, recipients: [{ email, ok,
  error? }], startedAt, completedAt }` with **unique index `{orgId, date}`** — the
  insert-first-wins idempotency claim (no lease primitive exists; the unique index IS the
  lock, valid across restarts and future replicas). No TTL (rows are small; the settings
  card reads the latest). `BackgroundTask` was considered and rejected: required
  `userId` for an unattended job + 7-day TTL.
- **FR-11.5 (MUST)** Scheduler in `unified.ts`, following the time-sync template
  verbatim (startup `setTimeout` block + `setInterval`, per-tick `.catch()`): every
  `DIGEST_CHECK_INTERVAL_MS` (config, default 10 min) → find orgs with
  `settings.dailyDigest.enabled` → per org, compute the **org-local** date and hour via
  `Intl.DateTimeFormat` with `settings.timezone` (first consumer of the field; fall back
  `Europe/Berlin` like the schema default) → if `localHour >= configured hour` and no
  `DigestRun` for `(orgId, localDate)` → `DigestRun.create` (duplicate-key ⇒ another
  tick/pod won — skip) → build + send → finalize the run doc. Semantics: **catch-up
  within the same day** (a restart at 11:00 still sends 07:00's digest), **never resend**
  (run doc), **no multi-day backfill** (an outage skips days; MAY later).
- **FR-11.6 (MUST)** Run outcomes: all recipients ok → `sent`; some failed → `partial`;
  builder threw → `failed` (+`reason`); email `not_configured` → `skipped` with
  `reason: 'email_not_configured'` (**the run doc is the only trace** — sendEmail writes
  no EmailLog row in that case, §1). Recipients resolve at send time: userIds → current
  active users' emails, deduped; inactive/deleted users silently dropped (counted in the
  run doc).

### 2.3 Content — `services/src/biz/digest/daily-digest.service.ts` (server-only)

`buildDailyDigest(orgId, localDate)` assembles sections with the dashboard pattern —
**each section independently `.catch()`-degraded** to an inline „section failed" note; a
broken query never kills the digest. Day window: the shipped `dayStart/dayEnd` helper
convention (`warehouse-operations.report.ts:58-60`); `issueDate`-based sections are
calendar-exact, `createdAt`/`timestamp`-based ones accept the ≤3 h server-vs-Sofia skew
(same trade-off FR-08 recorded). All aggregations cast `orgId` to ObjectId.

- **FR-11.7 (MUST) — Продажби (KPIs).** New aggregation (nothing reusable exists):
  outgoing documents of the day grouped by `type` (`$match {orgId, direction:'outgoing',
  issueDate: window, status: {$nin: ['draft','cancelled','voided']}} → $group {_id:'$type',
  count, total}`), same for incoming (bills); payments recorded that day
  (`payments[].date` unwind or `record_payment` audit count — implementer's choice,
  stated in code). SHOULD: cash-vs-card split of the register day, reusing the
  sales-history report's effective-payment-method helper if exported, else inlining the
  3-step precedence (payments[] → header `paymentMethod` → cash-sale inference).
- **FR-11.8 (MUST) — Наличности.** Count + capped list (30 rows + „и още N") of stock
  levels with `quantity <= 0` (product name/SKU via post-match `$lookup`, per-warehouse
  row) — the „актуалното количество е 0" line. SHOULD: low-stock (below
  `Product.minStockLevel`) via the existing — currently caller-less — batched
  `productDao.findLowStock` (note: `CLAUDE.md`'s "N+1 in findBelowMinStock" known-issue
  entry is stale — wrong name, already batched; correct it in this PR).
- **FR-11.9 (MUST) — Корекции и отписвания.** Yesterday's `adjustment` movements
  (LIVE_STATUSES, `{orgId,type,date}` index): movement number, kind label from the notes
  marker (`corr:` → Корекция, `sklisk:` → Отписване, else Ръчна корекция), line count,
  **signed** total qty/value (sign rule: `fromWarehouseId ⇒ −|qty|`, else signed qty —
  inventory-count adjustments are already signed). This is the digest's „разписка със
  знак минус" surface. Import-born corrections carry the document date in `date`, so the
  window is correct for them by construction.
- **FR-11.10 (MUST) — Продажби без складов документ.** Issued outgoing
  `invoice|cash_sale` of the day having ≥1 line with `productId`+`warehouseId` but **zero
  linked movements** (`$lookup stockmovements on invoiceId` + `$match {movements:
  {$size: 0}}`). **Requires a new index `{orgId, invoiceId}` on StockMovement** (MUST —
  also speeds the existing reverse reads). Rows tagged `cash-register-import` render in
  a muted „migration import (intentionally no movement)" sub-list, not as alarms.
  Documents with no product+warehouse lines at all are excluded (legitimately
  movement-free).
- **FR-11.11 (SHOULD) — Съмнителни дублирания.** Same `(productId, quantity)` pair in
  >1 outgoing sale line that day (`$unwind lines → $group → count > 1`, capped),
  labelled „за преглед" — a heuristic, explicitly allowed to have false positives; at
  regal the realistic shape is CSR-line + invoice-line same day.
- **FR-11.12 (SHOULD) — Редактирани след издаване.** Via
  `queryAuditLogs(orgId, { modules: ['invoicing'], actions: ['update','void','delete'],
  dateFrom, dateTo, size: 200 })` (explicit size!), filtered to non-draft entities:
  entity name + action + changed-field count. Covers the „korigirana faktura" trail.
- **FR-11.13 (MUST) — Импорти и имейли (ops).** Yesterday's `BackgroundTask` rows
  (`doc-import-*`, `opening-stock`, `bill-ocr-draft`): per type, completed/failed +
  `result.created/failed` sums; failed `EmailLog` rows of the day
  (`{orgId, status:'failed', createdAt: window}` — **add index
  `{orgId, status, createdAt}`** to EmailLog, currently unindexed for org queries).
- **FR-11.14 (MUST) — Rendering.** `renderDigestHtml(data, locale)` — inline-styled HTML
  per the `buildEmailHtml` house rule (**no templating engine**), new `DIGEST_I18N` map
  ×4 (en/bg/de/mk) colocated with the service; subject
  `„Дневен отчет — {orgName} — {DD.MM.YYYY}"` localized; empty sections render as one
  „няма" line (an empty digest still sends — silence is itself the signal that the day
  was clean); footer notes the org + generated-at. Locale = config `locale` → org
  `settings.locale` → `en` (per-user locale is unwritten today — out of scope).

### 2.4 Endpoints & extras

- **FR-11.15 (MUST)** `POST /org/:orgId/digest/test` (new small `digest.controller.ts`
  in portal-api, mounted in unified.ts): **admin-only** (same raw-role guard as the org
  PUT), builds yesterday's digest and sends it **only to the calling admin's email**
  (never the recipient list), returns `{ sent, to }` or the mapped error
  (`not_configured` → 503 with the explicit message, matching the FR-10 convention).
  SHOULD: `GET /org/:orgId/digest/preview` returning the HTML for an in-card preview
  dialog.
- **FR-11.16 (MAY)** In-app mirror: one `Notification.create({orgId, userId, type:'info',
  title, message, module:'digest'})` per recipient — the first server-side notification
  producer (the model exists; note: no live push is wired, it appears on next load).
- **FR-11.17 (MUST)** i18n ×4 for the settings card (`settings.dailyDigest.*` keys in
  ui-shared locales) and the server `DIGEST_I18N`.

## 3. Edge cases

1. **Unconfigured SendGrid** (dev): run recorded as `skipped`, settings card shows it;
   the test button returns the explicit 503 — never a silent success (FR-10 doctrine).
2. **All recipients deactivated / list empty** while enabled: run `skipped`,
   `reason: 'no_recipients'`; the settings card surfaces it.
3. **DST transitions** in org tz: the hour comparison uses `Intl` wall-clock — a skipped
   or repeated wall-clock hour still yields exactly one run per local date (the run doc
   keys on the date, not the hour).
4. **Org tz changed mid-day**: at most one digest that day regardless (date-keyed).
5. **Two pods / restart mid-send**: the unique-index claim admits one builder; a crash
   after claim but before completion leaves a `DigestRun` without `completedAt` — the
   scheduler retries runs older than 30 min with no `completedAt` (stale-claim takeover,
   conditional update on `completedAt: null`).
6. **Huge anomaly days** (first enablement on a drifted org): every list is capped with
   „и още N" — the digest is a pointer, not an export; deep links (MAY `appHref`) lead
   to the grids/reports.
7. **BackgroundTask TTL**: 7-day window is fine for "yesterday"; the digest never reads
   further back.
8. **EmailLog growth**: one HTML body per recipient per day (~tens of KB) — acceptable;
   note it, no TTL added here.
9. **regal's `settings.timezone` is already `Europe/Sofia`**, other seeds default
   `Europe/Berlin` — the settings card SHOULD display the tz next to the hour picker so
   the admin sees which clock the hour means.

## 4. Integration & regression constraints

1. **No existing endpoint changes** except: the additive org PUT schema key, the
   user-list projection fix (FR-11.3 — verify nothing depends on reading `password`
   there; nothing does), and two new indexes (`StockMovement {orgId,invoiceId}`,
   `EmailLog {orgId,status,createdAt}`) — index builds are cheap at regal scale (~35k
   movements).
2. Import skills / `/bills/import/*` / `POST /invoices` contracts untouched — the digest
   only reads.
3. The scheduler must not fire in tests: gate on `config` flag
   (`DIGEST_CHECK_INTERVAL_MS=0 → disabled`) and set that in `.env.test`; mirror the
   time-sync pattern of best-effort startup.
4. New tests: digest service integration (seed a day: sales + correction movement +
   zero-stock product + undocumented sale + failed task → assert section contents and
   caps; try/catch capture, no `.rejects` — Windows Bun deadlock), DigestRun idempotency
   (double tick → one run; stale-claim retry), scheduler hour/tz math unit tests
   (`Intl`-based, table-driven incl. DST dates), test-send endpoint (admin gate, 503
   unconfigured), user-list projection regression test (no `password` in response).
5. `bun run build` (settings card) + `bun run test`; e2e SHOULD: settings card saves and
   test-send surfaces the 503 in dev.

## 5. Acceptance criteria

- [ ] Admin enables the digest in Settings → Organization: picks recipients (no password hashes on the wire), hour, sections; saves; card shows last-run state.
- [ ] „Send test now" delivers a digest to the admin (or an explicit „email not configured" error), rendered in the org locale with all enabled sections.
- [ ] At the configured org-local hour the digest goes to every recipient exactly once per day — restart mid-day does not resend; a restart before the hour still sends after it.
- [ ] Yesterday's numbers reconcile: KPI totals match the sales-history report for the same day; the corrections section lists the day's adjustment movements with correct signs; a product at qty ≤ 0 appears in the stock section; an issued sale whose movement was skipped appears in the undocumented list (import-tagged ones muted).
- [ ] Runs are recorded (`sent/partial/failed/skipped` + per-recipient outcomes) and visible in the settings card; failed recipient sends land in EmailLog as `failed`.
- [ ] Empty day → short „всичко е наред" digest still arrives.
- [ ] `bun run test` + `bun run build` green; scheduler inert under tests.

## 6. Field test (lgrai.app / regal)

1. Enable for regal with yourself as the only recipient, hour = current hour + a few
   minutes (tz Europe/Sofia); wait a tick interval → digest arrives in bg; verify the
   KPI totals against `/reports` sales-history for the same day.
2. Compare the corrections section against a day with a known imported КОРЕКЦИЯ/sklisk
   batch (movement numbers + signs match the source PDFs).
3. Check the zero-stock list against ProductsView filtered to a known zero-qty product
   (e.g. the ШПИЛКА DIN 976 from the appendix list).
4. „Send test now" twice within a minute → two test mails (test path is exempt from the
   daily claim); the scheduled run still fires once.
5. Temporarily set an invalid SendGrid key on a dev instance → run recorded `failed`
   with provider error; restore.

---

## Appendix A — the driving list (goran, 2026-08-26, verbatim) and its mapping

```
ВИНТ 4.2Х16 ШИР.ПЕР - 14.08 - na email korigiranata faktura
ГАЙКА М12 - DIN 934 - A2  - izprateni stokova i skladova razpiska lipsvashti na email
3000016119 - ВИНТ 8Х300 - ТХ - EVOLUTION izpratena na email lipsvashta razpiska s znak minus
3000016114 - БОЛТ М12Х35 - DIN 933 - K 10.9 - BL - lipsvashta stokova razpiska ot 28.07
ШПИЛКА - DIN 976 - М16Х1200 - 8.8 - ZN - aktualnot koliqestvo e 0
БОЛТ М5Х40 - КОЛАРСКИ - ima samo svobodna prodazba 50br ot 13.08 bez dokument
ВИНТ - 4.8Х20 /+2.5/ + шайба - метал - SW8 - 14.08  50br kato svobodna prodazba se dublirat, ima samo edna prodazba ot 50br
ВИНТ - САМОПР. - 5.5Х25 - ПОКРИВЕН - kasova prodazba ot 50br ot 13.08 lipsva
ВИНТ 4Х60 -  stokovata razpiska ot 17.08 e s znak minus 3000016234
ВИНТ 5Х100 - svobodna prodazba ot13.08 50 broja lipsva
ВИНТ 5Х120 -stokovata razpiska ot 17.08 - 3000016234 znaka e minus
ГАЙКА М5 - DIN 6923 - ФЛАНЦОВА -  stokovata ot 07.07 e s znak минус 3000016159 i lipsva kasova prodazba ot 13.08
ДЮБЕЛ - 6Х60 - ТУХЛА lipsva kasova prodazba ot 13.08 - 50br
```

| Manual finding | Digest section | Note |
|---|---|---|
| разписка „със знак минус" (3000016234, 3000016159, …) | FR-11.9 Корекции и отписвания | negative halves book as `adjustment` movements with markers |
| „актуалното количество е 0" (ШПИЛКА DIN 976) | FR-11.8 Наличности | point-in-time qty ≤ 0 scan |
| „свободна продажба … без документ" (БОЛТ М5Х40) | FR-11.10 Продажби без складов документ | sale with product+WH lines and no linked movement |
| „50бр … се дублират" (ВИНТ 4.8Х20) | FR-11.11 Съмнителни дублирания | same product+qty twice in a day, heuristic |
| „на email коригираната фактура" | FR-11.12 Редактирани след издаване (+ FR-10's per-invoice email action for the send itself) | audit `update` on issued docs |
| failed/late import batches behind several findings | FR-11.13 Импорти и имейли | BackgroundTask + EmailLog failures |
| „липсваща касова продажба от 13.08", „липсваща разписка от 28.07" (present in PlusMinus, absent in LGR) | **OUT OF SCOPE** | cross-system absence is undetectable from LGR data alone — remains the job of the `compare-products` / import skills; the digest reports what LGR *has*, the compare script what it *lacks* |

Odoo reference (user-supplied): digest emails configured under Settings → Digest Emails
(frequency, KPIs, recipients); Odoo's built-in servers impose daily send limits
(200/day paid) which LGR avoids by using its own SendGrid integration — digest volume is
`recipients × 1/day` and irrelevant to SendGrid quotas.
