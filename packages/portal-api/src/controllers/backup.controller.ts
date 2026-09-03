import { Elysia, t } from 'elysia'
import { join } from 'node:path'
import { stat } from 'node:fs/promises'
import { AuthService } from '../auth/auth.service.js'
import { BackupRun, Org } from 'db/models'
import { config } from 'config'
import { runBackupForOrg } from 'services/biz/backup/backup-runner.service'
import { bundleDir, verifyBundle } from 'services/biz/backup/backup-bundle.service'
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
 * ⚠ Artifacts are streamed through this authenticated handler only. They live under
 * `<UPLOAD_DIR>/<orgId>/backups/`, which no static handler serves (FR-13.24).
 */

/** The org-local day a run started today is claimed under. */
async function claimDateFor(orgId: string): Promise<string> {
  const org: any = await Org.findById(orgId, { settings: 1 }).lean().exec()
  const { date } = orgLocalParts(new Date(), org?.settings?.timezone || 'UTC')
  return date
}

export const backupController = new Elysia({ prefix: '/org/:orgId/backup' })
  .use(AuthService)

  /** Build a bundle now. `force` bypasses today's claim; the scheduler's own run is unaffected. */
  .post(
    '/run',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (user.role !== 'admin') return status(403, { message: 'Admin only' })

      const b = (body || {}) as any
      const kind = b.kind === 'delta' ? 'delta' : 'full'
      const date = b.date || await claimDateFor(orgId)

      const outcome = await runBackupForOrg(orgId, date, {
        kind,
        force: b.force !== false,      // a manual run defaults to forcing; that IS the request
        actorUserId: user.id,
      })
      if (!outcome) return status(409, { message: 'A backup for today is already running' })
      if (outcome.status === 'failed') {
        return status(500, { message: 'Backup failed', detail: outcome.reason })
      }
      return outcome
    },
    {
      isSignIn: true,
      body: t.Optional(t.Object({
        kind: t.Optional(t.String()),
        date: t.Optional(t.String()),
        force: t.Optional(t.Boolean()),
      })),
    },
  )

  /** History: sizes, checksums, per-collection counts, and whether the mail carried it. */
  .get('/runs', async ({ params: { orgId }, query, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (user.role !== 'admin') return status(403, { message: 'Admin only' })

    const size = Math.min(Number(query.size) || 30, 100)
    const runs = await BackupRun.find({ orgId }).sort({ startedAt: -1 }).limit(size).lean().exec()
    return { runs, total: runs.length }
  }, { isSignIn: true })

  /** Re-verify a stored bundle against its own manifest — proof, not assumption (FR-13.12). */
  .get('/:id/verify', async ({ params: { orgId, id }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (user.role !== 'admin') return status(403, { message: 'Admin only' })

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
    if (!user) return status(401, { message: 'Unauthorized' })
    if (user.role !== 'admin') return status(403, { message: 'Admin only' })

    const run: any = await BackupRun.findOne({ _id: id, orgId }).lean().exec()
    if (!run?.filename) return status(404, { message: 'No such backup' })

    // `bundleDir(orgId)` + the stored basename — never a caller-supplied path. The row is
    // fetched by `{_id, orgId}`, so one org cannot name another's artifact.
    const absolute = join(bundleDir(orgId), run.filename)
    try {
      await stat(absolute)
    } catch {
      return status(410, { message: 'The artifact is no longer on disk', detail: run.filename })
    }

    createAuditEntry({
      orgId, userId: user.id, action: 'export', module: 'admin',
      entityType: 'backup', entityId: String(run._id), entityName: run.filename,
    })

    set.headers['content-type'] = 'application/zstd'
    set.headers['content-disposition'] = `attachment; filename="${run.filename}"`
    return Bun.file(absolute)
  }, { isSignIn: true })

  /**
   * Mail the latest bundle to the CALLER ONLY, never to a configured list.
   * The FR-11 precedent: a "test" that mails the whole company is not a test.
   */
  .post('/test-email', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    if (user.role !== 'admin') return status(403, { message: 'Admin only' })
    if (!user.email) return status(422, { message: 'Your account has no email address' })
    if (!config.email.sendgridApiKey) {
      return status(503, { message: 'Email is not configured on this server' })
    }

    const date = await claimDateFor(orgId)
    const outcome = await runBackupForOrg(orgId, date, {
      kind: 'full', force: true, actorUserId: user.id, email: user.email,
    })
    if (!outcome || outcome.status === 'failed') {
      return status(500, { message: 'Backup failed', detail: outcome?.reason })
    }
    return { sent: outcome.emailed, to: user.email, skippedReason: outcome.emailSkippedReason }
  }, { isSignIn: true })
