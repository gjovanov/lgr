/** Fleet module SQLite schema */
export const fleetSchema = `
-- ══════════════════════════════════════════
-- FLEET TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  model TEXT NOT NULL,
  brand TEXT NOT NULL,
  driver_id TEXT,
  state TEXT NOT NULL DEFAULT 'active',
  acquisition_date TEXT,
  purchase_value REAL,
  fuel_type TEXT NOT NULL DEFAULT 'gasoline',
  odometer REAL NOT NULL DEFAULT 0,
  next_service_date TEXT,
  insurance_expiry TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, name)
);

CREATE TABLE IF NOT EXISTS vehicle_costs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  type TEXT NOT NULL,
  amount REAL NOT NULL,
  date TEXT NOT NULL,
  vendor_id TEXT REFERENCES contacts(id),
  odometer REAL,
  description TEXT,
  is_recurring INTEGER NOT NULL DEFAULT 0,
  recurring_interval INTEGER,
  recurring_period TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vehicle_costs_vehicle ON vehicle_costs(org_id, vehicle_id, date);
`
