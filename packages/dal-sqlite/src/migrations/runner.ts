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

/** Migration 3: inventory costing methods + cost layers */
export const costingMigration: Migration = {
  version: 3,
  name: 'inventory-costing',
  up(db: Database) {
    // Add costing_method and standard_cost to products (if missing)
    const prodCols = db.query<{ name: string }, []>(`PRAGMA table_info(products)`).all()
    if (!prodCols.some(c => c.name === 'costing_method')) {
      db.exec(`ALTER TABLE products ADD COLUMN costing_method TEXT CHECK(costing_method IN ('wac','fifo','lifo','fefo','standard'))`)
    }
    if (!prodCols.some(c => c.name === 'standard_cost')) {
      db.exec(`ALTER TABLE products ADD COLUMN standard_cost REAL`)
    }

    // Create cost_layers table
    db.exec(`
      CREATE TABLE IF NOT EXISTS cost_layers (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id),
        product_id TEXT NOT NULL REFERENCES products(id),
        warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
        unit_cost REAL NOT NULL,
        currency TEXT,
        exchange_rate REAL,
        initial_quantity REAL NOT NULL,
        remaining_quantity REAL NOT NULL,
        batch_number TEXT,
        expiry_date TEXT,
        source_movement_id TEXT NOT NULL,
        source_movement_number TEXT NOT NULL,
        received_at TEXT NOT NULL,
        is_exhausted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_layers_consume ON cost_layers(org_id, product_id, warehouse_id, is_exhausted, received_at)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_layers_fefo ON cost_layers(org_id, product_id, warehouse_id, is_exhausted, expiry_date)`)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cost_layers_source ON cost_layers(org_id, source_movement_id)`)

    // Create cost_layer_serial_numbers child table
    db.exec(`
      CREATE TABLE IF NOT EXISTS cost_layer_serial_numbers (
        cost_layer_id TEXT NOT NULL REFERENCES cost_layers(id) ON DELETE CASCADE,
        serial_number TEXT NOT NULL,
        PRIMARY KEY (cost_layer_id, serial_number)
      )
    `)

    // Add cost allocation fields to stock_movement_lines (if missing)
    const smlCols = db.query<{ name: string }, []>(`PRAGMA table_info(stock_movement_lines)`).all()
    if (!smlCols.some(c => c.name === 'resolved_unit_cost')) {
      db.exec(`ALTER TABLE stock_movement_lines ADD COLUMN resolved_unit_cost REAL`)
    }
    if (!smlCols.some(c => c.name === 'costing_method')) {
      db.exec(`ALTER TABLE stock_movement_lines ADD COLUMN costing_method TEXT`)
    }

    // Create cost allocation child table for stock movement lines
    db.exec(`
      CREATE TABLE IF NOT EXISTS stock_movement_line_cost_allocations (
        id TEXT PRIMARY KEY,
        stock_movement_line_id TEXT NOT NULL,
        cost_layer_id TEXT NOT NULL REFERENCES cost_layers(id),
        quantity REAL NOT NULL,
        unit_cost REAL NOT NULL,
        total_cost REAL NOT NULL,
        sort_order INTEGER DEFAULT 0
      )
    `)
  },
}

/** Migration 4: product categories */
export const productCategoryMigration: Migration = {
  version: 4,
  name: 'product-categories',
  up(db: Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS product_categories (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL REFERENCES orgs(id),
        name TEXT NOT NULL,
        description TEXT,
        icon TEXT,
        color TEXT,
        parent_id TEXT REFERENCES product_categories(id),
        sort_order INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        is_system INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(org_id, name)
      )
    `)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_pc_org_sort ON product_categories(org_id, sort_order)`)

    const prodCols = db.query<{ name: string }, []>(`PRAGMA table_info(products)`).all()
    if (!prodCols.some(c => c.name === 'category_id')) {
      db.exec(`ALTER TABLE products ADD COLUMN category_id TEXT REFERENCES product_categories(id)`)
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS product_category_prices (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        category_id TEXT NOT NULL REFERENCES product_categories(id),
        price REAL NOT NULL,
        min_quantity REAL,
        valid_from TEXT,
        valid_to TEXT,
        sort_order INTEGER DEFAULT 0
      )
    `)
  },
}

/** All registered migrations in order */
export const migrations: Migration[] = [
  initialMigration,
  tagPricingMigration,
  costingMigration,
  productCategoryMigration,
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
