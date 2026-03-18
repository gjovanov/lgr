/** Invoicing module SQLite schema */
export const invoicingSchema = `
-- ══════════════════════════════════════════
-- INVOICING TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  type TEXT NOT NULL CHECK(type IN ('customer','supplier','both')),
  company_name TEXT,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  mobile TEXT,
  website TEXT,
  tax_id TEXT,
  tax_number TEXT,
  vat_number TEXT,
  registration_number TEXT,
  currency TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 30,
  credit_limit REAL,
  discount REAL,
  notes TEXT,
  tags TEXT DEFAULT '[]',
  account_receivable_id TEXT,
  account_payable_id TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_contacts_org_type ON contacts(org_id, type);
CREATE INDEX IF NOT EXISTS idx_contacts_org_email ON contacts(org_id, email);
CREATE INDEX IF NOT EXISTS idx_contacts_org_company ON contacts(org_id, company_name);
CREATE INDEX IF NOT EXISTS idx_contacts_org_tax ON contacts(org_id, tax_id);
CREATE INDEX IF NOT EXISTS idx_contacts_org_tax_num ON contacts(org_id, tax_number);
CREATE INDEX IF NOT EXISTS idx_contacts_org_vat ON contacts(org_id, vat_number);

CREATE TABLE IF NOT EXISTS contact_addresses (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('billing','shipping','office')),
  street TEXT NOT NULL,
  street2 TEXT,
  city TEXT NOT NULL,
  state TEXT,
  postal_code TEXT NOT NULL,
  country TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS contact_bank_details (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  bank_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  iban TEXT,
  swift TEXT,
  currency TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  invoice_number TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('invoice','proforma','credit_note','debit_note')),
  direction TEXT NOT NULL CHECK(direction IN ('outgoing','incoming')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','sent','partially_paid','paid','overdue','voided','cancelled','converted')),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  exchange_rate REAL NOT NULL DEFAULT 1,
  reference TEXT,
  subtotal REAL NOT NULL DEFAULT 0,
  discount_total REAL NOT NULL DEFAULT 0,
  tax_total REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  total_base REAL NOT NULL DEFAULT 0,
  amount_paid REAL NOT NULL DEFAULT 0,
  amount_due REAL NOT NULL DEFAULT 0,
  notes TEXT,
  terms TEXT,
  footer TEXT,
  billing_address TEXT NOT NULL,
  shipping_address TEXT,
  related_invoice_id TEXT REFERENCES invoices(id),
  converted_invoice_id TEXT REFERENCES invoices(id),
  proforma_id TEXT REFERENCES invoices(id),
  journal_entry_id TEXT,
  recurring_config TEXT,
  attachments TEXT DEFAULT '[]',
  sent_at TEXT,
  paid_at TEXT,
  tags TEXT DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, invoice_number)
);
CREATE INDEX IF NOT EXISTS idx_invoices_org_contact ON invoices(org_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_invoices_org_status ON invoices(org_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_org_dir_date ON invoices(org_id, direction, issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_invoices_org_due ON invoices(org_id, due_date, status);

CREATE TABLE IF NOT EXISTS invoice_lines (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  product_id TEXT,
  description TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  unit_price REAL NOT NULL,
  discount REAL NOT NULL DEFAULT 0,
  tax_rate REAL NOT NULL,
  tax_amount REAL NOT NULL,
  line_total REAL NOT NULL,
  account_id TEXT,
  warehouse_id TEXT,
  price_explanation TEXT DEFAULT '[]',
  sort_order INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_il_invoice ON invoice_lines(invoice_id);

CREATE TABLE IF NOT EXISTS invoice_payments (
  id TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('cash','bank_transfer','card','check','other')),
  reference TEXT,
  bank_account_id TEXT,
  journal_entry_id TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS invoice_attachments (
  invoice_id TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  PRIMARY KEY (invoice_id, file_id)
);

CREATE TABLE IF NOT EXISTS payment_orders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  order_number TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('payment','receipt')),
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  exchange_rate REAL NOT NULL DEFAULT 1,
  invoice_ids TEXT NOT NULL DEFAULT '[]',
  reference TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','approved','executed','cancelled')),
  executed_at TEXT,
  journal_entry_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, order_number)
);

CREATE TABLE IF NOT EXISTS cash_orders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  order_number TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('receipt','disbursement')),
  contact_id TEXT,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  description TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  counter_account_id TEXT NOT NULL REFERENCES accounts(id),
  journal_entry_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, order_number)
);
`
