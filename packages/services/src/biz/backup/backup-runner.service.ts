/**
 * FR-13.10/13.11/13.16–13.19/13.25 (#24) — claiming a day, building the bundle, mailing the
 * manifest, recording what happened.
 *
 * The scheduler half is deliberately the same small, boring shape as FR-11's: no cron
 * library, no queue, no lease primitive — the unique `{orgId, kind, date}` index on
 * `BackupRun` IS the lock. First writer wins, everyone else takes E11000 and walks away.
 *
 * ⚠ Claim-day vs covered-day, the FR-11 bug, applies identically here: a run is CLAIMED under
 * the day it executes and COVERS the window ending then.
 */

import { BackupRun, Org, User } from 'db/models'
import { config } from 'config'
import { logger } from '../../logger/logger.js'
import { sendEmail, MAX_ATTACHMENT_BYTES } from '../email.service.js'
import { createAuditEntry } from '../audit-log.service.js'
import { orgLocalParts, digestHourReached } from '../digest/digest-time.js'
import { join } from 'node:path'
import { buildBundle, bundleDir, pruneBundles, readBundleManifest, verifyBundle } from './backup-bundle.service.js'
import { BUNDLE_FORMAT, type BackupBundleManifest } from './backup-bundle.types.js'

/** A claim older than this with no `completedAt` is assumed dead and may be taken over. */
export const STALE_CLAIM_MS = 60 * 60 * 1000

/**
 * FR-13.18 — the REAL email ceiling.
 *
 * ⚠ `MAX_ATTACHMENT_BYTES` (20 MB) is compared against the **base64** length in
 * `email.service.ts`, and base64 inflates by 4/3. The true binary ceiling is therefore
 * 20 MiB × 3/4 = **14.6 MiB**, not 20 MB. A pre-flight against the wrong number would let the
 * send be attempted and fail as an opaque `provider_error` — which, at the measured growth
 * rate, would start happening silently around month 20.
 */
export const MAX_ATTACHMENT_BINARY_BYTES = Math.floor((MAX_ATTACHMENT_BYTES * 3) / 4)

export interface BackupRunOutcome {
  status: 'completed' | 'failed'
  reason?: string
  runId?: string
  filename?: string
  bytes?: number
  sha256?: string
  documentCount?: number
  emailed?: boolean
  emailSkippedReason?: string
}

function isDuplicateKey(e: any): boolean {
  return e?.code === 11000 || /E11000/.test(String(e?.message || ''))
}

/**
 * Insert the claim, or take over a stale one.
 *
 * The takeover exists for one scenario: a pod that claimed a day and died mid-build. Without
 * it that org silently loses its backup forever, because the claim row blocks every retry.
 * The conditional `completedAt: null` keeps two live runners from both taking over.
 */
async function claimDay(orgId: string, kind: 'full' | 'delta', date: string): Promise<{ _id: any } | null> {
  try {
    const doc = await BackupRun.create({
      orgId, kind, date, status: 'running', startedAt: new Date(), attempts: 1,
    })
    return { _id: doc._id }
  } catch (e) {
    if (!isDuplicateKey(e)) throw e
  }

  const cutoff = new Date(Date.now() - STALE_CLAIM_MS)
  // Two distinct rows are claimable, and conflating them was the bug:
  //
  //  - `status: 'failed'` — a finished attempt that produced nothing. Retryable IMMEDIATELY;
  //    making the org wait an hour for a blip that has already passed serves nobody.
  //  - a stale `running` — a pod that claimed the day and died mid-build. Only after
  //    STALE_CLAIM_MS, or two live runners would both take over a healthy in-flight run.
  //
  // Both are gated on `attempts` so a deterministic failure retries a bounded number of times
  // instead of rebuilding the same broken bundle every tick until morning.
  const takeover = await BackupRun.findOneAndUpdate(
    {
      orgId, kind, date,
      completedAt: null,
      attempts: { $lt: config.backup.maxAttemptsPerDay },
      $or: [{ status: 'failed' }, { startedAt: { $lte: cutoff } }],
    },
    { $set: { status: 'running', startedAt: new Date() }, $inc: { attempts: 1 } },
    { new: true },
  ).exec()

  if (takeover) {
    const t: any = takeover
    logger.warn(
      { orgId, kind, date, attempts: t.attempts, previous: t.reason },
      'Backup: retrying a failed or stale claim',
    )
    return { _id: t._id }
  }
  return null
}

/** A few KB of counts and checksums — what proves WHAT SHOULD EXIST even when the payload cannot be sent. */
export function renderManifestEmail(m: BackupBundleManifest, bundleSha: string, bytes: number, note?: string): string {
  const rows = m.collections
    .map(c => `<tr><td style="padding:3px 8px;border-bottom:1px solid #eee">${c.name}</td>` +
      `<td style="padding:3px 8px;border-bottom:1px solid #eee;text-align:right">${c.count}</td>` +
      `<td style="padding:3px 8px;border-bottom:1px solid #eee;font-family:monospace;font-size:11px">${c.sha256.slice(0, 16)}…</td></tr>`)
    .join('')
  return [
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#222;max-width:760px">`,
    `<h2 style="font-size:16px;margin:0 0 6px">Backup — ${m.orgName || m.orgSlug}</h2>`,
    `<div style="color:#888;font-size:12px">${m.kind} · ${m.date} · ${m.documentCount} documents · ${(bytes / 1024 / 1024).toFixed(2)} MB</div>`,
    note ? `<p style="margin:10px 0;padding:8px 10px;background:#fff6e5;border-left:4px solid #f0a500">${note}</p>` : '',
    `<p style="font-family:monospace;font-size:11px;word-break:break-all">sha256 ${bundleSha}</p>`,
    `<table style="border-collapse:collapse;width:100%"><tr>`,
    `<th style="text-align:left;padding:3px 8px;background:#f4f4f6;font-size:12px">Collection</th>`,
    `<th style="text-align:right;padding:3px 8px;background:#f4f4f6;font-size:12px">Documents</th>`,
    `<th style="text-align:left;padding:3px 8px;background:#f4f4f6;font-size:12px">SHA-256</th></tr>`,
    rows,
    `</table></div>`,
  ].filter(Boolean).join('\n')
}

/**
 * Build one org's bundle for one org-local day, claiming it first.
 *
 * Returns `null` when another runner holds the claim — the caller treats that as "not mine",
 * not as an error.
 */
export async function runBackupForOrg(
  orgId: string,
  date: string,
  opts: { kind?: 'full' | 'delta'; force?: boolean; actorUserId?: string; email?: string } = {},
): Promise<BackupRunOutcome | null> {
  const kind = opts.kind || 'full'

  let claimId: any
  if (opts.force) {
    // An explicit forced run takes the day over even from a live claim. ⚠ It is deliberately
    // NOT the default for `POST /run` any more: two builders writing the same filename for
    // the same org/kind/date race, and the row's recorded sha256 can end up describing
    // neither file. The caller has to ask for this.
    const doc = await BackupRun.findOneAndUpdate(
      { orgId, kind, date },
      {
        $set: { status: 'running', startedAt: new Date(), completedAt: null },
        $inc: { attempts: 1 },
      },
      { new: true, upsert: true },
    ).exec()
    claimId = (doc as any)._id
  } else {
    const claim = await claimDay(orgId, kind, date)
    if (!claim) return null
    claimId = claim._id
  }

  const started = Date.now()
  try {
    const coversTo = new Date()
    // FR-13.12 wants the covered WINDOW, not just its end. The previous completed run for
    // this org and kind is where this one picks up; the first ever run covers from the org's
    // beginning, which is recorded as an absent `coversFrom` rather than a guessed date.
    const previous: any = await BackupRun.findOne(
      { orgId, kind, status: 'completed', _id: { $ne: claimId } },
      { coversTo: 1, completedAt: 1 },
    ).sort({ startedAt: -1 }).lean().exec()
    const coversFrom: Date | undefined = previous?.coversTo || previous?.completedAt || undefined

    const built = await buildBundle(orgId, { kind, date, coversFrom, coversTo })

    // Prove it before recording it. A bundle whose own manifest does not reproduce is not a
    // backup, and finding that out at restore time is the whole failure this FR exists to
    // prevent.
    const verified = await verifyBundle(built.absolutePath, built.sha256)
    if (!verified.ok) {
      throw new Error(`bundle failed its own verification: ${verified.problems.slice(0, 3).join('; ')}`)
    }

    const mail = await mailBundle(orgId, built, opts.email)

    // Prune AFTER the new bundle is written and verified, never before: the retention rule
    // must never be able to remove an old copy on a night that then fails to produce a new one.
    const pruned = await pruneBundles(orgId, kind)
    if (pruned.length) {
      // The rows stay — they are the history and the audit trail — but they must stop
      // claiming an artifact that is gone, or `/download` becomes a lie.
      await BackupRun.updateMany(
        { orgId, filename: { $in: pruned } },
        { $set: { artifactPruned: true } },
      ).exec()
    }

    await BackupRun.updateOne({ _id: claimId }, {
      $set: {
        status: 'completed',
        path: built.path,
        filename: built.filename,
        bytes: built.bytes,
        sha256: built.sha256,
        collections: built.manifest.collections.map(c => ({
          name: c.name, count: c.count, sha256: c.sha256, bytes: c.bytes,
        })),
        documentCount: built.manifest.documentCount,
        coversFrom,
        coversTo,
        emailed: mail.emailed,
        emailSkippedReason: mail.skippedReason,
        completedAt: new Date(),
        durationMs: Date.now() - started,
      },
    }).exec()

    // FR-13.25 — an operator creating a backup is an auditable act.
    //
    // ⚠ The SCHEDULER's runs are deliberately not written here. `AuditLog.userId` is a
    // required `ObjectId` ref to `User` (`audit-log.model.ts:23`) and `createAuditEntry`
    // casts it unconditionally, so a system actor would throw, be swallowed by that
    // function's own try/catch, and write nothing — the appearance of an audit trail with
    // none behind it. (The `userId: 'system'` calls in `events/handlers.ts` already fail this
    // way; that is a separate bug and weakening a fiscal model is not this PR's business.)
    // A scheduled run is instead made visible where an operator actually looks: the FR-11
    // digest now carries this org's own last `BackupRun` — see `readOrgBackupRun` below.
    if (opts.actorUserId) {
      createAuditEntry({
        orgId, userId: opts.actorUserId, action: 'create', module: 'admin',
        entityType: 'backup', entityId: String(claimId), entityName: built.filename,
      })
    }

    return {
      status: 'completed', runId: String(claimId), filename: built.filename,
      bytes: built.bytes, sha256: built.sha256, documentCount: built.manifest.documentCount,
      emailed: mail.emailed, emailSkippedReason: mail.skippedReason,
    }
  } catch (e: any) {
    logger.error({ orgId, kind, date, err: e?.message }, 'Backup run failed')
    // ⚠ `completedAt` stays NULL on failure, deliberately.
    //
    // Setting it marked the org-day done: `backupTick` skips any org whose row for today has
    // a truthy `completedAt`, and `claimDay`'s stale takeover only matches `completedAt:
    // null`. So a single transient failure at 03:00 — a momentary Mongo blip, a full disk
    // that cleared — silently cost the org its entire night, with nothing but a log line
    // nobody reads to show for it. That is the roomler failure mode this FR exists to
    // eliminate, reproduced inside the code written to prevent it.
    //
    // Leaving it null lets the next tick retry, bounded by `attempts` so a deterministic
    // failure cannot spin. The reason stays on the row for the digest to report.
    await BackupRun.updateOne({ _id: claimId }, {
      $set: {
        status: 'failed',
        reason: e?.message || 'failed',
        completedAt: null,
        failedAt: new Date(),
        durationMs: Date.now() - started,
      },
    }).exec()
    return { status: 'failed', reason: e?.message || 'failed', runId: String(claimId) }
  }
}

/**
 * FR-13.16–13.19 — the manifest always, the payload only when it fits.
 *
 * ⚠ Email is NOT one of the three copies (FR-13.19). It is a courier of last resort, which is
 * why an unconfigured provider or an oversized payload degrades the mail rather than failing
 * the run: the bundle is already on the PV and already checksummed.
 */
async function mailBundle(
  orgId: string,
  built: { filename: string; bytes: number; sha256: string; absolutePath: string; manifest: BackupBundleManifest },
  explicitTo?: string,
): Promise<{ emailed: boolean; skippedReason?: string }> {
  let to = explicitTo
  if (!to) {
    const org: any = await Org.findById(orgId, { settings: 1 }).lean().exec()
    const ids = (org?.settings?.dailyDigest?.recipients || []).map((r: any) => r?.userId).filter(Boolean)
    if (!ids.length) return { emailed: false, skippedReason: 'no_recipients' }
    const u: any = await User.findOne({ _id: { $in: ids }, orgId, isActive: true }, { email: 1 }).lean().exec()
    if (!u?.email) return { emailed: false, skippedReason: 'no_recipients' }
    to = u.email
  }

  const m = built.manifest
  const subject = `Backup — ${m.orgName || m.orgSlug} — ${m.date}`

  // Two independent reasons not to attach the payload, and they are reported separately
  // because they mean different things to an operator.
  //
  // 1. FR-13.23 — a bundle carries every tenant-scoped collection, which includes `User`
  //    documents whose `password` field is NOT `select: false`, so bcrypt hashes and every
  //    contact's tax ID would be leaving the cluster in a mailbox, unencrypted. Off by
  //    default; a deployment that wants it must say so.
  // 2. FR-13.18 — the effective ceiling, computed the way email.service.ts computes it
  //    (against the BASE64 length). Over it, the send is skipped with a recorded reason
  //    rather than attempted and left to fail as an opaque provider_error.
  const attachAllowed = config.backup.emailAttachBundle
  const overSized = built.bytes > MAX_ATTACHMENT_BINARY_BYTES
  const attach = attachAllowed && !overSized

  const note = !attachAllowed
    ? `The bundle itself was NOT attached: this server does not mail backup payloads, ` +
      `because a bundle contains every collection in the organisation — including user ` +
      `password hashes and contact tax numbers — and mail leaves the cluster unencrypted. ` +
      `Download it from the Backups screen. This manifest proves what should exist.`
    : overSized
      ? `The bundle is ${(built.bytes / 1024 / 1024).toFixed(1)} MB, over the ` +
        `${(MAX_ATTACHMENT_BINARY_BYTES / 1024 / 1024).toFixed(1)} MB this mail can carry. ` +
        `It was NOT attached — download it from the Backups screen. This manifest still proves what should exist.`
      : undefined

  const res = await sendEmail({
    to,
    subject,
    html: renderManifestEmail(m, built.sha256, built.bytes, note),
    orgId,
    entityType: 'backup',
    attachments: !attach ? undefined : [{
      filename: built.filename,
      content: await (await import('node:fs/promises')).readFile(built.absolutePath),
      type: 'application/zstd',
    }],
  })

  if (!res.ok) return { emailed: false, skippedReason: res.reason }
  const skippedReason = !attachAllowed
    ? 'attachment_disabled_manifest_sent'
    : overSized
      ? 'payload_too_large_manifest_sent'
      : undefined
  return { emailed: true, skippedReason }
}

/**
 * Mail an ALREADY-BUILT run's manifest, without building anything.
 *
 * This is what `POST /backup/test-email` uses. It previously ran a forced full backup to
 * produce something to send, which meant a button whose name says "test" overwrote the day's
 * real backup row and re-exported the whole organisation. Mailing the newest completed run is
 * both harmless and a better test: it exercises the delivery path against exactly the artifact
 * an operator would receive.
 */
export async function mailExistingRun(
  orgId: string,
  run: { filename: string; bytes?: number; sha256?: string; date: string; kind?: string; collections?: any[]; documentCount?: number },
  to: string,
): Promise<{ emailed: boolean; skippedReason?: string }> {
  const org: any = await Org.findById(orgId, { slug: 1, name: 1 }).lean().exec()
  const absolutePath = join(bundleDir(orgId), run.filename)

  // Prefer the manifest inside the artifact — it is the reproducible record (FR-13.12). If
  // retention has removed the file, fall back to what the row remembers rather than failing:
  // the operator asked to test the MAIL, and the row still proves what existed.
  let manifest: BackupBundleManifest
  try {
    manifest = await readBundleManifest(absolutePath)
  } catch {
    manifest = {
      format: BUNDLE_FORMAT,
      orgId: String(orgId),
      orgSlug: org?.slug || '',
      orgName: org?.name || '',
      kind: (run.kind as 'full' | 'delta') || 'full',
      date: run.date,
      createdAt: new Date().toISOString(),
      schemaVersion: BUNDLE_FORMAT,
      appImageTag: process.env.LGR_IMAGE_TAG || process.env.IMAGE_TAG || 'unknown',
      documentCount: run.documentCount || 0,
      collections: (run.collections || []) as any,
    }
  }

  return mailBundle(orgId, {
    filename: run.filename,
    bytes: run.bytes || 0,
    sha256: run.sha256 || '',
    absolutePath,
    manifest,
  }, to)
}

/**
 * One scheduler tick: every org whose backup hour has arrived, in ITS OWN timezone, that has
 * not been backed up today yet.
 *
 * Same semantics as the digest tick, for the same reasons: catch-up within the day, never
 * repeat, no multi-day backfill.
 */
export async function backupTick(now = new Date()): Promise<{ checked: number; ran: number }> {
  // ⚠ Opt-in, and the query is where that is enforced. 73 of the 80 orgs in production are
  // `e2e-*` test tenants; bundling all of them nightly would put artifacts nobody will ever
  // read on the PV that §2.4 identifies as the only resource under real pressure. The gate is
  // on the SCHEDULER only — an org admin can always take a manual backup of their own org.
  const orgs: any[] = await Org.find(
    { 'settings.backup.enabled': true },
    { name: 1, settings: 1 },
  ).lean().exec()
  let ran = 0

  for (const org of orgs) {
    try {
      const tz = org.settings?.timezone || 'UTC'
      const { date: today, hour } = orgLocalParts(now, tz)
      const wantedHour = org.settings?.backup?.hour ?? config.backup.hour
      if (!digestHourReached(hour, wantedHour)) continue

      const existing: any = await BackupRun.findOne(
        { orgId: org._id, kind: 'full', date: today },
        { _id: 1, completedAt: 1, startedAt: 1, status: 1, attempts: 1 },
      ).lean().exec()
      if (existing) {
        // Done for today — the only genuinely finished state.
        if (existing.completedAt) continue
        // Out of retries. The row keeps `status: 'failed'` and its reason, and the digest
        // reports it; silently trying again every ten minutes would not help.
        if ((existing.attempts || 0) >= config.backup.maxAttemptsPerDay) continue
        // A live claim someone else is still building. A FAILED row is not live — it is the
        // retry case, and falling through to `runBackupForOrg` is the point of the change.
        const live = existing.status !== 'failed' &&
          new Date(existing.startedAt).getTime() > Date.now() - STALE_CLAIM_MS
        if (live) continue
      }

      const outcome = await runBackupForOrg(String(org._id), today)
      if (outcome) {
        ran++
        logger.info({ orgId: String(org._id), date: today, status: outcome.status }, 'Backup run')
      }
    } catch (e: any) {
      // One org's failure must not stop the others.
      logger.error({ orgId: String(org._id), err: e?.message }, 'Backup tick failed for org')
    }
  }

  return { checked: orgs.length, ran }
}
