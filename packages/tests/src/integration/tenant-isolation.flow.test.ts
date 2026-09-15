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
 * ⚠ The thing everyone believed enforced tenancy does nothing. `db/src/plugins/tenant.plugin.ts`
 * registers `pre('find')`, `pre('findOne')` and `pre('countDocuments')` hooks whose bodies are
 * a guard clause and no more, and CLAUDE.md has told 67 controller authors that the plugin
 * "auto-filters all queries". So `const filter = { orgId }` — with `orgId` read out of the
 * URL — is the whole of the tenancy check in most of this codebase.
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
 *   KNOWN_LEAKS   reachable across orgs today. Each is asserted to STILL leak — so when the
 *                 central guard lands, this test goes red and the fixer must delete the line.
 *                 A list that only grows is a list nobody trusts.
 *   EXEMPT        legitimately reachable, with the reason. Adding to this is a design claim,
 *                 so each entry must say why in its own words.
 *   INCONCLUSIVE  the probe cannot reach the guard (the route needs a query param, or 404s
 *                 for everyone). Recorded rather than counted as safe, because an unmeasured
 *                 route is not a passing one.
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
 *     is meant to be locked out of.
 *
 * The 270 unprobed routes are not evidence of safety. Given 73 of 83 leak, assume they do too.
 */

// ── The inventory, measured 2026-09-15 against master ─────────────────────────────────────

/**
 * Reachable with another organisation's token. Every one returns 200 and that org's data.
 *
 * ⚠ Read a few of these out loud before deciding this is a tidy-up. `/api/org/:orgId/` hands
 * over another company's org document. `audit-logs/` is their security trail. `payroll/payslip/`
 * is what each of their employees is paid. `invoices/` and `digest/preview` are the two the
 * issue demonstrated by hand; the other 71 were found by this file on its first run.
 */
const KNOWN_LEAKS: string[] = [
  '/api/org/:orgId/invite',
  '/api/org/:orgId/',
  '/api/org/:orgId/digest/preview',
  '/api/org/:orgId/digest/last-run',
  '/api/org/:orgId/user/',
  '/api/org/:orgId/file/',
  '/api/org/:orgId/notification/',
  '/api/org/:orgId/apps/',
  '/api/org/:orgId/tags/',
  '/api/org/:orgId/audit-logs/filters',
  '/api/org/:orgId/audit-logs/search-users',
  '/api/org/:orgId/audit-logs/',
  '/api/org/:orgId/permission-sets/',
  '/api/org/:orgId/dashboard/summary',
  '/api/org/:orgId/accounting/account/',
  '/api/org/:orgId/accounting/journal/',
  '/api/org/:orgId/accounting/fiscal-year/',
  '/api/org/:orgId/accounting/fiscal-period/',
  '/api/org/:orgId/accounting/fixed-asset/',
  '/api/org/:orgId/accounting/bank-account/',
  '/api/org/:orgId/accounting/reconciliation/',
  '/api/org/:orgId/accounting/tax-return/',
  '/api/org/:orgId/accounting/exchange-rate/',
  '/api/org/:orgId/accounting/report/trial-balance',
  '/api/org/:orgId/accounting/report/profit-loss',
  '/api/org/:orgId/accounting/report/balance-sheet',
  '/api/org/:orgId/accounting/journals/',
  '/api/org/:orgId/accounting/payment-terms/',
  '/api/org/:orgId/accounting/fiscal-positions/',
  '/api/org/:orgId/accounting/reports/journal-analysis',
  '/api/org/:orgId/invoicing/contact/',
  '/api/org/:orgId/invoices/',
  '/api/org/:orgId/invoices/peek-next',
  '/api/org/:orgId/invoices/summary',
  '/api/org/:orgId/invoicing/orders/',
  '/api/org/:orgId/invoicing/orders/peek-next',
  '/api/org/:orgId/invoicing/internal-orders/',
  '/api/org/:orgId/invoicing/internal-orders/peek-next',
  '/api/org/:orgId/invoicing/reservations/',
  '/api/org/:orgId/invoicing/payment-order/',
  '/api/org/:orgId/invoicing/cash-order/',
  '/api/org/:orgId/invoicing/reports/aging',
  '/api/org/:orgId/invoicing/sequences/',
  '/api/org/:orgId/warehouse/product/',
  '/api/org/:orgId/warehouse/warehouse/',
  '/api/org/:orgId/warehouse/movement/',
  '/api/org/:orgId/warehouse/stock-level/',
  '/api/org/:orgId/warehouse/stock-level/by-products',
  '/api/org/:orgId/warehouse/inventory-count/',
  '/api/org/:orgId/warehouse/price-list/',
  '/api/org/:orgId/warehouse/cost-layer/',
  '/api/org/:orgId/warehouse/cost-layer/valuation',
  '/api/org/:orgId/warehouse/product-category/',
  '/api/org/:orgId/warehouse/locations/',
  '/api/org/:orgId/warehouse/operation-types/',
  '/api/org/:orgId/warehouse/lots/',
  '/api/org/:orgId/payroll/employee/',
  '/api/org/:orgId/payroll/run/',
  '/api/org/:orgId/payroll/payslip/',
  '/api/org/:orgId/payroll/timesheet/',
  '/api/org/:orgId/trade/pos/catalog',
  '/api/org/:orgId/trade/pos/session',
  '/api/org/:orgId/trade/pos/transactions',
  '/api/org/:orgId/pos/payment-methods/',
  '/api/org/:orgId/reports/catalog',
  '/api/org/:orgId/files/',
  '/api/org/:orgId/files/dates',
  '/api/org/:orgId/files/audit',
  '/api/org/:orgId/files/archives',
  '/api/org/:orgId/files/archives/candidates',
  '/api/org/:orgId/fiscal/device/',
  '/api/org/:orgId/fiscal/workstation/',
  '/api/org/:orgId/supto/export/tables',
]

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

/** Probed, but the probe never reached the guard. Not evidence of safety. */
const INCONCLUSIVE: Record<string, string> = {
  '/api/org/:orgId/logo/': '404 for both orgs — the fixture org has no logo, so the two cases are indistinguishable',
  '/api/org/:orgId/audit-logs/search-entities': '400 before the handler — requires a `q` query param',
  '/api/org/:orgId/pricing/resolve': '400 before the handler — requires productId/qty',
  '/api/org/:orgId/pricing/options': '400 before the handler — requires productId',
}

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
    const stale = [...KNOWN_LEAKS, ...Object.keys(EXEMPT), ...Object.keys(INCONCLUSIVE)].filter(
      p => !mounted.has(p),
    )

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
})

// ── The three the issue demonstrated by hand ──────────────────────────────────────────────
//
// Named individually so `git log -S` finds them from the issue, and so the failure message
// says what leaked rather than "expected [] to equal [...]".

describe('the routes gjovanov/lgr#31 demonstrated', () => {
  it('invoices: an admin of A lists B\'s invoices', async () => {
    expect(await get(`/api/org/${B.orgId}/invoices/`, A.token)).toBe(200)
  })

  it('invoices: a SALES user of A lists B\'s invoices — the route asks only for a valid login', async () => {
    // The sharper probe from the issue: no admin role, no admin permissions, same result.
    expect(await get(`/api/org/${B.orgId}/invoices/`, salesOfA)).toBe(200)
  })

  it('digest/preview: an admin of A renders B\'s daily digest — sales, documents, stock', async () => {
    expect(await get(`/api/org/${B.orgId}/digest/preview`, A.token)).toBe(200)
  })

  it('digest/last-run: reachable with any valid login, no role check at all', async () => {
    expect(await get(`/api/org/${B.orgId}/digest/last-run`, salesOfA)).toBe(200)
  })

  it('backup: the one controller with a guard (gjovanov/lgr#30) denies the same call', async () => {
    // The control that proves the probe works — an identical request to a guarded route.
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
    // can only ever confirm that Mongo honours a `where`. With the plugin's `pre` hooks empty,
    // a query WITHOUT one sees every tenant — which is the guarantee CLAUDE.md advertises and
    // the reason `const filter = { orgId }` from the URL looked sufficient to 67 authors.
    const all = await Contact.find({})

    expect(all.map(c => c.companyName).sort()).toEqual(['A Co', 'B Co'])
  })
})
