import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { register, login } from 'services/biz/auth.service'
import { User } from 'db/models'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'

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
      orgName: 'Admin Perms Org', orgSlug: 'admin-perms-org',
      email: 'admin@perms.com', username: 'adminperms', password: 'secure123',
      firstName: 'Admin', lastName: 'Perms',
    })

    expect(user.role).toBe('admin')
    expect(user.permissions).toContain('admin.users')
    expect(user.permissions).toContain('admin.settings')
    for (const perm of [
      'accounting.read', 'accounting.write', 'accounting.post',
      'invoicing.read', 'invoicing.write', 'invoicing.send',
      'warehouse.read', 'warehouse.write', 'warehouse.adjust',
      'payroll.read', 'payroll.write', 'payroll.approve',
      'hr.read', 'hr.write', 'hr.approve_leave',
      'crm.read', 'crm.write',
      'erp.read', 'erp.write',
    ]) {
      expect(user.permissions).toContain(perm)
    }
    expect(user.permissions.slice().sort()).toEqual(DEFAULT_ROLE_PERMISSIONS.admin.slice().sort())
    expect(user.permissions.length).toBe(DEFAULT_ROLE_PERMISSIONS.admin.length)
  })

  it('should grant accountant only accounting + invoicing permissions', async () => {
    const org = await createTestOrg({ name: 'Accountant Org', slug: 'accountant-org' })
    const user = await createTestUser(org._id, {
      role: 'accountant',
      email: 'acct@test.com',
      username: 'acctuser',
    })

    expect(user.role).toBe('accountant')
    expect(user.permissions.slice().sort()).toEqual(DEFAULT_ROLE_PERMISSIONS.accountant.slice().sort())
    expect(user.permissions.length).toBe(DEFAULT_ROLE_PERMISSIONS.accountant.length)

    // Must not have admin, warehouse, hr, payroll, crm, erp permissions
    expect(user.permissions).not.toContain('admin.users')
    expect(user.permissions).not.toContain('admin.settings')
    expect(user.permissions).not.toContain('warehouse.read')
    expect(user.permissions).not.toContain('hr.read')
    expect(user.permissions).not.toContain('payroll.read')
    expect(user.permissions).not.toContain('crm.read')
    expect(user.permissions).not.toContain('erp.read')
  })

  it('should grant HR manager only hr + payroll permissions', async () => {
    const org = await createTestOrg({ name: 'HR Org', slug: 'hr-org' })
    const user = await createTestUser(org._id, {
      role: 'hr_manager',
      email: 'hr@test.com',
      username: 'hruser',
    })

    expect(user.role).toBe('hr_manager')
    expect(user.permissions.slice().sort()).toEqual(DEFAULT_ROLE_PERMISSIONS.hr_manager.slice().sort())
    expect(user.permissions.length).toBe(DEFAULT_ROLE_PERMISSIONS.hr_manager.length)

    // Must include hr and payroll full access
    for (const perm of ['hr.read', 'hr.write', 'hr.approve_leave', 'payroll.read', 'payroll.write', 'payroll.approve']) {
      expect(user.permissions).toContain(perm)
    }

    // Must not have accounting, invoicing, warehouse, crm, erp, admin
    expect(user.permissions).not.toContain('accounting.read')
    expect(user.permissions).not.toContain('invoicing.read')
    expect(user.permissions).not.toContain('warehouse.read')
    expect(user.permissions).not.toContain('admin.users')
  })

  it('should grant warehouse manager only warehouse permissions', async () => {
    const org = await createTestOrg({ name: 'WH Org', slug: 'wh-org' })
    const user = await createTestUser(org._id, {
      role: 'warehouse_manager',
      email: 'wh@test.com',
      username: 'whuser',
    })

    expect(user.role).toBe('warehouse_manager')
    expect(user.permissions.slice().sort()).toEqual(DEFAULT_ROLE_PERMISSIONS.warehouse_manager.slice().sort())
    expect(user.permissions.length).toBe(DEFAULT_ROLE_PERMISSIONS.warehouse_manager.length)

    for (const perm of ['warehouse.read', 'warehouse.write', 'warehouse.adjust']) {
      expect(user.permissions).toContain(perm)
    }

    // Must not have any other module permissions
    expect(user.permissions).not.toContain('accounting.read')
    expect(user.permissions).not.toContain('invoicing.read')
    expect(user.permissions).not.toContain('hr.read')
    expect(user.permissions).not.toContain('payroll.read')
    expect(user.permissions).not.toContain('crm.read')
    expect(user.permissions).not.toContain('admin.users')
  })

  it('should grant sales user only crm + invoicing read/write permissions', async () => {
    const org = await createTestOrg({ name: 'Sales Org', slug: 'sales-org' })
    const user = await createTestUser(org._id, {
      role: 'sales',
      email: 'sales@test.com',
      username: 'salesuser',
    })

    expect(user.role).toBe('sales')
    expect(user.permissions.slice().sort()).toEqual(DEFAULT_ROLE_PERMISSIONS.sales.slice().sort())
    expect(user.permissions.length).toBe(DEFAULT_ROLE_PERMISSIONS.sales.length)

    for (const perm of ['crm.read', 'crm.write', 'invoicing.read', 'invoicing.write']) {
      expect(user.permissions).toContain(perm)
    }

    // Must not have invoicing.send, accounting, warehouse, hr, payroll, erp, admin
    expect(user.permissions).not.toContain('invoicing.send')
    expect(user.permissions).not.toContain('accounting.read')
    expect(user.permissions).not.toContain('warehouse.read')
    expect(user.permissions).not.toContain('hr.read')
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

    // All permissions should be .read only
    for (const perm of user.permissions) {
      expect(perm).toMatch(/\.read$/)
    }

    // Must have read access across all business modules
    for (const perm of ['accounting.read', 'invoicing.read', 'warehouse.read', 'payroll.read', 'hr.read', 'crm.read', 'erp.read']) {
      expect(user.permissions).toContain(perm)
    }

    // Must not have any write, post, approve, send, adjust, or admin permissions
    expect(user.permissions).not.toContain('admin.users')
    expect(user.permissions).not.toContain('accounting.write')
    expect(user.permissions).not.toContain('invoicing.write')
  })

  it('should prevent user from org1 accessing org2 data via login', async () => {
    const { user: org1Admin } = await register({
      orgName: 'Perm Org One', orgSlug: 'perm-org-one',
      email: 'admin@permone.com', username: 'permadmin1', password: 'secure123',
      firstName: 'Admin', lastName: 'One',
    })

    await register({
      orgName: 'Perm Org Two', orgSlug: 'perm-org-two',
      email: 'admin@permtwo.com', username: 'permadmin2', password: 'secure123',
      firstName: 'Admin', lastName: 'Two',
    })

    // org1 admin cannot login to org2
    await expect(
      login({ username: 'permadmin1', password: 'secure123', orgSlug: 'perm-org-two' }),
    ).rejects.toThrow('Invalid credentials')

    // org1 admin can only login to org1
    const result = await login({
      username: 'permadmin1', password: 'secure123', orgSlug: 'perm-org-one',
    })
    expect(result.user.orgId).toBe(String(org1Admin.orgId))
    expect(result.org.slug).toBe('perm-org-one')

    // Permissions returned on login match the stored admin permissions
    expect(result.user.permissions.slice().sort()).toEqual(DEFAULT_ROLE_PERMISSIONS.admin.slice().sort())
    expect(result.user.permissions.length).toBe(DEFAULT_ROLE_PERMISSIONS.admin.length)
  })

  it('should reject login for disabled user', async () => {
    const org = await createTestOrg({ name: 'Disabled Perm Org', slug: 'disabled-perm-org' })
    const user = await createTestUser(org._id, {
      role: 'accountant',
      email: 'disabled-acct@test.com',
      username: 'disabledacct',
      password: await Bun.password.hash('secure123'),
    })

    // Verify permissions were assigned correctly before disabling
    expect(user.permissions.slice().sort()).toEqual(DEFAULT_ROLE_PERMISSIONS.accountant.slice().sort())
    expect(user.isActive).toBe(true)

    // Disable the user
    await User.findByIdAndUpdate(user._id, { isActive: false })

    // Login should fail with Account is disabled
    await expect(
      login({ username: 'disabledacct', password: 'secure123', orgSlug: 'disabled-perm-org' }),
    ).rejects.toThrow('Account is disabled')
  })
})
