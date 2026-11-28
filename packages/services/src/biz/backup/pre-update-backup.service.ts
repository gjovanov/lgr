import { randomBytes } from 'node:crypto'
import { Org } from 'db/models'
import { homeScope } from 'db/home/home'
import { runBackupForOrg } from './backup-runner.service.js'
import { orgLocalParts } from '../digest/digest-time.js'

/**
 * FR-20.20 (plan step P1-8d): the backup a master takes before it switches to a new version.
 *
 * "A backup first, then migrations, then a health check." The update helper asks for it, through
 * the supervisor and this API's control socket, after the new version is downloaded and verified
 * and just before the switch: the OLD version, which is known to work, backs up the data the new
 * one is about to migrate. No backup, no switch (the helper's rule): the version stays installed
 * and is switched to in a later window.
 *
 * - Every org homed on this node, each its own bundle: the rows (`variant: 'data'`), which is what
 *   a migration changes. The files are not touched by one, and the nightly run carries them.
 * - Written where every backup goes (the PV and its local copy, FR-20.21, then the off-site
 *   destinations) under its own claim and file name, so it never takes or overwrites a night's.
 * - Mailed to nobody: an update a week would otherwise put a sealed bundle in the digest
 *   recipient's inbox each time.
 */
export interface PreUpdateBackup {
  ok: boolean
  runs: Array<{ orgId: string; slug?: string; status: string; reason?: string; filename?: string; bytes?: number }>
}

/**
 * The stamp of one backup before an update, which names both its claim and its file (#981).
 *
 * ⚠ Unique to each call, not just to its second. The run is forced, and two forced builders on one
 * claim and one file race: the second takes the first one's claim over and writes the same file,
 * and the row's recorded sha256 may then describe neither. The update helper asks once per switch,
 * but `lgr-server backup now` can be asked twice within a second. The field lanes did that, and the
 * second backup wrote over the first one's file. The milliseconds and a random tail make each
 * stamp unique, and the second still comes first, so the stamps sort as they did.
 */
export function preUpdateStamp(now: Date, tail = randomBytes(3).toString('hex')): string {
  const iso = now.toISOString()
  return `pre-update-${iso.slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${iso.slice(20, 23)}-${tail}`
}

export async function backupBeforeUpdate(now = new Date()): Promise<PreUpdateBackup> {
  const orgs = await Org.find({ ...(await homeScope('_id')) }, { _id: 1, slug: 1, settings: 1 }).lean().exec()
  // One stamp for the whole run: the bundles of one update share it, and no other run does.
  const stamp = preUpdateStamp(now)
  const runs: PreUpdateBackup['runs'] = []
  for (const org of orgs as any[]) {
    const orgId = String(org._id)
    try {
      const { date } = orgLocalParts(now, org.settings?.timezone || 'UTC')
      const outcome: any = await runBackupForOrg(orgId, date, {
        kind: 'full',
        variant: 'data',
        source: 'manual',
        force: true,
        claimKey: stamp,
        filenameSuffix: stamp,
        mail: false,
      })
      runs.push({
        orgId,
        slug: org.slug,
        status: outcome?.status ?? 'not_run',
        reason: outcome?.reason,
        filename: outcome?.filename,
        bytes: outcome?.bytes,
      })
    } catch (e: any) {
      runs.push({ orgId, slug: org.slug, status: 'failed', reason: e?.message || 'the backup failed' })
    }
  }
  return { ok: runs.every(r => r.status !== 'failed' && r.status !== 'not_run'), runs }
}
