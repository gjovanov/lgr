# FR-17 — Sync page: the org's desktops and the health of their sync

**Goal:** one page per org where an admin sees **every registered desktop** and **the state of
its sync**, and acts on both. The page shows presence, version, what each desktop holds, what it
has not yet pushed, what failed, what conflicted, and which number bands it issues from. The
actions are register, assign, pause, reconcile, update and revoke. Two companion pages come with
it:

- a **sys-admin engine page** for the hub side, which spans all orgs;
- a **Sync view inside the desktop app**, which shows the same facts from the desktop's side and
  works offline.

The org page merges two proven screens: PCON+'s `/admin/sync` (`g-rox/pcon` →
`packages/ui/src/views/admin/sync/SyncView.vue`) and roomler's Devices page (`roomler-ai` →
`ui/src/views/devices/DevicesView.vue` + `AgentsSection.vue`).

Status: draft for implementation · Date: 2026-09-28 · Tracking: [gjovanov/lgr#60](https://github.com/gjovanov/lgr/issues/60) (epic [#56](https://github.com/gjovanov/lgr/issues/56)) · Depends on: [FR-15](FR-15-desktop-registration.md)
(the registry and its actions), [FR-16](FR-16-local-mode-sync-engine.md) (the engine state it
displays) · Feeds: [FR-18](FR-18-desktop-tests-field-automation.md).

Driving input: *"With an Sync page for the Org and all devices/desktops."* (goran, 2026-09-28;
full request in FR-16).

---

## 1. Current state (verified 2026-09-28, master @ `81b5fe5`)

- **No desktop or sync UI exists** anywhere in the product. The prototype's `/api/settings` sync
  section has no screen and no reader (FR-14 §1.2 #11).
- **Where portal pages live** (`packages/portal-ui/src/router/index.ts`):
  - the org owner's self-service area, `settings/*`: organization, users, invites, billing,
    permission-sets;
  - system functions, `admin/*`: `admin/audit-log`, and `admin/backup`, gated by the FR-13.26
    sys-admin allow-list.
  - ⚠ **Portal routes have no client-side gate at all.** The server check is the entire control
    (FR-13 trap 20).
- **The first model, PCON+'s `SyncView.vue`** (1,340 lines):
  - an engine card with cycles, rows each way, conflicts, dead letters and the last cycle, plus a
    sparkline over a chosen series and range (1 h / 24 h / 7 d);
  - a schema-drift card;
  - a spokes table with status, last error and pause/resume/reconcile;
  - a progress card showing pending rows per table and direction;
  - tabs Runs · Conflicts · Dead letters · Changes (change browser) · CDC;
  - a run-detail dialog with the per-table breakdown, and the conflicts and dead letters of that
    cycle;
  - confirmation dialogs for actions.
- **The second model, roomler's Devices page:**
  - a toolbar with **Update all**, an **Enroll ▾** menu, search, a kind filter and a column
    picker;
  - columns: name with presence and version, status, OS, last seen;
  - row actions: maintenance (update now, rotate key), diagnostics, access (rename, policies) and
    delete, with confirmation;
  - **no pause or quarantine action**, which FR-15 adds.
- **Existing building blocks to reuse:**
  - `useGridColumns` + `GridColumnPickerDialog` (per-user column visibility and order, keyed by
    route name);
  - `useListQueryState` (FR-05), which keeps grid state in the URL;
  - `appHref(appId, path)`, for cross-SPA links into documents;
  - the `BackgroundTask` + polling pattern for long jobs (FR-12, FR-13.16).

---

## 2. Placement

| Page | Route | Audience | Gate (server-side) |
|---|---|---|---|
| **Org Sync page** | portal `/settings/sync` (name `settings.sync`) | the org's admins | `admin.settings` (FR-15.20) |
| Desktop approval | portal `/settings/sync/approve?code=` (name `settings.sync.approve`) | an admin approving FR-15.6 | `admin.settings` |
| **Engine page** | portal `/admin/sync` (name `admin.sync`), beside `admin/backup` | platform operators | the FR-13.26 `sysAdmins` allow-list |
| **This desktop's Sync view** | desktop app `--view=sync` (FR-14.32) | whoever sits at the desktop | local session |

The org page lives under `settings/`. Managing your own org's desktops is org self-service, in
the same way users and invites are. The engine spans every org, so it goes under `admin/`,
together with the other function that is not an org owner's to hold.

---

## 3. Requirements

### 3.1 The org Sync page (`/settings/sync`)

**FR-17.1 — Tabs:** Overview · Desktops · Conflicts · Dead letters · Runs · Changes · Numbering
· Settings.
- The active tab and every grid's filters, sort and page live in the URL (`useListQueryState`),
  so a link to "dead letters of Till-1" works.
- Route names are fixed once and never renamed, because `useGridColumns` keys per-user column
  preferences by route name.

**FR-17.2 — Overview.** A header states *"Sync is off for this org"* with **Enable** (see
FR-17.13), or shows the journal heartbeat age. Stat tiles:

- desktops online / stale / offline / paused / revoked;
- changes waiting to reach the hub (Σ reported);
- open conflicts;
- open dead letters;
- **the oldest unpushed sale**, with its desktop and age (FR-16.65);
- desktops needing a reconcile, with reasons;
- desktops below `minDesktopVersion`;
- bands ≥ 80 % used, and bands with a tail *"unaccounted after restore"* (FR-16.50);
- **projections pending and failed** in the `sync_outbox` (FR-16.36). A stuck projection means a
  pushed sale whose JE or stock effect has not happened yet;
- drift findings.

Every tile links to the filtered tab behind it. Under the tiles is a sparkline of runs, rows
applied each way, conflicts and dead letters over 1 h / 24 h / 7 d (PCON+'s summary chart), which
follows the `dataviz` conventions. A panel labelled **"What to look at when something is
wrong"** repeats `sync.md` §1's six questions, each linked to its answer on the page.

**FR-17.3 — Desktops table.**

Columns, each one toggleable in the column picker:

| Column | Content |
|---|---|
| Actions | the row actions menu (FR-17.4) |
| Desktop | name, code, presence dot (online / stale / offline, FR-15.12), `ephemeral` chip, copy-id |
| Status | active / paused / revoked, and reconcile-required with its reason |
| Mode | server / local |
| Version | app version, with an "update available" or "below minimum" chip |
| OS | platform, version, arch |
| Warehouses | assigned warehouse names; **"none — receives no stock data"** when empty |
| Workstation / fiscal devices | linked workstation code; bridged devices with their state |
| Last seen | relative time, absolute on hover |
| Last pull / last push | relative times |
| Waiting ↑ | changes reported waiting on the desktop, "as of" the report time |
| Behind ↓ | ≈ journal rows past the desktop's watermark. It is labelled "≈" because out-of-scope rows are counted. |
| Conflicts / dead letters | open counts, linking to the tabs pre-filtered |
| Clock | skew, flagged beyond ±2 min |
| Bands | per legal series: used % |

The **toolbar** has:
- **Register a desktop** (FR-17.6);
- **Update all**;
- a search over name, code, hostname and the warehouses assigned to each desktop;
- a status filter;
- an **include revoked** toggle, off by default (FR-15.19);
- the column picker;
- auto-refresh (10 s, on by default, pauses while a dialog is open).

**FR-17.4 — Row actions**, grouped the way roomler groups them:
- **Manage:** Details · Rename · Assign (warehouses, workstation, fiscal devices, start path,
  history window).
- **Sync:** Sync now (poke) · Pause / Resume · Reconcile.
- **Maintenance:** Update now · Rotate key.
- **Danger:** Revoke…

Every action that changes behaviour has a confirmation dialog **that states its consequence**:
- **Pause:** "sync stops; server mode keeps working".
- **Reconcile:** "the desktop is read-only until it finishes".
- **Revoke:** shows the desktop's last-reported waiting-change count and oldest unpushed sale,
  **"as of <time>"**, then offers wipe or no wipe with FR-15.18's wording, including *"a desktop
  that never comes back online never learns of the wipe"*.

**FR-17.5 — Desktop details** (a drawer):
- identity: name, code, installation, machine id, OS, hostname;
- credential: key epoch, last rotation;
- versions and metadata hash;
- capabilities: serial ports seen, local data on/off;
- assignment;
- scope summary: warehouses, window, and the synced collections with row counts as last reported;
- watermarks;
- the last 50 runs, the conflicts and dead letters involving this desktop, and its bands;
- its audit trail (FR-15.21).

**FR-17.6 — Register a desktop.** The dialog mints an enrollment code (FR-15.5). It shows:
- the code (`XXXX-XXXX`) with a live 10-minute countdown;
- a QR code of the `lgr://enroll` deep link;
- the defaults the desktop will receive: name, warehouses, history window.

It also gives short per-OS download links to the latest signed release (FR-14.4). The dialog
closes itself with *"Till-2 registered"* when the code is used, by polling the code's state. When
`ephemeralKeysEnabled` is on, a second section manages ephemeral keys: create with max uses and
expiry, revoke, and the per-use ledger.

**FR-17.7 — The approval page** (FR-15.6) shows what the machine reported about itself: name,
OS, hostname, public IP, time requested. It warns if the IP is far from the admin's own, and
lets the admin set the defaults. **Approve** and **Deny** are both audit-logged. An expired or
already-used code says so plainly.

**FR-17.8 — Conflicts tab.**

Columns:
- when, desktop, user;
- collection and document, with a link into the document's app via `appHref`;
- field;
- **base / hub / desktop values**, side by side, as JSON trees for arrays;
- policy, winner, status.

Actions:
- **Acknowledge**, singly or in bulk;
- **Re-apply the desktop's value.** The value is applied **through the normal online API, as the
  acting admin**, audit-logged and linked to the conflict. It is never a raw write, because a raw
  write would skip the derived effects the projections exist for (FR-16.36).

Filters: status (open by default), desktop, collection, date range.

**FR-17.9 — Dead letters tab.**

Columns:
- when, desktop, collection, op;
- **reason**, from one taxonomy: `validation`, `duplicate_key`, `foreign_org`, `immutable`,
  `hub_only_field`, `unknown_collection`, `too_large`, `projection_failed`;
- a payload preview.

Actions:
- **Retry**: re-apply after the cause is fixed.
- **Discard**: the origin desktop drops the change and gets the hub version (FR-16.42). The
  dialog says exactly that, and warns loudly when the change is a sale.

Both are audit-logged.

**FR-17.10 — Runs tab.** This is PCON+'s run log.
- **Filters:** desktop, direction (`hd` / `dh` / `rc`), status, date.
- **Columns:** when, desktop, direction, collections, read, applied, conflicts, dead letters,
  duration, status.
- **Run details** (a dialog): the per-collection breakdown, plus the conflicts and dead letters
  **produced by that cycle**, joined by `cycleId`.

**FR-17.11 — Changes tab**, a browser over the org's journal:
- **Filters:** collection, document id, origin (hub or a desktop), `seq` range, time.
- **Columns:** `seq`, op (upsert / delete / evict), origin, changed fields, time.
- **Paging** is keyset on `seq`, never skip/limit over tens of thousands of rows.
- The page states **plainly that values are not shown**. The journal records *that* a document
  changed and *which* fields, not the before and after (`sync.md` §2.1). PCON+ labels its spoke
  side the same way, so that an empty "values" column does not read as broken.

**FR-17.12 — Numbering tab.**
- **Bands** (FR-16.43): one row per band, showing desktop, series, year, `[from, to]`, next,
  used %, status (active / exhausted / retired) and the unused tail of retired bands.
- **The hub's own live range** is shown beside the bands.
- **Actions:**
  - **Propose a band**: FR-16.44's proposal, editable, validated against every other band and
    the hub's issued numbers;
  - **Confirm**;
  - **Retire**.
- **Continuity per band** (FR-16.46): for each band, the issued range and any absent numbers,
  with voided documents listed, not counted as gaps.

⚠ Bands are legally visible, so the tab heads its proposal dialog with *"numbers issued from a
band go into customers' hands and cannot be taken back"*.

**FR-17.13 — Settings tab** (the org's `sync_orgs` policy, FR-15.25):

| Setting | Detail |
|---|---|
| **Enable sync for this org** | Starts **seeding** as a `BackgroundTask` with progress (collections done / total, rows journaled). The page polls it. **Disable** stops serving pulls and pushes, keeps the journal, and needs a confirmation naming the desktops affected. |
| Default history window | |
| `minDesktopVersion` override | above the deployment minimum only |
| Ephemeral keys enabled | |
| Default band size per series | |
| Whether unassigned desktops may register | |
| Tombstone retention | shown read-only. A deployment setting, overridable per org by a sys-admin only (FR-17.19) |
| Dry run | shown read-only |

**FR-17.14 — Drift.** A panel on Overview, expandable. It lists:
- desktops whose metadata hash differs from the published one, with their version;
- hub collections dropped or renamed (from DDL events);
- anything a desktop reported as an unknown collection.

It shows the comparison time, and offers **Re-check** (FR-16.54).

**FR-17.15 — Live data.** P1 polls every 10 s while the page is visible. If a live channel is
added later, it authenticates the user's JWT in the first socket message. It MUST NOT copy
`/ws/tasks`, which trusts a `?userId=` query parameter and would stream one org's sync state to
anyone who guesses a user id.

**FR-17.16 — Server-side gate on every endpoint.**
- All `/api/org/:orgId/sync/*` and `/api/org/:orgId/desktops/*` routes run behind `AuthService`:
  deny-by-default, `isForeignOrg`, then an explicit `admin.settings` check in the handler.
- Anonymous callers get 401 from the unconditional guard. Cross-org callers get 403.
- The page adds no client-side gate that would pretend otherwise.

**FR-17.17 — Navigation and language.** "Sync" appears in the portal's Settings menu for
holders of `admin.settings`, below "Users". Every string exists in en/bg/de/mk. Numbers and
dates follow the org locale.

**FR-17.18 — The daily digest gains a "Desktops and sync" section** (FR-11), emitted only for
orgs with sync enabled:
- desktops not seen for more than 24 h;
- **desktops holding unpushed sales older than 24 h** (FR-16.65);
- open conflicts and dead letters, with counts and links;
- **failed or stale outbox projections**, meaning pushed documents whose JE or stock effect is
  still missing;
- bands ≥ 80 % used;
- desktops needing a reconcile.

A failure of the section renders as a visible line, never as an absent section (FR-13.6's rule).

### 3.2 The sys-admin engine page (`/admin/sync`)

**FR-17.19 — Engine page**, gated by the FR-13.26 `sysAdmins` allow-list (an empty list means
403 for everyone). It shows:
- **Tailer:** lease holder (pod) and lease expiry; heartbeat age; **lag** (now − last event
  `clusterTime`); **resume-token age against the live oplog window** (FR-16.58); journal epoch;
  recent tailer errors.
- **Per org:** enabled, `seq`, journal size, tombstone floor, desktops (active / online),
  waiting totals, last seeding.
- **State:** dry-run and tailer-enabled flags (read-only, since they are env settings).

It also shows the **outbox**: pending, running and failed projections per org, with the oldest
item's age and its last error.

Actions, each with a confirmation and an audit entry:
- **Re-seed an org**;
- **Set an org's tombstone-retention override** (FR-16.52). FR-18 uses it to shorten retention
  for `lgr-fieldtest`;
- **Retry a failed projection**;
- **Bump the journal epoch**, which forces every desktop of every enabled org to reconcile. It is
  labelled as the last resort.

### 3.3 The desktop's own Sync view

**FR-17.20 — This desktop's Sync view** (FR-14.32) works **offline**, from local state:

**Shows**
- registration (org, desktop, code);
- server link;
- mode;
- watermarks (`hub_seq`, last pushed and last acknowledged);
- last pull, last push, last error;
- **changes waiting, by collection** (from `_changes`);
- open overlays (`_pending_overlay`);
- conflicts and dead letters concerning this desktop (from `_conflicts` / `_dead_letters`, as
  last reported by the hub);
- its bands with usage;
- reconcile state.

**Actions**
- **Sync now**;
- **Reconcile**, when required or asked;
- **Export waiting changes**, to a file, for support or for FR-15.18's revoke-without-wipe;
- **Open logs**.

### 3.4 API

**FR-17.21 — Endpoints** (user-authenticated, `admin.settings` unless marked):

```
GET  /api/org/:orgId/sync/overview
GET  /api/org/:orgId/sync/series?metric&range                  sparkline buckets
GET  /api/org/:orgId/sync/runs?desktopId&direction&status&from&to&page
GET  /api/org/:orgId/sync/runs/:cycleId
GET  /api/org/:orgId/sync/conflicts?status&desktopId&coll&page
POST /api/org/:orgId/sync/conflicts/:id/acknowledge
POST /api/org/:orgId/sync/conflicts/:id/reapply
GET  /api/org/:orgId/sync/dead-letters?status&desktopId&reason&page
POST /api/org/:orgId/sync/dead-letters/:id/retry
POST /api/org/:orgId/sync/dead-letters/:id/discard
GET  /api/org/:orgId/sync/journal?coll&docId&origin&afterSeq&limit
GET  /api/org/:orgId/sync/bands
POST /api/org/:orgId/sync/bands/propose | confirm | :id/retire
GET  /api/org/:orgId/sync/drift        POST /api/org/:orgId/sync/drift/recheck
GET  /api/org/:orgId/sync/settings     PUT /api/org/:orgId/sync/settings
POST /api/org/:orgId/sync/enable       → BackgroundTask id (seeding)
POST /api/org/:orgId/sync/disable
GET  /api/admin/sync/engine                                    sysAdmins allow-list
POST /api/admin/sync/orgs/:orgId/reseed                        sysAdmins allow-list
PUT  /api/admin/sync/orgs/:orgId/retention                     sysAdmins allow-list
GET  /api/admin/sync/outbox?state&orgId                        sysAdmins allow-list
POST /api/admin/sync/outbox/:id/retry                          sysAdmins allow-list
POST /api/admin/sync/epoch                                     sysAdmins allow-list
```

The desktops endpoints are FR-15.23.

---

## 4. Edge cases and traps

1. **Hiding the nav entry protects nothing** (FR-13 trap 20). Every endpoint checks
   `admin.settings` itself. An e2e case drives the endpoints directly with a `member` token.
2. **"Behind ↓" is an estimate.** Journal rows past the watermark include rows outside the
   desktop's scope. Showing it as an exact count would send people chasing numbers that never
   reach zero.
3. **Counts from an offline desktop are stale by definition.** Every waiting or unpushed figure
   carries its "as of" time. The revoke dialog above all must not suggest the number is live.
4. **Re-apply is an online edit, not a sync write** (FR-17.8). A raw write would skip the JE,
   the stock and the audit projections, which is the exact failure FR-16.36 exists to prevent.
5. **The journal browser pages by `seq`.** skip/limit over regal-pz's roughly 54,000 journal
   rows degrades linearly and returns duplicates while the tailer writes.
6. **Conflict values are org data.** They are visible only to the org's admins, and never in
   the sys-admin cross-org page, which shows counts only.
7. **Route names are load-bearing twice**: in `useGridColumns` keys and in Playwright
   navigation (FR README global constraint 3). They are chosen once.
8. **Seeding a big org takes minutes.** Enable returns a task id at once, and the page polls it.
   A synchronous call would hit the ingress timeout, the lesson of FR-12's async jobs.
9. **Disabling sync with desktops holding unpushed sales** strands those sales. The disable
   dialog lists them and requires typing the org slug.

---

## 5. Acceptance criteria

1. `/settings/sync` renders for an org admin. Its data endpoints answer 403 for a `manager` and
   a `member`, 403 for another org's admin, and 401 anonymously. This is asserted in the e2e
   `security` project by driving the endpoints directly.
2. Register a desktop: the code counts down, the QR decodes to the deep link, and the dialog
   closes on use with the new desktop online in the table.
3. The Desktops table shows presence transitions (online → stale → offline) within 90 s of a
   socket drop. Clock skew beyond ±2 min is flagged.
4. Pause / Resume / Reconcile / Update now / Rotate key / Revoke each produce the backend effect,
   an audit entry, and the documented confirmation text. Revoke shows the waiting-change count
   with its "as of" time.
5. A conflict created by the FR-16 test harness appears with base, hub and desktop values.
   **Re-apply** changes the document through the online API, and the resulting JE/stock/audit
   equals an ordinary online edit.
6. A dead letter appears with its reason. Retry after the fix applies it; Discard makes the
   desktop drop it and converge.
7. The run-detail dialog shows exactly the conflicts and dead letters of its cycle.
8. The Changes tab pages through a seeded org's journal by `seq`, with no duplicates while the
   tailer is writing.
9. Numbering: a proposed band that overlaps another band, or the hub's issued numbers, is
   refused. Continuity per band shows absent numbers and lists voided documents separately.
10. Enabling sync seeds in the background with visible progress. Disabling lists the desktops
    affected.
11. `/admin/sync` answers 403 for everyone while `sysAdmins` is empty. It shows lag and
    resume-token age against the oplog window when populated.
12. The desktop's Sync view renders with the network unplugged, from local state only.
13. The FR-11 digest renders the "Desktops and sync" section for a sync-enabled org, and a
    forced failure of the section renders as a visible failure line.
14. Every string renders in en/bg/de/mk (no literal keys). `bun run build` green, and the new
    Playwright specs (FR-18) green.
