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
