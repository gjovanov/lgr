# FR-15 — Desktop registration: every LGR Desktop is a registered desktop of its org

**Goal:** every LGR Desktop installation is **registered as a desktop of one org**, whichever
mode it runs in. From then on the org can see and manage the machine: its name, OS, version,
presence, what it may sync, which warehouses and fiscal devices it serves. An admin can pause
it, update it or revoke it. The desktop gets a **credential of its own**, separate from any
user's session. The sync engine (FR-16), the native fiscal bridge (FR-14) and the Sync page
(FR-17) all authenticate the machine with it.

The model is roomler's device enrollment (`roomler-ai` →
`crates/modules/fleet/src/agent.rs`, `crates/agent-core/src/enrollment.rs`, Devices page). It
has admin-minted single-use tokens, ephemeral keys for throwaway machines, and "the row *is* the
revocation list". FR-15 keeps those and fixes the two weaknesses roomler documents for itself
(§1.3).

Status: draft for implementation · Date: 2026-09-28 · Tracking: [gjovanov/lgr#58](https://github.com/gjovanov/lgr/issues/58) (epic [#56](https://github.com/gjovanov/lgr/issues/56)) · Depends on: nothing (it is the foundation)
· Feeds: [FR-14](FR-14-lgr-desktop-app-server-mode.md), [FR-16](FR-16-local-mode-sync-engine.md),
[FR-17](FR-17-sync-page.md), [FR-18](FR-18-desktop-tests-field-automation.md).

Driving input: *"Each LGR desktop should be registered as device/desktop within the org."*
(goran, 2026-09-28; full request quoted in FR-16).

---

## 1. Current state (verified 2026-09-28, master @ `81b5fe5`)

### 1.1 LGR has no notion of a machine

- There is **no Device, Desktop, ApiKey or Session model**. The 60 Mongoose models are listed in
  `packages/db/src/models/index.ts`.
- `Code` (`code.model.ts`) supports exactly one type, `user_activation`.
- The desktop prototype identifies itself with a UUID in `_device_info`, set by a
  `setDeviceInfo()` that nothing calls (`packages/sync/src/change-tracker/change-log.ts:80-85`).
- The cloud never learns that the desktop exists.

### 1.2 The machine-shaped things that do exist

- **`Workstation`** (`workstation.model.ts`): `code` (unique per org), `name`, `warehouseId`
  (required), `fiscalDeviceId`, `isActive`/`deactivatedAt`. It is a SUPTO concept: a point of
  sale.
- **`FiscalDevice`** (`fiscal-device.model.ts`): `deviceNumber` (8 characters, unique per org),
  manufacturer, `connectionType ∈ serial|tcp|usb|browser`, `connectionParams`, `warehouseId`,
  `workstationId`, `status`.
- **The browser fiscal bridge** `/ws/fiscal-bridge` (`portal-api/src/websocket/fiscal-bridge.ts`)
  registers a bridge from `{deviceNumber, orgId}` alone. There is **no token check** on the
  socket (it is mounted at `unified.ts:103`). A valid registration **disconnects the existing
  bridge** for that device number. Bridges are also keyed by `deviceNumber` without the org, so
  two orgs holding the same number collide. FR-14.26 fixes this, because the native bridge rides
  on the credential defined here.
- **`/ws/tasks`** (`ws.server.ts:32-45`) accepts any `?userId=` in its query string and streams
  that user's task updates. It is the pattern this FR's sockets MUST NOT copy.

### 1.3 The roomler model, and the two things FR-15 does differently

| roomler (`roomler-ai`) | FR-15 |
|---|---|
| Admin mints an HS256 **enrollment JWT**, 10-min TTL, single-use `jti` (`fleet/agent.rs:50-79`) | Same shape: a short **enrollment code**, single use, 10 min (FR-15.5) |
| Reusable **ephemeral keys** with `max_uses`/`expires_at`, a per-use ledger, and a reaper (FR-51) | Same (FR-15.7). FR-18's vmtest lanes need them to throw machines away cleanly. |
| `machine_id` = SHA-256 of hostname + OS + arch + config path. No hardware id. | Same idea, plus an **installation id** (FR-15.3) |
| **No keypair.** The device credential is a **1-year bearer JWT** stored in `config.toml` | **An Ed25519 keypair.** The private key lives in the OS keystore; access tokens last 15 min and are minted by a signed assertion (FR-15.9–15.10). A copied config or profile database carries no credential. |
| `AuthAgent` re-reads the device row on every request: "the row IS the revocation list" | Same (FR-15.10) |
| Presence online / stale / offline over WebSocket plus a 30 s heartbeat | Same (FR-15.12) |
| Revocation = soft delete; **no pause or quarantine action** exists, though `Quarantined` is honoured | **Pause** (sync stops, the desktop stays registered) **and revoke**, both first-class (FR-15.16, 15.18) |
| Device JWT carried in the WebSocket **query string** (`/ws?token=…`) | Token in the **first message**, never in a URL (S-05) |

---

## 2. Naming: *desktop*, not *device*

The entity is called **`Desktop`**, in the model, the collection `desktops`, the APIs and the
UI. **Device** already means *fiscal device* all through the POS and fiscal code:

- `deviceId`, `deviceNumber`;
- `getFiscalContext()` returning `{ deviceId, … }`;
- `isDeviceConnected`;
- `POSSession.fiscalDeviceId`.

The two meet in the native fiscal bridge, where a desktop bridges a fiscal device. That is
exactly where an ambiguous `deviceId` would cost a debugging session. The UI says "Desktops"
and, where both appear, "fiscal devices".

---

## 3. Requirements

### 3.1 The registry

**FR-15.1 — Model `Desktop`** (collection `desktops`, `tenantPlugin`). Fields, grouped:

| Group | Fields |
|---|---|
| Identity | `name`, `nameAdminSet`, `code` (FR-15.4), `machineId`, `installationId`, `os {platform, version, arch}`, `hostname` |
| Credential | `publicKey` (Ed25519, base64), `keyEpoch`, `keyRotatedAt` |
| Lifecycle | `status: active \| paused \| revoked`, `ephemeral`, `ephemeralTtlSec`, `enrollKeyId`, `enrolledBy`, `enrolledAt`, `revokedAt`, `revokedBy`, `revokeReason`, `wipeRequested` |
| Reported | `appVersion`, `sidecarVersion`, `metaHash`, `capabilities {serverMode, localData, fiscalBridge, serialPorts[]}`, `mode: server \| local`, `lastSeenAt`, `lastPresence {ip, clockSkewMs}` |
| Assignment | `warehouseIds[]`, `workstationId?`, `fiscalDeviceIds[]` (bridged), `startPath?` (FR-14.19), `historyDays?` |
| Sync summary | `reconcileRequired`, `reconcileReason` (the full state lives in `sync_desktop_state`, FR-16) |

Indexes:
- unique `{orgId, code}`;
- unique `{orgId, installationId}`, with a partial filter `status: { $in: ['active', 'paused'] }`.
  A `partialFilterExpression` cannot use `$ne`;
- `{orgId, status}`;
- `{orgId, lastSeenAt}`.

**FR-15.2 — The registry is identity; sync state is separate.** Watermarks, pending counts and
run history live in the FR-16 `sync_*` collections, keyed by `desktopId`. The registry row stays
small and changes rarely. PCON+ splits its `spoke_registry` from `spoke_state` the same way.

**FR-15.3 — One row per installation per org.**
- The desktop generates an `installationId` (random, 128-bit) once per OS user profile. It keeps
  it outside any profile database, in **non-roaming** local storage (`%LOCALAPPDATA%` on Windows,
  FR-16.1). A roaming copy would give every PC the user logs into the same identity.
- `machineId` is SHA-256 of hostname + OS + arch. It is used for display and duplicate
  detection only, **never** as a credential.
- An installation MAY hold profiles for several orgs (an accountant serving several companies).
  Each profile is a separate registration and a separate row. P1 ships a single profile.

**FR-15.4 — A short code per desktop**, 2–4 characters from `[A-Z0-9]`, unique per org.
- It is proposed as `T1`, `T2`, … from a **per-org monotonic counter**, and an admin can edit it
  before first use.
- **A code is never reused, even after its row is gone.** Ephemeral rows are hard-deleted
  (FR-15.19). Reusing `T7` for the next VM would collide with every `SM-…-T7-…` number the first
  one issued, so used codes are kept as tombstones on `sync_orgs`.
- It is the infix of every internal document number the desktop issues offline
  (`SM-2026-T1-00012`, FR-16.47).
- It is **immutable once any document carries it.** The UI locks the field and says why.

### 3.2 Enrollment

**FR-15.5 — Single-use enrollment codes.** An admin clicks **Register a desktop** on the Sync
page (FR-17) and gets three things:
- a code: 8 Crockford-base32 characters shown as `XXXX-XXXX`, about 40 bits, single use,
  valid 10 minutes;
- a QR code / deep link `lgr://enroll?server=<origin>&code=<code>` (FR-14.14);
- the defaults the desktop will receive: name, warehouses and history window.

The code is stored **hashed** (SHA-256) in `desktop_enrollment_keys`. Exchange attempts are
rate-limited per IP and per code prefix. Everything together makes brute force pointless.

**FR-15.6 — Signed-in registration (SHOULD)**, using the OAuth device-authorization pattern
(RFC 8628):
1. The desktop starts `POST /api/desktop/v1/device-authorization` and shows a user code.
2. It opens `https://<server>/settings/sync/approve?code=<user code>`. The admin, already signed
   in, sees the machine's reported name, OS and IP, picks the defaults and approves.
3. The desktop, polling, receives its registration.

No token ever crosses from the webview into the shell. That preserves FR-14.16's rule that
remote pages get no IPC.

**FR-15.7 — Ephemeral enrollment keys**, gated by the org setting `ephemeralKeysEnabled`
(default off):
- A key is reusable, with `maxUses`, `expiresAt` and `revokedAt`, and every use is recorded in
  `desktop_enrollment_key_uses`.
- A desktop enrolled with one is `ephemeral`. It **unregisters itself on clean shutdown**
  (`DELETE /api/desktop/v1/self`).
- A **reaper** removes ephemeral rows not seen for `ephemeralTtlSec` (default 15 min). It leaves
  permanent rows alone.
- Turning the org setting off is class-wide revocation, re-checked on every use. This matches
  roomler FR-51.

FR-18's vmtest lanes depend on this, because every throwaway VM must leave the org at its
baseline.

**FR-15.8 — The exchange.** The desktop calls `POST /api/desktop/v1/enroll` with
`{code | ephemeralKey, installationId, machineId, name, os, hostname, appVersion, publicKey}`
and receives `{desktopId, orgId, orgSlug, orgName, code, assignment, serverTime}`.
- **Re-enrollment** of the same `installationId` into the same org revives its revoked row. It
  keeps the name (unless admin-set), the code and the assignment, rotates the key and increments
  `keyEpoch`.
- **A different installation always gets a new row.** A copied profile database therefore
  registers as a new desktop (FR-16.51).
- The response carries `serverTime`, so the desktop can measure its clock skew before it signs
  anything.

### 3.3 Credential

**FR-15.9 — The keypair.** The desktop generates an Ed25519 keypair at enrollment.
- **Where the private key lives:** only in the OS keystore:
  - Windows: Credential Manager / DPAPI;
  - macOS: Keychain;
  - Linux: Secret Service.

  It is accessed from the **Rust shell** (for example the `keyring` crate), and it never enters
  the profile database, the settings file or the Bun sidecar process.
- **Windows: non-roaming persistence only.** Credential Manager with
  `CRED_PERSIST_LOCAL_MACHINE`, or a DPAPI-protected file under `%LOCALAPPDATA%`.
  - The `keyring` crate's default Windows persistence (`CRED_PERSIST_ENTERPRISE`) **roams** with
    the user's profile. It would put one desktop key on every PC the user logs into, and defeat
    clone detection (FR-16.51).
- **When there is no keystore:** a headless Linux box without Secret Service falls back to a
  `0600` file in the user's config directory. The Overview shows this as a visible warning.
- **Rotation (SHOULD):** from the desktop's Settings or on admin request. It increments
  `keyEpoch` and invalidates outstanding access tokens.

**FR-15.10 — Access tokens by signed assertion.**
- **The exchange:** the shell calls `POST /api/desktop/v1/token` with a JWS (EdDSA) client
  assertion `{sub: desktopId, aud: <token endpoint URL>, iat, exp ≤ iat + 60 s, jti}`. It receives
  an access token valid for **15 minutes**, with claims `{desktopId, orgId, keyEpoch, aud:
  'lgr-desktop'}`.
- **Signing:** the access token is signed with a **new secret `DESKTOP_TOKEN_SECRET`**, required
  in production exactly like `JWT_SECRET` since S-02. A desktop token therefore can never be
  verified as a user token, and a user token never as a desktop token.
- **Replay:** a replayed `jti` within 5 minutes is refused.
- **Revocation:** every desktop-authenticated request **re-reads the desktop row**. A revoked row
  is refused at once, whatever the token's age.
- **Handing tokens on:** the shell passes access tokens to the sidecar over a local channel (the
  sidecar's stdin, or a loopback endpoint guarded by a per-launch secret). The sidecar never sees
  the private key.

**FR-15.11 — Desktop principals get their own auth plugin.** `/api/desktop/v1/*`, `/api/sync/v1/*`
and `/ws/desktop` are mounted with a **`DesktopAuth`** plugin. It is built exactly like the S-01
fix: an unconditional `onBeforeHandle` that is deny-by-default, never a macro.
- **Anonymous HTTP routes:** only `enroll`, `device-authorization` (start and poll) and `token`.
  They are listed in `public-routes.ts` with their reasons, the way that file requires: "public
  does not mean unprotected — the code or the assertion is the credential".
- **The `/ws/desktop` upgrade is allow-listed too.** A WebSocket upgrade request carries no
  token, and must not carry one in its URL (S-05), so an HTTP guard would 401 every socket. The
  credential is the first message instead. A socket that has not authenticated within 10 s is
  closed, and it receives nothing before that.
- **Everything else** is desktop-authenticated, including `/api/desktop/v1/latest-release`
  (FR-14.27).
- User tokens are refused on desktop routes, and desktop tokens on user routes.

### 3.4 Presence and reporting

**FR-15.12 — Presence.**
- **The socket:** `/ws/desktop` takes the access token in its **first message**. It carries the
  30 s heartbeat and FR-16's `sync:poke`. On token expiry the shell re-authenticates in-band.
- **Liveness:** `lastSeenAt` is updated by the heartbeat and by every sync request.
- **States:** **online** = a socket is registered; **stale** = seen within 90 s but no socket;
  **offline** = neither. This is roomler's rule.
- **Clock skew:** each heartbeat carries the desktop's wall clock. The hub records `clockSkewMs`,
  and the Sync page flags anything above ±2 min.

**FR-15.13 — Assignment**, admin-editable on the Sync page:
- `warehouseIds[]`, which drives FR-16 scope. An **unassigned desktop receives no
  warehouse-scoped data**. Changing the assignment triggers the desktop's **scope reconcile**
  (FR-16.26): a backfill of added warehouses, and a local eviction of removed ones. No document
  changed, so the journal alone would never tell it.
- `workstationId`, linking the machine to the SUPTO point of sale.
- `fiscalDeviceIds[]`, the fiscal devices this desktop may bridge (FR-14.24).
- `startPath`: where **Open LGR** lands, for example `/pos/` for a till.
- `historyDays`, which can tighten the org window but not widen it.

**FR-15.14 — Names.**
- The desktop proposes its name, defaulting to the hostname, and can change it.
- An admin rename sets `nameAdminSet`. From then on the desktop's own renames are ignored until
  an admin clears the flag. The same precedence applies across re-enrollment (roomler's rule).

**FR-15.15 — Reporting.** On startup, and on change, the desktop reports:
- `appVersion`, `sidecarVersion` and `metaHash`;
- OS details;
- capabilities: server mode, local data enabled, fiscal bridge, and the serial ports it sees;
- its current mode.

It does this with `PUT /api/desktop/v1/self`.

### 3.5 Lifecycle actions

**FR-15.16 — Pause and resume.**
- **Pause** stops sync for that desktop. Its sync requests answer **423**. It stays registered,
  keeps its data, and server mode keeps working. The state is persisted, so it survives restarts.
- **Resume** re-validates watermarks (FR-16.50).

**FR-15.17 — Update now / update all.** An admin action sends `desktop:update {version?}` over
`/ws/desktop`. The desktop's updater (FR-14.27) applies it **with every safety rule intact**. An
admin request never skips signature verification and never installs a downgrade.

**FR-15.18 — Revoke, with or without wipe.**
- **The dialog** shows the desktop's last-reported unpushed change count, and the age of its
  oldest unpushed sale (FR-16.65), before it asks for confirmation.
- **On confirm:** `status: revoked`. The next request is refused `401 {code:'desktop_revoked'}`,
  and the socket is closed with a reason. The desktop:
  1. shows *"This desktop was removed from <org>"*;
  2. stops sync;
  3. disables local mode;
  4. either keeps the profile **read-only** and offers to **export** its unpushed changes to a
     file, or, **with wipe**, deletes the profile database, archives and keystore entries without
     exporting anything. A stolen laptop must not get an export.
- **A desktop that never comes back online** never learns of the wipe. The dialog says so.

**FR-15.19 — Revoked rows stay.** They are kept for the audit trail and for FR-16's origin
records. They are hidden from the default list, and MAY be purged after 1 year. Ephemeral rows
are deleted outright by self-unregistration or by the reaper.

### 3.6 Permissions, audit, tenancy

**FR-15.20 — Gate everything on `admin.settings`.**
- Registering, assigning, pausing, updating and revoking desktops are all gated on the existing
  permission. `admin` holds it; `manager` holds no `admin.*` permission. This is the same gate as
  the Files app (`config/constants.ts:115-118`).
- **Deliberately no new permission.** A new one needs a model change, a `PermissionSet` backfill
  and a **re-login** before it takes effect, which is the FR-06 P2 ordering hazard that FR-13.26
  also avoided.
- A read-only view of desktops for `admin.audit` holders MAY follow.

**FR-15.21 — Every registry action writes an `AuditLog` entry:** code minted, key created or
revoked, enroll, rename, assignment change, pause/resume, update request, key rotation, revoke,
wipe and reap. The entry uses module `admin` and entity type `desktop`, with the actor, and the
IP where there is one.

**FR-15.22 — Tenant isolation.**
- Every `/api/org/:orgId/desktops*` route runs behind `AuthService`'s `isForeignOrg` guard.
- Every desktop-principal route takes the org **from the desktop row**.
- `tenant-isolation.flow.test.ts` and the e2e `security` project gain cases proving that an admin
  of org A cannot list, mint for, approve or revoke desktops of org B, and that a desktop of org A
  cannot touch org B.

### 3.7 API

**FR-15.23 — Admin endpoints** (user-authenticated, `admin.settings`):

```
GET    /api/org/:orgId/desktops                      list: presence, versions, sync summary; paging, search
GET    /api/org/:orgId/desktops/:id
PUT    /api/org/:orgId/desktops/:id                  name, code (until first use), assignment, historyDays, startPath
POST   /api/org/:orgId/desktops/:id/pause | resume | reconcile | update | rotate-key
POST   /api/org/:orgId/desktops/:id/revoke           { wipe: boolean, reason }
POST   /api/org/:orgId/desktops/enrollment-codes     → { id, code, expiresAt, deepLink }
GET    /api/org/:orgId/desktops/enrollment-codes/:id state (unused / used by <desktop> / expired) — the FR-17.6 dialog polls it
GET    /api/org/:orgId/desktops/device-authorizations/:userCode        what the machine reported (FR-17.7)
POST   /api/org/:orgId/desktops/device-authorizations/:userCode/deny
GET    /api/org/:orgId/desktops/enrollment-keys      ephemeral keys
POST   /api/org/:orgId/desktops/enrollment-keys      { maxUses, expiresAt, defaults }
DELETE /api/org/:orgId/desktops/enrollment-keys/:id
GET    /api/org/:orgId/desktops/enrollment-keys/:id/uses
POST   /api/org/:orgId/desktops/device-authorizations/:userCode/approve
```

**FR-15.24 — Desktop endpoints** (`DesktopAuth`):

```
POST   /api/desktop/v1/enroll                        anonymous — the code/key is the credential
POST   /api/desktop/v1/device-authorization          anonymous — start; returns user code + poll handle
POST   /api/desktop/v1/device-authorization/poll     anonymous — the poll handle is the credential
POST   /api/desktop/v1/token                         anonymous — the signed assertion is the credential
PUT    /api/desktop/v1/self                          report versions / capabilities / mode
DELETE /api/desktop/v1/self                          ephemeral self-unregister
POST   /api/desktop/v1/user-verify                   FR-16.13
WS     /ws/desktop                                   presence + poke + update requests
```

**FR-15.25 — Org-level desktop policy** is stored in `sync_orgs` (FR-16), **not** in
`Org.settings`. The reason: `PUT /org/:orgId` replaces the whole `settings` subdocument and
strips keys it does not know (FR-11, FR-13.55), so a setting kept there would vanish on the next
unrelated save. The policy covers:
- `ephemeralKeysEnabled`;
- `defaultHistoryDays`;
- `minDesktopVersion` (override);
- default band size;
- whether unassigned desktops may register at all.

**FR-15.26 — Plan limits MAY cap desktops per subscription plan.** If they do, the cap is checked
on **new** rows only, so a re-enrollment is never refused, and the refusal names the plan.
`PLAN_APP_LIMITS` is dead config today; this FR does not revive it.

---

## 4. Edge cases and traps

1. **"Device" means fiscal device** everywhere it already appears (§2). A PR that names the new
   model `Device` makes the native-bridge code unreadable.
2. **A bearer credential in a config file is a credential on every backup of that file.** This is
   roomler's 1-year agent JWT. The keypair in the OS keystore is the whole point of FR-15.9.
3. **Never put a token in a URL.** Not in the socket (S-05), and not in the deep link: the
   enrollment code in `lgr://enroll` is single-use and expires in 10 minutes, which is exactly
   why it may travel there.
4. **`/ws/fiscal-bridge` and `/ws/tasks` authenticate nothing** (§1.2). New sockets are
   authenticated by token-in-first-message, closing after 10 s without it.
5. **A cloned Win11 guest boots about 3 h ahead of UTC** (roomler FR-61 trap). A 60-second
   assertion signed on a skewed clock is refused. The desktop uses `serverTime` from enrollment
   and from each token response to correct its `iat`, and reports the skew.
6. **Ephemeral rows and the reaper.** A desktop that SIGTERMs itself while a test still needs its
   row unregisters itself; roomler's vmtest learned this the hard way. The FR-18 lanes stop the
   service once, enroll, and start it once.
7. **`isSignIn` does not protect a route; the unconditional guard does** (S-01). Desktop routes
   are safe because `DesktopAuth` is built the same way, not because a flag is set.
8. **Revoking a desktop does not un-issue its numbers.** Its bands are retired, and their unused
   tail is reported on the band's row (FR-16.43).
9. **The code is immutable once used** (FR-15.4). Renaming `T1` after it appears in
   `SM-2026-T1-…` would orphan every "latest number" parser's assumptions.

---

## 5. Integration constraints

- **`public-routes.ts` gains exactly these entries,** each with its reason in the header block:
  - the four anonymous desktop HTTP routes and the `/ws/desktop` upgrade (FR-15.11);
  - FR-14's `/api/auth/desktop-code/redeem`.

  The S-01 "measured against the real route table" test MUST include them and nothing else.
- `unified.ts` mounts `desktopController` (admin), `desktopAuthController` (desktop principal)
  and the `/ws/desktop` socket beside the existing ones.
- The Sync page lives in `portal-ui` at `settings/sync` (FR-17), gated server-side. Portal routes
  have no client-side guard, so the server check is the whole control (FR-13 trap 20).
- i18n keys ×4 (en/bg/de/mk) for every new string. A missing key renders literally.

---

## 6. Acceptance criteria

1. An admin mints a code, a fresh desktop enrolls with it, and the row appears **online** within
   one heartbeat. The code cannot be used twice or after 10 minutes.
2. A desktop enrolled with an ephemeral key disappears after a clean shutdown. After a `kill -9`
   it disappears when the reaper runs (TTL). Permanent rows are untouched in both cases.
3. The private key is in the OS keystore on all three platforms. Neither the profile database nor
   any config file contains it: grep for the key bytes.
4. Copying a profile database to another machine yields **no** working credential. That machine
   must enroll and gets a new row.
5. A revoked desktop's next request is refused within one heartbeat, whatever the age of its
   access token.
6. A desktop access token is rejected by every user route, and a user JWT is rejected by every
   desktop route.
7. Pause yields 423 on sync with server mode unaffected. Resume re-validates.
8. Revoke with wipe removes the profile database, archives and keystore entries on the next
   contact. Revoke without wipe leaves a read-only profile with an export action.
9. Admin rename wins over desktop rename until cleared, across re-enrollment.
10. Presence shows online / stale / offline correctly across a socket drop and a machine
    shutdown. Clock skew beyond ±2 min is flagged.
11. Cross-org cases (FR-15.22) pass in both `tenant-isolation.flow.test.ts` and the e2e
    `security` project.
12. Every lifecycle action appears in the audit log with actor and desktop.
13. `bun run test` + `bun run build` green. No test mints a real enrollment against production.
