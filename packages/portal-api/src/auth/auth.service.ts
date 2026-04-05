import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'
import { LEGACY_PERMISSION_MAP } from 'config/constants'
import type { UserTokenized } from 'services/biz/auth.service'
import { buildScopedRepos } from 'services/biz/scoped-repos'

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

    // Expand legacy trade.* permissions to new granular permissions
    if (user?.permissions) {
      const expanded = new Set(user.permissions)
      for (const perm of user.permissions) {
        const mapped = LEGACY_PERMISSION_MAP[perm]
        if (mapped) {
          for (const p of mapped) expanded.add(p)
        }
      }
      if (expanded.size > user.permissions.length) {
        user.permissions = [...expanded]
      }
    }
    const scopedRepos = user?.ownRecordsModules?.length
      ? buildScopedRepos(user.ownRecordsModules, user.id)
      : null
    return { user, scopedRepos }
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
