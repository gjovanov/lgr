# BusinessTrip

## Entity Interface

```typescript
export interface IBusinessTripExpense {
  id?: string
  date: Date
  category: string
  description: string
  amount: number
  currency: string
  receipt?: string
}

export interface IBusinessTrip extends TenantEntity {
  employeeId: string
  destination: string
  purpose: string
  startDate: Date
  endDate: Date
  status: string
  expenses: IBusinessTripExpense[]
  totalExpenses: number
  perDiem?: number
  advanceAmount?: number
  settlementAmount?: number
  approvedBy?: string
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS business_trips (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  destination TEXT NOT NULL,
  purpose TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','approved','completed','cancelled')),
  total_expenses REAL NOT NULL DEFAULT 0,
  per_diem REAL,
  advance_amount REAL,
  settlement_amount REAL,
  approved_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_bt_emp ON business_trips(org_id, employee_id, start_date DESC);

CREATE TABLE IF NOT EXISTS business_trip_expenses (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES business_trips(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('transport','accommodation','meals','other')),
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'EUR',
  receipt TEXT,
  sort_order INTEGER DEFAULT 0
);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string | Yes | - | Tenant organization ID |
| employeeId | string | Yes | - | Reference to the Employee |
| destination | string | Yes | - | Trip destination |
| purpose | string | Yes | - | Purpose/reason for the trip |
| startDate | Date | Yes | - | Trip start date |
| endDate | Date | Yes | - | Trip end date |
| status | string | Yes | `requested` | `requested`, `approved`, `completed`, `cancelled` |
| expenses | IBusinessTripExpense[] | Yes | `[]` | Child table `business_trip_expenses` in SQLite |
| expenses[].id | string | No | auto | Expense row ID |
| expenses[].date | Date | Yes | - | Date of the expense |
| expenses[].category | string | Yes | - | `transport`, `accommodation`, `meals`, `other` |
| expenses[].description | string | Yes | - | Description of the expense |
| expenses[].amount | number | Yes | - | Expense amount |
| expenses[].currency | string | Yes | `EUR` | Currency code |
| expenses[].receipt | string | No | - | File ID of the receipt |
| totalExpenses | number | Yes | 0 | Sum of all expense amounts |
| perDiem | number | No | - | Per diem allowance |
| advanceAmount | number | No | - | Cash advance given to the employee |
| settlementAmount | number | No | - | Final settlement amount (totalExpenses + perDiem - advanceAmount) |
| approvedBy | string | No | - | User ID who approved the trip |
| createdAt | Date | Yes | now | Record creation timestamp |
| updatedAt | Date | Yes | now | Record last-update timestamp |

## Relationships

- **Org** -- `orgId` references the tenant organization
- **Employee** -- `employeeId` references the traveling employee
- **BusinessTripExpense (child)** -- embedded array; child table `business_trip_expenses` in SQLite (CASCADE delete)
- **User** -- `approvedBy` references the approving user

## API Endpoints (prefix: `/api/org/:orgId/hr/business-trip`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | isSignIn | List business trips. Pagination: `page`, `size`, `sortBy`, `sortOrder`. Returns `{ businessTrips, total, page, size, totalPages }` |
| POST | `/` | isSignIn | Create business trip |
| GET | `/:id` | isSignIn | Get single business trip by ID |
| PUT | `/:id` | isSignIn | Update business trip |
| DELETE | `/:id` | isSignIn | Delete business trip |
