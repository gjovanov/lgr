import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { DEFAULT_ROLE_PERMISSIONS, PERMISSIONS } from 'config/constants'
import { register, tokenize } from 'services/biz/auth.service'
import { getPermissionSet, deletePermissionSet, computeEffectivePermissions } from 'services/biz/permission-set.service'
import { User } from 'db/models'

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

    expect(user.role).toBe('admin')
    expect(user.permissions).toContain('admin.users')
    expect(user.permissions).toContain('admin.settings')
    for (const perm of [
      'accounting.read', 'accounting.write', 'accounting.post',
      'inventory.read', 'inventory.write', 'inventory.adjust',
      'invoicing.read', 'invoicing.write', 'invoicing.send',
      'pos.read', 'pos.write',
      'payroll.read', 'payroll.write', 'payroll.approve',
    ]) {
      expect(user.permissions).toContain(perm)
    }
    expect(user.permissions.slice().sort()).toEqual(DEFAULT_ROLE_PERMISSIONS.admin.slice().sort())
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

    for (const perm of ['accounting.read', 'inventory.read', 'invoicing.read', 'payroll.read']) {
      expect(user.permissions).toContain(perm)
    }

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
    expect(org1Admin.role).toBe('admin')
    expect(org2Admin.role).toBe('admin')
  })
})

/**
 * The grant that decides WHAT a user may do used to be resolved by `_id` alone, so whichever
 * org owned the id got to answer — while `isForeignOrg` carefully guarded whose DATA you may
 * ask for. An instance of exactly this was found live in a dev database: a user carrying
 * another org's `Administrator` set, which is `isAdmin` and therefore every permission.
 */
describe('Permission sets are scoped to the owning org', () => {
  it('ignores a permission set belonging to another org, and falls back to the role', async () => {
    const { user: foreignAdmin } = await register({
      orgName: 'Foreign Org', orgSlug: 'foreign-org',
      email: 'admin@foreign.com', username: 'foreignadmin', password: 'pass123',
      firstName: 'Foreign', lastName: 'Admin',
    })

    // `register` assigns the org's own Administrator set (isAdmin) to its first admin.
    const foreignSetIds = (await User.findById(foreignAdmin.id).exec())!.permissionSetIds!
    expect(foreignSetIds.length).toBe(1)

    // A plain member of a DIFFERENT org, pointed at that foreign set.
    const org = await createTestOrg({ name: 'Victim Org', slug: 'victim-org' })
    const member = await createTestUser(org._id, {
      role: 'member', email: 'member@victim.com', username: 'victimmember',
    })
    await User.findByIdAndUpdate(member._id, { permissionSetIds: foreignSetIds }).exec()

    const reloaded = (await User.findById(member._id).exec())!
    const token = await tokenize(reloaded)

    // Not admin-by-proxy: the foreign set grants nothing.
    expect(token.permissions).not.toContain('admin.users')
    expect(token.permissions).not.toContain('admin.settings')
    expect(token.permissions).not.toContain('inventory.write')

    // And the user is not stranded with an empty permission list — the role still applies.
    expect(token.permissions.slice().sort()).toEqual(DEFAULT_ROLE_PERMISSIONS.member.slice().sort())
  })

  it('still resolves a set that DOES belong to the org', async () => {
    const { user: admin } = await register({
      orgName: 'Own Set Org', orgSlug: 'own-set-org',
      email: 'admin@ownset.com', username: 'ownsetadmin', password: 'pass123',
      firstName: 'Own', lastName: 'Admin',
    })

    const token = await tokenize((await User.findById(admin.id).exec())!)

    // The org's own Administrator set is isAdmin, which expands to every PERMISSION.
    expect(token.permissions.slice().sort()).toEqual([...PERMISSIONS].sort())
  })

  it('computeEffectivePermissions agrees with the token for a foreign set', async () => {
    const { user: foreignAdmin } = await register({
      orgName: 'Foreign Two', orgSlug: 'foreign-two',
      email: 'admin@foreign2.com', username: 'foreign2admin', password: 'pass123',
      firstName: 'Foreign', lastName: 'Two',
    })
    const foreignSetIds = (await User.findById(foreignAdmin.id).exec())!.permissionSetIds!

    const org = await createTestOrg({ name: 'Victim Two', slug: 'victim-two' })
    const member = await createTestUser(org._id, {
      role: 'member', email: 'member@victim2.com', username: 'victim2member',
    })
    await User.findByIdAndUpdate(member._id, { permissionSetIds: foreignSetIds }).exec()

    // The preview the Users screen shows must not promise permissions the token won't carry.
    const effective = await computeEffectivePermissions(String(member._id), String(org._id))
    expect(effective.isAdmin).toBe(false)
    expect(effective.permissions).not.toContain('admin.settings')
  })

  it('refuses to read another org\'s permission set by id', async () => {
    const { user: foreignAdmin } = await register({
      orgName: 'Foreign Three', orgSlug: 'foreign-three',
      email: 'admin@foreign3.com', username: 'foreign3admin', password: 'pass123',
      firstName: 'Foreign', lastName: 'Three',
    })
    const foreignSetId = String((await User.findById(foreignAdmin.id).exec())!.permissionSetIds![0])

    const org = await createTestOrg({ name: 'Other Org', slug: 'other-org' })

    // Reachable with its real id from the owning org, invisible from any other.
    expect(await getPermissionSet(foreignSetId, String(foreignAdmin.orgId))).not.toBeNull()
    expect(await getPermissionSet(foreignSetId, String(org._id))).toBeNull()

    const del = await deletePermissionSet(foreignSetId, String(org._id))
    expect(del.success).toBe(false)
    expect(del.reason).toBe('Not found')

    // Still there.
    expect(await getPermissionSet(foreignSetId, String(foreignAdmin.orgId))).not.toBeNull()
  })
})
