import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { Elysia } from 'elysia'
import jwt from '@elysiajs/jwt'
import { setupTestDB, teardownTestDB } from '../setup'
import { createApiApp } from '../../../portal-api/src/api.js'
import { spaErrorHandler } from '../../../portal-api/src/spa-fallback.js'
import { config } from 'config'
import { Identity, Invite, Org, PermissionSet, Role, User } from 'db/models'
import { register, tokenize } from 'services/biz/auth.service'
import { joinOrgByInvite } from 'services/biz/identity/account.service'
import { forgetAccessModel } from 'services/biz/access/shadow'
import { ROLE_TEMPLATES, compileLegacy, grantOfRole, legacyClaimsOf, sameGrant } from 'config/access'

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

async function legacyGrantOf(member: any) {
  const sets = member.permissionSetIds?.length ? await PermissionSet.find({ _id: { $in: member.permissionSetIds }, orgId: member.orgId }).lean().exec() : []
  return compileLegacy(legacyClaimsOf({ role: member.role, permissions: member.permissions }, sets as any))
}

beforeAll(async () => {
  await setupTestDB()
  app = new Elysia().onError(spaErrorHandler({}) as any).use(createApiApp()) as any
  const r = await register({ orgName: 'Onboarding', orgSlug: 'roles-onboarding', email: 'founder@onboarding.test', username: 'founder', password: 'secure123', firstName: 'Fo', lastName: 'Under' })
  org = r.org
  orgId = String(org._id)
  founder = r.user
  adminToken = await sign(founder._id)
}, 60_000)

afterAll(async () => { await teardownTestDB() }, 60_000)

describe('FR-27.3: a new org', () => {
  it('starts with the built-in roles, and its founder holds the Administrator role, with their legacy fields as they were', async () => {
    const builtins = await Role.find({ orgId: org._id, isBuiltin: true }).lean().exec()
    expect(builtins.map((r: any) => r.templateKey).sort()).toEqual(ROLE_TEMPLATES.map(t => t.key).sort())
    const me: any = await User.findById(founder._id).lean().exec()
    const admin: any = builtins.find((r: any) => r.templateKey === 'admin')
    expect(String(me.roleId)).toBe(String(admin._id))
    expect(me.role).toBe('admin')
    const adminSet: any = await PermissionSet.findOne({ orgId: org._id, name: 'Administrator' }).lean().exec()
    expect(me.permissionSetIds.map(String)).toEqual([String(adminSet._id)])
  })
})

describe('FR-27.3: the default role', () => {
  it('none at first; an Administrator names one, and clears it', async () => {
    expect((await call('GET', `/org/${orgId}/roles`, adminToken)).json.defaultRoleId).toBeNull()
    const made = await call('POST', `/org/${orgId}/roles`, adminToken, { name: 'Counter', from: { templateKey: 'seller' } })
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
  it('a role named rides on the invitation with its legacy key, and the person joins holding it', async () => {
    const r = await call('POST', `/org/${orgId}/invite`, adminToken, { targetEmail: 'named@onboarding.test', assignRoleId: String(counter._id) })
    expect(r.status).toBe(200)
    const invite: any = await Invite.findOne({ orgId: org._id, targetEmail: 'named@onboarding.test' }).lean().exec()
    expect(String(invite.assignRoleId)).toBe(String(counter._id))
    expect(invite.assignRole).toBe(counter.legacy.role)

    const who = await person('named@onboarding.test')
    const { member } = await joinOrgByInvite(who._id, invite.code)
    const joined: any = await User.findById(member._id).lean().exec()
    expect(String(joined.roleId)).toBe(String(counter._id))
    expect(joined.permissionSetIds.map(String)).toEqual([String(counter.legacy.setId)])
    // What an older release reads off the person grants what the role does.
    expect(sameGrant(await legacyGrantOf(joined), grantOfRole(counter))).toBe(true)
  })

  it('naming neither a role nor a legacy role is the default role', async () => {
    await call('POST', `/org/${orgId}/invite`, adminToken, { targetEmail: 'default@onboarding.test' })
    const invite: any = await Invite.findOne({ orgId: org._id, targetEmail: 'default@onboarding.test' }).lean().exec()
    expect(String(invite.assignRoleId)).toBe(String(counter._id))
    const { member } = await joinOrgByInvite((await person('default@onboarding.test'))._id, invite.code)
    expect(String(((await User.findById(member._id).lean().exec()) as any).roleId)).toBe(String(counter._id))
  })

  it('a legacy role named is the built-in role of that name, the person keeping their system set', async () => {
    await call('POST', `/org/${orgId}/invite`, adminToken, { targetEmail: 'legacy@onboarding.test', assignRole: 'accountant' })
    const invite: any = await Invite.findOne({ orgId: org._id, targetEmail: 'legacy@onboarding.test' }).lean().exec()
    expect(invite.assignRoleId).toBeUndefined()
    const { member } = await joinOrgByInvite((await person('legacy@onboarding.test'))._id, invite.code)
    const joined: any = await User.findById(member._id).lean().exec()
    const accountant: any = await Role.findOne({ orgId: org._id, templateKey: 'accountant' }).lean().exec()
    expect(String(joined.roleId)).toBe(String(accountant._id))
    const set: any = await PermissionSet.findOne({ orgId: org._id, name: 'Accountant', isSystem: true }).lean().exec()
    expect(joined.permissionSetIds.map(String)).toEqual([String(set._id)])
  })

  it('an org whose system set was edited: the person keeps that set and has no role yet, so nobody\'s access changes', async () => {
    await PermissionSet.updateOne({ orgId: org._id, name: 'Accountant', isSystem: true }, { $addToSet: { permissions: 'payroll.read' } }).exec()
    await call('POST', `/org/${orgId}/invite`, adminToken, { targetEmail: 'edited@onboarding.test', assignRole: 'accountant' })
    const invite: any = await Invite.findOne({ orgId: org._id, targetEmail: 'edited@onboarding.test' }).lean().exec()
    const { member } = await joinOrgByInvite((await person('edited@onboarding.test'))._id, invite.code)
    const joined: any = await User.findById(member._id).lean().exec()
    expect(joined.roleId).toBeUndefined()
    expect((await legacyGrantOf(joined) as any).caps.has('payroll-runs.view')).toBe(true)
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
    expect(made.permissionSetIds.map(String)).toEqual([String(counter.legacy.setId)])
  })

  it('with a legacy role named, the built-in role of that name', async () => {
    const r = await call('POST', `/org/${orgId}/user`, adminToken, { ...body('mgr'), role: 'manager' })
    const made: any = await User.findById(r.json.user._id ?? r.json.user.id).lean().exec()
    const manager: any = await Role.findOne({ orgId: org._id, templateKey: 'manager' }).lean().exec()
    expect(String(made.roleId)).toBe(String(manager._id))
    expect(made.role).toBe('manager')
  })
})

describe('FR-27.5: /auth/me says what the role grants', () => {
  it('null while the org is on the legacy model; the role, its name and version once on `roles`', async () => {
    expect((await call('GET', '/auth/me', adminToken)).json.access).toBeNull()
    await Org.updateOne({ _id: org._id }, { $set: { 'settings.access.model': 'roles' } }).exec()
    forgetAccessModel(orgId)
    const clerk: any = await User.findOne({ orgId: org._id, username: 'nobody' }).lean().exec()
    const me = (await call('GET', '/auth/me', await sign(clerk._id))).json.access
    expect(me.all).toBe(false)
    expect(me.role).toMatchObject({ id: String(counter._id), name: 'Counter' })
    expect(me.role.version).toBe(`${counter._id}:${counter.version ?? 1}`)
    expect(me.caps).toEqual([...grantOfRole(counter).caps as Set<string>].sort())
    expect((await call('GET', '/auth/me', adminToken)).json.access).toMatchObject({ all: true, caps: [] })
  })
})
