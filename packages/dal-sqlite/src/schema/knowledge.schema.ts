/** Knowledge module SQLite schema */
export const knowledgeSchema = `
-- ══════════════════════════════════════════
-- KNOWLEDGE TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS knowledge_articles (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  parent_id TEXT REFERENCES knowledge_articles(id),
  author_id TEXT NOT NULL,
  last_editor_id TEXT NOT NULL,
  access_level TEXT NOT NULL DEFAULT 'internal',
  shared_with TEXT NOT NULL DEFAULT '[]',
  tags TEXT DEFAULT '[]',
  is_favorite INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  versions TEXT NOT NULL DEFAULT '[]',
  is_published INTEGER NOT NULL DEFAULT 0,
  related_entity_type TEXT,
  related_entity_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_knowledge_articles_published ON knowledge_articles(org_id, is_published, access_level);
`
