# FR-14 — LGR Desktop: a server-mode desktop client

**Goal:** a signed, self-updating **LGR Desktop** for Windows, macOS and Linux, modelled on
roomler-desktop. It has **exactly one mode: it opens the LGR cloud app.** An **Overview** page
with **Open LGR** works like roomler-desktop's "Open Roomler". There is no local mode, no local
data and no sync.

The desktop adds six things a browser tab cannot give:
- a **native fiscal bridge** that owns the till's serial port;
- autostart, with **open on launch**, so a till comes back by itself;
- auto-update;
- a tray;
- a diagnostics bundle;
- **registration**, which makes every desktop a known, revocable machine of its org.

It ships through CI, e2e and automated field testing on the vmtest hosts. It is signed with
**roomler's signing identity on all three platforms**.

Status: draft for implementation · Date: 2026-09-28 (revised the same day) · Tracking:
[gjovanov/lgr#57](https://github.com/gjovanov/lgr/issues/57) · Depends on: nothing.

Driving input, goran, 2026-09-28:

> *"create Functional Requirements and corresponding Github issues for reviving the LGR desktop
> (similar to https://github.com/gjovanov/roomler-ai roomler-desktop). LGR desktop should have
> two modes: 1. working with the server similar like roomler-desktop has "Open Roomler" from
> "Overview" page and 2. working with local data … Each LGR desktop should be registered as
> device/desktop within the org. … With integration/e2e tests and automated field testing"*

and, after the review:

> *"after review of the offline mode, we have decided to ditch local mode completely and have a
> desktop client that will only open the server mode. so pls remove other FRs. regarding
> signing, reuse roomler signing identity also for win, apple and linux."*

**What was dropped, and where the rest went.** Commit `bc48d04` specified four more FRs:
- FR-15, registration;
- FR-16, a SQLite local mode with hub↔desktop sync;
- FR-17, a Sync page;
- FR-18, tests and field automation.

They were dropped the same day, and local mode is gone entirely. A server-only client still needs
three things from them, which are **folded into this FR** and trimmed to what server mode uses:
- registering the desktop (§3.4), because its credential is what authenticates the native fiscal
  bridge, and the request asked for it;
- a Desktops page in the portal (FR-14.23);
- the tests and field lanes (§3.10).

The dropped specs remain readable at `bc48d04`.

---

## 1. Current state (verified 2026-09-28, master @ `81b5fe5`)

### 1.1 What exists

- **`packages/desktop`** is a Tauri 2 shell:
  - `tauri.conf.json`: product "LGR Desktop", version `0.1.3`, identifier `com.lgr.desktop`.
  - One 1280×800 window loading the bundled `desktop-ui/dist`, a tray, and bundle targets `all`.
  - Crates: tauri 2 (`tray-icon`), `tauri-plugin-shell`, `tauri-plugin-process`, `rusqlite`,
    `zstd`, tokio, chrono.
- **Tauri commands** (`main.rs:32-43`): `start_api`, `stop_api`, `api_status`, `get_db_path`, and
  six archive commands. **No frontend code calls any of them.**
- **Local mode.** The prototype's local half is a Bun sidecar (`desktop-api`, compiled with
  `bun build --compile`, spawned at start by `sidecar.rs:62-72`) over SQLite (`dal-sqlite`),
  plus `packages/sync`, a LAN peer-to-peer sync that nothing imports. By the decision above,
  **all of it is retired, not repaired** (§3.9).
- **Releases** `desktop-v0.1.1`–`0.1.3` were published on 2026-03-14.

### 1.2 What is broken

| # | Finding | Where |
|---|---|---|
| 1 | **The release pipeline cannot build.** All three runs on 2026-07-20 failed at "Install Tauri CLI": `cargo install tauri-cli@2.10.1` without `--locked` → `E0063 missing fields uninstaller_header_image … minimum_webview2_version`. | `desktop-release.yml:73-74`; runs `29761311734`, `…3855`, `…4673` |
| 2 | **The sidecar signs local tokens with the committed `'lgr-dev-secret'`**, because it is started without `JWT_SECRET`. First run creates **`admin` / `admin123`**, logs it in plain text, pre-fills it on the login form and prints it in the release notes. **Both disappear with the sidecar** (§3.9). | `desktop-auth.service.ts:10-17`; `sidecar.rs:57-69`; `first-run.ts:49-66`; `desktop-release.yml:218` |
| 3 | **`"csp": null`, `"withGlobalTauri": true`.** | `tauri.conf.json:13,31-33` |
| 4 | **No updater** of any kind: no plugin, endpoints or key. **No code signing, no notarisation.** | `tauri.conf.json`; `desktop-release.yml` |
| 5 | **Profiles live in Roaming AppData** (`app_data_dir()`). | `sidecar.rs:30`; `archive.rs:24,85,151` |
| 6 | **`desktop-ui` is not built by `bun run build`** and bit-rots. The deletion of `CreditNotesView` broke its build unnoticed from `0236cc1` (2026-08-22) to `acbace8` (2026-08-26). | root `package.json:7` |
| 7 | **No server mode, no registration, no device identity.** | — |

### 1.3 Two live web exposures found on the way (fixed in P1, independent of the desktop)

- **`/ws/fiscal-bridge` authenticates nothing** (`portal-api/src/websocket/fiscal-bridge.ts:115-140`,
  mounted at `unified.ts:103`).
  - It registers a bridge from `{deviceNumber, orgId}` alone, and a new registration
    **disconnects the till's current bridge**.
  - The device number is printed on every fiscal receipt.
  - Bridges are keyed by `deviceNumber` without the org, so two orgs holding the same number
    collide.
- **Login fixation through `?token=`.** Every `*-ui` router stores a `?token=` query parameter
  into `localStorage` on any origin (portal-ui `router/index.ts:67-80`, invoicing-ui `:89-95`, …).
  Only the *sending* side is limited to the Vite dev ports (`ui-shared/src/nav/navigate.ts:22-30`).
  So `https://lgrai.app/apps?token=<attacker's JWT>` silently signs the visitor's browser into
  the attacker's account and org.

### 1.4 The model: roomler-desktop

Facts from `roomler-ai` @ `8e1eb06b2`: `agents/roomler-desktop`, `agents/roomlerd/src/updater.rs`,
`docs/fr/FR-61-vmtest-matrix.md`, `.github/actions/sign-{windows,macos}`.

| roomler-desktop | LGR Desktop (this FR) |
|---|---|
| Tauri 2 tray app, `tauri-plugin-single-instance`, `--view=<name>` routing | Same (FR-14.5) |
| Views: Overview · Devices · Routes · Settings · Onboarding | Overview · Settings · Onboarding · Logs · Diagnostics (Vue, i18n ×4; FR-14.31) |
| **Open Roomler**: on Windows an in-app WebView2 window `roomler-web` (`WebviewUrl::External(origin)`), elsewhere the system browser (WebRTC needs Chromium). **No auth handover, no IPC for the remote page**; sign-in persists in the webview profile. | **Open LGR**: an in-app window on all three OSes (LGR has no WebRTC), with a system-browser setting. Same no-handover, no-IPC rule. OAuth goes out to the system browser (FR-14.14). |
| Enrollment: admin-minted single-use token (10 min), ephemeral keys + reaper; device credential = **1-year bearer JWT** in `config.toml`; "the row IS the revocation list" | Same enrollment. The credential is an **Ed25519 key in the OS keystore** with 15-min access tokens (FR-14.20): a copied config carries nothing. |
| Web Devices page: presence, version, OS, last seen; Update now / all; delete | The portal **Desktops** page (FR-14.23) |
| Self-update: signed artifacts, signer pinned to **"G ROX LTD"**, ed25519-pinned `.asc`, never downgrade, crash-loop rollback | Same rules and **the same identity** (FR-14.3, FR-14.28) |
| vmtest (FR-61): throwaway VMs on zeus/mars, ephemeral-key org, CDP desktop walk, `results.tsv`/`LATEST`/expected-failures | LGR lanes on the same hosts and golden images (FR-14.38) |

---

## 2. Process model

```
┌──────────────── LGR Desktop (per OS user) ─────────────────┐
│  Shell (Rust, Tauri 2) — the whole app                     │
│   · tray · single instance · deep links · updater          │
│   · registration + desktop key in the OS keystore          │
│   · native fiscal bridge: owns serial ports, speaks the    │
│     /ws/fiscal-bridge protocol as the registered desktop   │
│   · windows:  main (Overview, Settings…)  ·  lgr-web       │
│                                                            │
│   lgr-web ── https://lgrai.app/<startPath>                 │
│              no IPC, the portal's own sign-in              │
└────────────────────────────────────────────────────────────┘
        no sidecar · no Bun · no SQLite · no local data
```

The shell's own pages are bundled into the app, so they work with no network. Everything else is
the cloud app, served by the cloud.

---

## 3. Requirements

### 3.1 Build, packaging, signing, release

**FR-14.1 — The app is the Tauri 2 shell, and nothing else.** There is no sidecar, no Bun runtime
and no local database. The main window hosts the shell pages, and the cloud app opens in
`lgr-web`. §3.9 lists what is removed to get there.

**FR-14.2 — The release pipeline builds again and stays built.**
- `tauri-cli` is installed `--locked`, or via `tauri-apps/tauri-action`, at a pinned version.
- The Rust toolchain is pinned.
- A scheduled **weekly dry build** catches the next dependency drift before a release needs it.
  The E0063 failure of 2026-07-20 sat unnoticed for over two months.

**FR-14.3 — Every artifact is signed with roomler's signing identity, on all three platforms.**
Nothing new is enrolled with Microsoft, Apple or a key server. LGR reuses exactly what signs
roomler today:

| Platform | Identity | How it is reused |
|---|---|---|
| Windows | Azure Artifact Signing, publisher subject **`G ROX LTD`** (roomler's `EXPECTED_PUBLISHER`, `agents/roomlerd/src/code_signature.rs:56`) | Sign with `gjovanov/roomler-ai/.github/actions/sign-windows@<sha>`. roomler-ai is public, so a pinned cross-repo `uses:` works. It signs, then verifies with `signtool verify /pa /all`, an RFC3161 timestamp, and `expect-subject-contains`. Every PE is signed: the app executable before it is bundled (Tauri `signCommand` against the same signing account), then the NSIS and MSI installers. |
| macOS | roomler's Apple **Developer ID**: `Developer ID Application: G ROX EOOD (4TG7586MY5)`, valid to 2031-09-09, plus the App Store Connect API key for notarisation | The `.app` is signed with the hardened runtime, notarised and stapled. The result is verified with `codesign --verify --deep --strict`, `spctl` (`source=Notarized Developer ID`) and `stapler validate`. ⚠ roomler's `sign-macos` action is **all-or-nothing on six** Apple secrets, the Installer certificate included, and lgr holds five (item 4 below). So lgr signs **inline** with the same identity, as `signing-smoke.yml` does, or through Tauri's bundler fed the same credentials. |
| Linux | roomler's **release GPG key** `D654B016256FD92A81634A0E2AD1E9F025973A7F` (signing subkey `…A2C53E5FE6FA485A`) | Detached `.asc` for every `.deb` / `.rpm`, and the same public key roomler publishes attached to the release |
| All | — | SLSA provenance (`actions/attest-build-provenance`) |

The one-time setup in `gjovanov/lgr` is itself a requirement, because the pipeline cannot work
without it:
1. **GitHub environment.** Create an environment **`release`** in `gjovanov/lgr`. The Windows
   jobs run in it, because the Entra federated credential is bound to an *environment*: roomler's
   tenant "rejects wildcard tag subjects" (`release-agent.yml:890-895`).
2. **Entra.** On the **same** app registration (`AZURE_CLIENT_ID`), add a federated identity
   credential with subject `repo:gjovanov/lgr:environment:release`.
3. **Variables.** Copy roomler-ai's seven Actions variables: `AZURE_CLIENT_ID`,
   `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_SIGNING_ENDPOINT`, `AZURE_SIGNING_ACCOUNT`,
   `AZURE_SIGNING_PROFILE`, `AZURE_SIGNING_EXPECT_SUBJECT`.
4. **Secrets.** Copy these into the `release` environment's secrets:
   - `APPLE_DEVELOPER_ID_APP_P12_BASE64`, `APPLE_CERT_PASSWORD`, `APPLE_API_KEY_ID`,
     `APPLE_API_ISSUER_ID`, `APPLE_API_KEY_P8_BASE64`;
   - `GPG_PRIVATE_KEY`, `GPG_PASSPHRASE`, `GPG_KEY_ID`.

   The Installer certificate is not needed: LGR ships a DMG, not a `.pkg`.
5. **Hard failure on tags.** On a `desktop-v*` tag, a missing or unverifiable signature
   **fails the job**. This is roomler's `require` default, and it means a release can never
   silently ship unsigned.

**Items 1–4 are done (2026-09-29):**
- the `release` environment (no protection rules, as in roomler);
- the federated credential `lgr-github-environment` on the app registration
  `roomler-ai-github-signing`;
- the 7 variables;
- the 8 environment secrets, taken from roomler's git-ignored signing folder
  (`roomler-ai/scripts/signing/{apple,gpg}`). That folder was first checked to be the material
  roomler's CI signs with today.

They are **proven end to end** by the manual workflow `.github/workflows/signing-smoke.yml`, run
[36538198352](https://github.com/gjovanov/lgr/actions/runs/36538198352). It signed a throwaway PE
(`Valid`, `CN=G ROX LTD`, Microsoft RFC3161 timestamp), a throwaway `.app` (notarisation
`Accepted`, stapled, Gatekeeper `source=Notarized Developer ID`), and a file with a detached
`.asc` that verifies in a clean keyring holding only roomler's published key.

⚠ **Two repositories now hold copies of one signing identity.** `gjovanov/*` is a personal
account, so there are no org-level secrets to share. Rotating any of this material in roomler-ai
MUST be repeated in lgr the same day.
- roomler's `60-apple-setup.sh` and `70-gpg-release-key.sh` write **only** roomler-ai's
  repo-level secrets. The same values go to lgr with `gh secret set … --repo gjovanov/lgr --env
  release`.
- Then **re-run `signing-smoke.yml`**.

Two checks catch a missed rotation at release time rather than at a customer's install: the
`expect-subject-contains` check, and the updater's pinned fingerprints (FR-14.28).

**FR-14.4 — Installers.**
- **Windows** gets two installers, each for a different kind of machine:
  - **Per-user NSIS**, for a user without admin rights on a machine whose policy lets
    executables run from the user's profile. It updates itself.
  - **Per-machine MSI**, for managed environments. **AppLocker/WDAC default rules block
    executables in user-writable paths such as `%LOCALAPPDATA%`**, so there the per-user
    installer is refused by policy. IT deploys the MSI.
    - A standard user cannot elevate `msiexec`, so per-machine installs run in
      **managed-update** mode: check, notify, report the version to the Desktops page, and let
      IT deploy.
    - An elevated update service MAY be added later. The app never tries to elevate.
- **macOS:** arm64 and x64 DMGs.
- **Linux:** `.deb` and `.rpm`, plus AppImage (MAY).
- **Uninstall** removes the app, the desktop key and the settings. If it can reach the server, it
  offers to unregister the desktop (FR-14.22).

**FR-14.5 — One instance per OS user.**
- `tauri-plugin-single-instance` is used, and a second launch focuses the running one.
- `--view=<overview|settings|onboarding|logs|diagnostics>` routes the window: ASCII
  alphanumerics only, validated as roomler validates it.
- `--status-json` prints registration, versions, server link and bridge state, then exits. It
  goes through the single-instance channel when an instance is running. Harnesses and
  `roomler exec` read this instead of scraping screens (FR-14.39).

**FR-14.6 — Tray.**
- **Menu:** Open LGR · Overview · Check for updates · Open logs folder · Quit.
- Left click opens the Overview. Closing a window hides the main window and **destroys**
  `lgr-web`, so a stale session is never shown.
- **Quit** first waits for any in-flight fiscal command.

**FR-14.7 — Autostart.** Onboarding offers **Start with Windows/macOS/Linux** as a per-user
login item, on by default when the desktop bridges a fiscal device. A till has to come back by
itself after a power cut. roomler-desktop has no login autostart on Windows; LGR's tills need it.

**FR-14.8 — `desktop-ui` becomes the shell's pages, and builds with everything else.**
- It holds only the shell's views (FR-14.31). The imported domain views, their routes, the store
  aliases for `*-ui` packages, and `hr`/`crm`/`erp` (modules that no longer exist) are removed
  (§3.9).
- It joins the root `bun run build`, so any change that breaks it fails where every other UI
  would.

**FR-14.9 — Content security.**
- A strict CSP replaces `"csp": null`.
- `withGlobalTauri: false`.
- Tauri capabilities grant each window only the commands it uses: the main window gets the shell
  commands, and **`lgr-web` gets none**.
  - ⚠ Tauri 2 still injects its IPC bridge (`__TAURI_INTERNALS__`) into remote pages. The
    capability set is what refuses the call.
  - So the test is that a real `invoke` from `lgr-web` is **rejected**. A missing
    `window.__TAURI__` proves nothing.
- `lgr-web` navigates only within its origin (FR-14.15).

**FR-14.10 — Logs and a diagnostics bundle.**
- The shell writes rotating logs (10 × 5 MB) to the OS log directory.
- **Create diagnostics bundle** writes a zip with: logs, versions, OS, registration (desktop id,
  org slug), bridge state, and the last updater and connectivity events.
- The bundle is **redacted**: no tokens, no keys, no receipt contents.
- It is how a field problem gets from a shop PC to a developer.

### 3.2 Onboarding and deep links

**FR-14.11 — Onboarding.** The steps are:
1. Server URL, defaulting to `https://lgrai.app`. `http://` is upgraded to `https://` except for
   loopback.
2. Desktop name, defaulting to the hostname.
3. Registration, by code (FR-14.19), or by signed-in approval (FR-14.19, SHOULD).
4. Autostart (FR-14.7) and **Open LGR on launch** (FR-14.16).

Onboarding ends on the Overview, with **Open LGR** highlighted.

**FR-14.12 — Deep links.** `tauri-plugin-deep-link` registers `lgr://`. It recognises:
- `lgr://enroll?server=<origin>&code=<code>`: pre-fills onboarding and **asks for confirmation**,
  never registers silently;
- `lgr://open?path=<path>`: opens `lgr-web` at a path inside the server origin;
- `lgr://login?code=<one-time code>` (FR-14.14).

Every parameter is validated. A deep link is attacker-controlled input.
- **Origin:** the allow-list is the registered server.
- **Path:** it must match `^/[A-Za-z0-9._~/-]*$`, which rules out `?`, `#`, `\`, `//` and `..`.
  The URL it resolves to is then **re-checked**: same origin as the server.
  - `//evil.example` starts with `/` too, and resolves to another origin.
  - `/pos/?token=<JWT>` starts with `/` too, and would sign the till into someone else's account
    (§1.3, FR-14.24).
- **Code:** its format is checked.

### 3.3 Server mode — "Open LGR"

**FR-14.13 — Open LGR** (Overview button and tray item) opens or focuses the window `lgr-web`,
1280×800, loading `WebviewUrl::External(<server origin><startPath>)`.
- **No auth handover.** The user signs in inside the window with the portal's normal login, and
  the session persists in the webview's profile, exactly as roomler does it. No JWT, cookie or
  code passes from the shell into the page. This is S-05's lesson: tokens do not travel in URLs.
- **No IPC.** Every `invoke` from the remote origin is refused (FR-14.9).
- **The window is destroyed on close.**
- **System browser setting:** "Open LGR in my browser" opens the same URL with the OS default
  browser instead.

**FR-14.14 — OAuth sign-in leaves the webview.** Google refuses sign-in inside embedded webviews
it detects (`disallowed_useragent`, *"This browser or app may not be secure"*), and whether it
detects WebView2, WKWebView or WebKitGTK varies by platform and changes without notice. The
desktop therefore **never** runs an OAuth provider page inside `lgr-web`:

1. **What gets intercepted.** The shell intercepts navigation to the portal's **OAuth start
   route** (`/api/oauth/:provider`), not the provider page. It opens the same URL in the system
   browser, adding `desktop=<desktopId>` and the S256 challenge of a verifier the shell has just
   generated.

   Intercepting later breaks the handshake. The S-04 fix binds OAuth `state` to an `oauth_state`
   cookie in the browser that started the flow (`oauth.controller.ts:29,77,103-115`), so the
   whole handshake has to run in one browser.
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

   The redeem page stores the token in `localStorage` the way the login page does, then routes to
   `startPath`. A cookie alone is not enough. The SPAs treat a browser as signed in only when
   `localStorage.lgr_token` is set (portal-ui `router/index.ts:84-89`), and they send it as a
   bearer header (`useHttpClient.ts:18-23`).

   Another app that registers `lgr://` and hijacks the deep link gets the code, but not the
   verifier the shell holds, so it cannot redeem it. This is RFC 8252's PKCE principle.

**FR-14.15 — What a browser does for free, the window must do explicitly.**
- **Downloads:** XLSX/PDF exports go through blob URLs + `a.download`
  (`useInvoicingExport.ts:16-19`). They must save with a Save-as dialog.
- **Print:** the document forms' **Print** must reach the OS print dialog.
- **New windows:** `window.open` must open in the system browser when the target is outside the
  origin, and in `lgr-web` when it is inside.
- **Navigation containment:** navigation outside the origin (other than FR-14.14's intercept)
  goes to the system browser, never into the window.

Each behaves differently in WebView2, WKWebView and WebKitGTK, and each is exercised per platform
(FR-14.37).

**FR-14.16 — Where Open LGR lands.**
- `startPath` comes from the desktop's assignment on the Desktops page (FR-14.22), for example
  `/pos/` for a till, and falls back to `/`.
- **Open LGR on launch** is a setting that a till turns on: after autostart, the POS is on
  screen without anyone touching it.

**FR-14.17 — An unreachable server is a clear page, not a broken window.**
- **In `lgr-web`**, when the cloud does not answer, the window shows a bundled page instead of a
  webview error: *"LGR is unreachable — retrying"*. It retries with backoff (1 s → 60 s), offers
  **Retry now** and **Create diagnostics bundle**, and returns to `startPath` by itself when the
  server answers.
- **Nothing works offline by design.** The page says so plainly, rather than implying work is
  being kept.
- **The Overview** shows the server link: connected / unreachable / signed out of the desktop
  credential.

### 3.4 Registration

**FR-14.18 — Model `Desktop`** (collection `desktops`, `tenantPlugin`).

| Group | Fields |
|---|---|
| Identity | `name`, `nameAdminSet`, `machineId`, `installationId`, `os {platform, version, arch}`, `hostname` |
| Credential | `publicKey` (Ed25519, base64), `keyEpoch`, `keyRotatedAt` |
| Lifecycle | `status: active \| revoked`, `ephemeral`, `ephemeralTtlSec`, `enrollKeyId`, `enrolledBy`, `enrolledAt`, `revokedAt`, `revokedBy`, `revokeReason` |
| Reported | `appVersion`, `capabilities {fiscalBridge, serialPorts[]}`, `lastSeenAt`, `lastPresence {ip, clockSkewMs}` |
| Assignment | `fiscalDeviceIds[]` (what it may bridge), `startPath?` |

Indexes:
- unique `{orgId, installationId}`, with a partial filter `status: { $in: ['active'] }`.
  A `partialFilterExpression` cannot use `$ne`;
- `{orgId, status}`;
- `{orgId, lastSeenAt}`.

**The entity is `Desktop`, not `Device`.** "Device" already means fiscal device all through the
POS and fiscal code: `deviceId`, `deviceNumber`, `getFiscalContext()`, `POSSession.fiscalDeviceId`.
The native bridge is exactly where the two meet.

`installationId` (random, 128-bit) and `machineId` (SHA-256 of hostname + OS + arch, for display
only, **never** a credential) identify the machine. One installation is registered to one org;
moving it to another org means revoke and re-register.

**FR-14.19 — Enrollment.**
- **Single-use codes.** An admin clicks **Register a desktop** (FR-14.23) and gets:
  - a code: 8 Crockford-base32 characters shown as `XXXX-XXXX`, about 40 bits, single use, valid
    10 minutes, stored **hashed**, and rate-limited per IP and per code prefix;
  - a QR / deep link `lgr://enroll?server=<origin>&code=<code>`.

  The desktop exchanges it at `POST /api/desktop/v1/enroll` with
  `{code, installationId, machineId, name, os, hostname, appVersion, publicKey}` and receives
  `{desktopId, orgId, orgName, assignment, serverTime}`.
  - **Re-enrollment** of the same `installationId` revives its revoked row. It keeps the name
    (unless admin-set) and the assignment, and rotates the key.
- **Signed-in approval (SHOULD).** This is the RFC 8628 device-authorization pattern: the desktop
  shows a user code and opens `/settings/desktops/approve?code=…`, and an admin approves. No token
  crosses from a webview into the shell.
- **Ephemeral keys**, for FR-14.38's throwaway VMs.
  - They are gated by the org setting `ephemeralKeysEnabled`, which defaults to off. Turning it off
    revokes the whole class at once.
  - A key is reusable, with `maxUses` / `expiresAt` / `revokedAt`, and every use is recorded.
  - An ephemeral desktop **unregisters itself on clean shutdown**. A **reaper** removes ephemeral
    rows not seen for `ephemeralTtlSec` (default 15 min) and leaves permanent rows alone. This is
    roomler FR-51.

**FR-14.20 — The desktop credential.**
- **The key.** The desktop generates an **Ed25519 keypair** at enrollment. The private key lives
  only in **non-roaming** OS key storage, accessed from the Rust shell:
  - Windows: Credential Manager with `CRED_PERSIST_LOCAL_MACHINE`, or a DPAPI file under
    `%LOCALAPPDATA%`. The `keyring` crate's default (`CRED_PERSIST_ENTERPRISE`) **roams**, and
    would give every PC the user logs into the same desktop key;
  - macOS: Keychain;
  - Linux: Secret Service, falling back to a `0600` file, which the Overview shows as a warning.

  `installationId` is stored non-roaming too. Nothing credential-bearing lives in
  `app_data_dir()` (§1.2 #5).
- **Access tokens.** The shell calls `POST /api/desktop/v1/token` with a JWS (EdDSA) client
  assertion `{sub: desktopId, aud: <token URL>, iat, exp ≤ iat + 60 s, jti}`. It receives an
  access token valid for **15 minutes**, with claims `{desktopId, orgId, keyEpoch, aud:
  'lgr-desktop'}`.
  - The token is signed with a **new secret `DESKTOP_TOKEN_SECRET`**, required in production the
    way `JWT_SECRET` has been since S-02. A desktop token is therefore never valid as a user
    token, and a user token never as a desktop token.
  - A replayed `jti` within 5 minutes is refused.
  - A skewed clock is corrected from the `serverTime` in the enroll and token responses.
- **Revocation is immediate.** Every desktop-authenticated request **re-reads the desktop row**,
  so a revoked desktop is refused at once, whatever its token's age. The row *is* the revocation
  list.
- **Its own auth plugin.** `/api/desktop/v1/*` and `/ws/desktop` are mounted with a
  **`DesktopAuth`** plugin, built exactly like the S-01 fix: an unconditional, deny-by-default
  `onBeforeHandle`, never a macro.
- **`public-routes.ts` gains exactly these entries,** each with its reason:
  - `enroll`, `device-authorization` (start and poll), `token`;
  - the **`/ws/desktop` upgrade**. It carries no token, and must not carry one in its URL. The
    credential is its first message, and a socket that has not authenticated within 10 s is
    closed;
  - `/api/auth/desktop-code/redeem` (FR-14.14).

  The S-01 route-table test asserts exactly these.

**FR-14.21 — Presence and reporting.**
- **The socket.** `/ws/desktop` carries a 30 s heartbeat, `desktop:update` requests (FR-14.22)
  and revocation notices. Presence follows roomler's rule:
  - **online** = a socket is registered;
  - **stale** = seen within 90 s but no socket;
  - **offline** = neither.
- **Clock skew.** The heartbeat carries the desktop's wall clock, the hub records `clockSkewMs`,
  and anything beyond ±2 min is flagged.
- **Reporting.** On start and on change, the desktop reports its version, OS, capabilities and
  the serial ports it sees, via `PUT /api/desktop/v1/self`.

It deliberately does **not** copy `/ws/tasks`, which trusts a `?userId=` query parameter
(`ws.server.ts:32-45`).

**FR-14.22 — Lifecycle actions**, all gated on the existing **`admin.settings`**.
- **Why no new permission.** A new one needs a model change, a PermissionSet backfill and a
  **re-login** before it takes effect, which is the FR-06 P2 ordering hazard that FR-13.26 also
  avoided.
- **Rename.** An admin rename sets `nameAdminSet`, which wins over the desktop's own renames until
  cleared, across re-enrollment.
- **Assign** `fiscalDeviceIds` and `startPath`.
- **Update now / Update all** sends `desktop:update` with every updater safety rule intact
  (FR-14.28). Per-machine installs answer "managed".
- **Rotate key** increments `keyEpoch` and invalidates outstanding tokens.
- **Revoke.** The next request is refused `401 {code:'desktop_revoked'}`, and the socket closes
  with a reason. The desktop:
  1. shows *"This desktop was removed from <org>"*;
  2. stops the fiscal bridge;
  3. deletes its key.

  There is no local data to wipe. Revoked rows stay for the audit trail. Ephemeral rows are
  deleted outright.
- **Audit.** Every action (code minted, key created or revoked, enroll, rename, assign, update
  request, key rotation, revoke, reap) writes an `AuditLog` entry with module `admin`, entity type
  `desktop`, the actor, and the IP where there is one.
- **Tenancy.**
  - `/api/org/:orgId/desktops*` runs behind `AuthService`'s `isForeignOrg` guard.
  - Desktop-principal routes take the org **from the desktop row**, never from the request.
  - `tenant-isolation.flow.test.ts` and the e2e `security` project gain the cross-org cases:
    list, mint, approve, assign and revoke across orgs are all refused.

**FR-14.23 — The Desktops page** in the portal: `/settings/desktops`, route name
`settings.desktops`, in the Settings menu for `admin.settings` holders. It is gated
**server-side**: portal routes have no client-side guard (FR-13 trap 20), so the endpoint checks
are the whole control.

- **Table.** Columns can be toggled with the per-user column picker, and the filters live in the
  URL (`useListQueryState`):

  | Column | Content |
  |---|---|
  | Actions | the row menu |
  | Desktop | name, presence dot (FR-14.21), `ephemeral` chip, copy-id |
  | Status | active / revoked (an **include revoked** toggle, off by default) |
  | Version | with an "update available" or "managed install" chip |
  | OS | |
  | Fiscal devices | bridged devices and their state |
  | Start path | |
  | Last seen | |
  | Clock | skew, flagged beyond ±2 min |

- **Toolbar:** **Register a desktop**, **Update all**, search, auto-refresh (10 s).
- **Register a desktop** shows:
  - the code with a live 10-minute countdown and the QR;
  - short per-OS download links to the latest signed release;
  - a close-by-itself *"Till-2 registered"*, by polling the code's state;
  - when `ephemeralKeysEnabled` is on, a section to manage ephemeral keys and their use ledger.
- **Row actions:** Rename · Assign · Update now · Rotate key · **Revoke…**
  - The revoke confirmation says what happens: the fiscal bridge stops on that machine.
- **The approval page** `/settings/desktops/approve?code=` shows:
  - what the machine reported about itself (name, OS, hostname, public IP, time);
  - a warning if the IP is far from the admin's own;
  - **Approve** / **Deny**, both audit-logged.
- **Language.** Every string exists in en/bg/de/mk.
- **Endpoints** (user-authenticated, `admin.settings`):

```
GET    /api/org/:orgId/desktops                      list: presence, versions; paging, search
GET    /api/org/:orgId/desktops/:id
PUT    /api/org/:orgId/desktops/:id                  name, fiscalDeviceIds, startPath
POST   /api/org/:orgId/desktops/:id/update | rotate-key | revoke
POST   /api/org/:orgId/desktops/update-all
POST   /api/org/:orgId/desktops/enrollment-codes     → { id, code, expiresAt, deepLink }
GET    /api/org/:orgId/desktops/enrollment-codes/:id state (unused / used by <desktop> / expired)
GET    /api/org/:orgId/desktops/enrollment-keys      ephemeral keys
POST   /api/org/:orgId/desktops/enrollment-keys      { maxUses, expiresAt }
DELETE /api/org/:orgId/desktops/enrollment-keys/:id
GET    /api/org/:orgId/desktops/enrollment-keys/:id/uses
GET    /api/org/:orgId/desktops/device-authorizations/:userCode
POST   /api/org/:orgId/desktops/device-authorizations/:userCode/approve | deny
```

and for the desktop itself (`DesktopAuth`):

```
POST   /api/desktop/v1/enroll                        anonymous — the code/key is the credential
POST   /api/desktop/v1/device-authorization          anonymous — start
POST   /api/desktop/v1/device-authorization/poll     anonymous — the poll handle is the credential
POST   /api/desktop/v1/token                         anonymous — the signed assertion is the credential
PUT    /api/desktop/v1/self                          report version / OS / capabilities
DELETE /api/desktop/v1/self                          ephemeral self-unregister
GET    /api/desktop/v1/latest-release                FR-14.28
WS     /ws/desktop                                   presence, update requests, revocation
```

### 3.5 The two live web fixes (P1, independent of the desktop)

**FR-14.24 — The SPAs accept `?token=` only on the Vite dev ports.** The receiving side (every
`*-ui` router's `?token=` / `?org=` handling, §1.3) gets the same condition as the sending side
(`navigate.ts:22-30`): `localhost` on a per-app dev port. On any other origin, a `?token=` is
removed from the address and **ignored**. It never replaces the signed-in account.

**FR-14.25 — `/ws/fiscal-bridge` authenticates its bridges.**
- **The browser relay** authenticates with the user's JWT in its first message, must be in the
  device's org, and needs `pos.write`.
- **The native bridge** authenticates with the desktop access token (FR-14.20), and the device
  must be in the desktop's `fiscalDeviceIds`.
- **Bridges are keyed by `(orgId, deviceNumber)`,** not `deviceNumber`, which collides across
  orgs.
- **A takeover of an authenticated bridge** by another principal requires `admin.settings`, is
  audit-logged, and tells the evicted bridge why.

### 3.6 The native fiscal bridge

**FR-14.26 — The shell owns the till's fiscal device.** On a desktop assigned fiscal devices, the
shell:
- opens their serial ports with the Rust `serialport` crate;
- speaks the existing bridge protocol to the hub as the registered desktop: `fiscal:bridge:register`,
  `fiscal:command`, `fiscal:response`, base64 frames, and the `protocol: 'isl'` + `timeoutMs`
  framing that `useFiscalBridge` implements (SEQ-matched, SYN-aware).

The protocol drivers stay where they are, in TypeScript on the hub (`isl-frame.ts`, `eltrade.ts`,
`tremol.ts`), and the shell only moves bytes. УНП allocation stays on the hub exactly as today
(`generateUNP`).

This ends three things:
- **"Failed to open serial port"**, which means another *tab* holds the port. The 2026-09-28
  memory records a Saturday tab holding COM4 for 33 h.
- **Web Serial's Chrome/Edge-only limit.** WKWebView and WebKitGTK have no Web Serial at all.
- **The `bridge.ts` CLI.**

⚠ The byte transport is Rust, never Bun: Bun + `serialport` on Windows opens the port and writes,
but **never delivers received bytes**. That made the Eltrade A3 look dead for two days in
September.

**FR-14.27 — `FiscalDevice.connectionType` gains `desktop`**, with `connectionParams.port` and a
`bridgeDesktopId`.
- The POS terminal and `GET /fiscal/device` show *"connected via <desktop name>"*, alongside
  today's live `connected` flag.
- A device bridged by a desktop is **never** also offered to the Web Serial relay. One owner per
  port is the point.

### 3.7 Updates

**FR-14.28 — Auto-update, with roomler's safety rules and roomler's trust anchors.**

| Rule | Detail |
|---|---|
| Manifest | server-proxied `GET /api/desktop/v1/latest-release`, per channel (stable / beta), checked at start (5-min cooldown) and every 4 h |
| Trust | **both** must pass, and every check **fails closed**. (1) The Tauri updater signature against its key **pinned in the binary**. (2) The platform signature against **roomler's identity**, pinned in the binary: Authenticode subject `G ROX LTD`, the Developer ID Team ID, and the roomler release GPG key fingerprint for `.asc`. |
| Direction | no downgrade, ever; an unparseable version is not an upgrade |
| Deferral | defer while the bridge has a fiscal command in flight or has carried one in the last 10 minutes (the till is in use); force through after 7 deferrals, never mid-receipt |
| Recovery | crash-loop rollback to `last_known_good_version`, marked *before* the attempt |
| Admin | "Update now / all" from the Desktops page, under the same rules |
| Per-machine installs | **managed updates** (FR-14.4): check, notify, report the version; never self-install, never elevate |

The updater's minisign key is generated once, and its private half lives in the lgr `release`
environment beside the roomler signing material.

**FR-14.29 — A minimum version.** The hub publishes `DESKTOP_MIN_VERSION`. Below it,
`/api/desktop/v1/token` answers **426 `{code:'desktop_outdated'}`**, so the native bridge cannot
connect until the desktop updates. The Overview says *"Update required"* and offers the update.
`lgr-web` keeps working, because it is just the cloud app. The minimum starts at the first FR-14
release, so a v0.1.x prototype never talks to the new endpoints.

### 3.8 The shell's pages

**FR-14.30 — Overview.** It has three cards and a set of banners.

**This desktop**
- registration chip: Registered / Not registered / Revoked;
- name, org;
- server and server link (FR-14.17);
- app version;
- **Open LGR**.

**Fiscal devices** (when assigned)
- per device: port, state, last command.

**Updates**
- current version, **Check**, **Install**, and "update required".

**Attention banners**, each with its fix:
- not registered → Register;
- revoked;
- desktop key stored in a file (FR-14.20);
- clock skew above ±2 min;
- update required (FR-14.29);
- server unreachable (FR-14.17).

**FR-14.31 — Views:** Overview · Settings · Onboarding · Logs (source, filter, follow, as
roomler has) · Diagnostics (FR-14.10). They are Vue views in `desktop-ui`, reusing `ui-shared`
(Vuetify, i18n en/bg/de/mk). They are bundled into the app and work with no network.

**FR-14.32 — Settings.**
- server URL (changing it requires re-registration);
- desktop name;
- autostart;
- open LGR on launch;
- open in system browser;
- proxy override;
- language;
- log level;
- **Rotate desktop key**.

The shell's own connections (registration, tokens, `/ws/desktop`, the bridge socket, the
updater) use the **system proxy (PAC included) and the OS trust store**, so a TLS-inspecting
corporate middlebox whose root arrives by GPO just works. A start path set by an admin is shown
read-only, with *"set by your administrator"*.

**FR-14.33 — Language.** The shell follows the OS locale until the user picks one: bg for a
Bulgarian Windows, and so on. Every string exists in all four locales. A missing key renders
literally (FR-06 lesson).

### 3.9 Retire the local-mode prototype

**FR-14.34 — Local mode is removed, not left to rot.** The first FR-14 release removes:
- **from the shell:** the sidecar spawn and supervision (`sidecar.rs`), the `lgr-api`
  `externalBin`, the Bun compile step in the release workflow, and the archive scheduler and its
  six commands (`archive.rs`). There is no local data left to archive;
- **`packages/desktop-api`**, and with it the demo org, `admin`/`admin123`, the `lgr-dev-secret`
  signing and the `/api/settings` sync section;
- **`packages/sync`**;
- **`packages/dal-sqlite`** and its parity tests. Nothing else uses them. The DAL interface and
  `dal-mongo` stay;
- **`desktop-ui`'s** domain routes and store aliases, and the committed `lgr.db-shm` / `-wal`
  files and the stray icon copy;
- **the prototype's docs, in the same PR:** `docs/api/desktop-api.md`,
  `docs/architecture/sync.md`, `docs/guides/sync-setup.md`, `cloud-to-desktop.md` and
  `desktop-to-cloud.md`. `docs/architecture/desktop.md` and `docs/guides/desktop-install.md` are
  rewritten for the client.

### 3.10 Tests and automated field testing

**FR-14.35 — CI.** There is none today; the only workflow is the broken `desktop-release.yml`.
- **`ci.yml`** runs on every pull request and push to master, on `ubuntu-latest`:
  `bun install --frozen-lockfile`, `bun run test`, `bun run build` (which includes `desktop-ui`),
  and `cargo clippy -p lgr-desktop` with the webkit dependencies installed.
- **A `macos-latest` job** runs `cargo check`, on demand and at a `desktop-v*` tag.
- **`desktop-ci.yml`** runs on demand (dispatch it for a PR touching `packages/desktop*`,
  `packages/fiscal` or `packages/e2e`) and at every `desktop-v*` tag. It builds the unsigned app
  on Linux and Windows, plus macOS at a tag, and the dispatch runs the Windows smoke (FR-14.37).
- ⚠ **Neither runs per PR or per merge any more (October 2026).** Hosted macOS bills at 10x and
  Windows at 2x. Running them per PR and per merge spent the account's free monthly allowance by
  2026-10-07, and GitHub then refused every job in this private repository for the rest of the
  month. The desktop dry build moved from weekly to monthly for the same reason.
- **The gate starts green.** Anything red on master when it is switched on is fixed first, or
  quarantined with a linked issue.
- **Heavy runs go to mars** (nightly e2e in the pinned Playwright container), not paid Actions
  minutes.

**FR-14.36 — Integration suites** (`packages/tests`):
- **Enrollment:** codes are single-use, expire, and are rate-limited; ephemeral keys and the
  reaper; re-enrollment revives the row and rotates the key.
- **Tokens:** assertion replay is refused, skew is corrected via `serverTime`, `keyEpoch`
  rotation works, and the row is the revocation list.
- **Auth boundaries:** desktop and user tokens are refused on each other's routes. The
  public-routes table test lists exactly FR-14.20's entries. An unauthenticated `/ws/desktop`
  receives nothing and closes after 10 s.
- **Cross-org:** every FR-14.22 case, in `tenant-isolation.flow.test.ts` and in the e2e
  `security` project.
- **`/ws/fiscal-bridge`** refuses unauthenticated and cross-org registrations and never evicts an
  authenticated bridge silently. The native bridge protocol runs against the **Eltrade
  simulator** (`tests/helpers/eltrade-simulator.ts`) over a pseudo-serial pair, covering SEQ
  priming, a replayed SEQ, SYN handling, the open-receipt void, and a second opener refused.
- **The `?token=` fixation case** (FR-14.24).
- **Hygiene:** no `.rejects` / `.resolves`, which deadlock the Windows run. Use
  `captureRejection` / `expectRejection`. No test contacts `lgrai.app`.

**FR-14.37 — E2E (Playwright).**
- **Portal:** `desktops.spec.ts` covers the table, register dialog (a stub desktop exchanges the
  code → it appears online → the dialog closes), every row action with its confirmation text, and
  the approval page.
- **Security project:** the desktops endpoints for `member`, `manager`, a foreign org and
  anonymous callers, plus the fixation case.
- **The app itself, on Windows.** The harness sets
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<p>`. **The harness sets it,
  never the app.** It drives the app with `connectOverCDP` and:
  - walks every shell view, asserting real DOM per view;
  - asserts that `lgr-web` opens a stub hub at `startPath`;
  - asserts that **a real `invoke` from `lgr-web` is rejected**;
  - asserts that an XLSX export saves;
  - asserts that `window.open` to an outside origin takes the system-browser path, and that
    print reaches the platform print path, both via the shell's structured log lines;
  - asserts that the unreachable page appears with the stub hub stopped, and recovers when it
    restarts.
- **The app on Linux and macOS:** `--view=<v>` + screenshots per view (over 20 KB, pairwise
  distinct), and a screenshot walk on macOS.

**FR-14.38 — Automated field testing: LGR lanes on the vmtest hosts.**
- **Reuse, don't rebuild.** The lanes reuse roomler's host capability (`k8s-cluster-multi`
  playbook 15, `vmtest-host` on zeus + mars, `vmtest-net`, `vmtest-audit`) and its golden images.
- **The orchestrator** is `lgr-deploy/vmtest/lgr-vmtest.sh`, with the same verbs
  (`bake|run|destroy|report|clean`), filters (`--lane --method --type --check --host --keep`) and
  report shape (`results.tsv`, `LATEST`, `expected-failures.txt`, isolated re-run, a
  `gjovanov/lgr` issue on a confirmed regression).
- **Production isolation.** A dedicated org `lgr-fieldtest` on `https://lgrai.app` is used, with
  **synthetic data only**. Every VM enrolls with an **ephemeral key**, and every run ends with the
  org at its desktop baseline (the reaper is the backstop).
- **The skill** `.claude/skills/lgr-vmtest/` is written after the lanes are green, as roomler's P8
  was.

A cell that cannot exist is recorded **NA, with the reason**, never skipped.

| Lane (host) | Methods | Types | Notes |
|---|---|---|---|
| **Win11 x86_64** (zeus, roomler golden) | NSIS per-user · MSI per-machine | standard user · admin | the till class |
| **Win11 corporate** (zeus) | MSI per-machine (as IT deploys it) · NSIS per-user | standard user | AppLocker default rules (**the per-user cell is expected to be refused by policy**, with a clear message); explicit proxy + a **TLS-inspecting mitmproxy** whose root is pushed to the machine store |
| **Ubuntu 24.04 GNOME Wayland** (zeus / mars) | `.deb` · AppImage (MAY) | per-user | |
| **macOS arm64** (tart on the MacBook, opt-in) | `.dmg` | per-user | auto-NA when the Mac is unreachable |

**Checks per cell.** A result id is `lane/method/type@host#check`:

| Check | Asserts |
|---|---|
| `install` | the installer succeeds silently for the type |
| `signature` | on the guest: Authenticode subject **`G ROX LTD`** with a timestamp / notarised + stapled / `.asc` by the roomler release key |
| `register` | the ephemeral key → the desktop is online in `lgr-fieldtest` |
| `presence` | online → offline within 90 s of a network cut |
| `open-lgr` | `lgr-web` loads `lgrai.app/<startPath>`; a password sign-in lands on the POS |
| `no-ipc` | a real `invoke` issued from `lgr-web` is rejected |
| `local-storage` | the key and `installationId` live in non-roaming storage |
| `downloads` · `print` | an XLSX export saves; the print-path log line appears |
| `desktop-walk` | every shell view renders (CDP DOM / screendump / screenshots) |
| `unreachable` | the guest firewall blocks the server → the unreachable page → unblock → back at `startPath` |
| `update` | install N-1 from the release, update to the build under test; **a tampered artifact is refused**; deferred while the bridge is busy. Per-machine cells assert **managed updates** instead. |
| `revoke` | revoke through the API → the Overview shows it within one heartbeat; the bridge stops |
| `ephemeral-cleanup` | a guest `shutdown` removes the row; `virsh destroy` leaves it for the reaper |
| `fiscal-bridge` | the Eltrade simulator behind a virtual serial pair (com0com on Windows, `socat` pty on Linux); a server-mode POS sale reaches it and prints; a second opener is refused |
| `proxy-tls` | corporate lane: `register`, `open-lgr`, the bridge socket and the update check all work through mitmproxy with the GPO root |
| `clock-skew` | runs **before** the lane's `w32time` resync, on the golden's natural +3 h clock: tokens still mint (`serverTime` correction), and the skew is flagged |
| `oauth-browser` | the Google sign-in hand-off (FR-14.14): **NA headless**, verified by the operator per release |

- **Result protocol.** Guest drivers emit `LGRTEST-RESULT <check> PASS|FAIL|NA <detail>` and
  `LGRTEST-METRIC <name> <value> <unit>`. A **missing result is FAIL**. Screenshots and the
  diagnostics bundle of every failing cell are kept next to `results.tsv`.
- **Budgets.** They are `METRIC` checks that fail when exceeded:
  - app start → Overview: < 5 s;
  - Open LGR → first paint on the lane network: < 3 s;
  - bridge command round trip: p95 < 500 ms.
- **Safety rails,** inherited from vmtest:
  - jupiter (production storage) is refused without an announced window;
  - one guest per host at a time;
  - check `tmux ls` / `virsh list` for a parallel roomler or LGR run, because the two share hosts;
  - never `restart` an ephemeral desktop whose row the cell still needs.

**FR-14.39 — The release gate, the field log, the fleet check.**
- **The gate.** A `desktop-v*` tag publishes a **draft** release. It becomes the release the
  updater serves only when all of these are true:
  - `ci.yml` and `desktop-ci.yml` are green for the tagged commit;
  - every lane cell is green, or matched by `expected-failures.txt` with a linked issue;
  - there is a field-verification log entry.

  The release PR carries this as a checklist.

  ⚠ **Changed 2026-10-13: the gate is opt-in.** `desktop-release.yml` now PUBLISHES by default,
  on a tag and on a dispatch, and itself sets `DESKTOP_RELEASE_VERSION`/`_URL` in lgr-deploy
  (needs the `LGR_DEPLOY_TOKEN` secret) once the release exists. The three conditions above are
  enforced only for a release dispatched with `draft: true` and promoted by
  `desktop-promote.yml`. Reason: the gate never worked for a dispatched draft — a draft creates
  no git tag (`untagged-…`), and promote starts by checking out the tag. A dispatch builds
  `windows-linux` by default; macOS only with `all` or a tag.
- **The field-verification log.** This FR keeps one, in roomler's convention (`roomler-ai` →
  `docs/fr/FR-27-…md`): per release and per finding, the **baseline run showing the failure**, the
  fixed run, run links and versions. A check never seen failing is not evidence.
- **The fleet check.** After every release,
  `lgr-deploy/scripts/desktop-fleet-check.sh` reads the Desktops API for `lgr-fieldtest` and, once
  live, regal-pz. It reports version adoption, presence and last seen. Machines that also run a
  Roomler agent are checked with `roomler exec <device> 'lgr-desktop --status-json'`.
  - ⚠ `roomler exec` splits argv on spaces, so the command stays a single token plus flags.

---

## 4. Edge cases and traps

1. **`cargo install` without `--locked`** is what broke the release pipeline (§1.2 #1). The
   weekly dry build (FR-14.2) exists so a robot finds the next one.
2. **Two repositories hold one signing identity** (FR-14.3). A rotation done only in roomler-ai
   ships LGR releases that fail their own `expect-subject-contains`. Worse, if the check were
   skipped, they would fail the updater's pinned-fingerprint check on every installed desktop.
   Rotate both the same day.
3. **The Entra federated credential is bound to an environment**, because the tenant rejects
   wildcard tag subjects. An lgr job without `environment: release` fails the OIDC exchange with
   an error that reads like a signing outage.
4. **Google blocks OAuth in embedded webviews** (FR-14.14). It may work on one OS and fail on
   another, and it can change overnight. Design for the system browser, not for luck.
5. **`?token=` in a URL is a sign-in today** (§1.3). A deep link, a bookmark or a chat message
   can carry one. FR-14.24 closes the receiving side. FR-14.12 makes sure the desktop never
   builds such a URL itself.
6. **Downloads, print and `window.open`** work in a browser tab and silently do nothing in some
   webviews (FR-14.15). A Print button that does nothing on a till is a support call.
7. **Web Serial does not exist in WKWebView or WebKitGTK.** Without the native bridge, LGR on
   macOS and Linux desktops has no fiscal path at all.
8. **Bun `serialport` on Windows never receives** (FR-14.26). Do not "simplify" the bridge into a
   script.
9. **AppLocker refuses per-user installs** (FR-14.4). In the corporate lane that is the expected
   result, not a bug to "fix" by weakening the lane.
10. **Roaming profiles** would put the desktop key and `installationId` on every PC the user logs
    into (FR-14.20). Use `CRED_PERSIST_LOCAL_MACHINE` / LocalAppData.
11. **The Win11 golden's +3 h clock** makes a 10-minute enrollment code look expired, and a
    60-second assertion invalid. That is why the order is: `clock-skew` first, then resync, then
    everything else. It is also why the desktop corrects `iat` from `serverTime`.
12. **The WebView2 remote-debugging port is for the harness only.** It is enabled by the lane's
    environment variable, never by the app.
13. **Autostart on a shared PC starts the app for every user who logs in.** It is per-user by
    design, and the installer does not register a machine-wide login item.
14. **`isSignIn` does not protect a route; the unconditional guard does** (S-01). `DesktopAuth` is
    safe because it is built the same way, not because a flag is set.
15. **`.rejects` / `.resolves` deadlock the Windows test run** (CLAUDE.md). Use the capture
    helpers from the first line.

---

## 5. Integration constraints

- The portal's cross-SPA `?token=` handoff is restricted to the Vite dev ports, on **both**
  sides (FR-14.24).
  - `lgr-web` serves every SPA from one origin (`/`, `/invoicing/`, `/pos/` …), and they share
    the bearer token the login response delivers into `localStorage`.
  - The FR-14.14 redeem answers like `/auth/login`, so it fits the same contract.
  - **No desktop code adds a token-in-URL path.**
- `unified.ts` mounts the Desktops admin controller, the `DesktopAuth` controller and the
  `/ws/desktop` socket beside the existing ones.
- Route names are load-bearing twice: in `useGridColumns` keys and in Playwright navigation (FR
  README global constraint 3). `settings.desktops` and `settings.desktops.approve` are named once.
- The fiscal protocol drivers (`packages/fiscal`) are unchanged by the native bridge. Only the
  transport moves.
- Release tags stay `desktop-v*`. The desktop version is independent of the cloud image tag, and
  the hub gates compatibility with `DESKTOP_MIN_VERSION` (FR-14.29).
- i18n keys ×4 (en/bg/de/mk) for every new string, portal and shell alike.

---

## 6. Phases

| Phase | Ships | Kill switch / rollback |
|---|---|---|
| P1 | **The two live web fixes** (FR-14.24–14.25) first; pipeline + roomler signing (FR-14.2–14.4); the shell, Overview and Open LGR incl. OAuth (FR-14.5–14.17, .30–.33); registration + the Desktops page (FR-14.18–14.23); the updater (FR-14.28–14.29); the prototype retired (FR-14.34); CI + integration + e2e (FR-14.35–14.37); Win11 + Ubuntu lanes | Unpublish the draft release; the updater never downgrades, so a bad build is fixed forward by a new tag |
| P2 | The native fiscal bridge (FR-14.26–14.27); the `fiscal-bridge` check and the corporate lane | Per device: set `connectionType` back to `browser` |
| P3 | The macOS lane, budgets enforced, the release gate enforced, fleet check + `lgr-vmtest` skill (FR-14.38–14.39) | — |

⚠ **P3 changes P1's release behaviour.** FR-14.2–14.4's pipeline published a `desktop-v*` tag
directly; the gate makes that tag publish a **draft**, promoted only by `desktop-promote.yml`
re-checking CI green for the tagged commit, lane cells green-or-expected-with-an-issue, and a
field-log entry. `desktop-release.yml`'s `draft=` was changed in place rather than a second
workflow being added, so there is one publish path and not two.

---

## 7. Acceptance criteria

1. A `desktop-v*` tag builds Windows (NSIS per-user + MSI), macOS (DMG, notarised + stapled) and
   Linux (`.deb`/`.rpm` + `.asc`) artifacts. **All of them are signed with roomler's identity**:
   Authenticode subject `G ROX LTD` with an RFC3161 timestamp, roomler's Developer ID, and roomler's
   release GPG key. A missing signature fails the tag. The weekly dry build runs green.
2. On Windows, both installers work where they are meant to:
   - A per-user install on a standard (no-admin) account **without** AppLocker succeeds,
     registers and opens LGR.
   - **Under AppLocker default rules,** the per-machine MSI deployed by IT runs for a standard
     user and reports managed updates. The per-user installer is refused by policy with a clear
     message.
3. **Open LGR** opens `lgr-web` at the assigned `startPath`. Password sign-in works inside it.
   **Google sign-in** goes through the system browser and lands signed in, with no JWT in any URL,
   history entry or log line.
4. A real `invoke` issued from `lgr-web` is **rejected**. `withGlobalTauri` is off.
5. `https://lgrai.app/apps?token=<valid JWT of another account>` does **not** change who the
   browser is signed in as. `lgr://open` with `?path=//evil.example` or `?path=/pos/?token=<JWT>`
   is refused.
6. In `lgr-web`, on Windows, macOS and Linux:
   - an XLSX export saves;
   - a document **Print** reaches the OS print dialog;
   - an external link opens in the system browser.
7. With the server blocked, `lgr-web` shows the unreachable page and recovers to `startPath` on
   its own when the server returns.
8. A till desktop with autostart and **Open LGR on launch** shows the POS after a reboot with no
   interaction.
9. A minted code registers a fresh desktop, which shows **online** on the Desktops page within
   one heartbeat. The code cannot be used twice or after 10 minutes. An ephemeral desktop
   disappears on clean shutdown, and via the reaper after `kill -9`.
10. The private key is in non-roaming OS key storage on all three OSes, and nowhere in any file
    the app writes. A copied config yields no credential.
11. A revoked desktop is refused within one heartbeat, whatever its token's age, and its bridge
    stops. Desktop tokens are refused on user routes, and user tokens on desktop routes.
12. The cross-org cases pass in `tenant-isolation.flow.test.ts` and in the e2e `security`
    project. Every lifecycle action is audit-logged.
13. With the native bridge, the Eltrade A3 prints a non-fiscal receipt from a server-mode sale on
    Windows, and a second opener cannot take the port. `/ws/fiscal-bridge` refuses
    unauthenticated and cross-org registrations and never evicts an authenticated bridge
    silently.
14. An update from N-1 to N installs when the till is idle and defers while the bridge is busy. A
    one-byte-tampered artifact is refused, and so is an artifact signed by any identity other than
    roomler's. A crash-looping N rolls back to N-1.
15. Below `DESKTOP_MIN_VERSION`, the token endpoint answers 426 and the Overview offers the
    update, while `lgr-web` keeps working.
16. No `sidecar`, `desktop-api`, `sync` or `dal-sqlite` code ships. No default credential or
    `lgr-dev-secret` exists anywhere in the build or its release notes.
17. `ci.yml` runs on every PR and push, green on master when enabled. `bun run build` builds
    `desktop-ui`, and deleting a view it imports fails the build.
18. `lgr-vmtest.sh run --lane win11` runs every P1 cell from the dev box through mars with no
    manual step on the VM, and leaves `lgr-fieldtest` at its baseline. A confirmed unexpected
    failure files a `gjovanov/lgr` issue carrying the cell id, logs, screenshot and diagnostics
    bundle.
19. The diagnostics bundle contains logs, versions, registration and bridge state, and no token,
    key or receipt content (checked by grep over a generated bundle).

---

## 8. Field test

The repeatable version is FR-14.38's lanes and FR-14.39's fleet check. The first manual pass on
production (`https://lgrai.app`, org `lgr-fieldtest`, then regal-pz's till) goes as follows:

1. Ship the two web fixes. Confirm:
   - `…/apps?token=<another account's JWT>` leaves the session untouched;
   - an unauthenticated `/ws/fiscal-bridge` registration is refused, while the till's browser
     relay still works when signed in.
2. Install the signed per-user build on a Windows machine. Confirm:
   - SmartScreen shows publisher **G ROX LTD**;
   - registration by code;
   - the desktop appears online on `/settings/desktops`.
3. Open LGR, sign in with a password, then with Google (system-browser round trip). Export an
   XLSX and print a document.
4. Block `lgrai.app` in the firewall, and confirm the unreachable page and the recovery.
5. Assign the Eltrade A3 (non-fiscalised: non-fiscal receipt) to the desktop. Confirm:
   - a POS sale prints through the native bridge;
   - a Chrome tab cannot take the port.
6. Publish N+1 as a draft, promote it, and watch the till update when idle. Tamper with a copy of
   the installer and confirm the updater refuses it.
7. Revoke the desktop from the Desktops page. The Overview shows it within one heartbeat, and
   the bridge stops.
8. Only then install on regal-pz's till, with autostart and Open LGR on launch.

---

## Field-verification log

*(Filled per release, in roomler's convention: a failing baseline before the passing run.)*

### Convention (C20 §4)

One entry per release and per finding. Each records **the baseline run showing the failure**
beside the fixed run, with links and versions.

⚠ **A check never seen failing is not evidence.** If a check has only ever passed, it may be
asserting nothing — so the convention is to break the behaviour once, record the red run, and
only then record the green one. That is the single most useful idea here, and it is why the
baseline column is not optional.

⚠ `desktop-promote.yml` reads this section at the **tagged commit** and refuses to promote a
release with no entry naming its version. It also warns when an entry records no baseline.

---

### Pre-release — the C15 CDP walk (2026-10-02)

Not a release entry: these four findings predate the first signed tag, and they are recorded
because each one *is* a baseline-red/fixed pair, produced by arming a check that had never run.
They are the evidence that the walk asserts something.

⚠ All four had **shipped**. The common cause is worth naming: every one was invisible to the
tests that existed because those tests asserted that something *started*, never that it
*worked*.

| # | Finding | Baseline (red) | Fixed | Evidence |
|---|---|---|---|---|
| 1 | The five shell views rendered **empty** under C08's CSP — `script-src 'self'` forbids `new Function`, which is how vue-i18n compiles every message, so every `$t()` threw an `EvalError` and the nav items and all five view bodies rendered as nothing | first run of `desktop-app.spec.ts` against the built shell: `the shell window › comes up on the Overview` failed, `[data-card="this-desktop"]` **element(s) not found**, with the a11y snapshot showing only `navigation / separator / list / text: v0.1.3` | `__INTLIFY_JIT_COMPILATION__` in `packages/desktop-ui/vite.config.ts` | After: 11 `data-*` markers and 5 nav hrefs present, **0 console errors**. ⚠ C08 believed `shell_ready` had proven the CSP; that line only shows the module executed |
| 2 | **Open LGR deadlocked the app** — a synchronous Tauri command runs on the main thread and `WebviewWindowBuilder::build()` needs the event loop, so it never returned and every later `invoke` hung too | over CDP: `get_status` → `OK {…}`, `open_lgr` → `TIMEOUT-8s`, `get_status` again → `TIMEOUT-8s`, with a half-created `about:blank` page present | `open_lgr`/`print_lgr` are `async` + `spawn_blocking`; the tray item spawns a thread; `setup`'s call stays direct | After: `lgr-web: opened url=http://127.0.0.1:4099/pos/`. ⚠ Nobody had hit it because the tray item and `openLgrOnLaunch` do not run inside a command handler |
| 3 | The bundled **unreachable page went to the system browser** — on Windows the bundle is served over plain `http` on `tauri.localhost`, so `decide_navigation` called the shell's own page a different site | app log: `lgr-web: external-navigation url=http://tauri.localhost/unreachable.html?wait=1&lang=en`, and the `lgr-web` window stayed `about:blank` | `is_bundled_host` in `web.rs`, matching `tauri.localhost`/`asset.localhost` by **exact** host | After: the bundled page appears and `lgr-web: server-returned url=` follows unattended. 2 new Rust tests cover both directions |
| 4 | **`--status-json` reported `not_registered` on a registered machine** — it hardcoded the value while `registration_status()` needs no `AppHandle` at all | a registered machine with `identity/desktop.key` and `identity/registration.json` on disk: `"registration":{"state":"not_registered"}`, `"keyStorage":"none"` | `print_status_without_app` calls `registration_status()` | After: `state: registered`, `desktopId: stub-desktop-1`, `keyStorage: keystore`, `assignment.startPath: /pos/`. ⚠ This would have poisoned C17 directly — its drivers read `--status-json` instead of scraping screens, so a lane's `register` cell would have read `not_registered` from a till that had just enrolled |

**Also pre-release, in the harness rather than the product:**

| Finding | Baseline (red) | Fixed |
|---|---|---|
| `desktop-ci.yml`'s "Collect the app log" step could not parse — the file was committed through a cp1252 round trip, so its em dashes are stored as `â€”`, and `”` **closes** a PowerShell string | `ParserError: Unexpected token 'it' in expression or statement` at the line after an em dash. ⚠ Broken since C16 and never noticed, because the step only runs `if: failure()` — the first time the job it guards failed, the step meant to explain why failed too | encoding repaired; the inline block is ASCII-only; `packages/tests/src/unit/workflow-powershell-ascii.test.ts` guards it, **verified by reintroducing the em dash and watching it fail** |
| The harness hid why the app was not running — `launchShell` ignored both the spawn error and the exit | CI reported `no CDP endpoint on 9222 after 60000 ms`, which names the debugging port: the one thing that was working | the binary's existence is checked before spawning, `error`/`exit` are recorded, and `connect` reports a dead child as a dead child. ⚠ It paid for itself immediately: the next failure said *"the app is still running, so it started but never opened the port"* and quoted the app's own log |

**Open, with no fix yet:** master's `windows smoke (CDP)` fails on `windows-2025-vs2026` with the
app up (`ui ready`) and no debugging port. Ruled out by experiment, not by reasoning: the
**build** (the exact CI artifact passes all 13 cases locally), `additionalBrowserArgs` (absent),
and the **WebView2 version** (runner Edge `153.0.4234.48` vs local `154.0.4258.53`). A
`portDiagnostics()` helper now prints the browser args, the runtime version and any listener on
the port, so the next CI failure names the cause instead of inviting another guess.

**2026-10-07 — the version theory is dead, and two more with it.** The runner was updated to
`154.0.4258.62`, which is *newer* than the local runtime that passes, and the port still never
opened. Two hypotheses were then tested against the installed 0.1.4 on **the same
`154.0.4258.62`**, and both are false — recorded so nobody pays for them again:

| Hypothesis | Why it was plausible | What the experiment showed |
|---|---|---|
| wry's `AdditionalBrowserArguments` **overrides** `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`, so the harness's switch never arrives | that is what the WebView2 docs say about the option, and wry does set it (`--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`) | the browser process came up carrying **both**: the variable is APPENDED. `--remote-debugging-port=9222` present, `/json/version` answered `Edg/154.0.4258.62` |
| Chromium refuses remote debugging on the **default** user data directory (the 136 cookie-theft mitigation), and `WEBVIEW2_USER_DATA_FOLDER` is unset | it would be silent, version-independent and exactly this shape | the port opened with `--user-data-dir` on the app's own default `…\com.lgr.desktop\EBWebView`. Setting the folder is not the fix it looks like |

The local run of the whole spec against that binary: **14 passed, 1 skipped, 20.3 s.** So the
harness is not the subject — the difference is the image.

**Then the measurement arrived, and took two more with it.** The browser process's command line on
the runner carries wry's `--disable-features=…` and **not** `--remote-debugging-port`, in the
position where the runtime appends the variable locally. So the switch is dropped at
environment-creation time by the runtime, on this image — not stripped by the harness, not
refused after being accepted.

| Also ruled out | What the experiment showed |
|---|---|
| **An Edge policy on the image** (`RemoteDebuggingAllowed`, `WebView2AdditionalBrowserArguments`) | `HKLM` and `HKCU\SOFTWARE\Policies\Microsoft\Edge` are both **absent** on the runner |
| **The build / the artifact** | the failing run's own `lgr-desktop.exe` (0.1.3) downloaded and driven through the whole spec locally: **14 passed, 1 skipped, 24.3 s** |

⚠ **Leading hypothesis now, untested: the app runs elevated** (`runneradmin`, UAC effectively
off). Silent, machine-wide, version-independent, invisible on a developer machine — the shape
fits. `portDiagnostics` prints the integrity level and the elevation flag, so the next dispatch
answers it.

⚠ **The job is `workflow_dispatch`-only as of 2026-10-07, which is a deliberate weakening**
(gjovanov/lgr#116). It was a failing check on every commit, and promote condition 1 refuses any
tagged commit carrying one — an unexplained CI-only failure was blocking the first signed release
outright. The walk itself still passes; it is the automation on this image that does not. Every
Desktop CI run prints a warning annotation saying so, because a coverage reduction that lives
only in a comment is one nobody remembers a month later.

---

### Releases

*(`desktop-v0.1.3` from 2026-03-14 is the prototype: unsigned, built before C05's pipeline, and not
a release this log covers. `desktop-v0.1.5` and `-v0.1.6` were signed and published by a dispatch
before the field lanes had ever run, so they have no entry. 0.1.7 is the first release with one.)*

#### desktop-v0.1.7 (2026-10-28), against the hub's v20261028-d357f0255e6d

**Lanes:** the FR-14 field lanes (lgr-deploy `vmtest/`, `win11/nsis/user` on zeus, org `lgr-fieldtest` on lgrai.app). They ran against the signed **draft** release's own bytes, before anything was offered to the fleet. Each finding comes from vmtest T-0 on 0.1.6 (#328), or from #332's deploy.

| # | Finding | Baseline (red) | Fixed | Evidence |
|---|---|---|---|---|
| 1 | **The shell never noticed a dead link** (FR-14.21). The presence socket had no read timeout: the loop sat in `read()` until the server spoke, the 30 s heartbeat went out only when a message arrived, and a cut was never seen. | 0.1.6, `base016-code` (2026-10-28): with the guest's link cut, *"the app never noticed the link was gone: no reconnect, and no 'did not answer' or 'socket closed' line, within 360 s of the cut"*. T-0 run 5 saw the same in a four-minute cut, and the dead socket simply resumed. | 0.1.7, `v017-code` and `v017-key`: *"noticed the cut, and authenticated again after it"*. | `presence.rs` `next()`: 5 s reads; the 30 s heartbeat on its own clock; 75 s of silence is dead (`silent`). #340 |
| 2 | **Connected tills read stale or offline once #332 was deployed** (hub). A 0.1.6 shell heartbeats only when its blocking read returns. | lgrai.app, right before the deploy: a connected desktop's `lastSeenAt` went from 51 s to 91 s old with no heartbeat between. | After #339, the same 0.1.6 desktop, sampled every 10 s for 2 min: at most 35 s. With a cut, the hub shows `online@0s stale@66–71s offline@81–86s` (*"offline 81 s after the cut"*). Before #332 it read online for four minutes. | #339: the hub's `desktop:tick` every 15 s wakes the read. #332: `online` needs a heartbeat. |
| 3 | **The start path was learned only at enrollment** (FR-14.12). | 0.1.6, `base016-code2`: the hub assigned `/pos/` after enrollment, and `open-lgr` *"opened https://lgrai.app/, and the shell never learned the start path the hub assigned after its enrollment (/pos/)"*. Every T-0 run had `open-lgr` NA (never assigned). | 0.1.7, `v017-code` and `v017-key`: the hub assigned `/pos/` after enrollment; after the reconnect, `open-lgr` *"opened https://lgrai.app/pos/"*. | `PUT /self` answers with the assignment; the shell refreshes it after every reconnect. #340 |
| 4 | **No ephemeral enrollment key** (FR-14.19). The shell sent only `code`, normalised (uppercase, O→0, `-`/`_` dropped). | 0.1.6, `base016-key`: *"onboarding did not reach step 4"* with a one-use key. | 0.1.7, `v017-key`: `register` PASS with `ephemeral=True`. **`ephemeral-cleanup` PASS:** *"the row went with the guest"* on a clean guest shutdown (Windows ending the session → `RunEvent::Exit` → `DELETE /self`). | `enroll::is_enrollment_key`; `should_unregister`. #340 |

**Also on 0.1.7:**
- `install`, `signature` (G ROX LTD, timestamped), `local-storage`, `no-ipc`, `print`, `unreachable` and `revoke`: PASS.
- `ubuntu/deb/user`: install and the `.asc` PASS; the rest NA (WebKitGTK has no CDP), as on 0.1.6.
- `desktop-walk` **failed in the first two 0.1.7 runs** (*"settings is pixel-identical to overview"*, then *"onboarding … to settings"*), with every 0.1.6 run passing. The cause was the **harness**: the walk captured the whole screen, where the Start menu and `lgr-web` sat in front (the screen captures of two views were byte-identical). 0.1.7 learned the assigned start path, so `lgr-web` showed a static `/pos/`; 0.1.6 still showed `/`, whose frames happened to differ. Captured from the shell's own window (`PrintWindow`, `v017-walk`), all five views are distinct, and its Settings view shows *"Start page /pos/ · Set by your administrator"*. The harness fix is lgr-deploy `feat/vmtest-328`.
- `win11/msi/admin`: install, signature and local storage PASS. Every window-driven cell fails with no CDP endpoint, **on 0.1.6 too** (`base016-msi`): the harness's elevated path, not the build (#341).

Published 2026-10-28 11:31 UTC from the draft the lanes ran against. The rebuild its tag triggered was cancelled, so the published assets are the tested bytes. Offered to the fleet by lgr-deploy `ec4ed81` (`DESKTOP_RELEASE_VERSION` 0.1.7).

