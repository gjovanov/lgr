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
    egress path), then proves the registration with a token and `/self`. A CA the OS store lacks (a
    TLS-inspecting middlebox's never deployed to the machine, or a test global's) is named by the
    service's own `LGR_SERVER_EXTRA_CA`, a PEM file, which the API's own calls to global trust too;
    one that holds no certificate stops the start;
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
- **Alarms (P3-8, FR-20.101).** The health frame also says the volume's size, how far back the
  oplog reaches (once it wraps: until then nothing is lost however long a capture stops), the
  server's clock (lgrai.app keeps the skew), its newest backup, the orgs it is fenced for, and what
  waits for the internet. From that and the mirror, lgrai.app raises: the mirror over an hour behind
  while the uplink is up, a backup older than 26 hours (or none, a day into serving its orgs), disk
  under 10 % free, an oplog under seven days, a fenced server, a clock over two minutes off. A
  frame older than ten minutes raises nothing. The Servers page shows a server's alarms (a lag only
  its own org's), and the Nodes page every master's, with its link and last backup.

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
- **The GitHub token is optional.** The repository is public: global reads a release anonymously and
  streams its files from their public download address (`github-release.ts`); a token only raises
  GitHub's API limit.

## Server updates (FR-20.20)

A master updates itself, with roomler's rules: versioned installs, two signatures, a maintenance
window, rollback from disk. Global's side (plan step P1-8a):
- **The release** (`server-release.yml`) publishes, beside the MSI, the .deb and the tarball, an
  **update bundle** per target: the whole home under one top-level directory (`.zip` on Windows, the
  tarball on Linux). Each has a minisign `.sig` with the desktop updater's key, checked in the
  workflow against the `updater.pub` a master's package carries, and a GPG `.asc`; the signing runs
  on a tag or any dispatch, so a dispatch proves the keys before a tag needs them.
- **The offer:** `GET /api/node/v1/server-release` (node token) names the version a human promoted
  (`SERVER_RELEASE_VERSION`; prereleases count, since the promotion is the gate) and, per target, its
  bundle with the `.sig`, the `.asc` and the sha256 inline. A target missing any of them is left out,
  and with none the answer is 204 (`node/server-release.service.ts`).
- **The bytes:** `GET /api/node/v1/server-release/<version>/<bundle>` streams that version's bundles
  and nothing else of any release.
- ⚠ Not a trust boundary either: the master checks every byte against keys built into its own
  package, and never takes a version older than its own.

The master's side, versioned installs (plan step P1-8b, `packages/server/src/{install,pointer,helper}.rs`):
- **One directory per version** under the install root (`C:\Program Files\LGR Server\`,
  `/opt/lgr-server/`): `versions/<v>/`, made only by `lgr-server update install-bundle`. A bundle is
  unpacked with the OS's own tar beside `versions/`, checked against its `HOME.json` (name, target,
  version, and the files and bytes it says it holds; no link leaving it), and renamed into place. A
  directory there is complete, or it is not there.
- **The packages carry the bundle, never a version.** The MSI and the .deb install a bootstrap and the
  bundle under `installer/` and run `install-bundle`, the code the helper uses. An upgrade leaves the
  previous version on disk to go back to, and Windows Installer and dpkg never delete one. The MSI's
  rollback runs `update undo` (a first install leaves nothing).
- **The pointers.** The service: `LGRServer`'s image path / `/opt/lgr-server/current`. The helper
  (`LGRServerUpdate`, LocalSystem; `lgr-server-update.service`, root): the last known good version,
  never the attempt, so a build that cannot start is not what rolls itself back. The Windows firewall
  rule follows the service's exe.
- **`update/state.json`** (SYSTEM's or root's, readable by the service): `current`,
  `lastKnownGood`, `previous`, the `attempting` switch (written before the pointer moves), and the
  versions that `failed`. Never a downgrade, never a version that failed, and two versions kept.
- **The watch.** After a switch the helper confirms the version once the supervisor and the API have
  run 5 minutes by the supervisor's own account, and goes back, from disk and offline, on 3 restarts
  in 10 minutes, on 3 minutes down, or with nothing clean by 20 minutes. It runs after every switch
  (the MSI starts it; the Linux unit pulls it in at every start) and at boot, and `reconcile` makes the
  pointers agree with the state after a crash.
- ⚠ **The service account may start the helper and nothing else** (its service DACL; the Linux unit is
  pulled in), and the helper reads nothing it acts on from the data directory, which that account may
  write (AC 59). Its view of the service's health comes over the supervisor's pipe, opened at
  identification level: the account holds SeImpersonate.
- The upgrade lane in `server-release.yml` proves it on the Windows runner (the MSI, the SCM) and
  under the Linux runner's systemd: an update confirmed, a broken one rolled back by itself and
  refused after, an uninstall that keeps the data.

Updates that come by themselves (plan step P1-8c, `updates.rs`, `helper.rs`, `signatures.rs`, `pgp.rs`):
- **The supervisor decides WHEN.** Every 5 minutes, and the offer every hour: an available version
  newer than the running home's `HOME.json` (and not one that failed) is installed only inside
  `UPDATE_WINDOW` (22:00–06:00 by default, the machine's own clock and zone), with no POS session
  open and no fiscal command in flight by the API's own account (one that cannot say is busy), and
  not within 10 minutes of a change of the LAN addresses. Then it wakes the helper: StartService
  (the service account's one right on `LGRServerUpdate`), or the file `lgr-server-update.path`
  watches (`/var/lib/lgr/run/update-wake`). `UPDATE_AUTO=off` stops all of it; `update apply` still works.
- **The helper decides WHAT.** It asks the supervisor (IPC `update-context`) for the gate, a node
  token and the supervisor's egress, and fetches the offer ITSELF through that egress (D-15: the
  supervisor owns every way out, so the machine's proxy rules apply). The bundle goes into
  `update/staging/`, capped at the offered size, then: its sha256 against the offer, the minisign
  signature against the updater key this binary carries, on Linux the release GPG key (roomler's
  subkey `5DB8221F…`, pinned), unpacked, on Windows WinVerifyTrust on the version's exe and a signer
  named exactly `G ROX LTD`, and the version read from inside the bytes, which must be the offered
  one. The gate is asked again before the switch: a till may have opened during the download.
- **Air-gapped:** `lgr-server update apply <bundle> --sig <file> [--asc <file>]`, the same checks on a
  copy made in `update/staging/`, switched now and watched.
- **Seven windows kept by open sessions** raise the alarm: the status's `update.alarm` and the
  health frame's `update`, and a logged error. Nothing is ever forced.
- ⚠ Nothing the supervisor says is trusted for WHAT is installed: a compromised service can only wake
  the helper early, or make it wait.
- **A backup first** (plan step P1-8d, FR-20.20's order: backup, migrations, health check). After the
  download is verified and the gate asked again, the helper asks the supervisor (IPC `backup-now`),
  which asks the API's control socket (`POST /backup`, the front secret, no idle limit): the OLD
  version, known to work, backs up every org homed here (`pre-update-backup.service.ts`: rows only,
  its own claim and file name so it never takes or overwrites a night's, mailed to nobody), written
  where every backup goes (the PV, the local copy, the off-site destinations). ⚠ No backup, no
  switch: the version stays installed and is switched to at a later chance. `update apply` does the
  same, unless `--no-backup` (a server that is not running); `lgr-server backup now` is the same
  backup, by hand.

## Licences (FR-20.55)

An org runs on its own server under a licence: a JWS that global signs, naming the org, the master
and the date it is paid through. A master verifies it with the public keys built into its package
(`packages/config/src/licence-keys.json`, which the supervisor reads too). A key rotates only through a
release.
- **Who is entitled** (`licence-issue.service.ts`): an Enterprise subscription that is active or
  trialing, paid through its period's end, or a pilot a sys-admin issued (`OrgLicence`,
  `/admin/licences`). The later date wins. A `past_due` subscription is not renewed, so its masters
  run into their grace from the last paid period.
- **Delivery:** in the uplink's `welcome` (interactive socket), then an `entitlements` frame when the
  terms change (re-checked every 10 minutes, at once on the pod where a pilot is changed) and once a
  day. The supervisor verifies each and keeps it in `<data>/state/licences/<orgId>.jws`; a licence
  issued earlier never replaces a later one. An air-gapped master takes a file:
  `lgr-server licence import <file>`, which a sys-admin downloads from the Licences page.
- **What it stops** (`licence-state.ts`, `licence-gate.ts`): nothing until the paid-through date plus
  30 days of grace. From the next local midnight after that, the master opens no till session and
  starts no new invoice, proforma, cash sale or client order (402 `licence_expired`). Everything else
  goes on: reading, exports, the SUPTO export, backups, closing the day, credit and debit notes,
  payments, bills, imports, issuing a draft, a session already open.
- **No licence at all** is a 30-day evaluation from the master's first start, then the same.
- ⚠ **Revoking a pilot stops renewals only.** A master verifies offline, so a licence it holds runs
  out on its own dates.
- Every app shows a banner while a master is on evaluation, in grace or restricted
  (`ui-shell/LicenceBanner.vue`, `GET /org/:orgId/licence`).

## Mail through lgrai.app (FR-20.59, FR-20.86)

A master holds none of the cloud's keys, so global sends its mail.
- **On the master**, `sendEmail` queues the mail in the `outbox` (node state) and answers `queued`;
  the EmailLog row says `queued` until global has sent it, and an emailed invoice's history is
  updated only then. The day's digest has a deterministic id per recipient
  (`digest:<orgId>:<date>:<userId>`), so a re-run queues nothing twice.
- **The worker** (`relay/outbox-worker.ts`, every 10 s) posts each due item to
  `/api/node/v1/relay/mail`, through the egress proxy, with the node token the supervisor keeps in
  `state/node-token.json` (`node_token.rs`, 15 minutes, refreshed every 10). It retries what
  cannot go yet (global down, rate limited, mail turned off) and fails what global refuses for good,
  or what is 7 days old.
- **Global** (`relay/mail-relay.service.ts`) sends it only when the org's admin turned mail on for
  that server on the Servers page (unset: on at Full, off at Control), for one of the server's own
  orgs, to one recipient, under 1 MB of body and 8 MB of attachments, within the server's limits
  (100 an hour, 500 a day), from global's own sender with the org's address as the reply-to.
- **Once:** a receipt per `(server, outbox id)` is claimed before the send and kept 7 days, so a
  retry whose answer was lost sends nothing. A failed send drops its claim, so the retry goes out.
- A backup's manifest mail attaches no more than the relay carries on a master (8 MB): over it, the
  bundle is left out with a note, rather than the whole mail refused (`attachmentCeiling`).

## Documents through lgrai.app (FR-20.59, plan step P2-6b)

A master's package carries no OCR sidecar and none of the model credentials, so its document import
(Files, doc-import, bill import) asks lgrai.app to read for it.
- **The same three steps** it would ask its own sidecar: text out of a PDF (`extract`, no model),
  an AI draft of a document's text (`draft`), AI line matching (`match-lines`). The OCR client
  (`doc-import/ocr-client.ts`) relays them when the process is a master with no `OCR_SERVER_URL` of
  its own, which every call site passes its org to.
- **A job, not a call**, because a draft takes up to 300 s, longer than a request through the
  ingress stays open: `POST /api/node/v1/relay/documents` answers 202, and the master polls
  `GET …/:requestId`. The same request id is the same job (`RelayJob`, node state), so a retry never
  runs the model twice; a job lost with lgrai.app's process (its lease passed) answers `lost`, and the
  master posts it again.
- **Global** (`relay/documents-relay.service.ts`) runs it on its own sidecar only when the org's
  admin turned documents on for that server on the Servers page (unset: on at Full, off at Control:
  the PDFs leave the shop, and drafts go to the model), for one of the server's own orgs, never under
  a clone alarm, within per-server daily caps (500 extracts, 200 drafts, 300 matches: the model runs
  on the subscription lgrai.app's own imports use), a 15 MB PDF and 200 000 characters of text.
  Only the answer is kept, for two days.
- Without the org's consent, or lgrai.app, the import says so per document. An EU VAT lookup, which
  needs a key a master does not have, answers 503 `lookup_unavailable` instead of "not found"; a
  Bulgarian EIK is looked up directly.
- **Extraction stays on the master when it can** (FR-20.88, plan step P2-6c, `doc-import/local-extract.ts`):
  text out of a PDF needs no model, so a master with poppler and tesseract (Bulgarian) reads it
  itself, offline, with the sidecar's own algorithm (the text layer from 40 non-space characters,
  otherwise every page at 300 dpi through `tesseract -l bul --psm 6`), and only the draft and the
  line matching go through lgrai.app. The deterministic parser reads most PlusMinus documents from
  that text alone. The .deb depends on poppler-utils, tesseract-ocr and tesseract-ocr-bul; a master
  without them (the Windows package, until it carries them) relays extraction as above.
  `LGR_PDF_TOOLS_DIR` names a directory of them instead of `PATH`.

## Sign in with LGR (FR-20.39)

A linked master's sign-in page offers the person's lgrai.app account first. It is an
authorization-code flow with PKCE, and lgrai.app is the identity provider:
1. The master's page keeps a PKCE verifier in the tab and sends the browser to lgrai.app's
   `/idp/authorize` with its node id, a redirect, a state and the S256 challenge.
2. lgrai.app's page uses the person's lgrai.app session from the tab, never a cookie (an org's
   address is same-site with lgrai.app, FR-20.72). It names the server and the org; on Continue it
   gets a code (`POST /api/idp/authorize`) and sends the browser back. A signed-out person signs in
   first and comes back to it.
3. The master redeems the code with its node token and the verifier
   (`POST /api/node/v1/idp/redeem`) for a 5-minute assertion signed by global's identity key
   (`IDP_SIGNING_KEY`). It verifies it with the key built into its package
   (`packages/config/src/idp-keys.json`), finds the membership it names, and issues its own session
   (`enterOrg`, method `lgr`).
- **A code is worth nothing alone.** It lives 60 seconds, is single use, and is bound to the server,
  its redirect and the challenge. Any mismatch spends it.
- **Redirects:** the desktop's `lgr://login`, a loopback address of the machine (the console, the
  desktop's own proxy), or an org's own address under lgrai.app. Always `/auth/idp/callback`.
- **A global password never reaches a master.** The assertion names the person (`iid`), the org,
  the membership, the email and the `tokenVersion`; the master's copy of the person catches up to
  that `tokenVersion`.
- Only for an org whose home is that master. A master that is not linked, or cannot reach lgrai.app,
  shows no button: its people use their local credentials (FR-20.40).
- **From the desktop:** the shell takes the flow over and runs it through `lgr://login` with its own
  PKCE pair, as it does an OAuth sign-in ([desktop.md](desktop.md#provider-sign-in-fr-1414)).

## People on a linked master (FR-20.42)

A master registered with lgrai.app (at Control or Full) is LINKED: its people are lgrai.app's.
- Their names, addresses and passwords are changed on lgrai.app and reach the master through the
  identity feed. The master refuses them with 409 `edit_on_lgrai`: an admin's edit of a person
  (`applyAdminIdentityEdit`), the person's own password change, and a forgotten password's request
  and reset. `/auth/me` names the lgrai.app to go to (`manageOn`), and the account page links to it.
- An admin on the master manages the MEMBERSHIP: role, permissions, operator code.
- `services/biz/node/link.ts#isLinkedMaster`: the supervisor keeps a node token for the API while
  the master is registered (`state/node-token.json`), run out or not. A master in an outage is still
  linked, and an edit waits for lgrai.app rather than splitting the person in two.
- An Air-gapped master owns its people and keeps today's behaviour (FR-20.41).

## The identity feed (FR-20.43, FR-20.44)

What changes about a master's people on lgrai.app reaches the master.
- Every 30 seconds the master asks `GET /api/node/v1/identity-changes?after=<cursor>` with its node
  token: the members of its orgs whose `Identity` changed after the cursor (`updatedAt`, then
  `_id`), oldest first. Every Identity writer moves `updatedAt`, so nothing has to remember to
  emit an event. A full pass from the start once a day catches what a raw write could have missed.
- It carries who the person is and nothing secret: email, names, `tokenVersion`, active. Never a
  password hash, an OAuth link or a reset token; a test scans the payload for their shapes.
- The master updates the people it holds (`identity-feed.service.ts`, cursor in `node_state`). A
  higher `tokenVersion` or a deactivation drops the person's cached session state at once, so every
  session they hold there ends on its next request. A `tokenVersion` never goes back down.
- An Air-gapped master has no feed: it owns its people (FR-20.41).

## Local credentials (FR-20.40)

When a shop's internet is down, its people sign in to their master with a local password, and at a
till with their operator code and a PIN. They set both on their lgrai.app account (*Servers in your
shops*), before the org moves too.
- **Global keeps only an argon2id verifier** (`OnpremCredential`, node state: no backup carries
  one). It is set with the person's own password, and a local password equal to the lgrai.app one
  is refused. A PIN needs an operator code in that org. Removing one leaves a tombstone, so the
  master hears of it.
- **The master's seal key.** The master's API makes an X25519 key once and keeps it in
  `node_state`. It puts the public half in `state/seal-pub.json`, and the supervisor signs that into
  its token assertions as a `seal` claim, with the node key. Global records the key only from such
  an assertion (`issueNodeToken`), so a proxy that sees a node token cannot substitute its own.
- **The credential feed.** On the identity feed's tick, after it, the master asks
  `GET /api/node/v1/credential-changes?after=<cursor>`. Each live credential of its orgs comes back
  sealed to its seal key (`crypto/node-seal.ts`: X25519, HKDF-SHA256, AES-256-GCM). The item's clear
  fields are bound in as associated data: the master, the person, the org, the kind, the
  `tokenVersion` and the time it was set. A dead one (removed, or set before a password change)
  travels as `sealed: null`.
  - ⚠ Unlike the backup seal, nothing about the plaintext is in the clear. That one's header has an
    unsalted SHA-256, which for a six-digit PIN's verifier would be no seal at all.
  - A value that does not open (lgrai.app sealed to a key this master no longer has) stops the pass
    without moving the cursor, until the next token signs the key in again.
  - A daily full pass removes a delivered credential that lgrai.app no longer has.
- **On the master** (`local_credentials`, `source: 'lgrai'`): its PIN sign-in takes them as it is,
  and a live local password replaces the copy of the lgrai.app password in `login()`, so the global
  one stops signing in there. Never through the tunnel (`x-lgr-source: tunnel`). One per person and
  kind: the newer wins, and the feed never removes one set on the master itself.
- **Ended** by a `tokenVersion` bump or a deactivation on lgrai.app: there at once, and on the master
  when the identity feed brings it (`dropDeadCredentials`).

## The mirror (FR-20.61–FR-20.66)

lgrai.app keeps a copy of every org homed on a master, which it shows read-only while the master is
offline (Q2). Only the master writes the org, and the copy follows it one way:
`services/biz/replication/`.
- **What replicates** is each model's own `replicate(schema, {class})` decision (P3-1a), generated
  into `db/replication/meta.generated.ts`. **R** (replicated) documents travel whole. **S** (split)
  ones only by their home's fields: `Org.slug`, `subscription` and `settings.integrations` are
  global's, `User.email`, the names and the password are the person's (global's), and
  `FiscalDevice.status` or a desktop's presence is true only where it was written. **N** and **G**
  never travel.
- **Capture** (P3-1b): one change stream on the master's database journals every write, whatever made
  it, into `repl_journal`, one row per document with its latest seq. It runs on a master linked at
  Full (the supervisor's registration says so) and stops when the link goes down, keeping the
  journal; `LGR_REPLICATION=on|off` overrides.
- **Pages** (P3-2a): the journal rows above global's watermark, each document as it is when the page
  is built, or a tombstone. BSON per document, zstd around the page, 1,000 documents or 4 MB at most.
  A hash chain ties each page to the one before it. A master continues only from a page it built
  itself, so a restored, reverted or cloned master cannot continue the chain global holds
  (FR-20.51). Global keeps where the mirror stands in `mirror_state`.
- **The apply** (P3-2a, on global): a page is refused whole, with an alarm, unless the sender is
  registered for the org (not revoked there, no clone alarm), linked at Full (FR-20.54: at Control no
  business data leaves the building), is its home at the page's epoch, and
  every row is a replicated collection of that org with its file paths under it (FR-20.66). Then one
  transaction: documents written by `{_id, orgId}` (`Org` by `_id`), split ones merged with
  global's own fields on the server, tombstones deleted, the watermark and the chain last. A
  Stripe webhook's write to `Org.subscription` survives every later page.
  - A unique key a stale document of the same org still holds is freed in the same transaction, and
    the master is asked to resend that document. A key another org holds refuses the page.
  - A membership naming a person the mirror never linked it to arrives without the link: it never
    lists the org for that person on lgrai.app (FR-20.63).
- **The transport** (P3-2b): the supervisor asks the master's API for each page over its control
  socket and sends it on the bulk socket, one page in flight per org, without reading it. Global
  answers with where the mirror stands, and the bulk `welcome` says it on every connection
  (FR-20.67). A page from behind or ahead starts again from there; another history, an older epoch
  or a chain this master never built stops that org until a re-seed (P3-7). A newer journal epoch
  that continues the chain is taken, and lgrai.app's copy reconciled (below). Its state is in
  `lgr-server status` (`bulk.replication`).
- **End to end, with real processes:** `packages/tests/src/two-node/mirror-e2e.script.ts` runs a real
  `lgr-server` (its own mongod, the built package's API) linked at Full to a local global behind T-1's
  TLS front and chaos proxy, cuts and throttles the link while the master writes, and ends with the
  mirror equal to the master document for document (about four minutes, by hand).
- **The files** (P3-3, FR-20.69): behind the documents, on the same socket. Once an org's pages are
  caught up, the supervisor asks which files the mirror lacks (`blob-sync`). Global answers from ITS
  OWN rows of that org, never from anything the master lists, so an answer cannot say what another org
  holds (FR-20.66). Each file goes up in 1 MB chunks the master's API reads by content and hashes
  before the first byte leaves. Global appends each chunk at its own offset, so a transfer resumes
  wherever it stopped. It names the file `<UPLOAD_DIR>/<orgId>/blobs/<sha256>` only once the file
  hashes to its name.
  - On lgrai.app, a mirrored org's documents, their earlier versions and its archived documents open
    from there, read by content and never where a row says.
  - Global's own copies from before a move are taken by their hash, never sent again.
  - An org may keep its files on its server only ("Files on lgrai.app" on the Servers page, the
    metadata-only option): its records are mirrored, and its files open only on the server.
  - A file the master cannot read is reported as missing there.
- **One document never stops the org** (P3-2c): a document lgrai.app cannot write (its id or a
  unique value belongs to another org there, or the database refuses it) is set aside, and the rest
  of the page applies. lgrai.app asks the server for it again, less often each time, and the page
  that finally writes it clears it. The Servers page lists what is set aside, and a move back waits
  for it.
- **Paced on the shop's line** (FR-20.52, P3-2c): a shop's upstream sits behind a router with a deep
  buffer, where a click waits behind every byte the mirror sent before it. While the mirror has work,
  the server measures that queue every two seconds on its interactive socket and holds the mirror
  back so it stays short, sending in pieces a quarter of a second long; it lets the mirror go faster
  again as soon as the line shows room. On a 512 kbit/s line with a catch-up under way, a click went
  from seconds (often timing out) to about a quarter of a second, and the catch-up took a fifth
  longer. `LGR_BULK_PACING=off` turns it off, for a line nothing else uses.

## Read-only where the org is not written (FR-20.75)

Every page of every app carries a banner while the org is not written where it is open:
- **On lgrai.app, for an org that lives on its server:** the banner names the server and says how
  current the copy is. It turns into a warning, saying since when, while the server is offline.
  Reads, reports and exports work; a write is refused, and says why in the reader's language.
- **On a server, for an org that went back to lgrai.app:** the copy the server keeps is read-only.
- **Anywhere, while a move is under way:** nothing can be written until it ends.
- **After a promotion (FR-20.81):** on lgrai.app, until the site's last numbers are recorded, that
  legal numbering waits; on the server it replaced, that the server writes nothing more of the org.

## Moving an org back to lgrai.app (FR-20.80)

An org admin moves the org back from its server on the Servers page ("Move back to lgrai.app"). No
copy travels: lgrai.app's mirror already holds the org, and the move waits until it holds all of it.
1. **Preflight**, every check at once:
   - the server is registered, linked at Full, connected and healthy;
   - no till is open and nothing prints there;
   - the mirror is live;
   - every file is on lgrai.app or on its way. A file the server cannot send blocks the move unless
     the admin leaves it behind.
2. **The server freezes the org** and waits until its last writes are captured, then reports how far
   its journal goes.
3. **lgrai.app catches up:** its pages up to that point, every file (an org that keeps its files on
   its server sends them now), then the server's digests of the org, compared with the mirror's
   whatever the order of fields.
4. **The files go back where their rows say**, and lgrai.app becomes the org's home again, one epoch
   up.
5. **The server keeps a read-only copy.** Its desktops are handed an instruction lgrai.app signed for
   each of them, and follow the org back on their own (a desktop older than this release says the
   org moved, and is paired again by hand).

Until the switch, an abort leaves the org on its server, which unfreezes it.

## A server whose database went back (FR-20.51)

A server restored from a backup, rolled back to a VM snapshot, or cloned onto another machine could
issue an invoice number the shop already gave a customer. So it locks legal numbering (sales
documents, cash sales, the fiscal devices' УНП) when:
- an organization is restored from a backup on it by Replace (a Merge, which only adds what is
  missing, locks nothing);
- its journal of changes is behind a mark it keeps outside the database, which only a database that
  went back in time can be: checked before it starts serving, and every minute;
- its journal is behind what lgrai.app's copy already holds of it: the mark lgrai.app keeps. This one
  catches a VM rolled back to a snapshot, whose own mark went back with the disk;
- lgrai.app holds changes of it that this database never sent: a database restored from a backup,
  which can no longer continue the copy;
- lgrai.app reports another machine connected as it, or refuses its history as one that went back;
- another machine on the shop's network answers as it, with its keys: a copy of its disk. The server
  looks every five minutes, and only a machine holding its keys can answer, so a stale or forged
  announcement on the network locks nothing.

On a server registered with lgrai.app, a restore by Replace is refused outright: it would take the
server back in time underneath lgrai.app's copy and then send that older history to it, deleting
there what the backup lacks. To go back to a backup, move the organization to lgrai.app and restore it
there. Merge stays available.

The server remembers that its database went back, so seeing it again after a person recorded the
numbers locks nothing more, and it tells lgrai.app every minute: the Servers page there marks it
"Database went back" and "Numbering locked", with the reason.

The page says why numbering waits, and a person records the last numbers off the last printed
documents and the fiscal device's report. Numbering resumes above them, and above lgrai.app's copy
when the server can ask it. Not yet: the fiscal device checked on its own.

### Re-seeding a server from lgrai.app's copy (FR-20.71)

A server whose database went back can no longer continue lgrai.app's copy of the organization: its
changes stop reaching lgrai.app. lgrai.app's copy is the newest complete one there is, deletions
included, so an org admin re-seeds the server from it on the Servers page ("Re-seed from lgrai.app's
copy", on the server's row while it is connected and says its database went back):
1. **lgrai.app checks** that the server is the organization's home, connected and healthy, with no
   till open and nothing printing, that it has a copy to give, and that the server's database really
   went back. Re-seeding a server that did not would replace newer data with older. The admin types
   the organization's address name.
2. **The server checks again**, freezes the organization, and keeps everything it holds of it in a
   file under its documents, for good. What it wrote that lgrai.app never received exists only there
   and on paper, so it also lists what of it lgrai.app's copy lacks, and the issued sales among it.
3. **It replaces** the organization with lgrai.app's copy, files included, and lgrai.app starts the
   copy's history again from the server's: nothing on lgrai.app is deleted.
4. **Legal numbering stays locked** on the server until its last numbers are recorded there: what it
   issued after the last change lgrai.app received is on paper and in the fiscal device only.

An abort puts back what the server held. Bringing the kept sales into the books is not done yet.

### Reconciling lgrai.app's copy (FR-20.70)

A server can lose the record of its changes without losing any data: its database's change history
no longer reaches back to where it stopped reading (it was down long, its database was upgraded), or
someone dropped a collection. It then starts a new journal epoch and sends every document it has
again. What it deleted meanwhile is in nothing it sends, so lgrai.app's copy is made equal to it:
1. **lgrai.app takes the new epoch** only if it continues the copy's history: the server still holds
   what lgrai.app last received, so its database did not go back (that is the re-seed's, above).
2. **The server asks lgrai.app for every document its copy holds**, a thousand at a time, and sends
   each again as it is on the server, or as gone. It keeps where it stands, so a cut goes on from
   there, and says when it asked them all.
3. **The copy is reconciled** once it has everything the server sent until then. The server wins,
   with one exception: an issued sale the server no longer has stays on lgrai.app, with an alarm,
   because nothing on a server deletes one, and a server without it lost it.

The server's numbering is not locked: it lost a record of its changes, not its data. The Servers
page says while the copy is made equal to the server again, and then when, how many documents went,
and which issued sales lgrai.app kept. A move back waits for it to end.

## Promoting lgrai.app's copy (FR-20.81)

When an org's server is lost for good, an org admin makes lgrai.app's copy the org's home on the
Servers page ("Promote lgrai.app's copy", on the home server while it is not connected). The danger is
not the changes lost: it is a server that is only cut off, still issuing invoice numbers in the shop
that lgrai.app would then issue again. So a promotion takes evidence:
1. **The server is gone:** connected on neither socket, and silent for 24 hours unless the admin
   attests the hardware is destroyed.
2. **The admin attests** that it is off or destroyed and that its tills are disconnected, and types
   the org's address name. The dialog says from when lgrai.app's copy is all there is, and that a
   server still running may issue numbers lgrai.app will issue again.
3. **The switch:** whatever files lgrai.app holds go where their rows say, and lgrai.app becomes the
   org's home, one epoch up.
4. **Legal numbering waits** (sales documents, cash sales, each fiscal device's УНП) until a person
   records the last number the site issued in each series, from its last printed documents and the
   fiscal device's daily report. Each series resumes above the higher of that and lgrai.app's own. A
   document that would take a legal number is refused before it moves anything; drafts, proformas
   and bills go on.
5. **If the old server comes back,** however late, it learns of the promotion and fences itself: it
   writes nothing more of the org and never resumes on its own. A server that was revoked cannot be
   told, so revoke one that was stolen, not one that may come back.
6. **What it did after the cutoff** is exported, unchanged, kept on the server and sent to lgrai.app
   (FR-20.84). The Servers page lists it for review: its sales and invoices by number, each new to
   lgrai.app, already there, or carrying a number lgrai.app has since given to another document.
7. **A person brings it into the books.** lgrai.app keeps every new sale and document exactly as the
   server wrote it, with where it came from, and books it as it would have: its stock (below zero if
   need be, since the goods left), its journal entry, its payments, its till session at its close.
   What lgrai.app already holds, a number it has since given to another document, a deletion, and
   anything it cannot book are left for a person, each listed with why.

Replacing a dead server is a promotion followed by a move to the new machine, whose desktops are
paired again.

## Moving an org to its master (FR-20.79)

An org admin moves the org from lgrai.app to one of its servers on the Servers page ("Move here", on
a server linked at Full). lgrai.app runs the move (`services/biz/move/move.service.ts`, its record in
`org_moves`), and the server takes it (`move-worker.service.ts`, which asks every 10 seconds).
- **Preflight**, every check at once: the org is written on lgrai.app and no other move is under way;
  the server is registered for the org at Full, has no clone alarm, has given lgrai.app its seal key,
  is connected on both sockets, reported healthy in the last 3 minutes and has 1 GB free; no till
  session is open, no fiscal device printing, no job running; and every member has set a local
  password for the server, or the admin names each one who may arrive without it.
- **The freeze**: the org's home record on lgrai.app goes to `freezing`, so the home gate and the
  write guard refuse every write of its data. The copy waits twice the home cache's lifetime (10 s),
  so no process still acts on a cached "home is here", then revokes the org's desktop enrollment codes
  and keys, which a pod could have minted on a cached "active" in between.
- **The copy** (`move-bundle.ts`): every replicated and split collection of the org, one canonical
  EJSON line per document read with `promoteValues: false`, so a whole `Double` stays a `Double` and
  the master's first pages carry the same types as the mirror. Then the org's people and their local
  credentials, then a trailer with each section's count and sha256. With it, the org's files.
  - Never in it: password copies and OAuth links, `Org.settings.integrations`, FR-20's node state,
    the node-owned fields of split documents (`User.lastLoginAt`).
  - **The people** travel as who they are (email, names, `tokenVersion`, active), never their
    password, OAuth links or other orgs. A master signs people in against its own copy of them, and
    its identity feed only updates people it already holds, so without them nobody could sign in.
  - **The local credentials** travel sealed to the server's seal key, as the credential feed seals
    them (FR-20.40). The feed alone would not do: it skips people a master does not hold yet and
    moves past them, so they would arrive only with the next daily full pass.
- **The import** on the server: the org's home there is `frozen` at the move's new epoch; the copy is
  downloaded with the node token, checked against its sha256, and imported into an EMPTY org with
  raw writes. It refuses an org the server already holds data of, and a person whose email someone
  else holds there. A person it holds already (a member of another org there) keeps their record,
  their `tokenVersion` only raised. The credentials are opened with its seal key, the files restored,
  and both feeds run from the start on their next tick, for what changed while the copy travelled.
- **Verify and flip**: the server answers with the digests of what it now holds, and how many of the
  copy's people and credentials it has. Equal to lgrai.app's, collection by collection, the flip runs
  in one transaction: the epoch up by one, the home the server, `homeEpochHighWater` with it, and the
  mirror's chain reset. lgrai.app then closes the server's bulk socket (4410 `home_changed`, any other
  pod within 30 s), so the pump's next welcome names the org. The org's home on the server becomes
  `active`, its capture journals the org, and the first pages re-send what the copy holds, which is
  idempotent, on a chain that starts at the move. lgrai.app keeps the documents as the mirror.
- **Abort**: until the flip, an admin's abort, a copy that fails, or digests that differ unfreeze
  lgrai.app, and the server removes what it imported (of the people, only those it added that no
  other membership there points at).
- ⚠ **The audit trail is org data**: lgrai.app writes the move's entry before the freeze (so it is in
  the copy), an abort's after the unfreeze, and the server records the arrival once the org is home
  there; it reaches lgrai.app with the mirror.
- **The desktops follow** (FR-20.82): lgrai.app tells each of the org's desktops where the server
  answers on the shop's LAN and which CA to pin there, in an instruction signed for that desktop
  alone, at the flip and whenever the desktop next connects. The desktop keeps its id and its key:
  its registry row moved with the org, so nothing is enrolled again. The server's health reports say
  where its LAN ingress answers; when lgrai.app does not know, the desktop is only told that its org
  moved, and offers to pair. Nothing of a moved org's desktop is written on lgrai.app.
- The move back to the cloud, promotion, the fenced export and its import are above. **Not yet**: a
  legal number issued twice, resolved by a credit note and a re-issue.

## Not built yet

FR-20's P1 to P3:
- the server updater (the installers are P1-7's, `docs/guides/server-install.md`);
- the setup console's step for the registration code (`lgr-server register` does it today);
- what else travels on the uplink: replication (P3); the other relayed services: EU VAT lookups,
  invitations to an on-prem org (plan A.6.8, with the move), off-site backups, reference data;
- reading documents without the internet on Windows: the package carrying poppler and tesseract
  (P2-6c did Linux, where the .deb depends on the distribution's);
- the tunnel; the mirror's transport, pacing, files, dead letters, re-seed and reconcile are above;
- the rest of the moves: a legal number a fenced server and lgrai.app both issued, resolved by a
  credit note and a re-issue (FR-20.51; everything else of the moves is above);
- setting a local credential on the master itself, right after a Sign in with LGR, and sending it up
  for a replacement master (FR-20.40).

[desktop.md](desktop.md) describes the desktop as it is today: a client of the cloud.
