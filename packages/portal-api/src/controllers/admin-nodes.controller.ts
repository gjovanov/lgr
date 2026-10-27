import { Elysia } from 'elysia'
import { nodeRole } from 'config'
import { Org, ServerNode } from 'db/models'
import { AuthService } from '../auth/auth.service.js'
import { nodeToWire, presenceOfNodes } from 'services/biz/node/node.service'
import { isSysAdmin } from 'services/biz/sys-admin'
import { alarmsOfNodes } from 'services/biz/node/node-alarms'

/**
 * The sys-admin Nodes page's API (FR-20 plan step P2-3a): every master registered with global,
 * across every org, with its orgs, presence, clone alarm and last health. Read-only.
 *
 * ⚠ The gate is the same allow-list as the backup administration (\`BACKUP_SYS_ADMINS\`): LGR has no
 * platform-operator permission, and an org \`admin\` must never see another org's servers. An empty
 * list closes the page to everyone. Global only: 404 on a master.
 */

export const adminNodesController = new Elysia({ prefix: '/admin/nodes' })
  .use(AuthService)
  .onBeforeHandle(({ status }) => {
    if (nodeRole() !== 'global') return status(404, { message: 'Not found' })
  })
  .get(
    '/',
    async ({ user, query, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!isSysAdmin(user)) return status(403, { message: 'This page requires a system administrator' })
      const nodes = await ServerNode.find(query.includeRevoked === 'true' ? {} : { status: 'active' })
        .sort({ lastSeenAt: -1 })
        .limit(500)
        .lean()
      const ids = nodes.map((n: any) => String(n._id))
      const connected = await presenceOfNodes(ids)
      // FR-20.99/101 (P3-8): each master's alarms.
      const alarms = await alarmsOfNodes(nodes)
      const orgIds = [...new Set(nodes.flatMap((n: any) => (n.orgIds ?? []).map(String)))]
      const orgs = new Map((await Org.find({ _id: { $in: orgIds } }).select('name slug').lean()).map((o: any) => [String(o._id), { id: String(o._id), slug: o.slug, name: o.name }]))
      return {
        nodes: nodes.map((n: any) => ({
          ...nodeToWire(n),
          orgs: (n.orgIds ?? []).map((id: any) => orgs.get(String(id)) ?? { id: String(id) }),
          connected: connected.get(String(n._id)),
          cloneAlarmAt: n.cloneAlarm?.at ?? null,
          alarms: alarms.get(String(n._id)) ?? [],
        })),
      }
    },
    { isSignIn: true },
  )
