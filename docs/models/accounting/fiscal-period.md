# FiscalPeriod

## Entity Interface

```typescript
export interface IFiscalPeriod extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  fiscalYearId: Types.ObjectId
  name: string
  number: number
  startDate: Date
  endDate: Date
  status: string        // 'open' | 'closed' | 'locked'
  createdAt: Date
  updatedAt: Date
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS fiscal_periods (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  fiscal_year_id TEXT NOT NULL REFERENCES fiscal_years(id),
  name TEXT NOT NULL,
  number INTEGER NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed','locked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, fiscal_year_id, number)
);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| fiscalYearId | ObjectId | Yes | - | Parent fiscal year this period belongs to |
| name | string | Yes | - | Display name (e.g., "January 2025", "Q1 2025") |
| number | number | Yes | - | Sequential period number within the fiscal year (1-12 for monthly) |
| startDate | Date | Yes | - | First day of the period |
| endDate | Date | Yes | - | Last day of the period |
| status | string | Yes | `open` | Lifecycle state: `open`, `closed`, `locked` |
| orgId | ObjectId | Yes | - | Tenant organization ID (auto-injected by tenantPlugin) |
| createdAt | Date | Auto | - | Timestamp of creation |
| updatedAt | Date | Auto | - | Timestamp of last update |

## Relationships

- **Belongs to**: `fiscalYearId` -> `FiscalYear`
- **Referenced by**: `JournalEntry.fiscalPeriodId`

## Indexes

- `(orgId, fiscalYearId, number)` -- unique

## API Endpoints (prefix: `/api/org/:orgId/accounting/fiscal-period`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | Yes | List fiscal periods (paginated). Query: `page`, `size`, `sortBy`, `sortOrder`. Default sort: `createdAt` desc. |
| POST | `/` | Yes | Create fiscal period. |
| GET | `/:id` | Yes | Get single fiscal period by ID. |
| PUT | `/:id` | Yes | Update fiscal period. |
| DELETE | `/:id` | Yes | Delete fiscal period. |
