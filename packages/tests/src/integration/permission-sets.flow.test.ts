import { describe, it, expect, beforeAll, afterAll, afterEach } from 'bun:test'
import { setupTestDB, teardownTestDB, clearCollections } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { PermissionSet, User } from 'db/models'
import { seedDefaultPermissionSets } from 'services/biz/permission-set.seed'
import {
  listPermissionSets,
  getPermissionSet,
  createPermissionSet,
  updatePermissionSet,
  deletePermissionSet,
  computeEffectivePermissions,
  migrateToPermissionSets,
} from 'services/biz/permission-set.service'
import { PERMISSIONS } from 'config/constants'

beforeAll(async () => {
  await setupTestDB()
})

afterAll(async () => {
  await teardownTestDB()
})

afterEach(async () => {
  await clearCollections()
})

describe('Permission Sets Flow', () => {
  it('should seed 9 default permission sets for an org', async () => {
    const org = await createTestOrg()
    await seedDefaultPermissionSets(String(org._id))

    const sets = await PermissionSet.find({ orgId: org._id }).lean().exec()
    expect(sets.length).toBe(9)

    const names = sets.map(s => s.name).sort()
    expect(names).toContain('Administrator')
    expect(names).toContain('Manager')
    expect(names).toContain('Sales Representative')
    expect(names).toContain('Accountant')
    expect(names).toContain('HR Officer')
    expect(names).toContain('Warehouse Manager')
    expect(names).toContain('Project Member')
    expect(names).toContain('Support Agent')
    expect(names).toContain('Member (Read Only)')

    // All should be system sets
    for (const s of sets) {
      expect(s.isSystem).toBe(true)
    }
  })

  it('should have Administrator set with all permissions and isAdmin=true', async () => {
    const org = await createTestOrg()
    await seedDefaultPermissionSets(String(org._id))

    const adminSet = await PermissionSet.findOne({ orgId: org._id, name: 'Administrator' }).lean().exec()
    expect(adminSet).toBeDefined()
    expect(adminSet!.isAdmin).toBe(true)
    expect(adminSet!.permissions.length).toBe(PERMISSIONS.length)
    for (const perm of PERMISSIONS) {
      expect(adminSet!.permissions).toContain(perm)
    }
  })

  it('should have Sales Representative set with ownRecordsOnly.sales=true', async () => {
    const org = await createTestOrg()
    await seedDefaultPermissionSets(String(org._id))

    const salesSet = await PermissionSet.findOne({ orgId: org._id, name: 'Sales Representative' }).lean().exec()
    expect(salesSet).toBeDefined()
    expect(salesSet!.ownRecordsOnly.sales).toBe(true)
    expect(salesSet!.ownRecordsOnly.crm).toBe(true)
    expect(salesSet!.isAdmin).toBe(false)
  })

  it('should have Member (Read Only) set as isDefault=true', async () => {
    const org = await createTestOrg()
    await seedDefaultPermissionSets(String(org._id))

    const memberSet = await PermissionSet.findOne({ orgId: org._id, name: 'Member (Read Only)' }).lean().exec()
    expect(memberSet).toBeDefined()
    expect(memberSet!.isDefault).toBe(true)
    expect(memberSet!.isAdmin).toBe(false)
  })

  it('should create a custom permission set', async () => {
    const org = await createTestOrg()

    const created = await createPermissionSet(String(org._id), {
      name: 'Custom Set',
      description: 'A custom permission set for testing',
      permissions: ['accounting.read', 'trade.read', 'trade.write'],
      ownRecordsOnly: { sales: true },
      isDefault: false,
      isAdmin: false,
    })

    expect(created).toBeDefined()
    expect(created.name).toBe('Custom Set')
    expect(created.permissions).toContain('accounting.read')
    expect(created.permissions).toContain('trade.read')
    expect(created.permissions).toContain('trade.write')
    expect(created.isSystem).toBe(false)
  })

  it('should assign permission set to user', async () => {
    const org = await createTestOrg()
    await seedDefaultPermissionSets(String(org._id))

    const user = await createTestUser(org._id, { role: 'member' })
    const salesSet = await PermissionSet.findOne({ orgId: org._id, name: 'Sales Representative' }).lean().exec()

    await User.findByIdAndUpdate(user._id, {
      permissionSetIds: [salesSet!._id],
    }).exec()

    const updated = await User.findById(user._id).lean().exec()
    expect(updated!.permissionSetIds!.length).toBe(1)
    expect(String(updated!.permissionSetIds![0])).toBe(String(salesSet!._id))
  })

  it('should compute effective permissions as union of 2 sets', async () => {
    const org = await createTestOrg()
    await seedDefaultPermissionSets(String(org._id))

    const user = await createTestUser(org._id, { role: 'member' })

    const salesSet = await PermissionSet.findOne({ orgId: org._id, name: 'Sales Representative' }).lean().exec()
    const accountantSet = await PermissionSet.findOne({ orgId: org._id, name: 'Accountant' }).lean().exec()

    await User.findByIdAndUpdate(user._id, {
      permissionSetIds: [salesSet!._id, accountantSet!._id],
    }).exec()

    const result = await computeEffectivePermissions(String(user._id))

    // Should contain permissions from both sets
    expect(result.permissions).toContain('sales.read')
    expect(result.permissions).toContain('sales.write')
    expect(result.permissions).toContain('crm.read')
    expect(result.permissions).toContain('accounting.read')
    expect(result.permissions).toContain('accounting.write')
    expect(result.permissions).toContain('accounting.post')
    expect(result.isAdmin).toBe(false)
  })

  it('should resolve ownRecordsOnly conflict: true + false = false wins', async () => {
    const org = await createTestOrg()

    // Create one set with sales ownRecordsOnly = true
    const set1 = await createPermissionSet(String(org._id), {
      name: 'Set A',
      permissions: ['sales.read', 'sales.write'],
      ownRecordsOnly: { sales: true },
    })

    // Create another set with sales ownRecordsOnly = false (all records)
    const set2 = await createPermissionSet(String(org._id), {
      name: 'Set B',
      permissions: ['sales.read'],
      ownRecordsOnly: { sales: false },
    })

    const user = await createTestUser(org._id, { role: 'member' })
    await User.findByIdAndUpdate(user._id, {
      permissionSetIds: [set1._id, set2._id],
    }).exec()

    const result = await computeEffectivePermissions(String(user._id))

    // false wins: user should NOT have sales in ownRecordsModules
    expect(result.ownRecordsModules).not.toContain('sales')
  })

  it('should migrate users from old roles to correct permission sets', async () => {
    const org = await createTestOrg()
    await seedDefaultPermissionSets(String(org._id))

    // Create users with various roles but no permissionSetIds
    const adminUser = await createTestUser(org._id, { role: 'admin', operatorCode: '0001' })
    const salesUser = await createTestUser(org._id, { role: 'sales', operatorCode: '0002' })
    const memberUser = await createTestUser(org._id, { role: 'member', operatorCode: '0003' })

    const result = await migrateToPermissionSets(String(org._id))
    expect(result.migrated).toBe(3)

    const updatedAdmin = await User.findById(adminUser._id).lean().exec()
    const updatedSales = await User.findById(salesUser._id).lean().exec()
    const updatedMember = await User.findById(memberUser._id).lean().exec()

    expect(updatedAdmin!.permissionSetIds!.length).toBe(1)
    expect(updatedSales!.permissionSetIds!.length).toBe(1)
    expect(updatedMember!.permissionSetIds!.length).toBe(1)

    // Verify correct mapping
    const adminSet = await PermissionSet.findById(updatedAdmin!.permissionSetIds![0]).lean().exec()
    expect(adminSet!.name).toBe('Administrator')

    const salesSet = await PermissionSet.findById(updatedSales!.permissionSetIds![0]).lean().exec()
    expect(salesSet!.name).toBe('Sales Representative')

    const memberSet = await PermissionSet.findById(updatedMember!.permissionSetIds![0]).lean().exec()
    expect(memberSet!.name).toBe('Member (Read Only)')
  })

  it('should not delete a system permission set', async () => {
    const org = await createTestOrg()
    await seedDefaultPermissionSets(String(org._id))

    const adminSet = await PermissionSet.findOne({ orgId: org._id, name: 'Administrator' }).lean().exec()
    const result = await deletePermissionSet(String(adminSet!._id))

    expect(result.success).toBe(false)
    expect(result.reason).toBe('System permission sets cannot be deleted')

    // Verify it still exists
    const stillExists = await PermissionSet.findById(adminSet!._id).lean().exec()
    expect(stillExists).toBeDefined()
  })

  it('should not delete a permission set in use by users', async () => {
    const org = await createTestOrg()

    const customSet = await createPermissionSet(String(org._id), {
      name: 'In Use Set',
      permissions: ['trade.read'],
    })

    const user = await createTestUser(org._id, { role: 'member' })
    await User.findByIdAndUpdate(user._id, {
      permissionSetIds: [customSet._id],
    }).exec()

    const result = await deletePermissionSet(String(customSet._id))
    expect(result.success).toBe(false)
    expect(result.reason).toContain('users are still assigned')
  })

  it('should seed idempotently (run twice, still 9 sets)', async () => {
    const org = await createTestOrg()

    await seedDefaultPermissionSets(String(org._id))
    const firstCount = await PermissionSet.countDocuments({ orgId: org._id }).exec()
    expect(firstCount).toBe(9)

    // Run seed again
    await seedDefaultPermissionSets(String(org._id))
    const secondCount = await PermissionSet.countDocuments({ orgId: org._id }).exec()
    expect(secondCount).toBe(9)
  })
})
