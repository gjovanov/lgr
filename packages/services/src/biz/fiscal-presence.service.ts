import { hostname } from 'node:os'
import { mongoose } from 'db/connection'
import { FiscalDevice, FiscalPresence, type FiscalHolderKind, type IFiscalPresence } from 'db/models'
import { homeScope } from 'db/home/home'

/**
 * FR-24.45–24.48: who holds a fiscal device, across every pod (`fiscal_presence`).
 *
 * The row is claimed when a bridge registers (or the server opens a TCP device), heartbeated every
 * `HEARTBEAT_MS` by the holder, and released when it lets go. Reads (`connected`, "connected via")
 * come from live rows, so a sibling pod's bridge counts, and a crashed pod's row stops counting
 * after `DEAD_MS`.
 */

export const HEARTBEAT_MS = 5_000
export const DEAD_MS = 20_000

/**
 * This process, as the rows name it: its host and its process id. ⚠ Not the hostname alone: two
 * processes on one machine (a test's two pods, a developer's) share it, and each would read the
 * other's rows as its own and never forward. In Kubernetes the hostname is the pod's name.
 */
export const POD_ID = `${hostname()}#${process.pid}`

export interface FiscalHolder {
  kind: FiscalHolderKind
  label: string
  userId?: string
  desktopId?: string
  instanceId?: string
}

export interface PresenceKey {
  orgId: string
  deviceNumber: string
}

let indexes: Promise<unknown> | null = null
function indexesReady(): Promise<unknown> {
  indexes ??= FiscalPresence.init().catch((e) => { indexes = null; throw e })
  return indexes
}

/** A row that has heartbeated within `DEAD_MS`. */
export function isLive(row: Pick<IFiscalPresence, 'heartbeatAt'> | null | undefined, now = Date.now()): boolean {
  return !!row && now - new Date(row.heartbeatAt).getTime() <= DEAD_MS
}

const liveSince = (now = Date.now()) => new Date(now - DEAD_MS)

/**
 * The same principal as the row's, reconnecting: it takes its own row over at once.
 * ⚠ A browser tab is recognised by its `instanceId` only. Two tabs of the same cashier are two
 * principals, and only one of them may hold the port.
 */
function samePrincipal(row: IFiscalPresence, holder: FiscalHolder): boolean {
  if (row.kind !== holder.kind) return false
  if (holder.kind === 'desktop') return !!holder.desktopId && row.desktopId === holder.desktopId
  if (holder.kind === 'user') return !!holder.instanceId && row.instanceId === holder.instanceId
  return holder.kind === 'server' && row.podId === POD_ID
}

export type ClaimResult =
  | { ok: true; previous: IFiscalPresence | null }
  | { ok: false; holder: IFiscalPresence }

/**
 * Claim a device for this connection. Succeeds when nobody holds it, when the holder's row is dead,
 * when the holder is this same principal reconnecting, or when `takeover` is asked for (an admin;
 * the caller checks the right). `previous` is the row that was replaced, so the caller can evict a
 * socket of its own or audit the takeover.
 */
export async function claimPresence(
  key: PresenceKey & { deviceId: string },
  holder: FiscalHolder,
  conn: { connId: string; podAddr?: string | null },
  opts: { takeover?: boolean } = {},
): Promise<ClaimResult> {
  // ⚠ The unique index IS the rule: wait until it exists (Mongoose builds indexes in the background).
  await indexesReady()
  const now = new Date()
  const doc = {
    orgId: new mongoose.Types.ObjectId(key.orgId),
    deviceNumber: key.deviceNumber,
    deviceId: new mongoose.Types.ObjectId(key.deviceId),
    kind: holder.kind,
    label: holder.label,
    ...(holder.userId ? { userId: holder.userId } : {}),
    ...(holder.desktopId ? { desktopId: holder.desktopId } : {}),
    ...(holder.instanceId ? { instanceId: holder.instanceId } : {}),
    podId: POD_ID,
    ...(conn.podAddr ? { podAddr: conn.podAddr } : {}),
    connId: conn.connId,
    connectedAt: now,
    heartbeatAt: now,
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await FiscalPresence.create(doc)
      return { ok: true, previous: null }
    } catch (e: any) {
      if (e?.code !== 11000) throw e
    }
    const row = await FiscalPresence.findOne({ orgId: doc.orgId, deviceNumber: key.deviceNumber }).exec()
    if (!row) continue // released between the insert and the read: try again
    if (row.connId === conn.connId) return { ok: true, previous: null } // a re-register of this very connection
    if (isLive(row, now.getTime()) && !samePrincipal(row, holder) && !opts.takeover) return { ok: false, holder: row }
    // Replace only the row we read: if someone else replaced it meanwhile, read again.
    const replaced = await FiscalPresence.replaceOne({ _id: row._id, connId: row.connId }, doc).exec()
    if (replaced.matchedCount === 1) return { ok: true, previous: row }
  }
  const row = await FiscalPresence.findOne({ orgId: doc.orgId, deviceNumber: key.deviceNumber }).exec()
  return row ? { ok: false, holder: row } : { ok: true, previous: null }
}

/** Why a holder lost its row: another connection has it, or someone asked it to let go. */
export type LostReason = { connId: string; reason: 'taken_over' | 'released' | string; by?: string }

/**
 * The holder's heartbeat. Returns the connections that no longer own their row, with why: the row
 * names another connection (taken over), carries an `evict` (a revocation or a takeover decided on
 * another pod), or is gone.
 */
export async function heartbeatPresence(held: Array<PresenceKey & { connId: string }>): Promise<LostReason[]> {
  const now = new Date()
  const lost: LostReason[] = []
  for (const h of held) {
    const res = await FiscalPresence.updateOne(
      { orgId: new mongoose.Types.ObjectId(h.orgId), deviceNumber: h.deviceNumber, connId: h.connId, evict: { $exists: false } },
      { $set: { heartbeatAt: now } },
    ).exec()
    if (res.matchedCount === 1) continue
    const row = await FiscalPresence.findOne({ orgId: new mongoose.Types.ObjectId(h.orgId), deviceNumber: h.deviceNumber }).lean().exec()
    if (row && row.connId === h.connId && row.evict) lost.push({ connId: h.connId, reason: row.evict.reason })
    else if (row) lost.push({ connId: h.connId, reason: 'taken_over', by: row.label })
    else lost.push({ connId: h.connId, reason: 'released' })
  }
  return lost
}

/** Let go of a device, only while the row is still this connection's. */
export async function releasePresence(key: PresenceKey, connId: string): Promise<boolean> {
  const res = await FiscalPresence.deleteOne({ orgId: new mongoose.Types.ObjectId(key.orgId), deviceNumber: key.deviceNumber, connId }).exec()
  return res.deletedCount === 1
}

/** Ask the holders of these rows to let go; each acts on its next heartbeat (FR-24.48). */
export async function requestEviction(filter: { desktopId?: string; orgId?: string; deviceNumber?: string }, reason: string): Promise<number> {
  const q: Record<string, unknown> = {}
  if (filter.desktopId) q.desktopId = filter.desktopId
  if (filter.orgId) q.orgId = new mongoose.Types.ObjectId(filter.orgId)
  if (filter.deviceNumber) q.deviceNumber = filter.deviceNumber
  if (!Object.keys(q).length) return 0
  const res = await FiscalPresence.updateMany(q, { $set: { evict: { reason, at: new Date() } } }).exec()
  return res.modifiedCount
}

/** The live row of a device, or null. */
export async function livePresence(key: PresenceKey): Promise<IFiscalPresence | null> {
  return FiscalPresence.findOne({
    orgId: new mongoose.Types.ObjectId(key.orgId),
    deviceNumber: key.deviceNumber,
    heartbeatAt: { $gte: liveSince() },
  }).lean().exec() as any
}

/** Every live row of an org, by device number: what a device list reads once for all its rows. */
export async function livePresenceByDevice(orgId: string): Promise<Map<string, IFiscalPresence>> {
  const rows = await FiscalPresence.find({ orgId: new mongoose.Types.ObjectId(orgId), heartbeatAt: { $gte: liveSince() } }).lean().exec()
  return new Map(rows.map((r: any) => [String(r.deviceNumber), r]))
}

/** What the POS prints as "connected via …" (FR-14.27), from a live row. */
export function holderOf(row: IFiscalPresence | null | undefined): { kind: 'user' | 'desktop'; label: string; desktopId?: string } | null {
  if (!row || row.kind === 'server') return null
  return row.kind === 'desktop' ? { kind: 'desktop', label: row.label, desktopId: row.desktopId } : { kind: 'user', label: row.label }
}

/**
 * FR-24.46: a device marked `online` that no live row holds is `offline`. It replaces the reset a
 * starting pod ran over every device, which with two pods marked offline the devices its sibling
 * held. Idempotent; scoped to the orgs whose home is here (FR-20.5). Returns how many it marked.
 */
export async function markUnheldDevicesOffline(): Promise<number> {
  const online = await FiscalDevice.find({ status: 'online', ...(await homeScope()) }, { _id: 1, orgId: 1, deviceNumber: 1 }).lean().exec()
  if (!online.length) return 0
  const live = await FiscalPresence.find(
    { deviceId: { $in: online.map((d: any) => d._id) }, heartbeatAt: { $gte: liveSince() } },
    { deviceId: 1 },
  ).lean().exec()
  const held = new Set(live.map((r: any) => String(r.deviceId)))
  const unheld = online.filter((d: any) => !held.has(String(d._id))).map((d: any) => d._id)
  if (!unheld.length) return 0
  const res = await FiscalDevice.updateMany({ _id: { $in: unheld }, status: 'online' }, { status: 'offline' }).exec()
  return res.modifiedCount
}
