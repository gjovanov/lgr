import { Database } from 'bun:sqlite'

let db: Database | null = null

/**
 * Open (or return existing) SQLite database connection with optimal pragmas.
 */
export function openDatabase(path: string): Database {
  if (db) return db

  db = new Database(path, { create: true })

  // Performance & safety pragmas
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec('PRAGMA cache_size = -64000')   // 64MB
  db.exec('PRAGMA temp_store = MEMORY')

  return db
}

/** Close the database connection */
export function closeDatabase(): void {
  if (db) {
    db.close()
    db = null
  }
}

/** Get the current database instance (throws if not opened) */
export function getDatabase(): Database {
  if (!db) throw new Error('Database not opened. Call openDatabase() first.')
  return db
}
