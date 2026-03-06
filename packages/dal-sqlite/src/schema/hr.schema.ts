/** HR module SQLite schema */
export const hrSchema = `
-- ══════════════════════════════════════════
-- HR TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS departments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  parent_id TEXT REFERENCES departments(id),
  head_id TEXT,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, code)
);

CREATE TABLE IF NOT EXISTS leave_types (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  default_days INTEGER NOT NULL,
  is_paid INTEGER NOT NULL DEFAULT 0,
  requires_approval INTEGER NOT NULL DEFAULT 1,
  color TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, code)
);

CREATE TABLE IF NOT EXISTS leave_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  leave_type_id TEXT NOT NULL REFERENCES leave_types(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days REAL NOT NULL,
  half_day INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
  approved_by TEXT,
  approved_at TEXT,
  rejection_reason TEXT,
  attachments TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lr_emp_status ON leave_requests(org_id, employee_id, status);
CREATE INDEX IF NOT EXISTS idx_lr_dates ON leave_requests(org_id, start_date, end_date);

CREATE TABLE IF NOT EXISTS leave_balances (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  leave_type_id TEXT NOT NULL REFERENCES leave_types(id),
  year INTEGER NOT NULL,
  entitled REAL NOT NULL,
  taken REAL NOT NULL DEFAULT 0,
  pending REAL NOT NULL DEFAULT 0,
  remaining REAL NOT NULL,
  carried_over REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, employee_id, leave_type_id, year)
);

CREATE TABLE IF NOT EXISTS business_trips (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  destination TEXT NOT NULL,
  purpose TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','completed','cancelled')),
  total_expenses REAL NOT NULL DEFAULT 0,
  per_diem REAL,
  advance_amount REAL,
  settlement_amount REAL,
  approved_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bt_emp ON business_trips(org_id, employee_id, start_date DESC);

CREATE TABLE IF NOT EXISTS business_trip_expenses (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES business_trips(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('transport','accommodation','meals','other')),
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  receipt TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS employee_documents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  type TEXT NOT NULL CHECK(type IN ('contract','amendment','id_copy','certificate','evaluation','warning','other')),
  title TEXT NOT NULL,
  description TEXT,
  file_id TEXT NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  is_confidential INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ed_emp_type ON employee_documents(org_id, employee_id, type);
`
