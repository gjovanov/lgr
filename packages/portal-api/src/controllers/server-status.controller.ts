import { Elysia } from 'elysia'
import { nodeRole } from 'config'
import { AuthService } from '../auth/auth.service.js'
import { serverStatus } from 'services/biz/node/server-status'

/**
 * A master's own status page (FR-20.98, FR-20.50, plan step P3-8b): what the supervisor last wrote of
 * itself, what this database says of the org, and the Прил. 32 fields ready to copy. On the server
 * itself, for the org's admins, offline above all; 404 on lgrai.app, whose Servers page says what it
 * hears of its servers.
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
