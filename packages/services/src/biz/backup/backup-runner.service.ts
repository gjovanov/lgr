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
import { buildBundle, pruneBundles, verifyBundle } from './backup-bundle.service.js'
import type { BackupBundleManifest } from './backup-bundle.types.js'

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
    const doc = await BackupRun.create({ orgId, kind, date, status: 'running', startedAt: new Date() })
    return { _id: doc._id }
  } catch (e) {
    if (!isDuplicateKey(e)) throw e
  }

  const cutoff = new Date(Date.now() - STALE_CLAIM_MS)
  const takeover = await BackupRun.findOneAndUpdate(
    { orgId, kind, date, completedAt: null, startedAt: { $lte: cutoff } },
    { $set: { status: 'running', startedAt: new Date() } },
    { new: true },
  ).exec()

  if (takeover) {
    logger.warn({ orgId, kind, date }, 'Backup: took over a stale claim')
    return { _id: (takeover as any)._id }
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
    // A manual run must not be blocked by today's scheduled one. It still writes a row, so
    // the audit trail and the history endpoint see it.
    const doc = await BackupRun.findOneAndUpdate(
      { orgId, kind, date },
      { $set: { status: 'running', startedAt: new Date(), completedAt: null } },
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
    const built = await buildBundle(orgId, { kind, date, coversTo })

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
        coversTo,
        emailed: mail.emailed,
        emailSkippedReason: mail.skippedReason,
        completedAt: new Date(),
        durationMs: Date.now() - started,
      },
    }).exec()

    // FR-13.25 — creating a backup is an auditable act. `actorUserId` is absent for the
    // scheduler, which is itself worth recording: it distinguishes an operator's action from
    // the nightly job.
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
    await BackupRun.updateOne({ _id: claimId }, {
      $set: { status: 'failed', reason: e?.message || 'failed', completedAt: new Date(), durationMs: Date.now() - started },
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

  // Pre-flight against the EFFECTIVE ceiling, computed the way email.service.ts computes it.
  // Over it, the send is skipped with a recorded reason — never attempted and left to fail as
  // an opaque provider_error.
  const overSized = built.bytes > MAX_ATTACHMENT_BINARY_BYTES
  const note = overSized
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
    attachments: overSized ? undefined : [{
      filename: built.filename,
      content: await (await import('node:fs/promises')).readFile(built.absolutePath),
      type: 'application/zstd',
    }],
  })

  if (!res.ok) return { emailed: false, skippedReason: res.reason }
  return { emailed: true, skippedReason: overSized ? 'payload_too_large_manifest_sent' : undefined }
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

      const existing = await BackupRun.findOne(
        { orgId: org._id, kind: 'full', date: today },
        { _id: 1, completedAt: 1, startedAt: 1 },
      ).lean().exec()
      if (existing && ((existing as any).completedAt || new Date((existing as any).startedAt).getTime() > Date.now() - STALE_CLAIM_MS)) {
        continue
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
