import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { getOrCreateUser, registerWithOAuth } from 'services/biz/oauth.service'
import { seedDefaultPermissionSets } from 'services/biz/permission-set.seed'
import { inviteDao } from 'services/dao/invite.dao'
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, APP_IDS } from 'config/constants'
import { Org, OrgApp, PermissionSet, User } from 'db/models'
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
  await seedDefaultPermissionSets(String(org._id))
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

describe('S-23: an OAuth session carries the same claims as a password session', () => {
  it('honours a restrictive permission set, own-records included, instead of the role\'s defaults', async () => {
    const narrow = await PermissionSet.create({
      orgId: org._id,
      name: 'Own sales, read only',
      permissions: ['sales.read'],
      ownRecordsOnly: { sales: true },
    })
    await createTestUser(org._id, {
      email: 'narrow@claims.test',
      username: 'narrow',
      role: 'accountant',
      permissionSetIds: [narrow._id],
      operatorCode: '0007',
      oauthProviders: [{ provider: 'google', providerId: 'g-narrow' }],
    } as any)

    const { user } = await getOrCreateUser(google('g-narrow', 'narrow@claims.test') as any, org.slug)

    expect(user.permissions.sort()).toEqual(['sales.read'])
    expect(user.permissions).not.toContain(DEFAULT_ROLE_PERMISSIONS.accountant.find(p => p !== 'sales.read')!)
    expect(user.ownRecordsModules).toContain('sales')
    expect(user.operatorCode).toBe('0007')
  })

  it('expands the Administrator set to every permission, as password login does', async () => {
    const adminSet = await PermissionSet.findOne({ orgId: org._id, isAdmin: true }).lean().exec()
    await createTestUser(org._id, {
      email: 'boss@claims.test',
      username: 'boss',
      role: 'admin',
      permissionSetIds: [adminSet!._id],
      oauthProviders: [{ provider: 'google', providerId: 'g-boss' }],
    } as any)

    const { user } = await getOrCreateUser(google('g-boss', 'boss@claims.test') as any, org.slug)

    expect([...user.permissions].sort()).toEqual([...PERMISSIONS].sort())
  })
})

describe('S-23: OAuth-created users are provisioned like registered ones', () => {
  it('an invited user gets an operator code and a role history, and the session carries the code', async () => {
    const inviter = await createTestUser(org._id, { email: 'inviter@claims.test', username: 'inviter' } as any)
    const invite = await inviteDao.createInvite({
      orgId: String(org._id),
      inviterId: String(inviter._id),
      assignRole: 'accountant',
      targetEmail: 'newbie@claims.test',
    } as any)

    const { user, isNew } = await getOrCreateUser(google('g-newbie', 'newbie@claims.test') as any, org.slug, invite.code)

    expect(isNew).toBe(true)
    const stored = await User.findById(user.id).lean().exec()
    expect(stored!.operatorCode).toMatch(/^\d{4}$/)
    expect(stored!.roleHistory?.[0]?.role).toBe('accountant')
    expect(user.operatorCode).toBe(stored!.operatorCode)
    expect(user.role).toBe('accountant')
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
    const adminSet = await PermissionSet.findOne({ orgId: created!._id, isAdmin: true }).lean().exec()
    expect(adminSet).not.toBeNull()

    const stored = await User.findById(user.id).lean().exec()
    expect(stored!.permissionSetIds?.map(String)).toContain(String(adminSet!._id))
    expect(stored!.operatorCode).toMatch(/^\d{4}$/)
    expect(stored!.roleHistory?.[0]?.role).toBe('admin')
    expect([...user.permissions].sort()).toEqual([...PERMISSIONS].sort())
    expect(user.operatorCode).toBe(stored!.operatorCode)
  })
})
