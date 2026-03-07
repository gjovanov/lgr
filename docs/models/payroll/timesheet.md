# Timesheet

## Entity Interface

```typescript
export interface ITimesheet extends TenantEntity {
  employeeId: string
  date: Date
  hoursWorked: number
  overtimeHours: number
  type: string
  projectId?: string
  description?: string
  status: string
  approvedBy?: string
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS timesheets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  date TEXT NOT NULL,
  hours_worked REAL NOT NULL,
  overtime_hours REAL NOT NULL DEFAULT 0,
  type TEXT NOT NULL CHECK(type IN ('regular','overtime','holiday','sick','vacation')),
  project_id TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','approved','rejected')),
  approved_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_timesheets_emp ON timesheets(org_id, employee_id, date DESC);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string | Yes | - | Tenant organization ID |
| employeeId | string | Yes | - | Reference to the Employee |
| date | Date | Yes | - | Date of the timesheet entry |
| hoursWorked | number | Yes | - | Regular hours worked |
| overtimeHours | number | Yes | 0 | Overtime hours worked |
| type | string | Yes | - | `regular`, `overtime`, `holiday`, `sick`, `vacation` |
| projectId | string | No | - | Optional project reference |
| description | string | No | - | Description of work performed |
| status | string | Yes | `submitted` | `submitted`, `approved`, `rejected` |
| approvedBy | string | No | - | User ID who approved the timesheet |
| createdAt | Date | Yes | now | Record creation timestamp |
| updatedAt | Date | Yes | now | Record last-update timestamp |

## Relationships

- **Org** -- `orgId` references the tenant organization
- **Employee** -- `employeeId` references the employee who logged time
- **User** -- `approvedBy` references the approving user

## API Endpoints (prefix: `/api/org/:orgId/payroll/timesheet`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | isSignIn | List timesheets. Pagination: `page`, `size`, `sortBy`, `sortOrder`. Returns `{ timesheets, total, page, size, totalPages }` |
| POST | `/` | isSignIn | Create timesheet entry |
| GET | `/:id` | isSignIn | Get single timesheet by ID |
| PUT | `/:id` | isSignIn | Update timesheet entry |
| DELETE | `/:id` | isSignIn | Delete timesheet entry |
