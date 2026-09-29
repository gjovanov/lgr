/**
 * The complete list of routes that may be reached WITHOUT a token — and, by omission, the
 * assertion that every other route may not.
 *
 * ## Why this exists
 *
 * Authentication used to be opt-in per route, via the `isSignIn` macro on the auth plugins.
 * On Elysia 1.4 the legacy function-form `.macro(({ onBeforeHandle }) => ({ … }))` those
 * plugins declared **silently stopped running** — it throws no error, logs nothing, and every
 * route carrying `isSignIn: true` simply answered as if the caller were signed in. Measured
 * against the real route table before this landed: of 366 routes, **172 reached their handler
 * with no credentials at all**, including payroll payslips, bank accounts, tax returns and
 * stock levels. The 194 that did answer 401 did so from an explicit `if (!user)` inside the
 * handler — a check CLAUDE.md already described as "load-bearing" without anyone realising it
 * was, by then, the *only* check.
 *
 * ⚠ So the guard must not be something a route opts into. It is registered as an unconditional
 * `onBeforeHandle` on the auth plugins, exactly like the `isForeignOrg` tenant guard
 * (gjovanov/lgr#41) and for exactly the same reason: "73 leaks is what 'the author has to
 * remember' produces." A new controller gets authentication by existing. Forgetting the macro
 * — or the macro breaking again on some future Elysia — can no longer open a route, because
 * nothing about a route turns the check ON. The only way out is an entry in the table below,
 * which is one grep away from any reviewer.
 *
 * ## Matching
 *
 * Keyed on `"<METHOD> <route>"` where `route` is Elysia's MATCHED ROUTE PATTERN
 * (`/api/org/:orgId/…`), never the request path. Matching the pattern means a parameter value
 * can never be crafted to look like an allow-listed route — `:code` cannot be filled in with
 * something that makes `/api/invite/:code` match a different entry, because the pattern is
 * produced by the router, not by the caller.
 *
 * ⚠ Public does NOT mean unprotected; it means "authenticated by something other than a JWT":
 *   - `/api/stripe/webhook` verifies Stripe's signature header — it is called by Stripe, which
 *     has no session, so a 401 here would break billing outright.
 *   - `/api/oauth/*` is the pre-login handshake, by definition tokenless.
 *   - `/api/auth/logout` clears a cookie; refusing an expired session the ability to log out
 *     is a bug, not a protection.
 *   - `/api/invite/:code` is the one deliberately cross-org read (CLAUDE.md, #41) — the code
 *     IS the credential, and it is unguessable, single-purpose and use-counted.
 *   - `/api/stripe/plans` is the public price list shown before anyone has an account.
 */

/** `"<METHOD> <matched route pattern>"`. Every entry needs a reason in the block above. */
const PUBLIC_ROUTES = new Set<string>([
  // Pre-login credential exchange.
  'POST /api/auth/register',
  'POST /api/auth/login',
  'POST /api/auth/activate',
  'POST /api/auth/logout',

  // OAuth handshake — tokenless by definition (the token is what it produces).
  'GET /api/oauth/:provider',
  'GET /api/oauth/callback/:provider',
  'POST /api/oauth/register-oauth',

  // The second half of the OAuth handshake, and tokenless for the same reason: it is what
  // produces the token. The credential is the single-use `oauth_handoff` cookie the callback
  // set — not a JWT, and not anything in the URL. It replaced
  // `…/auth/oauth-callback?token=<JWT>`, which any attacker could fill in with a JWT of their
  // own to sign the visitor into their account (FR-14.14's "no JWT ever travels in a URL",
  // applied to the browser flow).
  'POST /api/auth/oauth-code/redeem',

  // The invite code is itself the credential; the one intentional cross-org read.
  'GET /api/invite/:code',

  // Public pricing, and Stripe's own signature-verified callback.
  'GET /api/stripe/plans',
  'POST /api/stripe/webhook',
])

/**
 * True when `route` may be served to a caller with no valid token.
 *
 * ⚠ Fails CLOSED on anything unexpected. If Elysia ever stops populating `route`, every route
 * becomes non-public and the app answers 401 across the board — loud, immediate, and safe.
 * The failure mode this replaces was the opposite one, and it went unnoticed for months.
 */
export function isPublicRoute(method: unknown, route: unknown): boolean {
  if (typeof method !== 'string' || typeof route !== 'string' || route === '') return false
  return PUBLIC_ROUTES.has(`${method.toUpperCase()} ${route}`)
}

/** The table itself, for the test that asserts it against the real route table. */
export const PUBLIC_ROUTE_KEYS: readonly string[] = [...PUBLIC_ROUTES]
