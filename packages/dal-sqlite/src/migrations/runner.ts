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

/** Migration 2: tag-based pricing + price explanation */
export const tagPricingMigration: Migration = {
  version: 2,
  name: 'tag-pricing',
  up(db: Database) {
    // Add product_tag_prices table
    db.exec(`
      CREATE TABLE IF NOT EXISTS product_tag_prices (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        tag TEXT NOT NULL,
        price REAL NOT NULL,
        min_quantity REAL,
        valid_from TEXT,
        valid_to TEXT,
        sort_order INTEGER DEFAULT 0
      )
    `)

    // Add name column to product_custom_prices (if missing)
    const cpCols = db.query<{ name: string }, []>(`PRAGMA table_info(product_custom_prices)`).all()
    if (!cpCols.some(c => c.name === 'name')) {
      db.exec(`ALTER TABLE product_custom_prices ADD COLUMN name TEXT NOT NULL DEFAULT ''`)
    }

    // Add price_explanation column to invoice_lines (if missing)
    const ilCols = db.query<{ name: string }, []>(`PRAGMA table_info(invoice_lines)`).all()
    if (!ilCols.some(c => c.name === 'price_explanation')) {
      db.exec(`ALTER TABLE invoice_lines ADD COLUMN price_explanation TEXT DEFAULT '[]'`)
    }

    // Add price_explanation column to pos_transaction_lines (if missing)
    const ptCols = db.query<{ name: string }, []>(`PRAGMA table_info(pos_transaction_lines)`).all()
    if (!ptCols.some(c => c.name === 'price_explanation')) {
      db.exec(`ALTER TABLE pos_transaction_lines ADD COLUMN price_explanation TEXT DEFAULT '[]'`)
    }
  },
}

/** All registered migrations in order */
export const migrations: Migration[] = [
  initialMigration,
  tagPricingMigration,
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
