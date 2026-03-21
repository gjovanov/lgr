/** Documents module SQLite schema */
export const documentsSchema = `
-- ══════════════════════════════════════════
-- DOCUMENTS TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS document_workspaces (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  description TEXT,
  parent_id TEXT REFERENCES document_workspaces(id),
  color TEXT,
  owner_id TEXT NOT NULL,
  member_ids TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  workspace_id TEXT NOT NULL REFERENCES document_workspaces(id),
  folder_id TEXT,
  file_id TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  tags TEXT DEFAULT '[]',
  owner_id TEXT NOT NULL,
  access_level TEXT NOT NULL DEFAULT 'workspace',
  shared_with TEXT NOT NULL DEFAULT '[]',
  share_link TEXT,
  share_link_expiry TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  versions TEXT NOT NULL DEFAULT '[]',
  related_entity_type TEXT,
  related_entity_id TEXT,
  is_archived INTEGER NOT NULL DEFAULT 0,
  ocr_data TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_documents_workspace ON documents(org_id, workspace_id, is_archived);

CREATE TABLE IF NOT EXISTS signature_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  document_id TEXT NOT NULL REFERENCES documents(id),
  state TEXT NOT NULL DEFAULT 'draft',
  signers TEXT NOT NULL DEFAULT '[]',
  sequential_signing INTEGER NOT NULL DEFAULT 0,
  expiry_date TEXT,
  reminder_interval_days INTEGER,
  completed_date TEXT,
  audit_trail TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signature_requests_state ON signature_requests(org_id, state);
`
