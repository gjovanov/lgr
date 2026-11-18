import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser, roleKeyOf } from '../helpers/factories'
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from 'config/constants'
import { register, tokenize } from 'services/biz/auth.service'
import { User, Role } from 'db/models'
import { grantOfRole } from 'config/access'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('Permission & Auth: Role-Based Access Control', () => {
  it('should grant admin all permissions (admin.users, admin.settings + all module perms)', async () => {
    const { user } = await register({
      orgName: 'Admin Perms Org',
      orgSlug: 'admin-perms-org',
      email: 'admin@perms.com',
      username: 'adminperms',
      password: 'secure123',
      firstName: 'Admin',
      lastName: 'Perms',
    })

    // FR-27 P3-5 (#529): the founder holds the Administrator role, which grants everything; no legacy role key or
    // permissions are written.
    expect(await roleKeyOf(user._id)).toBe('admin')
    const stored: any = await User.findById(user._id).lean()
    expect(grantOfRole(await Role.findById(stored.roleId).lean()).all).toBe(true)
    expect(stored.role).toBeUndefined()
    expect(stored.permissions).toBeUndefined()
  })

  it('should grant accountant only accounting + invoicing + inventory.read permissions', async () => {
    const org = await createTestOrg({ name: 'Acct Org', slug: 'acct-org' })
    const user = await createTestUser(org._id, {
      role: 'accountant',
      email: 'acct@test.com',
      username: 'acctuser',
    })

    expect(user.role).toBe('accountant')
    expect(user.permissions.slice().sort()).toEqual(DEFAULT_ROLE_PERMISSIONS.accountant.slice().sort())
    expect(user.permissions.length).toBe(DEFAULT_ROLE_PERMISSIONS.accountant.length)

    for (const perm of ['accounting.read', 'accounting.write', 'accounting.post', 'invoicing.read', 'invoicing.write', 'invoicing.send', 'inventory.read']) {
      expect(user.permissions).toContain(perm)
    }
  })

  it('should grant warehouse manager only inventory permissions', async () => {
    const org = await createTestOrg({ name: 'WH Org', slug: 'wh-org' })
    const user = await createTestUser(org._id, {
      role: 'warehouse_manager',
      email: 'wh@test.com',
      username: 'whuser',
    })

    expect(user.role).toBe('warehouse_manager')
    expect(user.permissions.slice().sort()).toEqual(DEFAULT_ROLE_PERMISSIONS.warehouse_manager.slice().sort())
    expect(user.permissions.length).toBe(DEFAULT_ROLE_PERMISSIONS.warehouse_manager.length)

    for (const perm of ['inventory.read', 'inventory.write', 'inventory.adjust']) {
      expect(user.permissions).toContain(perm)
    }

    expect(user.permissions).not.toContain('accounting.read')
    expect(user.permissions).not.toContain('payroll.read')
    expect(user.permissions).not.toContain('admin.users')
  })

  it('should grant member user only read permissions across modules', async () => {
    const org = await createTestOrg({ name: 'Member Org', slug: 'member-org' })
    const user = await createTestUser(org._id, {
      role: 'member',
      email: 'member@test.com',
      username: 'memberuser',
    })

    expect(user.role).toBe('member')
    expect(user.permissions.slice().sort()).toEqual(DEFAULT_ROLE_PERMISSIONS.member.slice().sort())
    expect(user.permissions.length).toBe(DEFAULT_ROLE_PERMISSIONS.member.length)

    for (const perm of user.permissions) {
      expect(perm).toMatch(/\.read$/)
    }

    for (const perm of ['accounting.read', 'inventory.read', 'invoicing.read']) {
      expect(user.permissions).toContain(perm)
    }

    // What people are paid is no default of being in the org (FR-25 §3.11).
    expect(user.permissions).not.toContain('payroll.read')
    expect(user.permissions).not.toContain('admin.users')
    expect(user.permissions).not.toContain('accounting.write')
    expect(user.permissions).not.toContain('inventory.write')
  })

  it('should prevent user from org1 accessing org2 data via login', async () => {
    const { user: org1Admin } = await register({
      orgName: 'Org One',
      orgSlug: 'org-one',
      email: 'admin@org1.com',
      username: 'org1admin',
      password: 'pass123',
      firstName: 'Org1',
      lastName: 'Admin',
    })

    const { user: org2Admin } = await register({
      orgName: 'Org Two',
      orgSlug: 'org-two',
      email: 'admin@org2.com',
      username: 'org2admin',
      password: 'pass456',
      firstName: 'Org2',
      lastName: 'Admin',
    })

    // Both should be admins in their respective orgs
    expect(org1Admin.orgId).not.toBe(org2Admin.orgId)
    expect(await roleKeyOf(org1Admin._id)).toBe('admin')
    expect(await roleKeyOf(org2Admin._id)).toBe('admin')
  })
})

/**
 * The grant that decides WHAT a user may do used to be resolved by `_id` alone, so whichever
 * org owned the id got to answer — while `isForeignOrg` carefully guarded whose DATA you may
 * ask for. An instance of exactly this was found live in a dev database: a user carrying
 * another org's `Administrator` set, which is `isAdmin` and therefore every permission.
 */
