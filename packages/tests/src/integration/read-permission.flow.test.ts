import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../api/src/api.js'
import { spaErrorHandler } from '../../../api/src/spa-fallback.js'
import { config } from 'config'
import { ROLES as ALL_ROLES, type Role } from 'config/constants'
import { EXACT_READS, READ_PREFIXES, accessRuleFor, appsOpenedBy, can, templateGrant } from 'config/access'
import { mongoose } from 'db/connection'
import { AuditLog, Org } from 'db/models'
import { orgRouteRest } from 'services/biz/route-permission'

/**
 * A role's capabilities hold over HTTP for READS too (S-29; FR-27 P3-6: the capability rules of
 * `config/access/routes.ts`, the legacy permission rules being gone).
 *
 * Until the read rules, any member of an org read its payroll, its ledgers and its audit trail
 * through the API: the UI was the only thing between a cashier and every payslip. The property is
 * over the real route table, as `route-permission.flow` is for writes:
 *
 *   - every GET under an org has a rule, and every rule names a route that exists;
 *   - a GET whose rule names capabilities answers 403 to a member whose role holds none of them;
 *   - each built-in role still reaches every read of every app it opens (`appsOpenedBy`), so the
 *     rules cannot quietly break a screen;
 *   - the audit trail is `admin.audit`'s, and a record's history is its module's;
 *   - an org is never serialised with an integration token.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const ROLES = ALL_ROLES.filter(r => r !== 'admin') as Role[]

/**
 * The parts FR-26 carved out of the Seller's and the Sales Consultant's modules (its `AREA_PREFIXES` until FR-27
 * P3-6), and which of the two still reads each: their built-in roles leave the rest out, so a route there refuses them.
 */
const CARVED: ReadonlyArray<readonly [string, readonly Role[]]> = [
  ['dashboard', []],
  ['invoicing/orders', ['sales_consultant']],
  ['invoicing/internal-orders', ['sales_consultant']],
  ['invoicing/reservations', ['sales_consultant']],
  ['bills/import', []],
  ['invoicing/bills', []],
  ['invoicing/payment-order', []],
  ['invoicing/cash-order', []],
  ['warehouse/price-list', []],
  ['warehouse/bulk-pricing', []],
  ['warehouse/inventory-count', []],
  ['warehouse/opening-stock', []],
  ['warehouse/cost-layer/valuation', []],
]
const carvedOf = (path: string) => {
  const rest = orgRouteRest(path)
  return rest === null ? undefined : CARVED.find(([prefix]) => rest === prefix || rest.startsWith(`${prefix}/`))
}
/** Whether FR-26 holds this role out of the carved part: the Seller out of all, the Sales Consultant out of all but orders. */
const heldOut = (role: Role, carved: readonly [string, readonly Role[]]) =>
  (role === 'seller' || role === 'sales_consultant') && !carved[1].includes(role)
const ruleOf = (path: string) => accessRuleFor('GET', orgRouteRest(path) as string)
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
    // The person's built-in role decides (FR-27 P3-2); the token carries none of it.
    tokens[role] = await (signer as any).decorator.jwt.sign({
      id: String(user._id), orgId, email, username: role, firstName: 'R', lastName: 'P',
    })
  }
}, 60_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

describe('the read rules cover the route table', () => {
  it('every GET under an org resolves to a rule', () => {
    const missing = getRoutes().filter(p => !ruleOf(p)).map(p => orgRouteRest(p))
    expect(missing).toEqual([])
  })

  it('no rule names a route that does not exist', () => {
    const rests = getRoutes().map(p => orgRouteRest(p)!)
    const dead = READ_PREFIXES.map(([prefix]) => prefix)
      .filter(prefix => !rests.some(r => prefix === '' ? r === '' : r === prefix || r.startsWith(`${prefix}/`)))
    expect(dead).toEqual([])
    expect([...EXACT_READS.keys()].filter(rest => !rests.includes(rest))).toEqual([])
  })

  it("a contact's amounts are the invoicing app's, though the contact itself is every trade app's", async () => {
    const summary = `/api/org/${orgId}/invoicing/contact/${NO_SUCH_ID}/summary`
    expect((await get(summary, tokens.warehouse_manager)).status).toBe(403)
    expect((await get(`/api/org/${orgId}/invoicing/contact`, tokens.warehouse_manager)).status).toBe(200)
    expect((await get(summary, tokens.sales)).status).not.toBe(403)
  })

  it('the longest prefix decides, whatever order the table lists them in', () => {
    const nested = READ_PREFIXES.map(([p]) => p).filter(p => p && READ_PREFIXES.some(([q]) => q && q !== p && p.startsWith(`${q}/`)))
    expect(nested.length).toBeGreaterThan(0)
    for (const p of nested) expect({ p, rule: accessRuleFor('GET', p) }).toEqual({ p, rule: READ_PREFIXES.find(([q]) => q === p)![1] })
  })
})

describe('a GET answers 403 to a member whose role holds none of its capabilities', () => {
  it('for every route whose rule names capabilities, and every built-in role that holds none', async () => {
    const leaks: string[] = []
    for (const path of getRoutes()) {
      const rule = ruleOf(path)
      if (!rule || !('anyOf' in rule)) continue
      for (const role of ROLES) {
        if (can(templateGrant(role), rule.anyOf)) continue
        const { status, json } = await get(concrete(path), tokens[role])
        if (status !== 403 || json?.code !== 'permission_required') leaks.push(`${role} GET ${orgRouteRest(path)} → ${status}`)
      }
    }
    expect(leaks).toEqual([])
  }, 120_000)

  it('the cases that made it a finding', async () => {
    for (const role of ['accountant', 'warehouse_manager', 'sales', 'nra_auditor', 'member'] as const) {
      expect((await get(`/api/org/${orgId}/payroll/payslip`, tokens[role])).status).toBe(403)
      expect((await get(`/api/org/${orgId}/payroll/employee`, tokens[role])).status).toBe(403)
    }
    for (const role of ['hr_manager', 'warehouse_manager', 'sales'] as const) {
      expect((await get(`/api/org/${orgId}/accounting/journal`, tokens[role])).status).toBe(403)
      expect((await get(`/api/org/${orgId}/accounting/report/balance-sheet`, tokens[role])).status).toBe(403)
    }
    // The ones whose role holds it still read.
    expect((await get(`/api/org/${orgId}/payroll/payslip`, tokens.hr_manager)).status).toBe(200)
    expect((await get(`/api/org/${orgId}/accounting/journal`, tokens.accountant)).status).toBe(200)
    expect((await get(`/api/org/${orgId}/payroll/payslip`, tokens.admin)).status).toBe(200)
  })
})

/**
 * What each app reads, found by scanning every UI module (`web/src/modules/*`) for the routes it calls. A role
 * opens an app when it opens a page of it (`appsOpenedBy`); the shell is everyone's. `pos` is the
 * till's pages inside the invoicing app, which `till.view` opens.
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
  payroll: ['payroll/run'],
  // About one person each, which `payroll.read` is not. The menu hides them from who lacks it (FR-25 §3.11).
  'payroll-people': ['payroll/employee', 'payroll/payslip', 'payroll/timesheet'],
  reports: ['reports/catalog'],
}

describe('each built-in role still reaches what its apps read', () => {
  it('no read of an app a role opens is refused', async () => {
    const broken: string[] = []
    for (const role of ROLES) {
      const grant = templateGrant(role)
      const apps = [
        'shell',
        // Invoicing as the back office that reads its documents: the Warehouse Manager opens only its orders, contacts
        // and devices pages there (#529), which its inventory reads cover.
        ...appsOpenedBy(grant).filter(app => app !== 'invoicing' || can(grant, 'sales-docs.view')),
        ...(can(grant, 'till.view') ? ['pos'] : []),
        ...(can(grant, 'payroll-people.view') ? ['payroll-people'] : []),
      ]
      for (const appId of apps) {
        for (const rest of APP_READS[appId] ?? []) {
          // FR-26: a part the role is held out of is refused on purpose (below).
          const carved = carvedOf(`/api/org/:orgId/${rest}`)
          if (carved && heldOut(role, carved)) continue
          const { status } = await get(`/api/org/${orgId}${rest ? `/${rest}` : ''}`, tokens[role])
          if (status === 403 || status === 401) broken.push(`${role} (${appId}) GET ${rest || '(org)'} → ${status}`)
        }
      }
    }
    expect(broken).toEqual([])
  }, 120_000)
})

describe("FR-26: the parts the Seller's and the Sales Consultant's roles leave out", () => {
  it('every carved-out read answers 403 to the roles held out of it, and only to them', async () => {
    const wrong: string[] = []
    const reads = getRoutes().filter(p => carvedOf(p))
    expect(reads.length).toBeGreaterThan(0)
    for (const path of reads) {
      const carved = carvedOf(path)!
      for (const role of ROLES) {
        // The two roles' own parts aside, a role its capabilities refuse already is not this test's.
        const rule = ruleOf(path)
        if (!heldOut(role, carved) && rule && 'anyOf' in rule && !can(templateGrant(role), rule.anyOf)) continue
        const { status, json } = await get(concrete(path), tokens[role])
        // A controller's own refusal (an export's `Forbidden`) is not the route rule's.
        const refused = status === 403 && json?.code === 'permission_required'
        if (refused !== heldOut(role, carved)) wrong.push(`${role} GET ${orgRouteRest(path)} → ${status} ${json?.code ?? ''}`)
      }
    }
    expect(wrong).toEqual([])
  }, 120_000)

  it('every carved prefix names a route that exists', () => {
    // Of any method: some parts are writes only (`bills/import`).
    const all = (createApiApp() as any).routes as Array<{ path: string }>
    const rests = all.map(r => orgRouteRest(r.path)).filter((r): r is string => r !== null)
    expect(CARVED.map(([prefix]) => prefix).filter(prefix => !rests.some(r => r === prefix || r.startsWith(`${prefix}/`)))).toEqual([])
  })

  it("what a Seller's kept pages read stays open: contacts, stock levels, products, movements, the journal", async () => {
    for (const rest of ['invoicing/contact', 'warehouse/stock-level', 'warehouse/product', 'warehouse/warehouse', 'warehouse/movement', 'cash-register/documents']) {
      expect({ rest, status: (await get(`/api/org/${orgId}/${rest}`, tokens.seller)).status }).toEqual({ rest, status: 200 })
    }
  })
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
