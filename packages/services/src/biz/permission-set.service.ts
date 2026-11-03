import { Identity, PermissionSet, User, type IPermissionSet } from 'db/models'
import { forgetIdentity } from './identity/session.service.js'
import { AREAS, DEFAULT_ROLE_AREAS, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, mergeAreas, type Area, type Role } from 'config/constants'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'
import { ROLE_TO_PERMISSION_SET } from './permission-set.seed.js'

export interface PermissionSetInput {
  name: string
  description?: string
  permissions: string[]
  ownRecordsOnly?: Record<string, boolean>
  /** FR-26: `null`/absent = every area (stored without the key), a list = only those, `[]` = none. */
  areas?: string[] | null
  isDefault?: boolean
  isAdmin?: boolean
}

/** A set's areas as stored: only known ones, deduplicated, in `AREAS` order; `undefined` = every area. */
export function normaliseAreas(areas: readonly string[] | null | undefined): Area[] | undefined {
  if (!Array.isArray(areas)) return undefined
  const unknown = areas.filter(a => !(AREAS as readonly string[]).includes(a))
  if (unknown.length) throw new Error(`Unknown area: ${unknown.join(', ')}`)
  return AREAS.filter(a => areas.includes(a))
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
  const areas = normaliseAreas(input.areas)
  const created = await PermissionSet.create({
    orgId,
    name: input.name,
    description: input.description || '',
    permissions: input.permissions,
    ownRecordsOnly: input.ownRecordsOnly || {},
    ...(areas ? { areas } : {}),
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
  const unset: Record<string, ''> = {}
  if (input.areas !== undefined) {
    const areas = normaliseAreas(input.areas)
    if (areas) updateData.areas = areas
    else unset.areas = ''
  }
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

  const update = Object.keys(unset).length ? { ...updateData, $unset: unset } : updateData
  const updated = await PermissionSet.findOneAndUpdate({ _id: id, orgId }, update, { new: true }).lean().exec()
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
 * What `tokenize()` issues a user without a set of their org: the role's defaults with the user's
 * own list on top, and the role's areas (FR-26). This preview used to show the user's own list
 * alone, which is not what they are issued.
 */
function fromRole(user: { role: string; permissions?: string[] }) {
  const roleDefaults = DEFAULT_ROLE_PERMISSIONS[user.role as Role] || DEFAULT_ROLE_PERMISSIONS.member
  const areas = DEFAULT_ROLE_AREAS[user.role as Role]
  return {
    permissions: [...new Set([...roleDefaults, ...(user.permissions || [])])],
    ownRecordsModules: [] as string[],
    ...(areas ? { areas: [...areas] } : {}),
    isAdmin: user.role === 'admin',
  }
}

/**
 * Compute effective permissions for a user (union of all their assigned permission sets).
 */
export async function computeEffectivePermissions(userId: string, orgId: string): Promise<{
  permissions: string[]
  ownRecordsModules: string[]
  /** FR-26: absent = every area. */
  areas?: Area[]
  isAdmin: boolean
}> {
  // Both lookups scoped: this endpoint took a bare userId, so an admin of one org could read
  // the effective permissions of a user in another.
  const user = await User.findOne({ _id: userId, orgId }).exec()
  if (!user) throw new Error('User not found')

  const setIds = user.permissionSetIds || []
  if (setIds.length === 0) {
    return fromRole(user)
  }

  // Same rule as `tokenize`: a set belonging to another org grants nothing here either, so
  // this preview matches the permissions the user will actually be issued.
  const sets = await PermissionSet.find({ _id: { $in: setIds }, orgId }).lean().exec()
  if (!sets.length) {
    return fromRole(user)
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

  const areas = mergeAreas(sets)
  return {
    permissions: isAdmin ? [...PERMISSIONS] : [...permSet],
    ownRecordsModules,
    ...(areas ? { areas } : {}),
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

/** The org's system set for a role (`ROLE_TO_PERMISSION_SET`), if the role has one and the org holds it. */
export async function systemSetForRole(orgId: unknown, role: string): Promise<IPermissionSet | null> {
  const name = ROLE_TO_PERMISSION_SET[role]
  if (!name) return null
  return PermissionSet.findOne({ orgId, name, isSystem: true }).lean().exec() as Promise<IPermissionSet | null>
}

/**
 * FR-26.9.1: the sets a user holds after a change of role. The system sets go (they are each a
 * role's), the role's own system set comes in, and custom sets stay.
 *
 * Without this a role change rewrote only the user's own `permissions`, which `tokenize()` never
 * reads while a set resolves: a user on the `Administrator` set made a Seller stayed an
 * administrator in all but the role name.
 */
export async function setsForRole(orgId: unknown, currentIds: readonly unknown[], role: string): Promise<string[]> {
  const ids = currentIds.map(String)
  const held = ids.length ? await PermissionSet.find({ _id: { $in: ids }, orgId }, { isSystem: 1 }).lean().exec() : []
  const system = new Set(held.filter(s => s.isSystem).map(s => String(s._id)))
  const kept = ids.filter(id => !system.has(id))
  const own = await systemSetForRole(orgId, role)
  return own ? [...new Set([...kept, String(own._id)])] : kept
}

/**
 * FR-26.9.4: a change of what a person may do ends every session they hold, within the minute
 * `identityStillValid` caches for, as a password change does. ⚠ The counter is the person's, so
 * this signs them out of every org (D-10). A membership linked to no person carries no `tv`: its
 * sessions run out on their own (24 h).
 */
export async function endSessionsOf(identityId: unknown): Promise<boolean> {
  if (!identityId) return false
  await Identity.updateOne({ _id: identityId }, { $inc: { tokenVersion: 1 } }).exec()
  forgetIdentity(identityId)
  return true
}

/**
 * FR-26.9.2: the set a person who accepts an invite with `role` starts on: the role's system set
 * where it has one, else the org's default set. A role held to areas (a Seller) whose set this org
 * lacks gets none: its role defaults carry the areas, and the default set („Member (Read Only)")
 * would open Accounting and Reports to it.
 */
export async function inviteSetFor(orgId: unknown, role: string): Promise<IPermissionSet | null> {
  const own = await systemSetForRole(orgId, role)
  if (own) return own
  if (DEFAULT_ROLE_AREAS[role as Role]) return null
  return PermissionSet.findOne({ orgId, isDefault: true }).lean().exec() as Promise<IPermissionSet | null>
}
