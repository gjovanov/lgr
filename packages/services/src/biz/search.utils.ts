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
  /**
   * Treat Latin/Cyrillic look-alike letters as the same letter (`x`/`х`, `m`/`м`, `a`/`а`, …).
   * Product names mix both alphabets freely — „М8х20" may be typed with a Latin M or a
   * Cyrillic х, in the query or in the name — and the two are indistinguishable on screen.
   */
  homoglyphs?: boolean
  /**
   * FR-28.10: per keyword, in the order `searchKeywords` gives them, the ids of documents the keyword matches
   * through something that is not one of `fields` (an article's recorded supplier code lives on another collection).
   * They join that keyword's OR, so the search stays an AND of keywords each of which finds SOMETHING.
   */
  alsoIds?: string[][]
}

/** The keywords of a search text: whitespace-separated, none empty. */
export function searchKeywords(search: string): string[] {
  return search.trim().split(/\s+/).filter(Boolean)
}

/**
 * Lowercase Latin ↔ Cyrillic pairs that render identically (or nearly) once lowercased from
 * their look-alike capitals (A/А, B/В, C/С, E/Е, H/Н, K/К, M/М, O/О, P/Р, T/Т, X/Х, Y/У).
 */
const HOMOGLYPH_PAIRS: Array<[string, string]> = [
  ['a', 'а'], ['b', 'в'], ['c', 'с'], ['e', 'е'], ['h', 'н'], ['k', 'к'],
  ['m', 'м'], ['o', 'о'], ['p', 'р'], ['t', 'т'], ['x', 'х'], ['y', 'у'],
]
const HOMOGLYPH_CLASS: Record<string, string> = {}
for (const [lat, cyr] of HOMOGLYPH_PAIRS) {
  HOMOGLYPH_CLASS[lat] = `[${lat}${cyr}]`
  HOMOGLYPH_CLASS[cyr] = `[${lat}${cyr}]`
}

/** Expand look-alike letters of an already-escaped, lowercased keyword into character classes. */
function expandHomoglyphs(escapedLower: string): string {
  let out = ''
  for (const ch of escapedLower) out += HOMOGLYPH_CLASS[ch] ?? ch
  return out
}

export function buildSearchFilter(
  search: string,
  fields: string[],
  options?: BuildSearchFilterOptions,
): Record<string, any> {
  const keywords = searchKeywords(search)
  if (!keywords.length || !fields.length) return {}

  const lowered = options?.lowered
  const locale = options?.locale ?? 'bg'

  // With homoglyphs on, the keyword is lowercased on BOTH paths: the classes are lowercase, and
  // the non-lowered path's `i` flag folds the field side.
  const glyphs = options?.homoglyphs
    ? (k: string) => expandHomoglyphs(escapeRegex(k.toLocaleLowerCase(locale)))
    : null
  const escaped = keywords.map(k => (glyphs ? glyphs(k) : escapeRegex(k)))
  const escapedLower = lowered
    ? keywords.map(k => (glyphs ? glyphs(k) : escapeRegex(k.toLocaleLowerCase(locale))))
    : escaped

  const orClause = (idx: number) => {
    const clauses: Record<string, any>[] = fields.map(f => {
      const target = lowered?.[f]
      if (target) return { [target]: { $regex: escapedLower[idx] } }
      return { [f]: { $regex: escaped[idx], $options: 'i' } }
    })
    const also = options?.alsoIds?.[idx]
    if (also?.length) clauses.push({ _id: { $in: also } })
    return clauses
  }

  if (escaped.length === 1) {
    return { $or: orClause(0) }
  }

  return {
    $and: escaped.map((_, idx) => ({ $or: orClause(idx) })),
  }
}

/**
 * THE product search: every surface that finds products by typed text (inventory list, line-item
 * pickers, the POS terminal and the cash-sale terminal via `/trade/pos/catalog`) goes through
 * this, so a query finds the same products everywhere. Runs on the `*Lower` mirrors (Cyrillic
 * case folding) with Latin/Cyrillic look-alikes treated as equal.
 */
export const PRODUCT_SEARCH_FIELDS = ['name', 'sku', 'barcode', 'description', 'category']
export const PRODUCT_SEARCH_LOWERED: Record<string, string> = {
  name: 'nameLower',
  sku: 'skuLower',
  barcode: 'barcodeLower',
  description: 'descriptionLower',
  category: 'categoryLower',
}

export function buildProductSearchFilter(search: string, opts: { alsoIds?: string[][] } = {}): Record<string, any> {
  return buildSearchFilter(search, PRODUCT_SEARCH_FIELDS, { lowered: PRODUCT_SEARCH_LOWERED, homoglyphs: true, alsoIds: opts.alsoIds })
}

/**
 * Escape regex special characters in a string.
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
