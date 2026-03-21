/** Manufacturing module SQLite schema */
export const manufacturingSchema = `
-- ══════════════════════════════════════════
-- MANUFACTURING TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS work_centers (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  capacity REAL NOT NULL DEFAULT 1,
  cost_per_hour REAL NOT NULL DEFAULT 0,
  setup_time REAL NOT NULL DEFAULT 0,
  cleanup_time REAL NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, code)
);

CREATE TABLE IF NOT EXISTS routings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  product_id TEXT REFERENCES products(id),
  bom_id TEXT REFERENCES bill_of_materials(id),
  steps TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ecos (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id),
  bom_id TEXT REFERENCES bill_of_materials(id),
  state TEXT NOT NULL DEFAULT 'draft',
  type TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  changes TEXT NOT NULL DEFAULT '[]',
  requester_id TEXT NOT NULL,
  reviewer_id TEXT,
  approved_date TEXT,
  applied_date TEXT,
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ecos_state ON ecos(org_id, state);
`
