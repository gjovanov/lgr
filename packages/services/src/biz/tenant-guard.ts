/**
 * gjovanov/lgr#41 — the whole of this codebase's cross-tenant check, in one function.
 *
 * Every data route is `/org/:orgId/…` and, before this landed, 66 of the 67 org-scoped
 * controllers treated the `orgId` in the URL as if it were the caller's — `const filter =
 * { orgId }` and nothing else. Measured by `tests/src/integration/tenant-isolation.flow.test.ts`:
 * 73 of the 83 probeable GET routes answered 200 with another organisation's data.
 *
 * The check lives here, import-pure, and is registered as a `beforeHandle` hook by the auth
 * plugins (`portal-api/src/auth/auth.service.ts` and `services/http/app-auth.service.ts`, the one domain plugin (FR-24.30))
 * so it applies to every route of every controller that authenticates — by default, with
 * nothing to opt into and nothing for a new controller to remember. `tenantPlugin` does NOT
 * help: it only adds the `orgId` field (`db/src/plugins/tenant.plugin.ts`).
 *
 * There is no exception list on purpose. Of the 83 routes probed, not one legitimately answers
 * for another org: `GET /org/:orgId/invite` merely lists an org's OWN invites, and the flows
 * that genuinely cross orgs — `GET /invite/:code`, OAuth registration — are not `/org/:orgId/…`
 * routes at all. If one ever needs to be, it does not belong under this prefix.
 */

/** The only part of the token this check reads. */
export interface TenantScopedUser {
  orgId?: unknown
}

export const FOREIGN_ORG_MESSAGE = 'This resource belongs to a different organisation'

/**
 * True when `orgId` names an organisation other than the caller's.
 *
 * ⚠ Compared as strings, deliberately: `user.orgId` arrives from the JWT (a string) and
 * `orgId` from the path, and in other call sites either can be an ObjectId. `backup.controller.ts`
 * — the one controller that had this check before #41 — does the same.
 *
 * Anonymous callers are NOT rejected here. Whether a route admits them is the `isSignIn`
 * macro's question (and, on several controllers, an explicit `if (!user)` in the handler —
 * per CLAUDE.md that check is load-bearing). Answering 403 for them here would turn "not
 * logged in" into "wrong organisation" on every route in the app.
 */
export function isForeignOrg(user: TenantScopedUser | null | undefined, orgId: unknown): boolean {
  if (!user) return false
  if (orgId === undefined || orgId === null || orgId === '') return false
  return String(user.orgId ?? '') !== String(orgId)
}
