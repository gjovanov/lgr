import type { RepositoryRegistry } from 'dal'
import { getRepos } from '../context.js'
import { getRecordScopeFilter } from './record-scope.config.js'
import { ScopedRepository } from './scoped-repository.js'

/**
 * Build a RepositoryRegistry where repos affected by the user's
 * ownRecordsOnly settings have automatic scope filters applied.
 *
 * Repos not affected by scoping are returned as-is (pass-through).
 */
export function buildScopedRepos(
  ownRecordsModules: string[],
  userId: string,
  repos?: RepositoryRegistry,
): RepositoryRegistry {
  const r = repos ?? getRepos()

  if (!ownRecordsModules || ownRecordsModules.length === 0) {
    return r  // No scoping needed — return raw repos
  }

  // Create a proxy that wraps repos with scope filters where applicable
  const scopedRepos = { ...r } as any

  for (const key of Object.keys(r) as (keyof RepositoryRegistry)[]) {
    const filter = getRecordScopeFilter(ownRecordsModules, key as string, userId)
    if (filter) {
      scopedRepos[key] = new ScopedRepository(r[key] as any, filter)
    }
  }

  return scopedRepos as RepositoryRegistry
}
