/** Planning module SQLite schema */
export const planningSchema = `
-- ══════════════════════════════════════════
-- PLANNING TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  employee_id TEXT,
  role_id TEXT,
  project_id TEXT REFERENCES projects(id),
  task_id TEXT REFERENCES project_tasks(id),
  date_start TEXT NOT NULL,
  date_end TEXT NOT NULL,
  hours REAL NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  is_recurring INTEGER NOT NULL DEFAULT 0,
  recurring_template_id TEXT REFERENCES shift_templates(id),
  notes TEXT,
  color TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_shifts_employee ON shifts(org_id, employee_id, date_start);

CREATE TABLE IF NOT EXISTS shift_templates (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  entries TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS appointment_types (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  duration INTEGER NOT NULL DEFAULT 30,
  assignee_ids TEXT NOT NULL DEFAULT '[]',
  location TEXT NOT NULL DEFAULT 'online',
  auto_confirm INTEGER NOT NULL DEFAULT 0,
  reminder_minutes TEXT NOT NULL DEFAULT '[1440,60]',
  custom_questions TEXT NOT NULL DEFAULT '[]',
  is_public INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  type_id TEXT NOT NULL REFERENCES appointment_types(id),
  partner_id TEXT REFERENCES contacts(id),
  assignee_id TEXT NOT NULL,
  date_start TEXT NOT NULL,
  date_end TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'scheduled',
  meeting_url TEXT,
  notes TEXT,
  answers TEXT NOT NULL DEFAULT '[]',
  lead_id TEXT REFERENCES leads(id),
  reminders_sent TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_appointments_assignee ON appointments(org_id, assignee_id, date_start);
`
