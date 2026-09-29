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
