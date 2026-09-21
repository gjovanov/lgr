/**
 * Cross-tenant isolation, over the deployed stack — gjovanov/lgr#31.
 *
 * The exhaustive version of this lives at
 * `packages/tests/src/integration/tenant-isolation.flow.test.ts`: it mounts the real route
 * table and probes all 83 org-scoped GET routes with no browser and no running server. Read
 * that one for the full inventory; it is the suite that will catch the route added next year.
 *
 * This file exists for what an in-process test cannot prove: that the same denial survives a
 * REAL login against the running server — a JWT the portal actually issued, carried over the
 * wire, through the unified server's routing. A guard implemented as an Elysia hook can pass
 * in-process and still be bypassed by, say, a proxy that rewrites the path.
 *
 * ── Reading a green run ───────────────────────────────────────────────────────────────────
 *
 * Every route is asserted against the behaviour we WANT: a foreign org must be refused.
 *
 * ⚠ Until gjovanov/lgr#41 the rows that leaked carried `leaks: true`, which marked the test
 * `test.fail()` so that Playwright reported a PASS as a failure — the mechanism that made the
 * list shrink instead of rot. **Every one of them is gone**, along with the flag itself: a
 * single `beforeHandle` guard (`services/biz/tenant-guard.ts`) closed all of them at once, and
 * keeping an unused opt-out around would invite the next leak to be recorded rather than fixed.
 * A route that starts leaking now simply goes red.
 *
 * Adding a route is one line, which is the point. If it ever costs more, the list stops being
 * maintained and this file becomes decoration.
 */
import { test, expect } from '@playwright/test'

const API = process.env.BASE_URL || 'http://localhost:4001'

/**
 * One line per route.
 *
 * A representative slice, not an inventory — the exhaustive walk is the integration suite's.
 * The three the issue demonstrated by hand, one route per module family, and `backup/runs` as
 * the control that proves the probe can see a denial.
 */
const ROUTES: Array<{ path: string; as?: 'admin' | 'sales' }> = [
  // The three #31 demonstrated by hand.
  { path: '/api/org/:orgId/invoices/' },
  { path: '/api/org/:orgId/invoices/', as: 'sales' },
  { path: '/api/org/:orgId/digest/preview' },
  { path: '/api/org/:orgId/digest/last-run', as: 'sales' },

  // The org document itself.
  { path: '/api/org/:orgId/' },
  { path: '/api/org/:orgId/user/' },

  // One per module family.
  { path: '/api/org/:orgId/audit-logs/' },
  { path: '/api/org/:orgId/accounting/account/' },
  { path: '/api/org/:orgId/invoicing/contact/' },
  { path: '/api/org/:orgId/warehouse/product/' },
  { path: '/api/org/:orgId/warehouse/stock-level/' },
  { path: '/api/org/:orgId/payroll/employee/' },
  { path: '/api/org/:orgId/payroll/payslip/' },
  { path: '/api/org/:orgId/trade/pos/transactions' },
  { path: '/api/org/:orgId/reports/catalog' },
  { path: '/api/org/:orgId/files/' },
  { path: '/api/org/:orgId/supto/export/tables' },

  // The control. gjovanov/lgr#30 gave this one its own guard, so its denial predates #41 and
  // does not come from the central hook. If this row ever goes red, the probe itself has
  // broken and every green row above means nothing.
  { path: '/api/org/:orgId/backup/runs' },
]

interface Session {
  token: string
  orgId: string
}

async function login(orgSlug: string, username: string): Promise<Session> {
  const res = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgSlug, username, password: 'test123' }),
  })
  expect(res.ok, `login failed for ${username}@${orgSlug} — is the DB seeded?`).toBe(true)
  const data = await res.json()
  return { token: data.token, orgId: data.org._id || data.org.id }
}

function url(path: string, orgId: string) {
  return `${API}${path.replace(':orgId', orgId)}`
}

async function status(path: string, orgId: string, token: string): Promise<number> {
  const res = await fetch(url(path, orgId), { headers: { Authorization: `Bearer ${token}` } })
  return res.status
}

let adminA: Session
let salesA: Session
let adminB: Session

test.beforeAll(async () => {
  // `bun run seed` gives two orgs, which is why this needs no fixtures of its own.
  adminA = await login('acme-corp', 'admin')
  salesA = await login('acme-corp', 'sales')
  adminB = await login('beta-inc', 'admin')
  expect(adminA.orgId).not.toBe(adminB.orgId)
})

test.describe('a user of acme-corp cannot reach beta-inc', () => {
  for (const route of ROUTES) {
    const who = route.as || 'admin'

    test(`GET ${route.path} as ${who}`, async () => {
      const caller = who === 'sales' ? salesA : adminA
      const code = await status(route.path, adminB.orgId, caller.token)

      // Status, never body shape. A 200 with an empty array is still a leak: it proves the
      // route accepted a foreign org id, and the next caller may pick an org that has rows.
      expect(
        [401, 403, 404],
        `${route.path} answered ${code} to a caller from another organisation`,
      ).toContain(code)
    })

    // The positive control. Without one, a blanket-deny bug — an auth regression, a typo in a
    // macro, a proxy stripping the header — turns this whole suite green while the app is down.
    test(`GET ${route.path} as ${who} still works against its own org`, async () => {
      const caller = who === 'sales' ? salesA : adminA
      const code = await status(route.path, caller.orgId, caller.token)

      expect(code, `${route.path} refused its OWN org — the denial above proves nothing`).toBeLessThan(400)
    })
  }
})

test.describe('the token, not the path, decides', () => {
  test('beta-inc\'s own admin is not refused the same routes', async () => {
    // Guards against a lazier reading of a green suite: "acme is denied" could also mean the
    // routes are broken for everyone. Beta's admin reaching beta's data rules that out.
    const code = await status('/api/org/:orgId/invoices/', adminB.orgId, adminB.token)
    expect(code).toBeLessThan(400)
  })

  test('an anonymous caller gets nothing', async () => {
    const res = await fetch(url('/api/org/:orgId/invoices/', adminB.orgId))
    expect([401, 403]).toContain(res.status)
  })
})
