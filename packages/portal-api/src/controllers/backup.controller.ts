import { Elysia, t } from 'elysia'
import { join } from 'node:path'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { AuthService } from '../auth/auth.service.js'
import { BackupRun, Org, RestoreRun } from 'db/models'
import { mongoose } from 'db/connection'
import { config } from 'config'
import { runBackupForOrg } from 'services/biz/backup/backup-runner.service'
import { bundleDir, verifyBundle, BUNDLE_DATE_RE } from 'services/biz/backup/backup-bundle.service'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { orgLocalParts } from 'services/biz/digest/daily-digest.service'

/**
 * FR-13.15 (#24) — the per-org backup's operator surface.
 *
 * Admin-only, using the same raw `role !== 'admin'` guard as the digest controller it sits
 * beside. This is the ORG's own backup: creating and downloading it is org-admin work
 * (arguably GDPR portability). The *restoring* half is a different animal entirely and is
 * NOT here — §5.7 gates that behind a separate, fail-closed sys-admin allow-list, because
 * `admin` is org-scoped and handing the regal-pz shop owner a button that deletes issued
 * fiscal documents is exactly what FR-13.26 forbids.
 *
 * ⚠ Every route carries its own explicit `if (!user) return status(401)`. Per CLAUDE.md the
 * `isSignIn` macro does not by itself reject anonymous callers on these controllers — that
 * check is load-bearing, not defensive.
 *
 * ⚠ Every route ALSO checks that the caller belongs to the org in the URL. See `guard()`.
 *
 * ⚠ Artifacts are streamed through this authenticated handler only. They live under
 * `<UPLOAD_DIR>/<orgId>/backups/`, which no static handler serves (FR-13.24).
 */

/**
 * The whole authorisation check for this controller: signed in, an admin, and an admin OF
 * THIS ORG.
 *
 * ⚠ That last clause is not redundant, and its absence was a cross-tenant data leak. Every
 * route here is `/org/:orgId/…` and the role check only asks whether the caller is *an*
 * admin — of anywhere. `tenantPlugin` does not save this either: its `pre` hooks are no-ops
 * (`db/src/plugins/tenant.plugin.ts:14-24`), so nothing downstream re-checks the tenant, and
 * `buildBundle` filters on the orgId in the ROUTE. Without this comparison, the admin of any
 * org could POST `/org/<someone-else>/backup/run` and then GET its download, walking away
 * with another tenant's entire database — including `User` rows, whose `password` field is
 * not `select: false`, so bcrypt hashes come too.
 *
 * Returns an error response to return, or `null` when the caller may proceed.
 */
function guard(user: any, orgId: string, status: any) {
  if (!user) return status(401, { message: 'Unauthorized' })
  if (user.role !== 'admin') return status(403, { message: 'Admin only' })
  // Compared as strings: `user.orgId` arrives from the JWT, `orgId` from the path.
  if (String(user.orgId || '') !== String(orgId)) {
    return status(403, { message: 'This backup belongs to a different organisation' })
  }
  return null
}

/**
 * FR-13.26 — the whole of the authorisation for §5.7, and it fails CLOSED.
 *
 * ⚠ An empty `config.backup.sysAdmins` means this returns 403 to EVERYONE, including an org
 * `admin`. That is the requirement, not an unconfigured state to be tolerated: `admin` is
 * org-scoped (`config/constants.ts:1`), so gating restore on it would give the regal-pz shop
 * owner a button that deletes issued fiscal documents and rolls invoice numbering backwards
 * into numbers already in customers' hands. LGR has no platform-operator identity; this list
 * is the smallest one that can exist without a model change, a `PermissionSet` backfill and a
 * re-login (FR-13.26 P1 vs P2).
 *
 * ⚠ Portal routes carry NO client-side role gating. Hiding the nav entry hides nothing — a
 * signed-in user can type the URL, and the SPA will render the screen. This function is the
 * entire control, which is why every §5.7 route calls it explicitly rather than relying on a
 * guard applied somewhere up the tree.
 *
 * Matching is case-insensitive against both the id and the email, so an operator can be
 * listed either way and a mixed-case address in the config still works.
 */
function requireSysAdmin(user: any, orgId: string, status: any) {
  const denied = guard(user, orgId, status)
  if (denied) return denied

  // Normalised HERE as well as at parse time: `config` is mutable, and a value set by
  // anything other than the env parser (a test, a future admin screen) must not be able to
  // make the comparison case-sensitive by accident.
  const allow = config.backup.sysAdmins.map(s => String(s).toLowerCase())
  if (!allow.length) {
    return status(403, {
      message: 'The backup administration surface is not enabled on this server',
      detail: 'BACKUP_SYS_ADMINS is unset, so no account may reach it.',
    })
  }
  const id = String(user.id || '').toLowerCase()
  const email = String(user.email || '').toLowerCase()
  if (!allow.includes(id) && !(email && allow.includes(email))) {
    return status(403, { message: 'This action requires a system administrator' })
  }
  return null
}

/** A run id must be an ObjectId, or `findOne` throws a CastError and the caller sees a 500. */
function badId(id: string): boolean {
  return !mongoose.Types.ObjectId.isValid(id)
}

/**
 * Normalise the `source` a §5.7 body names into the shape the restore service takes.
 *
 * Only three source types exist and an unknown one becomes `path`, which `resolveSource`
 * then refuses unless the path resolves inside the org's own backup directory — an unknown
 * type must not fall through to something more permissive than the ones we listed.
 */
function sourceFromBody(b: any): { type: 'run' | 'path' | 'upload'; runId?: string; path?: string } {
  const raw = b?.source || {}
  const type = raw.type === 'run' ? 'run' : raw.type === 'upload' ? 'upload' : 'path'
  return { type, runId: raw.runId ? String(raw.runId) : undefined, path: raw.path ? String(raw.path) : undefined }
}

/** The org-local day a run started today is claimed under. */
async function claimDateFor(orgId: string): Promise<string> {
  const org: any = await Org.findById(orgId, { settings: 1 }).lean().exec()
  const { date } = orgLocalParts(new Date(), org?.settings?.timezone || 'UTC')
  return date
}

export const backupController = new Elysia({ prefix: '/org/:orgId/backup' })
  .use(AuthService)

  /**
   * Build a bundle now.
   *
   * ⚠ `force` defaults to **false**. It used to default to true (`b.force !== false`), which
   * meant a bare `POST /run` always took over any live claim — so a manual run that happened
   * to land while the nightly one was building produced two builders writing the SAME
   * absolute path for the same org/kind/date, with the row's recorded `sha256` describing
   * whichever finished last. Forcing is still available; it just has to be asked for.
   */
  .post(
    '/run',
    async ({ params: { orgId }, body, user, status }) => {
      const denied = guard(user, orgId, status)
      if (denied) return denied

      const b = (body || {}) as any
      const kind = b.kind === 'delta' ? 'delta' : 'full'
      // ⚠ `date` reaches the artifact FILENAME, which is persisted and later joined back onto
      // `bundleDir()` by `/download`. Unvalidated, `../../../../x` wrote outside the org's
      // directory and was then streamed back over HTTP. `buildBundle` re-checks this for the
      // same reason; neither check is the other's backup.
      if (b.date !== undefined && !BUNDLE_DATE_RE.test(String(b.date))) {
        return status(422, { message: 'date must be YYYY-MM-DD' })
      }
      const date = b.date || await claimDateFor(orgId)

      const outcome = await runBackupForOrg(orgId, date, {
        kind,
        force: b.force === true,
        actorUserId: user!.id,
      })
      if (!outcome) {
        return status(409, {
          message: 'A backup for today is already running, or has used up its attempts. Pass force to override.',
        })
      }
      if (outcome.status === 'failed') {
        return status(500, { message: 'Backup failed', detail: outcome.reason })
      }
      return outcome
    },
    {
      isSignIn: true,
      body: t.Optional(t.Object({
        kind: t.Optional(t.String()),
        date: t.Optional(t.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}$' })),
        force: t.Optional(t.Boolean()),
      })),
    },
  )

  /** History: sizes, checksums, per-collection counts, and whether the mail carried it. */
  .get('/runs', async ({ params: { orgId }, query, user, status }) => {
    const denied = guard(user, orgId, status)
    if (denied) return denied

    const size = Math.min(Number(query.size) || 30, 100)
    const runs = await BackupRun.find({ orgId }).sort({ startedAt: -1 }).limit(size).lean().exec()
    return { runs, total: runs.length }
  }, { isSignIn: true })

  /** Re-verify a stored bundle against its own manifest — proof, not assumption (FR-13.12). */
  .get('/:id/verify', async ({ params: { orgId, id }, user, status }) => {
    const denied = guard(user, orgId, status)
    if (denied) return denied
    if (badId(id)) return status(404, { message: 'No such backup' })

    const run: any = await BackupRun.findOne({ _id: id, orgId }).lean().exec()
    if (!run?.filename) return status(404, { message: 'No such backup' })

    try {
      const result = await verifyBundle(join(bundleDir(orgId), run.filename), run.sha256)
      return result
    } catch (e: any) {
      return status(500, { message: 'Verification could not run', detail: e?.message })
    }
  }, { isSignIn: true })

  /** Stream the artifact. Authenticated, org-scoped, and audited (FR-13.24, FR-13.25). */
  .get('/:id/download', async ({ params: { orgId, id }, user, status, set }) => {
    const denied = guard(user, orgId, status)
    if (denied) return denied
    if (badId(id)) return status(404, { message: 'No such backup' })

    const run: any = await BackupRun.findOne({ _id: id, orgId }).lean().exec()
    if (!run?.filename) return status(404, { message: 'No such backup' })

    // `bundleDir(orgId)` + the stored basename. The row is fetched by `{_id, orgId}`, so one
    // org cannot name another's artifact — and `buildBundle` now refuses to write a filename
    // that escapes this directory, so the stored value cannot point outside it either.
    const absolute = join(bundleDir(orgId), run.filename)
    try {
      await stat(absolute)
    } catch {
      // Expected once retention has moved past it — the row is history, not a promise.
      return status(410, {
        message: run.artifactPruned
          ? 'This backup has been rotated out by retention'
          : 'The artifact is no longer on disk',
        detail: run.filename,
      })
    }

    createAuditEntry({
      orgId, userId: user!.id, action: 'export', module: 'admin',
      entityType: 'backup', entityId: String(run._id), entityName: run.filename,
    })

    set.headers['content-type'] = 'application/zstd'
    set.headers['content-disposition'] = `attachment; filename="${run.filename}"`
    return Bun.file(absolute)
  }, { isSignIn: true })

  /**
   * Mail the latest bundle's manifest to the CALLER ONLY, never to a configured list.
   * The FR-11 precedent: a "test" that mails the whole company is not a test.
   *
   * ⚠ This no longer BUILDS anything. It used to call `runBackupForOrg(..., force: true)`,
   * so a "test email" silently overwrote today's real backup row and re-ran a full export of
   * the organisation — a read-shaped button with a write-shaped effect. It now mails the most
   * recent completed run, which is also a more honest test: it exercises the mail path
   * against the artifact an operator would actually receive.
   */
  .post('/test-email', async ({ params: { orgId }, user, status }) => {
    const denied = guard(user, orgId, status)
    if (denied) return denied
    if (!user!.email) return status(422, { message: 'Your account has no email address' })
    if (!config.email.sendgridApiKey) {
      return status(503, { message: 'Email is not configured on this server' })
    }

    const run: any = await BackupRun.findOne({ orgId, status: 'completed' })
      .sort({ startedAt: -1 }).lean().exec()
    if (!run?.filename) {
      return status(409, { message: 'This organisation has no completed backup to mail yet' })
    }

    const { mailExistingRun } = await import('services/biz/backup/backup-runner.service')
    const result = await mailExistingRun(orgId, run, user!.email)
    if (!result.emailed) {
      return status(502, { message: 'The mail could not be sent', detail: result.skippedReason })
    }
    return { sent: true, to: user!.email, filename: run.filename, skippedReason: result.skippedReason }
  }, { isSignIn: true })

  // ── §5.7 — the system-administrator surface ────────────────────────────────────
  //
  // Everything below is gated on `requireSysAdmin`, never on `guard` alone.
  //
  // ⚠ Open decision 2 on issue #24 ("should create + download of an org's OWN backup stay
  // self-service?") is answered here by splitting the screen rather than the routes' names:
  // `POST /run`, `GET /runs`, `/verify`, `/download` and `/test-email` above remain org-admin
  // — an org exporting its own data is arguably GDPR portability, and they shipped that way —
  // while everything that can WRITE to live data, or that reaches across a tenant boundary,
  // is behind the allow-list. The dividing line is destructiveness, not tidiness.

  /**
   * Whether the CALLER may use §5.7 — a presentation probe, not a gate.
   *
   * Answers 200 with `false` rather than 403, deliberately: the nav entry has to be able to
   * ask this question without the answer itself being an error, and hiding the entry is
   * cosmetic anyway (see `requireSysAdmin`). Nothing is authorised by this route.
   */
  .get('/access', async ({ params: { orgId }, user, status }) => {
    const denied = guard(user, orgId, status)
    if (denied) return denied
    const allow = config.backup.sysAdmins.map(s => String(s).toLowerCase())
    const id = String(user!.id || '').toLowerCase()
    const email = String(user!.email || '').toLowerCase()
    return {
      sysAdmin: allow.length > 0 && (allow.includes(id) || (!!email && allow.includes(email))),
      configured: allow.length > 0,
    }
  }, { isSignIn: true })

  /**
   * FR-13.29 — "Create backup now", as a `BackgroundTask`.
   *
   * ⚠ Dispatches and returns; it never builds inside the request. The Files app already paid
   * for this lesson: the OCR sidecar draft at ~53 s exceeded the ingress proxy timeout and had
   * to become an async job. Today's bundle takes seconds — at the §2.3 year-10 volumes
   * (737k documents, ~6.9 GB of `docs/`) it will not, and the shape must be right before the
   * data grows into it rather than after.
   */
  .post(
    '/create',
    async ({ params: { orgId }, body, user, status }) => {
      const denied = requireSysAdmin(user, orgId, status)
      if (denied) return denied

      const b = (body || {}) as any
      const variant = b.variant === 'full' ? 'full' : 'data'
      const date = await claimDateFor(orgId)

      const { startJob, updateProgress, completeJob, failJob } = await import('services/background/task.service')
      const task = await startJob(orgId, user!.id, 'backup-create', { variant, date })

      // ⚠ Not awaited. The floating promise is the point of the route; every terminal state
      // is written onto the task, so a failure lands somewhere the poller reads rather than
      // in an unhandled rejection.
      void (async () => {
        try {
          const outcome = await runBackupForOrg(orgId, date, {
            kind: 'full',
            variant,
            source: 'manual',
            // A manual create takes over the day's claim: the operator asked for a backup NOW,
            // and answering "the scheduler already did one at 03:45" is not what they asked.
            // ⚠ It writes its OWN file rather than over the night's — see `filenameSuffix`.
            force: true,
            filenameSuffix: `manual-${new Date().toISOString().slice(11, 19).replace(/:/g, '')}`,
            actorUserId: user!.id,
            onProgress: (percent, message) => { void updateProgress(String(task.id), percent, message) },
          })
          if (!outcome || outcome.status === 'failed') {
            await failJob(String(task.id), outcome?.reason || 'the backup did not run')
            return
          }
          await completeJob(String(task.id), outcome as any)
        } catch (e: any) {
          await failJob(String(task.id), e?.message || 'the backup failed')
        }
      })()

      return { taskId: String(task.id), variant, date }
    },
    {
      isSignIn: true,
      body: t.Optional(t.Object({ variant: t.Optional(t.String()) })),
    },
  )

  /**
   * Poll a `POST /create` job. Same shape as `files-api`'s `/files/task/:taskId`.
   *
   * ⚠ Reads the in-process store first and falls back to the row, because the two answer
   * different questions: the store knows about the job running in THIS pod right now, the row
   * survives a restart and a different pod picking up the poll. Neither alone is enough.
   */
  .get('/task/:taskId', async ({ params: { orgId, taskId }, user, status }) => {
    const denied = requireSysAdmin(user, orgId, status)
    if (denied) return denied

    const { taskStore } = await import('services/background/task.store')
    const live = taskStore.get(taskId)
    if (live && String(live.orgId) === String(orgId)) {
      return {
        status: live.status, progress: live.progress,
        logs: live.logs.slice(-20), result: live.result, error: live.error,
      }
    }
    if (badId(taskId)) return status(404, { message: 'No such task' })
    const { BackgroundTask } = await import('db/models')
    const row: any = await BackgroundTask.findOne({ _id: taskId, orgId }).lean().exec()
    if (!row) return status(404, { message: 'No such task' })
    return {
      status: row.status, progress: row.progress,
      logs: (row.logs || []).slice(-20), result: row.result, error: row.error,
    }
  }, { isSignIn: true })

  /**
   * FR-13.30 — get an artifact onto the server without a 50 MB ceiling in the way.
   *
   * ⚠ `config.upload.maxFileSize` is 50 MB and is NOT used here: a `full` bundle exceeds it
   * today and a `data` bundle does around year 8, so sharing the documents cap would make
   * upload fail on exactly the artifacts it exists to carry. Restoring the org's own most
   * recent bundle needs no upload at all — `restore/inspect` takes a `runId`.
   *
   * The file lands in `backups/uploads/`, inside the tree `resolveSource` will accept and
   * outside the one nightly retention prunes.
   */
  .post(
    '/upload',
    async ({ params: { orgId }, body, request, user, status }) => {
      const denied = requireSysAdmin(user, orgId, status)
      if (denied) return denied

      // Same shape as `files-api/src/controllers/file.controller.ts:40-51`: Elysia's `t.Files()`
      // validator is brittle, so take what it parsed and otherwise re-read the form.
      const raw = (body as any)?.file || (body as any)?.files
      let file: File | null = raw instanceof File ? raw : Array.isArray(raw) && raw[0] instanceof File ? raw[0] : null
      if (!file) {
        try {
          const form = await request.formData()
          const got = form.get('file') || form.get('files')
          if (got instanceof File) file = got
        } catch { /* not multipart */ }
      }
      if (!file) return status(400, { message: 'No bundle was uploaded' })
      if (file.size > config.backup.restoreMaxUploadBytes) {
        return status(413, {
          message: 'That bundle is larger than this server accepts',
          detail: `${file.size} bytes; the limit is ${config.backup.restoreMaxUploadBytes}`,
        })
      }

      const { uploadStagingDir } = await import('services/biz/backup/backup-restore.service')
      const dir = uploadStagingDir(orgId)
      await mkdir(dir, { recursive: true })
      // The uploaded name is attacker-controlled text that becomes a path. Reduced to a safe
      // alphabet and stamped, so two uploads of `backup.zst` cannot silently replace each other.
      const safe = String(file.name || 'bundle').replace(/[^A-Za-z0-9._-]/g, '-').slice(-120)
      const filename = `${Date.now()}-${safe}`
      const absolute = join(dir, filename)
      await writeFile(absolute, Buffer.from(await file.arrayBuffer()))

      createAuditEntry({
        orgId, userId: user!.id, action: 'create', module: 'admin',
        entityType: 'restore', entityId: filename, entityName: `uploaded ${safe}`,
      })

      // The path is returned RELATIVE to the org's backup directory, which is the only form
      // `resolveSource` needs and the only one worth putting in front of a browser.
      return { path: join('uploads', filename), filename: safe, bytes: file.size }
    },
    { isSignIn: true },
  )

  /**
   * FR-13.33 — Inspect. The default mode, and the one that writes nothing.
   *
   * Returns the `RestoreRun` whose `_id` is the `inspectionId` an apply must name.
   */
  .post(
    '/restore/inspect',
    async ({ params: { orgId }, body, user, status }) => {
      const denied = requireSysAdmin(user, orgId, status)
      if (denied) return denied

      const b = (body || {}) as any
      const { inspectBundle } = await import('services/biz/backup/backup-restore.service')
      try {
        const run = await inspectBundle(orgId, sourceFromBody(b), { userId: user!.id, email: user!.email })
        return run
      } catch (e: any) {
        return status(422, { message: 'The bundle could not be inspected', detail: e?.message })
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        source: t.Object({
          type: t.String(),
          runId: t.Optional(t.String()),
          path: t.Optional(t.String()),
        }),
      }),
    },
  )

  /**
   * FR-13.33/13.34/13.36 — the writing modes.
   *
   * Every refusal below is a 4xx with the reason in it, because each one is a decision the
   * operator has to be able to act on: inspect first, ask for a remap, type the slug, use
   * Merge because this org has a fiscal device.
   */
  .post(
    '/restore/apply',
    async ({ params: { orgId }, body, user, status }) => {
      const denied = requireSysAdmin(user, orgId, status)
      if (denied) return denied

      const b = (body || {}) as any
      const mode = b.mode === 'replace' ? 'replace' : 'merge'
      const { applyRestore } = await import('services/biz/backup/backup-restore.service')
      try {
        const run = await applyRestore(orgId, sourceFromBody(b), {
          mode,
          remap: b.remap === true,
          confirmSlug: b.confirmSlug,
          inspectionId: String(b.inspectionId || ''),
          restoreFiles: b.restoreFiles === true,
          actor: { userId: user!.id, email: user!.email },
        })
        return run
      } catch (e: any) {
        // A restore that failed AND rolled back is still a 422 — the request was refused and
        // live data is where it started — but the rollback state has to travel with it, since
        // "it failed" and "it failed and your data is back" are different facts.
        return status(422, {
          message: 'The restore did not complete',
          detail: e?.message,
          restoreRunId: e?.restoreRunId,
          rolledBack: e?.rolledBack,
          rollbackDetail: e?.rollbackDetail,
        })
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        source: t.Object({
          type: t.String(),
          runId: t.Optional(t.String()),
          path: t.Optional(t.String()),
        }),
        inspectionId: t.String(),
        mode: t.Optional(t.String()),
        remap: t.Optional(t.Boolean()),
        confirmSlug: t.Optional(t.String()),
        restoreFiles: t.Optional(t.Boolean()),
      }),
    },
  )

  /** Restore history — inspections included, because an inspection is an operator act too. */
  .get('/restores', async ({ params: { orgId }, query, user, status }) => {
    const denied = requireSysAdmin(user, orgId, status)
    if (denied) return denied
    const size = Math.min(Number(query.size) || 20, 100)
    const runs = await RestoreRun.find({ orgId }).sort({ startedAt: -1 }).limit(size).lean().exec()
    return { runs, total: runs.length }
  }, { isSignIn: true })

  /** One restore's full report: counts, clamps, dangling files, rollback state. */
  .get('/restore/:id', async ({ params: { orgId, id }, user, status }) => {
    const denied = requireSysAdmin(user, orgId, status)
    if (denied) return denied
    if (badId(id)) return status(404, { message: 'No such restore' })
    const run = await RestoreRun.findOne({ _id: id, orgId }).lean().exec()
    if (!run) return status(404, { message: 'No such restore' })
    return run
  }, { isSignIn: true })
