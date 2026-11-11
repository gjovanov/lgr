import { Elysia, t } from 'elysia'
import { can, grantOf } from 'services/biz/access/evaluate'
import { AuthService } from '../auth/auth.service.js'
import { getAvailableApps, activateApp, deactivateApp } from 'services/biz/app-hub.service'
import type { AppId } from 'config/constants'

export const appHubController = new Elysia({ prefix: '/org/:orgId/apps' })
  .use(AuthService)
  .get('/', async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })

    // FR-27.5: an org on `roles` (the live grant on `user.access`) shows the tiles of the role's apps.
    const apps = await getAvailableApps(orgId, user.permissions || [], user.id, undefined, { role: user.role, grant: (user as any).access ? grantOf(user as any) : undefined })
    return { apps }
  }, { isSignIn: true })
  .post(
    '/:appId/activate',
    async ({ params: { orgId, appId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!can(user, 'apps.manage')) return status(403, { message: 'Admin only' })

      try {
        const app = await activateApp(orgId, appId as AppId, user.id)
        return { app }
      } catch (err: any) {
        return status(400, { message: err.message })
      }
    },
    { isSignIn: true },
  )
  .post(
    '/:appId/deactivate',
    async ({ params: { orgId, appId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      if (!can(user, 'apps.manage')) return status(403, { message: 'Admin only' })

      try {
        const app = await deactivateApp(orgId, appId as AppId)
        return { app }
      } catch (err: any) {
        return status(400, { message: err.message })
      }
    },
    { isSignIn: true },
  )
