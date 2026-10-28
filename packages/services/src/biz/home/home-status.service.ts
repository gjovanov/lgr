/**
 * Where an org lives, as every member of it may read (FR-20.75, plan step P3-5): what the read-only
 * banner says, above every page of every app.
 *
 * - **On lgrai.app, an org homed on one of its servers** is a mirror: reads, reports and exports
 *   work, every write answers `org_home_elsewhere`. The banner says which server writes it, whether
 *   that server is connected, since when it is not, and as of when the copy holds (the last page the
 *   mirror applied).
 * - **On a master, an org that went back to lgrai.app** (FR-20.80) is the read-only copy the master
 *   keeps: the banner says so.
 * - **A move under way** freezes the org wherever it lives: nothing can be written until it ends.
 * - **After a promotion** (FR-20.81): on lgrai.app, legal numbering waits for the lost site's last
 *   numbers (`seriesFrozen`); on the master it replaced, the org is FENCED (`state: 'fenced'`), which
 *   is no move: the server writes nothing more of it, for good.
 *
 * Nothing in it is secret: a server's name and whether it is online, never its address or its health.
 */
import { nodeRole } from 'config'
import { LIVE_MOVE_STATES, MirrorState, OrgHome, OrgMove, ServerNode } from 'db/models'
import { homeOf, thisNode } from 'db/home/home'
import { presenceOfNodes } from '../node/node.service.js'

export interface HomeStatus {
  /** `here`: written here. `master`: on lgrai.app, written on one of the org's servers. `global`: on a master, written on lgrai.app now. */
  home: 'here' | 'master' | 'global'
  state: string
  epoch: number
  /** A move is under way: the org is frozen until it ends. */
  moving: boolean
  server?: { id: string; name: string }
  /** Whether the server holds both of its sockets to lgrai.app now. */
  online?: boolean
  /** Since when the server has not been heard from, while it is offline; since when the org lives on lgrai.app, on a master. */
  since?: string | null
  /** The last change the mirror holds: as of when this copy is. */
  asOf?: string | null
  /** FR-20.81: legal numbering waits for the last numbers issued at a lost site. */
  seriesFrozen?: { since: string }
}

const iso = (d: unknown) => (d ? new Date(d as any).toISOString() : null)

export async function homeStatus(orgId: string): Promise<HomeStatus> {
  const home = await homeOf(orgId, { fresh: true })
  // A fenced home is not frozen for a move: it is replaced, and says so.
  const moving = (home.state !== 'active' && home.state !== 'fenced') || !!(await OrgMove.exists({ orgId, state: { $in: [...LIVE_MOVE_STATES] } }))
  const base = { state: home.state, epoch: home.epoch, moving }
  if (home.home === thisNode()) {
    const row: any = await OrgHome.findOne({ orgId }, { seriesFrozen: 1 }).lean()
    return { home: 'here', ...base, ...(row?.seriesFrozen?.since ? { seriesFrozen: { since: new Date(row.seriesFrozen.since).toISOString() } } : {}) }
  }

  if (nodeRole() === 'master') {
    // The org went back to lgrai.app: this server keeps a read-only copy.
    const row: any = await OrgHome.findOne({ orgId }, { since: 1 }).lean()
    return { home: 'global', ...base, since: iso(row?.since) }
  }

  const [node, mirror]: [any, any] = await Promise.all([
    ServerNode.findById(home.home, { name: 1, lastSeenAt: 1 }).lean(),
    MirrorState.findOne({ orgId }, { lastPageAt: 1 }).lean(),
  ])
  const live = (await presenceOfNodes([home.home])).get(home.home)
  const online = !!live?.interactive && !!live?.bulk
  return {
    home: 'master',
    ...base,
    server: { id: home.home, name: node?.name ?? home.home },
    online,
    since: online ? null : iso(node?.lastSeenAt),
    asOf: iso(mirror?.lastPageAt),
  }
}
