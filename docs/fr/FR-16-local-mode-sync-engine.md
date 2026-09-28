# FR-16 — Local mode: SQLite data plane and the hub ↔ desktop sync engine

**Goal:** an LGR Desktop keeps working when the cloud is unreachable. It serves a defined part
of the product from a **local SQLite copy** of its org's data, and it syncs **two-way** with
the cloud. Changes made on the hub reach the desktop. Changes made offline reach the hub and,
through it, the org's other desktops.

The engine is modelled on PCON+'s hub/spoke sync (`g-rox/pcon` → `docs/Sync_Architecture.md`,
branch `dev`): change capture on both sides, echo suppression by markers, routing by class,
exactly-once batches, dead letters, logged conflicts, fenced reconcile and a drift check. The
one difference is on the hub, where a **MongoDB change stream over the oplog** takes the place
of SQL Server CDC. The architecture reference is the rewritten
[`docs/architecture/sync.md`](../architecture/sync.md). This FR is the requirements and the
acceptance.

Status: draft for implementation · Date: 2026-09-28 · Depends on: [FR-15](FR-15-desktop-registration.md)
(desktop identity and credentials), [FR-14](FR-14-lgr-desktop-app-server-mode.md) (the shell
that hosts the sidecar and the native fiscal bridge) · Feeds: [FR-17](FR-17-sync-page.md)
(Sync page), [FR-18](FR-18-desktop-tests-field-automation.md) (tests and field automation).

Driving input: goran's request of 2026-09-28:

> *"LGR desktop should have two modes: 1. working with the server similar like roomler-desktop
> has "Open Roomler" from "Overview" page and 2. working with local data - sqllite and synced
> data (the sync.md might need to be adjusted or improved - similar to sync in
> https://github.com/g-rox/pcon/blob/dev/docs/Sync_Architecture.md without cdc with mongodb
> oplog). Each LGR desktop should be registered as device/desktop within the org. With an Sync
> page for the Org and all devices/desktops. With integration/e2e tests and automated field
> testing"*

This FR covers **mode 2** and the sync engine. Mode 1 is FR-14, registration is FR-15, the Sync
page is FR-17, and the tests are FR-18. "Without CDC, with MongoDB oplog" is read as: *PCON+'s
hub-side CDC becomes a change stream over the replica-set oplog.* The oplog is the only capture
mechanism that sees every write. §2 records the measurements behind that choice and the two
alternatives it beats.

---

## 1. Current state (verified 2026-09-28, master @ `81b5fe5`)

Every fact below was read from the code or queried against production on that date. The
desktop is a **March 2026 prototype that the product has since outgrown**. Reviving it is mostly
rebuilding it on the foundations it already has: Tauri, the DAL seam, the archive code.

### 1.1 The local data plane covers the product as it was in March

- **The DAL.** `packages/dal/src/registry.ts:18-80` declares **48** repositories.
  - `dal-mongo` wires all 48.
  - `dal-sqlite` (`src/index.ts:86-143`) wires **41**. Seven keys are `undefined` at runtime:
    journals, paymentTerms, fiscalPositions, stockLocations, operationTypes, stockLots and
    posPaymentMethods.
  - Two more are wired to tables that do not exist: `fiscal_devices` and `workstations`
    (`schema/erp.schema.ts` defines four POS tables, and neither of these is one).
  - That leaves **39 working SQLite entities for 60 Mongoose models. 21 models have no working
    local table.** Among them are Order, InternalOrder, Reservation, Sequence, FiscalDevice and
    Workstation.
- **Schema drift.** The tables were re-modelled by hand (72 tables, migrations v1 to v5,
  `migrations/runner.ts`, the last one on 2026-04-21), and nothing tracks the Mongoose schemas:
  - The SQLite Invoice lacks **17** fields: `statusHistory`, `paymentMethod`, `orderId`,
    `internalOrderId`, `draftNumber`, `certificateNumber`, `numberHistory` and more.
  - Its lines lack **9** (`orderId`, `reservationId`, `allocationId`, …).
  - POSSession lacks at least **11** (`fiscalStatus`, `zReportNumber`, `closingBreakdown`,
    `fiscalDeviceId`, …).
  - **No table has `deactivated_at`.** The SQLite repository writes every field as a column
    (`base.repository.ts:82-89,133-137`), so the five controllers that soft-delete (contact,
    price-list, product, warehouse, employee) fail on it.
- **`create()` discards the caller's id and timestamps** (`base.repository.ts:72-74`,
  `crypto.randomUUID()`). A sync applier cannot write a row under its hub id at all.
- **Query support.** `aggregate()` throws (`base.repository.ts:187-191`). `$regex` becomes
  `LIKE`, and dotted paths are unsupported (`filter-translator.ts:53`).
- **Parity tests.** `packages/tests/src/dal/parity/` holds **70** cases in 9 files: CRUD only,
  covering 9 of the 48 repositories. `docs/architecture/dal.md` says 132.

### 1.2 Most of the business logic cannot run on SQLite

- **Services.** `packages/services` has 133 files. 80 of them (60 %) import `db`/`mongoose`
  directly, and 24 use the DAL.
  - Of the 35 top-level `biz/*.service.ts` files, 12 are DAL-only, 3 are mixed and **18 are
    Mongoose-only**. The Mongoose-only ones include `sequence`, `invoice-numbering`,
    `reservation`, `reservation-ops`, `product-ledger`, `invoice-with-update`,
    `movement-with-update` and `auth`.
  - Every subsystem added since April (archive, backup, digest, doc-import, files, reports,
    retention) has **zero DAL-only files**.
  - `services/dao/*` (29 files) is all Mongoose.
  - 29 controller files import Mongoose models directly.
- **What the desktop mounts.** `desktop-api` mounts 27 domain controllers.
  - **22 work through the DAL**, apart from auditing.
  - **3 are broken in their core flow**:
    - invoice: numbering goes through the Mongoose `Sequence` model (`sequence.service.ts:11-160`,
      called at `invoice.controller.ts:447-451,839`);
    - pos: POSSession through `db/models`, `Sequence`, `orgDao`, and a `fiscalDevices`
      repository with no table;
    - product-ledger.
  - **2 are partly broken**: contact and movement.
  - Mongoose 8.24 **buffers** a command for 10 s when nothing is connected, then fails. So these
    paths hang first and error afterwards.
- **Auditing is lost without a trace.** 23 of the mounted controllers call `createAuditEntry`,
  which writes through Mongoose (`audit-log.service.ts:51-74`). On a UUID id,
  `new Types.ObjectId(uuid)` throws, the error is swallowed, and **no audit entry is ever
  written**. An `audit_logs` table sits right there, unused.

### 1.3 The sync package is a LAN prototype that nothing imports

`packages/sync` has 20 files and 2,380 lines, from one commit (`080ae4c`, 2026-03-07). Nothing
imports it, and `desktop-api` does not even list it as a dependency. What it contains:

- **Transport.** A peer-to-peer WebSocket server on `0.0.0.0:/sync`, checking nothing except
  that `orgId` matches (`ws-server.ts:31-44,78-83`). Discovery is an **unauthenticated UDP
  broadcast** on port 41234 every 5 s.
- **Triggers.** `withTriggersDisabled` drops every trigger around each apply and reinstalls it
  afterwards. The trigger list (`table-registry.ts`) has 79 entries, **23 of which no longer
  exist**, and it misses 10 live tables. `installTriggers` is never called; it would fail on
  the first missing table.
- **Migration.** `mongo-to-sqlite` / `sqlite-to-mongo` with an `_id_map` is broken in both
  directions:
  - both backends' `create()` discard the mapped id;
  - the FK maps are snake_case against camelCase entities;
  - nested lines are never remapped.
- **No tests, and no cloud side at all.** There is no `.watch()` anywhere in the repo, and no sync
  controller in `portal-api`.

`docs/architecture/sync.md` §12 records why each piece is replaced rather than repaired.

### 1.4 The hub side: a change feed exists, nobody consumes it

- **Oplog.** Production runs `mongo:7` as a single-node replica set `rs0`
  (`statefulset.apps/mongodb 1/1`). The API is `deployment.apps/lgr 1/1` and connects as
  `lgr_admin` (`authSource=admin&replicaSet=rs0&directConnection=true`), queried 2026-09-28. The
  oplog is **3,544 MB and holds 134.8 days** (FR-13 §1.3).
- **Who reads it today.** Only FR-13's Layer-1 delta, and that runs from `lgr-deploy` scripts,
  not from the application.
- **Tests.** `packages/tests/src/setup.ts` already starts `MongoMemoryReplSet` (count 1) for
  transactions, so change streams work in the suite **as it is**.
- **Writes that bypass middleware.** Excluding tests, the application and `scripts/` contain
  **15 `bulkWrite`, 16 `updateMany`, 8 `insertMany`, 14 `deleteMany` and 4 raw `collection.*`
  write sites**. Add the ops scripts run in the pod and any hand fix made in `mongosh`.
- **Why `updatedAt` is no substitute.** FR-13 §3.4 measured an `updatedAt` window at **81 % of
  regal-pz over 7 days**, because the catalog scripts rewrite every product. It also cannot see
  deletes.

### 1.5 Numbering assumes a single allocator

- **Counters.** `getNextNumber()` is an atomic `$inc` on `Sequence` (`sequence.service.ts:11-27`).
- **`getNextInvoiceNumber()`** first calls `currentMaxSuffix()`
  (`invoice-numbering.service.ts:86-117`), which regex-scans **every** invoice of the series and
  pulls the counter up to the highest suffix found. A desktop-issued number from a reserved range
  would therefore drag the hub counter into, or past, that range.
- **POS stock movements** are numbered "latest `SM-<year>-NNNNN` + 1" with a retry on duplicates
  (CLAUDE.md, fixed 2026-09-26). That is the same hazard.
- **УНП** is per fiscal device and operator (`generateUNP`, `sequence.service.ts:67-92`,
  `year: 0`), so it is already partitioned the way offline selling needs.

### 1.6 Derived state and the event handlers

`services/src/events/handlers.ts` registers four handlers, all through the DAL:

- `invoice.posted` → JE,
- `payment.recorded` → JE,
- `stock.movement.confirmed` → valuation JE,
- `pos.session.closed` → batch dispatch record + JE.

⚠ **Three of the four handlers have no idempotency guard.**
- `invoice.posted` creates a JE every time it runs (`handlers.ts:25-80`).
- So does `stock.movement.confirmed` (`:145-172`).
- `payment.recorded` (`:83-142`) also stamps the new JE onto *the last* `payments[]` element and
  rewrites the whole array (`:113-114`).

Only the POS handler checks (`session.journalEntryId`, `:183`).

⚠ **`confirmMovement` is not reusable for an already-completed movement.** It refuses anything
that is not a draft (`warehouse.service.ts:13`) and emits `stock.movement.confirmed` itself
(`:64`). The stock arithmetic underneath it, `adjustStock` (`:79-125`), is a read-modify-write
with no session.

⚠ **The POS session-close batch dispatch bypasses `confirmMovement`.** It is created already
`completed` through `repos.stockMovements.create` (`auto-journal.service.ts`,
`createPOSSessionJournalEntry`). A completed movement therefore exists that never moved
StockLevel. **StockLevel cannot be recomputed from movement history.**

---

## 2. Decisions

| # | Decision | Rejected alternatives, and why |
|---|---|---|
| **D-1** | **Hub change capture is a change stream over the oplog**, consumed by one tailer into a per-document journal (`sync.md` §2.1). | *`updatedAt` query:* 81 % of the org per week, blind to deletes (§1.4). *Mongoose middleware / application outbox:* 57 known write sites bypass it, and so does every ops script and hand fix. A sync that misses writes diverges silently, which is the worst failure available. |
| **D-2** | **The desktop stores documents as JSON**: one table per collection with `id`, `org_id`, `doc`, `hub_seq`, plus generated columns for indexed paths (`sync.md` §9). | *Extending the relational `dal-sqlite` schema:* that re-model is exactly where the drift in §1.1 lived. A JSON document keeps fields the desktop does not know, so an old desktop cannot erase a new hub field, and dotted paths work. |
| **D-3** | **Hub-and-spoke only.** | *LAN peer-to-peer* (the prototype): no single truth, no credentials, and conflicts multiply per pair. A LAN relay MAY come back later as a *transport* to the hub, never as a peer protocol. |
| **D-4** | **ObjectIds on both sides**, generated locally on the desktop. | *UUID + `_id_map`:* broken today (§1.3), and it would need a remapping pass on every pushed row, nested ids included. |
| **D-5** | **Local mode runs the same service code over the DAL, for an explicit offline route manifest** (FR-16.8). Everything else is server-only in local mode. | *Port everything:* 60 % of services are Mongoose-only, and every new subsystem is. Chasing full parity is what killed the prototype. *Embedded `mongod` sidecar:* +~150 MB, a second database engine to operate on every till, and not what was asked. *Command replay to the cloud API:* one bespoke replay handler per offline feature, and a replayed sale that fails validation still has a fiscal receipt in the customer's hand. The hub has to accept it, which turns "replay" back into row sync. |
| **D-6** | **Accounting and derived state are computed on the hub only**, as projections after each push. The desktop shows an overlay (`sync.md` §5.4–5.5). | *Both sides compute:* every offline sale would book two JEs. *"Additive merge" of stock levels* (the prototype): merges derived state as if it were a fact. |
| **D-7** | **Legal numbers come from admin-confirmed bands. Internal numbers carry a desktop infix.** | *Hub-leased small blocks:* abandoned blocks leave gaps in a legal series. *Assigning numbers on sync:* an invoice or receipt printed offline already carries its number. |
| **D-8** | **Sync is opt-in per org** (`sync_orgs.enabled`). | *On for every org:* 73 of the 80 production orgs are `e2e-*` tenants (FR-13 §1.4). |

---

## 3. Requirements

### 3.1 The local data plane

**FR-16.1 — One SQLite file per org profile.**
- **Location:** `<local app data>/profiles/<orgSlug>/lgr.db`, with WAL and `synchronous=NORMAL`.
  - **Windows:** `%LOCALAPPDATA%`, never the roaming profile. The shell uses Tauri's
    `app_local_data_dir()`. Today it uses `app_data_dir()` (`sidecar.rs:30`,
    `archive.rs:24,85,151`), which on Windows is **Roaming** AppData.
  - **Roaming profiles and folder redirection** would put a WAL database on a network share,
    where SQLite's WAL is unsafe. Two PCs would also share one database. The shell MUST refuse
    to open a profile database on a network or redirected path.
- **Schema:** document tables per `sync.md` §9, created and migrated from the generated sync
  metadata (FR-16.24). Local schema migrations are forward-only, recorded in `_migrations`, and
  run inside a transaction before the API starts.
- **Legacy files:** a `lgr.db` in the pre-FR-16 relational format is **not** migrated. No
  installation holds production data in it: the three releases are 2026-03 prototypes that boot
  into a demo org (FR-14 §1). The shell MUST move such a file aside (`lgr.db.prototype-<date>`),
  never open it.

**FR-16.2 — A generic document repository replaces the per-entity SQLite repositories.**
- **Contract:** it implements the unchanged `IRepository` / `IBatchRepository` interfaces over
  `json_extract` on `doc`, with generated columns and indexes where the metadata declares them.
- **Filters:** `$eq/$ne/$gt/$gte/$lt/$lte/$in/$nin/$exists/$regex`. `$regex` is evaluated
  case-sensitively like Mongo, with the Cyrillic-lowercase rule of `lowered-fields.plugin.ts`
  applied in-process (`locale='bg'`).
- **Paths:** dotted paths and array-element matching.
- **Paging:** `sort`, `page` and `size`, plus the DAL's "All" paging.
- **Lowered mirrors:** on every write, the repository maintains the `*Lower` mirror fields exactly
  as `lowered-fields.plugin.ts` does, with the same helper. `buildSearchFilter` then works
  unchanged: the product search already queries `nameLower`, `skuLower` and the other mirrors
  (`warehouse-api/src/controllers/product.controller.ts:17-24`).
- **`create()` MUST honour a caller-supplied `id`, `createdAt` and `updatedAt`**, and generate an
  ObjectId only when none is given. The sync applier and the offline services both depend on it.

**FR-16.3 — Two new DAL primitives, implemented by both backends:**
- `withTransaction(fn)`: Mongo session / SQLite `BEGIN IMMEDIATE`.
- `counters.next(key, { band? })`: Mongo `findOneAndUpdate $inc` / SQLite
  `UPDATE … RETURNING`. Any service in the offline manifest that needs a counter or atomicity
  uses these, never `Sequence` or `mongoose.startSession` directly.

⚠ **On SQLite, transactions must be serialised by the application.** `bun:sqlite` gives the
sidecar one connection. The services are async. Any `await` inside `BEGIN IMMEDIATE … COMMIT`
lets another request's statements run *inside* the open transaction. A rollback would then undo
writes that were already acknowledged to their caller. The rules:
- the sidecar opens **one write connection**, guarded by a process-wide **async write mutex**;
- `withTransaction`, every standalone write, and the sync applier all hold the mutex for their
  full duration;
- reads outside a transaction use a **separate read-only connection** (WAL), so they never see
  another request's uncommitted state.

**FR-16.4 — The wire and store codec is generated and round-trip proven.**
- **Shape:** documents travel and are stored in the shape `dal-mongo`'s entity mapper
  produces: top-level `id`, and nested `_id`s preserved as 24-hex strings. ObjectIds are hex
  strings and Dates are ISO-8601 strings.
- **Casting back:** the hub casts back to BSON through the Mongoose model (FR-16.33).
- **`Mixed` paths travel as Extended JSON** (`$oid`, `$date`) and are decoded explicitly on the
  hub, because Mongoose does not cast `Mixed`. Examples:
  - `stock-movement.model.ts:90-91`: `lines[].productUpdate`, `priceTiers`;
  - `audit-log.model.ts:30,36-37`: `entityId`, `oldValue`, `newValue`.

  As plain strings, their ObjectIds and Dates would come back as strings, and the round-trip
  would fail.
- **Proof:** for every synced collection, a property test MUST show that
  `hub doc → wire → SQLite → wire → Mongoose cast` is BSON-identical to the original. That
  includes subdocument `_id`s, which `orderRef.reservationId` / `lineId` resolve against. Those ids
  were preserved on purpose by the reservation migration, and a codec that drops them breaks every
  historic order link.

**FR-16.5 — `aggregate()` stays unsupported on the desktop.**
- A service in the offline manifest MUST NOT call it.
- Local read models that the online product serves with an aggregation (stock valuation,
  dashboards) are either server-only or re-implemented as plain queries in the offline service,
  with a parity test (FR-16.9).

### 3.2 What local mode offers

**FR-16.6 — Phase 1: read-only local mode.** Over the local replica, the desktop MUST serve:

| Area | What |
|---|---|
| Products | search by name, SKU, barcode and tags (Cyrillic-safe); the product form read-only; price resolution through `pricing.service.ts` (DAL-only today) incl. tiers, tag and contact prices |
| Contacts | search and view |
| Stock | warehouses; stock levels **with the pending overlay** (`sync.md` §5.5) |
| Documents | outgoing documents, cash sales, stock movements and POS transactions inside the history window (default 90 days) — list, view, print |

**FR-16.7 — Phase 2: offline selling.** The offline selling manifest MUST include:

| Flow | Requirement |
|---|---|
| POS | open session, sale, storno, close, including the fiscal receipt and the Z-report through the desktop's **native fiscal bridge** (FR-14.24) |
| Cash sale | issue (`CS`) |
| Outgoing sales invoice | issue, numbered from the desktop's **band** (FR-16.43) |
| Contacts | create and edit (a walk-in customer who needs an invoice) |
| Stock | availability check, against the overlaid `availableQuantity` |

Phase 3 extends this to goods receipts, transfers and write-offs, outgoing credit notes, recorded
payments, and product create/edit (price tiers included).

**FR-16.8 — The offline route manifest is the single source of what local mode serves.**
- **Where:** `packages/desktop-api/src/offline-routes.ts` lists `method + route pattern + phase`.
- **Unlisted routes:** `desktop-api` answers every route not in the manifest with **503
  `{code:'server_only'}`**, never a hang and never a 404.
- **In the UI:** `desktop-ui` hides server-only navigation in local mode, or shows it disabled
  with an **Open in LGR (server)** action (FR-14).
- **Server-only for the whole of this FR:**
  - accounting and payroll;
  - the Reports app (its handlers are Mongoose aggregations and ledger services);
  - document import, OCR and the Files app;
  - orders, internal orders and reservations;
  - backup and restore, the digest, email;
  - OAuth, user/role/permission-set admin, fiscal-device admin, sequence configuration.

**FR-16.9 — Parity is a gate, not an aspiration.** Every manifest route MUST have:
1. an **import-graph test**: nothing reachable from the route's module imports `db/models`,
   `db/connection` or `mongoose` (checked with the Bun bundler metafile). This is what would have
   caught all of §1.2;
2. a **parity test** that runs the same request against a Mongo-backed and a SQLite-backed
   instance and asserts the same response and the same resulting documents, modulo ids and
   timestamps.

A route cannot enter the manifest without both. New features are server-only by default.

**FR-16.10 — The services on the Phase 2 path MUST be made backend-agnostic.** At minimum:

- `sequence.service` / `invoice-numbering.service`: allocation through `counters.next` with band
  awareness (FR-16.43); `currentMaxSuffix` reads through the DAL.
- `audit-log.service`: through the DAL, so that local audit entries exist and sync
  (class `append`).
- `invoicing.service` stock validation: no `Reservation`/`Product` Mongoose imports. The local
  side validates against the overlaid `availableQuantity`, which already includes the hub's
  reservation holds.
- `pos.controller.ts`: its `POSSession` and `orgDao` uses; `fiscalDevices` / `workstations`
  gain local tables.
- `contact.controller.ts:123-129` and `invoice.controller.ts:86-92`: their direct `db/models`
  imports.

**FR-16.11 — In local mode the desktop registers none of the JE-producing event handlers.**
`registerEventHandlers()` gains a mode switch. Accounting is a hub projection (FR-16.36), and a
desktop that also posted would double-book every offline sale.

### 3.3 Offline authentication

**FR-16.12 — Password hashes never reach a desktop.** `User` is class `reference` with
`password`, OAuth provider tokens and every activation or reset token marked `hubOnly`
(FR-16.29). S-14 (no `select: false` on `User.password`) is exactly why this list is explicit.

**FR-16.13 — Local sign-in works offline only for users who have already proved who they are on
this desktop while online.** There are two kinds of offline verifier, both **argon2id** and both
stored with the user's `credentialEpoch`:

- **Password.** The local login posts to the sidecar. The sidecar verifies the credentials
  against the hub over the desktop-authenticated `POST /api/desktop/v1/user-verify` (FR-15), then
  stores a verifier of the password.
- **Local PIN** (6+ digits). It is set on this desktop right after an online identity check, and
  is the **only** way an **OAuth-only user** (no password, `user.model`'s `oauthProviders[]`) can
  work offline. For those users, the identity check is the FR-14.17 system-browser flow: the
  sidecar redeems its one-time code with the desktop credential
  (`user-verify {oauthCode, verifier}`). Tills are the users most likely to sign in with Google.
  Five failed PIN attempts lock the PIN until the next online sign-in.

Offline, the sidecar checks the stored verifier.

**FR-16.14 — `credentialEpoch` on User**, bumped by a password change, deactivation, a role or
permission-set change, or an admin "sign out everywhere".
- A pulled User whose epoch differs from its verifier's **invalidates the verifier**, so the next
  sign-in must be online.
- A pulled `isActive: false` locks the user out locally at once, and ends that user's local
  sessions.

**FR-16.15 — Local session tokens are signed with a per-profile key, never the cloud JWT secret.**
- **Key:** HS256 with a random 256-bit key generated at profile creation. It is stored in the OS
  keystore beside the desktop key (FR-15.9) and handed to the sidecar at start, since the sidecar
  both signs and verifies local sessions. It is **not** the desktop's Ed25519 private key, which
  never leaves the shell. Claims carry `aud: 'lgr-local'` and a 12 h lifetime.
- **What it replaces:** today's `DesktopAuthService` signs with `config.jwt.secret`, and in the
  sidecar that is the committed fallback `'lgr-dev-secret'` (FR-14 §1). Anyone can mint an admin
  token for any desktop install.

**FR-16.16 — The local API is hardened as a local web server**, because every browser on the
machine can reach `127.0.0.1`:
- it binds `127.0.0.1` on a **random** port per launch (not the hard-coded 4080);
- it rejects any `Host` header other than `127.0.0.1:<port>`, which blocks DNS rebinding;
- it requires a per-launch token header on every state-changing request, which blocks CSRF. The
  shell hands the token to the window in the URL **fragment** (FR-14.22), never in a query
  string;
- its cookies are `SameSite=Strict; HttpOnly`.

**FR-16.17 — No default credentials, no demo org.**
- The first-run "My Company / `admin` / `admin123`" is removed. Today it is logged in plain text,
  pre-filled on the login form and published in the release notes.
- A local profile exists **only** as the result of registering the desktop with an org (FR-15).
- A standalone, never-synced company is out of scope.

### 3.4 Hub change capture

**FR-16.18 — The tailer.** One change stream on the `lgr` database, configured per `sync.md`
§2.1:
- `fullDocument` and `fullDocumentBeforeChange` both `'whenAvailable'`;
- `showExpandedEvents: true`;
- a `$match` on the synced collections plus `sync_applied_batches`.

An idempotent startup step MUST enable `changeStreamPreAndPostImages` on every synced collection
(`collMod`).

**FR-16.19 — The journal is written exactly once.** Per batch of up to 1,000 events or 200 ms,
one transaction does three things:
1. allocates per-org `seq` blocks;
2. upserts `sync_journal` rows, keyed `(orgId, coll, docId, lane)`, where `lane` is `doc` for
   the document's own row and `evict:<route key>` for an eviction row;
3. saves the resume token on `sync_engine`.

**Batch boundaries:** a batch is cut **only at a transaction boundary**, never between two events
sharing `lsid` + `txnNumber`. Resuming inside a push transaction would lose its marker
(`sync.md` §2.1).

**Row contents:** journal rows record:
- `seq`, and **`prevSeq`** (the row's `seq` before this change; FR-16.30 needs it);
- `op`, `origin`, route keys, the changed top-level field names, and `clusterTime`.

They **do not copy document values**; values are read at pull time. Collections with no `orgId`
(ExchangeRate) are journaled under the sentinel org `_global`.

**FR-16.20 — Origin comes from markers.**
- An event whose transaction (`lsid` + `txnNumber`) began with a `sync_applied_batches` marker
  takes that marker's desktop as origin.
- Every other event is origin `hub`.
- The marker is the push transaction's **first** write (FR-16.33).

**FR-16.21 — Seeding.** Enabling sync for an org writes a journal row for every existing document
of every synced collection, in pages, while the tailer keeps running. Seeding writes with
**`$setOnInsert` only**, so a row a live event has already written is never overwritten with
stale route keys.

**FR-16.22 — One tailer per deployment.**
- It holds a lease on `sync_engine` (5 s renewal, 15 s expiry) and a heartbeat.
- A pod that cannot take the lease serves pull and push normally; only tailing is exclusive.
- This is the codebase's first lease. The justification (a continuous consumer is not a daily
  claim) is recorded in `sync.md` §2.1.

**FR-16.23 — Lost history is loud.** On `ChangeStreamHistoryLost` (code 286), or on a
resume-token mismatch after a cluster restore, the tailer does four things:
1. restarts at the current time;
2. **bumps the journal epoch**;
3. re-seeds;
4. marks every desktop of every sync-enabled org `reconcileRequired: 'journal_epoch'`.

It MUST NOT continue across a gap.

### 3.5 Metadata, routing and scope

**FR-16.24 — Sync metadata is generated from the Mongoose schemas** (`packages/db`) and
committed, for example as `packages/config/src/sync-meta.generated.ts`.
- **Contents:** one entry per synced collection, with class, scope, route-key paths, `hubOnly`
  fields, merge arrays, desktop index paths and per-path codec types.
- **Guard:** a snapshot test fails the build when a schema change is not reflected, and when a
  model is neither synced nor explicitly `hub-only`. The second check forces every new model to
  make a sync decision.

**FR-16.25 — Classes and scopes** are exactly those in `sync.md` §4. The Phase 1–2 assignment
MUST match that table. Any change to a collection's class needs an FR amendment, because it
changes what leaves the building.

**FR-16.26 — Scope per desktop** = the org, plus its assigned warehouses (FR-15.13), plus its
history window.
- The window defaults to 90 days, is configurable per org, and can be tightened per desktop.
- `warehouse`-scoped rows reach only desktops assigned to an intersecting warehouse.
- An **unassigned desktop gets no warehouse-scoped rows at all**, never all of them.
- **A change to the desktop's own scope** (assignment or window, FR-15.13) produces no journal
  row, so it triggers a **scope reconcile** instead:
  - the desktop backfills the added scope by pulling from `seq 0` filtered to the added keys
    (`/pull?since=0&scope=added`);
  - it evicts, locally and under `_sync_ctx`, the rows no longer in scope. Rows with unpushed
    changes or open overlays are kept until they are pushed.

**FR-16.27 — Evictions.**
- An update that removes a document from a scope produces an eviction row per lost route-key
  value.
- The pull delivers an eviction to a desktop **only if the document's current route keys are
  outside that desktop's scope.** A desktop assigned to both warehouses of an A→B move keeps the
  movement.
- Desktops remove evicted rows under `_sync_ctx`, so the removal is neither captured nor pushed.

**FR-16.28 — Age-out is local.** Each desktop prunes rows that fall out of its window, under
`_sync_ctx`, at most once a day. **Exception:** it never prunes a row that has unpushed changes
or an open overlay.

**FR-16.29 — `hubOnly` fields are stripped by the pull serialiser, and rejected by the push
applier.**
- A desktop cannot read `User.password`, and it cannot set it either. Both directions are tested
  for every `hubOnly` path.
- An acceptance test (§8) seeds an org and scans **every** pull payload for bcrypt prefixes
  (`$2a$`/`$2b$`) and OAuth token shapes.

### 3.6 Pull

**FR-16.30 — Endpoint.** `GET /api/sync/v1/pull?since&limit` returns the response described in
`sync.md` §5.1.
- **Filtering:** by the desktop's scope. It includes eviction rows (per FR-16.27), and tombstones
  since `since`.
- **Echo skip:** a row is skipped for the caller **only if `origin` is the caller and
  `prevSeq ≤ since`**, meaning the caller's own change is the only one it has not seen. The
  journal collapses history, so a plain "skip rows of my origin" would silently lose a hub edit
  that preceded the caller's push to the same document (`sync.md` §3). The skip is a bandwidth
  optimisation; correctness never depends on it.
- **Missing documents:** a journal `upsert` whose document is gone at read time is returned as a
  `delete`.
- **Limits:** `limit` is at most 1,000, default 500. The response is compressed when it exceeds
  16 KB.

**FR-16.31 — Desktop apply.** One SQLite transaction per page, holding the write mutex
(FR-16.3), with `_sync_ctx.applying = 1` and the watermark as the last write (`sync.md` §3).
- **Unpushed local changes:** a pulled document that has them is **merged per field**. Local
  pending values stay; everything else takes the hub value.
- **StockLevel:** a pulled StockLevel recomputes the shown quantity from the hub value plus open
  overlays. An overlay is retired when the desktop applies a pulled version of its movement that
  carries `stockAppliedAt` (`sync.md` §5.5).
- **Push responses are applied the same way.** The post-apply documents a push returns
  (FR-16.33) are applied under `_sync_ctx`, with the same per-field merge. They do **not** move
  the watermark.

**FR-16.32 — Poke and presence.** `/ws/desktop` authenticates by the desktop access token in the
**first message**, never in a query string.
- **What it carries:** `sync:poke {seq}` after every journal batch that touches the desktop's org,
  plus the FR-15 presence heartbeat.
- **Fallback:** without a socket, the desktop polls on an adaptive 5–60 s interval.

### 3.7 Push and hub apply

**FR-16.33 — Endpoint.** `POST /api/sync/v1/push` handles a batch of up to 500 changes or 4 MB,
coalesced per row as `sync.md` §5.2 describes. It is applied in **one Mongo transaction**, in
this order:
1. the `sync_applied_batches` marker, **first**;
2. every change, **through the Mongoose model** (casting, `runValidators: true`, lowered-field
   hooks);
3. one `sync_outbox` item per projection the batch requires (FR-16.36);
4. `sync_desktop_state.lastAppliedSpokeSeq` for the batch's `(desktopId, instanceEpoch)`,
   **last**.

The response carries the **post-apply document** of every document the batch touched:
`updatedAt`, schema defaults, casting and the lowered mirrors, exactly as the hub stored them.
The desktop never lags behind what its own push produced, and a skipped echo (FR-16.30) hides
nothing.

**FR-16.34 — Per-change semantics:**
- `insert` is create-if-absent, converging on a retry;
- `update` is a field-level compare-and-set against `base`;
- `delete` is tolerant.

Every change is **validated** before it is applied:
- the collection is synced, and its class may be pushed;
- `orgId` is forced to the desktop's org; a mismatch is dead-lettered as `foreign_org`;
- ids are valid ObjectIds;
- field names are known to the metadata, are not `hubOnly`, contain no `$` or `.` operators and
  are not `__proto__`;
- the change is within size caps.

**FR-16.35 — Idempotent, per epoch and by content.**
- **Epoch.** `lastAppliedSpokeSeq` is kept **per `(desktopId, instanceEpoch)`**.
- **Stored result.** A batch whose `seqTo` is at or below its epoch's watermark returns the
  stored result and writes nothing.
- **After a restore.** A restore regenerates the epoch (FR-14.30), which starts a fresh
  watermark. Changes from the restored database then **converge by content** (FR-16.34). They
  are never dropped because an older epoch had already counted past their `seq`. Without this,
  every sale made after a restore would be silently discarded as "already applied".
- **Write conflicts.** `WriteConflict` retries the transaction, and the compare-and-set is
  evaluated again.

**FR-16.36 — Projections go through a transactional outbox** (`sync.md` §5.4).
- **Enqueued with the push.** The push transaction enqueues one `sync_outbox` item per required
  projection. A committed push therefore always has its projections recorded, even if the pod
  dies a millisecond later. A retried push is answered from the stored result and enqueues
  nothing twice.
- **Drained by a worker.** Any pod claims items with a lease. Each item is at-least-once, and each
  effect is idempotent, which together gives exactly-once.
- **Origin `hub`.** Every projection writes with origin `hub`.

The full set:
- **the StockLevel effect** of each pushed completed movement, through
  **`applyMovementStockEffect(movement, { session })`**. It is extracted from `confirmMovement`
  and has three properties:
  - an atomic `$inc`, not `adjustStock`'s read-modify-write;
  - no draft check;
  - no event.

  It runs in the item's transaction, together with marking the item done and writing the
  movement's `stockAppliedAt` **last**. That makes it **once per movement id**, and **never** a
  recompute from history (§1.6). `confirmMovement` keeps its online behaviour by calling it.
- `stock.movement.confirmed`, `invoice.posted`, `payment.recorded` for each **new**
  `payments[]` element, and `pos.session.closed`, through `handlers.ts`, guarded per FR-16.37;
- `syncOrderForInvoice` for invoices carrying `orderRef`s (an idempotent re-materialisation).

**Audit entries are not a projection.** The desktop runs the same controller code, so it writes
the same entries the online path writes. They carry `via: 'desktop:<name>'` and sync as class
`append`. The hub's handlers write their own entries exactly as online. The push applier writes
none, so the trail matches the online one entry for entry.

**FR-16.37 — Every JE handler becomes idempotent before any projection exists.** Today only
`pos.session.closed` checks (`handlers.ts:183`).
- `invoice.posted` skips when `journalEntryId` is set or a JE already references the invoice.
- `payment.recorded` binds its JE to the **payment element's `_id`**. Today it stamps
  `journalEntryId` on *the last element* and rewrites the whole `payments` array
  (`handlers.ts:113-114`). That is wrong the moment `merge-elements` brings in two payments at
  once, and it races any concurrent merge.
- `stock.movement.confirmed` skips when a valuation JE for that movement already exists.

This is a prerequisite of FR-16.36, not a tidy-up: at-least-once delivery without these guards
double-posts.

**FR-16.38 — The online/offline equivalence property.** For each Phase 2 flow, performing it
online and performing it offline then syncing MUST leave the hub in the same state:
- documents, StockLevels and JEs;
- **the audit trail, entry for entry**, apart from the `via` field;
- sequence counters.

Ids, timestamps and the desktop infix/band may differ. This is the acceptance test that proves
the projection list is complete (FR-18).

### 3.8 Conflicts and dead letters

**FR-16.39 — Policies.** Conflict policies are those in `sync.md` §7: `hub-wins` (default),
`monotonic` status, `merge-elements`, `owner-wins`, `immutable`. They are declared per path in
the metadata.

**FR-16.40 — Every conflict is recorded** in `sync_conflicts` with base, both values, policy,
winner, desktop, user, HLC, hub time and `cycleId`. **The losing desktop is resent the
document** (journal touch, origin `hub`) so that it converges.

**FR-16.41 — Dead letters by bisection.**
- **Isolation:** a failing batch is bisected in order until the rows that fail alone are
  isolated. Those are parked in `sync_dead_letters` with the change, reason, batch and `cycleId`.
- **Progress:** every succeeding sub-batch commits with its own marker and watermark advance.
  Parked rows never block later rows.
- **Response:** the push response lists the parked changes. The desktop keeps them flagged
  locally until they are resolved.

**FR-16.42 — Dead-letter resolution** (from FR-17) offers two actions:
- **retry**, which re-applies the stored change as a fresh single-row push, after an admin has
  fixed the cause;
- **discard**, which asks the origin desktop to drop the change and resends the hub version.

Both are audit-logged.

### 3.9 Numbering

**FR-16.43 — Number bands for legal series.**
- **Model:** `sync_number_bands {orgId, desktopId, sequenceKey, year, from, to, next, status:
  active|exhausted|retired}` records the ranges.
- **Which series:** the sequence registry (`sequence-registry.ts`) gains a `legal: boolean` per
  key. `SALES_DOC`, `CASH_SALE` and `PROFORMA` are legal. Drafts, `ORDER`, `INTERNAL_ORDER`,
  `RESERVATION` and the companion documents are not.
- **Offline issuing:** a desktop issues a legal document offline **only** from an active band.
  Without one it can save drafts, and the UI says why.

**FR-16.44 — Bands are proposed automatically and confirmed by an admin** (FR-17).
- **The proposal:** the next free, non-overlapping range after the hub's live counter, sized per
  org and key (default 10,000).
- **Overlap:** it MUST NOT overlap another band or the hub's already-issued numbers.
- **Warnings:** the Sync page warns at 80 % and at 95 % used. The desktop requests its next band
  while online.

**FR-16.45 — The hub allocator is band-aware.**
- `getNextNumber` / `getNextInvoiceNumber` never allocate inside or through **any** band,
  whether active, exhausted or retired. The counter jumps over a band as a whole.
- `currentMaxSuffix()` and the POS "latest SM + 1" logic **ignore numbers that belong to a band**
  (§1.5).
- A test issues a desktop invoice from band `[50001, 59999]`, syncs it, issues an online invoice,
  and asserts the online number is **not** 50002.

**FR-16.46 — Continuity is checked per band.** FR-11.7b's sequence line (the daily digest) and
the sequences configuration page report per range: the hub range, and each desktop band with
its owner.

**FR-16.47 — Every internal series allocated offline carries the desktop's short code**
(FR-15.4). That means stock movements (`SM-2026-T1-00012`), POS transactions
(`TXN-2026-T1-0000031`, today `getNextNumber(orgId, 'TXN', 7)` at `pos.controller.ts:607,861`),
POS sessions (today `getNextNumber(orgId, 'POS', 6)` at `:317`) and drafts. They are allocated
locally and never collide. Every parser that reads "the latest number" skips infixed numbers.

**FR-16.48 — One УНП allocator per fiscal device, in both modes.**
- **Owner.** For a fiscal device bridged by a desktop (FR-14.25), **that desktop is the only
  allocator, in server mode as well as local mode.**
- **In server mode**, the hub's `generateUNP` (`pos.controller.ts:604,858`) asks the bridge over
  the bridge socket (`fiscal:unp:allocate`, FR-14.24). The device is physically attached to that
  desktop, so a sale that cannot reach it cannot be fiscalised anyway.
- **Why not split by mode.** Allocating on the hub while online and on the desktop while offline
  means two allocators sharing a counter. A till that drops offline mid-day cannot know the hub's
  latest value, and pulled POS transactions lag.
- **The hub's copy.** The desktop pushes its `max`, and the hub keeps
  `Sequence(UNP-<device>-<operator>) = max(hub, pushed)` for export and display only.
- **Handover** to another bridge, or back to the browser relay, transfers the counter. The old
  owner reports its `max`, and the new owner starts above `max(hub, reported)`. Without the old
  owner's report, it takes an explicit admin override, which is recorded and shows its
  duplicate-risk warning.

### 3.10 Reconcile, restore and clone detection

**FR-16.49 — Reconcile** follows `sync.md` §8: fence, push first, digests, the fixed existence
order, hub-wins on values. It is exposed as:
- `POST /api/sync/v1/reconcile/start|digest|repair|finish` for the desktop;
- a Sync page action "Reconcile" for admins.

**FR-16.50 — Detection sets `reconcileRequired` with a reason**, from the §8 list:
`restored`, `hub_regressed`, `beyond_retention`, `journal_epoch`, `resumed`, `manual`.
- `instanceEpoch` is regenerated by the shell's archive restore (FR-14.30).
- A desktop that is `reconcileRequired` makes no ordinary pull or push until its reconcile
  finishes. Only the reconcile flow's own pushes are accepted (FR-16.61).
- **After a restore, nothing legal is issued until it is safe** (`sync.md` §6). The archive
  brought back old counters, and numbers issued after it was taken are already with customers.
  The desktop:
  1. blocks legal issuing and УНП allocation;
  2. retires every band it used before the restore, reporting the tail the hub cannot confirm
     as *"unaccounted after restore"*;
  3. waits for new bands to be confirmed;
  4. resumes УНП only above `max(hub max, the last УНП the fiscal device reports)`, or after an
     admin confirms;
  5. reseeds its infix counters from `max(local, hub)`.

  A gap can be explained. A duplicate invoice number cannot.

**FR-16.51 — Clones never push under a stolen identity.**
- A profile database whose `_desktop_info.desktop_id` has no matching key in this machine's OS
  keystore is opened **read-only**.
- Its unacknowledged `_changes` are exported to a file for review.
- The machine must register as a new desktop (FR-15.8).

**FR-16.52 — Tombstone retention.**
- **The window:** `SYNC_TOMBSTONE_DAYS` defaults to 180. A sys-admin can override it per org from
  `/admin/sync` (FR-17.19). FR-18's `beyond-retention` check shortens it for `lgr-fieldtest`
  that way.
- **Purging:** tombstones and evictions older than the window are purged daily, and the org's
  floor advances.
- **Below the floor:** a desktop whose `hub_seq` is **above 0** and below the floor must
  reconcile. A desktop at `hub_seq = 0` is doing a full first pull, which the journal serves
  completely (`sync.md` §8).

### 3.11 Drift and version skew

**FR-16.53 — Each request carries the desktop's app version and metadata hash.**
- The hub publishes `minDesktopVersion`, per deployment and overridable per org.
- **Push** below the minimum answers **426 `{code:'desktop_outdated'}`**. Unpushed changes wait in
  `_changes`, and the desktop updates (FR-14.27).
- **Pull** stays allowed.

**FR-16.54 — Drift report.** Published metadata is compared with each desktop's reported hash
and with the live collections (DDL events from `showExpandedEvents`). The findings appear on the
Sync page (FR-17). A failed catalogue read **filters nothing**.

### 3.12 Transport and networks

**FR-16.55 — The sync client works on the networks people actually have:**
- the system proxy, including PAC (WinINET/WinHTTP on Windows, the system proxy on macOS,
  environment variables and GNOME settings on Linux), resolved by the shell and handed to the
  sidecar, with an explicit override in Settings;
- the **OS trust store**, so that a TLS-inspecting middlebox's root CA installed by GPO is
  trusted. Bun's `fetch` uses its own CA bundle, so the shell MUST export the OS roots to the
  sidecar (e.g. `NODE_EXTRA_CA_CERTS`), or the sync HTTP client MUST live in the Rust shell;
- HTTPS only (loopback excepted in development);
- exponential backoff with full jitter (1 s → 5 min), honouring `Retry-After`.

FR-18's proxy lane proves the first two. A desktop that works only on a clean home network
**has not worked**.

**FR-16.56 — Online/offline state.** The desktop declares the hub **unreachable** after three
failed attempts within 30 s, and **reachable** again on the first success.
- The shell surfaces the state (FR-14).
- **Mode is never switched silently.** The user is offered local mode.

### 3.13 Observability and operations

**FR-16.57 — Run log.** One `sync_runs` row per direction, per desktop, per cycle that did
something, with a per-collection breakdown and a `cycleId` that joins it to conflicts and dead
letters.

**FR-16.58 — Engine health.** `sync_engine` carries these fields:
- the tailer holder;
- heartbeat (every 5 s);
- `lag` = now − the last event's `clusterTime`;
- the resume token's age against the live oplog window. This is read from `local.oplog.rs`, the
  same bound FR-13.9 checks;
- journal size;
- journal epoch.

They are exposed at `GET /api/admin/sync/engine` behind the FR-13.26 sys-admin allow-list, and
on the Sync page per org.

**FR-16.59 — `SYNC_DRY_RUN=true`.** The hub reads, routes and logs but writes nothing. Pushes
answer with what would have happened. `SYNC_TAILER_ENABLED=false` stops tailing without
affecting anything else. Both are 0/false in `.env.test`, except where a test enables them.

**FR-16.60 — The tailer holds no locks the import skills or the FR-13 backup could wait on.** Its
transactions touch only `sync_*` collections.

### 3.14 Security and tenancy

**FR-16.61 — Every `/api/sync/v1/*` request authenticates the desktop access token (FR-15.10)
and re-reads the desktop row.**
- revoked → 401 `desktop_revoked`;
- paused → 423;
- reconcile required → 409 `reconcile_required`. Two things are exempt: the reconcile endpoints,
  and pushes carrying the active reconcile session's id. The reconcile's "push first" step
  (`sync.md` §8) must be able to run.

**The org is taken from the desktop row, never from the request.**

**FR-16.62 — Tenant isolation is asserted over the sync surface.**
`tenant-isolation.flow.test.ts` gains cases proving that a desktop of org A:
- cannot pull org B's rows;
- cannot push into org B;
- cannot reconcile against org B, even with a forged `orgId` in the body.

The e2e `security` project gains the same cases over HTTP.

**FR-16.63 — Local data at rest.** The installer documents OS full-disk encryption (BitLocker or
FileVault) as the baseline. The Overview page (FR-14) MUST show a warning when it can detect that
disk encryption is off. An encrypted SQLite store (SQLCipher) MAY follow. Revocation with wipe
is FR-15.18.

### 3.15 SUPTO / Н-18 in local mode

**FR-16.64 — A desktop selling offline is a SUPTO instance.** It MUST:

- **allocate УНП** per FR-16.48;
- **keep completed sales immutable** in the local store. Two mechanisms enforce it:
  - the local service refuses edits and deletes of issued fiscal documents under
    `SUPTO_MODE=production`, as online;
  - a SQLite trigger raises on `DELETE` of a completed POS transaction or an issued cash sale,
    `WHEN (SELECT applying FROM _sync_ctx) = 0`. The condition keeps it from blocking the
    engine's own removals: age-out, eviction and reconcile.
- **write its operations to the local audit log**, pushed as class `append`;
- **run the FR-09 day close**, Z-report first, through the native bridge.

**FR-16.65 — The hub's SUPTO export (tables 18.1–18.9) is only as complete as the last push.**
- The Sync page shows each desktop's unpushed sales count and the age of its oldest unpushed
  sale.
- The FR-11 digest gains a line for any desktop holding unpushed sales older than 24 h.

### 3.16 Retire the prototype

**FR-16.66 — When Phase 2 ships, `packages/sync` is removed in the same release**, together with
the first-run demo org, `_id_map`, and the `/api/settings` sync section, which nothing reads.

The guides that describe the prototype are rewritten, not left beside the new ones:
`docs/guides/sync-setup.md`, `cloud-to-desktop.md`, `desktop-to-cloud.md`, and
`docs/api/desktop-api.md`.

---

## 4. Edge cases and traps

1. **`currentMaxSuffix()` jumps the hub counter into a desktop's band** the first time a
   band-numbered invoice syncs (§1.5). FR-16.45's test must fail against today's code before it
   passes.
2. **POS "latest SM + 1" does the same with movement numbers.** Infixed numbers (FR-16.47) must
   be invisible to it.
3. **Three of the four JE handlers are not idempotent** (§1.6, FR-16.37). `payment.recorded`
   also stamps the *last* payment element. An outbox item retried after a timeout double-posts
   unless FR-16.37 lands first.
4. **StockLevel is not the sum of movements** (§1.6). The POS batch dispatch record never touched
   it. Any recompute of stock from history double-dispatches. **`confirmMovement` cannot be
   reused either**: it refuses non-drafts (`warehouse.service.ts:13`) and emits the valuation
   event itself (`:64`). Hence `applyMovementStockEffect`.
5. **A per-document journal collapses history** (FR-16.30). "Skip rows of my own origin" would
   silently lose a hub edit made before the desktop's push to the same document. The skip is
   exact (`prevSeq`), or it does not happen. Separately, the marker must be the push
   transaction's **first** write, and a tailer batch must never split a transaction
   (FR-16.19). Break either and the rest of that push is journaled as origin `hub`.
5a. **Projections after commit are lost on a crash** unless they were enqueued **inside** the
   push transaction (FR-16.36). A retried push is answered from the stored result and would never
   re-trigger them.
5b. **A restore brings back old counters.** Watermarks (FR-16.35), bands, УНП and infix counters
   (FR-16.50) must all treat the restored database as a new epoch. Otherwise the hub drops
   post-restore sales as "already applied", and the till re-issues numbers customers already
   hold.
5c. **`await` inside a SQLite transaction on the one `bun:sqlite` connection** lets other
   requests' statements join the transaction (FR-16.3). A rollback then undoes their
   acknowledged writes.
5d. **Windows `app_data_dir()` is Roaming AppData** (FR-16.1). With roaming profiles, a WAL
   database lands on a network share, and one key and one database follow the user to every
   PC.
6. **Deletes route only with pre-images.** If `changeStreamPreAndPostImages` is missing on one
   collection, its deletes arrive without `orgId`. They still route, through the seeded journal
   row, but an eviction cannot be computed. The startup `collMod` step is not optional.
7. **Mongoose buffering hides a missing port as a 10-second hang.** An offline route that reaches
   Mongoose does not fail fast (§1.2). The import-graph test (FR-16.9) is the only reliable
   catch.
8. **The Win11 guest clock boots about 3 h ahead** (roomler FR-61 trap). HLC ordering and token
   expiry must survive a skewed clock. The desktop reports its skew, and nothing uses its wall
   clock to decide against the hub.
9. **A pull must never clobber an unpushed field** (FR-16.31). Otherwise a concurrent pull
   silently discards an offline edit.
10. **Evictions are not deletes.** A desktop that captured an eviction would push a delete of a
    document it merely stopped seeing.
11. **A copied profile database is not a desktop** (FR-16.51). Treating it as one would push its
    `_changes` a second time under the original identity.
12. **Bulk catalog rewrites are normal days.** `assign-din-tags` touches 23,246 products in one
    run. The journal absorbs it (no values are copied), and every desktop pulls 47 pages.
    FR-18's budget holds it to "caught up within 10 minutes".
13. **73 `e2e-*` orgs.** Sync is opt-in (D-8). Seeding them by accident would multiply the journal
    by a lot of nothing.
14. **Cyrillic regex.** Bun transpiles Cyrillic regex literals to `\uXXXX`, which Mongo refuses
    (CLAUDE.md). Hub-side route or seed queries must not build `$regex` from Cyrillic literals.
    Desktop-side `$regex` runs in-process (FR-16.2), so it is unaffected.
15. **`.rejects` / `.resolves` deadlock the Windows test run** (CLAUDE.md known issue).
    The new suites use `captureRejection` / `expectRejection` from
    `helpers/capture-rejection.ts`.
16. **A revoked desktop can still hold unpushed sales.** FR-15.18 shows the count before the
    revoke is confirmed.
17. **`PUT /org/:orgId` replaces the whole `settings` subdocument and strips unknown keys**
    (FR-11 / FR-13.55). Per-org sync policy therefore lives in `sync_orgs`, not in
    `Org.settings`.

---

## 5. Integration constraints

- The five migration CLI skills drive `POST /org/:orgId/bills/import/*` and
  `POST /org/:orgId/invoices`, and their contracts are frozen (FR README global constraints 1–2).
  Their writes reach desktops through the tailer like any other. **Nothing about them changes.**
- Route names stay load-bearing (global constraint 3). `desktop-ui` reuses the domain views and
  their names.
- Sequence and prefix logic stays registry-driven (global constraint 4). `legal` is a registry
  column, not a list in the sync code.
- The FR-13 backup and restore interact with the journal in two places:
  - A **per-org Merge/Replace restore** writes through Mongo, so the tailer journals it, and
    desktops receive it like any other change.
  - A **full-cluster restore** lands in FR-16.23.
- `bun run test`, `bun run build` and `bun run test:e2e` stay green. `desktop-ui` joins the root
  `build` (FR-14.9).

---

## 6. Migration and ops notes

1. **The first deploy only lays the foundation.** It enables `changeStreamPreAndPostImages` on
   the synced collections and starts the tailer with **no org enabled**, which exercises lease,
   heartbeat, resume and lag on production traffic, journaling nothing. Watch it for a week in
   the sys-admin panel before enabling a real org.
2. **Enable a dedicated field-test org first** (FR-18's `lgr-fieldtest`), then regal-pz. Seeding
   regal-pz writes about 54k journal rows, in pages. That is the org's 60,429 documents
   (FR-13 §2.1) minus the hub-only collections: files, docfiles, backgroundtasks, emaillogs and
   auditlogs (`dh` only).
3. **The app user.** The API connects as `lgr_admin` (authSource `admin`). Confirm it holds
   `changeStream` + `find` on `lgr` and `find` on `local.oplog.rs`, because FR-16.58 reads the
   window bound. A least-privilege `lgr_sync` user SHOULD follow once the engine is stable.
4. **Oplog budget.** Pre/post images live in `config.system.preimages` and expire with the oplog.
   Measure their size after a regal-pz week and record it in FR-13's growth model.
5. **Band plan for regal-pz.** Agree the ranges with the accountant **before** any desktop issues
   offline. Invoice numbers go into customers' hands and cannot be taken back.
6. **`minDesktopVersion`** starts at the first FR-16 release, so that a prototype build can never
   push.

---

## 7. Phases

| Phase | Ships | Kill switch / rollback |
|---|---|---|
| P0 | This spec, `sync.md` rewrite, issues | — |
| P1 | Tailer + journal + seeding + pull + desktop document store + read-only local mode. It ships with its manifest and parity gate, offline sign-in, and the auth, tenancy and at-rest rules from day one (FR-16.1–16.6, .8–.9, .12–.32, .52, .55–.63). A P1 desktop holds no local changes, so its reconcile is a **rebaseline**: drop the replica and pull from `seq 0`. | `sync_orgs.enabled=false` per org; `SYNC_TAILER_ENABLED=false` |
| P2 | Push + outbox projections + bands + offline selling. **Full reconcile with restore and clone detection, and the 426 gate, ship here too.** A P2 desktop holds unpushed sales, so it cannot wait for P3 to be un-blocked (FR-16.7, .10–.11, .33–.51, .53, .64–.65). | `minDesktopVersion` above the build; per-desktop pause |
| P3 | Two-way master data, the P3 manifest, the remaining conflict policies (`merge-elements` for `payments[]`), drift report (FR-16.54) | per-collection push disable in metadata |
| P4 | Performance budgets met, chaos harness and field matrix green (FR-18); prototype retired (FR-16.66) | — |

---

## 8. Acceptance criteria

1. The tailer journals inserts, updates and deletes from `bulkWrite`, `updateMany`, `insertMany`,
   `deleteMany` and a raw `collection.updateOne`. Each is proven by a test that fails with the
   tailer disabled.
2. Killing the tailer mid-batch and restarting loses no event and double-allocates no `seq`.
   Two pods during a rolling deploy yield exactly one tailer.
3. `ChangeStreamHistoryLost` (forced by resuming from a token older than a tiny test oplog) bumps
   the epoch and marks every desktop `journal_epoch`.
4. A new desktop's first pull from `seq 0` reproduces the org's in-scope documents exactly
   (per-collection digest equality). An unassigned desktop receives no warehouse-scoped row.
5. **No pull payload of a seeded org contains a bcrypt hash or an OAuth token**, whatever the
   collection. A push setting `password` is dead-lettered.
6. An update moving a movement to another warehouse evicts it from desktops of the old warehouse
   and delivers it to desktops of the new one. Nothing is pushed back.
7. A push replayed three times applies once. A push with one invalid row applies the others and
   dead-letters exactly that row. The watermark covers both.
8. **Collapsed history.** The hub edits field A of a document, then a desktop pushes field B of
   the same document. The desktop ends with both. It is not re-sent a document whose only unseen
   change was its own push, and it matches the hub byte for byte through the push response. The
   org's other desktop receives the change within one poke.
8a. **Durable projections.** The hub is killed between a push's commit and its projections. After
    restart, the JE and StockLevel effects happen exactly once, from the outbox. A retried push
    re-enqueues nothing.
8b. **Restore numbering.** A desktop restored from an archive issues no legal number and no УНП
    until FR-16.50's reseed. Its post-restore sales reach the hub (none is dropped as "already
    applied"), and no number is issued twice.
8c. **Scope change.** Assigning a second warehouse backfills its rows. Unassigning evicts them,
    except rows with unpushed changes.
8d. **Serialised writes.** Two concurrent local requests, one of which rolls back, leave the
    other's write intact.
9. A field changed on both sides is logged in `sync_conflicts` with both values. The hub keeps
   its value, and the losing desktop converges after the resend.
10. **Online/offline equivalence** (FR-16.38) holds for: POS sale, storno and close; cash sale;
    outgoing invoice issue; contact create.
11. An offline POS day on a desktop leaves the hub with exactly one JE per online-equivalent
    event. The StockLevel change equals the online path's, with no double dispatch, including an
    org with inventory accounts configured (the batch-record trap).
12. A band-numbered invoice synced to the hub does **not** move the hub counter into the band
    (FR-16.45). The digest reports continuity per band.
13. A desktop restored from an archive is detected (`restored`), reconciles, and ends identical
    to the hub for its scope, with its unpushed post-archive changes neither lost nor duplicated.
14. A copied profile database on another machine opens read-only and exports its `_changes`.
15. A desktop below `minDesktopVersion` gets 426 on push and still pulls. After updating, its
    queued changes push.
16. A desktop of org A cannot pull, push into or reconcile against org B (integration + e2e).
17. Every manifest route has an import-graph test and a parity test. Removing a DAL port makes
    the corresponding test fail.
18. Local mode answers every non-manifest route with 503 `server_only`, in under 100 ms (no
    Mongoose buffering).
19. A user who has never signed in online on the desktop cannot sign in offline. An OAuth-only
    user can, after setting a local PIN following an online OAuth check. A user deactivated on the
    hub is locked out locally at the next pull.
20. Local tokens are signed with the per-profile key. A token signed with `lgr-dev-secret` is
    rejected. No default credential exists anywhere in the build or its release notes.
21. `bun run test` + `bun run build` green. `SYNC_TAILER_ENABLED=false` in `.env.test` except in
    the suites that start their own tailer.

---

## 9. Field test

The scripted, repeatable version is FR-18's `lgr` vmtest lanes and fleet checks. The first
manual pass on production (`https://lgrai.app`, dedicated org `lgr-fieldtest`, then regal-pz)
goes as follows:

1. Deploy with no org enabled. For a week, record in the sys-admin panel:
   - tailer heartbeat, lag and resume-token age against the oplog window;
   - one forced pod restart (the lease hands over, no event is lost);
   - one rolling deploy (still one tailer).
2. Enable `lgr-fieldtest`, register a Windows desktop (FR-15) and assign it one warehouse. Time
   the first pull, and compare per-collection digests with the hub.
3. Run `assign-din-tags` on `lgr-fieldtest` and time the desktop's catch-up.
4. Unplug the network. Sell three POS items with the Eltrade A3 through the native bridge (a
   non-fiscalised unit prints non-fiscal), issue one cash sale and one band-numbered invoice.
   Reconnect. Confirm on the hub:
   - the documents;
   - one JE each where accounting is configured;
   - StockLevels equal to the online path;
   - the audit entries carrying `via: desktop:<name>`;
   - the hub invoice counter outside the band.
5. Edit the same contact on the hub and on the desktop while it is offline. Reconnect, confirm
   the conflict on the Sync page, and confirm that the desktop converges.
6. Restore the desktop's archive from step 2 and confirm:
   - `restored` → reconcile → identical to the hub;
   - step 4's sales present exactly once;
   - **legal issuing blocked** until a new band is confirmed;
   - no invoice number or УНП reused.
7. Revoke the desktop while it has one unpushed sale. Confirm the warning shows the count, and
   that the desktop stops syncing and exports the sale.
8. Only then enable regal-pz, with the accountant's band plan (§6.5).

---

## Appendix A — where the §1 numbers come from

```bash
# services: Mongoose vs DAL (from the repo root)
grep -rlE "from '(db|db/[^']*|mongoose)'" packages/services/src | wc -l          # 80 of 133
grep -rlE "getRepos|RepositoryRegistry" packages/services/src | grep -v context.ts | wc -l   # 24
# write sites that bypass middleware (tests excluded)
for p in bulkWrite updateMany insertMany deleteMany; do
  echo $p $(grep -rn "\.$p(" packages scripts --include=*.ts | grep -v node_modules | grep -v /tests/ | wc -l); done
grep -rn "\.collection\.\(insert\|update\|delete\|bulk\|replace\)" packages scripts --include=*.ts \
  | grep -v node_modules | grep -v /tests/ | wc -l                               # 4
# production topology (read-only)
kubectl -n lgr get deploy,sts -o wide
kubectl -n lgr exec deploy/lgr -c lgr -- printenv MONGODB_URI | sed -E 's#//([^:]*):[^@]*@#//\1:***@#'
```
