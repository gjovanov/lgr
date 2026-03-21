/** Helpdesk module SQLite schema */
export const helpdeskSchema = `
-- ══════════════════════════════════════════
-- HELPDESK TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tickets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  channel_source TEXT NOT NULL DEFAULT 'manual',
  partner_id TEXT REFERENCES contacts(id),
  assignee_id TEXT,
  team_id TEXT REFERENCES helpdesk_teams(id),
  stage_name TEXT NOT NULL DEFAULT 'New',
  state TEXT NOT NULL DEFAULT 'new',
  priority TEXT NOT NULL DEFAULT 'normal',
  sla_deadline TEXT,
  sla_status TEXT NOT NULL DEFAULT 'on_track',
  tags TEXT DEFAULT '[]',
  category_id TEXT,
  rating INTEGER,
  rating_comment TEXT,
  total_hours REAL NOT NULL DEFAULT 0,
  room_id TEXT,
  related_entity_type TEXT,
  related_entity_id TEXT,
  first_response_date TEXT,
  resolution_date TEXT,
  closed_date TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, name)
);
CREATE INDEX IF NOT EXISTS idx_tickets_state_sla ON tickets(org_id, state, sla_deadline);
CREATE INDEX IF NOT EXISTS idx_tickets_assignee ON tickets(org_id, assignee_id, state);

CREATE TABLE IF NOT EXISTS helpdesk_teams (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  member_ids TEXT NOT NULL DEFAULT '[]',
  leader_id TEXT NOT NULL,
  assignment_method TEXT NOT NULL DEFAULT 'manual',
  email_alias TEXT,
  description TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, name)
);

CREATE TABLE IF NOT EXISTS sla_policies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  team_id TEXT REFERENCES helpdesk_teams(id),
  priority TEXT NOT NULL,
  targets TEXT NOT NULL DEFAULT '{}',
  escalate_to TEXT,
  business_hours_only INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`
