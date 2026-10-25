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
  /**
   * Liveness, and the one entry here that is NOT a credential exchange.
   *
   * ⚠ Public because the callers cannot hold a token by definition: FR-14.17's desktop
   * reachability probe runs before — and often instead of — minting one, and a load balancer
   * has none at all. It touches no database and returns `{ok:true}` and nothing else: no
   * version, no hostname, no counts. The body is the smallest true thing precisely because
   * anybody can read it.
   */
  'GET /api/health',

  // Pre-login credential exchange.
  'POST /api/auth/register',
  'POST /api/auth/login',
  'POST /api/auth/activate',
  // S-06: the person asking for a new activation link is by definition not signed in. It answers
  // the same for every address and mails only the address's own inbox, so it reveals nothing.
  'POST /api/auth/activate/resend',
  'POST /api/auth/logout',

  // OAuth handshake — tokenless by definition (the token is what it produces).
  'GET /api/oauth/:provider',
  'GET /api/oauth/callback/:provider',
  // Which sign-in buttons to show, asked before anyone has signed in. Provider names only.
  'GET /api/oauth/providers',

  // A forgotten password, by definition asked by someone who cannot sign in. The request answers
  // the same for any address (and is throttled); the reset is authorised by the emailed token.
  'POST /api/auth/password/forgot',
  'POST /api/auth/password/reset',

  // FR-20.40: the till PIN, asked by the next operator at a paired desktop. Both answer 404 off a
  // master and to anything but the LAN (with a paired desktop's token) or the console; the PIN is
  // the credential, it backs off rather than locks, and the session it makes reaches the till only.
  'GET /api/auth/local/methods',
  'POST /api/auth/local/pin',

  // The OAuth SIGN-UP handoff (security review S-19), tokenless for the same reason: completing
  // it is what produces the token. The credential is the `oauth_pending` cookie the callback set,
  // never anything in the URL or the body. It replaced `POST /api/oauth/register-oauth`, which
  // took an `oauth_pending` JWT the register form had read out of its own address bar — so a
  // planted `/auth/register?oauth_token=…` link chose whose identity the new account carried.
  'GET /api/oauth/pending',
  'POST /api/oauth/pending/register',

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

  // LGR Desktop registration (FR-14.20). Both are "authenticated by something other than a JWT",
  // and both are what PRODUCE the desktop's credential:
  //   - `enroll` is authenticated by a single-use enrollment code (or a reusable key for the
  //     field-test VMs). The code IS the credential, exactly as `/api/invite/:code` is;
  //   - `token` is authenticated by an Ed25519 signature over a nonce, made with a private key
  //     that never leaves the machine's OS keystore. Nothing about it is guessable, and a replayed
  //     assertion is refused by a unique index on `(desktopId, jti)`.
  // ⚠ `/ws/desktop` needs no entry: it is mounted outside `createApiApp()`, so this table's guard
  // is not in its chain at all. Its credential is its first message and a socket that has not
  // authenticated within 10 s is closed. A route table covering `/api` says nothing about `/ws`.
  'POST /api/desktop/v1/enroll',
  'POST /api/desktop/v1/token',

  // A master's registration with global (FR-20.2, plan step P2-1), and tokenless for the desktops'
  // reasons: `enroll` is authenticated by a single-use code an org admin minted (or a field lane's
  // reusable key) AND a signature by the key it registers; `token` by an Ed25519 assertion from
  // that key, never replayable (`node_assertions`). Both are 404 on a master.
  'POST /api/node/v1/enroll',
  'POST /api/node/v1/token',

  // FR-14.14 — the desktop's half of an OAuth sign-in, and tokenless for the same reason as its
  // browser twin above: it is what PRODUCES the token.
  //
  // ⚠ The credential here is the PAIR. The code arrived over `lgr://login`, a scheme any program
  // on the machine can register, so the code alone is deliberately not enough — redeeming it
  // also needs the PKCE verifier, which never left the shell until it went into a URL fragment
  // that no server and no log sees. A program that hijacks the deep link holds half a credential.
  'POST /api/auth/desktop-code/redeem',

  // LGR Desktop downloads (#93 follow-up): the link the hub offers with an update. Public because
  // the operator who clicks it is in the system browser, not signed in — often on the very machine
  // that needs the installer before it can sign in at all. What it serves is the signed installers
  // of a PUBLISHED `desktop-v*` release, and nothing else: a strict version shape, an allow-list of
  // installer file names, and the file must belong to that release (`release-download.ts`). The
  // GitHub token behind it never leaves the server and never follows the storage redirect.
  'GET /api/desktop/download/:version',
  'GET /api/desktop/download/:version/:file',
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
