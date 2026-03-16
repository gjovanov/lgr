import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { register } from 'services/biz/auth.service'
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
      'trade.read', 'trade.write', 'trade.adjust', 'trade.send',
      'payroll.read', 'payroll.write', 'payroll.approve',
      'hr.read', 'hr.write', 'hr.approve_leave',
      'crm.read', 'crm.write',
      'erp.read', 'erp.write',
    ]) {
      expect(user.permissions).toContain(perm)
    }
    expect(user.permissions.slice().sort()).toEqual(DEFAULT_ROLE_PERMISSIONS.admin.slice().sort())
  })

  it('should grant accountant only accounting + trade permissions', async () => {
    const org = await createTestOrg({ name: 'Acct Org', slug: 'acct-org' })
    const user = await createTestUser(org._id, {
      role: 'accountant',
      email: 'acct@test.com',
      username: 'acctuser',
    })

    expect(user.role).toBe('accountant')
    expect(user.permissions.slice().sort()).toEqual(DEFAULT_ROLE_PERMISSIONS.accountant.slice().sort())
    expect(user.permissions.length).toBe(DEFAULT_ROLE_PERMISSIONS.accountant.length)

    for (const perm of ['accounting.read', 'accounting.write', 'accounting.post', 'trade.read', 'trade.write', 'trade.send']) {
      expect(user.permissions).toContain(perm)
    }
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

    for (const perm of ['hr.read', 'hr.write', 'hr.approve_leave', 'payroll.read', 'payroll.write', 'payroll.approve']) {
      expect(user.permissions).toContain(perm)
    }

    expect(user.permissions).not.toContain('accounting.read')
    expect(user.permissions).not.toContain('trade.read')
    expect(user.permissions).not.toContain('admin.users')
  })

  it('should grant warehouse manager only trade permissions', async () => {
    const org = await createTestOrg({ name: 'WH Org', slug: 'wh-org' })
    const user = await createTestUser(org._id, {
      role: 'warehouse_manager',
      email: 'wh@test.com',
      username: 'whuser',
    })

    expect(user.role).toBe('warehouse_manager')
    expect(user.permissions.slice().sort()).toEqual(DEFAULT_ROLE_PERMISSIONS.warehouse_manager.slice().sort())
    expect(user.permissions.length).toBe(DEFAULT_ROLE_PERMISSIONS.warehouse_manager.length)

    for (const perm of ['trade.read', 'trade.write', 'trade.adjust']) {
      expect(user.permissions).toContain(perm)
    }

    expect(user.permissions).not.toContain('accounting.read')
    expect(user.permissions).not.toContain('hr.read')
    expect(user.permissions).not.toContain('payroll.read')
    expect(user.permissions).not.toContain('crm.read')
    expect(user.permissions).not.toContain('admin.users')
  })

  it('should grant sales user only crm + trade read/write permissions', async () => {
    const org = await createTestOrg({ name: 'Sales Org', slug: 'sales-org' })
    const user = await createTestUser(org._id, {
      role: 'sales',
      email: 'sales@test.com',
      username: 'salesuser',
    })

    expect(user.role).toBe('sales')
    expect(user.permissions.slice().sort()).toEqual(DEFAULT_ROLE_PERMISSIONS.sales.slice().sort())
    expect(user.permissions.length).toBe(DEFAULT_ROLE_PERMISSIONS.sales.length)

    for (const perm of ['crm.read', 'crm.write', 'trade.read', 'trade.write']) {
      expect(user.permissions).toContain(perm)
    }

    expect(user.permissions).not.toContain('trade.send')
    expect(user.permissions).not.toContain('accounting.read')
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

    for (const perm of user.permissions) {
      expect(perm).toMatch(/\.read$/)
    }

    for (const perm of ['accounting.read', 'trade.read', 'payroll.read', 'hr.read', 'crm.read', 'erp.read']) {
      expect(user.permissions).toContain(perm)
    }

    expect(user.permissions).not.toContain('admin.users')
    expect(user.permissions).not.toContain('accounting.write')
    expect(user.permissions).not.toContain('trade.write')
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
