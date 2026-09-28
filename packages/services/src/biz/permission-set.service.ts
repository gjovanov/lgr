import { PermissionSet, User, type IPermissionSet } from 'db/models'
import { PERMISSIONS } from 'config/constants'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'
import { ROLE_TO_PERMISSION_SET } from './permission-set.seed.js'

export interface PermissionSetInput {
  name: string
  description?: string
  permissions: string[]
  ownRecordsOnly?: Record<string, boolean>
  isDefault?: boolean
  isAdmin?: boolean
}

/**
 * List all permission sets for an org.
 */
export async function listPermissionSets(orgId: string): Promise<{ permissionSets: IPermissionSet[]; total: number }> {
  const items = await PermissionSet.find({ orgId }).sort({ isSystem: -1, name: 1 }).lean().exec()
  return { permissionSets: items as IPermissionSet[], total: items.length }
}

/**
 * Get a single permission set by ID, within one org.
 *
 * ⚠ `orgId` is required on every by-id operation in this file. `isForeignOrg` checks that the
 * CALLER's token matches the `:orgId` in the path; it cannot know that the `:id` in the path
 * belongs to a different org entirely. Without the filter, an admin passing their own orgId
 * and another org's set id could read, edit and delete it.
 */
export async function getPermissionSet(id: string, orgId: string): Promise<IPermissionSet | null> {
  return PermissionSet.findOne({ _id: id, orgId }).lean().exec() as Promise<IPermissionSet | null>
}

/**
 * Create a new permission set.
 */
export async function createPermissionSet(orgId: string, input: PermissionSetInput): Promise<IPermissionSet> {
  const created = await PermissionSet.create({
    orgId,
    name: input.name,
    description: input.description || '',
    permissions: input.permissions,
    ownRecordsOnly: input.ownRecordsOnly || {},
    isDefault: input.isDefault || false,
    isAdmin: input.isAdmin || false,
    isSystem: false,
  })
  return created.toJSON() as unknown as IPermissionSet
}

/**
 * Update an existing permission set.
 */
export async function updatePermissionSet(id: string, orgId: string, input: Partial<PermissionSetInput>): Promise<IPermissionSet | null> {
  const existing = await PermissionSet.findOne({ _id: id, orgId }).exec()
  if (!existing) return null

  // Cannot modify isSystem flag
  const updateData: Record<string, unknown> = {}
  if (input.name !== undefined) updateData.name = input.name
  if (input.description !== undefined) updateData.description = input.description
  if (input.permissions !== undefined) {
    // Cannot remove admin permissions from an isAdmin set
    if (existing.isAdmin) {
      const adminPerms = ['admin.users', 'admin.settings', 'admin.audit']
      const newPerms = [...new Set([...input.permissions, ...adminPerms])]
      updateData.permissions = newPerms
    } else {
      updateData.permissions = input.permissions
    }
  }
  if (input.ownRecordsOnly !== undefined) updateData.ownRecordsOnly = input.ownRecordsOnly
  if (input.isDefault !== undefined) updateData.isDefault = input.isDefault
  if (input.isAdmin !== undefined) updateData.isAdmin = input.isAdmin

  const updated = await PermissionSet.findOneAndUpdate({ _id: id, orgId }, updateData, { new: true }).lean().exec()
  return updated as IPermissionSet | null
}

/**
 * Delete a permission set. Cannot delete system sets or sets in use.
 */
export async function deletePermissionSet(id: string, orgId: string): Promise<{ success: boolean; reason?: string }> {
  const existing = await PermissionSet.findOne({ _id: id, orgId }).exec()
  if (!existing) return { success: false, reason: 'Not found' }

  if (existing.isSystem) {
    return { success: false, reason: 'System permission sets cannot be deleted' }
  }

  // Deliberately NOT scoped to the org: a reference from anywhere is still a reference, and
  // deleting the row out from under it is how a user ends up with an unresolvable grant.
  const usersWithSet = await User.countDocuments({ permissionSetIds: id }).exec()
  if (usersWithSet > 0) {
    return { success: false, reason: 'Cannot delete — users are still assigned' }
  }

  await PermissionSet.deleteOne({ _id: id, orgId }).exec()
  return { success: true }
}

/**
 * Compute effective permissions for a user (union of all their assigned permission sets).
 */
export async function computeEffectivePermissions(userId: string, orgId: string): Promise<{
  permissions: string[]
  ownRecordsModules: string[]
  isAdmin: boolean
}> {
  // Both lookups scoped: this endpoint took a bare userId, so an admin of one org could read
  // the effective permissions of a user in another.
  const user = await User.findOne({ _id: userId, orgId }).exec()
  if (!user) throw new Error('User not found')

  const setIds = user.permissionSetIds || []
  if (setIds.length === 0) {
    // Fallback to legacy permissions on user
    return {
      permissions: user.permissions || [],
      ownRecordsModules: [],
      isAdmin: user.role === 'admin',
    }
  }

  // Same rule as `tokenize`: a set belonging to another org grants nothing here either, so
  // this preview matches the permissions the user will actually be issued.
  const sets = await PermissionSet.find({ _id: { $in: setIds }, orgId }).lean().exec()
  if (!sets.length) {
    return { permissions: user.permissions || [], ownRecordsModules: [], isAdmin: user.role === 'admin' }
  }

  let isAdmin = false
  const permSet = new Set<string>()
  // For ownRecordsOnly: track per-module. false (all records) wins over true (own only).
  const ownRecordsMap = new Map<string, boolean>()

  for (const ps of sets) {
    if (ps.isAdmin) isAdmin = true
    for (const p of ps.permissions) {
      permSet.add(p)
    }
    if (ps.ownRecordsOnly) {
      for (const [mod, val] of Object.entries(ps.ownRecordsOnly)) {
        if (val === true) {
          // Only set to true if not already set to false
          if (!ownRecordsMap.has(mod)) {
            ownRecordsMap.set(mod, true)
          }
        } else if (val === false) {
          // false wins (all records access)
          ownRecordsMap.set(mod, false)
        }
      }
    }
  }

  // Collect modules where ownRecordsOnly is still true
  const ownRecordsModules: string[] = []
  for (const [mod, val] of ownRecordsMap) {
    if (val) ownRecordsModules.push(mod)
  }

  return {
    permissions: isAdmin ? [...PERMISSIONS] : [...permSet],
    ownRecordsModules,
    isAdmin,
  }
}

/**
 * Migrate users from old role-based permissions to permission sets.
 */
export async function migrateToPermissionSets(orgId: string): Promise<{ migrated: number }> {
  const users = await User.find({ orgId }).exec()
  const sets = await PermissionSet.find({ orgId }).lean().exec()

  const nameToId = new Map<string, string>()
  for (const s of sets) {
    nameToId.set(s.name, String(s._id))
  }

  let migrated = 0
  for (const user of users) {
    if (user.permissionSetIds && user.permissionSetIds.length > 0) continue

    const setName = ROLE_TO_PERMISSION_SET[user.role] || 'Member (Read Only)'
    const setId = nameToId.get(setName)
    if (!setId) {
      logger.warn({ orgId, userId: String(user._id), role: user.role }, 'No matching permission set for role')
      continue
    }

    await User.findByIdAndUpdate(user._id, {
      permissionSetIds: [setId],
    }).exec()
    migrated++
  }

  logger.info({ orgId, migrated }, 'Migrated users to permission sets')
  return { migrated }
}

/**
 * Get user count for each permission set in an org.
 */
export async function getPermissionSetUserCounts(orgId: string): Promise<Record<string, number>> {
  const sets = await PermissionSet.find({ orgId }).lean().exec()
  const counts: Record<string, number> = {}
  for (const s of sets) {
    const id = String(s._id)
    counts[id] = await User.countDocuments({ orgId, permissionSetIds: s._id }).exec()
  }
  return counts
}
