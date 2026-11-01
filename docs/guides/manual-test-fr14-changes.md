# Manual test runbook — the FR-14 desktop changes

Everything shipped or staged for FR-14 (issue #57), and how to check each part **by hand**.

Grouped by **what you need**, not by chunk, so you can work through whatever machine you are
sitting at and stop when you run out of hardware.

| Part | You need | Time |
|---|---|---|
| [A. Dev box only](#a-dev-box-only) | this repo + Bun | ~20 min |
| [B. The desktop app](#b-the-desktop-app) | a Windows machine + Rust | ~30 min |
| [C. The lane tooling](#c-the-lane-tooling) | `lgr-deploy` checked out | ~10 min |
| [D. Needs a token](#d-needs-a-token) | an admin token for an org | ~5 min |
| [E. Needs hardware or hosts](#e-needs-hardware-or-hosts) | a fiscal device, vmtest hosts, a Mac | — |
| [F. Needs a release](#f-needs-a-release) | a signed tag | — |

> ## ⚠ Read this before section B
>
> `packages/e2e/tests/desktop-app.spec.ts` calls `resetAppState()`, which **deletes
> `%LOCALAPPDATA%\com.lgr.desktop` outright** — settings, logs and the **identity directory with
> the desktop's private key**.
>
> If the machine you run it on has a desktop **registered against a real org**, that registration
> is destroyed and the row on the Desktops page becomes an orphan you have to revoke by hand. The
> machine can re-enrol with a new code, but the old key is gone.
>
> Run section B on a machine with no real registration, or back up
> `%LOCALAPPDATA%\com.lgr.desktop\identity` first.

---

## A. Dev box only

### A1. The full test suite

```bash
bun run test
```

**Expect:** ~1860 pass / 7 skip / **0 fail**, about 10 minutes.

⚠ If it hangs rather than fails, look for a `.rejects` or `.resolves` matcher somebody
reintroduced — one is enough to reap the shared mongod and cascade every later file into
`ECONNREFUSED`. Use `helpers/capture-rejection.ts` instead.

### A2. The in-memory MongoDB no longer leaks ~300 MB a run

This is the fix in `packages/tests/src/dal/helpers/dal-test-setup.ts`.

```bash
# Count what is there now (Windows PowerShell)
(Get-ChildItem $env:TEMP -Directory -Filter "mongo-mem-*").Count

bun test packages/tests/src/dal/repos/

# Count again
(Get-ChildItem $env:TEMP -Directory -Filter "mongo-mem-*").Count
```

**Expect:** 70 pass / 0 fail, and **the same count before and after**. Before the fix it grew by
one directory of ~302 MB per run.

⚠ The number does not go *down* — the run cleans up after itself, it does not sweep history.

### A3. The sweeper

```bash
bun scripts/clean-mongo-mem.ts                      # dry run: lists what it would delete
bun scripts/clean-mongo-mem.ts --execute            # delete
bun scripts/clean-mongo-mem.ts --execute --older-than 1   # keep today's
```

**Expect:** a per-directory size and date, then `N removed (X MB), M skipped`.

**To prove the safety rail**, start a test run and, while it is going, run the dry run in another
terminal. The live run's directory must be reported `SKIP … mongod pid NNN is still running` —
deleting a live server's data directory would turn a disk leak into a corrupted test run.

### A4. The workflow PowerShell guard

```bash
bun test packages/tests/src/unit/workflow-powershell-ascii.test.ts
```

**Expect:** 3 pass.

**To see it work**, break it on purpose: put an em dash (`—`) inside the double-quoted string in
`desktop-ci.yml`'s "Collect the app log" step, re-run, and watch it fail naming the file, line and
character. Then undo. ⚠ A guard nobody has seen fail is a guard nobody should trust — that is why
this step is here and not just the green run.

Why it exists: an em dash is three UTF-8 bytes that decode as `â`, `€`, `”` when the runner reads
the temp `.ps1` as ANSI, and `”` **closes** a PowerShell string. The step died with
`Unexpected token 'it'`, pointing at a word nowhere near the cause.

### A5. The TypeScript types fix

```bash
bunx tsc --noEmit -p packages/e2e            # the Node half: tests/, playwright.config.ts
bunx tsc --noEmit -p packages/e2e/scripts    # the Bun half: the two stub servers
```

**Expect:** no output from either (0 errors).

Two programs because the package holds two runtimes: Playwright's workers are **Node**, the stub
servers are **Bun**, and one `types` setting cannot describe both.

### A6. All nine UIs still build

```bash
bun run build
```

**Expect:** nine `✓ built in …` lines, no errors.

---

## B. The desktop app

### B0. Build it

```bash
# ⚠ Keep the Rust target directory OUT of OneDrive. OneDrive sync locks build
# artifacts mid-write and the build fails in ways that look like compiler bugs.
$env:CARGO_TARGET_DIR = "C:\Users\<you>\cargo-target\lgr-desktop"

bun run build:desktop-ui      # ⚠ FIRST: generate_context!() resolves frontendDist at COMPILE time
cd packages/desktop/src-tauri
cargo build                   # debug is fine for everything below
cargo test                    # expect 132 passed
cargo clippy --all-targets -- -D warnings    # expect clean
```

### B1. The four bugs that shipped — see each one for yourself

Run the app: `& $env:CARGO_TARGET_DIR\debug\lgr-desktop.exe`

| # | What was broken | What you should now see |
|---|---|---|
| 1 | **All five views rendered empty.** `script-src 'self'` forbids `new Function`, which is how vue-i18n compiles every message, so every `$t()` threw and only the drawer and version number appeared. | The Overview renders: registration chip, server, version, **Open LGR**, the Updates card. Click each of the five nav items — every one shows its own content. |
| 2 | **Open LGR deadlocked the whole app.** A sync Tauri command runs on the main thread and building a window needs the event loop. | Press **Open LGR**. A second window opens. ⚠ Then go back to the first window and click around — before the fix the entire app was frozen from this point on. |
| 3 | **The unreachable page went to your system browser.** On Windows the bundle is served on `tauri.localhost`, which the shell mistook for a foreign origin. | See B3. |
| 4 | **`--status-json` claimed `not_registered` on a registered machine.** | See B2. |

### B2. `--status-json` tells the truth

```bash
& $env:CARGO_TARGET_DIR\debug\lgr-desktop.exe --status-json
```

**Expect** one line of JSON carrying `schemaVersion`, `bridge.supported: true`, `bridge.fiscal: []`,
and a `logPath` under `AppData\Local` (**never `Roaming`** — on a domain with roaming profiles that
would give every PC the same identity).

After enrolling (B3), run it again: `registration.state` must become `registered` with the real
`desktopId`, `keyStorage: keystore` and the assignment's `startPath`. Before the fix it said
`not_registered` and `keyStorage: none` no matter what was on disk.

⚠ It must contain nothing credential-shaped — it lands in CI logs and pasted issues.

### B3. The hermetic end-to-end walk (the quickest way to exercise everything)

This drives the real binary against a fake hub on loopback, so it touches no real org.

```bash
# Terminal 1 — the stub hub
bun packages/e2e/scripts/desktop-hub-stub.ts
# -> hub http://127.0.0.1:4099  control http://127.0.0.1:4100  startPath=/pos/

# Terminal 2 — the walk
cd packages/e2e
$env:LGR_DESKTOP_BIN = "C:\Users\<you>\cargo-target\lgr-desktop\debug\lgr-desktop.exe"
$env:CI = "1"
bunx playwright test tests/desktop-app.spec.ts --project=desktop-app --workers=1 --reporter=line
```

**Expect:** **13 passed, 1 skipped** in ~10–30 s. (The skip is the print/downloads case — see B5.)

⚠ The spec starts its own stub hub, so terminal 1 is only for poking at it by hand. If you leave an
old stub running you get `the stub hub did not come up` naming the port — kill whatever holds 4099
and 4100.

**Poke the stub by hand** while the app is enrolled:

```bash
curl http://127.0.0.1:4100/__stub/state        # what the hub has seen
curl -X POST http://127.0.0.1:4100/__stub/offline   # stop listening -> unreachable page
curl -X POST http://127.0.0.1:4100/__stub/online    # the shell returns to startPath by itself
curl -X POST http://127.0.0.1:4100/__stub/revoke    # push a revocation down the socket
```

⚠ `offline` really stops listening rather than returning a 503: `presence::probe` treats **any**
HTTP answer as reachable, so a status code cannot fake a dead server.

### B4. The unreachable page, by hand (bug 3)

With the app registered against the stub:

1. `curl -X POST http://127.0.0.1:4100/__stub/offline`
2. Quit the app, start it again (or press **Open LGR**).
3. **Expect:** the bundled page **inside the app window**, with Retry and Diagnostics buttons.
   ⚠ Before the fix your *system browser* opened with a URL that means nothing outside a webview,
   and the app window stayed blank.
4. `curl -X POST http://127.0.0.1:4100/__stub/online`
5. **Expect:** within a minute, with nobody touching anything, the window navigates to
   `http://127.0.0.1:4099/pos/`, which redirects to `/invoicing/cash-sales/new`, as the real
   server does.

Check the log at `%LOCALAPPDATA%\com.lgr.desktop\logs\lgr-desktop.log` for
`lgr-web: server-unreachable` followed by `lgr-web: server-returned`.

### B5. Print and downloads (the two the harness cannot drive)

Both end in a **modal OS dialog** that blocks the app, which no CDP call can dismiss — so they are
skipped by default and are yours to check by hand:

```bash
$env:LGR_DESKTOP_ALLOW_MODAL = "1"
bunx playwright test tests/desktop-app.spec.ts --project=desktop-app --workers=1
```

Or simply: with `lgr-web` open, trigger an XLSX export in the cloud app and confirm a **Save as**
dialog appears, then check the log for `lgr-web: download-accepted url=`.

### B6. The capability boundary (AC 6) — the most important single assertion

The stub hub's fake SPA issues a **real `invoke`** from the remote origin and writes the outcome
into the page. With `lgr-web` open on the stub, the line
*"IPC from this remote origin: **REJECTED: …**"* must be visible.

⚠ A missing `window.__TAURI__` proves **nothing** — Tauri 2 injects `__TAURI_INTERNALS__` into
remote pages regardless. The capability list is the real boundary, so only a refused `invoke` tests
it. If that line ever says `ACCEPTED`, the cloud app can call into the shell and that is a
critical finding.

---

## C. The lane tooling

Everything here runs on your machine with no hosts, because `VMTEST_HOST_CMD` is unset and every
host call prints instead of running.

```bash
cd ../lgr-deploy          # or wherever lgr-deploy is checked out

# 1. The result protocol, the budgets and the auto-NA — 24 assertions
./vmtest/lib/test-results.sh
# -> "test-results: all checks passed"

# 2. The whole cell matrix with every NA reason
./vmtest/lgr-vmtest.sh cells | less
./vmtest/lgr-vmtest.sh cells --lane win11-corp
./vmtest/lgr-vmtest.sh cells --lane macos
# -> 144 cells across win11 (72), ubuntu (18), win11-corp (36), macos (18)

# 3. A dry run writes NOTHING
./vmtest/lgr-vmtest.sh run --lane win11-corp
ls vmtest/out        # must not exist
```

**Expect** from the dry run: a loud `DRY RUN — VMTEST_HOST_CMD is unset`, the list of cells that
*would* run, and **no `results.tsv`**. ⚠ That refusal is deliberate: a green report nobody could
have earned is worse than no report.

**Things worth reading rather than running:**

- `./vmtest/lgr-vmtest.sh cells --lane win11-corp` — the `nsis/user` row runs only `install` and
  NAs the other fifteen. That cell is an **expected failure**: AppLocker refusing a per-user
  installer is correct, and what is asserted is that the refusal is *legible*. See
  `vmtest/expected-failures.txt`.
- `./vmtest/lgr-vmtest.sh cells --lane macos` — `no-ipc` is **NA**, because WKWebView exposes no
  CDP endpoint. **AC 6 is proven on Windows only.**
- `vmtest/budgets.tsv` — all three budgets are `advisory`, so a breach annotates but does not
  fail. Flip a row to `enforce` once a few real runs exist.

### C1. Prove the budget mechanism without a lane

```bash
cd ../lgr-deploy
. vmtest/lib/budgets.sh
budget_verdict app_start_to_overview_seconds 9      # ADVISORY-BREACH … over the 5s budget
budget_advisory_count                               # 3
```

### C2. The shell linter

```bash
./scripts/lint-shell.sh      # needs shellcheck installed
```

---

## D. Needs a token

### D1. The fleet check

```bash
export LGR_API_TOKEN='<an admin token for the org>'
./scripts/desktop-fleet-check.sh --org lgr-fieldtest
./scripts/desktop-fleet-check.sh --org lgr-fieldtest --expect 0.2.0
```

**Expect:** a table of name / version / presence / last seen / assignment, then version adoption
percentages and, with `--expect`, `N/M on 0.2.0`.

⚠ **Read-only** — it never revokes, renames or asks a desktop to update. Run it as often as you
like.

Without the variable it refuses immediately: the token must come from the environment, never an
argument, because an argument lands in shell history and in every process listing.

`--probe` additionally asks each machine through `roomler exec` what it says about itself — the
only way to catch a till whose presence socket is up while the app is wedged.

### D2. The desktop registration API (C18's hub side)

```bash
bun test packages/tests/src/integration/desktop-fiscal-bridge.flow.test.ts   # 19 pass
bun test packages/tests/src/integration/fiscal-bridge-auth.flow.test.ts      # 21 pass
```

⚠ Run them **one file at a time**. Two files that each call `setupTestDB()` in one `bun test`
invocation fight over the shared mongod; the suite handles it, two files by hand do not.

Then by hand on a dev server: create a fiscal device with `connectionType: 'desktop'` and press
**Connect** on it in the admin UI. **Expect a 422** saying the device is opened by its LGR Desktop,
not by the server. ⚠ Before the fix the server tried, failed, and marked the device `status:
'error'` — which makes the server **503 every sale** until a bridge takes it. An idle click took
the till out of service.

---

## E. Needs hardware or hosts

**None of this has ever been run.** Recorded so nobody assumes otherwise.

### E1. The native fiscal bridge against real hardware (AC 13)

Needs the Eltrade A3 (non-fiscalised) on a Windows machine:

1. On the Desktops page, assign the device to the desktop and set `connectionType: 'desktop'` with
   `connectionParams.port`.
2. Restart the shell (or enrol it — both now start the bridge; a till that enrolled while running
   used to start nothing until a restart).
3. `--status-json` → `bridge.fiscal[0].state` must be `idle`.
4. Make a POS sale in the cloud app. **Expect a non-fiscal text receipt to print.**
5. Open a POS tab in Chrome and try to connect the same device. **Expect a refusal**, with the
   till's bridge intact.

⚠ **Fiscal receipts remain unproven on hardware.** The A3 in the field is non-fiscalised, so step 4
prints text. Do not let release notes claim otherwise.

### E2. The vmtest lanes

Need the vmtest hosts (`zeus`/`mars`), roomler's golden images, and `lib/host.sh` reconciled with
roomler's orchestrator — see `lgr-deploy/vmtest/README.md`. The corporate lane additionally needs
AppLocker, mitmproxy and com0com baked into the golden; the macOS lane needs the MacBook reachable.

### E3. The simulator over a virtual serial pair

com0com on Windows or a `socat` pty on Linux, with
`packages/tests/helpers/eltrade-simulator.ts` on the far end. ⚠ A green virtual-pair run is **not**
a substitute for E1: the simulator was built from the protocol PDF, so it agrees with the document,
which is not the same as agreeing with the hardware.

---

## F. Needs a release

### F1. A tag now publishes a DRAFT

```bash
gh workflow run desktop-release.yml --repo gjovanov/lgr -f version=0.2.0 -f draft=true
# or: git tag desktop-v0.2.0 && git push origin desktop-v0.2.0
gh release list --repo gjovanov/lgr        # expect the new release to be a Draft
```

⚠ This used to publish the release the updater serves the moment the build went green. CI green is
evidence that it compiles, not that it works.

### F2. The promotion gate re-checks, rather than trusting

```bash
# Attach the lane evidence to the draft first
gh release upload desktop-v0.2.0 lane-results.tsv lane-expected-failures.txt

gh workflow run desktop-promote.yml --repo gjovanov/lgr -f tag=desktop-v0.2.0
```

It re-checks three things and refuses on any of them:

1. `ci.yml` / `desktop-ci.yml` green **for the tagged commit**;
2. every lane cell green, or an expected failure **with a linked issue**;
3. a field-verification log entry naming the version, read **at the tagged commit**.

**To watch it refuse** (worth doing once — a gate never seen refusing is not a gate): run it for a
version with no entry in the field-verification log. Expect
`the field-verification log has no entry naming X`.

You can rehearse condition 3 locally without a release:

```bash
cd /path/to/lgr
awk 'tolower($0) ~ /^#+.*field.?verification/ {i=1;next} i && /^#{1,2} / {i=0} i' \
  docs/fr/FR-14-lgr-desktop-app-server-mode.md | grep -c 0.1.3
# non-zero -> the gate would allow 0.1.3; 0 -> it would block
```

---

## Known red, and why

**`desktop-ci`'s `windows smoke (CDP)` fails on master.** The app starts and renders (`ui ready` is
in the log) but never opens the debugging port on the `windows-2025-vs2026` runner. Ruled out **by
experiment, not by reasoning**:

- the **build** — the exact CI artifact passes all 13 cases locally;
- **`additionalBrowserArgs`** — there is no such key, and only one config file;
- the **WebView2 version** — runner Edge `153.0.4234.48` vs local `154.0.4258.53`.

A `portDiagnostics()` helper prints the browser args, the runtime version and any listener on the
port, so the next CI failure names the cause instead of inviting a fourth guess.

**It is not reproducible locally**, which is the whole difficulty: the same binary, driven the same
way, works here.

---

## What this runbook cannot cover

- **AC 6 on macOS and Linux.** The rejected-`invoke` assertion exists only on Windows; WKWebView
  has no CDP endpoint and the Linux path has never been run.
- **The updater refusing a tampered artifact.** The minisign keypair does not exist yet, so there
  is nothing behind that assertion.
- **`DESKTOP_TOKEN_SECRET` in production.** Still to go into the sealed `lgr-secret`.
- **The three performance budgets.** Advisory until a few real lane runs establish a distribution —
  a budget set from one sample is a flaky test with a number on it.
