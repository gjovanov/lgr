/** Sync & migration system tables */
export const syncSchema = `
-- ══════════════════════════════════════════
-- SYNC & MIGRATION TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS _changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('INSERT','UPDATE','DELETE')),
  data TEXT,
  old_data TEXT,
  timestamp TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f', 'now')),
  device_id TEXT NOT NULL,
  synced INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_changes_pending ON _changes(synced, seq);
CREATE INDEX IF NOT EXISTS idx_changes_table_row ON _changes(table_name, row_id);

CREATE TABLE IF NOT EXISTS _sync_state (
  peer_device_id TEXT PRIMARY KEY,
  last_received_seq INTEGER NOT NULL DEFAULT 0,
  last_sent_seq INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  peer_name TEXT,
  peer_address TEXT
);

CREATE TABLE IF NOT EXISTS _device_info (
  device_id TEXT PRIMARY KEY,
  device_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS _conflict_log (
  id TEXT PRIMARY KEY,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  local_data TEXT NOT NULL,
  remote_data TEXT NOT NULL,
  resolution TEXT CHECK(resolution IN ('local_wins','remote_wins','merged','pending')),
  resolved_data TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS _id_map (
  sqlite_id TEXT NOT NULL,
  mongo_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  PRIMARY KEY (table_name, sqlite_id),
  UNIQUE (table_name, mongo_id)
);

CREATE TABLE IF NOT EXISTS _migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`
