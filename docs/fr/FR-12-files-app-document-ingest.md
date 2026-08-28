# FR-12 — Files app: in-app document ingest (upload → OCR → analyze → commit → reconcile)

**Goal:** Turn the CLI-only PlusMinus→LGR migration ingest into an in-app, audited, idempotent,
PV-backed workflow. Drop a day's exports into the **Files** app (#7, `/files/`), and from the
browser: version + store them, OCR the PDFs, analyze them against the catalog, review the result,
and **commit in bulk** — the same tested `doc-import` engine the CLI skills use, no new booking
logic. GitHub issue: **[#23](https://github.com/gjovanov/lgr/issues/23)**.

Status: Phases 1–3 shipped (deploy `v20260827-e3626c177f89`); **this FR adds the batch layer
(§4)** · Date: 2026-08-28 · Depends on: the `doc-import` engine, the OCR sidecar, the background-job
model (`task.service`/`BackgroundTask`), the `lgr-uploads` PV · Feeds: nothing.

Driving input: goran's 2026-08-28 request — "we need batch analyze and batch commit (with selection
of analyzed docs); in /files/documents a grouping/viewing option by date; warnings need a revision
and confirmation that can be committed; batch should be performant (not N+1)."

---

## 1. What already exists (Phases 1–3, on master)

- **Store** — `DocFile` (unique `{orgId, docType, docNumber}` = idempotency key); files on the PV at
  `/app/uploads/<orgId>/docs/<date>/`, prior copies archived to `versions/`, every write → `AuditLog`.
- **Pipeline** — per-document `POST /:id/{ocr,analyze,commit,reconcile}` as **background jobs**
  (the sidecar `/draft` is ~50s, past the front-proxy read timeout), each `{taskId}` + `GET /task/:id`
  polling. `doc-pipeline.service` wraps `analyzeDocuments`/`commitDocuments`; `doc-reconcile.service`
  is the idempotent create/update/delete for a re-uploaded movement doc.
- **UI** — `FileUploadView` (batch upload + per-row Analyze/Commit/Reconcile), `DocumentsView`
  (browse/filter/download), `UploadAuditView`. `FilesHubView` card grid.
- Gate: `admin.settings`. Detection fallback (`AnalyzeItem.kind`) rescues fragmented landscape titles.

## 2. Problem this FR solves

Committing a day means clicking Analyze then Commit on **~30 documents one at a time**, each a
separate job and a separate ~50s wait, with no way to see the whole day's warnings before booking.
`DocumentsView` is a flat paginated table with no selection and no per-day rollup.

## 3. Acceptance criteria

1. **Selection** — checkboxes in `DocumentsView` (both views); a batch action bar shows the count and
   the batch actions. Selection survives view/filter changes within a session.
2. **Batch analyze** — analyze the selected documents in **one** job (not N calls); progress reported
   `done/total`. Already-analyzed docs are **reused** (no re-draft) unless *Re-analyze* is ticked.
3. **Warnings review + confirmation** — after analyze, a review step lists every analyzed document
   with its kind, matched/total lines, **warnings** and **duplicate** flag; the user selects which to
   commit (clean+fully-matched pre-selected, duplicates/errors excluded but overridable) and confirms.
4. **Batch commit** — commit the confirmed selection in **one** job; per-document result (booked
   number / error); partial success is reported, not fatal.
5. **By-date grouping** — a *By date* view in `DocumentsView`: one expandable group per `docDate` with
   a count + status breakdown; expanding lists that date's documents; a group checkbox selects the day.
6. **Performance (no N+1)** — the batch endpoints do ONE `$in` load, resolve the warehouse ONCE,
   persist via ONE `bulkWrite`, and run the sidecar-bound analyze phase at bounded concurrency
   (4-way — the sidecar spawns async, so `/draft` calls overlap; same limit `/extract` uses). The
   per-date rollup is ONE aggregation. Commit runs serially (stock-safe) but is sidecar-free (fast).

## 4. Implementation

**Backend** (`services/biz/files/`):
- `doc-pipeline.service`: extracted helpers (`resolveDefaultWarehouseId`, `buildAnalyzeItem`,
  `analysisRecord`, `docSummary`, `commitItemFor`, `stampCommitted`) shared by the single + batch
  paths. New `analyzeDocFilesBatch(orgId, userId, ids, {force}, onProgress)` — `$in` load, warehouse
  once, per-doc analyze via `mapWithConcurrency(_, 4, …)`, one `bulkWrite`; returns a compact
  `docSummary[]` (matched/total, warnings, duplicate, `committable`, `recommended`). New
  `commitDocFilesBatch(orgId, userId, ids, opts, onProgress)` — serial commit, one `bulkWrite` of the
  stamps; per-doc result. Reuse: a doc whose status ≠ `uploaded` with a stored `analysis.mapped`
  returns `{reused:true}` instead of re-drafting.
- `doc-store.service`: `listDatesSummary(orgId, filters)` — one `$group` aggregation (orgId matched
  explicitly as an ObjectId, since `aggregate()` bypasses the tenant plugin).
- Controller: `POST /files/analyze-batch` + `POST /files/commit-batch` (both jobs, `MAX_BATCH` 60),
  `GET /files/dates`. Same `admin.settings` gate.

**Frontend** (`DocumentsView.vue`):
- View toggle Table ⇄ By date; a unified `selected` set drives both. Batch action bar (Analyze +
  *Re-analyze*, progress bar). By-date = `v-expansion-panels` fed by `/dates`, lazy-loading each day's
  docs on expand, with a per-day select checkbox.
- Review dialog: per-doc table with a commit checkbox (recommended pre-checked, non-committable
  disabled), warnings/duplicate/error inline, summary chips; commit options (*Move stock*, *Allow
  duplicates*); the reviewed selection posts to `/commit-batch`.
- Shared `runJob()` poller reads `task.progress`. i18n ×4 (`files.batch.*`, `files.status.*`,
  `files.review.*`, `files.col.{kind,matched}`).

**Tests** — `integration/doc-batch.flow.test.ts` (batch analyze+commit via sidecar-free
storeOperations xlsx; reuse-unless-forced + progress; non-analyzable → per-doc error, not a batch
failure). The Phase-3 suites (`doc-reconcile`, `doc-store`, `compare-snapshot`, `doc-import`) stay
green after the pipeline refactor.

## 5. Notes / non-goals

- The sidecar is the floor: analyzing N *new* documents is ≈ `N/4 × draft-latency`. Reusing prior
  analyses and skipping re-OCR is the real win; a batch `/draft` endpoint on the sidecar would help
  further (future). **Do not remove the concurrency cap** — an unbounded fan-out would swamp the
  single sidecar replica.
- Batch commit is serial by design: concurrent `confirmMovement`s on the same product would race the
  `StockLevel` read-modify-write.
- `desktop-ui` parity for the Files app remains deferred (as in Phase 3).
