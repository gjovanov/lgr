# FR-13 (issue gjovanov/lgr#24) — status audit and implementation plan

Audited 2026-09-04 against `lgr@2a7026b` (master, PR #29 merged 11:06 UTC today) and
`lgr-deploy@8c22cc3` (master). Spec: `lgr/docs/fr/FR-13-backup-archive.md`.

## Context

Issue #24 specifies backups for LGR in five phases (the collaborator's plan comment of
2026-09-03). Phases 1 and 2 are merged. Nothing off-site exists yet, the cron is not
installed, and the audit below found real defects in what shipped, two of them security
relevant. This document records what is done, what is wrong, and the order of work to
finish the issue, so it can be picked up in a fresh session.

---

## Part A — What is completed

### Phase 1 — Layer 1 infra DR (`lgr-deploy`, PRs #1–#3) — MERGED, mostly correct

| FR | Status | Where |
|---|---|---|
| 13.1 scripts | done (5 scripts + `scripts/lib/backup-common.sh`) | `scripts/backup-mongodb.sh`, `backup-mongodb-delta.sh`, `backup-uploads.sh`, `backup-offsite.sh`, `verify-backups.sh` |
| 13.2 `--oplog --archive \| zstd -19` | done | `backup-mongodb.sh:72-79` |
| 13.3 uploads `rsync --link-dest`, fail loudly | done in code, **never run successfully** | `backup-uploads.sh:65-114` |
| 13.4 sanity gates (1 MiB floor, `zstd -t`, shrink) | done | `lib/backup-common.sh:58`, `backup-mongodb.sh:83-97` |
| 13.5 verify by real restore | done, deviations (see A-bugs) | `verify-backups.sh:211-259` |
| 13.6 publish result for the digest | done, **publish path will fail in prod** | `verify-backups.sh:300-312` |
| 13.7 schedule | done, 02:30/03:15/04:30 + hourly 07-20 match; yearly tier is a hard-link, no `xz -9e`/encrypt | `crontab.lgr` |
| 13.8 GFS by generations kept | done (one off-by-one in uploads tiers) | `lib/backup-common.sh:112-134` |
| 13.9 oplog delta + window guard + escalation | done (one HIGH bug) | `backup-mongodb-delta.sh` |
| 13.22 runbook | partial: 3 of 5 scenarios, rehearsal rows `_pending_` | `docs/BACKUP-RUNBOOK.md` |
| 13.23 encrypt off-site (`age`) | mechanism only; no key, no remote, nothing has left mars | `backup-offsite.sh` |

### Phase 2 — Layer 2 per-org bundles (`lgr`, PRs #28, #29) — MERGED, works, has holes

| FR | Status | Where |
|---|---|---|
| 13.6 digest Backups section | done, opt-in per org (default off) | `services/src/biz/backup/backup-status.service.ts`, `digest/daily-digest.render.ts:367-429` |
| 13.10 scheduler, `checkIntervalMs=0` disables, `.env.test`=0 | done | `portal-api/src/unified.ts:391-400`, `.env.test:35-36` |
| 13.11 `BackupRun` unique `{orgId,kind,date}` lock | done (`coversFrom` never written) | `db/src/models/backup-run.model.ts:93`, `backup-runner.service.ts:59-79` |
| 13.12 self-verifying bundle + manifest | done (`schemaVersion` == format constant, so no real version compare) | `backup-bundle.service.ts:140-182, 268-334` |
| 13.13 zstd 19/3 | done | `backup-bundle.service.ts:77-86` |
| 13.14 path `<UPLOAD_DIR>/<orgId>/backups/` | done | `backup-bundle.service.ts:97` |
| 13.15 five routes, explicit 401 | done, **no org-membership check** | `portal-api/src/controllers/backup.controller.ts` |
| 13.16–13.19 email manifest/attachment/ceiling | done (ceiling computed as 15 MiB, correct) | `backup-runner.service.ts:34, 230-251` |
| 13.24 not served statically | done | `unified.ts:289-303` |
| 13.25 AuditLog | partial: download yes; create only for manual runs; no destinations | `backup-runner.service.ts:181-186` |
| retention per org | done (`keepPerOrg`, generations) | `backup-bundle.service.ts:218-250` |
| UI | **none** — no screen consumes `GET /backup/runs` | — |

Tests: 19 in `packages/tests/src/integration/backup-bundle.flow.test.ts`, digest contract test
in `digest-backups.flow.test.ts` with fixture `fixtures/backup-verify-report.json`. No HTTP-level
test for the controller. `bun run test` (full) has never completed on Windows (Bun `.rejects`
deadlock) — needs a Linux run.

In production: one hand-taken full backup on mars (3.3 MB, 18 s). That is the only second copy.

---

## Part B — Defects found in the merged work (fix before building on it)

### B1. Security / correctness in `lgr` (Layer 2)

1. **Cross-tenant export.** No backup route compares `params.orgId` to `user.orgId`.
   `tenantPlugin` pre-hooks are no-ops (`db/src/plugins/tenant.plugin.ts:14-24`), and
   `buildBundle` filters on the route orgId. Any org's `admin` can run and download another
   org's whole database including `User.password` hashes. No controller in portal-api does
   this check today (systemic), but this is the worst blast radius. `backup.controller.ts:41-151`.
2. **Path traversal via `body.date`.** `POST /run` takes a free-form `date` string; it lands in
   the filename at `backup-bundle.service.ts:186` and is persisted to `BackupRun.filename`,
   which `/download` later streams. `backup.controller.ts:49, 64-68`.
3. **Failure becomes silence.** A failed run sets `completedAt`; `backupTick` skips orgs with a
   truthy `completedAt`, and stale takeover only matches `completedAt:null`. A 03:00 failure is
   never retried that day and appears nowhere (digest reads only Layer-1 `verify.json`).
   `backup-runner.service.ts:195-197, 279-285`.
4. **`force` defaults to true** and upserts over an in-flight claim, so a manual run (or
   `POST /test-email`) concurrent with the nightly run writes the same file from two builders.
   `backup.controller.ts:53, 145`, `backup-runner.service.ts:117-125`.
5. **Unencrypted bundle attached to email** (SendGrid is outside the cluster) carrying bcrypt
   hashes and contact tax IDs. Violates FR-13.23. `backup-runner.service.ts:243-247`.
6. Minor: `/:id/verify` and `/:id/download` cast errors → 500 on non-ObjectId; `coversFrom`
   unset; `schemaVersion` meaningless; pruning matches kind by substring; scheduled runs write
   no AuditLog; `org.model.ts:212` references a runbook path that lives in the other repo.
7. Tests that don't assert their title: `backup-bundle.flow.test.ts:113` (never checks org B
   data is absent), `:167` (never tampers a manifest), `:225` (passes an Org id as user id,
   never asserts AuditLog), `:358` (title says 14.6 MiB, value is 15 MiB).

### B2. Bugs in `lgr-deploy` (Layer 1)

1. **HIGH — status publish uses `root@10.10.10.12`** (`.env.example:70`, runbook `:68`), the
   login PR #3 proved is disabled. `verify-backups.sh:300-304` has no `UPLOADS_SSH_USER` /
   `sudo rsync` equivalent. Verify will pass and never publish; the digest shows "verification
   stopped". Also the failure is counted after `write_status`, so `verify.json` says ok.
2. **HIGH — `--no-escalate` advances the checkpoint without taking a full.**
   `backup-mongodb-delta.sh:55-63` writes `write_checkpoint "$HI"` even when the full was
   skipped, so the chain claims coverage that does not exist.
3. MEDIUM — first full does not seed `mongodb/delta/checkpoint.json` (runbook `:73` says it
   does); first delta escalates to a redundant full. `backup-mongodb.sh:107-121`.
4. MEDIUM — restore-verify starts `mongo:7` without `--replSet` then runs `--oplogReplay`
   (`verify-backups.sh:225-232`); the spec's own reproduction used `--replSet`. Readiness loop
   falls through silently at 60 s. If `mongosh` returns empty, `jq --argjson` aborts and no
   status is written at all (no EXIT trap in this script).
5. MEDIUM — uploads GFS keeps one generation fewer: `promote` without a glob makes
   `find -name '*'` include the tier directory itself. `backup-uploads.sh:119-121`,
   `lib/backup-common.sh:120, 160`.
6. MEDIUM — `backup-uploads.sh` auth: default `UPLOADS_SSH_USER` is still `root`
   (`:40`); passwordless sudo for `gjovanov` and the key in its `authorized_keys` are unverified.
7. LOW — `crontab.lgr` sets no `PATH`/`MAILTO` (rclone/age/zstd in `/usr/local/bin` will
   `require_cmd`-die silently); `.env.example:84` `UPLOADS_RSYNC_PATH=sudo rsync` unquoted
   aborts every script if uncommented; verify's delta-RPO check only runs 08–20 but cron runs
   it at 04:30 (dead check, and `${HOUR#0}` is empty at 00); bare non-dash args still ignored;
   `backup-offsite.sh` never ships uploads and `rclone sync` mirrors deletions (needs bucket
   versioning + Object Lock); yearly tier is not `xz -9e`/encrypted.

---

## Part C — What is left

**Ops, not code (closes the actual 3-2-1 gap):** age key generated off mars, B2/R2 bucket with
versioning + Object Lock, rclone remote, `.env` on mars, cron install, first uploads run,
timed restore rehearsal, enable digest Backups section for regal-pz, run `cleanup-e2e-data.sh`
with a manual dump first. Every one of these is still pending (runbook §3, §7).

**Phases not started:** 3 (Google Drive, FR-13.48–59), 4 (sys-admin restore screen,
FR-13.26–37), 5 (archiving, FR-13.38–47). Also FR-13.21 point-in-time restore is documented but
unrehearsed, and FR-13.22's mass-delete and PV-corruption scenarios are missing from the runbook.

---

## Part D — Implementation plan (recommended order)

Ordering rationale: harden what is merged first (it is the foundation Phases 3–4 upload and
restore), then the no-code ops steps that give LGR an off-site copy, then Drive, then the
restore screen (largest, sharpest), then archiving (no pressure until year 7; pull `EmailLog`
retention forward). Each step is its own PR/branch (`LGR-09`, `LGR-10`, …).

### Progress

| step | state | where |
|---|---|---|
| 0 — this plan in the repo | **done** | `docs/fr/FR-13-IMPLEMENTATION-PLAN.md` |
| 1 — `lgr` hardening | **done**, committed | `lgr` branch `LGR-09`, commit `3593524` |
| 2 — `lgr-deploy` hardening | **done**, committed | `lgr-deploy` branch `LGR-09`, commit `3256452` |
| 3 — ops rollout on mars | not started, **needs the operator** | — |
| 4 — Google Drive | **done**, committed | `lgr` `LGR-10` `4f71430` · `lgr-deploy` `LGR-10` `8a3782d` |
| 4b — consolidation (full + N deltas → full) | **done**, committed | `lgr-deploy` `LGR-10` `f32cea9` |
| 5 — sys-admin restore screen | **done**, committed | `lgr` branch `LGR-11` |
| 6 — archiving | not started | — |

Steps 1 and 2 are complete and verified as described in their own sections below. Neither
branch is pushed and no PR is open.

**Verification actually run for Steps 1–2**

- `lgr`: 125 tests, 0 failures, across the six suites touching backups, the digest, reports
  and invoice export. All 8 UIs build. The full `bun run test` still hangs on Windows (the
  known Bun `.rejects` deadlock, unrelated) — **it still needs one Linux run before merge**.
- `lgr-deploy`: `bash -n` clean on all 15 scripts; new `scripts/test-backup-lib.sh` passes
  11/11. Both the tenant-isolation defect and the retention off-by-one were proven by
  deliberately reverting the fix and watching the new test fail.
- ⚠ **shellcheck has not run** — not installed locally and the Docker daemon was down. Run it
  on mars before installing the cron.

### Step 1 — Hardening PR for `lgr` (Phase 2.5, branch `LGR-09`) — DONE

Files: `packages/portal-api/src/controllers/backup.controller.ts`,
`packages/services/src/biz/backup/backup-runner.service.ts`, `backup-bundle.service.ts`,
`packages/tests/src/integration/backup-bundle.flow.test.ts`, new
`packages/tests/src/integration/backup-routes.flow.test.ts`.

1. Add a shared guard at the top of every backup route:
   `if (String(user.orgId) !== orgId) return status(403)`. Put it in one helper
   (`requireOrgAdmin(user, orgId, status)`) in the controller so Phase 4 reuses it.
2. Validate `date` with `t.RegExp(/^\d{4}-\d{2}-\d{2}$/)` in the body schema, and in
   `buildBundle` assert the resolved path stays under `bundleDir(orgId)` (resolve + prefix check).
   Validate `:id` as ObjectId → 404 otherwise.
3. `force` defaults to **false**; document that `force:true` is explicit. `POST /test-email`
   must not rebuild/overwrite today's run: read the latest completed run and mail its manifest.
4. Retry semantics: on failure keep `completedAt:null`, set `status:'failed'`, `attempts++`, and
   let `claimDay` take over after `STALE_CLAIM_MS`; cap at 3 attempts/day.
5. Make Layer-2 outcomes visible: extend the digest Backups section with the org's own last
   `BackupRun` (status, size, sha, email skipped-reason). Reuse `backup-status.service.ts` shape.
6. Stop attaching plaintext bundles to email unless `config.backup.emailAttachBundle=true`
   (default false); always mail the manifest. Note in `.env.example` that attachment is
   unencrypted. (Encryption at Layer 2 is deferred to Phase 3 where `age`/AES wrapping is
   added for Drive uploads; both paths then share it.)
7. Write `coversFrom`; write an AuditLog for scheduled runs (`userId: null`, action `backup`).
8. Fix the four mis-titled tests; add HTTP tests for 401/403/cross-org 403/410-after-prune/
   invalid date.

Verification: `bun run test` on Linux (or `bun test --env-file=.env.test <file>` per file on
Windows), `bun run build`.

### Step 2 — Hardening PR for `lgr-deploy` (branch `LGR-09`) — DONE

Files: `scripts/backup-mongodb-delta.sh`, `backup-mongodb.sh`, `verify-backups.sh`,
`backup-uploads.sh`, `lib/backup-common.sh`, `crontab.lgr`, `.env.example`,
`docs/BACKUP-RUNBOOK.md`.

1. `escalate()`: only write the checkpoint when the full actually ran; on `--no-escalate`
   write status `blocked` and exit 1.
2. `backup-mongodb.sh`: after a successful full, write `delta/checkpoint.json` from the
   recorded `oplogHighWater` (seeds the chain, matches the runbook).
3. `verify-backups.sh`: publish with the same `UPLOADS_SSH_USER` + `--rsync-path="sudo rsync"`
   logic as `backup-uploads.sh` (factor into `lib/backup-common.sh` as `remote_rsync`); move
   the publish attempt before `write_status` so the file reflects it; start the throwaway
   mongo with `--replSet rt` + `rs.initiate()` like Appendix A; make the readiness loop fail
   loudly; guard `GOT` empty; install the EXIT status trap; run the delta-RPO check based on
   the newest slice's age relative to the last trading hour rather than the current hour.
4. `promote` in `lib/backup-common.sh`: use `-mindepth 1` in `prune_generations`.
5. `crontab.lgr`: add `PATH=/usr/local/bin:/usr/bin:/bin` and `MAILTO`; fix the "five lines"
   comment. `.env.example`: quote `UPLOADS_RSYNC_PATH`, default `UPLOADS_SSH_USER=gjovanov`,
   replace `root@` in `BACKUP_STATUS_PUBLISH_PATH`. Reject bare non-dash args.
6. `backup-offsite.sh`: include `uploads/latest` (as a `tar --zstd | age` of the snapshot,
   daily) so tier 3 covers files; add a lock (`flock`) shared with the delta job.
7. Runbook: add mass-delete and PV-corruption scenarios; add a checklist for bucket
   versioning + Object Lock.

Verification: `bash -n` + `shellcheck` locally; `--dry-run` of each script on mars; the four
deliberate-break tests from AC 6 recorded in the runbook.

### Step 3 — Ops rollout on mars (no code; needs the operator) — NEXT

⚠ Step 2 added two prerequisites that were previously assumed rather than checked, and both
belong at the front of this sequence: prove SSH to `k8s-worker-2` works **as `gjovanov` with
passwordless sudo** (its absence is what blocked the uploads backup on its first real run),
and set `MAILTO` in `scripts/crontab.lgr`. The runbook's §3 now lists them in order.


Order: `age-keygen` on a laptop, public key into `.env`, private key into the password
manager → create B2/R2 bucket with versioning + Object Lock, `rclone config` → `.env` on mars
→ `mkdir backup/{log,status}` → dry runs → first real full + uploads run (proves B2.6) →
`verify-backups.sh --restore`, timed, recorded in runbook §7 → install `crontab.lgr` →
`configure-daily-digest.ts --org regal-pz --backups on --execute` → next morning confirm the
digest shows the section → manual dump, then `cleanup-e2e-data.sh` against prod. After this,
AC 1–8 can be ticked on the issue.

### Step 4 — Phase 3: Google Drive (both layers, branch `LGR-10`, FR-13.48–59) — DONE

Shipped in three commits. Drive is the tier-3 destination in **both** layers, per the
decisions taken on the issue: rclone remote on mars for Layer 1, refresh token in `lgr-secret`
for Layer 2, Drive first and object storage later.

**Layer 1 — `lgr-deploy` `8a3782d`.** New `backup-drive.sh` uploads what `backup-offsite.sh`
stages: the same age-encrypted artifacts, each already carrying its type and timestamp in the
name, into `LGR/mongodb/{daily,weekly,monthly,yearly,delta}/`. `rclone copy`, never
`sync` — sync mirrors mars's deletions and Drive has no Object Lock underneath (FR-13.58).
Quota pre-flight via `rclone about`; uploads rotation off by default (FR-13.57). Weekly
round-trip download + re-hash, with its own status file so an hourly job that verifies weekly
does not report "never verified" six days out of seven. The staging loop moved into
`lib/backup-common.sh` because both jobs ship the same bytes. `verify-backups.sh` gains
`drive` and `drive.verify`. 18/18 in `test-backup-lib.sh`; the remote-retention rule was
proven by reversing the sort on purpose (it then deletes the newest generation).

**Layer 2 — `lgr` `4f71430`.** `cloud-storage.service.ts` is a real adapter on plain `fetch`
(no `googleapis`), scope `drive.file`, resumable-only uploads that THROW on a partial rather
than returning what they wrote. New `backup-crypto.ts` seals with X25519 → HKDF-SHA256 →
AES-256-GCM — asymmetric so the cluster can seal and cannot open, with the private half off
the cluster; no recipient configured means no upload, never plaintext. New
`backup-destinations.service.ts` sequences seal → quota → upload → read-back → prune.
`BackupRun.destinations[]` records failures too, and the FR-11 digest renders a completed
bundle that reached nowhere as a failure banner that takes the day off "all clear".
`integrations.controller.ts` writes the connection through its own endpoint because
`PUT /org/:orgId` drops `integrations` (FR-13.55). Operator scripts `backup-crypto.ts` and
`google-drive-consent.ts`. New `unit/backup-drive.test.ts` 29/29 with `fetch` stubbed;
`backup-bundle.flow` + `backup-routes.flow` 42/42 unmodified.

⚠ **Still needs the operator, and nothing above is a copy until they run it:** create the
dedicated Google account, `rclone config` on mars, `bun scripts/backup-crypto.ts keygen` OFF
the cluster, seal `BACKUP_ENCRYPTION_PUBLIC_KEY` + `BACKUP_GOOGLE_DRIVE_REFRESH_TOKEN` into
`lgr-secret`, install the cron.

### Step 4b — Consolidation: full + N deltas → a new full (`lgr-deploy` `f32cea9`, FR-13.21)

Not in the original plan; added on request. `backup-consolidate.sh` replays a base full plus
every slice after it into a throwaway `mongo:7` replica set and dumps the result back out as
an ordinary full — "Sunday's full plus everything since it" becomes Wednesday's full, shipped
off-site by the existing jobs with no special handling. It is also the restore rehearsal
FR-13.22 asks for, run weekly by cron instead of by a human, and `verify-backups.sh` now fails
when nothing has proven the chain for eight days. It does **not** replace the nightly full:
the nightly is what keeps the chain short enough for this to take a minute.

### Step 4 (original plan, for reference)

Decisions already taken on the issue: refresh token in `lgr-secret`, not the Org document;
Drive carries the `data` GFS chain, object storage keeps the yearly tier.

Files: `packages/services/src/biz/cloud-storage.service.ts` (extend interface with
`uploadFile`, `deleteFile`, `ensureFolder`, `getQuota`; Dropbox/OneDrive throw
`not_implemented`), new `packages/services/src/biz/backup/backup-destinations.service.ts`,
`packages/config/src/index.ts` (`config.backup.googleDrive.{refreshToken,folderName}`,
`config.backup.encryptionRecipient`), `backup-runner.service.ts` (after verify: encrypt →
upload → record `destinations[]` on `BackupRun`), `backup-run.model.ts` (`destinations`),
`backup-status`/digest render (Drive reached / re-consent required), new
`packages/portal-api/src/controllers/integrations.controller.ts` (
`GET /org/:orgId/integration/google-drive/auth-url`, `POST …/callback` — the configmap already
sets `GOOGLE_REDIRECT_URI` to exactly this path; sys-admin gated once Step 5 lands, admin+org
gated until then; callback prints the refresh token once for the operator to seal), one-off
`scripts/google-drive-consent.ts` as the alternative to the web callback.

Implementation notes: raw `fetch` like `email.service.ts:119-146`; scope `drive.file`;
resumable upload only (`uploadType=resumable`, resume via `Content-Range: bytes */total`);
refresh token → access token at the start of every run, distinguish `invalid_grant` (re-consent)
from transport errors, never count a partial upload; `about.get?fields=storageQuota` pre-flight;
`appProperties` carry `sha256`, `coversFrom/To`, `orgSlug`, `kind`; retention via
`listFiles`+`deleteFile` by generations; weekly verification downloads the newest artifact and
re-hashes (add a `verifyRemote` step to the Sunday tick). Encryption: wrap the bundle with
`age`-compatible or AES-256-GCM using the public recipient in config, key held off-cluster;
reuse for the email attachment from Step 1.6.

Tests: mock `fetch` for token refresh, resumable session, 5 MB+ chunks, quota refusal, revoked
consent; assert `destinations` never records a partial upload.

### Step 5 — Phase 4: sys-admin manual backup + restore-from-file (`lgr`, `LGR-11`, FR-13.26–37) — DONE

Shipped broadly as planned below. Four things the implementation found that the plan did not,
each of which changed the design rather than the wording:

- **⚠ Preserving `_id` on a remap is wrong in this deployment, and it fails SILENTLY.** The
  plan (and FR-13.32's "rewrite `orgId` and cross-references by an `_id` map") could be read as
  optional bookkeeping — keep the ids and every reference stays valid by construction. That
  holds only where the bundle's rows are landing in a database that does not already contain
  them, and LGR is single-database multi-tenant: org A's `contacts` and org B's are the SAME
  physical collection. A remap that kept `_id` collided with the origin's live rows on the
  `_id` index, inside an unordered bulk insert, surfacing as `insertedCount: 0` and nothing
  else. New ids are minted for the whole bundle first, and every reference is rewritten BY
  VALUE, recursively — not against a list of known ref paths, which would be wrong the first
  time a model gained a field.
- **⚠ A bundle line is JSON, so `_id` and every `Date` come back as STRINGS.** Inserting a
  parsed line directly is accepted by Mongo and then invisible: `Model.find({ orgId })` casts
  its query to an `ObjectId` and matches none of it. Documents exist, occupy the volume, ride
  along in every future backup, and cannot be seen — FR-13.32's failure mode reached from a
  completely different direction. Every document now goes through `Model.castObject`, which is
  the schema's own authority on which paths are ObjectIds and Dates.
- **The safety bundle cannot be a `BackupRun`.** The plan said `source: 'safety'`; the unique
  `{orgId, kind, date}` index IS the nightly claim, so a safety bundle taken on a day the
  scheduler already ran would collide with — or overwrite — the night's row. It lives on
  `RestoreRun` instead, and is written to `backups/safety/`, a directory `pruneBundles` does
  not walk: generation counting knows nothing about "the copy taken 30 seconds before an
  operator changed live data", which is the copy that matters most.
- **`Inspect`'s diff was worthless until both sides were hashed the same way.** A live lean
  document holds real BSON objects and `Object.keys()` on an `ObjectId` yields its internal
  buffer, so hashing live rows against bundle lines reported the entire organisation as
  `differing`. Both sides now go through the bundle's own JSON representation, with sorted
  keys so a changed insertion order is not mistaken for changed data.

Also found while working in the area, and fixed: a **duplicate `backupOffsiteNone` key** in
every locale table of `daily-digest.render.ts` — the Layer-2 wording added by `LGR-10`
silently overwrote the Layer-1 line in the same object literal, so the cluster-wide off-site
warning rendered with the per-org text. Three `digest-backups.flow.test.ts` cases had been
failing on master since that PR; two asserted `allClear === true` for a run that reached no
destination, which FR-13.59 made a failure.

**Verified:** 217 tests across the 13 backup / digest / doc-store / audit suites, 0 failures —
including 24 new in `integration/backup-restore.flow.test.ts` (AC 14–25) and 5 new in
`digest-backups.flow.test.ts`. All 8 UIs build. The full `bun run test` still needs one Linux
run (the known Bun `.rejects` deadlock on Windows, unrelated).

**Still needs the operator:** `BACKUP_SYS_ADMINS` is empty by default and every §5.7 route
403s until it is set in `lgr-secret` — including for org admins. That is the design, and it
also means the screen ships inert. Set `LGR_IMAGE_TAG` in the prod configmap too, or the
version check FR-13.31 asks for records `unknown` and can only warn.

#### The original plan for this step, for reference

Backend files: `packages/config/src/index.ts` (`config.backup.sysAdmins` from
`BACKUP_SYS_ADMINS`, comma-separated ids/emails, empty default), `backup.controller.ts`
(`requireSysAdmin(user, status)` → 403 when unset or not listed; applied on every new route),
new `packages/services/src/biz/backup/backup-restore.service.ts`, new streaming NDJSON reader
(`verifyBundle` holds everything in memory; restore needs a line iterator over the decompressed
buffer), `backup-run.model.ts` (`source: 'scheduled'|'manual'|'upload'|'safety'`), new
`RestoreRun` model (mode, bundle sha, counts, clamped sequences, dangling files, rollback state),
`BackgroundTask` usage for create and restore (existing model; 7-day TTL).

Routes (all: explicit 401, sys-admin allow-list, org match):
- `POST /org/:orgId/backup/create` → BackgroundTask id (variant `data|full`; `full` adds the
  org's `docs/` tree as a tar section)
- `POST /org/:orgId/backup/upload` (multipart via `readUploadedFiles` pattern from
  `files-api/src/controllers/file.controller.ts:40-51`; own size cap, not `config.upload.maxFileSize`)
- `POST /org/:orgId/backup/restore/inspect` `{source: {runId|path|uploadId}}` → per-collection
  diff, writes nothing, stores an `inspectionId`
- `POST /org/:orgId/backup/restore/apply` `{inspectionId, mode: 'merge'|'replace', remap?,
  confirmSlug?}`
- `GET /org/:orgId/backup/restore/:id` (progress/report)

Restore sequence (mirrors `desktop/src-tauri/src/archive.rs:79-144`): verify every SHA →
compare `manifest.orgId` (refuse unless `remap`, then rewrite `orgId` and known cross-refs by an
`_id` map) → version check (`appImageTag`; also set `LGR_IMAGE_TAG` in the prod configmap so it
is not `unknown`) → safety `data` bundle of the target org, verified, `source:'safety'` → stage
into `restore_<orgId>_<ts>` collections → Merge: insert only `_id`s absent from live; Replace:
blocked if any `FiscalDevice.isActive` or any `FiscalYear.status==='locked'` inside the covered
window, else delete + insert per collection inside a session → `Sequence.lastNumber =
max(live, bundle)` with a clamp list → dangling `DocFile` references counted → on any error roll
back from the safety bundle and report → AuditLog (`module:'admin'`, actor, mode, window, sha,
counts) and a `restores` line in the next digest.

Frontend files: `packages/portal-ui/src/router/index.ts` (add `admin/backup` beside
`admin/audit-log` at `:39`), `packages/portal-ui/src/layouts/DefaultLayout.vue:33` (nav item,
shown only if `GET /backup/runs` returns 200 — presentation only), new
`packages/portal-ui/src/views/admin/BackupView.vue` (runs table with download/verify; Create
backup with variant + estimated size; Restore wizard: source → Inspect result → mode → confirm
slug for Replace), new `packages/portal-ui/src/store/backup.store.ts`, i18n keys in all four
`packages/ui-shared/src/locales/{en,bg,de,mk}.json`. Method names mirror `archive.rs`
(`createArchive`, `restoreArchive`, `listArchives`, `deleteArchive`, `getArchiveStats`).

Tests: AC 14–25 as integration tests: allow-list unset → 403 for org admin; flipped byte →
rejected pre-write; wrong-org refused / remap leaves no original orgId; Inspect writes zero
(compare counts and `updatedAt` maxima); Merge only inserts; Replace blocked with active device;
failed restore rolls back byte-identical; sequences never move backwards.

### Step 6 — Phase 5: archiving (`lgr`, branch `LGR-12`, FR-13.38–47)

Pull forward first (small PR): `EmailLog.body` → optional (`email-log.model.ts:30`), a
`retentionTick` beside the backup tick in `unified.ts` that strips bodies > 90 days and deletes
rows > 1 year, strips `DocFile.compareSummary` on `committed|superseded`; hard allow-list of
touchable collections (`EmailLog`, `DocFile.compareSummary` only) with a test asserting fiscal
collection counts are unchanged; one-off `scripts/backfill-email-log-retention.ts`.

Then file archiving: `DocFile.archived`, `archiveRef` fields; `ArchiveUnit` model (fiscal year,
orgId, path, sha, size, file count); job packs `<UPLOAD_DIR>/<orgId>/docs/<dates in year>` into
`archives/<fiscalYear>.tar.zst` for `FiscalYear.status==='locked'` older than
`config.archive.horizonYears` (2), verifies per-file SHA against `currentChecksum`, then
removes loose files; `doc-store.service.ts:resolveDownload` gains a rehydrate branch that
extracts the single member on demand (UI shows "retrieving from archive"); un-archive action;
read-only Archives tab in the Files app listing units with coverage/size/checksum, reachable by
`nra_auditor`. Also push each `.tar.zst` to tier 3 via Step 4's destination service.

### Deferred / out of scope (as the issue states)
P2 `platform.admin` permission; desktop-ui parity; hostPath → CSI migration; Dropbox/OneDrive.

---

## Verification checklist per PR
- `bun run test` on Linux (Windows: per-file with `--env-file=.env.test`, `.rejects` → try/catch)
- `bun run build` (all 8 UIs)
- `.env.test` keeps `BACKUP_CHECK_INTERVAL_MS=0`; no test sends mail or writes outside the tmp upload dir
- For `lgr-deploy`: `shellcheck`, `--dry-run` on mars, and the AC 6 deliberate-break log in the runbook
- Update the status comment on issue #24 at the end of each step
