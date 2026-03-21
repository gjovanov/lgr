/** Subscriptions module SQLite schema */
export const subscriptionsSchema = `
-- ══════════════════════════════════════════
-- SUBSCRIPTIONS TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  partner_id TEXT NOT NULL REFERENCES contacts(id),
  state TEXT NOT NULL DEFAULT 'draft',
  lines TEXT NOT NULL DEFAULT '[]',
  recurring_interval INTEGER NOT NULL DEFAULT 1,
  recurring_period TEXT NOT NULL DEFAULT 'month',
  date_start TEXT NOT NULL,
  date_end TEXT,
  next_invoice_date TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  amount_recurring REAL NOT NULL DEFAULT 0,
  payment_method TEXT,
  auto_renew INTEGER NOT NULL DEFAULT 1,
  cancellation_reason TEXT,
  cancellation_date TEXT,
  invoice_ids TEXT NOT NULL DEFAULT '[]',
  sales_order_id TEXT REFERENCES sales_orders(id),
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, name)
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_state ON subscriptions(org_id, state, next_invoice_date);
`
