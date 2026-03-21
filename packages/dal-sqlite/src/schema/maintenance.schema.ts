/** Maintenance module SQLite schema */
export const maintenanceSchema = `
-- ══════════════════════════════════════════
-- MAINTENANCE TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS equipment (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  category_id TEXT,
  location TEXT,
  assigned_to_id TEXT,
  serial_number TEXT,
  purchase_date TEXT,
  warranty_expiry TEXT,
  maintenance_team_id TEXT,
  expected_mtbf REAL,
  mttr REAL,
  next_preventive_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS maintenance_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  equipment_id TEXT NOT NULL REFERENCES equipment(id),
  type TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  state TEXT NOT NULL DEFAULT 'new',
  assignee_id TEXT,
  scheduled_date TEXT NOT NULL,
  completed_date TEXT,
  duration REAL,
  description TEXT,
  notes TEXT,
  is_recurring INTEGER NOT NULL DEFAULT 0,
  recurring_days INTEGER,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_maintenance_state ON maintenance_requests(org_id, state, scheduled_date);
`
