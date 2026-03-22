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
      onBeforeHandle(({ user, status }) => {
        if (!user) return status(401, { message: 'Unauthorized' })
      })
    },
    access(spec?: { permission?: string; admin?: boolean }) {
      onBeforeHandle(({ user, status }) => {
        if (!user) return status(401, { message: 'Unauthorized' })
        if (!spec) return

        if (spec.admin) {
          if (user.role !== 'admin' && !user.permissions?.includes('admin.settings')) {
            return status(403, { message: 'Administrator access required' })
          }
        }

        if (spec.permission) {
          if (!user.permissions?.includes(spec.permission)) {
            return status(403, { message: `Permission required: ${spec.permission}` })
          }
        }
      })
    },
  }))
