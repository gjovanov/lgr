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
}

export async function homeOf(orgId: unknown): Promise<OrgHomeInfo> {
  const key = String(orgId)
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < HOME_CACHE_MS) return hit.info

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
