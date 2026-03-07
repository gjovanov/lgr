# LeaveBalance

## Entity Interface

```typescript
export interface ILeaveBalance extends TenantEntity {
  employeeId: string
  leaveTypeId: string
  year: number
  entitled: number
  taken: number
  pending: number
  remaining: number
  carriedOver: number
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS leave_balances (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  leave_type_id TEXT NOT NULL REFERENCES leave_types(id),
  year INTEGER NOT NULL,
  entitled REAL NOT NULL,
  taken REAL NOT NULL DEFAULT 0,
  pending REAL NOT NULL DEFAULT 0,
  remaining REAL NOT NULL,
  carried_over REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, employee_id, leave_type_id, year)
);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string | Yes | - | Tenant organization ID |
| employeeId | string | Yes | - | Reference to the Employee |
| leaveTypeId | string | Yes | - | Reference to the LeaveType |
| year | number | Yes | - | Calendar year this balance applies to |
| entitled | number | Yes | - | Total days entitled for the year |
| taken | number | Yes | 0 | Days already taken (approved leave) |
| pending | number | Yes | 0 | Days in pending leave requests |
| remaining | number | Yes | - | Days remaining (entitled + carriedOver - taken) |
| carriedOver | number | Yes | 0 | Days carried over from previous year |
| createdAt | Date | Yes | now | Record creation timestamp |
| updatedAt | Date | Yes | now | Record last-update timestamp |

## Relationships

- **Org** -- `orgId` references the tenant organization
- **Employee** -- `employeeId` references the employee whose balance this is
- **LeaveType** -- `leaveTypeId` references the type of leave
- **LeaveRequest** -- balance is automatically updated when leave requests are created, approved, rejected, or cancelled

## API Endpoints (prefix: `/api/org/:orgId/hr/leave-balance`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | isSignIn | List leave balances. Pagination: `page`, `size`, `sortBy`, `sortOrder`. Returns `{ leaveBalances, total, page, size, totalPages }`. Note: this is a read-only endpoint; balances are managed automatically by the leave request workflow. |
