/** Permission Sets SQLite schema */
export const permissionSetSchema = `
-- ══════════════════════════════════════════
-- PERMISSION SETS
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS permission_sets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  description TEXT,
  permissions TEXT NOT NULL DEFAULT '[]',
  own_records_only TEXT NOT NULL DEFAULT '{}',
  is_default INTEGER NOT NULL DEFAULT 0,
  is_admin INTEGER NOT NULL DEFAULT 0,
  is_system INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, name)
);
CREATE INDEX IF NOT EXISTS idx_permission_sets_org ON permission_sets(org_id);
CREATE INDEX IF NOT EXISTS idx_permission_sets_org_default ON permission_sets(org_id, is_default);

CREATE TABLE IF NOT EXISTS user_permission_sets (
  user_id TEXT NOT NULL REFERENCES users(id),
  permission_set_id TEXT NOT NULL REFERENCES permission_sets(id),
  PRIMARY KEY (user_id, permission_set_id)
);
CREATE INDEX IF NOT EXISTS idx_user_permission_sets_user ON user_permission_sets(user_id);
`
