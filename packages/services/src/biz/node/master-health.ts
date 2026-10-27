/**
 * What a master's health frame says of its orgs, beside the machine (FR-20.98–20.101, plan step
 * P3-8): read by the supervisor through the control socket's status, once a minute, and carried to
 * lgrai.app, which raises the alarms (`node-alarms.ts`).
 *
 * - `lastBackupAt`: the newest completed backup of any org written here. FR-20.101: older than 26
 *   hours is an alarm.
 * - `fenced`: the orgs this server is fenced for (a promotion made lgrai.app their home while it was
 *   away, P3-6d). FR-20.101: a fenced master is an alarm, until a person deals with what it holds.
 * - `outboxQueued`: what waits to go to the internet (mail, documents to read, FR-20.100).
 */
import { nodeRole } from 'config'
import { BackupRun, OrgHome, Outbox } from 'db/models'
import { thisNode } from 'db/home/home'

export interface MasterHealth {
  lastBackupAt: string | null
  fenced: number
  outboxQueued: number
}

export async function masterHealth(): Promise<MasterHealth | null> {
  if (nodeRole() !== 'master') return null
  const homes: any[] = await OrgHome.find({ home: thisNode() }, { orgId: 1, state: 1 }).lean()
  const [last, outboxQueued]: [any, number] = await Promise.all([
    homes.length
      ? BackupRun.findOne({ orgId: { $in: homes.map(h => h.orgId) }, status: 'completed', completedAt: { $exists: true } }, { completedAt: 1 }).sort({ completedAt: -1 }).lean()
      : null,
    Outbox.countDocuments({ state: { $in: ['queued', 'sending'] } }),
  ])
  return {
    lastBackupAt: last?.completedAt ? new Date(last.completedAt).toISOString() : null,
    fenced: homes.filter(h => h.state === 'fenced').length,
    outboxQueued,
  }
}
