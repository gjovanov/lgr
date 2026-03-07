import type { Database } from 'bun:sqlite'
import type { ChangeEntry } from '../change-tracker/types.js'
import type { ConflictResolver } from '../conflict/resolver.js'
import { TABLE_REGISTRY } from '../change-tracker/table-registry.js'

export interface ApplyResult {
  hadConflict: boolean
  resolution: 'local_wins' | 'remote_wins' | 'merged' | 'pending'
  localData?: Record<string, unknown> | null
  resolvedData?: Record<string, unknown> | null
}

/**
 * Apply a single change entry to the local database.
 * Detects conflicts when an UPDATE targets a row that has also been modified locally.
 */
export function applyChange(
  db: Database,
  change: ChangeEntry,
  resolver: ConflictResolver,
): ApplyResult {
  const tableMeta = TABLE_REGISTRY.find(t => t.name === change.tableName)
  if (!tableMeta) {
    throw new Error(`Unknown table: ${change.tableName}`)
  }

  switch (change.operation) {
    case 'INSERT':
      return applyInsert(db, change, tableMeta.columns)

    case 'UPDATE':
      return applyUpdate(db, change, tableMeta.columns, resolver)

    case 'DELETE':
      return applyDelete(db, change)

    default:
      throw new Error(`Unknown operation: ${change.operation}`)
  }
}

function applyInsert(db: Database, change: ChangeEntry, columns: string[]): ApplyResult {
  if (!change.data) throw new Error('INSERT change must have data')

  // Check if row already exists (duplicate insert from another sync)
  const existing = db.prepare(`SELECT id FROM ${change.tableName} WHERE id = ?`).get(change.data.id as string)
  if (existing) {
    // Row already exists — treat as update
    return applyUpdateData(db, change.tableName, change.data.id as string, change.data, columns)
  }

  const cols = columns.filter(c => change.data![c.replace(/"/g, '')] !== undefined)
  const cleanCols = cols.map(c => c.replace(/"/g, ''))
  const placeholders = cols.map(() => '?').join(', ')
  const values = cleanCols.map(c => {
    const val = change.data![c]
    return typeof val === 'object' && val !== null ? JSON.stringify(val) : val
  })

  try {
    db.prepare(`INSERT INTO ${change.tableName} (${cols.join(', ')}) VALUES (${placeholders})`).run(...values as any[])
  } catch (err: any) {
    if (err.message?.includes('UNIQUE constraint')) {
      // Duplicate — skip silently
      return { hadConflict: false, resolution: 'remote_wins' }
    }
    throw err
  }

  return { hadConflict: false, resolution: 'remote_wins' }
}

function applyUpdate(
  db: Database,
  change: ChangeEntry,
  columns: string[],
  resolver: ConflictResolver,
): ApplyResult {
  if (!change.data) throw new Error('UPDATE change must have data')

  // Read current local state
  const localRow = db.prepare(`SELECT * FROM ${change.tableName} WHERE id = ?`).get(change.rowId) as Record<string, unknown> | null

  if (!localRow) {
    // Row doesn't exist locally — convert to insert
    return applyInsert(db, { ...change, operation: 'INSERT' }, columns)
  }

  // Check if local has changed since the base (old_data)
  const base = change.oldData
  if (base) {
    const localChanged = hasLocalChanges(localRow, base)
    if (localChanged) {
      // Conflict: both local and remote modified this row
      const resolved = resolver.resolve(
        change.tableName,
        localRow,
        change.data,
        localRow.updated_at as string ?? '',
        change.timestamp,
        base,
      )

      return applyUpdateData(db, change.tableName, change.rowId, resolved.data, columns, {
        hadConflict: true,
        resolution: resolved.resolution,
        localData: localRow,
        resolvedData: resolved.data,
      })
    }
  }

  // No conflict — apply remote changes
  return applyUpdateData(db, change.tableName, change.rowId, change.data, columns)
}

function applyUpdateData(
  db: Database,
  tableName: string,
  rowId: string,
  data: Record<string, unknown>,
  columns: string[],
  result?: ApplyResult,
): ApplyResult {
  const cleanCols = columns.map(c => c.replace(/"/g, '')).filter(c => c !== 'id' && data[c] !== undefined)
  if (cleanCols.length === 0) return result ?? { hadConflict: false, resolution: 'remote_wins' }

  const setClauses = cleanCols.map(c => {
    const quotedCol = columns.find(col => col.replace(/"/g, '') === c) ?? c
    return `${quotedCol} = ?`
  }).join(', ')
  const values = cleanCols.map(c => {
    const val = data[c]
    return typeof val === 'object' && val !== null ? JSON.stringify(val) : val
  })

  db.prepare(`UPDATE ${tableName} SET ${setClauses} WHERE id = ?`).run(...values as any[], rowId)

  return result ?? { hadConflict: false, resolution: 'remote_wins' }
}

function applyDelete(db: Database, change: ChangeEntry): ApplyResult {
  db.prepare(`DELETE FROM ${change.tableName} WHERE id = ?`).run(change.rowId)
  return { hadConflict: false, resolution: 'remote_wins' }
}

function hasLocalChanges(local: Record<string, unknown>, base: Record<string, unknown>): boolean {
  for (const key of Object.keys(base)) {
    const localVal = local[key]
    const baseVal = base[key]
    if (localVal !== baseVal) {
      // Handle JSON fields
      if (typeof localVal === 'string' && typeof baseVal === 'string') {
        try {
          if (JSON.stringify(JSON.parse(localVal)) === JSON.stringify(JSON.parse(baseVal))) continue
        } catch { /* not JSON */ }
      }
      return true
    }
  }
  return false
}
