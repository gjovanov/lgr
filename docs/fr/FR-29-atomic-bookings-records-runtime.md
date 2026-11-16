# FR-29 — Bookings that are all-or-nothing, records that always exist, and a server that says when it is degraded

| | |
|---|---|
| **Status** | Specified 2026-11-16. Nothing is built. The defaults in §9 stand unless the owner answers otherwise on the issue. |
| **Builds on** | The claim on a draft movement and the issue lease (#460, #462, #483), `movement-with-update.service` (the one booking that already runs in a transaction), FR-28 (`createdFrom.requestId` on orders), FR-20 (a new model declares its replication class), FR-27 (the access model), S-41 (a session ends when its person or membership does) |
| **Touches** | `services` (warehouse, costing, invoicing, events, audit log, identity, access, scheduler, background tasks), `invoicing-api` and `warehouse-api` (issue, receive, confirm, three creates), `db` (connection, `StockMovement`, `JournalEntry`, `AuditLog`, one new collection), `dal` and `dal-mongo` (a session reaches the writes), `invoicing-ui` and `inventory-ui` (a request id on three creates), `portal-api` (health, the scheduler's registrations) |
| **Tracking** | [gjovanov/lgr#794](https://github.com/gjovanov/lgr/issues/794) |
| **Code anchors** | origin/master `cb7d18c5` (2026-11-16), re-read at `cb039b1a`. Anchors, not gospel. |
| **Batch** | One of the four FRs of the 2026-11-16 audit: FR-29 (this one), [FR-30](FR-30-speed-at-shop-volume.md) speed, [FR-31](FR-31-forms-and-lists-that-do-not-lose-or-mislead.md) forms and lists, [FR-32](FR-32-code-health.md) code health. [`README.md`](README.md) maps every finding to its FR. |

## 0. The request (owner, 2026-11-16)

> identify what are the technical debts, code smells, performance bottle-necks and suboptimal UX aspects of the app and propose a solution to each of them

and, after reading the findings: create the FRs, grouped as much as makes sense.

**How the audit was done.** `cb7d18c5` was read, and then run on a throwaway local copy: an in-memory replica set, one API process, a real browser at 1366x768, and the seeded demo organization filled to about one shop-year (23 050 products, 46 120 stock levels, 10 020 invoices of 12 lines, 5 000 movements of 10 lines), with the database profiler on. Production was only read anonymously (its public sign-in page). The audit produced 53 findings.

**This FR** holds the eleven where the server can store half of a fact, lose a record it owes, or degrade without saying so. Each keeps the id it had in the audit.

**Evidence.** *reproduced*: made to happen on the local copy. *measured*. *read*: the code was read and the effect inferred. *counted*: a pattern count.

| Finding | In short | Evidence | Today | Requirements | Slice |
|---|---|---|---|---|---|
| R1 | A stock booking that fails midway keeps what it moved, and each retry moves it again | reproduced | §1.1 | FR-29.1 to .4, .6, .7 | A |
| P12 | A booking makes about three database round trips per line | read | §1.1 | FR-29.5 | A |
| R2 | An issue that failed midway succeeds on the retry with its stock half moved; a receive that fails after its status write has no retry | reproduced, read | §1.2 | FR-29.8 to .12 | B |
| R9 | Three creates carry no request id | read | §1.3 | FR-29.13 | C |
| R3 | A journal entry owed by an event can be lost | read | §1.4 | FR-29.14 to .18 | D |
| R4 | Audit rows without their content; no row for what the system did | reproduced, read | §1.5 | FR-29.19 to .21 | E |
| C7 | The audit entity search | read | §1.5 | FR-29.22 | E |
| R7 | A lookup that failed is remembered as an answer | read | §1.6 | FR-29.23 | F |
| R8 | Nothing checks that the declared indexes exist | read | §1.6 | FR-29.24, .25 | F |
| P13 | No query has a time limit | counted | §1.6 | FR-29.26 | F |
| T6 | State that lives in one process, with two pods | read | §1.6 | FR-29.27 to .30 | F |

**Where to look.** Slices A and B are one piece of work (B needs A's transaction). C, E and F are independent of them and of each other. D is cheapest after A and B, because it writes its row in their transaction.

## 1. What is wrong today

### 1.1 A stock booking is written line by line (R1, P12)

- `confirmMovement` (`services/src/biz/warehouse.service.ts`) claims the draft (`claimedUntil`, ten minutes), calls `adjustStock` once per line, and writes `status: 'completed'` after the loop. Nothing joins these writes: there is no transaction, no per-line marker, and no `finally` that releases the claim.
- `adjustStock` moves the level first and consumes cost layers afterwards. So the line that fails has already moved its own level.
- Reproduced on the demo organization: two articles at 100, a dispatch of 3 and 4, and line 2's article on a layered costing method with stock and no cost layer (the method was set directly in the database).

| Step | Answer | Levels | Movement |
|---|---|---|---|
| Confirm | 500, "No cost layers available for product *id* in warehouse *id*" | 97 / 96 | draft |
| Confirm again within ten minutes | 409, "is being confirmed or deleted right now" | 97 / 96 | draft |
| Confirm after the claim lapsed | 500 | 94 / 92 | draft |
| Confirm again | 500 | 91 / 88 | draft |

- On average costing, the default, nothing in the loop refuses. The trigger is then a database error or a process that stops in the middle of the loop: rare, and silent when it happens.
- The refusal is a 500 whose message names two database ids.
- **Round trips (P12).** Per line, the costing method is resolved by reading the product and then the organization (`getEffectiveCostingMethod`, `costing.service.ts`), before the level write and the layer writes. `stock-transfer.service.ts` reads one to five documents per line, and the count's completion does a find and an update per line (`inventory-count.controller.ts`).
- **Not read:** what the product form's costing switch does with stock on hand (whether it opens a layer). The reproduction does not depend on it.

### 1.2 Issuing and receiving are two sequences, and neither survives a failed booking (R2)

- **`/send`** takes the issue lease, books the stock, then writes the status. Its retry check is "a movement that carries this invoice's id exists", whatever that movement's status.
- Reproduced: Issue answers 400, the levels are already at 97 / 96 and a draft movement is left behind. Issue again answers 200: the invoice is `sent` and its movement is still a draft. That draft, confirmed later from the movements list, takes the levels to 94 / 92. The invoice's goods left twice.
- **`/receive`** moves the bill out of draft first, in one conditional write (so two Receives cannot both win), and books after. It pre-checks what it can foresee (`stockBookingRefusal`). A booking that fails for any other reason leaves a bill that is `received` with none or part of its stock, and no route retries it, because the bill is no longer a draft.
- The block that draws the issued number is written twice, once per route.

### 1.3 Three creates can happen twice (R9)

- The supplier order form, the customer order form and the movement form guard a second submit with a `saving` flag only. Their `POST` routes take no key.
- Invoices, payments and the till use `createIdempotentAction()`, and FR-28's one-click order routes are idempotent on `createdFrom.requestId` (a sparse unique index).
- A request repeated after a timeout whose first attempt did land creates a second draft.

### 1.4 A journal entry rides an in-process event (R3)

- `services/src/events/event-bus.ts` is a Node `EventEmitter`. Each handler runs inside `try { … } catch { logger.error(…) }`.
- Six places emit: `invoice.posted` and `payment.recorded` (`invoice.controller.ts`), `payment.recorded` (`cash-settlement.service.ts`, `cash-register/payment-receipt.service.ts`), `pos.session.closed` (`pos.controller.ts`), `stock.movement.confirmed` (`warehouse.service.ts`).
- The handlers say of themselves that they are not idempotent: they post whenever they are called (`events/handlers.ts`).
- Nothing stores that a posting is owed, nothing retries one, and no report lists documents that have no entry.
- So a handler that throws, or a process that stops between the state change and the handler, leaves an issued invoice, a payment, a completed movement or a closed session without its journal entry, and one log line.

### 1.5 The audit trail (R4, C7)

- **Content (R4 a).** `AuditLog.changes` is an array of `{ field, oldValue, newValue }`. Sixteen call sites pass an object such as `{ invoiceNumber: { from, to } }`. Mongoose casts it to one element with no fields.
  - Reproduced: issuing a draft stored `changes: [{ _id }]`.
  - By file: `reservation.controller.ts` 5, `order.controller.ts` 4, `invoice.controller.ts` 3, `internal-order.controller.ts` 3, `services/src/biz/doc-import/persist.ts` 1.
  - What is recorded without its content: the draft-to-issued number on issue and on receive; an order's confirm, cancel and convert; a reservation's cancel and pre-empt; an import's commit.
- **System entries (R4 b).** Five entries written by event handlers pass `userId: 'system'`. `auditDoc` (`audit-log.service.ts`) builds an ObjectId from it, which throws, and `createAuditEntry` swallows the error into `console.warn`. A journal entry created by a handler leaves no audit row. `backup-runner.service.ts` works around the same limit and says so in a comment.
- **Entity search (C7).** The audit page's entity search offers four entity types whose repositories do not exist (department, lead, deal, pipeline), so they return nothing. Its keyword does not go through the shared search builder (`buildSearchFilter`) that every other search uses.
- R4 a was found by a strict type-check, which this repository does not run ([FR-32](FR-32-code-health.md)).

### 1.6 The server degrades without saying so (R7, R8, P13, T6)

- **Lookups (R7).** `identityStillValid` (`services/src/biz/identity/session.service.ts`) treats a read that failed like a person who is gone, and remembers that for a minute. `membershipSwitchedOff`, next to it, does the opposite on purpose: "a lookup that fails must not sign people out". `accessModelOf` (`services/src/biz/access/shadow.ts`) remembers a failed read of the organization as the default model for a minute.
- **Indexes (R8).** `connectDB` (`db/src/connection.ts`) leaves `autoIndex` on, so Mongoose builds each schema's indexes in the background after connect. Nothing awaits the builds or reads their errors; one model (`FiscalPresence`) awaits its own. Several guards are unique indexes: a document's number, the digest's `{ orgId, date }` claim, a movement's number, FR-28's `requestId`. A unique index that cannot build over rows that already clash is simply absent, and the code that waits for a duplicate-key error never gets one.
- **Time limits (P13).** `maxTimeMS` is used nowhere in the backend. A slow list or report runs to its end on the single database member after its caller has gone.
- **Two pods (T6).**
  - `services/src/scheduler/registry.ts` runs each job on `setInterval` with no "still running" check: a tick slower than its interval overlaps itself. Every pod runs every job (twenty are registered in `portal-api/src/unified.ts`). Some claim their work in the database (the digest's unique index, a background task's owner); the registry does not say which.
  - `services/src/background/task.store.ts` is a `Map` that no production code empties.
  - A task's progress reaches only the sockets of the pod that runs it.
  - Limits that are counted in memory count per pod.
- **Observed, not explained.** Two anonymous loads of production's sign-in page painted after more than seven seconds while a rollout was under way; a controlled repeat after an idle gap was fast. It was not attributed, so it is not a finding. FR-29.31 measures instead of guessing.

## 2. Design

### 2.1 Terms

- **Booking**: the writes that make a movement's lines true: stock levels, cost layers, the movement's status.
- **Claim**: `claimedUntil` on a draft movement. **Lease**: the same idea on a document that is being issued.
- **Posting**: the journal entry that a business event owes. **Posting key**: `<event>:<source id>`, for example `invoice.posted:<invoice id>`.
- **Guard index**: a unique index that code relies on to refuse a second write.

### 2.2 One transaction per booking

- The booking runs inside `session.withTransaction`, as `movement-with-update.service` already does for its own writes. Production and every on-prem master run a replica set, and `setupTestDB()` has a replica-set mode.
- **How the session reaches the writes (D-1).** The repositories take no session today. Two ways:
  - an optional `session` in the options of the repository methods the booking uses, and of `moveLevel`, `consumeCostLayers` and `createCostLayers`, passed explicitly (the repository change is [FR-32](FR-32-code-health.md).14);
  - Mongoose's `transactionAsyncLocalStorage` (the installed `^8.9` has it), which hands the session to every Mongoose call made inside `connection.transaction()`. Raw driver calls stay outside it.
  - Default: the explicit parameter. It can be read in the code and does not depend on async context surviving every `await` under Bun. The second way is taken only after a probe in the production image.
- **An outer transaction is joined.** `confirmMovement(…, { session })` uses the caller's session and starts none of its own. Callers that are in a transaction themselves: the goods receipt with product update, and the issue service of §2.3.
- **Size (D-2).** A transaction keeps its writes in the database's cache until it commits, and has a time limit (60 s by default). Before slice A ships, a count-only read on production reports the largest movement by lines. If that size books comfortably in one transaction on the fixture, every movement books in one. Otherwise a movement above a limit books in chunks: each chunk is one transaction that applies its lines and advances `booking.cursor` on the movement; the movement cannot be edited or deleted while `booking` exists; a retry resumes at the cursor.
- **The claim** is released in a `finally` on every path that did not complete.
- **The event** leaves after the commit, never from inside the transaction.
- **Reads.** The organization's costing method is read once per booking and the products' methods in one query (`costsAt`, in the same file, is the pattern).
- **Refusals** are typed errors with a code (`no_cost_layer`, `insufficient_cost_layers`), answered 422 with the article's name and SKU and the warehouse's name. The confirm route maps them the way it maps `MovementClaimedError` today.

### 2.3 One issue service

- `issueDocument()` in `services/biz`, called by `/send` and by `/receive`.
- Order: today's checks and pre-checks; the lease; one transaction that holds the stock booking (joined, §2.2), the number (D-3), the status write and the owed posting (§2.5); release. After the commit: events, the audit entry, prices carried forward, the order sync.
- **A retry asks what the document needs and what it has.** Per warehouse, the movements the document needs are compared with the completed ones that carry its id. A completed one is kept. A draft left by an earlier attempt is finished, or removed and rebuilt, inside the transaction. It is never skipped.
- **The number (D-3)** is drawn last inside the transaction, so a failed issue draws none and the hold on the counter is short. Today `/send` draws after the booking and `/receive` before its claim (and accepts the gap in an internal series; its comment says why).

### 2.4 A request id on three creates

- `Order` and `InternalOrder` already have `createdFrom { source, requestId }` and its sparse unique index. The forms send `source: 'form'` and a fresh id per form instance.
- `StockMovement` gains an optional `requestId` and a partial unique index on `{ orgId, requestId }`.
- A repeated request answers with the document the first one made, in the create's own shape.
- A caller that sends no id behaves as today: the importers and the skills are not touched.

### 2.5 Postings that are neither lost nor doubled

- **A posting key on the entry.** `JournalEntry.postingKey`, with a partial unique index on `{ orgId, postingKey }` (the model's `importKey` index is the precedent). A handler that meets the duplicate treats the posting as done. Entries that exist today carry no key and are not touched.
- **An owed posting is a row (D-4).** `postingjobs { orgId, postingKey, event, payload, state: queued | done | failed, attempts, nextAttemptAt, lastError }`, unique on `{ orgId, postingKey }`, inserted in the same transaction as the state change that owes it. An organization that does not post owes nothing and gets no row (the handlers decide that today; the rule moves to one function both use).
- **Draining.** Right after the commit, the process tries the job itself, so the entry appears as fast as today. A scheduler job retries what is queued or failed, with a growing delay. Every pod may run it: the key decides. After a set number of attempts the job is `failed` and stays visible.
- **Visible (D-5).** The organization's accountant sees how many postings are owed or failed, and which. Health reports the count across organizations. The daily digest's operations section names them.
- **The event bus stays** for what is not a record: notifications, cache drops.
- **The past.** A read-only report lists, per organization that posts, the issued documents, payments, completed movements and closed sessions that have no entry. Public text about it says counts, never figures.

### 2.6 The audit trail

- `createAuditEntry` accepts `changes` as the array or as a map `{ field: { from, to } }`, and stores the array. The parameter is typed so that another shape does not compile once the type-check runs.
- An entry has an **actor**: a user, or the system with the name of the job or the event. `userId` is optional for the system. The audit page shows "System".
- **A failed write** is logged at error level through the structured logger with the module, the action, the entity type and its id, never values, and is counted for health. It does not fail the business action (D-6).
- The entity search offers only types it can search, and escapes its keyword.
- No row that exists is rewritten.

### 2.7 Lookups, start-up, limits, ticks

- **A lookup has three outcomes**: found, not there, failed. Only the first two are remembered. While it fails, the request is answered 503 (`lookup_unavailable`), which the SPA treats as "try again" and never as a sign-out. The rule lives with the shared session rules, so every auth plugin behaves alike.
- **Indexes.** After connect, every model's index build is awaited and each failure is logged with the model, the index and the reason, and shown in health. The guard indexes are listed in one place in `db`. Later, index builds move into `packages/migrations` and production runs with `autoIndex: false`.
- **Time limits.** One default for the queries of a request. Jobs, exports, backups and migrations name their own, higher one. A request that hits the limit answers 503 (`query_timeout`).
  - ⚠ Order: the lookups first. A time limit makes "the read failed" more frequent under load, and a lookup that remembers a failure would then turn load into sign-outs.
- **Ticks.** A job does not start while its previous run is still going in the same process. Each job says where it may run: on every pod, or on one, in which case it takes a lease document (`leaseUntil`, taken by a conditional update; the migration lock is the pattern).
- **The task store** forgets a finished task after a while; the `BackgroundTask` row stays the record. The document import's task route already falls back to it, and the others do the same.

## 3. Requirements

### 3.1 Stock booking (slice A)

**FR-29.1 — All or nothing (MUST).** After `confirmMovement` returns or throws, either every line's level change, every cost-layer change and `status: 'completed'` are stored, or none of them is. A failed confirm leaves the levels, the layers and the movement as they were before the call.

**FR-29.2 — The claim is released (MUST).** A confirm that did not complete clears `claimedUntil` before it answers. A second confirm right after gets the real refusal again, never "is being confirmed".

**FR-29.3 — The session reaches every write, and an outer one is joined (MUST).**
- Every write of a booking carries the transaction's session, the cost-layer writes included. A unit test fails on a write of the booking path that takes none.
- `confirmMovement`, called with a session, uses it and starts no transaction of its own.
- The goods receipt with product update keeps its atomicity: its test suite passes unmodified.

**FR-29.4 — Large movements (MUST).** The largest movement production holds, by lines, is read before the slice ships (a count, said as a count). The booking of a movement of that size is tested on the fixture. If it does not book comfortably inside one transaction, §2.2's chunks are built: no line is applied twice, a retry resumes at the cursor, and a movement that is partly booked cannot be edited, deleted or booked from a second request.

**FR-29.5 — Reads per booking, not per line (SHOULD).** A booking reads the organization's costing method once and the products' in one query. A test counts the reads of a 10-line and a 100-line movement: the count does not grow with the lines. The same for the transfer and for the count's completion.

**FR-29.6 — The refusal names the article and the warehouse (MUST).** A booking refused for its cost layers answers 422 with a `code`, the article's name and SKU and the warehouse's name, in the caller's language (FR-29.35). No database id is in a message a person reads.

**FR-29.7 — The event leaves after the commit (MUST).** `stock.movement.confirmed` is emitted once, after the booking is stored, and never for a booking that was rolled back.

### 3.2 Issue and receive (slice B)

**FR-29.8 — One issue service (MUST).** `/send` and `/receive` call one service that holds the sequence of §2.3. The number block exists once. The two routes keep their paths, their bodies and their refusal codes (FR-29.32).

**FR-29.9 — A retry finishes what an earlier attempt left (MUST).** A document is never `sent` or `received` while a movement that carries its id is a draft. A retry after a failed attempt ends with exactly the completed movements the document needs, and the levels moved once.

**FR-29.10 — A failed receive is not a received bill (MUST).** If the booking of a receive fails, the bill is the draft it was, with the number it had, and can be received again.

**FR-29.11 — The number is drawn last (SHOULD).** An issue that fails draws no number. Two issues at once in one organization both succeed, each with its own number (a test runs them together).

**FR-29.12 — What production holds today (MUST, before the slice ships).** A read-only count per organization of issued or received documents with a draft movement that carries their id, and of drafts with a completed one. It runs through the database connection without models, so nothing can be created. A non-zero count is reported to the owner privately, with the list; the public record says the count.

### 3.3 Creates (slice C)

**FR-29.13 — A request id on three creates (MUST).**
- `POST` of a supplier order, a customer order and a stock movement accept a request id (§2.4). The same id twice makes one document, and the second answer is the first document.
- An id used in one organization does not collide with the same id in another.
- A request without an id behaves as today.
- The three forms send one through `createIdempotentAction()`; a double click and a retry after a timeout make one document.

### 3.4 Postings (slice D)

**FR-29.14 — A posting key (MUST).** Every entry a handler creates carries its posting key, and the index of §2.5 refuses a second one. A handler called twice for one event leaves one entry. What counts as its own posting (a void's reversal, a payment, a session's close) is listed in the handler's file before the index is added.

**FR-29.15 — An owed posting is stored with the state change (MUST).** For the four events of §1.4, the row that says a posting is owed is written in the same transaction as the status change, the payment or the close. A process that stops right after the commit has lost nothing.

**FR-29.16 — Draining (MUST).** The posting is tried at once after the commit and retried by a scheduler job with a growing delay, up to a set number of attempts. A job that fails keeps its last error. Both pods may run the drain.

**FR-29.17 — Visible (MUST).** An accountant of the organization sees the owed and the failed postings, with the document each belongs to and a "try again" action. Health carries the count across organizations. A failed posting appears in the daily digest's operations section.

**FR-29.18 — What is missing today (SHOULD).** The read-only report of §2.5, run per organization, dry by default. It writes nothing. Posting what it lists is the accountant's decision and a separate run.

### 3.5 Audit trail (slice E)

**FR-29.19 — One shape for `changes` (MUST).** Each of the sixteen call sites of §1.5 stores the fields it names with their old and new values. The parameter's type refuses any other shape. A test performs each of those actions and reads the row back.

**FR-29.20 — A system actor (MUST).** An entry written by a handler or a job is stored, with the system as its actor and the job or event named. The five handler entries of §1.5 exist after their events. The audit page, and any export that lists audit rows, shows such a row with "System" where a person's name would be.

**FR-29.21 — A failed audit write is loud (MUST).** It is logged at error level with what was being recorded (no values), and counted in health. The action it belongs to still succeeds (D-6).

**FR-29.22 — The entity search (MUST).** Every entity type the audit page offers returns matches, or is not offered. The keyword is escaped by the function the other searches use. A keyword made of pattern characters returns the rows that contain those characters and nothing else.

### 3.6 Runtime (slice F)

**FR-29.23 — A lookup that fails is not an answer (MUST).**
- `identityStillValid` and `accessModelOf` tell "not there" from "the read failed". A failed read is never remembered.
- While the read fails, the request is answered 503 with `lookup_unavailable`. The SPA shows "try again" and keeps the session.
- "Not there" and "inactive" end the session exactly as today, and a positive answer is remembered exactly as long as today: nothing here lengthens a session.
- Tests: a read that throws once, then succeeds, costs one 503 and no sign-out; a person who is gone is signed out; both lookups.

**FR-29.24 — Declared indexes are verified (MUST).** After connect, the server awaits every model's index build and reports each failure (model, index, reason) in the log and in `/api/health`. A test plants two rows that clash, declares the unique index, and reads the failure in health.

**FR-29.25 — Guard indexes (SHOULD).** The unique indexes that code relies on are listed in one file in `db`, with what each guards. A missing one is reported apart from the others, to the system administrator as well (D-7). Index builds move to `packages/migrations`, and production then runs with `autoIndex: false`.

**FR-29.26 — Query time limits (MUST, after FR-29.23).** The queries of a request have a default time limit (D-8), aggregations and raw driver calls included. A job, an export, a backup and a migration set their own. A request that hits the limit answers 503 with `query_timeout`, and the log names the route and the shape of the filter, never its values.

**FR-29.27 — A tick does not overlap itself, and says where it may run (MUST).**
- The registry does not start a job whose previous run in this process has not finished, and logs the skip.
- Every job definition states `every-pod` or `one`. A `one` job runs under a lease. The table of the twenty jobs is part of the PR, with the reason for each.

**FR-29.28 — The task store is bounded (MUST).** A finished task leaves the in-memory store after a set time. Its route still answers from the `BackgroundTask` row.

**FR-29.29 — Limits hold across pods (SHOULD).** A limit that protects an endpoint anyone can call is counted in the database, as the sign-in throttle is, or its threshold is documented as per pod. The files that keep such counters in memory are listed when this is built.

**FR-29.30 — Task progress on either pod (MAY).** A task's progress reaches its user's socket whichever pod holds it.

**FR-29.31 — The first request after a rollout (SHOULD).** The first request to each new pod is timed from outside after a rollout. If it takes longer than two seconds, readiness waits for the warm-up that `unified.ts` already runs.

### 3.7 Across this FR

**FR-29.32 — Contracts that do not move (MUST).**
- `POST /org/:orgId/invoices` (with `skipStockMovement` and `allowNegativeStock`), `POST /org/:orgId/bills/import/{extract,draft,convert}`, `POST /warehouse/movement`, `/warehouse/movement/with-update` and `/warehouse/movement/:id/confirm`: paths, bodies and answers. The importers and the skills drive them.
- `/invoices/:id/send` and `/receive`: bodies, answers and today's refusal codes (`bill_not_draft`, the claimed-document refusal, the overlap refusals).
- The one answer that changes on purpose: a cost-layer refusal is a 422 with a code where it was a 500.

**FR-29.33 — Guards stay green (MUST).** The tenant-isolation, route-permission and read-permission suites pass unmodified. A new model declares its replication class and `unit/replication-meta.test.ts` passes. The PR that adds a collection says what an on-prem master older than the hub does with it.

**FR-29.34 — No business data (MUST).** Tests, fixtures and this spec use the seeded demo organizations. Anything written to the issue or a PR says "equal", "unchanged" or a count.

**FR-29.35 — Four languages (MUST).** Every new message exists in `en`, `bg`, `de` and `mk`.

**FR-29.36 — Windows (MUST).** No new test uses `.rejects` or `.resolves` (`helpers/capture-rejection.ts`).

## 4. Migration

| What | Change | Procedure |
|---|---|---|
| `StockMovement.requestId` | optional field, partial unique index | Existing rows carry none. The index builds at once |
| `StockMovement.booking` | optional sub-document, only if FR-29.4 needs chunks | Absent on every existing row |
| `JournalEntry.postingKey` | optional field, partial unique index | Existing entries carry none and are not backfilled, so the index cannot clash |
| `postingjobs` | new collection | Declares its replication class. Empty at start |
| `AuditLog` | an actor field; `userId` optional | Existing rows are read as a user's. No row is rewritten |
| Documents with a draft movement | none | Counted first (FR-29.12). A repair is the owner's decision |
| Entries that were never posted | none | Reported (FR-29.18) |
| Index verification | none | Its first run on production may report indexes that never built. Each is looked at before anything is changed |

## 5. Slices, dependencies and rollback

| Slice | Ships | Visible change | Exit |
|---|---|---|---|
| A | FR-29.1 to .7 | a refused booking names the article; nothing else | the atomic-booking tests; the receipt, transfer, count and till suites unmodified |
| B | FR-29.8 to .12 | none on the happy path | the issue-retry tests; the count of FR-29.12 reported |
| C | FR-29.13 | none | the request-id tests |
| D | FR-29.14 to .18 | the accountant sees owed postings | the exactly-once tests |
| E | FR-29.19 to .22 | audit rows show what changed; "System" rows | the audit-shape tests |
| F | FR-29.23 to .31 | health says more | the lookup, index and registry tests |

**Order.** A, then B, then D. C, E and F at any time; inside F, FR-29.23 before FR-29.26.

**Rollback.** A and B: revert the PR; the claim, the lease and the per-line writes return as they were, and no stored data depends on the transaction. C: revert; the index is harmless. D: revert the drain and the insert; entries posted with a key stay valid. E: revert; rows written with an actor are read by the old code as rows without a user. F: each requirement is its own switch or its own revert.

**Risks.**
- *A transaction that is too large.* FR-29.4 measures before choosing.
- *A write of the booking that misses the session* would commit outside the transaction. FR-29.3's test.
- *Contention on the number counter.* The number is drawn last (FR-29.11), and two issues at once are tested.
- *A posting made twice.* The key, not the drain's care, prevents it.
- *A time limit that cuts a legitimate long read.* Jobs and exports name their own, and the first deploy logs what would have been cut before it cuts.
- *An on-prem master older than the hub.* FR-29.33.

## 6. Tests

- **Booking** (`movement-confirm-atomic.flow`): a failing line, forced by the layered-method fixture of §1.1 and by a repository that throws on its Nth write, leaves levels, layers and movement as before; the claim is free; a second confirm gets the same refusal; the event was not emitted. The happy path of a receipt, a dispatch, a transfer and an adjustment is unchanged. A joined outer transaction rolls both back. If chunks exist: a stop between chunks, then a retry, applies every line once.
- **Issue** (`invoice-issue-retry.flow`): a failed `/send` followed by a retry ends with one completed movement per warehouse and the levels moved once. A draft movement left by the old code is finished, not skipped. A failed `/receive` leaves a draft bill. Two issues at once get two numbers.
- **Creates** (`create-request-id.flow`): the three routes, the same id twice, another organization, no id.
- **Postings** (`posting-exactly-once.flow`): a handler that throws once is retried and leaves one entry; a handler that never ran is drained; an event emitted twice leaves one entry; an organization that does not post owes nothing; a job that keeps failing is listed.
- **Audit** (`audit-entry-shape.flow`): the sixteen actions, the five system entries, a write that fails.
- **Lookups** (unit): §3.6's cases for both lookups.
- **Indexes** (`index-verification.flow`), **registry** (unit: a slow tick, a `one` job on two registries).
- **Guards, unmodified**: `tenant-isolation.flow`, `route-permission.flow`, `read-permission.flow`, `bill-with-update.flow`, `invoice-stock-validation.flow`, `order-reservations.flow`, `internal-order.flow`, `pos-transaction.flow`, `unit/replication-meta.test.ts`.

## 7. Acceptance criteria

1. The four steps of §1.1's table, run again, leave the levels at 100 / 100 after every step, and every step answers the same 422 that names the article.
2. §1.2's sequence ends with the invoice issued, one completed movement and the levels at 97 / 96.
3. A double submit of each of the three forms makes one document.
4. With a handler made to throw once, an issued invoice has one journal entry a moment later, and the accountant's list was not empty in between.
5. Issuing a draft stores an audit row whose changes name the number. The journal entry made for it has a "System" row.
6. A read of the person or of the organization that fails costs the caller a 503, not the session.
7. Health lists the indexes that did not build, and none is listed on the fixture.
8. The existing suites pass unmodified. `bun run test`, `bun run build` and CI are green.
9. No test, fixture, comment or PR carries a customer's name or figure.

## 8. Field test (production, after each slice; the demo organization, never a customer's)

1. **Slice A.** Confirm a receipt, a dispatch and a transfer of several lines; compare the levels and the valuation before and after. Confirm one movement from two tabs at once: one books, the other is told. If the product form offers a layered costing method, switch an article that has stock and dispatch it on the second line of a movement: the refusal names it and the first line's level is unchanged. Otherwise the failure path rests on the tests.
2. **Slice B.** Issue an invoice and press Issue twice quickly; receive a bill the same way. One movement per warehouse, the levels moved once.
3. **Slice C.** Double-click Save on a new supplier order, a new customer order and a new movement: one of each.
4. **Slice D.** Issue an invoice and record a payment: one entry each, and the list of owed postings is empty.
5. **Slice E.** Open the audit page: the issue shows the number change, and the entry's own row says "System".
6. **Slice F.** Read `/api/health`. Time the first request to each pod after the rollout.
7. **Clean up.** Void or delete every document and movement the test made, and report the count left (0) and how it was checked.

## 9. Decisions (defaults stand unless the owner answers otherwise)

| | Question | Default |
|---|---|---|
| D-1 | How does the session reach the writes? | An explicit parameter. Async context only after a probe in the production image |
| D-2 | One transaction, or chunks? | One, if the largest movement production holds books comfortably on the fixture. Chunks with a cursor above that size |
| D-3 | When is the issued number drawn? | Last, inside the transaction, so a failed issue draws none |
| D-4 | Where is an owed posting stored? | Its own collection. The alternative is a field on the source document, which needs no new collection and no transaction, and scatters the drain over four collections |
| D-5 | Where does the accountant see owed postings? | Accounting, on the journal entries page: a banner with the count and a filter |
| D-6 | Does a failed audit write fail the action? | No. It is logged and counted. The alternative, for fiscal actions only, is to refuse the action |
| D-7 | What happens when a guard index is missing? | The server starts, health and the administrator's page say so, and a mail goes to the system administrator. It does not refuse to start: a single on-prem master that will not start is an outage, and the guard was missing before too |
| D-8 | The default time limit of a request's queries | 20 seconds, logged only for the first week |

## 10. Not in this FR

- Re-posting after an edit of a posted document. `CLAUDE.md` records that an edit does not re-post; that is a decision of its own.
- Whether a received bill owes a journal entry. The service keeps what each route does today.
- Correcting the past: stock that moved twice, entries that were never posted, audit rows stored without their content. This FR counts and lists them.
- Replacing the event bus with a broker, or the scheduler with a queue.
- The fiscal device flow, and what a fiscal receipt owes.
- A second database member.

## 11. Build log

Nothing is built yet.
