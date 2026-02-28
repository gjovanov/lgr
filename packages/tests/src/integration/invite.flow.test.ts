import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { register } from 'services/biz/auth.service'
import { inviteDao } from 'services/dao/invite.dao'
import { Invite, User, Notification } from 'db/models'
import { createTestOrg, createTestUser, createTestInvite, createTestNotification } from '../helpers/factories'
import { paginateQuery } from 'services/utils/pagination'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('Invite Flow', () => {
  async function registerAdmin() {
    return register({
      orgName: 'Test Corp',
      orgSlug: 'test-corp',
      email: 'admin@test.com',
      username: 'admin',
      password: 'secure123',
      firstName: 'Admin',
      lastName: 'User',
    })
  }

  it('should create a shareable invite', async () => {
    const { org, user } = await registerAdmin()
    const invite = await inviteDao.createInvite({
      orgId: String(org._id),
      inviterId: String(user._id),
      maxUses: 10,
      expiresInHours: 24,
    })
    expect(invite.code).toHaveLength(21)
    expect(invite.status).toBe('active')
    expect(invite.maxUses).toBe(10)
    expect(invite.useCount).toBe(0)
    expect(invite.assignRole).toBe('member')
    expect(invite.expiresAt).toBeDefined()
  })

  it('should create a targeted email invite with maxUses=1', async () => {
    const { org, user } = await registerAdmin()
    const invite = await inviteDao.createInvite({
      orgId: String(org._id),
      inviterId: String(user._id),
      targetEmail: 'new@user.com',
    })
    expect(invite.targetEmail).toBe('new@user.com')
    expect(invite.maxUses).toBe(1)
  })

  it('should list invites by org', async () => {
    const { org, user } = await registerAdmin()
    await inviteDao.createInvite({ orgId: String(org._id), inviterId: String(user._id) })
    await inviteDao.createInvite({ orgId: String(org._id), inviterId: String(user._id) })

    const result = await inviteDao.listByOrg(String(org._id))
    expect(result.items).toHaveLength(2)
    expect(result.total).toBe(2)
  })

  it('should find invite by code', async () => {
    const { org, user } = await registerAdmin()
    const created = await inviteDao.createInvite({
      orgId: String(org._id),
      inviterId: String(user._id),
    })
    const found = await inviteDao.findByCode(created.code)
    expect(found).not.toBeNull()
    expect(String(found!._id)).toBe(String(created._id))
  })

  it('should validate active invite as valid', async () => {
    const { org, user } = await registerAdmin()
    const invite = await inviteDao.createInvite({
      orgId: String(org._id),
      inviterId: String(user._id),
    })
    const result = inviteDao.validate(invite)
    expect(result.valid).toBe(true)
  })

  it('should validate expired invite as invalid', async () => {
    const { org, user } = await registerAdmin()
    const invite = await Invite.create({
      code: 'expired-code-12345678',
      orgId: org._id,
      inviterId: user._id,
      status: 'active',
      useCount: 0,
      assignRole: 'member',
      expiresAt: new Date(Date.now() - 1000),
    })
    const result = inviteDao.validate(invite)
    expect(result.valid).toBe(false)
    expect(result.reason).toContain('expired')
  })

  it('should revoke an active invite', async () => {
    const { org, user } = await registerAdmin()
    const invite = await inviteDao.createInvite({
      orgId: String(org._id),
      inviterId: String(user._id),
    })
    const revoked = await inviteDao.revoke(String(invite._id), String(org._id))
    expect(revoked).not.toBeNull()
    expect(revoked!.status).toBe('revoked')
  })

  it('should increment use count and exhaust invite', async () => {
    const { org, user } = await registerAdmin()
    const invite = await inviteDao.createInvite({
      orgId: String(org._id),
      inviterId: String(user._id),
      maxUses: 1,
    })
    const updated = await inviteDao.incrementUseCount(String(invite._id))
    expect(updated!.useCount).toBe(1)
    expect(updated!.status).toBe('exhausted')
  })

  it('should register user via invite code and join existing org', async () => {
    const { org, user } = await registerAdmin()
    const invite = await inviteDao.createInvite({
      orgId: String(org._id),
      inviterId: String(user._id),
    })

    const result = await register({
      email: 'newbie@test.com',
      username: 'newbie',
      password: 'newpass123',
      firstName: 'New',
      lastName: 'User',
      inviteCode: invite.code,
    })

    expect(result.user.role).toBe('member')
    expect(String(result.user.orgId)).toBe(String(org._id))
    expect(String(result.org._id)).toBe(String(org._id))

    // Verify invite use count incremented
    const updated = await inviteDao.findByCode(invite.code)
    expect(updated!.useCount).toBe(1)
  })

  it('should reject registration with targeted invite if email mismatches', async () => {
    const { org, user } = await registerAdmin()
    const invite = await inviteDao.createInvite({
      orgId: String(org._id),
      inviterId: String(user._id),
      targetEmail: 'specific@user.com',
    })

    await expect(
      register({
        email: 'wrong@email.com',
        username: 'wrong',
        password: 'wrong123',
        firstName: 'Wrong',
        lastName: 'User',
        inviteCode: invite.code,
      }),
    ).rejects.toThrow('different email')
  })

  it('should reject registration with revoked invite', async () => {
    const { org, user } = await registerAdmin()
    const invite = await inviteDao.createInvite({
      orgId: String(org._id),
      inviterId: String(user._id),
    })
    await inviteDao.revoke(String(invite._id), String(org._id))

    await expect(
      register({
        email: 'another@test.com',
        username: 'another',
        password: 'pass123',
        firstName: 'Another',
        lastName: 'User',
        inviteCode: invite.code,
      }),
    ).rejects.toThrow('revoked')
  })

  it('should not revoke invite from different org', async () => {
    const { org, user } = await registerAdmin()
    const invite = await inviteDao.createInvite({
      orgId: String(org._id),
      inviterId: String(user._id),
    })

    const { org: otherOrg } = await register({
      orgName: 'Other Corp',
      orgSlug: 'other-corp',
      email: 'other@test.com',
      username: 'otheradmin',
      password: 'secure123',
      firstName: 'Other',
      lastName: 'Admin',
    })

    const result = await inviteDao.revoke(String(invite._id), String(otherOrg._id))
    expect(result).toBeNull()
  })
})

describe('Portal Pagination', () => {
  it('should paginate invites', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    for (let i = 0; i < 15; i++) {
      await createTestInvite(org._id, user._id)
    }
    const p0 = await paginateQuery(Invite, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)
    expect(p0.totalPages).toBe(2)

    const p1 = await paginateQuery(Invite, { orgId: org._id }, { page: '1' })
    expect(p1.items).toHaveLength(5)

    const all = await paginateQuery(Invite, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate users', async () => {
    const org = await createTestOrg()
    for (let i = 0; i < 15; i++) {
      await createTestUser(org._id, { email: `user-pag-${i}@test.com`, username: `user-pag-${i}` })
    }
    const p0 = await paginateQuery(User, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(User, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })

  it('should paginate notifications', async () => {
    const org = await createTestOrg()
    const user = await createTestUser(org._id)
    for (let i = 0; i < 15; i++) {
      await createTestNotification(org._id, user._id, { title: `Notif ${String(i).padStart(2, '0')}` })
    }
    const p0 = await paginateQuery(Notification, { orgId: org._id }, {})
    expect(p0.items).toHaveLength(10)
    expect(p0.total).toBe(15)

    const all = await paginateQuery(Notification, { orgId: org._id }, { size: '0' })
    expect(all.items).toHaveLength(15)
  })
})
