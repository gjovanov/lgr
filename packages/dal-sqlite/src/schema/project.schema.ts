/** Project module SQLite schema */
export const projectSchema = `
-- ══════════════════════════════════════════
-- PROJECT TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  description TEXT,
  partner_id TEXT REFERENCES contacts(id),
  state TEXT NOT NULL DEFAULT 'active',
  date_start TEXT,
  date_end TEXT,
  manager_id TEXT NOT NULL,
  member_ids TEXT NOT NULL DEFAULT '[]',
  stages TEXT NOT NULL DEFAULT '[]',
  color TEXT,
  tags TEXT DEFAULT '[]',
  budget_planned REAL NOT NULL DEFAULT 0,
  budget_spent REAL NOT NULL DEFAULT 0,
  revenue_expected REAL NOT NULL DEFAULT 0,
  revenue_invoiced REAL NOT NULL DEFAULT 0,
  is_favorite INTEGER NOT NULL DEFAULT 0,
  sales_order_id TEXT REFERENCES sales_orders(id),
  room_id TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_projects_state ON projects(org_id, state);

CREATE TABLE IF NOT EXISTS project_tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  description TEXT,
  stage_name TEXT NOT NULL DEFAULT 'To Do',
  state TEXT NOT NULL DEFAULT 'open',
  priority TEXT NOT NULL DEFAULT 'normal',
  assignee_ids TEXT NOT NULL DEFAULT '[]',
  parent_task_id TEXT REFERENCES project_tasks(id),
  dependency_ids TEXT NOT NULL DEFAULT '[]',
  date_deadline TEXT,
  date_start TEXT,
  date_end TEXT,
  planned_hours REAL NOT NULL DEFAULT 0,
  effective_hours REAL NOT NULL DEFAULT 0,
  remaining_hours REAL NOT NULL DEFAULT 0,
  milestone_id TEXT REFERENCES project_milestones(id),
  tags TEXT DEFAULT '[]',
  is_recurring INTEGER NOT NULL DEFAULT 0,
  recurring_interval INTEGER,
  recurring_period TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_project_tasks_project ON project_tasks(org_id, project_id, state);

CREATE TABLE IF NOT EXISTS project_milestones (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  deadline TEXT NOT NULL,
  is_reached INTEGER NOT NULL DEFAULT 0,
  reached_date TEXT,
  sales_order_line_index INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project_timesheets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  employee_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects(id),
  task_id TEXT REFERENCES project_tasks(id),
  date TEXT NOT NULL,
  hours REAL NOT NULL,
  description TEXT,
  unit_amount REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_project_timesheets_emp ON project_timesheets(org_id, employee_id, date);
CREATE INDEX IF NOT EXISTS idx_project_timesheets_proj ON project_timesheets(org_id, project_id, date);
`
