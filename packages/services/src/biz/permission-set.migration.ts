import type { RepositoryRegistry } from 'dal'
import { getRepos } from '../context.js'
import { logger } from '../logger/logger.js'
import { seedDefaultPermissionSets, ROLE_TO_PERMISSION_SET } from './permission-set.seed.js'

/**
 * Migrate all orgs from old role-based system to permission sets.
 * Idempotent — skips users already migrated.
 */
export async function migrateToPermissionSets(repos?: RepositoryRegistry): Promise<{ orgsProcessed: number; usersProcessed: number }> {
  const r = repos ?? getRepos()
  const orgs = await r.orgs.findMany({})
  let usersProcessed = 0

  for (const org of orgs) {
    // Seed default permission sets for this org
    await seedDefaultPermissionSets(org.id, r)

    // Get all permission sets for this org
    const sets = await r.permissionSets.findMany({ orgId: org.id } as any)
    const setMap = new Map(sets.map(s => [s.name, s.id]))

    // Get all users for this org
    const users = await r.users.findMany({ orgId: org.id } as any)

    for (const user of users) {
      // Skip if already has permission sets
      if ((user as any).permissionSetIds?.length > 0) continue

      const setName = ROLE_TO_PERMISSION_SET[(user as any).role] || 'Member (Read Only)'
      const setId = setMap.get(setName)
      if (!setId) continue

      await r.users.update(user.id, {
        permissionSetIds: [setId],
      } as any)
      usersProcessed++
    }
  }

  logger.info({ orgsProcessed: orgs.length, usersProcessed }, 'Permission set migration complete')
  return { orgsProcessed: orgs.length, usersProcessed }
}
