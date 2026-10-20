# FR-20 — the planning prompt

This is the brief for step 2 of FR-20: turning the functional requirement into a plan for the
architecture, the implementation and the migration of today's LGR. It is written so it can be
pasted as is into a fresh session, or handed to an engineer.

- The requirement it plans: [`FR-20-offline-lan-master.md`](FR-20-offline-lan-master.md).
- The plan it produced: [`FR-20-IMPLEMENTATION-PLAN.md`](FR-20-IMPLEMENTATION-PLAN.md).

---

## The prompt

> You are planning **FR-20: offline operation of LGR**, for the LGR repository
> (`github.com/gjovanov/lgr`).
>
> - **The stack:** a Bun monorepo with Elysia, MongoDB/Mongoose and Vue 3/Vuetify, plus a Tauri 2
>   desktop shell in Rust.
> - **Where to work:** a worktree off `origin/master`, never the shared checkout.
>
> ### The problem, in the owner's words (2026-10-19)
>
> *"regal org and their current software plusminus supports offline (in same LAN work). often
> times they lose internet connection and this is a problem during daily work like cash register
> sales, invoices, POS... hence we need investigate and propose an architecture that support
> offline work."*
>
> The owner proposed:
> - **Three installation types:**
>   - **global**: lgrai.app;
>   - **master**: an org's central server, plus the desktop app;
>   - **local**: workstations for daily work.
> - **Numbers** are always issued by the master.
> - **Sync:** the master syncs with global in real time, or when the connection returns. The
>   global link is optional.
> - **Privacy** is a goal: *"their data doesnt leave their servers"*.
>
> The owner's mind map:
> - one or more client and server apps;
> - mongod vs SQLite;
> - real-time sync that is idempotent, resilient, resumable and scalable;
> - Windows, Linux and macOS, packaged the way roomler-ai does it.
>
> ### The requirement is settled: plan it, do not re-decide it
>
> Read `docs/fr/FR-20-offline-lan-master.md` in full. Its decisions D-1 to D-15 are settled:
> - one home per org, and only the home writes;
> - the master runs the same server over `mongod`;
> - locals are thin;
> - master → global replication is one-way, from a change-stream journal;
> - remote writes are tunnelled to the master. While the master is offline, the mirror is served
>   read-only **on lgrai.app's own origin**, and the master's address shows only a notice;
> - global is the identity provider. Local fallback credentials are **set on lgrai.app**, must
>   differ from the global password, and are accepted on the LAN only;
> - the home allocates every number, with no bands;
> - one server package for three OSes, plus Compose and Kubernetes;
> - three link levels: Full, Control (no business data leaves unless a relay is turned on) and
>   Air-gapped;
> - on the LAN, the desktop uses a loopback proxy;
> - opt-in per org;
> - cloud secrets never leave global;
> - each on-prem org's address is **`<org slug>.lgrai.app`** (the owner's decision of 2026-10-20).
>   Because it is same-site with lgrai.app, lgrai.app uses `__Host-` cookies only and ignores them
>   on same-site requests. An address goes only to a licensed org, approved by a sys-admin, with an
>   unreserved label;
> - field coverage on throwaway instances on mars, zeus and jupiter, extending `lgr-deploy`'s vmtest
>   in FR-61's shape;
> - the supervisor owns every way in and out of a master: the LAN's TLS, the tunnel, the setup
>   console and outbound calls. The API listens on loopback for the supervisor alone.
>
> These are settled with them, and are not to be re-decided either:
> - the home record fails closed: a missing or disagreeing record puts the org on hold, never on
>   global;
> - a restored, reverted or cloned master locks its legal series until outside evidence clears
>   them;
> - promoting the mirror needs evidence, and leaves global's series frozen until the site's last
>   numbers are recorded.
>
> If you find evidence that a decision is wrong, say so in a separate section and give the
> evidence. Do not quietly plan around it. Its legal constraints (§2.8) bind the plan: one УНП
> counter per fiscal device; no invoice bands; no tool that deletes or alters sales; BG/EU
> residency; SUPTO versions declared before they reach a master. Its questions (§12) are the
> owner's to answer. Most were answered on 2026-10-20, and each answer is recorded under its
> question. Q4's licence proposal awaits confirmation; Q6 and Q9 are open. Plan around what is
> open explicitly.
>
> ### Read, in this order, before planning
>
> 1. `CLAUDE.md`: architecture, multi-tenancy, auth, SUPTO, deployment, known issues.
> 2. `docs/fr/FR-20-offline-lan-master.md` and `docs/fr/README.md` (the global regression
>    constraints).
> 3. **The withdrawn design FR-20 builds on:**
>    `git show bc48d04:docs/fr/FR-16-local-mode-sync-engine.md` and
>    `git show bc48d04:docs/architecture/sync.md`.
>    - **Keep:** their change capture (the tailer, the journal, the lease, lost-history handling,
>      seeding).
>    - **Drop:** the SQLite plane, multi-writer merge, projections, overlays and bands.
> 4. `docs/fr/FR-14-lgr-desktop-app-server-mode.md` and `packages/desktop/src-tauri/src/*.rs`:
>    registration, keystore, the native fiscal bridge and the updater. The local role is built on
>    them.
> 5. `docs/fr/FR-19-global-accounts-org-switcher.md`: Identity and memberships. The identity
>    provider builds on it.
> 6. `docs/fr/FR-13-backup-archive.md` §5.3 and §5.7: bundles and restore modes. The move and the
>    master's backups reuse them.
> 7. **The code paths FR-20 §2 cites**, starting with:
>    - `services/biz/sequence.service.ts`, `invoice-numbering.service.ts`, `tenant-guard.ts`,
>      `identity/account.service.ts`;
>    - `portal-api/src/auth/auth.service.ts`, `portal-api/src/unified.ts`;
>    - `invoicing-api/src/controllers/pos.controller.ts`, `invoice-export.controller.ts`;
>    - `portal-api/src/websocket/{fiscal-bridge,ws.server,desktop}.ts`;
>    - `reporting/src/pdf/base.pdf.ts`, `files/doc-store.service.ts`, `packages/config`.
> 8. **roomler-ai** (`C:/dev/gjovanov/roomler-ai`, read at `origin/master`):
>    - `agents/roomlerd/src/{win_service,updater.rs,code_signature.rs,artifact_version.rs,post_install.rs,watchdog.rs}`;
>    - `agents/roomlerd/wix-perMachine/main.wxs` and `agents/roomlerd/packaging/{linux,macos}`;
>    - `crates/localapi`;
>    - `.github/workflows/release-agent.yml` and `.github/actions/sign-*`;
>    - `docs/installation.md`, `docs/linux-self-update.md`, `.claude/skills/ship-it/SKILL.md`.
>
>    The master's service, installer, updater and signing copy its patterns. roomler has **no**
>    LAN discovery and **no** `mongod`-as-a-service precedent, so design both fresh.
> 9. **The field-testing precedent, which FR-20 §5.14 and D-14 adopt:**
>    - roomler-ai `docs/fr/FR-61-vmtest-matrix.md` and `docs/vmtest.md`: throwaway VMs on the fleet
>      hosts; `lane/method/type@host#check`; ephemeral enrollment; `results.tsv` / `LATEST` /
>      `expected-failures.txt`; one isolated re-run before filing; one issue per condition, closed
>      on green;
>    - `lgr-deploy/vmtest/`: FR-14.38's LGR harness (`lgr-vmtest.sh`, `lib/{host,lanes,results}.sh`,
>      the `LGRTEST-RESULT` protocol, `budgets.tsv`). **It has never driven a guest.**
>
> ### Produce one document: `docs/fr/FR-20-IMPLEMENTATION-PLAN.md`
>
> - **Part A: Architecture.**
>   - Components, and where each runs: the global pod, the master service, the desktop shell.
>   - The process model of a master (supervisor, `mongod`, API) and of a desktop bound to a
>     master, with ports and trust boundaries.
>   - Every protocol, with its messages and failure behaviour: pairing, node registration, the
>     uplink and its two sockets, replication pages and acks, the tunnel, "Sign in with LGR", and
>     the control channel.
>   - The move state machine.
>   - Every new collection, with its fields, its indexes and where it lives.
>   - The classification of **every** existing collection (replicated / split with field owners /
>     node-local / global-only), plus the rule that forces a decision for each new model.
>   - Where every scheduler and job runs.
>   - Sequence diagrams for:
>     - a sale on the LAN;
>     - the WAN dropping and returning;
>     - a remote edit through the tunnel;
>     - a cloud → master move;
>     - a restored master;
>     - a lost master.
>   - A failure-mode table: what happens when each component dies.
> - **Part B: Implementation.**
>   - The work, split into pull-request-sized steps per phase (P0a, P0b, P1–P4 of FR-20 §9).
>   - For each step:
>     - the files and modules it touches or adds, with `file:line` anchors at the commit you read;
>     - the tests that prove it: integration, e2e, Tauri/CDP, vmtest field lanes, network-pull
>       chaos;
>     - its FR-20 §10 acceptance criteria;
>     - its kill switch;
>     - its size (S/M/L).
>   - Name the order, and what can run in parallel.
>   - Mark every step that touches production infrastructure (`lgr-deploy`, DNS, certificates,
>     ingress, sealed secrets).
> - **Part C: Migration of today's LGR.**
>   1. **Code:** every existing path that must change, and how it stays byte-compatible for orgs
>      whose home is global (the five import skills, the invoice payload, route names,
>      registry-driven prefixes).
>   2. **Data:** new collections, indexes, `changeStreamPreAndPostImages`, the path and УНП
>      migrations, and nothing else backfilled on global.
>   3. **Operations:** how ops scripts and skills target an on-prem org.
>   4. **The regal rollout:**
>      - a field-test org first, then regal-pz;
>      - the prerequisites on the shop PC;
>      - staff sign-in and PIN enrolment;
>      - the rehearsal, then the move after closing time;
>      - the WAN-pull test on a trading day, with PlusMinus running in parallel;
>      - the rollback criteria, and the move back.
>   5. **Exit and rollback** for every phase.
> - **Part D: Risks.** For each: likelihood × impact, mitigation and owner.
> - **Part E: Open questions**, and the phase each one blocks.
> - **Part F: Coverage.** Integration and e2e tests run against throwaway instances on **mars, zeus
>   and jupiter**, in FR-61's shape:
>   1. **The tiers.** CI integration, including a two-node harness (global and master as
>      subprocesses with a chaos proxy between them). Playwright e2e projects. The field lanes.
>   2. **The topologies and where each machine runs.** The rail: jupiter carries production storage,
>      so it is used only in announced windows.
>   3. **The throwaway global, and the anchor master.**
>   4. **The golden images**, and the WAN/LAN impairment verbs on the hosts.
>   5. **The synthetic regal-shaped org.** No real data, ever.
>   6. **A catalogue of checks**, each mapped to an FR-20 acceptance criterion.
>   7. **The verdict and the regression lifecycle.**
>   8. **The steps**, as a lane beside the others. The first step reconciles `lgr-deploy`'s host
>      layer and runs FR-14's desktop lanes for the first time.
>
> ### Quality bar
>
> - **Code-grounded.** Every claim about current behaviour carries a `file:line` anchor at the
>   commit you read. Every number is measured or cited, never guessed. Mark anything unverified.
> - **"It just works"** on the networks that shops and companies actually have. A step that only
>   works on a clean network has not worked. The cases:
>   - a Windows shop PC with no admin user signed in;
>   - a GPO-locked corporate server behind a TLS-inspecting proxy (PAC, OS trust store);
>   - a Linux box or NAS running Docker;
>   - CGNAT or 4G backup internet;
>   - a flat shop LAN with guest Wi-Fi;
>   - VLANs that mDNS does not cross.
> - **CI green is not done.** Each phase names its vmtest cells. A check counts as evidence only
>   once it has been seen failing first (FR-14.39's field-log convention).
> - **Each phase stands alone.** It is shippable, useful and reversible on its own. Nothing on
>   global changes for an org whose home is global.
> - **No migration scripts on a master.** No step relies on a person running a migration script
>   there.
> - **The repo's rules hold:**
>   - `bun run test`, `bun run build` and `bun run test:e2e` pass;
>   - never `.rejects`/`.resolves` in tests (the Windows deadlock);
>   - prefixes come from `sequence-registry.ts`;
>   - route names are load-bearing;
>   - tenant isolation is asserted over every new surface.
>
> ### Out of scope
>
> - multi-writer sync of any kind;
> - a SQLite data plane;
> - the offline till beyond a design sketch (it needs its own FR amendment);
> - multi-site orgs (one org across two LANs);
> - the SUPTO compliance findings in FR-20 §2.8, except the УНП key (they go into their own
>   ticket).
