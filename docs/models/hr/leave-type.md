# LeaveType

## Entity Interface

```typescript
export interface ILeaveType extends TenantEntity {
  name: string
  code: string
  defaultDays: number
  isPaid: boolean
  requiresApproval: boolean
  color: string
  isActive: boolean
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS leave_types (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  code TEXT NOT NULL,
  default_days INTEGER NOT NULL,
  is_paid INTEGER NOT NULL DEFAULT 0,
  requires_approval INTEGER NOT NULL DEFAULT 1,
  color TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, code)
);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string | Yes | - | Tenant organization ID |
| name | string | Yes | - | Leave type name (e.g. "Annual Leave", "Sick Leave") |
| code | string | Yes | - | Unique leave type code within the org |
| defaultDays | number | Yes | - | Default number of days allocated per year |
| isPaid | boolean | Yes | `false` (0) | Whether this leave type is paid |
| requiresApproval | boolean | Yes | `true` (1) | Whether requests of this type require manager approval |
| color | string | Yes | - | Display color for UI (hex or named color) |
| isActive | boolean | Yes | `true` (1) | Whether the leave type is active |
| createdAt | Date | Yes | now | Record creation timestamp |
| updatedAt | Date | Yes | now | Record last-update timestamp |

## Relationships

- **Org** -- `orgId` references the tenant organization
- **LeaveRequest** -- leave requests reference this type via `leaveTypeId`
- **LeaveBalance** -- leave balances reference this type via `leaveTypeId`

## API Endpoints (prefix: `/api/org/:orgId/hr/leave-type`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | isSignIn | List leave types. Pagination: `page`, `size`, `sortBy` (default: `name`), `sortOrder` (default: `asc`). Returns `{ leaveTypes, total, page, size, totalPages }` |
| POST | `/` | isSignIn | Create leave type |
| GET | `/:id` | isSignIn | Get single leave type by ID |
| PUT | `/:id` | isSignIn | Update leave type |
| DELETE | `/:id` | isSignIn | Delete leave type |
