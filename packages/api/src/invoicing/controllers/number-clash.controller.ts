import { Elysia } from 'elysia'
import { AppAuthService } from '../auth/app-auth.service.js'
import { listNumberClashes, NumberClashError, prepareClashCorrection } from 'services/biz/number-clash.service'

/**
 * A legal number issued twice (FR-20.51, AC 51; `services/biz/number-clash.service.ts`): every pair of
 * the org, and its correction prepared once as two drafts (a credit note annulling the later
 * document, and its re-issue), for a person to check and issue. Reads need `invoicing.read`, the
 * preparation `invoicing.write` (the route rules).
 */
export const numberClashController = new Elysia({ prefix: '/org/:orgId/invoicing/number-clashes' })
  .use(AppAuthService)
  .get(
    '/',
    async ({ params: { orgId }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      return { clashes: await listNumberClashes(orgId) }
    },
    { isSignIn: true },
  )
  .post(
    '/:id/prepare',
    async ({ params: { orgId, id }, user, status }) => {
      if (!user) return status(401, { message: 'Unauthorized' })
      try {
        return { correction: await prepareClashCorrection(orgId, id, { id: String(user.id), operatorCode: (user as any).operatorCode }) }
      } catch (e) {
        if (e instanceof NumberClashError) return status(e.statusCode, { code: e.code, message: e.message })
        throw e
      }
    },
    { isSignIn: true },
  )
