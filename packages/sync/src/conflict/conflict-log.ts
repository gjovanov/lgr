import type { Database } from 'bun:sqlite'
import type { ConflictEntry } from '../change-tracker/types.js'

/**
 * Log a conflict for review/audit.
 */
export function logConflict(db: Database, conflict: Omit<ConflictEntry, 'createdAt' | 'resolvedAt'>): void {
  db.prepare(`
    INSERT INTO _conflict_log (id, table_name, row_id, local_data, remote_data, resolution, resolved_data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `).run(
    conflict.id,
    conflict.tableName,
    conflict.rowId,
    JSON.stringify(conflict.localData),
    JSON.stringify(conflict.remoteData),
    conflict.resolution,
    conflict.resolvedData ? JSON.stringify(conflict.resolvedData) : null,
  )
}

/**
 * Get pending (unresolved) conflicts.
 */
export function getPendingConflicts(db: Database): ConflictEntry[] {
  const rows = db.prepare(
    `SELECT * FROM _conflict_log WHERE resolution = 'pending' ORDER BY created_at DESC`
  ).all() as any[]
  return rows.map(mapConflictRow)
}

/**
 * Get all conflicts (for audit/history).
 */
export function getConflicts(db: Database, limit: number = 100, offset: number = 0): ConflictEntry[] {
  const rows = db.prepare(
    'SELECT * FROM _conflict_log ORDER BY created_at DESC LIMIT ? OFFSET ?'
  ).all(limit, offset) as any[]
  return rows.map(mapConflictRow)
}

/**
 * Resolve a pending conflict.
 */
export function resolveConflict(
  db: Database,
  conflictId: string,
  resolution: 'local_wins' | 'remote_wins' | 'merged',
  resolvedData: Record<string, unknown>,
): void {
  db.prepare(`
    UPDATE _conflict_log
    SET resolution = ?, resolved_data = ?, resolved_at = datetime('now')
    WHERE id = ?
  `).run(resolution, JSON.stringify(resolvedData), conflictId)
}

function mapConflictRow(row: any): ConflictEntry {
  return {
    id: row.id,
    tableName: row.table_name,
    rowId: row.row_id,
    localData: JSON.parse(row.local_data),
    remoteData: JSON.parse(row.remote_data),
    resolution: row.resolution,
    resolvedData: row.resolved_data ? JSON.parse(row.resolved_data) : null,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  }
}
