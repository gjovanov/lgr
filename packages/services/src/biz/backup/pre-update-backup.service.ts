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

export async function backupBeforeUpdate(now = new Date()): Promise<PreUpdateBackup> {
  const orgs = await Org.find({ ...(await homeScope('_id')) }, { _id: 1, slug: 1, settings: 1 }).lean().exec()
  // One stamp for the whole run: the bundles of one update share it, and it sorts after the night's.
  const stamp = `pre-update-${now.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}`
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
