/** CRM module SQLite schema */
export const crmSchema = `
-- ══════════════════════════════════════════
-- CRM TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  source TEXT NOT NULL CHECK(source IN ('website','referral','cold_call','email','social','event','other')),
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','qualified','unqualified','converted')),
  company_name TEXT,
  contact_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  website TEXT,
  industry TEXT,
  estimated_value REAL,
  currency TEXT,
  notes TEXT,
  assigned_to TEXT,
  converted_to_contact_id TEXT,
  converted_to_deal_id TEXT,
  converted_at TEXT,
  tags TEXT DEFAULT '[]',
  custom_fields TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_leads_org_status ON leads(org_id, status);
CREATE INDEX IF NOT EXISTS idx_leads_org_assigned ON leads(org_id, assigned_to);
CREATE INDEX IF NOT EXISTS idx_leads_org_source ON leads(org_id, source);

CREATE TABLE IF NOT EXISTS pipelines (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, name)
);

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id TEXT PRIMARY KEY,
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  probability REAL NOT NULL,
  color TEXT NOT NULL,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  contact_id TEXT NOT NULL REFERENCES contacts(id),
  stage TEXT NOT NULL,
  pipeline_id TEXT NOT NULL REFERENCES pipelines(id),
  value REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  probability REAL NOT NULL,
  expected_close_date TEXT,
  actual_close_date TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','won','lost')),
  lost_reason TEXT,
  assigned_to TEXT NOT NULL,
  notes TEXT,
  tags TEXT DEFAULT '[]',
  custom_fields TEXT DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_deals_org_pipeline ON deals(org_id, pipeline_id, stage);
CREATE INDEX IF NOT EXISTS idx_deals_org_contact ON deals(org_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_deals_org_assigned ON deals(org_id, assigned_to);
CREATE INDEX IF NOT EXISTS idx_deals_org_status ON deals(org_id, status, expected_close_date);

CREATE TABLE IF NOT EXISTS deal_products (
  id TEXT PRIMARY KEY,
  deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  quantity REAL NOT NULL,
  unit_price REAL NOT NULL,
  discount REAL,
  total REAL NOT NULL,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS activities (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  type TEXT NOT NULL CHECK(type IN ('call','email','meeting','task','note','follow_up')),
  subject TEXT NOT NULL,
  description TEXT,
  contact_id TEXT,
  deal_id TEXT,
  lead_id TEXT,
  assigned_to TEXT NOT NULL,
  due_date TEXT,
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','cancelled')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK(priority IN ('low','medium','high')),
  duration INTEGER,
  outcome TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activities_assigned ON activities(org_id, assigned_to, status, due_date);
CREATE INDEX IF NOT EXISTS idx_activities_contact ON activities(org_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_activities_deal ON activities(org_id, deal_id);
`
