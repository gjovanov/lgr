# Security review — 2026-09-21

Full-repo review of `lgr` @ `master`. Covers the auth layer, tenant guard, document store,
config/secret handling, OAuth, container build and dependencies.

**S-01**–**S-08**, **S-17**–**S-28** are fixed. The rest are open, ordered by severity below.

⚠ **S-17 and S-18 were not in the original review.** S-17 was found while fixing S-04, in the same
function, and is the most serious finding in this document — an unauthenticated stranger could join
any organisation whose slug they could name. S-18 is the `/ws/fiscal-bridge` endpoint, which
authenticated nothing at all; the review covered `/api` and never looked at `/ws`, and the S-01
guard does not reach there either. S-19 is the sign-up half of S-05, which that fix did not reach.
S-20 is a second account takeover in the SAME `getOrCreateUser` S-17 hardened — an unverified
provider email was trusted to link and sign in as an existing member — found while re-reviewing that
function. S-21 is a third cross-tenant takeover, through the admin user-management routes, found while
planning the multi-org sign-in; S-22 (the session-token rules) and S-23 (OAuth sessions ignoring permission
sets) came out of the same work, and S-24 (production running without `NODE_ENV=production`) out of its
field test. All eight are written up at the end.

S-25–S-28 were found in October 2026 while specifying and building offline operation (FR-20). Each
was fixed in a private fork, deployed the same day, and published as a GitHub security advisory once
the fix had been verified on production. They are written up at the end too.

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| S-01 | Critical | `isSignIn` macro dead on Elysia 1.4 — 172/366 routes answered anonymously | **Fixed** |
| S-02 | Critical | `JWT_SECRET` silently falls back to a committed default | **Fixed** |
| S-03 | High | Path traversal → arbitrary file write via upload filename | **Fixed** |
| S-04 | High | OAuth `state` generated but never verified (login CSRF) | **Fixed** |
| S-05 | High | JWT delivered in a URL query string (and, unlogged, login fixation) | Fixed 2026-09-29 |
| S-06 | High | `/auth/register` returns the activation token in its response | **Fixed 2026-10-02** |
| S-07 | Medium | CORS reflects any origin with `credentials: true` | **Fixed 2026-10-04** |
| S-08 | Medium | No rate limiting or lockout on `/auth/login`; account enumeration | **Fixed 2026-10-04** |
| S-09 | Medium | Password minimum is 6 characters | Open |
| S-10 | Medium | `.dockerignore` does not exclude the secrets `.gitignore` protects | Fixed 2026-10-21 (root user: open) |
| S-11 | Medium | Swagger served unauthenticated in production | Open |
| S-12 | Medium | Raw `err.message` returned on 500 | Open |
| S-13 | Low | Live credentials in a OneDrive-synced working copy | Open |
| S-14 | Low | `User.password` has no `select: false` | Open |
| S-15 | Low | Body validation runs before the auth guard (schema disclosure) | Open |
| S-16 | Info | Dependency audit: 2 transitive advisories, neither reachable | Open |
| **S-17** | **Critical** | **OAuth self-enrolment — anyone could join any org they could name** | **Fixed** |
| **S-18** | **High** | **`/ws/fiscal-bridge` authenticated nothing; a registration evicted the till's bridge** | **Fixed 2026-09-29** |
| **S-19** | **High** | **OAuth sign-up put its credential in a URL, and honoured a planted one** | **Fixed 2026-10-01** |
| **S-20** | **Critical** | **OAuth linked an existing account on an unverified provider email (nOAuth takeover); deactivated users could sign in** | **Fixed 2026-10-01** |
| **S-21** | **Critical** | **An org admin could read, rewrite and deactivate any org's users — `/org/:orgId/user/:userId` looked the user up by `_id` alone** | **Fixed 2026-10-02** |
| S-22 | Low | A stale `auth` cookie overrode the bearer token; any validly signed JWT counted as a session | **Fixed 2026-10-04** |
| S-23 | Medium | An OAuth sign-in ignored permission sets: a narrowed user got the role's full rights, own-records limits were dropped, and the fiscal operator code was missing | **Fixed 2026-10-04** |
| S-24 | High | Production ran without `NODE_ENV=production`: the S-02 secret guards never ran, desktop tokens were signed with the committed dev key, and session cookies lacked `Secure` | **Fixed 2026-10-05** (config) |
| **S-25** | **Critical** | **By-id routes in 21 controllers ignored the org: any signed-in user could read, change, delete or move another org's records** ([GHSA-mfh7-36vq-fhhp](https://github.com/gjovanov/lgr/security/advisories/GHSA-mfh7-36vq-fhhp)) | **Fixed 2026-10-23** |
| S-26 | Medium | PDF rendering served the app's working directory over HTTP on every interface while a document printed ([GHSA-76q2-87cq-2rvm](https://github.com/gjovanov/lgr/security/advisories/GHSA-76q2-87cq-2rvm)) | **Fixed 2026-10-23** |
| **S-27** | **Critical** | **The two import upload endpoints wrote a file wherever its name pointed: any signed-in user could write any file in the container, as root** ([GHSA-f2fv-8rm4-9c9x](https://github.com/gjovanov/lgr/security/advisories/GHSA-f2fv-8rm4-9c9x)) | **Fixed 2026-10-23** |
| **S-28** | **High** | **A role's permissions were enforced by the UI alone: read-only roles could write invoices, journal entries, payroll and stock through the API** ([GHSA-gg6h-4gv9-w2hx](https://github.com/gjovanov/lgr/security/advisories/GHSA-gg6h-4gv9-w2hx)) | **Fixed 2026-10-23** |

---

## S-01 — `isSignIn` was a no-op; 172 of 366 routes answered anonymously (Critical, **fixed**)

**Where:** `portal-api/src/auth/auth.service.ts`, the seven `*/src/auth/app-auth.service.ts` copies.

Both auth plugins declared their guard through Elysia's 1.0 function-form macro:

```ts
.macro(({ onBeforeHandle }) => ({
  isSignIn(_value?: boolean) { onBeforeHandle(({ user, status }) => { … }) },
}))
```

`package.json` asks for `elysia: ^1.3.0`; the installed version is **1.4.29**. On 1.4 that form
is accepted and then **never invoked** — no throw, no warning, no type error. Every
`isSignIn: true` in the codebase had silently become a comment.

`isForeignOrg` could not compensate: it returns `false` for an anonymous caller by design
(`tenant-guard.ts:44`), so a tokenless request passed the tenant guard too and fell straight
through to the handler.

**Measured** against the real route table (`createApiApp()`, the same table `unified.ts` serves),
probing every route with no cookie and no `Authorization` header:

```
TOTAL 366 | 401-guarded 194 | NOT guarded 172
```

The 194 that did answer 401 did so from an explicit `if (!user)` **inside the handler** — the
check CLAUDE.md calls "load-bearing" without recording that it had become the only one. The
other 172 had nothing. Among the GET routes reaching handlers anonymously:

```
/api/org/:orgId/payroll/payslip/            /api/org/:orgId/accounting/bank-account/
/api/org/:orgId/payroll/timesheet/          /api/org/:orgId/accounting/tax-return/
/api/org/:orgId/warehouse/stock-level/      /api/org/:orgId/accounting/fiscal-year/
/api/org/:orgId/warehouse/price-list/       /api/org/:orgId/invoicing/payment-order/
…48 GET routes total, plus 124 POST/PUT/DELETE
```

Note `:orgId` is supplied by the caller, so this is not scoped to one tenant — any org's
payslips, bank accounts and tax returns, to anyone who can reach the port.

CLAUDE.md records the symptom twice ("`isSignIn` does not actually reject anonymous callers",
"verified against the running server") as a local quirk of the reports and files controllers.
It was neither local nor a quirk.

### Fix

Authentication is now **deny-by-default and unconditional**, in the same `onBeforeHandle` that
already runs the tenant guard — the shape #41 established, for the reason #41 gives: *"73 leaks
is what 'the author has to remember' produces."*

```ts
.onBeforeHandle({ as: 'scoped' }, ({ user, params, status, request, route }) => {
  if (!user && !isPublicRoute(request.method, route)) {
    return status(401, { message: 'Unauthorized' })
  }
  const orgId = (params as Record<string, string | undefined> | undefined)?.orgId
  if (isForeignOrg(user, orgId)) return status(403, { message: FOREIGN_ORG_MESSAGE })
})
```

Nothing about a route turns the check on, so nothing about a route can turn it off. The only
way out is an entry in `services/biz/public-routes.ts` — a 10-entry table, each with its
reason, one grep from any reviewer:

```
POST /api/auth/register · login · activate · logout     pre-login credential exchange
GET  /api/oauth/:provider · /api/oauth/callback/:provider · POST /api/oauth/register-oauth
GET  /api/invite/:code            the code IS the credential (the one intentional cross-org read)
GET  /api/stripe/plans            public price list
POST /api/stripe/webhook          Stripe-signed; Stripe has no session
```

Matching is on the **matched route pattern** (`/api/invite/:code`), never the request path, so
a caller-supplied parameter can never spell its way into an exemption. `isPublicRoute` fails
**closed** on anything unexpected — if Elysia stops populating `route`, the app 401s across the
board rather than opening up.

The macros were also migrated to the object form so `isSignIn: true` works again as a second
belt and as documentation of intent. `access()` was checked and has **zero call sites**, so no
permission check was silently passing.

**Verified:**

```
before: TOTAL 366 | 401-guarded 194 | NOT guarded 172
after:  TOTAL 366 | 401-guarded 286 | NOT guarded  80   ← all 80 are 422 or the 10 public routes
```

The residual 80 are body-validation 422s (see **S-15**) plus the 10 intended public routes; a
direct test proves those same routes 401 once the body validates.

New regression test `tests/src/integration/anonymous-access.flow.test.ts` — a property over the
real route table, in the shape of its `tenant-isolation` sibling, so a controller added next
year is covered the day it is mounted. Its sharpest assertion needs no database: a guarded
route never reaches Mongo, so **any 5xx means a handler ran**.

---

## S-02 — `JWT_SECRET` silently fell back to a committed default (Critical, **fixed**)

**Where:** `packages/config/src/index.ts:120`

```ts
secret: process.env.JWT_SECRET || 'lgr-dev-secret',
```

Every JWT in the system — org, role, full permission list — is signed with this. A cluster
that booted with `JWT_SECRET` unset, misspelled, or resolved to an empty string from
`lgr-secret` would come up perfectly healthy, log nothing unusual, and accept an `admin` token
for any org that anyone who has read this repository can mint. There was no startup validation
anywhere, and no observable difference until it is being exploited.

### Fix

The dev fallback survives for `bun run dev` and the test suite. In production, a missing,
default-valued, or too-short secret is a **fatal boot error** — a pod that crash-loops is a
page at 03:00; a pod serving forgeable tokens is a breach nobody is looking for.

```
dev, unset             -> BOOT  (len=14, dev fallback)
prod, unset            -> FATAL JWT_SECRET is not set. Refusing to start…
prod, empty string     -> FATAL JWT_SECRET is not set. Refusing to start…
prod, dev default      -> FATAL JWT_SECRET is set to the committed development default…
prod, too short (20)   -> FATAL JWT_SECRET is 20 characters; 32 is the minimum…
prod, good (48)        -> BOOT
```

The 32-character floor matters as much as the presence check: a short secret is brute-forceable
offline from a single captured token, needing no further access to the cluster.

> ### ⚠ Before deploying
>
> **Check `JWT_SECRET` in the prod `lgr-secret` is ≥32 characters and is not `lgr-dev-secret`,
> or this fix will crash-loop the cluster.** The local `.env` is 35 characters and passes; the
> sealed secret could not be read from here. If it needs rotating, note that **rotating
> `JWT_SECRET` invalidates every issued token** — all users are signed out at once.
> `openssl rand -base64 48`

Related, not fixed: `mongodb://ttt_admin:TtT_5uper5ecret…@localhost` is in git history at
`ba757ed:.env` (initial commit). Dev-only and `.env` is untracked now — rotate if that password
was ever reused elsewhere.

---

## S-03 — Path traversal → arbitrary file write (High, **fixed**)

**Where:** `services/src/biz/files/doc-store.service.ts`

```ts
const canonicalPath = join(dir, file.name)   // file.name is caller-controlled
await Bun.write(canonicalPath, buf)
```

`file.name` is the `filename=` of a multipart part — chosen by the caller. Browsers strip path
components before sending; `curl` and every other HTTP client do not. `join()` does not help:
normalising `..` is precisely what it is for. A part named
`../../../../app/packages/portal-api/src/unified.ts` resolved cleanly out of the uploads tree,
as did `..\..\lgr-seal.key`.

`docDate` **was** already validated (`files-api/.../file.controller.ts:84`) — the filename was
the hole. The route is gated on `admin.settings`, but `admin` is a TENANT-scoped role: this
turned the regal-pz shop owner into write access on the host every other tenant shares.

### Fix

`services/biz/files/safe-path.ts` — import-pure, two functions, applied in two layers because
either alone has a gap:

- **`safeFileName`** sanitises at INGEST, so the value persisted on `DocFile.originalName`
  (and the `docNumber` derived from it) is already clean. Every later path is built from those
  stored values, so cleaning them once covers code not yet written.
- **`containedJoin`** asserts at every SINK, so a row written before this landed — or a path
  that forgets to sanitise — still cannot escape. It is the check that does not depend on
  anyone remembering.

All **16** path constructions in `doc-store.service.ts` now go through one or both, and `join`
is no longer imported there — so `join(` returning nothing in that file is the invariant.

Three specifics worth keeping:

- `docNumber` falls back to the raw filename when it carries no digits, and
  `resolveCompareDump` joins that into a path — so the name had to be sanitised **before**
  `parseDocMeta`, not merely before `canonicalPath`.
- `resolveDownload`'s existing separator-strip left `..` intact as a whole segment. It passed
  the one input it existed to stop.
- `safeFileName` runs **both** `win32` and `posix` basename rather than the platform's.
  `path.basename` follows the host, so the Linux server and the Windows desktop build
  disagreed about drive prefixes and backslashes — and Linux is the half that does *not*
  strip a backslash path.

Also closed: Windows device names (`CON`, `NUL`, `COM1`…), which open a device rather than a
file, and trailing-dot/space names that Windows folds together so one document silently
overwrites another.

**Tests:** `packages/tests/src/unit/safe-path.test.ts` (15) — no database, no filesystem. The
property is about strings, and a test that writes files only ever samples the inputs someone
thought of.

Still open here: the upload enforces `MAX_BATCH` (count) but not `config.upload.maxFileSize`,
and has no extension allow-list.

---

## S-04 — OAuth `state` generated but never verified (High, **fixed**)

**Where:** `services/src/biz/oauth.service.ts`, `portal-api/src/controllers/oauth.controller.ts`

`buildAuthUrl` minted `{ orgSlug, mode, nonce: crypto.randomUUID() }`; `parseState`
base64-decoded whatever came back from the provider and `JSON.parse`d it. The nonce was never
stored, so it was never checked — `state` carried no evidence about who started the flow, and
the callback completed for anybody. An attacker obtains a `code` for their own account, induces
the victim's browser to hit the callback, and the victim is silently signed in as the attacker.

### Fix

The nonce is now minted by the **controller**, so one value can be in two places: in the
`state` (which travels through the provider) and in an httpOnly `oauth_state` cookie (which
does not). The callback requires them to match, compared in constant time, and clears the
cookie before anything else can return — single-use, so a failed attempt cannot be replayed.

⚠ `sameSite: 'lax'`, and it **cannot** be `'strict'`: the callback arrives as a top-level
navigation from the provider's domain, and a strict cookie is withheld on exactly those. Here
the stricter setting is the broken one, so it is recorded in the code rather than rediscovered.

`parseState` now reads fields individually and coerces them to strings, so a crafted state
cannot introduce keys the callback never asked for, and `orgSlug.toLowerCase()` cannot be
handed an object.

**Tests:** `oauth-hardening.flow.test.ts` — nonce round-trip, refusal to start a flow without
one, invite-code round-trip, and a hostile state asserted down to known string fields.

---

## S-05 — JWT delivered in a URL query string (High, **fixed 2026-09-29**)

**Where:** `portal-api/src/controllers/oauth.controller.ts:91`

```ts
Response.redirect(`${config.oauth.frontendUrl}/auth/oauth-callback?token=${token}`, 302)
```

A 24-hour session token in a URL lands in browser history, in the `Referer` header of every
outbound link from that page, and in every ingress/proxy access log. Set the `auth` cookie
server-side on the redirect — `/auth/login` already does exactly this (`auth.controller.ts:53`)
— and redirect to a bare path.

**⚠ It was worse than logged.** This entry described *leakage* — history, `Referer`, access logs.
The direction nobody wrote down is that the receiving view stored **whatever** `?token=` it was
handed, unvalidated (`OAuthCallbackView.vue:25-33`), which makes it **login fixation**: an
attacker who starts their own OAuth flow and sends a victim
`https://lgrai.app/auth/oauth-callback?token=<their JWT>` signs the victim's browser into the
**attacker's** account and org. FR-14.24 gated that pattern across all eight SPA routers, and this
route is the one it had to exempt — being exempt is precisely what kept it alive.

**Fixed:** the callback now stores the claims in a one-time server-side record (`OAuthHandoff`)
and puts a random code in an **httpOnly** cookie scoped to `/api/auth`; the SPA posts an empty
body to `POST /api/auth/oauth-code/redeem`, which consumes the code and answers exactly as
`/auth/login` does. An attacker cannot set a cookie on our origin, so there is nothing left to
plant — the vector is removed rather than narrowed. The router's exemption for this route is gone,
and so is the `skip` escape hatch that implemented it. No JWT travels in a URL any more, which is
also FR-14.14's rule for the desktop client.

**Tests:** `oauth-handoff.flow.test.ts` (single use incl. two concurrent redeems, expiry, hashed
storage, claims-not-tokens at rest, one flat refusal message), `token-handoff.test.ts` (no route is
exempt), `e2e/tests/oauth.spec.ts` (a planted token signs nobody in and is stripped from the URL).

---

## S-06 — `/auth/register` returns the activation token (High, **fixed 2026-10-02**)

**Where:** `portal-api/src/controllers/auth.controller.ts:22`, `services/biz/auth.service.ts:170`

```ts
return { message: 'Registration successful. Please check your email…', userId, activationToken }
```

Email verification exists to prove control of an address. Returning the token in the HTTP
response means the caller never needs to see the email, so the check proves nothing — anyone
can register `billing@some-customer.com` and immediately activate it. Drop `activationToken`
from the response body (keep it on the service return for tests if useful).

### Fix

**It was worse than logged, in the other direction too.** Dropping the token alone would have
locked everyone out. The email's link pointed at `/auth/activate`, a route portal-ui did not have,
so the response was the only working way to activate. And `RegisterView` never used it: the store
wrote the absent `data.token` into `lgr_token` as the string `"undefined"`, so a new registrant was
bounced to the landing page by the first 401 with an account they could not activate. All of these
ship together:

- **The response carries no code.** `register()` still returns it to its caller (tests read it);
  `POST /auth/register` no longer echoes it.
- **The link carries the code in the URL fragment**, built in one place
  (`auth.service.ts#activationUrl`): `/auth/activate#userId=…&code=…`. A fragment never reaches a
  server or an access log, and the page clears it with `history.replaceState` before posting it.
  It is deliberately not called `token`, because every SPA router treats `?token=` as a session
  handoff (FR-14.24) and would strip it first. Same shape as `/auth/desktop-redeem`.
- **portal-ui has the page:** `ActivateView`, which also asks for a new link when one is missing or
  dead. The register screen now says "check your email" instead of storing a token it never got.
  The sign-in page links to the page for a lost email.
- **`POST /auth/activate/resend {email}`**, so an expired link is recoverable. Prod runs a 5-minute
  TTL (`ACTIVATION_TOKEN_TTL_MINUTES` in the `lgr-config` ConfigMap), and the response is no longer
  a fallback. The endpoint:
  - answers identically for pending, active, deactivated and unknown addresses;
  - mails only accounts that are inactive and were never deactivated by an admin;
  - applies a 60 s cooldown while the last link is still valid.
- **An account an admin deactivated cannot be revived by the code mailed before**: `/activate`
  refuses it with the same message as a bad code.
- **With no SendGrid key** the link is logged for local use, never in production. The template now
  escapes the name and org it interpolates.

**Tests:** `registration-activation.flow.test.ts` covers:
- the response has no code, anywhere;
- the link is in the fragment, with no query and no `token=`;
- a wrong code and an expired code are both refused;
- resend answers identically for pending and unknown addresses, replaces an expired code with one
  that activates exactly once, mints nothing for an active account, is throttled, and never reaches
  an admin-deactivated account, whose old code is refused too.

`e2e/tests/auth.spec.ts` covers the page: a bad link and fragment clearing, the resend answer, and
the link from the sign-in page.

---

## S-07 — CORS reflects any origin with credentials (Medium, **fixed 2026-10-04**)

**Where:** `portal-api/src/unified.ts:42` — `cors({ origin: true, credentials: true })`

Echoes back whatever `Origin` the caller sends, with credentials allowed. Today
`sameSite: 'lax'` on the auth cookie is what actually prevents exploitation; the day someone
needs a cross-site embed and flips that to `'none'`, every site on the internet can make
authenticated calls as a logged-in user. Pin to the known frontend origins
(`config.oauth.frontendUrl` and the dev ports).

### Fix

`portal-api/src/cors.ts#corsPlugin()` answers only:
- **The configured frontend and app URLs** (`OAUTH_FRONTEND_URL`, `APP_URL`), normalised to
  origins.
- **`CORS_ORIGINS`**, a comma-separated list for a deliberate extra. A malformed entry is skipped,
  never widened into a wildcard.
- **The per-app Vite dev ports, outside production only.** That is `localhost` / `127.0.0.1` on
  4000, 4001 and every `APP_REGISTRY` dev port, because a domain SPA on :4021 calls the unified API
  on :4001 directly for `/auth/me`. Never in production: a page anyone runs on those ports must not
  reach lgrai.app with a user's credentials.

In production every SPA is served from the API's own origin, so the browser never sends a
cross-origin request and nothing legitimate changes.

⚠ CORS is not an access control. A refused origin's request still reaches the server; the browser
only withholds the response. The auth guards decide who may do what.

**Tests:** `auth-precedence.flow.test.ts` checks that an arbitrary origin is not reflected, that the
app's own origin is (with credentials), and that a dev port is outside production. The plugin is
mounted around `createApiApp()` in the test, because `unified.ts`, not the route table, applies it.

---

## S-08 — No rate limiting or lockout on login; account enumeration (Medium, **fixed 2026-10-04**)

**Where:** `auth.controller.ts:44`, `services/biz/auth.service.ts:186-193`

Nothing caps password attempts anywhere in the app. `login()` also distinguishes
`'Organization not found'` / `'Invalid credentials'` / `'Account is disabled'`, enumerating
valid orgs and accounts. Add a failed-attempt counter on `User` with backoff; collapse the
first three errors into one message.

### Fix

**Nothing is said before the password is proven.** `login()` (`auth.service.ts`):
- **One answer without the password.** A missing org, a missing user, a wrong password and an
  OAuth-only account all get `401 {message: 'Invalid credentials', code: 'invalid_credentials'}`.
  `'Please login with your OAuth provider'` was a fourth enumerator the entry did not list.
- **One argon2 verify on every path.** With no real hash to check, it verifies against a decoy
  hashed with the runtime's own defaults. The old early returns let response time alone reveal
  which usernames existed.
- **Account state only after the password verifies.** `'Account is disabled'` (deactivated by an
  admin) and the new `'Account not activated…'` (S-06's pending registration) are said only to
  someone who has just proven the password.

**A throttle, but not a counter on `User`.** A per-user counter cannot see a password spray across
many accounts, and it hands anyone who can name an account a way to lock its owner out. Three
counters live in a global `login_throttles` collection (no `orgId`, so backups skip it; rows expire
a day after the last write), in `services/biz/login-throttle.service.ts`:

| Key | Limit | Catches |
|---|---|---|
| `pair:<ip>\|<account>` | 5 failures | a guesser at one address. It locks only that address out of that account, so the owner elsewhere still signs in |
| `acct:<account>` | 30 failures | one account guessed from many addresses |
| `ip:<ip>` | 100 failures | one address spraying many accounts |

- Each limit is per 15-minute window, followed by a 15-minute lock; all are configurable
  (`LOGIN_THROTTLE_*`).
- **Only failures count**, so a till, an import script or the e2e suite signing in all day never
  trips it. A success clears that account's counters, but not the address's.
- A locked caller gets `429 {code: 'too_many_attempts', retryAfterSeconds}` with `Retry-After`,
  **before** any argon2 work.
- The counters are in Mongo, not memory, because prod runs more than one pod.
- Each update is one atomic pipeline `updateOne`, with a retry on a first-insert race.
- A throttle that can't be read fails open.

**The address is the one our proxy saw.** lgrai.app reaches the pod only through the mars nginx,
which sets `X-Real-IP $remote_addr` (replacing the client's) and appends to `X-Forwarded-For`. The
new `portal-api/src/auth/client-ip.ts` reads `X-Real-IP`, then the LAST `X-Forwarded-For` hop.
Trusting the first hop, which the client writes, would let anyone choose whose address a failure is
charged to, and lock that person out. `desktop-v1.controller.ts` had exactly that copy; it now uses
the shared helper.

**Tests:**
- `login-throttle.flow.test.ts` (over HTTP) covers:
  - the pair lock, which still refuses once the guesser has the password;
  - the owner at another address still signing in;
  - the account-wide lock and the per-address spray lock;
  - successes never counting;
  - a spoofed first `X-Forwarded-For` hop not being charged;
  - a correct password on a pending account not counting;
  - four kinds of refusal getting byte-identical answers.
- `auth.flow.test.ts` covers the generic answer for a missing org, the two post-password messages,
  and the silence without the password.

`.env.test` sets `LOGIN_THROTTLE_ENABLED=false`, because suites fail logins on purpose.

---

## S-09 — Password minimum is 6 characters (Medium, open)

**Where:** `auth.controller.ts:36` — `password: t.String({ minLength: 6 })`

No composition rule and no breach check, on a system holding payroll and fiscal records.
Raise to 12. Hashing itself is fine (`Bun.password.hash`, bcrypt).

---

## S-10 — `.dockerignore` does not exclude the secrets `.gitignore` protects (Medium, fixed 2026-10-21)

**Where:** `Dockerfile:2` (`COPY . /app`), `.dockerignore`

`.dockerignore` excludes `.env*` but **not** `lgr-seal.key`, `*.seal.key`, `.secrets/`,
`*.xlsx`, `*.csv`, or `ap_*.json` — all of which `.gitignore` protects at length, and for
reasons it spells out:

> the PRIVATE half of the backup seal key … the half that can OPEN a sealed bundle, and a
> bundle carries every collection in an organisation

The build runs in `mars:~/lgr`, a working checkout. If the seal key or
`.secrets/google-oauth-client.json` is present there, it is baked into the image and pushed to
`registry.roomler.ai`. Mirror the `.gitignore` secret block into `.dockerignore`.

Also worth confirming the runtime stage does not run as root — the `apt-get` layer needs root
and no `USER` directive follows it.

**Fixed 2026-10-21:** `.dockerignore` now covers everything `.gitignore` keeps out of git (secrets,
the seal key, business-data exports, `uploads/`), with `**/` so a nested copy is excluded too, plus
the build output and local tooling. Measured on a working copy: the build context went from 6.79 GB /
22,148 files to 11.7 MB / 1,345, and the only secret-shaped file left in it is `.env.example`.
⚠ An image built BEFORE this from a checkout that held any of these files carries them: check the
images in the registry and rotate whatever they held. The root-user point above is still open.

---

## S-11 — Swagger served unauthenticated in production (Medium, open)

**Where:** `unified.ts:74` — full route inventory and body schemas for every module, free to
anyone who can reach the port. Gate on `NODE_ENV !== 'production'`.

---

## S-12 — Raw `err.message` returned on 500 (Medium, open)

**Where:** `unified.ts:72` — `return { message: err.message || 'Internal server error' }`

Leaks Mongoose validation internals and occasionally filesystem paths. Log the detail with a
correlation id; return the id and a generic string.

---

## S-13 — Live credentials in a OneDrive-synced working copy (Low, open)

The working copy is `C:\Users\atana\OneDrive\Desktop\Projects\lgr`. `.env` holds a populated
`JWT_SECRET`, `SENDGRID_API_KEY`, `GOOGLE_CLIENT_SECRET` and `BACKUP_GOOGLE_DRIVE_REFRESH_TOKEN`
— the token `config/index.ts` describes as able to **delete the off-site backups** — and
`lgr-seal.key` sits beside them.

All correctly gitignored. All continuously uploaded to Microsoft's cloud and synced to every
device signed into that account, which is a copy of the backup-deletion credential and the
bundle-opening key in a place neither threat model accounts for. Move the checkout outside
OneDrive, or relocate `.env` and the seal key.

---

## S-14 — `User.password` has no `select: false` (Low, open)

FR-11.3 patched the one endpoint that was leaking bcrypt hashes (`GET /org/:orgId/user`) with an
explicit projection, but the model-level default is still "include the hash", so the next
handler that forgets a projection leaks again. `config.backup.emailAttachBundle`'s comment
already names this as the reason that flag defaults off.

---

## S-15 — Body validation runs before the auth guard (Low, open)

Elysia runs schema validation before `beforeHandle`, so ~74 POST/PUT routes answer **422 with
the full expected schema** to a caller holding no token. Not a bypass — the handler is never
reached, and those routes 401 once the body validates (asserted in
`anonymous-access.flow.test.ts`) — but it discloses the API shape to anonymous callers and
muddies the 401 signal. Worth moving the auth check to `onRequest` if that ordering matters.

---

## S-16 — Dependency audit (Info)

`bun audit` reports **2**, not the 4 in CLAUDE.md's Known Issues (that entry is stale):

- `js-yaml` — high, CPU exhaustion on merge keys, transitive via `md-to-pdf`
- `uuid` — moderate, missing buffer bounds check, transitive via `exceljs`

Neither is reachable from untrusted input in this codebase: no user-supplied YAML reaches
`md-to-pdf`, and `exceljs`'s uuid use is internal. No action needed beyond refreshing the
Known Issues entry.

---

## Suggested order for the rest

**S-09** (S-10 was fixed on 2026-10-21, apart from its root-user note; S-07 and S-08 on 2026-10-04).

*(S-06 was fixed on 2026-10-02. Like S-05, it was not the one-line change the entry suggested:
the response was the only working way to activate, so removing it needed the activation page and a
resend path to ship with it.)*

*(S-05 was fixed on 2026-09-29. It turned out not to be small: the entry logged only the leakage
side, and the fixation side needed the handoff to be redesigned rather than the redirect tidied.)*
---

## S-17 — OAuth self-enrolment into any organisation (Critical, **fixed**)

> Not in the original review. Found while fixing S-04, in the same function.

**Where:** `services/src/biz/oauth.service.ts#getOrCreateUser`

```ts
const org  = await Org.findOne({ slug: orgSlug.toLowerCase() })
let   user = await User.findOne({ email: info.email, orgId: org._id })
if (!user) { user = await User.create({ …, role: 'member', isActive: true, … }) }
```

`orgSlug` arrives from the `org_slug` query parameter by way of the OAuth `state`. It is the
caller's choice, never a fact about them. So the entire attack was:

```
GET /api/oauth/google?org_slug=<any org slug>
  → sign in with any personal Google account
  → active `member` of that organisation
```

with `accounting.read`, `inventory.read`, `invoicing.read`, `payroll.read` and `reports.read`
— the payslips included. No invite, no approval, nothing for the target org to notice. Any of
the five providers works.

It also made the #41 tenant guard irrelevant on this path: the attacker ends up holding a
legitimate JWT for the victim's org, so there is no boundary left to cross.

**Proven** before the fix, against a seeded org:

```
  isNew       : true
  org         : 6ab26151f5d24e4cf5c12609 === victim org ✓
  role        : member
  isActive    : true
  permissions : accounting.read, inventory.read, invoicing.read, payroll.read, reports.read
```

⚠ **Fixing S-04 does not close this, which is why they are separate findings.** The state check
proves the browser finishing the flow is the one that started it — and here it is: the
attacker's own, with a nonce that matches perfectly. Self-enrolment is an *authorisation*
hole and needs an authorisation answer.

### Fix

Membership must now pre-exist, or be granted by an **invite** — the same object `register()`
already requires for joining an org with a password, carrying the same `targetEmail` pin,
expiry and use count. An OAuth identity is proof of an email. It was never proof of belonging
anywhere.

- Existing member signs in → unchanged.
- `mode=register` (new org) → unchanged.
- Stranger with no invite → refused, told to ask an administrator.
- Stranger with a valid invite → admitted **with the invite's role**, not a hardcoded `member`.
- Invite for a different org, or pinned to a different email → refused. The invite decides the
  org, not the URL; honouring `org_slug` alongside an invite for elsewhere would restore the
  hole with one extra step.
- The invite is consumed with `incrementUseCount` **before** the user is created, so two
  simultaneous callbacks cannot both pass `validate()` on a single-use invite.

**UI:** `RegisterView`'s OAuth buttons now pass `invite_code` + `org_slug` when the page was
opened from an invite link. Without that, closing the hole would have left invited users whose
only identity is a Google account with no way in — the insecure path was also the only path.

**Tests:** `oauth-hardening.flow.test.ts` — refusal without an invite, existing member still
signs in, invited stranger admitted with the invite's role, wrong-org invite, wrong-email
invite, bad code, and a single-use invite refusing a second person.

⚠ **Ops:** anyone who joined an org via OAuth before this landed already has an account, and
this change does not remove it. Worth auditing: users with `oauthProviders` set, no password,
and no matching invite.


---

## S-18 — `/ws/fiscal-bridge` authenticated nothing (High, **fixed 2026-09-29**)

> Not in the original review — the WebSocket surface was not covered by it. Found while planning
> FR-14, recorded as FR-14.25, and fixed as its own chunk.

**Where:** `portal-api/src/websocket/fiscal-bridge.ts`, mounted at `unified.ts:103`.

```ts
case 'fiscal:bridge:register': {
  const { deviceNumber, orgId, warehouseId } = msg
  // …no credential of any kind…
  if (bridgeConnections.has(deviceNumber)) {   // and a new registration EVICTED the old bridge
```

Three problems in one handler:

1. **No authentication at all.** A registration named `{deviceNumber, orgId}` and was believed.
   The device number is **printed on every fiscal receipt**, so it is public knowledge, and the org
   id is in every URL the customer's own browser shows.
2. **A new registration silently evicted the till's bridge.** So the above was not merely a spoof —
   it was "take a named shop's printer offline from anywhere", repeatable, with the cashier seeing
   only that printing stopped working.
3. **Bridges were keyed by `deviceNumber` alone**, without the org, so two tenants using the same
   device number shared one slot: registering in org A unregistered org B's printer.

⚠ The upgrade is reached **outside** `createApiApp()`, so the S-01 guard never applied to it and
`anonymous-access.flow.test.ts` never probed it. A route table that covers `/api` says nothing
about `/ws`.

### Fix

- The register message **carries the user's JWT**, verified with the same plugin and secret the
  routes use (`portal-api/src/auth/verify-token.ts`), and the caller must hold **`pos.write`** in
  the device's own org. The **org is taken from the token**, never from the message; a message
  naming a different one is refused rather than ignored.
- The **upgrade stays tokenless on purpose** — a credential in a URL lands in ingress and proxy
  logs, which is S-05's lesson — so the credential is the first message, and a socket that has not
  authenticated within **10 s is closed**. Until it authenticates, `register` is the only message
  it may send.
- Bridges are keyed by **`(orgId, deviceNumber)`**.
- **No silent eviction.** A second opener is refused with `code: 'bridge_in_use'`, naming the
  holder. Only an `admin.settings` holder **asking for it explicitly** (`takeover: true`) may take
  over; the evicted bridge is told who took it, and the handover is audit-logged.
- A **desktop-audience token is refused**, not treated as a user token. FR-14.26 gives the native
  bridge its own branch, checked against the `Desktop` row.

**Tests:** `fiscal-bridge-auth.flow.test.ts` (21) drives the exported handlers with a stand-in
socket — no token, garbage token, wrong-secret token, missing permission, cross-org, org mismatch,
two orgs sharing a device number, the 10-second deadline, second-opener refusal, idempotent
re-register, takeover refused without the flag and without admin, takeover accepted with both, and
the audit entry. `fiscal-bridge-eltrade.flow.test.ts` adds two cases **over a real socket**: an
unauthenticated registration is refused, and a second opener does not evict the till that is
printing.

---

## S-19 — OAuth sign-up put its credential in a URL, and honoured a planted one (High, **fixed 2026-10-01**)

> Not in the original review. S-05's fix (`911d7ec`) noted it and left it: "it is not a sign-in,
> but it is the same shape and deserves its own look". It is a sign-in, the victim's, into an
> account the attacker owns.

**Where:** `portal-api/src/controllers/oauth.controller.ts:131` (the callback in `mode=register`),
`POST /api/oauth/register-oauth` (same file, `:175`), `portal-ui/src/views/auth/RegisterView.vue:105`.

```ts
const pendingToken = await jwt.sign({ type: 'oauth_pending', email, name, provider, providerId, avatarUrl })
return Response.redirect(`${config.oauth.frontendUrl}/auth/register?oauth_token=${pendingToken}`, 302)
```

The register view decoded `?oauth_token=` for its prefill and posted it back to
`POST /api/oauth/register-oauth`, which checked the signature and created an org and an **admin**
account for whatever identity the token named. Both of S-05's halves, on the sign-up side:

- **Leakage.** The token is signed with the session secret and carries **no `exp`**, so it never
  expires. It sat in the address bar, the history, the access log, `Referer`, and any analytics
  that record the page address. FR-14.24 does not strip it: that gate knows `token` and `org`,
  not `oauth_token`.
- **Fixation, which is the direction that matters.** An attacker starts a sign-up with their own
  Google account, stops at `…/auth/register?oauth_token=<their token>`, and sends a victim that
  link. The victim sees a register form with the name and email filled in and read-only, types
  their company's name, and submits. The new org's admin account is linked to the **attacker's**
  provider identity, so the attacker signs in to it with their own Google account and holds admin
  over everything the victim puts into it. The prefilled address is the only tell, and the
  attacker chooses it.

**Proven** before the fix, against master `474e7e0`, through the real route table and the real
callback with Google faked at `fetch`: `oauth-register-url-token.flow.test.ts`, 3 of 3 failing.
The register-mode callback redirected with `oauth_token=<JWT>` in the URL. A pending token taken
from the URL was honoured (200, with the org and the admin user created on the attacker's
identity). `POST /api/oauth/register-oauth` was on the public-route table.

### Fix

S-05's handoff, applied to the sign-up:

- The callback stores the provider identity in a one-time record, `OAuthPendingRegistration`: the
  code as a **SHA-256 hash**, the claims (never a token), an explicit `expiresAt` (30 min),
  `usedAt`, and a TTL index as a floor rather than the check. The code goes in an **httpOnly**
  `oauth_pending` cookie, `SameSite=Lax`, with **path `/api/oauth/pending`**, so only the two
  sign-up endpoints ever receive it. The redirect is `/auth/register?oauth=1`, and the flag is a
  hint, not a credential.
  - ⚠ **Superseded by FR-20.72 (plan step P0a-8):** the cookie is now `__Host-oauth_pending`,
    which no subdomain of lgrai.app can plant or overwrite. The prefix requires `Path=/`, so the
    narrow path is gone. A `Sec-Fetch-Site: same-site` request never presents the code, which is
    what the narrow path used to give.
- `GET /api/oauth/pending` returns the prefill: provider, email and name. The provider id stays on
  the server. Reading does not use the code, so the form can be reloaded.
- `POST /api/oauth/pending/register` completes the sign-up. The body says **what** to create (org
  name, slug, username), and the record the cookie names says **who for**. The code is claimed by
  a conditional update, so exactly one of two simultaneous submissions proceeds. A sign-up that
  fails (a taken slug) releases it, so the corrected form can be resubmitted. The session cookie
  is set as the sign-in handoff sets it: `secure` in production, `sameSite: 'lax'`, and 24 h to
  match the token. The old endpoint set a 7-day cookie around a 24-hour token, with neither
  attribute.
- **`POST /api/oauth/register-oauth` is removed**, not deprecated. Every `oauth_pending` token
  ever minted is still validly signed and has no expiry, and removing the only endpoint that
  exchanged one is what makes them worthless. Every refusal answers 400 with one message.
- `RegisterView` removes a legacy `?oauth_token=` from the address bar with `router.replace`
  before it makes any request, and uses nothing from it.

⚠ **A legacy pending token is still a valid signature.** `AuthService.derive` accepts any payload
the secret verifies and checks no `type` claim, so a leaked `oauth_pending` token presented as a
bearer passes the S-01 guard as a "user" with no `id`, `orgId` or permissions. Measured over the
whole route table: every org-scoped route answers 403 (the tenant guard) or 422 (S-15), and the
only 200 is `GET /api/auth/me` echoing the token's own claims back. That is benign, and nothing
mints a typed token any more. But a future JWT type signed with this secret would inherit the same
confusion, so give it its own secret, as FR-14.20 did for the desktop.

**Tests:** `oauth-register-url-token.flow.test.ts` covers the vector (red on master, above).
`oauth-pending-registration.flow.test.ts` covers the fix:

- end to end through the real callback: the cookie's attributes, the prefill, the sign-up, the
  session cookie, the sign-up cookie cleared, and a second use refused;
- the stored identity wins over anything in the body, and with no cookie the sign-up is refused
  even when the body carries a valid token;
- the code is stored hashed and the claims are stored, not a token;
- a read does not consume the code;
- single use, including two concurrent submissions;
- a failed sign-up releases the code;
- one refusal message for expired, unknown and non-string codes.

`e2e/tests/oauth.spec.ts` checks that the prefill comes from the server, and that a planted
`?oauth_token=` is stripped and not used.

---

## S-20 — OAuth linked an existing account on an unverified provider email (Critical, **fixed 2026-10-01**)

> Not in the original review. Found while re-reviewing `getOrCreateUser` — the same function S-17
> hardened. S-17 stopped a stranger JOINING an org; this is the EXISTING-member path it left alone,
> and it is a full account takeover of any member, admins included.

**Where:** `services/src/biz/oauth.service.ts#getOrCreateUser`, and the five `userInfoFetcher`s in
the same file.

```ts
let user = await User.findOne({ email: info.email, orgId: org._id })
if (user) { /* link this provider identity onto them, and sign in */ }
```

The member was found by `info.email` alone, and the provider's email was trusted as proof of who
the caller is. But an email is proof of identity only if the PROVIDER verified it, and two of the
five send an address they never verified:

- **Microsoft** — Graph `/me` returns `mail || userPrincipalName`. `mail` is set by the admin of
  **any** Entra tenant and verified by nobody. Production's Microsoft OAuth app is **multi-tenant**:
  the start redirect uses `/common`, and Microsoft serves the login page for both `/organizations`
  and `/consumers`.
- **Facebook** — gives no verification signal at all.

So this is the published **"nOAuth"** pattern, end to end:

```
1. attacker creates their own Entra tenant
2. gives a user there  mail = <victim admin's address>
3. GET /api/oauth/microsoft?org_slug=<victim org>&mode=login
   → the member is found by email
   → the attacker's Microsoft identity is linked onto that member
   → a JWT for the victim comes back
```

The victim can be an org **admin**, so the attacker lands with accounting and payroll access. S-17's
invite requirement does **not** cover this: the victim already IS a member, which is exactly the
branch the attack takes. Google (`verified_email`) and LinkedIn (`email_verified`) do send a signal,
and GitHub is safe on its `/user/emails` path — but the old code ignored all three.

### Fix

An OAuth identity is proof of an email, and only of a VERIFIED one. `getOrCreateUser` now resolves
the caller in this order:

1. **Linked identity first.** `oauthProviders: { $elemMatch: { provider, providerId } }` within the
   org. A linked identity signs in whatever its email now says — that link was written on an earlier,
   already-authorised sign-in, so honouring it again grants nothing new.
2. **Email match links ONLY on a verified email.** `OAuthUserInfo` gains `emailVerified: boolean`,
   set by each fetcher from the provider's own signal — Google `verified_email === true`, LinkedIn
   `email_verified === true`, GitHub by confirming the chosen address against `/user/emails` (the
   public `data.email` path is now checked against that list too, not trusted blind), and **always
   `false` for Microsoft and Facebook**. An unverified email that matches a member is **refused**,
   and links nothing.
3. **Invites.** A `targetEmail` pin only means something with a verified email — an unverified
   address is forgeable, so a pinned invite plus an unverified email is refused. Unpinned invite
   codes are unchanged: they are bearer secrets.

**Deactivated users.** Password login refuses `!user.isActive` (`auth.service.ts:191`); the OAuth
path never checked it, so a disabled user could still sign in with Google or any already-linked
identity. `getOrCreateUser` now refuses `isActive === false` on **both** the linked-identity lookup
and the email match. `redeemLoginHandoff` (the S-05 handoff) re-checks `isActive` as well, closing
the window where an admin disables an account between the callback minting the handoff and the SPA
redeeming it.

**One refusal, so it is not a membership oracle.** The three refusals that turn on *who the caller
is* — not a member, a member whose email was not verified, a deactivated member — are the **same
string**, which keeps the existing phrase *"Ask an administrator for an invitation"*. The specific
reason goes to a server-side log line, without the email. (The invite-specific refusals — wrong org,
wrong pinned email, pinned-but-unverified — keep their own messages: the caller already holds the
invite code, so those leak nothing about membership.)

**User-visible change.** An existing password user who signs in for the FIRST time with **Microsoft**
or **Facebook** (or any provider that did not verify the address) is no longer linked automatically;
they get *"This sign-in can't be used for …. If you already have an account there, sign in with your
password, or with the provider you linked before. Ask an administrator for an invitation."* They sign
in with their password (or a verified provider) and the link is made then. Google/LinkedIn/GitHub
users with a verified address are unaffected.

**Not changed, deliberately:** `registerWithOAuth` still creates a **new** org's admin from an
unverified email. That path creates a brand-new identity rather than taking over an existing account,
and the address is scoped to the new org (the `{email, orgId}` index is per-org), so there is no
victim to impersonate. Tightening it (e.g. requiring a verified email, or email activation of the new
admin) is a separate hardening, not part of this takeover fix.

**Tests:** `oauth-hardening.flow.test.ts` — the S-20 block. Negatives: a Microsoft, a Google
(`emailVerified:false`) and a Facebook identity whose email equals an existing member are each refused
and link nothing; a pinned invite plus an unverified email is refused; a deactivated member is refused
both by a linked identity and by a verified email match; and not-a-member / unverified / deactivated
all return the identical string (no oracle), which does not contain the address tried. Positive
controls: an already-linked identity signs in on an unverified email; a verified Google email links; an
unpinned invite still works; and the S-05 handoff refuses to redeem for a member deactivated after the
callback. The existing `oauth.flow.test.ts` link/invite tests gained `emailVerified: true` and an
active member, since the fix (correctly) refuses an unverified email and an inactive account.

⚠ **Ops:** anyone who linked a Microsoft or Facebook identity to an existing account before this
landed did so on an unverified email. Worth auditing: `users` with a `microsoft` or `facebook` entry
in `oauthProviders`, cross-checked against who should control that address.

### Addendum — re-review, 2026-10-10

This section was written with the fix. A re-review against the code as it now stands found that two
of its statements are out of date, and found one gap the fix left latent.

1. **"Unpinned invite codes are unchanged: they are bearer secrets" left an account pre-hijack open.**
   - **The gap:** a holder of an unpinned invite could found an account on an address they never proved (any Entra tenant's `mail`).
   - **The consequence:** that address is the person's sign-in and password-reset address everywhere. Whoever really owns it would later reset into an account the attacker's provider identity still opened.
   - **Closed 2026-10-05** by PR #100 (`9951cc0`; tests `9699da2`): `resolveOAuthJoin` refuses an unverified email that would found a person. The invite is untouched, so it can still be completed with a password.
   - **Tests:** the positive control above now uses a verified email, and an unverified one is asserted refused with the invite unspent.
2. **"Not changed, deliberately: `registerWithOAuth` …" no longer holds.** Founding an org now requires a provider-verified email. Both `registerWithOAuth` and the callback's register mode refuse `unverified_email`.
3. **Latent: a provider answer with no account id.**
   - **The gap:** `providerId` is what every linked identity is found by: `getOrCreateUser`, `signInWithOAuth` and `resolveOAuthJoin` all `$elemMatch` on it. A userinfo error body has no `id`, and the fetchers passed that through as `undefined`; GitHub's turned it into the string `"undefined"`.
   - **Why nothing matched:** the driver's default sends `undefined` as `null`, which matches no stored link. Measured against this schema, with `ignoreUndefined: true` the key is dropped instead, and the lookup matched an admin with a linked Google identity.
   - **Fixed 2026-10-10** in PR #123 (`1cd1bb3`): `fetchUserInfo` refuses an answer that names no account. The tests fail with the guard removed.

**Production, counts only, 2026-10-10:**
- no Microsoft or Facebook links on any user or identity;
- no inactive OAuth-linked users;
- no OAuth-created users since 2026-10-01, so the pre-hijack window went unused;
- no unconfirmed identity links.

---

## S-21 — An org admin could read, rewrite and deactivate any org's users (Critical, **fixed 2026-10-02**)

> Not in the original review. Found on 2026-10-02 while planning the multi-org sign-in, which makes
> every per-org `User` row a credential worth guarding.

**Where:** `portal-api/src/controllers/user.controller.ts`: `GET`, `PUT` and `DELETE /:userId`, and
`services/src/dao/user.dao.ts#findByIdSafe`.

```ts
const found    = await userDao.findByIdSafe(userId)        // GET    — findById(id)
const existing = await User.findById(userId).exec()        // PUT    — then userDao.update(userId, …)
await userDao.update(userId, { isActive: false, … })       // DELETE — findByIdAndUpdate(id)
```

The `:userId` came from the URL and the org never took part in the lookup. The #41 tenant guard
checks `:orgId` against the token, and here `:orgId` is the caller's **own** org, so
`/org/<mine>/user/<yours>` went straight through to another organisation's user.
`tenant-isolation.flow.test.ts` could not see it: its probe walks routes whose only parameter is
`:orgId`, and its header explains that `/:id` routes need a seeded record in the other org to probe
honestly.

The handlers require `role === 'admin'`, and anyone can be an admin by registering an org. With S-06
still open (it was fixed later the same day), the activation token came back in the register
response, so this attack needed no email access:

```
1. POST /api/auth/register              → my org; activate with the token in the response
2. PUT  /api/org/<my org>/user/<victim> {password, role, email}
3. POST /api/auth/login {orgSlug: <victim org>, username: <victim>, password}
```

A user id is not a secret. Ids appear in API responses, audit-log `entityId`s and every JWT's `id`,
and ObjectIds are partly sequential. The same routes also handed over the victim's profile (`GET`)
and could lock them out (`DELETE`). `PUT` echoed the updated document back **with its argon2 hash**,
and `POST` echoed the new user's hash.

### Fix

- `userDao.findInOrg(id, orgId)` and `userDao.updateInOrg(id, orgId, data)` take the org from the
  URL. That is the caller's own org, because the tenant guard has already run. A foreign id is
  simply not found, and gets a 404.
- `findByIdSafe` is gone, so the unscoped form cannot be picked up again by accident.
- A malformed id is now a 404. It used to be a 500 from a Mongoose `CastError`.
- No `/user` response carries `password` any more, matching the list endpoint (FR-11.3).

**Tests:** `user-admin-idor.flow.test.ts` covers:
- a cross-org `GET`, `PUT` and `DELETE`, each a 404 that leaves the target unchanged (password, role,
  email, `isActive`);
- a malformed id;
- a control: the same admin still reads, edits and deactivates users of their own org, and the `PUT`
  response no longer carries the hash.

⚠ **The wider pattern is not closed by this.** About 90 lookups in 35 controllers take a record by
`_id` alone. Many probably re-check `orgId` after loading; that is unmeasured. Extending the
tenant-isolation probe to `/:id` routes with a seeded foreign record would measure it.

⚠ **Ops:** check whether this was ever used. Look for audit-log entries with `module: 'admin'`,
`entityType: 'user'` and `action: 'update'` or `'deactivate'` whose `entityId` is a user in a
**different** org from the entry's own `orgId`. Any such row is a cross-org write.

---

## S-22 — A stale cookie overrode the bearer token; any validly signed JWT was a session (Low, **fixed 2026-10-04**)

> Not in the original review. Found while planning the multi-org sign-in, which will keep a
> separate session in each browser tab.

**Where:** the token derivation in `portal-api/src/auth/auth.service.ts` and the seven
`*-api/src/auth/app-auth.service.ts` copies, and the session cookie in five controller blocks.

```ts
const token = cookie?.auth?.value || (Bearer header) || ''
const user  = (await jwt.verify(token)) ? (payload as UserTokenized) : null
```

1. **The cookie won.** Every SPA sends a bearer token from its own storage. No UI ever calls
   `POST /auth/logout`, so the httpOnly cookie of an earlier sign-in survives, and it silently
   replaced the token the caller had chosen: the request ran as whoever the cookie named. Today that
   is a wrong-account bug. With one session per tab (two tokens, one shared cookie) it would act in
   the wrong organisation.
2. **A verified signature was taken as a session.** Nothing checked the payload's shape. Until S-19
   the `oauth_pending` JWT, signed with the same secret and carrying neither `id` nor `orgId`, passed
   every guard as a signed-in user.
3. **The OAuth callback's cookie outlived its token**: `maxAge: 7 days` on a 24-hour token. That is
   how five hand-copied cookie blocks drift.

### Fix

- **`services/biz/session-token.ts`**, used by all eight plugins (the seven copies remain
  byte-identical):
  - `pickSessionToken`: a non-empty `Authorization` header is used exclusively, and the cookie only
    when no header is sent. An invalid bearer token is a 401, never rescued by the cookie. An empty
    `Bearer ` counts as no header, because some scripts send one on login.
  - `asSessionUser`: a verified payload is a session only with a string `id` and `orgId` and no
    `type`.
- **`portal-api/src/auth/session-cookie.ts#sessionCookie()`** replaces the five blocks, so the
  cookie lives exactly as long as the token.

Nothing in the SPAs relies on the cookie, because every API call carries the bearer header. The
cookie still serves the requests that send none: the download links that are top-level navigations,
and the desktop redeem.

**Tests:** `auth-precedence.flow.test.ts`:
- a bearer beats the cookie;
- the cookie alone still works;
- an invalid bearer is a 401 despite a valid cookie;
- an empty `Bearer ` falls back to the cookie;
- three non-session payloads are refused (the old `oauth_pending` shape, an `id` with no `orgId`, a
  typed token);
- the OAuth callback's cookie carries `Max-Age=86400`.

---

## S-23 — An OAuth sign-in ignored permission sets (Medium, **fixed 2026-10-04**)

> Not in the original review. Found while planning the multi-org sign-in, where every org switch
> must mint the same claims a password sign-in does.

**Where:** `services/src/biz/oauth.service.ts`: the end of `getOrCreateUser`, and
`registerWithOAuth`.

```ts
const tokenized: UserTokenized = {
  id, email, username, firstName, lastName, role, orgId,
  permissions: [...user.permissions],   // the ROLE's defaults
  ownRecordsModules: [],                // always empty
}
```

Password login builds a session through `tokenize()`, which honours the user's permission sets. The
OAuth path built a second answer by hand:

- **A user narrowed by a permission set got the role's full rights with Google.** Take an
  `accountant` placed in a read-only set: read-only with a password, full accountant rights through
  the provider.
- **Own-records limits were dropped.** `ownRecordsModules` was always empty, so a salesperson
  limited to their own sales saw everyone's.
- **The Administrator set's every-permission never applied**, so an admin signing in with Google
  lacked `admin.audit` and the rest.
- **No `operatorCode`**, the fiscal operator a POS receipt is printed under (Н-18).

The two OAuth paths that create users also skipped what `register()` does:
- An **invited** user got no operator code and no role history.
- An **OAuth sign-up's org** got `modules: []`, no permission sets and no app rows, and its founder
  no operator code or role history. The founder therefore held the admin role's defaults rather
  than the Administrator set's every-permission.

### Fix

- **`getOrCreateUser` returns `tokenize(user)`.** One answer to "what may this person do", whichever
  way they signed in.
- **An invited OAuth user gets an operator code** (`allocateOperatorCode`) **and a role-history
  entry**. Their permissions stay the invite's role, as S-17 decided.
- **`registerWithOAuth` builds the org `register()` builds.** The settings come from the new
  `defaultOrgSettings()`, and ownership, app rows, permission sets and the Administrator set come
  from the new `provisionNewOrg()`. Both are now shared with `register()` instead of copied. The
  founder also gets an operator code and role history, and the session comes from `tokenize()`.

**Tests:** `oauth-claims.flow.test.ts`:
- a restrictive set and its own-records limit are honoured through Google;
- the Administrator set expands to every permission;
- an invited OAuth user gets an operator code and role history, and the session carries the code;
- an OAuth sign-up gets modules, app rows, permission sets, the Administrator set and an operator
  code.

Red before the fix: 0/4.

⚠ **Not changed:** an invite accepted through `register()` (password) still puts the new user in the
org's default "Member (Read Only)" set whatever role the invite names, so an invited accountant is
read-only until an admin changes the set. That is the opposite drift, and belongs to the
membership work.

---

## S-24 — Production ran without `NODE_ENV=production` (High, **fixed 2026-10-05**, config)

> Not in the original review. Found on 2026-10-04 by the S-07 field test: production still answered
> a CORS preflight from `http://localhost:4021`, an origin the allow-list admits only outside
> production.

**Where:** the deployment, not the code. `lgr-config` (lgr-deploy `k8s/base/configmap-lgr-config.yaml`),
the Deployment and the Dockerfile never set `NODE_ENV`, so every `NODE_ENV === 'production'` check
in the app was false in production:

- **The S-02 boot guards never ran.** `requiredSecret()` refuses to start in production with a
  missing, default or short `JWT_SECRET` or `DESKTOP_TOKEN_SECRET`.
  - `JWT_SECRET` happened to be a real 64-character value, so user sessions were not forgeable.
  - **`DESKTOP_TOKEN_SECRET` was not set at all**, and silently fell back to the committed
    development default. Production signed desktop access tokens (FR-14.20) with a published key,
    which is exactly the case its own docstring warns about: *"a published key that mints tokens
    for any desktop of any org."*
  - **No desktop was enrolled yet** (0 rows in `desktops`), and a desktop token is honoured only
    after its desktop row is re-read, so nothing could be impersonated. The first enrolment would
    have made it exploitable: the native fiscal bridge and `/api/desktop/v1/*` accept these tokens.
- **The session cookies went out without `Secure`.** That covers `auth`, `oauth_state` and
  `oauth_handoff` on lgrai.app.
- **CORS answered the Vite dev ports** (S-07's allow-list keys its dev-only origins off `NODE_ENV`).

### Fix (configuration, lgr-deploy)

1. **`6ace09e`** sealed a fresh 48-byte random `DESKTOP_TOKEN_SECRET` into `lgr-secret`
   (`kubeseal --raw`, piped straight from `openssl` so the plaintext was never stored), and confirmed
   the cluster Secret held it (length only) before going on.
2. **`078ca28`** set `NODE_ENV: production` in `lgr-config`, and the pod was restarted.
   - Every `requiredSecret()` was checked first (lengths and not-the-default only).
   - The new pod came up 1/1 with no restarts, so the guards passed.

**Verified on lgrai.app:**
- the running config's desktop key is no longer the default;
- `Set-Cookie: auth=…; Max-Age=86400; Path=/; HttpOnly; Secure; SameSite=Lax`;
- the S-07/S-08/S-22 field test passes 9/9.

⚠ **Still worth doing:** `ENV NODE_ENV=production` in the Dockerfile, so that no deployment of the
image can run as development by omission. Check the `lgr-qa` namespace first: it is not managed
from lgr-deploy, and an image that turns the guards on would refuse to start there unless its
secrets are set too.

---

## S-25 — By-id routes in 21 controllers ignored the org (Critical, **fixed 2026-10-23**)

> Not in the original review. Found on 2026-10-20 while writing FR-20, which needs every by-id
> route scoped before any mirror exists (FR-20.7). Same class as S-21, in 21 more controllers.
> Reported and fixed privately ([GHSA-mfh7-36vq-fhhp](https://github.com/gjovanov/lgr/security/advisories/GHSA-mfh7-36vq-fhhp)).

**Where:** 21 controllers across `accounting-api`, `invoicing-api`, `payroll-api`, `portal-api` and
`warehouse-api`, through the DAL base repository (`dal-mongo/src/base.repository.ts`), whose
`findById`, `update` and `delete` take an id and nothing else:

```ts
const item = await r.bankAccounts.findById(params.id)            // GET    — any org's
const item = await r.bankAccounts.update(params.id, body as any)  // PUT    — findByIdAndUpdate(id, body)
await r.bankAccounts.delete(params.id)                            // DELETE — any org's
```

The #41 tenant guard checks only that the URL's `:orgId` is the caller's own. The `:id` after it can
name a document of any org, and `tenantPlugin` filters nothing. So `/org/<mine>/…/<yours>` reached
another organisation's bank accounts, tax returns, fixed assets, cash and payment orders, payslips,
timesheets, price lists and inventory counts, and the journal entries, movements and payments of any
invoice (`GET /invoicing/stats/invoice/:id`).

- **Read, change, delete:** through GET, PUT and DELETE by bare id.
- **Move:** most of the PUTs passed an unvalidated body to `findByIdAndUpdate`, so a body carrying
  `orgId` re-parented the document. The first version of the fix still allowed it with an update
  operator, `{"$set": {"orgId": …}}`: review caught it before the merge.
- **Who:** any signed-in user, and registration is self-service. Ids are ObjectIds, which are partly
  sequential within one API process.

### Fix

- `findByIdInOrg`, `updateInOrg` and `deleteInOrg` on the DAL filter by `{_id, orgId}` in one
  operation. `updateInOrg` drops `orgId` and `_id` from the data, refuses any top-level `$` key
  (422), and updates with an explicit `$set`. Every by-id route uses them with the URL's `:orgId`.
- A PUT without a full body schema refuses `orgId` outright (422).
- Two tests guard the property:
  - `tenant-isolation.flow.test.ts` walks the real route table, calls every by-id route with another
    org's document and with an update operator, and fails if anything leaks or moves;
  - a static check fails on any controller that passes a URL id to an unscoped repository method. It
    caught 7 such calls added by later work before the merge.

### Was it used?

A read-only check of production's audit log on 2026-10-23 found no sign of it. There are only 25
audit entries of the affected types, 7 of them updates or deletes, and none names a document of
another org or changes an `orgId`. Reads were never audited, so a cross-org read cannot be ruled
out this way.

---

## S-26 — PDF rendering served the working directory on every interface (Medium, **fixed 2026-10-23**)

> Found on 2026-10-20 while writing FR-20 (FR-20.25). Reported and fixed privately
> ([GHSA-76q2-87cq-2rvm](https://github.com/gjovanov/lgr/security/advisories/GHSA-76q2-87cq-2rvm)).

**Where:** `reporting/src/pdf/base.pdf.ts` rendered through `md-to-pdf` 5.2.5 with `{ content }`
input and no `basedir`. md-to-pdf then served `process.cwd()` with `serve-handler`, through
`http.createServer(…).listen(port)` with no host: on every interface, with directory listings, for
the whole of each render. Chrome itself was driven over a DevTools port.

Anything that could reach the pod's IP while a document printed could fetch any file under the
app's working directory: other pods on the cluster network, and the nodes. On a developer machine,
and later on an on-prem master or a desktop, the same listener faced the LAN. The production image
held no secrets there (checked 2026-10-23 alongside S-10).

### Fix

- The markdown becomes HTML in-process (`marked`). Chrome gets it with `page.setContent` and prints
  it with `page.pdf`, so nothing is served.
- Chrome keeps its sandbox unless the process is root.
- `PDF_RENDERER=md-to-pdf` restores the previous renderer for one release.
- A unit test watches the OS socket table during a render, and fails on any listener in the
  process or on a non-loopback address.

Chrome itself is driven over its DevTools WebSocket, which it binds to 127.0.0.1 during a render:
reachable from the same machine (in production, the same pod) only. The first version drove it over
a pipe, which opens no port, but Bun 1.3.10 loses CDP messages on that pipe (10 of 60 renders
stalled in the production image, against 0 of 100 over the WebSocket), so the WebSocket became the
default the same day (`PDF_CHROME_PIPE=1` restores the pipe). On production after that change, the
pod listened on the API's 4001 and on one loopback port per render, nothing else. FR-20's masters
need the loopback port closed before P1 ships.


---

## S-27 — Import uploads wrote outside the upload directory (Critical, **fixed 2026-10-23**)

> Found on 2026-10-23 while making stored file paths relative (FR-20 P0b-8). Same class as S-03,
> in the two writers S-03 did not reach. Reported and fixed privately ([GHSA-f2fv-8rm4-9c9x](https://github.com/gjovanov/lgr/security/advisories/GHSA-f2fv-8rm4-9c9x)).

**Where:** `POST /api/org/:orgId/bills/import/extract` and `POST /api/org/:orgId/doc-import/extract`
built the stored name with `` `${Date.now()}-${f.name}`.replace(/[^\w.\-\/\\]/g, '_') ``. The filter
kept `/` and `\`, so a multipart part named `x/../../../../<anywhere>` was written wherever `join`
resolved it.

- **Who:** any signed-in user. Neither endpoint checks a permission, so this included `member` and
  `nra_auditor`. Registration is self-service.
- **What:** any file the process can write. The container runs as root with a writable root
  filesystem, and Bun runs the TypeScript sources, so this reached code execution. It also reached
  every other org's uploaded documents.

### Fix

- Both endpoints write through `stampedUploadPath()`, which keeps only the last component of the
  name, for POSIX and Windows separators alike, and checks the result with `containedJoin()`.
- `file.service#uploadFile` (no callers) gets the same treatment.
- `upload-filename.flow.test.ts` posts hostile names over HTTP with a hand-written multipart body.
  It fails on the previous code.

### Was it used?

Read-only checks on production on 2026-10-23 found no sign of it:
- every `File` row's path lies in its own org's directory, and no stored name carries a path;
- nothing on the upload volume is outside its layout;
- nothing in the container was written since that day's restart except caches.

A user could have deleted their own `File` row, and the container filesystem from before that
restart is gone, so this cannot rule out use whose trace was removed. After the deploy, a probe
with a traversing name stayed inside the org's directory on both endpoints.

⚠ The container still runs as root (S-10's open half). That is what let a file write reach the
whole container, application code included, rather than only what the app user owns.


---

## S-28 — Role permissions not enforced on writes (High, **fixed 2026-10-23**)

> Found on 2026-10-23 while fixing S-27, whose upload routes checked no permission. Reported and
> fixed privately ([GHSA-gg6h-4gv9-w2hx](https://github.com/gjovanov/lgr/security/advisories/GHSA-gg6h-4gv9-w2hx)).

**Where:** every write in the accounting, invoicing, payroll and warehouse APIs, about 140 routes.
They checked the session, the org in the URL (#41) and the home, and nothing else.
`AppAuthService` defined an `access({ permission })` macro, and no controller there used it.

- **Who:** any member of the org, including `member` and `nra_auditor`, read-only by design. The
  NRA auditor account exists for a tax inspector.
- **Exposure on the day:** none. Every active user in the customer orgs was an `admin`.

### Fix

- `services/biz/route-permission.ts` resolves every write under an org to a rule: `need`, `self`
  or `member`. It is enforced in a transform hook in all eight auth plugins, before validation, so
  a refusal is a 403, never a schema. A write with no rule is refused.
- `spaErrorHandler` passes a thrown status through. It used to turn the refusal into a 500.
- `POST /audit-logs` takes notes only. Any member could write any action into the trail.
- `route-permission.flow.test.ts` walks the route table, and fails without the guard.
