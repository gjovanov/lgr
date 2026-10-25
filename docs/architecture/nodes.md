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
- Next (P1-8d): a backup before the switch (the old version's API takes it, before the new one migrates).

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

## Not built yet

FR-20's P1 to P3:
- the server updater (the installers are P1-7's, `docs/guides/server-install.md`);
- the setup console's step for the registration code (`lgr-server register` does it today);
- what else travels on the uplink: replication (P3); the other relayed services: EU VAT lookups,
  invitations to an on-prem org (plan A.6.8, with the move), off-site backups, reference data;
- reading documents without the internet: a master's own text extraction (pdftotext), for the
  deterministic parser that reads most PlusMinus documents without a model;
- the mirror and the tunnel;
- moving an org between homes, which also delivers the people's local credentials, and then
  carries no copy of their lgrai.app password (FR-20.39);
- setting a local credential on the master itself, right after a Sign in with LGR, and sending it up
  for a replacement master (FR-20.40).

[desktop.md](desktop.md) describes the desktop as it is today: a client of the cloud.
