import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'
import type { UserTokenized } from 'services/biz/auth.service'

export const AuthService = new Elysia({ name: 'Service.Auth' })
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
      onBeforeHandle(({ user, error }) => {
        if (!user) return error(401, { message: 'Unauthorized' })
      })
    },
  }))
