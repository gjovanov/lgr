import type { Database } from 'bun:sqlite'
import type { IdMapEntry } from '../change-tracker/types.js'

/**
 * Bidirectional ID mapper for MongoDB ObjectId <-> SQLite UUID mapping.
 * Used during MongoDB <-> SQLite migration to preserve referential integrity.
 */
export class IdMapper {
  // table -> mongoId -> sqliteId
  private mongoToSqlite = new Map<string, Map<string, string>>()
  // table -> sqliteId -> mongoId
  private sqliteToMongo = new Map<string, Map<string, string>>()

  set(table: string, mongoId: string, sqliteId: string): void {
    if (!this.mongoToSqlite.has(table)) {
      this.mongoToSqlite.set(table, new Map())
      this.sqliteToMongo.set(table, new Map())
    }
    this.mongoToSqlite.get(table)!.set(mongoId, sqliteId)
    this.sqliteToMongo.get(table)!.set(sqliteId, mongoId)
  }

  getSqliteId(table: string, mongoId: string): string | undefined {
    return this.mongoToSqlite.get(table)?.get(mongoId)
  }

  getMongoId(table: string, sqliteId: string): string | undefined {
    return this.sqliteToMongo.get(table)?.get(sqliteId)
  }

  /**
   * Find the SQLite ID for a MongoDB ID across all tables.
   * Used for FK remapping when the source table is unknown.
   */
  findSqliteId(mongoId: string): { table: string; sqliteId: string } | undefined {
    for (const [table, map] of this.mongoToSqlite) {
      const sqliteId = map.get(mongoId)
      if (sqliteId) return { table, sqliteId }
    }
    return undefined
  }

  /**
   * Remap all ID-like fields in an entity using the ID map.
   * Recognizes fields ending in _id, Id, or named 'id'.
   */
  remapEntity(entity: Record<string, unknown>, fkTableMap: Record<string, string>): Record<string, unknown> {
    const remapped = { ...entity }

    for (const [field, value] of Object.entries(remapped)) {
      if (typeof value !== 'string') continue
      if (field === 'id') continue // ID is handled separately

      // Check FK table map first (explicit mapping)
      if (fkTableMap[field]) {
        const mapped = this.getSqliteId(fkTableMap[field], value)
        if (mapped) remapped[field] = mapped
        continue
      }

      // Fall back to searching all tables
      if (field.endsWith('_id') || field.endsWith('Id')) {
        const found = this.findSqliteId(value)
        if (found) remapped[field] = found.sqliteId
      }
    }

    return remapped
  }

  /**
   * Persist the entire ID map to SQLite's _id_map table.
   */
  persistToSQLite(db: Database): void {
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO _id_map (sqlite_id, mongo_id, table_name)
      VALUES (?, ?, ?)
    `)

    db.exec('BEGIN TRANSACTION')
    try {
      for (const [table, map] of this.mongoToSqlite) {
        for (const [mongoId, sqliteId] of map) {
          stmt.run(sqliteId, mongoId, table)
        }
      }
      db.exec('COMMIT')
    } catch (err) {
      db.exec('ROLLBACK')
      throw err
    }
  }

  /**
   * Load the ID map from SQLite's _id_map table.
   */
  loadFromSQLite(db: Database): void {
    const rows = db.prepare('SELECT sqlite_id, mongo_id, table_name FROM _id_map').all() as IdMapEntry[]
    for (const row of rows) {
      this.set(row.tableName, row.mongoId, row.sqliteId)
    }
  }

  /** Get total entries across all tables */
  get size(): number {
    let total = 0
    for (const map of this.mongoToSqlite.values()) {
      total += map.size
    }
    return total
  }

  /** Clear all mappings */
  clear(): void {
    this.mongoToSqlite.clear()
    this.sqliteToMongo.clear()
  }
}
