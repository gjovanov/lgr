/** Recruitment module SQLite schema */
export const recruitmentSchema = `
-- ══════════════════════════════════════════
-- RECRUITMENT TABLES
-- ══════════════════════════════════════════

CREATE TABLE IF NOT EXISTS job_positions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  department_id TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  requirements TEXT,
  salary_min REAL,
  salary_max REAL,
  salary_currency TEXT NOT NULL DEFAULT 'EUR',
  state TEXT NOT NULL DEFAULT 'draft',
  published_date TEXT,
  closing_date TEXT,
  expected_hires INTEGER NOT NULL DEFAULT 1,
  hired_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS applicants (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  job_position_id TEXT NOT NULL REFERENCES job_positions(id),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  stage_name TEXT NOT NULL DEFAULT 'New',
  source TEXT NOT NULL DEFAULT 'other',
  referrer_id TEXT,
  resume_file_id TEXT,
  rating INTEGER NOT NULL DEFAULT 0,
  interview_date TEXT,
  notes TEXT,
  state TEXT NOT NULL DEFAULT 'new',
  salary REAL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_applicants_job ON applicants(org_id, job_position_id, state);

CREATE TABLE IF NOT EXISTS appraisals (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  employee_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft',
  date_scheduled TEXT NOT NULL,
  date_completed TEXT,
  self_evaluation TEXT NOT NULL DEFAULT '[]',
  manager_evaluation TEXT NOT NULL DEFAULT '[]',
  overall_rating INTEGER NOT NULL DEFAULT 0,
  goals TEXT NOT NULL DEFAULT '[]',
  next_appraisal_date TEXT,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`
