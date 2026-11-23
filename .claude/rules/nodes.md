---
paths:
  - "packages/server/**"
  - "packages/desktop/**"
  - "packages/desktop-ui/**"
  - "packages/db/src/home/**"
  - "packages/db/src/replication/**"
  - "packages/services/src/biz/home/**"
  - "packages/services/src/biz/node/**"
  - "packages/services/src/biz/move/**"
  - "packages/services/src/biz/replication/**"
  - "packages/services/src/biz/relay/**"
  - "packages/services/src/biz/licence/**"
  - "packages/services/src/biz/idp/**"
  - "packages/services/src/biz/desktop/**"
  - "packages/portal-api/src/front/**"
  - "packages/portal-api/src/controllers/desktop*"
  - "packages/tests/src/two-node/**"
  - "packages/migrations/**"
  - "scripts/build-server.ts"
  - "scripts/check-package.ts"
  - "scripts/lib/server-package.ts"
  - "scripts/seed-fieldtest.ts"
  - "scripts/data-scan.ts"
---

# Rules and traps: Nodes: masters, the supervisor, the mirror, desktops

Every ⚠ and every never/always rule of this area's history, copied whole with the bullet it sits in, by section.
Why each one exists, and what was built around it: [`docs/history/nodes.md`](../../docs/history/nodes.md).
`unit/claude-md.test.ts` fails when a ⚠ of that history is in neither this file nor `CLAUDE.md`.

## The server package (FR-20.25/FR-20.26, plan step P0b-9)

- ⚠ **`Bun.build` inlines `process.env.NODE_ENV` as "development"**, even with `env: 'disable'`: every
  production guard compiles to false (the bundle STARTED with no `JWT_SECRET`). Server code is only ever
  bundled through `serverBuildOptions()`, which defines it to itself.

- ⚠ **A bundle has nothing beside the source.** An asset is IMPORTED: CSS/text `with { type: 'text' }`,
  a binary `with { type: 'file' }` resolved against `import.meta.dir` (relative once bundled), data as a
  JSON import. Never `readFileSync(new URL('../x', import.meta.url))` or `createRequire().resolve()`:
  every PDF failed with ENOENT on `assets/markdown.css`. One file cannot be imported as text AND as code
  in one bundle ("No matching export").

## The two-node harness (FR-20 plan Part F.2, step T-1)

- ⚠ WebSocket close codes 1005/1006/1015 are only ever REPORTED: passing one to `close()` throws, and
  in the front's close handler that broke the next upgrade. `tls-front.ts#sendable` maps them.

- ⚠ Lifting a blackhole closes the connections that went silent, or a client's pooled connection
  hangs its next request: a blackholed TCP connection is dead to its client.

## The synthetic field-test org (FR-20.112/113, plan step T-2)

- ⚠ Nothing real: names from word lists, ЕИКs with a deliberately WRONG check digit, every e-mail
  under `.invalid`. A new org has no accounting defaults (`settings.accounting`), so the event
  handlers journal nothing: no entries, as for an org that only invoices.

- `scripts/data-scan.ts`: `--export` against production (native driver, so no index builds) lists
  every org but the synthetic ones (field-test, `acme-corp`, `beta-inc`); `--denylist <file>` against
  a throwaway refuses on any of their ids (as ObjectIds or inside strings) or slugs (as words).
  ⚠ The DEMO seed creates an org with the slug `regal`, a real customer's: never run it on a
  throwaway, the scan rightly flags it.

## The API behind the supervisor (FR-20 plan step P1-3)

- `Host` on the list, else 403. Any IP literal and `localhost` are on it, since DNS rebinding
  always arrives under a name;

- ⚠ A registration stamped `console` on a master makes the founder ACTIVE, with no activation
  mail (FR-20.17, #350). The console exists only during setup, on loopback, behind the one-time
  token. An invite through it still needs the email. Gated on `nodeRole() === 'master'` AND
  `frontSource()`, which is `undefined` with no front, so a forged header on global does nothing.

- **Setup is the supervisor's** (`packages/server/src/setup.rs`, its page `setup_page.html`, served
  at `/__lgr/setup/app` on the console, never by the API). It chooses the link level, opens the LAN,
  sets the backup copy, then writes `state/setup-complete`, which closes the console and opens the
  tunnel. Its choices live in `state/setup.json`, UNDER `config/api.env` (the operator's line wins,
  and setup never edits that file). It applies them by restarting the supervisor IN ITS OWN PROCESS
  (`supervisor::RELOAD`), so the service manager counts no restart (#369). The control socket's
  `GET /setup` tells it which orgs are homed here (their owners become `BACKUP_SYS_ADMINS`) and how
  many desktops are paired. `lgr-server setup reset` reopens it with a new token.

- ⚠ A console session is derived from the token (`front::setup_session`) so that it survives
  that restart. Never the token itself in the cookie.

- ⚠ Never run `cargo fmt` in `packages/server`. There is no rustfmt config, CI runs only clippy,
  and the crate is written in long lines: fmt rewrites all 36 files.

- ⚠ This is the one `X-LGR-*` header the LAN ingress carries over from the client. It is a
  credential the API verifies, never a stamp it trusts.

- ⚠ Bun 1.4.4 on Windows serves HTTP on an AF_UNIX path, but not on a named pipe (ENOENT). A
  path longer than 108 bytes fails with ENAMETOOLONG.

⚠ On Windows, CTRL_BREAK ends Bun at once with `0xC000013A` and runs no handler. Under the
supervisor, the socket is the only graceful stop.

- a POS sale's and a storno's whole print sequence is one `fiscalOperation`, so a stop never lands
  between "open receipt" and "close receipt".

## The supervisor, `lgr-server` (FR-20 plan step P1-1)

- **Backoff** (`backoff.rs`, roomler's numbers): 2 s doubling to 60 s, reset after 30 s up. Exit
  **7** (configuration) and **8** (refused on purpose) are never retried, by it or by systemd
  (`RestartPreventExitStatus=7 8`); a clean `0` is a failure like any other.

- **The API's environment is built, never inherited** (`config.rs`): OS basics, then `HOST`/`PORT`
  /`UPLOAD_DIR` defaults, then `<data>/config/api.env`, then the API's own keys
  (`<data>/keys/api-secrets.env`, made on first boot, never rotated here), then what nobody
  overrides: `NODE_ENV=production`, `LGR_NODE_ROLE=master`, `LGR_UI_ROOT`. A master never gets the
  cloud's secrets (D-12).

- **Children run in a Job Object (Windows) / their own session (Unix)**, so Chrome's helpers die with
  the API. ⚠ A test child must die of an ordinary stop: `ping` takes Ctrl+Break as "print
  statistics" and carries on (the tests re-run their own binary as `child_sleeps`).

Both are clean on every OS, console or not, and a signal is the fallback. ⚠ Under the SCM there is
no console, so CTRL_BREAK cannot be sent and that fallback is the job, at once. Stopping
everything at once let `mongod` go first, under the API's last writes.

- ⚠ A bare tmp + rename survives a crash, not a power cut. ext4 (delayed allocation) and NTFS put
  the rename on disk before the data, so a cut seconds after a first start left an empty
  `node.json` or a half `api-secrets.env`, and either is exit 7 for good.

- It goes in `state/address-conflict.json` and the status, NEVER `clone.json`. That one locks legal
  numbering, and only the TLS proof may write it.

- Detection only: the supervisor never announces the address.

- ⚠ **A copy at THIS address is read off the wire** (#380, `mdns_wire.rs`).

- Its mDNS comes from this machine's own address, which the kernel drops as a martian
  (`accept_local=0`) before any socket of the IP stack. `advert::browse` can never hear it.

- A new conflict makes the DNS-SD advert announce again (`advert::announce_again`, mdns-sd's
  re-`register`). A copy never hears a query from here (martian both ways), so only an
  announcement tells it who this server is.

- ⚠ The veth tests need `lo` up in the far namespace. mdns-sd binds its signal socket on
  127.0.0.1, and does not start without it.

- ⚠ `CAP_NET_RAW` is a FILE capability of the binary, never the unit's. Root writes it as it
  installs a version or a home (`arp::grant_file_capability`, in `install_bundle_checked` and
  `service install`).

- ⚠ The INSTALLING version writes it. A 0.1.5 installed by 0.1.4's `update apply` or helper has
  none. Applying the same bundle again with its own `update apply` writes it
  (`Installed::Already`, no switch, no restart), and the watch comes on at the next start.

- ⚠ It is `cap_net_raw=p`, NEVER `+ep`: with the effective flag the kernel refuses to EXECUTE the
  binary wherever the bounding set lacks `CAP_NET_RAW` (a pod that drops ALL, `--cap-drop
  NET_RAW`), so the server would not start at all.

- **The update helper watches a switch for CRASHES, never restarts** (`helper.rs` `Watch`, #369, 0.1.4).

- Linux counts systemd's `NRestarts`. A `systemctl restart` (an administrator's, or needrestart's after
  every library unattended-upgrades installs on Ubuntu) never moves it.

- Windows counts a process only when it was seen STOPPED with an error, which the SCM's recovery
  (5/30/60 s) holds long enough for a once-a-second look. Never "an orderly stop was seen": our stop
  lasts about a second and is easy to miss.

- Before #369 any new PID counted. The first update lane lost a good 0.1.3 to needrestart, and it
  was then never switched to again on that machine.

- ⚠ The helper runs the LAST KNOWN GOOD version, never the one it watches. A fix to the helper
  guards only switches made after it is the last known good version: the lanes proved #369 with a
  test-only 0.1.5 over 0.1.4.

- It reads `api.ok` and `api.uptimeSecs` from the API's `/status` over its control socket, which
  exists only once the API serves. It never reads whether the API child's process runs.

- The first 0.1.4 rollback lane's helper reported "the previous version runs" while that API sat
  behind a migration lock, alive and serving nothing. A version whose API never answers is now
  never confirmed: it reaches the 20-minute deadline instead.

- The .deb's conffile `/etc/needrestart/conf.d/lgr-server.conf` tells needrestart never to restart
  lgr-server.

- ⚠ It execs `/proc/self/exe`, NEVER `current`. A version a package switched to must run from the
  service's next START, where the update helper watches it.

- The main PID stays, so `NRestarts` never moves. The unit's user `lgr` may not `systemctl restart`
  anything.

- **`mongod` (P1-2, FR-20.15, `mongod.rs`):** started first, on 127.0.0.1 only (port 27118, never
  27017, which another MongoDB may own), `--replSet rs0`, `--keyFile keys/mongo.keyfile`, cache
  0.5/1/2 GB by RAM (<8 / <16 / more GB), oplog 2 GB. The API is listed `pending` until the
  bootstrap returns its URI. `MONGODB_URI` in `config/api.env` means "my own database": no `mongod`.

- ⚠ The bootstrap is idempotent and crash-safe: the passwords go into `keys/mongo.env` BEFORE the
  users exist, then `replSetInitiate` + the admin user via the localhost exception, then the API's
  user as admin. Users that `keys/mongo.env` does not open (keys lost or replaced) are a REFUSAL,
  exit 8, never a reset: only restoring the keys brings the data back.

- ⚠ mongod exits 1 at once, saying so only on its console, when its `--logpath` directory is
  missing. Its console goes to `logs/mongod.console.log`.

- ⚠ Cookies ignore ports: any other server on 127.0.0.1 receives `lgr_setup` too. That is
  acceptable for a session that only opens setup on loopback, never for a longer-lived credential.

- It serves the master's own certificate: a CA made once at first start, ECDSA P-256 for 20 years
  (`keys/lan-ca.*`, what desktops pin, so never replaced here), signing a server certificate for
  397 days (`keys/lan-server.*`).

- The CA's name derives from its own key (the digest's first 6 bytes, hex), so later certificates
  are signed from the key alone. rcgen, rustls and ring throughout: never aws-lc-rs, which needs cmake.

- ⚠ A port the bind cannot get is a loud error, never a fatal one: the console and the API stay
  up for whoever fixes it. On Windows, PID 4 (System, http.sys reservations) can hold a port.

- With the LAN ingress open, the API is given `LGR_LAN_URL` and `LGR_LAN_CA_FINGERPRINT`.
  `LGR_LAN_URL` is the default route's source address (`certs::default_route_v4`, a UDP `connect`
  that sends nothing). ⚠ Not the first private address: here a Hyper-V switch, 192.168.128.1,
  sorts before the real LAN.

- `GET /__lgr/ca.pem` on the LAN ingress answers the CA itself, never the API, with no desktop
  credential. A pairing desktop fetches it untrusted, checks it against `fp` (or a person checks the
  words), then trusts that CA alone.

- lgrai.app: native-tls, the OS store and the system proxy, as before. A paired master: rustls
  with a root store holding only its CA, never a proxy, and `X-LGR-Desktop-Token` on every request
  and WebSocket upgrade.

- ⚠ **A pin applies only to a name no public CA can certify** (`trust::may_pin`): a private,
  loopback, link-local or shared (100.64/10) address, a single label, `.local`, `.home.arpa`,
  `.internal`, `.localhost`. A deep link is attacker-controlled, and
  `server=https://lgrai.app&fp=<theirs>` plus someone in the middle of the shop's network would
  otherwise pin the cloud's own name to their CA, while the window still showed the real site.

- ⚠ `tungstenite`'s `MaybeTlsStream` is `non_exhaustive`, so every match on it needs one arm per
  transport. The bridge's read-timeout match fell to `_ => {}` for rustls: a loop blocked in `read`
  for ever, past `stop` and past revocation.

- Only the window gets in. `Host` must be exactly `127.0.0.1:<port>`, `Origin` (when sent) the
  proxy's, and a per-launch secret must ride in the `HttpOnly; SameSite=Strict` cookie
  `lgr_launch`. The window gets it from `/__lgr/boot#<secret>`: the page posts the fragment and
  drops it from the address. ⚠ It is never forwarded and never logged (`web::loggable` strips it
  from the "opened url=" line).

- The port is the installation's, so the SPAs' per-origin storage survives a restart.
  `settings.webServer` records whose session that storage holds; a window opened for another
  server clears it first. ⚠ An empty value (every install before this) clears nothing: wiping it
  on an update would sign out every till at once.

- A master never opens in the system browser: a browser would send the launch cookie to every
  server on 127.0.0.1 (cookies ignore ports).

- ⚠ Found on the way: the unreachable page's Retry and Diagnostics were refused on Windows, whose
  bundle is `http://tauri.localhost` (read as a remote page). `act_on_shell_request` now asks
  `is_bundled_host`.

- ⚠ Windows answers address queries for the machine's own name ONLY: an advert pointing at a
  name of its own never resolves (the resolve waits until cancelled, status 1223). And it answers
  that name with whichever interface the query came in on: measured, the WireGuard overlay's
  100.65.0.5, not the LAN's 192.168.8.115. Hence `ip` in TXT, which the shell prefers.

- ⚠ An advert proves nothing. A chosen server is probed and pinned as a typed one is. A server
  whose certificate is not the one its advert claimed is refused, with no tick to override it.

- `NODE_EXTRA_CA_CERTS`: the OS's trusted roots, exported at each start (`run/os-roots.pem`,
  rustls-native-certs), so a TLS-inspecting middlebox whose root came by GPO is trusted, plus the
  CA the service's `LGR_SERVER_EXTRA_CA` names: ⚠ the API calls global ITSELF (the feeds, the
  outbox, a move), so a root only the supervisor trusted left the API's calls failing.

CONNECT only: plain HTTP is a 501, never sent direct behind its back. The egress stops LAST, after
the API, which may still need it while it finishes. ⚠ Not yet: Negotiate (Kerberos/NTLM) proxy
authentication, and PAC off Windows.

- **`status`** carries `front` (port, socket, names, console, `lan` with the CA's SPKI fingerprint,
  `egress`; never a secret), and `api`, the API's own `/status`: schedulers, `fiscalInFlight`,
  `posOpen`.

- CI: clippy + `cargo test` on Linux, and the real-`mongod` bootstrap test runs wherever
  `LGR_SERVER_TEST_MONGOD` names a binary (mongodb-memory-server's cache has one). ⚠ Since the
  driver (rustls → `ring`) needs a C compiler for its target, clippy with `--target` from Windows no
  longer works: Linux is checked by CI natively. Installing the service for real is a vmtest cell
  (T-3), not CI.

## Desktop: local mode retired (2026-09-29, FR-14.34)

- ⚠ **`packages/dal` and `packages/dal-mongo` stay.** `DalBackend` is now the single member
  `'mongo'`, and `packages/tests/src/dal/` keeps all 70 repository test bodies — they exercise the
  `dal` INTERFACE, not `dal-mongo`, which is why they are not redundant with the integration
  suites. The directory was renamed **`dal/parity/` → `dal/repos/`** (`*.parity.test.ts` →
  `*.repo.test.ts`): with one backend, "parity" named nothing.

- ⚠ **`desktop-ui` is now in `bun run build`.** That is the point: it was NOT built before and
  bit-rotted unnoticed — a deleted view broke it from 2026-08-22 to 2026-08-26. Its five views are
  placeholders until FR-14.30–14.33.

- The sidecar's `admin` / `admin123` default account and its `'lgr-dev-secret'` token signing are
  gone, along with the release-notes line that published the password. ⚠ `lgr-dev-secret` still
  exists in `packages/config` as the **dev-only** JWT fallback that is fatal in production (S-02) —
  that is a different thing and stays.

- ⚠ The `SQLite Type` columns in `docs/models/**` are **historical** and nothing implements them.
  The per-entity `## SQLite Schema` sections, which cited deleted files, were removed; the table
  columns were left alone rather than risk mangling 49 reference docs by script.

## A master's own backups (2026-10-25, FR-20.21, plan step P1-9)

- ⚠ A format of its own, so a reader that only knows `-1` (paths under `docs/`) refuses it
  rather than putting files where they never lived.

- The restore anchors at whichever root the header names, and never writes into `backups/`:
  a crafted entry there could otherwise overwrite the bundles a later restore needs.
  `restoreTarget` judges every path, on the RESOLVED form (`./backups/x` passed a check of
  the raw string, and on Windows so did `Backups/x` and `backups./x`).

- ⚠ **Read sidecar lines through `splitLines`, never `chunk.toString()` per chunk.** A chunk
  boundary inside a Cyrillic character turned it into U+FFFD, and the restore wrote the file
  under a name nothing points at: 3 of 3000 `фактура-*.pdf` paths on a real zstd stream (16 KB
  and 8 KB chunks). The checksum covers the content, not the name, so nothing said so.

- ⚠ A location that is not there is a `failed` destination, never a failed run, and it is
  never created: a "copy" made on the master's own disk would be no copy at all.

- ⚠ **And on a master, a location on the disk the uploads are on is `failed` too**
  (`localDisk.sameAsData`, `stat().dev`; the volume on Windows). On Linux an unplugged drive
  leaves its mount point behind, an empty folder on the system disk, and "is it there?" passed
  it: the copy landed beside the database, read back fine and said `reached` every night.
  Tests whose folders all share one disk stand a second disk in through that seam (`freshLocal`).

- ⚠ The region alone proves little: `us-east-1` is SigV4's default answer.

- ⚠ **The cloud is told, not stopped.** FR-20.97 binds its copies too (§2.8). Enforcing it the
  day this deployed would have stopped production's off-site backups until someone attested a
  region, which is the owner's decision. It logs a warning once a process.

## Till PINs on a master (2026-10-25, FR-20.40, plan step P1-5)

- **Where.** Only a paired desktop on the LAN ingress (`x-lgr-source: lan` plus its token: the
  desktop's org is the org signed in to), or the console. ⚠ Never the tunnel. `frontSource` is the
  supervisor's stamp, and a master with no front offers no PIN at all.

- **Stored** in `local_credentials` (`identityId`, `kind`, argon2id `verifier`, `tvAtSet`): node
  state, no `orgId`, never in a bundle. ⚠ Never on `Identity`, which travels in every bundle of
  the person's orgs.

- **Backs off, never locks** (trap 32): 3 free tries, then 1 s doubling to 60 s, per person
  (persisted) and per desktop (in memory). During the wait the answer is 429 with `Retry-After`,
  and the PIN is not checked. Every attempt costs one argon2 verify, decoy included, as `login()`
  does.

- ⚠ **A PIN session (`amr: ['pin']`, 12 h) reaches the till only** (`pinScopeRefusal`, first in
  `accessRefusal`, so the Administrator too): the POS routes, the shell's `me`/`logout`, and the PIN pad
  itself (the next operator signs in over the last one's session). Inside them the role still
  counts, so a manager's PIN authorises a storno. A new route the POS terminal calls must be added
  to `PIN_SCOPE_ORG`, or a till breaks on it. ⚠ Keep `/auth/switch` out: it would mint a FULL
  session from a PIN session.

- ⚠ Those calls use plain `fetch` (`invoicing-ui/src/pos/composables/useTillPin.ts`), never the shared
  HTTP client. They run with no session, or with the last operator's, and the client's 401
  recovery would sign the tab out or send it to the portal.

- ⚠ **A master's PASSWORD sign-in backs off too.** There the password is the person's local
  credential, so `/auth/login`'s S-08 throttle uses the PIN's curve once a counter reaches its
  limit, never the cloud's 15-minute lock. A lock would let anyone at a till lock the admin out
  for an outage. Password-reset requests still lock: that only stops a mail flood. The cloud is
  unchanged.

## The LAN CA rotates with a week's notice (2026-10-25, FR-20.30, plan step P1-4)

Desktops pin a master's own CA (FR-20.31), so it is never replaced silently.
`lgr-server ca rotate` (`--in <seconds>`, a week by default) announces the change:
- **The next CA is made at once and served beside the current one** at `/__lgr/ca.json`, on the LAN
  ingress. A paired desktop reads it hourly through the TLS it already trusts (`trust::follow`),
  adds the next CA to its pin and saves it (`settings.master.next*`). The window's proxy re-trusts
  in place (`Running::retrust`), so the switch drops nobody who came by during the week.
- **At the switch** (`switch_if_due`, checked each minute) the next CA signs a new server
  certificate and becomes the current one. Desktops then promote it and drop the old one. A
  desktop that never came by pairs again.
- ⚠ **The switch is resumable.** `lan-ca-rotation.json` is marked `switching` before a file moves,
  and `ensure` finishes a started switch BEFORE it reads the CA. Cut off between the two CA files,
  they belong to different CAs until it does.
- ⚠ **A next CA is only ever taken from `ca.json` read through the pinned TLS.** Unpinned, the same
  document proves nothing, since anyone on the LAN could serve one. `follow` returns `Unknown` for
  a current CA the pin has never heard of.
- **`state/lan.json`** (`LGR_LAN_STATE_FILE`) is what a pairing code names and pins, kept current
  by the supervisor. The API reads it (`currentLan`), so a rotation or a DHCP move needs no
  restart; the environment's values are only the fallback. A new address used to leave codes
  naming the old one until the API restarted.
- A connection kept from before the switch, or a TLS session resumed from one, still carries the
  old certificate, legitimately: only that master holds the session. A probe of the old CA must
  make a full handshake (a fresh client) to see it refused.

## A master prints with its own Chrome (2026-10-25, FR-20.25)

- **Without one the master starts, warns, and prints nothing** (503). It never falls back to another
  Chrome.

- ⚠ **Never the machine's Edge or Chrome.** A Windows browser with an update pending
  (`new_msedge.exe` beside it, which is how an update waits while anyone has the browser open)
  swaps and RELAUNCHES itself on start. Puppeteer sees "Failed to launch the browser process:
  Code: 0", and the relaunched headless browser runs on with nobody to close it, three per PDF.
  74 were left behind by a handful of test renders on 2026-10-25.

- ⚠ **`packages/server/pdf-browser.lock.json` pins the unpacked TREE** of each platform (every
  path and its sha256), not the archive, and the fetch refuses anything else. After a puppeteer
  bump, `unit/pdf-browser.test.ts` fails until `--update-lock` is run and its four digests
  reviewed.

- ⚠ **In the image an explicit `PDF_CHROME_NO_SANDBOX` always wins over the default, `0` included**
  (`config/api.env` first, then the container's own environment, read only in the image). `0` is how an
  operator whose host grants the namespace keeps the sandbox, so never fold it into "unset"; an empty
  value is unset. `chromeArgs()` turns the sandbox off for `1` only, and as root whatever is set.

## Masters registered with global (2026-10-25, FR-20.2, plan step P2-1)

- ⚠ **Every node route is 404 on a master**, and `NODE_TOKEN_SECRET` is required in production on
  global only. It is sealed in `lgr-secret` (lgr-deploy 7d7d29a). Without it global refuses to
  start.

- ⚠ **Revocation is per org.** `POST /org/:orgId/nodes/:id/revoke` takes only that org off. The node
  is revoked with its last org (an ephemeral one is deleted), and each step is conditional on the
  row as read.

- ⚠ **`GLOBAL_STATE_WRITES` (route-class.ts) is the home gate's one exception**: routes under
  `/org/:orgId/` that write global's registry, never org data, so they work while the org's home is
  the master being revoked. The models carry no tenant plugin. They are node state, never bundled.

- Reusable keys for the field lanes need `Org.settings.node.ephemeralKeysEnabled`. Their nodes are
  reaped after 24 h of silence (`NODE_REAPER_INTERVAL_MS`, 0 in tests), and never a permanent node.

- Its key is `keys/node.key`: DPAPI at machine scope on Windows, a `0600` file elsewhere.
  ⚠ A key that does not open is a refusal, never a new key, since a new key would leave the master
  registered with one it no longer holds.

## The uplink, global's side (2026-10-25, FR-20.52, plan step P2-2a)

- ⚠ **`node_presence` (unique per node and channel) is the clone check.**

- ⚠ 4403 stops the uplink until the master registers again. It never stops the shop: the
  supervisor and the API keep running.

- Global keeps it sanitised on `ServerNode.health`. ⚠ Only known fields, bounded, with undefined
  dropped: a Mixed field would store each undefined as null. At most one per 20 s.

- ⚠ `ServerNode.cloneAlarm` is a single nested subdocument with `default: undefined`. As a nested
  path holding an array it defaulted to `{bootNonces: []}` on every node, and every hello read as an
  alarm.

## Desktop updates through the master (2026-10-25, FR-20.56, plan step P2-7)

- ⚠ `current.json` names a version only once every file is whole, at its listed size.
  `release-cache.ts` serves only listed release files at their recorded size, inside the
  directory. A part-file or a leftover is never served.

## Licences on a master (2026-10-25, FR-20.55, plan step P2-3b)

- The keys a master accepts are `packages/config/src/licence-keys.json`, read by the API AND the
  supervisor (`include_str!`). ⚠ A production master accepts those and nothing else; outside
  production a process also accepts the key it signs with (`allowInDevelopment`).

- ⚠ **A session still opens** (FR-23, owner 2026-11-01). Where LGR prints, a payment on a document
  needs a session, so refusing one refused the payment the gate promises to leave alone. The sale is
  what stops: `/transaction` answers 402 in a session opened on or after `restrictedFrom`, and one
  opened before keeps selling (`licenceGate`'s `started`). A receipt for a document started since is
  refused too (`prepareReceipt`): only a debit note can be one, and its lines are whatever it was given.

- ⚠ **The auth plugins never read a body** for this: naming `body` in a shared Elysia hook makes
  every route parse its body, and the Stripe webhook needs its raw one. `POST /invoices`, which
  decides on its body (credit notes go through), asks `licenceGate` in its handler.

- `OrgLicence` is NODE STATE (`home/node-state.ts`): never in an org's bundle.

## Mail through lgrai.app (2026-10-25, FR-20.59/86, plan step P2-6)

- On a master `sendEmail` QUEUES (`Outbox`, node state) and answers `{ok: true, queued: true}`.
  ⚠ Callers must say "queued", never "sent": the invoice email route answers 202, the digest run
  says `queued`, and an invoice's `emailedTo` changes only when the mail has gone.

## Sign in with LGR (2026-10-25, FR-20.39, plan step P2-4)

- ⚠ The identity keys are not the licence keys, and the JWS types differ (`lgr-idp+jws`): an
  assertion can never pass for a licence. Both use `services/biz/crypto/ed-jws.ts`.

- ⚠ **On the setup console, lgrai.app's redirect back is a cross-site navigation, and the console's
  `SameSite=Strict` session does not come with one.** Until 2026-11-23, Cancel and Continue both landed
  on 403 "Setup needs its link", and a reload did not help because the browser keeps the cross-site
  start. Only a test that presses the button in a real browser could see it: the HTTP-level checks
  carry the cookie themselves. The console now answers that one request, a cookieless
  `GET /auth/idp/callback` whose Fetch Metadata says `cross-site`, `navigate` and `document`, with
  `IDP_RETURN_PAGE` (`ingress.rs`). That page requests the same address again from the console's own
  origin, and that request needs the cookie like any other, so nothing without the session reaches
  the API. ⚠ Never fix it with `SameSite=Lax`: then any other site's top-level GET carries the setup
  session. The desktop is not affected, because its shell takes the flow over with `lgr://login`
  (`web.rs`, `finish_master_idp`).

## The identity feed (2026-10-25, FR-20.43/44, plan step P2-5)

- ⚠ The payload is email, names, `tokenVersion` and active, nothing else (FR-20.44). A new field
  there needs the same care: `identity-feed.flow` scans for hash and token shapes.

- `NodeState` (`node_state`): a master's own small records by name. No `orgId`, so never bundled.

## The server packages (2026-10-25, FR-20.10, plan step P1-7)

- ⚠ **`lgr-server.exe` is built with a static CRT** (`RUSTFLAGS=-C target-feature=+crt-static`), and a
  release step refuses an EXE that names the C runtime. The MSI runs the installer's own copy
  (`update install-bundle`) BEFORE any version, with its app-local runtime, is unpacked. server-v0.1.0
  linked it dynamically: the first field lane (vmtest T-3, a clean Win11) failed the install with 1603,
  STATUS_DLL_NOT_FOUND. The release runner has the runtime installed, so CI's own MSI install passed.

- ⚠ **The preflight looks for that runtime where `mongod` loads it** (`preflight::vc_runtime_in`): the
  version's `bin\` first, then System32, DLL by DLL. It used to look in System32 alone, so on a clean
  Windows the supervisor refused every start (exit 7, which the event log renders as "The storage
  control blocks were destroyed") while all three DLLs sat in `bin\`. Found by the same lane, on
  0.1.1's first build. `install::runtime_bin` answers for `installer\lgr-server.exe`, which has no
  `bin\`.

- **The installers refuse a machine below FR-20.13's floor, and install nothing** (AC 14, 0.1.2). The
  MSI runs `Preflight` from `lgr_server_msi.dll` (`src/msi.rs`, the package's `[lib]` cdylib, which
  compiles `preflight.rs` in as it is) as an IMMEDIATE action before InstallInitialize: the reason
  goes through `MsiProcessMessage` (a message box with a UI, the log either way). The .deb's
  `packaging/linux/preinst` mirrors the checks in shell, held equal by
  `preflight::tests::the_preinst_mirrors_the_checks`. A first install only, never an upgrade.

- ⚠ `preflight.rs` must stay a LEAF (no `crate::`): `msi.rs` compiles it on its own.

- ⚠ An EXE custom action could not say why: its failure is the installer's generic "a program run
  as part of the setup did not finish as expected".

- ⚠ **Memory is measured against `MIN_USABLE_RAM` (3.25 GiB), never 4 GiB.** A 4096 MB VM reads
  3.8 GB, so the old `>= 4 GiB` refused every 4 GB machine; the `master-ubuntu-4gb` lane found it.

- ⚠ **At start, the supervisor refuses only what makes running impossible or unsafe**
  (`preflight::blocks_start`: cpu, location, vc-runtime). Below the memory or disk floor it starts and
  warns. It used to refuse any failed check, so a master whose disk dropped under 20 GB free would
  have stopped at its next reboot.

- ⚠ The MSI creates the service with a deferred custom action, `service install --no-start`, and
  starts it with ServiceControl. `install` is idempotent (an upgrade runs it again).

- ⚠ The .deb's postinst never starts, stops or enables anything. `packaging/linux/lgr-server.service`
  must equal `service::systemd_unit` (a Rust test holds it).

## The mirror: capture, pages, the apply (2026-10-25, FR-20.61–20.67, plan steps P3-1, P3-2a, P3-2b)

- ⚠ Documents are read and decoded with `promoteValues: false`. A JavaScript round trip turns an
  integral `Double` into an `Int32` and a `Long` into a number: the hash would not match, and the
  mirror would hold other types than the home.

- ⚠ A page is built only once the org's seeding at the current journal epoch has finished
  (`ReplOrg.seededEpoch`): seeding hands out seqs outside the tailer's transactions, so before it
  ends a lower seq can appear below a page already sent.

- ⚠ The master continues only from a page it built itself (`ReplOrg.pages`, the last 32). Global
  may tell it the chain hash it holds, but only to pick among those: a restored, reverted or cloned
  master that adopted global's hash would pass for the one whose history it lost (FR-20.51).

- ⚠ A split document is written with ONE `$replaceWith` pipeline (`mirrorPipeline`): the page's
  home parts plus the mirror's own parts as they are on the server. A `$set` of the home's fields
  would keep a field the home removed (`User.deactivatedAt` after a reactivation), and a
  read-then-write would lose a Stripe webhook's write in between.

- ⚠ A duplicate key ABORTS a MongoDB transaction, so a collision is resolved by trying again with
  the stale same-org document deleted first, and `resend {coll, ids}` asks the master for it again
  (`rejournal`). A key or `_id` another org holds is never written over or deleted: that
  document is SET ASIDE (below).

- **One document never stops the org** (P3-2c, FR-20.65; `replication/dead-letters.ts`,
  `mirror_dead_letters`, node state): a document whose `_id` another org holds (found before the
  first attempt, one `$in` a collection, not one retry each), whose unique key another org holds,
  or that the database refuses (a server code that is the document's: not 11000, not a
  transient/server-state code, no `TransientTransactionError` label) is left out of the next
  attempt and recorded `open`, with a `dead_letter` alarm the first time; the rest of the page
  applies. More than `DEAD_MAX` (100) in one page fail it (`page-error`). An open one rides the
  org's next acknowledgement as `resend` once its `retryAt` comes (5 min, doubling to a day),
  and the page that writes it resolves it, so a conflict someone removes heals by itself. The
  Servers page's "Files on lgrai.app" card lists them (×4), and the move back waits on them
  (`mirror_whole`): a set-aside document would keep its digest from ever matching.
  The isolation refusals (another org's row, a collection that does not replicate, a file outside
  the org) still refuse the whole page: those are not one document's trouble.

- ⚠ A stale SPLIT document is parked (its key set to `~stale~<id>`), never deleted: its global
  and node fields travel in no page, so a resent membership would come back with no person and,
  looking new, without its sanctioned link.

- ⚠ The chain hash proves a page whole, not who sent it: authorship is the node token, the
  registry and the home check. Never trust a page's own `nodeId`.

- ⚠ The supervisor never reads a page, and global takes the node from the token, never the page.

- ⚠ A page is read at the snapshot (majority-committed) point, which can trail a `local` read by
  the batch that just committed: "nothing to send" then is not "caught up". The pump looks again
  after 2 s; a test waits for the journal's head (`replication-pages.flow`'s end-to-end case).

- **Paced on the shop's upstream** (FR-20.52, FR-20.68, P3-2c; `packages/server/src/pacing.rs`). Two
  sockets keep a catch-up from queueing in front of a click inside the supervisor, not on the LINE:
  behind a router with a deep buffer every bulk byte waits in front of the interactive socket's. So:
  while bulk has work the interactive socket pings every 2 s, one at a time, NUMBERED (global echoes
  `n` in its pong; an older global's unnumbered pong times only a ping alone in flight; one
  unanswered for 10 s is a 10 s sample already); its round trip less the least of ten minutes is the
  line's queue. Over 150 ms the bulk rate falls by a fifth (by half past 600 ms), at most once a
  round trip or two; under it, it grows by a quarter only if bulk used two fifths of what the rate
  allowed (an idle line is no evidence); floor 8 KB/s (the mirror never stops). At the floor two
  minutes with the delay unmoved, the queue is a slower route, not ours: the base starts again from
  the last minute. Pages (`maxBytes`) and chunks (`length`) are asked for in a quarter of a second
  of the rate (16 KB to 1 MB; an older API ignores both), spaced by a token bucket in the pump's own
  task (the socket loop never waits on it). `lgr-server status` shows `bulk.pacing`;
  `LGR_BULK_PACING=off` turns it off. ⚠ The real-process proof is `mirror-e2e`'s shared-uplink
  section, the chaos proxy's `uplink(Bps)` (ONE unbounded FIFO for every connection, a bloated
  router): a click through the same 64 KB/s line during a 3,000-document + 2 MB catch-up went from
  p50 4.7 s / p95 over 60 s (timeouts) unpaced to p50 223 ms / p95 559 ms, the catch-up 50 → 59 s.
  A per-connection `throttle` cannot show it: nothing queues behind anything there.

- `mirror_state` (global) and `node_instance` (master) are node state, never in a bundle.

- Tests: `replication-capture.flow`, `replication-pages.flow` (two databases on one replica set: the
  master's and the mirror), `replication-transport.flow` (the control socket, the bulk socket),
  `unit/replication-meta`, `unit/replication-project`, and Rust `replication::tests` + the uplink's bulk
  session test. The whole path with a real supervisor, a cut link and a slow one:
  `bun packages/tests/src/two-node/mirror-e2e.script.ts` (after `cargo build`, `bun run build`,
  `bun run build:server`). ⚠ That script runs T-1's TLS front and chaos proxy IN its own process:
  never `Bun.spawnSync` the CLI there, or the blocked event loop forwards nothing and every supervisor
  call to global times out (it looks like a slow WinHTTP proxy lookup, and is not).

## Moving an org to its master (2026-10-25, FR-20.79, plan step P3-6a)

- ⚠ **The copy carries the org's PEOPLE** (`$people`, `PEOPLE_FIELDS`: who they are, never a password,
  OAuth link or other org) **and their local credentials sealed to the master's seal key**
  (`$credentials`, `sealedCredentialsForMove`). A master's sign-in needs its own `Identity` row, and
  BOTH feeds skip people a master does not hold and move their cursors past them: without these
  sections nobody signs in at the site, and the credentials would wait for the next daily full pass.
  After the import `forgetFeedCursors()` makes both feeds run from the start once.

- ⚠ Canonical EJSON per document read with `promoteValues: false` (the mirror's type rule), and the
  digests are a function of the DATABASE (`collectionDigests`), computed by both sides over the same
  projection; the flip waits for them and for the people/credential counts.

- ⚠ **The audit trail is org data**, refused like any other write once the org is frozen or gone: the
  start's entry is AWAITED before the freeze (`recordAuditEntry`, so it is in the copy), an abort's
  after the unfreeze, and the master writes the arrival once the org is home there.

- ⚠ **Global's own org-scoped records are refused by the write guard during the freeze too**
  (`DesktopEnrollmentCode/Key` carry `tenantPlugin`): those revocations, `homeEpochHighWater` and
  `mirror_state` are raw writes, listed in `home-write-guard.flow`'s `RAW_WRITE_SITES`.

- ⚠ `collectionDigests` hashes canonical EJSON in STORED field order, and the mirror's apply
  reorders a split document (`$mergeObjects: [home, kept]` puts global's fields last). So the move
  back compares with `homeDigests` instead, which is order-insensitive.

## Desktops follow their org's home (2026-10-26, FR-20.82, plan step P3-6b)

- **Alarms (FR-20.101, P3-8a; `services/biz/node/node-alarms.ts`).** The health frame also carries
  `disk.totalBytes`, `oplogWindowSecs` (the supervisor reads `local.oplog.rs` as the
  administrator, `mongod::OplogWindow`: the API's user cannot; ⚠ ONLY once the oplog is 90 % of its
  max size: until it wraps its first entry is just the server's first day, and a new install would
  read as a short window for a week), `clock` (global keeps `clockSkewSecs`, master minus global at
  receipt) and the API's `lastBackupAt` / `fenced` / `outboxQueued`
  (`services/biz/node/master-health.ts`, through the control socket's status). `nodeAlarms`: the
  mirror over an hour behind while bulk is up (the master's reported head past the watermark AND
  no page for an hour; caught up is never lag), a backup over 26 h (none at all only a day after
  enrolment, and only for a server that writes an org), disk under 10 %, oplog under 7 days, fenced,
  clock over ±2 min. ⚠ A health frame older than ten minutes raises nothing: away is the
  connection's to say. `alarmsOfNodes` batches presence, homes and mirrors; the org's Servers
  list carries `alarms` (a lag only that org's) and `/admin/nodes` everyone's, with link and last
  backup (`useNodeAlarms` formats both, durations through `Intl`, ×4), and `supto_waiting` (P3-8c, below).

- **A SUPTO version travels only once declared (FR-20.50, P3-8c).** `packages/config/src/supto.json`
  holds this source's SUPTO version and the versions declared to НАП (a JSON file so the build host
  reads it with `jq` and the supervisor with `include_str!`; `config/supto` is its reading for the
  code). ⚠ Bump `version` by hand in the commit that changes Прил. 29 functionality or the database
  structure (чл. 52в(3), (3а)); add to `declared` in the commit that records the declaration.

- **`higher_epoch`**: a master registered for the org reports, in its minute org-state report
  (now with `epoch` + `state` per org), a newer home record than global's — global's database is
  older than the org's last move. ⚠ Only an `active` row is a claim: during a move the master
  writes its row at the NEW epoch as `frozen` before global flips (move-worker), and holding then
  would break the move's own flip precondition. Not from a revoked server, nor for an org it is not
  registered for.

- Settled on the sys-admin Nodes page ("Organizations on hold", `/admin/nodes/held`): **release**
  (global's record stands; the high-water mark is made to agree) or **adopt** (the server's claimed
  record becomes global's, only from a server still registered). ⚠ The routes take `:id`, never
  `:orgId`: the tenant guard and the home gate key on that name and would refuse a sys-admin
  settling an org on hold. Global's audit log cannot take it (the org is on hold): the row keeps
  `released`, and the log line says who. The Nodes page raises `home_hold` per server.

- **An org's address on the internet (FR-20.72, P3-4a; `services/biz/address/org-address.service.ts`).**
  `OrgAddress {label, orgId, state: requested | active | refused | retired}`, global's record about the
  org: node state, never in a bundle, no `tenantPlugin` (so the write guard does not see it).

- **The flow.** The org admin asks on the Servers page (`POST /org/:orgId/address`). That route is
  in `GLOBAL_STATE_WRITES`, because the org is usually homed on its server. A sys-admin then
  approves, refuses or retires it on the Nodes page (`/admin/addresses/:id/…`, `:id` never
  `:orgId`). A refusal needs a reason and frees the label.

- ⚠ **A label is issued once.** The unique index covers requested, active and retired. A retired
  address answers with a notice for 12 months and is never issued again.

- **The edge** (mars' Docker nginx, `gjovanov/nginx`; P3-4e, lgr-deploy#27, live since 2026-10-27)
  holds a ZeroSSL certificate for `*.lgrai.app`, and the zone a wildcard A record beside the
  server block `org-addresses.lgrai.app.conf`. ⚠ A name with its own record (`qa`) wins over
  the wildcard. `harvex` was retired the same day: its record and vhost are gone, so the name now
  reaches LGR and answers the unknown-label 404.

- **The tunnel, lgrai.app's side (FR-20.72–20.74, FR-20.78, P3-4b; `portal-api/src/tunnel/`).** A
  global-only `onRequest`, registered FIRST in `unified.ts`, handles every `Host` of the form
  `<label>.<ORG_ADDRESS_APEX>` whose label is not reserved. Such a request belongs to the org's
  server, never to lgrai.app: once a hook returns a `Response`, none of lgrai.app's later hooks,
  headers or cookies run (measured).

- a server that is not connected gets a 503 static notice, never a sign-in page (FR-20.75).

- Each stream gets a 256 KB credit window in each direction, used whole and never exceeded.

- ⚠ **Elysia's WebSocket wrapper turns anything but a Buffer into text.** Binary goes out through
  `raw.sendBinary`.

- ⚠ **The browser's WebSocket is upgraded inside `onRequest`**, with `server.upgrade(req, {data:
  handlers})` (Elysia dispatches to `ws.data.*`), and the hook returns a 101.

- A hop has passed the edge already and keeps the browser's address. ⚠ It is NEVER forwarded
  again: a socket gone from both pods answers offline instead of bouncing.

- The other pod unreachable: offline. Only an `offline` failure forwards, since nothing of the
  request was sent; a link lost mid-request never does.

- ⚠ **The API answers `<label>.<ORG_ADDRESS_APEX>` ONLY for the `tunnel` source**
  (`front-guard.ts#isOrgAddressHost`). The same name from the LAN is 403 `host_not_allowed`. The
  tunnel source is never held to the LAN's desktop-credential rule, and creating an org stays the
  console's.

- ⚠ The session loop drains the socket's outbound channel, so nothing in it may wait on that
  channel. An immediate answer goes out through a spawned send.

- **A master's own status page (FR-20.98, FR-20.50, P3-8b; `/settings/server`).** The supervisor
  writes its status every 30 s to `state/status.json` (`status_file.rs`: atomic, with the volume and
  the oplog's reach beside it; nothing secret is in a supervisor status), beside the node token, so
  the API finds it at `dirname(LGR_NODE_TOKEN_FILE)`. `services/biz/node/server-status.ts` joins it to
  what this database holds of the org (home, journal head, last backup, outbox, fiscal devices,
  desktops online) and to lgrai.app's last `/self` (`lastSelfAnswer`, kept by the link-alarm tick:
  the mirror's watermark), and adds the Прил. 32 fields ready to copy (т. 5, 7, 10–13: re-filed
  within 7 days of a change, чл. 52з(1)). `GET /org/:orgId/server/status`: admin or
  `admin.settings`, **404 on lgrai.app**; `GET …/server/here` answers any member whether to show
  the nav entry, 200 either way. ⚠ One server may hold several orgs: the licence is projected to
  THIS org's (plan, paid through, grace, error), never the supervisor's whole list. A file older than
  two minutes says the supervisor is not writing.

- **The declaration**, per org (`NodeState` `inspection:<orgId>`, node state, never mirrored or
  bundled): the server stands in the shop (inspected there, no path asked), or off the premises.
  Off the premises it needs a path:
  - `tunnel`, the org's address, refused (409) without the Full link (`link_not_full`) or without
    an issued address (`no_address`);
  - `overlay`, the roomler overlay, with the address an inspector uses;
  - `vpn`, the company's VPN, with the address an inspector uses.
- `PUT /org/:orgId/server/inspection`: admin or `admin.settings`, on the server only (404 on
  lgrai.app, and the home gate's 409 before that for an org written on a server). The change is
  audited (`entityType: 'server'`).
- **lgrai.app's `/self` now names each org's address** (`orgs[].address`), which is how the server
  knows the tunnel's.
- **The status page's Прил. 32 panel** shows the path, and a hint while it is undeclared, missing,
  or broken (e.g. the link went down to Control). An admin declares it there.
- `docs/supto/FUNCTIONAL-DESCRIPTION.md` §13 is the on-prem variant the spec asks for.

- **The digest's on-prem lines (FR-20.100, P3-8b; `buildServerSection`).** An org's digest is built
  on its home (FR-20.85), so on a master it gains a `server` section: lgrai.app's copy (behind by how
  much, the last page's age, from `lastSelfAnswer`), the last backup there, and what waits in the
  outbox, each red past FR-20.101's threshold (`ALARM_AT`): `unheard` (no `/self` for an hour, or
  never by an API up that long; ⚠ never just after a start, when the first tick has not run),
  `mirror_lag`, `backup_stale` / `backup_none` (only once the org's home is 26 h old),
  `queued_old`. Any alarm keeps the day off "all clear". `settings.dailyDigest.sections.server`
  (default on); never built on lgrai.app.

- **A re-point** (`desktop:repoint {instruction, node, name}` on `/ws/desktop`): an EdDSA JWS, typ
  `lgr-repoint+jws`, for ONE desktop (`sub`), its org, the master and the move's epoch, the
  master's LAN URL and CA pin; 30 days. Signed with `REPOINT_SIGNING_KEY` (sealed in lgr-secret),
  verified by the desktop against `config/src/repoint-keys.json` built into it. ⚠ The signature is
  the point: a till reaches lgrai.app through the machine's trust store, so a TLS-inspecting middlebox
  it trusts could otherwise send it to a server of its own, pinned from then on.

- **When**: at the flip (`repointOrgDesktops`, after `copied`), at every later authentication, and
  on the heartbeat (a flip on another process), each followed by `desktop:error {code: 'org_moved'}`
  and a close: a shell older than P3-6b takes that as any refusal. ⚠ Nothing of a moved org's desktop
  is written on global (`lastSeenAt` would be refused: the rows are the mirror's now).

- **The shell** (`packages/desktop/src-tauri/src/repoint.rs`, `main.rs#follow_repoint`): believes
  an instruction only under a key built into it (`include_str!` of `repoint-keys.json`), for its
  own desktop id and org (`registration.json`), above `settings.homeEpoch` (a replay cannot send
  it back), with a LAN origin `trust::may_pin` allows and the dates within a day of its CORRECTED
  clock; then `trust::confirm`s the master's CA against the pin, saves server + pin + epoch, and
  RESTARTS (`prepare_exit` + `app.restart()` from a thread: Tauri then runs `RunEvent::Exit`, where
  the single-instance plugin releases its mutex before the relaunch). Not followed: `status.orgMoved`
  and the Overview's `org-moved` banner; the next connection brings the instruction again.
  ⚠ `save_settings` keeps the on-disk `homeEpoch`, as it keeps `master`.

- ⚠ The shell and global verify ONE vector (`desktop/src-tauri/src/repoint-vector.json`, signed by
  global's own signer with a throwaway key): change either verifier and the other's test says so.

- Tests: `desktop-repoint.flow` (9), Rust `repoint::tests` + `presence::tests`, `uplink::tests`
  (the lan in health). ⚠ Not yet walked with a real shell: this PC holds a real enrolled desktop
  (a second shell hands off to it), so the walk is owed to the VM lane before the next desktop release.

## Moving an org back to lgrai.app (2026-10-27, FR-20.80, plan step P3-6c)

The org admin starts it on lgrai.app's Servers page ("Move back to lgrai.app" on the org's home
server; `POST /api/org/:orgId/moves/preflight` and `POST /moves/` with `{ to: 'global' }`). The
org's data never travels as a copy: global's mirror already holds it, and the move waits until the
mirror holds ALL of it. Global: `services/biz/move/move-back.service.ts`; the master:
`move-worker.service.ts#moveBack`. `org_moves` with `kind: 'to_global'`, `from` the master.

- **Asked** (`freezing`): global records the move and re-welcomes the master, so a records-only
  org's files travel now (`movingBack`). The master's worker (every 10 s) refuses while a till is
  open, a fiscal command prints or a job runs (`failed`). Otherwise it writes the move into the
  org's audit trail (here, the org's home) and freezes the org: `OrgHome.state: 'freezing'` at the
  same epoch. ⚠ The capture never disables an org, so a frozen org's last pages and files still go.

- ⚠ A mismatch WAITS (a page may still be on its way); only the timeouts abort: 30 min to freeze,
  6 h to drain.

- **The master** hears `done` (from `drained` or its moves) and sets its home record to
  `{home: 'global', epoch}`. It keeps a read-only copy (its home gate refuses writes). ⚠ A later move
  to that master needs the copy removed first: the import refuses an org with data.

- the shell (`repoint.rs`) believes a pinless one ONLY for the cloud built into it (`CLOUD`, `https://lgrai.app` unless
  `LGR_CLOUD_URL` at build time): anything else is `not_our_cloud`, and a cloud one carrying a pin
  is `bad_claims`. Followed, it drops the master's pin, saves the cloud and the epoch, and restarts.
  ⚠ Without that rule a pinless instruction would send the till wherever its signer said, trusted
  through the OS store.

- ⚠ Both verifiers test the cloud cases against the one vector (`repoint-vector.json`, regenerated
  with a new throwaway key: `jwsParts`, `cloudJwsParts`, `cloudOtherJwsParts`,
  `cloudPinnedJwsParts`).

- `homeDigests` (`move/home-digest.ts`): per collection, over `homePart` (what pages carry, never
  global's or a node's own parts), canonical EJSON with keys sorted at every level (arrays keep their
  order), type-exact (`promoteValues: false`).

## Promoting lgrai.app's copy of a lost server (2026-10-27, FR-20.81, plan step P3-6d)

- ⚠ **The danger is not lost data, it is a server that is only cut off**: still issuing invoices in
  the shop above the mirror's counters, while lgrai.app issues the same numbers to other customers.
  So a promotion takes EVIDENCE, and freezes the legal series after it:
  - preflight: the home is one of the org's servers, no other move, the server connected on neither
    socket (one that answers is moved back instead), and a mirror to promote;
  - the attestation: the server is off or destroyed, its tills are disconnected, and the slug typed;
  - 24 h of silence (`SILENCE_MS`, from `ServerNode.lastSeenAt`) unless destroyed is attested
    (`not_silent_long_enough`);
  - the dialog states the loss window (`lossFrom` = `mirror_state.lastPageAt`) AND the
    duplicate-number risk, and how many files lgrai.app lacks.
- **The flip** is the move back's. The move is created `verifying` (no copy, no drain; it takes
  whatever files global holds, `allowMissingFiles`), and `moveBackTick` places the files and flips in
  one transaction: epoch + 1, home global, `homeEpochHighWater`, `mirror_state` deleted, and
  `OrgHome.seriesFrozen {since, reason: 'promoted', moveId}`. Then the content store goes, and the
  org's audit trail (here from now on) records the promotion and its evidence.
- **The legal series** (`LEGAL_SERIES`: `SALES_DOC`, `CASH_SALE`, and every `UNP-<device>`, in
  `sequence.service.ts`) stay frozen until a person records the last number the site issued in each,
  read off the last printed documents and the fiscal device's daily report (`GET`/`POST
  /api/org/:orgId/numbering/last-numbers`, on every node since P3-7; the Servers page's card).
  - Every series lgrai.app knows must be given, so none opens by omission (`series_missing`).
  - Each resumes above the higher of the site's number and the mirror's (`ensureSequenceAtLeast`,
    never lowered). Then `seriesFrozen` is unset, and the change audited.
  - `getNextNumber` (legal prefixes) and `generateUNP` refuse while frozen (`SeriesFrozenError` →
    409 `series_frozen`, in `spaErrorHandler`). Drafts, proformas, bills, orders and journal entries
    go on.
  - ⚠ **Every issuing path refuses BEFORE it moves anything** (`issuableRefusal`):
    - `/send` before its claim and its dispatch;
    - `insertRegisterDocument` before the insert (a storno gives its claim back);
    - an invoice for a cash sale before its placeholder;
    - an import's conversion before its number (one carrying its own number goes on).

- **The old server, if it comes back**, learns of the move from its moves (`movesForNode` lists a
  promotion of an org it was home of) and FENCES itself (`move-worker.service.ts#fenceHere`): home
  global at the new epoch, `state: 'fenced'`, `fenceCutoff` = the mirror's watermark at the
  promotion. It writes nothing more of the org and never resumes on its own; what it captured above
  the cutoff is exported to lgrai.app for review (FR-20.84, P3-6e, below). Global's welcome names the
  org `home: 'global'`, so the pump sends nothing of it.

- ⚠ A done promotion stays in `movesForNode` however old (the others drop out after 30 days): a
  server back after a month must still fence.

- ⚠ A REVOKED server is never told: its token is refused, and it goes on selling at the site. Revoke
  a server that was stolen, never one that may come back on its own.

- **Replacing a dead server** is a promotion followed by a move to the new machine (FR-20.79): a new
  node with new keys, its desktops paired again (a dead server re-points nothing). ⚠ A till session
  the lost server left open is in the copy, and the move's `no_till_open` refuses until it is closed
  (an admin closes it without the fiscal device: `closeWithoutFiscal`).

## A master whose database went back locks its legal series (2026-10-27, FR-20.51, plan step P3-7, first slice)

- an in-app **Replace** restore (`applyRestore`), right before its first write, and only on a
  server lgrai.app never knew (below): a restore refused by a check locks nothing, one that fails
  mid-way stays locked. A **Merge** locks nothing: it only inserts what is missing and clamps every
  counter upwards;

- the journal below its own high-water mark (`journalHwmTick`): the per-org `repl_orgs.seq` only
  grows in a database never rewound, and the mark lives OUTSIDE it, in `journal-hwm.json` beside
  the node token. Checked at the API's start, BEFORE it serves, and every minute
  (`series-lock-tick`, masters, its first run at start). ⚠ Only where the master CAPTURES: on an
  Air-gapped one `seq` never grows and it sees nothing (#549);

- **the legal counters below their own mark** (`home/legal-mark.service.ts`, `legalMarkTick`,
  #549, capture or not): per org and legal series (`legalCounters`, the filter `legalSeriesOf`
  uses), the highest counter seen, in `state/legal-mark.json` AND copied to the backup drive
  (`<BACKUP_LOCAL_PATH>/LGR/State/legal-mark-<node>.json`), which a restored system-disk image
  leaves alone. The mark is the max of the two copies; never lowered; an older drive copy is
  brought up, never a lock. Start (before serving) + `series-lock-tick`.
  ⚠ Traps:
  - Only orgs home here AND `active`: a move in (or a re-seed) imports while `frozen`, with the
    counters empty meanwhile, and an earlier stay's mark would lock the org arriving whole.
  - The drive copy follows `pushBundleToLocalPath`'s rule: there, and NOT on the data's disk
    (`localDisk.sameAsData`). The base path is never created.
  - **The drive is BOUNDED** (`onDrive`: 10 s, one operation at a time). `BACKUP_LOCAL_PATH` may
    be a share, and a share whose server went away blocks a `stat` for good (NFS `hard`, CIFS) or a
    minute (UNC), while the API's start and the minute's other detectors wait on this tick. Past
    the bound, or while an earlier request still hangs, the drive is "not there". The local mark
    and the counters are checked regardless, and no blocked thread piles up each minute.
  - A copy naming another node is ignored.
  - **Damage ≠ an I/O error.** No JSON or no mark: renamed `.unreadable-<date>`, never
    overwritten, and a new mark starts. Not READ (an AV or a backup tool holding it, a
    permission): left as it is and not written that minute, with the drive's copy still compared.
    The unlock refuses 503 `mark_unreadable` meanwhile, before it writes anything.
  - Entries past a real counter's range (УНП > 9 999 999) are damage, dropped, never a floor;
- the journal below **lgrai.app's watermark** (`linkAlarmsTick`; `/self`'s `mirrors`): the other
  mark kept outside, by global. A healthy master is never behind the pages it sent. ⚠ This is the
  one that catches a reverted VM snapshot: its own mark went back with the disk;
- lgrai.app holding pages of the org **past the newest this database ever built** (`buildPage`,
  when the pump asks: `chain_unknown` with `wentBack`): a restored database whose chain the
  master can no longer continue. ⚠ Its pump stops that org WITHOUT telling global, so this is the
  master's own finding; global never records a refusal for it. Below the newest page built here an
  unknown chain concludes nothing (global may be the one restored);
- what lgrai.app says of the master (`linkAlarmsTick`, every minute): a clone alarm, or its pages
  refused as a history that went back (`instance_changed`, `stale_journal`, `diverged`) more
  recently than its last applied page. `GET /api/node/v1/self` carries `cloneAlarm`, `wentBack`
  and `mirrors` (per org with a chain: `watermark`, `lastPageAt`);
- **a clone on the shop's network** (AC 50; `packages/server/src/lan_clone.rs` →
  `state/clone.json` → `lanCloneTick`, at the API's start and every minute). The LAN advert
  carries this start's nonce (`boot`, the uplink's `bootNonce`); every 5 minutes the supervisor
  browses `_lgr-server._tcp` for this node from ANOTHER start at ANOTHER address, and PROBES it: a
  TLS handshake with its LAN ingress that trusts only this server's own LAN CA and checks no name.
  ⚠ The probe is what makes it evidence: an advert is anyone's to send, and a crash leaves this
  machine's own TXT record in caches for up to 75 minutes (RFC 6762), after a DHCP change at another
  address; only a copy of this disk completes that handshake (a clone re-issues its certificate for
  its own address, under the same CA). The record's `at` is renewed at every sighting, so a clone
  still answering after the unlock locks again. Only while the LAN ingress is on (nothing advertises
  otherwise).

- ⚠ **A history that went back is RECORDED once** (`noteWentBack`, `repl_orgs.wentBack {at, reason,
  detail}`; reason `mirror_ahead` or the mirror's refusal), and numbering locks with the record,
  never with the sign. The pump sends the refused history again on every new session and lgrai.app
  dates each refusal anew, so a sign seen again after a person recorded the numbers must find the
  record and change nothing. The re-seed from the mirror is what clears it.

- **The anchor is never evicted** (`buildPage`): `repl_orgs.pages` keeps the 32 newest pages AND
  the one global last said it stands on, and a page built again with the same rows is recorded once.
  ⚠ Before, 32 retries while global could not apply (it errs every 5 s) pushed the anchor out, and
  the org stopped for good on `chain_unknown`, which now would also read as a database gone back.

- ⚠ **A Replace restore is REFUSED on a master lgrai.app knows** (`replaceRefusedHere`, before
  anything is read or written, no `RestoreRun` row): registered at any link level, capturing, or with
  pages of the org built. Its deletes and rewrites are journaled like any other write, so its pages
  would carry the backup's state to the mirror and delete there what the backup lacks (AC 36's "cannot
  overwrite the mirror"). The way back to a backup is a move to lgrai.app and a restore there; Merge
  stays available.

- each series resumes above the person's reading and, on a master that can ask, the mirror's
  numbers (`GET /api/node/v1/legal-series?orgId=`, `mirrorLegalSeries`; ⚠ a query parameter: a
  path with `:orgId` is a user's org route to the tenant guard); with the link down,
  the person's reading stands alone;

- it records `seriesUnlockedAt` and resets the journal's mark (never the legal mark).

- **Locked by hand** (#549, the runbook after a revert nothing sees, server-install.md):
  `POST /api/org/:orgId/numbering/lock {note?}`, admin, master only (404 on lgrai.app), reason
  `restored`, detail `locked by <name>: <note>`, audited once, idempotent. The UI is
  `portal-ui/views/settings/LastNumbersCard.vue`, shared by the Servers page (lgrai.app, after a
  promotion) and the master's status page (`on-server`: the lock button, and the record card a
  master never had: its Servers page shows only "not here").

- ⚠ A sign seen again does not lock again: replication stays refused until a re-seed, and the
  journal may stay below its marks a while. The went-back record decides that (above); a clone
  alarm counts only when it is newer than `seriesUnlockedAt`.

- ⚠ An org arriving by a move resets the mark (`activate`): an org that left and came back starts a
  new journal, which its old mark would read as a rewind.

- ⚠ **Evidence, never a lock or a floor.** An Eltrade's 71h counts every document: receipts,
  stornos, text receipts, X and Z reports, and the keyboard's. So a device ahead is normal after a
  Z-report, and no LGR series steps with it. Locking on it wants the device: what its counter
  counts, and whether it moves when the device sells on its own.

- Tests: `legal-mark.flow` (11: written and raised by issuing, УНП included; an Air-gapped
  database-only rollback locked where `journalHwmTick` sees nothing; a whole-disk revert caught by
  the drive copy; no/unplugged/same-disk drive; an older or foreign drive copy; the unlock's floor
  and its audit; not a master / not home / a move still frozen; non-counters and a damaged mark; a
  write that fails; the lock by hand over HTTP, 403/409/404). `series-lock.flow` (7: the mark and the unlock; global's alarms, the mirror's floor, no
  re-lock, a refusal dated anew after the unlock locking nothing; the journal below global's
  watermark, no re-lock until the record is cleared; `nodeSelf`; a Replace locking before its first
  write where lgrai.app never knew the server, a refused one or a Merge locking nothing; a Replace
  refused where it knows the server; the report and what lgrai.app keeps of it; a clone on the LAN
  locking, not again after the unlock, again while it goes on answering); `lan_clone.rs` (4: what is a
  candidate; what is recorded; a real handshake: a copy of this disk completes it with a certificate
  re-issued for its own address, another CA and nothing listening do not);
  `replication-pages.flow` (+2: the anchor through 40 rebuilds and the chain going on from it, a
  mirror past every page built here; `pageFor` recording and locking once).

## Re-seeding a server from lgrai.app's copy (2026-10-27, FR-20.71, AC 36, plan step P3-7)

A server whose database went back underneath the mirror (above) can no longer continue its chain,
and its numbering is locked. The mirror is the newest complete copy there is and knows every delete
made since the backup, so the org admin re-seeds the server FROM it: its copy of the org is REPLACED,
never merged ("only what it lacks or holds older" would bring back what was deleted since).
`org_moves {kind: 'reseed'}`, home and epoch unchanged. Global: `services/biz/move/reseed.service.ts`;
the server: `move-worker.service.ts#reseedHere`.

- **Preflight** (`POST /api/org/:orgId/moves/reseed/preflight`, admin): home the server, active; no
  other move; registered at Full, no clone alarm (decide which machine is real first), its seal key;
  both sockets, healthy, room, no till open, no fiscal command; the mirror has a chain; and the
  server's database WENT BACK: its org-state report says so, or the mirror refused its history since
  its last page. ⚠ Re-seeding a server that did not go back replaces newer data with older.
  ⚠ Both routes are for an org written ELSEWHERE, so the home gate must let them through: the
  preflight is in `READ_ONLY_WRITES`, the start in `GLOBAL_STATE_WRITES` (`route-class.ts`). Missing,
  both answered 409 `org_home_elsewhere`; only the real-process e2e saw it, the services-level tests
  call past the gate (`reseed.flow` has an HTTP test for it now).

- **The server**, whatever global's preflight said, re-seeds only if `repl_orgs.wentBack` is set;
  else it reports `failed`. Then: the org `frozen` (same epoch) and `repl_orgs.pages` cleared, so
  no page continues the old chain; after 2 × `HOME_CACHE_MS`, everything the org holds is KEPT ONCE,
  for good, at `<org>/docs/reseed/<move>.ndjson.zst` (under `docs/`, so its backups carry it: what
  the server wrote that lgrai.app never received exists only there and on paper), with what the copy
  lacks (`notInCopy`: documents only there, issued sales and their numbers); then
  `discardMoveImport` + `importMoveBundle` + the files + `forgetFeedCursors`, and `copied` with
  `replaced`. A failed round is tried again; the org stays frozen.

- **The flip** (`reseedCopied`): the server's digests are compared with the COPY's (`m.digests`),
  never with the mirror's as it is now (global's own fields of a split document may change
  meanwhile); equal, one transaction claims the move and deletes `mirror_state`, and the server's
  bulk socket is welcomed again. Its pages start a new chain from 0: what the mirror holds, re-sent
  unchanged, and tombstones only for what it never held, so nothing on the mirror is deleted.

- **Done** on the server: unfrozen, the went-back record cleared, the mark reset, the re-seed in the
  org's trail. ⚠ Legal numbering STAYS LOCKED: what the server issued between its last page and the
  failure is on paper and in the fiscal device only, so a person still records the last numbers.

- ⚠ **Master data only when named.** Nothing in the app hard-deletes it, so a named one is new
  work. An unnamed one might be something a raw script deleted after the restore point, so it is
  counted in `keptOnly` and never resurrected.

- **Never touched:** what the copy holds.

- **Bookkeeping.** Rows in `fenced_import_items` with the re-seed's id as the run, state in
  `NodeState` `kept-import:<moveId>` (lease 10 min), audited. Numbering continues above every
  number brought in (no lock check: it is a raw counter bump, never an issue).

## Reconciling lgrai.app's copy after a master lost the record of its changes (2026-10-27, FR-20.70, plan step P3-7f)

- ⚠ Global answers only the org's home, registered for it at Full, with no clone alarm, and only the
  ids of ITS copy of that org (FR-20.66). The org's own document is never asked.

- ⚠ **No page deletes an issued sale** (FR-20.51; `issued-sales.ts`: an invoice with a number that
  is not a draft, any till transaction): a tombstone for one the copy holds is not applied, the copy
  keeps it, with a `sale_kept` alarm and on the reconcile's `kept` list. Nothing on a home deletes
  one (a draft only), so a home without it lost it, and the copy may be its only record.

- Not yet: the reconcile on demand, and after the journal's tombstones are pruned (nothing prunes them).
  ⚠ A kept sale also holds a move back (the copy then differs from the server, and P3-6c waits on a
  mismatch): bringing it back onto the server is the same audited import the re-seed's kept sales
  wait for.

## What a fenced server did after the cutoff (2026-10-27, FR-20.84, plan step P3-6e)

- ⚠ also every row of another journal epoch than the cutoff's (`OrgMove.fenceJournalEpoch`, from
  the mirror at the promotion): a lost history journaled them again, and whether global saw them
  is unknown;

- **Built once and kept** under the org's `docs/fenced/fenced-<moveId>.ndjson.zst`, on the master and
  on global alike, so both sides' backups carry it. ⚠ Never discarded, whatever its state: it is the
  evidence the audited import keeps (Прил. 42: full, unchanged, with source and time).

- Global writes at the offset and NEVER truncates: a slow retry of an earlier chunk must not cut off
  the ones after it.

- ⚠ One org's (AC 38): a document of another org, a collection a move does not carry, or a file path
  outside the org's tree refuses the bundle.

- `collision`: lgrai.app gave its number to another document, which the import will resolve by a
  credit note and a re-issue (FR-20.51), never by an edit.

## The audited import (second half)

- `deletion` (never applied);

- **Resumable**: a document already ours (`importedFrom.exportId`) is booked on, never inserted
  again, and every booking checks what it would create first: a stock movement for the sale, its
  `journalEntryId`, each payment's, the session's.

- ⚠ `postInvoiceJournal`/`postPosSessionJournal` are the event handlers' bodies, exported unchanged
  (refactor only). `invoice.posted` itself is NOT idempotent: the import checks `journalEntryId` first.

- ⚠ The repository's invoice carries its payments WITHOUT their `_id`s or entries:
  `postPaymentJournal` reads the invoice raw and stamps the one payment with a positional `$set`.

- ⚠ `confirmMovement` leaves `completed`, not `confirmed`: test for both.

- ⚠ **The unique key is `{orgId, invoiceNumber, numberClash.withId}`** (`INVOICE_NUMBER_KEY`,
  migration `0010-invoice-number-clash`, which replaced `orgId_1_invoiceNumber_1`). Every
  ordinary invoice has no `numberClash` and the key reads it as null, so `(org, number)` stays
  exactly as unique for them. The pair's second fits; a third never does.

- ⚠ **`numberClash` is a SINGLE NESTED SUBDOCUMENT**, like `cashSaleRef`. A nested-path object
  would be materialised on every invoice (as `stockSource` is), and the key would no longer read
  null for ordinary documents.

- ⚠ **A partial index cannot do this:** `partialFilterExpression` takes no `$exists: false`.

- **Remedy** (spec §5.5, ЗДДС чл. 116): the LATER of the pair is annulled by a credit note and
  re-issued under a new number, never edited or deleted. "Prepare the correction"
  (`POST /org/:orgId/invoicing/number-clashes/:id/prepare`, `invoicing.write`; listed by
  `GET …/number-clashes`) makes two DRAFTS for a person to issue:
  - a credit note (`relatedInvoiceId` = the later document) and its re-issue;
  - both carry `stockSource.marker` `number_clash:<id>`, so neither moves stock;
  - neither copies the lines' `orderRef`;
  - payments stay on the annulled document, for a person to allocate.
- Only an outgoing invoice is prepared. A cash sale's legal number is its УНП, so a cash-sale pair
  is corrected by a person.
- The Sales invoices list shows the banner and the dialog (`NumberClashBanner.vue`, ×4).
- Rollout: `bun run migrate` on prod after the deploy. Until it runs, the old key refuses the
  pair and the imports leave it `number_taken`, as before.

## Read-only where the org is not written (2026-10-27, FR-20.75, plan step P3-5, first half)

- The org's own address (P3-4) shows a static notice while its server is offline, never a sign-in
  (`portal-api/src/tunnel/notice.ts`).

## The mirror's files (2026-10-27, FR-20.66, FR-20.69, plan step P3-3)

An org homed on a master sends its files to lgrai.app's mirror behind its documents, on the bulk
socket. Global stores and reads them BY CONTENT, per org: `<UPLOAD_DIR>/<orgId>/blobs/<sha256>`,
recorded in `mirror_blobs` (`MirrorBlob`, node state). ⚠ Never where a mirrored row says: the
row's path is the master's to choose.

- ⚠ Computed per org and from nothing the master lists. A store shared across orgs, or an answer
  from the master's own list, would tell any master whether another org holds some file (AC 52).
  Two orgs with the same bytes hold two rows and two files.

+ at most 1 MB. The magic is not zstd's, so a chunk is never taken for a page.

- The master's API reads them (`blob-source.ts#blobFor`, `POST /replication/blob` on the control
  socket): the org's rows with that hash (current documents, versions, deleted ones, imports,
  archive units), and only if the org is homed here at Full. At offset 0 it hashes the whole file
  first, so bytes that are not what their row says never leave (`hash_mismatch`).

- ⚠ `not_ready`, `not_full` and `not_home` from the API wait 10 s, never the 10 minutes of other
  refusals (`LAGGING`). The API reads the link level and the home through 5-second caches, so right
  after a registration at Full it may still say `not_full`. That stalled a fresh master's first pages
  for ten minutes; the mirror e2e caught it.

- **Global's own copy from before a move** is taken, never asked for. A file at a mirrored row's
  stored path, under the org and outside `blobs/`, that hashes to the row's content is COPIED into
  the store (a reflink where the filesystem has them, never a hard link: the original stays global's
  own). Bounded per ask (200 files / 512 MB). The same happens on read, one file at a time, so such a
  file opens even for an org that mirrors its records only.

- `resolveDownload`: the current file by `currentChecksum`; `?version=` by the version's `File`
  row; an archived document out of its unit's blob, checked against the row's checksum, and NEVER
  written back.

- `getVersions` from the `File` rows, never `readdir`.

- ⚠ The mirror's own writes on a GET (taking a pre-move copy, re-asking for a file the disk lost) are
  global's node state (`mirror_blobs` and `blobs/`), never the org's data.

- ⚠ Global writing its own part of a mirrored org passes `{ timestamps: false }`. Mongoose would
  otherwise set `updatedAt`, which is the home's field, and the mirror would differ from the home
  until the master next sends the org. The e2e's digest caught it.
