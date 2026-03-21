/** Purchase module SQLite schema */
export const purchaseSchema = `
-- ══════════════════════════════════════════
-- PURCHASE TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS purchase_orders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  vendor_id TEXT NOT NULL REFERENCES contacts(id),
  date_order TEXT,
  date_approved TEXT,
  date_planned TEXT,
  currency TEXT NOT NULL DEFAULT 'EUR',
  exchange_rate REAL NOT NULL DEFAULT 1,
  lines TEXT NOT NULL DEFAULT '[]',
  amount_untaxed REAL NOT NULL DEFAULT 0,
  amount_tax REAL NOT NULL DEFAULT 0,
  amount_total REAL NOT NULL DEFAULT 0,
  receipt_status TEXT NOT NULL DEFAULT 'pending',
  invoice_status TEXT NOT NULL DEFAULT 'nothing',
  invoice_ids TEXT NOT NULL DEFAULT '[]',
  movement_ids TEXT NOT NULL DEFAULT '[]',
  agreement_id TEXT REFERENCES blanket_orders(id),
  approval_status TEXT,
  approved_by TEXT,
  notes TEXT,
  user_id TEXT NOT NULL,
  tags TEXT DEFAULT '[]',
  sent_at TEXT,
  confirmed_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, name)
);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_state ON purchase_orders(org_id, state);
CREATE INDEX IF NOT EXISTS idx_purchase_orders_vendor ON purchase_orders(org_id, vendor_id);

CREATE TABLE IF NOT EXISTS blanket_orders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  vendor_id TEXT NOT NULL REFERENCES contacts(id),
  state TEXT NOT NULL DEFAULT 'draft',
  date_start TEXT NOT NULL,
  date_end TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  lines TEXT NOT NULL DEFAULT '[]',
  purchase_order_ids TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS reorder_rules (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  min_qty REAL NOT NULL,
  max_qty REAL NOT NULL,
  multiple_qty REAL,
  lead_time_days INTEGER NOT NULL DEFAULT 0,
  vendor_id TEXT REFERENCES contacts(id),
  is_active INTEGER NOT NULL DEFAULT 1,
  last_triggered_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, product_id, warehouse_id)
);
`
