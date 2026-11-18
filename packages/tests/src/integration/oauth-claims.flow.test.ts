import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { setupTestDB, teardownTestDB } from '../setup'
import { builtinRoleIdOf, createTestOrg, createTestUser } from '../helpers/factories'
import { getOrCreateUser, registerWithOAuth } from 'services/biz/oauth.service'
import { tokenize } from 'services/biz/auth.service'
import { inviteDao } from 'services/dao/invite.dao'
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, APP_IDS } from 'config/constants'
import { Org, OrgApp, Role, User } from 'db/models'
import { mongoose } from 'db/connection'
import type { Types } from 'mongoose'

/**
 * S-23 — an OAuth sign-in built its session claims by hand, so it was a second, drifting answer to
 * "what may this person do". `tokenize()` is the first one, used by password login:
 *
 *   - **Permission sets were ignored.** The claims took `user.permissions`, the role's defaults,
 *     so a user narrowed by a permission set (read-only, or own-records-only) got their ROLE's full
 *     rights by signing in with Google instead of a password. Own-records restrictions
 *     (`ownRecordsModules`) were dropped entirely.
 *   - **The Administrator set's "every permission"** never applied either, so an admin signing in
 *     with Google lacked what the same admin had with a password (`admin.audit`, …).
 *   - **No `operatorCode`** — the fiscal operator a POS receipt is printed under (Н-18).
 *
 * And the two OAuth paths that CREATE users skipped what `register()` does: an invited user got no
 * operator code and no role history, and an OAuth sign-up's org got no permission sets, no app
 * rows and `modules: []`.
 */

let org: { _id: Types.ObjectId; slug: string }

const google = (providerId: string, email: string, name = 'Test Person') => ({
  provider: 'google',
  providerId,
  email,
  emailVerified: true,
  name,
  avatarUrl: undefined,
})

beforeAll(async () => {
  await setupTestDB()
  const o = await createTestOrg({ slug: 'claims-org' } as any)
  org = { _id: o._id as Types.ObjectId, slug: 'claims-org' }
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

describe('S-23: an OAuth session carries the same claims as a password session', () => {
  it('names the role a narrow person holds, as a password session does', async () => {
    // A person from before roles on a set of their own (raw: sets have no model since FR-27 P3-6); 0015 gives the role.
    const narrow = { _id: new mongoose.Types.ObjectId() }
    await mongoose.connection.db!.collection('permissionsets').insertOne({ _id: narrow._id, orgId: org._id, name: 'Own sales, read only', permissions: ['sales.read'] })
    await createTestUser(org._id, {
      email: 'narrow@claims.test',
      username: 'narrow',
      role: 'accountant',
      permissionSetIds: [narrow._id],
      operatorCode: '0007',
      oauthProviders: [{ provider: 'google', providerId: 'g-narrow' }],
    } as any)

    const { user } = await getOrCreateUser(google('g-narrow', 'narrow@claims.test') as any, org.slug)

    // FR-27 P3-5: an org session names the person's role, whichever way they signed in (S-23): here the role 0015
    // gave, exactly the set's access. The token carries no permissions; the role decides every request.
    const password = await tokenize((await User.findOne({ orgId: org._id, username: 'narrow' }).exec())!)
    expect(user).toEqual(password)
    expect(user.rid).toBeTruthy()
    expect('permissions' in user).toBe(false)
    expect(user.operatorCode).toBe('0007')
  })

  it('names the Administrator role, as password login does', async () => {
    await createTestUser(org._id, {
      email: 'boss@claims.test',
      username: 'boss',
      role: 'admin',
      oauthProviders: [{ provider: 'google', providerId: 'g-boss' }],
    } as any)

    const { user } = await getOrCreateUser(google('g-boss', 'boss@claims.test') as any, org.slug)

    // FR-27 P3-5: the Administrator's role, as a password sign-in names it (S-23); the role grants everything.
    const password = await tokenize((await User.findOne({ orgId: org._id, username: 'boss' }).exec())!)
    expect(user).toEqual(password)
    const role: any = await Role.findById(user.rid).lean().exec()
    expect(role.all).toBe(true)
  })
})

describe('S-23: OAuth-created users are provisioned like registered ones', () => {
  it('an invited user gets an operator code and a role history, and the session carries the code', async () => {
    const inviter = await createTestUser(org._id, { email: 'inviter@claims.test', username: 'inviter' } as any)
    const invite = await inviteDao.createInvite({
      orgId: String(org._id),
      inviterId: String(inviter._id),
      assignRoleId: await builtinRoleIdOf(org._id, 'accountant'),
      targetEmail: 'newbie@claims.test',
    })

    const { user, isNew } = await getOrCreateUser(google('g-newbie', 'newbie@claims.test') as any, org.slug, invite.code)

    expect(isNew).toBe(true)
    const stored = await User.findById(user.id).lean().exec()
    expect(stored!.operatorCode).toMatch(/^\d{4}$/)
    // FR-27 P3-5: the history names the role by id and name.
    const accountant: any = await Role.findOne({ orgId: org._id, isBuiltin: true, templateKey: 'accountant' }).lean().exec()
    expect(String(stored!.roleHistory?.[0]?.roleId)).toBe(String(accountant._id))
    expect(stored!.roleHistory?.[0]?.roleName).toBe(accountant.name)
    expect(user.operatorCode).toBe(stored!.operatorCode)
    expect(user.rid).toBe(String(accountant._id))
  })

  it('an OAuth sign-up gets the org register() would build: modules, app rows, permission sets, an operator code', async () => {
    const { user } = await registerWithOAuth(
      google('g-founder', 'founder@claims.test', 'Founding Owner') as any,
      'OAuth Founded',
      'oauth-founded',
      'founder',
    )

    const created = await Org.findOne({ slug: 'oauth-founded' }).lean().exec()
    expect(created!.settings.modules?.length ?? 0).toBeGreaterThan(0)
    expect(await OrgApp.countDocuments({ orgId: created!._id })).toBe(APP_IDS.length)
    // FR-27 P3-6: no permission sets for a new org, its built-in roles instead.
    expect(await mongoose.connection.db!.collection('permissionsets').countDocuments({ orgId: created!._id })).toBe(0)

    const stored = await User.findById(user.id).lean().exec()
    // FR-27 P3-5: the Administrator role, by id and name in the history; no permission set, no legacy key.
    expect(stored!.permissionSetIds).toBeUndefined()
    expect(stored!.role).toBeUndefined()
    expect(stored!.operatorCode).toMatch(/^\d{4}$/)
    const admin: any = await Role.findOne({ orgId: created!._id, isBuiltin: true, templateKey: 'admin' }).lean().exec()
    expect(String(stored!.roleId)).toBe(String(admin._id))
    expect(String(stored!.roleHistory?.[0]?.roleId)).toBe(String(admin._id))
    const password = await tokenize((await User.findById(user.id).exec())!)
    expect(user.rid).toBe(password.rid)
    expect(user.operatorCode).toBe(stored!.operatorCode)
  })
})
