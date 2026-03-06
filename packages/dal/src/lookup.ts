import type { BaseEntity } from './types.js'
import type { IRepository } from './repository.js'

/**
 * Batch-lookup related entities and attach selected fields.
 * Replaces Mongoose .populate() for DAL entities.
 *
 * @param items     Array of entities to enrich
 * @param field     The ID field to look up (e.g., 'fromWarehouseId')
 * @param repo      Repository to fetch related entities from
 * @param select    Fields to pick from the related entity (e.g., ['name'])
 * @param as        Optional: attach the related data under this key instead of replacing the field
 *
 * @example
 * // Attach warehouse names to movements
 * const enriched = await lookup(movements, 'fromWarehouseId', repos.warehouses, ['name'])
 * // enriched[0].fromWarehouseId stays the ID
 * // enriched[0]._fromWarehouse = { id: '...', name: 'Main Warehouse' }
 *
 * // Or use a custom key:
 * const enriched = await lookup(movements, 'fromWarehouseId', repos.warehouses, ['name'], 'fromWarehouse')
 * // enriched[0].fromWarehouse = { id: '...', name: 'Main Warehouse' }
 */
export async function lookup<T extends Record<string, any>, R extends BaseEntity>(
  items: T[],
  field: string,
  repo: IRepository<R>,
  select?: (keyof R)[],
  as?: string,
): Promise<(T & Record<string, any>)[]> {
  // Collect unique IDs
  const ids = new Set<string>()
  for (const item of items) {
    const val = item[field]
    if (val && typeof val === 'string') ids.add(val)
  }

  if (ids.size === 0) return items

  // Batch fetch
  const idArray = [...ids]
  const related = await repo.findMany({ id: { $in: idArray } } as any)
  const map = new Map<string, R>()
  for (const r of related) {
    map.set(r.id, r)
  }

  // Attach
  const targetKey = as || `_${field.replace(/Id$/, '')}`
  return items.map(item => {
    const val = item[field]
    const ref = val ? map.get(val) : undefined
    if (!ref) return { ...item, [targetKey]: null }

    const picked = select
      ? select.reduce((acc, k) => { acc[k as string] = ref[k as string]; return acc }, { id: ref.id } as any)
      : ref

    return { ...item, [targetKey]: picked }
  })
}

/**
 * Multi-field lookup — populate multiple fields in one pass.
 *
 * @example
 * const enriched = await lookupMany(movements, [
 *   { field: 'fromWarehouseId', repo: repos.warehouses, select: ['name'] },
 *   { field: 'toWarehouseId', repo: repos.warehouses, select: ['name'] },
 *   { field: 'contactId', repo: repos.contacts, select: ['companyName', 'firstName', 'lastName'] },
 * ])
 */
export async function lookupMany<T extends Record<string, any>>(
  items: T[],
  lookups: { field: string; repo: IRepository<any>; select?: string[]; as?: string }[],
): Promise<(T & Record<string, any>)[]> {
  let result = items as any[]
  for (const lk of lookups) {
    result = await lookup(result, lk.field, lk.repo, lk.select as any, lk.as)
  }
  return result
}
