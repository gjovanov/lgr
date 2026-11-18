import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { AuditLog, Org, Role, User, type IUser } from 'db/models'
import { tokenize } from 'services/biz/auth.service'
import { PRICE_CAPS, grantOfRole, sameGrant, templateGrant, withPriceLevels } from 'config/access'
import { RoleRefusal, setRoleCapsBySystem } from 'services/biz/access/role.service'
import { rolesFromSets } from 'migrations/migrations/0015-roles-from-sets'

/**
 * FR-27.3, FR-27.4, FR-27.8 (#529) — the roles API and its safety rules.
 *
 * The org runs on `roles` from the start, so a delegate (a role holding `roles.edit` and little else) is judged by
 * their role, as FR-27.8 means them to be.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: Elysia
let org: any
let orgId: string
let other: any
const people: Record<string, IUser> = {}
const tokens: Record<string, string> = {}

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/api/org/${orgId}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

const sign = async (key: string) => { tokens[key] = await (signer as any).decorator.jwt.sign(await tokenize((await User.findById(people[key]._id).exec())!)) }
const builtin = async (key: string) => (await Role.findOne({ orgId: org._id, templateKey: key }).lean().exec()) as any

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  org = await createTestOrg({ slug: 'roles-api' } as any)
  other = await createTestOrg({ slug: 'roles-api-other' } as any)
  orgId = String(org._id)
  for (const [key, role] of [['admin1', 'admin'], ['admin2', 'admin'], ['manager', 'manager'], ['accountant', 'accountant'], ['clerk', 'member']] as const) {
    people[key] = await createTestUser(org._id, { role, username: key, email: `${key}@roles-api.test` } as any)
  }
  await createTestUser(other._id, { role: 'admin', username: 'outsider', email: 'outsider@roles-api.test' } as any)
  await rolesFromSets.up({ db: mongoose.connection.db as any, log: () => {}, orgFilter: {} })
  await Org.updateOne({ _id: org._id }, { $set: { 'settings.access.model': 'roles' } }).exec()
  for (const key of Object.keys(people)) await sign(key)
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('FR-27.4: the roles of an org', () => {
  it('an Administrator lists them, the ten built-in ones with their people; a manager may not', async () => {
    const r = await call('GET', '/roles', tokens.admin1)
    expect(r.status).toBe(200)
    expect(r.json.roles.filter((x: any) => x.isBuiltin)).toHaveLength(10)
    expect(r.json.roles.find((x: any) => x.templateKey === 'admin')).toMatchObject({ all: true, people: 2 })
    expect((await call('GET', '/roles', tokens.manager)).status).toBe(403)
  })

  it('a role is created from a template, as its access, with no legacy projection (FR-27 P3-5)', async () => {
    // `sales` withholds nothing (FR-27.11.B): its access is exactly the legacy role's.
    const r = await call('POST', '/roles', tokens.admin1, { name: 'Counter', from: { templateKey: 'sales' } })
    expect(r.status).toBe(200)
    expect(r.json.role).toMatchObject({ name: 'Counter', isBuiltin: false })
    expect(r.json.role).not.toHaveProperty('needsRelease')
    const role: any = await Role.findById(r.json.role.id).lean().exec()
    expect(sameGrant(grantOfRole(role), templateGrant('sales'))).toBe(true)
    expect(role.legacy).toBeUndefined()
    expect(await mongoose.connection.db!.collection('permissionsets').countDocuments({ orgId: org._id, name: 'Role · Counter' })).toBe(0)
    // The create does not wait for its audit row: `createAuditEntry` never makes the operation it records
    // wait for, or fail on, its own trail. A read at once is a race, so read the row when it is there
    // (the idiom of audit-via.flow.test.ts).
    const end = Date.now() + 5000
    let audit: any = null
    while (!audit && Date.now() < end) {
      audit = await AuditLog.findOne({ entityType: 'role', action: 'create', entityId: role._id }).lean().exec()
      if (!audit) await Bun.sleep(20)
    }
    expect(audit?.changes?.[0]?.field).toBe('caps')
  })

  it('FR-27.11.B (D-11, D-12): from the Seller template, without the cost figures, Цена на едро and Цена 0', async () => {
    const r = await call('POST', '/roles', tokens.admin1, { name: 'Counter (Seller)', from: { templateKey: 'seller' } })
    expect(r.status).toBe(200)
    expect(r.json.role.caps).not.toContain('products.costs')
    expect(r.json.role.caps).not.toContain('products.price:wholesale')
    expect(r.json.role.caps).not.toContain('products.price:0')
    expect(r.json.role.caps).toContain('products.price:1')
    await call('DELETE', `/roles/${r.json.role.id}`, tokens.admin1)
  })

  it('a name is unique; an unknown capability is no grant', async () => {
    expect((await call('POST', '/roles', tokens.admin1, { name: 'Counter' })).status).toBe(409)
    const r = await call('POST', '/roles', tokens.admin1, { name: 'Lookers', caps: ['products.view', 'products.teleport'] })
    // The unknown id is dropped; the helpers the Products form reads come with View (FR-27.4 `withImplied`).
    expect(r.json.role.caps).toEqual(['doc-import.read', 'pricing.read', 'products.view', 'stock-availability.check', 'stock-levels.lookup'])
  })
})

describe('FR-27.3: giving a person a role', () => {
  it('writes the role and its history entry (id and name), and nothing of the legacy model (FR-27 P3-5)', async () => {
    const counter: any = await Role.findOne({ orgId: org._id, name: 'Counter' }).lean().exec()
    const before: any = await User.findById(people.clerk._id).lean().exec()
    const r = await call('PUT', `/user/${people.clerk._id}`, tokens.admin1, { roleId: String(counter._id) })
    expect(r.status).toBe(200)
    const clerk: any = await User.findById(people.clerk._id).lean().exec()
    expect(String(clerk.roleId)).toBe(String(counter._id))
    // The person's legacy fields stay as they were, frozen (P3-7 archives them).
    expect((clerk.permissionSetIds ?? []).map(String)).toEqual((before.permissionSetIds ?? []).map(String))
    expect(clerk.role).toBe(before.role)
    expect(clerk.roleHistory.at(-1)).toMatchObject({ roleName: 'Counter' })
    expect(String(clerk.roleHistory.at(-1).roleId)).toBe(String(counter._id))
    const token = await tokenize((await User.findById(people.clerk._id).exec())!)
    expect(token.rid).toBe(String(counter._id))
    expect('permissions' in token).toBe(false)
  })

  it('nobody changes their own role', async () => {
    const r = await call('PUT', `/user/${people.admin1._id}`, tokens.admin1, { roleId: String((await builtin('seller'))._id) })
    expect(r.json?.code).toBe('own_role')
  })

  it("another org's role is not found", async () => {
    const theirs: any = await Role.findOne({ orgId: other._id, templateKey: 'seller' }).lean().exec()
    const r = await call('PUT', `/user/${people.clerk._id}`, tokens.admin1, { roleId: String(theirs._id) })
    expect(r.status).toBe(404)
  })
})

describe('FR-27.8: a delegate gives nothing beyond their own role', () => {
  it('only an Administrator gives the right to manage roles', async () => {
    // A delegate who gives people roles also edits users (PUT /user takes `users.edit` before the role's rules).
    const delegate = await call('POST', '/roles', tokens.admin1, { name: 'Delegate', caps: ['roles.view', 'roles.edit', 'sales-docs.view', 'users.view', 'users.edit'] })
    expect(delegate.status).toBe(200)
    expect((await call('PUT', `/user/${people.manager._id}`, tokens.admin1, { roleId: delegate.json.role.id })).status).toBe(200)
  })

  it('a delegate makes a role within their own reach, and is refused one beyond it', async () => {
    expect((await call('POST', '/roles', tokens.manager, { name: 'Readers', caps: ['sales-docs.view'] })).status).toBe(200)
    const beyond = await call('POST', '/roles', tokens.manager, { name: 'Payers', caps: ['payments.view'] })
    expect(beyond.json).toMatchObject({ code: 'beyond_your_role', capability: 'payments.view' })
    expect((await call('POST', '/roles', tokens.manager, { name: 'Managers', caps: ['roles.view'] })).json.code).toBe('administrator_only')
  })

  it('a delegate neither gives the Administrator role, nor edits their own role', async () => {
    const admin = await builtin('admin')
    expect((await call('PUT', `/user/${people.accountant._id}`, tokens.manager, { roleId: String(admin._id) })).json.code).toBe('administrator_only')
    const own: any = await Role.findOne({ orgId: org._id, name: 'Delegate' }).lean().exec()
    expect((await call('PUT', `/roles/${own._id}`, tokens.manager, { caps: ['roles.view', 'roles.edit', 'sales-docs.view', 'users.edit', 'payments.view'] })).json.code).toBe('own_role')
  })
})

describe('FR-27.8: the Administrator', () => {
  it('the Administrator role is not edited or deleted', async () => {
    const admin = await builtin('admin')
    expect((await call('PUT', `/roles/${admin._id}`, tokens.admin1, { caps: [] })).json.code).toBe('administrator_role_fixed')
    expect((await call('DELETE', `/roles/${admin._id}`, tokens.admin1)).json.code).toBe('builtin_role')
  })

  it('the last active Administrator keeps the role and stays active', async () => {
    const seller = await builtin('seller')
    expect((await call('PUT', `/user/${people.admin1._id}`, tokens.admin2, { roleId: String(seller._id) })).status).toBe(200)
    expect((await call('DELETE', `/user/${people.admin2._id}`, tokens.admin2)).json?.code).toBe('last_administrator')
    expect((await call('PUT', `/user/${people.admin2._id}`, tokens.admin2, { isActive: false })).json?.code).toBe('last_administrator')
  })
})

describe('editing and deleting roles', () => {
  it('an edit reaches the role, a new version, and no legacy projection (FR-27 P3-5)', async () => {
    const counter: any = await Role.findOne({ orgId: org._id, name: 'Counter' }).lean().exec()
    const r = await call('PUT', `/roles/${counter._id}`, tokens.admin2, { caps: ['sales-docs.view', 'sales-docs.create', 'products.view'] })
    expect(r.status).toBe(200)
    expect(r.json.role).toMatchObject({ edited: true, version: 2 })
    const stored: any = await Role.findById(counter._id).lean().exec()
    expect(stored.legacy).toBeUndefined()
    expect(stored.needsRelease).toBeUndefined()
  })

  it('a role in use, or built-in, is not deleted; an unused one is', async () => {
    const counter: any = await Role.findOne({ orgId: org._id, name: 'Counter' }).lean().exec()
    expect((await call('DELETE', `/roles/${counter._id}`, tokens.admin2)).json.code).toBe('role_in_use')
    const lookers: any = await Role.findOne({ orgId: org._id, name: 'Lookers' }).lean().exec()
    expect((await call('DELETE', `/roles/${lookers._id}`, tokens.admin2)).status).toBe(200)
    expect(await Role.exists({ _id: lookers._id })).toBeNull()
  })
})

describe("#529: a sys-admin sets a role's price levels by script, as the editor would", () => {
  const VIA = 'scripts/role-price-levels.ts'
  const priceCaps = (caps: string[]) => caps.filter(c => (PRICE_CAPS as readonly string[]).includes(c)).sort()
  const notPrice = (caps: Iterable<string>) => [...caps].filter(c => !(PRICE_CAPS as readonly string[]).includes(c)).sort()

  it("the store's levels land on the built-in role, with the rest of it kept, a new version and an audit row", async () => {
    // As migration 0015 left the stores' roles: built-in, never edited.
    const seller: any = await Role.findOne({ orgId: other._id, isBuiltin: true, templateKey: 'seller' }).lean().exec()
    expect(seller.edited).toBe(false)
    const edit = withPriceLevels(templateGrant('seller').caps as Set<any>, ['selling', '1', '2', 'other'])
    expect([edit.unknown, edit.cameBack]).toEqual([[], []])

    const { before, after, role } = await setRoleCapsBySystem(String(other._id), String(seller._id), edit.caps, VIA)
    expect(priceCaps(after)).toEqual(['products.price:1', 'products.price:2', 'products.price:other', 'products.price:selling'])
    expect(notPrice(after)).toEqual(notPrice(before))
    expect(role).toMatchObject({ edited: true, version: (seller.version ?? 1) + 1 })

    // What the server reads from now on is what was saved: the role is edited, so its caps are its grant.
    const stored: any = await Role.findById(seller._id).lean().exec()
    expect(priceCaps([...grantOfRole(stored).caps as Set<string>])).toEqual(priceCaps(after))
    const audit: any = await AuditLog.findOne({ orgId: other._id, entityType: 'role', entityId: seller._id }).lean().exec()
    expect(audit).toMatchObject({ action: 'update', via: VIA })
  })

  it('the Administrator role is refused, and nothing is written', async () => {
    const admin: any = await Role.findOne({ orgId: other._id, isBuiltin: true, templateKey: 'admin' }).lean().exec()
    let refused: unknown
    try { await setRoleCapsBySystem(String(other._id), String(admin._id), [], VIA) } catch (e) { refused = e }
    expect(refused).toBeInstanceOf(RoleRefusal)
    expect((refused as RoleRefusal).body.code).toBe('administrator_role_fixed')
    expect(((await Role.findById(admin._id).lean().exec()) as any).version).toBe(admin.version)
  })
})
