# FR-20 — Implementation plan: architecture, implementation, migration

Spec: [`FR-20-offline-lan-master.md`](FR-20-offline-lan-master.md) · Brief:
[`FR-20-PROMPT.md`](FR-20-PROMPT.md) · Read against `lgr@ab0a446` (origin/master, 2026-10-19),
`roomler-ai@c9ccfba66` and `d71ad3cf4`, and `lgr-deploy@b2455d3`. `file:line` anchors refer to those
commits. They drift; treat them as anchors, not gospel.

**Revision 2 (2026-10-19).** This version incorporates an independent adversarial review of the first
draft. The review found 5 blockers and 18 major issues; all are addressed here and in the FR. **Part
G** lists what the review changed, decision by decision, as the brief asks: *"say so in a separate
section with the evidence"*.

**How to read this.**

| Part | What it covers |
|---|---|
| A | What gets built, and how the pieces talk |
| B | The order of the work, in pull-request-sized steps, each with a kill switch |
| C | How today's LGR, and regal, get there |
| D | What can go wrong |
| E | What is still undecided |
| F | The coverage: integration and e2e tiers, and the vmtest matrix on mars, zeus and jupiter, in roomler FR-61's shape |
| G | The decisions and requirements the review changed, with the evidence |

Requirement numbers (FR-20.N), acceptance numbers (AC N), decisions (D-N) and questions (QN) are
FR-20's.

---

## Summary

- **The shape.** One codebase, two server roles (`global`, `master`), and a desktop that can be bound
  to either.
  - Every org has one home that writes, and the home record fails closed.
  - A master's supervisor owns every way in and out.
  - A master mirrors its orgs to global over two outbound sockets, with a hash chain. Global tunnels
    remote users from the org's address (`regal-pz.lgrai.app`) back to the master, and serves
    read-only on lgrai.app's own origin while the master is offline.
- **Five new pieces:**

  | Piece | Language | Where |
  |---|---|---|
  | Supervisor: service host, ingresses, egress proxy, uplink, updater | Rust | `packages/server` |
  | Node services: home, replication, uplink server, tunnel, identity provider, relays, moves | TS | `packages/node` |
  | Versioned migrations runner | TS | `packages/migrations` |
  | Loopback proxy and pinned trust | Rust | the desktop shell |
  | Field lanes | bash | `lgr-deploy/vmtest` |

- **Phases** (FR-20 §9):

  | Phase | Delivers |
  |---|---|
  | P0a | Fixes and hardening the cloud needs anyway, including lgrai.app made safe to have subdomains |
  | P0b | Foundations, with no behaviour change on global |
  | P1 | A shop that runs with no internet at all |
  | P2 | Licensed, updated and signed into through lgrai.app |
  | P3 | regal-pz on-prem, with a live mirror and remote access |
  | P4 | Options, only on field evidence |

- **Coverage (Part F)** has three tiers:
  1. integration in CI, including a two-node harness with a chaos proxy;
  2. Playwright e2e;
  3. a field matrix on throwaway instances on **zeus** (shop LANs), **mars** (a throwaway global, the
     remote user, the corporate proxy) and **jupiter** (the second and the "lost" shop, in announced
     windows only).
- **Effort, roughly:** 42–53 person-weeks, of which 11–15 are coverage. That is about **22–28
  calendar weeks** across four parallel lanes plus ops (B.8). The supervisor, the tunnel and the
  first run of the host layer carry the most uncertainty.
- **The owner's answers (FR-20 §12, 2026-10-20):**

  | Question | Answer |
  |---|---|
  | Q1 thin locals | Yes: D-3 stands |
  | Q2 read-only lgrai.app while the master is offline | Yes: D-5 stands |
  | Q7 the address | `<org slug>.lgrai.app` (D-13). It adds P0a-8, which makes lgrai.app safe to have subdomains |
  | Q3, Q5, Q8, Q10, Q11 (before the regal move) | As recommended: regal-pz first and alone; the accountant in writing; НАП queried now; one system on the A3 at a time; 24 h + attestation |
  | Q4 licence | A proposal (FR-20.55) awaits confirmation before P2-3 |
  | Q6 macOS installer certificate, Q9 jupiter windows and the anchor master | Open. They block only the macOS server, and T-7/T-8 |

---

## Part A — Architecture

### A.1 Topology

```mermaid
flowchart LR
  subgraph Internet
    RU[Remote user's browser]
  end

  subgraph GLOBAL["Global — lgrai.app (k8s, multi-tenant)"]
    ING[Ingress<br/>lgrai.app · *.lgrai.app]
    API_G["lgr API pods<br/>role=global"]
    MDB_G[(MongoDB rs0<br/>cloud orgs + mirrors)]
    ING --> API_G --> MDB_G
  end

  subgraph SHOP["Shop LAN — regal-pz"]
    subgraph M["Master PC — LGR Server (OS service)"]
      SUP["lgr-server supervisor (Rust)<br/>LAN TLS · tunnel · console · egress · uplink"]
      API_M[lgr API, role=master<br/>loopback only]
      MDB_M[(mongod rs0<br/>loopback only)]
      SUP -- "front port + control socket" --> API_M --> MDB_M
    end
    D1[Till 1 — LGR Desktop<br/>loopback proxy + bridge]
    D2[Office PC — LGR Desktop]
    FU1[[Eltrade A3 ФУ]]
    D1 -- serial --- FU1
    D1 & D2 -- "HTTPS :4443, pinned TLS<br/>+ desktop token" --> SUP
  end

  SUP == "uplink ×2 (outbound WSS :443)<br/>interactive: control + tunnel<br/>bulk: pages + blobs (paced)" ==> ING
  RU -- "https://regal-pz.lgrai.app" --> ING
  FU1 -. "own data SIM" .-> NRA[(НАП)]
```

- **The shop's tills never talk to the internet.** The master's supervisor is the only thing in the
  shop that does, and only outbound.
- **The API never faces the LAN or the internet.** Every request reaches it through the supervisor,
  stamped with where it came from (FR-20.16, D-15).
- **Global holds the mirror in its own MongoDB.** A mirrored org's documents are written only by the
  mirror applier, and a Mongoose-level guard refuses every other write (FR-20.4).

### A.2 Components and where they run

| Component | Runs on | Language | Responsibility | New / changed |
|---|---|---|---|---|
| `lgr` API, role `global` | global pods | TS | Today's app, plus: home gate (by effect) and Mongoose write guard, node registry, uplink server, mirror applier, tunnel router, IdP, relays, move orchestrator, read-only mode | changed |
| `lgr` API, role `master` | master | TS | Today's app, plus: source-aware request handling (LAN / tunnel / console stamps), setup, local credentials, tailer + journal + page builder, outbox worker, identity-feed apply, licence check, restore lock | changed |
| `packages/node` | both | TS | The role-specific modules above, mounted from `unified.ts` | new |
| `packages/migrations` | both | TS | Versioned, idempotent migrations run at start, filtered by home | new |
| `lgr-server` supervisor | master | Rust | Service host; supervises `mongod` and the API (Job Object / process group); **all ingresses** (LAN TLS with the CA key, tunnel, console); **egress proxy**; uplink (both sockets, machine proxy/PAC, OS trust, pacing); DNS-SD advert + clone detection; journal high-water mark outside the DB; IPC; diagnostics | new |
| `lgr-server-update` helper | master | Rust (same binary, `update-helper`) | The only privileged piece. It downloads and verifies a release itself, installs it into a versioned directory, switches the pointer, and confirms the service is up. | new |
| `mongod` 7.0 | master | — | Single-node replica set on loopback, auth on, replicated collections created explicitly | bundled |
| LGR Desktop shell | workstations | Rust | Today's shell, plus: server kind `master`, discovery by nodeId, one pinned trust client (including presence and the updater), loopback proxy, re-point with identity kept | changed |
| `desktop-ui` | workstations | Vue | Onboarding gains *"a server on this network"* and *"this computer"*, with six-word confirmation; the Overview shows the server's cloud link | changed |
| `portal-ui` / `ui-shell` | both | Vue | Servers page, move and promotion wizards, sys-admin Nodes page, master status page, setup console, *"Sign in with LGR"*, local sign-in and PIN pad, **On-prem credentials** under the account, read-only banner | changed |
| `lgr-deploy` | global infra | YAML | `*.lgrai.app` DNS record, wildcard certificate and ingress rule for org addresses; WebSocket timeouts; three new sealed secrets; vmtest lanes | changed |

### A.3 Process model of a master

```
┌───────────────────────────── LGR Server (one OS service) ──────────────────────────────┐
│ lgr-server supervisor (NT SERVICE\LGRServer · lgr · _lgr — never SYSTEM/root)          │
│  ingresses — the only sockets reachable from outside the process tree:                 │
│    · LAN      0.0.0.0:4443  TLS (master CA; the key stays here) · paired-desktop token │
│    · tunnel   streams from the uplink (no socket of its own)                           │
│    · console  127.0.0.1:<setup port> · only while setupComplete=false · one-time token │
│    every ingress: strip X-LGR-* → stamp source + client IP + front secret → the API    │
│  egress proxy  127.0.0.1:<egress port> (CONNECT; machine proxy/PAC; OS roots exported) │
│  uplink        interactive WSS ─► global :443 (control + tunnel)                       │
│                bulk WSS ────────► global :443 (pages + blobs; paced)                   │
│  DNS-SD        _lgr-server._tcp {nodeId, name, fp, bootNonce}  (also: clone detection) │
│  high-water    keys/journal-hw (outside the DB): last journal seq + chain hash per org │
│  IPC           \\.\pipe\lgr-server | /run/lgr/lgr-server.sock (NDJSON; CLI + desktop) │
│  children, in a Job Object / process group:                                           │
│   ├─ mongod --replSet rs0 --bind_ip 127.0.0.1 --port <chosen at install> --auth ...    │
│   └─ lgr-api (Bun baseline build)                                                      │
│        HTTP 127.0.0.1:<front port> — the supervisor only (front secret + Host list);   │
│          Elysia's own server, so WebSockets work                                       │
│        control socket (AF_UNIX / named pipe) — supervisor only: pages, status, stop    │
└────────────────────────────────────────────────────────────────────────────────────────┘
lgr-server-update (SYSTEM/root): idle; woken over IPC; resolves, downloads and verifies the
release itself; installs to versions/<v>/; switches the `current` pointer; confirms the service.
```

- **Start order** (FR-20.11):
  1. `mongod`, then wait for its port;
  2. idempotent `rs.initiate`, and on first boot the SCRAM user;
  3. **create every replicated collection** with pre/post images (FR-20.15);
  4. compare the database's journal head with the outside high-water mark (FR-20.51);
  5. `lgr-api migrate` (FR-20.19);
  6. `lgr-api serve`;
  7. the ingresses;
  8. the uplink, if linked;
  9. the DNS-SD advert.
- **Stop order** (FR-20.23):
  1. close the ingresses and drain the uplink;
  2. `stop` over the control socket (the API waits for an in-flight fiscal command, then exits);
  3. `mongod` via `db.shutdownServer()`;
  4. the supervisor exits 0.

  The service's pre-shutdown timeout covers a fiscal command.
- **Exit codes**, adapted from roomler `src/watchdog.rs`:

  | Code | Meaning | Service manager |
  |---|---|---|
  | 0 | normal stop | — |
  | 2 | stall, must come back | restarts |
  | 7 | the installation is unusable: keys missing, data directory unreadable | does not restart; an alarm |
  | 8 | already running | does not restart |
  | 9 | restart requested | restarts |

  ⚠ **A revocation is not an exit.** Close code 4403 stops the uplink only, and the shop keeps
  selling (FR-20.94).
- **Health.** `GET /api/health` (`portal-api/src/api.ts:124`) plus the control socket's `status`:
  schedulers, journal lag, outbox depth, fiscal state, `posOpen` and `fiscalInFlight` (the updater
  defers on them), and the restore lock.

### A.4 Process model of a desktop bound to a master

```
LGR Desktop (per OS user, Tauri 2)
  shell
   ├─ trust.rs   ONE HTTP client; per-server policy: OS store (lgrai.app) | pinned master CA
   │             used by enroll, token, presence (today presence.rs:115 builds its own),
   │             the bridge, the proxy, AND the updater (today tauri_plugin_updater's own client,
   │             install.rs:371,391-397, which would never trust a master's CA)
   ├─ proxy.rs   127.0.0.1:<stable port> ──pinned TLS──► master:4443
   │             · per-launch secret (cookie set by /__lgr/boot#<secret>)
   │             · Host must be 127.0.0.1:<port>; Origin checked
   │             · adds X-LGR-Desktop-Token (15-min desktop token)
   │             · forwards WebSocket upgrades
   │             · on a re-point: clears the webview storage for this origin
   ├─ discovery  finds the master by nodeId: last address → DNS-SD (DnsServiceBrowse on Windows)
   │             → <host>.local → ask; the pin is checked whichever way it was found
   ├─ bridge.rs  COM port ◄──► wss://master:4443/ws/fiscal-bridge  (via trust.rs)
   └─ windows    main (Overview, Settings…) · lgr-web → http://127.0.0.1:<port>/<startPath>
```

- **A desktop registered to lgrai.app** keeps loading `https://lgrai.app` directly. The proxy is used
  only for a master.
- **A desktop on the master PC itself** pairs through the LAN ingress on `127.0.0.1:4443`, with the
  same pin and the same rules.

### A.5 Data

#### A.5.1 New collections and fields

**Collections:**

| Collection | Lives on | Key fields | Indexes |
|---|---|---|---|
| `org_homes` | global + master | `orgId`, `home` (`'global'` \| nodeId), `epoch`, `state` (`active`\|`freezing`\|`frozen`\|`fenced`\|`hold`), `since`, `changedBy` | unique `orgId` |
| `nodes` | global | `_id` = nodeId, `name`, `installationId`, `publicKey`, `keyEpoch`, `orgIds[]`, `linkLevel`, `status`, `ephemeral`, `versions{app,protocol,schema,supto}`, `os`, `lastSeenAt`, `presence{ip,clockSkewMs}`, enrolment/revocation fields | `{orgIds:1,status:1}`; unique `installationId` (partial: active) |
| `org_addresses` | global | `label` (the org's slug when issued), `orgId`, `state` (`requested`\|`active`\|`retired`), `approvedBy`, `approvedAt`, `retiredAt` | unique `label` (retired labels stay, so none is ever reissued); `{orgId, state}` |
| `node_enrollment_codes`, `node_enrollment_keys`, `node_enrollment_key_uses` | global | as FR-14.19's desktop equivalents; keys are reusable, gated by `ephemeralKeysEnabled` | as the desktop equivalents |
| `node_presence` | global | `nodeId`, `podId`, `channel`, `connectedAt`, `heartbeatAt` | unique `{nodeId, channel}`; TTL on `heartbeatAt` |
| `node_assertions` | global | `nodeId`, `jti`, `at` | unique `{nodeId, jti}`; TTL 5 min |
| `mirror_state` | global | `nodeId`, `orgId`, `epoch`, `instanceEpoch`, `journalEpoch`, `watermark`, `chainHash`, `fenceCutoff`, `lastPageAt`, `lagMs` | unique `orgId` |
| `mirror_blobs` | global | `orgId`, `sha256`, `size`, `state` (`wanted`\|`partial`\|`ok`), `offset` | unique `{orgId, sha256}` |
| `mirror_dead_letters` | global | `orgId`, `nodeId`, `coll`, `docId`, `reason`, `page`, `at`, `status` | `{orgId, status}` |
| `org_moves` | global | `orgId`, `kind` (`to_master`\|`to_global`\|`promote`), `state`, `from`, `to`, `epochFrom/To`, `startedBy`, `evidence{attestation, silenceSince}`, `steps[{name,at,ok,detail}]` | `{orgId, state}` |
| `idp_codes` | global | `codeHash`, `nodeId`, `identityId`, `redirectUri`, `codeChallenge`, `expiresAt` (60 s), `usedAt` | unique `codeHash`; TTL |
| `onprem_credentials` | global | `identityId`, `orgId`, `kind` (`password`\|`pin`), `verifier` (argon2id), `setAt`, `deliveredTo[{nodeId, at}]` | unique `{identityId, orgId, kind}` |
| `_migrations` | every node | `_id` = migration id, `appliedAt`, `durationMs`, `appVersion`, `checksum` | — |
| `repl_engine` | master | singleton: tailer lease holder, heartbeat, resume token, `journalEpoch`, lag | — |
| `repl_orgs` | master | `orgId`, `enabled`, `seq`, `chainHash`, `tombstoneFloor`, `seededAt` | unique `orgId` |
| `repl_journal` | master | `orgId`, `coll`, `docId`, `seq`, `op` (`upsert`\|`delete`), `changedFields[]`, `clusterTime` | unique `{orgId, coll, docId}`; `{orgId, seq}`; `{coll, docId}` |
| `node_instance` | master | singleton: `instanceEpoch`, `createdAt`, `restoreLock{series[], since, reason}` | — |
| `local_credentials` | master | `identityId`, `kind`, `verifier`, `tvAtSet`, `failures`, `nextAttemptAt` (backoff) | unique `{identityId, kind}` |
| `outbox` | master | `_id` = a deterministic id (e.g. `digest:<orgId>:<date>`), `orgId`, `kind`, `payload`, `state`, `attempts`, `nextAt`, `lastError`, `doneAt` | `{state, nextAt}` |
| `entitlements` | master | `orgId`, `jws`, `plan`, `apps[]`, `desktops`, `expiresAt`, `verifiedAt` | unique `orgId` |
| `desktop_releases` | master | `version`, `channel`, `files[{name, sha256, path}]`, `fetchedAt` | unique `version` |

**Fields added to existing documents:**

| Where | Field | Why |
|---|---|---|
| `Org` (global copy) | `homeEpochHighWater` | the second home record (FR-20.3) |
| `POSSession`, `POSTransaction`, `Invoice`, `Invoice.payments[]` | `clientKey`, `requestHash` | FR-20.37: the idempotency key lives on the document; unique `{orgId, clientKey}` per collection |
| `POSTransaction` | `fiscal{state: pending\|printed\|failed, receiptNo, printedAt}` | FR-20.37 |
| `File` | `sha256` | where it is missing; `DocFile.currentChecksum` already exists |
| `BackgroundTask` | `owner{process, pod, heartbeatAt}` | FR-20.23 |

**Not created:** a band collection, a conflicts collection, a projections outbox, an `idempotency_keys`
table. One writer needs none of them, and idempotency keys live on documents.

**Never in an FR-13 bundle:** `org_homes`, `mirror_*`, `org_moves`, `repl_*`, `outbox`,
`local_credentials`, `node_instance`, `entitlements` (FR-20.3). `tenantCollections()`
(`backup-bundle.service.ts:62-79`) gains this exclusion list, and a test lists every model with an
`orgId` and asserts each is classified.

#### A.5.2 Every existing collection, classified

There are 70 models in 67 files (`packages/db/src/models/`; CLAUDE.md's "83" is stale).

| Class | Meaning |
|---|---|
| **R** (replicated) | Written on the home; the mirror applies the whole document. A document with no `orgId` is never journaled. |
| **S** (split) | Fields have owners, on dotted leaf paths; the master projects each page to the home-owned ones, and the mirror applies only those. |
| **N** (node-local) | Never leaves the node that wrote it. |
| **G** (global-only) | Belongs to people or to everyone. A master holds a sanitised cache and never writes it. |

**Del** is how the app deletes rows today: `H` hard deletes (tombstones needed), `S` soft deletes
only, `TTL` a TTL index, `—` never deleted. **⚠** marks a unique index that does not include `orgId`.

| # | Model → collection | Class | Del | Notes |
|---|---|---|---|---|
| 1 | Org → `orgs` | **S** | — | Home owns company data and `settings.{baseCurrency, fiscalYearStart, dateFormat, timezone, locale, taxConfig, payroll, inventory, accounting, modules, dailyDigest, backup, desktop}`. Global owns ⚠`slug`, `subscription.*` and `settings.integrations.*`, plus `homeEpochHighWater` on its own copy. **Applied by `{_id}`**: `_id` is the org id, and Org has no `orgId` field. |
| 2 | OrgLogo → `orglogos` | R | H | Image bytes in Mongo. |
| 3 | OrgApp → `orgapps` | R | — | Inserted by a GET today (FR-20.6). |
| 4 | User → `users` | **S** | — | Home owns the membership (role, permissions, permissionSetIds, operatorCode, position, roleHistory, isActive, preferences, avatar). `identityId` is applied only where global sanctioned it (FR-20.63). Email and names come from the identity feed. `password` and `oauthProviders` are never on a master. `lastLoginAt` is node-local. |
| 5 | Identity → `identities` | G | — | ⚠`email`, ⚠ provider link. A master caches `{iid, email, names, tv, active}`, with no hash. |
| 6 | AuthToken → `auth_tokens` | G | TTL | Password-reset hashes. |
| 7 | PermissionSet → `permissionsets` | R | H | |
| 8 | Invite → `invites` | G | S | ⚠`code` (a bearer credential). For an on-prem org, see A.6.8. |
| 9 | Code → `codes` | N | TTL/H | Activation codes, in clear. |
| 10 | OAuthHandoff | N | TTL | |
| 11 | LoginThrottle | N | TTL/H | |
| 12 | OAuthPendingRegistration | N | TTL | |
| 13 | EmailLog | N | H (365 d) | `body` holds raw reset links. |
| 14 | DigestRun | N | — | Claim lock. |
| 15 | BackupRun | N | — | Claim lock. |
| 16 | RestoreRun | N | — | |
| 17 | ArchiveUnit | R | — | Relative paths (FR-20.24); bytes travel as blobs. |
| 18 | AuditLog | R | — | Append-only; gains `via` (FR-20.48). |
| 19 | File | R | H | `storagePath` becomes relative; `sha256` added. |
| 20 | DocFile | R | H | `currentPath` becomes relative; large working fields. |
| 21 | Notification | N | — | No production writer today. |
| 22 | BackgroundTask | N | TTL | Gains an owner and a heartbeat. |
| 23 | Tag | R | H | Auto-inserted on product and warehouse save. |
| 24 | Journal | R | S | |
| 25 | Account | R | H | `balance` is a derived cache (`accounting.service.ts:111,148` vs `journal.controller.ts:226,249`), mirrored as is. |
| 26 | FiscalYear | R | H | Auto-created. |
| 27 | FiscalPeriod | R | H | Auto-created (`insertMany`). |
| 28 | JournalEntry | R | H (draft) | Auto-JEs from the event bus. |
| 29 | FixedAsset | R | H | |
| 30 | BankAccount | R | H | |
| 31 | BankReconciliation | R | H | |
| 32 | TaxReturn | R | H | |
| 33 | ExchangeRate | R | H | Org rows only. `orgId:null` system rows are never journaled; they are G, fed as reference data. |
| 34 | PaymentTerm | R | S | |
| 35 | FiscalPosition | R | S | |
| 36 | Contact | R | S | `*Lower` mirrors travel as data. |
| 37 | Invoice | R | H (draft) | Gains `clientKey`; derived payment fields travel as data; **issued invoices are immutable on every path** (FR-20.51). |
| 38 | Order (ORDO) | R | H (draft) | |
| 39 | InternalOrder (ORDI) | R | H (draft) | |
| 40 | Reservation (RES) | R | — | |
| 41 | SupplierProductAlias | R | — | `hits` uses `$inc`. |
| 42 | PaymentOrder | R | H | |
| 43 | CashOrder | R | H | |
| 44 | Product | R | S (scripts: H) | `seed-products --clean` re-inserts the catalog under new `_id`s. |
| 45 | Warehouse | R | S | |
| 46 | StockLevel | R (derived) | — (scripts: H) | Cannot be recomputed from movements; travels as data, so the mirror needs no projections. |
| 47 | StockMovement | R | — | `SM-` numbers come from a scan on the home. |
| 48 | InventoryCount | R | H | |
| 49 | PriceList | R | S | |
| 50 | CostLayer | R (derived) | — | Path-dependent; travels as data. |
| 51 | ProductCategory | R | S | |
| 52 | StockLocation | R | S | |
| 53 | OperationType | R | S | |
| 54 | StockLot | R | S | |
| 55 | DinCatalog → `din_catalog` | G | — | ⚠`din`. Fed to masters (FR-20.87). |
| 56 | Employee | R | S | |
| 57 | PayrollRun | R | H (draft) | |
| 58 | Payslip | R | H | |
| 59 | Timesheet | R | H | |
| 60 | POSSession | R | — | Gains `clientKey`; totals use `$inc`. |
| 61 | POSTransaction | R | — | Carries `unpNumber` (`pos.controller.ts:619`), `clientKey` and `fiscal.state`; immutable once completed. |
| 62 | POSPaymentMethod | R | S | |
| 63 | FiscalDevice | **S** | S | Home owns the configuration. Node-local: `status`, `lastCommunicationAt`. |
| 64 | Workstation | R | S | Прил. 29 т. 18.9 nomenclature. |
| 65 | Desktop | **S** | H (ephemeral) | Home owns the registry (name, status, assignment, versions, capabilities, publicKey). Node-local: `lastSeenAt`, `lastPresence`. The registry moves with the org, so desktops keep their ids. |
| 66 | DesktopEnrollmentCode | N | TTL | ⚠`codeHash`. Revoked by a move. |
| 67 | DesktopEnrollmentKey | N | S | ⚠`keyHash`. Revoked by a move. |
| 68 | DesktopEnrollmentKeyUse | N | — | |
| 69 | DesktopAssertion | N | TTL | ⚠`{desktopId, jti}`. |
| 70 | Sequence | R (derived) | — | Counters plus `displayPrefix`; they move with the org (FR-20.46). |

**Totals: 48 R, 4 S, 4 G, 14 N.**

#### A.5.3 The generated metadata, and the rule that forces a decision

`packages/node/src/replication/meta.generated.ts` is produced by `bun run gen:replication-meta`. It
loads every model and reads a **required** schema option, either
`schema.set('replication', { class: 'R' })` or `{ class: 'S', home: [...], global: [...],
node: [...] }`. The lists are **dotted leaf paths**.

A snapshot test (`unit/replication-meta.test.ts`) fails on any of these:
- a model without the option;
- a generated entry that differs from the committed file;
- an `S` model whose lists do not give **every leaf path exactly one owner**. Nested ownership is the
  point: `Org.settings` is the home's, while `Org.settings.integrations` is global's.

The same metadata drives the bundle exclusions (A.5.1) and the explicit creation of collections at
boot (FR-20.15).

### A.6 Protocols

Every node-to-node message carries `v`. Every message about an org carries `orgId` and `epoch`.
Messages are JSON on the interactive socket and BSON frames on the bulk socket.

#### A.6.1 Pairing (desktop ↔ master)

FR-14.19 / FR-14.20, served by the master, with these deltas:
1. **The code's QR and deep link carry `fp`,** the SHA-256 of the master CA's SPKI:
   `lgr://enroll?server=https://192.168.1.10:4443&code=XXXX-XXXX&fp=sha256:…`.
2. **The first connection is pinned to `fp`** (`trust.rs`). A typed code is confirmed with **six
   words** derived from `fp`, at least 66 bits. They are shown on the master's Desktops page and on
   the desktop. The fingerprint is broadcast in DNS-SD, so a 32-bit comparison could be ground in
   hours (FR-20.29).
3. **DNS-SD TXT** carries `{nodeId, name, fp, bootNonce}`. It is informational, and also used for
   clone detection.
4. **Enrollment answers as today,** plus `{serverKind: 'master', nodeId, caPem}`. The shell stores
   `caPem` beside its registration.

#### A.6.2 Node registration (master ↔ global)

```
admin on lgrai.app ── POST /api/org/:orgId/nodes/enrollment-codes ──▶ global
                      ◀── { code: "XXXX-XXXX", expiresAt (10 min), qr }
setup on the master ── POST /api/node/v1/enroll
                      { code, installationId, name, os, versions, publicKey (Ed25519) }
                      ◀── { nodeId, orgId, orgSlug, linkLevel, serverTime }
```

- **The code.** It follows FR-14.19 and `desktop.service.ts:45-77,189-206`, and is minted by an
  `admin.settings` holder. A second org on the same master needs a second code from that org's
  admin.
- **Ephemeral node keys,** for the vmtest lanes: reusable, gated by `ephemeralKeysEnabled`, every use
  recorded. Ephemeral nodes are reaped after **24 h** of silence, longer than any WAN-cut cell
  (FR-20.113).
- **Tokens.** `POST /api/node/v1/token` takes an EdDSA client assertion `{sub, aud, iat, exp ≤ iat +
  60, jti}` and returns a 15-minute token `{nodeId, keyEpoch, aud: 'lgr-node'}`.
  - It is signed with **`NODE_TOKEN_SECRET`**, which is fatal-if-missing in production
    (`config/src/index.ts:126-151`).
  - `node_assertions` refuses a replayed `jti`.
  - The node row is re-read on every token, connection and page.
- **Global's IdP and licence public keys are built into the signed package** (FR-20.39, FR-20.55).
  They are never learned at registration.

#### A.6.3 The uplink

Two sockets: `wss://lgrai.app/api/node/v1/uplink?ch=interactive` and `…?ch=bulk`. The URL carries no
credential. The master's first frame:

```jsonc
{ "t": "hello", "v": 1, "ch": "interactive",
  "token": "<node access token>",
  "versions": { "app": "2026.11.3", "protocol": 1, "schema": 412, "supto": "1.4" },
  "instanceEpoch": "b3f…", "journalEpoch": 2, "bootNonce": "9c1…",
  "orgs": [ { "orgId": "6a5d…", "epoch": 3, "journalHead": 184233, "chainHash": "…",
              "tailerHealthy": true, "restoreLock": false } ],
  "clock": "2026-11-04T08:12:03.117Z" }
```

Global's reply:

```jsonc
{ "t": "welcome", "serverTime": "…", "minMasterVersion": "2026.10.0",
  "orgs": [ { "orgId": "6a5d…", "homeEpoch": 3, "state": "active",
              "mirror": { "instanceEpoch": "b3f…", "journalEpoch": 2,
                          "watermark": 184101, "chainHash": "…" },
              "linkLevel": "full", "entitlements": "<signed JWS>" } ] }
```

- **Refusals never stop the shop** (FR-20.52, FR-20.94):

  | Signal | What happens |
  |---|---|
  | 4401 unauthenticated | the uplink retries with backoff |
  | 4403 revoked | the uplink stops; a banner; **the supervisor keeps running** |
  | `master_outdated` (control message) | replication and the tunnel stop; the interactive socket stays open for updates |
  | `home_epoch_stale {orgId, fenceCutoff}` (control message) | that org fences (FR-20.8) |
  | 4429 | slow down |

- **A second connection from the same nodeId** while one is live: global accepts neither socket's
  pages or tunnel traffic, sends `clone-alarm` to both, and raises an alarm (FR-20.8, FR-20.51).
- **Liveness:** `{t:'ping'}` every 30 s on each socket; dead after 75 s without a frame.
- **Backoff:** full jitter, 1 s → 5 min, honouring `Retry-After`.
- **Proxy and trust, resolved by the supervisor as the service** (FR-20.53):
  - **Windows:** WinHTTP's machine settings (`WinHttpGetDefaultProxyConfiguration`), WPAD, and
    `WinHttpGetProxyForUrl` with auto-detect, under the service account. A user-scoped call such as
    `WinHttpGetIEProxyConfigForCurrentUser` reads a virtual service account's empty settings.
  - **macOS:** CFNetwork system proxies.
  - **Linux:** `/etc/environment` and the systemd unit environment, then a configured PAC URL.
  - **Everywhere:** an explicit proxy or PAC URL from setup; proxy authentication by Negotiate with
    the machine account, or by stored credentials.
  - **Trust:** rustls with the platform verifier.
- **Pacing.** The bulk socket backs off when the interactive socket's RTT rises above its baseline,
  and holds to about 70 % of the measured upstream (FR-20.52).

#### A.6.4 Replication (bulk socket)

```
master (API builds, supervisor sends)                    global
  page {orgId, epoch, instanceEpoch, journalEpoch,
        fromSeq, toSeq, prevHash, chainHash, rows[]}
        BSON, zstd  ───────────────────────────────────▶  txn:
                                                            check home/epoch/instanceEpoch/journalEpoch
                                                            check prevHash == mirror.chainHash
                                                            per row:
                                                              Org     → updateOne({_id: orgId}, {$set: homeFields})
                                                              R       → replaceOne({_id, orgId}, doc, {upsert})
                                                              S       → updateOne({_id, orgId}, {$set: homeFields}, {upsert})
                                                              delete  → deleteOne({_id, orgId})
                                                            unique-key collision → delete the stale mirror
                                                              doc (same org) + insert + queue resend{coll, ids}
                                                            User.identityId only if sanctioned
                                                            mirror_state.{watermark, chainHash} = page's (last)
  ack {orgId, watermark, chainHash} / resend {coll, ids}  ◀──  commit
```

- **Building a page.** The API builds it over the control socket: `page {org, after, limit}`
  returns BSON. The supervisor sends it.
  - Each row is read **when the page is built** (the latest state) and **projected to home-owned
    fields** for split documents.
  - The chain hash covers each row's `(seq, coll, docId, op, sha256(doc))`.
- **Size:** at most 1,000 rows or 4 MB per page. One page is in flight per org, with up to 4 orgs
  pipelined per master.
- **`nack` reasons:**

  | Reason | Meaning, and what follows |
  |---|---|
  | `home_epoch_stale` | the master fences |
  | `instance_epoch_changed` or `chain_mismatch` | the restored-master flow, A.7.5 |
  | `journal_epoch_changed` | a reconcile, FR-20.70 |
  | `isolation` | stop and alarm |

- **Files** go through the lane `blob-have {sha256[]}` → `blob-want {sha256[]}` (computed **per
  org**) → `blob-chunk {sha256, offset, bytes}`:
  - 1 MB chunks, resumable from global's offset;
  - stored at `<UPLOAD_DIR>/<orgId>/blobs/<sha256>` and recorded in `mirror_blobs`;
  - global serves a mirrored org's file by `(orgId, sha256)`, never by the row's path;
  - every path in a page must be a valid relative path, or the page is refused (FR-20.66).
- **History loss on the master.** `ChangeStreamHistoryLost` bumps `journalEpoch` and re-journals
  every document with a new seq (an upsert). Global answers the new journal epoch's first page with
  `journal_epoch_changed`, and a reconcile (digests per collection) runs before pages flow again.

#### A.6.5 The tunnel (interactive socket)

```jsonc
{ "t": "req",  "sid": 17, "method": "POST", "path": "/api/org/6a5d…/invoices",
  "headers": [["content-type","application/json"], …],      // hop-by-hop and X-LGR-* stripped by global
  "client": { "ip": "93.152.x.x" }, "epoch": 3 }
{ "t": "data", "sid": 17, "b": <binary ≤ 64 KB> }
{ "t": "end",  "sid": 17 }
{ "t": "res",  "sid": 17, "status": 201, "headers": [...] }
{ "t": "window", "sid": 17, "bytes": 262144 }
{ "t": "reset", "sid": 17, "code": "idle" | "too_large" | "home_epoch_stale" }
{ "t": "ws-open", "sid": 19, "path": "/ws/tasks", "headers": [...] }
{ "t": "ws-msg",  "sid": 19, "b": …, "binary": false }
```

- **On the master,** a stream enters the **tunnel ingress**.
  - The supervisor strips `X-LGR-*` again, stamps `source=tunnel`, the client IP and the front
    secret, and proxies to the API's front port.
  - The API answers `/internal/*`, `/api/setup/*` and local-credential sign-in with 404 for a
    `tunnel` request.
  - The desktop-credential gate applies only to `source=lan`.
- **Limits:**
  - 64 concurrent streams per master;
  - bodies up to the app's upload limit;
  - idle measured on bytes, 120 s;
  - long reports and exports run as background jobs (the FR-12 pattern).
- **Global's router:**
  - `Host: <slug>.lgrai.app` → `org_addresses` (active) → the org → its home node (`org_homes`) →
    the pod holding that node's interactive socket (`node_presence`, with a heartbeat), forwarded
    pod-to-pod with an internal token if needed;
  - an unknown label, a retired one and a cloud org's slug get the same answer, so the router is no
    slug oracle;
  - **the edge filter** (FR-20.78): a request with neither a session cookie nor a bearer token
    reaches the master only for static UI GETs outside `/api/`, `/api/auth/idp/*` and WebSocket
    upgrades; anything else gets 401 from global; anonymous requests are rate-limited per address
    and per client IP;
  - a `Domain=` attribute is stripped from every `Set-Cookie`;
  - global never issues its own token or cookie on an org address (FR-20.75).

#### A.6.6 "Sign in with LGR", and local credentials

```
browser / desktop     master                          global (lgrai.app)
  │ GET /auth/login ─▶ │
  │ ◀── "Sign in with LGR"
  │ ── GET /idp/authorize?client_id=<nodeId>&redirect_uri&state&code_challenge (S256) ──▶
  │                    │                    existing sign-in UI on lgrai.app's origin,
  │                    │                    then the membership among the node's orgs
  │ ◀── 302 redirect_uri?code&state   (desktop: lgr://login via the system browser, FR-14.14)
  │ POST /auth/idp/redeem {code, verifier} ─▶ │
  │                    │ ctl: idp-redeem ──────────────▶ │ code: 60 s, single use, bound to
  │                    │                                 │ nodeId + redirect + challenge
  │                    │ ◀── assertion: JWS(EdDSA, IDP key)
  │                    │     {iss:"lgrai.app", aud:nodeId, sub:iid, email, tv, amr, exp:+5 min}
  │                    │ verify (IDP key built into the package) → User{identityId: iid, orgId}
  │                    │ → master session (master JWT_SECRET; __Host- cookie on a node host)
  │ ◀── { token, user, org }  (the shape of /auth/login)
```

- **`redirect_uri`** must be one the node registered: the address of each org it is home for
  (`https://<slug>.lgrai.app/auth/idp/callback`), and `lgr://login`.
- **The authorize page is an SPA page on lgrai.app** that reads the person's session from the tab
  (bearer). The navigation from an org's address is same-site, and lgrai.app ignores its cookies
  on same-site requests (P0a-8), so a cookie-based authorize endpoint would never see a session.
- **Local credentials are set on lgrai.app,** under *Account → On-prem servers*.
  - Global refuses a password equal to the person's global password (checked against the global
    hash at set time).
  - It stores an argon2id verifier in `onprem_credentials`, and delivers it **sealed to the node
    key**: `cred-sync`, in the move bundle, and after any change.
  - The master stores the verifier in `local_credentials`.
  - Local sign-in is accepted on `source=lan|console` only, with backoff (FR-20.40).

#### A.6.7 Control messages (interactive socket)

| Message | Direction | Purpose |
|---|---|---|
| `health {…}` | m → g | Every 60 s: versions, disk, `mongod`, oplog window, journal lag per org, last backup, desktops online, fiscal device states, restore lock. |
| `entitlements {orgId, jws}` | g → m | On change and daily; verified against the built-in licence key. |
| `identity-changes {cursor, items[]}` | g → m | `{iid, email, firstName, lastName, tv, active}` for members; the master updates its copies and ends sessions. |
| `cred-sync {identityId, orgId, kind, sealed}` | g → m | Local-credential verifiers, sealed to the node key (FR-20.40). |
| `idp-redeem` / `idp-assertion` | m ↔ g | A.6.6. |
| `relay {outboxId, kind, payload}` → `relay-result` | m → g → m | Mail, VAT, LLM, invite-create; idempotent by `outboxId`, 7-day dedupe. |
| `reference {kind: 'din' \| 'fx-system', since, items[]}` | g → m | FR-20.87. |
| `update-offer {component, channel, version, supto, declared}` | g → m | The helper resolves and verifies it itself; undeclared SUPTO versions wait. |
| `home {orgId, epoch, state, fenceCutoff?}` | g → m | Freeze, unfreeze, fence, hold. |
| `master_outdated` | g → m | FR-20.58. |
| `clone-alarm {nodeId, addresses}` | g → m | FR-20.51. |
| `member-join {orgId, inviteId, iid, role}` | g → m | A.6.8. |
| `resend {orgId, coll, ids}` | g → m | A.6.4 collisions. |
| `desktop-repoint` | old home → its desktops (`/ws/desktop`) | FR-20.82: signed by the old home; `{server, caPem}`; the desktop keeps its id and key. |

#### A.6.8 Joining an on-prem org

1. **The admin creates the invite on the master.** The master asks global to create the global
   `Invite` row (`relay {kind:'invite-create'}`).
2. **The person accepts at lgrai.app** (`invite.controller.ts:17,48` → `account.service.ts:138`).
   Global sanctions `(iid, orgId)` but does **not** create the `User` (FR-20.5). It sends
   `member-join`, and the master creates the membership.
3. **If the master is offline,** the acceptance is recorded as pending and delivered on reconnect.
4. **The person sets their local credential** under their account. It is delivered by `cred-sync`.

#### A.6.9 The move state machine (on global, per org)

```mermaid
stateDiagram-v2
  [*] --> active_global
  active_global --> preflight: start (admin)
  preflight --> active_global: fail (POS open, import running, credentials missing, master unhealthy)
  preflight --> freezing: ok
  freezing --> copying: org_frozen + 2× home-cache TTL elapsed + enrollment codes/keys revoked
  copying --> verifying: bundle (no secrets, relative paths) + sealed credential verifiers
  copying --> active_global: abort (unfreeze)
  verifying --> active_global: digest mismatch (abort)
  verifying --> flipped: digests equal
  flipped --> repointing: epoch+1, home=master, homeEpochHighWater=epoch, mirror chain = master's seed head
  repointing --> active_master: GLOBAL sends desktop-repoint (desktops are connected to it), master unfrozen
  active_master --> [*]
```

- **Every transition** is an audit entry and a step in `org_moves.steps`, and every step is
  idempotent.
- **The reverse move** (`to_global`) waits for `watermark == head` **and** `mirror_blobs` complete,
  and **the master** sends the re-point.
- **`promote`** has no copy step. It requires `evidence` (FR-20.81), and it leaves global's legal
  series frozen after the flip until the site's last numbers are recorded.

### A.7 Sequence diagrams

#### A.7.1 A sale on the LAN, with a crash between save and print

```mermaid
sequenceDiagram
  participant T as Till (lgr-web)
  participant P as Shell proxy 127.0.0.1
  participant S as Supervisor (LAN ingress)
  participant A as Master API
  participant B as Bridge (Rust, till)
  participant F as ФУ (serial)
  T->>P: POST …/pos/session/S/transaction  Idempotency-Key: k1
  P->>S: same, pinned TLS + X-LGR-Desktop-Token
  S->>A: strip X-LGR-*, stamp source=lan, front secret
  A->>A: find POSTransaction{clientKey:k1}? none
  A->>A: generateUNP(device) — one counter per ФУ
  A->>A: save POSTransaction{clientKey:k1, requestHash, unpNumber, fiscal.state:pending}
  A->>B: fiscal:command (ISL frames) over /ws/fiscal-bridge
  B->>F: bytes
  F-->>B: answer (receipt n)
  B-->>A: fiscal:response
  A->>A: fiscal.state = printed, receiptNo = n
  A-->>T: 201 {transaction, receiptNo}
  Note over A: crash after the save, before the print?
  T->>A: retry with k1 (same body)
  A->>A: found, fiscal.state = pending
  A->>B: query the device's last receipt
  alt the device's last receipt carries this УНП
    A->>A: mark printed
  else
    A->>B: print once
  end
  A-->>T: 201 — never a second sale, УНП or receipt
```

#### A.7.2 The WAN drops and returns

```mermaid
sequenceDiagram
  participant S as Master supervisor
  participant A as Master API (tailer + journal)
  participant G as Global
  Note over S,G: connected — pages flow within seconds
  S-xG: WAN down (no frame for 75 s → socket dead)
  Note over A: tills keep selling, and the journal keeps one row per changed doc (bounded)
  Note over A: mail, VAT and LLM wait in the outbox (deterministic ids)
  Note over G: lgrai.app serves the org read-only, as of 14:01, and the org address shows a notice
  S->>G: reconnect (backoff + jitter) → hello {journalHead, chainHash}
  G-->>S: welcome {watermark, chainHash}
  loop until watermark == head (bulk paced against interactive RTT)
    S->>G: page (prevHash matches)
    G-->>S: ack
  end
  S->>G: relays (once each, by outboxId)
  Note over G: the notice clears, and the tunnel resumes
```

#### A.7.3 A remote edit through the tunnel

```mermaid
sequenceDiagram
  participant U as Owner's browser (at home)
  participant G as Global router
  participant S as Master supervisor (tunnel ingress)
  participant A as Master API
  U->>G: PUT https://regal-pz.lgrai.app/api/org/X/products/P
  G->>G: strip X-LGR-*, check that a credential is present, Host → org → home node → pod
  G->>S: req sid=17 (+ client ip, epoch)
  S->>A: stamp source=tunnel + front secret → front port
  A->>A: authorise with the master's session (__Host- cookie / bearer)
  A-->>S: 200
  S-->>G: res sid=17 200
  G-->>U: 200 (Set-Cookie Domain= stripped)
  Note over A,G: journaled and mirrored within seconds, and the tills see it at once
```

#### A.7.4 Cloud → master move

```mermaid
sequenceDiagram
  participant Ad as Admin (lgrai.app)
  participant G as Global
  participant S as Master
  participant D as Org's desktops (connected to global)
  Ad->>G: start move (regal-pz → node)
  G->>G: preflight: no POS session, fiscal command or import, master healthy, every person has a local credential
  G->>G: freeze (org_frozen), wait 2× the home-cache TTL, revoke enrollment codes and keys
  G->>S: bulk: export stream (relative paths, no password copies, no integrations, no FR-20 state)
  G->>S: sealed local-credential verifiers
  S->>S: import into the EMPTY org (its own path, not FR-13 Replace), create collections, seed the journal
  S-->>G: digests per collection + journal head + chain hash
  G->>G: compare → equal
  G->>G: epoch 3→4, home = node, homeEpochHighWater = 4, mirror chain = master's head
  G->>D: desktop-repoint {server, caPem} (signed by global)
  D->>S: same desktop id and key, tokens minted at the master, bridge restarts in place
  G->>S: home {epoch:4, state:active} → unfreeze on the master
  G-->>Ad: done + the Прил. 32 fields to file within 7 days
```

#### A.7.5 A restored (or snapshot-reverted) master

```mermaid
sequenceDiagram
  participant S as Master (went back in time)
  participant F as ФУ
  participant G as Global (mirror is newer)
  S->>S: boot: journal head < outside high-water mark → restore lock on every legal series
  S->>F: last receipt?
  F-->>S: receipt above the DB's → evidence confirmed
  S->>G: hello {journalHead: 1200, chainHash: X}
  G-->>S: nack chain_mismatch (watermark 1450, chain Y)
  Note over S: admin starts "recover from the mirror"
  S->>G: request the full org (re-seed, not a merge)
  G-->>S: every document + file as the mirror holds it (nothing on the mirror deleted)
  S->>S: replace the org's data, counters = max(mirror, device, person-read last numbers)
  S->>S: new instanceEpoch, reseed the journal, lift the lock
  S->>G: pages resume
```

An Air-gapped master has no mirror. It keeps the lock until a person enters the last issued numbers,
checked against the device's report, and resumes above them.

#### A.7.6 A lost master

```mermaid
sequenceDiagram
  participant Ad as Admin (lgrai.app)
  participant G as Global
  participant S as Old master (cut off, maybe still selling)
  Ad->>G: promote (attestation: master off or destroyed, tills disconnected, ≥ 24 h of silence)
  G-->>Ad: shows the loss window AND the duplicate-number risk, admin types the slug
  G->>G: epoch 4→5, home = global, fenceCutoff = watermark (14:01)
  G->>G: legal series FROZEN until the site's last numbers are recorded
  Ad->>G: records last invoice / receipt numbers from the site's paper and device report
  G->>G: series resume above them
  S->>G: hello {epoch:4}
  G-->>S: home_epoch_stale {fenceCutoff}
  S->>S: fence, export everything above fenceCutoff (sealed)
  Ad->>G: review → audited import (Прил. 42 model), a collision → credit note + re-issue
```

### A.8 Where every job runs

| Job (today's anchor) | On a master | On global, for an on-prem org | Notes |
|---|---|---|---|
| Fiscal status reset (`unified.ts:157-162`) | its orgs only | skipped | `status` is node-local. |
| Time sync (`unified.ts:165-171`) | yes, its printers | n/a | Pushes only a verified clock (FR-20.22). |
| Daily digest (`:177-184`) | yes, mail through the outbox | skipped | Deterministic outbox id; a day counts as done only after its mail is sent. |
| Backup (`:189-195`) | yes: local + off-site/vault | skipped (global's Layer-1 dump still covers the mirror) | FR-20.21; residency. |
| Retention (`:206-212`) | its orgs | skipped | `stripSettledCompareSummaries` gains an org filter (`retention.service.ts:97-104`). |
| Desktop reaper (`:220-227`) | its desktops | skipped | |
| Migrations (`packages/migrations`) | its orgs | only orgs whose home is global | FR-20.5. |
| Mongo TTL indexes | `mongod` | `mongod` | |
| Files analyze/commit, manual backups (`background/task.service.ts`) | yes | refused (writes) | Stale `processing` rows are failed by owner heartbeat. |
| Archive (manual, `file.controller.ts:442-492`) | yes | refused | |
| **New:** tailer, page builder, high-water mark, restore lock | yes | — | P3 / P1. |
| **New:** mirror applier, tunnel router, IdP, relays, move orchestrator, `cred-sync` | — | yes | P2–P3. |
| **New:** outbox worker, identity-feed apply, licence check | yes | — | P2. |
| **New:** reconcile | both | both | One-way; the home wins (FR-20.70). |
| **New:** update helper | supervisor | — | P1. |

### A.9 Trust boundaries and secrets

| Boundary | Authenticated by | Secret lives |
|---|---|---|
| Browser ↔ global | user JWT (global `JWT_SECRET`): the tab's bearer token; `__Host-` cookies, ignored on same-site requests (P0a-8) | `lgr-secret` |
| Browser ↔ master (tunnel, `<slug>.lgrai.app`) | master session (master `JWT_SECRET`, `__Host-` host-only cookie), via the IdP; global checks only that a credential is present (FR-20.78) | master `keys/` |
| Desktop ↔ supervisor (LAN) | pinned master CA (key held by the supervisor) + desktop token (master `DESKTOP_TOKEN_SECRET`) + the user's master session | master `keys/`; the desktop's key in its keystore |
| Supervisor ↔ API | front secret (per boot) on the front port; the control socket's OS permissions | memory; socket ACL |
| Master ↔ global (uplink) | node assertion (Ed25519) → node token (`NODE_TOKEN_SECRET`); OS-store TLS | node key in master `keys/`; `NODE_TOKEN_SECRET` in `lgr-secret` |
| Global → master assertions | `IDP_SIGNING_KEY`, `LICENCE_SIGNING_KEY` (Ed25519) | `lgr-secret`; public halves **built into the package** |
| Global → master credentials | sealed to the node key | `onprem_credentials` (global), `local_credentials` (master) |
| API ↔ `mongod` (master) | SCRAM + keyfile, on loopback | master `keys/` |
| **Never on a master** | SendGrid, Stripe, OAuth client secrets, Claude/Anthropic, Drive client, `DESKTOP_RELEASE_GITHUB_TOKEN`, global `JWT_SECRET`/`DESKTOP_TOKEN_SECRET`, the seal private key (D-12) | — |

### A.10 Failure modes

| What fails | What the shop sees | What a remote user sees | Recovery |
|---|---|---|---|
| Internet line | nothing | read-only at lgrai.app, "as of …" | automatic catch-up |
| Master PC off or crashed | tills: "server not answering — retrying"; кочан if it lasts | read-only at lgrai.app | service restart; standby master (P4) |
| `mongod` or API crash | the same, for seconds | the same | supervisor restarts it; idempotent retries |
| A till's LAN cable | that till retries; no double sale | — | reconnect |
| Master address changed (DHCP) | a short blip | — | desktops find it by nodeId (FR-20.28) |
| A global pod restart | nothing | in-flight requests fail, then reconnect | the uplink reconnects |
| Master revoked on global | a banner; **sales continue** | read-only mirror | re-register, or a move |
| Master fenced (another node became home) | **tills stop writing for that org**, banner says why | the org is writable wherever its new home is | export + audited import (FR-20.84) |
| A bad release on the master | — | — | crash-loop → pointer back to `last_known_good`, offline |
| Power loss during an update | — | — | the helper finds the pointer and versions on disk; switches back if the new version is not healthy |
| Master restored from a backup / snapshot reverted, WAN down | legal issuing **locked** until evidence is entered | — | re-seed from the mirror when linked; person + device evidence when not |
| A cloned master | both lock their legal series, alarm | — | sys-admin picks the real one; the other is re-installed |
| Master clock jumped (CMOS reset) | the time sync refuses to push; a banner | — | a person confirms after the clock is corrected |
| Master disk full | alarm at 10 %; writes fail before data does | — | free space; backups elsewhere |
| Tailer history lost | nothing at the shop | mirror paused | journal epoch bump → reconcile → resume |
| Master disk dies | tills stop | read-only at lgrai.app | **replace**: promote + move to the new PC (FR-20.81); desktops re-pair |
| Master stolen | tills stop | read-only | promote; revoke the node |
| Global down | nothing | lgrai.app down | — (relays queue) |
| Global restored from an old dump | nothing | the org is in `hold` (read-only) | its node reconnects or a sys-admin releases it |
| Mirror page refused (isolation, chain) | nothing | mirror lags | alarm; a person inspects |
| A desktop missed a CA rotation or a re-point | that desktop cannot connect; a clear message | — | one-action re-register |

---

## Part B — Implementation

### B.0 How to read the steps

- **What each step lists:**

  | Field | Meaning |
  |---|---|
  | Touches | existing code, with anchors |
  | Adds | new files |
  | Tests | what proves it |
  | AC | FR-20 §10 numbers |
  | Size | S ≤ 2 days · M ≤ 1 week · L = 1–3 weeks, for one developer |

- **Kill switches** for every step are in the B.10 table.
- **Step ids** look like `P0a-1` and `P1-6`.
- 🏗 marks a step that touches production infrastructure.
- **Every step is one PR** off `origin/master`, in a worktree. It runs `bun run test` and `bun run
  build`, plus `bun run test:e2e` where the UI changes, and passes CI's Linux gate (self-hosted on
  mars since #126).

### B.1 P0a — Fixes and hardening the rest depends on

**P0a-1 — Every by-id route scoped by org** (FR-20.7) · M
- **Touches** every route that reads, updates or deletes a document by id. The step generates the
  inventory from the route table.
- **Adds:**
  - `findByIdInOrg`, `updateInOrg` and `deleteInOrg` on the DAL base repository;
  - a body schema on every PUT, rejecting `orgId` (with CLAUDE.md's open item on missing body
    schemas);
  - `orgId:null` exchange rates read-only through org routes.
- **Tests:** `tenant-isolation.flow.test.ts` gains a by-id probe over the real route table (a
  document in org A, called as org B → 404); the same in the e2e `security` project.
- **AC 5.** Must land before P3-2.

**P0a-2 — PDF rendering that opens no socket** (FR-20.25) · M
- **Touches:** `reporting/src/pdf/base.pdf.ts`.
  - markdown → HTML with `marked`;
  - `puppeteer.launch({executablePath: config.pdf.chromePath, pipe: true})`;
  - `page.setContent(html)`, then `page.pdf()`;
  - `--no-sandbox` only as root.
- **Tests:**
  - the 68 export tests and the FR-06 PDF tests pass unmodified;
  - a unit test asserts no new listening socket during a render (hook `net.Server.prototype.listen`
    and check the OS socket table).
- **AC 10.**

**P0a-3 — `/ws/tasks` authenticates in its first message** (FR-20.78) · S · [#154](https://github.com/gjovanov/lgr/issues/154)
- **Touches:** `portal-api/src/websocket/ws.server.ts:31-69` and the `useWebSocket` client.
- **The pattern:** the same first-message-within-10-s structure as `/ws/desktop`
  (`websocket/desktop.ts:66-112`), but carrying the user's bearer token. `/ws/desktop` carries a
  desktop token.
- **AC 11.**

**P0a-4 — Idempotent hot path, crash-safe** (FR-20.37) · M · [#155](https://github.com/gjovanov/lgr/issues/155)
- **Adds:**
  - `clientKey` and `requestHash` on `POSSession`, `POSTransaction`, `Invoice` and
    `Invoice.payments[]`, with a unique `{orgId, clientKey}` per collection;
  - `POSTransaction.fiscal{state, receiptNo, printedAt}`;
  - a `services/biz/hot-path-key.ts` helper: find by key → compare hash → return, resume or 422.
- **Touches:** `pos.controller.ts:303,409,568,825`; the cash-sale create, invoice `/send` and
  payment-record routes; `pos-ui` and the invoicing forms (one key per attempt, reused on a retry).
- **The resume rule:** on `fiscal.state=pending`, ask the device for its last receipt before
  printing. The Eltrade and Tremol drivers expose it, and the Eltrade driver already voids an
  interrupted open receipt.
- **Tests:**
  - 5 concurrent same-key requests → one document, one movement, one fiscal command, on the Eltrade
    simulator (`tests/helpers/eltrade-simulator.ts`);
  - a kill between the save and the print, then a retry → one receipt;
  - same key, different body → 422.
- **AC 7, 18, 57.**

**P0a-5 — One УНП counter per fiscal device, rollback-safe** (FR-20.45) · S · [#156](https://github.com/gjovanov/lgr/issues/156)
- **Lands after P0b-7** (its runner) and P0b-6 (its guard): the device is not fiscalised yet, so the
  order costs nothing.
- **Touches:** `services/biz/sequence.service.ts:67-92`. The key becomes `UNP-<device>`.
- **Adds:** migration `0002-unp-per-device`. Per device, the counter becomes the maximum of every
  `UNP-<device>-*` counter and of the highest `unpNumber` suffix (`pos.controller.ts:619`).
- **Rollback safety, for one release:** each allocation also `$max`es the old per-operator counters
  to the device maximum, so a rolled-back binary still cannot re-issue a number.
- **Tests:** two operators → consecutive suffixes; the first number after the migration is above
  every issued one; a rollback simulation (the old allocator after the new) → no repeat.
- **AC 12.** ⚠ This is a SUPTO-relevant change: `docs/supto/DATABASE-SCHEMA.md` and
  `FUNCTIONAL-DESCRIPTION.md` §2 are corrected in the same PR.

**P0a-6 — Schedulers independent; tasks owned** (FR-20.23) · S
- **Touches:** `unified.ts:153-229` becomes a `schedulers` registry, each scheduler with its own
  `try/catch` and a health record.
- **Adds:** `BackgroundTask.owner{process, pod, heartbeatAt}`. At boot, only tasks whose owner's
  heartbeat is stale are failed.
- **AC 6** (in part).

**P0a-7 — Timeouts on every outbound call** (FR-20.53) · S
- **Touches:**
  - `email.service.ts:117-138`;
  - `company-lookup.service.ts:47,164`;
  - `oauth.service.ts:316-339`;
  - `backup-destinations.service.ts`;
  - `s3-client.ts:180`;
  - `release-download.ts:169-181` (the redirect hop).
- **Each call** gets an `AbortSignal.timeout`.
- **Tests:** a black-holed address fails within the timeout.

**P0a-8 — lgrai.app made safe to have subdomains** (FR-20.72, D-13) · M
- **Why:** org addresses (`regal-pz.lgrai.app`) are same-site with lgrai.app. A master's
  JavaScript could otherwise plant cookies lgrai.app reads, and a master's pages could make
  same-site requests that carry the person's lgrai.app cookie.
- **Touches:**
  - `portal-api/src/auth/session-cookie.ts` (`auth`), `auth/handoff-cookie.ts` (`oauth_handoff`,
    `oauth_pending`) and `controllers/oauth.controller.ts:49-51` (`oauth_state`) take `__Host-`
    names, `Path=/` and `Secure` always (browsers treat `http://localhost` as secure, so dev keeps
    working);
  - `services/biz/session-token.ts`, the rules all eight auth plugins share, ignores a cookie on a
    request whose `Sec-Fetch-Site` is `same-site`. A browser that sends no fetch metadata falls back
    to an `Origin` check on writes;
  - response headers: `Cross-Origin-Resource-Policy: same-origin` and `Origin-Agent-Cluster: ?1`.
    The CORS allow-list never matches a subdomain.
- **Two releases:** release N writes both names and reads either. Release N+1 reads only the
  `__Host-` names. Both ship before P3-4, while no subdomain serves anything. Nobody is signed out:
  the SPAs authenticate with the tab's bearer token, and only a cookie-only request (a plain
  download link) needs a fresh sign-in after the switch.
- **Tests:**
  - a planted plain `auth` cookie is ignored;
  - a same-site request carrying the session cookie answers 401;
  - the OAuth callback, a cross-site navigation, still signs in;
  - the suites that read cookie names (`oauth-pending-registration.flow.test.ts`,
    `auth-precedence.flow.test.ts`) move to the new names.
- **AC 39.** Must land before P3-4. It is off the critical path.

### B.2 P0b — Foundations (no behaviour change on global)

**P0b-1 — Node role and config** (FR-20.1, FR-20.17) · S · [#157](https://github.com/gjovanov/lgr/issues/157)
- **Touches:** `packages/config/src/index.ts`.
  - `node: {role, id?}` and `pdf: {chromePath}`.
  - Cloud-only secrets are optional when `role=master`.
  - `requiredSecret` (`:126-151`) also refuses the values in `.env.example` and the compose files.

**P0b-2 — Home registry, gate by effect, and the Mongoose write guard** (FR-20.3, FR-20.4) · L
- **Adds:**
  - `db/models/org-home.model.ts` and `Org.homeEpochHighWater`;
  - `packages/node/src/home/home.service.ts`: `homeOf` with a 5 s cache and change-stream
    invalidation on global; `isHomeHere`; `hold` when the two records disagree;
  - `home-guard.ts`, import-pure;
  - a route marker (`readOnly`), declared on every route; reports and POST exports are `readOnly`;
  - a **Mongoose plugin**: on any save, update, insert or delete of an org-scoped model, it refuses
    when `!isHomeHere(orgId)`, and refuses any write inside a read-only request context
    (`AsyncLocalStorage`);
  - an **explicit list** of the application's raw and bulk write sites, each guarded, plus a test
    that fails on any new site;
  - legal allocations (`sequence.service.ts`, `invoice-numbering.service.ts`) read the home record
    inside their transaction.
- **Touches:** registered beside `isForeignOrg` at `portal-api/src/auth/auth.service.ts:83` and
  `app-auth.service.ts:80` in seven packages.
- **Tests:** `home-gate.flow.test.ts` walks the route table:
  - every route is classified;
  - every writing route → 409 for a foreign-home org;
  - `readOnly` routes write nothing (the context makes them throw);
  - a service-level write to a mirrored org is refused by the plugin.
- **AC 1, 2, 56.**

**P0b-3 — Cross-org writers, sweeps and migrations** (FR-20.5) · M
- **Touches:**
  - `identity/account.service.ts:35-46,127-128` and `identity.service.ts:290-336` skip
    foreign-home memberships;
  - org creation (`services/src/biz/auth.service.ts:193-198`; `account.service.ts:169`;
    `oauth.service.ts:655`) and invite accept (`account.service.ts:138`) refuse foreign-home orgs;
  - desktop enrollment refuses foreign-home orgs;
  - `unified.ts:157-162` is filtered by home;
  - `retention.service.ts:97-104` gains an org filter;
  - the migrations runner is filtered by home.
- **AC 3.**

**P0b-4 — Reads that write** (FR-20.6) · S
- **Touches:**
  - `invoice-export.controller.ts:363-377` (`ensureCompanionNumber`) asserts the home and checks it
    inside its claim;
  - `app-hub.service.ts:24-37` skips the lazy insert off-home.
- **Adds:** a committed list of GET-reachable writers, with a test.
- **AC 4.**

**P0b-5 — Schedulers gated by home** (FR-20.85) · S
- **Touches:** the org loops of the digest (`digest-runner.service.ts:185-218`), backup
  (`backup-runner.service.ts:557-608`) and reaper (`desktop.service.ts:575-588`). Retention is
  covered in P0b-3.
- **AC 6.**

**P0b-6 — Scripts refuse to write elsewhere** (FR-20.4) · S
- **Adds:** `scripts/lib/home-guard.ts`, plus a scan test over `scripts/*.ts`.
- **Touches:** every writing script, and `scripts/backfill-movement-reference.ts:46-131`, which reads
  the non-existent `organizations` collection: fix it, and require `--org`.

**P0b-7 — Versioned migrations run themselves** (FR-20.19) · M
- **Adds:**
  - `packages/migrations/src/runner.ts`: discover, lock, run in order, record, and refuse a changed
    checksum;
  - `0000-baseline`;
  - `lgr-api migrate`;
  - filtering by home.
- **Touches:** `unified.ts`, which migrates before `listen` when `MIGRATIONS_AUTO=true`. That is the
  default on masters; global switches it on after one release of the CLI in `deploy-prod.sh`.
- **Tests:** every migration runs twice on a seeded database.
- **AC 8.**

**P0b-8 — Relative file paths, expand then contract** (FR-20.24) · M
- **Release N** ships `services/biz/files/stored-path.ts`:
  - `toStored(abs) → rel`;
  - `resolveStored(rel | legacyAbs)`;
  - validation: no `..`, no absolute path, no drive letter.

  Every reader uses it, and `File.sha256` is added and backfilled.
- **Release N+1** switches the writers and runs `0001-relative-file-paths`. The writers are:
  - `doc-store.service.ts:28,155,187,193,216`;
  - `file.service.ts:16-23,57`;
  - `archive.service.ts:51-57,229,345`;
  - `backup-restore.service.ts:502-506,706`;
  - `doc-import.controller.ts:90-97`;
  - `bill-import.controller.ts:41-48`.
- **AC 9.**

**P0b-9 — A reproducible, allow-listed server build** (FR-20.25, FR-20.26) · M
- **Touches:**
  - `.gitignore:7` (commit `bun.lock`; CI uses `--frozen-lockfile`);
  - `.dockerignore` (S-10);
  - the `Dockerfile` runtime stage, built from the allow-list.
- **Adds:**
  - `build:server`: `bun build … --target=bun` with mongodb's optional native modules as externals.
    The bundle carries the 8 UI `dist/` folders, fonts, the vetted-script allow-list and its scripts,
    and `server-manifest.json`;
  - `scripts/check-package.ts`, which fails on any of: gitignored paths, `.secrets/`, `*.seal.key`,
    `.env*`, `lgr-secret` key names, a third-party script origin in a built UI, or any allow-listed
    script that writes `Invoice`, `POSTransaction` or `CashOrder`.
- **Spike:** `bun build --compile --target=bun-<os>-<arch>-baseline`. Adopt it if it boots and
  renders a PDF.
- **AC 21, 66, 67.**

**P0b-10 — Bundles exclude FR-20 state** (FR-20.3) · S
- **Touches:** `backup-bundle.service.ts:62-79`. `tenantCollections()` excludes the metadata's
  node-state list.
- **Tests:** a bundle of a seeded org contains none of them; every model with an `orgId` is
  classified.
- **AC 55** (in part).

**P0b-11 — Docs** · S
- `CLAUDE.md`: 70 models.
- `docs/architecture/desktop.md` and `overview.md`: made current.
- `docs/architecture/nodes.md`: Part A of this plan.
- `docs/supto/` corrections, as listed in FR §2.8.

### B.3 P1 — The master, on its own (Air-gapped)

**P1-1 — Supervisor skeleton** (`packages/server`, Rust) · L
- **Adds:** subcommands `service install|uninstall|run`, `status --json`, `diagnostics`,
  `backup now`, `run-script <allow-listed name>`, `setup-token`, `update-helper`.
- **Windows:** `windows-service`. Recovery 5/30/60 s with a 24 h reset (roomler
  `win_service/mod.rs:234-268`). The service runs as `NT SERVICE\LGRServer`; `LGRServerUpdate`
  (LocalSystem) runs the helper.
- **Linux and macOS:**
  - `lgr-server.service` (`User=lgr`, `Restart=always`, `RestartPreventExitStatus=7 8`);
  - `lgr-server-update.{service,path}` (root, woken by a wake file whose content is ignored);
  - LaunchDaemons on macOS.
- **Children** run in a Job Object or process group, with backoff from 2 s to 60 s.
- **IPC:** NDJSON over a pipe or socket, with a pool of 4 listening instances (roomler
  `crates/localapi`).
- **Tests:** Rust unit tests; a CI job installs the service on Windows and Linux, kills children,
  and asserts the restarts and the exit codes.

**P1-2 — `mongod` under the supervisor, and the machine check** (FR-20.13, FR-20.15) · L
- **Adds:**
  - checksum-pinned MongoDB 7.0 binaries per OS and arch (`mongod.lock`);
  - **first boot:** keyfile → `mongod --replSet rs0 --bind_ip 127.0.0.1 --port <chosen> --auth
    --keyFile` → `rs.initiate` → the SCRAM user;
  - the WiredTiger cache capped (0.5 GB by default below 8 GB of RAM, the 2026-10-08 OOM lesson);
  - the oplog sized for at least 30 days of the hosted orgs' writes (FR-20.15): 2 GB to start,
    with the window it actually holds shown on the status page and raised before it drops under
    30 days;
  - **explicit creation of every replicated collection** with `changeStreamPreAndPostImages`, from
    the metadata;
  - **preflight**, in the MSI custom action and in `lgr-server preflight`: AVX by CPUID or
    `/proc/cpuinfo` or `sysctl`; ARMv8.2; RAM; disk; path type; VC++;
  - the FCV routine for major upgrades.
- **Tests:** a CI matrix boot; vmtest `no-avx` on Linux and on Windows.
- **AC 14.**

**P1-3 — The supervisor's ingresses, and the API behind them** (FR-20.16, FR-20.18, FR-20.23) · L
- **Supervisor:**
  - **the LAN ingress:** rustls on the master's certificate, held by the supervisor, on port 4443;
    the source stamp; WebSocket upgrade passthrough;
  - **the console ingress** on loopback, during setup only, opened with the one-time setup token;
  - **header stripping;**
  - **the egress proxy:** CONNECT on loopback, with the machine proxy, PAC and authentication, and
    the OS roots exported to `NODE_EXTRA_CA_CERTS`.
- **API:**
  - one HTTP listener on `127.0.0.1:<front port>` (`unified.ts:109`), requiring the front secret and
    a `Host` on its allow-list;
  - a control socket for `status`, `stop` and `page`;
  - `source` read from the stamp, never from the client;
  - `/internal/*` and `/api/setup/*` refused on HTTP;
  - the desktop-token gate for `source=lan`;
  - Swagger off; register and orgs off outside setup.
- **Tests:**
  - LAN without a token → 401;
  - a forged `X-LGR-*` never reaches the API;
  - `/internal/*` → 404 through the LAN and the tunnel;
  - the WebSocket endpoints work through the LAN ingress;
  - setup without the token → refused.
- **AC 15, 47, 48.**

**P1-4 — Certificates and the outside high-water mark** (FR-20.30, FR-20.51) · M
- **Adds**, in the supervisor:
  - the CA and leaf certificate (`rcgen`), with SAN refresh on an address change;
  - the CA's SPKI fingerprint exposed over IPC and DNS-SD;
  - rotation announced a week ahead;
  - `keys/journal-hw`: the last journal seq and chain hash per org, written after each page is
    built, outside the database;
  - the boot comparison with the database's head → the restore lock.

**P1-5 — People on a master** (FR-20.40, FR-20.41, FR-20.42) · M
- **Adds:**
  - `local_credentials` and a local sign-in route (LAN and console only, with backoff);
  - for an Air-gapped master, full local `Identity` handling (FR-19's model);
  - for a linked master, refusal of person edits (`applyAdminIdentityEdit`, `identity.service.ts:
    288-336`), pointing to lgrai.app;
  - a PIN pad in `pos-ui` (×4 locales).
- **Tests:** no lockout (backoff); a tunnel request for local sign-in → 404; Air-gapped people
  management.
- **AC 64, 65** (Air-gapped part).

**P1-6 — Desktop: discovery, pairing, pinned trust, proxy** (FR-20.28–20.36) · L
- **Adds:**
  - `src/discovery.rs`: `DnsServiceBrowse` on Windows, `mdns-sd` elsewhere; finding a master by
    nodeId;
  - `src/trust.rs`: the one client;
  - `src/proxy.rs`: `hyper` on a stable port, the boot secret, Host and Origin checks, WebSocket
    upgrades, storage cleared on re-point.
- **Touches:**
  - `src/enroll.rs:3-7,36-42` (`trust.rs`, `caPem`, `fp`, six words);
  - **`src/presence.rs:115`** and **`src/install.rs:371,391-397`**, which move onto `trust.rs`: the
    updater fetches the manifest and the bytes through it, and its two signature checks are
    unchanged;
  - `src/validate.rs:97-127` and `desktop-ui/src/server-url.ts:22-60` (one rule, with a shared table
    test);
  - `src/settings.rs:32-33,42`;
  - `src/bridge.rs:271-305,476`;
  - `src/main.rs:523-545` (restart in place);
  - the onboarding and unreachable pages.
- **Tests:** pin mismatch refused; Host check; missing secret; the CDP walk against a local master;
  a forged server refused.
- **AC 16.**

**P1-7 — Packaging and release** (FR-20.10, FR-20.12) · L
- **Adds:**
  - **the MSI** (`packages/server/wix/main.wxs`): per-machine; a deferred non-impersonated custom
    action creates the service and never starts it inside the action;
  - **versioned directories:** `versions/<v>/` plus a `current` pointer. The MSI installs the first
    version and the helper adds the rest;
  - **the firewall rule** on the Domain, Private and Public profiles, `RemoteAddress=LocalSubnet`;
  - **Linux packages:** `.deb`, `.rpm` and a tarball, with maintainer scripts that reload but never
    start or stop;
  - **the Compose bundle**, which replaces the dead `start:unified` (`docker-compose.yml:39`);
  - **`server-release.yml`:** roomler's `sign-windows@<sha>`, GPG `.asc`, SLSA, a hard fail when
    unsigned, and the `supto` and `declared` release fields;
  - **`installer-smoke`;**
  - **the SSPL source offer.**
- **AC 13, 21.**

**P1-8 — The server updater** (FR-20.20) · L
- **Adds** to the helper:
  - it resolves the manifest itself (lgrai.app's public signed manifest, or a local file when
    Air-gapped);
  - it downloads into a SYSTEM/root-owned staging directory;
  - two signatures, and the version read from inside the bytes;
  - it installs into `versions/<v>/`, switches `current` and restarts the service;
  - it confirms the service is up, and switches back if not;
  - it keeps two versions.
- **Supervisor:**
  - the window and the deferrals, read from the control socket's `posOpen` and `fiscalInFlight`;
  - an alarm after 7 blocked windows;
  - deferral after network transitions;
  - `last_known_good` after 5 minutes;
  - a crash loop switches the pointer back, offline.
- **AC 19, 59.**

**P1-9 — Backups on the master** (FR-20.21) · M
- **Touches:** `backup-runner.service.ts` and `backup-destinations.service.ts`. The changes:
  - a `local-path` destination;
  - S3 with the region checked;
  - Drive only with an attested EU data region;
  - the vault sealed with the org's own key pair;
  - pushes go through the egress proxy.
- **Adds:** an uploads tarball and restore-verify.
- **AC 20, 62.**

**P1-10 — Time and the fiscal clock** (FR-20.22, FR-20.49) · S
- **Touches:** `time-sync.service.ts:23,82-85`. The check reports *unknown* rather than 0. The OS
  clock is pushed only if it was verified within 24 h and the step is ≤ 2 min; otherwise a person
  confirms.
- **Adds:** the 2-hour device rule per workstation, which reads `lastCommunicationAt`.
- **AC 58.**

**P1-11 — P1 field lanes** · M
- Part F's T-3 against the P1 build: `shop-standalone` (`msi` on Windows 11 and 10, `deb`,
  `compose`, `k8s`), `no-avx` and `soak`.
- The lab rig with the real Eltrade A3.
- **AC 13–21, 47–50, 57–59, 64–67** (the master side).

### B.4 P2 — The cloud link

**P2-1 — Node registry on global** (FR-20.2) · M 🏗
- **Adds:**
  - the models (A.5.1), with ephemeral keys reaped after 24 h;
  - `/api/org/:orgId/nodes/*` and `/api/node/v1/{enroll,token}` behind a deny-by-default
    `NodeAuth`;
  - `/settings/servers`;
  - `NODE_TOKEN_SECRET`, sealed.

**P2-2 — The uplink** (FR-20.52, FR-20.53) · L 🏗
- **Global:**
  - `packages/node/src/uplink/server.ts`, mounted beside the existing WebSockets (`unified.ts:74-76`);
  - first-frame authentication;
  - `node_presence` with a heartbeat;
  - **a second connection from the same nodeId → `clone-alarm`**;
  - ingress timeouts in `lgr-deploy`.
- **Supervisor:** both sockets; the machine proxy, PAC and authentication; the OS trust store;
  backoff; liveness; pacing.
- **Tests:** a two-process harness behind a TLS/WSS front; the chaos proxy; the `corp-proxy` lane.
- **AC 22, 50** (global side).

**P2-3 — Control channel, licence, health, version skew** (FR-20.55, FR-20.57, FR-20.58) · M 🏗
- **Adds:**
  - the control handlers (A.6.7);
  - `LICENCE_SIGNING_KEY` (sealed), its public half built into the package;
  - `master_outdated` as a control message;
  - `/admin/nodes`;
  - revocation semantics: 4403 stops the uplink only.
- **AC 26, 53, 60, 61.**

**P2-4 — "Sign in with LGR", and on-prem credentials** (FR-20.39, FR-20.40) · L 🏗
- **Global:**
  - `/idp/authorize`, `idp_codes` and `idp-redeem`;
  - `IDP_SIGNING_KEY` (sealed), its public half in the package;
  - *Account → On-prem servers*: set a local password or PIN; equality with the global password is
    refused; `onprem_credentials`; `cred-sync`.
- **Master:** `/auth/idp/redeem`; the login button; `__Host-` session cookies on node hosts.
- **Desktop:** `lgr://login` for a master.
- **AC 24, 65.**

**P2-5 — Identity feed** (FR-20.43, FR-20.44) · M
- **Adds:** `identity.changed` events from every Identity writer → per-node batches → a daily full
  reconcile.
- **The master** applies them and ends sessions.
- **Tests:** a payload scan for `$argon2`, `$2a$`, `$2b$`, `$2y$` and token shapes; revocation
  within 60 s.
- **AC 23, 25.**

**P2-6 — Relays and the outbox** (FR-20.59, FR-20.86) · M
- **Master:** `outbox` with deterministic ids. `email.service.ts`, the company lookup, LLM steps and
  off-site pushes are enqueued. The digest completes only after its send.
- **Global:** relay handlers for mail, VAT, LLM and invite-create; a 7-day dedupe; the reference
  feeds.
- **AC 27.**

**P2-7 — Desktop updates through the master** (FR-20.56) · M
- **Master:** fetches desktop releases through lgrai.app's download endpoint
  (`release-download.ts:226-261`) and answers `/api/desktop/v1/update` from its cache.
- **Desktop:** already handled by P1-6's `trust.rs` change to the updater.
- **AC 28.**

**P2-8 — P2 field lanes** · M
- Part F's T-4 (`shop-linked` at Control) and T-5 (`shop-corp`, on Windows Server 2022 and 2019).
- **AC 22–28, 53, 60, 61, 65.**

### B.5 P3 — Mirror, remote access, moves

**P3-1 — Capture: tailer, journal, history loss** (FR-20.61, FR-20.62) · L
- **Adds** `packages/node/src/replication/{tailer,journal,seed,engine}.ts`, from FR-16.18–16.23:
  - pre- and post-images on explicitly created collections;
  - batches cut at transaction boundaries;
  - one transaction per batch;
  - the lease;
  - **history loss → `journalEpoch` + 1 and a full re-journal by upsert**;
  - indexes on `{coll, docId}`;
  - the replication metadata (A.5.3) on all 70 models.
- **AC 29.**

**P3-2 — Pages, the hash chain, and the mirror apply** (FR-20.63–20.68) · L
- **Master:**
  - pages over the control socket (BSON, zstd), projected to home-owned fields;
  - the chain hash;
  - the supervisor's bulk transport with pacing.
- **Global:** `packages/node/src/mirror/apply.ts`:
  - one transaction;
  - `Org` by `{_id}`;
  - R by `{_id, orgId}`;
  - S by `$set` of home-owned fields;
  - tombstones;
  - collision → delete + insert + `resend`;
  - `identityId` only where sanctioned;
  - a `prevHash` check;
  - the watermark and chain last;
  - isolation checks;
  - dead letters and alarms.
- **Tests:**
  - chaos, then digest equality;
  - forged pages refused;
  - the Stripe webhook survives;
  - `FiscalDevice.status` never crosses;
  - an unsanctioned membership is applied inert.
- **AC 30–33.** **Requires P0a-1.**

**P3-3 — Files** (FR-20.69) · M
- **Adds:** the per-org blob lane; storage by `(org, sha256)`; `mirror_blobs`; global reads mirrored
  files by content; the metadata-only option.
- **AC 52, 63.**

**P3-4 — The tunnel and org addresses** (FR-20.72–20.74, FR-20.78) · L 🏗
- **Requires P0a-8,** in both of its releases.
- **`lgr-deploy`:**
  - a `*.lgrai.app` wildcard DNS record at Cloudflare. Names that have records of their own, such
    as the mail-authentication ones, are unaffected;
  - a cert-manager DNS-01 issuer and a `*.lgrai.app` wildcard certificate;
  - an ingress host rule for `*.lgrai.app`.
- **Global:**
  - `org_addresses`: a request from the org's admin, approval on the sys-admin Nodes page, the
    reserved-label list, a check that the label has no DNS record of its own, the 63-character
    limit, and retirement (a notice for 12 months, never reissued);
  - the router: Host → org → home node → pod, with pod-to-pod forwarding;
  - the edge filter for anonymous requests, with rate limits;
  - framing, flow control, and header and cookie handling.
- **Supervisor:** the tunnel ingress, with WebSocket passthrough.
- **AC 34, 39.**

**P3-5 — Read-only mode on lgrai.app** (FR-20.75) · M
- **Global:**
  - the org at lgrai.app serves the mirror under global's own session, with `readOnly` routes only;
  - `GET /api/org/:orgId/home` returns `{home, online, asOf}`;
  - a banner in `ui-shell`;
  - the node address serves **only a static notice** while the uplink is down;
  - no global token or cookie on node hosts.
- **AC 34, 39.**

**P3-6 — Moves, promotion, replacement** (FR-20.79–20.84) · L
- **Global:**
  - the `org_moves` state machine (A.6.9);
  - the freeze, with 2× cache TTL and enrollment revocation;
  - an exporter that reuses `backup-bundle.service.ts`'s streams, minus node state, integrations and
    password copies;
  - sealed credential verifiers;
  - re-point from global (to a master);
  - **promotion with evidence, a series freeze and recording of the site's last numbers**.
- **Master:**
  - the importer for an empty org;
  - collection creation; journal seeding; digests;
  - re-point to lgrai.app (back to the cloud);
  - the fence with `fenceCutoff`;
  - the export above the cutoff;
  - the audited import (the Прил. 42 model; collision → credit note + re-issue).
- **Portal UI:** the move, promotion and replacement wizards.
- **AC 35, 37, 51, 54.**

**P3-7 — Restore lock, clones, re-seed** (FR-20.51, FR-20.71) · M
- **Adds:**
  - the restore lock driven by the high-water mark, the device's last receipt, the chain mismatch,
    and person-entered numbers;
  - FR-13's in-app restore routed through the supervisor for home orgs;
  - clone detection on the LAN (DNS-SD `bootNonce`) and by global (`clone-alarm`);
  - **re-seed from the mirror**, which replaces the org's data, then counters above the evidence;
  - a one-way digest reconcile that never deletes or alters issued sales.
- **AC 36, 49, 50.**

**P3-8 — Observability, SUPTO hand-off, home hold** (FR-20.3, FR-20.50, FR-20.98–20.101) · M
- **Adds:**
  - the status page, the nodes page, digest lines and alarms;
  - the Прил. 32 panel;
  - the `supto` and `declared` release fields enforced for masters **and for global's deploys**
    (the `deploy-prod.sh` gate);
  - the remote-inspection path recorded for off-site masters;
  - the `hold` state and the global disaster-recovery runbook step.
- **AC 40, 55.**

**P3-9 — P3 field lanes and regal** · M
- Part F's T-6 (Full), T-7 (jupiter: `two-shops`, `restore-and-lost`) and T-8 (anchor and
  `shop-prod`).
- Then T-9's release gate.
- Then Part C.4.
- **AC 29–46, 49–56, 63.**

### B.6 P4 — Options (sketch only; each needs a decision on field evidence)

- **Standby master** (FR-20.102) · L
  - A second PC as a secondary, plus an arbiter.
  - The `mongod` LAN exposure is limited to the other member (TLS + keyfile).
  - One node identity; only the primary runs the API and the uplink.
- **Offline till** (FR-20.104) · L+
  - It needs an FR amendment first, and НАП's answer (Q8).
  - Receipts only: the drivers run in the desktop, the till owns the УНП for its own device, and its
    outbox is imported as already-fiscalised sales.
- **TLS passthrough** (FR-20.77) · M
- **Air-gapped → linked** (FR-20.83) · M

### B.7 Order, lanes and the critical path

| Lane | P0 | P1 | P2 | P3 |
|---|---|---|---|---|
| **A — server (TS)** | P0a-1…7, P0b-1…11 | P1-3 (API), P1-5, P1-9, P1-10 | P2-1, P2-3…P2-7 | P3-1, P3-2 (TS), P3-3, P3-5…P3-8 |
| **B — supervisor + packaging (Rust)** | (P0b-9 spike) | P1-1, P1-2, P1-3 (ingresses, egress), P1-4, P1-7, P1-8 | P2-2 (client) | P3-2 (transport), P3-4 (ingress), P3-7 (high-water mark, clone advert) |
| **C — desktop shell** | — | P1-6 | P2-4 (deep link) | P3-6 (re-point) |
| **D — ops / infra** | — | the lab rig with the real A3 | 🏗 P2-1/P2-3/P2-4 secrets, P2-2 ingress | 🏗 P3-4 `*.lgrai.app` DNS + certificate, regal (Part C.4) |
| **E — coverage (Part F)** | T-0, T-1, T-2 | T-3 | T-4, T-5 | T-6, T-7, T-8, T-9 |

**Critical path:** P0b-2 → P1-3 → P1-6 → P1 field (T-3) → P2-2 → P2-4 → P3-1 → P3-2 → P3-6 → P3-7
→ T-7 / T-9 → regal.

**Hard dependencies:**

| Before | After | Why |
|---|---|---|
| P0a-1 | P3-2 | mirror isolation needs org-scoped by-id routes |
| P0a-8 (both releases) | P3-4 | lgrai.app must ignore cookies from its subdomains before any subdomain serves a master |
| P0b-8 (both releases) | P3-6 | paths |
| P0b-7 | P1, and P0a-5 | masters cannot take scripts; P0a-5 is a migration |
| P0b-10 | the first master | bundles must not carry home state |
| P0a-5 | any fiscalised till on a master | |
| T-0 | T-3 | |
| T-6 | P3-6's regal use | moves are proven on global-eph first |
| T-7 and T-9 | Part C.4 | |

### B.8 Effort (rough)

| Phase | One developer | Calendar with lanes |
|---|---|---|
| P0a | 4–5 weeks | 2–3 weeks (P0a-8 runs beside P0b; it is needed only by P3-4) |
| P0b | 4–5 weeks | 3–4 weeks |
| P1 | 10–12 weeks | 6–7 weeks |
| P2 | 5–6 weeks | 4–5 weeks |
| P3 | 8–10 weeks | 6–7 weeks |
| Coverage, T-0…T-9 (lane E) | 11–15 weeks | alongside; about +1–2 weeks on the critical path |
| **Total to regal-pz on-prem** | **42–53 weeks** | **≈ 22–28 weeks** |

**The widest error bars:**
- **P1-1, P1-2, P1-3 and P1-8.** There is no `mongod`-as-a-service precedent here, and the ingress
  and updater design is new.
- **P3-4, the tunnel.**
- **T-0.** The host layer has never driven a guest, and roomler's first day of FR-61 found 35 field
  defects (`docs/vmtest.md:13`).

### B.9 Steps that touch production infrastructure (🏗)

| Step | What it touches |
|---|---|
| P2-1 | `NODE_TOKEN_SECRET` sealed in `lgr-secret` |
| P2-2 | ingress WebSocket timeouts for `/api/node/v1/uplink` |
| P2-3 | `LICENCE_SIGNING_KEY` sealed |
| P2-4 | `IDP_SIGNING_KEY` sealed |
| P3-4 | Cloudflare: the `*.lgrai.app` wildcard record; cert-manager: a DNS-01 issuer and the `*.lgrai.app` wildcard certificate; the ingress host rule |
| P3-8 | the `deploy-prod.sh` SUPTO-version gate for global |
| P1-7 / P1-8 | the `release` environment for `server-release.yml` (roomler's identity, FR-14.3) |
| T-0 | the vmtest hosts (zeus, mars) drive guests for the first time |
| T-3 / T-5 | `k8s-cluster-multi`: golden images (Ubuntu server, Windows 10, Server 2022, Server 2019, no-AVX) and the impairment verbs |
| T-4 | mars: the global-eph stack; the test domain (never under lgrai.app), its DNS and its DNS-01 wildcard certificate, **issued once and renewed**; dnsmasq split horizon |
| T-7 | jupiter: playbook 15's `vmtest-host` role (opt-in), used in announced windows only |
| T-8 | production: the org `lgr-fieldtest-onprem` and the anchor master; ephemeral node keys enabled on `lgr-fieldtest` |

### B.10 Kill switches, per step

| Step | Kill switch / rollback |
|---|---|
| P0a-1, P0a-3, P0a-6, P0a-7 | none needed: fixes. Revert the PR. |
| P0a-8 | release N (both cookie names) reverts cleanly; after N+1, a revert restores the plain names, which is harmless while no subdomain serves anything |
| P0a-2 | `PDF_RENDERER=md-to-pdf` for one release |
| P0a-4 | no key sent → today's behaviour (clients can stop sending it) |
| P0a-5 | the dual-write keeps old counters safe for a binary rollback |
| P0b-1 | `LGR_NODE_ROLE` defaults to `global` |
| P0b-2 | `HOME_GATE=off` (no home rows exist anyway); the Mongoose plugin logs instead of refusing under `HOME_GUARD=warn` for one release on global |
| P0b-3, P0b-4, P0b-5 | inert while no org has a foreign home |
| P0b-6 | the scan test can be marked expected for a script with an issue |
| P0b-7 | `MIGRATIONS_AUTO=false` |
| P0b-8 | release N only reads; release N+1's migration is reversible by its own down step for one release |
| P0b-9, P0b-10, P0b-11 | revert |
| P1-* | uninstall LGR Server; nothing on global changed |
| P1-8 | the auto-update toggle off (a manual update from a file still works) |
| P2-1 | revoke the node; `ephemeralKeysEnabled=false` |
| P2-2, P2-3 | link level Air-gapped |
| P2-4 | the login page hides "Sign in with LGR"; local credentials keep working |
| P2-5, P2-6, P2-7 | per-feature flags on the master (`relay.mail=false`, …) |
| P3-1, P3-2, P3-3 | link level Control (stops the mirror; the journal keeps capturing) |
| P3-4 | the tunnel is off per node (`tunnel=false`), and an address can be retired; read-only mode still works |
| P3-5 | read-only mode is off (the org at lgrai.app shows "on-prem, offline") |
| P3-6 | move back; a promotion needs a sys-admin and evidence |
| P3-7 | the restore lock cannot be switched off; it can only be lifted by evidence |
| P3-8 | per panel |

---

## Part C — Migration of today's LGR

### C.1 Code: what changes in existing paths, and why global does not notice

The rule: **an org with no `org_homes` row, and which never had a node, takes exactly today's code
path.**

| Existing path | Change | Why it is a no-op for cloud orgs |
|---|---|---|
| `AuthService` (`auth.service.ts:83`) + 7 `AppAuthService` copies (`:80`) | the home gate, by effect | `homeOf()` is `global` |
| Every Mongoose model | the home write guard | the home is here |
| Identity flows (`account.service.ts:35-46,127-128`; `identity.service.ts:290-336`) | skip foreign-home memberships | none exist |
| GET writers (`invoice-export.controller.ts:363-377`; `app-hub.service.ts:24-37`) | `assertHomeIsHere` | true |
| Scheduler org loops; retention sweep; migrations | filtered by home; independent starts | true |
| POS / cash sale / invoice issue / payment routes | an optional key on the document | no key → today |
| By-id routes | filter by `{_id, orgId}` | only a foreign id changes behaviour (404) |
| `sequence.service.ts:67-92` | УНП per device, with a dual-write | numbers continue above every issued one |
| PDF rendering (`base.pdf.ts`) | `setContent` + `pipe: true` | same layout |
| lgrai.app cookies (`session-cookie.ts`, `handoff-cookie.ts`, `oauth.controller.ts`) | `__Host-` names; ignored on same-site requests (P0a-8) | nobody is signed out: the SPAs use the tab's bearer token; a plain download link needs a fresh sign-in once, after the switch |
| File paths | relative, expand then contract | readers accept both forms |
| Outbound calls | timeouts | a slow provider fails instead of hanging |
| `config` | role; example secrets refused | role defaults to `global` |
| `backup-bundle.service.ts:62-79` | excludes FR-20 state | the collections do not exist on global orgs |
| Desktop shell | master kind; `trust.rs` (presence, updater); proxy; discovery | a desktop on lgrai.app uses the OS store as today |

**Global regression constraints** (FR README) are re-proven by the existing suites. CI also runs the
five import skills in dry-run mode against a seeded org on a P0 build.

### C.2 Data

- **Global gains:**
  - new collections only (A.5.1), plus `Org.homeEpochHighWater` and the new document fields;
  - `File.sha256`, backfilled;
  - the migrations `0001-relative-file-paths` (about 1,700 regal-pz rows) and
    `0002-unp-per-device`.
- **The master gains** the same, plus `repl_*`, `local_credentials`, `outbox`, `node_instance`,
  `entitlements` and `desktop_releases`. Replicated collections are created explicitly with pre- and
  post-images.
- **A move** copies documents with their `_id`s. These do not travel:
  - `User.password`;
  - `User.oauthProviders`;
  - `Identity` hashes;
  - `Org.settings.integrations`;
  - FR-20's own state.

  Global keeps the same documents as the mirror.

### C.3 Operations

| Today | With an on-prem org |
|---|---|
| Skills sign in at `https://lgrai.app --org regal-pz` | `--server https://regal-pz.lgrai.app`, signing in with the operator's **local password** set under their account (FR-20.40, FR-20.76) |
| Read-only investigations in the pod (`.scratch/*.ts`) | against the mirror on global (up to the watermark), or on the master |
| Direct-to-Mongo writers (`assign-din-tags`, `seed-products --no-clean`, `backfill-*`) | `lgr-server run-script <name>` on the master, **allow-listed and vetted only** (none touches an issued document, FR-20.26). The rest stay in the repository and run against global for cloud orgs only (`assertHomeIsHere`). |
| `deploy-prod` ships global | unchanged, plus the SUPTO-version gate; masters update from the feed after promotion to `stable` |
| A data migration = a script run by hand | a versioned migration every node runs, filtered by home |

### C.4 The regal rollout

#### C.4.1 Prerequisites at the shop

A checklist the field engineer signs:
1. **The master PC.**
   - Hardware: x86-64 with AVX (the installer checks), ≥ 8 GB of RAM, an SSD.
   - Windows 10/11 Pro, with BitLocker on.
   - A UPS, a DHCP reservation, and sleep disabled.
2. **A backup target:** a second disk or a USB drive, plus a monthly rotated drive taken off-site.
3. **The tills and office PCs** run LGR Desktop registered to lgrai.app (FR-14), with the Eltrade A3
   on its COM port.
4. **The network:**
   - tills and master on one LAN segment;
   - outbound 443 open;
   - the installer's firewall rule covers all profiles, restricted to the local subnet.
5. **НАП links.** Each device's link to НАП is its own data SIM (FR-20.49), with the operator
   recorded.
6. **What the answers of 2026-10-20 require** (FR-20 §12):
   - the accountant's written confirmation of the single allocator (Q5);
   - **PlusMinus keeps the A3** during the parallel run, and LGR's POS prints non-fiscal text until
     cutover (Q10);
   - LGR is declared to НАП before the master prints its first fiscal receipt (Q8);
   - regal-pz moves alone. The legal-entity question and a disjoint invoice range are needed
     before regal-sf (Q3, C.4.7).

#### C.4.2 The rehearsal, on a synthetic copy

1. The **synthetic, regal-shaped org** (FR-20.112, Part F.4.6) is moved to a lab master on the same
   model of PC.
2. It trades for a day with the WAN pulled.
3. It is restored from a backup (the restore lock), and moved back.
4. AC 17, 30, 31, 35, 49 and 54 are checked on it.

**Never use a clone of regal-pz.** It would put real customer data on a lab machine, and its bundle
paths would still point at regal-pz's real files.

#### C.4.3 The onboarding day (online, before the move)

1. The master is installed and registered at Full.
2. **On lgrai.app, under their account,** every regal-pz person sets a local password for the
   on-prem server, and each till operator also sets a PIN (FR-20.40). That works now, because local
   credentials are set on global.
3. The move wizard's preflight lists anyone who has not.
4. regal-pz's admin requests the address `regal-pz.lgrai.app`, and a sys-admin approves it on the
   Nodes page (FR-20.72). It starts answering at the flip.

#### C.4.4 The move

It runs after closing time; Saturday evening is the safest.
1. The POS day is closed (FR-09 Z-report), and no import is running.
2. The move wizard runs: preflight → freeze → copy → verify → flip → **global** re-points the
   desktops. It takes minutes for regal-pz: 66 MiB of documents and 76 MiB of files.
3. **On a till:** sign in with the **local password** with the WAN pulled. Open a POS session, sell
   one item non-fiscally, storno it, and close.
4. **From outside** (a phone on 4G): open `https://regal-pz.lgrai.app`, sign in with LGR, and read
   an invoice.
5. **The Прил. 32 update** is filed within 7 days, if LGR is declared by then (Q8).

#### C.4.5 The first trading days

- **Day 1.** Normal trading, with a 30-minute WAN pull at a quiet hour (AC 17 on site).
- **Every day.** PlusMinus runs in parallel and keeps the A3, and LGR's POS prints non-fiscal text
  (Q10). The daily compare-products reconciliation runs against the master, and is the go/no-go
  signal.
- **Day 7.** A 5-minute master power pull (AC 13 on site).
- **Cutover.** Once the reconciliation has been clean for the agreed period and LGR is declared
  (Q8), LGR takes the A3 and PlusMinus stops printing fiscal receipts. One system is on the device
  at any time, so no УНП ranges need declaring.

#### C.4.6 Rollback

**Criteria**, any one of:
- any duplicate number;
- any lost sale;
- mirror lag above 1 hour twice in a day with the uplink up;
- a stuck master.

**Procedure:**
- **If the master works:** the master → cloud move (FR-20.80) the same evening. The master re-points
  the desktops to lgrai.app.
- **If the master is dead:** promote the mirror (FR-20.81). That requires the attestation; the shop
  is told about the duplicate-number risk, and the last numbers are recorded from paper and the
  device before global issues any.

#### C.4.7 Then the other regal orgs

One site at a time, each with its own master (Q3, as answered):
- **regal-sf** goes next, with a master at the Sofia shop, once regal-pz has run clean for a month.
  Before it moves:
  - the legal-entity question is answered from the orgs' own invoices;
  - regal-sf's invoice range is confirmed disjoint from regal-pz's, and recorded in its sequences.
    PlusMinus already numbers the two shops apart.
- **`regal`** stays in the cloud until its role is settled.

### C.5 Exit and rollback per phase

| Phase | To undo it |
|---|---|
| P0a | Each step is a fix (B.10). The УНП dual-write keeps a binary rollback safe. |
| P0b | `MIGRATIONS_AUTO=false`. The path migration only after its reader has shipped for a release. |
| P1 | Uninstall LGR Server. No global state exists. |
| P2 | Revoke the node on global; link level Air-gapped on the master. |
| P3 | Move the org back to the cloud; link level Control. |
| P4 | A per-feature switch. |

---

## Part D — Risks

Likelihood (L) and impact (I) are scored 1–3.

| # | Risk | L | I | Mitigation | Owner |
|---|---|---|---|---|---|
| R1 | **Two homes** for one org → duplicate legal numbers | 1 | 3 | Epoch on every message; home record fails closed (FR-20.3); promotion on evidence with a series freeze (FR-20.81); restore lock and clone detection (FR-20.51); AC 49–51, 55 as CI chaos tests and vmtest cells | server |
| R2 | **`mongod` on Windows shop PCs:** AV/EDR quarantine, CPUs without AVX, full disks, unclean shutdowns | 2 | 3 | Preflight; signed binaries; journal on; UPS; disk alarm; nightly backup + mirror; vmtest with Defender on and a hard power-off | supervisor |
| R3 | **The tunnel** is the most new code with the least precedent | 2 | 2 | Last in P3; strict limits and metrics; read-only mode on lgrai.app covers "master offline" without it | global |
| R4 | **Version skew** breaks read-only views or replication | 2 | 2 | Expand-then-contract; `MASTER_MIN_VERSION`; the tunnel serves the master's own UI | release |
| R5 | **Automatic migrations:** a bad one runs on every master at once | 2 | 3 | Backup before migrate; migrations twice in CI; stable only after a week on global and beta masters; filtered by home | release |
| R6 | **Corporate proxies** break the uplink (PAC, authentication, TLS inspection) | 2 | 2 | Machine proxy resolution as the service; proxy authentication; OS trust store; the `corp-proxy` lane on Server 2022 and 2019 | supervisor |
| R7 | **Staff cannot sign in** during the first outage | 1 | 2 | Local credentials are set on lgrai.app **before** the move; the preflight refuses until everyone has one | rollout |
| R8 | **Cloud secrets leak** into a master package | 1 | 3 | Masters boot without them (D-12); `check-package.ts`; secrets scanning | release |
| R9 | **The shop's uplink is slow** | 2 | 1 | Pacing against interactive RTT; zstd; metadata-only option; measured in the rehearsal | rollout |
| R10 | **macOS server packaging** needs a certificate lgr lacks | 3 | 1 | Defer macOS server | release |
| R11 | **Licence undecided** → expiry blocks sales | 2 | 3 | Expiry never blocks reading, exports, the SUPTO export or the day close; 30-day grace; AC 60 | product |
| R12 | **Ops habits** (direct-to-Mongo against global for an on-prem org) | 2 | 2 | `assertHomeIsHere`; the Mongoose guard; the reconcile flags strays | ops |
| R13 | **A shop PC dies** with the only copy of the day's sales | 1 | 3 | Mirror whenever the line is up; nightly backup; standby master (P4); the device's КЛЕН holds the receipts | rollout |
| R14 | **SSPL obligations** misread | 1 | 2 | Legal review; the licence and a source offer | product |
| R15 | **SUPTO declaration** missed (an undeclared version on a master or on global; a topology change unfiled) | 2 | 3 | `supto` + `declared` gate for masters and global; the Прил. 32 panel and reminders; one compliance owner | product |
| R16 | **Org scoping of by-id routes** (P0a-1) lands late | 1 | 3 | P0a-1 before P3-2; the probe stays in CI | server |
| R17 | **НАП disagrees** with the replicated topology or the till-local database | 1 | 3 | A written query before P4 (Q8) | product |
| R18 | **The field harness stays "written, never run"** | 2 | 3 | T-0 first; it runs FR-14's lanes; the release gate needs a field-log entry; `report` flags mostly-NA runs | coverage |
| R19 | **A jupiter cell starves production storage** | 1 | 3 | Announced windows only (`lib/host.sh:86-89`); audit first; one guest | coverage |
| R20 | **A test cell damages production** | 1 | 3 | Destructive checks refused against `global=prod`; the anchor is never moved; synthetic data; `teardown/baseline`, `data-scan` | coverage |
| R21 | **The simulator passes where the hardware fails** | 2 | 2 | The manual A3 pass stays mandatory | rollout |
| R22 | **Bun on Windows as a 24/7 production server** has no precedent here (memory growth, handle leaks, timer drift) | 2 | 2 | The 72 h `soak` lane on Windows 11 and 10; memory and handle metrics on the status page; the supervisor restarts the API on a threshold | supervisor |
| R23 | **A master's security model regresses** (an ingress or header path reopens B1/B2) | 1 | 3 | AC 47 and AC 39 as permanent route-table and e2e tests; the security review checklist gains the node surface | server |
| R24 | **Org addresses are same-site with lgrai.app** (D-13 as decided): a compromised master serves convincing phishing at a real lgrai.app name, password managers offer lgrai.app passwords there, a cookie flood locks visitors out of lgrai.app, and slugs could be squatted for names like `login` | 2 | 2 | P0a-8 closes cookies and sessions; addresses only for licensed, sys-admin-approved orgs with unreserved labels; "Sign in with LGR" never asks for a password on an address, and lgrai.app's sign-in page says so; addresses can be retired at once | server + ops |

## Part E — Open questions, answers, and what each blocks

goran answered on 2026-10-20 (FR-20 §12 records each answer under its question).

| Question (FR-20 §12) | State | Blocks, or what the answer sets in motion |
|---|---|---|
| Q1 thin locals | **answered: yes** | nothing; D-3 stands |
| Q2 read-only lgrai.app while the master is offline | **answered: yes** | nothing; D-5 stands |
| Q7 the address | **answered: `<org slug>.lgrai.app`** | P0a-8 before P3-4; D-13 and FR-20.72 rewritten; R24 |
| Q3 which regal orgs, where | **answered as recommended** | regal-pz first and alone; regal-sf after a clean month, once its invoice range is confirmed disjoint (Part C.4.7) |
| Q5 the accountant | **answered as recommended** | a written confirmation on the move's preflight checklist (C.4.1) |
| Q8 НАП | **answered as recommended** | the written query goes now; LGR declared before any master prints a fiscal receipt; P4's offline till waits for the answer |
| Q10 PlusMinus and the A3 | **answered as recommended** | one system on the device at a time (C.4.1, C.4.5) |
| Q11 promotion evidence | **answered as recommended** | 24 h + attestation, as FR-20.81 has it |
| Q4 licence | **proposal, awaiting confirmation** (FR-20.55) | P2-3's licence rules |
| Q6 macOS Developer ID Installer certificate | open | the macOS server only |
| Q9 jupiter windows; the anchor master | open | T-7 / T-8 |

---

## Part F — Coverage: integration, e2e and the vmtest matrix on mars, zeus and jupiter

This part implements FR-20 §5.14 and D-14, at goran's request of 2026-10-19: *"add coverage with
integration & e2e test - via throwaway instances on mars, zeus, jupiter - similar like in roomler-ai
repo FR-61-vmtest-matrix.md"*. It was read against roomler-ai `docs/fr/FR-61-vmtest-matrix.md` and
`docs/vmtest.md` (`d71ad3cf4`), and against `lgr-deploy/vmtest/` (`b2455d3`).

### F.1 Three tiers

| Tier | Where it runs | What it proves | When |
|---|---|---|---|
| **1 — Integration** | `packages/tests`, in CI on the mars runner (`ci.yml` `test-and-build`, `vars.LGR_LINUX_RUNNER`), plus a `two-node` job | Each piece's contract, in-process (`MongoMemoryReplSet`, `packages/tests/src/setup.ts:23`); the node protocols end to end, through the two-node harness | Every PR; `two-node` on PRs touching `packages/{node,migrations,server}` or the shell |
| **2 — E2E** | Playwright, `packages/e2e` (`playwright.config.ts`, `BASE_URL`-driven), in the pinned container | The UI flows FR-20 adds: projects `master` and `node` | In CI against the harness; in every field run against throwaway instances |
| **3 — Field** | `lgr-deploy/vmtest` lanes on throwaway VMs and container stacks on zeus, mars and jupiter | That it **just works** on a clean OS, from the signed artifact, on a real topology | On demand; the release gate; scheduled once stable (Q9) |

**All tiers speak one verdict:**
- `LGRTEST-RESULT <check> PASS|FAIL|NA <detail>` and `LGRTEST-METRIC <name> <value> <unit>`;
- **a missing result is `FAIL`** (`lgr-deploy/vmtest/README.md`);
- a check after an earlier `FAIL` in the same cell is `NA "not reached"` (roomler FR-61 P9,
  `lib.sh lift_verdicts`);
- silence without an earlier failure stays `FAIL`.

### F.2 The two-node harness (tier 1)

```
packages/tests/src/two-node/
  harness.ts      boots and tears down the processes below; exposes handles to tests
  chaos-proxy.ts  Bun TCP proxy: drop() · blackhole() · delay(ms) · throttle(Bps) · flapAt(points)
  tls-front.ts    a local TLS/WSS terminator with a test CA, so the uplink speaks WSS as in prod
  fixtures.ts     the synthetic org (small preset), node registration, a paired stub desktop
```

```
MongoMemoryReplSet A ◄── global API (bun unified.ts, LGR_NODE_ROLE=global) ◄── tls-front
MongoMemoryReplSet B ◄── master API (bun unified.ts, LGR_NODE_ROLE=master, front port + control socket)
lgr-server dev  (ingresses + uplink + tunnel; no mongod, no service)
    ──interactive/bulk──► chaos-proxy ──► tls-front ──► global API
```

- **`lgr-server dev`** is the real supervisor without service or `mongod` management. CI already
  builds Rust (the `clippy` job). Before P2-2 lands, a TypeScript double of the uplink stands in.
- **It proves:**
  - AC 2–5 and AC 23, 25, 26, 27 (with an injectable clock);
  - AC 29–40;
  - AC 41;
  - AC 47–57 at the protocol level.

### F.3 The e2e projects (tier 2)

| Project | `BASE_URL` | Specs |
|---|---|---|
| `master` | a master (LAN ingress, via the desktop proxy or a test client with a desktop token) | `master-setup.spec.ts`: console token, no default credentials, register/orgs refused · `master-local-signin.spec.ts`: local password, PIN pad, backoff, refused through the tunnel · `master-status.spec.ts`: status page, Прил. 32 panel, restore-lock banner · `master-desktops.spec.ts`: pairing code with six words |
| `node` | global | `servers.spec.ts`: register a node, link levels, revoke (the shop keeps selling) · `move-wizard.spec.ts`: preflight (missing credentials refused) → freeze → flip → done, plus an abort · `promote-wizard.spec.ts`: evidence required, duplicate-number warning, series freeze · `readonly-mirror.spec.ts`: on lgrai.app's origin, banner, writes 409, reports work, the node address shows only a notice · `tunnel-remote-edit.spec.ts` · `idp-signin.spec.ts` · `onprem-credentials.spec.ts`: set on the account page; a password equal to the global one is refused |

- **Cells select by exact name** (`E2E_NODE_NAME`, `E2E_ORG_SLUG`), FR-61's lesson.
- **Specs are env-gated.**
- **The Playwright version** is pinned by the container image tag.

### F.4 The field lanes (tier 3)

#### F.4.1 What each host does

| Host | Role | Rail |
|---|---|---|
| **zeus** | Shop LANs (masters, locals, simulators behind virtual serial pairs); the anchor master; `soak` | roomler's default host too; sequential; `vmtest-audit` first |
| **mars** | **global-eph** (container stack); **remote-user** (Playwright); **corp-proxy** (mitmproxy); overflow guests; the image just built | `compose down -v` at the end of every run |
| **jupiter** | The second shop (`two-shops`), and the "lost" master (`restore-and-lost`) | **Carries production storage:** announced windows only (`VMTEST_JUPITER_WINDOW`; `lib/host.sh:86-89`); one guest |

#### F.4.2 Topology

```mermaid
flowchart LR
  subgraph ZEUS["zeus"]
    subgraph LANA["vmtest-net A — shop 1 LAN"]
      M1[master VM<br/>LGR Server]
      L1[local VM — till<br/>LGR Desktop + simulator]
      L2[local VM — office]
    end
    WA{{"WAN shaper A (routed uplink only)<br/>cut · throttle · latency · loss · cgnat"}}
    LANA --- WA
    ANC[anchor master<br/>lgr-fieldtest-onprem]
  end
  subgraph JUP["jupiter (announced window)"]
    subgraph LANB["vmtest-net B — shop 2 LAN"]
      M2[master VM 2]
    end
    WB{{WAN shaper B}}
    LANB --- WB
  end
  subgraph MARS["mars"]
    GE[global-eph<br/>lgr image role=global + mongo rs + TLS front + stubs]
    RU[remote-user<br/>Playwright container]
    CP[corp-proxy<br/>mitmproxy + PAC + proxy auth]
  end
  WA -- uplink --> GE
  WB -- uplink --> GE
  RU -- "https://slug.test-domain" --> GE
  ANC -- "uplink (Full)" --> PROD[(lgrai.app<br/>org lgr-fieldtest-onprem)]
```

- **Split-horizon DNS.** dnsmasq on each `vmtest-net` answers the test domain with global-eph's
  address.
- **The test domain's wildcard certificate** is real (DNS-01), issued once and renewed. Guests trust it
  through their unmodified OS store. The corporate lane alone adds mitmproxy's root to the machine
  store, as GPO would.

#### F.4.3 Golden images

| Image | Source | Used by |
|---|---|---|
| Win11 x86_64 | **roomler's** (autounattend, OVMF + swtpm) | masters (`msi`), locals |
| Win10 x86_64 | new, from roomler's bake recipe | masters (`msi`), locals |
| Ubuntu 24.04 GNOME Wayland | **roomler's** | locals (`deb`) |
| Ubuntu 24.04 server | new: cloud-init, Docker, k3s | masters (`deb`, `compose`, `k8s`) |
| Windows Server 2022 and 2019 | new: autounattend; AppLocker defaults; mitmproxy root in the machine store; machine proxy by PAC with authentication | `shop-corp` masters |
| no-AVX | the Ubuntu server and Win11 images booted with `-cpu Westmere` | `no-avx` (`.deb` and MSI) |
| macOS arm64 | roomler's tart golden (opt-in) | deferred with Q6 |

**Inherited traps** (roomler `docs/vmtest.md`; `lgr-deploy/vmtest/README.md`):
- the +3 h Win11 clock means `clock-skew` runs before the `w32time` resync;
- `$ErrorActionPreference='Stop'` turns native stderr into a terminating error;
- `.ps1` files must be ASCII;
- `domifaddr --source arp`;
- wait for cloud-init, DNS and a free dpkg lock;
- never branch on a piped exit status.

#### F.4.4 global-eph: the throwaway global

A compose stack on mars, fresh for every run:
- **the services:**
  - the `lgr` image under test, with `LGR_NODE_ROLE=global`;
  - `mongo:7` as a replica set;
  - a TLS front routing by `Host`;
  - stubs that record what they were asked: SendGrid, the LLM (`packages/e2e/scripts/ocr-stub.ts`),
    the VAT lookup, and Stripe webhooks for AC 33;
- **throwaway secrets,** per run: `NODE_TOKEN_SECRET`, `IDP_SIGNING_KEY`, `LICENCE_SIGNING_KEY`. The
  test package build embeds the test IdP and licence public keys, through a build flag that the
  release workflow refuses;
- **the lifecycle:** `up` → seed (F.4.6) → register masters with ephemeral node keys → cells →
  `down -v`;
- **isolation:** it never connects to production, and production never connects to it.

#### F.4.5 Impairments (FR-20.110), on the host

| Verb | Implementation | Used by |
|---|---|---|
| `wan cut` / `restore` | nftables drop on the **routed** forward path from the lane bridge to the outside interface (`iifname <bridge> oifname != <bridge>`), so bridged LAN traffic is untouched even with `br_netfilter` | `wan-cut-day`, `read-only`, `pin-offline`, `outbox-30d`, `desktop-update-offline` |
| `wan throttle <rate>` / `latency <ms>` / `loss <pct>` | `tc` `tbf` + `netem` on the uplink egress; **an IFB device for the upload direction** | `catalog-flood`, `mirror-latency`, `chaos` |
| `wan cgnat` | a second NAT namespace | `shop-linked` variant |
| `lan cut <guest>` / `loss <guest> <pct>` | the guest's vnet | `cable-pull`, flaky Wi-Fi |
| `lan drop-multicast` | nft bridge family: 224.0.0.251 and ff02::fb, UDP 5353 | `shop-corp` |
| `power-pull <guest>` | `virsh destroy` | `power-pull`, `restore-and-lost` |
| `snapshot-revert <guest>` | `virsh snapshot-revert` | `restore-and-lost` (AC 49) |
| `clone <guest>` | boot a second guest from the same disk image | `restore-and-lost` (AC 50) |

These are new verbs on `vmtest-net` in `k8s-cluster-multi`. `host_cut_network` /
`host_restore_network` (`lib/host.sh:242-250`) call them.

#### F.4.6 The synthetic org

`scripts/seed-fieldtest.ts --seed <n> --preset small|regal`:
- it is deterministic;
- it refuses any target outside a slug allow-list;
- the **`regal` preset** is regal-pz's shape (FR-13 §2.1): 23k products with Cyrillic fastener names
  and tags, 2k contacts, 550 invoices, 900 movements, POS sessions, and 1.5k files of about 76 MB,
  generated by the product's own renderers.

**No real customer data, ever.** `data-scan` (AC 45) checks.

### F.5 The check catalogue

A cell is `lane/method/type@host#check`:
- `type` is one of `airgapped`, `control`, `full`;
- `method` is one of `msi`, `deb`, `compose`, `k8s`;
- checks run in the order listed;
- a cell that cannot exist is `NA` with its reason.

| Check | Asserts | How | AC | Lanes |
|---|---|---|---|---|
| `clock-skew` | tokens mint on a +3 h guest; skew flagged | before the resync | 13 (P1 boot), FR-20.22 | Windows |
| `preflight` | refusal with a reason; nothing installed | installer exit code, log, files | 14 | `no-avx` (`.deb` and MSI), low-RAM, network-path |
| `install` · `signature` | silent install; Authenticode `G ROX LTD` / GPG `.asc` / image digest; a tampered package refused | in the guest | 13, 59 | every master |
| `service-boot` | after a reboot with nobody signed in, LAN-ready within 60 s; firewall rule on all profiles | `virsh reboot`; poll `:4443` from a local | 13 | every master |
| `mongod-private` · `lan-auth` | `mongod` closed to the LAN; 401 without a desktop token; throttle by socket address | from a local guest | 15 | every master |
| `ingress-control` | `/internal/*` and `/api/setup/*` → 404 via LAN and tunnel; forged `X-LGR-*` stripped; setup needs its token | from a local and from remote-user | 47 | every master; `shop-linked` |
| `ws-lan` | `/ws/fiscal-bridge`, `/ws/desktop`, `/ws/tasks` work through the LAN ingress and the tunnel | guest driver + remote-user | 48 | `shop-*` |
| `setup` | no default credentials; first admin per setup; register/orgs refused | e2e `master` | 47 | every master |
| `discover` · `pair` · `pin-forged` | DNS-SD lists the master (or, with multicast dropped, the typed address works); six-word pairing; a rogue server at the master's address refused | guest drivers; a rogue container | 16 | `shop-*` |
| `rediscover` | after the master's address changes, the tills find it again by nodeId | change the DHCP lease | 16 (FR-20.28) | `shop-standalone` |
| `proxy` | wrong `Host` or missing launch secret refused | guest driver | 16 (FR-20.32) | locals |
| `bridge-lan` | a POS sale prints on the simulator through the master, unaffected by `wan cut` | simulator log + API | 17 | `shop-*` |
| `unreachable` | master stopped → the named page with the кочан hint; recovers | CDP / screendump | 17 (FR-20.33) | locals |
| `wan-cut-day` | a scripted trading day with the WAN cut (POS + receipts, consecutive invoices, cash sale, goods receipt, day close) | CDP-driven till + API; latency metrics | 17 | `shop-standalone`, `shop-linked` |
| `no-external-wait` | no business request waits on DNS or an external call during the cut | request timings + host pcap | 17 | the same |
| `cable-pull` | a local's LAN cut mid-sale + retry → one sale, one print | `lan cut` + idempotency key | 18 | `shop-*` |
| `crash-mid-print` | the API killed between save and print; retry → one sale, one УНП, one receipt | kill via the supervisor's control socket | 57 | `shop-*` |
| `power-pull` | master destroyed mid-day → back; last committed sale present; stale tasks failed | `power-pull` + API | 13 | `shop-*` |
| `update-window` | update deferred while POS is open; installed in the window; a forced health failure switches back from disk with the WAN cut | test feed + health hook | 19, 59 | masters (`msi`, `deb`) |
| `backup-local` | nightly bundle + uploads on the second disk, restore-verified | second virtual disk | 20 | masters |
| `clock-push` | OS clock set 3 days wrong, NTP blocked → nothing pushed to the device; a person asked | guest clock + simulator log | 58 | masters |
| `restore-lock` | restore a backup with the WAN cut → legal series locked until device and person evidence; snapshot revert + writes → detected | `snapshot-revert`, a restore, simulator | 49 | `restore-and-lost` |
| `clone` | two guests from one image → both lock and alarm | `clone` | 50 | `restore-and-lost` |
| `link-control` | registered; uplink up; with relays off, global-eph's channel record of the day holds no org document; with mail on, only mail | global-eph metrics | 26 | `shop-linked`/control |
| `revoke-continues` | revoking the node stops the uplink; the tills keep selling; the day close works | API + simulator | 53 | `shop-linked` |
| `proxy-pac` | the uplink links through mitmproxy via PAC with proxy authentication, and mitmproxy saw it | corp-proxy log | 22 | `shop-corp` |
| `idp` · `pin-offline` · `cred-tunnel` | "Sign in with LGR" → a master session; with `wan cut` the local credential works and the global password does not; local sign-in through the tunnel refused | e2e + guest | 24, 65 | `shop-linked`, `shop-prod` |
| `revocation` | a password change on global ends master sessions within 60 s | API timing | 25 | `shop-linked` |
| `no-secrets` | no hash (`$argon2`, `$2a/b/y$`) or token in any message or move bundle | global-eph message log | 23 | `shop-linked` |
| `outbox-30d` | `wan cut`; master clock +30 d; on reconnect, the mail stub receives each message once | guest clock + stub | 27 | `shop-linked` |
| `desktop-update-offline` | a local updates its desktop from the master under `wan cut` | versions before and after | 28 | `shop-linked` |
| `version-skew` | a master below `MASTER_MIN_VERSION` keeps updates, has replication refused, updates itself | test feed | 61 | `shop-linked` |
| `licence-expiry` | past grace: reading, exports, the SUPTO export and the day close still work | licence with a past expiry | 60 | `shop-linked` |
| `residency` | setup refuses an off-site destination outside BG/EU; Drive only with an attested EU region | setup API | 62 | masters |
| `capture` | `bulkWrite`/`updateMany`/raw writes on the master appear on the mirror | an allow-listed test script | 29 | `shop-linked`/full |
| `mirror-latency` | METRIC p95 < 5 s | timestamps | 30 | the same |
| `catalog-flood` | 23k products mirrored within 15 min at `throttle 10mbit`; interactive p95 < 2 s meanwhile | script + remote-user probes | 30 | the same |
| `chaos` | random kills (master API, supervisor, global-eph containers) and WAN flaps → digests equal | chaos schedule + digest compare | 31 | the same |
| `forged-pages` | forged pages (other org, stale epoch, bad chain, `..` path) refused and alarmed | a test client with the node's credential | 32, 52 | `shop-linked` |
| `split-docs` | a Stripe-stub webhook on `Org.subscription` survives; `FiscalDevice.status` never mirrored; an unsanctioned membership is inert | API reads | 33 | `shop-linked`/full |
| `remote-edit` · `read-only` | an edit through the node address lands on the master and the tills; under `wan cut`, lgrai.app serves read-only on its own origin (reports work), and the node address shows only a notice | e2e `node` from remote-user | 34, 4, 56 | the same |
| `files` | every file opens from the mirror by content; a metadata-only org moving back transfers every file first | API + file hashes | 63 | the same |
| `move-roundtrip` | cloud → master → cloud on global-eph; one gapless series; digests equal; local credentials work after the move with the WAN cut; desktops keep their ids; the bridge prints without re-registering | move wizard (e2e) + API | 35, 54 | `shop-linked`/full |
| `home-hold` | a deleted `org_homes` row → `hold`; global restored from a pre-move dump → `hold` until the node reconnects; no FR-20 state in a bundle | global-eph DB ops | 55 | `shop-linked` |
| `restored-merge` | restore a 2-day-old backup → pages refused → re-seed from the mirror; deleted documents stay deleted; nothing on the mirror deleted; no number re-issued | guest restore + API | 36 | `restore-and-lost` |
| `lost-master` | promotion refused without evidence or before 24 h; after promotion, series frozen until the last numbers are recorded; the jupiter master returns → fenced → export above the cutoff → audited import; a collision → credit note + re-issue | `power-pull` + API + e2e | 37, 51 | `restore-and-lost` |
| `tenant-node` | master A cannot replicate into, tunnel to or control org B, even with forged frames | test client with A's credential | 38 | `two-shops` |
| `cookie-domain` | no `Domain=` reaches the browser; `__Host-` host-only session cookies; no global token on an org address; a cookie planted by an address's JavaScript with `Domain=<test domain>` is ignored by global-eph; a same-site request carrying the global-eph session cookie answers 401, while the OAuth sign-in still works; an anonymous API request to an address gets 401 from the edge; a reserved, unlicensed or unapproved label gets no address | browser cookie jar + storage; a planted-cookie page served by the master | 39 | `shop-linked`/full |
| `people` | an Air-gapped master manages people locally; a linked master refuses person edits | e2e `master` | 64 | `shop-standalone`, `shop-linked` |
| `no-third-party` | a crawl of every SPA on a master finds no external origin | crawler | 66 | every master |
| `supto-hold` | a release flagged as an undeclared SUPTO version is not installed | test feed | 40 | masters |
| `soak` | 72 h of synthetic trading: memory, handles and logs within budget; a nightly backup and an update inside the window | metrics | 13, 19, 20 | `soak` |
| `prod-ingress` | through the anchor: the anchor org's address `lgr-fieldtest-onprem.lgrai.app` and the `*.lgrai.app` certificate, a remote edit, a password sign-in through the real IdP (`oauth-browser` is `NA` headless) | remote-user against lgrai.app | 30, 34 | `shop-prod` |
| `teardown/baseline` | no guest left; global-eph down; both field-test orgs at baseline; production health green | polled for 3 min | 43 | every run |
| `jupiter-window` | no jupiter cell outside an announced window | orchestrator log | 44 | every run |
| `data-scan` | no production org's ids or slugs on any throwaway database | scan before teardown | 45 | every run |

### F.6 Verdict and the regression lifecycle

`lgr-deploy/vmtest` already writes `results.tsv` and `LATEST`, and reads `expected-failures.txt` with
its two kinds of entry. It gains roomler's P9 behaviour, **implemented, not described**:
- **one isolated re-run** of a failing cell, on a fresh guest, before anything is filed
  (`VMTEST_RERUN=0` skips it);
- **one `gjovanov/lgr` issue per condition**, titled exactly `vmtest: unexpected failure in
  <lane/method/type#check>`;
  - it is matched by client-side string equality over the open-issue listing, never by search;
  - a repeat failure comments on the issue;
  - the first run that sees every condition green closes it;
- **`triage --run-dir`** re-evaluates a finished run without guests (`VMTEST_FILE_ISSUES=0` makes it
  a dry run);
- **redaction** of everything sent to GitHub;
- **`report`** warns once `NA` passes a quarter of the cells.

### F.7 Safety rails

| Rail | How it is enforced |
|---|---|
| jupiter only in an announced window | `host_check_rails` refuses without `VMTEST_JUPITER_WINDOW`; the default lane set never includes jupiter |
| One guest per host | `vmtest-audit`; `tmux ls` / `virsh list` for a parallel roomler or LGR run; never `destroy --all` while another run may be live |
| Destructive cells never touch production | the orchestrator refuses destructive checks (moves, promotion, chaos, restore, clone, clock advance, version skew) against `global=prod`; the anchor is never moved, promoted or restored |
| Production at its baseline | ephemeral node and desktop keys; nodes reaped after 24 h of silence (longer than any cut), desktops after 15 min; `teardown/baseline` |
| No real data | the generator's allow-list; `data-scan` |
| global-eph shares nothing with production | its own Mongo, secrets, test domain (never under lgrai.app) and certificate; stubs; the test-key build flag is refused by the release workflow |
| Never `restart` an ephemeral daemon whose row the cell still needs | stop → enroll → one clean start |

### F.8 Steps

| Step | Phase | What | Size |
|---|---|---|---|
| **T-0** 🏗 | P0 | Reconcile `lgr-deploy/vmtest/lib/host.sh` with roomler's host capability on zeus and mars. **Run FR-14's desktop lanes for the first time**, and fix what breaks, with fail-first evidence. | M–L |
| **T-1** | P0 | The two-node harness, the chaos proxy, the TLS front, the TS uplink double; the `two-node` CI job | M |
| **T-2** | P0 | `scripts/seed-fieldtest.ts` and `data-scan` | M |
| **T-3** 🏗 | P1 | `shop-standalone` (Win11 + Win10 MSI, `deb`, `compose`, `k8s` on k3s), `no-avx` (`.deb` + MSI), `soak`; goldens; master and local drivers; LAN verbs, `power-pull`, `snapshot-revert`, `clone`; the e2e `master` project | L |
| **T-4** 🏗 | P2 | global-eph on mars (compose, TLS front, test domain + certificate, dnsmasq, stubs); WAN verbs with IFB; `shop-linked` at Control; ephemeral node keys | L |
| **T-5** 🏗 | P2 | `shop-corp`: Server 2022 and 2019 goldens, corp-proxy (PAC, proxy authentication, machine-store root), AppLocker, `drop-multicast` | M |
| **T-6** | P3 | `shop-linked` at Full (`capture` … `supto-hold`); remote-user; the e2e `node` project | L |
| **T-7** 🏗 | P3 | jupiter: playbook 15 (opt-in); `two-shops`, `restore-and-lost`, first in an announced window | M |
| **T-8** 🏗 | P3 | `shop-prod`: the anchor master on zeus, home of `lgr-fieldtest-onprem` at Full, on the beta channel | M |
| **T-9** | P3 | The lifecycle for real; the release gate in `server-release.yml`'s promote step; the `lgr-vmtest` skill | M |

**How the phase steps map onto these:**
- P1-11 = T-3 against the P1 build;
- P2-8 = T-4 + T-5;
- P3-9 = T-6 + T-7 + T-8, then T-9, then Part C.4.

### F.9 Driving it

From the dev box via mars, always in `tmux` with the output `tee`d:

```bash
./vmtest/lgr-vmtest.sh bake --lane shop-standalone --host zeus
./vmtest/lgr-vmtest.sh run --lane shop-standalone --method msi --type airgapped --host zeus
./vmtest/lgr-vmtest.sh run --lane shop-linked --type full --host zeus+mars
VMTEST_JUPITER_WINDOW="2026-11-07 20:00-23:00 announced in #ops" \
  ./vmtest/lgr-vmtest.sh run --lane restore-and-lost --host zeus+jupiter+mars
./vmtest/lgr-vmtest.sh report
VMTEST_FILE_ISSUES=0 ./vmtest/lgr-vmtest.sh triage --run-dir ~/lgr-vmtest/<stamp>
```

---

## Part G — What the independent review changed (2026-10-19)

The brief asks that evidence against a decision be stated, not quietly planned around. The first draft
was reviewed adversarially: about 50 anchors were checked against the code, `node_modules`, roomler-ai
and lgr-deploy. These are the changes, and why.

### G.1 Blockers

| Finding | Evidence | Change |
|---|---|---|
| **B1 — loopback trusted while the tunnel replays the internet onto it** | The tunnel replayed requests to the API's loopback port carrying the internal secret, so `/internal/repl/page`, `/internal/shutdown` and setup were reachable from the internet. A second `Bun.serve` fed by `app.handle` has no WebSocket handlers: Elysia 1.4.29 upgrades through `app.server`. | **D-15**; FR-20.16 and FR-20.18 rewritten. The supervisor owns every ingress and stamps the source; control moves to a socket that is not a TCP port; the setup token; AC 47, 48. |
| **B2 — global sessions on a node origin** | `POST /auth/switch` (`auth.controller.ts:232-245`) enters any org with a token carrying `iid`, and the node origin runs the master's code when it returns. | **D-5** amended; FR-20.75 rewritten. Read-only mode lives on lgrai.app's origin, and the node address shows only a notice; AC 34 and 39 extended. |
| **B3 — restored, reverted or cloned masters re-issue numbers** | The instance epoch was regenerated only by the supervisor's own restore. Overlapping seqs were acked "without writing", and Air-gapped masters had no witness at all. | FR-20.51 extended (restore lock driven by outside witnesses, clones); FR-20.64 (hash chain); FR-20.71 (re-seed, not merge); AC 49, 50. |
| **B4 — promoting a partitioned but alive master** | The dialog stated loss, not duplicate numbers; the fence cutoff was undefined; a collision had no remedy. | FR-20.8 (cutoff in the refusal); FR-20.81 (evidence, series freeze, replacement); FR-20.84 (credit note + re-issue); AC 51. |
| **B5 — blobs written where the master says** | `<UPLOAD_DIR>/<relative path>` taken from a page, in a pod that runs as root; a global `blob-want` acting as an existence oracle. | FR-20.66 and FR-20.69: content-addressed per org, path validation, per-org `blob-want`; AC 52. |

### G.2 Major findings

| Finding | Change |
|---|---|
| A revocation (4403 → exit 7) stopped the shop | FR-20.52 and FR-20.94: a refusal stops only the link; exit 7 is redefined (A.3); AC 53 |
| Desktop updater and presence would not trust a master's CA | FR-20.31: one trust client for everything; P1-6 touches `presence.rs:115` and `install.rs:371,391-397` |
| The onboarding day was impossible (no memberships before the move); re-point came from the wrong side; new desktop ids broke `bridgeDesktopId`; files lost on the way back | **D-6** amended; FR-20.40 (credentials set on lgrai.app), FR-20.79/80/82 (re-point by the connected side, ids kept, file drain); AC 54 |
| A missing home row failed open; FR-20 state went into bundles; the cache was per process | FR-20.3 (two records, `hold`, the highest epoch wins, bundle exclusions); FR-20.4 (allocation checks the home in its transaction); AC 55 |
| Global migrations, retention and enrollment wrote mirrored data | FR-20.4 (Mongoose write guard), FR-20.5 (sweeps, migrations, enrollment); AC 56 |
| The apply did not fit `Org`, nested splits, `mirrorBlob` or `ExchangeRate`; duplicate keys aborted pages | FR-20.62, 20.63, 20.65: `Org` by `_id`, dotted leaf paths, mirror state outside documents, documents with no org never journaled, collision → delete + insert + resend |
| A master could inject memberships into global | FR-20.63: `identityId` only where global sanctioned it; pages projected on the master |
| Capture could miss writes (lazy collections, `$setOnInsert` reseed) | FR-20.15 (explicit creation), FR-20.61 (full re-journal, journal epoch, `{coll, docId}` index) |
| The restore merge resurrected deleted documents; a new PC was undefined; node secrets were in no backup | FR-20.71 (re-seed), FR-20.81 (replacement), FR-20.21 (what no backup holds) |
| Idempotency did not survive a crash; key not bound to the body | FR-20.37: key on the document, fiscal state, query the device on resume, body hash; AC 7, 57 |
| Read-only mode broke POST reports and exports | FR-20.4: gate by effect with `readOnly` routes |
| Control contradicted the relays | **D-9** amended; FR-20.54; AC 26 |
| The hash scan looked for bcrypt; keys were trusted on first use; a local password could equal the global one; PIN lockout was a DoS; a 32-bit pairing comparison; person edits on a linked master | FR-20.44 (argon2 patterns), FR-20.39 and FR-20.55 (keys built in), FR-20.40 (inequality check, LAN-only, backoff), FR-20.29 (six words), FR-20.42 (person edits on lgrai.app); AC 23, 64, 65 |
| Service-account proxy discovery; API egress outside the OS store; the firewall profile; hanging calls; DHCP changes; bufferbloat | FR-20.53 (machine proxy, authentication, egress through the supervisor, timeouts), FR-20.92 (all profiles), FR-20.28 (find by nodeId), FR-20.52 (pacing) |
| The updater: helper trusting staged files; networked rollback; a failed MSI leaving the server stopped | FR-20.11 and FR-20.20: helper resolves and verifies itself, versioned directories, local rollback, confirmation; AC 59 |
| P0 migrations not rollback-safe | FR-20.45 (dual-write), FR-20.24 (expand then contract) |
| Legal: `run-script` shipped invoice-altering tools; the SUPTO gate covered masters only; no remote inspection path off-site; the 2-hour rule was claimed but absent; the vault claim was false; Drive residency; unverified clock pushes | FR-20.26 (vetted allow-list), FR-20.50 (global too), FR-20.47 (remote inspection path), FR-20.49 (rule is new), FR-20.21 (org key pair for the vault, Drive only with an EU region), FR-20.22 (verified clock only); AC 58, 62, 66, 67 |
| Coverage gaps (Air-gapped, k8s, Win10, Server 2019, MSI no-AVX, soak); requirements without ACs; kill switches; missing failure modes | FR-20.109 and FR-20.111 (cells), AC 47–67, B.10, A.10, R22 |

### G.3 Minor findings, fixed in place

- **Anchors:**
  - org creation is `services/src/biz/auth.service.ts:193-198` and `auth.controller.ts:81`;
  - `background/task.service.ts`, not a 47–145 range;
  - `account.service.ts:45`;
  - `POSTransaction.unpNumber`.
- **The `/ws/desktop` pattern note** (P0a-3).
- **Consistency:**
  - the `fenced` and `hold` states;
  - the Westmere CPU model everywhere;
  - `master_outdated` as a control message;
  - the `mongod` port chosen at install;
  - the T-6 dependency;
  - the calendar sum;
  - the LAN listener's default;
  - the tunnel's path wording;
  - "Air-gapped" replacing "standalone" as a link level.
- **`pipe: true`** for Chrome.
- **vmtest details:** the routed cut, IFB, certificate reuse, the 24 h node reaper, and the harness's
  TLS front.
- **The rehearsal uses synthetic data,** not a regal-pz clone.

### G.4 The owner's answers (2026-10-20)

goran answered FR-20 §12 the day after the review. Most answers confirm the draft. One changes a
decision:

| Answer | What changed |
|---|---|
| **Q7: the address is `<org slug>.lgrai.app`**, e.g. `regal-pz.lgrai.app` | **D-13 reversed.** The first draft put masters under a separate registrable domain on the Public Suffix List, with random labels, because a subdomain is same-site with lgrai.app. The decision keeps the brand and a memorable address. The plan now hardens lgrai.app itself (P0a-8: `__Host-` cookies only, none accepted on same-site requests, CORP and origin-keyed agent clusters). Addresses are issued only to licensed, sys-admin-approved orgs with unreserved labels (P3-4), and the edge answers anonymous API requests itself (FR-20.78). What hardening cannot remove is recorded as R24 and in D-13. The Public Suffix List submission is gone from P2-1, and the test domain must not be under lgrai.app (T-4). |
| Q1 thin locals, Q2 read-only while the master is offline | Confirmed; no change. |
| Q3, Q5, Q8, Q10, Q11 "per your recommendation" | Recorded in FR §12 and carried into Part C.4: regal-pz first and alone, the accountant in writing, НАП queried now and LGR declared before the first fiscal receipt, one system on the A3 at a time, 24 h + attestation. |
| Q4 "make a proposal" | FR-20.55 now holds one: Enterprise, priced per user; 30 days of grace; then no new sessions or documents, at a day boundary; never blocking closing, refunds, payments, exports or leaving. It awaits confirmation. |

---

## Progress

| Step | State | PR |
|---|---|---|
| P0a-1 every by-id route scoped by org | done 2026-10-23 | Merged from its private fork; deployed in `v20261023-f8afae854508`. Prod smoke: another org's document answers 404 to GET and PUT; an update operator in a body answers 422 |
| P0a-2 PDF rendering that opens no socket | done 2026-10-23 | Merged from its private fork; deployed in `v20261023-f8afae854508`. Prod: invoices print (140 KB, ~3 s), and the pod listened only on 4001 while six PDFs rendered. Follow-ups: #184 gives every render a deadline (deployed `v20261023-5fe108e268ba`); #185 drives Chrome over its loopback WebSocket, because Bun loses CDP messages on the pipe (10 of 60 renders stalled in the production image; 0 of 100 over the WebSocket). With #185 a render opens one socket, Chrome's own, on 127.0.0.1, on every OS: P1 needs it closed on a master |
| P0a-8 `__Host-` cookies, same-site guard, isolation headers | release N done 2026-10-23 | #183, deployed `v20261023-e687faca95ab`. Prod field test 13/13: both cookie names set (`__Host-auth` Secure, `Path=/`, no Domain), a `Sec-Fetch-Site: same-site` request is not authenticated by the cookie while a cross-site navigation is, CORP and `Origin-Agent-Cluster` on API and SPA answers, `__Host-oauth_state` on the OAuth start, sign-out clears both names. It exposed an Elysia bug on Bun 1.3.10: a JSON answer that sets two cookies went out as text/plain (#186). Release N+1 (stop writing and reading the plain names) must ship before P3-4 |
| P0a-3 `/ws/tasks` first-message auth | done 2026-10-20 | #158 (closes #154) |
| P0a-4 idempotent hot path, crash-safe | done 2026-10-21 | #160 (POS), #161 (invoicing); closes #155 |
| P0a-5 one УНП counter per fiscal device | done 2026-10-21 | #163 (closes #156). ⚠ After deploying it, run `bun run migrate` once (or set `MIGRATIONS_AUTO=true`): until then a fiscal sale on a device with history is refused, not mis-numbered |
| P0a-6 schedulers independent; tasks owned | done 2026-10-21 | #166 |
| P0a-7 timeouts on every outbound call | done 2026-10-21 | #165 |
| P0b-1 node role; refuse committed example secrets | done 2026-10-21 | #164 (closes #157). `pdf.chromePath` lands with P0a-2 |
| P0b-2 home registry, route gate, write guard | done 2026-10-21 | #167, #169. The read-only request context moved to P0b-4 (it needs P0b-4's list of GETs that write; see #169 for the Bun `AsyncLocalStorage` findings) |
| P0b-3 cross-org writers, sweeps, migrations | done 2026-10-21 | #170. `homeScope()`; joining an org homed elsewhere (invite, registration, OAuth, desktop enrollment) is refused |
| P0b-4 reads that write | done 2026-10-21 | #172. The read-only request context; `GET_WRITERS` lists the companion-number print, the App Hub and the OAuth callback. At home an unlisted one is warned about, not refused |
| P0b-5 schedulers gated by home | done 2026-10-21 | #173. Digest, backup, desktop reaper, and the orphaned-task sweep; `homeScope(field)` |
| P0b-6 scripts refuse to write elsewhere | done 2026-10-21 | #174. `scripts/lib/home-guard.ts`; `backfill-movement-reference` now requires `--org` |
| P0b-7 versioned migrations runner | done 2026-10-21 | #162. Global still runs `bun run migrate` by hand (`MIGRATIONS_AUTO=false`) |
| P0b-8 relative file paths | done 2026-10-23 | #177 (release N): readers take either form (`resolveStored`), `File.sha256` + migration `0002`. #182 (release N+1, closes #180): writers store the relative form, and migration `0003` rewrote the rows. Prod after `0003`: 2996 `DocFile` and 2973 local `File` rows, none absolute, every document's bytes present; the 167 `File` rows the Files app had left pointing into the inbox now point at their document; 127 rows with no bytes and no document are listed, not deleted (removing them is the owner's call). Roll back no further than `v20261023-0290f81fffaa`'s predecessor that reads both forms (#177) |
| P0b-9 reproducible, allow-listed build | in part | #176: `.dockerignore` (S-10), merged. The lockfile, the allow-listed runtime stage and the `--compile` spike are not started |
| P0b-10 bundles exclude FR-20 state | done 2026-10-21 | #175. `db/home/node-state.ts` (`OrgHome`, `BackgroundTask`); a restore skips such a section from an older bundle |
| P0b-11 docs | done 2026-10-21 | #179: the model count (71), `desktop.md` and `overview.md` as built, the SUPTO producer appendix, the new `docs/architecture/nodes.md`, and CLAUDE.md's package and script lists |
| every other step | not started | — |
