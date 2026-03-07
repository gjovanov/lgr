import { Elysia, t } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'
import { getRepos } from 'services/context'
import type { UserTokenized } from 'services/biz/auth.service'

/**
 * Desktop auth service — issues and verifies local JWTs.
 * No OAuth, no email activation, no Stripe.
 * Uses the same JWT secret as cloud so AppAuthService in domain controllers can verify.
 */
export const DesktopAuthService = new Elysia({ name: 'Service.DesktopAuth' })
  .use(
    jwt({
      name: 'jwt',
      secret: config.jwt.secret,
    }),
  )
  .derive({ as: 'scoped' }, async ({ cookie, headers, jwt }) => {
    const token =
      cookie?.auth?.value ||
      (headers.authorization?.startsWith('Bearer ')
        ? headers.authorization.slice(7)
        : headers.authorization) ||
      ''

    const payload = await jwt.verify(token)
    const user = payload ? (payload as unknown as UserTokenized) : null
    return { user }
  })
  .macro(({ onBeforeHandle }) => ({
    isSignIn(_value?: boolean) {
      onBeforeHandle(({ user, status }) => {
        if (!user) return status(401, { message: 'Unauthorized' })
      })
    },
  }))
