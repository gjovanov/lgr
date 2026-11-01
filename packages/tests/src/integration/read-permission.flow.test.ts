import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { APP_REGISTRY, DEFAULT_ROLE_PERMISSIONS, type Role } from 'config/constants'
import { mongoose } from 'db/connection'
import { AuditLog, Org } from 'db/models'
import { EXACT_READ_RULES, PREFIX_READ_RULES, orgRouteRest, readRuleFor } from 'services/biz/route-permission'

/**
 * A role's permissions hold over HTTP for READS too (S-29).
 *
 * Until the read rules, any member of an org read its payroll, its ledgers and its audit trail
 * through the API: the UI was the only thing between a cashier and every payslip. The property is
 * over the real route table, as `route-permission.flow` is for writes:
 *
 *   - every GET under an org has a rule, and every rule names a route that exists;
 *   - a GET whose rule names permissions answers 403 to a member holding none of them;
 *   - each default role still reaches every read of every app it may open (`APP_REGISTRY`'s
 *     `requiredPermission`), so the rules cannot quietly break a screen;
 *   - the audit trail is `admin.audit`'s, and a record's history is its module's;
 *   - an org is never serialised with an integration token.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const ROLES = Object.keys(DEFAULT_ROLE_PERMISSIONS).filter(r => r !== 'admin') as Role[]
const NO_SUCH_ID = '0123456789abcdef01234567'
const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))

let app: Elysia
let orgId: string
const tokens: Record<string, string> = {}

function getRoutes(): string[] {
  const routes = (createApiApp() as any).routes as Array<{ method: string; path: string }>
  return [...new Set(routes.filter(r => r.method === 'GET' && orgRouteRest(r.path) !== null).map(r => r.path))]
}

function concrete(path: string): string {
  return path.replace(':orgId', orgId).replace(/:[A-Za-z]+/g, NO_SUCH_ID)
}

async function get(path: string, token: string) {
  const res = await app.handle(new Request(`http://localhost${path}`, { headers: { authorization: `Bearer ${token}` } }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  const org = await createTestOrg()
  orgId = String(org._id)
  for (const role of [...ROLES, 'admin' as Role]) {
    const email = `${role}@reads.test`
    const user = await createTestUser(org._id, { role, email } as any)
    tokens[role] = await (signer as any).decorator.jwt.sign({
      id: String(user._id), orgId, role, email, username: role, firstName: 'R', lastName: 'P',
      permissions: DEFAULT_ROLE_PERMISSIONS[role], ownRecordsModules: [],
    })
  }
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

describe('the read rules cover the route table', () => {
  it('every GET under an org resolves to a rule', () => {
    const missing = getRoutes().filter(p => !readRuleFor(p)).map(p => orgRouteRest(p))
    expect(missing).toEqual([])
  })

  it('no rule names a route that does not exist', () => {
    const rests = getRoutes().map(p => orgRouteRest(p)!)
    const dead = PREFIX_READ_RULES.map(([prefix]) => prefix)
      .filter(prefix => !rests.some(r => prefix === '' ? r === '' : r === prefix || r.startsWith(`${prefix}/`)))
    expect(dead).toEqual([])
    expect([...EXACT_READ_RULES.keys()].filter(rest => !rests.includes(rest))).toEqual([])
  })

  it("a contact's amounts are the invoicing app's, though the contact itself is every trade app's", async () => {
    const summary = `/api/org/${orgId}/invoicing/contact/${NO_SUCH_ID}/summary`
    expect((await get(summary, tokens.warehouse_manager)).status).toBe(403)
    expect((await get(`/api/org/${orgId}/invoicing/contact`, tokens.warehouse_manager)).status).toBe(200)
    expect((await get(summary, tokens.sales)).status).not.toBe(403)
  })

  it('a nested prefix is listed before the one it nests in, so it is ever reached', () => {
    const prefixes = PREFIX_READ_RULES.map(([p]) => p)
    const shadowed = prefixes.filter((p, i) => p && prefixes.slice(0, i).some(q => q && p.startsWith(`${q}/`)))
    expect(shadowed).toEqual([])
  })
})

describe('a GET answers 403 to a member without its permissions', () => {
  it('for every route whose rule names permissions, and every default role that holds none', async () => {
    const leaks: string[] = []
    for (const path of getRoutes()) {
      const rule = readRuleFor(path)
      if (!rule || !('need' in rule)) continue
      for (const role of ROLES) {
        if (rule.need.some(p => DEFAULT_ROLE_PERMISSIONS[role].includes(p))) continue
        const { status, json } = await get(concrete(path), tokens[role])
        if (status !== 403 || json?.code !== 'permission_required') leaks.push(`${role} GET ${orgRouteRest(path)} → ${status}`)
      }
    }
    expect(leaks).toEqual([])
  }, 120_000)

  it('the cases that made it a finding', async () => {
    for (const role of ['accountant', 'warehouse_manager', 'sales', 'nra_auditor'] as const) {
      expect((await get(`/api/org/${orgId}/payroll/payslip`, tokens[role])).status).toBe(403)
      expect((await get(`/api/org/${orgId}/payroll/employee`, tokens[role])).status).toBe(403)
    }
    for (const role of ['hr_manager', 'warehouse_manager', 'sales'] as const) {
      expect((await get(`/api/org/${orgId}/accounting/journal`, tokens[role])).status).toBe(403)
      expect((await get(`/api/org/${orgId}/accounting/report/balance-sheet`, tokens[role])).status).toBe(403)
    }
    // The ones that hold the permission still read.
    expect((await get(`/api/org/${orgId}/payroll/payslip`, tokens.hr_manager)).status).toBe(200)
    expect((await get(`/api/org/${orgId}/payroll/payslip`, tokens.member)).status).toBe(200)
    expect((await get(`/api/org/${orgId}/accounting/journal`, tokens.accountant)).status).toBe(200)
    expect((await get(`/api/org/${orgId}/payroll/payslip`, tokens.admin)).status).toBe(200)
  })
})

/**
 * What each app reads, found by scanning every `*-ui` package for the routes it calls. A role
 * opens an app when it holds the app's `requiredPermission`; the shell is everyone's. `pos` is the
 * till's pages inside the invoicing app, whose tile `pos.read` opens too.
 */
const APP_READS: Record<string, string[]> = {
  shell: ['', 'apps', 'notification', 'user'],
  invoicing: [
    'invoices', 'invoicing/contact', 'invoicing/orders', 'invoicing/internal-orders', 'invoicing/reservations',
    'invoicing/cash-order', 'invoicing/payment-order', 'accounting/account', 'accounting/bank-account',
    'warehouse/product', 'warehouse/product-category', 'warehouse/warehouse', 'warehouse/movement',
    'trade/pos/catalog', 'trade/pos/catalog/lookup', 'tags',
  ],
  inventory: [
    'warehouse/product', 'warehouse/product-category', 'warehouse/warehouse', 'warehouse/movement',
    'warehouse/stock-level', 'warehouse/price-list', 'warehouse/cost-layer', 'warehouse/inventory-count',
    'invoicing/contact', 'invoicing/orders', 'tags',
  ],
  pos: ['trade/pos/catalog', 'trade/pos/catalog/lookup', 'trade/pos/session', 'cash-register/documents', 'warehouse/product-category', 'warehouse/warehouse', 'fiscal/device', 'tags'],
  accounting: ['accounting/account', 'accounting/journal', 'accounting/exchange-rate', 'accounting/fiscal-year', 'accounting/report/trial-balance'],
  payroll: ['payroll/employee', 'payroll/payslip', 'payroll/run', 'payroll/timesheet'],
  reports: ['reports/catalog'],
}

describe('each default role still reaches what its apps read', () => {
  it('no read of an app a role may open is refused', async () => {
    const broken: string[] = []
    for (const role of ROLES) {
      const held = DEFAULT_ROLE_PERMISSIONS[role]
      const apps = [
        'shell',
        ...Object.entries(APP_REGISTRY).filter(([, a]) => held.includes(a.requiredPermission)).map(([id]) => id),
        ...(held.includes('pos.read') ? ['pos'] : []),
      ]
      for (const appId of apps) {
        for (const rest of APP_READS[appId] ?? []) {
          const { status } = await get(`/api/org/${orgId}${rest ? `/${rest}` : ''}`, tokens[role])
          if (status === 403 || status === 401) broken.push(`${role} (${appId}) GET ${rest || '(org)'} → ${status}`)
        }
      }
    }
    expect(broken).toEqual([])
  }, 120_000)
})

describe('the audit trail', () => {
  let invoiceId: string
  let employeeId: string

  beforeAll(async () => {
    invoiceId = '6a0000000000000000000a01'
    employeeId = '6a0000000000000000000e01'
    const at = new Date()
    await AuditLog.create([
      // As `createAuditEntry` stores them: an id as an ObjectId.
      { orgId, userId: NO_SUCH_ID, action: 'update', module: 'invoicing', entityType: 'invoice', entityId: new mongoose.Types.ObjectId(invoiceId), entityName: 'INV-1', timestamp: at },
      { orgId, userId: NO_SUCH_ID, action: 'update', module: 'invoicing', entityType: 'invoice', entityId: new mongoose.Types.ObjectId('6a0000000000000000000a02'), entityName: 'INV-2', timestamp: at },
      { orgId, userId: NO_SUCH_ID, action: 'update', module: 'payroll', entityType: 'employee', entityId: new mongoose.Types.ObjectId(employeeId), entityName: 'Salary', timestamp: at },
      // ...and a sequence prefix as its string.
      { orgId, userId: NO_SUCH_ID, action: 'update', module: 'invoicing', entityType: 'sequence', entityId: 'CASH_SALE', entityName: 'CS', timestamp: at },
    ] as any)
  })

  it('whole, is admin.audit\'s', async () => {
    for (const role of ['manager', 'accountant', 'sales', 'member'] as const) {
      expect((await get(`/api/org/${orgId}/audit-logs`, tokens[role])).status).toBe(403)
      expect((await get(`/api/org/${orgId}/audit-logs/filters`, tokens[role])).status).toBe(403)
      expect((await get(`/api/org/${orgId}/audit-logs/search-users`, tokens[role])).status).toBe(403)
    }
    const auditor = await get(`/api/org/${orgId}/audit-logs`, tokens.nra_auditor)
    expect(auditor.status).toBe(200)
    expect(auditor.json.auditLogs ?? auditor.json.items).toHaveLength(4)
  })

  it('a record\'s history is the record\'s, and only in a module the caller reads', async () => {
    const own = await get(`/api/org/${orgId}/audit-logs?entityType=invoice&entityId=${invoiceId}`, tokens.sales)
    expect(own.status).toBe(200)
    // ⚠ `entityId` used to be dropped: the panel showed every invoice's history.
    expect((own.json.auditLogs ?? own.json.items).map((e: any) => e.entityName)).toEqual(['INV-1'])

    const salary = await get(`/api/org/${orgId}/audit-logs?entityType=employee&entityId=${employeeId}`, tokens.sales)
    expect(salary.status).toBe(200)
    expect(salary.json.auditLogs ?? salary.json.items).toEqual([])

    const hr = await get(`/api/org/${orgId}/audit-logs?entityType=employee&entityId=${employeeId}`, tokens.hr_manager)
    expect((hr.json.auditLogs ?? hr.json.items).map((e: any) => e.entityName)).toEqual(['Salary'])

    // A sequence prefix is stored as its string; casting it to an id threw.
    const prefix = await get(`/api/org/${orgId}/audit-logs?entityType=sequence&entityId=CASH_SALE`, tokens.sales)
    expect((prefix.json.auditLogs ?? prefix.json.items).map((e: any) => e.entityName)).toEqual(['CS'])
  })
})

describe('the org is never serialised with an integration token', () => {
  it('neither by GET /org/:orgId nor by /auth/me, to anyone', async () => {
    await Org.updateOne({ _id: orgId }, {
      $set: { 'settings.integrations.googleDrive': { accessToken: 'secret-access-value', refreshToken: 'secret-refresh-value', email: 'drive@reads.test' } },
    }).exec()
    for (const role of ['member', 'admin'] as const) {
      const org = await get(`/api/org/${orgId}`, tokens[role])
      expect(org.status).toBe(200)
      expect(JSON.stringify(org.json)).not.toContain('secret-')
      expect(org.json.org.settings.integrations.googleDrive.email).toBe('drive@reads.test')

      const me = await get('/api/auth/me', tokens[role])
      expect(me.status).toBe(200)
      expect(JSON.stringify(me.json)).not.toContain('secret-')
    }
  })
})
