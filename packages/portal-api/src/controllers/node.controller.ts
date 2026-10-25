import { Elysia, t } from 'elysia'
import { nodeRole } from 'config'
import { NodeEnrollmentCode, NodeEnrollmentKey, NodeEnrollmentKeyUse, ServerNode } from 'db/models'
import { AuthService } from '../auth/auth.service.js'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { paginateQuery } from 'services/utils/pagination'
import {
  NodeError,
  mintNodeEnrollmentCode,
  mintNodeEnrollmentKey,
  nodeToWire,
  revokeNodeForOrg,
} from 'services/biz/node/node.service'

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
      return { nodes: result.items.map(nodeToWire), total: result.total, page: result.page, pageSize: result.size }
    },
    { isSignIn: true },
  )

  .get(
    '/:id',
    async ({ params: { orgId, id }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const n = await ServerNode.findOne({ _id: id, orgIds: orgId }).lean()
      if (!n) return status(404, { message: 'Server not found' })
      return { node: nodeToWire(n) }
    },
    { isSignIn: true },
  )

  /** Take this org off the server; the server is revoked when no org is left on it. */
  .post(
    '/:id/revoke',
    async ({ params: { orgId, id }, body, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      try {
        const { node, outcome } = await revokeNodeForOrg(orgId, id, user.id, body?.reason)
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
