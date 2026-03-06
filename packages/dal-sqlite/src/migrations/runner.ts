import type { Database } from 'bun:sqlite'
import { allSchemas } from '../schema/index.js'

export interface Migration {
  version: number
  name: string
  up(db: Database): void
  down?(db: Database): void
}

/** Initial migration: creates all tables */
export const initialMigration: Migration = {
  version: 1,
  name: 'initial-schema',
  up(db: Database) {
    for (const schema of allSchemas) {
      db.exec(schema)
    }
  },
}

/** All registered migrations in order */
export const migrations: Migration[] = [
  initialMigration,
]

/**
 * Run pending migrations against the database.
 * Creates the _migrations table if it doesn't exist.
 */
export function runMigrations(db: Database): void {
  // Ensure migrations table exists
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')))')

  const applied = new Set(
    db.query<{ version: number }, []>('SELECT version FROM _migrations').all().map(r => r.version),
  )

  const pending = migrations.filter(m => !applied.has(m.version))
  if (pending.length === 0) return

  const transaction = db.transaction(() => {
    for (const m of pending) {
      m.up(db)
      db.run('INSERT INTO _migrations (version, name) VALUES (?, ?)', [m.version, m.name])
    }
  })

  transaction()
}
