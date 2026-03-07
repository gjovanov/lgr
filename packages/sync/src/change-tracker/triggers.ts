import type { Database } from 'bun:sqlite'
import { TABLE_REGISTRY } from './table-registry.js'

/**
 * Generate INSERT/UPDATE/DELETE trigger SQL for a table.
 * Each trigger writes to the _changes table for change tracking.
 */
export function generateTriggerSQL(tableName: string, columns: string[]): string[] {
  const deviceIdExpr = `(SELECT device_id FROM _device_info LIMIT 1)`

  // For json_object, strip quotes from column names (e.g., "order" → order as key)
  const jsonPairs = columns.map(c => {
    const cleanName = c.replace(/"/g, '')
    return `'${cleanName}', NEW.${c}`
  }).join(', ')

  const jsonPairsOld = columns.map(c => {
    const cleanName = c.replace(/"/g, '')
    return `'${cleanName}', OLD.${c}`
  }).join(', ')

  return [
    // INSERT trigger
    `CREATE TRIGGER IF NOT EXISTS trg_${tableName}_insert
     AFTER INSERT ON ${tableName}
     WHEN (SELECT COUNT(*) FROM _device_info) > 0
     BEGIN
       INSERT INTO _changes (table_name, row_id, operation, data, timestamp, device_id)
       VALUES ('${tableName}', NEW.id, 'INSERT',
         json_object(${jsonPairs}),
         strftime('%Y-%m-%dT%H:%M:%f', 'now'), ${deviceIdExpr});
     END`,

    // UPDATE trigger
    `CREATE TRIGGER IF NOT EXISTS trg_${tableName}_update
     AFTER UPDATE ON ${tableName}
     WHEN (SELECT COUNT(*) FROM _device_info) > 0
     BEGIN
       INSERT INTO _changes (table_name, row_id, operation, data, old_data, timestamp, device_id)
       VALUES ('${tableName}', NEW.id, 'UPDATE',
         json_object(${jsonPairs}),
         json_object(${jsonPairsOld}),
         strftime('%Y-%m-%dT%H:%M:%f', 'now'), ${deviceIdExpr});
     END`,

    // DELETE trigger
    `CREATE TRIGGER IF NOT EXISTS trg_${tableName}_delete
     AFTER DELETE ON ${tableName}
     WHEN (SELECT COUNT(*) FROM _device_info) > 0
     BEGIN
       INSERT INTO _changes (table_name, row_id, operation, old_data, timestamp, device_id)
       VALUES ('${tableName}', OLD.id, 'DELETE',
         json_object(${jsonPairsOld}),
         strftime('%Y-%m-%dT%H:%M:%f', 'now'), ${deviceIdExpr});
     END`,
  ]
}

/**
 * Install change-tracking triggers on all registered tables.
 * Safe to call multiple times (uses CREATE TRIGGER IF NOT EXISTS).
 */
export function installTriggers(db: Database): void {
  for (const table of TABLE_REGISTRY) {
    const sqls = generateTriggerSQL(table.name, table.columns)
    for (const sql of sqls) {
      db.exec(sql)
    }
  }
}

/**
 * Remove all change-tracking triggers.
 */
export function removeTriggers(db: Database): void {
  for (const table of TABLE_REGISTRY) {
    db.exec(`DROP TRIGGER IF EXISTS trg_${table.name}_insert`)
    db.exec(`DROP TRIGGER IF EXISTS trg_${table.name}_update`)
    db.exec(`DROP TRIGGER IF EXISTS trg_${table.name}_delete`)
  }
}

/**
 * Temporarily disable triggers (e.g., during sync apply).
 * Drops all triggers, executes fn, then reinstalls them.
 */
export async function withTriggersDisabled<T>(db: Database, fn: () => T | Promise<T>): Promise<T> {
  removeTriggers(db)
  try {
    return await fn()
  } finally {
    installTriggers(db)
  }
}
