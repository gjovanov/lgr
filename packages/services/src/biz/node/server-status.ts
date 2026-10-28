/**
 * A master's own status page (FR-20.98, FR-20.50, plan step P3-8b), for an org's admins on the
 * server itself, offline above all, when nothing of it reaches lgrai.app:
 * - **the supervisor**, as it last wrote itself (`state/status.json`, every 30 s): its version, its
 *   children (mongod, the API), the uplink's two sockets and the mirror's pacing, the update, the
 *   data volume and the oplog's reach. Older than two minutes, the page says the supervisor is not
 *   writing;
 * - **the org on this server**: whether it is written here, its journal and how far lgrai.app's copy
 *   holds it (as lgrai.app last said, `/self`), its last backup, what waits for the internet, its
 *   fiscal devices and its desktops;
 * - **the Прил. 32 fields** (FR-20.50, т. 5, 7, 10–13), ready to copy: the trader re-files them within
 *   seven days of a change of topology (чл. 52з(1)). With them, where an inspector reaches the server
 *   (FR-20.47, P3-8e: `inspection.service.ts`).
 *
 * ⚠ One server may hold several orgs: an org's admin sees this org's licence, backups and devices,
 * never another's.
 */
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { config, nodeRole } from 'config'
import { mongoose } from 'db/connection'
import { BackupRun, Desktop, FiscalDevice, OrgHome, Outbox, ReplOrg } from 'db/models'
import { thisNode } from 'db/home/home'
import { currentLan } from '../desktop/desktop.service.js'
import { lastSelfAnswer } from '../home/series-lock.service.js'
import { captureOn } from '../replication/engine.js'
import { inspectionOf, inspectionView, type TunnelReach } from './inspection.service.js'

/** A status file older than this: the supervisor is not writing it. */
const STALE_MS = 2 * 60_000
/** A desktop seen this recently is online. */
const ONLINE_MS = 5 * 60_000

const oid = (v: string) => new mongoose.Types.ObjectId(v)

function statusFile(): string | null {
  const token = config.outbox.tokenFile
  return token ? join(dirname(token), 'status.json') : null
}

/** host:port of the database, as the API reaches it: what Прил. 32 calls the DB address. */
function databaseAddress(): string | null {
  try {
    const u = new URL(config.mongodb.uri)
    return u.host || null
  } catch {
    return null
  }
}

/** What the supervisor last wrote of itself, or null. */
async function readSupervisor(): Promise<any> {
  const file = statusFile()
  try {
    return file ? JSON.parse(await readFile(file, 'utf8')) : null
  } catch {
    return null
  }
}

function reachOf(sup: any, orgId: string): TunnelReach {
  const org = (lastSelfAnswer()?.body?.orgs ?? []).find((o: any) => o?.id === orgId)
  return { linkLevel: sup?.registration?.linkLevel ?? null, address: typeof org?.address === 'string' ? org.address : null }
}

/** FR-20.47 (P3-8e): what the server offers for the tunnel now: its link, and the org's address. */
export async function tunnelReach(orgId: string): Promise<TunnelReach> {
  return reachOf(await readSupervisor(), orgId)
}

export async function serverStatus(orgId: string, now = new Date()): Promise<Record<string, unknown> | null> {
  if (nodeRole() !== 'master' || !/^[0-9a-f]{24}$/.test(orgId)) return null
  const sup = await readSupervisor()
  const writtenAt = sup?.writtenAt ? new Date(sup.writtenAt) : null
  const org = oid(orgId)
  const [home, repl, backup, outboxQueued, devices, desktops, inspection]: [any, any, any, number, any[], any[], Awaited<ReturnType<typeof inspectionOf>>] = await Promise.all([
    OrgHome.findOne({ orgId: org }, { home: 1, epoch: 1, state: 1, seriesFrozen: 1 }).lean(),
    ReplOrg.findOne({ orgId: org }, { seq: 1, reconciledEpoch: 1 }).lean(),
    BackupRun.findOne({ orgId: org, status: 'completed', completedAt: { $exists: true } }, { completedAt: 1 }).sort({ completedAt: -1 }).lean(),
    Outbox.countDocuments({ orgId: org, state: { $in: ['queued', 'sending'] } }),
    FiscalDevice.find({ orgId: org, isActive: { $ne: false } }, { name: 1, deviceNumber: 1, manufacturer: 1, connectionType: 1, status: 1 }).lean(),
    Desktop.find({ orgId: org, status: 'active' }, { name: 1, lastSeenAt: 1 }).lean(),
    inspectionOf(orgId),
  ])
  const self = lastSelfAnswer()
  const mirror = (self?.body?.mirrors ?? []).find((m: any) => m.orgId === orgId) ?? null
  const head = Number(repl?.seq ?? 0)
  const watermark = mirror ? Number(mirror.watermark ?? 0) : null
  const online = desktops.filter(d => d.lastSeenAt && now.getTime() - new Date(d.lastSeenAt).getTime() < ONLINE_MS).length
  // This org's own, never another's on the same server.
  const held = (Array.isArray(sup?.licences) ? sup.licences : []).find((l: any) => l?.orgId === orgId) ?? null
  const licence = held ? { plan: held.plan ?? null, paidThrough: held.paidThrough ?? null, graceDays: held.graceDays ?? null, error: held.error ?? null } : null
  const u = sup?.update
  const update = u && typeof u === 'object'
    ? { state: u.state ?? null, running: u.running ?? null, available: u.available ?? null, reason: u.reason ?? null, blockedWindows: u.blockedWindows ?? 0, alarm: !!u.alarm, supto: u.supto ?? null, suptoWaiting: u.suptoWaiting ?? null }
    : null
  // Where desktops reach it, as the supervisor publishes it (FR-20.30): what pairing codes name.
  const lanUrl = currentLan().url ?? null
  return {
    supervisor: sup
      ? {
          version: sup.version ?? null,
          uptimeSecs: sup.uptimeSecs ?? null,
          writtenAt,
          fresh: !!writtenAt && now.getTime() - writtenAt.getTime() < STALE_MS,
          children: (sup.children ?? []).map((c: any) => ({ name: c.name, state: c.state, failures: c.failures ?? 0 })),
          uplink: {
            interactive: sup.uplink?.interactive?.state ?? null,
            bulk: sup.uplink?.bulk?.state ?? null,
            pacing: sup.uplink?.bulk?.pacing ?? null,
          },
          update,
          disk: sup.disk ?? null,
          oplogWindowSecs: sup.oplogWindowSecs ?? null,
          linkLevel: sup.registration?.linkLevel ?? null,
        }
      : null,
    org: {
      home: home ? { here: home.home === thisNode(), state: home.state, epoch: home.epoch, numberingLocked: !!home.seriesFrozen?.since } : null,
      capture: captureOn(),
      journalHead: head,
      // As lgrai.app last said it: null when it has not been heard from this start.
      mirror: mirror ? { watermark, behind: Math.max(0, head - (watermark ?? 0)), lastPageAt: mirror.lastPageAt ?? null, heardAt: self!.at } : null,
      lastBackupAt: backup?.completedAt ?? null,
      outboxQueued,
      licence,
      fiscalDevices: devices.map(d => ({ name: d.name, deviceNumber: d.deviceNumber, manufacturer: d.manufacturer, connectionType: d.connectionType, status: d.status })),
      desktops: { active: desktops.length, online },
    },
    // FR-20.50: what the trader's Прил. 32 asks of the installation, as this server is now.
    pril32: {
      installation: 'lan',
      host: hostname(),
      lanUrl,
      databaseAddress: databaseAddress(),
      database: 'MongoDB',
      mirror: sup?.registration?.server ?? null,
      linkLevel: sup?.registration?.linkLevel ?? null,
      desktops: desktops.length,
      version: sup?.version ?? null,
      // FR-20.50: the SUPTO version that runs, as the supervisor says it.
      supto: u?.supto ?? null,
      // FR-20.47 (P3-8e): where an inspector reaches this server (Н-18 чл. 52и(1)).
      inspection: inspectionView(inspection, reachOf(sup, orgId)),
    },
  }
}
