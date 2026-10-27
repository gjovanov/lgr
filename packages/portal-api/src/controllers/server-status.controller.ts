import { Elysia, t } from 'elysia'
import { nodeRole } from 'config'
import { AuthService } from '../auth/auth.service.js'
import { serverStatus, tunnelReach } from 'services/biz/node/server-status'
import { InspectionError, inspectionOf, inspectionView, setInspection } from 'services/biz/node/inspection.service'
import { keptOf, requestKeptImport } from 'services/biz/move/kept-import.service'
import { MoveError } from 'services/biz/move/move.service'
import { createAuditEntry } from 'services/biz/audit-log.service'
import { thisNode } from 'db/home/home'

/**
 * A master's own status page (FR-20.98, FR-20.50, plan step P3-8b): what the supervisor last wrote of
 * itself, what this database says of the org, and the Прил. 32 fields ready to copy. On the server
 * itself, for the org's admins, offline above all; 404 on lgrai.app, whose Servers page says what it
 * hears of its servers.
 *
 * `PUT /inspection` (FR-20.47, P3-8e): where the server stands and, off the premises, how an inspector
 * reaches it. The trader declares it in Прил. 32 (Н-18 чл. 52и(1)).
 *
 * `GET /kept`, `POST /kept/:moveId/import` (FR-20.71, P3-7g): what a re-seed kept on this server, and
 * its issued sales brought into the books (`kept-import.service.ts`).
 */

function canAdmin(user: any): boolean {
  return user?.role === 'admin' || !!user?.permissions?.includes('admin.settings')
}

export const serverStatusController = new Elysia({ prefix: '/org/:orgId/server' })
  .use(AuthService)
  // Whether the page is here for this caller, for the nav: 200 either way, so asking is never an error.
  .get(
    '/here',
    async ({ user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      return { server: nodeRole() === 'master' && canAdmin(user) }
    },
    { isSignIn: true },
  )
  .get(
    '/status',
    async ({ params: { orgId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (nodeRole() !== 'master') return status(404, { message: 'This page is on the organization\'s server' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const s = await serverStatus(orgId)
      if (!s) return status(404, { message: 'Not found' })
      return { status: s }
    },
    { isSignIn: true },
  )
  .put(
    '/inspection',
    async ({ params: { orgId }, user, body, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (nodeRole() !== 'master') return status(404, { message: 'This page is on the organization\'s server' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      const reach = await tunnelReach(orgId)
      const before = await inspectionOf(orgId)
      try {
        const after = await setInspection(orgId, String(user.id), body, reach)
        const wire = (i: typeof before) => (i ? { premises: i.premises, path: i.path, detail: i.detail } : null)
        createAuditEntry({
          orgId, userId: String(user.id), operatorCode: user.operatorCode, action: 'update', module: 'admin',
          entityType: 'server', entityId: thisNode(), entityName: 'remote inspection path',
          changes: [{ field: 'inspection', oldValue: wire(before), newValue: wire(after) }],
        })
        return { inspection: inspectionView(after, reach) }
      } catch (e) {
        if (e instanceof InspectionError) return status(e.statusCode, { code: e.code, message: e.message })
        throw e
      }
    },
    {
      isSignIn: true,
      body: t.Object({
        premises: t.String({ maxLength: 20 }),
        path: t.Optional(t.Union([t.String({ maxLength: 20 }), t.Null()])),
        detail: t.Optional(t.Union([t.String({ maxLength: 400 }), t.Null()])),
      }),
    },
  )
  .get(
    '/kept',
    async ({ params: { orgId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (nodeRole() !== 'master') return status(404, { message: 'This page is on the organization\'s server' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      return { kept: await keptOf(orgId) }
    },
    { isSignIn: true },
  )
  .post(
    '/kept/:moveId/import',
    async ({ params: { orgId, moveId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (nodeRole() !== 'master') return status(404, { message: 'This page is on the organization\'s server' })
      if (!canAdmin(user)) return status(403, { message: 'Forbidden' })
      try {
        return { import: await requestKeptImport(orgId, moveId, { id: String(user.id), operatorCode: user.operatorCode }) }
      } catch (e) {
        if (e instanceof MoveError) return status(e.statusCode as any, { code: e.code, message: e.message })
        throw e
      }
    },
    { isSignIn: true },
  )
