---
name: run-desktop
description: Build and run LGR Desktop (the Tauri shell) locally, point it at the hermetic stub hub, a local dev server or production, drive it over CDP, and read what it says about itself. Use when the user wants to run/launch/install the desktop app, enrol a desktop, reproduce something in the shell, run the desktop smoke walk, or diagnose a shell that will not start, shows the unreachable page, or hangs.
allowed-tools: Bash, PowerShell, Read, Edit, Write, Glob, Grep
---

# Run LGR Desktop locally

The desktop is a **server-mode client**: it opens the cloud app in an `lgr-web` window and holds
no local data (FR-14.34). Nothing works offline by design, so "it shows the unreachable page" is
usually a pointing problem, not a fault.

## ⚠ Before anything: the one destructive action

`packages/e2e/tests/desktop-app.spec.ts` calls `resetAppState()`, which deletes
**`%LOCALAPPDATA%\com.lgr.desktop` entirely — including `identity\`, the desktop's private key.**

If that machine has a desktop registered against a **real org**, the registration is destroyed and
the row on the Desktops page becomes an orphan somebody has to revoke by hand. The machine can
re-enrol with a new code; the old key is gone.

**So: never run the CDP walk on a machine with a real registration you care about.** Back up
`identity\` first, or keep the walk and real enrolments on different machines. Always say which
you are about to do before doing it.

## Build

```powershell
# ⚠ Target dir OUTSIDE OneDrive. Sync locks build artifacts mid-write and the failures look
# like compiler bugs.
$env:CARGO_TARGET_DIR = "C:\Users\<you>\cargo-target\lgr-desktop"

bun run build:desktop-ui          # ⚠ FIRST — `generate_context!()` resolves frontendDist at
                                  #    COMPILE time, so cargo fails if dist/ is absent
cd packages\desktop\src-tauri
cargo build                       # debug is enough for everything here
```

Installers (slower, only when you need one): `bun run tauri:build` → NSIS + MSI under
`target/release/bundle/`. **Unsigned**, so SmartScreen warns — that is expected, not a fault.

Or take CI's: `gh run download <desktop-ci run> --repo gjovanov/lgr -n lgr-desktop-windows`.

## Three things to point it at

### 1. The stub hub — hermetic, nothing real touched

Best default for reproducing anything. A fake hub on loopback, serving the handful of endpoints
the shell calls plus a fake SPA.

```powershell
bun packages/e2e/scripts/desktop-hub-stub.ts
# -> hub http://127.0.0.1:4099   control http://127.0.0.1:4100   startPath=/pos/
```

⚠ It is `LGR_STUB_PORT`, **never `PORT`** — `PORT` is often already set and the stub once came up
on **4001**, the real API's port, printing the port it chose while nothing looked wrong.

Poke it through the control port:

```bash
curl      http://127.0.0.1:4100/__stub/state     # what the hub has seen
curl -X POST http://127.0.0.1:4100/__stub/offline  # stop listening -> unreachable page
curl -X POST http://127.0.0.1:4100/__stub/online   # the shell returns to startPath by itself
curl -X POST http://127.0.0.1:4100/__stub/revoke   # push a revocation down the socket
curl -X POST http://127.0.0.1:4100/__stub/update   # push an update request
```

⚠ `offline` really **stops listening**. A 503 would not do: `presence::probe` treats *any* HTTP
answer as reachable, so a status code cannot fake a dead server.

### 2. A local dev server

```bash
bun run dev        # unified API on 4001
```

Server URL `http://localhost:4001`. ⚠ Loopback stays `http` — the onboarding screen upgrades
`http://` to `https://` for everything *except* loopback, decided by **hostname**, so
`http://localhost.evil.example` is not loopback.

The dev fallback applies to `DESKTOP_TOKEN_SECRET` outside production, so nothing is blocked.

### 3. Production (`https://lgrai.app`)

Works since S-24 sealed a real `DESKTOP_TOKEN_SECRET` and set `NODE_ENV=production`. Confirm the
endpoints are actually deployed before blaming the app — **422, not 404**:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://lgrai.app/api/desktop/v1/enroll \
  -H 'Content-Type: application/json' -d '{}'
```

Get a code from **Settings → Desktops** in the portal. ⚠ Enrolling creates a real `Desktop` row in
a real org — confirm with the user first, and never while their machine holds a registration the
CDP walk is about to delete.

## Driving it

### What it says about itself — prefer this over screenshots

```powershell
& $env:CARGO_TARGET_DIR\debug\lgr-desktop.exe --status-json
```

⚠ **This is the interface, not the screen.** It answers *before* the Tauri builder runs, so it
works on a machine where no window can open. `schemaVersion` exists so a consumer can tell "the
shape changed" from "the field is missing". It carries nothing credential-shaped, deliberately —
it lands in CI logs and pasted issues.

`--view=<overview|settings|onboarding|logs|diagnostics>` routes the window. It is an **allow-list**:
an unknown value produces no view line at all rather than a route.

The log — and the only evidence for things CDP cannot see:

```powershell
Get-Content "$env:LOCALAPPDATA\com.lgr.desktop\logs\lgr-desktop.log" -Tail 40
```

| Line | Means |
|---|---|
| `ui ready (route=…)` | the page rendered and reached IPC |
| `lgr-web: opened url=…` | Open LGR succeeded, at this URL |
| `lgr-web: server-unreachable url=…` | the probe failed; bundled page shown |
| `lgr-web: server-returned url=…` | the retry loop recovered, unattended |
| `lgr-web: external-navigation url=…` | an outside origin went to the system browser |
| `lgr-web: print-requested` | the platform print path was reached |
| `lgr-web: download-accepted\|cancelled url=…` | the Save-as dialog was answered |
| `bridge: …` | the native fiscal bridge (FR-14.26) |

Every line is redacted **when written**, not when bundled.

### Over CDP

```powershell
cd packages\e2e
$env:LGR_DESKTOP_BIN = "C:\Users\<you>\cargo-target\lgr-desktop\debug\lgr-desktop.exe"
$env:CI = "1"
bunx playwright test tests/desktop-app.spec.ts --project=desktop-app --workers=1 --reporter=line
```

**Expect 13 passed, 1 skipped.** The skip is `print`/`downloads`, which end in a modal OS dialog no
CDP call can dismiss — `LGR_DESKTOP_ALLOW_MODAL=1` runs them if you will answer the dialog.

⚠ **The harness opens the debugging port, never the app.** It arrives through
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`; an app that opened one itself would ship a debugging port
to customers.

⚠ `--workers=1`. There is one app and one port — C08's single-instance plugin guarantees exactly
that — so parallel workers fight over both.

To drive the UI outside the spec, use `vmtest/guest/win11/drive.mjs` in `lgr-deploy`
(`enroll`, `open-lgr`, `print`, `check-updates`, `no-ipc`). ⚠ The binary has **no** `--enroll`,
`--print` or `--check-updates` flag — an `--enroll` flag would put a code in shell history and in
every process listing.

## When it goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| **Unreachable page on launch** | `settings.json` points at a server that is not running — commonly the stub hub left behind by a test run, with `openLgrOnLaunch: true` | check `--status-json`'s `serverUrl`; start the stub, or wipe and re-point (below) |
| `registration: revoked`, org `Stub Org` | the spec's last act pushes a revocation; you are looking at the end of a test | wipe and re-enrol |
| `the stub hub did not come up on …` | an orphaned stub holds 4099/4100 | kill the listener on both ports |
| `no CDP endpoint on 9222` | the app is not running, or never opened the port | the error now prints the app's output, the WebView2 version and any listener — read it before guessing |
| `cargo` fails on `frontendDist` | `desktop-ui/dist` missing | `bun run build:desktop-ui` first |
| A second app instance does nothing | single-instance plugin focusing the first | intended (FR-14.5) |
| Views render but are **empty** | regression of the vue-i18n/CSP bug — `new Function` is forbidden by `script-src 'self'` | `__INTLIFY_JIT_COMPILATION__` must stay in `packages/desktop-ui/vite.config.ts` |
| **The whole app freezes after Open LGR** | regression of the main-thread deadlock | `open_lgr`/`print_lgr` must stay `async` + `spawn_blocking`; the tray item must spawn a thread |

Clean slate:

```powershell
Get-Process lgr-desktop -ErrorAction SilentlyContinue | Stop-Process -Force
$p = (Get-NetTCPConnection -LocalPort 4099,4100,9222 -State Listen -EA SilentlyContinue).OwningProcess
$p | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -EA SilentlyContinue }

# ⚠ Deletes the identity directory. See the warning at the top.
Remove-Item "$env:LOCALAPPDATA\com.lgr.desktop" -Recurse -Force
```

## What cannot be done from a dev box

Say so plainly rather than approximating:

- **the vmtest lanes** — need the hosts on zeus/mars and `lgr-deploy/vmtest/lib/host.sh` reconciled
  with roomler's orchestrator;
- **a fiscal receipt through the native bridge** — needs the Eltrade A3, or com0com plus the
  simulator. ⚠ Fiscal receipts are **unproven on hardware**; the field A3 is non-fiscalised and
  prints text;
- **`signature`, and the promotion gate** — need a signed release, and a `desktop-v*` tag now
  publishes a **draft** that `desktop-promote.yml` promotes only after re-checking CI, the lane
  cells and a field-log entry;
- **`no-ipc` on macOS/Linux** — WKWebView exposes no CDP endpoint, so AC 6 is proven on Windows
  only.

## Related

- `docs/guides/manual-test-fr14-changes.md` — the by-hand runbook for every FR-14 change, grouped
  by what you need
- `docs/guides/desktop-install.md` · `docs/guides/desktop-signing.md`
- `docs/architecture/desktop.md` · `docs/fr/FR-14-lgr-desktop-app-server-mode.md`
- `lgr-deploy/vmtest/README.md` — the lanes, and why they have never run
