/** Field Service module SQLite schema */
export const fieldServiceSchema = `
-- ══════════════════════════════════════════
-- FIELD SERVICE TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS field_service_tasks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  description TEXT,
  partner_id TEXT REFERENCES contacts(id),
  assignee_id TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  state TEXT NOT NULL DEFAULT 'scheduled',
  priority TEXT NOT NULL DEFAULT 'normal',
  date_scheduled TEXT NOT NULL,
  date_start TEXT,
  date_end TEXT,
  location TEXT,
  latitude REAL,
  longitude REAL,
  planned_hours REAL NOT NULL DEFAULT 0,
  effective_hours REAL NOT NULL DEFAULT 0,
  parts TEXT NOT NULL DEFAULT '[]',
  total_parts_cost REAL NOT NULL DEFAULT 0,
  total_labor_cost REAL NOT NULL DEFAULT 0,
  worksheet_notes TEXT,
  customer_signature TEXT,
  technician_signature TEXT,
  invoice_id TEXT REFERENCES invoices(id),
  sales_order_id TEXT REFERENCES sales_orders(id),
  tags TEXT DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_field_service_assignee ON field_service_tasks(org_id, assignee_id, date_scheduled);
CREATE INDEX IF NOT EXISTS idx_field_service_state ON field_service_tasks(org_id, state, date_scheduled);
`
