# PayrollRun

## Entity Interface

```typescript
export interface IPayrollRunDeduction {
  type: string
  name: string
  amount: number
}

export interface IPayrollRunEmployerContribution {
  type: string
  name: string
  amount: number
}

export interface IPayrollRunItem {
  id?: string
  employeeId: string
  baseSalary: number
  overtimeHours: number
  overtimePay: number
  bonuses: number
  allowances: number
  grossPay: number
  deductions: IPayrollRunDeduction[]
  totalDeductions: number
  netPay: number
  employerContributions: IPayrollRunEmployerContribution[]
  totalEmployerCost: number
}

export interface IPayrollRunTotals {
  grossPay: number
  totalDeductions: number
  netPay: number
  totalEmployerCost: number
  employeeCount: number
}

export interface IPayrollRun extends TenantEntity {
  name: string
  period: { from: Date; to: Date }
  status: string
  currency: string
  items: IPayrollRunItem[]
  totals: IPayrollRunTotals
  journalEntryId?: string
  approvedBy?: string
  approvedAt?: Date
  paidAt?: Date
  createdBy: string
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS payroll_runs (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  name TEXT NOT NULL,
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','calculated','approved','paid','cancelled')),
  currency TEXT NOT NULL DEFAULT 'EUR',
  totals TEXT NOT NULL DEFAULT '{}',
  journal_entry_id TEXT,
  approved_by TEXT,
  approved_at TEXT,
  paid_at TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pr_org_period ON payroll_runs(org_id, period_from DESC);
CREATE INDEX IF NOT EXISTS idx_pr_org_status ON payroll_runs(org_id, status);

CREATE TABLE IF NOT EXISTS payroll_run_items (
  id TEXT PRIMARY KEY,
  payroll_run_id TEXT NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id TEXT NOT NULL REFERENCES employees(id),
  base_salary REAL NOT NULL,
  overtime_hours REAL NOT NULL DEFAULT 0,
  overtime_pay REAL NOT NULL DEFAULT 0,
  bonuses REAL NOT NULL DEFAULT 0,
  allowances REAL NOT NULL DEFAULT 0,
  gross_pay REAL NOT NULL,
  deductions TEXT NOT NULL DEFAULT '[]',
  total_deductions REAL NOT NULL DEFAULT 0,
  net_pay REAL NOT NULL,
  employer_contributions TEXT NOT NULL DEFAULT '[]',
  total_employer_cost REAL NOT NULL DEFAULT 0,
  sort_order INTEGER DEFAULT 0
);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string | Yes | - | Tenant organization ID |
| name | string | Yes | - | Payroll run name/label |
| period | object | Yes | - | Pay period range (flattened to `period_from`/`period_to` in SQLite) |
| period.from | Date | Yes | - | Period start date |
| period.to | Date | Yes | - | Period end date |
| status | string | Yes | `draft` | `draft`, `calculated`, `approved`, `paid`, `cancelled` |
| currency | string | Yes | `EUR` | Currency code |
| items | IPayrollRunItem[] | Yes | `[]` | Child table `payroll_run_items` in SQLite |
| items[].id | string | No | auto | Item row ID |
| items[].employeeId | string | Yes | - | Reference to Employee |
| items[].baseSalary | number | Yes | - | Employee base salary for this run |
| items[].overtimeHours | number | Yes | 0 | Overtime hours worked |
| items[].overtimePay | number | Yes | 0 | Overtime pay amount |
| items[].bonuses | number | Yes | 0 | Bonus amount |
| items[].allowances | number | Yes | 0 | Allowances amount |
| items[].grossPay | number | Yes | - | Gross pay (base + overtime + bonuses + allowances) |
| items[].deductions | IPayrollRunDeduction[] | Yes | `[]` | Itemized deductions (JSON column in SQLite) |
| items[].totalDeductions | number | Yes | 0 | Sum of all deductions |
| items[].netPay | number | Yes | - | Net pay (grossPay - totalDeductions) |
| items[].employerContributions | IPayrollRunEmployerContribution[] | Yes | `[]` | Employer-side contributions (JSON column in SQLite) |
| items[].totalEmployerCost | number | Yes | 0 | Total cost to employer |
| totals | IPayrollRunTotals | Yes | `{}` | Aggregated totals (JSON column in SQLite) |
| totals.grossPay | number | Yes | - | Sum of all items gross pay |
| totals.totalDeductions | number | Yes | - | Sum of all items deductions |
| totals.netPay | number | Yes | - | Sum of all items net pay |
| totals.totalEmployerCost | number | Yes | - | Sum of all items employer cost |
| totals.employeeCount | number | Yes | - | Number of employees in this run |
| journalEntryId | string | No | - | Linked journal entry ID (cross-module: Accounting) |
| approvedBy | string | No | - | User ID who approved the run |
| approvedAt | Date | No | - | Approval timestamp |
| paidAt | Date | No | - | Payment timestamp |
| createdBy | string | Yes | - | User ID who created the run |
| createdAt | Date | Yes | now | Record creation timestamp |
| updatedAt | Date | Yes | now | Record last-update timestamp |

## Relationships

- **Org** -- `orgId` references the tenant organization
- **Employee** -- `items[].employeeId` references employees included in the run
- **JournalEntry** -- `journalEntryId` optionally links to an Accounting journal entry (cross-module)
- **User** -- `createdBy` and `approvedBy` reference user accounts
- **PayrollRunItem (child)** -- embedded array; child table `payroll_run_items` in SQLite (CASCADE delete)

## API Endpoints (prefix: `/api/org/:orgId/payroll/run`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | isSignIn | List payroll runs. Filter: `status`. Pagination: `page`, `size`, `sortBy`, `sortOrder`. Returns `{ payrollRuns, total, page, size, totalPages }` |
| POST | `/` | isSignIn | Create payroll run. Body: `name`, `period { from, to }`, `currency`. Auto-sets `status: 'draft'`, `createdBy`, and zeroed `totals`. |
| GET | `/:id` | isSignIn | Get single payroll run by ID |
| PUT | `/:id` | isSignIn | Update payroll run. Only allowed when status is `draft` or `calculated`. |
| DELETE | `/:id` | isSignIn | Delete payroll run. Role restricted: `admin` or `hr_manager`. Only allowed when status is `draft`. |
| POST | `/:id/calculate` | isSignIn | Calculate payroll for all active employees. Computes items with salary, deductions, and totals. Transitions status to `calculated`. |
| POST | `/:id/approve` | isSignIn | Approve a calculated payroll run. Role restricted: `admin` or `hr_manager`. Sets `approvedBy` and `approvedAt`. Transitions status to `approved`. |
