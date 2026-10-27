import { Elysia, t } from 'elysia'
import { nodeRole } from 'config'
import { NodeEnrollmentCode, NodeEnrollmentKey, NodeEnrollmentKeyUse, Org, ServerNode } from 'db/models'
import { homeOf } from 'db/home/home'
import { AuthService } from '../auth/auth.service.js'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { paginateQuery } from 'services/utils/pagination'
import { notifyNodeRevoked, rewelcomeNode } from '../websocket/uplink.js'
import { mirrorFilesStatus } from 'services/biz/replication/mirror-blobs'
import { mirrorReconcileStatus } from 'services/biz/replication/reconcile'
import { alarmsOfNodes } from 'services/biz/node/node-alarms'
import { mirrorDeadLetterStatus } from 'services/biz/replication/dead-letters'
import {
  NodeError,
  mintNodeEnrollmentCode,
  mintNodeEnrollmentKey,
  nodeToWire,
  orgStateFor,
  presenceOfNodes,
  revokeNodeForOrg,
} from 'services/biz/node/node.service'
import { relayEnabled } from 'services/biz/relay/mail-relay.service'
import { logger } from 'services/logger'

/**
 * The Servers page's API (FR-20.2, plan step P2-1): an org's registered masters, the codes that
 * register one, and taking the org off one. Global only: 404 on a master.
 *
 * - **`admin.settings`, as the Desktops page:** no new permission, so no re-login and no backfill.
 * - **Tenancy:** `:orgId` brings `isForeignOrg`, and every query names the org. A node is listed
 *   for an org only while the org is in its `orgIds`.
 * - ⚠ **The home gate lets the writes through** (`GLOBAL_STATE_WRITES`): they write global's
 *   registry, never the org's data, and revoking a lost master is exactly when the org's home is
 *   that master.
 */

function canAdmin(user: any): boolean {
  return user?.role === 'admin' || !!user?.permissions?.includes('admin.settings')
}

function fail(status: any, e: unknown) {
  if (e instanceof NodeError) return status(e.statusCode, { code: e.code, message: e.message })
  throw e
}

const NOT_FOUND = { message: 'Not found' }

/** FR-20.59: what global relays for THIS org on the node, and whether its admin set it or it follows the link level. */
function relaysFor(n: any, orgId: string) {
  const set = (n.relays ?? []).find((r: any) => String(r.orgId) === orgId)
  return {
    mail: relayEnabled(n, orgId, 'mail'),
    mailChosen: typeof set?.mail === 'boolean',
    documents: relayEnabled(n, orgId, 'documents'),
    documentsChosen: typeof set?.documents === 'boolean',
  }
}

export const nodeController = new Elysia({ prefix: '/org/:orgId/nodes' })
  .use(AuthService)
  .onBeforeHandle(({ status }) => {
    if (nodeRole() !== 'global') return status(404, NOT_FOUND)
  })

  .get(
    '/',
    async ({ params: { orgId }, query, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const filter: Record<string, any> = { orgIds: orgId }
      if (query.includeRevoked !== 'true') filter.status = 'active'
      const result = await paginateQuery(ServerNode as any, filter, query, { sortBy: 'lastSeenAt', size: 25 })
      const connected = await presenceOfNodes(result.items.map((n: any) => String(n._id)))
      // FR-20.101 (P3-8): each server's alarms; a mirror's lag only this org's.
      const alarms = await alarmsOfNodes(result.items)
      return {
        nodes: result.items.map((n: any) => ({
          ...nodeToWire(n),
          connected: connected.get(String(n._id)),
          relays: relaysFor(n, orgId),
          orgState: orgStateFor(n, orgId),
          alarms: (alarms.get(String(n._id)) ?? []).filter(a => a.kind !== 'mirror_lag' || a.orgId === orgId),
        })),
        total: result.total, page: result.page, pageSize: result.size,
      }
    },
    { isSignIn: true },
  )

  /**
   * FR-20.69 (plan step P3-3): the org's files on lgrai.app's mirror while its home is one of its
   * servers: whether they travel at all (the metadata-only option), and how many have arrived.
   */
  .get(
    '/mirror',
    async ({ params: { orgId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const home = await homeOf(orgId)
      return { mirror: { home: home.home, ...(await mirrorFilesStatus(orgId)), reconcile: await mirrorReconcileStatus(orgId), deadLetters: await mirrorDeadLetterStatus(orgId) } }
    },
    { isSignIn: true },
  )

  /**
   * FR-20.69: metadata only, or the files too. The org's own choice for its own files, on global's
   * part of the org (`settings.node`, which no page overwrites). Files already on the mirror stay
   * there and keep opening. ⚠ Through the home gate (`GLOBAL_STATE_WRITES`): the case it exists for is
   * an org homed on a master.
   */
  .put(
    '/mirror',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const org: any = await Org.findById(orgId, { 'settings.node.mirrorFiles': 1 }).lean()
      if (!org) return status(404, { message: 'Not found' })
      const before = org.settings?.node?.mirrorFiles !== false
      if (before !== body.files) {
        // ⚠ No timestamps: `updatedAt` is the home's field (FR-20.63). Touched here, global's copy of
        // a mirrored org would differ from its home's until the master next sends the org.
        await Org.updateOne({ _id: orgId }, { $set: { 'settings.node.mirrorFiles': body.files } }, { timestamps: false })
        const home = await homeOf(orgId, { fresh: true })
        const change = { field: 'settings.node.mirrorFiles', oldValue: before, newValue: body.files }
        if (home.home === 'global') {
          createAuditEntry({ orgId, userId: user.id, operatorCode: user.operatorCode, action: 'update', module: 'admin', entityType: 'org', entityId: orgId, entityName: 'mirror', changes: [change] })
        } else {
          // The org's audit trail is written where the org lives; global says it in its own log.
          logger.info({ orgId, userId: user.id, home: home.home, ...change }, 'Mirror: an org chose whether its files travel to lgrai.app')
          // The master's pump reads the choice from its bulk welcome: welcomed again, it follows now.
          rewelcomeNode(home.home)
        }
      }
      const home = await homeOf(orgId)
      return { mirror: { home: home.home, ...(await mirrorFilesStatus(orgId)), reconcile: await mirrorReconcileStatus(orgId), deadLetters: await mirrorDeadLetterStatus(orgId) } }
    },
    { isSignIn: true, body: t.Object({ files: t.Boolean() }) },
  )

  .get(
    '/:id',
    async ({ params: { orgId, id }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const n = await ServerNode.findOne({ _id: id, orgIds: orgId }).lean()
      if (!n) return status(404, { message: 'Server not found' })
      return { node: { ...nodeToWire(n), relays: relaysFor(n, orgId), orgState: orgStateFor(n, orgId) } }
    },
    { isSignIn: true },
  )

  /**
   * FR-20.59 (plan step P2-6): whether global sends this org's mail on the server's behalf. The org
   * consents for its own data; a master cannot turn it on for itself. ⚠ Through the home gate
   * (`GLOBAL_STATE_WRITES`): it writes global's registry, and the org's home is that master.
   */
  .put(
    '/:id/relays',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const n: any = await ServerNode.findOne({ _id: id, orgIds: orgId, status: 'active' }).lean()
      if (!n) return status(404, { message: 'Server not found' })
      if (body.mail === undefined && body.documents === undefined) return status(422, { message: 'Nothing to set' })
      // The kind not in the body keeps the org's earlier choice (or stays unset: the default).
      const had = (n.relays ?? []).find((r: any) => String(r.orgId) === orgId) ?? {}
      const before = { mail: relayEnabled(n, orgId, 'mail'), documents: relayEnabled(n, orgId, 'documents') }
      const entry: Record<string, unknown> = { orgId, setBy: user.id, setAt: new Date() }
      for (const kind of ['mail', 'documents'] as const) {
        const v = body[kind] ?? had[kind]
        if (typeof v === 'boolean') entry[kind] = v
      }
      // One entry per org: replaced in place, or added when there is none (the `$ne` keeps two
      // concurrent first choices from adding two).
      const replaced = await ServerNode.updateOne({ _id: id, status: 'active', 'relays.orgId': orgId }, { $set: { 'relays.$': entry } })
      if (!replaced.matchedCount) await ServerNode.updateOne({ _id: id, status: 'active', 'relays.orgId': { $ne: orgId } }, { $push: { relays: entry } })
      const after: any = await ServerNode.findById(id).lean()
      createAuditEntry({
        orgId, userId: user.id, operatorCode: user.operatorCode,
        action: 'update', module: 'admin', entityType: 'node',
        entityId: id, entityName: n.name,
        changes: (['mail', 'documents'] as const)
          .filter(kind => body[kind] !== undefined)
          .map(kind => ({ field: `relays.${kind}`, oldValue: before[kind], newValue: body[kind] })),
      })
      return { node: { ...nodeToWire(after), relays: relaysFor(after, orgId), orgState: orgStateFor(after, orgId) } }
    },
    { isSignIn: true, body: t.Object({ mail: t.Optional(t.Boolean()), documents: t.Optional(t.Boolean()) }) },
  )

  /** Take this org off the server; the server is revoked when no org is left on it. */
  .post(
    '/:id/revoke',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      try {
        const { node, outcome } = await revokeNodeForOrg(orgId, id, user.id, body?.reason)
        // A courtesy: its sockets on this process hear it now. The uplink's 30 s re-read is the rule.
        if (outcome !== 'removed') notifyNodeRevoked(id)
        createAuditEntry({
          orgId, userId: user.id, operatorCode: user.operatorCode,
          action: 'update', module: 'admin', entityType: 'node',
          entityId: id, entityName: node.name,
          changes: [{ field: 'status', oldValue: 'active', newValue: outcome }],
        })
        return { ok: true, outcome }
      } catch (e) {
        return fail(status, e)
      }
    },
    { isSignIn: true, body: t.Optional(t.Object({ reason: t.Optional(t.String({ maxLength: 200 })) })) },
  )

  .post(
    '/enrollment-codes',
    async ({ params: { orgId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const minted = await mintNodeEnrollmentCode(orgId, user.id)
      createAuditEntry({
        orgId, userId: user.id, operatorCode: user.operatorCode,
        action: 'create', module: 'admin', entityType: 'node',
        entityId: minted.id, entityName: 'registration code',
        // ⚠ Never the code itself: the audit trail is read by every admin.audit holder.
        changes: [{ field: 'registrationCode', oldValue: null, newValue: 'minted' }],
      })
      return minted
    },
    { isSignIn: true },
  )

  /** Lets the "Add a server" dialog close itself when the master registers. */
  .get(
    '/enrollment-codes/:id',
    async ({ params: { orgId, id }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const r: any = await NodeEnrollmentCode.findOne({ _id: id, orgId }).lean().catch(() => null)
      if (!r) return status(404, { message: 'Code not found' })
      const state = r.usedAt ? 'used' : r.expiresAt.getTime() < Date.now() ? 'expired' : 'unused'
      let usedBy: string | undefined
      if (r.usedByNodeId) usedBy = ((await ServerNode.findOne({ _id: r.usedByNodeId, orgIds: orgId }).select('name').lean()) as any)?.name
      return { id: String(r._id), state, expiresAt: r.expiresAt, usedAt: r.usedAt, usedBy }
    },
    { isSignIn: true },
  )

  // ── Reusable keys, for the field lanes' throwaway masters (gated by the org setting) ──────────
  .get(
    '/enrollment-keys',
    async ({ params: { orgId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const keys = await NodeEnrollmentKey.find({ orgId }).sort({ createdAt: -1 }).lean()
      return {
        keys: keys.map((k: any) => ({
          id: String(k._id), name: k.name, keyPrefix: k.keyPrefix, maxUses: k.maxUses, uses: k.uses,
          expiresAt: k.expiresAt, revokedAt: k.revokedAt, createdAt: k.createdAt,
        })),
      }
    },
    { isSignIn: true },
  )

  .post(
    '/enrollment-keys',
    async ({ params: { orgId }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      try {
        const minted = await mintNodeEnrollmentKey(orgId, user.id, {
          name: body.name,
          maxUses: body.maxUses,
          expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
        })
        createAuditEntry({
          orgId, userId: user.id, operatorCode: user.operatorCode,
          action: 'create', module: 'admin', entityType: 'node',
          entityId: minted.id, entityName: body.name,
          changes: [{ field: 'registrationKey', oldValue: null, newValue: 'minted' }],
        })
        return minted
      } catch (e) {
        return fail(status, e)
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        name: t.String({ minLength: 1, maxLength: 120 }),
        maxUses: t.Optional(t.Integer({ minimum: 0, maximum: 100_000 })),
        expiresAt: t.Optional(t.String({ format: 'date-time' })),
      }),
    },
  )

  .delete(
    '/enrollment-keys/:id',
    async ({ params: { orgId, id }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const r = await NodeEnrollmentKey.updateOne({ _id: id, orgId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedBy: user.id } }).catch(() => null)
      if (!r?.matchedCount) return status(404, { message: 'Key not found' })
      return { ok: true }
    },
    { isSignIn: true },
  )

  .get(
    '/enrollment-keys/:id/uses',
    async ({ params: { orgId, id }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const uses = await NodeEnrollmentKeyUse.find({ orgId, keyId: id }).sort({ createdAt: -1 }).limit(200).lean().catch(() => [])
      return { uses: uses.map((u: any) => ({ nodeId: u.nodeId, installationId: u.installationId, ip: u.ip, at: u.createdAt })) }
    },
    { isSignIn: true },
  )
