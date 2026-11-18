# History: Nodes: masters, the supervisor, the mirror, desktops

What was built in this area, release by release: FR-20: the server package, the supervisor (`lgr-server`), the API behind it, masters, uplink, mirror, moves, desktops.

Moved here whole from `CLAUDE.md` by FR-32.13 (#797), section by section and word for word, so "below" and
"above" in it speak of the file it came from. The traps and the never/always rules of these sections are also in
the rule file [`.claude/rules/nodes.md`](../../.claude/rules/nodes.md), which a session loads when it touches
this area's files. A new trap goes there (or in `CLAUDE.md` if it is not one area's); what was built goes here.

## The server package (FR-20.25/FR-20.26, plan step P0b-9)

What a master runs: `bun run build && bun run build:server && bun run check:package` →
`dist/lgr-server/` = `server-manifest.json` (commit, Bun, every file's sha256, no build clock) +
`app/server.js` + `app/migrate.js` + `app/scripts/<name>.js` (`SCRIPT_ALLOW_LIST`) + `ui/<module>/`.
Run it with `LGR_UI_ROOT=<package>/ui`. Shared definitions: `scripts/lib/server-package.ts`. CI builds,
checks, boots (`integration/server-package.flow.test.ts` with `LGR_SERVER_PACKAGE`) and rebuilds it
(identical manifest). `check-package.ts` refuses an unlisted/changed file, an ignored path, `.secrets/`,
a seal key, `.env*`, a cloud secret name (in a bundle: one given a VALUE), another origin in a built
SPA (AC 66), a packaged script whose import graph touches `Invoice`/`POSTransaction`/`CashOrder`
(AC 67), and a bundle with NODE_ENV inlined.
- ⚠ **`Bun.build` inlines `process.env.NODE_ENV` as "development"**, even with `env: 'disable'`: every
  production guard compiles to false (the bundle STARTED with no `JWT_SECRET`). Server code is only ever
  bundled through `serverBuildOptions()`, which defines it to itself.
- ⚠ **A bundle has nothing beside the source.** An asset is IMPORTED: CSS/text `with { type: 'text' }`,
  a binary `with { type: 'file' }` resolved against `import.meta.dir` (relative once bundled), data as a
  JSON import. Never `readFileSync(new URL('../x', import.meta.url))` or `createRequire().resolve()`:
  every PDF failed with ENOENT on `assets/markdown.css`. One file cannot be imported as text AND as code
  in one bundle ("No matching export").
- **lgrai.app's analytics tag is added by the server** to the portal shell, on `global` only
  (`spa-fallback.ts#portalShellFor`); `portal-ui/index.html` carries no origin, so no build does. Swagger
  (its page loads Scalar from a CDN) is served on `global` only. Both are AC 66: a master serves no
  third-party script.
- The static plugins are **awaited** before `listen`: unawaited, every asset answered 404 for ~180 ms
  after `/api/health` said ready.
- `bun build --compile --target=bun-windows-x64-baseline` (2026-10-24 spike): one 127 MB executable,
  booted from an empty directory, served the SPAs, signed in and printed an invoice. Chrome and the
  fonts are not in the package yet (P1).

## The two-node harness (FR-20 plan Part F.2, step T-1)

`packages/tests/src/two-node/harness.ts` boots a `global` and a `master`, each its own process on its
own `MongoMemoryReplSet` with its own keys and no schedulers. Between them sit `chaos-proxy.ts`
(`drop` · `blackhole` · `down`/`up` · `delay` · `throttle` · `flapAt`, raw TCP) and `tls-front.ts`
(TLS/WSS terminator; a test CA minted per run by `openssl`, so no key is ever committed). The
master's side reaches global at `uplinkUrl` with the run's CA. With `LGR_SERVER_PACKAGE` both nodes
run the package. `two-node.test.ts` runs only with `LGR_TWO_NODE=1` (CI, after the package is built).
- ⚠ WebSocket close codes 1005/1006/1015 are only ever REPORTED: passing one to `close()` throws, and
  in the front's close handler that broke the next upgrade. `tls-front.ts#sendable` maps them.
- ⚠ Lifting a blackhole closes the connections that went silent, or a client's pooled connection
  hangs its next request: a blackholed TCP connection is dead to its client.

## The synthetic field-test org (FR-20.112/113, plan step T-2)

A throwaway instance gets its data from `scripts/seed-fieldtest.ts` and nothing else (AC 45):
`bun run scripts/seed-fieldtest.ts --org lgr-fieldtest-<name> --seed <n> --preset small|regal --server <url> --execute`.
- It writes only into `lgr-fieldtest` / `lgr-fieldtest-<name>` (exit 2 otherwise), nothing without
  `--execute`, and over an existing org only with `--replace`. The admin is `admin` with
  `FIELDTEST_ADMIN_PASSWORD`, or a generated password in `.secrets/fieldtest-<org>.password`.
- Phase 1 (MONGODB_URI): the org through `register()`, then warehouse, categories, tags, products and
  contacts in bulk, ids from the seed (`scripts/lib/fieldtest-data.ts`, import-pure). Phase 2
  (`--server`): receipts confirmed, then invoices issued, through the API, so numbering, stock and
  dispatch are the server's. Phase 3: the server's own invoice PDFs and Excel exports, uploaded.
- `regal` is regal-pz's shape: 23k Cyrillic fastener products tagged as `assign-din-tags` tags them,
  2k contacts, 350 receipts + 550 invoices (900 movements), 1.5k files. `small` takes ~11 s.
- ⚠ Nothing real: names from word lists, ЕИКs with a deliberately WRONG check digit, every e-mail
  under `.invalid`. A new org has no accounting defaults (`settings.accounting`), so the event
  handlers journal nothing: no entries, as for an org that only invoices.
- `scripts/data-scan.ts`: `--export` against production (native driver, so no index builds) lists
  every org but the synthetic ones (field-test, `acme-corp`, `beta-inc`); `--denylist <file>` against
  a throwaway refuses on any of their ids (as ObjectIds or inside strings) or slugs (as words).
  ⚠ The DEMO seed creates an org with the slug `regal`, a real customer's: never run it on a
  throwaway, the scan rightly flags it.

## The API behind the supervisor (FR-20 plan step P1-3)

On a master the API answers the supervisor alone (`portal-api/src/front/`). The supervisor sets
`LGR_FRONT_SECRET` (per boot, ≥ 32 characters), `LGR_FRONT_HOSTS` and `LGR_CONTROL_SOCKET`. With no
secret (global, a developer's machine, the tests) the front checks are off, and no `X-LGR-*` header
is ever read as a stamp.
- **`frontRefusal`** runs in the root app's `onRequest`: before routing, and for WebSocket upgrades
  too (Elysia 1.4.30 refuses an upgrade from there). In order:
  - the front secret (`x-lgr-front`, constant time), else 403;
  - `Host` on the list, else 403. Any IP literal and `localhost` are on it, since DNS rebinding
    always arrives under a name;
  - the source stamp, `x-lgr-source` ∈ `lan | tunnel | console`, else 403.
- **On EVERY master, front or not:**
  - `/internal/*` and `/api/setup/*` answer 404 over HTTP, matched on the normalized path (decoded,
    lowercased, single slashes, no trailing slash);
  - the three routes that create an org (`POST /api/auth/register`, `POST /api/auth/orgs`,
    `POST /api/oauth/pending/register`) answer 404 unless `source=console` (FR-20.18).
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
- **`source=lan` needs a paired desktop:** `X-LGR-Desktop-Token`, verified and then re-read through
  `loadActiveDesktop`, so a revocation takes effect at once.
  - Exempt: `GET /api/health` and `POST /api/desktop/v1/{enroll,token}`, matched EXACTLY. A variant
    such as `/api/health/` is gated: an exemption fails closed.
  - ⚠ This is the one `X-LGR-*` header the LAN ingress carries over from the client. It is a
    credential the API verifies, never a stamp it trusts.
- **`clientIp()` behind the front** returns `x-lgr-client-ip` only. There is no nginx in front of a
  master, so `X-Real-IP` and `X-Forwarded-For` are the client's own text.
- **Every audit entry says where it came from (FR-20.48)**, so an auditor can tell a till from a
  remote session. The field is `AuditLog.via`:
  - `lan:<desktopId>`: a till, by its credential;
  - `lan`: the shop's network without a credential;
  - `tunnel`: the org's address;
  - `loopback`: the console, and the server's own work (a tick, or a job outside any request).

  How it is set:
  - `requestVia` (`front-guard.ts`) derives it, and `api.ts`'s synchronous `onTransform` puts it
    in the request context.
  - `auditDoc` stamps it on every entry, so none of the ~240 call sites changed.
  - A socket's own event has no request context, so it passes `via` itself (the fiscal bridge's
    takeover).
  - lgrai.app records none.
  - The audit page names the till (`viaDesktop`; strings `admin.via.*` ×4).
- **The control socket** (`control-socket.ts`): HTTP over AF_UNIX (`Bun.serve({ unix })`), and every
  request carries the front secret.
  - `GET /status`: schedulers, `fiscalInFlight`, `posOpen`, requests and sockets in flight.
  - `GET /setup`: the orgs homed here with owner and admins (addresses and an active flag only), and
    the paired desktops. For setup's console.
  - `POST /stop`.
  - ⚠ Bun 1.4.4 on Windows serves HTTP on an AF_UNIX path, but not on a named pipe (ENOENT). A
    path longer than 108 bytes fails with ENAMETOOLONG.
- **One graceful stop** (`graceful-stop.ts`), for SIGTERM, SIGINT and the socket alike:
  1. stop listening, but keep the open WebSockets (a receipt printing through a bridge needs its
     socket);
  2. halt the schedulers;
  3. wait up to `LGR_STOP_WAIT_MS` (25 s) for the fiscal operations and the requests in flight;
  4. disconnect the devices;
  5. exit 0.

  ⚠ On Windows, CTRL_BREAK ends Bun at once with `0xC000013A` and runs no handler. Under the
  supervisor, the socket is the only graceful stop.
- **Fiscal in flight** (`fiscal/in-flight.ts`):
  - `getPrinter()` hands out a counted view of the printer: one per printer, stable across calls,
    and NOT the object that was registered;
  - a POS sale's and a storno's whole print sequence is one `fiscalOperation`, so a stop never lands
    between "open receipt" and "close receipt".

## The supervisor, `lgr-server` (FR-20 plan step P1-1)

`packages/server` (Rust, own `Cargo.lock`, toolchain 1.98) is what a master runs: it starts the
API from the server package (`<home>/package/app/server.js` under `<home>/bin/bun` or `bun`), keeps it
up, and answers a local control channel. `lgr-server run` (foreground) · `service install|uninstall|run`
· `status [--json]` · `restart <child>` · `stop` · `diagnostics` · `run-script <name>` (only what the
package manifest's `scripts` lists) · `setup-token`. `backup now` and `update-helper` answer "not
yet" (exit 2) until P1-9 / P1-8.
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
- **Stopping (FR-20.23):** the ingresses close first, then the children stop in REVERSE start order,
  each fully before the next — the API while its database still answers, `mongod` last. Each says
  how it is asked (`child::Stop`) and how long it has (`ChildSpec::grace`):
  - the API through its control socket (`POST /stop`, P1-3), with its own `LGR_STOP_WAIT_MS` + 15 s,
    since it waits for a receipt in flight;
  - `mongod` through its own `shutdown` command as its administrator, with 30 s for its last
    checkpoint.

  Both are clean on every OS, console or not, and a signal is the fallback. ⚠ Under the SCM there is
  no console, so CTRL_BREAK cannot be sent and that fallback is the job, at once. Stopping
  everything at once let `mongod` go first, under the API's last writes.
- **Control channel** (`ipc.rs`): NDJSON over `\\.\pipe\lgr-server` (a pool of 4, the first
  `first_pipe_instance`, so a squatter or a second supervisor stops it: exit 8) or
  `/run/lgr-server/control.sock` (0600; systemd's `RuntimeDirectory=`). Admins and the service only.
- **Data** (FR-20.14): `%ProgramData%\LGR`, `/var/lib/lgr`, `/Library/Application Support/LGR`,
  readable by the service and administrators only (Windows: inheritance removed, the service,
  SYSTEM and Administrators granted by SID). Windows service: `LGRServer` as `NT SERVICE\LGRServer`,
  recovery 5/30/60 s, 24 h reset. Linux: `lgr-server.service`, `User=lgr`. macOS: LaunchDaemon
  `ai.lgrai.server` as `_lgrserver` (P1-7 creates the user).
- **State survives a power cut** (`config::write_durable`, 2026-10-28): every file the supervisor
  keeps in `state/` and `keys/` is written as `<name>.tmp`, given its mode, flushed, renamed over,
  and on Unix the directory flushed too. `write_private` is that with 0600.
  - ⚠ A bare tmp + rename survives a crash, not a power cut. ext4 (delayed allocation) and NTFS put
    the rename on disk before the data, so a cut seconds after a first start left an empty
    `node.json` or a half `api-secrets.env`, and either is exit 7 for good.
  - New state goes through `write_durable`.
- **Another machine with this server's address** (#356, `arp.rs`, Linux): RFC 5227 probes for
  `certs::lan_ip`, plus every ARP packet on its interface. A sender MAC that is none of this
  machine's, naming this address, is a conflict.
  - It goes in `state/address-conflict.json` and the status, NEVER `clone.json`. That one locks legal
    numbering, and only the TLS proof may write it.
  - Detection only: the supervisor never announces the address.
  - ⚠ **A copy at THIS address is read off the wire** (#380, `mdns_wire.rs`).
    - Its mDNS comes from this machine's own address, which the kernel drops as a martian
      (`accept_local=0`) before any socket of the IP stack. `advert::browse` can never hear it.
    - A second packet socket reads it: IPv4 UDP to 5353, with a BPF filter attached BEFORE the bind.
      An advert is kept only from the MAC that claims the address over ARP, and naming this node from
      another start, it makes the conflict `probableClone`.
    - A new conflict makes the DNS-SD advert announce again (`advert::announce_again`, mdns-sd's
      re-`register`). A copy never hears a query from here (martian both ways), so only an
      announcement tells it who this server is.
    - ⚠ The veth tests need `lo` up in the far namespace. mdns-sd binds its signal socket on
      127.0.0.1, and does not start without it.
  - The conflict rides in the health frame (`address`). lgrai.app raises `address_conflict` while it
    was seen in the last 15 minutes (`node-alarms.ts`, `detail: probable_clone`), and the master's own
    status page shows it.
  - ⚠ `CAP_NET_RAW` is a FILE capability of the binary, never the unit's. Root writes it as it
    installs a version or a home (`arp::grant_file_capability`, in `install_bundle_checked` and
    `service install`).
    - ⚠ The INSTALLING version writes it. A 0.1.5 installed by 0.1.4's `update apply` or helper has
      none. Applying the same bundle again with its own `update apply` writes it
      (`Installed::Already`, no switch, no restart), and the watch comes on at the next start.
    - Children are other files and inherit nothing, and a rollback to a version from before it runs
      no watch rather than a wider one.
    - ⚠ It is `cap_net_raw=p`, NEVER `+ep`: with the effective flag the kernel refuses to EXECUTE the
      binary wherever the bounding set lacks `CAP_NET_RAW` (a pod that drops ALL, `--cap-drop
      NET_RAW`), so the server would not start at all.
    - The supervisor raises it, opens the socket once per process (a `OnceLock`, for every start in
      the process), and drops it at the top of `run_supervisor_blocking`, before the runtime has a
      thread.
    - `NoNewPrivileges=`, or a directive that implies it, turns it off: the unit test refuses those.
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
- **"Clean" is the API SERVING, by its own account** (`helper.rs` `health_from`, 0.1.4).
  - It reads `api.ok` and `api.uptimeSecs` from the API's `/status` over its control socket, which
    exists only once the API serves. It never reads whether the API child's process runs.
  - The first 0.1.4 rollback lane's helper reported "the previous version runs" while that API sat
    behind a migration lock, alive and serving nothing. A version whose API never answers is now
    never confirmed: it reaches the 20-minute deadline instead.
- **A library a security update replaced runs from a restart IN PLACE, at night** (`night_restart.rs`, #370).
  - The .deb's conffile `/etc/needrestart/conf.d/lgr-server.conf` tells needrestart never to restart
    lgr-server.
  - Instead, the supervisor finds deleted executable mappings under `/usr`, `/lib` and `/lib64` in itself and
    every process under it. Inside `UPDATE_WINDOW` (no till session, no fiscal command, no watched switch,
    once a night) it stops its children as a service stop does and execs itself.
  - ⚠ It execs `/proc/self/exe`, NEVER `current`. A version a package switched to must run from the
    service's next START, where the update helper watches it.
  - The main PID stays, so `NRestarts` never moves. The unit's user `lgr` may not `systemctl restart`
    anything.
  - **Seven nights kept out by open tills raise an alarm** (#373, `Blocked`, the update gate's
    `ALARM_WINDOWS`).
    - Only a till, a fiscal command or an API that cannot say (`Decision::Busy`) counts its night.
    - It shows as `blockedNights`/`alarm` in the status, in the health frame (`nightRestart`), on the
      master's status page and on the server's row on lgrai.app, plus one WARN.
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
- **Preflight (FR-20.13, `preflight.rs`, `lgr-server preflight`):** AVX (or ARMv8.2-A, `dpb`), ≥ 4 GB
  RAM, ≥ 20 GB free, a local fixed disk (no UNC, mapped share, removable, RAM disk, NFS/SMB/FUSE,
  tmpfs, roaming profile), and on Windows the VC++ runtime. The supervisor runs it before starting
  anything: a failure is exit 7, with each reason in words.
- **The front (P1-3b, FR-20.16, `front.rs`), made at every boot:**
  - the front secret, kept in memory and given to the API in its environment;
  - the API's loopback port, picked free;
  - the control socket, `<data>/run/api.sock`. AF_UNIX on every OS, so a data path that makes it
    longer than 100 bytes is exit 7;
  - the names `Host` may carry: the machine's, `<machine>.local` and `LGR_LAN_NAMES`.

  The API's `HOST` (127.0.0.1) and `PORT` are forced: the API answers the supervisor alone (see "The
  API behind the supervisor"). `control.rs` talks HTTP over the socket, through `uds_windows` on
  Windows, where tokio has no AF_UNIX client.
- **Ingresses (`ingress.rs`, hyper 1):**
  - each strips the client's `X-LGR-*`, its hop-by-hop headers and the forwarding headers a client
    can write (`X-Real-IP`, `X-Forwarded-*`, `Forwarded`);
  - each stamps the secret, the source, the peer's address and `X-Forwarded-Proto`;
  - the only client header carried over is the LAN's `X-LGR-Desktop-Token`;
  - a WebSocket upgrade becomes a byte pipe after the API's 101, and an API that is down is 502.
- **The setup console (FR-20.18):** `127.0.0.1:SETUP_PORT` (4480), only until `state/setup-complete`
  exists, then it closes itself. It answers its own address in `Host` only.
  - `lgr-server setup-token` prints `http://127.0.0.1:4480/__lgr/setup#<token>`
    (`keys/setup-token`). It is made on first use, so it works before the first start.
  - The page trades the fragment's token for an `HttpOnly; SameSite=Strict` cookie `lgr_setup`,
    which is stripped before the API sees the request.
  - ⚠ Cookies ignore ports: any other server on 127.0.0.1 receives `lgr_setup` too. That is
    acceptable for a session that only opens setup on loopback, never for a longer-lived credential.
- **The LAN ingress (P1-3c, FR-20.30, `certs.rs`):** HTTPS on `0.0.0.0:LAN_PORT` (4443), only with
  `LAN_INGRESS=on`: a master with no desktops opens nothing on the LAN.
  - It serves the master's own certificate: a CA made once at first start, ECDSA P-256 for 20 years
    (`keys/lan-ca.*`, what desktops pin, so never replaced here), signing a server certificate for
    397 days (`keys/lan-server.*`).
  - The server certificate names the machine, `<machine>.local`, `LGR_LAN_NAMES`, every LAN
    address, `localhost`, 127.0.0.1 and ::1. Every 60 s it is re-issued if those names changed
    (DHCP), and 30 days before it expires; the next handshake serves the new one.
  - The CA's name derives from its own key (the digest's first 6 bytes, hex), so later certificates
    are signed from the key alone. rcgen, rustls and ring throughout: never aws-lc-rs, which needs cmake.
  - ⚠ A port the bind cannot get is a loud error, never a fatal one: the console and the API stay
    up for whoever fixes it. On Windows, PID 4 (System, http.sys reservations) can hold a port.
- **Pairing (P1-6a, FR-20.29) is FR-14's enrollment, against the master.** The fingerprint has ONE
  written form, `sha256:<base64url of the CA SPKI's SHA-256>`, everywhere.
  - With the LAN ingress open, the API is given `LGR_LAN_URL` and `LGR_LAN_CA_FINGERPRINT`.
    `LGR_LAN_URL` is the default route's source address (`certs::default_route_v4`, a UDP `connect`
    that sends nothing). ⚠ Not the first private address: here a Hyper-V switch, 192.168.128.1,
    sorts before the real LAN.
  - A code minted there names that address, whatever address the admin is on (the console is
    127.0.0.1). Its link carries `&fp=…`, and it comes with six words for a code typed by hand: the
    first 66 bits of the digest, 11 a word, from BIP-39 English
    (`services/biz/desktop/fingerprint-words.txt`, MIT, sha256 `2f5eed53…`, kept LF by
    `.gitattributes`). The desktop shell reads the same file.
  - `GET /__lgr/ca.pem` on the LAN ingress answers the CA itself, never the API, with no desktop
    credential. A pairing desktop fetches it untrusted, checks it against `fp` (or a person checks the
    words), then trusts that CA alone.
- **The shell trusts a master by its pin (P1-6b, FR-20.31, `desktop/src-tauri/src/trust.rs`):** one
  client per server for everything the shell sends (enrollment, tokens, `/self`, the manifest,
  presence, the bridge, the updater).
  - lgrai.app: native-tls, the OS store and the system proxy, as before. A paired master: rustls
    with a root store holding only its CA, never a proxy, and `X-LGR-Desktop-Token` on every request
    and WebSocket upgrade.
  - The pin is `settings.master` (`origin`, `caPem`, `fingerprint`), written by enrollment only:
    `save_settings` keeps it whatever the page sends. Enrollment fetches the CA again itself and
    checks it against the fingerprint the page names (`trust::confirm`).
  - ⚠ **A pin applies only to a name no public CA can certify** (`trust::may_pin`): a private,
    loopback, link-local or shared (100.64/10) address, a single label, `.local`, `.home.arpa`,
    `.internal`, `.localhost`. A deep link is attacker-controlled, and
    `server=https://lgrai.app&fp=<theirs>` plus someone in the middle of the shop's network would
    otherwise pin the cloud's own name to their CA, while the window still showed the real site.
  - ⚠ `tungstenite`'s `MaybeTlsStream` is `non_exhaustive`, so every match on it needs one arm per
    transport. The bridge's read-timeout match fell to `_ => {}` for rustls: a loop blocked in `read`
    for ever, past `stop` and past revocation.
  - The updater plugin builds its own reqwest 0.13 client: the pin goes in through
    `configure_client`, which needs the plugin's `rustls-tls` feature (ring). native-tls stays the
    default backend when both are on, for reqwest 0.12 and 0.13 alike.
  - The Rust and TypeScript server-URL rules answer to one table,
    `desktop-ui/src/server-url.cases.json`; they disagreed about `[::1]` and the rest of 127/8.
- **The window reaches a master through a loopback proxy (P1-6c, FR-20.32,
  `desktop/src-tauri/src/proxy.rs`):** `lgr-web` loads `http://127.0.0.1:<settings.proxyPort>`, and
  the proxy forwards to the master over the pinned TLS with `X-LGR-Desktop-Token` (minted by the
  shell, kept 10 minutes, minted again when the master answers a `desktop_*` 401).
  - Only the window gets in. `Host` must be exactly `127.0.0.1:<port>`, `Origin` (when sent) the
    proxy's, and a per-launch secret must ride in the `HttpOnly; SameSite=Strict` cookie
    `lgr_launch`. The window gets it from `/__lgr/boot#<secret>`: the page posts the fragment and
    drops it from the address. ⚠ It is never forwarded and never logged (`web::loggable` strips it
    from the "opened url=" line).
  - `Host`, `Origin` and `Referer` move to the master's origin, and a `Location` back to the proxy's.
    One upstream connection per request: no keep-alive the master closed while idle can swallow a
    POST.
  - The port is the installation's, so the SPAs' per-origin storage survives a restart.
    `settings.webServer` records whose session that storage holds; a window opened for another
    server clears it first. ⚠ An empty value (every install before this) clears nothing: wiping it
    on an update would sign out every till at once.
  - A master never opens in the system browser: a browser would send the launch cookie to every
    server on 127.0.0.1 (cookies ignore ports).
  - Measured in Chrome: `__Host-auth` (`Secure`) is kept on `http://127.0.0.1`, so the master's
    cookies need no rewriting.
  - ⚠ Found on the way: the unreachable page's Retry and Diagnostics were refused on Windows, whose
    bundle is `http://tauri.localhost` (read as a remote page). `act_on_shell_request` now asks
    `is_bundled_host`.
- **Finding a master (P1-6d, FR-20.28):** the supervisor advertises its LAN ingress as
  `_lgr-server._tcp` (`server/src/advert.rs`), with `v`, `node`, `fp` (the CA desktops pin), `name`
  and `ip` in TXT. It is re-registered when DHCP moves the address. The shell browses it
  (`desktop/src-tauri/src/discovery.rs`): the onboarding's "On this network" list, and a paired
  desktop that has stopped reaching its master.
  - On Windows both sides use the OS's own DNS-SD (`DnsServiceRegister` / `DnsServiceBrowse` +
    `DnsServiceResolve`): a per-user app cannot open the firewall for its own multicast listener.
    `mdns-sd` elsewhere.
  - ⚠ Windows answers address queries for the machine's own name ONLY: an advert pointing at a
    name of its own never resolves (the resolve waits until cancelled, status 1223). And it answers
    that name with whichever interface the query came in on: measured, the WireGuard overlay's
    100.65.0.5, not the LAN's 192.168.8.115. Hence `ip` in TXT, which the shell prefers.
  - ⚠ An advert proves nothing. A chosen server is probed and pinned as a typed one is. A server
    whose certificate is not the one its advert claimed is refused, with no tick to override it.
  - **"By identity, not by address":** after three unreachable presence attempts in a row (at most
    every two minutes), the shell looks for its pin's fingerprint (`discovery::locate`). It moves
    only to an address the pinned TLS proves, and moves everything with it: settings, pin,
    `webServer` (the same master's session is not cleared), the proxy via `Running::retarget`
    (same port, so the window keeps its sessions), and presence. The bridge needs a restart, as on
    any re-point.
- **The egress (P1-3d, FR-20.53, `egress.rs`):** on a master the API makes no direct internet call.
  Bun's `fetch` has its own CA bundle and no PAC. The API is given:
  - `HTTPS_PROXY` / `HTTP_PROXY`: `http://lgr:<per-boot secret>@127.0.0.1:<port>`. Any process can
    reach a loopback port; only the API knows the credential. Without it the answer is 407;
  - `NO_PROXY`: loopback;
  - `NODE_EXTRA_CA_CERTS`: the OS's trusted roots, exported at each start (`run/os-roots.pem`,
    rustls-native-certs), so a TLS-inspecting middlebox whose root came by GPO is trusted, plus the
    CA the service's `LGR_SERVER_EXTRA_CA` names: ⚠ the API calls global ITSELF (the feeds, the
    outbox, a move), so a root only the supervisor trusted left the API's calls failing.

  Bun 1.4.4 honours all four, credentials included (measured). Upstream, per CONNECT:
  1. `EGRESS_PROXY` (+ `EGRESS_PROXY_AUTH` for Basic);
  2. on Windows, WinHTTP's machine setting, then WPAD/PAC (`EGRESS_PAC`), cached 5 min, "no WPAD"
     10 min;
  3. direct. `EGRESS_BYPASS` and WinHTTP's bypass list go direct.

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

The desktop is being rebuilt as a **server-mode client** — it opens the LGR cloud app in its own
window, and that is its only mode. `docs/architecture/desktop.md` is the current picture; the spec
is `docs/fr/FR-14-lgr-desktop-app-server-mode.md` (issue #57).

**Deleted, not deprecated:** `packages/desktop-api` (the Bun sidecar), `packages/sync` (imported by
nothing), `packages/dal-sqlite`, the shell's `sidecar.rs` + `archive.rs` and its ten unused
`invoke` commands, `desktop-ui`'s ~50 routes into six other UI packages, `OFFLINE-MODE-PLAN.md`,
and the prototype's five docs.

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
- Gone from the scripts: `dev:desktop`, `dev:desktop-api`, `start:desktop`. `dev:desktop-ui`,
  `build:desktop`, `tauri:dev` and `tauri:build` remain.
- ⚠ The `SQLite Type` columns in `docs/models/**` are **historical** and nothing implements them.
  The per-entity `## SQLite Schema` sections, which cited deleted files, were removed; the table
  columns were left alone rather than risk mangling 49 reference docs by script.

## A master's own backups (2026-10-25, FR-20.21, plan step P1-9)

A master has no mars: nothing like the Layer-1 rsync of the uploads PV backs its files up, and
its database is on the same disk as everything else.

- **The nightly run is `full` on a master** (`nodeRole() === 'master'` and no variant asked
  for). Its files sidecar is ORG-ROOTED: the whole `<UPLOAD_DIR>/<orgId>/` tree, `backups/`
  aside, in format `lgr-backup-files-2`.
  - ⚠ A format of its own, so a reader that only knows `-1` (paths under `docs/`) refuses it
    rather than putting files where they never lived.
  - The restore anchors at whichever root the header names, and never writes into `backups/`:
    a crafted entry there could otherwise overwrite the bundles a later restore needs.
    `restoreTarget` judges every path, on the RESOLVED form (`./backups/x` passed a check of
    the raw string, and on Windows so did `Backups/x` and `backups./x`).
  - The cloud's `full` is unchanged (`docs/` only, `-1`).
- **Every sidecar is read back before the run is called complete** (`verifyFilesSidecar`, the
  files' `verifyBundle`): each entry decoded and checksummed, each path one the restore accepts,
  the count the writer recorded, and the bytes on disk hashed in the same streamed pass. A
  sidecar that fails fails the run. On a master it is the only copy of the uploads.
  - ⚠ **Read sidecar lines through `splitLines`, never `chunk.toString()` per chunk.** A chunk
    boundary inside a Cyrillic character turned it into U+FFFD, and the restore wrote the file
    under a name nothing points at: 3 of 3000 `фактура-*.pdf` paths on a real zstd stream (16 KB
    and 8 KB chunks). The checksum covers the content, not the name, so nothing said so.
- **`BACKUP_LOCAL_PATH`:** a second disk, a USB drive or a NAS path. Each night's bundle and its
  sidecar are copied to `<path>/LGR/Backups/<org>/<kind>/`.
  - **Streamed** in and out: the sidecar is projected at gigabytes.
  - **Read back and re-hashed every night**, then pruned to `BACKUP_LOCAL_KEEP` generations
    (default `BACKUP_KEEP_PER_ORG`), touching only files it wrote.
  - **Not sealed:** FR-20.21 seals what goes off-site, and this stays in the shop.
  - ⚠ A location that is not there is a `failed` destination, never a failed run, and it is
    never created: a "copy" made on the master's own disk would be no copy at all.
  - ⚠ **And on a master, a location on the disk the uploads are on is `failed` too**
    (`localDisk.sameAsData`, `stat().dev`; the volume on Windows). On Linux an unplugged drive
    leaves its mount point behind, an empty folder on the system disk, and "is it there?" passed
    it: the copy landed beside the database, read back fine and said `reached` every night.
    Tests whose folders all share one disk stand a second disk in through that seam (`freshLocal`).
- **Off-site only to Bulgaria or the EU** (FR-20.97, Н-18 чл. 52з(14), 52к(1)). On a master:
  - object storage must be NAMED EU (`s3InEu`: an `eu`/`eu-*` label, or a Hetzner, Scaleway or
    OVH EU site) or attested (`BACKUP_S3_EU=true`);
  - Drive needs `BACKUP_GOOGLE_DRIVE_EU=true` (a Workspace data region; a personal Drive cannot
    choose one).
  - Otherwise the destination is `skipped`, before any network call.
  - ⚠ The region alone proves little: `us-east-1` is SigV4's default answer.
  - ⚠ **The cloud is told, not stopped.** FR-20.97 binds its copies too (§2.8). Enforcing it the
    day this deployed would have stopped production's off-site backups until someone attested a
    region, which is the owner's decision. It logs a warning once a process.
- The cloud vault sealed with the org's own key pair is P2's.

## Till PINs on a master (2026-10-25, FR-20.40, plan step P1-5)

An operator signs in at a till with **operator code + PIN** (6–12 digits, `pinRuleViolation`
refuses runs and repeats). Routes are under `/api/auth/local`, and **every one answers 404 off a
master**, but the `/methods` probe, which says no (`portal-api/src/controllers/local-auth.controller.ts`).
- **Where.** Only a paired desktop on the LAN ingress (`x-lgr-source: lan` plus its token: the
  desktop's org is the org signed in to), or the console. ⚠ Never the tunnel. `frontSource` is the
  supervisor's stamp, and a master with no front offers no PIN at all.
- **Stored** in `local_credentials` (`identityId`, `kind`, argon2id `verifier`, `tvAtSet`): node
  state, no `orgId`, never in a bundle. ⚠ Never on `Identity`, which travels in every bundle of
  the person's orgs.
- **Set by its person** with their password (`PUT /pin`); a PIN session may not. A
  `tokenVersion` bump (a password change, a sign-out everywhere) invalidates it: `pin_not_set`.
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
- **The UI** (P1-5b) appears only where `GET /auth/local/methods` says `pin: true`:
  - The till's `/invoicing/pin` (`PosPinView`) opens when a tab has no session on one of the till's
    pages, and from the menu ("Switch operator");
  - a "Till PIN" card under the portal's account (`TillPinCard`, hidden on a 404).
  - ⚠ Those calls use plain `fetch` (`invoicing-ui/src/pos/composables/useTillPin.ts`), never the shared
    HTTP client. They run with no session, or with the last operator's, and the client's 401
    recovery would sign the tab out or send it to the portal.
- ⚠ **A master's PASSWORD sign-in backs off too.** There the password is the person's local
  credential, so `/auth/login`'s S-08 throttle uses the PIN's curve once a counter reaches its
  limit, never the cloud's 15-minute lock. A lock would let anyone at a till lock the admin out
  for an outage. Password-reset requests still lock: that only stops a mail flood. The cloud is
  unchanged.
- Not yet: local passwords delivered from lgrai.app, and refusing person edits on a linked master
  (P2, with the link).

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

A master renders its PDFs with **`chrome-headless-shell`**, at the build the repo's puppeteer pins.
`bun scripts/fetch-pdf-browser.ts --platform <win64|linux|mac|mac_arm> --out <home>` puts it in
`<home>/chrome/`, and `lgr-server` hands it to the API as `PUPPETEER_EXECUTABLE_PATH`.
- **Override:** `LGR_SERVER_CHROME`, or `PUPPETEER_EXECUTABLE_PATH` in `api.env`. The second is how a
  Linux ARM master names its distribution's Chromium, since Chrome for Testing publishes no Linux ARM
  build.
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
- CI's package boot prints its invoice with the Linux build. A Linux master still needs the
  libraries the tree's `deb.deps` lists, and fonts with Cyrillic (P1-7's packages).

## Masters registered with global (2026-10-25, FR-20.2, plan step P2-1)

Global keeps a registry of the masters that link to it: `ServerNode` (`nodes`, keyed by the master's
own `master-<16 base32>` id) and `NodeEnrollment*` / `NodeAssertion`. The model is
`docs/architecture/nodes.md`.
- **The Servers page** (`/settings/servers`, `admin.settings`) mints a 10-minute code. The master
  redeems it at `POST /api/node/v1/enroll`, together with a `proof` signed by the key it registers,
  then trades assertions at `/api/node/v1/token` for 15-minute tokens. `NodeAuth` denies by default
  and re-reads the row on every request.
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
- **A master registers itself** with `lgr-server register --code XXXX-XXXX` (P2-1b).
  - The running service does the work; the command only passes the code.
  - Its key is `keys/node.key`: DPAPI at machine scope on Windows, a `0600` file elsewhere.
    ⚠ A key that does not open is a refusal, never a new key, since a new key would leave the master
    registered with one it no longer holds.
  - Global is reached through the machine's proxy rules and the OS trust store (`https.rs`).
  - What global answered is kept in `state/registration.json` and shown by `lgr-server status`.

## The uplink, global's side (2026-10-25, FR-20.52, plan step P2-2a)

`/api/node/v1/uplink?ch=interactive|bulk` (`portal-api/src/websocket/uplink.ts`) is a registered
master's socket to global. It is mounted on global only. The protocol is in
`docs/architecture/nodes.md`.
- **Authentication:** the first frame is `hello` (a node token, the channel, a `bootNonce`), within
  10 s. Global answers `welcome`.
- **Liveness and revocation:** pings every 30 s; the node row is re-read every 30 s (4403 revoked,
  4401 a new key); 75 s of silence closes the socket (4408).
- ⚠ **`node_presence` (unique per node and channel) is the clone check.**
  - The same `bootNonce` is the same supervisor reconnecting, and takes its place back (4409 to the
    old socket).
  - A second LIVE connection with another `bootNonce` raises `clone-alarm` on both sockets and on
    the node (`ServerNode.cloneAlarm`). That stands until an admin re-registers the node.
- Pages and tunnel traffic (P3) must check `isTrusted(ws)` AND that the org is in the node's
  `orgIds`.
- **The supervisor holds both sockets** (`packages/server/src/uplink.rs`, P2-2b), one task per
  channel.
  - It is woken by `lgr-server register`.
  - The socket rides the TLS stream `https.rs` makes, through the machine's proxy rules and the OS
    trust store.
  - ⚠ 4403 stops the uplink until the master registers again. It never stops the shop: the
    supervisor and the API keep running.
  - `lgr-server status` shows each channel's state, and `CLONE ALARM`.
- **Control (P2-3a).**
  - The master sends `health` every 60 s on the interactive socket.
  - Global keeps it sanitised on `ServerNode.health`. ⚠ Only known fields, bounded, with undefined
    dropped: a Mixed field would store each undefined as null. At most one per 20 s.
  - `master_outdated` answers a master below `NODE_MIN_MASTER_VERSION`, or naming no version. It
    stays connected for its update; nothing else trusts it.
  - `/api/admin/nodes` (the "All servers" page) lists every master across orgs, for the
    `BACKUP_SYS_ADMINS` allow-list only. The licence waits on Q4.
- ⚠ `ServerNode.cloneAlarm` is a single nested subdocument with `default: undefined`. As a nested
  path holding an array it defaulted to `{bootNonces: []}` on every node, and every hello read as an
  alarm.

## Desktop updates through the master (2026-10-25, FR-20.56, plan step P2-7)

A master keeps its tills' desktop release (`docs/architecture/nodes.md`).
- The supervisor (`desktop_releases.rs`, every 6 h) reads `/api/node/v1/desktop-release` with its node
  token. That is global's configured version, its files and the updater signatures. The bytes come
  from the public download endpoint into `<data>/desktop-releases/`.
- The master's API serves `/update`, `latest-release` and the downloads from there, on its LAN address.
- ⚠ `current.json` names a version only once every file is whole, at its listed size.
  `release-cache.ts` serves only listed release files at their recorded size, inside the
  directory. A part-file or a leftover is never served.
- On global the route is 204 until a release can be served: `DESKTOP_RELEASE_VERSION` set and
  `DESKTOP_RELEASE_GITHUB_TOKEN` sealed.

## Licences on a master (2026-10-25, FR-20.55, plan step P2-3b)

An org on its own server runs under a licence global signs (`docs/architecture/nodes.md#licences-fr-2055`).
- Global: `services/biz/licence/licence-issue.service.ts` (who is entitled: a paid Enterprise
  subscription or a sys-admin's pilot, `OrgLicence`) signs with `LICENCE_SIGNING_KEY` (sealed). The
  uplink sends it in `welcome` and in `entitlements` frames. Sys-admins: `/admin/licences` (pilots,
  and a licence FILE for an air-gapped master).
- The keys a master accepts are `packages/config/src/licence-keys.json`, read by the API AND the
  supervisor (`include_str!`). ⚠ A production master accepts those and nothing else; outside
  production a process also accepts the key it signs with (`allowInDevelopment`).
- The master: the supervisor keeps `state/licences/<orgId>.jws` (`licence.rs`;
  `lgr-server licence import <file>`), and the API verifies it again on every change
  (`master-licence.service.ts`). It must name this org AND this master.
- **What it stops**, from the local midnight after paid-through + 30 days (or after a 30-day
  evaluation when there is no licence): a new till sale, a new invoice / proforma / cash sale, a new
  client order, and the three converts (`licence-gate.ts`, 402 `licence_expired`). Nothing else.
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

A master's mail is sent by global on its behalf (`docs/architecture/nodes.md#mail-through-lgraiapp-fr-2059-fr-2086`).
- On a master `sendEmail` QUEUES (`Outbox`, node state) and answers `{ok: true, queued: true}`.
  ⚠ Callers must say "queued", never "sent": the invoice email route answers 202, the digest run
  says `queued`, and an invoice's `emailedTo` changes only when the mail has gone.
- `relay/outbox-worker.ts` drains it to `POST /api/node/v1/relay/mail` with the supervisor's node
  token (`state/node-token.json`, `LGR_NODE_TOKEN_FILE`). `OUTBOX_INTERVAL_MS=0` disables it.
- Global (`relay/mail-relay.service.ts`) relays only what the org's admin turned on for that server
  (`ServerNode.relays[]`, per org; unset = on at Full, off at Control), with fixed caps and a
  7-day receipt per outbox id (`RelayReceipt`).

## Sign in with LGR (2026-10-25, FR-20.39, plan step P2-4)

A master signs its people in with their lgrai.app identity (`docs/architecture/nodes.md#sign-in-with-lgr-fr-2039`).
- Global: `services/biz/idp/idp.service.ts` (`/api/idp/client`, `/api/idp/authorize`; identity-only
  sessions may use them) issues 60-second single-use codes (`IdpCode`, node state) bound to the
  server, the redirect and an S256 challenge; `POST /api/node/v1/idp/redeem` turns one into a
  5-minute assertion signed with `IDP_SIGNING_KEY` (sealed, lgr-deploy 0a22ec0).
- The master: `/api/auth/idp/config` and `/api/auth/idp/redeem` (public, 404 on global) redeem
  with the supervisor's node token (`state/node-token.json`) and verify with the BUILT-IN keys
  (`config/src/idp-keys.json`, kid `S6iuZQxKWBBlip1p`), then `enterOrg(…, 'lgr')`.
- ⚠ The identity keys are not the licence keys, and the JWS types differ (`lgr-idp+jws`): an
  assertion can never pass for a licence. Both use `services/biz/crypto/ed-jws.ts`.
- UI: `views/idp/IdpAuthorizeView.vue` (lgrai.app), `views/auth/IdpCallbackView.vue` and the button on
  `LoginView` (a master). The verifier stays in the tab (`views/auth/idp.ts`).
- Not yet: the desktop's `lgr://login` path for a master, local credentials set on lgrai.app and
  their delivery (`cred-sync`), and the identity feed (P2-5).

## The identity feed (2026-10-25, FR-20.43/44, plan step P2-5)

A master pulls its people's changes from lgrai.app (`docs/architecture/nodes.md#the-identity-feed-fr-2043-fr-2044`).
- `services/biz/identity/identity-feed.service.ts`: global's `identityChangesFor` behind
  `GET /api/node/v1/identity-changes` (members of the node's orgs, by an `updatedAt|_id` cursor), and
  the master's `identityFeedTick` (every 30 s, `IDENTITY_FEED_INTERVAL_MS=0` disables it) applying
  them with `forgetIdentity`, so a password change or a deactivation ends the person's sessions there.
- ⚠ The payload is email, names, `tokenVersion` and active, nothing else (FR-20.44). A new field
  there needs the same care: `identity-feed.flow` scans for hash and token shapes.
- `NodeState` (`node_state`): a master's own small records by name. No `orgId`, so never bundled.

## The server packages (2026-10-25, FR-20.10, plan step P1-7)

`.github/workflows/server-release.yml` builds what a shop installs (`docs/guides/server-install.md`):
a signed per-machine **MSI** (`packages/server/wix/main.wxs`), a **.deb** (`packaging/nfpm.yaml`) and a
**tarball**, from a home `scripts/assemble-server-home.ts` lays out. Signed like roomlerd: roomler's
`sign-windows` (G ROX LTD) on `lgr-server.exe` BEFORE the MSI is built and on the MSI after; roomler's
release GPG key on every asset; SLSA provenance. A `server-v*` tag publishes (a prerelease for now);
a pull request touching it builds unsigned and installs.
- Bun and `mongod` are pinned by their vendors' sha256 (`packages/server/runtime.lock.json`, mongod =
  global's 7.0.30); Chrome by `pdf-browser.lock.json`. On Windows the VC++ runtime ships app-local,
  for `mongod`, inside the version.
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
- CI installs each one before it ships: the MSI on the runner (service account, files, firewall rule,
  the API up, a clean uninstall that keeps the data), the .deb in Ubuntu 22.04 and 24.04 containers
  (every library resolves; the supervisor runs as lgr).

## The mirror: capture, pages, the apply (2026-10-25, FR-20.61–20.67, plan steps P3-1, P3-2a, P3-2b)

A master journals its own writes and sends them to lgrai.app's mirror of the org as pages
(`services/biz/replication/`). What replicates is each model's `replicate()` decision (P3-1a).
- **Capture** (`capture.ts`, `engine.ts`, P3-1b): one change stream → `repl_journal`, one row per
  document (its latest seq), in one transaction per batch with the resume token. Lost history raises
  the journal epoch and journals everything again. Masters only, and it follows the link: on while the
  supervisor's registration (`LGR_REGISTRATION_FILE`) says Full, stopped when it goes down (the
  journal stays); `LGR_REPLICATION=on|off` overrides.
- **Pages** (`pages.ts`): the rows above global's watermark, each document as it is NOW (one snapshot
  read), or a tombstone. Split documents carry their home's parts only (`project.ts#homePart`). BSON
  per document inside the page, zstd around it, at most 1,000 documents or 4 MB.
  - ⚠ Documents are read and decoded with `promoteValues: false`. A JavaScript round trip turns an
    integral `Double` into an `Int32` and a `Long` into a number: the hash would not match, and the
    mirror would hold other types than the home.
  - ⚠ A page is built only once the org's seeding at the current journal epoch has finished
    (`ReplOrg.seededEpoch`): seeding hands out seqs outside the tailer's transactions, so before it
    ends a lower seq can appear below a page already sent.
  - ⚠ The master continues only from a page it built itself (`ReplOrg.pages`, the last 32). Global
    may tell it the chain hash it holds, but only to pick among those: a restored, reverted or cloned
    master that adopted global's hash would pass for the one whose history it lost (FR-20.51).
- **The apply** (`apply.ts`, on global): refused whole, with an alarm in `mirror_state.alarms`,
  unless the hash matches, the sender is registered for the org (not revoked, no clone alarm, linked
  at Full: FR-20.54's Control sends no business data, and global enforces it) and its home at the
  page's epoch, and every row is a replicated collection of that org with stored file
  paths under it. Then ONE transaction of raw driver writes, the watermark and chain last.
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
  - A `User` naming a person the mirror's copy does not already name is applied WITHOUT `identityId`
    (FR-20.63), with an alarm. A membership new to the mirror gets inert person fields
    (`<id>@inert.invalid`), because `email` and the names are global's and `{email, orgId}` is unique.
- **The transport** (P3-2b: `control.ts`, `websocket/uplink.ts`, the supervisor's `replication.rs`):
  the supervisor asks the API's control socket for a page (`POST /replication/page {orgId, after,
  afterHash}` → the bytes, 204, or 409 with the reason) and sends it as ONE binary frame on the bulk
  socket. Global answers `page-ack` / `page-refused` / `page-error`; a `resend`'s ids travel as EJSON
  to `POST /replication/resend`. The bulk `welcome` says where each mirror stands (FR-20.67). One page
  in flight per org; `behind`/`gap` start again from global's watermark; another history, an older
  epoch or an unknown chain STOPS that org (a re-seed is P3-7's, and a person's call); the rest waits
  10 minutes. A NEWER journal epoch that continues the chain is applied and reconciled (P3-7f, below).
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

The Servers page's "Move here" (server at Full) → `/api/org/:orgId/moves` (`move.controller.ts`:
`preflight`, start, `current`, `:id/abort`; `admin.settings`, global only). lgrai.app runs it
(`services/biz/move/move.service.ts`, `org_moves`, node state: freezing → copying → verifying → done
| aborted); the master takes it (`move-worker.service.ts`, every 10 s on `GET /api/node/v1/moves`,
then `…/:id/bundle`, `…/files`, `POST …/copied {digests, people, credentials}` or `…/failed`).
Operator page: `docs/architecture/nodes.md#moving-an-org-to-its-master-fr-2079`.
- **Freeze**: `OrgHome.state: 'freezing'`; the copy waits 2 × `HOME_CACHE_MS` (10 s), then revokes the
  desktop enrollment codes/keys and builds `move-bundle.ts`'s copy (+ the org-rooted files sidecar).
- ⚠ **The copy carries the org's PEOPLE** (`$people`, `PEOPLE_FIELDS`: who they are, never a password,
  OAuth link or other org) **and their local credentials sealed to the master's seal key**
  (`$credentials`, `sealedCredentialsForMove`). A master's sign-in needs its own `Identity` row, and
  BOTH feeds skip people a master does not hold and move their cursors past them: without these
  sections nobody signs in at the site, and the credentials would wait for the next daily full pass.
  After the import `forgetFeedCursors()` makes both feeds run from the start once.
- ⚠ Canonical EJSON per document read with `promoteValues: false` (the mirror's type rule), and the
  digests are a function of the DATABASE (`collectionDigests`), computed by both sides over the same
  projection; the flip waits for them and for the people/credential counts.
- **Flip** (one transaction): `OrgHome {home: node, epoch+1, active}`, `Org.homeEpochHighWater`, the
  org's `mirror_state` deleted (the master's first pages re-send the copy, idempotent, on a new chain);
  then `rewelcomeNode()` closes the node's bulk socket (4410 `home_changed`; other pods notice in their
  30 s tick) because the pump pages only the orgs its welcome named.
- ⚠ **The audit trail is org data**, refused like any other write once the org is frozen or gone: the
  start's entry is AWAITED before the freeze (`recordAuditEntry`, so it is in the copy), an abort's
  after the unfreeze, and the master writes the arrival once the org is home there.
- ⚠ **Global's own org-scoped records are refused by the write guard during the freeze too**
  (`DesktopEnrollmentCode/Key` carry `tenantPlugin`): those revocations, `homeEpochHighWater` and
  `mirror_state` are raw writes, listed in `home-write-guard.flow`'s `RAW_WRITE_SITES`.
- **The master**: frozen at the new epoch, then an import into an EMPTY org only (refuses data already
  there, or a person whose email another holds); a person it holds already keeps their record, with
  `tokenVersion` only raised; the people it adds are recorded in `node_state` (`move:<id>`) BEFORE
  they are inserted, so an abort removes exactly those still unreferenced. A lost `copied` report is
  sent again without importing again; only global's answer moves the move on.
- A flip is claimed INSIDE its transaction: a report sent again after a crash between `verifying` and
  the flip finishes it, one after the flip is answered done, and a late second flip changes nothing
  (it would otherwise delete the mirror's new chain).
- The desktops follow (P3-6b, below), the org can move back (P3-6c, below), a lost server's copy
  can be promoted (P3-6d, below), and a fenced server's work reaches lgrai.app and is brought into
  the books (P3-6e, below). A number issued twice is kept and corrected (AC 51, below).
  - ⚠ `collectionDigests` hashes canonical EJSON in STORED field order, and the mirror's apply
    reorders a split document (`$mergeObjects: [home, kept]` puts global's fields last). So the move
    back compares with `homeDigests` instead, which is order-insensitive.
- Tests: `move.flow` (12: the copy's types and contents, tampering and a forged password refused,
  preflight, freeze → copy → flip with the bulk re-welcome, mismatch and abort, a flip cut short, the
  master's import, activation, a lost report, the abort's people rule, the refusals, and the routes) and
  `bun packages/tests/src/two-node/move-e2e.script.ts` (real processes, as `mirror-e2e`: 18 checks
  from preflight through the flip to the mirror equal again).

## Desktops follow their org's home (2026-10-26, FR-20.82, plan step P3-6b)

After a move to a master, global tells each of the org's desktops where the master answers and which
CA to pin there; the desktop keeps its id and its key (its registry row moved with the org, FR-20.63),
so nothing is re-enrolled. Global's half: `services/biz/desktop/repoint.service.ts#movedFor`.
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
  - **Not enforced while `declared` is empty** — LGR is not on НАП's list yet, and nothing waits.
    Once it is not: a declared version travels, so does a build within the running version, and
    anything else waits. A release naming no version waits too (it cannot be shown declared).
  - **Masters:** the release publishes `lgr-server-<v>.supto` and the home's `HOME.json` carries
    `supto`; global's offer adds `supto {version, declared, enforced}`, declared-ness computed at
    read time against global's own build (a declaration needs no new release). The supervisor does not
    wake the helper for a waiting one (`update.suptoWaiting`, the `supto_waiting` alarm); the
    helper asks the same rule, and after the download checks the bundle's `HOME.json` against the
    offer's claim — the signed bytes, not the offer, decide.
  - **lgrai.app's own deploys:** `deploy-prod.sh`'s `supto_gate` reads the checkout's file and the
    pod's own copy (`kubectl exec … cat`; `SUPTO_RUNNING=<v>` when the pod cannot say) and refuses a
    build of an undeclared new version. A `--tag` redeploy builds nothing and is not gated.
  - The master's status page shows the SUPTO version that runs, and Прил. 32 lists it.
- **Home records fail closed on lgrai.app (FR-20.3, AC 55, P3-8d; `services/biz/home/home-hold.service.ts`).**
  `homeOf` already DERIVES a hold from the record (a missing row after a move, a row that disagrees
  with `homeEpochHighWater`); these are the holds global TAKES, stored as `OrgHome.hold {reason,
  since, from, claim?}`:
  - **`higher_epoch`**: a master registered for the org reports, in its minute org-state report
    (now with `epoch` + `state` per org), a newer home record than global's — global's database is
    older than the org's last move. ⚠ Only an `active` row is a claim: during a move the master
    writes its row at the NEW epoch as `frozen` before global flips (move-worker), and holding then
    would break the move's own flip precondition. Not from a revoked server, nor for an org it is not
    registered for.
  - **`dr_restore`**: the runbook's step right after a Layer-1 restore (lgr-deploy
    `docs/BACKUP-RUNBOOK.md` §4 step 2b): every org with a server, or a high-water mark, or a row.
    Released by its home server reporting the SAME record; an org homed on global, or a newer record,
    waits for a sys-admin.
  - Settled on the sys-admin Nodes page ("Organizations on hold", `/admin/nodes/held`): **release**
    (global's record stands; the high-water mark is made to agree) or **adopt** (the server's claimed
    record becomes global's, only from a server still registered). ⚠ The routes take `:id`, never
    `:orgId`: the tenant guard and the home gate key on that name and would refuse a sys-admin
    settling an org on hold. Global's audit log cannot take it (the org is on hold): the row keeps
    `released`, and the log line says who. The Nodes page raises `home_hold` per server.
- **An org's address on the internet (FR-20.72, P3-4a; `services/biz/address/org-address.service.ts`).**
  `OrgAddress {label, orgId, state: requested | active | refused | retired}`, global's record about the
  org: node state, never in a bundle, no `tenantPlugin` (so the write guard does not see it).
  - **The label is the org's slug WHEN REQUESTED**; a rename does not move it. It must be a DNS label of
    at most 63 characters, with no punycode, and not reserved (the built-in list plus
    `ORG_ADDRESS_RESERVED`).
  - At approval the label must also have **no record of its own in the zone**: no CNAME, MX or TXT,
    and no A record that differs from a random label's (that one is the wildcard).
  - **The org's licence must include on-prem** (`entitlementsOf`).
  - **The flow.** The org admin asks on the Servers page (`POST /org/:orgId/address`). That route is
    in `GLOBAL_STATE_WRITES`, because the org is usually homed on its server. A sys-admin then
    approves, refuses or retires it on the Nodes page (`/admin/addresses/:id/…`, `:id` never
    `:orgId`). A refusal needs a reason and frees the label.
  - ⚠ **A label is issued once.** The unique index covers requested, active and retired. A retired
    address answers with a notice for 12 months and is never issued again.
  - **"Sign in with LGR"** now returns a person only to an ACTIVE address of the server's orgs
    (`activeLabelsOf`), no longer to any slug.
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
  - **Routing** (cached 10 s):
    - an ACTIVE address of an org homed on a master REGISTERED for it tunnels;
    - a requested or refused address, no address, or an org homed on lgrai.app answers exactly like
      an unknown label: 404 (a page, or JSON for an API client);
    - a retired address answers 410 for its 12 months;
    - a server that is not connected gets a 503 static notice, never a sign-in page (FR-20.75).
  - **The edge** (FR-20.78). A credential is a non-empty bearer token or a non-empty `__Host-`
    cookie; global checks only that one is present, and the master validates it. Without one, only
    these pass: GETs outside `/api/`, `/api/auth/idp/*`, and WebSocket upgrades. Anything else is
    401. Anonymous requests are limited per address (600/min) and per client (120/min), counted per pod.
  - **The wire** (`services/biz/tunnel/tunnel-frame.ts`; the supervisor mirrors it). It runs on the
    INTERACTIVE uplink, and only over a socket `isTrusted` accepts.
    - Frames: JSON control frames `tun-open`, `tun-credit`, `tun-cancel`, `tun-head`, `tun-error`,
      `tun-ws-open` and `tun-ws-close`; binary `LGRT` data frames of at most 64 KB.
    - Each stream gets a 256 KB credit window in each direction, used whole and never exceeded.
    - An HTTP stream idle for 120 s is closed (504); WebSockets are not timed.
    - A link drop fails its streams. A GET or HEAD with no answer yet is retried once, on the server's
      next socket.
    - Headers: request headers cross without hop-by-hop headers, `X-LGR-*`, forwarding headers or
      the WebSocket handshake's own. A response's `Set-Cookie` loses any `Domain`.
  - ⚠ **Elysia's WebSocket wrapper turns anything but a Buffer into text.** Binary goes out through
    `raw.sendBinary`.
  - ⚠ **The browser's WebSocket is upgraded inside `onRequest`**, with `server.upgrade(req, {data:
    handlers})` (Elysia dispatches to `ws.data.*`), and the hook returns a 101.
  - **Across pods** (P3-4d; `forward.ts`, `hop.ts`, `pod.ts`). A request may land on a pod that does
    not hold the server's interactive socket. That pod forwards it to the pod that does, found by the
    uplink's presence row, which now records `podAddr`.
    - `podAddr` is `LGR_POD_ADDR`, else `http://<POD_IP or the first non-internal IPv4>:<PORT>`.
    - The row must be fresh (75 s), must not be under a clone alarm, and must name another pod.
    - HTTP is streamed both ways, byte for byte (`decompress: false`). A WebSocket is accepted here
      and opened there.
    - The forward is a HOP: `X-LGR-Hop: <ts>.<HMAC>` over the time, the method, the `Host`, the path
      and `X-LGR-Hop-Client`, keyed from `JWT_SECRET` and valid for 30 s.
    - A hop has passed the edge already and keeps the browser's address. ⚠ It is NEVER forwarded
      again: a socket gone from both pods answers offline instead of bouncing.
    - A hop that does not verify is the client's own request, so the edge applies. Every `X-LGR-*`
      is dropped before the server either way.
    - The other pod unreachable: offline. Only an `offline` failure forwards, since nothing of the
      request was sent; a link lost mid-request never does.
- **The tunnel, the server's side (FR-20.73, P3-4c; `packages/server/src/tunnel.rs`).** The supervisor
  carries the streams on its INTERACTIVE uplink only, and not while that socket is suspended or
  outdated. A clone alarm ends the tunnel along with every stream in it.
  - **One task per stream.** An HTTP stream goes to the API's loopback port. The request body is
    passed on as global sends it, and credit goes back as the API takes each chunk. The answer goes
    out only within the credit global grants. A WebSocket stream opens its own socket to the API and
    carries whole messages, up to 1 MB each.
  - **Stamped exactly like a LAN request** (`ingress::stamp`, `Source::Tunnel`):
    - the client's `X-LGR-*` and forwarding headers are dropped (global drops them too);
    - the front secret, the source and the client's address are stamped;
    - the org's address is the `Host`.
  - ⚠ **The API answers `<label>.<ORG_ADDRESS_APEX>` ONLY for the `tunnel` source**
    (`front-guard.ts#isOrgAddressHost`). The same name from the LAN is 403 `host_not_allowed`. The
    tunnel source is never held to the LAN's desktop-credential rule, and creating an org stays the
    console's.
  - ⚠ The session loop drains the socket's outbound channel, so nothing in it may wait on that
    channel. An immediate answer goes out through a spawned send.
  - Proven end to end in `two-node/move-e2e.script.ts`: a master-signed session, a write, a bundle
    larger than one window, a WebSocket, a forged stamp dropped, and a 404 once the org has moved back.
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
- **Where an inspector reaches the server (FR-20.47, P3-8e; `node/inspection.service.ts`).** Н-18
  чл. 52и(1): every device of the СУПТО, servers included, reachable "незабавно".
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
- **Where the master answers**: the supervisor's health frame carries `lan {url, caFingerprint}` from
  `state/lan.json` (only while the LAN ingress is on); `sanitizeHealth` keeps it only in the shape a
  desktop takes (`LAN_URL`, `CA_PIN` in `repoint-token.ts`).
- **A re-point** (`desktop:repoint {instruction, node, name}` on `/ws/desktop`): an EdDSA JWS, typ
  `lgr-repoint+jws`, for ONE desktop (`sub`), its org, the master and the move's epoch, the
  master's LAN URL and CA pin; 30 days. Signed with `REPOINT_SIGNING_KEY` (sealed in lgr-secret),
  verified by the desktop against `config/src/repoint-keys.json` built into it. ⚠ The signature is
  the point: a till reaches lgrai.app through the machine's trust store, so a TLS-inspecting middlebox
  it trusts could otherwise send it to a server of its own, pinned from then on.
- **`desktop:moved {node, name}`** instead when global cannot say where (no `health.lan`, the node
  removed, no key): the shell says the org moved and offers to pair.
- **When**: at the flip (`repointOrgDesktops`, after `copied`), at every later authentication, and
  on the heartbeat (a flip on another process), each followed by `desktop:error {code: 'org_moved'}`
  and a close: a shell older than P3-6b takes that as any refusal. ⚠ Nothing of a moved org's desktop
  is written on global (`lastSeenAt` would be refused: the rows are the mirror's now).
- A moved org's desktop on the fiscal bridge is refused `org_moved` before its device is marked
  online, and a write a desktop route makes (`PUT /desktop/v1/self`) answers the home gate's 409
  (`spaErrorHandler` maps `HomeElsewhereError`, which was a 500).
- Global only: the move back (P3-6c) is the master's to announce.
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
- **Preflight**, every check at once:
  - the org's home is one of its servers, which is registered, at Full, with no clone alarm,
    connected on both sockets and healthy;
  - no till open and no fiscal command in flight there (its health frame's `posOpen` and
    `fiscalInFlight`; unknown is not 0) and no open session among the mirrored rows;
  - a live mirror (no reconcile running: `mirror_state.reconcile` done, or none), and a whole one
    (no document set aside, `mirror_whole`, P3-2c);
  - every file the mirror's rows name is on lgrai.app or on its way. A file the server cannot send
    blocks the move unless the admin leaves it behind (`allowMissingFiles`).
- **Asked** (`freezing`): global records the move and re-welcomes the master, so a records-only
  org's files travel now (`movingBack`). The master's worker (every 10 s) refuses while a till is
  open, a fiscal command prints or a job runs (`failed`). Otherwise it writes the move into the
  org's audit trail (here, the org's home) and freezes the org: `OrgHome.state: 'freezing'` at the
  same epoch. ⚠ The capture never disables an org, so a frozen org's last pages and files still go.
- **Drained** (`copying`). From `DRAIN_AFTER_MS` after the freeze (twice the home cache, plus a
  capture round), the master reports its journal head (`POST /api/node/v1/moves/:id/drained`) on
  every tick. Global answers what it still waits for:
  - `pages`: the mirror's watermark below the head;
  - `files`: `mirrorFilesStatus` not complete;
  - then `need: 'digests'`: the master sends `homeDigests` (at most once a minute);
  - `wait: 'digests'` with the collections that differ, until they are equal.
  - ⚠ A mismatch WAITS (a page may still be on its way); only the timeouts abort: 30 min to freeze,
    6 h to drain.
- **Verified** (`verifying`). Global's move-back tick puts every file back where its row says
  (`placeFilesBack`: from the content store, a file already there with the right bytes stays, one
  with other bytes is replaced; idempotent), because global reads an org homed here BY PATH. Then
  the flip.
- **The flip**, in one transaction that first claims the move:
  - the epoch up by one, the home global, `homeEpochHighWater`;
  - the org's `mirror_state` deleted.

  After it, the content store (`dropMirrorBlobs`) goes, and the master is re-welcomed.
- **The master** hears `done` (from `drained` or its moves) and sets its home record to
  `{home: 'global', epoch}`. It keeps a read-only copy (its home gate refuses writes). ⚠ A later move
  to that master needs the copy removed first: the import refuses an org with data.
- **Its desktops follow** (FR-20.82, the second step):
  - `drained`'s `done` answer carries one CLOUD re-point per active desktop of the org
    (`cloudRepointsFor`): the same JWS as P3-6b's, signed afresh on every answer with
    `REPOINT_SIGNING_KEY`, but with `node: 'global'`, `server` = global's own public https origin
    (`OAUTH_BASE_URL`) and NO `fp`;
  - the master keeps them (`keepCloudRepoints`, `NodeState cloud-repoint:<org>`), asking global
    again if the answer was lost;
  - its `movedFor` hands each desktop its own instruction (`desktop:repoint`), or `desktop:moved`
    for one global signed nothing for;
  - the shell (`repoint.rs`) believes a pinless one ONLY for the cloud built into it (`CLOUD`, `https://lgrai.app` unless
    `LGR_CLOUD_URL` at build time): anything else is `not_our_cloud`, and a cloud one carrying a pin
    is `bad_claims`. Followed, it drops the master's pin, saves the cloud and the epoch, and restarts.
    ⚠ Without that rule a pinless instruction would send the till wherever its signer said, trusted
    through the OS store.
  - ⚠ Both verifiers test the cloud cases against the one vector (`repoint-vector.json`, regenerated
    with a new throwaway key: `jwsParts`, `cloudJwsParts`, `cloudOtherJwsParts`,
    `cloudPinnedJwsParts`).
  - Until a desktop release carries the shell's half, the desktops show the org-moved banner and
    re-pair by hand.
- **An abort** (the admin, a refusal, a timeout) leaves the home where it was; the master unfreezes on
  its next report. Global writes no audit entry for it: the org's trail lives on its master.
- `homeDigests` (`move/home-digest.ts`): per collection, over `homePart` (what pages carry, never
  global's or a node's own parts), canonical EJSON with keys sorted at every level (arrays keep their
  order), type-exact (`promoteValues: false`).
- Tests:
  - `move-back.flow` (7): the digest, the preflight, the drain from pages to files to digests, the
    placement and flip, a wrong file replaced, abort and timeouts, and the master's freeze, report,
    leave, refusals and unfreeze;
  - `two-node/move-e2e.script.ts`: the forward move, then BACK with a real `lgr-server` (a file the
    shop made comes home by content and lands at its stored path; global writes the org again).

## Promoting lgrai.app's copy of a lost server (2026-10-27, FR-20.81, plan step P3-6d)

When an org's server is gone for good, the org admin makes lgrai.app's mirror its home: "Promote
lgrai.app's copy" on the Servers page, on the home server's row while it is not connected
(`POST /api/org/:orgId/moves/promote/preflight`, `POST /moves/promote`). Global:
`services/biz/move/promote.service.ts`; `org_moves` with `kind: 'promote'`.
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

    Refused at the allocation alone, a `/send` would leave a draft that had already dispatched.
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
- Banners (P3-5): `home.seriesFrozen` on lgrai.app while frozen, `home.fenced` on the old server.
- Tests: `promote.flow` (4: the evidence; the flip, the freeze and the last numbers; the old
  server fencing itself; every issuing path refused before it moves anything) and
  `bun packages/tests/src/two-node/move-e2e.script.ts --promote` (real processes, 32 checks: the move
  to a real `lgr-server`, a file the shop made, the supervisor stopped, the promotion, numbering frozen
  then resumed above the site's number, and the restarted server fenced at exactly the cutoff).

## A master whose database went back locks its legal series (2026-10-27, FR-20.51, plan step P3-7, first slice)

A restore, a reverted snapshot or a clone can make a master issue a legal number the site already
gave a customer. So, on a master, for an org written there, the legal series LOCK
(`OrgHome.seriesFrozen`, the lock a promotion sets) until a person records the last numbers.
`services/biz/home/series-lock.service.ts`; `assertSeriesOpen` and the issuing paths' early refusals
(P3-6d) enforce it.
- **What locks them** (reason `restored` | `went_back` | `clone`, with a detail):
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
- **lgrai.app is told** (`reportOrgState`, every minute, `POST /api/node/v1/org-state` →
  `recordOrgState` → `ServerNode.orgState`): per org written there, the journal's head, the
  went-back record and the numbering lock with its reason. Kept for the orgs the server is registered
  for only, known reasons only, text cut short, no date after now; `orgStateFor` puts ONE org's on the
  Servers page (chips "Database went back", "Numbering locked" with the reason as a tooltip, ×4).
  The master's word, shown to the admin: nothing on lgrai.app decides on it.
- ⚠ **A Replace restore is REFUSED on a master lgrai.app knows** (`replaceRefusedHere`, before
  anything is read or written, no `RestoreRun` row): registered at any link level, capturing, or with
  pages of the org built. Its deletes and rewrites are journaled like any other write, so its pages
  would carry the backup's state to the mirror and delete there what the backup lacks (AC 36's "cannot
  overwrite the mirror"). The way back to a backup is a move to lgrai.app and a restore there; Merge
  stays available.
- **The unlock** (`numbering.controller.ts`, `GET`/`POST /api/org/:orgId/numbering/last-numbers`,
  admin, every node; the card on the Servers page, with the reason):
  - each series resumes above the person's reading and, on a master that can ask, the mirror's
    numbers (`GET /api/node/v1/legal-series?orgId=`, `mirrorLegalSeries`; ⚠ a query parameter: a
    path with `:orgId` is a user's org route to the tenant guard); with the link down,
    the person's reading stands alone;
  - and, on a master, above its own legal mark (#549, `legalMarkOf`), with an audit change per
    series the mark raised past the reading; the GET returns it as `mark`;
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
- **The fiscal device as a witness** (AC 49; `home/device-witness.service.ts`). While numbering
  waits, `GET /numbering/last-numbers` asks each active device of the org for its last document
  (`getLastReceiptNumber`, 5 s). Beside it is the last fiscal receipt this database recorded on the
  device (`register.fiscalReceiptNumber` by `register.fiscalDeviceNumber`), and how many documents
  the device printed since. The `POST` reads them again and keeps them in its audit entry
  (`fiscal device <number>: last document`, the database's receipt → the device's word).
  - ⚠ **Evidence, never a lock or a floor.** An Eltrade's 71h counts every document: receipts,
    stornos, text receipts, X and Z reports, and the keyboard's. So a device ahead is normal after a
    Z-report, and no LGR series steps with it. Locking on it wants the device: what its counter
    counts, and whether it moves when the device sells on its own.
  - States: `read`; `unsupported` (Tremol); `not_connected` (no bridge here: another pod or
    process); `error` (including no answer in 5 s). Nothing asks a device while numbering is open.
  - Tests: `device-witness.flow` (3).
- Bringing a re-seed's kept sales into the books is P3-7g (below).
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
- **Start** (`POST /moves/reseed {slug}`): created `copying` with `buildingAt: new Date(0)`, so
  `moveTick` takes it at once as "a build that died long ago"; it builds the move bundle of global's
  MIRROR (credentials sealed to the server's key) and `buildMirrorFilesSidecar` (every file the
  mirror's rows name, read from the content store by hash, at its row's path; `buildFilesSidecar` now
  takes explicit `entries`). Nothing freezes on global, and global writes none of the org's trail.
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
- **Aborted**: the server puts back what it replaced from the kept copy, then unfreezes (a rollback
  that fails leaves it frozen, loudly). An abort before anything was replaced only unfreezes.
- The Servers page offers "Re-seed from lgrai.app's copy" on the home server's row while it is
  connected and says its database went back; the dialog runs the preflight, says what is replaced and
  kept, and wants the slug. The move banner says, when done, how many documents were kept and the
  issued sales among those lgrai.app lacked (×4).
- **The kept sales into the books (P3-7g; `move/kept-import.service.ts`).** On the server's status
  page an org's admin asks once (`GET /org/:orgId/server/kept`, `POST …/kept/:moveId/import`: admin
  or `admin.settings`, on the server only, for a re-seed that FINISHED, i.e. phase `active`). The
  server's `kept-import-tick` then runs the kept file under the fenced import's own rules: the
  shared `Ctx` now carries `runId` and `source`, and `importedFrom.kind` is `reseed_kept`.
  - **The candidates.** The file is read once. Its documents are checked against the org as it is
    now, in batches of 1,000 ids. Only those it holds no longer are candidates, plus this run's own
    earlier imports, so a run cut short finishes and records them.
  - **Brought in:**
    - every NON-DRAFT invoice, booked here (stock below zero if need be, the journal entry, the
      payments' entries);
    - the till sessions they name, journaled at the end once all their sales are in;
    - movements of their own that moved stock;
    - the contacts, products, categories and stores these NAME.
  - ⚠ **Master data only when named.** Nothing in the app hard-deletes it, so a named one is new
    work. An unnamed one might be something a raw script deleted after the restore point, so it is
    counted in `keptOnly` and never resurrected.
  - **Left for a person:** drafts (`kept_draft`), and what names something neither copy holds. A
    number the copy gave to another document comes in flagged (AC 51, below).
  - **Never touched:** what the copy holds.
  - **Bookkeeping.** Rows in `fenced_import_items` with the re-seed's id as the run, state in
    `NodeState` `kept-import:<moveId>` (lease 10 min), audited. Numbering continues above every
    number brought in (no lock check: it is a raw counter bump, never an issue).
- Tests: `reseed.flow` (7: the preflight and its went-back evidence; the copy of the mirror with its
  files and the flip, the mirror losing nothing; the routes through the home gate over HTTP; a
  differing copy aborted; the server freezing, keeping, replacing and unfreezing with numbering
  still locked; a server that did not go back refusing; an abort rolling back from the kept copy);
  real-process `two-node/move-e2e.script.ts --reseed` (a real master's documents, journal and
  outside mark taken back to a snapshot, the mirror ahead: found by the master itself, recorded,
  locked, told; re-seeded; what was made since back, what was deleted since gone, the mirror
  untouched, a new chain caught up).

## Reconciling lgrai.app's copy after a master lost the record of its changes (2026-10-27, FR-20.70, plan step P3-7f)

Lost history (FR-20.61: the oplog no longer reaches the saved resume token, a token that no longer
parses, an invalidate, a captured collection DROPPED) raises the master's journal epoch, and the
tailer journals every document it HAS again (`seedOrg(…, 'upsert')`). What it DELETED in the gap is
in no row. Until P3-7f global refused the new epoch (`reconcile_required`) and the pump stopped the
org: the mirror stalled for good. Now (`services/biz/replication/reconcile.ts`, `apply.ts`):
- **Global applies the epoch's first page if it continues the chain** from the watermark
  (`decide` → `reconcile`): the master still holds the page global stands on, so its database did
  not go back under the mirror (that is the re-seed's, above). `mirror_state.reconcile
  {journalEpoch, since, deleted, kept[], head?, doneAt?}` follows it.
- **The master drives the id pass** (`mirrorReconcileTick`, every minute, master only, at Full): for
  an org written there whose journal is whole at an epoch above `repl_orgs.reconciledEpoch` (set at
  the FIRST seeding; absent means 1), it asks `GET /api/node/v1/reconcile/ids?orgId=&coll=&after=`
  (EJSON, the ids keep their types; 1,000 a page, 50 pages a tick) and journals each id again
  (`rejournal`: as it is here, or as GONE). Where it stands is `repl_orgs.reconcile`, so a cut tick
  goes on from there. With every id asked it reports `POST /reconcile/done {orgId, journalEpoch,
  head, asked}` and marks the epoch reconciled; global sets `doneAt` once its watermark reaches
  `head` (checked against the watermark as it is NOW: a page applied meanwhile read no head).
- ⚠ Global answers only the org's home, registered for it at Full, with no clone alarm, and only the
  ids of ITS copy of that org (FR-20.66). The org's own document is never asked.
- ⚠ **No page deletes an issued sale** (FR-20.51; `issued-sales.ts`: an invoice with a number that
  is not a draft, any till transaction): a tombstone for one the copy holds is not applied, the copy
  keeps it, with a `sale_kept` alarm and on the reconcile's `kept` list. Nothing on a home deletes
  one (a draft only), so a home without it lost it, and the copy may be its only record.
- Numbering is NOT locked: the master lost a record of its changes, not its data. The move back
  waits while a reconcile runs (`mirror_live`). The Servers page's "Files on lgrai.app" card says
  the copy is being made equal to the server again, then when it was, how many documents went, and
  the issued sales it kept (×4).
- Not yet: the reconcile on demand, and after the journal's tombstones are pruned (nothing prunes them).
  ⚠ A kept sale also holds a move back (the copy then differs from the server, and P3-6c waits on a
  mismatch): bringing it back onto the server is the same audited import the re-seed's kept sales
  wait for.
- Tests: `mirror-reconcile.flow` (7: the copy made equal, what the gap deleted gone, what it changed
  come, an issued sale kept; only a chain-continuing page raises the epoch; the master's word before
  the first page; no page deletes an issued sale; the ids to the org's home only, page by page; a
  first seeding needs none; a cut tick goes on); real-process `two-node/move-e2e.script.ts --reconcile`
  (a captured collection dropped on a real master and an issued sale deleted unseen: a new epoch,
  taken by lgrai.app, the copy made equal but for the sale it keeps, numbering open).

## What a fenced server did after the cutoff (2026-10-27, FR-20.84, plan step P3-6e)

A server that comes back after a promotion fences itself (above), then EXPORTS everything its
journal captured above the cutoff and sends it to lgrai.app, where a person reviews it and brings it
into the books through the audited import (second half, below). Nothing is imported on its own. `services/biz/move/fenced-export.service.ts`; the master's half is
`move-worker.service.ts#exportFenced`.
- **What it holds** (`lgr-fenced/1`, one zstd stream):
  - every document behind a `repl_journal` row above `fenceCutoff`, as a move carries it
    (`moveProjection`);
  - ⚠ also every row of another journal epoch than the cutoff's (`OrgMove.fenceJournalEpoch`, from
    the mirror at the promotion): a lost history journaled them again, and whether global saw them
    is unknown;
  - a document gone since, as a deletion;
  - the bytes of the files those rows name (`DocFile.currentPath`, a local `File.storagePath`),
    inline, so the evidence is one artifact; a file not on disk is counted (`missingFiles`);
  - a header (org, node, promotion, cutoff, epoch, journal head) and a trailer with every section's
    count and sha256.
- **Built once and kept** under the org's `docs/fenced/fenced-<moveId>.ndjson.zst`, on the master and
  on global alike, so both sides' backups carry it. ⚠ Never discarded, whatever its state: it is the
  evidence the audited import keeps (Прил. 42: full, unchanged, with source and time).
- **Sent in chunks** of at most 4 MB (`PUT /api/node/v1/moves/:id/fenced-export?offset=&size=&sha256=`,
  `GET` the same for where global stands), 16 a tick. A chunk anywhere but where global stands is
  answered 409 `offset` with that offset, so a cut link resumes.
  - The first chunk fixes size and sha256 for good: another is 409 `export_changed`.
  - Global writes at the offset and NEVER truncates: a slow retry of an earlier chunk must not cut off
    the ones after it.
- **Checked when whole**: the sha256 against the announced one, then `readFencedExport`, every section
  against the trailer. Either failing makes it `refused`, kept on both sides (`fenced_exports`, node
  state, records its arrival).
  - ⚠ One org's (AC 38): a document of another org, a collection a move does not carry, or a file path
    outside the org's tree refuses the bundle.
- **The review** (`GET /api/org/:orgId/moves/fenced-exports`, admin; a card per export on the Servers
  page): counts per collection, deletions, files, and the sales and invoices by number, each checked
  against lgrai.app NOW:
  - `absent`: new here;
  - `same_id`: made before the cutoff, changed after;
  - `collision`: lgrai.app gave its number to another document, which the import will resolve by a
    credit note and a re-issue (FR-20.51), never by an edit.
- Tests:
  - `fenced-export.flow` (6): what it holds, AC 38, the chunked receipt, refused and kept, the
    review's three cases, and the worker exporting once and sending until global has it, across a
    cut link;
  - `move-e2e.script.ts --promote` (43): the shop's link CUT by the chaos proxy, two sales made while
    cut, the promotion, and on the link's return the fence, the export with exactly those sales and
    their customer, the same bytes on both sides, the review naming the collision, and the import.

### The audited import (second half)

"Bring into the books" on the review card (`POST /api/org/:orgId/moves/fenced-exports/:id/import`,
admin, asked once) sets `FencedExport.import`. Global's `fenced-import-tick` (every 10 s) runs it in
batches of 200 under a 2-minute lease, phase by phase:
- what a sale names (contacts, product categories, products, warehouses, tags);
- till sessions;
- sales;
- stock movements;
- documents and their files;
- the site's audit trail.

`services/biz/move/fenced-import.service.ts`.
- **Kept as it was** (Прил. 42): a document new to lgrai.app is inserted with its own `_id`, number,
  dates and content. A sale gets `Invoice.importedFrom` {kind, exportId, moveId, nodeId, at, by}. What
  it points at that stays behind is dropped: `journalEntryId`, each payment's `journalEntryId`,
  `register.movementId`.
- **Booked here as lgrai.app would have** (`bookSale`):
  - an issued sale: `createInvoiceStockMovement` with `allowNegative` (the goods left), its entry
    (`postInvoiceJournal`), each payment's entry (`postPaymentJournal`, on THAT payment), and
    `syncOrderForInvoice`;
  - an invoice for a cash sale books nothing of its own (#171);
  - a bill: its receipt and its orders, no entry (as `/receive`);
  - a till sale: its stock, `register.movementId` set to it. Its entry is its session's: an imported
    closed session drops the site's `journalEntryId` and is posted at the end
    (`postPosSessionJournal`), only if EVERY sale of it came in;
  - a stock movement of its own (a delivery, a transfer, a write-off) that the site applied
    (`completed`/`confirmed`): inserted as a draft, then `confirmMovement`. A movement number lgrai.app
    has since used gets the next one (`importedFrom.number` keeps the site's).
- **All or nothing per document**: a sale whose stock cannot be booked is taken out again (`failed`).
- **Left for a person, each with why** (`fenced_import_items`, node state, one row per document):
  - `same_id`: changed here as well;
  - `number_taken`: only before migration 0010, or a third document for a number already
    issued twice (since AC 51 a second one comes in flagged, `imported:number_clash`);
  - `missing_reference`: a sale naming a product, warehouse or customer lgrai.app does not hold;
  - `made_by_its_sale`: a movement its sale's import makes again;
  - `unique_conflict`;
  - `deletion` (never applied);
  - `not_imported_kind`: everything else, journal entries and payment/cash orders included.
  - A draft's number is no legal number: a taken one gets the next draft number.
- **Numbering continues above** every number imported (`ensureSequenceAtLeast`), the УНП of each
  device included.
- **Resumable**: a document already ours (`importedFrom.exportId`) is booked on, never inserted
  again, and every booking checks what it would create first: a stock movement for the sale, its
  `journalEntryId`, each payment's, the session's.
- ⚠ `postInvoiceJournal`/`postPosSessionJournal` are the event handlers' bodies, exported unchanged
  (refactor only). `invoice.posted` itself is NOT idempotent: the import checks `journalEntryId` first.
- ⚠ The repository's invoice carries its payments WITHOUT their `_id`s or entries:
  `postPaymentJournal` reads the invoice raw and stamps the one payment with a positional `$set`.
- ⚠ `confirmMovement` leaves `completed`, not `confirmed`: test for both.
- The review shows, per sale, what the import did; the server's name comes with the export, so a
  removed server shows its name, not its id. Count labels are plural-free ("Files: 1") in all four
  languages.
- **A legal number issued twice (AC 51, FR-20.51; `services/biz/number-clash.service.ts`).** Both
  documents are on paper, so both are in the books under the number. The second to reach the database
  carries `numberClash {withId, withNumber, source, at}`.
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
- Tests: `number-clash.flow` (5: the key; the migration twice; the correction, of either
  document, stock-free and once; a cash sale refused; the routes), and the fenced and kept imports'
  flags.
- Tests: `fenced-import.flow` (3: the real export of a second database playing the site, imported to
  the end and checked against the books; a crash repeating nothing; the refusals).

## Read-only where the org is not written (2026-10-27, FR-20.75, plan step P3-5, first half)

Above every page of every app, `ui-shell/HomeBanner.vue` says when the org is not written here. It
reads `GET /api/org/:orgId/home` (`services/biz/home/home-status.service.ts`, `home.controller.ts`):
any member of the org may, nothing in it is secret, and it is in the PIN scope too.
- **On lgrai.app, an org homed on one of its servers** (`home: 'master'`) is a read-only copy:
  - the server's name, and whether it holds both sockets now;
  - while it does not, since when (`lastSeenAt`);
  - as of when the copy holds (`mirror_state.lastPageAt`).
  - Online it is an info banner; offline, a warning.
- **On a master, an org that went back to lgrai.app** (`home: 'global'`): the read-only copy it keeps.
- **A move under way** (`moving`: the home record not `active`, or a live `org_moves` row): nothing can
  be written until it ends.
- **After a promotion** (P3-6d): `seriesFrozen` on `home: 'here'`, a warning until the site's last
  numbers are recorded; and `state: 'fenced'` on the server it replaced, which is no move (`moving`
  leaves it out) but a server that writes nothing more of the org.
- An org written here: nothing shows (`home: 'here'`).
- Polled every two minutes, so a server going offline, or coming back, shows without a reload.
  The page that changes where the org is written says so at once (`ui-shared/useHomeChanged`:
  the Servers page when a move starts or ends, and when a promotion's last numbers are saved), or
  the banner went on saying "numbering waits" under "numbering resumes" for up to two minutes.
- **A refused write says why, in the reader's language.**
  - `setRefusalTranslator` (`ui-shared/useHttpClient`): the shell registers its words for a 409 the
    server names by code, and the interceptor rewrites `data.message`, which is what every view already
    shows. The client itself has no i18n.
  - `org_home_elsewhere` → `home.writeRefused`, `series_frozen` → `home.seriesFrozen`. Strings:
    `home.*`, ×4.
- The org's own address (P3-4) shows a static notice while its server is offline, never a sign-in
  (`portal-api/src/tunnel/notice.ts`).
- Tests: `home-status.flow` (4).

## The mirror's files (2026-10-27, FR-20.66, FR-20.69, plan step P3-3)

An org homed on a master sends its files to lgrai.app's mirror behind its documents, on the bulk
socket. Global stores and reads them BY CONTENT, per org: `<UPLOAD_DIR>/<orgId>/blobs/<sha256>`,
recorded in `mirror_blobs` (`MirrorBlob`, node state). ⚠ Never where a mirrored row says: the
row's path is the master's to choose.
- **Who asks for what** (`services/biz/replication/mirror-blobs.ts#wantBlobs`): once an org's pages
  are caught up, the supervisor sends `blob-sync {orgId}`. Global answers `blob-want {want: [{sha256,
  offset, size}], more, files}`: the contents ITS rows of that org name and it does not hold
  (`DocFile.currentChecksum` of a document not in an archive, `File.sha256` of local rows, and
  `ArchiveUnit.sha256`), 64 at a time.
  - ⚠ Computed per org and from nothing the master lists. A store shared across orgs, or an answer
    from the master's own list, would tell any master whether another org holds some file (AC 52).
    Two orgs with the same bytes hold two rows and two files.
  - This replaces the plan's `blob-have {sha256[]}`: the master lists nothing.
- **Chunks** (`blob-frame.ts`): `LGRB` + version + a JSON header `{orgId, sha256, offset, size}`
  + at most 1 MB. The magic is not zstd's, so a chunk is never taken for a page.
  - The master's API reads them (`blob-source.ts#blobFor`, `POST /replication/blob` on the control
    socket): the org's rows with that hash (current documents, versions, deleted ones, imports,
    archive units), and only if the org is homed here at Full. At offset 0 it hashes the whole file
    first, so bytes that are not what their row says never leave (`hash_mismatch`).
  - Global (`acceptChunk`) takes a chunk only from the org's home (registered, Full, no clone
    alarm), only for a content it asked for, and only at its own offset. Anything else is answered
    with where to resume. The file grows as `<sha256>.part` and is named `<sha256>` once whole AND
    hashing to its name. A bad file is dropped and asked for again after a growing wait (10 min,
    doubling, at most a day).
  - `blob-unavailable`: the master holds no readable bytes for a content global asked for. Asked
    again after 6 h, and counted as **missing on the master**, which there is lost data.
- **The supervisor** (`replication.rs`): pages first, then a page is asked for before every chunk.
  While files wait, every other turn is theirs, so a busy shop's pages cannot starve them. It asks
  again after pages brought rows (at most every 10 s), and every 10 minutes regardless.
  - Files only where the welcome says `files: 'all'`. A global older than P3-3 says nothing, and
    gets nothing.
  - ⚠ `not_ready`, `not_full` and `not_home` from the API wait 10 s, never the 10 minutes of other
    refusals (`LAGGING`). The API reads the link level and the home through 5-second caches, so right
    after a registration at Full it may still say `not_full`. That stalled a fresh master's first pages
    for ten minutes; the mirror e2e caught it.
  - `lgr-server status` shows `bulk.replication.<org>.files`.
- **Global's own copy from before a move** is taken, never asked for. A file at a mirrored row's
  stored path, under the org and outside `blobs/`, that hashes to the row's content is COPIED into
  the store (a reflink where the filesystem has them, never a hard link: the original stays global's
  own). Bounded per ask (200 files / 512 MB). The same happens on read, one file at a time, so such a
  file opens even for an org that mirrors its records only.
- **Read by content** (`readsByContent`: on global, an org whose home is not global):
  - `resolveDownload`: the current file by `currentChecksum`; `?version=` by the version's `File`
    row; an archived document out of its unit's blob, checked against the row's checksum, and NEVER
    written back.
  - `getVersions` from the `File` rows, never `readdir`.
  - The compare dump is refused: it is made where the org lives.
  - A file not there answers 404 `file_not_mirrored`, or `files_not_mirrored` for a records-only
    org. The Files app says either in words (`mirror.*`, ×4).
- **Records only** (the metadata-only option): `Org.settings.node.mirrorFiles: false`, global's own
  part of the org, which no page overwrites. Set on the Servers page ("Files on lgrai.app", shown
  while a server is the org's home) through `GET/PUT /api/org/:orgId/nodes/mirror` (admin.settings,
  `GLOBAL_STATE_WRITES`). The PUT re-welcomes the master (`rewelcomeNode`), whose pump reads the
  choice from its welcome. Files already on the mirror stay and keep opening.
- **`mirrorFilesStatus`**: referenced, held, arriving, waiting, missing on the master, failing, and
  `complete`, which is what a move back (P3-6c, FR-20.80) must wait for.
- `MIRROR_FILES_MAX_GB` (50 by default) caps one org's files on the mirror. Past it, global asks for
  no more and raises an alarm: a master could otherwise fill the disk every org shares.
- Indexes: `File {orgId, sha256}` (partial), `DocFile {orgId, currentChecksum}`.
- ⚠ The mirror's own writes on a GET (taking a pre-move copy, re-asking for a file the disk lost) are
  global's node state (`mirror_blobs` and `blobs/`), never the org's data.
- ⚠ Global writing its own part of a mirrored org passes `{ timestamps: false }`. Mongoose would
  otherwise set `updatedAt`, which is the home's field, and the mirror would differ from the home
  until the master next sends the org. The e2e's digest caught it.
- Not yet:
  - removing blobs no row names any more;
  - pacing against the interactive socket (P3-2c);
  - putting blobs back at their stored paths when an org comes home to global (P3-6c, P3-6d).
- Tests:
  - `mirror-files.flow` (9): the lane, isolation, records only, pre-move copies, reads by content
    (AC 63), and an end to end through `blobFor` and the uplink;
  - Rust `replication::tests` (6 new);
  - `two-node/mirror-e2e.script.ts`, with a real supervisor: two files, one in three chunks, reach
    global and open there; records only stops a new file, and switching back sends it.
