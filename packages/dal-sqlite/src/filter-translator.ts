import type { Filter, FilterOperator } from 'dal'

interface SQLCondition {
  clause: string
  params: any[]
}

/**
 * Convert a camelCase field name to snake_case for SQLite columns.
 */
export function toSnakeCase(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)
}

/**
 * Translate a DAL Filter to SQL WHERE clause + params.
 */
export function translateFilter(filter: Filter<any>): SQLCondition {
  const clauses: string[] = []
  const params: any[] = []

  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue

    // Handle $or logical operator
    if (key === '$or' && Array.isArray(value)) {
      const orParts: string[] = []
      for (const subFilter of value) {
        const sub = translateFilter(subFilter)
        orParts.push(`(${sub.clause})`)
        params.push(...sub.params)
      }
      if (orParts.length > 0) {
        clauses.push(`(${orParts.join(' OR ')})`)
      }
      continue
    }

    const col = toSnakeCase(key)

    if (isFilterOperator(value)) {
      const op = value as FilterOperator<any>
      const sub = translateOperator(col, op)
      clauses.push(sub.clause)
      params.push(...sub.params)
    } else if (value === null) {
      clauses.push(`${col} IS NULL`)
    } else {
      clauses.push(`${col} = ?`)
      params.push(serializeValue(value))
    }
  }

  return {
    clause: clauses.length > 0 ? clauses.join(' AND ') : '1=1',
    params,
  }
}

function translateOperator(col: string, op: FilterOperator<any>): SQLCondition {
  const clauses: string[] = []
  const params: any[] = []

  if (op.$eq !== undefined) { clauses.push(`${col} = ?`); params.push(serializeValue(op.$eq)) }
  if (op.$ne !== undefined) { clauses.push(`${col} != ?`); params.push(serializeValue(op.$ne)) }
  if (op.$gt !== undefined) { clauses.push(`${col} > ?`); params.push(serializeValue(op.$gt)) }
  if (op.$gte !== undefined) { clauses.push(`${col} >= ?`); params.push(serializeValue(op.$gte)) }
  if (op.$lt !== undefined) { clauses.push(`${col} < ?`); params.push(serializeValue(op.$lt)) }
  if (op.$lte !== undefined) { clauses.push(`${col} <= ?`); params.push(serializeValue(op.$lte)) }
  if (op.$in !== undefined) {
    const placeholders = op.$in.map(() => '?').join(', ')
    clauses.push(`${col} IN (${placeholders})`)
    params.push(...op.$in.map(serializeValue))
  }
  if (op.$nin !== undefined) {
    const placeholders = op.$nin.map(() => '?').join(', ')
    clauses.push(`${col} NOT IN (${placeholders})`)
    params.push(...op.$nin.map(serializeValue))
  }
  if (op.$regex !== undefined) { clauses.push(`${col} LIKE ?`); params.push(regexToLike(op.$regex)) }
  if (op.$exists !== undefined) {
    clauses.push(op.$exists ? `${col} IS NOT NULL` : `${col} IS NULL`)
  }
  if (op.$text?.$search !== undefined) {
    // For FTS5 tables, caller must handle this separately
    clauses.push(`${col} LIKE ?`)
    params.push(`%${op.$text.$search}%`)
  }

  return { clause: clauses.join(' AND '), params }
}

function isFilterOperator(value: any): boolean {
  if (typeof value !== 'object' || value === null || value instanceof Date || Array.isArray(value)) return false
  return Object.keys(value).some(k => k.startsWith('$'))
}

function serializeValue(value: any): any {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'boolean') return value ? 1 : 0
  if (typeof value === 'object' && value !== null) return JSON.stringify(value)
  return value
}

/** Convert simple regex patterns to SQL LIKE patterns */
function regexToLike(regex: string): string {
  // Handle common MongoDB regex patterns
  let like = regex
    .replace(/^\^/, '')      // Remove start anchor
    .replace(/\$$/, '')      // Remove end anchor
    .replace(/\.\*/g, '%')   // .* → %
    .replace(/\./g, '_')     // . → _

  // If no anchors, wrap in %
  if (!regex.startsWith('^') && !like.startsWith('%')) like = `%${like}`
  if (!regex.endsWith('$') && !like.endsWith('%')) like = `${like}%`

  return like
}
