import { NodeTraffic, type TrafficCarries, type TrafficChannel } from 'db/models'
import { logger } from '../../logger/logger.js'

/**
 * Global's record of what each registered master sent it (FR-20.54, AC 26): per UTC day, per link
 * level, per channel and per kind of message, how many and how many bytes. Global only.
 *
 * - **Counted in memory, written every 30 s** (the `node-traffic` scheduler, on every pod, and once
 *   more on a graceful stop): one upsert per row that grew, so a frame costs a map entry. Rows from
 *   several pods add up (`$inc`).
 * - ⚠ **A kind comes from a closed list, never from what the master wrote**: a master must not be
 *   able to grow the collection or name its own rows. Anything else is `other`, and carries
 *   `unknown`, which AC 26 reads as data until the list says otherwise.
 * - **Only an authenticated master's traffic is counted**: frames after its `hello`, requests that
 *   carried a valid node token. Registration and token requests carry no org data, and could not be
 *   attributed before they succeed.
 */

/** What each kind of uplink frame carries. The binary frames are `page`, `blob` and `tun-data`. */
const FRAME_CARRIES: Readonly<Record<string, TrafficCarries>> = {
  hello: 'control',
  ping: 'control',
  health: 'control',
  'blob-sync': 'mirror',
  'blob-unavailable': 'mirror',
  page: 'mirror',
  blob: 'mirror',
  'tun-head': 'tunnel',
  'tun-credit': 'tunnel',
  'tun-error': 'tunnel',
  'tun-ws-open': 'tunnel',
  'tun-ws-close': 'tunnel',
  'tun-data': 'tunnel',
}

/**
 * What each node API route carries, by `METHOD /route` below `/api/node/v1` as the router names it.
 * Control is FR-20.54's first two rows: the licence, updates, health, the clock, "Sign in with LGR"
 * and the identity feed, and the master's account of its orgs (`/org-state`, counts and heads).
 */
const ROUTE_CARRIES: Readonly<Record<string, TrafficCarries>> = {
  'GET /desktop-release': 'control',
  'GET /server-release': 'control',
  'GET /server-release/:version/:file': 'control',
  'POST /idp/redeem': 'control',
  'GET /identity-changes': 'control',
  'GET /credential-changes': 'control',
  'GET /moves': 'control',
  'GET /legal-series': 'control',
  'POST /org-state': 'control',
  'GET /self': 'control',
  'DELETE /self': 'control',
  'POST /relay/mail': 'mail',
  'POST /relay/documents': 'documents',
  'GET /relay/documents/:requestId': 'documents',
  'GET /moves/:id/fenced-export': 'move',
  'PUT /moves/:id/fenced-export': 'move',
  'GET /moves/:id/:part': 'move',
  'POST /moves/:id/copied': 'move',
  'POST /moves/:id/drained': 'move',
  'POST /moves/:id/failed': 'move',
  'GET /reconcile/ids': 'mirror',
  'POST /reconcile/done': 'mirror',
}

const OTHER = 'other'

/** The kind a frame or a route is counted as, and what it carries. */
export function trafficKind(channel: TrafficChannel, name: string): { kind: string; carries: TrafficCarries } {
  const table = channel === 'http' ? ROUTE_CARRIES : FRAME_CARRIES
  const carries = Object.hasOwn(table, name) ? table[name] : undefined
  return carries ? { kind: name, carries } : { kind: OTHER, carries: 'unknown' }
}

/** `POST /api/node/v1/relay/mail` → `POST /relay/mail`: the route as `ROUTE_CARRIES` names it. */
export function nodeRouteName(method: string, route: string): string {
  const at = route.indexOf('/node/v1')
  return `${method.toUpperCase()} ${at < 0 ? route : route.slice(at + '/node/v1'.length) || '/'}`
}

interface Tally {
  nodeId: string
  day: string
  level: string
  channel: TrafficChannel
  kind: string
  carries: TrafficCarries
  n: number
  bytes: number
  firstAt: Date
  lastAt: Date
}

const pending = new Map<string, Tally>()
/** A pod that cannot write keeps at most this many rows waiting; past it, new rows are dropped and said so. */
export const MAX_PENDING = 10_000
let dropped = 0

/** Count one frame or request from a master. `name` is the frame's type or the route (`nodeRouteName`). */
export function countTraffic(nodeId: string, level: string | null | undefined, channel: TrafficChannel, name: string, bytes: number, at = new Date()): void {
  const { kind, carries } = trafficKind(channel, name)
  const day = at.toISOString().slice(0, 10)
  const lvl = level || 'unknown'
  const id = `${nodeId}|${day}|${lvl}|${channel}|${kind}`
  const size = Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0
  const t = pending.get(id)
  if (t) {
    t.n++
    t.bytes += size
    t.lastAt = at
    return
  }
  if (pending.size >= MAX_PENDING) {
    dropped++
    return
  }
  pending.set(id, { nodeId, day, level: lvl, channel, kind, carries, n: 1, bytes: size, firstAt: at, lastAt: at })
}

let flushing: Promise<number> | null = null

/** Write what was counted since the last flush. A failed write keeps its rows for the next one. Returns the rows written. */
export function flushTraffic(): Promise<number> {
  // One at a time: the scheduler and a graceful stop may both ask.
  flushing ??= writePending().finally(() => { flushing = null })
  return flushing
}

async function writePending(): Promise<number> {
  if (dropped) {
    logger.warn({ dropped }, 'Node traffic: rows were dropped while the record could not be written')
    dropped = 0
  }
  if (!pending.size) return 0
  const rows = [...pending.entries()]
  pending.clear()
  try {
    await NodeTraffic.bulkWrite(
      rows.map(([id, t]) => ({
        updateOne: {
          filter: { _id: id },
          update: {
            $setOnInsert: { nodeId: t.nodeId, day: t.day, level: t.level, channel: t.channel, kind: t.kind, carries: t.carries },
            $inc: { n: t.n, bytes: t.bytes },
            $min: { firstAt: t.firstAt },
            $max: { lastAt: t.lastAt },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    )
    return rows.length
  } catch (e) {
    // Back into the tally, added to what arrived meanwhile: the next flush tries again.
    for (const [id, t] of rows) {
      const now = pending.get(id)
      if (now) {
        now.n += t.n
        now.bytes += t.bytes
        if (t.firstAt < now.firstAt) now.firstAt = t.firstAt
        if (t.lastAt > now.lastAt) now.lastAt = t.lastAt
      } else if (pending.size < MAX_PENDING) {
        pending.set(id, t)
      } else {
        dropped++
      }
    }
    throw e
  }
}

export interface NodeTrafficRow {
  day: string
  level: string
  channel: TrafficChannel
  kind: string
  carries: TrafficCarries
  n: number
  bytes: number
  firstAt: Date
  lastAt: Date
}

/**
 * A master's record, newest day first: one UTC day (`YYYY-MM-DD`), or the last `days` days (at most
 * 90, what the record keeps). What this pod counted and has not written yet is written first.
 */
export async function trafficOf(nodeId: string, opts: { day?: string; days?: number } = {}): Promise<NodeTrafficRow[]> {
  await flushTraffic().catch(e => logger.warn({ err: e instanceof Error ? e.message : String(e) }, 'Node traffic: not written before a read'))
  let day: unknown
  if (opts.day) {
    day = opts.day
  } else {
    const days = Math.min(Math.max(Math.floor(opts.days ?? 7), 1), 90)
    day = { $gte: new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10) }
  }
  const rows = await NodeTraffic.find({ nodeId, day }, { _id: 0, nodeId: 0 }).sort({ day: -1, level: 1, channel: 1, kind: 1 }).limit(5000).lean()
  return rows as unknown as NodeTrafficRow[]
}

/** Tests only: what is counted and not written yet. */
export function pendingTraffic(): number {
  return pending.size
}
