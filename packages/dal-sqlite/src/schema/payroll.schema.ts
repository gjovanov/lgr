/** Payroll module SQLite schema */
export const payrollSchema = `
-- ══════════════════════════════════════════
-- PAYROLL TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT,
  employee_number TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  date_of_birth TEXT,
  gender TEXT CHECK(gender IN ('male','female','other')),
  national_id TEXT,
  tax_id TEXT,
  address TEXT,
  department TEXT NOT NULL,
  position TEXT NOT NULL,
  manager_id TEXT,
  employment_type TEXT NOT NULL CHECK(employment_type IN ('full_time','part_time','contract','intern')),
  contract_start_date TEXT NOT NULL,
  contract_end_date TEXT,
  probation_end_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','on_leave','terminated','suspended')),
  termination_date TEXT,
  termination_reason TEXT,
  salary TEXT NOT NULL DEFAULT '{}',
  documents TEXT DEFAULT '[]',
  emergency_contact TEXT,
  notes TEXT,
  tags TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, employee_number)
);
CREATE INDEX IF NOT EXISTS idx_employees_org_dept ON employees(org_id, department);
CREATE INDEX IF NOT EXISTS idx_employees_org_status ON employees(org_id, status);
CREATE INDEX IF NOT EXISTS idx_employees_org_manager ON employees(org_id, manager_id);

CREATE TABLE IF NOT EXISTS employee_deductions (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  amount REAL,
  percentage REAL,
  account_id TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS employee_benefits (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','calculated','approved','paid','cancelled')),
  currency TEXT NOT NULL DEFAULT 'EUR',
  totals TEXT NOT NULL DEFAULT '{}',
  journal_entry_id TEXT,
  approved_by TEXT,
  approved_at TEXT,
  paid_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pr_org_period ON payroll_runs(org_id, period_from DESC);
CREATE INDEX IF NOT EXISTS idx_pr_org_status ON payroll_runs(org_id, status);

CREATE TABLE IF NOT EXISTS payroll_run_items (
  id TEXT PRIMARY KEY,
  payroll_run_id TEXT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  base_salary REAL NOT NULL,
  overtime_hours REAL NOT NULL DEFAULT 0,
  overtime_pay REAL NOT NULL DEFAULT 0,
  bonuses REAL NOT NULL DEFAULT 0,
  allowances REAL NOT NULL DEFAULT 0,
  gross_pay REAL NOT NULL,
  deductions TEXT NOT NULL DEFAULT '[]',
  total_deductions REAL NOT NULL DEFAULT 0,
  net_pay REAL NOT NULL,
  employer_contributions TEXT NOT NULL DEFAULT '[]',
  total_employer_cost REAL NOT NULL DEFAULT 0,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payslips (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  payroll_run_id TEXT NOT NULL REFERENCES payroll_runs(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  gross_pay REAL NOT NULL,
  total_deductions REAL NOT NULL DEFAULT 0,
  net_pay REAL NOT NULL,
  year_to_date TEXT NOT NULL DEFAULT '{}',
  payment_method TEXT NOT NULL CHECK(payment_method IN ('bank_transfer','cash','check')),
  payment_reference TEXT,
  status TEXT NOT NULL DEFAULT 'generated' CHECK(status IN ('generated','sent','paid')),
  sent_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payslips_emp ON payslips(org_id, employee_id, period_from DESC);

CREATE TABLE IF NOT EXISTS payslip_earnings (
  id TEXT PRIMARY KEY,
  payslip_id TEXT NOT NULL REFERENCES payslips(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  hours REAL,
  rate REAL,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payslip_deductions (
  id TEXT PRIMARY KEY,
  payslip_id TEXT NOT NULL REFERENCES payslips(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS timesheets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  date TEXT NOT NULL,
  hours_worked REAL NOT NULL,
  overtime_hours REAL NOT NULL DEFAULT 0,
  type TEXT NOT NULL CHECK(type IN ('regular','overtime','holiday','sick','vacation')),
  project_id TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','approved','rejected')),
  approved_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_timesheets_emp ON timesheets(org_id, employee_id, date DESC);
`
