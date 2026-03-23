/** ERP module SQLite schema (POS only) */
export const erpSchema = `
-- ══════════════════════════════════════════
-- ERP TABLES (POS)
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS pos_sessions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  cashier_id TEXT NOT NULL,
  session_number TEXT NOT NULL,
  opened_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
  opening_balance REAL NOT NULL,
  closing_balance REAL,
  expected_balance REAL,
  difference REAL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  total_sales REAL NOT NULL DEFAULT 0,
  total_returns REAL NOT NULL DEFAULT 0,
  total_cash REAL NOT NULL DEFAULT 0,
  total_card REAL NOT NULL DEFAULT 0,
  transaction_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pos_sessions_cashier ON pos_sessions(org_id, cashier_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS pos_transactions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  session_id TEXT NOT NULL REFERENCES pos_sessions(id),
  transaction_number TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('sale','return','exchange')),
  customer_id TEXT,
  subtotal REAL NOT NULL,
  discount_total REAL NOT NULL DEFAULT 0,
  tax_total REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL,
  change_due REAL NOT NULL DEFAULT 0,
  invoice_id TEXT,
  movement_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, transaction_number)
);
CREATE INDEX IF NOT EXISTS idx_pos_txn_session ON pos_transactions(org_id, session_id);
CREATE INDEX IF NOT EXISTS idx_pos_txn_date ON pos_transactions(org_id, created_at DESC);

CREATE TABLE IF NOT EXISTS pos_transaction_lines (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES pos_transactions(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  discount REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL DEFAULT 0,
  tax_amount REAL NOT NULL DEFAULT 0,
  line_total REAL NOT NULL,
  price_explanation TEXT DEFAULT '[]',
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS pos_transaction_payments (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES pos_transactions(id) ON DELETE CASCADE,
  method TEXT NOT NULL CHECK(method IN ('cash','card','mobile','voucher')),
  amount REAL NOT NULL,
  reference TEXT,
  sort_order INTEGER DEFAULT 0
);
`
