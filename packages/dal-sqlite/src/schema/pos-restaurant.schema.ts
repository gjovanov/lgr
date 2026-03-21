/** POS Restaurant module SQLite schema */
export const posRestaurantSchema = `
-- ══════════════════════════════════════════
-- POS RESTAURANT TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS restaurant_floors (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  tables TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kitchen_orders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  pos_transaction_id TEXT NOT NULL REFERENCES pos_transactions(id),
  table_number INTEGER,
  state TEXT NOT NULL DEFAULT 'pending',
  lines TEXT NOT NULL DEFAULT '[]',
  priority TEXT NOT NULL DEFAULT 'normal',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_kitchen_orders_state ON kitchen_orders(org_id, state);
`
