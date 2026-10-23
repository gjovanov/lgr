import { config, nodeRole } from 'config'
import { Org } from '../models/org.model.js'
import { OrgHome, type OrgHomeState } from '../models/org-home.model.js'

/**
 * Is this node an org's home? (FR-20.3, plan step P0b-2.)
 *
 * Lives in `db`, not in a service, because the write guard (a Mongoose plugin, P0b-2 part 2)
 * asks it too, and `db` cannot import from `services`.
 *
 * ⚠ It FAILS CLOSED. Anything that is not a clean "this node, active" is not home:
 * - **no row** is `global`, epoch 0 — but only while `Org.homeEpochHighWater` is unset, i.e. the org
 *   never had a node. A missing row for an org that did is `hold`;
 * - **the row and the high-water mark disagree** (a restore, a hand edit) → `hold`;
 * - **any state but `active`** (`freezing` during a move, `frozen`, `fenced`, `hold`) writes nothing.
 */

export interface OrgHomeInfo {
  /** `global`, or the node id of the master that is home. */
  home: string
  epoch: number
  state: OrgHomeState
  /** Why the state was derived rather than read, when it was. */
  reason?: 'row_missing_after_move' | 'epoch_disagrees'
}

/** Five seconds: a move freezes the org first, so a stale "active" can only outlive the freeze by this. */
export const HOME_CACHE_MS = 5_000
const cache = new Map<string, { at: number; info: OrgHomeInfo }>()

/** Forget one org's cached home (after a move, or when a change stream says it changed). */
export function forgetHome(orgId: unknown): void {
  cache.delete(String(orgId))
}

/** Forget every cached home. Tests, and a node that just changed role. */
export function forgetAllHomes(): void {
  cache.clear()
  awayCache = undefined
  scopeCache = undefined
}

/**
 * The org's home. `fresh` skips the cache: legal number allocation asks fresh, so a five-second-old
 * "active" can never let a number be drawn after a freeze (FR-20.4, allocation).
 */
export async function homeOf(orgId: unknown, { fresh = false }: { fresh?: boolean } = {}): Promise<OrgHomeInfo> {
  const key = String(orgId)
  const hit = cache.get(key)
  if (!fresh && hit && Date.now() - hit.at < HOME_CACHE_MS) return hit.info

  const [row, org] = await Promise.all([
    OrgHome.findOne({ orgId: key }, { home: 1, epoch: 1, state: 1 }).lean().exec(),
    Org.findById(key, { homeEpochHighWater: 1 }).lean().exec(),
  ])
  const highWater = (org as any)?.homeEpochHighWater as number | undefined

  let info: OrgHomeInfo
  if (!row) {
    info = highWater
      ? { home: 'global', epoch: 0, state: 'hold', reason: 'row_missing_after_move' }
      : { home: 'global', epoch: 0, state: 'active' }
  } else {
    const r = row as any
    info = { home: r.home, epoch: r.epoch ?? 0, state: r.state }
    // Global keeps the second record; it must agree with the row.
    if (nodeRole() === 'global' && highWater !== undefined && highWater !== info.epoch) {
      info = { ...info, state: 'hold', reason: 'epoch_disagrees' }
    }
  }
  cache.set(key, { at: Date.now(), info })
  return info
}

/** This node's name for itself in `OrgHome.home`. */
export function thisNode(): string {
  return nodeRole() === 'master' ? (config.node.id ?? '') : 'global'
}

/** True when this node is the org's home and may write its data now. */
export async function isHomeHere(orgId: unknown): Promise<boolean> {
  const info = await homeOf(orgId)
  const here = thisNode()
  return !!here && info.home === here && info.state === 'active'
}

/** A write to an org whose home is elsewhere (or not `active`). */
export class HomeElsewhereError extends Error {
  readonly code = 'org_home_elsewhere'
  constructor(public orgId: string, public info: OrgHomeInfo) {
    super(`Org ${orgId} is not written here: its home is ${info.home === 'global' ? 'global' : 'another server'}${info.state !== 'active' ? ` (${info.state})` : ''}.`)
    this.name = 'HomeElsewhereError'
  }
}

/** FR-20.4 — throws unless this node may write `orgId`'s data now. Scripts and raw write sites call it. */
export async function assertHomeIsHere(orgId: unknown, opts: { fresh?: boolean } = {}): Promise<void> {
  const info = await homeOf(orgId, opts)
  if (info.home === thisNode() && info.state === 'active') return
  throw new HomeElsewhereError(String(orgId), info)
}

let awayCache: { at: number; value: boolean } | undefined

/**
 * Could ANY org's writes be refused here? False on global while no org has ever had a node — every
 * org today — so a write that does not name its org (an update by `_id`) needs no lookup. A master
 * always answers true: the orgs it is not home of have no row at all.
 */
export async function anyOrgAwayFromHome(): Promise<boolean> {
  if (nodeRole() === 'master') return true
  if (awayCache && Date.now() - awayCache.at < HOME_CACHE_MS) return awayCache.value
  const [row, moved] = await Promise.all([
    OrgHome.exists({ $or: [{ home: { $ne: 'global' } }, { state: { $ne: 'active' } }] }).exec(),
    Org.exists({ homeEpochHighWater: { $exists: true } }).exec(),
  ])
  awayCache = { at: Date.now(), value: !!row || !!moved }
  return awayCache.value
}

/** The condition on the org id, or null for "every org". Cached apart from the field it is put on. */
let scopeCache: { at: number; cond: Record<string, unknown> | null } | undefined

/**
 * FR-20.5 — a filter fragment for the orgs this node is home of, to merge into a write that sweeps
 * or fans out across orgs (`{ ...filter, ...await homeScope() }`):
 * - **global, no org ever moved** (every org today): `{}`, so nothing changes;
 * - **global, some orgs away or on hold**: `{ orgId: { $nin: [those] } }`;
 * - **a master**: `{ orgId: { $in: [its orgs] } }` — an empty list matches nothing, which is right.
 *
 * `field` names where the org id lives: `orgId` on tenant data, `_id` for a loop over `Org` itself
 * (the schedulers, FR-20.85).
 *
 * ⚠ Cached for `HOME_CACHE_MS`, like `homeOf`. A sweep is not a legal allocation; a write that is
 * still checks each document through the write guard.
 */
export async function homeScope(field = 'orgId'): Promise<Record<string, unknown>> {
  if (!scopeCache || Date.now() - scopeCache.at >= HOME_CACHE_MS) scopeCache = { at: Date.now(), cond: await scopeCondition() }
  return scopeCache.cond ? { [field]: scopeCache.cond } : {}
}

async function scopeCondition(): Promise<Record<string, unknown> | null> {
  if (nodeRole() === 'master') {
    const mine = await OrgHome.distinct('orgId', { home: thisNode(), state: 'active' }).exec()
    return { $in: mine }
  } else if (!(await anyOrgAwayFromHome())) {
    return null
  } else {
    const [away, moved] = await Promise.all([
      OrgHome.distinct('orgId', { $or: [{ home: { $ne: 'global' } }, { state: { $ne: 'active' } }] }).exec(),
      Org.distinct('_id', { homeEpochHighWater: { $exists: true } }).exec(),
    ])
    // A moved org is out unless its record says, consistently, that it is back and active here.
    const held: unknown[] = []
    for (const id of moved) if (!(await isHomeHere(id))) held.push(id)
    // An org can be both: one entry each.
    const out = new Map<string, unknown>()
    for (const id of [...away, ...held]) out.set(String(id), id)
    return { $nin: [...out.values()] }
  }
}
