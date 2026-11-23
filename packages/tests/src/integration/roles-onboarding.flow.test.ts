import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { Identity, Invite, Org, Role, User } from 'db/models'
import { mongoose } from 'db/connection'
import { register, tokenize } from 'services/biz/auth.service'
import { joinOrgByInvite } from 'services/biz/identity/account.service'
import { ROLE_TEMPLATES, grantOfRole, sameGrant } from 'config/access'

/**
 * FR-27.3 / FR-27.4 (#529) — how a person gets their first role: a new org's founder, an invitation, a member an admin
 * creates, and the org's default role; and what `/auth/me` tells the SPA about the role.
 *
 * Phase 1 changes nobody's access: a role read off someone's legacy role is recorded only when it grants exactly what
 * their legacy fields do, and those are left alone. A role an admin CHOSE (named, or the org's default) is written onto
 * the person, as an assignment is.
 *
 * NOTE: no `.rejects` / `.resolves` (Bun-on-Windows deadlock, see Known Issues).
 */

const signer = new Elysia().use(jwt({ name: 'jwt', secret: config.jwt.secret }))
let app: Elysia
let org: any
let orgId: string
let founder: any
let adminToken: string
let counter: any

async function call(method: string, path: string, token: string, body?: unknown) {
  const res = await app.handle(new Request(`http://localhost/api${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  let json: any = null
  try { json = await res.json() } catch { /* not json */ }
  return { status: res.status, json }
}

const sign = async (userId: unknown) => (signer as any).decorator.jwt.sign(await tokenize((await User.findById(userId).exec())!))

/** Someone with their own password, who can accept an invitation. */
async function person(email: string) {
  return Identity.create({ email, password: await Bun.password.hash('secure123'), passwordSetBy: 'self', firstName: 'New', lastName: 'Person', isActive: true })
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  const r = await register({ orgName: 'Onboarding', orgSlug: 'roles-onboarding', email: 'founder@onboarding.test', username: 'founder', password: 'secure123', firstName: 'Fo', lastName: 'Under' })
  // What the activation link does. A session is a live membership's, and a founder still waiting for the link
  // holds none (`liveSessionUser`): the token signed below stood for one the product never gives.
  await User.updateOne({ _id: r.user._id }, { $set: { isActive: true } })
  org = r.org
  orgId = String(org._id)
  founder = r.user
  adminToken = await sign(founder._id)
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('FR-27.3: a new org', () => {
  it('starts with the built-in roles, and its founder holds the Administrator role and no legacy fields (FR-27 P3-5)', async () => {
    const builtins = await Role.find({ orgId: org._id, isBuiltin: true }).lean().exec()
    expect(builtins.map((r: any) => r.templateKey).sort()).toEqual(ROLE_TEMPLATES.map(t => t.key).sort())
    const me: any = await User.findById(founder._id).lean().exec()
    const admin: any = builtins.find((r: any) => r.templateKey === 'admin')
    expect(String(me.roleId)).toBe(String(admin._id))
    expect(me.role).toBeUndefined()
    expect(me.permissionSetIds).toBeUndefined()
    expect(me.permissions).toBeUndefined()
  })
})

describe('FR-27.3: the default role', () => {
  it('none at first; an Administrator names one, and clears it', async () => {
    expect((await call('GET', `/org/${orgId}/roles`, adminToken)).json.defaultRoleId).toBeNull()
    // `sales` withholds nothing (FR-27.11.B), so its projection is exact.
    const made = await call('POST', `/org/${orgId}/roles`, adminToken, { name: 'Counter', from: { templateKey: 'sales' } })
    expect(made.status).toBe(200)
    counter = await Role.findById(made.json.role.id).lean().exec()

    expect((await call('PUT', `/org/${orgId}/roles/default`, adminToken, { roleId: String(counter._id) })).status).toBe(200)
    expect((await call('GET', `/org/${orgId}/roles`, adminToken)).json.defaultRoleId).toBe(String(counter._id))
    expect((await call('PUT', `/org/${orgId}/roles/default`, adminToken, { roleId: null })).status).toBe(200)
    expect((await call('GET', `/org/${orgId}/roles`, adminToken)).json.defaultRoleId).toBeNull()
    await call('PUT', `/org/${orgId}/roles/default`, adminToken, { roleId: String(counter._id) })
  })

  it("another org's role is not a default", async () => {
    const other = await register({ orgName: 'Other', orgSlug: 'roles-onboarding-other', email: 'other@onboarding.test', username: 'other', password: 'secure123', firstName: 'Ot', lastName: 'Her' })
    const foreign: any = await Role.findOne({ orgId: other.org._id, templateKey: 'manager' }).lean().exec()
    expect((await call('PUT', `/org/${orgId}/roles/default`, adminToken, { roleId: String(foreign._id) })).status).toBe(404)
  })
})

describe('FR-27.4: an invitation names a role', () => {
  it('a role named rides on the invitation (no legacy key, FR-27 P3-5), and the person joins holding it', async () => {
    const r = await call('POST', `/org/${orgId}/invite`, adminToken, { targetEmail: 'named@onboarding.test', assignRoleId: String(counter._id) })
    expect(r.status).toBe(200)
    const invite: any = await Invite.findOne({ orgId: org._id, targetEmail: 'named@onboarding.test' }).lean().exec()
    expect(String(invite.assignRoleId)).toBe(String(counter._id))
    expect(invite.assignRole).toBeUndefined()

    const who = await person('named@onboarding.test')
    const { member } = await joinOrgByInvite(who._id, invite.code)
    const joined: any = await User.findById(member._id).lean().exec()
    expect(String(joined.roleId)).toBe(String(counter._id))
    expect(joined.permissionSetIds).toBeUndefined()
    expect(joined.role).toBeUndefined()
  })

  it('naming neither a role nor a legacy role is the default role', async () => {
    await call('POST', `/org/${orgId}/invite`, adminToken, { targetEmail: 'default@onboarding.test' })
    const invite: any = await Invite.findOne({ orgId: org._id, targetEmail: 'default@onboarding.test' }).lean().exec()
    expect(String(invite.assignRoleId)).toBe(String(counter._id))
    const { member } = await joinOrgByInvite((await person('default@onboarding.test'))._id, invite.code)
    expect(String(((await User.findById(member._id).lean().exec()) as any).roleId)).toBe(String(counter._id))
  })

  it('a legacy role is no longer accepted by the route: 422, nothing stored (FR-27 P3-3, #529)', async () => {
    const r = await call('POST', `/org/${orgId}/invite`, adminToken, { targetEmail: 'refused@onboarding.test', assignRole: 'accountant' })
    expect({ status: r.status, code: r.json?.code }).toEqual({ status: 422, code: 'legacy_role_field' })
    expect(await Invite.countDocuments({ orgId: org._id, targetEmail: 'refused@onboarding.test' })).toBe(0)
  })

  it('an invitation from before P3-3, its legacy role gone with 0017 and 0020, names none: the default role (FR-27 P3-9)', async () => {
    // As production keeps one after migration 0017: no `assignRole`, no `assignRoleId`, the key in `legacyArchive`
    // (0020 drops that too). No schema names either, and nothing reads them: it is an invitation that names no role.
    const code = `pre-p3-3-${Date.now()}`
    await mongoose.connection.db!.collection('invites').insertOne({
      orgId: org._id, code, inviterId: founder._id, targetEmail: 'legacy@onboarding.test', maxUses: 1, useCount: 0, status: 'active',
      legacyArchive: { assignRole: 'accountant', archivedAt: new Date() }, createdAt: new Date(), updatedAt: new Date(),
    })
    const { member } = await joinOrgByInvite((await person('legacy@onboarding.test'))._id, code)
    const joined: any = await User.findById(member._id).lean().exec()
    expect(String(joined.roleId)).toBe(String(counter._id))
    expect(joined.permissionSetIds).toBeUndefined()
    expect(joined.role).toBeUndefined()
  })

  it('a role beyond the inviter is refused (FR-27.8)', async () => {
    const r = await call('POST', `/org/${orgId}/invite`, adminToken, { targetEmail: 'x@onboarding.test', assignRoleId: '000000000000000000000000' })
    expect(r.status).toBe(404)
  })
})

describe('FR-27.3: a member an admin creates', () => {
  const body = (u: string) => ({ email: `${u}@onboarding.test`, username: u, password: 'secure-pass-123', firstName: 'Cr', lastName: 'Eated' })

  it('with no role named, starts with the default role', async () => {
    const r = await call('POST', `/org/${orgId}/user`, adminToken, body('nobody'))
    expect(r.status).toBe(200)
    const made: any = await User.findById(r.json.user._id ?? r.json.user.id).lean().exec()
    expect(String(made.roleId)).toBe(String(counter._id))
    expect(made.permissionSetIds).toBeUndefined()
  })

  it('with a legacy role named, 422 legacy_role_field and nobody made (#866)', async () => {
    const r = await call('POST', `/org/${orgId}/user`, adminToken, { ...body('mgr'), role: 'manager' })
    expect({ status: r.status, code: r.json?.code }).toEqual({ status: 422, code: 'legacy_role_field' })
    expect(await User.countDocuments({ orgId: org._id, username: 'mgr' })).toBe(0)
  })

  it('with a role key named, the built-in role of that key; no legacy key written', async () => {
    const r = await call('POST', `/org/${orgId}/user`, adminToken, { ...body('mgr'), roleKey: 'manager' })
    expect(r.status).toBe(200)
    const made: any = await User.findById(r.json.user._id ?? r.json.user.id).lean().exec()
    const manager: any = await Role.findOne({ orgId: org._id, templateKey: 'manager' }).lean().exec()
    expect(String(made.roleId)).toBe(String(manager._id))
    expect(made.role).toBeUndefined()
  })
})

describe('FR-27.5: /auth/me says what the role grants', () => {
  it('the role, its name and version, in every org (FR-27 P3-2: the access model is no longer read)', async () => {
    // On the legacy model too: every org session is its role's.
    expect((await call('GET', '/auth/me', adminToken)).json.access).toMatchObject({ all: true, caps: [] })
    await Org.updateOne({ _id: org._id }, { $set: { 'settings.access.model': 'roles' } }).exec()
    const clerk: any = await User.findOne({ orgId: org._id, username: 'nobody' }).lean().exec()
    const me = (await call('GET', '/auth/me', await sign(clerk._id))).json.access
    expect(me.all).toBe(false)
    expect(me.role).toMatchObject({ id: String(counter._id), name: 'Counter' })
    expect(me.role.version).toBe(`${counter._id}:${counter.version ?? 1}`)
    expect(me.caps).toEqual([...grantOfRole(counter).caps as Set<string>].sort())
    expect((await call('GET', '/auth/me', adminToken)).json.access).toMatchObject({ all: true, caps: [] })
  })
})
