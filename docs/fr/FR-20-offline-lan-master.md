# FR-20 — Offline operation: an on-prem LGR server per org (master), LAN workstations (locals), and an optional link to the cloud (global)

**Goal:** a shop keeps selling, invoicing and receiving goods in LGR when its internet line is
down, as it does today in PlusMinus. A company that does not want its data in the cloud can run
LGR entirely on its own machines.

**The idea in one paragraph:** every org has exactly one **home**: the node that holds the
authoritative copy of its data and the only one that writes it. Today the home of every org is
the cloud (lgrai.app). FR-20 adds a second kind of home, the **master**: the same LGR server, with
its own MongoDB, installed in the shop or in the company's server room. The shop's workstations
(**locals**) are LGR Desktop installations that work against the master over the LAN, so the
internet is not on the path of a sale. While the master has internet, it **mirrors** the org to the
cloud continuously, the cloud carries remote users' requests to it, and the cloud holds the
off-site copy. When the internet is down, nothing in the shop notices, and the mirror catches up
when the line returns. The link to the cloud is optional.

Status: draft, owner's answers of 2026-10-20 recorded (§12: Q4 is a proposal awaiting confirmation;
Q6 and Q9 are open) · Date: 2026-10-19 · Tracking: [gjovanov/lgr#153](https://github.com/gjovanov/lgr/pull/153); P0 bugs #154–#157 · Depends on:
[FR-14](FR-14-lgr-desktop-app-server-mode.md) (desktop: registration, native fiscal bridge,
updater, signing), [FR-19](FR-19-global-accounts-org-switcher.md) (Identity + memberships),
[FR-13](FR-13-backup-archive.md) (bundles, restore) · Planning prompt:
[FR-20-PROMPT](FR-20-PROMPT.md) · Plan: [FR-20-IMPLEMENTATION-PLAN](FR-20-IMPLEMENTATION-PLAN.md)

**Relation to the withdrawn local mode.** FR-15–FR-18 (2026-09-28, `bc48d04`) stay withdrawn. §2.7
records what FR-20 takes from them and what it does differently.

Driving input, goran, 2026-10-19:

> *"one of the issues we need to tackle is support offline working of lgr...*
>
> *regal org and their current software plusminus supports offline (in same LAN work). often
> times they lose internet connection and this is a problem during daily work like cash register
> sales, invoices, POS... hence we need investigate and propose an architecture that support
> offline work. one option that i think it would work is to have three types of installations.
> 1. global (current lgr server accessible via lgrai.app), 2. master - master server and desktop
> app, that behaves as a central unit/server for a given org, 3. local - local server and desktop
> app, for daily work e.g. cash register, warehouse, accounting etc. the idea is that all local
> instances connected with their master in LAN and they sync their changes to the master. Also
> for the sake of doc sequence numbers (like invoice number), they always ask the master to give
> them the latest incremented number. The master is also syncing with global either in realtime
> or if no internet connection, when the connection is back. The connection and sync to global is
> optional but recommended. This also opens door for privacy and security concerns of corps
> (their data doesnt leave their servers).*
>
> *mind map:*
> *- one or more client & server apps*
> *- mongod vs sqllite*
> *- realtime sync (idempotent, resillient, resumable, scalable)*
> *- cross platform (win, linux, macos) - see https://github.com/gjovanov/roomler-ai how it does it)"*

**How this FR answers the request.** It keeps the three installation types and the master as the
number authority.
- **The local is thin**: LGR Desktop bound to the master, with no server or database of its own
  (D-3 explains why).
- **Sync to global is one way**, from master to cloud, and global is a mirror (D-4, D-5).
- **The mind map** is answered in:
  - D-2 (mongod);
  - FR-20.61–20.71 (real-time sync that is idempotent, resilient, resumable and scalable);
  - FR-20.10–20.27 (the three OSes, packaged the way roomler-ai packages `roomlerd`).
- **Coverage** (added 2026-10-19 at goran's request: *"add coverage with integration & e2e test -
  via throwaway instances on mars, zeus, jupiter - similar like in roomler-ai repo
  FR-61-vmtest-matrix.md"*) is §5.14 and D-14.

---

## 0. In plain language

Take one regal shop. Today every till, every invoice and every fiscal receipt goes over the
internet to lgrai.app and back. When the line drops, the till cannot sell, because even the fiscal
printer on the counter is driven from the cloud. After two hours without it, the law requires the
software to stop opening sales at that till (§2.8).

After FR-20:

- **One PC in the shop runs "LGR Server", the master.** It is the same LGR that runs at lgrai.app,
  with its own database, installed as a service so it comes back by itself after a power cut. The
  shop's data lives on it.
- **Every other PC runs LGR Desktop**, registered to that server instead of to lgrai.app.
  - Tills, the office PC and the warehouse PC talk to the master over the shop's network.
  - The fiscal printer is driven by the master, and invoice numbers come from the master.
  - **Nothing a person does in the shop needs the internet.**
- **When the internet is up**, the master copies every change to lgrai.app within seconds.
  - People outside the shop (the owner at home, the accountant) open the org from lgrai.app as
    today. Their clicks are carried to the master and answered there.
  - lgrai.app is also the shop's off-site copy.
- **When the internet is down**, the shop does not notice. lgrai.app shows the org as a read-only
  copy, marked with the time it was last up to date, and the copy catches up by itself when the
  line returns.
- **When the master PC itself is off**, the tills say so plainly and wait for it, exactly as
  PlusMinus does when its server is off. A second PC can be added as a standby (FR-20.102).
- **A company that does not want its data in the cloud** runs the same LGR Server with the cloud
  link set to *Control* (only the licence and updates go out) or *Air-gapped* (nothing goes out).

## 1. Why

- **regal's line drops during trading days, and LGR stops with it.**
  - PlusMinus is a LAN client–server program, so a lost internet line does not touch it.
  - LGR is served entirely from lgrai.app: every screen, every login, every document number, and
    the **fiscal printer itself**. The native bridge only moves bytes; the drivers and the УНП run
    in the cloud (FR-14.26).
  - **The law turns that into a hard stop.** The one live link Н-18 requires is the one between
    the software and the fiscal device. Sales may open only with a device reached within the last
    two hours, after which opening sales is blocked for that workstation (Прил. 29 т. 8). After
    that, the only fallback is the paper book (кочан, чл. 36(1) т. 6). With the master on the LAN,
    that link never leaves the shop (§2.8).
- **This keeps regal from switching PlusMinus off.** regal's staff already enter their documents
  in LGR every day. They cannot rely on it at the till until an outage costs them nothing.
- **Some companies will not put their books in someone else's cloud.** The request names them.
  Today LGR has nothing to offer them.
- **The previous answer to "offline" was too big.** FR-15–FR-18 put a second database engine on
  every till and merged two writers, and they were withdrawn the day they were written (§2.7).
  FR-20 comes at offline from the other side: the shop gets its own copy of the whole server, and
  the cloud gets a copy of the shop.

---

## 2. Current state (verified 2026-10-19, `origin/master` @ `ab0a446`)

### 2.1 One deployment serves everything, from one process

- **Deployment.** LGR is one Kubernetes deployment behind lgrai.app: a single image on
  `oven/bun:1.3.10-slim`, beside a single-node MongoDB 7 replica set, rolled out by ArgoCD from
  `lgr-deploy` (CLAUDE.md "Deployment").
- **How the API runs.**
  - It is unbundled TypeScript started with `bun run start` from `packages/portal-api`.
  - It finds its UIs as `../<mod>-ui/dist` and its environment as `../../.env`, both relative to
    that directory (`unified.ts:34-40`; `portal-api/package.json:8`).
  - It speaks plain HTTP (`unified.ts:109`); TLS is the ingress's.
- **It is one process by design.** The fiscal printer registry, the bridge sockets, the desktop
  sockets, the task store and the event bus all live in memory:
  - `fiscal/src/fiscal-device.service.ts:15`
  - `portal-api/src/websocket/fiscal-bridge.ts:106-171`
  - `websocket/desktop.ts:40`
  - `background/task.store.ts:5`
  - `events/event-bus.ts:62-104`

  A POS sale handled by a process other than the one holding the bridge cannot print.
- **MongoDB must be a replica set.** Three flows use multi-document transactions:
  `invoice-with-update.service.ts:23,70`, `movement-with-update.service.ts:52,107` and
  `reservation-ops.service.ts:255,693`. Nothing uses change streams yet.
- **Background work.**
  - Schedulers start in `unified.ts:153-229`: fiscal-status reset, time sync, digest, backup,
    retention and the desktop reaper.
  - They all start inside one `setTimeout` with one empty `catch`, so if one step throws, every
    later scheduler silently never starts.
  - Files analyze/commit jobs run inside the API process (`background/task.service.ts`). After a crash
    their rows stay `processing`, and nothing recovers them.

### 2.2 What needs the internet today

First, **the app itself**: lgrai.app is the only place the SPAs and the API are served. Then
**the fiscal path**: the till's bridge connects to the server's `/ws/fiscal-bridge`, and the
drivers and `generateUNP` run on the server (FR-14.26, `pos.controller.ts`). Every receipt is a
round trip through the cloud.

Beyond those, the server calls out to:

| Feature | Where | Without internet |
|---|---|---|
| Mail: activation, reset, invoice email (FR-10), digest, backup manifest | `email.service.ts:117-138` (SendGrid) | Logs a `failed` EmailLog; invoice email answers 502. ⚠ The digest marks its day done even when the send failed (`digest-runner.service.ts:139-142,201-204`), so that day's digest is lost for good. |
| OAuth sign-in (5 providers, incl. the desktop's PKCE flow) | `oauth.service.ts:55-216,316-339` | Sign-in fails. |
| Company / VAT lookup | `company-lookup.service.ts:47` (eik.bg), `:164` (verifyvat) | Empty result. |
| Time check | `time-sync.service.ts:23` (`http://worldtimeapi.org`) | ⚠ Reports drift **0**, which reads as "in tolerance". |
| Off-site backups (Drive, S3) | `backup-destinations.service.ts:173-500` | The destination is marked `failed` and never retried. |
| Document drafting and line matching (LLM) | `doc-import/ocr-client.ts:40,59`; the `lgr-ocr` sidecar | Fails; the deterministic parser still works. |
| Desktop updates and installers | `release-download.ts:129-181` (private GitHub via `DESKTOP_RELEASE_GITHUB_TOKEN`) | 502. |
| Stripe, the analytics script, the Swagger CDN | `stripe.service.ts`; `portal-ui/index.html:8` | Billing pages fail; the rest is harmless. |

Several of these calls set no timeout, so on a black-holed route they hang instead of failing.

**Not present**, so FR-20 need not replace them: an exchange-rate feed (`EXCHANGE_RATE_API_KEY` is
never read; rates are rows, `currency.service.ts:4-40`), a VIES call, UDP NTP, outbound webhooks.

### 2.3 Numbering assumes one allocator per org, and FR-20 keeps it that way

| Series | How it is allocated | Where |
|---|---|---|
| every document counter | `$inc` on `Sequence {orgId, prefix, year}` | `sequence.service.ts:11-27` |
| sales documents | first pulls the counter up to the highest suffix already present (`currentMaxSuffix`), then `$inc` | `invoice-numbering.service.ts:87-147` |
| companion documents (certificate, ПП protocol) | allocated by a **GET** print or export | `invoice-export.controller.ts:701-738` → `ensureCompanionNumber` `:363-377` |
| stock movements (`SM-`) | latest number + 1, found by a scan in 8 places | e.g. `pos.controller.ts:82`, `invoicing.service.ts:111` |
| УНП | `UNP-<device>-<operator>`, `year: 0`, so one counter **per device and operator** | `sequence.service.ts:67-92` |

- **One writer per org makes all of them correct**, apart from the УНП key (§2.8).
- FR-16 had to change all of them to admit a second writer: bands, a band-aware
  `currentMaxSuffix`, infixed internal numbers and a per-device УНП owner.
- **FR-20 keeps one writer and changes none of them, except to fix the УНП key.**

### 2.4 Sessions, identities and orgs

- **Signing keys.** User sessions are HS256 JWTs under one `JWT_SECRET`
  (`portal-api/src/auth/auth.service.ts:20-31`). Desktop tokens use `DESKTOP_TOKEN_SECRET`
  (`desktop/desktop.service.ts:312-364`).
- **Production checks.** Production refuses a missing, default or short secret
  (`config/src/index.ts:126-151`). ⚠ It accepts the values published in `.env.example`:
  `JWT_SECRET=lgr-dev-secret-change-in-production` is 35 characters and is not the fallback.
- **People.** There is one `Identity` per person, on global, holding the password. Each org's
  `User` is a membership (FR-19).
  - Sessions are org-scoped (`tokenize()` plus `iid`/`tv`). A `tokenVersion` bump ends them within
    a minute (`liveSessionUser`).
- **⚠ Identity flows write across orgs.**
  - A password change sets the legacy copy on **every** membership:
    `User.updateMany({identityId}, …)` (`identity/account.service.ts:35-46`).
  - An admin's edit of a member is mirrored into the person's other orgs
    (`identity.service.ts:290-336`).
  - These writes come from `/auth/*` routes, which carry no `:orgId`.
- **OAuth callbacks** are `${OAUTH_BASE_URL}/api/oauth/callback/<provider>`
  (`oauth.service.ts:253-255`). Each must be registered with the provider, which a LAN host name
  cannot be.
- **Orgs and plans.**
  - Anyone can create an org: `POST /api/auth/register` and `POST /api/auth/orgs`
    (`services/src/biz/auth.service.ts:193-198`, the register route at `auth.controller.ts:81`;
    `auth.controller.ts:343`).
  - **Plans are not enforced.** `PLAN_APP_LIMITS` is 7 for every plan (`constants.ts:121-127`),
    and `subscription.maxUsers` is never checked.
  - The platform operator is `BACKUP_SYS_ADMINS`. When it is empty, every restore route answers
    403 (`config:447-450`).

### 2.5 LGR Desktop (FR-14): most of it has shipped

Since 2026-10-05 the shell has had:
- enrollment (`src/enroll.rs`);
- the desktop key: DPAPI on Windows, a `0600` file elsewhere (`src/keystore.rs`);
- presence over `/ws/desktop`;
- the native fiscal bridge in Rust (`src/bridge.rs`);
- the updater, which checks both signatures (`src/install.rs`, `src/update.rs`).

What it does not do yet, and FR-20 needs:
- **One server per machine.** The default is `https://lgrai.app` (`src/settings.rs:42`).
  - `http://` is upgraded to `https://` for any non-loopback host (`src/validate.rs:97-127`).
  - The TypeScript twin of that rule disagrees on `127.0.0.0/8` (`desktop-ui/src/server-url.ts:22-60`).
- **The shell trusts the OS store and nothing else** (`src/enroll.rs:3-7,36-42`): no custom CA, no
  pin. A master with its own certificate is refused today.
- **No discovery.** A server is typed in, or arrives in an `lgr://enroll` deep link.
- **Moving the bridge to another server** needs an app restart (`src/main.rs:523-545`).
- **The `proxy` setting** is declared but never read (`src/settings.rs:32-33`).
- **Stale docs.**
  - `docs/architecture/desktop.md:49` still lists registration, the bridge and the updater as not
    built.
  - `docs/architecture/overview.md` still says business logic never imports Mongoose (60 % of
    `services` does, FR-16 §1.2) and calls the desktop offline-first.
  - CLAUDE.md counts 83 models; there are 70, in 67 files.

### 2.6 Data shape and volume

- **Volume.**
  - The whole production database holds 95,090 documents, 92.2 MiB of BSON across 80 orgs
    (FR-13 §2.1). 73 of those orgs are `e2e-*` tenants.
  - regal-pz is 68 % of it: 60,429 documents, 65.9 MiB. 71 % of that is the one-off seed of 23,246
    products. Its uploads are 1,532 files, 75.9 MiB.
  - Growth is about 169 MB of BSON and 0.68 GB of uploads a year. A daily delta is 30–430 KB
    (FR-13 §2.3).
  - **Moving regal-pz is minutes of copying, not hours.** A catalog rewrite such as
    `assign-din-tags` touches all 23,246 products, about 50 MB.
- **Uploads live on the local filesystem** under `UPLOAD_DIR` (prod: `/app/uploads`, a 5 Gi
  hostPath). ⚠ The stored paths are absolute: `File.storagePath` and `DocFile.currentPath` contain
  `config.upload.dir` itself (`files/doc-store.service.ts:28,155,187,216`), and a restore rewrites
  only the orgId segment (`backup-restore.service.ts:502-506`). A document copied to a server with
  a different root points nowhere.
- **Writes that bypass Mongoose are common**, so only the oplog sees every write. The application
  holds 4 `bulkWrite`, 20 `updateMany`, 2 `insertMany`, 11 `deleteMany`, 6 raw `collection.*`
  write sites and 16 `$inc` sites. The scripts add 11, 3, 6, 7 and 1 more of the first five.
  Every ops script and every `mongosh` fix also bypasses Mongoose.
- **Hard deletes happen in normal flows.** Examples:
  - draft invoices, orders and journal entries;
  - DocFile, File, Tag and PermissionSet;
  - eleven accounting and payment collections with no status guard;
  - TTL indexes on eight collections;
  - `seed-products --clean`, which deletes the whole catalog and re-inserts it under new `_id`s.

  Replication must carry deletes, so the journal needs pre-images (§5.7).
- **Scoping by id is the handler's job.** The tenant guard compares the URL's `:orgId` with the
  token (`tenant-guard.ts:40`). What a handler then loads by id is filtered by org only if the
  handler passes `orgId` (the tenant plugin does not filter, CLAUDE.md). A mirror makes that
  filter load-bearing for another org's data, so FR-20.7 requires it on every by-id route and
  proves it over the route table.
- **Reads that write.** Some GETs write:
  - printing a document allocates a companion number (§2.3);
  - the App Hub inserts `OrgApp` rows on a GET (`app-hub.service.ts:24-37`);
  - every boot resets `FiscalDevice.status` in every org (`unified.ts:157-162`).

#### 2.6.1 Collections, by what they mean for a master

There are 70 models in `packages/db/src/models`. The full table, one row per collection, is in
plan Part A.5. In summary:

| Class | What it means | Collections |
|---|---|---|
| **Replicated** | The org's data, written on its home and mirrored whole | 48 collections: catalog, stock, documents, orders, POS, accounting, payroll, files metadata, audit, the derived StockLevel, CostLayer and Sequence counters, and `ExchangeRate` (its `orgId:null` system rows are never journaled, because a document with no org never is) |
| **Split** | One document, fields with different owners (FR-20.63) | `Org` (company data: home; `slug`, `subscription`, `settings.integrations`: global); `User` (membership: home; person copies: the identity feed; `lastLoginAt`: node-local); `FiscalDevice` (configuration: home; `status`/`lastCommunicationAt`: node-local); `Desktop` (registry: home; presence: node-local) |
| **Global-only** | Belongs to people or to everyone, never written by a master | `Identity`, `AuthToken`, `Invite`, `din_catalog` (masters get sanitised or reference copies) |
| **Node-local** | Belongs to the installation and never travels | 14 collections: `Code`, `OAuthHandoff`, `OAuthPendingRegistration`, `LoginThrottle`, `EmailLog` (it holds raw reset links), `DigestRun`, `BackupRun`, `RestoreRun`, `BackgroundTask`, `Notification`, and the desktop enrollment codes, keys, key uses and assertions; plus FR-20's own state (journal, idempotency keys, local credentials, outbox) |

### 2.7 What was tried before, and what FR-20 keeps

- **The 2026-03 prototype.** A Bun sidecar over SQLite with LAN peer-to-peer sync. It was deleted
  on 2026-09-29 (FR-14.34) for its default credentials (`admin`/`admin123`), its committed signing
  secret and a sync package nothing imported.
- **FR-15–FR-18** (`bc48d04`, 2026-09-28). A SQLite replica on every desktop with two-way
  hub↔desktop sync modelled on PCON+, number bands, outbox projections and an offline route
  manifest gated by import-graph and parity tests. They were withdrawn the same day as too big
  and risky (`d270164`). Two things made them big:
  1. **A second data plane** under a business layer that is 60 % Mongoose-only. Every offline
     route needed porting, a codec and a parity test.
  2. **A second writer.** That meant field-level compare-and-set, five conflict policies, hub
     projections behind idempotent journal-entry handlers, stock overlays, number bands, and a
     restore/clone protocol.

  FR-20 removes both: every node runs the same server over MongoDB, and every org has one writer.
- **What FR-20 keeps from FR-16:**
  - change capture by a change stream into a per-document journal, with its lease, lost-history
    and seeding rules (FR-16.18–16.24, `sync.md` §2.1 and §11);
  - ObjectIds minted by the writer and kept everywhere;
  - the network rules: the system proxy including PAC, and the OS trust store (FR-16.55);
  - a minimum-version gate;
  - no default credentials;
  - one УНП allocator per fiscal device (FR-16.48), now in every mode.
- **What FR-20 drops:** SQLite and any second writer. With them go bands in the core design,
  projections, overlays and conflict policies, which existed only to make a second writer safe.

### 2.8 Legal constraints (Н-18, ЗДДС, ДОПК, ЗСч; read 2026-10-19 on lex.bg)

**When the SUPTO rules apply.** Using a SUPTO is a choice (ЗДДС чл. 118(18)). Глава 7"в" and
Прил. 29 bind regal once LGR is on НАП's list and regal has filed Прил. 32 for the shop.
`docs/supto/` still has blank producer and version fields, so LGR is probably not declared yet. The
fiscal-device, invoice and retention rules apply either way.

| Topic | What the law says | What it means for FR-20 |
|---|---|---|
| **Where the database lives** | Anywhere in **Bulgaria or the EU** (чл. 52з(14)), including archive copies (чл. 52к(1)). Declared per shop in Прил. 32: internet availability, installation type (local / LAN / web / SaaS), data location, DB address, protocol, topology (т. 5, 7, 10–13). Changes are re-filed within 7 days (чл. 52з(1)). | A master on-prem is allowed. A master plus a cloud mirror is declared as such. A move changes the declaration (FR-20.50). Global and every off-site copy must be in BG/EU (FR-20.97). |
| **Losing the database server** | Not regulated. НАП's producer checklist (Кд200) asks about storage *"на сървър в обекта и/или на отдалечен сървър, възможност за поддържане на репликация на БД"*. Replication is anticipated. | One-way replication to a mirror is consistent with it (medium confidence; confirm with НАП, §12 Q8). |
| **The one live link required** | Software → fiscal device. A sale may open with a device reached within the **last 2 hours**; after that, opening sales is blocked for that workstation (Прил. 29 т. 8). The fallback is the paper book (чл. 36(1) т. 6; чл. 40(5)–(8)). Under a SUPTO, the device may not be switched to its own sales mode (чл. 52з(3)). | Today that link crosses the internet. With a master it stays on the LAN (FR-20.36). |
| **Fiscal device → НАП** | Over the device's own **data SIM**, through a mobile operator's VPN (Прил. 1 разд. IIIб т. 1 "а", "в"). The device blocks after **72 h** without transmitting ("м"). The 48 h figure is the paper-book window after such a block (чл. 36(1) т. 4). | The shop's internet does not affect the device's link to НАП (FR-20.49). |
| **УНП** | `XXXXXXXX-ZZZZ-NNNNNNN`. The 7-digit counter is kept **per fiscal device** and steps by 1 for every sale; ZZZZ is the operator (т. 9). It is generated when the **first item** is entered (т. 9.1; Кд200 1.5.2 forbids generating it at the end). Ranges exist only between *different* SUPTOs sharing one device (т. 9, Прил. 32 т. 23). | One allocator per device, on the home (FR-20.45). ⚠ LGR keys the counter per device **and operator** today, so two operators on one device both issue `…-0000001`. That is a bug, fixed in P0. |
| **Invoice numbers** | One **10-digit** series per legal entity, ascending, with no gaps and no duplicates, shared by invoices and debit and credit notes, and **not reset at year end** (ЗДДС 114(1) т. 2; ППЗДДС 78(2)–(3)). Parallel ranges are allowed per поделение/обект (78(4)). НАП reads that as per обект, *"не … на териториален или софтуерен принцип"* (opinion 23-30-16/11.04.2014). An invoice is due within 5 days of the tax event (ЗДДС 113(4)). | A per-till range inside one shop is not acceptable, so there are no invoice bands (D-7). An offline till issues receipts only, and the invoice follows from the master (FR-20.104). |
| **Immutability** | No delete function for the т. 15/18 data (т. 13). The producer must not distribute tools that change or delete database data (ЗДДС 118(14) т. 3). An invoice is never corrected, only annulled (ЗДДС 116(1)). | Replication and repair never delete or alter an issued sale (FR-20.51). A restored master is re-seeded from the mirror, and nothing on the mirror is ever deleted (FR-20.71). |
| **Inspection** | Immediate access to every device, servers included. Devices outside the shop must be made reachable remotely, *"незабавно"* (чл. 52и(1)). The auditor profile can read and export the current and archive databases wherever they are (52и(2)). | The master is inspected on site. The mirror and the tunnel give remote reach (FR-20.47). |
| **Retention** | 10 years, payroll 50 (ЗСч чл. 12; ДОПК чл. 38(1)). Archives must be reachable in the UI (Прил. 29 т. 17). | Unchanged; the master runs FR-13 (FR-20.21). |
| **Versions** | A change to Прил. 29 functionality or to the database structure is a new version. The producer declares it within 7 days (52в(3), (3а)), and the trader updates Прил. 32 within 7 days. A build suffix is allowed. | Self-updating masters must not take an undeclared SUPTO version (FR-20.50). |

**Found along the way.** These are not FR-20's, but they belong in a SUPTO-compliance ticket before
LGR is declared:
1. **The УНП counter key**: per device+operator instead of per device (`sequence.service.ts:79-86`).
   FR-20 fixes this in P0, because the home's allocator is what moves.
2. **When the УНП is generated**: at checkout (`POST /session/:id/transaction`), not at the first
   item, so an annulled open sale (т. 12) cannot be captured.
2a. **The 2-hour device rule is not implemented** (т. 8). Nothing reads
    `FiscalDevice.lastCommunicationAt`. FR-20.49 needs it.
3. **The POS "Non-fiscal" toggle** (`pos.controller.ts:597-661`) conflicts with Прил. 29 т. 10,
   11 and 20 and чл. 7а(2) (*"Не трябва да има настройка – да се отпечатва или не ФБ"*, Кд200
   2.2.10).
4. **Issued invoices are editable** in every status (CLAUDE.md), against ЗДДС 116(1).
5. **The 18.x reports** are not split by currency at 01.01.2026 (§ 74 ПЗР, ДВ 42/2025).
6. **`docs/supto/` errors:**
   - it names the wrong producer appendix (Прил. 30/31, not 32);
   - it cites the archive rule as т. 16 instead of т. 17;
   - its checklist still relies on the repealed т. 3.
7. **The FR-13 Drive and S3 copies** need BG/EU storage regions.
8. **The invoice number format.** The law requires a pure 10-digit series that does not reset at
   year end (ЗДДС 114(1) т. 2; ППЗДДС 78(2)–(3)). LGR's **default** is neither:
   - the default format is `INV-<year>-NNNNN`;
   - the counters are year-scoped (`Sequence {orgId, prefix, year}`, `sequence.service.ts:11-27`).

   The display prefix is configurable, so whether regal's configured series complies needs
   checking before regal-sf moves, together with the question of one legal entity across its orgs
   (§12 Q3).

Confidence: high on the texts. Medium on reading replication as acceptable, and on НАП's
range opinions, which are individual and not binding. What goes to НАП and to the accountant is
settled in §12 Q5 and Q8.

### 2.9 Findings that a LAN or the internet makes worse

These are not offline problems. A master exposes them to the shop's LAN, and the tunnel (§5.8)
exposes them to the internet:

- **PDF rendering runs Chrome beside the API.** On a master, which is a shared PC on a shop LAN,
  rendering has to be self-contained: Chrome from the package, driven over a pipe, with its
  sandbox on, fonts bundled, and nothing listening on a socket (FR-20.25).
- **`/ws/tasks` trusts `?userId=`** (`websocket/ws.server.ts:31-69`). Any client can subscribe to
  any user's task and notification messages.
- **The client IP comes from headers** (`X-Real-IP` or the last `X-Forwarded-For` hop,
  `auth/client-ip.ts`). On a LAN with no proxy, a client chooses the IP the login throttle sees.
- **Build and deploy hygiene:**
  - Swagger is unauthenticated (S-11).
  - `.dockerignore` does not exclude the gitignored secrets (S-10).
  - `bun.lock` is gitignored (`.gitignore:7`), so no build is reproducible.
  - About 5.5 GB of the ~7.5 GB image is unexplained.

---

## 3. Vocabulary

| Term | Meaning |
|---|---|
| **Node** | One LGR server installation: `global` (lgrai.app, many orgs) or a `master` (on-prem, one or a few orgs). |
| **Local** | A workstation: LGR Desktop registered to a master. Not a server; it holds no business data. |
| **Home** (of an org) | The one node that holds the authoritative copy of the org's data and is the only one that writes it. `global` unless the org has moved on-prem. |
| **Mirror** | A read-only copy of an org on a node that is not its home. In FR-20 the only mirror is global's copy of an on-prem org. |
| **Move** | A change of an org's home: cloud → master, master → cloud, or promoting the mirror when a master is lost. Fenced by the epoch. |
| **Epoch** | A counter on the home record, incremented by every move. Anything stamped with an older epoch is refused. |
| **Link level** | How much a master shares with global: Full, Control or Air-gapped. |
| **Uplink** | The master's outbound connections to global. They carry control messages, replication and the tunnel. Nothing on the internet connects in to a master. |
| **Tunnel** | Requests from people outside the shop, carried by global over the uplink to the master. |
| **Journal** | The master's per-document change index, fed from its oplog (FR-16 D-1). Replication reads it. |
| **Watermark** | How far global's mirror has applied an org's journal, per instance epoch. Kept on global. |
| **Instance epoch** | A random id that a master's database carries. Every restore from backup regenerates it. |
| **Freeze** | A short state during a move in which neither side accepts writes for the org. |
| **Fence cutoff** | The watermark global held for an org when a higher epoch began. A fenced master exports everything above it. |
| **Hold** | A global org state: read-only until a sys-admin or the org's node resolves who is home. Used after a disaster-recovery restore, or when the two home records disagree. |
| **Restore lock** | A legal series that is locked after the database went back in time: a restore, a snapshot revert or a clone. It resumes only above every number that may already have been issued. |
| **Air-gapped** | A master with no link to global at all. It is licensed by file, updated by hand, and owns its people. |
| **Local credential** | A password or till PIN a person sets for one master, so they can sign in there while the internet is down. It never leaves that master. |

---

## 4. Decisions

| # | Decision | Rejected alternatives, and why |
|---|---|---|
| **D-1** | **Every org has exactly one home, and only the home writes the org's data.** The home is `global` by default, and becomes a master when the org moves on-prem (FR-20.3). Every other copy is a read-only mirror. | *Multi-master* (global and master both writable, merged later): an ERP's invariants do not merge. Gapless legal numbers, stock that cannot be summed from history (FR-16 §1.6), weighted-average cost and journal-entry posting all break. FR-16 needed field-level CAS, five conflict policies, projections, overlays and number bands to make two writers safe for a *subset* of the product, and that is what was judged too big. *Automatic failover of the home* (whichever side is reachable writes): a partition makes both sides home, and two allocators then issue the same invoice number. A duplicate legal number cannot be taken back (ЗДДС 114, ППЗДДС 78(2)). |
| **D-2** | **A master runs the same server as global**: the unified Bun API over MongoDB (a single-node replica set), the same built UIs and the same migrations. One codebase, one data plane, a role switch. | *SQLite:* the business layer is Mongoose (60 % of `services` imports it directly, and every subsystem since April does). SQLite would mean a second data plane, an offline route manifest and parity tests: the FR-16 cost, and the reason the 2026-03 prototype rotted. *FerretDB on SQLite:* no multi-document transactions and no change streams, and LGR needs both. *Postgres + DocumentDB:* the same objection, plus a new engine to run. |
| **D-3** | **Locals are thin.** A local is LGR Desktop (FR-14) registered to the master instead of to lgrai.app. Every request, every number and every fiscal command goes to the master over the LAN. A local holds no business data. | *A full LGR server with its own database on every workstation* (the request's "local server"). It helps only when the master is unreachable, and in that moment it cannot get numbers from the master, which the request requires. So it cannot issue an invoice or a receipt. Working around that means writing while disconnected: multi-writer again (D-1), one level down. It also puts `mongod` on every till (AVX, RAM, a service, backups ×N). The failure it would cover is better handled by a standby master (FR-20.102) and, if field data shows the need, by a narrow **offline till** that issues fiscal receipts only (FR-20.104). Inside a working LAN, a thin local loses nothing: it gets the number from the master on every request, exactly as the request asks. |
| **D-4** | **Master → global is one-way state replication of the whole org.** A change-stream tailer captures it from the master's oplog into a per-document journal (FR-16 D-1, kept). It is pushed in pages over an outbound connection, and global applies each page atomically and idempotently. | *Native MongoDB replication* into the multi-tenant cluster: a replica-set member replicates a whole deployment, not one org, and global serves 80 orgs from one set. *Periodic `mongodump`:* not real time, and a full copy every run. *A Mongoose middleware outbox:* 60+ bulk and raw write sites and every ops script bypass it, and a sync that misses writes diverges silently. *Polling `updatedAt`:* 81 % of regal-pz per week because of catalog rewrites, and it cannot see deletes (FR-13 §3.4). |
| **D-5** | **Remote work on an on-prem org goes through the master.** A request to the org from outside is tunnelled to the master over the same outbound connection, and the master answers it. When the master is unreachable, global serves the mirror **read-only, on lgrai.app's own origin**, and says since when. The master's address then shows only a notice (FR-20.75). | *Global accepts writes and replays them later:* that is a second writer (D-1). *Global serves its own UI against the master's API:* masters update on their own schedule, so the two run different releases and the SPA and the API drift apart. The whole app, UI and API, is served by the master through the tunnel, so they always match. *Read-only mode on the master's address* (the first draft): a global session minted on an origin the master's code controls would be harvested when the master returns, and through `/auth/switch` it reaches every org the person belongs to. |
| **D-6** | **Global is the identity provider of a linked master; the master keeps a local fallback.** While the internet is up, people sign in to a master with "Sign in with LGR", an OIDC-style redirect to lgrai.app, so **a global password never reaches a master**. For outages, each person sets a **local credential** for the org's master on lgrai.app: a password that must differ from the global one, or a till PIN. Global delivers only its verifier to the master. Local credentials work only on the LAN, never through the tunnel. An Air-gapped master owns its identities outright. | *Replicating password hashes to masters:* a person's single global password (FR-19) would become brute-forceable by whoever runs any master of any org they belong to. *Online-only sign-in:* defeats the purpose. *A JWT secret shared between global and masters:* a master could mint tokens for every org on global. *Local credentials set only on the master after an online sign-in* (the first draft): the memberships do not exist on the master until the move copies them, so nobody could set one before the move. |
| **D-7** | **The home allocates every number.** Sequence counters are org data; they live on the home and move with it. Locals never allocate: they get the number in the response to the request that creates the document. There are no number bands. | *Bands per workstation* (FR-16.43): needed only when two allocators run disconnected, which D-1 and D-3 remove. They are also unlikely to pass: НАП allows invoice ranges per обект, "not on a software basis" (§2.8). The offline till (FR-20.104) issues fiscal receipts only, so it needs no invoice range either. *Assigning numbers on sync:* a receipt or invoice handed to a customer already carries its number. |
| **D-8** | **One server package, three ways to run it.** An installable **LGR Server** for Windows, Linux and macOS: an OS service supervising a bundled `mongod` and the API, signed with roomler's identity and updated with roomler's rules. A **Docker Compose** bundle. And the existing **Kubernetes manifests**, for companies that host it themselves. | *A server inside the desktop app:* it would stop when the user logs off, and a shop's master must come back after a power cut with nobody signed in. *Docker only:* a Windows shop PC without Docker is the common case at regal. |
| **D-9** | **The link to global is optional and has three levels**, chosen per master: **Full** (mirror, remote access, identity, updates, licence), **Control** (licence, updates, health and identity; no business data leaves the building unless the org turns on a relayed service, each of which says what it sends) and **Air-gapped** (no link at all: a signed licence file, updates by hand, the master owns its people). | *Always linked:* rules out the corporate privacy case the request names. *One sync on/off switch:* a company that refuses the mirror still wants updates and a licence that renews itself. |
| **D-10** | **On the LAN, the desktop is the supported client.** It reaches the master through a loopback proxy in the shell (`http://127.0.0.1:<port>`, a secure context), over TLS pinned at pairing. There is no certificate warning and no CA to install, and secure-context APIs keep working. Browser access on the LAN is opt-in per subnet. | *Browsers straight to `https://<lan-ip>`:* a self-signed warning on every PC, or a private CA pushed to every machine. *A public DNS name with a real certificate pointing at a LAN IP:* needs public DNS, which is exactly what is missing during an outage. |
| **D-11** | **Sync is opt-in per org.** The first org is a dedicated field-test org, then regal-pz. | *On for every org:* 73 of the 80 production orgs are `e2e-*` tenants. |
| **D-12** | **Shared cloud secrets never leave global.** SendGrid, Stripe, the OAuth client secrets, the Anthropic and Claude credentials, the Drive client, `DESKTOP_RELEASE_GITHUB_TOKEN`, `JWT_SECRET`, `DESKTOP_TOKEN_SECRET` and the seal key stay in `lgr-secret`. A linked master uses those services *through* global over its uplink. A standalone master brings its own (SMTP, its own OAuth app, its own keys) or does without. | *Shipping the cloud's keys in the installer:* anyone with a shop PC would hold every tenant's mail key and the JWT secret of lgrai.app. |
| **D-13** | **An on-prem org's internet address is a subdomain of lgrai.app named after the org: `<org slug>.lgrai.app`**, for example `regal-pz.lgrai.app` (the owner's decision, 2026-10-20, §12 Q7). Global terminates its TLS and tunnels it to the org's home. The address is same-site with lgrai.app, so lgrai.app is hardened before the first address goes live (FR-20.72): <br/>– lgrai.app's cookies take `__Host-` names and it reads no others, so a page on a subdomain cannot plant one; <br/>– lgrai.app ignores its cookies on requests from a sibling subdomain (`Sec-Fetch-Site: same-site`); <br/>– global strips `Domain=` from every cookie a master's response sets, and masters use `__Host-` cookies; <br/>– global answers anonymous API requests to an address itself (FR-20.78); <br/>– an address is issued only to an org licensed for on-prem, approved by a sys-admin, and never for a reserved label. | *A separate registrable domain on the Public Suffix List* (the first draft: `<node>.lgr-site.net`, random labels). Each master would be its own site to the browser, and a compromised master could not serve a page under a lgrai.app name. Declined for the brand and a memorable address. The hardening closes the cookie and session paths that domain closed. **What remains:** a compromised master can show a convincing phishing page at a real lgrai.app address; browsers' password managers offer lgrai.app passwords there; and its pages can flood a visitor's browser with lgrai.app cookies until lgrai.app stops answering that browser. "Sign in with LGR" never asks for a password on a master's address, and lgrai.app's sign-in page says so. |
| **D-14** | **Field coverage runs on throwaway instances on the fleet hosts (mars, zeus, jupiter), through `lgr-deploy`'s vmtest harness, in roomler FR-61's shape.** Every cell is built from the signed artifacts on a clean OS, wired into a real topology with a WAN and a LAN the host can impair, and destroyed. Destructive cells use a throwaway global; production is touched only through `lgr-fieldtest` and one anchor master. | *GitHub-hosted runners:* hosted minutes ran out on 2026-10-07 (FR-14.35). A runner also cannot reboot a Windows service with nobody signed in, put three machines on one LAN, or cut a WAN. *A standing test lab:* it drifts away from "a clean machine nobody configured", which is the field's condition. *Production only:* moves, promotion and chaos are destructive. *A second harness beside FR-14's:* two harnesses on the same hosts would fight over them, and FR-14's has to be made to run anyway. |
| **D-15** | **The supervisor owns every way in and out of a master.** It terminates the LAN's TLS (and holds its key), receives the tunnel, and opens the setup console. It proxies the API's outbound calls. The API has one loopback listener only the supervisor can reach, and a control socket that is not a TCP port. | *The API listening on the LAN, the tunnel and loopback itself* (the first draft): the tunnel replayed internet requests onto the loopback listener carrying the internal secret, which put `/internal/*` and setup on the internet. A second `Bun.serve` has no WebSocket handlers. The CA's private key sat with the internet-facing process. *Bun's own `fetch` for egress:* its CA bundle and its proxy handling ignore the machine's PAC and GPO roots. |

---

## 5. Requirements

### 5.1 Nodes, homes and the write gate

**FR-20.1 — Two server roles, one codebase.** `LGR_NODE_ROLE` is `global` (the default) or `master`.
- Global is today's deployment. With no home records it behaves exactly as today.
- A master is the same API, UIs and migrations with `LGR_NODE_ROLE=master`.
- **A local is not a server role.** It is LGR Desktop registered to a master.
- Role-dependent behaviour is decided in one module (`config` → `nodeRole()`), never by host names
  or environment sniffing in feature code.

**FR-20.2 — Node identity.** A master has a `nodeId` (ObjectId) and an **Ed25519 node key**,
generated at install.
- **Where the private half lives:** machine-scope, non-roaming storage that only the service can
  read:
  - Windows: DPAPI (machine scope) under `%ProgramData%\LGR\keys`;
  - Linux: a `0600` file under `/var/lib/lgr/keys`;
  - macOS: the System keychain;
  - a container: a mounted secret.
- **Where it never is:**
  - in a config file a user can read;
  - in a backup that leaves the building unsealed;
  - derived from the host name. Cloned shop PCs share host names (roomler's vmtest finding);
    `installationId` is random, as FR-14 already makes it.

**FR-20.3 — Every org has a home record, and a missing or older one fails closed.** `org_homes`
holds one row per org on every node that knows the org: `{orgId, home: 'global' | <nodeId>, epoch,
state: active | freezing | frozen | fenced | hold, since, changedBy}`.
- **No row means `home: global, epoch: 0`**, but only for an org that has never had a node. Nothing
  is backfilled for the 80 existing orgs.
- **Global keeps a second record:** the highest epoch it has ever seen for the org, in a
  global-owned field of the org's `Org` document (`homeEpochHighWater`). If the row and that field
  disagree, the org goes to `hold`, read-only until a sys-admin resolves it.
- **The highest epoch wins.** If a node presents a higher epoch than the receiver's record, the
  receiver stops writing for that org (fenced, or `hold` on global) and raises an alarm.
- **After a global disaster-recovery restore** (FR-13 Layer 1), every org that has a node record
  starts in `hold`. It stays there until its node reconnects or a sys-admin releases it. A restored
  dump that predates a move therefore cannot quietly make global home again.
- **The row changes only through the moves in §5.9.** Every change increments `epoch`.
- **Storage.** The row lives in its own collection, never in `Org.settings` (trap 16), and **never
  in a backup bundle**. FR-13's per-org bundles take every model with an `orgId`
  (`backup-bundle.service.ts:62-79`), so FR-20's own state is excluded explicitly: `org_homes`,
  `mirror_*`, `org_moves`, `repl_*`, `outbox`, `local_credentials`,
  `node_instance` and `entitlements`. A Replace restore can therefore never rewrite who is home.

**FR-20.4 — Only the home writes, and the gate looks at what a route does, not its HTTP method.**
On a node that is not the org's home:
- **Routes.** Every route under `/api/org/:orgId/` that writes answers **409
  `{code:'org_home_elsewhere', home:{kind, url?}}`**.
  - Each route is classified once, by an explicit marker, as writing or `readOnly`.
  - Reports and exports that use POST (`report.controller.ts:154,188`;
    `invoice-export.controller.ts:564`) are `readOnly`, so they stay available on a mirror.
  - The check is registered next to `isForeignOrg`, by the same auth plugins, with the same rule:
    no exception list.
- **Route tests.** A route-table test asserts that every route is classified, that every writing
  route answers 409 for an org whose home is elsewhere, and that a `readOnly` route writes nothing:
  it runs inside a read-only request context (below).
- **A second guard, below the routes, on every node.** A Mongoose plugin refuses a write to a
  document whose org's home is elsewhere. It also refuses any write at all inside a read-only
  request context (`AsyncLocalStorage`).
  - It catches what the route table cannot see: services, sweeps, event handlers, and routes
    without an `:orgId` (`/api/desktop/v1/enroll` takes its org from the code).
  - The mirror applier writes with raw driver operations, which the plugin does not see, by design.
  - The few raw and bulk write sites in the application are listed and guarded explicitly. A test
    fails on any new site that is not on the list.
- **Schedulers and sweeps** skip the org (FR-20.85).
- **The mirror applier** is the only writer of the org's documents (FR-20.65).
- **Scripts.** Every script that writes calls the shared `assertHomeIsHere(orgId)` first. A test
  fails any writing script that does not.
- **Allocation is checked inside the transaction.** Every allocation of a legal number checks the
  home record inside its own transaction, so a cached answer can never let a number be issued after
  a freeze or a flip.

**FR-20.5 — Writers that cross orgs consult the home too.** The route gate does not see writes from
routes without an `:orgId`, or from sweeps:
- **Identity flows.** A password change sets the legacy copy on every membership
  (`account.service.ts:35-46`). An admin's member edit is mirrored into the person's other orgs
  (`identity.service.ts:290-336`). On global, both skip memberships of on-prem orgs. The master
  updates its own copies from the identity feed (FR-20.43).
- **Org creation, invites and OAuth registration** never create a membership in an org whose home is
  elsewhere. Joining an on-prem org is carried to the master (plan Part A.6.8).
- **Desktop enrollment** is refused for an org whose home is elsewhere. A move revokes the org's
  outstanding enrollment codes and keys on the old home.
- **Sweeps** filter by home. Today, two sweeps cover every org:
  - the boot resets `FiscalDevice.status` (`unified.ts:157-162`);
  - retention strips `DocFile.compareSummary` (`retention.service.ts:97-104`).
- **Migrations** filter by home. On global, a migration runs only for orgs whose home is global. A
  master runs it for its own orgs, and the mirror receives the result through replication.

**FR-20.6 — Reads that write are made explicit.** A GET that allocates a number or inserts a row is
either moved to POST or marked as writing, so the write gate covers it:
- printing or exporting a document that allocates a companion number (§2.3);
- the App Hub inserting `OrgApp` rows (`app-hub.service.ts:24-37`).

On a mirror these answer `org_home_elsewhere`. Above all, **printing on a mirror must never
allocate a number**: that would make global a second allocator.

**FR-20.7 — No document is reachable across orgs by its bare `_id`.** Every route that reads,
updates or deletes a document by id filters by `{_id, orgId}`. Its PUT validates the body and can
never change `orgId`. A route-table test probes every by-id route with another org's id and expects
404.
- **It must hold before any mirror exists (P3).** Otherwise a user of a cloud org could write into
  an on-prem org's mirror through their own org's route, past the write gate.

**FR-20.8 — Moves are fenced by the epoch.** Every replication page, tunnelled request and control
message about an org carries the epoch its sender believes current.
- **A higher epoch wins.** A receiver holding a higher epoch refuses the message with
  `409 home_epoch_stale`. When it refuses a master, the refusal carries **the fence cutoff**: the
  watermark global held for that org when the higher epoch began.
- **A master that learns it is no longer an org's home fences itself** for that org (state
  `fenced`). It learns this from a refusal or from a control message. Once fenced:
  - it stops accepting writes on the LAN, and every client shows why;
  - it exports everything it captured **above the fence cutoff**, not merely what it wrote after it
    learned (FR-20.84);
  - it never resumes on its own.
- **One node identity, one live connection.** If a second uplink arrives from the same nodeId while
  the first is live, global stops accepting pages and tunnel traffic from both, and raises an alarm
  naming both addresses. Two machines with one identity are a clone (FR-20.51).

**FR-20.9 — A master is home for one or more orgs.** One server can host several orgs of one
company at one site. It is home only for orgs moved to it (§5.9), or, when Air-gapped, created on it.

### 5.2 The master

**FR-20.10 — LGR Server is one installable package per OS**, signed with roomler's identity
(FR-14.3):

| OS | Package |
|---|---|
| Windows 10/11 and Server 2019+, x64 | A **per-machine MSI**. The service is created by a deferred, non-impersonated custom action (`lgr-server service install`), not WiX `ServiceInstall`, and it is never started inside that action (roomler `wix-perMachine/main.wxs`; error 87). `MajorUpgrade` refuses a downgrade. |
| Linux x64/arm64 | `.deb` and `.rpm` with systemd units, plus a universal tarball with files owned `0:0`. Each carries an `.asc` signed by the roomler release key. |
| macOS 13+, arm64 (x64 MAY) | A notarised `.pkg` installing LaunchDaemons. ⚠ It needs Apple's *Developer ID Installer* certificate, which lgr does not hold yet (§12 Q6). |

**Contents:**
- a Rust supervisor (`lgr-server`);
- `mongod`, pinned to global's major version (7.0 today);
- the API and its built UIs;
- the PDF renderer and its fonts (FR-20.25);
- the document-extraction tools (FR-20.88);
- the SSPL licence text and a source offer for `mongod`, as roomler ships its LGPL source offer.

**FR-20.11 — The server runs as an OS service, with least privilege.**
- **It comes back by itself.** It starts at boot with nobody signed in and restarts after a crash:
  - Windows: recovery 5/30/60 s, reset after 24 h, non-crash stops included;
  - Linux: systemd `Restart=always`, with an exit-code contract;
  - macOS: launchd `KeepAlive`.
- **The API and `mongod` never run as SYSTEM or root.** They run as a dedicated account
  (`NT SERVICE\LGRServer`, `lgr`, `_lgr`). The API answers requests from the internet (the tunnel,
  §5.8), so it must not hold the machine.
- **Only a separate update helper runs privileged.** The server wakes it. The helper downloads and
  verifies the release itself, and never runs anything the service account staged (roomler's root
  helper resolves and verifies its own release). This is roomler's split on Linux, applied on all
  three OSes.
- **Children die with the supervisor:** a Windows Job Object, the systemd unit's process group, or
  launchd's process group. The service's pre-shutdown timeout is long enough for an in-flight
  fiscal command to finish.
- **Start and stop order.**
  - Start: `mongod` → idempotent `rs.initiate` → the replicated collections created explicitly
    (FR-20.15) → migrations (FR-20.19) → API → ingresses (FR-20.16).
  - Stop: the reverse order (FR-20.23).

**FR-20.12 — The same server runs from Compose and from Kubernetes.** The `lgr` image with
`LGR_NODE_ROLE=master` runs from:
- a published Compose bundle: Mongo 7 as a single-node replica set, with named volumes for data,
  uploads and backups;
- the existing Kustomize base, for companies that host it themselves.

The repository's own `docker-compose.yml:39` runs a `start:unified` script that no longer exists.
The published bundle replaces it.

**FR-20.13 — The installer checks the machine first.** On a machine that fails, it installs nothing
and gives the reason in words:
- **CPU.** x86-64 with **AVX**, or ARMv8.2-A: MongoDB 5.0 and later will not start without it.
  Bun's default x64 build needs **AVX2**, so the package ships Bun's *baseline* build, and the floor
  stays MongoDB's.
- **Memory and disk.** At least 4 GB of RAM and 20 GB free on the data volume.
- **Where the data goes.** A local, fixed disk. Not a network share, a redirected path or a roaming
  path.
- **Windows only.** The VC++ runtime is present, or is installed.

**FR-20.14 — Data lives in one machine-wide place.**
- **Location:** `%ProgramData%\LGR\` (Windows), `/var/lib/lgr/` (Linux),
  `/Library/Application Support/LGR/` (macOS).
- **Contents:** `db/`, `uploads/`, `backups/`, `logs/` and `keys/`.
- **Access:** readable only by the service account and administrators.

**FR-20.15 — `mongod` is private to the server.**
- **Never on the LAN.** It is bound to loopback only, with authentication on (generated credentials
  and a keyfile for the replica set). The one exception is the standby option (FR-20.102). There,
  it also listens for the other member's address only, with TLS and the keyfile, behind a firewall
  rule for that address.
- **A single-node replica set** (`rs0`), as `docker-compose.yml` already runs it. Transactions and
  change streams need it.
- **Sized for a shop PC.** The WiredTiger cache is capped, by default at 0.5 GB below 8 GB of RAM
  (the 2026-10-08 OOM lesson). The oplog is sized to hold at least 30 days of the hosted orgs'
  writes.
- **Every replicated collection is created explicitly at boot** from the metadata (FR-20.62), with
  `changeStreamPreAndPostImages` enabled at creation, before the API serves. A collection that
  Mongoose would create lazily later would have no pre-images, and its deletes would arrive without
  an org. A delete event without a pre-image on a replicated collection raises an alarm and is
  never dropped silently (FR-20.61).

**FR-20.16 — The supervisor owns every way in.** The API never listens on the LAN, and never faces
the tunnel itself.
- **The API has one listener**, on loopback.
  - Only the supervisor can reach it: it requires the supervisor's per-boot front secret, and a
    `Host` on an allow-list (against DNS rebinding).
  - WebSockets work on it, because it is the server Elysia itself listens on. A second `Bun.serve`
    fed through `app.handle` would have no WebSocket handlers.
- **The supervisor terminates every ingress.** It stamps each request with where it came from, after
  **stripping** any `X-LGR-*` header the client sent. The ingresses:
  - **LAN:** HTTPS on the master's certificate (FR-20.30), whose private key the supervisor holds and
    the API never sees.
    - Every LAN request must carry a paired desktop's credential (FR-20.32), except the pairing
      endpoints.
    - Browser access is opt-in per subnet (FR-20.35).
    - The ingress is on when the master has desktops; setup asks.
  - **Tunnel:** requests from the uplink (FR-20.73), stamped `tunnel`.
  - **Console:** a loopback page on the server itself, during setup only (FR-20.18).
- **Supervisor ↔ API control is not HTTP on a port.** It runs over a Unix domain socket (Windows 10
  1803 and later provide one too) or a named pipe, never a TCP port.
  - Replication pages, status and shutdown live there, so no ingress can reach them.
  - The API refuses `/internal/*` and `/api/setup/*` on its HTTP listener outright (AC 47).
- **The client IP** is the one the supervisor saw on its ingress socket. Forwarded headers are never
  trusted (§2.9).
- **Swagger is off** (S-11), and login rate limits apply as on global (S-08).

**FR-20.17 — No default credentials, and no published secret, ever.**
- There is no `admin`/`admin123` or anything like it.
- **The first admin comes from setup.**
  - A linked master takes the person who registered it (signed in at lgrai.app).
  - An Air-gapped master asks for that person's email and a password, and logs neither.
- **Secrets are generated at install.** The production check also refuses every value published in
  the repository's examples and compose files, not only the fallback (§2.4).

**FR-20.18 — Setup, and a master hosts only its orgs.**
- **Where setup runs:** on the server itself, through the supervisor's console ingress
  (FR-20.16).
  - It opens with a **one-time setup token**. The installer prints it, and `lgr-server
    setup-token` shows it again to an administrator.
  - Setup is refused on every other ingress, the tunnel included.
  - The uplink carries no tunnel traffic until setup is complete.
- **What it asks for:** the link level, the registration code (when linked), the org (move one
  here, or create one when Air-gapped), the backup destination, and LAN access.
- **On a master, `POST /api/auth/register` and `POST /api/auth/orgs` are off** outside setup.
- **`BACKUP_SYS_ADMINS`** is set to the first admin, so restore works (§2.4).

**FR-20.19 — Data migrations run themselves.** Every data change a release needs ships as an
idempotent, versioned migration in the codebase. The server runs it at start, under a lock, after
an automatic backup, and records it in `_migrations`.
- Today's migrations are scripts run by hand (`scripts/migrate-*.ts`, `--execute` and then
  `--strip`). A master has no operator. Global adopts the same runner, so the two never diverge.
- Migrations are **expand-then-contract across one release**, so a binary rollback (FR-20.20)
  never meets a schema it cannot read.

**FR-20.20 — The server updates itself, with roomler's rules** (FR-14.28's table; roomler
`agents/roomlerd/src/updater.rs`).
- **Where updates come from.** The manifest and the bytes come through lgrai.app, one origin to
  allow-list.
- **Signatures.** Both are checked and both fail closed:
  - the platform signature, pinned to `G ROX LTD`, the Developer ID or the GPG key;
  - the update signature.

  The version is read from inside the signed bytes. An update offer is never a downgrade.
- **Who installs:** the privileged helper. It downloads, verifies and installs the release itself
  (FR-20.11).
- **Versioned installs.**
  - Each version lives in its own directory, beside the previous one.
  - Switching versions is a pointer change and a service restart, so there is no MSI file
    replacement under a running service, and no service left stopped by a failed install.
  - At most two versions are kept.
- **When an update installs:**
  - inside a **maintenance window**, by default 22:00–06:00 site time;
  - never while a POS session is open or a fiscal command is in flight;
  - if open sessions keep it from installing through 7 windows, the master raises an alarm rather
    than forcing it.
- **The order:** a backup first, then migrations, then a health check.
- **Rollback.**
  - `last_known_good` is recorded after 5 clean minutes.
  - A crash loop (3 crashes in 10 min) switches the pointer back to the previous version, from disk
    and offline, with the attempt marked before it is made.
  - Rolling back a failed update is not a downgrade offer, and never needs the network.
  - The helper confirms the service is running after every switch, and switches back if it is not.
- **Channels.** A stable and a beta channel, and a minimum version (FR-20.58).
- **SUPTO versions.** A release that changes the SUPTO version is held from masters until it is
  marked declared (FR-20.50).
- **Air-gapped.** An Air-gapped master takes the same signed package from a file.

**FR-20.21 — Backups on the master.**
- **Nightly, local.** FR-13's per-org bundle **plus the uploads**, to a local destination (a second
  disk, a USB drive or a NAS path), restore-verified as FR-13 does it.
- **Off-site, sealed**:
  - **to FR-13's destinations.** S3-compatible storage in a BG/EU region. Google Drive only where
    the org attests an EU data region, since a personal Drive's region cannot be chosen
    (FR-20.97).
  - **or, for a master linked at Control, to the cloud's backup vault.** This is sealed with **the
    org's own key pair**, generated at setup, whose private half the company keeps (printed, or
    stored by them). Only then can global not read the bundle; FR-13's single operator seal key does
    not give that property.

  A failed push is retried from the outbox (FR-20.86). It is never left `failed` for good, as it is
  today.
- **At Full, the mirror is the warm off-site copy.** A backup is still required, because a mirror
  replicates deletions too.
- **What no backup holds:** the node key, the CA, the JWT secrets and the local credentials. A
  replaced master is a new node (FR-20.81): its desktops re-pair, and people's local credentials
  are delivered again from lgrai.app (FR-20.40).
- **Visibility.** The status page and the digest show the age of the last good backup
  (FR-20.101).

**FR-20.22 — Time is reported honestly.**
- The master's OS clock drives the fiscal-device clock sync (the time-sync service,
  `zoned-time.ts`).
- When the time check cannot reach its source, it reports *unknown*, never drift 0 (§2.2), and shows
  the OS clock's last NTP sync.
- When linked, the master's skew against global is recorded, and anything beyond ±2 min is shown on
  every client.
- **An unverified clock is never pushed into a fiscal device.** Today `runTimeSyncCycle` pushes
  `new Date()` to every device even when the check failed (`time-sync.service.ts:82-85`). A shop PC
  whose clock reset after a power cut would write a wrong date into the device's fiscal records. A
  master pushes its clock only when two things hold:
  - the clock was verified within the last 24 h, by an NTP sync or against global's clock;
  - the correction is no more than 2 min.

  A larger step waits for a person to confirm it.
- Nothing orders data by a workstation's clock.

**FR-20.23 — Recovery from an unclean stop, and a clean stop on every OS.** Shop PCs lose power.
- **Recovery at start.** The server:
  - marks `BackgroundTask` rows left `processing` by a process that is gone as failed, with a
    reason. Each task records its process and a heartbeat, so on a multi-pod global only tasks whose
    owner's heartbeat is stale are touched;
  - lets claims time out (FR-11 and FR-13 already do);
  - resets fiscal statuses for its own orgs;
  - starts **each scheduler independently**, and reports any that failed.
- **A clean stop.** The API stops cleanly only on SIGTERM or SIGINT (`unified.ts:232-248`), which a
  Windows service does not deliver to a child. The supervisor therefore:
  1. stops the API through an authenticated loopback endpoint;
  2. waits for an in-flight fiscal command;
  3. stops `mongod` cleanly last.

**FR-20.24 — File paths are relative to the upload root.**
- `File.storagePath`, `DocFile.currentPath`, `ArchiveUnit` paths and every other stored file path
  are kept relative to `UPLOAD_DIR`, with `/` separators.
- A P0 migration rewrites the existing rows (§2.6).
- A reader still accepts a legacy absolute path, by stripping a known prefix.
- **Expand, then contract.** The release that rewrites paths comes one release after the release that
  reads both forms, so a binary rollback never meets a path it cannot read.
- **Paths are validated wherever they are read or written:** no `..`, no absolute path, no drive
  letter.

**FR-20.25 — PDFs render offline, open no listener, and carry their fonts.**
- **Nothing listens.** Rendering loads the HTML with Chrome's `setContent` and prints it with
  `pdf`, so nothing is served over a socket. Chrome is driven over a pipe (`pipe: true`), so it
  opens no DevTools port either.
- **Chrome comes from the package** (`PUPPETEER_EXECUTABLE_PATH`), never from the service account's
  cache, and runs with its sandbox when the service is not root.
- **Fonts.** DejaVu and Liberation ship with the package, so a fiscal form lays out the same on
  every OS (`house-style.ts:27`).

**FR-20.26 — The package is reproducible and contains only what it lists.**
- It is built from a **committed lockfile** and an **explicit file allow-list**, never `COPY . .`.
- CI fails the package if it contains any of these:
  - a gitignored path;
  - `.secrets/` or `*.seal.key`;
  - `.env*`;
  - the name of any `lgr-secret` key.
- This matters more than for the cloud image (S-10), because the package goes to customers'
  machines.
- **No general script runner.**
  - The package carries only an allow-listed set of vetted maintenance scripts, and none of them can
    change an issued document. Distributing a tool that alters sales is forbidden (ЗДДС 118(14)
    т. 3).
  - Scripts such as `fix-imported-invoice-lines.ts` and `migrate-invoice-numbering.ts` never leave
    the repository.

**FR-20.27 — A diagnostics bundle for the server**, like FR-14.10.
- **Contents:** logs, versions, `mongod` status, the oplog window, journal lag, uplink state and the
  last backup.
- **Redacted:** no tokens, no keys and no document contents.

### 5.3 Locals: LGR Desktop on a master

**FR-20.28 — Finding the server.** Onboarding asks *"Where is your LGR?"*: lgrai.app, **a server on
this network**, or **this computer**.
- **"On this network"** lists the masters found by DNS-SD (`_lgr-server._tcp`), with their name,
  orgs and certificate fingerprint. roomler has no LAN discovery to copy, so this is new.
  - On Windows it uses the OS's own resolver (`DnsServiceBrowse` / `DnsServiceRegister`). A per-user
    desktop cannot open the firewall for its own multicast listener.
- **An address can always be typed in.** Multicast is often blocked (trap 9), so discovery is a
  convenience, never a basis for trust.
- **A paired desktop finds its master by identity, not by address,** so a DHCP change does not
  strand the tills. It tries, in order:
  1. the last address that worked;
  2. DNS-SD for its master's nodeId;
  3. `<host>.local`;
  4. only then, asking a person.

  The certificate pin is checked whichever way the master was found.

**FR-20.29 — Pairing is FR-14's enrollment, against the master.**
- **The code.** An admin mints it on the master's Desktops page (FR-14.19, FR-14.23): the same page,
  served by the master.
- **It carries the master's certificate fingerprint.** The code's QR and deep link include it:
  `lgr://enroll?server=https://192.168.1.10:4443&code=XXXX-XXXX&fp=sha256:…`.
  - The first TLS connection is pinned to that fingerprint.
  - **A code typed by hand is confirmed with six words** derived from the fingerprint (at least 66
    bits), shown on the master's Desktops page and on the desktop.
    - The fingerprint is broadcast in DNS-SD, so a short comparison would let someone grind a
      look-alike certificate.
    - Six words put that out of reach. Four hex characters would take hours.
- **The `desktops` registry** lives on the home and is mirrored to global (registry fields only,
  FR-20.63).

**FR-20.30 — LAN TLS.**
- **Its own CA.** The master creates its own CA and server certificate at install. The certificate
  names the host name, `<name>.local` and the master's LAN addresses, and is re-issued when an
  address changes.
- **Pinning.** Desktops pin the CA from pairing.
- **Rotation** is announced to paired desktops before it happens.

**FR-20.31 — The shell trusts a master by its pin.**
- **One client, one trust policy per server.** Everything the shell sends to its server goes
  through one HTTP client: enrollment, tokens, presence, the bridge, the proxy, **and the updater**.
  It trusts the OS store for lgrai.app, and the pinned CA for a master.
  - Today `presence.rs:115` builds its own client.
  - The updater goes through `tauri_plugin_updater`'s own client (`install.rs:371,391-397`), which
    would never trust a master's CA. Both move to the shared client.
- **No proxy to the master.** Traffic to the master bypasses any system proxy.
- **One URL rule.** The Rust and TypeScript URL validators agree on loopback (§2.5).

**FR-20.32 — The desktop reaches the master through a loopback proxy in the shell.**
- **What the window loads.** `lgr-web` loads `http://127.0.0.1:<port>`, a secure context by
  definition, so nothing in the web app needs a certificate the webview trusts.
- **Forwarding.** The shell forwards each request over TLS pinned to the master, and adds the
  desktop's access token (FR-14.20) in its own header.
  - The master's LAN listener refuses a request without that token.
  - The user's session is checked on top, as everywhere.
- **Loopback rules** (FR-16.16):
  - it answers only `Host: 127.0.0.1:<port>`;
  - it requires a per-launch secret that the shell hands the window, never in a query string;
  - it keeps the **same port** for the installation, so the SPAs' per-origin session storage
    survives a restart.
  - **On a re-point it clears the webview's storage for that origin,** so nothing from one server's
    session survives into another's.
- **WebSocket upgrades** are forwarded too.

**FR-20.33 — When the master is unreachable, the desktop says so.**
- It shows FR-14.17's page, naming the server: *"Shop server KASA-1 is not answering — retrying"*.
- It returns to `startPath` by itself when the server answers.
- **It never pretends to keep work.** If the outage lasts, the page points to the paper book
  (кочан), the legal fallback while the software is down (Н-18 чл. 36(1) т. 6). The offline till is
  FR-20.104.

**FR-20.34 — A desktop is registered to one server.**
- **The Overview** shows the server, the server's own cloud link ("lgrai.app: connected / down
  since 14:02") and the desktop's fiscal devices.
- **Changing server** is a re-registration (FR-14.32). A move re-points the desktop (FR-20.82).

**FR-20.35 — Browsers on the LAN (MAY, opt-in per subnet).**
- **HTTPS, two ways.** With LAN browser access on, the master serves HTTPS with either:
  - its own CA, installed on those PCs (for example by GPO); or
  - while public DNS works, a per-master public name with a public certificate.
- **The UI tells the user** that fiscal printing needs the desktop.

**FR-20.36 — The fiscal path stays on the LAN.**
- The native bridge (FR-14.26) connects to the master's `/ws/fiscal-bridge`.
- The drivers and УНП allocation run on the master.
- Прил. 29 т. 8's software-to-device link therefore never crosses the internet (§2.8).

**FR-20.37 — The hot path is idempotent, and survives a crash between the save and the print.**
- **Which operations:** opening and closing a POS session, a POS sale, a storno, a cash sale,
  issuing an invoice, and recording a payment.
- **The key lives on the document.** Each request carries a client-generated key.
  - The key is stored **on the business document**, in the same write that creates it (a unique
    `{orgId, clientKey}`), together with a hash of the request body.
  - A key reused with a different body answers 422 `idempotency_key_reused`.
  - A side table that records the response only after the work is done does not survive a crash:
    today the sale is saved before the receipt prints (`pos.controller.ts:610`, then `:646-661`).
- **The document records its fiscal state:** `pending`, then `printed` with the receipt number, or
  `failed`. A retry with the same key does the following:
  - **`printed`:** returns the stored outcome, with the same document, number and receipt;
  - **`pending`** (a crash or a lost response between the save and the print):
    1. asks the fiscal device for its last receipt before printing anything;
    2. if that receipt is this sale's УНП, marks the sale printed and returns it;
    3. otherwise, prints once.
  - **Never:** a second sale, a second УНП or a second receipt.
- **Today** `POST /session/:id/transaction` (`pos.controller.ts:568`) takes no key at all (trap 3).
  The fix helps the cloud too.

### 5.4 Signing in on a master

**FR-20.38 — A master signs its own sessions.**
- It has its own `JWT_SECRET` and `DESKTOP_TOKEN_SECRET`, generated at install and stored like the
  node key.
- A token from global is never valid on a master, nor the reverse.
- Claims carry `iss: <nodeId>`.

**FR-20.39 — "Sign in with LGR" while online.** A linked master's login page offers it first. It is
an authorization-code flow with PKCE against lgrai.app:
1. **lgrai.app signs the person in**, with any method it supports (password, Google, …). Its
   authorize page reads the person's lgrai.app session from the tab, never from a cookie: arriving
   from a master's address is a same-site navigation, and lgrai.app ignores its cookies on those
   (FR-20.72).
2. **The master redeems the code over its uplink**, authenticated by its node key. It receives a
   short-lived assertion `{iid, email, tv, amr}`, signed by global's identity key.
   - That public key is **built into the signed package**, as the licence key is (FR-20.55). It is
     not learned at registration, over a channel FR-20.53 deliberately lets a TLS-inspecting proxy
     sit in.
   - It rotates only through a signed release.
3. **The master maps it to a membership.** It finds the person's membership in the org
   (`User.identityId`) and issues its own session.

In the desktop, the flow leaves the webview exactly as FR-14.14 does. **A global password never
reaches a master.**

**FR-20.40 — Local credentials for outages.** A person has a **local password** for an org's
on-prem server, and a till operator also has a **PIN** of at least 6 digits.
- **Where they are set:** on lgrai.app, under the person's account (*On-prem servers*), or on the
  master right after a "Sign in with LGR". They can therefore be set **before** the org moves,
  which is what makes the onboarding day possible (§8).
- **Never the global password.** Global refuses a local password equal to the person's global
  password: it checks the candidate against the global hash when the local one is set.
- **How they reach the master.**
  - Global keeps only an argon2id verifier (`Bun.password`).
  - It delivers the verifier to the master sealed to the master's node key: inside the move
    (FR-20.79), and afterwards over the identity feed.
  - It keeps it only so that a replacement master can receive it again.
  - The verifier is valid only on that org's master.
- **Offline.**
  - The login page offers local sign-in only. Each operator still authenticates as themselves
    (Прил. 29 т. 7).
  - **Local credentials are accepted only on the LAN and console ingresses, never through the
    tunnel.** Failed attempts slow down with backoff, per person and per desktop, rather than
    locking. Otherwise anyone who could reach the login page could lock every operator for the
    length of an outage.
- **Invalidation.** Either of these, reported by global, invalidates the person's local
  credentials, so the next sign-in must be online:
  - a `tokenVersion` bump (a password change, sign-out everywhere);
  - a deactivation.

**FR-20.41 — An Air-gapped master owns its people.** It runs FR-19's model on the master (Identity
plus memberships). An admin resets passwords, or email does, when the master has SMTP.

**FR-20.42 — Permissions are the home's; people are global's.**
- Roles, permission sets and operator codes are org data on the master.
- A remote user who comes through the tunnel is authorised by the master, not by global.
- **On a linked master, the admin manages memberships:** role, permissions and operator code.
  - People join by invitation (plan Part A.6.8).
  - Person fields (name, email, password) are changed on lgrai.app, never on the master.
  - `applyAdminIdentityEdit` (`identity.service.ts:288-336`) writes the global `Identity`, so a
    linked master refuses it and points to lgrai.app.
  - An Air-gapped master keeps today's behaviour, because it owns its people.

**FR-20.43 — Revocation and person data reach the master.**
- Global sends identity changes of the master's members over the control channel: `tokenVersion`,
  deactivation, email and name.
- The master updates its membership copies of those people, and ends their sessions within 60 s of
  receiving the change (the `liveSessionUser` window).

**FR-20.44 — No secret about a person leaves global.**
- Identity data sent to a master excludes `password`, OAuth tokens and reset tokens.
- A move never copies `User.password` or `User.oauthProviders` (the legacy copies FR-19 Release D
  removes), or `Org.settings.integrations` (OAuth tokens of the org's cloud integrations).
- An acceptance test scans every message and every move bundle of a seeded org for password hashes
  and token shapes.
  - **Argon2:** `$argon2`. That is what `Bun.password.hash` writes by default
    (`account.service.ts:57,126`).
  - **bcrypt:** `$2a$`, `$2b$`, `$2y$`, which migrated legacy hashes can still carry.
  - **Token shapes.**

### 5.5 Numbering, fiscal and SUPTO

**FR-20.45 — The allocators stay as they are, and run only on the home.**
- **Where they run.** `getNextNumber`, `getNextInvoiceNumber`, companion numbers, `SM-` numbering and
  `generateUNP` run on the home, and only there (FR-20.4, FR-20.6).
- **Locals never allocate.** The number comes back in the response to the request that creates the
  document. This is what the request asks for ("they always ask the master").
- **The one change: УНП gets one counter per fiscal device** (Прил. 29 т. 9), not one per device and
  operator (§2.8). ZZZZ stays the operator who entered the sale.
  - The new counter starts above the highest number already issued on that device by any operator.
  - A two-operator test proves no 7-digit number repeats.
  - **Rollback stays safe.** For one release the code also raises every old per-operator counter of
    the device to the device's maximum. A binary rolled back to the per-operator key then still
    cannot re-issue a number.
  - **A device shared by two systems needs declared ranges** (Прил. 32 т. 23). Two orgs on one
    device, or LGR and PlusMinus during a parallel run, are such systems.

**FR-20.46 — Counters move with the org.**
- `Sequence` documents are org data: they are mirrored, and every move carries them.
- A series issued on global, continued on a master and returned to global is one gapless series
  (acceptance 35).

**FR-20.47 — The master is the org's СУПТО.** All of these run on the master:
- `SUPTO_MODE` and the immutability rules;
- the audit log;
- the `nra_auditor` role, on the LAN and through the tunnel (Н-18 чл. 52и);
- the 18.1–18.9 export;
- the FR-09 day close, with its Z-report.

`docs/supto/` gains the on-prem deployment variant.

**A master outside the shop needs a declared remote inspection path.** A master in a company
server room must be reachable by an inspector "незабавно" (чл. 52и(1)). The path is one of:
- the tunnel (Full);
- the roomler overlay;
- the company's own VPN.

The path is declared in Прил. 32. Control and Air-gapped masters off the premises need one of the
last two.

**FR-20.48 — Every audit entry says where it came from.** On the home it carries
`via: lan:<desktop> | tunnel | loopback`, so an auditor can tell a till from a remote session.

**FR-20.49 — The fiscal device's own link to НАП is not LGR's.**
- A fiscal device reports to НАП over its own data SIM (Прил. 1 разд. IIIб т. 1 "а", "в"), so the
  shop's internet line does not affect it.
- The device blocks itself after 72 h without transmitting.
- **The master implements Прил. 29 т. 8's 2-hour rule per workstation:** a sale cannot open if that
  workstation's device has not answered within 2 hours.
  - This is new: nothing reads `FiscalDevice.lastCommunicationAt` today.
  - It belongs to the SUPTO-compliance work in §2.8, and FR-20 depends on it.

**FR-20.50 — The SUPTO declaration follows the topology.**
- **The trader's Прил. 32 needs the topology.** It records the installation type, the data
  location, the DB address and the topology (т. 5, 7, 10–13), and must be updated within 7 days of a
  change (чл. 52з(1)).
- **LGR supplies those fields.** Each master's status page shows them, ready to copy. Every move and
  every link-level change shows them again, with a reminder of the 7 days.
- **SUPTO versions travel only once declared.** A change to Прил. 29 functionality or to the
  database structure is a new SUPTO version, which the producer must declare (чл. 52в(3), (3а)).
  The release feed marks such releases, and masters hold them until they are marked declared. Build
  updates within a declared version flow normally.
  - **The same rule binds global's own releases.** Global serves the cloud orgs' SUPTO, and the
    mirrors' auditor access.
- **All nodes of one shop move together.** They are rolled to the same SUPTO version together.

**FR-20.51 — No sale is lost, altered or numbered twice: not by sync or repair, and not by a
restore, a snapshot or a clone.**
- **Nothing changes an issued sale.** No sync, reconcile, move or recovery path deletes or changes
  a sale, a fiscal receipt or an issued invoice on the home (Прил. 29 т. 13; ЗДДС 118(14) т. 3,
  116(1)).
- **On the mirror,** a repair only makes the copy equal to the home, and every repair is logged.
- **Late sales are imported, never pushed or dropped.** Examples are a fenced master's sales and an
  offline till's.
  - They are imported by an audited import that keeps their content and original times. The model
    is Прил. 42: full and unchanged content, with source, method and time stored.
  - They are never re-keyed and never dropped.
- **A database that went back in time locks its legal series.**
  - **What counts:**
    - a restore from a backup;
    - a VM snapshot reverted;
    - a disk image copied;
    - FR-13's in-app restore, which on a master is routed through the supervisor for its home orgs.
  - **What the lock means.** Every legal series (sales documents, cash sales, УНП) stays locked
    until it resumes above the highest of:
    - the mirror's highest issued number, when linked;
    - the last number a person reads off the last printed document;
    - the fiscal device's last receipt, where its protocol reports it.
  - **How it is detected,** without needing global:
    - the fiscal device is an outside witness: a device ahead of the database means the database
      went back;
    - the supervisor keeps a high-water mark of the journal outside the database;
    - when linked, the page hash chain (FR-20.64) refuses a history that does not continue the one
      global saw.
  - **The weakest case.** An Air-gapped master has no mirror, so a person's reading of the last
    printed numbers is its only evidence for invoices. The lock makes that reading required
    rather than optional.
- **A clone is two homes.** Two machines with one node identity are detected on the LAN, because each
  supervisor advertises its nodeId and a per-boot nonce and sees the other's. Global detects them too,
  through a second live uplink (FR-20.8). Both lock their legal series and raise an alarm until a
  sys-admin decides which machine is real. The other is re-installed as a new node.
- **If a number is ever issued twice anyway,** the later document is annulled by a credit note and
  re-issued under a new number. That is ЗДДС 116's remedy for a wrong invoice, and it is
  audit-logged. A collision is never resolved by editing or deleting either document.

### 5.6 The link to global

**FR-20.52 — The uplink.** A master opens **two** outbound WSS connections to global on port 443,
and accepts no inbound connection from the internet:
- **interactive:** control messages and the tunnel;
- **bulk:** replication pages and file bytes.

Two sockets keep a 50 MB catalog catch-up from queueing in front of a remote user's click (trap 8).
- **Authentication.** Both authenticate in their first message, with a node assertion (EdDSA,
  `exp ≤ 60 s`, `jti`), never in the URL. A socket that has not done so within 10 s is refused.
- **Reconnection.** Exponential backoff with full jitter, 1 s → 5 min, honouring `Retry-After`.
- **Liveness.** A receive-liveness deadline, because middleboxes can keep a dead connection looking
  alive (roomler `signaling.rs`).
- **Pacing.** Two sockets do not by themselves stop a bulk transfer from filling a shared ADSL or 4G
  line's buffers. The bulk socket is therefore paced: it backs off as the interactive socket's
  round-trip time rises, and holds to a share of the measured upstream.
- **A refusal stops the link, never the shop.** A revoked node (close code 4403), an outdated
  version or a stale epoch stops the uplink, or that org's traffic. The master keeps serving its
  LAN, and its clients show a banner (FR-20.60, FR-20.94).

**FR-20.53 — On the networks companies have.**
- **Proxy.** The uplink uses the **machine's** proxy configuration, PAC included. roomler's WebSocket
  ignores proxies and PAC; LGR's must not.
  - It reads WinHTTP's machine settings and WPAD under the service account. A virtual service account
    has no user proxy settings to read.
  - An explicit proxy or PAC URL can be set in setup.
  - Proxy authentication is supported: Negotiate with the machine account, or credentials an admin
    enters.
- **Trust.** It uses the **OS trust store**, so a TLS-inspecting middlebox whose root arrives by GPO
  just works.
- **Where it runs.** The uplink lives in the Rust supervisor, which already owns the OS integration.
- **The API's own outbound calls go through the supervisor too.** On a master the API makes no direct
  internet call (FR-16.55's warning: Bun's `fetch` uses its own CA bundle and no PAC). Every outbound
  call takes one of two routes:
  - **a relay over the uplink** (FR-20.59);
  - **the supervisor's egress proxy on loopback.** It applies the same proxy rules, and the API
    receives the OS's trusted roots, exported by the supervisor at start (`NODE_EXTRA_CA_CERTS`).
    Off-site backups and the desktop-release cache use this route.
- **Timeouts.** Every outbound call has one, so a black-holed route fails instead of hanging
  (§2.2).

**FR-20.54 — Link levels.** A level is chosen in setup, changed by an admin on the master, and
audit-logged:

| | Full | Control | Air-gapped |
|---|---|---|---|
| Licence, updates, health, clock | ✔ | ✔ | file |
| "Sign in with LGR", identity feed | ✔ | ✔ | — |
| Relayed services (mail, LLM, VAT, reference data) | per service | per service, **off by default** | — |
| Mirror of the org's data | ✔ | — | — |
| Remote access through global | ✔ | — (the roomler overlay MAY) | — |
| Sealed backup to the cloud vault | MAY | MAY | — |

- **What Control means.** At Control, no business data leaves the building unless the org turns on
  a relayed service.
- **Each relayed service says exactly what it sends.** For example: *"an emailed invoice's PDF and
  the recipient's address pass through lgrai.app to SendGrid"*. The settings page shows this before
  the service is turned on (FR-20.90).
- Going down from Full stops the mirror and offers to delete it on global.

**FR-20.55 — Licence.**
- **What it is.** Entitlements (org, plan, apps, desktop count, expiry) arrive as a document signed
  by global's licence key, whose public half is built into the signed package. It rotates only
  through a release.
- **Renewal.** A linked master renews it over the uplink and keeps working offline until expiry
  plus 30 days of grace. An Air-gapped master takes a licence file.
- **What expiry never blocks:** reading, exports, the SUPTO export, backups, the fiscal day close,
  a storno or credit note of an existing sale, a payment against an existing document, and a move
  back to the cloud. A customer can always close the day and leave with its data.
- **The rest is a proposal** (§12 Q4), awaiting the owner's confirmation:
  - **Who:** on-prem is an Enterprise feature (€29 per user per month today, `PLANS` in
    `config/src/index.ts`), priced like the cloud plan: users are counted, desktops and masters are
    not. An Air-gapped master is billed a year ahead.
  - **Grace:** for 30 days after the paid-through date nothing is blocked; admins see a banner and
    get a daily mail. A linked master's licence is signed for the paid-through date plus the grace,
    so an outage never ends a paid licence.
  - **After the grace:** the master stops opening POS sessions and creating new documents, at a day
    boundary, never in the middle of a sale or of an open session. Everything listed above keeps
    working.
  - **Updates keep arriving**, licensed or not: an unpatched service on a shop PC is worse for
    everyone.
  - **Pilots:** a sys-admin can issue a time-limited licence (regal's first site, the field tests).
- **This is a new mechanism.** Plans are not enforced anywhere today (§2.4), so there is nothing to
  port.

**FR-20.56 — Updates come through global, and the master serves its desktops' updates.**
- The server's own release feed comes over the uplink. The bytes come from lgrai.app's download
  endpoint.
- **Desktop releases** are fetched through the same endpoint and cached on the master. Its tills
  then stay current with the internet down, and `DESKTOP_RELEASE_GITHUB_TOKEN` never leaves global.

**FR-20.57 — Presence and health.**
- **Where masters appear:** on a sys-admin page on global, and on the org's settings page.
- **What is shown:** version, link level, uplink state, journal lag, mirror watermark, last backup,
  disk, `mongod`, desktops online, and the fiscal devices' state as the master reports it.
- **Presence** follows FR-14.21.

**FR-20.58 — Version skew.**
- Global publishes `MASTER_MIN_VERSION`.
- **Below it, replication and the tunnel are refused** with a control message (`master_outdated`),
  not by closing a socket.
  - The interactive socket carries both the tunnel and the updates, so it stays open.
  - The master can therefore fix itself.
- The protocol version is negotiated in the first message.

**FR-20.59 — Services go through global.** A linked master never holds the cloud's keys (D-12):
- **Mail** is sent by global on the master's behalf (the FR-10 and FR-11 senders).
- **LLM drafting and line matching** go to `lgr-ocr` through global, only when the org allows it
  (FR-20.88).
- **Company and VAT lookups**, and **`din_catalog`**, come through global.

An Air-gapped master brings its own SMTP and keys, or does without.

**FR-20.60 — Global is never required for the master to work.** With the uplink down for 30 days, a
master loses only the relayed services, and queues their work (FR-20.86).

### 5.7 The mirror: master → global

**FR-20.61 — Capture is FR-16's change-stream journal, on the master.** It is FR-16.18–16.23 as
specified there:
- pre- and post-images, on collections created explicitly (FR-20.15);
- batches cut only at transaction boundaries;
- the resume token saved in the batch's own transaction;
- a lease;
- seeding with `$setOnInsert`.

It journals every write, whatever issued it: `bulkWrite`, scripts, a `mongosh` fix. Two of FR-16's
rules are restored and made explicit:
- **Lost history means a full re-send, not a quiet continue.** On `ChangeStreamHistoryLost` the
  journal epoch goes up by one, and every document is journaled again with a fresh seq: an upsert,
  not `$setOnInsert`. `$setOnInsert` would keep stale rows at or below the watermark, so the changes
  made during the gap would never be sent.
- **Global refuses pages of the new journal epoch until a reconcile has run** (FR-20.70). The
  journal epoch travels in `hello`, in every page and in `mirror_state`.
- **Deletes are routable.** The journal is indexed on `{coll, docId}` as well as on
  `{orgId, coll, docId}`, so a delete can be routed by its pre-image or by its journal row.

**FR-20.62 — What replicates is generated, not listed by hand.**
- **Generated metadata.** It is built from the Mongoose models and marks every collection
  `replicated`, `split`, `node-local` or `global-only` (§2.6.1; plan Part A.5).
- **A forced decision.** A snapshot test fails the build when a model is added without a decision
  (FR-16.24's rule).
- **Node-local includes:** the journal itself, local credentials, background tasks, and the shell
  proxy's sessions.
  - Idempotency keys are not on the list. They live on the business documents (FR-20.37) and travel
    with them.
- **A document with no org is never journaled.** That covers `ExchangeRate` rows with `orgId: null`,
  which are global reference data (FR-20.87).

**FR-20.63 — Split documents replicate by field ownership.** Each field of a split document is owned
by the home, by global, or by the node (§2.6.1).
- **Ownership is declared on dotted leaf paths, not top-level fields.** `Org.settings` is the
  home's, but `Org.settings.integrations` is global's. A snapshot test fails unless every leaf path
  of the schema has exactly one owner.
- **The master projects every page to home-owned fields before sending it,** so node-only fields
  never cross the wire. A standalone master's legacy `User.password` copies are one example.
- **The mirror apply writes only home-owned fields.** Global-owned fields (`Org.slug`,
  `subscription`, `settings.integrations`) are never overwritten by a page.
- **Node-local fields never travel:** `FiscalDevice.status`, `Desktop` presence,
  `User.lastLoginAt`.
- **The mirror's own state is never kept inside a replicated document,** where a page would
  overwrite it. Blob state, for example, lives in a global collection of its own.
- **A membership's link to a person is global's to sanction.** A page may carry a `User` whose
  `identityId` global never sanctioned. Sanctioned means through an invitation accepted on global,
  the move's initial copy, or a `member-join` global started. An unsanctioned link is applied
  without the `identityId`, so it is inert and never lists the org for that person on lgrai.app,
  and an alarm is raised. Otherwise a compromised master could attach any person to its org.

A Stripe webhook updating `Org.subscription` on global survives every later page (acceptance 33).

**FR-20.64 — Pages.**
- **Contents.** Over the bulk socket, the master sends the journal rows above global's watermark for
  `(org, instance epoch)`. Each row carries the document **as it is now**, or a tombstone.
- **Encoding.** The pages are **BSON**. Both ends are MongoDB, so there is no codec and no type loss.
- **Size.** At most 1,000 documents or 4 MB per page, compressed with zstd.
- **A hash chain.** Each page carries the hash of the chain up to its first row (`prevHash`), and
  global keeps the last hash per org. A master whose history does not continue the chain global saw
  is refused. That is the case after a restore, a snapshot revert or a clone, even when its seqs
  overlap the watermark (FR-20.51).

**FR-20.65 — Apply is atomic and idempotent.** Global applies a page in one transaction:
1. **Insert or replace each document.**
   - By `{_id, orgId}`; for split documents, the home-owned fields only.
   - The `Org` document is matched by `{_id}`, which is the org id itself, because `Org` has no
     `orgId` field.
2. **Delete each tombstone.**
3. **Advance the watermark, last.**

A page at or below the watermark, whose hash matches, is acknowledged without writing. The apply
uses raw driver operations: the document is final as the home wrote it, and Mongoose hooks must not
change it.
- **A unique key that collides is resolved inside the same transaction.** A collision means the
  mirror still holds a stale document of the same org with that key; two documents that swapped a
  key inside one transaction can arrive in separate pages. The stale document is deleted, the
  page's document inserted, and global asks the master to resend the stale document's current state
  (`resend {coll, ids}`).
- A duplicate-key error must never abort the page, which would stall the org's replication.

**FR-20.66 — Apply enforces isolation.** A page is refused, and an alarm is raised, unless all of
these hold:
- every document's `orgId` is the page's org;
- the sending node is that org's home at the page's epoch;
- the collection is replicated;
- every file path in it is a valid relative path (FR-20.24).

Files are never written where a page says. A mirrored file is stored by content, at
`<UPLOAD_DIR>/<page org>/blobs/<sha256>` (FR-20.69), and global's `blob-want` answers per org. A
global answer would tell any master whether some other org holds a given file.

A compromised master can therefore damage only its own org's mirror.

**FR-20.67 — The watermark lives on global** and is told to the master on connect. A master always
learns where the mirror really is, including after its own restore.

**FR-20.68 — Real time while connected.**
- **A single document:** p95 under 5 s from commit on the master to visible on global.
- **A catalog rewrite:** 23k products fully mirrored within 15 minutes over 10 Mbit/s, while
  interactive requests still answer within 2 s.

**FR-20.69 — Files.**
- **How they travel.** Upload bytes replicate as content-addressed blobs, in resumable chunks,
  behind the documents on the bulk socket.
  - Every replicated file row carries its SHA-256. `DocFile` already does; P0 adds it where it is
    missing.
  - On global, a mirrored org's files are read by `(org, sha256)`, never by the path in the row.
- **Metadata-only option.** An org MAY mirror metadata only, and only while its home is a master.
  - A move back to the cloud first completes the file transfer (FR-20.80).
  - Promoting a metadata-only mirror says, in its loss window, that the files are not in the cloud.

**FR-20.70 — Reconcile.** It compares per-collection digests, one way: the home always wins, within
FR-20.51.
- **When it runs:** when the watermark is below the tombstone floor, after an epoch change, after a
  restore, and on demand.
- **What it reports:** everything it repaired.

**FR-20.71 — A restored master recovers from the mirror and never regresses it.** A master has its
pages refused in any of these cases:
- its instance epoch changed;
- its journal is behind global's watermark;
- its hash chain does not continue global's (FR-20.64).

From the moment it detects that it went back in time, it locks its legal series (FR-20.51). It
recovers like this:
1. **Re-seed from the mirror.** The master's copy of the org is **replaced** by the mirror's: every
   document and file. The mirror is the newest complete state it has, and it knows the deletes made
   after the backup.
   - Copying only what the master "lacks or holds older" would bring back drafts, reservations and
     files deleted since the backup.
   - Nothing on the mirror is deleted (FR-20.51).
2. **Resume numbering safely.** Every counter resumes above the highest of: the mirror's highest
   issued number, the device's last receipt, and the last numbers a person reads off the last
   printed documents (FR-20.51).
3. **Re-seed the journal.** Replication then resumes.

An admin starts the re-seed. Until it finishes, the master accepts no writes for the org. Anything
the master wrote after its last mirrored page and before the failure exists only on paper and in
the fiscal device. Nothing in software can bring it back, and the recovery says so.

### 5.8 Remote access through global

**FR-20.72 — Every on-prem org on a linked master has an address on the internet:
`<org slug>.lgrai.app`** (D-13), served by global.
- **Everything on it is tunnelled to the org's home master**: the UI, the API and the WebSockets. A
  remote user therefore always runs the master's own UI against the master's own API (D-5). A master
  that is home for two orgs answers on two addresses.
- **The label is the org's slug.** Slugs are already valid DNS labels
  (`^[a-z0-9]+(?:-[a-z0-9]+)*$`, `account.service.ts:166`), which also rules out punycode (`xn--`).
  An address is issued only:
  - for a label of at most 63 characters;
  - to an org whose licence includes on-prem (FR-20.55), after a sys-admin approves it;
  - for a label that is not reserved (`www`, `api`, `app`, `admin`, `auth`, `login`, `account`,
    `id`, `sso`, `oauth`, `mail`, `status`, `docs`, `help`, `support`, `billing`, `pay`, `secure`,
    `static`, `cdn`, `download`, `update`, `registry` and the like);
  - for a label with no record of its own in the lgrai.app DNS zone (the mail-authentication
    records, for example).
- **An address outlives a rename.** A slug change does not move it. A retired address answers with a
  notice for 12 months and is never issued to another org.
- **An org whose home is global has no address.** Its label answers exactly like an unknown one.
- **lgrai.app is made safe to have subdomains before the first address goes live:**
  - its cookies (`auth`, `oauth_state`, `oauth_pending`, `oauth_handoff`) take `__Host-` names, and
    it reads no others. A `__Host-` cookie needs `Path=/`, so the two OAuth cookies lose their narrow
    paths; both are one-time and short-lived;
  - it ignores its cookies on any request whose `Sec-Fetch-Site` is `same-site`, which is what a
    sibling subdomain's page sends. Cross-site navigations, such as the OAuth callback, are
    unaffected;
  - its responses carry `Cross-Origin-Resource-Policy: same-origin` and `Origin-Agent-Cluster: ?1`,
    and CORS never allows a subdomain.
- **Cookies on the address.**
  - The router strips any `Domain=` from the master's `Set-Cookie`.
  - A master's session cookies are `__Host-` prefixed and host-only, so a sibling master cannot plant
    one under their name, and they never reach lgrai.app.
- **From lgrai.app.** The org menu lists on-prem orgs with a link to their address.

**FR-20.73 — The tunnel.** Multiplexed streams over the interactive socket, with flow control:
- **What it carries.** HTTP requests and responses streamed both ways, uploads and downloads within
  the app's limits, and WebSocket upgrades.
- **On the master**, each stream enters through the supervisor's **tunnel ingress** (FR-20.16).
  - It reaches the same API, under the same authorisation, as a LAN request, except the
    desktop-credential gate, which is a LAN rule.
  - A remote request is authenticated by the master's own session.
  - It can never reach the control socket, setup, or a local-credential sign-in.
- **Headers.** Global strips every client-supplied `X-LGR-*` header. The supervisor stamps the
  source and the client's address.
- **Retries.** Idempotent GETs are retried once on an uplink drop. Other requests are never retried
  automatically.
- **Idle time** is measured on bytes, not on the request. A stream that sends nothing for 120 s is
  closed. Long reports and large exports already run as background jobs (the FR-12 pattern), and
  stay that way through the tunnel.

**FR-20.74 — The tunnel works with more than one global pod.**
- A request that reaches a pod without the master's uplink is forwarded to the pod that holds it.
- A rolling deploy costs only the requests in flight and a reconnect.

**FR-20.75 — Read-only mode lives on lgrai.app, never on the master's address.** While a master's
uplink is down:
- **The org at lgrai.app serves the mirror read-only**, on lgrai.app's own origin, under global's own
  session: the person's global identity and the mirrored membership.
  - Reads, reports and exports work (FR-20.4's `readOnly` routes).
  - Every write, and every read that writes (FR-20.6), answers `org_home_elsewhere`.
  - A banner says *"The shop's server is offline since 14:02 — this is a read-only copy as of
    14:01"*.
- **The master's address serves only a static notice**, with a link to that read-only view. It never
  offers sign-in, and global never issues a token or sets a cookie for an org address.
  - That origin runs the master's code whenever the master is back. A global session minted there
    would be read by the master's JavaScript, or sent to the master by the browser.
  - A global session carrying the person's `iid` reaches every org that person belongs to
    (`POST /auth/switch`, `auth.controller.ts:232-245`).
  - So one customer-operated master would harvest an accountant's access to their other companies.

**FR-20.76 — Operations target the home.**
- Import skills and API-driven scripts take the master's address (`--server`). They sign in with the
  operator's **local password** (FR-20.40), because a master never accepts a global password.
- Read-only investigations MAY use the mirror.
- For an on-prem org, direct-to-Mongo scripts run on the master, never against global, and only the
  vetted ones the package carries (FR-20.26).

**FR-20.77 — End-to-end privacy (MAY).**
- **TLS passthrough.** Global relays bytes it cannot read. The master holds the key for its own
  address, obtained by ACME DNS-01; global only writes the TXT record.
- **The roomler overlay.** For privacy-mode orgs, it is the other way in: it reaches a master with
  no inbound ports and needs no tunnel through global.

**FR-20.78 — Nothing unauthenticated is tunnelled, beyond the sign-in flow.**
- **At global's edge,** a request to an org's address that carries no session credential (a
  `__Host-` session cookie or a bearer token) reaches the master only for the app's static UI (GETs
  outside `/api/`), the "Sign in with LGR" redemption, and WebSocket upgrades. Global answers
  everything else with 401, and rate-limits anonymous requests per address and per client.
- Global only checks that a credential is present. The master validates it.
- **WebSockets authenticate in their first message** and are closed after 10 s otherwise, as
  `/ws/desktop` already works. `/ws/tasks` moves to that pattern (§2.9) before the tunnel ships.

### 5.9 Moving an org's home

**FR-20.79 — Cloud → master** (regal-pz's move). An admin starts it on lgrai.app once the master is
registered at Full. It runs in six steps:
1. **Preconditions:**
   - no open POS session, no fiscal command in flight, no import job running;
   - the master is healthy and has enough disk;
   - every person who works at the site has set a local credential on lgrai.app (FR-20.40). The
     preflight lists those who have not.
2. **Freeze.**
   - Global refuses writes for the org (`org_frozen`), with a banner.
   - The copy starts only after twice the home-record cache's lifetime has passed, so that no pod
     still acts on a cached "home is here" (legal allocations check the home inside their own
     transaction anyway, FR-20.4).
   - The org's outstanding desktop enrollment codes and keys are revoked.
3. **Copy.** The org's documents and files go into the master, bundle-shaped (the FR-13.12 manifest
   with per-collection SHA-256). On the way, file paths are relative (FR-20.24), and these never
   travel: password copies, `Org.settings.integrations`, and FR-20's own state (FR-20.3, FR-20.44).
   Two more rules:
   - **The local-credential verifiers travel** with the copy, sealed to the master's node key
     (FR-20.40).
   - **Size.** An org the size of regal-pz copies in minutes, so the copy runs inside the freeze,
     after closing time. A live copy with catch-up is needed only for an org too large to freeze
     that long.
4. **Verify.** Per-collection digests are equal on both sides.
5. **Flip.** The epoch goes up by one, and the home becomes the master. Global keeps the documents
   as the mirror, with its watermark and hash chain set to the master's seeded journal head.
   Nothing is sent back.
6. **Re-point and unfreeze.** **Global** re-points the org's desktops (FR-20.82), because they are
   still connected to it. The org is then unfrozen on the master, and the trader is shown the
   Прил. 32 changes (FR-20.50).

Until step 5, the move is undone by unfreezing global.

**FR-20.80 — Master → cloud.** In six steps:
1. Freeze on the master.
2. Wait until the watermark equals the journal head **and every file has been transferred**. A
   metadata-only org transfers its files first (FR-20.69).
3. Verify the digests.
4. Bump the epoch and make global the home.
5. **The master** re-points its desktops to lgrai.app (FR-20.82).
6. Unfreeze on global.

The master stops serving the org, and keeps a read-only copy until an admin removes it.

**FR-20.81 — A lost master, and a replaced one.** When a master is gone for good, an admin on global
may **promote the mirror**. The danger is not lost data. It is a master that is only cut off: it is
still issuing invoices in the shop from a counter above the mirror's, while global starts issuing
the same numbers to other customers. So promotion requires evidence, not just a confirmation:
- **Evidence.**
  - The admin attests that the master PC is off, or destroyed, and that its tills are disconnected.
  - The master must have been silent for at least 24 hours, unless the attestation records the
    hardware as destroyed.
  - The dialog states the **duplicate-number risk** as well as the loss window: *"changes made on
    the server after 14:01 on 21 Oct are not here; if that server is still running, it may issue
    invoice numbers that this one will issue again"*.
  - The admin types the org slug.
- **The flip.** The epoch goes up by one, and the home becomes global.
- **Global's legal series stay frozen after the flip** until a person records the last numbers
  issued at the site: from the last printed documents, and from the fiscal device's report. They
  then resume above them (FR-20.51).
- **If the old master returns,** it fences itself (FR-20.8). Its sales above the fence cutoff are
  brought in under FR-20.84, never lost.
- **Replacing a dead master** is this promotion followed by a move to the new machine (FR-20.79).
  - The new machine is a new node with new keys.
  - Its desktops re-pair: a dead master cannot re-point anything.
  - People's local credentials are delivered again from lgrai.app (FR-20.21).

**FR-20.82 — Desktops follow the home, and keep their identity.**
- **The instruction comes from the side the desktops are connected to.** That is global, for a move
  to a master, and the master, for a move back. The instruction is signed by the old home and sent
  over `/ws/desktop`. It carries the new address and the new home's certificate pin.
- **The desktop keeps its id and its key.** The `desktops` registry moves with the org (registry
  fields, FR-20.63), so a re-point is not a new enrollment. `FiscalDevice.connectionParams.bridgeDesktopId`
  therefore still names the desktop that holds the till's port.
- **What the desktop does.** It trusts the new home's pin, mints its tokens there with its existing
  key, clears the webview's storage for its proxy origin (FR-20.32), and restarts its bridge in
  place. Today moving the bridge needs an app restart (§2.5).
- **A desktop that missed the instruction** shows *"<org> has moved to <server>"*, with one action to
  re-register.

**FR-20.83 — Air-gapped → linked (MAY).** An Air-gapped master links later:
1. The org is created on global as a mirror, and renamed if its slug is taken.
2. People are linked by verified email, as each signs in at lgrai.app.
3. The mirror is seeded.

**FR-20.84 — A fenced master's work is exported, then imported on purpose.**
- **Export.** A fenced master puts everything it captured **above the fence cutoff** (FR-20.8) into a
  sealed bundle.
- **Review.** A person reviews it.
- **Import.** The sales and documents in it are brought into the home through the audited import of
  FR-20.51.
  - Their numbers are kept when they do not collide.
  - Where one does collide, the later document is annulled by a credit note and re-issued under a
    new number (FR-20.51), and the customer receives the corrected document. The import never
    re-keys a number silently.
- It is never pushed automatically and never discarded.

### 5.10 Jobs and integrations

**FR-20.85 — Jobs that write org data run on the home only.**
- **What it covers:** the digest, backups, retention, time sync, the fiscal-status reset, and every
  other scheduler's org loop. All go through one `isHomeHere(orgId)` gate.
- **Sweeps that cover every org** filter by home as well (FR-20.5). Retention's
  `stripSettledCompareSummaries` (`retention.service.ts:97-104`) has no org loop to gate, so it
  gains an org filter.
- **On global**, the schedulers skip on-prem orgs.
- **Every scheduler is listed** with where it runs (plan Part A.8).

**FR-20.86 — Outbound work is queued, not lost.**
- **The outbox.** Mail, VAT lookups, LLM steps, off-site backup pushes, and anything else that needs
  the internet, go into a durable outbox on the master. Each item leaves once, when the uplink
  returns.
- **Every item has a deterministic id.** For a digest it is `digest:<orgId>:<date>`, so a re-run
  re-enqueues nothing. The digest's stale-claim takeover (`digest-runner.service.ts:202`) would
  otherwise queue the same mail twice.
- **The digest.** A day's digest counts as done only once its mail has gone (§2.2).
- **Honesty.** The UI says *queued*, never *sent* (FR-10's rule).

**FR-20.87 — Reference data.**
- **`din_catalog`** arrives over the control channel when linked, or inside the update package when
  Air-gapped.
- **Exchange rates** are rows entered by hand today (§2.2), and stay so.
- **The `orgId:null` system rates** are global reference data, delivered the same way as
  `din_catalog`.

**FR-20.88 — Document import on a master.**
- **Extraction runs on the master.** The package includes pdftotext and tesseract with Bulgarian
  (`bul`). Today they live in the `lgr-ocr` sidecar, whose image also carries the Claude Code CLI on
  a subscription token and cannot be distributed.
- **The deterministic PlusMinus parser** works offline.
- **The LLM steps** (`/draft`, `/match-lines`) are relayed through global, only when the org allows
  it, and never at Control or Air-gapped unless the org turns them on.

**FR-20.89 — Billing stays on global.** Masters never call Stripe.

### 5.11 Privacy and security

**FR-20.90 — The org's settings page says what leaves the building**, per link level and per relayed
service, in the words of FR-20.54's table.
- **A master serves no third-party script.** The purestat analytics beacon (`portal-ui/index.html:8`)
  is off on a master, and so is any CDN asset. Neither may leave a trace of a Control or Air-gapped
  site on the internet.

**FR-20.91 — At rest.**
- **Disk encryption.** The installer checks for BitLocker, FileVault or LUKS. The status page warns
  when the data volume is not encrypted.
- **Backups** that leave the building are sealed (FR-13).

**FR-20.92 — On the LAN.**
- `mongod` listens on loopback only (the standby option aside, FR-20.15).
- **The LAN ingress requires a paired desktop**, and only the supervisor terminates it (FR-20.16).
- **Local credentials work only on the LAN and console ingresses** (FR-20.40).
- The client IP comes from the ingress socket.
- Swagger is off, and rate limits are on.
- **The firewall.** The installer's inbound rule covers the Domain, Private **and** Public profiles,
  restricted to `RemoteAddress=LocalSubnet`. Windows marks a new network Public, so a
  Private-only rule would leave the tills unable to reach a freshly installed master.
- A guest Wi-Fi client gets nothing from the port (trap 10).

**FR-20.93 — A master's secrets are its own.** They are generated at install, rotatable from the
status page, and never the cloud's (D-12).

**FR-20.94 — Revoking a master stops its link, not its shop.**
- **What revocation does.** Revoking a master on global refuses its uplink at once. The node row is
  re-read on every connection and every page (FR-14.20's rule), and the mirror stays read-only on
  global until it is deleted.
- **What it does not do.** The master keeps serving its LAN, with a banner on every client: it is
  still the org's home (FR-20.60). Revocation is about whether global trusts the node. It is never a
  remote kill switch, which a bug or a forged close code could otherwise turn against a shop
  (FR-20.52).
- **Taking the home away** is a move or a promotion (§5.9), with its own safeguards.

**FR-20.95 — Tenant isolation over the node surface.**
- A node can replicate, tunnel and control only the orgs it is home for.
- `tenant-isolation.flow.test.ts` and the e2e `security` project gain the cross-node and cross-org
  cases. FR-20.7's by-id probe is part of the suite.

**FR-20.96 — Every node and move action is audit-logged on both sides**: registration, link-level
changes, freeze, flip, promotion, fence, export, import and revoke.

**FR-20.97 — Data residency.**
- **What must be in Bulgaria or the EU** (Н-18 чл. 52з(14), 52к(1)): global, every mirror, the
  backup vault, and every off-site backup destination.
- **Setup refuses an off-site destination whose region is not.**
  - S3-compatible storage declares its region.
  - Google Drive cannot choose one for a personal account, so it is offered only where the org
    attests a Google Workspace EU data region.
- **The same rule binds FR-13's existing Drive and S3 copies of cloud orgs** (§2.8).

### 5.12 Observability

**FR-20.98 — A server status page on the master**, for admins. It shows:
- `mongod`, the oplog window and the disk;
- journal lag, the uplink and the mirror watermark;
- the last backup;
- desktops online and the fiscal devices;
- the update state and the SUPTO version;
- the Прил. 32 fields (FR-20.50).

**FR-20.99 — A nodes page on global**, for sys-admins: every master, with its version, link, lag,
last-backup age and alarms.

**FR-20.100 — The digest** (FR-11) gains, for an on-prem org, the mirror lag, the last backup, and
anything queued for the internet.

**FR-20.101 — Alarms** are raised for:
- mirror lag above 1 h while the uplink is up;
- a backup older than 26 h;
- disk below 10 %;
- an oplog window below 7 days;
- a fenced master;
- clock skew above ±2 min;
- a SUPTO version waiting for declaration.

### 5.13 Resilience options (MAY, decided by field data from P3)

**FR-20.102 — Standby master.** A second LAN machine runs as a secondary of the master's replica set,
with an arbiter, so the shop survives one PC dying. Desktops know both addresses.
- **Its `mongod` faces the LAN** only toward the other member's address, with TLS and the keyfile.
  This is the one exception to FR-20.15 and AC 15.
- **Both machines carry one node identity.** Only the replica set's primary runs the API and the
  uplink, so this is not a clone (FR-20.51). The option needs its own acceptance criteria when it is
  specified.

**FR-20.103 — Power.** The site checklist includes the master on a UPS, with a clean shutdown on a
power event.

**FR-20.104 — Offline till: fiscal receipts only.** A desktop that completes POS sales while its
master is unreachable needs:
- a cached catalog and prices;
- PIN sign-in;
- the fiscal drivers running in the desktop;
- **the УНП allocated by the till for its own fiscal device.** One allocator per device (FR-16.48):
  while the till holds the device, the master does not allocate for it;
- an outbox, imported into the master as *already fiscalised* sales (FR-20.51).

**It issues no invoices.** A customer who needs one gets it from the master within 5 days (ЗДДС
113(4)), so no invoice range is needed (D-7).

Whether a till-local database counts as a declared part of the same SUPTO is a question for НАП
(§12 Q8). **It needs its own FR amendment before any code.**

**FR-20.105 — Multi-site orgs** (one org across two LANs) are out of scope. regal already runs one
org per site.

### 5.14 Tests and automated field testing

FR-20's claims are about networks, machines and failures: a cut line, a dead PC, a corporate proxy, a
till that loses a response. No developer machine has those. The coverage therefore follows roomler's
FR-61 vmtest matrix: throwaway instances on the fleet hosts, built from the signed artifacts, wired
into real topologies, and destroyed after every cell.

**FR-20.106 — Three tiers, one result protocol.**
- **Tier 1, integration** (`packages/tests`, in CI on the self-hosted mars runner):
  - the in-process suites on `mongodb-memory-server`, as today;
  - a **two-node harness**: a global and a master as subprocesses, each with its own
    `MongoMemoryReplSet`, joined through a **chaos TCP proxy** (drop, delay, black-hole, throttle).
    It covers the uplink, replication, the tunnel, the identity provider and the moves.
- **Tier 2, e2e** (Playwright, `packages/e2e`), with two new projects:
  - `master`: setup, local sign-in, the PIN pad, the status page, desktop pairing on a master;
  - `node`: the Servers page, the move wizard, the read-only banner, a remote edit through the
    tunnel, "Sign in with LGR".

  Both run in CI against tier 1's harness, and in the field lanes against throwaway instances
  (`BASE_URL`).
- **Tier 3, field lanes** on throwaway instances on **mars, zeus and jupiter** (FR-20.107–20.116).
- **One result protocol for all three tiers.** Every check reports `PASS`, `FAIL` or `NA` with a
  detail:
  - **a missing result is `FAIL`**;
  - an `NA` always carries its reason;
  - a check that was never reached, because an earlier check in the same cell already failed, is
    `NA "not reached"`, never `FAIL`; silence without an earlier failure stays `FAIL` (roomler
    FR-61 P9, `lib.sh lift_verdicts`;
    `lgr-deploy/vmtest/README.md`).

**FR-20.107 — The field lanes extend `lgr-deploy/vmtest`; they do not fork it.**
- FR-14.38's harness (C17–C20: `lgr-vmtest.sh`, `lib/lanes.sh`, the `LGRTEST-RESULT` protocol,
  `budgets.tsv`, `expected-failures.txt`) gains the FR-20 lanes.
- ⚠ **That harness has never driven a guest.** Its README says *"written, never run"* as of
  2026-10-19: `lib/host.sh` was never reconciled with roomler's host capability (`k8s-cluster-multi`
  playbook 15, `vmtest-host`, `vmtest-net`, `vmtest-audit`) or with its golden images.
- **Reconciling it is the first step.** It also makes FR-14's desktop lanes run for the first time.

**FR-20.108 — Throwaway instances only.** Every machine in a cell boots from a golden image as a
copy-on-write clone, or from a fresh container stack, and is destroyed at the end (`--keep` to
debug):

| Instance | What it is | Where |
|---|---|---|
| **master VM** | a clean OS + the signed LGR Server package, installed the way a customer installs it | zeus (default), mars (overflow), jupiter (announced window) |
| **local VM** | a clean OS + the signed LGR Desktop, with the Eltrade simulator behind a virtual serial pair (com0com / `socat` pty) | the same host and LAN as its master |
| **global-eph** | a throwaway global: the release's `lgr` image with `LGR_NODE_ROLE=global`, its own MongoDB replica set, and a TLS front for its own test domain (never under lgrai.app, which would make it same-site with production), with org addresses as subdomains of it, as a container stack | mars |
| **remote-user** | Playwright in the pinned container, playing the owner at home | mars |
| **corp-proxy** | mitmproxy with a GPO-pushed root and a PAC file | the corporate lane's host |
| **anchor master** | the one standing exception, like roomler's anchor node: a small master permanently home for `lgr-fieldtest-onprem`, linked at Full to lgrai.app, on the beta channel. Cells use it for production realism (the real ingress, the org address `lgr-fieldtest-onprem.lgrai.app`, the `*.lgrai.app` certificate and the identity provider). They never move, promote or restore it. | zeus |

**FR-20.109 — The lanes are network topologies**, because FR-20's claims are about networks:

| Topology | Hosts | Machines | Exercises |
|---|---|---|---|
| `shop-standalone` | zeus | a master + 2 locals on one `vmtest-net` LAN, with no WAN. Masters: `msi` on Windows 11 and Windows 10, `deb`, `compose`, and `k8s` (a single-node k3s); link level `airgapped` | P1: offline from the first boot |
| `soak` | zeus | a master + 2 locals under a synthetic trading load for 72 h | Bun on Windows as a 24/7 server: memory, handles, log growth, a nightly backup and an update inside the window |
| `shop-linked` | zeus + mars | the same, plus a WAN link to global-eph, shaped by the host | P2/P3: link, mirror, tunnel, outage and return, moves |
| `shop-prod` | zeus | 2 locals and a remote user against the anchor master and lgrai.app | the real ingress, org address, `*.lgrai.app` certificate, identity provider and update feed |
| `shop-corp` | zeus + mars | a Windows Server 2022 or 2019 master behind corp-proxy (PAC, TLS inspection, AppLocker, proxy authentication), with locals on a LAN where multicast is dropped | the corporate case; pairing by typed address |
| `two-shops` | zeus + jupiter (+ mars) | two masters for two orgs, linked to one global-eph | tenant isolation over the node surface; a move with the master on another host |
| `restore-and-lost` | zeus + jupiter (+ mars) | a master restored from a 2-day-old backup; a master powered off while its mirror is promoted, then brought back | FR-20.71, FR-20.81, FR-20.84 |
| `no-avx` | zeus | Linux and Windows VMs with a CPU model without AVX | the installer's refusal, from the `.deb` and from the MSI (FR-20.13) |

**FR-20.110 — The WAN and the LAN can be impaired from the host.** The host capability gains these
operations per lane, applied outside the guest (`tc netem`/`tbf`, nftables) so that no guest can tell
it is a test:
- **WAN:** `cut`, `restore`, `throttle <rate>`, `latency <ms>`, `loss <pct>`, `cgnat` (a double NAT).
- **LAN:** `cut <guest>`, `loss <guest> <pct>`, `drop-multicast`.

Two details decide whether the impairments test the product or the host:
- **A WAN cut acts on the routed uplink only, never on traffic bridged inside the LAN.** With
  `br_netfilter` loaded, a bridge-level rule would also cut the shop's own LAN.
- **Upload shaping uses an IFB device.** `tc` shapes only egress.

`host_cut_network` in `lgr-deploy/vmtest/lib/host.sh` grows into this.

**FR-20.111 — Cells and checks.**
- **A cell is `lane/method/type@host#check`** (FR-61, FR-14.38):
  - `lane` is the topology;
  - `method` is how the master is installed: `msi`, `deb`, `compose` or `k8s`;
  - `type` is the link level: `airgapped`, `control` or `full`;
  - `host` is the host or hosts involved, for example `zeus+mars`.
- **Every FR-20 acceptance criterion that a machine can observe is a check.** The plan maps each
  one in Part F. The rest stay in tiers 1–2.
- **A cell that cannot exist is `NA` with its reason**, never skipped. For example: `airgapped`
  has no mirror; `compose` has no MSI signature.

**FR-20.112 — Synthetic data, sized like regal-pz.**
- **A deterministic, seeded generator** builds a field-test org shaped like regal-pz:
  - about 23k products, with Cyrillic names and fastener tags;
  - about 2k contacts;
  - about 550 invoices;
  - about 900 stock movements;
  - about 1.5k files, about 76 MB in total.
- **No real customer data ever reaches a throwaway instance.**

**FR-20.113 — Isolation and safety rails.** These are FR-61's and FR-14.38's, extended:
- **jupiter carries production storage.**
  - A cell there runs only in an announced window (`VMTEST_JUPITER_WINDOW`; the orchestrator
    refuses otherwise, `lib/host.sh:86-89`), sequentially, and after `vmtest-audit`.
  - The default run uses zeus and mars. The three-host topologies run in a window, per release.
- **One guest per host at a time,** unless the audit shows room.
  - Check `tmux ls` and `virsh list` first: roomler and LGR share these hosts.
  - Never `destroy --all` while another run may be live.
- **Destructive cells run only against global-eph, never lgrai.app.** These are moves, promotion,
  chaos, version skew, a restored master, and a clock advance.
- **Production cells use `lgr-fieldtest`, and the anchor's `lgr-fieldtest-onprem`,** with ephemeral
  node and desktop keys. The node registry gets FR-14.19's ephemeral keys: reusable, gated by an org
  setting, and reaped when silent. Every run ends with both orgs' nodes and desktops back at their
  baseline, with the reaper as backstop.
  - **A node is reaped only after 24 h of silence,** longer than any WAN-cut cell. A 15-minute reaper
    (the desktops' default) would remove a master in the middle of a cut and fail the cell for the
    wrong reason.
- **global-eph shares nothing with production.**
  - It has its own MongoDB, throwaway secrets, and its own test domain with a wildcard certificate.
    The test domain is never a subdomain of lgrai.app, which would make it same-site with
    production.
  - **That certificate is issued once and renewed, never per run.** Let's Encrypt limits duplicate
    certificates.
  - SendGrid, the LLM and the VAT lookup are stubs on it; they record what they were asked, for the
    assertions.

**FR-20.114 — Verdicts and regressions follow FR-61.**
- **Each run writes:** `results.tsv`, `LATEST` and `expected-failures.txt`. The expected failures
  are of two kinds: tracked defects, each with an issue, and by-design refusals, each with a spec
  reference.
- **Before anything is filed,** a failing cell gets one isolated re-run.
- **Then one `gjovanov/lgr` issue per condition** (`lane/method/type#check`, with the host stripped).
  A repeat failure is a comment on it, and the first green run closes it.
- **`triage --run-dir`** re-evaluates a finished run without booting anything.
- **Everything sent to GitHub is redacted:** host names, tokens and keys.

**FR-20.115 — Budgets are measured before they are enforced.** These start `advisory` in
`budgets.tsv`, and become `enforce` after a handful of runs establish the real distribution:
- mirror latency p95;
- catalog-flood catch-up;
- tunnel request p95;
- master boot to LAN-ready;
- update duration;
- the WAN-cut day's request latencies.

**FR-20.116 — One command, a release gate and a field log.**
- **One command.** `lgr-vmtest.sh run --lane <topology> [--method --type --check --host --keep]`,
  run from the dev box via mars, runs any cell. `report` prints the verdict.
- **The release gate.** A server release reaches the stable channel only when two things hold:
  - the supported matrix is green, or each failure is expected and has its issue;
  - its field-verification log shows every new check failing first, then passing (FR-14.39's
    convention: a check never seen failing is not evidence).
- **The skill** `.claude/skills/lgr-vmtest/` is written once the lanes are green, as roomler's P8
  was.

---

## 6. Edge cases and traps

1. **Two homes is the one failure that cannot be repaired.** The concrete harm is two allocators
   issuing the same invoice number. Every rule that touches homes exists to prevent it:
   - moves are fenced by the epoch (FR-20.8);
   - a missing or older home record fails closed (FR-20.3);
   - a lost master is promoted only on evidence that it is gone, and global's legal series stay
     frozen until the site's last numbers are recorded (FR-20.81);
   - a master that comes back after that refuses its own LAN writes rather than continuing;
   - a clone is caught on the LAN and by global (FR-20.51).

   ⚠ The **dangerous** lost master is the one that is only cut off. It keeps selling, from a counter
   above the mirror's.
2. **A master restored from a backup is behind its mirror.** The sales made after the backup exist on
   global and on paper, but not on the restored master. Three tempting fixes are all wrong:
   - pushing the restored state deletes those sales from the mirror, which is forbidden;
   - re-issuing their numbers duplicates them;
   - merging only "what the master lacks" brings back documents deleted since the backup.

   FR-20.71 re-seeds from the mirror under a restore lock. ⚠ The same holds for a VM snapshot
   reverted, a disk image copied, and FR-13's own in-app restore. Only a lock driven by outside
   witnesses (the fiscal device, global's hash chain, a person reading the last printed number)
   catches them all (FR-20.51). An Air-gapped master has only the device and the person.
3. **A lost response on the LAN double-sells.** `POST /session/:id/transaction`
   (`pos.controller.ts:568`) takes no idempotency key. A till that loses the response retries, and a
   second sale is recorded and a second fiscal receipt printed. FR-20.37 makes the hot path
   idempotent. The same is true of the cloud today.
4. **The fiscal printer is driven from the server.** The native bridge only moves bytes; the drivers
   and the УНП are on the server (FR-14.26). A till pointed at lgrai.app while its org's home is the
   master would split fiscal control. Moves re-point desktops (FR-20.82), and a desktop registered
   to a node that is not the home is told so.
5. **Masters update on their own schedule.** A master can run an older release than global for days.
   - Replicated documents carry the master's schema, so global's read-only views must tolerate them.
   - Data migrations must expand and contract across one release (FR-20.19–20.20).
   - The tunnel serves the master's own UI, so what a remote user sees always matches its API (D-5).
6. **Migrations are run by hand today.** `scripts/migrate-*.ts`, `backfill-*.ts` and the
   `--execute`/`--strip` phases work for one cloud, not for fifty masters. A release that needs a
   migration a master cannot run by itself is a release no master can take.
7. **Ops scripts write to Mongo directly.** `assign-din-tags`, `seed-products --no-clean` and
   `backfill-*` use `bulkWrite` and skip Mongoose.
   - Run against global for an on-prem org, they would write into the mirror and be overwritten by
     the next page. Or worse, they would create documents the master never sees.
   - Every writing script calls `assertHomeIsHere()` (FR-20.4), and the reconcile flags strays.
   - `scripts/backfill-movement-reference.ts` already reads a collection that does not exist
     (`organizations`). Without `--org` it rewrites the stock movements of every org.
8. **A catalog rewrite floods the mirror.** `assign-din-tags` touches all 23,246 regal-pz products in
   one run. The journal collapses that to one row per product, but over a shop's uplink it is still
   about 50 MB. Bulk replication runs on its own socket, so it never queues behind a remote user's
   click, or in front of it (FR-20.52).
   - `seed-products --clean` is worse: it deletes the catalog and re-inserts it under new `_id`s,
     which means a full set of tombstones plus a full set of inserts.
9. **mDNS is often blocked.** Corporate Wi-Fi, VLANs and guest isolation all drop multicast.
   Discovery is a convenience; a typed address with a pinned fingerprint always works.
10. **Guest Wi-Fi in the shop.** A master listening on the LAN is reachable from the customers' Wi-Fi
    when the router does not isolate it. The LAN listener requires a paired desktop's credential
    (FR-20.32), so reaching the port gives nothing.
11. **CPU floors.** MongoDB 5.0 and later needs AVX on x86-64, or ARMv8.2-A. Bun's default x64 build
    needs AVX2. Old Celeron and Atom shop PCs, and the Raspberry Pi 4, cannot run them. The
    installer checks before it installs anything, and ships Bun's baseline build (FR-20.13).
12. **A roaming or redirected profile is no place for a database.** The data directory is
    machine-wide (`%ProgramData%`, `/var/lib`): never under a user profile, and never on a share.
13. **Windows clocks.** Cloned VMs boot hours ahead (roomler FR-61), and shop PCs drift.
    - Nothing orders data by a local's clock.
    - The master's clock drives the fiscal-device sync, and is checked against global's when linked.
    - The time check never reports "0 drift" when it could not check (FR-20.22).
14. **Fiscal day boundaries during a move.** A move with an open POS session, or a fiscal command in
    flight, is refused. The Z-report must be run where the session was opened.
15. **The 73 `e2e-*` orgs.** Nothing is seeded or mirrored without the opt-in.
16. **`PUT /org/:orgId` replaces the whole `settings` subdocument** (the FR-11 / FR-13.55 trap). Home,
    link and node state live in their own collections, never in `Org.settings`.
17. **Absolute file paths.** Stored paths include the server's upload root (§2.6). Copied as they
    are, every document on a master would point at `/app/uploads/…`, and every mirrored one on
    global would point at `C:\ProgramData\…`. FR-20.24 makes paths relative before anything moves.
18. **Local servers in the rendering path.** Anything that serves files or a debugging protocol on a
    socket while it renders is reachable from everything that can reach the machine; on a shop LAN,
    that includes the guest Wi-Fi. FR-20.25 renders from memory, over a pipe.
19. **One API process.** The fiscal registry and the bridge sockets are in memory (§2.1). A master
    runs one API process. The standby master (FR-20.102) is a second machine, never a second process
    on the first.
20. **Cross-org writes bypass the route gate.** A password change on global rewrites the person's
    membership in every org (`account.service.ts:45`), on-prem orgs included, unless FR-20.5 holds.
    The boot-time `FiscalDevice` reset touches every org's devices. Neither request carries an
    `:orgId`.
21. **Reads that write.** Printing an invoice allocates a companion number on a GET (§2.3). On a
    read-only mirror that would make global a second allocator (FR-20.6).
22. **The write gate checks the URL's org, not the document's.** A by-id route that did not filter
    by org would let a cloud user of org B, writing through `/api/org/B/…/:id`, reach a mirrored
    document of on-prem org A: the gate passes, because B's home is global. FR-20.7's route-table
    probe holds before P3.
23. **Split documents.** A whole-document page would overwrite `Org.subscription`, which global's
    Stripe webhook owns, and would carry `FiscalDevice.status` from one node to another
    (FR-20.63).
24. **The УНП counter key.** Today two operators on one device both issue `…-0000001` (§2.8). When
    the key is fixed, the new per-device counter must start above every number already issued on
    that device (FR-20.45).
25. **Cyrillic regex.** Bun transpiles Cyrillic regex literals to `\uXXXX`, which Mongo refuses.
    Nothing in replication builds `$regex` from Cyrillic.
26. **`.rejects` / `.resolves` deadlock the Windows test run.** New suites use `captureRejection` /
    `expectRejection`.
27. **Loopback is not a trust boundary on a machine that replays the internet onto it.** The first
    draft replayed tunnelled requests onto the API's loopback listener, with the internal secret
    attached. An anonymous request to `/internal/repl/page` at an org address would then have
    dumped the org, and `/internal/shutdown` would have closed the shop. FR-20.16 gives each ingress
    its own stamp, strips client `X-LGR-*` headers, and moves control off HTTP entirely.
28. **A global session on a master's origin leaks every org of that person.** The origin runs the
    master's code. A global token carrying `iid` can enter any of the person's orgs
    (`auth.controller.ts:232-245`). Read-only mode therefore lives on lgrai.app's origin (FR-20.75).
29. **A master names the paths of its files.** Global writing a mirrored file where the row says
    would let a compromised master write outside its org, or into the app's own files: the pod runs
    as root (`base.pdf.ts:69-70`). Files are stored by content, per org (FR-20.66, FR-20.69).
30. **Revocation is not a kill switch.** A supervisor that exited on a revocation close code would
    stop `mongod` and the API, and with them the shop's sales and its fiscal day close. It stops only
    the link (FR-20.94).
31. **A clock reset after a power cut writes into fiscal memory.** The time sync pushes the OS clock
    into the device even when the check failed (`time-sync.service.ts:82-85`). On a master it pushes
    only a verified clock (FR-20.22).
32. **A lockout is a denial of service.** A PIN that locks after five failures, offered through the
    tunnel, lets anyone lock every operator out for the length of an outage. Local credentials are
    LAN-only and back off rather than lock (FR-20.40).
33. **Argon2, not bcrypt.** `Bun.password.hash` with no algorithm writes `$argon2id$` hashes. A leak
    test that scans only for `$2a$`/`$2b$` passes while every hash leaks (FR-20.44).
34. **A global disaster-recovery restore can predate a move.** Restored as is, global would believe
    it is home again for an org a master now writes. Orgs that have a node start in `hold` after such
    a restore (FR-20.3), and the FR-13 restore runbook says so.
35. **Bundles carry FR-20's own state** unless they are told not to. `tenantCollections()` takes
    every model with an `orgId` (`backup-bundle.service.ts:62-79`), so a Replace restore would
    rewrite who is home (FR-20.3).
36. **A subdomain of lgrai.app is same-site with it.** `SameSite` cookies flow from a master's pages
    to lgrai.app; a master's JavaScript can set `Domain=lgrai.app` cookies that no router can strip;
    and a password manager offers lgrai.app passwords on the subdomain. FR-20.72's hardening closes
    the cookie and session paths. The phishing credibility remains, and D-13 says so.

---

## 7. Integration constraints

- **The FR README's global constraints hold:** import endpoints stay byte-compatible, and so do the
  invoice payload, route names and registry-driven prefixes; the test commands and the Windows
  `.rejects`/`.resolves` rule apply.
  - For an org whose home is global they hold trivially, because nothing on its path changes
    (FR-20.4).
  - For an on-prem org they hold on the master, which runs the same code.
- **FR-14.** The desktop's rules stay:
  - no token in a URL;
  - OAuth leaves the webview;
  - `lgr-web` has no IPC;
  - the updater's trust rules.

  The shell gains a master as a kind of server, plus discovery, pinned TLS and the loopback proxy.
- **FR-19.** One Identity per person, on global, and memberships per org.
  - Rule 2 (an org admin never controls the credentials of someone active in another org) applies on
    a master too. A master admin can revoke a person's local credential, but never set it.
  - The move never copies the legacy per-org `User.password` copies.
- **FR-13.** The move and the master's backups reuse the bundle format (FR-13.12) and the restore
  path. ⚠ FR-13 blocks *Replace* on an org with an active fiscal device. Importing an org into an
  **empty** master is a different operation (there is no live data to replace), so it gets its own
  path rather than an exception to that rule.
- **FR-09 / SUPTO.**
  - A move never alters an issued fiscal document, and it requires the POS day to be closed.
  - The SUPTO findings in §2.8 go into a separate compliance ticket. FR-20 fixes only the УНП key,
    because the home's allocator is what moves.
- **FR-11.** The digest runs on the home. For an on-prem org, its mail goes through global's relay.
- **`lgr-deploy`** gains:
  - new sealed secrets: `NODE_TOKEN_SECRET`, the identity signing key and the licence key;
  - a `*.lgrai.app` DNS record, wildcard certificate and ingress rule for the org addresses;
  - WebSocket timeouts long enough for the uplink;
  - the FR-20 lanes and the global-eph stack in `vmtest/` (§5.14).
- **`k8s-cluster-multi`** (the host capability vmtest stands on) gains:
  - playbook 15's `vmtest-host` role on jupiter too (opt-in, never in `site.yml`, used only in
    announced windows);
  - the WAN and LAN impairment operations on `vmtest-net` (FR-20.110);
  - golden images for Windows Server 2022 and for a CPU model without AVX.

  roomler's lanes keep working unchanged: the additions are new verbs and new images.

## 8. Migration and ops notes

1. **P0 changes nothing for anyone**, except where it fixes or hardens what the cloud already runs
   (P0a). It ships, and production is watched for a week, before a single master exists.
2. **A field-test org goes first.**
   - It is generated: shaped and sized like regal-pz, but synthetic (FR-20.112).
   - It goes through every phase on a lab master running on the same model of PC regal uses.
   - A clone of regal-pz's own bundle would put real customer data on a lab machine. The bundle's
     file paths would also still point at regal-pz's real files.
3. **regal-pz moves after closing time, after an onboarding day.**
   - On that day, while the org is still on lgrai.app, every person sets their local password, and
     each till operator their PIN, for the on-prem server, under their account (FR-20.40). The move
     carries those verifiers to the master.
   - The move needs the accountant's confirmation (§12 Q5).
   - During the parallel run PlusMinus keeps the A3 and LGR's POS prints non-fiscal text. LGR takes
     the device at cutover, so no УНП ranges need declaring (§12 Q10).
   - PlusMinus runs in parallel until the daily reconciliation has been clean for an agreed period.
4. **Operations follow the home.** Skills and API-driven scripts take the master's address, and
   direct-to-Mongo scripts run on the master (FR-20.76).
5. **Releases change shape.**
   - A migration is code that every node runs.
   - A release reaches masters through the beta channel before stable.
   - A SUPTO-version release waits for its declaration (FR-20.50).
   - The package is reproducible (FR-20.26).

The step-by-step runbook is Part C of the implementation plan.

## 9. Phases

Each phase ships on its own, is useful on its own, and can be switched off without touching the
phase before it.

| Phase | Ships | Useful because | Kill switch / rollback |
|---|---|---|---|
| **P0 — Fixes and foundations** | **P0a, fixes and hardening the cloud needs anyway:** org-scoped by-id routes (FR-20.7), self-contained PDF rendering (FR-20.25), `/ws/tasks` auth (FR-20.78), idempotent hot path (FR-20.37), the УНП key (FR-20.45), scheduler independence, lgrai.app ready for subdomains (FR-20.72). **P0b, foundations:** node role, home registry + write gate (a no-op for every org whose home is global), cross-org writers and reads-that-write gated, automatic versioned migrations, relative file paths, a reproducible allow-listed build, stale docs fixed. **Coverage:** the two-node harness + chaos proxy, the synthetic-data generator, and `lgr-deploy/vmtest`'s host layer reconciled with roomler's, so that FR-14's desktop lanes run for the first time. | P0a fixes the cloud today. P0b is everything later phases build on, with no behaviour change on global. | The role defaults to `global`, and an absent home record means global. |
| **P1 — The master, on its own** | LGR Server for Windows first (regal's PCs), then Linux (+ Compose), then macOS. LAN TLS, pairing and the desktop's loopback proxy; local identities and credentials; local backups; the server updater. **Coverage:** the `shop-standalone` and `no-avx` lanes; the e2e `master` project. | A shop, or a company that wants no cloud, runs LGR with no internet at all. | Uninstall; nothing on global changed. |
| **P2 — The cloud link** | Node registry and enrollment on global; the uplink; the control channel (licence, updates, health, clock); "Sign in with LGR" + local credentials; relayed services; masters serving their desktops' updates. **Coverage:** ephemeral node keys; the throwaway global (global-eph) on mars; the `shop-linked` (Control) and `shop-corp` lanes. | A master is licensed, updated and signed into through lgrai.app without sharing any business data (link level Control). | Link level → Air-gapped; revoke the node. |
| **P3 — Mirror, remote access, moves** | Journal on the master; mirror apply on global (with split-document ownership); the tunnel and the org addresses (`<slug>.lgrai.app`); read-only mode; the three moves; the restore lock, clone detection and re-seeding a restored master from the mirror; reconcile; alarms and digest lines; the Прил. 32 hand-off. **Coverage:** the `shop-linked` (Full) lane; `shop-prod` with the anchor master; `two-shops` and `restore-and-lost` across zeus, jupiter and mars (in announced windows); the e2e `node` project; the release gate. | **regal-pz moves on-prem** with everything it has at lgrai.app today, plus offline. | Move back to the cloud; link level → Control. |
| **P4 — Resilience options** | Standby master; offline till (its own FR amendment); TLS passthrough for privacy; Air-gapped → linked. | Only if the field data from P3 asks for them. | Per feature. |

## 10. Acceptance criteria

**P0, fixes, hardening and global regression:**

1. With no home records, the full suite (`bun run test`, `bun run build`, `bun run test:e2e`) passes
   unchanged, and every import skill runs unchanged against global.
2. A route-table test proves that every non-GET route under `/api/org/:orgId/` answers
   `409 org_home_elsewhere` when the org's home is another node, and is unaffected otherwise.
3. Cross-org writers respect the home:
   - a password change on global writes no membership of an on-prem org;
   - the boot-time reset touches no device of an org whose home is elsewhere.
4. Reads that write respect the home: on a mirror, printing a document that has no companion number
   is refused, and the App Hub inserts nothing.
5. Every by-`_id` route, probed with an id from another org, answers 404. No PUT can change `orgId`.
6. Schedulers:
   - every scheduler's org loop skips an org whose home is elsewhere (one test per scheduler);
   - a scheduler that throws at start does not stop the others.
7. Idempotency: each hot-path operation retried with the same key produces one document, one stock
   effect and one fiscal print, and the retry returns the first response. The operations are
   opening and closing a POS session, a POS sale, a storno, a cash sale, an invoice issue and a
   payment record. AC 57 covers a crash between the save and the print.
8. Every migration runs twice on a seeded database, with no change on the second run.
9. After the path migration every stored file path is relative, and a bundle restored on a server
   with a different `UPLOAD_DIR` opens every file.
10. Rendering an invoice PDF opens no listening socket (checked against the OS socket table during
    the render).
11. `/ws/tasks` refuses a subscription without first-message authentication.
12. Two operators selling on one fiscal device receive consecutive 7-digit УНП numbers, never the
    same one, and the first number after the migration is above every number issued before it.

**P1, the master:**

13. On a clean Windows 11 VM, the signed MSI installs LGR Server as a service. After a reboot with no
    user signed in, the server answers on the LAN within 60 s.
14. The installer refuses each of these, says why, and installs nothing: a CPU without AVX, a network
    data path, less than 4 GB of RAM.
15. On the LAN:
    - `mongod` is unreachable from another LAN machine (the standby option aside, FR-20.102);
    - the LAN ingress answers `401` without a paired desktop's credential;
    - the login throttle uses the ingress socket's address, not `X-Forwarded-For`.
16. A desktop pairs by code + fingerprint. A forged server with another certificate at the same
    address is refused by the pin.
17. With the WAN cable pulled for a full trading day, all of these work: POS sales with fiscal
    receipts, invoices with consecutive numbers, cash sales, goods receipts and the FR-09 day close.
    No request waits on a DNS lookup or an external call.
18. Pulling a till's LAN cable mid-sale and retrying never produces a second sale or a second receipt.
19. Updates:
    - an update during business hours waits;
    - at night it installs and passes its health check;
    - a forced health failure rolls back to the previous version with the data intact.
20. A nightly backup lands on the local destination and restore-verifies.
21. The package contains no gitignored path and no secret name. FR-20.26's CI check fails on a
    planted one.

**P2, the link:**

22. A master behind a TLS-inspecting proxy configured by PAC links, using the OS trust store.
23. No payload from global to a master, and no move bundle, contains any of these:
    - a password hash: `$argon2…`, which is what LGR writes, or `$2a$`/`$2b$`/`$2y$`;
    - an OAuth token, including `Org.settings.integrations`;
    - a reset token.
24. Sign-in:
    - "Sign in with LGR" works on a master, and a PIN the person set on lgrai.app reaches it;
    - with the WAN pulled, the PIN works;
    - the global password is not accepted anywhere on the master.
25. A password change on lgrai.app ends that person's master sessions within 60 s while linked, and
    at the next reconnect otherwise.
26. A master linked at **Control** sends only control messages:
    - with every relayed service off, global's per-channel record of a trading day contains no org
      document;
    - with the mail relay on, it contains only that relay's messages in addition.
27. With the uplink down for 30 days (clock advanced), the master keeps working. Mail queued in that
    time is sent once on reconnect, never twice, and never reported as sent before it was.
28. A till updates its desktop from the master with the WAN pulled.

**P3, mirror and moves:**

29. The tailer journals writes from `bulkWrite`, `updateMany`, `insertMany`, `deleteMany` and raw
    `collection.*` calls. Each test fails with the tailer off.
30. Speed:
    - a single-document change on the master is visible on global within 5 s (p95, uplink up);
    - a 23k-product catalog rewrite is fully mirrored within 15 min over 10 Mbit/s;
    - meanwhile, a remote user's request still answers within 2 s.
31. Killing the master, the uplink or a global pod at random points during replication loses nothing
    and duplicates nothing. The mirror's per-collection digests equal the master's.
32. A page that names another org, another node, a stale epoch or a non-replicated collection is
    refused and alarmed, and nothing is written.
33. A Stripe webhook that updates `Org.subscription` on global survives the next page. A
    `FiscalDevice.status` change on the master never reaches the mirror.
34. Remote work:
    - a product changed through the master's address is changed on the master, visible on the
      shop's tills at once, and on the mirror after replication;
    - with the master offline, the org at lgrai.app serves the mirror read-only, on lgrai.app's own
      origin, with its as-of time, and reports and exports work;
    - every write, and every read that writes, answers `org_home_elsewhere`;
    - the master's address shows only a notice, never a sign-in.
35. Cloud → master → cloud: invoice numbers issued on global, then on the master, then on global
    again form one gapless series. Every document, StockLevel and journal entry is identical before
    and after (digest).
36. A master restored from a 2-day-old backup cannot overwrite the mirror. Re-seeding from the mirror
    then holds:
    - the 2 days come back;
    - documents deleted since the backup stay deleted;
    - nothing on the mirror is deleted;
    - no number is issued twice.
37. A lost master promoted on global, then reconnected, fences itself and writes nothing more for the
    org. Its sales above the fence cutoff arrive on the home through the audited import, with their
    content and original times.
38. Tenant isolation: a node cannot replicate into, tunnel to or control an org it is not home for,
    even with a forged `orgId` (integration + e2e `security`).
39. **Org addresses** (FR-20.72, FR-20.78):
    - a cookie set by a master with `Domain=` never reaches the browser with that attribute;
    - a master's session cookie is `__Host-` prefixed;
    - global never issues a token, or sets a cookie, for an org address;
    - a cookie planted from an address's JavaScript with `Domain=lgrai.app` is ignored by
      lgrai.app; a request from an address's page that carries the person's lgrai.app cookie is
      treated as unauthenticated; and the OAuth sign-in on lgrai.app still works;
    - an anonymous API request to an address is answered 401 by global, without reaching the master;
    - an address is refused for a reserved label, for an org without an on-prem licence, and until a
      sys-admin approves it.
40. SUPTO:
    - a move shows the trader the Прил. 32 fields;
    - a release marked as a new SUPTO version is not installed by any master until it is marked
      declared.

**Coverage (all phases, §5.14):**

41. The two-node harness runs in CI on every PR that touches `packages/node`, `packages/migrations`,
    `packages/server` or the desktop shell. A chaos run (drop, delay and black-hole the link at
    random points) ends with the per-collection digests equal.
42. One command, `lgr-vmtest.sh run`, run from the dev box via mars, runs the supported FR-20
    matrix:
    - `shop-standalone` and `no-avx`;
    - `shop-linked`, at Control and at Full;
    - `shop-corp` and `shop-prod`;
    - in an announced window, `two-shops` and `restore-and-lost`.

    Every impossible cell is `NA` with its reason.
43. After every run:
    - no guest is left on any host, and global-eph is torn down;
    - `lgr-fieldtest` and `lgr-fieldtest-onprem` are at their node and desktop baselines;
    - production `/api/health` and `kubectl get nodes` stayed green throughout.
44. The orchestrator refuses a jupiter cell outside an announced window and says why. The run log
    shows every jupiter cell ran inside one.
45. No real customer data reaches a throwaway instance. The generator is the only data source, and
    a check scans every throwaway database for the ids and slugs of production orgs other than the
    field-test ones.
46. Each FR-20 check has fail-first evidence in the field log before the release gate accepts it.
    A confirmed regression files exactly one issue per condition, and the first green run closes it
    (the shape of FR-61's AC9).

**Added after the independent review (2026-10-19):**

47. **Ingress and control** (FR-20.16, FR-20.18):
    - `/internal/*` and `/api/setup/*` answer 404 through an org address and through the LAN
      ingress;
    - a client-supplied `X-LGR-*` header never reaches the API;
    - the API's loopback listener refuses a request without the front secret, or with a `Host` off
      its list;
    - setup without the one-time token is refused.
48. WebSockets (`/ws/fiscal-bridge`, `/ws/desktop`, `/ws/tasks`) work through the LAN ingress and
    through the tunnel.
49. **The restore lock** (FR-20.51):
    - **Restore with the WAN cut.** A master restored from a backup locks its legal series until
      they resume above the fiscal device's last receipt and a last invoice number entered by a
      person.
    - **Snapshot revert.** A VM snapshot reverted and then written to is detected by the hash chain
      when linked, and by the fiscal device for receipts. It locks the same way.
    - **Air-gapped restore.** An Air-gapped master restored from last night's backup cannot issue an
      invoice until a person enters the last issued number.
    - In every case, no number is issued twice.
50. **Clones.** Two VMs booted from one disk image are detected on the LAN, and by global through a
    second uplink. Both lock their legal series and raise an alarm.
51. **Promotion** (FR-20.81):
    - it is refused without the attestation, and before 24 h of silence unless the hardware is
      attested destroyed;
    - after it, global's legal series stay frozen until the site's last numbers are recorded;
    - a collision found by the audited import is resolved by a credit note and a re-issue, never by
      an edit.
52. **File isolation** (FR-20.66, FR-20.69):
    - a page naming a path with `..`, an absolute path, or another org's directory is refused;
    - mirrored files are stored and read by `(org, sha256)`;
    - `blob-want` never answers for another org's content.
53. Revoking a master stops its uplink within seconds, while its tills keep selling and its fiscal
    day close still works.
54. **The move** (FR-20.79–20.82):
    - with the WAN cut, every local credential set on lgrai.app before the move works on the master
      after it;
    - the desktops keep their ids, and `bridgeDesktopId` still names the till that holds the port;
    - the bridge prints without a re-registration;
    - a move back waits until every file has been transferred.
55. **Home records fail closed** (FR-20.3):
    - deleting an org's `org_homes` row on global puts the org in `hold`;
    - a global restored from a pre-move dump starts with that org in `hold`;
    - a master presenting a higher epoch makes global stop writing for the org;
    - no FR-20 state collection appears in any FR-13 bundle.
56. **The second guard** (FR-20.4):
    - on global, a service-level write to a mirrored org's document, outside the routes, is refused
      by the Mongoose plugin;
    - a `readOnly` route that tries to write throws in tests;
    - reports and exports work on a mirror.
57. **Idempotency survives a crash** (FR-20.37):
    - killing the API between the save and the print, then retrying, gives exactly one sale, one УНП
      and one receipt (the device's last receipt is consulted first);
    - a key reused with a different body answers 422.
58. No unverified clock reaches a fiscal device. With the OS clock 3 days wrong and NTP unreachable,
    the time sync pushes nothing and asks a person.
59. **The updater** (FR-20.20):
    - a failed update leaves the service running on the previous version, switched back from disk,
      with the WAN cut;
    - the helper refuses a package the service account staged, an offer older than the running
      version, and a package whose signature fails.
60. An expired licence, past its grace period, still allows reading, exports, the SUPTO export and
    the fiscal day close.
61. A master below `MASTER_MIN_VERSION` has replication and the tunnel refused by a control message,
    keeps receiving updates, and updates itself.
62. Setup refuses an off-site destination outside BG/EU. Drive is offered only with an attested EU
    data region.
63. **Files on a mirror:**
    - every file of a mirrored org opens from the mirror (read by content);
    - a metadata-only org moving back transfers every file first.
64. **People** (FR-20.41, FR-20.42):
    - an Air-gapped master's admin creates and edits people, and resets passwords, locally;
    - a linked master refuses person edits and points to lgrai.app.
65. **Local credentials** (FR-20.40):
    - they are refused through the tunnel;
    - a local password equal to the global one is refused when it is set;
    - repeated failures slow sign-in down, but never lock an operator out.
66. A master serves no third-party script and no analytics beacon. A crawl of every SPA on a master
    finds no external origin.
67. No script the package carries can modify an issued document. A static check runs over the
    allow-listed scripts.

## 11. Field test

**The scripted version is §5.14's matrix:** throwaway instances on mars, zeus and jupiter, built
from the signed artifacts. Every step below is one of its cells (plan Part F.5). **The manual
version runs at a regal shop,** with the real Eltrade A3. A simulator built from the protocol PDF
agrees with the document, which is not the same as agreeing with the hardware (FR-14.38, C19
trap 4).

**In the lab, before regal:**
1. Install LGR Server from the signed MSI on three VMs:
   - Windows 11, with no user signed in after the reboot;
   - Linux, with Compose;
   - a VM without AVX, which must be refused.
2. Pair two desktops, one by QR and one by typed address + fingerprint. Try a third from an unpaired
   machine on the same network; it must be refused.
3. Run Air-gapped for a full trading day with the WAN disconnected: POS with the Eltrade A3
   (non-fiscalised: non-fiscal text), invoices, a cash sale, a goods receipt, and the day close.
4. Pull a till's cable mid-sale and retry. Pull the master's power mid-day.
5. Link at Control behind a TLS-inspecting proxy configured by PAC. Sign in with LGR. Set PINs and
   local passwords on lgrai.app, and check that they reach the master. Change a password on
   lgrai.app and watch the master's session end.
6. Move the synthetic regal-shaped org (FR-20.112) cloud → master at Full, and trade on it:
   - pull the WAN for 2 h;
   - edit a product from outside, through the master's address;
   - reconnect and compare digests;
   - run `assign-din-tags` on the master through `lgr-server run-script`, and time the mirror's
     catch-up on a throttled 10 Mbit/s link.
7. Restore the master from a two-day-old backup. Its legal series lock, and its pages are refused,
   until it is re-seeded from the mirror; nothing is deleted from the mirror. Then move back to the
   cloud, and check that the invoice series is gapless across the three homes.

**At regal (regal-pz):** Part C.4 of the plan. The onboarding day; the move after closing; the first
trading day with a 30-minute WAN pull at a quiet hour; the master's power pulled on day 7; and the
daily reconciliation against PlusMinus as the go/no-go signal.

## 12. Open questions for goran

1. **Thin locals (D-3).** The request has a local *server* on each workstation. This FR makes locals
   thin, and covers the master-down case with a standby master and, if needed, an offline till that
   issues fiscal receipts only. Do you agree, or is there a case the thin local does not cover?
   - **Answer (2026-10-20): thin locals.** D-3 stands.
2. **Remote writes while the master is offline (D-5).** lgrai.app becomes read-only for an on-prem
   org while its master is unreachable. Is that acceptable for regal, with the owner and the
   accountant working from home? Invoices may be issued up to 5 days after the sale (ЗДДС 113(4)),
   so nothing legal forces a remote write during an outage.
   - **Answer (2026-10-20): read-only.** lgrai.app serves an on-prem org read-only while its master
     is unreachable (D-5, FR-20.75).
3. **Which regal orgs move, and where.** It is one master per shop LAN. Which orgs live at which
   site (`regal`, `regal-pz`, `regal-sf`)? And **are they one legal entity (ЕИК)?** If so, their
   invoices form **one** series, and each shop needs a disjoint range of it (ППЗДДС 78(4)). Separate
   LGR orgs, each counting from 1, would issue duplicates. That is true today, independent of
   FR-20.
   - **Answer (2026-10-20), as recommended:**
     - **regal-pz moves first, alone,** with a master at its own shop.
     - **regal-sf follows** with its own master, once regal-pz has run clean for a month.
     - **`regal` stays in the cloud** until its role is settled.
     - **Before regal-sf moves,** the legal-entity question is answered from the orgs' own invoices,
       and the two shops' invoice ranges are confirmed disjoint and recorded in each org's
       sequences. PlusMinus already numbers the two shops apart, which is how misfiled regal-sf
       documents have been told from regal-pz's.
4. **Pricing and licence.** Is on-prem a plan feature? What does an expired licence block: nothing,
   new documents, or everything except reading and the fiscal day close?
   - **Proposal (2026-10-20), awaiting confirmation:** FR-20.55. In short, on-prem is an
     Enterprise feature priced per user like the cloud. Expiry gives 30 days of grace, then stops
     new sessions and new documents at a day boundary, and never blocks closing the day, refunds,
     payments, exports or leaving.
5. **The accountant.** Confirm that a single allocator on the master is the only numbering change
   (no bands, D-7), and that the offline till's "receipts now, invoice from the master within 5 days"
   works for regal's customers.
   - **Answer (2026-10-20), as recommended:** the accountant confirms the single allocator in
     writing before the regal move, and the move's preflight checklist carries it (plan Part C.4.1).
     The offline till is P4 and does not affect the first move.
6. **macOS server packaging** needs Apple's *Developer ID Installer* certificate, for a `.pkg` with a
   LaunchDaemon. lgr holds five of roomler's six Apple secrets (FR-14.3). Add it, or defer the macOS
   server? Shops and companies here run Windows and Linux.
7. **The node domain (D-13).** Which name? Its Public Suffix List entry is part of the decision, and
   an entry takes weeks to be accepted, so it is submitted at the start of P2.
   - **Answer (2026-10-20): a subdomain of lgrai.app, named after the org,** for example
     `regal-pz.lgrai.app`. There is no separate domain and no Public Suffix List entry. D-13 and
     FR-20.72 record the hardening this needs on lgrai.app itself, and what it leaves.
8. **НАП.** Is LGR declared as a SUPTO yet, or when will it be? Masters hold undeclared SUPTO
   versions (FR-20.50), so the release cadence depends on it. Two questions for НАП, by a written
   query, before P4: is a replicated master + mirror topology acceptable as declared, and is a
   till-local database that imports later acceptable (FR-20.104)?
   - **Answer (2026-10-20), as recommended:**
     - the written query goes to НАП now, because answers are slow and asking costs nothing;
     - masters install declared SUPTO versions only (FR-20.50);
     - LGR's declaration is filed before any master prints a fiscal receipt, and until then regal's
       fiscal receipts stay with PlusMinus (Q10);
     - the offline till waits for НАП's answer.
9. **jupiter's windows, and the anchor master.** The three-host topologies (`two-shops`,
   `restore-and-lost`) need jupiter. It carries production storage, so they run only in an
   announced window (FR-20.113).
   - How often: per release, or weekly?
   - Should the anchor master for `lgr-fieldtest-onprem` (FR-20.108) stay up permanently on zeus,
     as roomler's anchor node does?
10. **The fiscal device during the parallel run.** Does PlusMinus also drive regal-pz's A3 while LGR
    does? If so, two systems allocate УНП on one device, which needs ranges declared in Прил. 32
    т. 23 (FR-20.45), or one system stays off the device until the cutover.
    - **Answer (2026-10-20), as recommended: one system on the device at a time.** During the
      parallel run, PlusMinus keeps the A3 and LGR's POS prints non-fiscal text, as it does today.
      At cutover LGR takes the device and PlusMinus stops printing fiscal receipts. No УНП ranges
      need declaring.
11. **Promotion evidence (FR-20.81).** Is 24 hours of silence plus an admin's attestation the right
    bar before a mirror may become home? A shorter wait gets a shop back to remote invoicing sooner,
    and raises the risk of two allocators.
    - **Answer (2026-10-20), as recommended:** 24 hours of silence plus the attestation, with the
      shortcut when the hardware is attested destroyed (FR-20.81, AC 51).
