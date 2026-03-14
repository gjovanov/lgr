/** Warehouse module SQLite schema */
export const warehouseSchema = `
-- ══════════════════════════════════════════
-- WAREHOUSE TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  sku TEXT NOT NULL,
  barcode TEXT,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('goods','service','raw_material','finished_product')),
  unit TEXT NOT NULL,
  purchase_price REAL NOT NULL DEFAULT 0,
  selling_price REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'EUR',
  tax_rate REAL NOT NULL DEFAULT 0,
  revenue_account_id TEXT,
  expense_account_id TEXT,
  inventory_account_id TEXT,
  track_inventory INTEGER NOT NULL DEFAULT 1,
  min_stock_level REAL,
  max_stock_level REAL,
  weight REAL,
  dimensions TEXT,
  images TEXT DEFAULT '[]',
  tags TEXT DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, sku)
);
CREATE INDEX IF NOT EXISTS idx_products_org_barcode ON products(org_id, barcode);
CREATE INDEX IF NOT EXISTS idx_products_org_category ON products(org_id, category);
CREATE INDEX IF NOT EXISTS idx_products_org_tags ON products(org_id, tags);

-- FTS5 virtual table for product text search
CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
  name, description, sku, barcode, category,
  content='products', content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS product_custom_prices (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  price REAL NOT NULL,
  min_quantity REAL,
  valid_from TEXT,
  valid_to TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS product_tag_prices (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  price REAL NOT NULL,
  min_quantity REAL,
  valid_from TEXT,
  valid_to TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS product_variants (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS warehouses (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  address TEXT,
  type TEXT NOT NULL CHECK(type IN ('warehouse','store','production','transit')),
  manager TEXT,
  manager_id TEXT,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  tags TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, code)
);

CREATE TABLE IF NOT EXISTS stock_levels (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  quantity REAL NOT NULL DEFAULT 0,
  reserved_quantity REAL NOT NULL DEFAULT 0,
  available_quantity REAL NOT NULL DEFAULT 0,
  avg_cost REAL NOT NULL DEFAULT 0,
  last_count_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, product_id, warehouse_id)
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  movement_number TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('receipt','dispatch','transfer','adjustment','return','production_in','production_out')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed','completed','cancelled')),
  date TEXT NOT NULL DEFAULT (datetime('now')),
  from_warehouse_id TEXT REFERENCES warehouses(id),
  to_warehouse_id TEXT REFERENCES warehouses(id),
  contact_id TEXT,
  invoice_id TEXT,
  production_order_id TEXT,
  total_amount REAL NOT NULL DEFAULT 0,
  notes TEXT,
  journal_entry_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, movement_number)
);
CREATE INDEX IF NOT EXISTS idx_sm_org_type_date ON stock_movements(org_id, type, date DESC);

CREATE TABLE IF NOT EXISTS stock_movement_lines (
  id TEXT PRIMARY KEY,
  movement_id TEXT NOT NULL REFERENCES stock_movements(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity REAL NOT NULL,
  unit_cost REAL NOT NULL,
  total_cost REAL NOT NULL,
  batch_number TEXT,
  expiry_date TEXT,
  serial_numbers TEXT DEFAULT '[]',
  sort_order INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_sml_movement ON stock_movement_lines(movement_id);
CREATE INDEX IF NOT EXISTS idx_sml_product ON stock_movement_lines(product_id);

CREATE TABLE IF NOT EXISTS inventory_counts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  count_number TEXT NOT NULL,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','completed','cancelled')),
  type TEXT NOT NULL CHECK(type IN ('full','partial','cycle')),
  adjustment_movement_id TEXT,
  completed_by TEXT,
  completed_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ic_org_wh ON inventory_counts(org_id, warehouse_id, date DESC);

CREATE TABLE IF NOT EXISTS inventory_count_lines (
  id TEXT PRIMARY KEY,
  inventory_count_id TEXT NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  system_quantity REAL NOT NULL,
  counted_quantity REAL NOT NULL,
  variance REAL NOT NULL,
  variance_cost REAL NOT NULL,
  notes TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS price_lists (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  is_default INTEGER NOT NULL DEFAULT 0,
  valid_from TEXT,
  valid_to TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, name)
);

CREATE TABLE IF NOT EXISTS price_list_items (
  id TEXT PRIMARY KEY,
  price_list_id TEXT NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  price REAL NOT NULL,
  min_quantity REAL,
  discount REAL,
  sort_order INTEGER DEFAULT 0
);
`
