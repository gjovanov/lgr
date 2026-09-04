/**
 * FR-13.6 (#24) — reading what the Layer-1 backup jobs reported.
 *
 * **Why a file and not an endpoint.** The backup jobs run on mars, on the host, outside the
 * cluster; this process runs inside it. `verify-backups.sh` publishes one small JSON document
 * onto the uploads PV, which both sides already reach — mars over the same SSH key its uploads
 * rotation uses, the app as an ordinary path under `UPLOAD_DIR`. That avoids opening an
 * inbound route for an unattended shell script to authenticate against, and nothing under
 * `UPLOAD_DIR` is served statically (FR-13.24).
 *
 * **Why absence is a failure.** roomler's uploads backup has produced zero snapshots since it
 * was installed. The cron ran, its verify job detected it, and nobody read either output. So
 * every way of learning nothing — no directory, no file, a stale file, unparseable JSON —
 * comes back `healthy: false` with a reason, and the digest renders it as a failure line.
 * There is no code path here that turns silence into good news.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { config } from 'config'
import { BackupRun } from 'db/models'
import type {
  DigestBackups,
  DigestBackupCheck,
  DigestOrgBackupRun,
} from '../digest/daily-digest.types.js'

/** The file `verify-backups.sh` writes, resolved the same way the script resolves it. */
export function backupStatusDir(): string {
  return config.backup.statusDir || join(config.upload.dir, '.backup-status')
}

function hoursSince(iso: unknown): number | undefined {
  const t = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(t)) return undefined
  return Math.max(0, Math.round((Date.now() - t) / 3_600_000))
}

function nonPassing(checks: unknown): DigestBackupCheck[] {
  if (!Array.isArray(checks)) return []
  return checks
    .filter((c: any) => c && c.result !== 'pass')
    .map((c: any) => ({
      check: String(c.check || ''),
      result: c.result === 'fail' ? 'fail' : 'warn',
      detail: String(c.detail || '').slice(0, 300),
    }))
}

function gap(reason: DigestBackups['gap']): DigestBackups {
  return { healthy: false, gap: reason, failures: [], checkCount: 0 }
}

/**
 * Read the latest verification report.
 *
 * Never throws: every failure to read is itself a reportable state. The caller wraps this in
 * the digest's `section()` helper anyway, but a thrown error there renders as "this section
 * could not be built", which is weaker and less honest than "no backup has been reported".
 */
export async function readBackupStatus(maxAgeHours = config.backup.statusMaxAgeHours): Promise<DigestBackups> {
  let raw: string
  try {
    raw = await readFile(join(backupStatusDir(), 'verify.json'), 'utf8')
  } catch (e: any) {
    // ENOENT covers both "the directory was never created" and "the push has never landed".
    return gap(e?.code === 'ENOENT' ? 'never_reported' : 'unreadable')
  }

  let doc: any
  try {
    doc = JSON.parse(raw)
  } catch {
    return gap('unreadable')
  }
  if (!doc || typeof doc !== 'object' || !doc.at) return gap('unreadable')

  const reportAgeHours = hoursSince(doc.at)
  if (reportAgeHours === undefined) return gap('unreadable')

  const detail = doc.detail || {}
  const summary = detail.summary || {}
  const failures = nonPassing(detail.checks)

  const out: DigestBackups = {
    // A report older than the window means verification stopped running, which tells us
    // nothing about the backups themselves — so it cannot be reported as healthy.
    healthy: reportAgeHours <= maxAgeHours && doc.result === 'ok',
    reportedAt: String(doc.at),
    reportAgeHours,
    host: doc.host ? String(doc.host) : undefined,
    failures,
    checkCount: Array.isArray(detail.checks) ? detail.checks.length : 0,
  }
  if (reportAgeHours > maxAgeHours) out.gap = 'stale'

  if (summary.latestFull?.artifact) {
    out.latestFull = {
      artifact: String(summary.latestFull.artifact),
      bytes: Number(summary.latestFull.bytes) || 0,
      ageHours: Number(summary.latestFull.ageHours) || 0,
    }
  }
  if (summary.generations) {
    out.generations = {
      daily: Number(summary.generations.daily) || 0,
      weekly: Number(summary.generations.weekly) || 0,
      monthly: Number(summary.generations.monthly) || 0,
      yearly: Number(summary.generations.yearly) || 0,
    }
  }
  if (summary.uploads) {
    out.uploads = {
      snapshots: Number(summary.uploads.snapshots) || 0,
      files: Number(summary.uploads.files) || 0,
      ageHours: Number(summary.uploads.ageHours) || 0,
    }
  }
  if (summary.delta) {
    out.delta = {
      slices: Number(summary.delta.slices) || 0,
      ageHours: Number(summary.delta.ageHours) || 0,
    }
  }
  if (summary.offsite) {
    out.offsite = {
      reached: Array.isArray(summary.offsite.reached) ? summary.offsite.reached.map(String) : [],
      ageHours: Number(summary.offsite.ageHours) || 0,
    }
  }

  const lr = detail.lastRestore
  if (lr && lr.at) {
    out.lastRestore = {
      result: lr.result === 'pass' ? 'pass' : 'fail',
      at: String(lr.at),
      collections: Number(lr.collections) || undefined,
      seconds: Number(lr.seconds) || undefined,
    }
  }

  return out
}

/**
 * This org's own most recent Layer-2 bundle run.
 *
 * ⚠ Separate from everything above, and that separation is the point. `verify.json` describes
 * the CLUSTER's Layer-1 dumps, published from mars. It cannot say anything about whether one
 * org's per-org bundle ran, so before this the Layer-2 scheduler could fail for a given org
 * every night indefinitely and the only trace would be a `logger.error` — the exact shape of
 * failure FR-13.6 was written to make impossible.
 *
 * Never throws, for the same reason `readBackupStatus` never throws: a section that cannot be
 * built is a weaker and less honest statement than one that reports what is wrong.
 */
export async function readOrgBackupRun(orgId: string): Promise<DigestOrgBackupRun | undefined> {
  try {
    const run: any = await BackupRun.findOne({ orgId })
      .sort({ startedAt: -1 })
      .lean()
      .exec()
    if (!run) return undefined

    const started = new Date(run.startedAt).getTime()
    return {
      status: run.status === 'completed' ? 'completed' : run.status === 'failed' ? 'failed' : 'running',
      date: String(run.date || ''),
      kind: run.kind === 'delta' ? 'delta' : 'full',
      bytes: run.bytes || undefined,
      documentCount: run.documentCount || undefined,
      sha256: run.sha256 || undefined,
      reason: run.reason || undefined,
      attempts: run.attempts || undefined,
      maxAttempts: config.backup.maxAttemptsPerDay,
      emailed: run.emailed,
      emailSkippedReason: run.emailSkippedReason || undefined,
      ageHours: Number.isFinite(started)
        ? Math.max(0, Math.round((Date.now() - started) / 3_600_000))
        : undefined,
    }
  } catch {
    return undefined
  }
}
