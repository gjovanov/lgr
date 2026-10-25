import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { config } from 'config'
import type { UserTokenized } from 'services/biz/auth.service'
import { buildScopedRepos } from 'services/biz/scoped-repos'
import { isForeignOrg, FOREIGN_ORG_MESSAGE } from 'services/biz/tenant-guard'
import { permissionRefusal } from 'services/biz/route-permission'
import { homeGate } from 'services/biz/home-gate'
import { licenceGate } from 'services/biz/licence/master-licence.service'
import { isPublicRoute } from 'services/biz/public-routes'
import { pickSessionToken, asSessionUser, sessionCookieValue } from 'services/biz/session-token'
import { liveSessionUser } from 'services/biz/identity/session.service'

/**
 * Verification-only auth service for domain apps.
 * Validates JWT issued by Portal but does NOT issue tokens.
 *
 * ⚠ This file exists byte-identical in all seven `*-api` packages, and Elysia dedupes them by
 * `name`, so whichever copy is registered first is the one that runs. Any change here must be
 * made to all seven or the behaviour depends on mount order. (`portal-api/src/auth/auth.service.ts`
 * is a separate plugin — `Service.Auth`, which can also ISSUE tokens — and carries the same
 * tenant guard below.)
 */
export const AppAuthService = new Elysia({ name: 'Service.AppAuth' })
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
    const token = pickSessionToken(headers.authorization, sessionCookieValue(cookie, headers))
    const user: UserTokenized | null = token ? await liveSessionUser(asSessionUser(await jwt.verify(token))) : null

    const scopedRepos = user?.ownRecordsModules?.length
      ? buildScopedRepos(user.ownRecordsModules, user.id)
      : null
    return { user, scopedRepos }
  })
  /**
   * A request needs the permission its route names: a write since S-28, a read since S-29
   * (`services/biz/route-permission.ts`).
   *
   * ⚠ A TRANSFORM hook, after the derive above: it runs before the body is validated, so a caller
   * without the permission gets 403, never the route's schema. Another org's URL is left to the
   * tenant guard below, which answers it with its own message.
   */
  .onTransform({ as: 'scoped' }, ({ user, params, request, route, status }: any) => {
    if (isForeignOrg(user, params?.orgId)) return
    const refusal = permissionRefusal(user, request.method, route)
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
  .onBeforeHandle({ as: 'scoped' }, async ({ user, params, status, request, route }) => {
    if (!user && !isPublicRoute(request.method, route)) {
      return status(401, { message: 'Unauthorized' })
    }
    const orgId = (params as Record<string, string | undefined> | undefined)?.orgId
    if (isForeignOrg(user, orgId)) return status(403, { message: FOREIGN_ORG_MESSAGE })
    // FR-20.4: only the home writes. Off its home, an org's writing routes answer 409.
    if (user) {
      const refusal = await homeGate(request.method, route, orgId)
      if (refusal) return status(409, refusal)
      // FR-20.55: on a master whose licence has run out, no new till session or sales document.
      // ⚠ Never `body` here: naming it would make Elysia parse every route's body, the Stripe
      // webhook's raw one included. A route that decides on its body asks in its handler.
      const unlicensed = await licenceGate(request.method, route, orgId)
      if (unlicensed) return status(402, unlicensed)
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
