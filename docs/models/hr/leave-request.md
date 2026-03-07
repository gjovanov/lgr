# LeaveRequest

## Entity Interface

```typescript
export interface ILeaveRequest extends TenantEntity {
  employeeId: string
  leaveTypeId: string
  startDate: Date
  endDate: Date
  days: number
  halfDay: boolean
  reason?: string
  status: string
  approvedBy?: string
  approvedAt?: Date
  rejectionReason?: string
  attachments: string[]
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS leave_requests (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  leave_type_id TEXT NOT NULL REFERENCES leave_types(id),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days REAL NOT NULL,
  half_day INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
  approved_by TEXT,
  approved_at TEXT,
  rejection_reason TEXT,
  attachments TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_lr_emp_status ON leave_requests(org_id, employee_id, status);
CREATE INDEX IF NOT EXISTS idx_lr_dates ON leave_requests(org_id, start_date, end_date);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string | Yes | - | Tenant organization ID |
| employeeId | string | Yes | - | Reference to the Employee requesting leave |
| leaveTypeId | string | Yes | - | Reference to the LeaveType |
| startDate | Date | Yes | - | Leave start date |
| endDate | Date | Yes | - | Leave end date |
| days | number | Yes | - | Number of leave days (minimum 0.5) |
| halfDay | boolean | Yes | `false` (0) | Whether this is a half-day request |
| reason | string | No | - | Reason for the leave |
| status | string | Yes | `pending` | `pending`, `approved`, `rejected`, `cancelled` |
| approvedBy | string | No | - | User ID who approved/rejected the request |
| approvedAt | Date | No | - | Approval/rejection timestamp |
| rejectionReason | string | No | - | Reason for rejection (set on reject action) |
| attachments | string[] | Yes | `[]` | Array of file IDs (JSON column in SQLite) |
| createdAt | Date | Yes | now | Record creation timestamp |
| updatedAt | Date | Yes | now | Record last-update timestamp |

## Relationships

- **Org** -- `orgId` references the tenant organization
- **Employee** -- `employeeId` references the requesting employee
- **LeaveType** -- `leaveTypeId` references the type of leave
- **LeaveBalance** -- creating/approving/rejecting/cancelling a request automatically updates the corresponding LeaveBalance
- **User** -- `approvedBy` references the approving/rejecting user

## API Endpoints (prefix: `/api/org/:orgId/hr/leave-request`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | isSignIn | List leave requests. Filters: `status`, `employeeId`. Pagination: `page`, `size`, `sortBy`, `sortOrder`. Returns `{ leaveRequests, total, page, size, totalPages }` |
| POST | `/` | isSignIn | Create leave request. Body: `employeeId`, `leaveTypeId`, `startDate`, `endDate`, `days` (required), `halfDay`, `reason` (optional). Auto-sets `status: 'pending'`. Updates LeaveBalance `pending` count. |
| GET | `/:id` | isSignIn | Get single leave request by ID |
| PUT | `/:id` | isSignIn | Update leave request. Only allowed when status is `pending`. |
| DELETE | `/:id` | isSignIn | Cancel leave request. Only allowed when status is `pending`. Sets status to `cancelled` and reverses the pending balance. |
| POST | `/:id/approve` | isSignIn | Approve a pending leave request. Role restricted: `admin` or `hr_manager`. Moves days from `pending` to `taken` in LeaveBalance, reduces `remaining`. |
| POST | `/:id/reject` | isSignIn | Reject a pending leave request. Role restricted: `admin` or `hr_manager`. Body: `reason` (optional). Reverses the pending balance. |
