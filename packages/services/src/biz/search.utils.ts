/**
 * Build a MongoDB-compatible search filter for multi-field, multi-keyword search.
 *
 * Strategy:
 * - If `lowered: { fieldsLowerMap }` is supplied, lowercase the keyword (locale-aware) and
 *   match against the lowered mirror fields with a plain regex (no `i` flag — Cyrillic case
 *   folding via the regex `i` flag is unreliable in MongoDB).
 * - Otherwise → use $regex with $options:'i' across the requested fields (ASCII-friendly).
 *
 * Multi-keyword: space-separated = AND (all keywords must match at least one field).
 */
export interface BuildSearchFilterOptions {
  hasTextIndex?: boolean
  /**
   * When set, search runs against the lowered mirror fields. Map source field → mirror field.
   * Example: { name: 'nameLower', sku: 'skuLower' }. Pass the source `fields` array as well —
   * any source field absent from this map falls back to a regular case-insensitive regex.
   */
  lowered?: Record<string, string>
  /** Locale used for `String.prototype.toLocaleLowerCase`. Defaults to 'bg' for Cyrillic safety. */
  locale?: string
}

export function buildSearchFilter(
  search: string,
  fields: string[],
  options?: BuildSearchFilterOptions,
): Record<string, any> {
  const keywords = search.trim().split(/\s+/).filter(Boolean)
  if (!keywords.length || !fields.length) return {}

  const lowered = options?.lowered
  const locale = options?.locale ?? 'bg'

  const escaped = keywords.map(k => escapeRegex(k))
  const escapedLower = lowered ? keywords.map(k => escapeRegex(k.toLocaleLowerCase(locale))) : escaped

  const orClause = (idx: number) =>
    fields.map(f => {
      const target = lowered?.[f]
      if (target) return { [target]: { $regex: escapedLower[idx] } }
      return { [f]: { $regex: escaped[idx], $options: 'i' } }
    })

  if (escaped.length === 1) {
    return { $or: orClause(0) }
  }

  return {
    $and: escaped.map((_, idx) => ({ $or: orClause(idx) })),
  }
}

/**
 * Escape regex special characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
