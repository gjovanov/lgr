import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'
import { LEGACY_PERMISSION_MAP } from 'config/constants'
import type { UserTokenized } from 'services/biz/auth.service'
import { buildScopedRepos } from 'services/biz/scoped-repos'
import { isForeignOrg, FOREIGN_ORG_MESSAGE } from 'services/biz/tenant-guard'
import { isPublicRoute } from 'services/biz/public-routes'

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
  /**
   * gjovanov/lgr#41 — the cross-tenant guard, applied to every route of every controller that
   * uses this plugin. Not a macro: a macro is opted into per route, and the 73 leaks this
   * replaces are exactly what "the author has to remember" produces. See
   * `services/biz/tenant-guard.ts` for why there is no exception list.
   */
  /**
   * Authentication, then tenancy — both unconditional, in that order.
   *
   * ⚠ The 401 is NOT the `isSignIn` macro's job any more, and must never go back to being it.
   * The legacy function-form macro these plugins declared stopped running on Elysia 1.4
   * without erroring, and 172 of 366 routes answered anonymously as a result. Deny-by-default
   * with a named allow-list (`services/biz/public-routes.ts`) is what makes that class of
   * failure impossible: nothing about a route turns the check on, so nothing about a route can
   * turn it off. `isSignIn: true` is kept below as documentation of intent and a second belt.
   *
   * ⚠ Order matters. `isForeignOrg` returns false for an anonymous caller by design, so it
   * cannot be the thing that stops one — running it first would let a tokenless request fall
   * straight through to the handler, which is precisely the bug that was live here.
   */
  .onBeforeHandle({ as: 'scoped' }, ({ user, params, status, request, route }) => {
    if (!user && !isPublicRoute(request.method, route)) {
      return status(401, { message: 'Unauthorized' })
    }
    const orgId = (params as Record<string, string | undefined> | undefined)?.orgId
    if (isForeignOrg(user, orgId)) return status(403, { message: FOREIGN_ORG_MESSAGE })
  })
  /**
   * ⚠ Object-form macro. The previous function form (`.macro(({ onBeforeHandle }) => …)`) is
   * the Elysia 1.0 API; on 1.4 it is accepted and then never invoked. Keep this shape.
   */
  .macro({
    isSignIn(_value?: boolean) {
      return {
        beforeHandle({ user, status }: any) {
          if (!user) return status(401, { message: 'Unauthorized' })
        },
      }
    },
    access(spec?: { permission?: string; admin?: boolean }) {
      return {
        beforeHandle({ user, status }: any) {
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
        },
      }
    },
  })
