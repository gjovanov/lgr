import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createApiApp } from '../../../api/src/api.js'
import { spaErrorHandler } from '../../../api/src/spa-fallback.js'
import { config } from 'config'
import { Identity, Invite, Role, User } from 'db/models'
import { mongoose } from 'db/connection'
import { register, tokenize } from 'services/biz/auth.service'
import { joinOrgByInvite } from 'services/biz/identity/account.service'
import { inviteDao } from 'services/dao/invite.dao'

/**
 * FR-27 P3-5 (#529) — the legacy model is no longer written, and the token carries no legacy claims.
 *
 * - A person: no legacy `role` key, `permissions` or `permissionSetIds`, whichever way they joined (founded an org, an
 *   invitation, an admin's create), and not when a loaded person is saved again either (the schema has no defaults
 *   for them any more, so a save after P3-7's archive writes none back). Their role history names the role by id
 *   and name.
 * - An invitation: no `assignRole`, created or saved.
 * - A role: no legacy projection, no `needsRelease`, no system permission set ("Role · <name>").
 * - The token: `rid`/`rv`, `operatorCode`, `iid`/`tv`, never `role`, `permissions`, `areas` or `ownRecordsModules`; the
 *   sign-in answer carries the role's grant instead, and every route decides by the role.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const LEGACY_USER_FIELDS = ['role', 'permissions', 'permissionSetIds'] as const
const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: Elysia
let org: any
let orgId: string
let founder: any
let adminToken: string

async function call(method: string, path: string, token: string | null, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/api${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

const sign = async (userId: unknown) => (signer as any).decorator.jwt.sign(await tokenize((await User.findById(userId).exec())!))

/** What a stored person carries of the legacy model: none of it, after P3-5. */
async function legacyFieldsOf(userId: unknown): Promise<string[]> {
  const raw: any = await User.collection.findOne({ _id: (await User.findById(userId, { _id: 1 }).lean().exec())!._id })
  return LEGACY_USER_FIELDS.filter(f => f in raw)
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  const r = await register({ orgName: 'No Legacy', orgSlug: 'no-legacy', email: 'founder@nolegacy.test', username: 'founder', password: 'secure123', firstName: 'Fo', lastName: 'Under' })
  await User.updateOne({ _id: r.user._id }, { $set: { isActive: true } })
  await Identity.updateOne({ _id: r.user.identityId }, { $set: { isActive: true } })
  org = r.org
  orgId = String(org._id)
  founder = r.user
  adminToken = await sign(founder._id)
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('FR-27 P3-5: a person carries none of the legacy model', () => {
  it('the founder of a new org: the Administrator role, its history entry by id and name, no legacy fields', async () => {
    const me: any = await User.findById(founder._id).lean().exec()
    const admin: any = await Role.findOne({ orgId: org._id, isBuiltin: true, templateKey: 'admin' }).lean().exec()
    expect(String(me.roleId)).toBe(String(admin._id))
    expect(await legacyFieldsOf(founder._id)).toEqual([])
    expect(me.roleHistory.map((h: any) => ({ roleId: String(h.roleId), roleName: h.roleName, role: h.role }))).toEqual([
      { roleId: String(admin._id), roleName: admin.name, role: undefined },
    ])
  })

  it('a User created and saved again writes none of the three fields, nor an Invite its `assignRole`', async () => {
    const created = await User.create({ email: 'plain@nolegacy.test', username: 'plain', firstName: 'Pl', lastName: 'Ain', orgId: org._id })
    expect(await legacyFieldsOf(created._id)).toEqual([])
    const loaded = (await User.findById(created._id).exec())!
    loaded.position = 'Clerk'
    await loaded.save()
    expect(await legacyFieldsOf(created._id)).toEqual([])

    const invite = await inviteDao.createInvite({ orgId, inviterId: String(founder._id), targetEmail: 'saved@nolegacy.test' })
    const rawInvite = async () => Invite.collection.findOne({ _id: invite._id })
    expect('assignRole' in (await rawInvite())!).toBe(false)
    const again = (await Invite.findById(invite._id).exec())!
    again.maxUses = 2
    await again.save()
    expect('assignRole' in (await rawInvite())!).toBe(false)
  })

  it('an admin creates a member by role id or key, writing no legacy key; a legacy key is refused (422), nobody made', async () => {
    const accountant: any = await Role.findOne({ orgId: org._id, isBuiltin: true, templateKey: 'accountant' }).lean().exec()
    const byId = await call('POST', `/org/${orgId}/user`, adminToken, {
      email: 'byid@nolegacy.test', username: 'byid', password: 'a-long-password-1', firstName: 'By', lastName: 'Id', roleId: String(accountant._id),
    })
    expect(byId.status).toBe(200)
    const byKey = await call('POST', `/org/${orgId}/user`, adminToken, {
      email: 'bykey@nolegacy.test', username: 'bykey', password: 'a-long-password-1', firstName: 'By', lastName: 'Key', roleKey: 'accountant',
    })
    expect(byKey.status).toBe(200)
    for (const username of ['byid', 'bykey']) {
      const u: any = await User.findOne({ orgId: org._id, username }).lean().exec()
      expect(String(u.roleId)).toBe(String(accountant._id))
      expect(await legacyFieldsOf(u._id)).toEqual([])
      expect(u.roleHistory.at(-1).roleName).toBe(accountant.name)
    }
    // #866: the legacy key is refused, as invitations refuse `assignRole`.
    const legacy = await call('POST', `/org/${orgId}/user`, adminToken, {
      email: 'legacy@nolegacy.test', username: 'legacykey', password: 'a-long-password-1', firstName: 'Le', lastName: 'Gacy', role: 'accountant',
    })
    expect({ status: legacy.status, code: legacy.json?.code }).toEqual({ status: 422, code: 'legacy_role_field' })
    expect(await User.countDocuments({ orgId: org._id, username: 'legacykey' })).toBe(0)
    expect(await Identity.countDocuments({ email: 'legacy@nolegacy.test' })).toBe(0)
  })

  it('the legacy sets, permissions and role key are refused on an update (422); a role key moves the person', async () => {
    const u: any = await User.findOne({ orgId: org._id, username: 'byid' }).lean().exec()
    for (const body of [{ permissions: ['invoicing.read'] }, { permissionSetIds: [] }, { role: 'manager' }]) {
      const r = await call('PUT', `/org/${orgId}/user/${u._id}`, adminToken, body)
      expect({ status: r.status, code: r.json?.code }).toEqual({ status: 422, code: 'legacy_role_field' })
    }
    expect(String((await User.findById(u._id).lean().exec() as any).roleId)).toBe(String(u.roleId))
    const manager: any = await Role.findOne({ orgId: org._id, isBuiltin: true, templateKey: 'manager' }).lean().exec()
    expect((await call('PUT', `/org/${orgId}/user/${u._id}`, adminToken, { roleKey: 'manager' })).status).toBe(200)
    const after: any = await User.findById(u._id).lean().exec()
    expect(String(after.roleId)).toBe(String(manager._id))
    expect(await legacyFieldsOf(u._id)).toEqual([])
    // Appendix 29: the accountant's period closed, the manager's open, each by id and name.
    const accountant: any = await Role.findOne({ orgId: org._id, isBuiltin: true, templateKey: 'accountant' }).lean().exec()
    expect(after.roleHistory.map((h: any) => [String(h.roleId), h.roleName, !!h.endDate])).toEqual([
      [String(accountant._id), accountant.name, true],
      [String(manager._id), manager.name, false],
    ])
  })

  it('an invitation names its role by id only, and the person who joins carries no legacy fields', async () => {
    const r = await call('POST', `/org/${orgId}/invite`, adminToken, { targetEmail: 'joiner@nolegacy.test' })
    expect(r.status).toBe(200)
    const raw: any = await Invite.collection.findOne({ orgId: org._id, targetEmail: 'joiner@nolegacy.test' })
    expect(raw.assignRoleId).toBeTruthy()
    expect('assignRole' in raw).toBe(false)

    const who = await Identity.create({ email: 'joiner@nolegacy.test', password: await Bun.password.hash('secure123'), passwordSetBy: 'self', firstName: 'Jo', lastName: 'Iner', isActive: true })
    const { member } = await joinOrgByInvite(who._id, raw.code)
    const joined: any = await User.findById(member._id).lean().exec()
    expect(String(joined.roleId)).toBe(String(raw.assignRoleId))
    expect(await legacyFieldsOf(member._id)).toEqual([])
    expect(String(joined.roleHistory[0].roleId)).toBe(String(raw.assignRoleId))
  })
})

describe('FR-27 P3-5: a role carries no legacy projection', () => {
  it('a role made and edited writes no `legacy`, no `needsRelease`, and no "Role · <name>" permission set', async () => {
    const made = await call('POST', `/org/${orgId}/roles`, adminToken, { name: 'Counter clerk', caps: ['products.view'] })
    expect(made.status).toBe(200)
    expect('needsRelease' in made.json.role).toBe(false)
    expect((await call('PUT', `/org/${orgId}/roles/${made.json.role.id}`, adminToken, { caps: ['products.view', 'contacts.view'] })).status).toBe(200)
    const raw: any = await Role.collection.findOne({ _id: (await Role.findById(made.json.role.id, { _id: 1 }).lean().exec())!._id })
    expect('legacy' in raw).toBe(false)
    expect('needsRelease' in raw).toBe(false)
    expect(raw.version).toBe(2)
    expect(await mongoose.connection.db!.collection('permissionsets').countDocuments({ orgId: org._id, name: 'Role · Counter clerk' })).toBe(0)
  })

  it("a new org's built-in roles carry no projection either", async () => {
    const builtins = await Role.collection.find({ orgId: org._id, isBuiltin: true }).toArray()
    expect(builtins.length).toBeGreaterThan(0)
    expect(builtins.filter((r: any) => 'legacy' in r || 'needsRelease' in r).map((r: any) => r.templateKey)).toEqual([])
  })
})

describe('FR-27 P3-5: the token carries no legacy claims', () => {
  it('`tokenize()` names the person, the org and the role, never what it allows', async () => {
    const claims: any = await tokenize((await User.findById(founder._id).exec())!)
    for (const k of ['role', 'permissions', 'areas', 'ownRecordsModules']) expect(k in claims).toBe(false)
    const admin: any = await Role.findOne({ orgId: org._id, templateKey: 'admin' }).lean().exec()
    expect(claims.rid).toBe(String(admin._id))
    expect(claims.rv).toBe(admin.version ?? 1)
    expect(claims.operatorCode).toBeTruthy()
  })

  it('sign-in answers the role\'s grant, and a session decides by its role', async () => {
    const login = await call('POST', '/auth/login', null, { username: 'founder', password: 'secure123', orgSlug: 'no-legacy' })
    expect(login.status).toBe(200)
    expect(login.json.access).toMatchObject({ all: true })
    expect(login.json.access.role.id).toBeTruthy()
    for (const k of ['role', 'permissions', 'areas']) expect(k in login.json.user).toBe(false)

    const me = await call('GET', '/auth/me', login.json.token)
    expect(me.json.access).toMatchObject({ all: true })
    // An org route, decided by the role: the Administrator reads the users.
    expect((await call('GET', `/org/${orgId}/user`, login.json.token)).status).toBe(200)

    // A member whose role reads no users is refused, though nothing in its token says so either way.
    const clerk: any = await User.findOne({ orgId: org._id, username: 'plain' }).lean().exec()
    const counter: any = await Role.findOne({ orgId: org._id, name: 'Counter clerk' }).lean().exec()
    await User.updateOne({ _id: clerk._id }, { $set: { roleId: counter._id, isActive: true } })
    const clerkToken = await sign(clerk._id)
    expect((await call('GET', `/org/${orgId}/accounting/journal`, clerkToken)).status).toBe(403)
  })
})
