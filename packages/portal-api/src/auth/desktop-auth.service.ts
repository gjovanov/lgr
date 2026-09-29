import { Elysia } from 'elysia'
import {
  DesktopError,
  loadActiveDesktop,
  verifyDesktopToken,
} from 'services/biz/desktop/desktop.service'
import { isPublicRoute } from 'services/biz/public-routes'
import type { IDesktop } from 'db/models'

/**
 * Authentication for `/api/desktop/v1/*` — the routes whose principal is a **desktop**, not a user
 * (FR-14.20).
 *
 * ## Built exactly like the S-01 fix, for exactly the S-01 reason
 *
 * ⚠ The guard is an **unconditional `onBeforeHandle`**, never a macro a route opts into. On Elysia
 * 1.4 the legacy function-form macro that `isSignIn` used **silently stopped running** — no throw,
 * no warning — and 172 of 366 routes answered anonymously for months. Nothing about a route here
 * turns the check on, so nothing about a route can turn it off. The only way out is an entry in
 * `public-routes.ts`, which is one grep from any reviewer.
 *
 * ⚠ `isSignIn: true` on a desktop route would be actively misleading: it belongs to `AuthService`
 * and means "a USER is signed in". These routes have no user.
 *
 * ## The row is the revocation list
 *
 * A valid signature on an unexpired token is not enough. `loadActiveDesktop` re-reads the row on
 * every request, so a revoked desktop is refused on its next call whatever its token's remaining
 * life, and a rotated key invalidates every token already issued — without any token blacklist.
 * That re-read is the entire reason these tokens can be short and stateless.
 */
export const DesktopAuth = new Elysia({ name: 'Service.DesktopAuth' })
  .derive({ as: 'scoped' }, async ({ headers }) => {
    const raw = headers.authorization
    const token = raw?.startsWith('Bearer ') ? raw.slice(7) : raw
    const claims = verifyDesktopToken(token)
    if (!claims) return { desktop: null as IDesktop | null, desktopError: null as DesktopError | null }
    try {
      return { desktop: await loadActiveDesktop(claims), desktopError: null as DesktopError | null }
    } catch (e) {
      // ⚠ Carried rather than thrown, so the guard below can answer with the specific code —
      // `desktop_revoked` vs `key_rotated` — which is what tells the shell whether to delete its
      // key or just re-authenticate (FR-14.22).
      return { desktop: null as IDesktop | null, desktopError: e instanceof DesktopError ? e : null }
    }
  })
  .onBeforeHandle({ as: 'scoped' }, ({ desktop, desktopError, status, request, route }) => {
    if (desktop) return
    if (desktopError) {
      return status(desktopError.statusCode, {
        code: desktopError.code,
        message: desktopError.message,
      })
    }
    // Fails CLOSED: an unexpected route value makes everything non-public.
    if (!isPublicRoute(request.method, route)) {
      return status(401, { code: 'unauthenticated', message: 'A desktop credential is required.' })
    }
  })
