# Nodes — the server model after FR-20's P0

**Status:** what exists on `master` after FR-20's P0 (October 2026). Production runs one node,
`global`, and every org's home is global, so nothing below changes how lgrai.app behaves today.

The target (on-prem masters, the mirror, the tunnel, moving an org) is in
[FR-20's plan, Part A](https://github.com/gjovanov/lgr/blob/feat/fr-20-offline/docs/fr/FR-20-IMPLEMENTATION-PLAN.md#part-a--architecture),
and is not built.

Specification: [FR-20](https://github.com/gjovanov/lgr/blob/feat/fr-20-offline/docs/fr/FR-20-offline-lan-master.md)
· Tracking: [gjovanov/lgr#159](https://github.com/gjovanov/lgr/issues/159)

## The node role

`LGR_NODE_ROLE` is `global` (the default) or `master`; anything else refuses to start
(`config/src/index.ts`). Code asks `nodeRole()` from `config`, never a host name or another
variable.

## Org homes

Every org has one **home**: the node that holds the authoritative copy of its data and is the only
one that writes it.

- **The record.** It is a row in `org_homes` (`OrgHome`): `{ orgId, home: 'global' | <nodeId>,
  epoch, state, since, changedBy }`. **No row means `global`, epoch 0**, which is every org today.
  `OrgHome` is node state, not tenant data: it has no `tenantPlugin`.
- **States.** `state` is `active`, `freezing`, `frozen`, `fenced` or `hold`. Only `active` writes.
- **It fails closed.** A row that disagrees with `Org.homeEpochHighWater`, or a missing row once
  that is set, reads as `hold`.
- **`db/home/home.ts`** reads it:
  - `homeOf(orgId)` answers from a 5-second cache, which `forgetHome` clears and `{ fresh: true }`
    skips;
  - `isHomeHere(orgId)`;
  - `assertHomeIsHere(orgId)` throws `HomeElsewhereError`.

## Where a write is refused

Three layers, from the outside in.

1. **The route gate.** The auth plugins run `services/biz/home-gate.ts#homeGate` right after
   `isForeignOrg`, on every route, with no exception list.
   - Off an org's home, a route that writes answers **409** `{ code: 'org_home_elsewhere' }`.
   - What writes is decided by `services/biz/route-class.ts`. A GET reads; anything else writes,
     except the POSTs in `READ_ONLY_WRITES` (reports, list exports). A route listed there must
     write nothing.
2. **The request context.** Every API request runs in a context (`db/home/request-context.ts`)
   that names its route and org. A write inside a read-only route is recorded.
   - Off the org's home, that write is refused, unless the route is in `GET_WRITERS`. Each route
     there checks the home itself.
   - At home, an unlisted one is logged, and `reads-that-write.flow.test.ts` walks every GET route
     and fails on it.
3. **The write guard.** `tenantPlugin` installs it on every org-scoped model
   (`db/home/write-guard.ts`).
   - **What it refuses**, with `HomeElsewhereError`, when the org's home is elsewhere:
     - `save` and `insertMany`;
     - every update, delete and `findOneAnd*`;
     - `bulkWrite`;
     - an update that moves documents into an org.

     That covers services, sweeps and scripts, not only routes.
   - **Legal numbers.** `Sequence` writes, which allocate every legal number, read the home fresh,
     never from the cache.
   - ⚠ **Raw driver writes (`Model.collection.*`) bypass the guard.** Each one is listed in
     `home-write-guard.flow.test.ts#RAW_WRITE_SITES`, and is either guarded by `assertHomeIsHere`
     or exempt with a reason. A new one fails that test.

## Writes that cross orgs

`homeScope()` (`db/home/home.ts`) returns the filter that keeps a multi-org write to the orgs homed
on this node:
- `{}` on global today;
- `{ orgId: { $nin: away } }` once an org lives elsewhere;
- `{ orgId: { $in: mine } }` on a master.

`homeScope('_id')` scopes a loop over `Org` itself.

**Where it's used:**
- the identity fan-outs: a password change reaches every membership of the person;
- the boot-time fiscal device reset;
- retention;
- the migrations runner;
- the schedulers: the daily digest, backups, the desktop reaper and the orphaned-task sweep.

An unscoped multi-org write is refused whole by the write guard as soon as one org lives
elsewhere.

**Joining an org refuses one homed elsewhere** rather than filtering it. That covers an invite,
registration, OAuth sign-up and desktop enrollment.

## Scripts

A script that opens the database checks the home **before** it writes, through
`scripts/lib/home-guard.ts`:
- **`assertScriptHome(orgId)`**, for a `--org` script. Off the org's home it exits with code 2,
  having written nothing.
- **`keepHomeOrgs`**, for a script that walks every org. It skips the orgs homed elsewhere, and
  stops if a NAMED org is one of them.
- **`tenantHomeScope()`**, for a collection sweep.

`unit/scripts-home-guard.test.ts` fails a script in `scripts/` that opens the database without
one.

## Data migrations

A data change a release needs is a versioned migration in `packages/migrations`, never a script
run by hand.
- **The registry.** `src/registry.ts` lists them in order. Today there are four:
  `0000-baseline`, `0001-unp-per-device`, `0002-file-sha256` and `0003-relative-file-paths`.
- **The runner** runs the pending ones under a lock, records each in `_migrations`, and takes only
  the orgs homed on this node.
- **Running them:**
  - `bun run migrate` runs them by hand, and `--status` lists them;
  - with `MIGRATIONS_AUTO=true`, the server runs them before it listens. That is off by default,
    so global runs them by hand after a deploy.
- **Never edit a released migration.** The runner refuses to start when an applied one has
  changed. A fix is a new migration.
- **Every migration is idempotent.** `migrations.flow.test.ts` re-runs each on a seeded database
  and expects no change.

## Node state stays out of backups

`db/home/node-state.ts#NODE_STATE_MODELS` names the models that describe this node rather than an
org's data: `OrgHome`, `BackgroundTask` (whose owner is a process), and global's registration of
masters (`NodeEnrollmentCode`, `NodeEnrollmentKey`, `NodeEnrollmentKeyUse`).
- They are left out of every backup bundle.
- A restore skips such a section, even from an older bundle that carries one.

A bundle restored on another node therefore never says who is home.

## Stored file paths

`File.storagePath` and `DocFile.currentPath` are paths relative to `UPLOAD_DIR` (`<orgId>/…`),
so that a node with a different upload root can read them
(`services/biz/files/stored-path.ts`).

- **Every reader goes through `resolveStored(stored, orgId)`.** It takes either form, and maps a
  legacy absolute path from a known root onto this node's root. The known roots are this
  server's, `/app/uploads`, and `UPLOAD_LEGACY_ROOTS`. It refuses `..`, drive letters and another
  org's tree.
- **Every writer stores the relative form.** Migration `0003-relative-file-paths` rewrites the
  rows written before. A `File` row follows its bytes when the Files app moves them.
- **0003 reads the files,** so it runs where the uploads volume is mounted. It repoints a `File`
  row that a document move left behind, and lists the rows with no bytes and no document. It
  never deletes them.
- **Rollback.** Once 0003 has run, a node rolls back only to a release whose readers take both
  forms.
- **`File.sha256`** is recorded at upload. Migration `0002-file-sha256` backfills it from the bytes
  on disk.

## Masters registered with global (FR-20.2)

Global keeps a registry of the masters that may link to it (`ServerNode`, collection `nodes`), and
nothing of it exists on a master: every route below is 404 there.
- **A node is recorded under its own id,** `master-<16 base32>`, which its supervisor made once in
  `state/node.json`. Global records it and never hands out another; `org_homes` names the same id.
- **Registering takes a code and a proof.** An org admin mints a single-use code on the Servers page
  (`POST /api/org/:orgId/nodes/enrollment-codes`, 10 minutes). The master's setup sends it to
  `POST /api/node/v1/enroll` with its id, its installation id, its Ed25519 public key, and a
  `proof`: an assertion by that key (`sub` = its id, `aud` = the enroll URL, at most 60 s, a
  `jti` never seen before).
  - The code is claimed by a conditional update, so of two masters racing for it one registers.
  - Every refusal is the same message.
- **Tokens:** `POST /api/node/v1/token` takes an assertion and returns a 15-minute HS256 token signed
  with `NODE_TOKEN_SECRET`. That secret is global's only: it is required in production there, and
  empty on a master.
- **`NodeAuth` denies by default** on `/api/node/v1/*` and re-reads the row on every request. A
  revoked node, or one registered again with a new key, is refused at once.
- **One node, several orgs.** A second org joins only through the node itself, since the proof needs
  its key. The same id with another key is refused with `node_exists`; the same key from another
  installation with `installation_mismatch`; another active node on the same installation with
  `installation_in_use`.
- **Revocation is per org.** An org's admin takes their org off a node, and the node is revoked only
  when no org is left on it, so one org can never cut another org's server off.
  - ⚠ Those routes write global's registry, not the org's data. The home gate lets them through
    (`GLOBAL_STATE_WRITES`), because revoking a lost master is exactly when the org's home is that
    master.
  - ⚠ A node acts for an org only while the org is in its `orgIds`. Whatever it later sends for an
    org (the uplink, P2-2; mirror pages, P3) must be checked against that, not only against the
    org's home: a revoked master's id can be registered again, for another org.
- **The master's side** is `lgr-server register --code XXXX-XXXX` (`--server`, `--link control|full`,
  `--name`). The command only passes the code; the running service does the rest:
  - its key is `keys/node.key` (`node_key.rs`), sealed with DPAPI at machine scope on Windows and a
    `0600` file elsewhere. It is made once, and a file that does not open is a refusal, never a new
    key;
  - it makes its installation id once, in `state/installation.json`;
  - it calls global through the machine's proxy rules and the OS trust store (`https.rs`, the API's
    egress path), then proves the registration with a token and `/self`;
  - what global answers is kept in `state/registration.json` and shown by `lgr-server status`.
  Run it again with another org's code to add that org.
- **The field lanes** register with reusable keys, gated by `Org.settings.node.ephemeralKeysEnabled`.
  Their nodes are reaped after 24 h of silence, not the desktops' 15 minutes, so a master cut off on
  purpose survives the cell. A shop's master stays permanent even when a key adds another org to it.

## The uplink, global's side (FR-20.52)

A registered master holds two sockets to global, `wss://lgrai.app/api/node/v1/uplink?ch=interactive`
and `…?ch=bulk` (`portal-api/src/websocket/uplink.ts`, mounted on global only).
- **The URL carries no credential.** The first frame is `hello`, with a node access token, the
  URL's channel and the supervisor's per-boot `bootNonce`. It must arrive within 10 s, and nothing
  else is heard before it.
- **Global answers `welcome`:** the server time, the lowest master version it talks to, and per org
  its home, home epoch, state and link level.
- **The master pings every 30 s.** A socket silent for 75 s is dead (4408).
- **Every 30 s global re-reads the node's row.** A revoked node gets 4403, which stops the uplink
  and never the shop; a new key gets 4401, so the master authenticates again. A revocation also
  tells the node's sockets at once.
- **Presence** is one row per node and channel in `node_presence`; its unique index is the clone
  check.
  - The same supervisor reconnecting carries the same `bootNonce` and takes its own place back. Its
    older socket is closed 4409.
  - A holder silent for 75 s is dead, and any boot may take its place.
  - ⚠ A second LIVE connection with another `bootNonce` is a clone (FR-20.8, FR-20.51): a cloned
    disk, or a restored copy running beside the original. Both sockets get `clone-alarm` and are
    suspended (`isTrusted` is false), and the node keeps `cloneAlarm`. The alarm stands across
    reconnects until an admin revokes the node and the real machine registers again.
- The front nginx's `location /` already carries WebSocket upgrades, with a 300 s read timeout that
  the 30 s pings keep open.
- **The supervisor's side** (`packages/server/src/uplink.rs`) is one task per channel, for as long
  as it runs:
  - Unregistered, it waits; `lgr-server register` wakes it at once.
  - To connect, it fetches a token and opens the socket on the TLS stream `https.rs` makes,
    through the machine's proxy rules and the OS trust store.
  - It pings every 30 s, and replaces a socket that hears nothing for 75 s.
  - 4403 stops the uplink until the master is registered again, and never stops the shop. Other
    failures back off with full jitter, 1 s to 5 minutes.
  - `lgr-server status` shows each channel, and `CLONE ALARM` when suspended.
- **Control (P2-3a).**
  - `health` every 60 s on the interactive socket: versions, uptime, the children's states, the
    data volume's free space, and the API's account (ok, open POS sessions, receipts in flight,
    clock trust).
  - Global keeps the latest on the node, sanitised (known fields only, bounded, at most one per
    20 s, never from bulk or a suspended socket). The Servers page shows it with each channel's
    presence and the clone alarm.
  - A master older than `NODE_MIN_MASTER_VERSION`, or naming no version, gets `master_outdated`.
    It stays connected for its update, and `isTrusted` is false.
  - `/admin/nodes` lists every master across orgs, for the `BACKUP_SYS_ADMINS` allow-list.

## Desktop updates through the master (FR-20.56)

A master keeps the desktop release for its tills, so they update with the internet down and the
GitHub token never leaves global.
- **Every 6 hours** (and at once after a registration), the supervisor asks global which release is
  current: `/api/node/v1/desktop-release`, with its node token, returns the version, its files and the
  updater signature per platform. It downloads the files it lacks through the public
  `/api/desktop/download/<version>/<file>` (`packages/server/src/desktop_releases.rs`).
- **The layout:** `<data>/desktop-releases/<version>/` holds the files and their `release.json`, and
  `current.json` names a version only once all of its files are whole. The current and the previous
  version are kept.
- **The master's API** (`release-cache.ts`, `LGR_DESKTOP_RELEASES_DIR`) answers its tills'
  `/api/desktop/v1/update`, `latest-release` and `/api/desktop/download/*` from that directory, linked
  on its LAN address.
- ⚠ **Nothing in this chain is a trust boundary.** Each till verifies the updater signature against
  a key pinned in its binary. What is checked here protects the shop's disk: versions, names, sizes
  and paths.

## Not built yet

FR-20's P1 to P3:
- the installer and the server updater;
- the setup console's step for the registration code (`lgr-server register` does it today);
- what else travels on the uplink: the licence (P2-3, waiting on Q4), replication (P3);
- the mirror and the tunnel;
- moving an org between homes.

[desktop.md](desktop.md) describes the desktop as it is today: a client of the cloud.
