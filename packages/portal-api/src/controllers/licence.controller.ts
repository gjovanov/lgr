import { Elysia } from 'elysia'
import { AuthService } from '../auth/auth.service.js'
import { licenceOf } from 'services/biz/licence/master-licence.service'

/**
 * FR-20.55 (plan step P2-3b) — where this server's licence for the org stands: what the banner in
 * every app shows, and what the till reads when a session will not open.
 *
 * On global it answers `{applies: false}`: a cloud org is licensed by its subscription, and the
 * banner stays hidden. Any member may read it, since the cashier is the one who needs to know, and
 * nothing in it is secret.
 */
export const licenceController = new Elysia({ prefix: '/org/:orgId/licence' })
  .use(AuthService)
  .get(
    '/',
    async ({ params: { orgId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      return licenceOf(orgId)
    },
    { isSignIn: true },
  )
