/**
 * An org's home record fails closed on lgrai.app (FR-20.3, plan step P3-8d): when global's record of
 * who writes an org may be older than the truth, global stops writing the org (`hold`) until the
 * record is settled. `homeOf` already derives a hold from the record itself (a missing row after a
 * move, a row that disagrees with `Org.homeEpochHighWater`); these are the holds global TAKES:
 *
 * - **`higher_epoch`** — a master registered for the org reports a newer home record than global's:
 *   global's database is older than the org's last move (a disaster-recovery restore from a dump
 *   that predates it). Global must not go on writing an org a master writes, so it holds it, and the
 *   Nodes page raises it. Only a sys-admin settles it: adopt the server's record, or release.
 * - **`dr_restore`** — after a disaster-recovery restore of global (FR-13 Layer 1), every org that
 *   has a server goes on hold: the runbook's step, right after `mongorestore` (Nodes page → Hold
 *   after a restore, `POST /api/admin/nodes/held/after-restore`). A hold of an org homed on a server
 *   is released when that server reconnects and reports the same record; an org homed on global is
 *   released by a sys-admin. Masters that are connected need not wait for it: their next report
 *   (every minute) holds any org whose record is newer than the dump.
 *
 * ⚠ A hold never changes who is home or the epoch: it only stops writes. Releasing restores the state
 * the row had (`hold.from`). Adopting is the one path that rewrites the record, and only to a record a
 * server registered for the org reported itself.
 * ⚠ Global's audit log cannot take these: the org is on hold, so nothing of its data is written here.
 * The row keeps the last release (`released`), and the log line says who.
 */
import { nodeRole } from 'config'
import { forgetAllHomes, homeOf } from 'db/home/home'
import { Org, OrgHome, ServerNode } from 'db/models'
import { mongoose } from 'db/connection'
import { logger } from '../../logger/logger.js'

export type HoldReason = 'dr_restore' | 'higher_epoch'

const oid = (v: unknown) => new mongoose.Types.ObjectId(String(v))
const isOrgId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{24}$/.test(v)

export interface ReportedHome {
  orgId: string
  epoch: number
}

/**
 * What a master says of the orgs it is home of, every minute (`POST /api/node/v1/org-state`), against
 * global's own record. A newer epoch holds the org; the same record releases a `dr_restore` hold of an
 * org homed on that server. Only orgs the server is registered for count: a server cannot hold
 * another org's. Returns how many it held and released.
 */
export async function noteReportedHomes(node: { _id: unknown; orgIds?: unknown[]; status?: string }, reported: ReportedHome[], now = new Date()): Promise<{ held: number; released: number }> {
  const out = { held: 0, released: 0 }
  if (nodeRole() !== 'global' || node.status === 'revoked') return out
  const nodeId = String(node._id)
  const mine = new Set((node.orgIds ?? []).map(String))
  for (const r of reported) {
    if (!isOrgId(r.orgId) || !mine.has(r.orgId) || !Number.isSafeInteger(r.epoch) || r.epoch < 1) continue
    const orgId = oid(r.orgId)
    const [row, org]: [any, any] = await Promise.all([
      OrgHome.findOne({ orgId }).lean(),
      Org.findById(orgId, { homeEpochHighWater: 1 }).lean(),
    ])
    const known = Math.max(Number(row?.epoch ?? 0), Number(org?.homeEpochHighWater ?? 0))
    if (r.epoch > known) {
      const claim = { nodeId, epoch: r.epoch, at: now }
      if (row?.hold?.reason === 'higher_epoch') {
        // Held already: only a newer claim is news.
        if (Number(row.hold.claim?.epoch ?? 0) < r.epoch) await OrgHome.updateOne({ _id: row._id }, { $set: { 'hold.claim': claim } })
        continue
      }
      const from = row ? (row.state === 'hold' ? (row.hold?.from ?? 'active') : row.state) : 'active'
      const hold = { reason: 'higher_epoch' as const, since: now, from, claim, detail: `${nodeId} reports home epoch ${r.epoch}; this database knows ${known}` }
      if (row) await OrgHome.updateOne({ _id: row._id }, { $set: { state: 'hold', hold } })
      else await OrgHome.updateOne({ orgId }, { $setOnInsert: { orgId, home: 'global', epoch: 0, since: now }, $set: { state: 'hold', hold } }, { upsert: true })
      forgetAllHomes()
      out.held++
      logger.error({ orgId: r.orgId, nodeId, epoch: r.epoch, known }, 'A server reports a newer home record than lgrai.app holds: the org is on hold until a sys-admin settles it (FR-20.3)')
      continue
    }
    if (row?.state === 'hold' && row.hold?.reason === 'dr_restore' && row.home === nodeId && Number(row.epoch) === r.epoch) {
      const released = { at: now, by: nodeId, how: 'reconnected', reason: 'dr_restore' }
      const res = await OrgHome.updateOne({ _id: row._id, state: 'hold', 'hold.reason': 'dr_restore' }, { $set: { state: row.hold.from ?? 'active', released }, $unset: { hold: '' } })
      if (res.modifiedCount) {
        forgetAllHomes()
        out.released++
        logger.info({ orgId: r.orgId, nodeId, epoch: r.epoch }, 'The org\'s server reconnected with the home record lgrai.app holds: its restore hold is released (FR-20.3)')
      }
    }
  }
  return out
}

/**
 * The runbook's step after a disaster-recovery restore of global (FR-13 Layer 1): every org that has
 * a server, or ever had one, goes on hold — its server's record may be newer than the dump. Already
 * held ones are left as they are. A dry run (`execute: false`) says what it would hold.
 */
export async function holdAfterRestore(opts: { execute?: boolean; now?: Date } = {}): Promise<{ orgs: string[]; held: number }> {
  if (nodeRole() !== 'global') return { orgs: [], held: 0 }
  const now = opts.now ?? new Date()
  const [rows, moved, nodes]: [any[], any[], any[]] = await Promise.all([
    OrgHome.find({}, { orgId: 1, state: 1 }).lean(),
    Org.find({ homeEpochHighWater: { $exists: true } }, { homeEpochHighWater: 1 }).lean(),
    ServerNode.find({ status: { $ne: 'revoked' } }, { orgIds: 1 }).lean(),
  ])
  const byOrg = new Map(rows.map(r => [String(r.orgId), r]))
  const highWater = new Map(moved.map(o => [String(o._id), Number(o.homeEpochHighWater ?? 0)]))
  const targets = new Set<string>([...byOrg.keys(), ...highWater.keys(), ...nodes.flatMap(n => (n.orgIds ?? []).map(String))])
  let held = 0
  const orgs = [...targets].filter(isOrgId).sort()
  for (const id of orgs) {
    const row = byOrg.get(id)
    if (row?.state === 'hold') continue
    if (opts.execute) {
      const hold = { reason: 'dr_restore' as const, since: now, from: row?.state ?? 'active', detail: 'a disaster-recovery restore of lgrai.app: the org\'s server may hold a newer record' }
      if (row) await OrgHome.updateOne({ _id: row._id, state: { $ne: 'hold' } }, { $set: { state: 'hold', hold } })
      else await OrgHome.updateOne({ orgId: oid(id) }, { $setOnInsert: { orgId: oid(id), home: 'global', epoch: highWater.get(id) ?? 0, since: now }, $set: { state: 'hold', hold } }, { upsert: true })
    }
    held++
  }
  if (opts.execute) forgetAllHomes()
  return { orgs, held }
}

export interface HeldHome {
  orgId: string
  slug?: string
  name?: string
  home: string
  epoch: number
  /** A hold global took (`higher_epoch`, `dr_restore`), or one `homeOf` derives from the record. */
  reason: HoldReason | 'row_missing_after_move' | 'epoch_disagrees'
  since?: Date
  detail?: string
  /** The newer record a server reported (`higher_epoch`): what adopting would make global's. */
  claim?: { nodeId: string; epoch: number; at: Date }
  highWater?: number
}

/** For the Nodes page: every org global holds, taken or derived, with what releasing would mean. */
export async function heldHomes(): Promise<HeldHome[]> {
  if (nodeRole() !== 'global') return []
  const [rows, moved]: [any[], any[]] = await Promise.all([
    OrgHome.find({ state: 'hold' }).lean(),
    Org.find({ homeEpochHighWater: { $exists: true } }, { _id: 1 }).lean(),
  ])
  const out = new Map<string, HeldHome>()
  for (const r of rows) {
    out.set(String(r.orgId), {
      orgId: String(r.orgId), home: r.home, epoch: Number(r.epoch ?? 0), reason: r.hold?.reason ?? 'dr_restore',
      since: r.hold?.since ?? r.since, ...(r.hold?.detail ? { detail: r.hold.detail } : {}), ...(r.hold?.claim ? { claim: r.hold.claim } : {}),
    })
  }
  // The holds `homeOf` derives: a moved org whose record is missing or disagrees.
  for (const o of moved) {
    const id = String(o._id)
    if (out.has(id)) continue
    const info = await homeOf(id, { fresh: true })
    if (info.state === 'hold' && info.reason) out.set(id, { orgId: id, home: info.home, epoch: info.epoch, reason: info.reason })
  }
  if (!out.size) return []
  const orgs: any[] = await Org.find({ _id: { $in: [...out.keys()].map(oid) } }, { slug: 1, name: 1, homeEpochHighWater: 1 }).lean()
  for (const o of orgs) Object.assign(out.get(String(o._id))!, { slug: o.slug, name: o.name, highWater: o.homeEpochHighWater })
  return [...out.values()].sort((a, b) => a.orgId.localeCompare(b.orgId))
}

export class HomeHoldError extends Error {
  constructor(readonly statusCode: 404 | 409, readonly code: string, message: string) {
    super(message)
  }
}

/**
 * A sys-admin settles a hold (FR-20.3).
 * - **release**: global's record stands. The row goes back to the state it had, and the high-water
 *   mark is made to agree with it (a derived hold); an org with no row is recorded as global's, at
 *   its high-water epoch.
 * - **adopt** (`higher_epoch` only): the server's record becomes global's — that server is home at the
 *   epoch it reported, and the high-water mark with it. Global then writes nothing of the org.
 *
 * ⚠ After adopting, lgrai.app's copy of the org is older than the server's: its mirror resumes only
 * where its chain allows, and may need a re-seed of the copy (P3-7).
 */
export async function releaseHold(orgId: string, by: string, opts: { adopt?: boolean; now?: Date } = {}): Promise<{ home: string; epoch: number; state: string }> {
  if (!isOrgId(orgId)) throw new HomeHoldError(404, 'not_found', 'No such organization')
  const now = opts.now ?? new Date()
  const id = oid(orgId)
  const [row, org]: [any, any] = await Promise.all([OrgHome.findOne({ orgId: id }).lean(), Org.findById(id, { homeEpochHighWater: 1 }).lean()])
  if (!org) throw new HomeHoldError(404, 'not_found', 'No such organization')
  const info = await homeOf(orgId, { fresh: true })
  if (info.state !== 'hold') throw new HomeHoldError(409, 'not_held', 'The organization is not on hold')

  if (opts.adopt) {
    const claim = row?.hold?.reason === 'higher_epoch' ? row.hold.claim : null
    if (!claim) throw new HomeHoldError(409, 'nothing_to_adopt', 'No server has reported a newer record for this organization')
    const node: any = await ServerNode.findOne({ _id: claim.nodeId, status: 'active', orgIds: id }, { _id: 1 }).lean()
    if (!node) throw new HomeHoldError(409, 'server_gone', 'The server that reported the newer record is no longer registered for this organization')
    await OrgHome.updateOne(
      { _id: row._id, state: 'hold' },
      { $set: { home: claim.nodeId, epoch: claim.epoch, state: 'active', since: now, changedBy: by, released: { at: now, by, how: 'adopted', reason: 'higher_epoch' } }, $unset: { hold: '' } },
    )
    // Global's own field of the org, written raw: the org is not written here, and its timestamps are the home's.
    await Org.collection.updateOne({ _id: id }, { $set: { homeEpochHighWater: claim.epoch } })
    forgetAllHomes()
    logger.warn({ orgId, by, nodeId: claim.nodeId, epoch: claim.epoch }, 'A sys-admin adopted a server\'s home record for the org (FR-20.3)')
    return { home: claim.nodeId, epoch: claim.epoch, state: 'active' }
  }

  const reason = row?.hold?.reason ?? info.reason ?? 'hold'
  let result: { home: string; epoch: number; state: string }
  if (row) {
    const state = row.state === 'hold' ? (row.hold?.from ?? 'active') : row.state
    await OrgHome.updateOne({ _id: row._id }, { $set: { state, released: { at: now, by, how: 'released', reason } }, $unset: { hold: '' } })
    if (Number(org.homeEpochHighWater ?? row.epoch) !== Number(row.epoch) || (org.homeEpochHighWater === undefined && Number(row.epoch) > 0)) {
      await Org.collection.updateOne({ _id: id }, { $set: { homeEpochHighWater: Number(row.epoch) } })
    }
    result = { home: row.home, epoch: Number(row.epoch), state }
  } else {
    const epoch = Number(org.homeEpochHighWater ?? 0)
    await OrgHome.updateOne({ orgId: id }, { $setOnInsert: { orgId: id, home: 'global', epoch, since: now }, $set: { state: 'active', changedBy: by, released: { at: now, by, how: 'released', reason } } }, { upsert: true })
    result = { home: 'global', epoch, state: 'active' }
  }
  forgetAllHomes()
  logger.warn({ orgId, by, reason, ...result }, 'A sys-admin released the org\'s home hold: lgrai.app\'s record stands (FR-20.3)')
  return result
}
