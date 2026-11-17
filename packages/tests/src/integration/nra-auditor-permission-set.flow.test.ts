import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import { setupTestDB, teardownTestDB } from '../setup'
import { createTestOrg, createTestUser } from '../helpers/factories'
import { tokenize } from 'services/biz/auth.service'
import { seedDefaultPermissionSets, ROLE_TO_PERMISSION_SET } from 'services/biz/permission-set.seed'
import { migrateToPermissionSets } from 'services/biz/permission-set.service'
import { DEFAULT_ROLE_PERMISSIONS } from 'config/constants'
import { PermissionSet, Role, User } from 'db/models'
import { can, grantOfRole } from 'config/access'
import type { Types } from 'mongoose'

/**
 * `nra_auditor` is the tax inspector's profile: it reads and exports and changes nothing. A set
 * outranks the role's defaults at sign-in, and both `seed-user.ts` and the permission-set migration
 * handed this role the Accountant set, so the account came out able to write invoices, stock and
 * journal entries, and unable to open the audit log the profile exists for.
 */

let orgId: Types.ObjectId

beforeAll(async () => {
  await setupTestDB()
  const org = await createTestOrg({ slug: 'nra-auditor-org' } as any)
  orgId = org._id as Types.ObjectId
  await seedDefaultPermissionSets(String(orgId))
}, 120_000)

afterAll(async () => {
  await teardownTestDB()
}, 60_000)

describe('the nra_auditor permission set', () => {
  it('is seeded with exactly the role\'s read-only defaults', async () => {
    const set = await PermissionSet.findOne({ orgId, name: ROLE_TO_PERMISSION_SET.nra_auditor }).lean().exec()
    expect(set).not.toBeNull()
    expect([...set!.permissions].sort()).toEqual([...DEFAULT_ROLE_PERMISSIONS.nra_auditor].sort())
    expect(set!.isAdmin).toBe(false)
    expect(set!.isDefault).toBe(false)
  })

  it('leaves a migrated auditor with no write and with the audit log', async () => {
    const auditor = await createTestUser(orgId, {
      email: 'auditor@nra.test',
      username: 'auditor',
      role: 'nra_auditor',
      permissionSetIds: [],
    } as any)

    await migrateToPermissionSets(String(orgId))

    const migrated = await User.findById(auditor._id).exec()
    expect(migrated!.permissionSetIds).toHaveLength(1)
    // FR-27 P3-5: the token names the auditor's role, and that role decides: it reads, exports reports and reads the
    // audit log, and works on nothing.
    const claims = await tokenize(migrated!)
    expect('permissions' in claims).toBe(false)
    const grant = grantOfRole(await Role.findById(claims.rid).lean()) as { caps: Set<string> }
    expect(can(grant, ['audit-log.view', 'reports.export', 'supto.view'])).toBe(true)
    expect([...grant.caps].filter(c => /\.(create|edit|delete|post|sell|approve)$/.test(c))).toEqual([])
  })
})
