/** Sales module SQLite schema */
export const salesSchema = `
-- ══════════════════════════════════════════
-- SALES TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sales_orders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  partner_id TEXT NOT NULL REFERENCES contacts(id),
  partner_shipping_id TEXT REFERENCES contact_addresses(id),
  partner_invoice_id TEXT REFERENCES contact_addresses(id),
  date_order TEXT,
  validity_date TEXT,
  commitment_date TEXT,
  pricelist_id TEXT REFERENCES price_lists(id),
  currency TEXT NOT NULL DEFAULT 'EUR',
  exchange_rate REAL NOT NULL DEFAULT 1,
  lines TEXT NOT NULL DEFAULT '[]',
  amount_untaxed REAL NOT NULL DEFAULT 0,
  amount_tax REAL NOT NULL DEFAULT 0,
  amount_total REAL NOT NULL DEFAULT 0,
  invoice_status TEXT NOT NULL DEFAULT 'nothing',
  delivery_status TEXT NOT NULL DEFAULT 'pending',
  invoice_ids TEXT NOT NULL DEFAULT '[]',
  movement_ids TEXT NOT NULL DEFAULT '[]',
  template_id TEXT REFERENCES quotation_templates(id),
  notes TEXT,
  terms_and_conditions TEXT,
  require_signature INTEGER NOT NULL DEFAULT 0,
  require_payment INTEGER NOT NULL DEFAULT 0,
  signed_by TEXT,
  signed_on TEXT,
  user_id TEXT NOT NULL,
  tags TEXT DEFAULT '[]',
  sent_at TEXT,
  confirmed_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, name)
);
CREATE INDEX IF NOT EXISTS idx_sales_orders_state ON sales_orders(org_id, state);
CREATE INDEX IF NOT EXISTS idx_sales_orders_partner ON sales_orders(org_id, partner_id);

CREATE TABLE IF NOT EXISTS quotation_templates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  lines TEXT NOT NULL DEFAULT '[]',
  optional_product_ids TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  terms_and_conditions TEXT,
  validity_days INTEGER NOT NULL DEFAULT 30,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, name)
);
`
