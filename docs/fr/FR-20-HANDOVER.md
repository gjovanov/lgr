# FR-20 — Handover to the next session

**As of 2026-10-20.** Written by the Claude Code session that wrote FR-20, for the session that
continues it. It says where FR-20 stands, what is decided, what to do next and in what order, and
the rules this repository holds you to. FR-20 itself is long; this note tells you which parts to
read and why.

## Start here

Paste this into the new session:

> You are continuing FR-20, offline operation, in `gjovanov/lgr`. Check out `feat/fr-20-offline`
> and read, in this order:
> 1. `docs/fr/FR-20-HANDOVER.md`, all of it;
> 2. `CLAUDE.md`;
> 3. the FR's §0, §4 (decisions D-1 to D-15) and §12 (the owner's answers);
> 4. the plan's Summary, B.0, B.1, B.2, B.7 and B.10.
>
> Then take the next open step in the handover's §4, starting with P0a-1. Follow the handover's §5
> rules. One PR per plan step.

## 1. What FR-20 is

A shop keeps selling, invoicing and receiving goods in LGR when its internet line is down. regal's
current software, PlusMinus, does that on the LAN, and regal loses its line often. A company that
does not want its data in the cloud can run LGR on its own machines.

- **Every org has exactly one home** that writes its data and allocates every number: the cloud
  by default, or an on-prem **master**. A master is the same Bun API over a bundled `mongod`,
  installed as an OS service on Windows, Linux or macOS. It also runs from Compose or k8s.
- **Thin locals.** The shop's workstations are LGR Desktop, bound to the master through a pinned
  loopback proxy. The fiscal bridge stays on the LAN.
- **An optional link to lgrai.app**, at three levels (Full / Control / Air-gapped):
  - a one-way mirror, built from a change-stream journal;
  - remote users tunnelled to the master at **`<org slug>.lgrai.app`**;
  - "Sign in with LGR";
  - a read-only copy on lgrai.app while the master is offline.

| Document | What it is |
|---|---|
| [`FR-20-offline-lan-master.md`](FR-20-offline-lan-master.md) | The requirement: 116 requirements, 67 acceptance criteria, 15 decisions, 36 traps, 11 questions |
| [`FR-20-IMPLEMENTATION-PLAN.md`](FR-20-IMPLEMENTATION-PLAN.md) | Architecture (A), the steps (B), migration and the regal rollout (C), risks (D), questions (E), coverage (F), what changed after review (G), and Progress |
| [`FR-20-PROMPT.md`](FR-20-PROMPT.md) | The brief the plan was written from; it holds the original request |
| [`README.md`](README.md) | The FR-20 row, and the constraints FR-20 adds for everyone |

## 2. Where things stand

- **Docs:** written 2026-10-19 and adversarially reviewed: 5 blockers and 18 major findings, all
  fixed (plan Part G). The owner answered §12 on 2026-10-20. Merged into `feat/fr-20-offline`
  through PR #153, with CI green.
- **Tracking issue: #159.** It carries the plan's summary, a checklist of every step, and this
  handover.
- **Code, as of 2026-10-21:** P0a-3 through P0a-7 and P0b-1 through P0b-7 are merged to `master`.
  In review: P0a-1 and P0a-2 (advisory forks), P0b-10 (#175) and the `.dockerignore` part of P0b-9
  (#176, S-10). The plan's **Progress** table has the PRs and
  what each left for later. In every step's PR, update that table, and tick the step in #159 once it
  merges.
- **Things the merged steps left for later:**
  - **`bun run migrate` after the next deploy** (P0a-5's migration `0001`). Global does not migrate
    itself yet (`MIGRATIONS_AUTO=false`); until it runs, a fiscal sale on a device with history is
    refused rather than mis-numbered.
  - **At home, P0b-4 only warns** about an unlisted write inside a read-only route (refusing would turn
    a path no test reached into an outage); `reads-that-write.flow.test.ts` walks every GET instead.
    The request context is entered synchronously and reset after the response: under Bun an
    `AsyncLocalStorage` store entered after an `await` is lost, and one entered synchronously leaks (#169).
  - **Left in P0b:** P0b-8 (relative file paths, two releases), the rest of P0b-9 (lockfile, the
    allow-listed runtime stage, the `--compile` spike: it changes the production build, so the owner's
    call), and P0b-11 (docs).
  - **Stacked PRs:** retarget the next PR to `master` BEFORE deleting its base branch; deleting the base
    first closes the stacked PR (that happened to #161).
- **Open issues for P0:** none. #155, #156 and #157 were closed by the merges above.

- **Effort:** about 42–53 person-weeks, or 22–28 calendar weeks across five lanes (plan B.7, B.8).

## 3. Decisions

### Answered by the owner on 2026-10-20 (FR §12)

| Question | Answer |
|---|---|
| Q1 | **Thin locals.** No server on the workstations (D-3). |
| Q2 | **lgrai.app is read-only** for an on-prem org while its master is offline (D-5). |
| Q7 | **Org addresses are `<org slug>.lgrai.app`.** This reversed the draft's separate domain. The compensation: <br/>– step P0a-8 gives lgrai.app `__Host-` cookies only, and makes it ignore them on `Sec-Fetch-Site: same-site` requests. Not "same-origin only": that would break the cross-site OAuth callback; <br/>– global answers anonymous API requests to an address itself (FR-20.78); <br/>– addresses go only to licensed orgs a sys-admin approves, with unreserved labels; <br/>– the test domain is never under lgrai.app. <br/>What this cannot remove is risk R24. |
| Q3 | **regal-pz moves first, alone.** regal-sf follows after a clean month, once its invoice range is confirmed disjoint. `regal` stays in the cloud. |
| Q5 | **The accountant confirms the single allocator in writing** before the move. |
| Q8 | **The written query goes to НАП now.** LGR is declared before a master prints its first fiscal receipt. |
| Q10 | **One system on the fiscal device at a time.** PlusMinus keeps the A3 until cutover, and LGR prints non-fiscal text until then. |
| Q11 | **Promotion needs 24 h of silence plus an attestation.** |

### Waiting on the owner

- **Q4: the licence.** A proposal sits in FR-20.55: Enterprise, per user; 30 days of grace; then no
  new sessions or documents, at a day boundary; never blocking closing, refunds, payments, exports
  or leaving. Do not build P2-3's licence rules until it is confirmed.
- **Q6: the macOS installer certificate.** It blocks only the macOS server.
- **Q9: jupiter's test windows and the permanent anchor master.** It blocks only T-7 and T-8.

### Settled by the review. Do not "simplify" them

Each looks like an over-complication until you read the failure it prevents (FR §6, plan Part G):

- **The supervisor owns every way in and out (D-15).** The API listens on loopback, for the
  supervisor alone, and takes control over a socket, not over HTTP.
- **Read-only mode lives on lgrai.app's own origin.** A master's address shows only a notice, and
  global never issues a token or cookie there.
- **Local credentials are set on lgrai.app,** must differ from the global password, and are
  accepted on the LAN only, with backoff rather than lockout.
- **The home record fails closed.** A missing or disagreeing record puts the org in `hold`, never
  on global.
- **A restored, reverted or cloned master locks its legal series** until outside evidence clears
  them. Promotion needs evidence, and freezes global's series until the site's last numbers are
  recorded.
- **A revocation (4403) stops the link, never the shop.**
- **The idempotency key lives on the document,** with a fiscal state. On a resume, the device is
  asked for its last receipt before anything is printed.
- **Pages carry a hash chain,** and the mirror applies split documents by field ownership, with an
  `identityId` only where global sanctioned it.

If you find evidence that one of these is wrong, write it up the way plan Part G does, with the
evidence, and ask the owner. Do not plan around it quietly.

## 4. What to do next, in order

The step definitions, with their touches, tests and ACs, are in plan Part B. Sizes: S is up to 2
days, M up to a week, L 1–3 weeks.

| # | Step | Size | Issue | Note |
|---|---|---|---|---|
| 1 | **P0a-1** — every by-id route scoped by org (FR-20.7, AC 5) | M | — | Start here. It must land before any mirror exists (P3-2) |
| 2 | **P0a-2** — PDF rendering that opens no socket (FR-20.25, AC 10) | M | — | The 68 export tests and the FR-06 PDF tests must pass unmodified |
| 3 | P0a-4 — idempotent hot path, crash-safe (AC 7, 18, 57) | M | #155 | Use the Eltrade simulator (`tests/helpers/eltrade-simulator.ts`) |
| 4 | P0b-1 — node role; refuse committed example secrets (FR-20.17) | S | #157 | |
| 5 | P0a-6, P0a-7 — independent schedulers and owned tasks; timeouts | S | — | |
| 6 | P0b-7 — the versioned migrations runner, then P0b-6 (scripts refuse to write elsewhere) | M | — | |
| 7 | P0a-5 — one УНП counter per fiscal device (AC 12) | S | #156 | **After P0b-7:** it is a migration. Correct `docs/supto/` in the same PR |
| 8 | P0b-2 — home registry, gate by effect, Mongoose write guard | L | — | **The head of the critical path** (plan B.7) |
| 9 | P0b-3, -4, -5, -8, -9, -10, -11 | S–M | — | P0b-8 ships in two releases (expand, then contract) |
| 10 | P0a-8 — lgrai.app made safe to have subdomains | M | — | Two releases. It must land before P3-4, and is off the critical path |

**Coverage (lane E) can start in parallel:**
- **T-1:** the two-node harness and chaos proxy.
- **T-2:** the synthetic-data generator.
- **T-0:** run FR-14's desktop vmtest lanes for the first time. It needs the owner, because it
  needs access to the zeus and mars hosts.

### Where each step's PR goes

- **A fix production needs now** (the P0a steps, and any bug fix) goes **to `master`**, in its own
  PR, the way #158 did. Then merge `master` into `feat/fr-20-offline`.
- **FR-20 work not yet meant for production** goes **into `feat/fr-20-offline`**.
- **Merging the feature branch to `master`, and every deploy, is the owner's call.**

## 5. Rules of the road

### This repository is public

Branches, PRs, issues and every commit in history are world-readable. A later commit does not
un-publish an earlier one.

- **Never describe an unfixed vulnerability** in a commit message, PR, issue, doc or code comment.
  Open a draft security advisory instead (Security → Advisories → New draft), and tell the owner.
- **Fix it through the advisory's temporary private fork** where you can.
  - **Only an admin (the owner) can start that fork, and only an admin can merge from it.** As an
    advisory collaborator, you push a branch to the fork and open a PR there, against `master`.
  - GitHub Actions does not run in the fork, so run the tests locally.
  - Keep the commit message factual and short, and let the owner time the merge and the deploy
    together.
- The owner decides when it is published, as the next free `S-NN` in
  `docs/security/2026-09-21-security-review.md`. **S-24 is taken by PR #88.**
- **Production holds real customer data,** regal's among others.

### Working in the repo

- **One PR per plan step,** off `origin/master` or `feat/fr-20-offline` (§4). Name the step and
  its kill switch (plan B.10) in the PR description.
- **Before pushing:** `bun run test`, and `bun run build` for UI changes. Run `bun run test:e2e`
  when a flow changes, and the single test file first when iterating.
- **CI** is a self-hosted Linux runner on mars and takes about 12 minutes; merge on green. The
  macOS cargo check runs only on a manual dispatch or a `desktop-v*` tag.
- **Never use `.rejects` or `.resolves` in a test.** On Windows they deadlock the whole suite (see
  CLAUDE.md's Known Issues). Use `helpers/capture-rejection.ts`.
- **Every new Mongoose model declares its replication class** once P3-1 lands. Until then, follow
  the classification in plan A.5.2.

### Keep the FR-20 docs consistent

- **Never renumber.** Requirements (FR-20.N), ACs, decisions (D-N), questions (QN) and traps are
  cited by issues and by the plan. Add at the end, and reword in place.
- **When a step lands,** update the plan's Progress table and tick the step in #159. If it changes
  what the FR says about the current state, update §2 too: P0a-3 is the example.
- **After editing,** run the check below from the repository root. It must print `no problems`.

### Production, regal and the fleet

- **Deploys are the owner's.** They go through the `deploy-prod` skill on mars.
- **Never run analytics or heavy scripts in the production app pod;** it gets OOM-killed. A
  read-only production script must connect with `autoIndex: false, autoCreate: false`, or Mongoose
  creates collections and indexes.
- **regal-pz is the first on-prem org.** Its staff enter documents in LGR daily while PlusMinus
  still runs beside it. Never test against regal's data.
- **No real customer data on throwaway instances.** They use the synthetic generator (T-2,
  FR-20.112).
- **jupiter carries production storage.** Field cells run there only in a window the owner
  announces.

## 6. Where things are

- **Code anchors** in the FR and plan were read at `ab0a446` and `e2477b9`. They drift: treat them
  as anchors, not gospel, and re-read before you quote one.
- **Related FRs:**
  - [FR-14](FR-14-lgr-desktop-app-server-mode.md): the desktop, its fiscal bridge, its updater,
    and signing with roomler's identity;
  - [FR-19](FR-19-global-accounts-org-switcher.md): one Identity per person, and memberships;
  - [FR-13](FR-13-backup-archive.md): bundles and restore.
- **Other repositories.** Ask the owner for access where you lack it.
  - **`gjovanov/roomler-ai`:** what FR-20 copies.
    - Service hosting and recovery: `win_service/mod.rs`. The IPC pool: `crates/localapi`. The
      exit-code contract: `src/watchdog.rs`.
    - The `sign-windows` action, and the root update helper.
    - The field-matrix model: `docs/fr/FR-61-vmtest-matrix.md` and `docs/vmtest.md`.
  - **`gjovanov/lgr-deploy`:** the k8s manifests, and `vmtest/`, which FR-20's lanes extend. Its
    host layer has never driven a guest; that is T-0.
  - **`gjovanov/k8s-cluster-multi`:** the hosts' capabilities. FR-20 adds golden images and the
    impairment verbs there.

## 7. The consistency check

Save it anywhere and run it with `bun run <file>` from the repository root:

```ts
import { readFileSync } from 'node:fs'
const read = (f: string) => readFileSync('docs/fr/' + f, 'utf8')
const fr = read('FR-20-offline-lan-master.md')
const others = ['FR-20-IMPLEMENTATION-PLAN.md', 'FR-20-PROMPT.md', 'FR-20-HANDOVER.md']
const problems: string[] = []
const ordered = (label: string, ns: number[]) =>
  ns.forEach((n, i) => { if (n !== i + 1) problems.push(`${label}: position ${i + 1} is ${n}`) })
const section = (from: string, to?: string) => fr.slice(fr.indexOf(from), to ? fr.indexOf(to) : undefined)
const reqs = [...fr.matchAll(/^\*\*FR-20\.(\d+) /gm)].map(m => +m[1]); ordered('requirement', reqs)
const acs = [...section('## 10. Acceptance criteria', '## 11. Field test').matchAll(/^(\d+)\. /gm)].map(m => +m[1]); ordered('AC', acs)
const ds = [...fr.matchAll(/^\| \*\*D-(\d+)\*\*/gm)].map(m => +m[1]); ordered('decision', ds)
const qs = [...section('## 12. Open questions').matchAll(/^(\d+)\. \*\*/gm)].map(m => +m[1]); ordered('question', qs)
const traps = [...section('## 6. Edge cases and traps', '## 7. Integration constraints').matchAll(/^(\d+)\. \*\*/gm)].map(m => +m[1]); ordered('trap', traps)
for (const [name, text] of [['FR', fr], ...others.map(f => [f, read(f)])]) {
  for (const m of text.matchAll(/FR-20\.(\d+)/g)) if (+m[1] > reqs.length) problems.push(`${name}: FR-20.${m[1]}`)
  for (const m of text.matchAll(/\bAC (\d+)(?:[–-](\d+))?/g)) for (const v of [m[1], m[2]].filter(Boolean)) if (+v > acs.length) problems.push(`${name}: AC ${v}`)
  for (const m of text.matchAll(/\bD-(\d+)\b/g)) if (+m[1] > ds.length) problems.push(`${name}: D-${m[1]}`)
  for (const m of text.matchAll(/\bQ(\d+)\b/g)) if (+m[1] > qs.length) problems.push(`${name}: Q${m[1]}`)
}
console.log(`requirements ${reqs.length}, ACs ${acs.length}, decisions ${ds.length}, questions ${qs.length}, traps ${traps.length}`)
console.log(problems.length ? problems.join('\n') : 'no problems')
```

## 8. Who decides

The owner (goran) decides:
- merges to `master`, and every deploy;
- Q4, Q6 and Q9;
- any change to a settled decision;
- when a security finding is published;
- anything that touches production, regal, or the fleet hosts.

Everything else in the plan is yours to carry out, one reviewed PR at a time.
