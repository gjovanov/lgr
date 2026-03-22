import { getRepos } from '../context.js'

/**
 * Upsert tags for a given entity type.
 * Uses batch lookup (findMany with $in) to minimize DB queries.
 */
export async function upsertTags(orgId: string, type: string, tags?: string[]): Promise<void> {
  if (!tags?.length) return
  const r = getRepos()
  const existing = await r.tags.findMany({ orgId, type, value: { $in: tags } } as any)
  const existingValues = new Set(existing.map((t: any) => t.value))
  const newTags = tags.filter(v => !existingValues.has(v))
  for (const value of newTags) {
    await r.tags.create({ orgId, type, value } as any)
  }
}
