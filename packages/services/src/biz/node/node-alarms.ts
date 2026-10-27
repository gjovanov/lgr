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
 *
 * ⚠ A health frame older than ten minutes says nothing about now: the alarms read from it are not
 * raised (the server being away is what the Servers page's connection says).
 */
import { MirrorState, OrgHome, ServerNode } from 'db/models'
import { presenceOfNodes } from './node.service.js'

export type NodeAlarmKind = 'mirror_lag' | 'backup_stale' | 'disk_low' | 'oplog_short' | 'fenced' | 'clock_skew' | 'supto_waiting'

export interface NodeAlarm {
  kind: NodeAlarmKind
  /** Seconds behind (lag, backup, skew), seconds the oplog reaches, the free percentage, or how many orgs. */
  value: number | null
  /** The org it is about, for a mirror's lag. */
  orgId?: string
  /** The SUPTO version an update waits for. */
  detail?: string
}

export const ALARM_AT = {
  lagSecs: 3600,
  backupSecs: 26 * 3600,
  diskFreePct: 10,
  oplogSecs: 7 * 86400,
  skewSecs: 120,
  healthFreshMs: 10 * 60_000,
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
  return out
}

/** The alarms of each of `nodes`, its presence and its orgs' mirrors read in a few queries. */
export async function alarmsOfNodes(nodes: any[], now = new Date()): Promise<Map<string, NodeAlarm[]>> {
  const ids = nodes.map(n => String(n._id))
  const [connected, homes] = await Promise.all([presenceOfNodes(ids), OrgHome.find({ home: { $in: ids } }, { orgId: 1, home: 1 }).lean()])
  const mirrors: any[] = homes.length ? await MirrorState.find({ orgId: { $in: (homes as any[]).map(h => h.orgId) } }, { orgId: 1, watermark: 1, lastPageAt: 1 }).lean() : []
  const byOrg = new Map(mirrors.map(m => [String(m.orgId), m]))
  const out = new Map<string, NodeAlarm[]>()
  for (const n of nodes) {
    const mine = (homes as any[]).filter(h => h.home === String(n._id)).map(h => byOrg.get(String(h.orgId)) ?? { orgId: h.orgId })
    out.set(String(n._id), nodeAlarms({ node: n, connected: connected.get(String(n._id)), mirrors: mine, now }))
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
