/**
 * The routes an IDENTITY-ONLY token reaches (multi-org sign-in, Phase 2).
 *
 * A person who signed in without landing in an org (several memberships and none to land in, or
 * none at all) holds a token that names them and no org (`IdentityClaims`). It is not a session:
 * `asSessionUser` refuses it, so no org route can be reached with it. These are the only routes
 * that take it, and each one is about the person, never an org's data: which orgs they belong
 * to, and entering one.
 *
 * Deny-by-default, like `public-routes.ts`: the portal auth guard admits an identity-only token
 * on exactly these keys, and `identity-session.flow.test.ts` sends one to every other route in
 * the table and expects 401 from each. Keys are `METHOD route-pattern`, matched on the pattern.
 */
const IDENTITY_ROUTES = new Set<string>([
  // The person's memberships (and, once invitations are accepted while signed in, those too).
  'GET /api/auth/orgs',
  // Enter one of them: the answer is an ordinary org session for that membership.
  'POST /api/auth/switch',
  // The person's own account (Phase 4): their password, an invitation, an org they found.
  'POST /api/auth/password',
  'POST /api/invite/:code/accept',
  'POST /api/auth/orgs',
  // FR-20.39 (P2-4): "Sign in with LGR": the authorize page, for a person who has not entered an
  // org yet as well.
  'GET /api/idp/client',
  'POST /api/idp/authorize',
])

export function isIdentityRoute(method: unknown, route: unknown): boolean {
  if (typeof method !== 'string' || typeof route !== 'string' || !route) return false
  return IDENTITY_ROUTES.has(`${method.toUpperCase()} ${route}`)
}

/** For the route-table test: every key here must be a real route. */
export const IDENTITY_ROUTE_KEYS: readonly string[] = [...IDENTITY_ROUTES]
