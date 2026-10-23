import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'
import { LEGACY_PERMISSION_MAP } from 'config/constants'
import type { SessionUser } from 'services/biz/auth.service'
import { buildScopedRepos } from 'services/biz/scoped-repos'
import { isForeignOrg, FOREIGN_ORG_MESSAGE } from 'services/biz/tenant-guard'
import { writeRefusal } from 'services/biz/route-permission'
import { homeGate } from 'services/biz/home-gate'
import { isPublicRoute } from 'services/biz/public-routes'
import { isIdentityRoute } from 'services/biz/identity-routes'
import { pickSessionToken, asSessionUser } from 'services/biz/session-token'
import {
  asIdentityClaims,
  identityStillValid,
  liveSessionUser,
  type IdentityClaims,
} from 'services/biz/identity/session.service'

export const AuthService = new Elysia({ name: 'Service.Auth' })
  .use(
    jwt({
      name: 'jwt',
      secret: config.jwt.secret,
    }),
  )
  .derive({ as: 'scoped' }, async ({ cookie, headers, jwt }) => {
    // A non-empty bearer token wins outright; the cookie is only for a request that sends none, and
    // an invalid bearer is never rescued by it. A verified signature is a session only if its claims
    // look like one. Both rules live in `services/biz/session-token.ts`, shared by all eight plugins.
    // A token naming a person (`iid`) is revoked by a password change or reset: `liveSessionUser`.
    const token = pickSessionToken(headers.authorization, cookie?.auth?.value)
    const payload = token ? await jwt.verify(token) : false
    const user: SessionUser | null = await liveSessionUser(asSessionUser(payload))
    // A person signed in but in no org yet: reaches the identity routes and nothing else (below).
    const identityClaims = asIdentityClaims(payload)
    const person: IdentityClaims | null =
      identityClaims && (await identityStillValid(identityClaims.iid, identityClaims.tv)) ? identityClaims : null

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
    return { user, person, scopedRepos }
  })
  /**
   * A write needs the permission its route names (S-28, `services/biz/route-permission.ts`).
   *
   * ⚠ A TRANSFORM hook, after the derive above: it runs before the body is validated, so a caller
   * without the permission gets 403, never the route's schema. Another org's URL is left to the
   * tenant guard below, which answers it with its own message.
   */
  .onTransform({ as: 'scoped' }, ({ user, params, request, route, status }: any) => {
    if (isForeignOrg(user, params?.orgId)) return
    const refusal = writeRefusal(user, request.method, route)
    if (refusal) throw status(403, refusal)
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
  .onBeforeHandle({ as: 'scoped' }, async ({ user, person, params, status, request, route }) => {
    // ⚠ An identity-only token (`person`) is admitted on the identity routes ONLY, never as a
    // session: deny-by-default, with its own named allow-list (`services/biz/identity-routes.ts`).
    if (!user && !isPublicRoute(request.method, route) && !(person && isIdentityRoute(request.method, route))) {
      return status(401, { message: 'Unauthorized' })
    }
    const orgId = (params as Record<string, string | undefined> | undefined)?.orgId
    if (isForeignOrg(user, orgId)) return status(403, { message: FOREIGN_ORG_MESSAGE })
    // FR-20.4: only the home writes. Off its home, an org's writing routes answer 409.
    if (user) {
      const refusal = await homeGate(request.method, route, orgId)
      if (refusal) return status(409, refusal)
    }
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
