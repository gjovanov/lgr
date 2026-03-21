/** Approvals module SQLite schema */
export const approvalsSchema = `
-- ══════════════════════════════════════════
-- APPROVALS TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS approval_types (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  description TEXT,
  steps TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  type_id TEXT NOT NULL REFERENCES approval_types(id),
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  current_step INTEGER NOT NULL DEFAULT 1,
  steps TEXT NOT NULL DEFAULT '[]',
  requested_date TEXT NOT NULL,
  decided_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_approval_requests_entity ON approval_requests(org_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_approval_requests_state ON approval_requests(org_id, state);
`
