# Security review — 2026-09-21

Full-repo review of `lgr` @ `master`. Covers the auth layer, tenant guard, document store,
config/secret handling, OAuth, container build and dependencies.

**S-01**–**S-04** and **S-17** are fixed. The rest are open, ordered by severity below.

⚠ **S-17 was not in the original review.** It was found while fixing S-04, in the same
function, and is the most serious finding in this document — an unauthenticated stranger
could join any organisation whose slug they could name. It is written up at the end.

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| S-01 | Critical | `isSignIn` macro dead on Elysia 1.4 — 172/366 routes answered anonymously | **Fixed** |
| S-02 | Critical | `JWT_SECRET` silently falls back to a committed default | **Fixed** |
| S-03 | High | Path traversal → arbitrary file write via upload filename | **Fixed** |
| S-04 | High | OAuth `state` generated but never verified (login CSRF) | **Fixed** |
| S-05 | High | JWT delivered in a URL query string | Open |
| S-06 | High | `/auth/register` returns the activation token in its response | Open |
| S-07 | Medium | CORS reflects any origin with `credentials: true` | Open |
| S-08 | Medium | No rate limiting or lockout on `/auth/login`; account enumeration | Open |
| S-09 | Medium | Password minimum is 6 characters | Open |
| S-10 | Medium | `.dockerignore` does not exclude the secrets `.gitignore` protects | Open |
| S-11 | Medium | Swagger served unauthenticated in production | Open |
| S-12 | Medium | Raw `err.message` returned on 500 | Open |
| S-13 | Low | Live credentials in a OneDrive-synced working copy | Open |
| S-14 | Low | `User.password` has no `select: false` | Open |
| S-15 | Low | Body validation runs before the auth guard (schema disclosure) | Open |
| S-16 | Info | Dependency audit: 2 transitive advisories, neither reachable | Open |
| **S-17** | **Critical** | **OAuth self-enrolment — anyone could join any org they could name** | **Fixed** |

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

## S-05 — JWT delivered in a URL query string (High, open)

**Where:** `portal-api/src/controllers/oauth.controller.ts:91`

```ts
Response.redirect(`${config.oauth.frontendUrl}/auth/oauth-callback?token=${token}`, 302)
```

A 24-hour session token in a URL lands in browser history, in the `Referer` header of every
outbound link from that page, and in every ingress/proxy access log. Set the `auth` cookie
server-side on the redirect — `/auth/login` already does exactly this (`auth.controller.ts:53`)
— and redirect to a bare path.

---

## S-06 — `/auth/register` returns the activation token (High, open)

**Where:** `portal-api/src/controllers/auth.controller.ts:22`, `services/biz/auth.service.ts:170`

```ts
return { message: 'Registration successful. Please check your email…', userId, activationToken }
```

Email verification exists to prove control of an address. Returning the token in the HTTP
response means the caller never needs to see the email, so the check proves nothing — anyone
can register `billing@some-customer.com` and immediately activate it. Drop `activationToken`
from the response body (keep it on the service return for tests if useful).

---

## S-07 — CORS reflects any origin with credentials (Medium, open)

**Where:** `portal-api/src/unified.ts:42` — `cors({ origin: true, credentials: true })`

Echoes back whatever `Origin` the caller sends, with credentials allowed. Today
`sameSite: 'lax'` on the auth cookie is what actually prevents exploitation; the day someone
needs a cross-site embed and flips that to `'none'`, every site on the internet can make
authenticated calls as a logged-in user. Pin to the known frontend origins
(`config.oauth.frontendUrl` and the dev ports).

---

## S-08 — No rate limiting or lockout on login; account enumeration (Medium, open)

**Where:** `auth.controller.ts:44`, `services/biz/auth.service.ts:186-193`

Nothing caps password attempts anywhere in the app. `login()` also distinguishes
`'Organization not found'` / `'Invalid credentials'` / `'Account is disabled'`, enumerating
valid orgs and accounts. Add a failed-attempt counter on `User` with backoff; collapse the
first three errors into one message.

---

## S-09 — Password minimum is 6 characters (Medium, open)

**Where:** `auth.controller.ts:36` — `password: t.String({ minLength: 6 })`

No composition rule and no breach check, on a system holding payroll and fiscal records.
Raise to 12. Hashing itself is fine (`Bun.password.hash`, bcrypt).

---

## S-10 — `.dockerignore` does not exclude the secrets `.gitignore` protects (Medium, open)

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

**S-05** and **S-06** next — both small and both in the auth surface already touched. Then
**S-07** and **S-10** as one config pass, then **S-08**/**S-09**.
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

