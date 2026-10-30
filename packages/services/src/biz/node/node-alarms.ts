/**
 * FR-20.101 (plan step P3-8): the alarms a master raises, read off what lgrai.app holds of it: its
 * last health frame (`ServerNode.health`, kept by `sanitizeHealth`), whether its sockets are up, its
 * own account of the orgs it writes (`ServerNode.orgState`, P3-7c), and lgrai.app's mirrors of them.
 *
 * - **Mirror lag** over an hour while the uplink is up: the server holds journal the mirror has not
 *   applied (its reported head past the watermark) and no page has been applied for an hour.
 * - **Backup** older than 26 hours; none at all once the server has served its orgs that long.
 * - **Disk** under 10 % free.
 * - **Oplog** reaching back less than seven days. Only once it wraps: until then nothing is lost
 *   however long a capture stops (the supervisor sends no window).
 * - **Fenced**: the server is fenced for some org (lgrai.app's copy was promoted while it was away).
 * - **Clock** more than two minutes off lgrai.app's.
 * - **A SUPTO version waiting for its declaration** (P3-8c, FR-20.50): an update the server holds
 *   because its SUPTO version is not declared to НАП yet.
 * - **Orgs on hold** (P3-8d, FR-20.3): lgrai.app holds orgs of the server, homed on it or of which it
 *   reported a newer home record, until a sys-admin settles them (`home-hold.service.ts`).
 * - **An address conflict** (#356, #380): another machine claims the server's LAN address, seen in the
 *   last 15 minutes (the record outlives the conflict; while it goes on, it is renewed every few
 *   minutes). `detail` is `probable_clone` when an advert named the server there from another start: a
 *   copy of its disk, two machines issuing one series of legal numbers. Still not proven, so nothing
 *   locks (only the TLS proof, `lan_clone`, does).
 *
 * ⚠ A health frame older than ten minutes says nothing about now: the alarms read from it are not
 * raised (the server being away is what the Servers page's connection says).
 */
import { MirrorState, OrgHome, ServerNode } from 'db/models'
import { presenceOfNodes } from './node.service.js'

export type NodeAlarmKind = 'mirror_lag' | 'backup_stale' | 'disk_low' | 'oplog_short' | 'fenced' | 'clock_skew' | 'supto_waiting' | 'home_hold' | 'address_conflict'

export interface NodeAlarm {
  kind: NodeAlarmKind
  /** Seconds behind (lag, backup, skew), seconds the oplog reaches, the free percentage, or how many orgs. */
  value: number | null
  /** The org it is about, for a mirror's lag. */
  orgId?: string
  /** The SUPTO version an update waits for; `probable_clone` for an address conflict that is probably one. */
  detail?: string
}

export const ALARM_AT = {
  lagSecs: 3600,
  backupSecs: 26 * 3600,
  diskFreePct: 10,
  oplogSecs: 7 * 86400,
  skewSecs: 120,
  healthFreshMs: 10 * 60_000,
  conflictSecs: 15 * 60,
}

export interface AlarmInput {
  node: { health?: any; enrolledAt?: Date | string; orgState?: Array<{ orgId: unknown; head?: number }> }
  connected: { interactive?: boolean; bulk?: boolean } | undefined
  /** lgrai.app's mirrors of the orgs the server is home of. */
  mirrors: Array<{ orgId: unknown; watermark?: number; lastPageAt?: Date | string | null }>
  now: Date
}

const secsSince = (v: unknown, now: Date) => {
  const t = v ? new Date(v as any).getTime() : Number.NaN
  return Number.isFinite(t) ? Math.max(0, Math.round((now.getTime() - t) / 1000)) : null
}

export function nodeAlarms({ node, connected, mirrors, now }: AlarmInput): NodeAlarm[] {
  const out: NodeAlarm[] = []
  if (connected?.bulk) {
    const heads = new Map((node.orgState ?? []).map(o => [String(o.orgId), Number(o.head ?? 0)]))
    for (const m of mirrors) {
      const head = heads.get(String(m.orgId))
      const since = secsSince(m.lastPageAt, now)
      if (head !== undefined && head > Number(m.watermark ?? 0) && since !== null && since > ALARM_AT.lagSecs) {
        out.push({ kind: 'mirror_lag', value: since, orgId: String(m.orgId) })
      }
    }
  }
  const h = node.health
  const healthAge = h?.at ? now.getTime() - new Date(h.at).getTime() : Number.POSITIVE_INFINITY
  if (!h || healthAge > ALARM_AT.healthFreshMs) return out
  const backup = secsSince(h.api?.lastBackupAt, now)
  if (backup !== null ? backup > ALARM_AT.backupSecs : mirrors.length > 0 && (secsSince(node.enrolledAt, now) ?? 0) > ALARM_AT.backupSecs) {
    out.push({ kind: 'backup_stale', value: backup })
  }
  const free = Number(h.disk?.freeBytes)
  const total = Number(h.disk?.totalBytes)
  if (Number.isFinite(free) && Number.isFinite(total) && total > 0 && (free / total) * 100 < ALARM_AT.diskFreePct) {
    out.push({ kind: 'disk_low', value: Math.round((free / total) * 1000) / 10 })
  }
  if (typeof h.oplogWindowSecs === 'number' && h.oplogWindowSecs < ALARM_AT.oplogSecs) out.push({ kind: 'oplog_short', value: h.oplogWindowSecs })
  if (typeof h.api?.fenced === 'number' && h.api.fenced > 0) out.push({ kind: 'fenced', value: h.api.fenced })
  if (typeof h.clockSkewSecs === 'number' && Math.abs(h.clockSkewSecs) > ALARM_AT.skewSecs) out.push({ kind: 'clock_skew', value: h.clockSkewSecs })
  if (typeof h.update?.suptoWaiting === 'string') out.push({ kind: 'supto_waiting', value: null, detail: h.update.suptoWaiting })
  const conflict = h.address?.conflict
  const conflictAge = secsSince(conflict?.at, now)
  if (conflict && conflictAge !== null && conflictAge <= ALARM_AT.conflictSecs) {
    out.push({ kind: 'address_conflict', value: null, ...(conflict.probableClone ? { detail: 'probable_clone' } : {}) })
  }
  return out
}

/** The alarms of each of `nodes`, its presence and its orgs' mirrors read in a few queries. */
export async function alarmsOfNodes(nodes: any[], now = new Date()): Promise<Map<string, NodeAlarm[]>> {
  const ids = nodes.map(n => String(n._id))
  const [connected, homes, held] = await Promise.all([
    presenceOfNodes(ids),
    OrgHome.find({ home: { $in: ids } }, { orgId: 1, home: 1 }).lean(),
    // FR-20.3: orgs lgrai.app holds, homed on a server or claimed by one.
    OrgHome.find({ state: 'hold', $or: [{ home: { $in: ids } }, { 'hold.claim.nodeId': { $in: ids } }] }, { orgId: 1, home: 1, 'hold.claim.nodeId': 1 }).lean(),
  ])
  const mirrors: any[] = homes.length ? await MirrorState.find({ orgId: { $in: (homes as any[]).map(h => h.orgId) } }, { orgId: 1, watermark: 1, lastPageAt: 1 }).lean() : []
  const byOrg = new Map(mirrors.map(m => [String(m.orgId), m]))
  const out = new Map<string, NodeAlarm[]>()
  for (const n of nodes) {
    const mine = (homes as any[]).filter(h => h.home === String(n._id)).map(h => byOrg.get(String(h.orgId)) ?? { orgId: h.orgId })
    const alarms = nodeAlarms({ node: n, connected: connected.get(String(n._id)), mirrors: mine, now })
    const holds = (held as any[]).filter(h => h.home === String(n._id) || h.hold?.claim?.nodeId === String(n._id)).length
    if (holds) alarms.push({ kind: 'home_hold', value: holds })
    out.set(String(n._id), alarms)
  }
  return out
}

/** One server's alarms, for the Servers page of one of its orgs (a lag only that org's). */
export async function alarmsOfNode(nodeId: string, orgId: string, now = new Date()): Promise<NodeAlarm[]> {
  const n: any = await ServerNode.findById(nodeId).lean()
  if (!n) return []
  const all = (await alarmsOfNodes([n], now)).get(nodeId) ?? []
  return all.filter(a => a.kind !== 'mirror_lag' || a.orgId === orgId)
}
