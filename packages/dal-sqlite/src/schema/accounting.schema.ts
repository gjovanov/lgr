/** Accounting module SQLite schema */
export const accountingSchema = `
-- ══════════════════════════════════════════
-- ACCOUNTING TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('asset','liability','equity','revenue','expense')),
  sub_type TEXT NOT NULL,
  parent_id TEXT REFERENCES accounts(id),
  currency TEXT,
  description TEXT,
  is_system INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  balance REAL NOT NULL DEFAULT 0,
  tags TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, code)
);
CREATE INDEX IF NOT EXISTS idx_accounts_org_type ON accounts(org_id, type);
CREATE INDEX IF NOT EXISTS idx_accounts_org_parent ON accounts(org_id, parent_id);

CREATE TABLE IF NOT EXISTS fiscal_years (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','locked')),
  closing_entry_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, start_date)
);

CREATE TABLE IF NOT EXISTS fiscal_periods (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  fiscal_year_id TEXT NOT NULL REFERENCES fiscal_years(id),
  name TEXT NOT NULL,
  number INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','locked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, fiscal_year_id, number)
);

CREATE TABLE IF NOT EXISTS journal_entries (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  entry_number TEXT NOT NULL,
  date TEXT NOT NULL,
  fiscal_period_id TEXT NOT NULL REFERENCES fiscal_periods(id),
  description TEXT NOT NULL,
  reference TEXT,
  type TEXT NOT NULL DEFAULT 'standard' CHECK(type IN ('standard','adjusting','closing','reversing','opening')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','voided')),
  total_debit REAL NOT NULL DEFAULT 0,
  total_credit REAL NOT NULL DEFAULT 0,
  attachments TEXT NOT NULL DEFAULT '[]',
  source_module TEXT,
  source_id TEXT,
  created_by TEXT NOT NULL,
  posted_by TEXT,
  posted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, entry_number)
);
CREATE INDEX IF NOT EXISTS idx_je_org_date ON journal_entries(org_id, date DESC);
CREATE INDEX IF NOT EXISTS idx_je_org_status ON journal_entries(org_id, status);
CREATE INDEX IF NOT EXISTS idx_je_org_period ON journal_entries(org_id, fiscal_period_id);

CREATE TABLE IF NOT EXISTS journal_entry_lines (
  id TEXT PRIMARY KEY,
  journal_entry_id TEXT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  description TEXT,
  debit REAL NOT NULL DEFAULT 0,
  credit REAL NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'EUR',
  exchange_rate REAL NOT NULL DEFAULT 1,
  base_debit REAL NOT NULL DEFAULT 0,
  base_credit REAL NOT NULL DEFAULT 0,
  contact_id TEXT,
  project_id TEXT,
  cost_center_id TEXT,
  tags TEXT DEFAULT '[]',
  sort_order INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_jel_entry ON journal_entry_lines(journal_entry_id);
CREATE INDEX IF NOT EXISTS idx_jel_account ON journal_entry_lines(account_id);

CREATE TABLE IF NOT EXISTS fixed_assets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  depreciation_account_id TEXT NOT NULL REFERENCES accounts(id),
  accumulated_dep_account_id TEXT NOT NULL REFERENCES accounts(id),
  purchase_date TEXT NOT NULL,
  purchase_price REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  salvage_value REAL NOT NULL DEFAULT 0,
  useful_life_months INTEGER NOT NULL,
  depreciation_method TEXT NOT NULL CHECK(depreciation_method IN ('straight_line','declining_balance','units_of_production')),
  current_value REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disposed','fully_depreciated')),
  disposal_date TEXT,
  disposal_price REAL,
  location TEXT,
  assigned_to TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, code)
);
CREATE INDEX IF NOT EXISTS idx_fa_org_category ON fixed_assets(org_id, category);

CREATE TABLE IF NOT EXISTS fixed_asset_depreciation (
  id TEXT PRIMARY KEY,
  fixed_asset_id TEXT NOT NULL REFERENCES fixed_assets(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  amount REAL NOT NULL,
  accumulated_amount REAL NOT NULL,
  book_value REAL NOT NULL,
  journal_entry_id TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bank_accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  bank_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  iban TEXT,
  swift TEXT,
  currency TEXT NOT NULL DEFAULT 'EUR',
  account_id TEXT NOT NULL REFERENCES accounts(id),
  balance REAL NOT NULL DEFAULT 0,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_reconciled_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, account_number)
);

CREATE TABLE IF NOT EXISTS bank_reconciliations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  bank_account_id TEXT NOT NULL REFERENCES bank_accounts(id),
  statement_date TEXT NOT NULL,
  statement_balance REAL NOT NULL,
  book_balance REAL NOT NULL,
  difference REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','completed')),
  reconciled_by TEXT,
  reconciled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_br_org_bank ON bank_reconciliations(org_id, bank_account_id, statement_date DESC);

CREATE TABLE IF NOT EXISTS bank_reconciliation_items (
  id TEXT PRIMARY KEY,
  reconciliation_id TEXT NOT NULL REFERENCES bank_reconciliations(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('deposit','withdrawal')),
  matched INTEGER NOT NULL DEFAULT 0,
  journal_entry_id TEXT,
  bank_reference TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tax_returns (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  type TEXT NOT NULL CHECK(type IN ('vat','income_tax','corporate_tax','payroll_tax')),
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','filed','paid')),
  total_tax REAL NOT NULL DEFAULT 0,
  total_input REAL NOT NULL DEFAULT 0,
  total_output REAL NOT NULL DEFAULT 0,
  net_payable REAL NOT NULL DEFAULT 0,
  filed_at TEXT,
  filed_by TEXT,
  attachments TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tr_org_type ON tax_returns(org_id, type, period_from DESC);

CREATE TABLE IF NOT EXISTS tax_return_lines (
  id TEXT PRIMARY KEY,
  tax_return_id TEXT NOT NULL REFERENCES tax_returns(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  taxable_amount REAL NOT NULL,
  tax_rate REAL NOT NULL,
  tax_amount REAL NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS exchange_rates (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  from_currency TEXT NOT NULL,
  to_currency TEXT NOT NULL,
  rate REAL NOT NULL,
  date TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','api')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_er_currencies ON exchange_rates(org_id, from_currency, to_currency, date DESC);
`
