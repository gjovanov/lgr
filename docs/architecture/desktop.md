# LGR Desktop — architecture

**Status:** a **server-mode client**, built. Local mode was removed on 2026-09-29 (FR-14.34).
What is still open is listed under [Open](#open) and tracked in
[gjovanov/lgr#150](https://github.com/gjovanov/lgr/issues/150).

Specification: [`docs/fr/FR-14-lgr-desktop-app-server-mode.md`](../fr/FR-14-lgr-desktop-app-server-mode.md)
· Tracking: [gjovanov/lgr#57](https://github.com/gjovanov/lgr/issues/57)

## What it is

A Tauri 2 shell, and nothing else. It has **exactly one mode: it opens the LGR cloud app.**

```
┌────────────── LGR Desktop (per OS user) ──────────────────┐
│  Shell (Rust, Tauri 2) — the whole app                    │
│   · tray · single instance · deep links · updater         │
│   · registration + desktop key in non-roaming storage     │
│   · native fiscal bridge: owns serial ports, speaks the   │
│     /ws/fiscal-bridge protocol as the registered desktop  │
│   · windows:  main (Overview, Settings…)  ·  lgr-web      │
│                                                           │
│   lgr-web ── https://lgrai.app/<startPath>                │
│              no IPC, the portal's own sign-in             │
└───────────────────────────────────────────────────────────┘
        no sidecar · no Bun · no SQLite · no local data
```

The shell's own pages (`packages/desktop-ui`) are bundled into the binary, so they work with no
network. Everything else is the cloud app, served by the cloud.

## What it adds over a browser tab

- a **native fiscal bridge** that owns the till's serial port — Web Serial exists only in
  Chrome/Edge, and gives a COM port to one tab at a time;
- **autostart with open-on-launch**, so a till is back on the POS by itself after a power cut;
- **auto-update**, a tray, and a redacted diagnostics bundle;
- **registration**, which makes every desktop a known, revocable machine of its org.

## Packages

| Package | What it is |
|---|---|
| `packages/desktop` | the Tauri 2 shell (Rust), `src-tauri/src/` |
| `packages/desktop-ui` | the shell's five Vue views: Overview · Settings · Onboarding · Logs · Diagnostics. Built by the root `bun run build`. |

Nothing else. The desktop talks to the same unified API as the browser.

## How the parts work

### Opening the app (FR-14.13, FR-14.15–14.17)

The Overview's **Open LGR** opens the `lgr-web` window at the configured server and start path
(`web.rs`). A setting opens the system browser instead (`settings.rs`).

- **No auth handover.** The user signs in inside `lgr-web` with the portal's normal login, and the
  session lives in the webview's profile. No token, cookie or code passes from the shell into the
  page.
- **No IPC.** `lgr-web` appears in no capability (`capabilities/default.json` lists only `main`),
  so an `invoke` from the cloud app is refused.

### Provider sign-in (FR-14.14)

OAuth leaves the webview:
1. The shell opens the provider flow in the system browser, with its desktop id and a PKCE
   challenge (`/api/oauth/:provider?desktop=…`, `oauth.controller.ts`).
2. The browser hands a one-time code back through the `lgr://login` deep link.
3. The shell redeems it in `lgr-web` with the verifier, which it keeps only in memory
   (`web.rs#finish_desktop_oauth`).

An `lgr://login` that this shell did not start is refused, because no verifier is waiting for it.

### Registration (FR-14.18–14.23)

- **Enrolling.** An admin with `admin.settings` issues a one-time enrollment code or a reusable
  enrollment key on `/settings/desktops` (`/api/org/:orgId/desktops/enrollment-codes`,
  `/enrollment-keys`).
- **The desktop's credential.** The shell generates an Ed25519 keypair and enrolls
  (`POST /api/desktop/v1/enroll`, `enroll.rs`, `identity.rs`). It then exchanges a signed client
  assertion for a 15-minute access token (`POST /api/desktop/v1/token`,
  `config.desktop.tokenTtlSec`).
- **Where the key lives** is non-roaming storage (`keystore.rs`):
  - on Windows, DPAPI-sealed under `%LOCALAPPDATA%`;
  - on macOS and Linux, a `0600` file for now, which the Overview flags (FR-14.30).

  Settings never hold a credential, so a copied settings file yields nothing.
- **Presence** is `/ws/desktop`, authenticated by its first message and closed after 10 s
  otherwise (`presence.rs`). The Overview's connection chip reads it.
- **The Desktops page** lists, revokes, rotates and updates desktops (`desktop.controller.ts`).
  Revoking or rotating a key drops that desktop's fiscal bridge from the server side.
- **The version floor.** Below `DESKTOP_MIN_VERSION`, the token exchange answers 426
  `desktop_outdated`. The Overview then shows "update required" and keeps the registration.

### Native fiscal bridge (FR-14.26, FR-14.27)

The shell opens the till's serial port and speaks the `/ws/fiscal-bridge` protocol as the
registered desktop (`bridge.rs`).
- **The hub keeps the logic.** The fiscal drivers and УНП allocation stay on the hub. The shell
  only moves bytes and finds frame boundaries (`framing.rs`), the same way as the browser's Web
  Serial relay.
- **Which devices it bridges.** A fiscal device with `connectionType: 'desktop'` is bridged by a
  registered desktop. `connectionParams.bridgeDesktopId` can pin it to one.
- **Why Rust carries the bytes:** Bun with `serialport` on Windows writes to the port but never
  receives from it.

### Updates (FR-14.28, FR-14.29)

The shell asks the hub for a manifest (`GET /api/desktop/v1/update`). `update.rs` decides whether
the offer is an upgrade and whether now is a safe moment. `install.rs` then installs it, but only
after two checks against anchors compiled into the binary:
1. **minisign**, against `updater.pub`;
2. **the platform's signature:**
   - on Windows, Authenticode with publisher `G ROX LTD`;
   - on macOS, Developer ID team `4TG7586MY5` and notarisation.

**What can self-install:**
- the Windows per-user (NSIS) build;
- macOS, where the user can write the app's folder.

**What can't:** the per-machine MSI never self-installs, and the hub offers no manifest for
Linux.

### Status and diagnostics

- **`--status-json`** (FR-14.5): one machine-readable line, with no credential (`status.rs`).
- **A redacted diagnostics bundle** (FR-14.10, `diagnostics.rs`).

## Open

FR-14's follow-ups, in [#150](https://github.com/gjovanov/lgr/issues/150):
- crash-loop rollback;
- the first real self-update;
- install scopes;
- macOS and Linux parity, including an OS key store in place of the `0600` file;
- fiscal receipts through the desktop.

## What was removed, and why it is not coming back

The 2026-03 prototype was an **offline-first** app: a compiled `desktop-api` Bun sidecar over
SQLite (`dal-sqlite`), plus `packages/sync` for LAN peer-to-peer replication. It was dropped on
2026-09-28 after review, and deleted rather than left to rot, because:

- the sidecar started **without `JWT_SECRET`**, so it signed local tokens with the committed
  `'lgr-dev-secret'`, and first run created **`admin` / `admin123`**, logged it in plain text,
  pre-filled it on the login form and **printed it in the release notes**;
- `packages/sync` was imported by nothing;
- `desktop-ui` mounted ~50 routes importing views out of six other UI packages, and was **not in
  `bun run build`**, so it bit-rotted: a deleted view broke its build unnoticed from 2026-08-22 to
  2026-08-26.

⚠ `packages/dal` and `packages/dal-mongo` **stay**. The DAL interface is still what the
repository tests in `packages/tests/src/dal/repos` exercise; only the SQLite implementation went.

Offline operation came back as a different design, an on-prem server per org rather than a
desktop replica: FR-20 ([#159](https://github.com/gjovanov/lgr/issues/159)), and
[nodes.md](nodes.md) for what exists of it today.
