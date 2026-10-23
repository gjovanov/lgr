import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { FOREIGN_ORG_MESSAGE } from 'services/biz/tenant-guard'
import {
  EXACT_WRITE_RULES, PREFIX_WRITE_RULES, orgRouteRest, writeRuleFor,
} from 'services/biz/route-permission'

/**
 * A role's permissions hold over HTTP (S-28).
 *
 * Until this guard the UI was the only thing between a read-only role and a write: the accounting,
 * invoicing, payroll and warehouse controllers checked the session, the org and the home, and
 * nothing else. A PROPERTY over the real route table, in the shape of tenant-isolation:
 *
 *   - every write under an org has a rule (`services/biz/route-permission.ts`), and no rule names
 *     a route that does not exist, so the table can neither miss a new controller nor rot;
 *   - every write whose rule names permissions answers 403 to a member of the org who holds none
 *     of them, before its body is validated. Probed with `{}`, so a route that checked only its
 *     schema would answer 422 and fail here.
 *
 * The probes cannot write anything: the guard refuses before the handler, and the controls that
 * do get through use ids that do not exist.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

let app: Elysia
let orgId: string
let otherOrgId: string
const tokens: Record<string, string> = {}

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const NO_SUCH_ID = '0123456789abcdef01234567'
const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

function writeRoutes(): Array<{ method: string; path: string }> {
  const routes = (createApiApp() as any).routes as Array<{ method: string; path: string }>
  return routes.filter(r => !READ_METHODS.has(r.method) && orgRouteRest(r.path) !== null)
}

async function tokenFor(org: any, role: keyof typeof DEFAULT_ROLE_PERMISSIONS): Promise<string> {
  const email = `${role}@${org.slug}.test`
  const user = await createTestUser(org._id, { role, email } as any)
  return (signer as any).decorator.jwt.sign({
    id: String(user._id), orgId: String(org._id), role, email, username: role, firstName: 'R', lastName: 'P',
    permissions: DEFAULT_ROLE_PERMISSIONS[role], ownRecordsModules: [],
  })
}

/** `/api/org/:orgId/x/:id` with real values; ids that exist nowhere. */
function concrete(path: string, org: string): string {
  return path.replace(':orgId', org).replace(/:[A-Za-z]+/g, NO_SUCH_ID)
}

async function call(method: string, path: string, token: string, body: unknown = {}) {
  const res = await app.handle(new Request(`http://localhost${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: method === 'DELETE' ? undefined : JSON.stringify(body),
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().use(createApiApp())
  const org = await createTestOrg({ slug: 'route-permission' } as any)
  const other = await createTestOrg({ slug: 'route-permission-other' } as any)
  orgId = String(org._id)
  otherOrgId = String(other._id)
  tokens.member = await tokenFor(org, 'member')
  tokens.nra_auditor = await tokenFor(org, 'nra_auditor')
  tokens.sales = await tokenFor(org, 'sales')
  tokens.admin = await tokenFor(org, 'admin')
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
})

describe('the rule table covers the route table', () => {
  it('every write under an org has a rule', () => {
    const missing = writeRoutes().filter(r => !writeRuleFor(r.method, r.path)).map(r => `${r.method} ${r.path}`)
    expect(missing).toEqual([])
  })

  it('every exact rule names a route that exists', () => {
    const real = new Set(writeRoutes().map(r => `${r.method} ${orgRouteRest(r.path)}`))
    expect([...EXACT_WRITE_RULES.keys()].filter(k => !real.has(k))).toEqual([])
  })

  it('every prefix rule covers at least one route', () => {
    const rests = writeRoutes().map(r => orgRouteRest(r.path) as string)
    const unused = PREFIX_WRITE_RULES
      .filter(([prefix]) => !rests.some(rest => rest === prefix || rest.startsWith(`${prefix}/`)))
      .map(([prefix]) => prefix)
    expect(unused).toEqual([])
  })
})

describe('a read-only role is refused every write its permissions do not cover', () => {
  for (const role of ['member', 'nra_auditor'] as const) {
    it(`${role}: 403 before the body is read, on every route that names a permission`, async () => {
      const held = DEFAULT_ROLE_PERMISSIONS[role] as readonly string[]
      const wrong: string[] = []
      let probed = 0
      for (const r of writeRoutes()) {
        const rule = writeRuleFor(r.method, r.path)
        if (!rule || !('need' in rule) || rule.need.some(p => held.includes(p))) continue
        probed++
        const res = await call(r.method, concrete(r.path, orgId), tokens[role])
        if (res.status !== 403 || res.json?.code !== 'permission_required') wrong.push(`${r.method} ${r.path} → ${res.status}`)
      }
      expect(wrong).toEqual([])
      // The table is not empty by accident: accounting, invoicing, payroll and warehouse alone are ~140.
      expect(probed).toBeGreaterThan(120)
    }, 120_000)
  }
})

describe('controls', () => {
  it('an admin passes the guard: a write to an id that does not exist is a 404, not a 403', async () => {
    const res = await call('DELETE', `/api/org/${orgId}/accounting/account/${NO_SUCH_ID}`, tokens.admin)
    expect(res.status).toBe(404)
  })

  it('a role is held to its own permissions, not denied outright', async () => {
    // `sales` holds invoicing.write but not accounting.write or inventory.write.
    expect((await call('DELETE', `/api/org/${orgId}/invoicing/contact/${NO_SUCH_ID}`, tokens.sales)).status).toBe(404)
    expect((await call('DELETE', `/api/org/${orgId}/accounting/account/${NO_SUCH_ID}`, tokens.sales)).status).toBe(403)
    expect((await call('DELETE', `/api/org/${orgId}/warehouse/product/${NO_SUCH_ID}`, tokens.sales)).status).toBe(403)
  })

  it('another org\'s URL still gets the tenant guard\'s answer', async () => {
    const res = await call('DELETE', `/api/org/${otherOrgId}/accounting/account/${NO_SUCH_ID}`, tokens.member)
    expect(res.status).toBe(403)
    expect(res.json?.message).toBe(FOREIGN_ORG_MESSAGE)
  })

  /**
   * ⚠ Production mounts the API behind `spaErrorHandler` (unified.ts), whose last branch turns any
   * error it is handed into a 500. The refusal is THROWN from a transform hook, so this is the
   * composition that decides whether a member sees 403 or 500.
   */
  it('in the production composition the refusal is still a 403', async () => {
    const served = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp())
    const res = await served.handle(new Request(`http://localhost/api/org/${orgId}/accounting/account/${NO_SUCH_ID}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${tokens.member}` },
    }))
    expect(res.status).toBe(403)
    expect((await res.json() as any).code).toBe('permission_required')
  })

  it('a read is never refused by it', async () => {
    expect((await call('GET', `/api/org/${orgId}/accounting/account/`, tokens.member)).status).toBe(200)
  })

  it('a member may post a note, and only a note, to the audit trail', async () => {
    const note = { module: 'invoicing', entityType: 'invoice', entityId: NO_SUCH_ID, changes: [{ field: 'note', oldValue: null, newValue: 'called the customer' }] }
    expect((await call('POST', `/api/org/${orgId}/audit-logs`, tokens.member, { ...note, action: 'note' })).status).toBe(200)
    expect((await call('POST', `/api/org/${orgId}/audit-logs`, tokens.member, { ...note, action: 'delete' })).status).toBe(422)
  })
})
