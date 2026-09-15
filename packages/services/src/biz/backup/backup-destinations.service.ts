/**
 * FR-13.48–13.59 (#24) — shipping a verified bundle somewhere that is not this cluster.
 *
 * **The gap this closes.** Layer 2 writes its bundles to `<UPLOAD_DIR>/<orgId>/backups/`,
 * which is a node-local hostPath on `k8s-worker-2` — the same node the live database sits on.
 * A per-org bundle that never leaves it protects against a bad migration and against nothing
 * else. This is the step that makes it a backup.
 *
 * **Order matters and is the whole design**: seal → pre-flight the quota → upload → verify →
 * prune. Each step exists because of a specific way the naive version fails:
 *
 *  1. **Seal first.** A bundle holds every tenant-scoped collection — `User` rows whose
 *     `password` is not `select: false`, every contact's tax ID, and `orgs`. Nothing goes to
 *     a third party in the clear (FR-13.23), and for Drive doubly so: `orgs` is where a Drive
 *     credential lives, so an unsealed bundle would ship the key to the backup inside the
 *     backup (FR-13.56).
 *  2. **Pre-flight the quota.** A free Google account is 15 GB shared with Gmail and Photos.
 *     Refusing up front with a clear message beats failing mid-transfer (FR-13.57).
 *  3. **Upload, resumably, and never record a partial one.** The adapter throws rather than
 *     returning what it managed to write (FR-13.52).
 *  4. **Verify by reading the artifact BACK.** An upload that returns 200 and stores nothing
 *     readable is exactly the failure §1.1 of the FR was written about — roomler's uploads
 *     backup has produced zero snapshots since installation and its verify job noticed every
 *     night, into a log nobody reads.
 *  5. **Prune last, by counted generations.** Never before, or a night that fails to produce
 *     a new copy can still have removed an old one; never by age, or a run of failed nights
 *     deletes the last good copy (FR-13.8/13.59).
 */

import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { config } from 'config'
import { logger } from '../../logger/logger.js'
import {
  googleDriveAdapter,
  refreshGoogleAccessToken,
  CloudReconsentRequired,
  type CloudTokens,
} from '../cloud-storage.service.js'
import { sealBundle } from './backup-crypto.js'
import type { BackupBundleManifest } from './backup-bundle.types.js'

/** What a run records about one destination. Persisted on `BackupRun.destinations`. */
export interface BackupDestinationResult {
  name: string
  /**
   * ⚠ `reached` is the ONLY value that counts as a copy existing. `reconsent_required` is
   * broken out from `failed` because it is the one failure that will never fix itself: a
   * retry tonight fails identically until a human re-consents (FR-13.54).
   */
  status: 'reached' | 'failed' | 'skipped' | 'reconsent_required'
  at: Date
  reason?: string
  remoteId?: string
  filename?: string
  bytes?: number
  /** SHA-256 over the SEALED artifact as uploaded — what a remote verification re-hashes. */
  sha256?: string
  verified?: boolean
  prunedCount?: number
}

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex')

/** `lgr-<slug>-<kind>-<YYYY-MM-DD>.ndjson.zst.sealed` — FR-13.59's naming, plus the seal. */
export function remoteArtifactName(localFilename: string): string {
  return `${localFilename}.sealed`
}

export function driveEnabled(): boolean {
  return Boolean(config.backup.googleDrive.refreshToken && config.backup.encryptionPublicKey)
}

/**
 * Why the Drive destination is not being attempted, in words an operator can act on.
 *
 * ⚠ Returned as a `skipped` result rather than silently doing nothing. "No destination was
 * configured" and "the destination was configured and did not work" are different states, and
 * a digest that cannot tell them apart teaches people to ignore it.
 */
function driveSkipReason(): string | null {
  if (!config.backup.googleDrive.refreshToken) {
    return 'google drive is not connected — no refresh token is configured (BACKUP_GOOGLE_DRIVE_REFRESH_TOKEN)'
  }
  if (!config.backup.encryptionPublicKey) {
    // Deliberately fatal to the upload rather than a warning that ships plaintext anyway.
    return 'no backup encryption recipient is configured — a bundle must not leave the cluster unsealed (FR-13.23)'
  }
  // ⚠ Checks the pair the upload ACTUALLY refreshes with — `config.backup.googleDrive`, which
  // prefers BACKUP_GOOGLE_DRIVE_CLIENT_ID/SECRET and only falls back to GOOGLE_CLIENT_ID.
  // Reading `config.integrations.google` here (as this did) reported a correctly configured
  // dedicated Drive client as "not connected", and the nightly job then skipped every night.
  if (!config.backup.googleDrive.clientId || !config.backup.googleDrive.clientSecret) {
    return 'google drive is not connected — the OAuth client id/secret are unset ' +
      '(BACKUP_GOOGLE_DRIVE_CLIENT_ID / BACKUP_GOOGLE_DRIVE_CLIENT_SECRET, or GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)'
  }
  return null
}

/**
 * The one root folder in the connected Drive that this application owns.
 *
 * ⚠ Validated rather than trusted. `BACKUP_GOOGLE_DRIVE_FOLDER=` (empty), `/`, or a value with
 * a separator in it would each resolve to My Drive's root, and the nightly job would then
 * scatter sealed bundles across the account it was given — beside whatever else lives there,
 * with a credential that can delete. Refusing the misconfiguration is the difference between a
 * destination that fails loudly and one that quietly writes to the wrong place (FR-13.56).
 */
export function driveRootFolder(): string {
  return assertSingleFolderName(config.backup.googleDrive.folderName, 'BACKUP_GOOGLE_DRIVE_FOLDER')
}

/**
 * The same validation, for any caller that owns its own root — the archive tree does.
 *
 * ⚠ Shared deliberately. A second root added without this check reintroduces exactly the
 * failure the first one guards: an empty or `/`-bearing name resolves to My Drive's root and
 * the job scatters sealed artifacts across the account, with a credential that can delete.
 */
export function assertSingleFolderName(value: string | undefined, envName: string): string {
  const configured = (value || '').trim()
  if (!configured || configured === '/' || configured === '.' || configured === '..' || configured.includes('/')) {
    throw new Error(
      `google drive: ${envName} is ${JSON.stringify(value)}, ` +
      'which would put files in My Drive root instead of one owned folder — set it to a single folder name',
    )
  }
  return configured
}

interface PushOptions {
  orgId: string
  manifest: BackupBundleManifest
  absolutePath: string
  filename: string
  /** SHA-256 of the UNSEALED artifact, as recorded on the run. Travels in `appProperties`. */
  sha256: string
  /** Read the artifact back after uploading and compare checksums. */
  verify?: boolean
  keep?: number
  /**
   * Which subtree of the owned root this artifact belongs to — see `DRIVE_SECTION`.
   * Defaults to `Backups`.
   */
  section?: string
}

/**
 * The two subtrees inside the one Drive folder this application owns.
 *
 * ⚠ Backups and archives rotate on completely different rules: 14 kept generations against a
 * TEN-YEAR legal retention (ЗСч чл. 12; payroll fifty). Mixed in one tree they invite exactly
 * one mistake — a prune, or a human tidying up, treating a fiscal year's only cold copy as an
 * old backup. Separating them makes the difference visible in the Drive UI before anyone has
 * to reason about it.
 *
 * ⚠ Still ONE root, not two. `drive.file` limits the token to files this app created, and a
 * single owned root is what makes that boundary legible to the human looking at the Drive
 * (FR-13.56). Two top-level folders would blur it for no gain.
 */
export const DRIVE_SECTION = {
  backups: 'Backups',
  archive: 'Archive',
} as const

/**
 * Seal one bundle and put it on Google Drive.
 *
 * Never throws: every failure is a reportable outcome. A backup RUN that succeeded must not be
 * marked failed because a destination was unreachable — the bundle exists, is verified and is
 * on the PV; what is missing is the off-site copy, and that is what the result says.
 */
export async function pushBundleToDrive(opts: PushOptions): Promise<BackupDestinationResult> {
  const at = new Date()
  const skip = driveSkipReason()
  if (skip) return { name: 'google_drive', status: 'skipped', at, reason: skip }

  const gd = config.backup.googleDrive
  const remoteName = remoteArtifactName(opts.filename)

  try {
    // ── 1. A fresh access token, always ──────────────────────────────────────
    // Access tokens last about an hour, so a nightly job ALWAYS starts with an expired one.
    // This is the normal path, not an error branch (FR-13.54).
    const { accessToken } = await refreshGoogleAccessToken(gd.refreshToken, {
      clientId: gd.clientId,
      clientSecret: gd.clientSecret,
    })
    const tokens: CloudTokens = { accessToken, refreshToken: gd.refreshToken }

    // ── 2. Seal ──────────────────────────────────────────────────────────────
    const plain = await readFile(opts.absolutePath)
    const sealed = sealBundle(plain, config.backup.encryptionPublicKey)
    const sealedSha = sha256(sealed)

    // ── 3. Quota pre-flight ──────────────────────────────────────────────────
    // ⚠ An unreadable quota is a WARNING, not a refusal. Declining to back up because the
    // free-space figure could not be read would turn a missing number into a missing backup.
    let quotaNote: string | undefined
    try {
      const quota = await googleDriveAdapter.getQuota(tokens)
      if (quota.free !== undefined) {
        const need = sealed.length + gd.minFreeBytes
        if (quota.free < need) {
          return {
            name: 'google_drive',
            status: 'failed',
            at,
            filename: remoteName,
            bytes: sealed.length,
            reason: `google drive has ${(quota.free / 1024 / 1024).toFixed(1)} MB free but this upload needs ` +
              `${(need / 1024 / 1024).toFixed(1)} MB including headroom — refused before transferring anything (FR-13.57)`,
          }
        }
      } else {
        quotaNote = 'the drive reported no storage limit (an unlimited account); no quota pre-flight was possible'
      }
    } catch (e: any) {
      quotaNote = `the storage quota could not be read (${e?.message}); proceeding without a pre-flight`
      logger.warn({ orgId: opts.orgId, err: e?.message }, 'Backup: Drive quota pre-flight failed')
    }

    // ── 4. Upload ────────────────────────────────────────────────────────────
    // One dedicated tree per org and kind (FR-13.59). Dedicated because the folder must not be
    // shared with anything else: the credential that writes here can also delete (FR-13.56).
    // `<root>/Backups/<org>/<kind>` or `<root>/Archive/<org>/<fiscal year>`.
    //
    // ⚠ The section sits ABOVE the org, not below it. Below, every org would grow its own
    // pair of subtrees and the Drive would have to be read org by org to answer "is anything
    // archived?" — the question an operator actually asks.
    const folderId = await googleDriveAdapter.ensureFolder(tokens, [
      driveRootFolder(),
      opts.section || DRIVE_SECTION.backups,
      opts.manifest.orgSlug || String(opts.orgId),
      opts.manifest.kind,
    ])

    const uploaded = await googleDriveAdapter.uploadFile(tokens, folderId, remoteName, sealed, {
      mimeType: 'application/octet-stream',
      // FR-13.59 — self-describing on the remote side. `appProperties` values are strings.
      properties: {
        lgrFormat: opts.manifest.format,
        orgSlug: opts.manifest.orgSlug || '',
        kind: opts.manifest.kind,
        date: opts.manifest.date,
        bundleSha256: opts.sha256,
        sealedSha256: sealedSha,
        documentCount: String(opts.manifest.documentCount),
        coversFrom: opts.manifest.coversFrom || '',
        coversTo: opts.manifest.coversTo || '',
        appImageTag: opts.manifest.appImageTag,
      },
    })

    // ── 5. Read it back ──────────────────────────────────────────────────────
    let verified: boolean | undefined
    if (opts.verify) {
      const back = await googleDriveAdapter.downloadFile(tokens, uploaded.id)
      if (sha256(back) !== sealedSha) {
        // ⚠ Do NOT delete the bad remote copy. It is evidence, and a second upload can be
        // attempted alongside it; silently removing the only trace of a corruption is how a
        // storage-side fault stays invisible.
        return {
          name: 'google_drive',
          status: 'failed',
          at,
          filename: remoteName,
          remoteId: uploaded.id,
          bytes: sealed.length,
          sha256: sealedSha,
          verified: false,
          reason: 'the artifact read back from google drive does not match what was uploaded',
        }
      }
      verified = true
    }

    // ── 6. Retention, last ───────────────────────────────────────────────────
    const prunedCount = await pruneDriveGenerations(tokens, folderId, opts.keep ?? gd.keep)

    logger.info(
      { orgId: opts.orgId, file: remoteName, bytes: sealed.length, verified, prunedCount },
      'Backup: bundle uploaded to Google Drive',
    )
    return {
      name: 'google_drive',
      status: 'reached',
      at,
      filename: remoteName,
      remoteId: uploaded.id,
      bytes: sealed.length,
      sha256: sealedSha,
      verified,
      prunedCount,
      reason: quotaNote,
    }
  } catch (e: any) {
    if (e instanceof CloudReconsentRequired) {
      // ⚠ Its own status, and NOT counted as reached. This one never recovers by itself.
      logger.error({ orgId: opts.orgId }, 'Backup: the Google Drive refresh token is dead — re-consent required')
      return { name: 'google_drive', status: 'reconsent_required', at, reason: e.message }
    }
    logger.error({ orgId: opts.orgId, err: e?.message }, 'Backup: the Google Drive upload failed')
    return { name: 'google_drive', status: 'failed', at, filename: remoteName, reason: e?.message || 'upload failed' }
  }
}

/**
 * Keep the `keep` newest artifacts in one folder; delete the rest.
 *
 * Names carry the date (`lgr-<slug>-<kind>-<YYYY-MM-DD>.…`) and the folder is per org AND per
 * kind, so lexical order is chronological and a run of deltas cannot evict a full.
 *
 * ⚠ Counted, never aged. `keep` is floored at 1 so a misconfigured `0` cannot empty the
 * folder, and a pruning failure is logged rather than thrown: retention is housekeeping, and
 * failing a completed upload over it would be the tail wagging the dog.
 */
export async function pruneDriveGenerations(tokens: CloudTokens, folderId: string, keep: number): Promise<number> {
  try {
    const files = (await googleDriveAdapter.listFiles(tokens, folderId))
      .filter(f => f.mimeType !== 'application/vnd.google-apps.folder')
      .sort((a, b) => (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))

    const victims = files.slice(Math.max(keep, 1))
    let removed = 0
    for (const v of victims) {
      try {
        await googleDriveAdapter.deleteFile(tokens, v.id)
        removed++
      } catch (e: any) {
        logger.warn({ file: v.name, err: e?.message }, 'Backup: could not prune a Drive artifact')
      }
    }
    return removed
  } catch (e: any) {
    logger.warn({ err: e?.message }, 'Backup: Drive retention could not run')
    return 0
  }
}

// ── Tier 3b — object storage, the copy a leaked token cannot delete ──────────────
//
// ⚠ This exists because of ONE property Drive does not have. Everything above ships a sealed
// artifact to a destination whose credential can also delete it, so a stolen refresh token, a
// buggy rotation or a human tidying a Drive can remove the off-site copy — and the artifact
// that has to survive all three is the ten-year archive (ЗСч чл. 12; payroll fifty), not last
// night's bundle. S3 with versioning plus Object Lock refuses the delete, to the writing key
// and to the account root alike. That is why `scope` defaults to `archive` rather than to
// everything: retention is the point, and retention applied to a nightly rotation is a bill.

/** Is object storage configured at ALL? Absent is a valid deployment, not a misconfiguration. */
export function s3Configured(): boolean {
  const s = config.backup.s3
  return Boolean(s.endpoint && s.bucket && s.accessKeyId && s.secretAccessKey)
}

export function s3Enabled(): boolean {
  return s3Configured() && config.backup.s3.scope !== 'off' && Boolean(config.backup.encryptionPublicKey)
}

/**
 * Why object storage is not being used, in words an operator can act on — or `null` when it is.
 *
 * ⚠ Returns `null` for a deployment that has not configured S3 at all, and the caller then
 * omits the destination entirely rather than reporting it `skipped`. That is the one place
 * this file departs from "never be silent": a permanent "s3 is not configured" line in every
 * digest of every Drive-only deployment teaches people to skim the section, and the fact it
 * would be repeating — that this bundle has no off-site copy — is already a banner of its own.
 * A HALF-configured S3 is different and is always reported: that is somebody's unfinished
 * intention, and it is the state in which an operator believes they have a copy.
 */
export function s3SkipReason(): string | null {
  const s = config.backup.s3
  if (!s3Configured()) return null
  if (s.scope === 'off') return 'object storage is configured but BACKUP_S3_SCOPE=off'
  if (!config.backup.encryptionPublicKey) {
    return 'no backup encryption recipient is configured — a bundle must not leave the cluster unsealed (FR-13.23)'
  }
  return null
}

/** `<prefix>/<section>/<org>/<kind>/<artifact>.sealed` — the Drive tree, flattened into keys. */
export function s3KeyFor(opts: PushOptions): string {
  const parts = [
    config.backup.s3.prefix.replace(/^\/+|\/+$/g, ''),
    opts.section || DRIVE_SECTION.backups,
    opts.manifest.orgSlug || String(opts.orgId),
    opts.manifest.kind,
    remoteArtifactName(opts.filename),
  ]
  return parts.filter(Boolean).map(p => String(p).replace(/[^A-Za-z0-9._\- ]/g, '-')).join('/')
}

/**
 * Seal one artifact and put it in the bucket.
 *
 * Never throws — same contract as the Drive push, for the same reason: a run whose bundle is
 * built, verified and on the PV is a completed run, and an unreachable destination is a
 * recorded gap rather than grounds to throw the work away.
 */
export async function pushBundleToS3(opts: PushOptions): Promise<BackupDestinationResult | null> {
  const at = new Date()
  if (!s3Configured()) return null
  const skip = s3SkipReason()
  if (skip) return { name: 's3', status: 'skipped', at, reason: skip }

  const s = config.backup.s3
  const key = s3KeyFor(opts)

  try {
    const { putObject, getObject, listObjects, deleteObject } = await import('./s3-client.js')
    const cfg = {
      endpoint: s.endpoint, region: s.region, bucket: s.bucket,
      accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey,
      forcePathStyle: s.forcePathStyle,
    }

    const plain = await readFile(opts.absolutePath)
    const sealed = sealBundle(plain, config.backup.encryptionPublicKey)
    const sealedSha = sha256(sealed)

    const put = await putObject(cfg, key, sealed, {
      contentType: 'application/octet-stream',
      lock: s.objectLockMode ? { mode: s.objectLockMode, years: s.objectLockYears } : undefined,
      // The same self-description `appProperties` carries on Drive, so an operator holding
      // only the bucket can tell what an object is without opening it — which they cannot do,
      // since the private half of the seal key is not on any cluster node.
      metadata: {
        'lgr-format': opts.manifest.format,
        'org-slug': opts.manifest.orgSlug || '',
        kind: opts.manifest.kind,
        date: opts.manifest.date,
        'bundle-sha256': opts.sha256,
        'sealed-sha256': sealedSha,
        'document-count': String(opts.manifest.documentCount),
        'app-image-tag': opts.manifest.appImageTag,
      },
    })

    // Read it back — the same rule as Drive. "The API returned 200" is not "the bytes are
    // there", and §1.1's whole cautionary tale is a backup job that reported success nightly
    // while storing nothing.
    let verified: boolean | undefined
    if (opts.verify) {
      const back = await getObject(cfg, key)
      if (sha256(back) !== sealedSha) {
        return {
          name: 's3', status: 'failed', at, filename: key, bytes: sealed.length,
          sha256: sealedSha, verified: false,
          reason: 'the object read back from object storage does not match what was uploaded',
        }
      }
      verified = true
    }

    // ⚠ Retention here is OFF by default and is skipped outright under a lock. `keep: 0` means
    // keep everything, which for the tier that exists to satisfy a ten-year obligation is the
    // correct policy; and under Object Lock the delete would be refused anyway, so attempting
    // it nightly would turn a working destination into a nightly error.
    let prunedCount: number | undefined
    // ⚠ An ARCHIVE is never pruned from this tier, whatever `keep` the Drive push was given.
    // The two destinations hold the same artifact for opposite reasons — Drive keeps a working
    // copy, this keeps the legal one — and a generation count borrowed from the first would
    // delete a fiscal year from the second. Ten years is not a rotation.
    const keep = (opts.section || DRIVE_SECTION.backups) === DRIVE_SECTION.archive ? 0 : (opts.keep ?? s.keep)
    if (keep > 0 && !s.objectLockMode) {
      const folder = key.slice(0, key.lastIndexOf('/') + 1)
      try {
        const existing = (await listObjects(cfg, folder))
          .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0))
        prunedCount = 0
        for (const victim of existing.slice(Math.max(keep, 1))) {
          try {
            await deleteObject(cfg, victim.key)
            prunedCount++
          } catch (e: any) {
            logger.warn({ key: victim.key, err: e?.message }, 'Backup: could not prune an S3 object')
          }
        }
      } catch (e: any) {
        logger.warn({ err: e?.message }, 'Backup: S3 retention could not run')
      }
    }

    logger.info(
      { orgId: opts.orgId, key, bytes: sealed.length, verified, prunedCount, retainUntil: put.retainUntil },
      'Backup: bundle uploaded to object storage',
    )
    return {
      name: 's3', status: 'reached', at, filename: key, remoteId: put.etag,
      bytes: sealed.length, sha256: sealedSha, verified, prunedCount,
      reason: put.retainUntil
        ? `retained under ${s.objectLockMode} object lock until ${put.retainUntil.slice(0, 10)}`
        : undefined,
    }
  } catch (e: any) {
    logger.error({ orgId: opts.orgId, key, err: e?.message }, 'Backup: the object-storage upload failed')
    return { name: 's3', status: 'failed', at, filename: key, reason: e?.message || 'upload failed' }
  }
}

/**
 * Every destination this run should attempt, in order.
 *
 * ⚠ Drive first, object storage second, and both are attempted even when the first fails: they
 * are not a fallback chain. Two destinations that can fail independently is the entire point —
 * one is convenient and deletable, the other is locked and dull.
 *
 * ⚠ Object storage takes the NIGHTLY bundle only when `BACKUP_S3_SCOPE=all`. Its default is
 * `archive`, because the property being paid for is write-once retention and applying that to
 * a 14-generation rotation means buying storage that cannot be reclaimed.
 */
export async function pushToDestinations(opts: PushOptions): Promise<BackupDestinationResult[]> {
  const out: BackupDestinationResult[] = [await pushBundleToDrive(opts)]
  if (config.backup.s3.scope === 'all') {
    const s3 = await pushBundleToS3(opts)
    if (s3) out.push(s3)
  }
  return out
}

/**
 * Both tiers for an artifact that must outlive its own retention policy — the yearly archive.
 *
 * Used by `archive.service.ts`. Object storage participates here whenever it is configured and
 * not switched `off`, because this is the copy FR-13.58 says SHOULD be on storage Drive cannot
 * provide: ten years of legal retention against a destination whose writing credential can
 * delete everything it ever wrote.
 */
export async function pushArchiveToDestinations(opts: PushOptions): Promise<BackupDestinationResult[]> {
  const out: BackupDestinationResult[] = []
  if (driveEnabled()) {
    out.push(await pushBundleToDrive(opts))
  } else {
    out.push({
      name: 'google_drive', status: 'skipped', at: new Date(),
      reason: driveSkipReason() || 'no off-site destination is configured',
    })
  }
  if (config.backup.s3.scope !== 'off') {
    const s3 = await pushBundleToS3(opts)
    if (s3) out.push(s3)
  }
  return out
}
