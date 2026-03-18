/**
 * Build a MongoDB-compatible search filter for multi-field, multi-keyword search.
 *
 * Strategy:
 * - If all keywords are full words (≥3 chars) and a text index exists → use $text (fast inverted index)
 * - Otherwise → use $regex with $or across fields (flexible, partial match)
 *
 * Multi-keyword: space-separated = AND (all keywords must match at least one field)
 */
export function buildSearchFilter(
  search: string,
  fields: string[],
  options?: { hasTextIndex?: boolean },
): Record<string, any> {
  const keywords = search.trim().split(/\s+/).filter(Boolean)
  if (!keywords.length || !fields.length) return {}

  // $text indexes only match whole words — not suitable for typeahead/partial search.
  // Always use $regex for per-grid search (users type partial words like "Roz" for "Rozi").
  // $text is reserved for future explicit "exact keyword search" mode.

  // Strategy 2: $regex with $or (partial match, case-insensitive)
  const escaped = keywords.map(k => escapeRegex(k))

  if (escaped.length === 1) {
    return { $or: fields.map(f => ({ [f]: { $regex: escaped[0], $options: 'i' } })) }
  }

  return {
    $and: escaped.map(kw => ({
      $or: fields.map(f => ({ [f]: { $regex: kw, $options: 'i' } })),
    })),
  }
}

/**
 * Escape regex special characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
