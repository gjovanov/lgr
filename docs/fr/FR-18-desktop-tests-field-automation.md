# FR-18 — LGR Desktop quality gates: integration, e2e, simulation and automated field testing

**Goal:** every requirement in FR-14 to FR-17 is proven. It is proven by more than CI going green:
the proof runs **on the machines and networks the desktop will actually meet**. There are four
layers:

1. **Integration suites** in `packages/tests`: Bun, `MongoMemoryReplSet`, in-memory SQLite.
2. A **multi-desktop simulation harness** that injects faults and checks convergence
   invariants after quiescence.
3. **Playwright e2e**: the portal Sync page; the local-mode UI against a real sidecar; the Tauri
   app itself.
4. **Automated field testing** on throwaway VMs and on the real fleet. This is roomler's FR-61
   *vmtest* pattern, on the same hosts and golden images, with LGR's own lanes, checks and
   release gate.

Status: draft for implementation · Date: 2026-09-28 · Tracking: [gjovanov/lgr#61](https://github.com/gjovanov/lgr/issues/61) (epic [#56](https://github.com/gjovanov/lgr/issues/56)) · Depends on: FR-14–FR-17 (it tests them) ·
Feeds: the release gate for every `desktop-v*` tag, and the hub deploys that touch sync.

Driving input: *"With integration/e2e tests and automated field testing"* (goran, 2026-09-28;
full request in [FR-16](FR-16-local-mode-sync-engine.md)).

---

## 1. Current state (verified 2026-09-28)

### 1.1 LGR

- **No CI runs a test.** The repository has exactly one workflow, `desktop-release.yml`, which
  has failed since 2026-07-20 (FR-14 §1.2 #1). `bun run test`, `bun run build` and
  `bun run test:e2e` are run by hand.
- **Suite size and a Windows trap.** Since the 2026-09-15 `.rejects` sweep the suite completes on
  Windows: 1,505 tests in 126 files, about 5 minutes (CLAUDE.md). ⚠ A single `.rejects` or
  `.resolves` reintroduced anywhere blocks the whole Windows run again.
- **No desktop or sync test exists.** DAL parity is 70 CRUD cases over 9 of 48 repositories
  (FR-16 §1.1). `packages/sync` has no tests.
- **The e2e suite.** Playwright, with `workers: CI ? 1 : 4` and projects `portal`, `security`
  (tenant isolation), `accounting`, `invoicing-inventory`, …
  - Its known gotchas are in CLAUDE.md: Node is required for workers; `v-select`/combobox;
    `v-switch` is a checkbox; `toHaveValue` rather than `toHaveText` on inputs; ad-hoc driver
    scripts run under Node, not Bun.
- **Helpers to build on:**
  - `packages/tests/src/setup.ts` already starts `MongoMemoryReplSet` (count 1), so change
    streams work in the suite today.
  - `tests/helpers/eltrade-simulator.ts` is built from Eltrade protocol v1.1.1.
  - `e2e/scripts/ocr-stub.ts` is a `Bun.serve` stand-in, the pattern for a stub hub.
  - `helpers/capture-rejection.ts`.

### 1.2 roomler's vmtest (FR-61), the model

Sources: `roomler-ai` → `docs/fr/FR-61-vmtest-matrix.md` and `.claude/skills/vmtest/SKILL.md`;
the orchestrator is `roomler-ai-deploy/vmtest/vmtest.sh`.

- **Host capability.** `k8s-cluster-multi` playbook 15 + `roles/vmtest-host` (opt-in, outside
  `site.yml`) provisions zeus and mars with qemu/OVMF/swtpm, a `vmtest-net` NAT (virbr2), an
  image cache, and `/usr/local/bin/vmtest-audit`.
- **Golden images:**
  - Win11 x86_64: KVM, autounattend, autologon + OpenSSH;
  - Ubuntu 24.04 GNOME Wayland: cloud-init, GDM autologin;
  - ARM64 under TCG;
  - macOS arm64: `tart` VMs on the operator's MacBook, reached from mars over roomler's own mesh.
- **Per cell:** COW-clone the golden image → boot → install (method × type) → enroll with an
  **ephemeral key** into a dedicated test org → checks → graceful shutdown (self-unenroll) →
  destroy. At the end of the run, assert the org is back at its baseline, with the reaper as
  backstop.
- **Desktop walk:**
  - Windows sets `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333` and then
    `connectOverCDP`, asserting the DOM of every view and taking screenshots.
  - Linux runs `--view=<v>` + `virsh screendump` per view; the dumps must be over 20 KB and
    pairwise distinct.
- **Reporting:**
  - guests emit `VMTEST-RESULT <check> PASS|FAIL|NA <detail>`;
  - the orchestrator writes `results.tsv` and a one-line `LATEST`, diffs against
    `expected-failures.txt`, and re-runs unexpected failures in isolation;
  - a confirmed regression becomes a GitHub issue;
  - status on 2026-09-06: 17/17 green.
- **Its traps, which LGR inherits:**
  - **the cloned Win11 guest boots about 3 h ahead of UTC**;
  - DNS, cloud-init and dpkg-lock races right after boot;
  - Playwright version drift between a caret range and the pinned image;
  - never SIGTERM an ephemeral service whose row you still need;
  - check for a parallel run on the same host before starting;
  - jupiter carries production storage.
- **Fleet rule.** After every rollout, the real fleet is checked (`roomler exec <device>`,
  `roomler peers`). Each FR keeps a **field-verification log that shows a failing run before the
  passing one**.

---

## 2. Requirements

### 2.1 Continuous integration

**FR-18.1 — `ci.yml` runs on every pull request and every push to master**, on `ubuntu-latest`:
1. `bun install --frozen-lockfile`;
2. `bun run test` (mongodb-memory-server binaries cached);
3. `bun run build`, which includes `desktop-ui` (FR-14.9);
4. the compiled sidecar for linux-x64 (`bun build --compile`);
5. `cargo clippy -p lgr-desktop` with the webkit dependencies installed.

A `macos-latest` job runs `cargo check` on the shell. **The gate starts green.** Any test that
is red on master when the gate is switched on is fixed first, or quarantined with a linked issue.

**FR-18.2 — `desktop-ci.yml`** runs on changes under `packages/{desktop,desktop-api,desktop-ui,dal,
dal-sqlite,sync,fiscal}` or the `sync_*` services. It builds the unsigned app on Windows, macOS
and Linux and runs the **Tauri smoke** (FR-18.14) on `windows-latest`.

**FR-18.3 — Heavy suites run on the house's own hosts, not paid Actions minutes.** Two runs, both
on mars, in the `LATEST` / `expected-failures` shape:
- **nightly e2e**: Playwright in its pinned container against a fresh stack;
- **nightly simulation**: FR-18.11, with 1,000 seeds.

### 2.2 Integration suites (`packages/tests`)

**FR-18.4 — Tailer** (FR-16.18–16.23), against `MongoMemoryReplSet`:
- every write shape is journaled: `create`, `updateOne`, `bulkWrite`, `updateMany`,
  `insertMany`, `deleteMany` and a raw `collection.updateOne`;
  - each case **fails with the tailer disabled**;
- deletes carry `orgId` through pre-images, and evictions are produced;
- resume after a kill loses no event and double-allocates no `seq`;
- two tailers result in one lease holder;
- seeding while writes continue;
- **history lost**: a replica set started with `--oplogSize 1`, a resume token forced past the
  window → epoch bumped, every desktop `journal_epoch`.

**FR-18.5 — Pull, push and apply** (FR-16.30–16.42).
- **The in-process hub** is `createApiApp()`, the same route table `unified.ts` serves, **plus
  the socket setup functions `unified.ts:102-103` calls and the new `/ws/desktop` socket.**
  `createApiApp()` itself mounts no sockets, so a hub built from it alone could never poke.
- **The in-process desktops** are sidecar modules over in-memory SQLite.

It covers:
- echo suppression and relay, **including the collapsed-history case**: a hub edit followed by
  the desktop's push to the same document must still reach that desktop (FR-16.30). The push
  response's post-apply documents must leave the desktop byte-identical to the hub;
- exactly-once and idempotent replay, **per `instanceEpoch`**: after a simulated restore, new
  changes are applied, not dropped as "already applied";
- **the outbox**: the hub is killed between a push's commit and its projections, and the effects
  still happen exactly once after restart (FR-16.36);
- **restore numbering**: no legal number and no УНП is reused (FR-16.50);
- **scope changes**: backfill on assignment, local eviction on unassignment, and an A→B move kept
  by a desktop that holds both warehouses (FR-16.26–16.27);
- compare-and-set conflicts per policy;
- bisection into dead letters;
- the pull never clobbering an unpushed field;
- projections exactly once;
- **the online/offline equivalence property for every Phase 2 flow** (FR-16.38);
- the band-aware allocator, **written to fail against today's `currentMaxSuffix()` first**
  (FR-16.45);
- the `hubOnly` scan of every pull payload (FR-16.29);
- the 426 version gate;
- reconcile for `restored`, `hub_regressed`, `beyond_retention` and `journal_epoch`;
- the clone opening read-only.

**FR-18.6 — Registry and auth** (FR-15):
- enrollment codes: single use, expiry, rate limit;
- ephemeral keys and the reaper;
- assertion and token: replay refused, skew corrected through `serverTime`, `keyEpoch` rotation;
- the row as revocation list;
- desktop and user tokens refused on each other's routes;
- **the public-routes table test lists exactly the four anonymous desktop HTTP routes, the
  `/ws/desktop` upgrade, and `/api/auth/desktop-code/redeem`**;
- an unauthenticated `/ws/desktop` socket receives nothing, and is closed after 10 s;
- pause, revoke and wipe semantics;
- audit entries;
- every cross-org case of FR-15.22 and FR-16.62.

**FR-18.7 — Local data plane** (FR-16.1–16.5):
- the document repository's filter translation for every operator, including dotted paths,
  array matching and Cyrillic `$regex` (the `bg` lowercase rule);
- `create()` honouring ids and timestamps;
- the `*Lower` mirrors maintained on write, so the product search finds a locally created
  Cyrillic product;
- **a codec round-trip property test per synced collection**, including subdocument `_id`s and
  the `Mixed` paths carried as Extended JSON (FR-16.4);
- **the write mutex** (FR-16.3): two concurrent requests, one of which rolls back, leave the
  other's acknowledged write intact;
- trigger capture;
- `_sync_ctx` suppression, including a **crash mid-apply** that must leave `applying = 0` and
  the watermark unmoved;
- migrations from every prior local schema version.

**FR-18.8 — Parity and import-graph gates, generated per manifest route** (FR-16.9). The test
file is generated from `offline-routes.ts`, so a route added without its parity test and
import-graph test fails the suite by construction.

**FR-18.9 — Fiscal bridge.**
- `/ws/fiscal-bridge` refuses an unauthenticated registration and a cross-org one, and never
  evicts an authenticated bridge silently (FR-14.26).
- The native bridge's protocol runs against the **Eltrade simulator over a pseudo-serial pair**,
  covering: SEQ priming, a replayed SEQ, SYN handling, the open-receipt void, and a second opener
  refused.

**FR-18.10 — Hygiene.**
- No `.rejects` / `.resolves` anywhere; use `captureRejection` / `expectRejection`.
- `SYNC_TAILER_ENABLED=false` and `SYNC_DRY_RUN=false` in `.env.test`, except inside the suites
  that start and stop their own tailer.
- No test contacts `lgrai.app`.
- Every suite that starts a tailer or a sidecar stops it in `afterAll`.

### 2.3 The simulation harness

**FR-18.11 — `packages/tests/src/sync-sim/` is a deterministic multi-desktop simulator.**

Its parts:
- one hub (`MongoMemoryReplSet` + the app);
- K desktops (in-memory SQLite, 2 ≤ K ≤ 5);
- a **fault-injecting transport** that can drop, duplicate, delay, reorder, partition a desktop,
  kill a process mid-transaction, and skew a clock;
- a **seeded random operation generator**: online hub edits, offline POS sales and cash sales,
  master-data edits on both sides, deletes, warehouse re-assignments (scope moves) and bulk
  rewrites.

After quiescence it checks these **invariants**:

| # | Invariant |
|---|---|
| I1 | **Convergence**: every desktop's in-scope documents equal the hub's (digest equality), except rows with an open dead letter |
| I2 | **No lost or duplicated sale**: count and total of POS transactions and cash sales per desktop equal the hub's |
| I3 | **Stock**: hub StockLevels equal a fault-free, online-only replay of the same operation sequence |
| I4 | **Exactly-once projections**: one JE per source document or event |
| I5 | **Numbering**: no duplicate legal number; every band continuous; the hub counter never inside a band |
| I6 | **No loop, no lost edit**: applying pulled or push-response documents never produces a captured change, and no hub edit is ever withheld from a desktop because a later change to the same document was its own |
| I7 | **Tenancy**: no desktop holds a row of another org (the simulator runs two orgs) |
| I8 | **Nothing silent**: every traced write that ended overwritten has a conflict row |

A failing seed is printed with a one-line replay command. CI runs 20 seeds per PR, and mars
runs 1,000 every night (FR-18.3).

### 2.4 End-to-end (Playwright)

**FR-18.12 — Portal specs.**
- `sync.spec.ts` covers every tab of FR-17 over seeded state, each action with its confirmation
  text, and the run-detail join.
- `desktop-enroll.spec.ts` covers the register dialog → a stub desktop exchanges the code → it
  appears online → the dialog closes; plus the approval page.
- The `security` project gains the sync and desktop endpoints for `member`, `manager`, a foreign
  org and anonymous callers (FR-17 §5.1).
- It also gains the **login-fixation case** (FR-14.14): opening `/apps?token=<another account's
  JWT>` on the production port leaves the signed-in account unchanged.

**FR-18.13 — Local-mode specs.** Playwright drives `desktop-ui` served by a **real sidecar** in
local mode, against an in-process test hub:
- an offline POS sale and a cash sale;
- the 503 `server_only` page with its **Open in LGR (server)** action;
- the offline-login rules: a user who has never signed in online is refused; a user deactivated
  on the hub is locked out after the next pull;
- the Sync view with the hub stopped.

The runner itself runs under Node (CLAUDE.md e2e gotcha 4).

**FR-18.14 — The app itself.**
- **Windows:** the harness launches the built app with
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=<p>` and drives it with
  `connectOverCDP`. The flag is **set by the harness, never by the app** (FR-14 trap 10). It
  walks every shell view, asserting real DOM per view. It also asserts:
  - `lgr-web` opens the stub hub at `startPath`;
  - **a real `invoke` from `lgr-web` is rejected** (FR-14.10). The absence of `window.__TAURI__`
    proves nothing, because Tauri 2 injects its IPC bridge into remote pages;
  - an XLSX export saves;
  - `window.open` to an outside origin reaches the system-browser path, via the shell's log line.
- **Linux:** `--view=<v>` + screenshots per view, over 20 KB and pairwise distinct.
- **macOS:** a screenshot walk.
- **Print:** the shell writes a structured log line when a print request reaches the platform
  print path. All three platforms assert it.

**FR-18.15 — `--status-json`.** The app gains a `--status-json` flag that prints registration,
mode, versions, server link, watermarks, waiting counts and bridge state, then exits. It uses
the single-instance channel when an instance is running. This is what harnesses, and
`roomler exec` (FR-18.22), read, instead of scraping screens.

### 2.5 Automated field testing: the LGR vmtest lanes

**FR-18.16 — Reuse, don't rebuild.**
- **Reused:** roomler's host capability (`vmtest-host` on zeus + mars, `vmtest-net`, the image
  cache, `vmtest-audit`) and its golden images. There is **no second VM stack**.
- **LGR's orchestrator** lives in `lgr-deploy/vmtest/lgr-vmtest.sh`, with the same verbs
  (`bake|run|destroy|report|clean`), the same filters (`--lane --method --type --check --host
  --keep`), and the same report shape:
  - `~/lgr-vmtest/<stamp>/results.tsv` and `~/lgr-vmtest/LATEST`;
  - `expected-failures.txt`, isolated re-runs;
  - a GitHub issue in `gjovanov/lgr` for a confirmed regression.
- **The skill** `.claude/skills/lgr-vmtest/` is written **after** the lanes are proven green, as
  roomler's P8 was, so it documents what works rather than what was intended.

**FR-18.17 — Production isolation.**
- **The org:** a dedicated org `lgr-fieldtest` on `https://lgrai.app`, with sync enabled. It is
  seeded by a generator script with a **synthetic** dataset sized like regal-pz:
  - 23,000 products with 10 price tiers and DIN-style tags;
  - 2,000 contacts;
  - stock in two warehouses;
  - 90 days of documents.

  **No real customer data ever goes into a VM.**
- **Keys:** ephemeral enrollment keys only (FR-15.7), plus one permanent **anchor desktop**. The
  anchor is a headless Linux desktop on mars, registered permanently and assigned both
  warehouses. It is "the other desktop" in the relay and conflict checks, the way roomler's
  anchor is the peer every VM pings.
- **Baseline:** every run ends with the org back at its desktop-count baseline, and the reaper
  is the backstop.
- **Kill switch:** turning off `lgr-fieldtest`'s `ephemeralKeysEnabled` revokes every key.

**FR-18.18 — The matrix.** A cell that cannot exist is recorded **NA, with the reason**, never
skipped.

| Lane (host) | Methods | Types | Notes |
|---|---|---|---|
| **Win11 x86_64** (zeus, roomler golden) | NSIS per-user · MSI per-machine | standard user (no admin) · admin | the till class |
| **Win11 corporate** (zeus) | MSI per-machine (as IT deploys it) · NSIS per-user | standard user | AppLocker default rules; explicit proxy + a **TLS-inspecting mitmproxy** whose root CA is pushed to the machine store, as a GPO would |
| **Ubuntu 24.04 GNOME Wayland** (zeus / mars) | `.deb` · `.rpm`-on-Fedora (MAY) · AppImage (MAY) | per-user | |
| **macOS arm64** (tart on the MacBook, opt-in) | `.dmg` | per-user | auto-NA when the Mac is unreachable |
| ARM Linux | — | — | **NA**: no aarch64 build planned |

⚠ **Under AppLocker's default rules, an executable in `%LOCALAPPDATA%` is not allowed to run.**
The per-user NSIS cell in the corporate lane is therefore **expected to be refused by policy**.
It asserts a clear error, not a hang. The per-machine MSI is the supported corporate path. That
is the whole point of having both installers (FR-14.5).

**FR-18.19 — The checks.** A result id is `lane/method/type@host#check`. Checks are added as each
phase ships.

**Phase 1** (FR-14 P1 + FR-15):

| Check | Asserts |
|---|---|
| `install` | the installer succeeds silently for the type |
| `signature` | Authenticode / notarisation / `.asc` verifies **on the guest** |
| `register` | the ephemeral key → the desktop is online in `lgr-fieldtest` |
| `presence` | online → offline within 90 s of a network cut |
| `open-lgr` | `lgr-web` loads `lgrai.app/<startPath>`; a password sign-in with the field-test user lands on the POS |
| `no-ipc` | a real `invoke` issued from `lgr-web` is rejected by the capability set |
| `local-storage` | the profile database, archives and key live in non-roaming storage (`%LOCALAPPDATA%` / Credential Manager `LOCAL_MACHINE`); none of them follows a roaming profile |
| `downloads` | an XLSX export saves |
| `print` | the print-path log line appears |
| `desktop-walk` | every shell view renders (CDP DOM / screendump / screenshots) |
| `update` | install N-1 from the release, update to the build under test; defers with a POS session open; **a tampered artifact is refused**. On per-machine cells run as a standard user: asserts **managed updates** (notified, version reported, no self-install, no elevation attempt; FR-14.5) |
| `revoke` | revoke through the API → the Overview shows it within one heartbeat |
| `ephemeral-cleanup` | a guest `shutdown` removes the row; `virsh destroy` leaves it for the reaper (roomler's `ephem` lane) |
| `oauth-browser` | the Google sign-in hand-off (FR-14.17) — **NA headless**, verified by the operator per release |

**Phase 2** (FR-14 P2):

| Check | Asserts |
|---|---|
| `fiscal-bridge` | the Eltrade simulator behind a virtual serial pair (com0com on Windows, `socat` pty on Linux); a server-mode POS sale reaches it and prints; a second opener is refused |

**Phase 3** (FR-16 local mode):

| Check | Asserts |
|---|---|
| `baseline` | enable local data; first pull of `lgr-fieldtest`; digest equality with the hub; time recorded against the budget |
| `offline-sale` | the guest firewall blocks `lgrai.app`; sell 3 POS items, 1 cash sale, 1 band invoice; unblock → the hub has each **once**, one JE each where accounting is set, StockLevels equal to the online path, the hub counter outside the band |
| `relay` | a change on the VM reaches the anchor within one poke, and never comes back to the VM |
| `conflict` | the anchor and the VM (offline) edit the same contact → a conflict on the Sync page; the VM converges |
| `kill-mid-push` | `kill -9` of the sidecar during a large push; restart → exactly once |
| `power-cut` | `virsh destroy` during a pull apply → boot → WAL recovery; watermark and rows consistent |
| `restore` | restore the `baseline` archive → `restored` → reconcile → identical, with `offline-sale`'s documents present once; **legal issuing and УНП are blocked until the reseed, and no number is reused** |
| `beyond-retention` | `lgr-fieldtest`'s tombstone retention shortened → reconcile |
| `clock-skew` | runs **before** the lane's `w32time` resync, on the golden's +3 h clock: tokens still mint (`serverTime` correction), the skew is flagged, nothing is ordered by the wall clock |
| `proxy-tls` | corporate lane: `open-lgr`, `register` and a full sync through mitmproxy with the GPO root; fails if the sidecar uses Bun's bundled CAs (FR-16.55) |
| `bulk-rewrite` | a whole-catalog rewrite on `lgr-fieldtest` → the VM catches up within budget |
| `update-with-pending` | update N-1 → N with unpushed changes → nothing lost, all pushed once |
| `outdated` | `minDesktopVersion` above the VM → 426 → update → the queued push succeeds |

**FR-18.20 — Result protocol.**
- Guest drivers emit `LGRTEST-RESULT <check> PASS|FAIL|NA <detail>` and
  `LGRTEST-METRIC <name> <value> <unit>`.
- The orchestrator treats a missing result as FAIL, never as PASS.
- The report writes screenshots and the FR-14.12 diagnostics bundle of every failing cell next to
  `results.tsv`. The first thing to open for a failure is its screenshot, as roomler's RD oracle
  trap teaches.

**FR-18.21 — Performance budgets**, as `METRIC` checks that FAIL when exceeded:

| Budget | Limit |
|---|---|
| baseline sync of `lgr-fieldtest` (regal-pz-sized), lane network | < 3 min |
| whole-catalog rewrite (23k products) caught up | < 10 min |
| online push → visible on the hub | p95 < 5 s |
| poke → pull started | < 2 s |
| app start → Overview rendered | < 5 s |
| local POS sale, API round trip | p95 < 300 ms |
| sidecar RSS with `lgr-fieldtest` loaded | < 400 MB |

### 2.6 The real fleet, the release gate, the log

**FR-18.22 — Fleet checks after every desktop release and every hub deploy that touches sync.**
This is the "check the real fleet after every roll" rule from the Roomler side.
- **The script** `lgr-deploy/scripts/desktop-fleet-check.sh` reads the Sync API for every
  desktop of `lgr-fieldtest` and, once live, regal-pz. It reports:
  - version adoption;
  - last seen and last push;
  - waiting counts;
  - the conflicts and dead letters opened since the deploy;
  - reconcile flags.
- **Machines that also run a Roomler agent** are checked with
  `roomler exec <device> 'lgr-desktop --status-json'` (FR-18.15).
- ⚠ `roomler exec` splits argv on spaces, so the command stays a single token plus flags.

**FR-18.23 — The release gate.** A `desktop-v*` tag publishes a **draft** release. Promotion to
the release the updater serves (FR-14.27) requires:
- `ci.yml` and `desktop-ci.yml` green for the tagged commit;
- the simulation harness green for that commit (the nightly run, or an on-demand 1,000-seed run);
- every shipped phase's vmtest cells green, or matched by `expected-failures.txt` with a linked
  issue;
- a field-verification log entry (FR-18.24) for the release.

The gate is a checklist the release PR carries, ticked with links.

**FR-18.24 — A field-verification log in each of FR-14 to FR-17**, using roomler's convention
(`roomler-ai` → `docs/fr/FR-27-…md` "Field-verification log"). For each release and each finding
it records:
- the **baseline run that shows the failure**;
- the fixed run;
- run links and the server image tag.

A check that has never been seen failing is not evidence. FR-16.45's band test and FR-18.4's
disabled-tailer cases exist for exactly that reason.

**FR-18.25 — Safety rails**, inherited from vmtest and not negotiable:
- **jupiter** (production storage) is refused without an announced window (`LGR_VMTEST_ALLOW_JUPITER=1`).
- **One guest per host at a time.** `vmtest-audit` runs before each cell.
- **Parallel runs:** check `tmux ls` and `virsh list` on the host for a roomler *or* LGR run,
  because the two orchestrators share hosts. Identify your own run directory by set difference,
  never by `ls -t | head -1`.
- **Production data:** only `lgr-fieldtest`. No regal-pz data leaves the cluster.
- **Ephemeral services:** stop the auto-started service, register, then start once. Never
  `restart` an ephemeral desktop whose row the cell still needs.

---

## 3. Edge cases and traps

1. **A single `.rejects` blocks the whole Windows suite** (CLAUDE.md). The new suites are
   written with the capture helpers from the first line.
2. **Change streams need a replica set.** `setup.ts` already provides one. A new suite that
   builds its own standalone `MongoMemoryServer` silently loses every change event.
3. **`--oplogSize 1` is how history loss is tested.** Waiting for a real oplog to roll is not a
   test.
4. **The Win11 golden's +3 h clock is a feature for `clock-skew`, and a hazard for every other
   check.** It makes a 10-minute enrollment code look expired. That is why the order is:
   `clock-skew` first, then resync, then everything else.
5. **Playwright drift.** A caret range installs a newer runner than the pinned image carries,
   and every cell dies the same way. Pin the runner to the image tag. If every cell fails
   identically, suspect tooling first.
6. **Boot races:** SSH comes up before DNS, cloud-init or dpkg are ready. Wait on each, and name
   which precondition failed.
7. **AppLocker refuses per-user installs** (FR-18.18). In the corporate lane that is the
   expected result, not a bug to "fix" by weakening the lane.
8. **An oracle that cannot fail proves nothing.** roomler's `ephem` lane originally reported a
   missed reap as WARN, which `finish_run` never counted as FAIL. Every LGR check has an explicit
   failing state, and an absent result counts as FAIL.
9. **The anchor must stay permanent and assigned.** An anchor that is unassigned or ephemeral
   turns `relay` and `conflict` into vacuous passes.
10. **Synthetic data must look like regal-pz where it matters:** 10 price tiers, Cyrillic names,
    DIN tags, 2 KB product documents. Otherwise `baseline` and `bulk-rewrite` measure a smaller
    problem than production has.

---

## 4. Phases

| Phase | Ships with | Adds |
|---|---|---|
| T1 | FR-14 P1 + FR-15 | `ci.yml`, `desktop-ci.yml`, FR-18.6/.9 (bridge auth), FR-18.12, FR-18.14–.15, vmtest Win11 + Ubuntu lanes with the Phase 1 checks, the anchor, `lgr-fieldtest` |
| T2 | FR-14 P2 | the `fiscal-bridge` check, the corporate lane |
| T3 | FR-16 P1–P2 | FR-18.4/.5/.7/.8, the simulation harness, FR-18.13, the Phase 3 checks, budgets |
| T4 | FR-16 P3–P4 + FR-17 | macOS lane, the release gate enforced, fleet checks, the `lgr-vmtest` skill |

---

## 5. Acceptance criteria

1. `ci.yml` runs on every PR and push. It is green on master when enabled and fails on a
   deliberately broken test, build or `desktop-ui` import.
2. Every FR-16 acceptance criterion has at least one test here that **was seen failing** against
   the pre-change code. The FR-16.45 band case and the FR-18.4 disabled-tailer cases are logged
   in the field-verification log.
3. The simulation harness finds a planted bug. Removing the `invoice.posted` idempotency guard
   (FR-16.37) breaks I4 within 20 seeds, and a failing seed replays deterministically.
4. `lgr-vmtest.sh run --lane win11` runs every Phase 1 cell from the dev box through mars, with
   no manual step on the VM, and leaves `lgr-fieldtest` at its baseline.
5. The corporate lane passes `open-lgr`, `register` and (from T3) `proxy-tls` through the
   TLS-inspecting proxy. It records the per-user NSIS cell as refused-by-policy with a clear
   error.
6. `offline-sale`, `kill-mid-push`, `power-cut` and `restore` pass on Win11 and Ubuntu, with each
   sale present on the hub exactly once.
7. Every performance budget is measured and within limits on the Win11 lane.
8. A confirmed unexpected failure files a `gjovanov/lgr` issue carrying the cell id, logs,
   screenshot and diagnostics bundle.
9. A `desktop-v*` release cannot become the updater's release without the FR-18.23 checklist
   complete.
10. The fleet check lists version adoption and sync health for every `lgr-fieldtest` desktop
    after a release. On a machine with a Roomler agent, `roomler exec … --status-json` returns
    the same facts.
