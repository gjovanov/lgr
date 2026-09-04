import { Elysia, t } from 'elysia'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { AuthService } from '../auth/auth.service.js'
import { BackupRun, Org } from 'db/models'
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

/** A run id must be an ObjectId, or `findOne` throws a CastError and the caller sees a 500. */
function badId(id: string): boolean {
  return !mongoose.Types.ObjectId.isValid(id)
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
