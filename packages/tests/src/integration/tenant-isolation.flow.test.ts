import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser, createTestContact } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import type { Types } from 'mongoose'

/**
 * gjovanov/lgr#31 — can one organisation read another's data over HTTP?
 *
 * Until this file, nothing at any level asked. `multi-tenancy.test.ts` looked like it did,
 * but it queries `Model.find({ orgId: A })` and asserts the rows carry orgId A — true of any
 * database ever written, and silent about the surface that actually decides who gets them.
 *
 * ⚠ The thing everyone believed enforced tenancy did nothing. `db/src/plugins/tenant.plugin.ts`
 * used to register `pre('find')`, `pre('findOne')` and `pre('countDocuments')` hooks whose
 * bodies were a guard clause and no more, and CLAUDE.md told 67 controller authors that the
 * plugin "auto-filters all queries". So `const filter = { orgId }` — with `orgId` read out of
 * the URL — was the whole of the tenancy check in most of this codebase.
 *
 * gjovanov/lgr#41 closed it: `services/biz/tenant-guard.ts#isForeignOrg`, registered as a
 * `beforeHandle` hook by `AuthService` and the seven `AppAuthService` copies, rejects any
 * request whose `:orgId` is not the token's. The dead `pre` hooks are deleted. `KNOWN_LEAKS`
 * below is empty, and the assertions that made it shrink are what keep it that way.
 *
 * ── What this file is ────────────────────────────────────────────────────────────────────
 *
 * Not a list of routes. A PROPERTY over the real route table: it mounts `createApiApp()` —
 * the same table `unified.ts` serves — walks every registered route, and probes it with a
 * token belonging to a DIFFERENT organisation. A controller added next year is covered the
 * day it is mounted, with no edit here.
 *
 * Three lists carry the routes that do not (yet) hold the property. All three are asserted
 * in BOTH directions, which is what stops them rotting:
 *
 *   KNOWN_LEAKS   reachable across orgs. Each is asserted to STILL leak — so when a route is
 *                 fixed, this test goes red and the fixer must delete the line. A list that
 *                 only grows is a list nobody trusts. It is EMPTY as of #41; adding a line is
 *                 recording a regression, not a to-do.
 *   EXEMPT        legitimately reachable, with the reason. Adding to this is a design claim,
 *                 so each entry must say why in its own words.
 *   INCONCLUSIVE  the probe cannot reach the guard (the route needs a query param, or 404s
 *                 for everyone). Recorded rather than counted as safe, because an unmeasured
 *                 route is not a passing one. Also empty as of #41 — see `WAS_INCONCLUSIVE`,
 *                 which asserts the four it held are now denied outright.
 *
 * A route that leaks and is on none of the lists fails the suite. That is the regression bar.
 *
 * ── What this file is NOT ────────────────────────────────────────────────────────────────
 *
 * It probes GET routes whose only path parameter is `:orgId` — 83 of the 353 org-scoped
 * routes. The rest need fixtures to probe honestly:
 *
 *   • `/:id` routes — a foreign id that does not exist 404s whether or not a guard exists,
 *     so an unguarded route would PASS. Probing them requires seeding a real record in org B
 *     and asking for it by its real id. Worth doing; it is not done here.
 *   • POST/PUT/DELETE — body validation (422) usually runs before the handler, so the probe
 *     never reaches the code under test, and a write probe that DOES land mutates the org it
 *     is meant to be locked out of. #41 added the weaker but honest version of this probe
 *     anyway — see the `cross-tenant writes` describe at the bottom: 74 write routes, none
 *     of which answers 2xx to a foreign org.
 *
 * The remaining unprobed routes (the `/:id` ones) are not evidence of safety — but they run
 * through the same hook, because #41's guard keys on `:orgId` and is not per route or per
 * method. What is unproven for them is only that nothing shadows it on those paths.
 */

// ── The inventory: measured 2026-09-15 against master, re-measured 2026-09-21 after #41 ───
/**
 * Reachable with another organisation's token — i.e. a cross-tenant leak.
 *
 * **Empty since gjovanov/lgr#41.** It held 73 routes, and they are worth reading once before
 * this looks like a tidy-up: `/api/org/:orgId/` handed over another company's org document,
 * `audit-logs/` their security trail, `payroll/payslip/` what each of their employees is paid.
 * `invoices/` and `digest/preview` are the two #31 demonstrated by hand; the other 71 were
 * found by this file on its first run. One guard in the auth layer closed all of them at once
 * (`services/biz/tenant-guard.ts`), which is why the list emptied in one step rather than 73.
 *
 * A line added here from now on is a recorded REGRESSION, not a to-do: it means a route
 * escaped the default guard, and the entry must say how.
 */
const KNOWN_LEAKS: string[] = []

/**
 * Routes that may legitimately answer for an org other than the caller's.
 *
 * Empty, and that is a finding rather than an oversight: of the 83 probed, not one needs to.
 * The candidates the issue names — invites and OAuth registration — do not appear here because
 * `GET /invite` merely LISTS an org's invites and has no business crossing orgs, while the
 * accept/register flows are not `/org/:orgId/…` routes at all. The follow-up issue's central
 * guard therefore has no exception to carve out among these routes.
 */
const EXEMPT: Record<string, string> = {}

/**
 * Probed, but the probe never reached the guard. Not evidence of safety.
 *
 * **Empty since gjovanov/lgr#41**, and for a reason worth recording rather than just deleting
 * four lines. It held the four routes that answered 400/404 for BOTH orgs — `logo/` (the
 * fixture org has no logo), `audit-logs/search-entities`, `pricing/resolve`, `pricing/options`
 * (each needs a query param) — so the two cases were indistinguishable and the probe could not
 * say whether a guard existed.
 *
 * They are now distinguishable: a `beforeHandle` hook runs BEFORE the handler and before the
 * route's own missing-param check, so all four answer **403** for a foreign org while still
 * answering 400/404 for their own. That is exactly the "unmeasured, not passing" state
 * resolving itself — and it is the second reason the guard belongs in the auth layer rather
 * than in 67 handlers, where it would have run after each route's own validation.
 */
const INCONCLUSIVE: Record<string, string> = {}

/**
 * The four that WERE inconclusive. Asserted explicitly, because "it is no longer on a list" is
 * not a measurement: for these, and only these, a 403 is the whole of the evidence.
 */
const WAS_INCONCLUSIVE: string[] = [
  '/api/org/:orgId/logo/',
  '/api/org/:orgId/audit-logs/search-entities',
  '/api/org/:orgId/pricing/resolve',
  '/api/org/:orgId/pricing/options',
]

// ── Harness ───────────────────────────────────────────────────────────────────────────────

let app: Elysia
let A: Tenant
let B: Tenant
let salesOfA: string

interface Tenant {
  /** The org's `_id`, as the string a URL carries. */
  orgId: string
  /** Mongoose id, for creating further users in this org. */
  _id: Types.ObjectId
  token: string
}

/**
 * A token the real `AuthService` will accept, signed with the secret it verifies with.
 *
 * ⚠ `permissions` is filled from the role's real defaults on purpose. A token with no
 * permissions gets 403 from the `access()` macro on many routes — which looks exactly like a
 * tenancy denial and would have reported most of this codebase as safe.
 */
const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
async function tokenFor(u: { id: string; orgId: string; role: string; email: string }) {
  const ctx: any = (signer as any).decorator
  return ctx.jwt.sign({
    ...u,
    username: 'isolation-probe',
    firstName: 'Iso',
    lastName: 'Probe',
    permissions: DEFAULT_ROLE_PERMISSIONS[u.role as keyof typeof DEFAULT_ROLE_PERMISSIONS] || [],
    ownRecordsModules: [],
  })
}

async function makeTenant(slug: string, role = 'admin'): Promise<Tenant> {
  const org = await createTestOrg({ slug } as any)
  const _id = org._id as Types.ObjectId
  const orgId = String(_id)
  const email = `${role}@${slug}.test`
  const user = await createTestUser(_id, { role, email } as any)
  return { orgId, _id, token: await tokenFor({ id: String(user._id), orgId, role, email }) }
}

/** A second, non-admin member of an existing org. */
async function memberOf(t: Tenant, role: string, email: string): Promise<string> {
  const user = await createTestUser(t._id, { role, email } as any)
  return tokenFor({ id: String(user._id), orgId: t.orgId, role, email })
}

async function get(path: string, token: string): Promise<number> {
  const res = await app.handle(
    new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } }),
  )
  return res.status
}

/** Every route this file can probe without fixtures — see the header for what that excludes. */
function probeRoutes(): string[] {
  const routes = (createApiApp() as any).routes as Array<{ method: string; path: string }>
  return routes
    .filter(r => r.method === 'GET')
    .filter(r => r.path.includes(':orgId') && (r.path.match(/:/g) || []).length === 1)
    .map(r => r.path)
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(createApiApp())
  A = await makeTenant('isolation-a')
  B = await makeTenant('isolation-b')
  // A non-admin member of A. The sharper probe the issue asks for: several routes ask only
  // "is this a valid login", so `sales` reaches another org's data exactly as `admin` does.
  salesOfA = await memberOf(A, 'sales', 'sales@isolation-a.test')
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

// ── The property ──────────────────────────────────────────────────────────────────────────

describe('cross-tenant reachability (gjovanov/lgr#31)', () => {
  it('no org-scoped GET route leaks to another org unless it is a listed, known leak', async () => {
    const unlisted: string[] = []

    for (const path of probeRoutes()) {
      if (KNOWN_LEAKS.includes(path) || path in EXEMPT || path in INCONCLUSIVE) continue
      const status = await get(path.replace(':orgId', B.orgId), A.token)
      if (status >= 200 && status < 300) unlisted.push(`${path} → ${status}`)
    }

    // A new controller mounted without a cross-org check lands here, on the day it is mounted.
    expect(unlisted).toEqual([])
  }, 120_000)

  it('every known leak is still a leak — when one is fixed, delete its line', async () => {
    const fixed: string[] = []

    for (const path of KNOWN_LEAKS) {
      const status = await get(path.replace(':orgId', B.orgId), A.token)
      if (status < 200 || status >= 300) fixed.push(`${path} → ${status}`)
    }

    // Deliberately red on good news: the guard PR's acceptance test is this list shrinking.
    expect(fixed).toEqual([])
  }, 120_000)

  it('every listed route is still mounted — a deleted route must leave the list', () => {
    const mounted = new Set(probeRoutes())
    const stale = [
      ...KNOWN_LEAKS,
      ...Object.keys(EXEMPT),
      ...Object.keys(INCONCLUSIVE),
      ...WAS_INCONCLUSIVE,
    ].filter(p => !mounted.has(p))

    expect(stale).toEqual([])
  })

  it('the guarded routes still answer their own org — a blanket deny is not a fix', async () => {
    const guarded = probeRoutes().filter(
      p => !KNOWN_LEAKS.includes(p) && !(p in EXEMPT) && !(p in INCONCLUSIVE),
    )
    // Positive control. Without it, a bug that 403s everyone passes the property above.
    expect(guarded.length).toBeGreaterThan(0)

    const brokenForOwner: string[] = []
    for (const path of guarded) {
      const status = await get(path.replace(':orgId', A.orgId), A.token)
      if (status === 401 || status === 403) brokenForOwner.push(`${path} → ${status}`)
    }

    // `backup/restores` is not here: it 403s its own admin too, by design — restore is
    // gated on `BACKUP_SYS_ADMINS`, which is unset in tests. See backup.controller.ts:77.
    expect(brokenForOwner.filter(p => !p.startsWith('/api/org/:orgId/backup/restores'))).toEqual([])
  }, 120_000)

  it('the four formerly-inconclusive routes are now measurably denied', async () => {
    const answers = await Promise.all(
      WAS_INCONCLUSIVE.map(async p => `${p} → ${await get(p.replace(':orgId', B.orgId), A.token)}`),
    )

    // They answered 400/404 for everyone before #41, which is why they were unmeasurable.
    // The hook runs ahead of both the handler and its param check, so the answer is now 403.
    expect(answers).toEqual(WAS_INCONCLUSIVE.map(p => `${p} → 403`))
  }, 60_000)
})

// ── The 74 write routes #31 could not probe ───────────────────────────────────────────────
//
// #31 left POST/PUT/DELETE unmeasured for two good reasons: body validation usually answers
// 422 before the handler runs, so the probe never reaches the code under test; and a write
// probe that DOES land mutates the org it is meant to be locked out of.
//
// #41 makes the first reason survivable and the second moot. The guard is one `beforeHandle`
// hook shared by every method, so a write route cannot be guarded differently from the GET
// beside it — and an empty `{}` body is rejected by validation (422) or by the guard (403),
// never handled. Measured: 30 answer 403, 44 answer 422, none is handled.
//
// This does NOT prove the 44 reach the guard — validation wins on those. It proves the far
// more useful thing: no write route answers 2xx to a foreign org, whatever the ordering.

describe('cross-tenant writes (gjovanov/lgr#41)', () => {
  it('no org-scoped write route accepts another org\'s request', async () => {
    const routes = (createApiApp() as any).routes as Array<{ method: string; path: string }>
    const writes = routes.filter(
      r => r.method !== 'GET' && r.path.includes(':orgId') && (r.path.match(/:/g) || []).length === 1,
    )
    expect(writes.length).toBeGreaterThan(0)

    const handled: string[] = []
    for (const r of writes) {
      const res = await app.handle(
        new Request(`http://localhost${r.path.replace(':orgId', B.orgId)}`, {
          method: r.method,
          headers: { authorization: `Bearer ${A.token}`, 'content-type': 'application/json' },
          // An empty object, deliberately: enough to get past parsing, never enough to be a
          // valid payload, so a route that DOES reach its handler cannot write anything.
          body: r.method === 'DELETE' ? undefined : '{}',
        }),
      )
      if (res.status >= 200 && res.status < 300) handled.push(`${r.method} ${r.path} → ${res.status}`)
    }

    expect(handled).toEqual([])
  }, 180_000)
})

// ── The three the issue demonstrated by hand ──────────────────────────────────────────────
//
// Named individually so `git log -S` finds them from the issue, and so the failure message
// says which route reopened rather than "expected [] to equal [...]".
//
// These four asserted 200 when the file was written — that WAS the demonstration. #41 flipped
// them to 403, and the diff that did so is the issue's acceptance test.

describe('the routes gjovanov/lgr#31 demonstrated', () => {
  it('invoices: an admin of A is refused B\'s invoices', async () => {
    expect(await get(`/api/org/${B.orgId}/invoices/`, A.token)).toBe(403)
  })

  it('invoices: a SALES user of A is refused too — the guard is not a role check', async () => {
    // The sharper probe from the issue: no admin role, no admin permissions. Before #41 that
    // made no difference because the route asked only for a valid login; now it makes none
    // because the guard runs before any role or permission is consulted.
    expect(await get(`/api/org/${B.orgId}/invoices/`, salesOfA)).toBe(403)
  })

  it('digest/preview: an admin of A cannot render B\'s daily digest', async () => {
    expect(await get(`/api/org/${B.orgId}/digest/preview`, A.token)).toBe(403)
  })

  it('digest/last-run: refused, where before it needed only a valid login', async () => {
    expect(await get(`/api/org/${B.orgId}/digest/last-run`, salesOfA)).toBe(403)
  })

  it('each of them still answers for the caller\'s OWN org', async () => {
    // The positive control these four need: a guard that 403s everyone would pass above.
    expect(await get(`/api/org/${A.orgId}/invoices/`, A.token)).toBe(200)
    expect(await get(`/api/org/${A.orgId}/invoices/`, salesOfA)).toBe(200)
    expect(await get(`/api/org/${A.orgId}/digest/last-run`, A.token)).toBe(200)
  })

  it('backup: the controller that had its own guard (gjovanov/lgr#30) is unchanged', async () => {
    // It now denies twice over — its own `guard()` and the central hook. Kept deliberately:
    // it is the one route whose denial predates #41, so it stays the control that proves the
    // probe can see a 403 that the new hook did not produce.
    expect(await get(`/api/org/${B.orgId}/backup/runs`, A.token)).toBe(403)
    expect(await get(`/api/org/${A.orgId}/backup/runs`, A.token)).toBe(200)
  })
})

// ── The plugin everyone trusted ───────────────────────────────────────────────────────────

describe('tenantPlugin does not filter by org', () => {
  it('an unfiltered find returns both orgs\' rows', async () => {
    const { Contact } = await import('db/models')
    await createTestContact(A._id, { companyName: 'A Co' })
    await createTestContact(B._id, { companyName: 'B Co' })

    // `multi-tenancy.test.ts` never asks this, because it always passes an orgId filter and so
    // can only ever confirm that Mongo honours a `where`. A query WITHOUT one sees every
    // tenant — which was the guarantee CLAUDE.md advertised, and the reason `const filter =
    // { orgId }` from the URL looked sufficient to 67 authors.
    //
    // ⚠ Still asserted AFTER #41, deliberately. The fix was a guard at the auth layer and the
    // plugin's three no-op `pre` hooks were DELETED, not implemented (see the plugin's header
    // for why). So this stays true, and this test is what would catch someone "fixing" the
    // plugin later — at which point seeding, the digest org sweep, migrations and
    // `backup-runner` all silently change behaviour.
    const all = await Contact.find({})

    expect(all.map(c => c.companyName).sort()).toEqual(['A Co', 'B Co'])
  })
})
