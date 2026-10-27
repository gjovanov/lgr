import { Elysia } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { homeStatus } from 'services/biz/home/home-status.service'

/**
 * Where the org lives (FR-20.75, plan step P3-5): `GET /api/org/:orgId/home`, for the read-only banner
 * above every page. Any member of the org (the tenant guard holds the org in the URL to the caller's
 * own); nothing in it is secret. A read, so a mirror answers it as well as the home does.
 */
export const homeController = new Elysia({ prefix: '/org/:orgId/home' }).use(AuthService).get(
  '/',
  async ({ params: { orgId }, user, status }) => {
    if (!user) return status(401, { message: 'Unauthorized' })
    return homeStatus(orgId)
  },
  { isSignIn: true },
)
