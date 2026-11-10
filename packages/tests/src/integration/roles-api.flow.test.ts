import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { mongoose } from 'db/connection'
import { AuditLog, Org, PermissionSet, Role, User, type IUser } from 'db/models'
import { tokenize } from 'services/biz/auth.service'
import { seedDefaultPermissionSets } from 'services/biz/permission-set.seed'
import { forgetAccessModel } from 'services/biz/access/shadow'
import { compileLegacy, grantOfRole, sameGrant, templateGrant } from 'config/access'
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
  await seedDefaultPermissionSets(orgId)
  await seedDefaultPermissionSets(String(other._id))
  for (const [key, role] of [['admin1', 'admin'], ['admin2', 'admin'], ['manager', 'manager'], ['accountant', 'accountant'], ['clerk', 'member']] as const) {
    people[key] = await createTestUser(org._id, { role, username: key, email: `${key}@roles-api.test` } as any)
  }
  await createTestUser(other._id, { role: 'admin', username: 'outsider', email: 'outsider@roles-api.test' } as any)
  await rolesFromSets.up({ db: mongoose.connection.db as any, log: () => {}, orgFilter: {} })
  await Org.updateOne({ _id: org._id }, { $set: { 'settings.access.model': 'roles' } }).exec()
  forgetAccessModel(orgId)
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

  it('a role is created from a template, as its access, with a projection the legacy model serves exactly', async () => {
    const r = await call('POST', '/roles', tokens.admin1, { name: 'Counter', from: { templateKey: 'seller' } })
    expect(r.status).toBe(200)
    expect(r.json.role).toMatchObject({ name: 'Counter', isBuiltin: false, needsRelease: false })
    const role: any = await Role.findById(r.json.role.id).lean().exec()
    expect(sameGrant(grantOfRole(role), templateGrant('seller'))).toBe(true)
    expect(await PermissionSet.exists({ _id: role.legacy.setId, orgId: org._id, name: 'Role · Counter' })).toBeTruthy()
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

  it('a name is unique; an unknown capability is no grant', async () => {
    expect((await call('POST', '/roles', tokens.admin1, { name: 'Counter' })).status).toBe(409)
    const r = await call('POST', '/roles', tokens.admin1, { name: 'Lookers', caps: ['products.view', 'products.teleport'] })
    expect(r.json.role.caps).toEqual(['products.view'])
  })
})

describe('FR-27.3: giving a person a role', () => {
  it('writes the role, its projection and the history, and the legacy model then grants what the role does', async () => {
    const counter: any = await Role.findOne({ orgId: org._id, name: 'Counter' }).lean().exec()
    const r = await call('PUT', `/user/${people.clerk._id}`, tokens.admin1, { roleId: String(counter._id) })
    expect(r.status).toBe(200)
    const clerk: any = await User.findById(people.clerk._id).lean().exec()
    expect(String(clerk.roleId)).toBe(String(counter._id))
    expect(clerk.permissionSetIds.map(String)).toEqual([String(counter.legacy.setId)])
    expect(clerk.roleHistory.at(-1)).toMatchObject({ roleName: 'Counter' })
    // What a release that reads no roles makes of the person: their token, compiled.
    const legacy = await tokenize((await User.findById(people.clerk._id).exec())!)
    await Org.updateOne({ _id: org._id }, { $set: { 'settings.access.model': 'legacy' } }).exec()
    forgetAccessModel(orgId)
    const onLegacy = await tokenize((await User.findById(people.clerk._id).exec())!)
    await Org.updateOne({ _id: org._id }, { $set: { 'settings.access.model': 'roles' } }).exec()
    forgetAccessModel(orgId)
    expect(sameGrant(compileLegacy(onLegacy), grantOfRole(counter))).toBe(true)
    expect(legacy.rid).toBe(String(counter._id))
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
  it('an edit reaches the role and its projection set; a built-in role edited keeps what it was saved with', async () => {
    const counter: any = await Role.findOne({ orgId: org._id, name: 'Counter' }).lean().exec()
    const r = await call('PUT', `/roles/${counter._id}`, tokens.admin2, { caps: ['sales-docs.view', 'sales-docs.create', 'products.view'] })
    expect(r.status).toBe(200)
    expect(r.json.role).toMatchObject({ edited: true, version: 2 })
    const set: any = await PermissionSet.findById(counter.legacy.setId).lean().exec()
    // Never more than the role: no permission covers these three alone, so the legacy model serves less.
    expect(sameGrant(compileLegacy({ role: 'member', permissions: set.permissions, areas: set.areas }), grantOfRole({ caps: r.json.role.caps })) || r.json.role.needsRelease).toBe(true)
  })

  it('a role in use, or built-in, is not deleted; an unused one is, with its set', async () => {
    const counter: any = await Role.findOne({ orgId: org._id, name: 'Counter' }).lean().exec()
    expect((await call('DELETE', `/roles/${counter._id}`, tokens.admin2)).json.code).toBe('role_in_use')
    const lookers: any = await Role.findOne({ orgId: org._id, name: 'Lookers' }).lean().exec()
    expect((await call('DELETE', `/roles/${lookers._id}`, tokens.admin2)).status).toBe(200)
    expect(await PermissionSet.exists({ _id: lookers.legacy.setId })).toBeNull()
  })
})
