import type { BaseEntity } from 'dal'
import { toSnakeCase } from './filter-translator.js'

/**
 * Convert a camelCase entity to a snake_case SQLite row.
 */
export function toRow(entity: Record<string, any>): Record<string, any> {
  const row: Record<string, any> = {}
  for (const [key, value] of Object.entries(entity)) {
    if (key === 'id') { row.id = value; continue }
    const col = toSnakeCase(key)
    row[col] = serializeForSQLite(value)
  }
  return row
}

/**
 * Convert a snake_case SQLite row to a camelCase entity.
 */
export function toEntity<T extends BaseEntity>(row: Record<string, any>): T {
  const entity: Record<string, any> = {}
  for (const [col, value] of Object.entries(row)) {
    const key = toCamelCase(col)
    entity[key] = deserializeFromSQLite(col, value)
  }
  return entity as T
}

function toCamelCase(str: string): string {
  return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
}

/** Serialize a JS value for SQLite storage */
function serializeForSQLite(value: any): any {
  if (value === undefined || value === null) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'boolean') return value ? 1 : 0
  if (Array.isArray(value) || (typeof value === 'object' && !(value instanceof Date))) {
    return JSON.stringify(value)
  }
  return value
}

/** Deserialize a SQLite value back to JS */
function deserializeFromSQLite(col: string, value: any): any {
  if (value === null) return value

  // Boolean columns (stored as INTEGER 0/1)
  if (isBooleanColumn(col) && typeof value === 'number') {
    return value === 1
  }

  // Date columns (stored as TEXT ISO 8601)
  if (isDateColumn(col) && typeof value === 'string') {
    const d = new Date(value)
    return isNaN(d.getTime()) ? value : d
  }

  // JSON columns (stored as TEXT)
  if (isJsonColumn(col) && typeof value === 'string') {
    try { return JSON.parse(value) } catch { return value }
  }

  return value
}

const BOOLEAN_PREFIXES = ['is_', 'has_', 'half_']
const BOOLEAN_COLUMNS = new Set([
  'is_active', 'is_system', 'is_default', 'is_paid', 'is_confidential',
  'requires_approval', 'track_inventory', 'enabled', 'read', 'matched',
  'synced', 'cancel_at_period_end', 'half_day',
])

function isBooleanColumn(col: string): boolean {
  return BOOLEAN_COLUMNS.has(col) || BOOLEAN_PREFIXES.some(p => col.startsWith(p))
}

const DATE_SUFFIXES = ['_at', '_date', '_to', '_from']
const DATE_COLUMNS = new Set([
  'created_at', 'updated_at', 'timestamp', 'date', 'opened_at', 'closed_at',
  'start_date', 'end_date', 'due_date', 'issue_date', 'valid_to', 'valid_from',
  'period_from', 'period_to', 'statement_date', 'purchase_date',
  'contract_start_date', 'contract_end_date', 'expiry_date',
])

function isDateColumn(col: string): boolean {
  return DATE_COLUMNS.has(col) || DATE_SUFFIXES.some(s => col.endsWith(s))
}

const JSON_COLUMNS = new Set([
  'settings', 'subscription', 'preferences', 'oauth_providers', 'permissions',
  'tags', 'images', 'custom_fields', 'attachments', 'logs', 'params', 'result', 'invoice_ids',
  'changes', 'ai_recognition', 'dimensions', 'salary', 'address', 'emergency_contact',
  'billing_address', 'shipping_address', 'recurring_config', 'budget',
  'totals', 'year_to_date', 'invoice_ids', 'serial_numbers', 'documents',
  'quality_checks', 'deductions', 'employer_contributions',
  'price_explanation',
])

function isJsonColumn(col: string): boolean {
  return JSON_COLUMNS.has(col)
}
