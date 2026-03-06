/** ERP module SQLite schema */
export const erpSchema = `
-- ══════════════════════════════════════════
-- ERP TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS bill_of_materials (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','obsolete')),
  labor_hours REAL NOT NULL,
  labor_cost_per_hour REAL NOT NULL,
  overhead_cost REAL NOT NULL DEFAULT 0,
  total_material_cost REAL NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  instructions TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bom_org_product ON bill_of_materials(org_id, product_id);

CREATE TABLE IF NOT EXISTS bom_materials (
  id TEXT PRIMARY KEY,
  bom_id TEXT NOT NULL REFERENCES bill_of_materials(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,
  wastage_percent REAL NOT NULL DEFAULT 0,
  cost REAL NOT NULL,
  notes TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS production_orders (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  order_number TEXT NOT NULL,
  bom_id TEXT NOT NULL REFERENCES bill_of_materials(id),
  product_id TEXT NOT NULL REFERENCES products(id),
  quantity REAL NOT NULL,
  warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  output_warehouse_id TEXT NOT NULL REFERENCES warehouses(id),
  status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','quality_check','completed','cancelled')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
  planned_start_date TEXT NOT NULL,
  planned_end_date TEXT NOT NULL,
  actual_start_date TEXT,
  actual_end_date TEXT,
  quantity_produced REAL NOT NULL DEFAULT 0,
  quantity_defective REAL NOT NULL DEFAULT 0,
  total_cost REAL NOT NULL DEFAULT 0,
  cost_per_unit REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, order_number)
);
CREATE INDEX IF NOT EXISTS idx_po_org_status ON production_orders(org_id, status, planned_start_date);
CREATE INDEX IF NOT EXISTS idx_po_org_product ON production_orders(org_id, product_id);

CREATE TABLE IF NOT EXISTS production_stages (
  id TEXT PRIMARY KEY,
  production_order_id TEXT NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','skipped')),
  planned_duration REAL NOT NULL,
  actual_duration REAL,
  assigned_to TEXT,
  started_at TEXT,
  completed_at TEXT,
  notes TEXT,
  quality_checks TEXT DEFAULT '[]',
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS materials_consumed (
  id TEXT PRIMARY KEY,
  production_order_id TEXT NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL REFERENCES products(id),
  planned_quantity REAL NOT NULL,
  actual_quantity REAL NOT NULL DEFAULT 0,
  wastage REAL NOT NULL DEFAULT 0,
  movement_id TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS construction_projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  project_number TEXT NOT NULL,
  name TEXT NOT NULL,
  client_id TEXT NOT NULL,
  address TEXT,
  status TEXT NOT NULL DEFAULT 'planning' CHECK(status IN ('planning','active','on_hold','completed','cancelled')),
  start_date TEXT NOT NULL,
  expected_end_date TEXT NOT NULL,
  actual_end_date TEXT,
  budget TEXT NOT NULL DEFAULT '{}',
  total_invoiced REAL NOT NULL DEFAULT 0,
  total_paid REAL NOT NULL DEFAULT 0,
  margin REAL NOT NULL DEFAULT 0,
  documents TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, project_number)
);
CREATE INDEX IF NOT EXISTS idx_cp_org_client ON construction_projects(org_id, client_id);
CREATE INDEX IF NOT EXISTS idx_cp_org_status ON construction_projects(org_id, status);

CREATE TABLE IF NOT EXISTS construction_phases (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed')),
  start_date TEXT,
  end_date TEXT,
  budget REAL NOT NULL,
  spent REAL NOT NULL DEFAULT 0,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS construction_phase_tasks (
  id TEXT PRIMARY KEY,
  phase_id TEXT NOT NULL REFERENCES construction_phases(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  assigned_to TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed')),
  due_date TEXT,
  completed_at TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS construction_team_members (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL,
  role TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS construction_materials (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES construction_projects(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_cost REAL NOT NULL,
  total_cost REAL NOT NULL,
  delivery_date TEXT,
  status TEXT NOT NULL DEFAULT 'ordered' CHECK(status IN ('ordered','delivered','installed')),
  movement_id TEXT,
  sort_order INTEGER DEFAULT 0
);

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
