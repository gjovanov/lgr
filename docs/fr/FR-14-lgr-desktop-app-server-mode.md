# FR-14 — LGR Desktop: the app, server mode ("Open LGR") and the local-mode shell

**Goal:** revive **LGR Desktop** as an installable app for Windows, macOS and Linux, modelled on
roomler-desktop. It has **two modes**:

1. **Server mode.** An **Overview** page with an **Open LGR** action, like roomler-desktop's
   "Open Roomler". It opens the cloud app in an app window, signed in the normal way, on a
   machine the org has registered (FR-15). It adds what a browser tab cannot give: a **native
   fiscal bridge** that owns the till's serial port, auto-update, tray, autostart and a
   diagnostics bundle.
2. **Local mode.** The same app serves a defined part of LGR from its own SQLite replica when
   the cloud is unreachable, and syncs back (FR-16).

This FR is the app: shell, packaging, release, update, windows, Overview, server mode, the
native bridge and the local-mode shell. The data plane and sync engine are FR-16, registration
is FR-15, the Sync page is FR-17, and the tests and field automation are FR-18.

Status: draft for implementation · Date: 2026-09-28 · Depends on: [FR-15](FR-15-desktop-registration.md)
· Feeds: [FR-16](FR-16-local-mode-sync-engine.md), [FR-17](FR-17-sync-page.md),
[FR-18](FR-18-desktop-tests-field-automation.md).

Driving input: *"create Functional Requirements and corresponding Github issues for reviving the
LGR desktop (similar to https://github.com/gjovanov/roomler-ai roomler-desktop). LGR desktop
should have two modes: 1. working with the server similar like roomler-desktop has "Open
Roomler" from "Overview" page and 2. working with local data …"* (goran, 2026-09-28; full text
in FR-16).

---

## 1. Current state (verified 2026-09-28, master @ `81b5fe5`)

### 1.1 What exists

- **`packages/desktop`** is a Tauri 2 shell:
  - `tauri.conf.json`: product "LGR Desktop", version `0.1.3`, identifier `com.lgr.desktop`.
  - One 1280×800 window loading the bundled `desktop-ui/dist`, a tray, and bundle targets `all`.
  - Crates: tauri 2 (`tray-icon`), `tauri-plugin-shell`, `tauri-plugin-process`, `rusqlite 0.31`
    (backup, bundled), `zstd 0.13`, tokio, chrono.
- **Tauri commands** (`main.rs:32-43`): `start_api`, `stop_api`, `api_status`, `get_db_path`,
  `create_archive`, `restore_archive`, `list_archives`, `delete_archive`,
  `cleanup_old_archives`, `get_archive_stats`. **No frontend code calls any of them.** There is no
  `invoke` or `@tauri-apps` import in desktop-ui, ui-shared or ui-shell.
- **The sidecar.** Release builds compile `packages/desktop-api` with `bun build --compile`
  (`desktop-release.yml:120-137`) and spawn it with `shell.sidecar("lgr-api")`
  (`sidecar.rs:62-72`). Users do **not** need Bun on their `PATH`.
  `docs/guides/desktop-install.md` still says they do.
- **Archives** (`archive.rs`): an SQLite online backup, zstd level 3, into `archives/*.db.zst`,
  with a daily 02:00 scheduler and 30-day retention, both hardcoded (`main.rs:128-174`). FR-13
  named this module as its restore template.
- **Releases** `desktop-v0.1.1`–`0.1.3` were published on 2026-03-14.

### 1.2 What is broken

| # | Finding | Where |
|---|---|---|
| 1 | **The release pipeline cannot build.** All three runs on 2026-07-20 failed at "Install Tauri CLI": `cargo install tauri-cli@2.10.1` without `--locked` pulls newer bundler crates → `E0063 missing fields uninstaller_header_image … minimum_webview2_version`. | `desktop-release.yml:73-74`; runs `29761311734`, `…3855`, `…4673` |
| 2 | **The packaged app probably cannot reach its own API.** The UI calls a relative `/api` (`useHttpClient.ts:9,56`), and only the Vite dev proxy forwards that to `127.0.0.1:4080`. The sidecar's static serving is also off by one directory: `new URL('../desktop-ui/dist', import.meta.url)` resolves to `packages/desktop-api/desktop-ui/dist`, so it always logs "serving API only". | `desktop-api/src/index.ts:149` |
| 3 | **Anyone can mint admin tokens for a desktop install.** `DesktopAuthService` signs with `config.jwt.secret`. The sidecar is started without `JWT_SECRET` or `NODE_ENV`, so it falls back to the **committed `'lgr-dev-secret'`**. | `desktop-auth.service.ts:10-17`; `sidecar.rs:57-69`; `config/src/index.ts:149,158` |
| 4 | **Published default credentials.** First run creates "My Company" with **`admin` / `admin123`**. It logs them in plain text, pre-fills them on the login form, and the release notes print them. | `first-run.ts:49-66`; `LoginView.vue:65-68`; `desktop-release.yml:218` |
| 5 | **No CSP** (`"csp": null`), and the dead Elysia 1.0 function-form macro in `DesktopAuthService` (S-01 class). | `tauri.conf.json:31-33`; `desktop-auth.service.ts:31-37` |
| 6 | **No updater** of any kind: no plugin, no endpoints, no key. Also no code signing or notarisation. | `tauri.conf.json`; `desktop-release.yml` |
| 7 | **Sidecar supervision.** Readiness is detected from a stdout string. Polling gives up after 30 × 500 ms and continues anyway. A crashed sidecar is never restarted. The port is hardcoded to `4080`. | `sidecar.rs:57-123` |
| 8 | **Restore swaps the database under a running sidecar.** The comment says the sidecar is stopped; the code never stops it. | `archive.rs:77,118-141` |
| 9 | **`desktop-ui` is not built by `bun run build`** and bit-rots between releases. Its Vite aliases redirect stores of `hr`/`crm`/`erp`, modules that no longer exist, while `reports-ui`'s store is not redirected. `lgr.db-shm`/`-wal` files and a stray copy of the icons are committed. The deletion of `CreditNotesView` broke its build unnoticed from `0236cc1` (2026-08-22) to `acbace8` (2026-08-26). | root `package.json:7`; `desktop-ui/vite.config.ts:14-21`; router comment `:41-44` |
| 10 | **No server mode, no registration, no device identity.** A 401 in the local UI redirects to `http://localhost:4001`. | `useHttpClient.ts:33-40` |
| 11 | **`settings.json`** has `general`, `sync`, `archive` and `updates` sections that **nothing reads**, and there is no settings screen. | `desktop-api/src/settings.ts` |

### 1.3 The model: roomler-desktop

The design facts come from `roomler-ai` @ `8e1eb06b2`: `agents/roomler-desktop`,
`agents/roomlerd/src/updater.rs`, `docs/fr/FR-27-…`, `docs/fr/FR-61-vmtest-matrix.md`.

| roomler-desktop | LGR Desktop (this FR) |
|---|---|
| Tauri 2 tray app, `tauri-plugin-single-instance`, `--view=<name>` routing | Same (FR-14.6) |
| Views: Overview · Devices · Routes · Settings · Onboarding (vanilla JS) | Overview · Sync · Settings · Onboarding · Logs · Diagnostics (Vue, `desktop-ui`, i18n ×4; FR-14.31–14.33) |
| **Open Roomler**: on Windows an in-app WebView2 window `roomler-web` (`WebviewUrl::External(origin)`), elsewhere the system browser (WebRTC needs Chromium). **No auth handover, no IPC for the remote page**; sign-in persists in the webview profile. | **Open LGR**: an in-app window on all three OSes (LGR has no WebRTC), with a system-browser setting. Same no-handover / no-IPC rule. OAuth goes out to the system browser (FR-14.17). |
| Overview "This device" card, Updates card, attention banners from a sentinel file | Same shape, LGR's facts (FR-14.31) |
| Self-update: server-proxied manifest, Authenticode signer check, ed25519-pinned `.asc`, never downgrade, crash-loop rollback, 5-min cooldown, admin "Update now / all" | Same rules (FR-14.27) |
| Windows desktop app has **no login autostart** | Autostart offered at onboarding (FR-14.8) — a till must come back after a reboot |
| No diagnostics page | A diagnostics bundle (FR-14.12) |

---

## 2. Process model

```
┌──────────────────────────── LGR Desktop (per OS user) ─────────────────────────────┐
│  Shell (Rust, Tauri 2)                                                             │
│   · tray · single instance · deep links · updater · archives · OS keystore (FR-15) │
│   · native fiscal bridge: owns serial ports, speaks the /ws/fiscal-bridge protocol │
│   · windows:  main (Overview/Sync/Settings…)  ·  lgr-web  ·  lgr-local             │
│                                                                                    │
│   lgr-web  ── https://lgrai.app/<startPath> ── no IPC, own sign-in (server mode)   │
│   lgr-local ── http://127.0.0.1:<random>/   ── sidecar-served UI (local mode)      │
│                                                                                    │
│   Sidecar (Bun, compiled; only when a local profile is enabled)                    │
│    · desktop-api over the SQLite document store (FR-16) · sync client (FR-16)      │
└────────────────────────────────────────────────────────────────────────────────────┘
```

A **server-mode-only** installation never starts the sidecar (FR-14.21). The shell's own pages
are bundled into the app and work with no sidecar and no network.

---

## 3. Requirements

### 3.1 Build, packaging and release

**FR-14.1 — The shell stays Tauri 2**, with the process model above. The main window hosts the
shell pages. The server and local apps open in their own windows (`lgr-web`, `lgr-local`), so the
Overview is always one click away.

**FR-14.2 — The sidecar is a compiled binary built with the production Bun version.**
- The build stays `bun build --compile`, but CI pins Bun to the version in the cloud
  `Dockerfile` (1.3.10 today; `desktop-release.yml` uses 1.2.15).
- **One Bun version** runs the services on both sides.
- The desktop installer has **no Bun prerequisite**, and `desktop-install.md` is corrected.

**FR-14.3 — The release pipeline builds again and stays built.**
- `tauri-cli` is installed `--locked`, or via `tauri-apps/tauri-action`, at a pinned version.
- The toolchain is pinned.
- A scheduled **weekly dry build** catches the next dependency drift before a release needs it.
  The E0063 failure of 2026-07-20 sat unnoticed for over two months.

**FR-14.4 — Signed artifacts.** Unsigned builds are development artifacts and never published.

| Platform | Signing |
|---|---|
| Windows | Authenticode, as roomler signs today (`.github/actions/sign-windows`, Azure Artifact Signing over OIDC), verified with `signtool verify /pa` |
| macOS | signed, notarised and stapled |
| Linux | `.deb` / `.rpm` with detached GPG `.asc` |
| All | SLSA provenance (`attest-build-provenance`) |

**FR-14.5 — Installers.**
- **Windows** gets two installers, each for a different kind of machine:
  - **Per-user NSIS** for a user without admin rights, wherever policy lets executables run from
    the user's profile. Most "no admin" office PCs are like that. It updates itself (FR-14.27).
  - **Per-machine MSI** for managed environments. **AppLocker/WDAC default rules block
    executables in user-writable paths such as `%LOCALAPPDATA%`**, so there the per-user
    installer is refused by policy. IT deploys the MSI. A standard user cannot elevate
    `msiexec`, so per-machine installs run in **managed-update** mode: the app checks, notifies
    and reports its version to the Sync page, and IT deploys the update. An elevated update
    service MAY be added later. The app never tries to elevate.
- **macOS:** arm64 and x64 DMGs.
- **Linux:** `.deb` and `.rpm`, plus AppImage (MAY).
- **Uninstall** keeps profile data unless the user ticks "Remove my data". It offers to
  unregister the desktop (FR-15.18) if it can reach the server.

**FR-14.6 — One instance per OS user.** `tauri-plugin-single-instance` is used. A second launch
focuses the running one. `--view=<overview|sync|settings|onboarding|logs|diagnostics>` routes the
window: ASCII alphanumerics only, validated as roomler validates it. FR-18's Linux desktop walk
drives the app this way.

**FR-14.7 — Tray.**
- **Menu:** Open LGR · Open local LGR (when a local profile exists) · Overview · Sync now ·
  Check for updates · Open logs folder · Quit.
- Left click opens the Overview. Closing a window hides it. **Quit** stops the sidecar cleanly: it
  drains any in-flight push and checkpoints the WAL.

**FR-14.8 — Autostart.** Onboarding offers **Start with Windows/macOS/Linux** as a per-user
login item, on by default when the desktop is assigned a workstation. A till has to come back by
itself after a power cut. roomler-desktop has no login autostart on Windows; LGR's tills need it.

**FR-14.9 — `desktop-ui` builds with everything else.**
- It joins the root `bun run build`, so any change that breaks it fails where every other UI
  would.
- Its Vite aliases are regenerated from the actual `*-ui` packages (`hr`/`crm`/`erp` removed,
  `reports-ui` and `files-ui` handled).
- The committed `lgr.db-shm`/`-wal` files and the stray icon copy are deleted.

**FR-14.10 — Content security.**
- A strict CSP replaces `"csp": null`.
- `withGlobalTauri: false`. Today it is `true` (`tauri.conf.json:13`).
- Tauri capabilities grant each window only the commands it uses: the main window gets the shell
  commands; **`lgr-web` gets none**; `lgr-local` gets none.
  - ⚠ Tauri 2 still injects its IPC bridge (`__TAURI_INTERNALS__`) into remote pages. The
    capability set is what refuses the call.
  - So the test is that a real `invoke` from `lgr-web` is **rejected**. A missing
    `window.__TAURI__` proves nothing.
- `lgr-web` and `lgr-local` navigate only within their origin (FR-14.18).

**FR-14.11 — Sidecar supervision.**
- **Readiness** comes from a health endpoint, not a stdout string.
- **A crash** is restarted with backoff, up to 5 times in 10 minutes. Beyond that the Overview
  shows *"Local data stopped: <last error>"* with **Restart** and **Open logs**.
- **Port:** random, never 4080 (FR-16.16).
- **Shutdown** is graceful: finish or roll back the in-flight transaction, checkpoint WAL, exit.

**FR-14.12 — Logs and a diagnostics bundle.**
- The shell and the sidecar both write rotating logs (10 × 5 MB) to the OS log directory.
- **Create diagnostics bundle** writes a zip with: logs, versions, OS, registration (desktop id,
  org slug), the sync state summary (watermarks, pending counts, last errors) and the recent
  run log.
- The bundle is **redacted**: no tokens, no keys, no document contents.
- It is how a field problem gets from a shop PC to a developer.

### 3.2 Onboarding, deep links, profiles

**FR-14.13 — Onboarding.** The steps are:
1. Server URL, defaulting to `https://lgrai.app`. `http://` is upgraded to `https://` except for
   loopback.
2. Desktop name, defaulting to the hostname.
3. Registration, by code (FR-15.5) or by signed-in approval (FR-15.6).
4. Autostart (FR-14.8).
5. **Enable local data**, shown only when the org has sync enabled (FR-16 D-8).

Onboarding ends on the Overview, with **Open LGR** highlighted.

**FR-14.14 — Deep links.** `tauri-plugin-deep-link` registers `lgr://`. It recognises:
- `lgr://enroll?server=<origin>&code=<code>`: pre-fills onboarding and **asks for confirmation**,
  never registers silently;
- `lgr://open?path=<path>`: opens `lgr-web` at a path inside the server origin;
- `lgr://login?code=<one-time code>` (FR-14.17).

Every parameter is validated. A deep link is attacker-controlled input.
- **Origin:** the allow-list is the profile's server.
- **Path:** it must match `^/[A-Za-z0-9._~/-]*$`, which rules out `?`, `#`, `\`, `//` and `..`.
  The URL it resolves to is then **re-checked**: same origin as the profile.
  - `//evil.example` starts with `/` too, and resolves to another origin.
  - `/pos/?token=<JWT>` starts with `/` too.
- **Code:** its format is checked.

⚠ **The SPAs accept a token from any URL today.** Every `*-ui` router stores a `?token=` query
parameter into `localStorage` and reloads, on any origin (portal-ui `router/index.ts:67-80`,
invoicing-ui `router/index.ts:89-95`, and the others). Only the *sending* side is limited to the
per-app Vite dev ports (`ui-shared/src/nav/navigate.ts:22-30`). So a link like
`https://lgrai.app/apps?token=<attacker's JWT>` silently signs the victim's browser into the
attacker's account and org. That is login fixation. A crafted `lgr://open` link would do the same
to a till, and its sales would land in the attacker's org.

**The receiving side is restricted to the same Vite-dev condition as the sending side.** This is
a web fix, independent of the desktop, and it ships in P1.

**FR-14.15 — Profiles.** Each org registration is a profile, with its own desktop row, keystore
entry, SQLite file and archives (FR-15.3). P1 ships one profile per installation. The profile
switcher is P3.

### 3.3 Server mode — "Open LGR"

**FR-14.16 — Open LGR** (Overview button and tray item) opens or focuses the window `lgr-web`,
1280×800, loading `WebviewUrl::External(<server origin><startPath>)`.
- **No auth handover.** The user signs in inside the window with the portal's normal login, and
  the session persists in the webview's profile, exactly as roomler does it. No JWT, cookie or
  code passes from the shell into the page. This is S-05's lesson: tokens do not travel in URLs.
- **No IPC.** The remote origin gets no Tauri capability, so every `invoke` it makes is refused
  (FR-14.10).
- **The window is destroyed on close**, not hidden, so it never shows a stale session.
- **System browser setting:** "Open LGR in my browser" opens the same URL with the OS default
  browser instead.

**FR-14.17 — OAuth sign-in leaves the webview.** Google refuses sign-in inside embedded webviews
it detects (`disallowed_useragent`, *"This browser or app may not be secure"*), and whether it
detects WebView2, WKWebView or WebKitGTK varies by platform and changes without notice. The
desktop therefore **never** runs an OAuth provider page inside `lgr-web`:
1. **What gets intercepted.** The shell intercepts navigation to the portal's **OAuth start
   route** (`/api/oauth/:provider`), not the provider page. It opens the same URL in the system
   browser, adding `desktop=<desktopId>` and the S256 challenge of a verifier the shell has just
   generated.

   Intercepting later breaks the handshake. The S-04 fix binds OAuth `state` to the browser that
   started it, so a flow started in the webview and finished in the system browser fails that
   check. The whole handshake therefore has to run in one browser.
2. **The one-time code.** The cloud completes OAuth there, then redirects to
   `lgr://login?code=<code>`. The code is single use, valid for 60 s, and bound to that desktop
   and that challenge.
3. **Redeeming.** The shell navigates `lgr-web` to `/auth/desktop-redeem#code=…&verifier=…`. A
   fragment never reaches a server or a log. The page POSTs both values to
   `/api/auth/desktop-code/redeem`, which:
   - verifies code, expiry, challenge, and that the desktop is active;
   - redeems the code;
   - answers **exactly as `/auth/login` does**: it sets the `auth` cookie *and* returns
     `{ token, user, org }` in the JSON body.

   The redeem page then stores the token in `localStorage` the way the login page does, and
   routes to `startPath`. A cookie alone is not enough. The SPAs treat a browser as signed in only
   when `localStorage.lgr_token` is set (portal-ui `router/index.ts:84-89`), and they send it as
   a bearer header (`useHttpClient.ts:18-23`). A redeem that set only the cookie would land on
   `/landing`.

   Another app that registers `lgr://` and hijacks the deep link gets the code, but not the
   verifier the shell holds, so it cannot redeem it. This is RFC 8252's PKCE principle.

The JWT itself never appears in a URL. This is the one place the no-handover rule bends, and it
bends through a one-time code and a verifier, not a token.

**FR-14.18 — What a browser does for free, the windows must do explicitly.**
- **Downloads:** XLSX/PDF exports go through blob URLs + `a.download`
  (`useInvoicingExport.ts:16-19`). They must save with a Save-as dialog.
- **Print:** the document forms' **Print** must reach the OS print dialog.
- **New windows:** `window.open` must open in the system browser when the target is outside the
  origin, and in `lgr-web` when it is inside.
- **Navigation containment:** navigation outside the origin (other than FR-14.17's intercept)
  goes to the system browser, never into the window.

Each behaves differently in WebView2, WKWebView and WebKitGTK. Each is exercised by FR-18's
desktop walk on every platform.

**FR-14.19 — Where Open LGR lands.**
- `startPath` comes from the desktop's assignment (FR-15.13), for example `/pos/` for a till,
  and falls back to `/`.
- **Open LGR on launch** is a setting that a till turns on: after autostart, the POS is on
  screen without anyone touching it.

**FR-14.20 — Connectivity is visible, and never decides for the user.** The shell derives
**server link** (connected / unreachable / signed out of the desktop credential) from the
`/ws/desktop` socket and token refreshes (FR-15.12). When the server is unreachable and a local
profile exists, the Overview and tray offer **Continue in local mode** (FR-16.56). The switch is
the user's click.

**FR-14.21 — Server mode needs no sidecar.** An installation with no local profile never starts
Bun. Registration, presence, the updater and the native fiscal bridge all live in the shell.

### 3.4 Local mode shell

**FR-14.22 — Open local LGR** opens the window `lgr-local` at
`http://127.0.0.1:<port>/#launch=<per-launch token>`.
- **The UI is served by the sidecar itself**, so it is same-origin with the local API and
  relative `/api` works (§1.2 #2).
- **The launch token travels in the fragment,** which is never sent to the server. The page
  moves it into `sessionStorage` and clears it from the address.

The window is **unmistakably local**:
- a coloured banner reading "Local data — last synced 14:32 · 3 changes waiting";
- the org name;
- **Open LGR (server)** whenever the server is reachable.

Server-only areas are hidden or disabled with that action (FR-16.8).

**FR-14.23 — The local UI is served correctly and never redirects to a developer URL.**
- The sidecar resolves `desktop-ui/dist` from the executable's resource directory in a packaged
  build.
- The `http://localhost:4001` 401-redirect (`useHttpClient.ts:33-40`) is replaced by the local
  login.
- The local UI's 503 `server_only` answers (FR-16.8) render as a page with **Open in LGR
  (server)**, not an error toast.

### 3.5 The native fiscal bridge

**FR-14.24 — The shell owns the till's fiscal device.** On a desktop assigned fiscal devices
(FR-15.13), the shell:
- opens their serial ports with the Rust `serialport` crate;
- speaks the existing bridge protocol (`fiscal:bridge:register`, `fiscal:command`,
  `fiscal:response`, base64 frames, the `protocol: 'isl'` + `timeoutMs` framing that
  `useFiscalBridge` implements);
- adds one message, **`fiscal:unp:allocate`**. The bridging desktop is the device's only УНП
  allocator in both modes (FR-16.48), so in server mode the hub's `generateUNP` asks it;
- **in server mode**, is the bridge the hub talks to, authenticated with the desktop credential
  (FR-14.26);
- **in local mode**, gives the sidecar's fiscal drivers (`packages/fiscal`) the same transport
  over a loopback channel.

This ends three things:
- **"Failed to open serial port"**, which means another *tab* holds the port. The 2026-09-28
  memory records a Saturday tab holding COM4 for 33 h.
- **Web Serial's Chrome/Edge-only limit.** WKWebView and WebKitGTK have no Web Serial at all.
- **The `bridge.ts` CLI.**

⚠ The byte transport MUST be in Rust, not Bun. Bun + `serialport` on Windows opens the port and
writes, but **never delivers received bytes**, which made the Eltrade A3 look dead for two days
in September. The protocol drivers stay in TypeScript (`isl-frame.ts`, `eltrade.ts`,
`tremol.ts`), and only the bytes move.

**FR-14.25 — `FiscalDevice.connectionType` gains `desktop`**, with `connectionParams.port` and a
`bridgeDesktopId`.
- The POS terminal and `GET /fiscal/device` show *"connected via <desktop name>"*, alongside
  today's live `connected` flag.
- A device bridged by a desktop is **never** also offered to the Web Serial relay. One owner per
  port is the point.

**FR-14.26 — `/ws/fiscal-bridge` authenticates its bridges.** Today it registers a bridge from
`{deviceNumber, orgId}` alone, and a new registration **disconnects the current one**
(`fiscal-bridge.ts:115-140`). Anyone who reads a device number off a receipt can take over a
till's fiscal traffic and answer it. The fix:
- **The browser relay** authenticates with the user's JWT in its first message, must be in the
  device's org, and needs `pos.write`.
- **The native bridge** authenticates with the desktop access token, and the device must be in
  the desktop's `fiscalDeviceIds`.
- **Bridges are keyed by `(orgId, deviceNumber)`,** not `deviceNumber`, which collides across
  orgs.
- **A takeover of an authenticated bridge** by another principal requires `admin.settings`, is
  audit-logged, and tells the evicted bridge why.

This fix ships in the **first** FR-14 phase, not with the native bridge. It is live today.

### 3.6 Updates

**FR-14.27 — Auto-update, with roomler's safety rules.**

| Rule | Detail |
|---|---|
| Manifest | server-proxied `GET /api/desktop/v1/latest-release`, per channel (stable / beta), checked at start (5-min cooldown) and every 4 h |
| Signatures | the Tauri updater signature is verified against a key **pinned in the binary**; on Windows the Authenticode signer must also match the publisher. Every check **fails closed** |
| Direction | no downgrade, ever; an unparseable version is not an upgrade |
| Deferral | defer while a POS session is open, a push is in flight, or a fiscal command is pending; force through after 7 deferrals, never mid-receipt |
| Recovery | crash-loop rollback to `last_known_good_version`, marked *before* the attempt |
| Admin | "Update now / all" from the Sync page (FR-15.17), under the same rules |
| Per-machine installs | **managed updates** (FR-14.5): check, notify and report the version. Never self-install, never elevate |

**FR-14.28 — Every update is preceded by an archive** of each local profile (FR-14.30). A local
schema migration that fails on start rolls back to it and reports the failure. It does not leave
a half-migrated store.

**FR-14.29 — "Update required to sync".** When the hub answers 426 `desktop_outdated`
(FR-16.53), the Overview says so, offers the update, and keeps server mode and local reads
working. Unpushed changes stay queued. They are never discarded to make an update go through.

### 3.7 Archives

**FR-14.30 — `archive.rs` is wired, and restore is made safe.**
- **Configurable:** schedule and retention come from Settings, not constants.
- **Per profile:** archives are kept per profile.
- **Restore sequence:**
  1. stop the sidecar;
  2. verify the archive;
  3. swap it in;
  4. **regenerate `instance_epoch`**, so that FR-16.50 detects the restore and reconciles;
  5. restart the sidecar with **legal issuing and УНП allocation blocked** until FR-16.50's
     reseed. An archive brings back old counters, and numbers issued after it was taken are
     already in customers' hands.

  Today the swap happens under a live sidecar (`archive.rs:118-141`).
- **Storage:** archives and profiles live under `app_local_data_dir()`, never Roaming AppData
  (FR-16.1).
- **UI:** Settings → Backups lists archives with size and date, and offers Create, Restore and
  Delete.

### 3.8 The shell's pages

**FR-14.31 — Overview.** It has three cards and a set of banners.

**This desktop**
- registration chip: Registered / Not registered / Paused / Revoked;
- name and code, org name and slug;
- server and server link (FR-14.20);
- mode;
- app and sidecar versions;
- **Open LGR**;
- **Open local LGR** (with a local profile).

**Local data** (when enabled)
- last pull and last push;
- changes waiting;
- open conflicts and dead letters concerning this desktop;
- band usage;
- **Sync now**.

**Fiscal devices** (when assigned)
- per device: port, state, last command, bridge mode.

**Updates**
- current version, **Check**, **Install**, and "update required to sync".

**Attention banners**, each with its fix:
- not registered → Register;
- revoked → FR-15.18 text;
- desktop key stored in a file (FR-15.9);
- disk encryption off (FR-16.63);
- clock skew above ±2 min;
- reconcile required (reason);
- sidecar stopped (FR-14.11);
- band ≥ 95 % used (FR-16.44).

**FR-14.32 — Views.** Overview · Sync (this desktop's page, FR-17 §3.3) · Settings · Onboarding ·
Logs (source, filter, follow, as roomler has) · Diagnostics (FR-14.12).
- They are Vue views in `desktop-ui`, reusing `ui-shared` (Vuetify, i18n in en/bg/de/mk).
- They are bundled into the app, so they work with no sidecar and no network.

**FR-14.33 — Settings.**
- server URL (changing it requires re-registration);
- desktop name;
- autostart;
- open LGR on launch;
- open in system browser;
- proxy override (FR-16.55);
- archive schedule and retention;
- language;
- log level;
- **Rotate desktop key** (FR-15.9).

A field set by an admin assignment (start path, warehouses) is shown read-only, with *"set by
your administrator"*.

**FR-14.34 — Language.** The shell follows the OS locale until the user picks one: bg for a
Bulgarian Windows, and so on. Every string exists in all four locales. A missing key renders
literally (FR-06 lesson).

---

## 4. Edge cases and traps

1. **`cargo install` without `--locked`** is what broke the release pipeline (§1.2 #1). The
   weekly dry build (FR-14.3) exists so this is found by a robot.
2. **The committed JWT fallback reaches the sidecar**, because it is started without
   `JWT_SECRET`/`NODE_ENV` (§1.2 #3). FR-16.15's per-profile key is what closes it. Merely
   setting `NODE_ENV=production` would crash the sidecar on start instead, since `requiredSecret`
   throws.
3. **The dead Elysia macro in `DesktopAuthService`** is the S-01 class of bug. On the desktop
   today, only inline `if (!user)` checks stand between a local caller and the data.
4. **Google blocks OAuth in embedded webviews** (FR-14.17). It may work on one OS and fail on
   another, and it can change overnight. Design for the system browser, not for luck.
5. **Downloads, print and `window.open`** work in a browser tab and silently do nothing in some
   webviews (FR-14.18). A Print button that does nothing on a till is a support call.
6. **Web Serial does not exist in WKWebView or WebKitGTK.** Server mode on macOS and Linux has no
   fiscal path at all without the native bridge.
7. **Bun `serialport` on Windows never receives** (FR-14.24). Do not "simplify" the bridge into
   the sidecar.
8. **A deep link is untrusted input** (FR-14.14). All three of `lgr://open?path=https://evil`,
   `?path=//evil.example` and `?path=/pos/?token=<JWT>` must be refused. The third is the
   dangerous one: today's SPAs store any `?token=` they see, so it would sign the till into
   someone else's account.
8a. **Roaming AppData** (`app_data_dir()` on Windows) puts the WAL database on a network share
   with roaming profiles or folder redirection. It also gives several PCs one database. Use
   `app_local_data_dir()` (FR-16.1).
9. **Restore under a live sidecar** corrupts the store, or the sidecar keeps writing to the
   unlinked file (§1.2 #8).
10. **The WebView2 remote-debugging port is for FR-18's CDP walk only.** It is enabled by the
    lane's environment variable, never by the app.
11. **Autostart on a shared PC starts the app for every user who logs in.** It is per-user by
    design, and the installer does not register a machine-wide login item.

---

## 5. Integration constraints

- The portal's cross-SPA `?token=` handoff is restricted to the Vite dev ports, on **both** sides
  (FR-14.14). `lgr-web` serves every SPA from one origin (`/`, `/invoicing/`, `/pos/` …), and they
  share the bearer token the login response delivers into `localStorage`. **No desktop code adds
  a token-in-URL path.** The FR-14.17 redeem answers like `/auth/login`, with a cookie plus the
  token in the body, so it fits the same contract.
- `/api/auth/desktop-code/redeem` (FR-14.17) is the one new user-auth route. It is public by
  necessity, so it goes into `public-routes.ts` with its reason: the one-time code is the
  credential, bound to a registered desktop.
- The fiscal protocol drivers (`packages/fiscal`) are unchanged by the native bridge. Only the
  transport moves. The Eltrade simulator (`tests/helpers/eltrade-simulator.ts`) drives both
  transports in tests.
- Release tags stay `desktop-v*`. The desktop version is independent of the cloud image tag, and
  the hub gates compatibility with `minDesktopVersion` (FR-16.53).

---

## 6. Phases

| Phase | Ships | Kill switch / rollback |
|---|---|---|
| P1 | Pipeline builds (FR-14.2–14.5, .9); security fixes (.10; FR-16.15/.17 cut-over: default credentials and shared secret gone); **`/ws/fiscal-bridge` auth (FR-14.26) and the SPAs' `?token=` acceptance limited to dev (FR-14.14)**, both web fixes that are live today; Overview + Open LGR (.16–.21, .31–.34); onboarding + registration (with FR-15); updater (.27–.29); supervision/logs/diagnostics (.11–.12) | Unpublish the release; the updater never downgrades, so a bad build is fixed forward by a new tag |
| P2 | Native fiscal bridge (FR-14.24–14.25) for server mode | Per-device: set `connectionType` back to `browser` |
| P3 | Local-mode shell (FR-14.22–14.23), archives (.30), deep-link login (.17 if not in P1), profiles (.15) | Local data is opt-in per org and per desktop |

---

## 7. Acceptance criteria

1. The release workflow builds **signed** Windows (NSIS per-user + MSI), macOS (notarised) and
   Linux (`.deb`/`.rpm` + `.asc`) artifacts from a `desktop-v*` tag. The weekly dry build runs
   green.
2. On Windows, both installers work where they are meant to:
   - A per-user install on a standard (no-admin) account **without** AppLocker succeeds,
     registers and opens LGR.
   - **Under AppLocker default rules,** the per-machine MSI deployed by IT runs for a standard
     user and reports managed updates. The per-user installer is refused by policy with a clear
     message, not a hang.
3. **Open LGR** opens `lgr-web` at the assigned `startPath`. Signing in with a password works
   inside it. Signing in **with Google** goes through the system browser and lands signed in, with
   no JWT in any URL, history entry or log line.
4. In `lgr-web`, an XLSX export saves, a document **Print** reaches the OS print dialog, and an
   external link opens in the system browser. This holds on Windows, macOS and Linux.
5. The remote page has no Tauri IPC. A real `invoke` issued from `lgr-web` (through
   `__TAURI_INTERNALS__`) is **rejected** by the capability set. `withGlobalTauri` is off.
5a. `https://lgrai.app/apps?token=<valid JWT of another account>` does **not** change who the
    browser is signed in as. `lgr://open` with `?path=//evil.example` or
    `?path=/pos/?token=<JWT>` is refused.
6. A till desktop with autostart and **Open LGR on launch** shows the POS after a reboot with no
   interaction.
7. With the native bridge, the Eltrade A3 prints a non-fiscal receipt from a server-mode sale on
   Windows, and a second tab cannot take the port. A Web Serial relay registering the same device
   without credentials is refused.
8. `/ws/fiscal-bridge` refuses an unauthenticated registration and a registration from another
   org, and never evicts an authenticated bridge silently.
9. An update from N-1 to N installs with a POS session closed, defers with it open, and refuses a
   tampered artifact (one flipped byte). A crash-looping N rolls back to N-1.
10. Restoring an archive stops the sidecar, swaps the database and regenerates `instance_epoch`.
    The next sync reports `reconcileRequired: restored`. No legal number and no УНП is issued
    until FR-16.50's reseed.
11. No build or release note contains a default credential. The sidecar never signs with
    `lgr-dev-secret`.
12. `bun run build` builds `desktop-ui`. Deleting a view that desktop-ui imports fails the build.
13. The diagnostics bundle contains logs, versions and sync state, and no token, key or document
    content (checked by grep over a generated bundle).
