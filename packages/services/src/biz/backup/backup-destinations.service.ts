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
  const configured = (config.backup.googleDrive.folderName || '').trim()
  if (!configured || configured === '/' || configured === '.' || configured === '..' || configured.includes('/')) {
    throw new Error(
      `google drive: BACKUP_GOOGLE_DRIVE_FOLDER is ${JSON.stringify(config.backup.googleDrive.folderName)}, ` +
      'which would put backups in My Drive root instead of one owned folder — set it to a single folder name',
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
}

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
    const folderId = await googleDriveAdapter.ensureFolder(tokens, [
      driveRootFolder(),
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

/**
 * Every destination this run should attempt, in order.
 *
 * A single-entry list today, and deliberately shaped as a list: FR-13.58 recommends keeping
 * the yearly cold tier on object storage as well, because Drive has no Object Lock — the same
 * credential that writes can delete, where S3 with versioning cannot.
 */
export async function pushToDestinations(opts: PushOptions): Promise<BackupDestinationResult[]> {
  return [await pushBundleToDrive(opts)]
}
