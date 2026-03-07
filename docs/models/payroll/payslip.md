# Payslip

## Entity Interface

```typescript
export interface IPayslipEarning {
  id?: string
  type: string
  description: string
  amount: number
  hours?: number
  rate?: number
}

export interface IPayslipDeduction {
  id?: string
  type: string
  description: string
  amount: number
}

export interface IPayslipYearToDate {
  grossPay: number
  totalDeductions: number
  netPay: number
}

export interface IPayslip extends TenantEntity {
  payrollRunId: string
  employeeId: string
  period: { from: Date; to: Date }
  earnings: IPayslipEarning[]
  deductions: IPayslipDeduction[]
  grossPay: number
  totalDeductions: number
  netPay: number
  yearToDate: IPayslipYearToDate
  paymentMethod: string
  paymentReference?: string
  status: string
  sentAt?: Date
  paidAt?: Date
}
```

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS payslips (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  payroll_run_id TEXT NOT NULL REFERENCES payroll_runs(id),
  employee_id TEXT NOT NULL REFERENCES employees(id),
  period_from TEXT NOT NULL,
  period_to TEXT NOT NULL,
  gross_pay REAL NOT NULL,
  total_deductions REAL NOT NULL DEFAULT 0,
  net_pay REAL NOT NULL,
  year_to_date TEXT NOT NULL DEFAULT '{}',
  payment_method TEXT NOT NULL CHECK(payment_method IN ('bank_transfer','cash','check')),
  payment_reference TEXT,
  status TEXT NOT NULL DEFAULT 'generated' CHECK(status IN ('generated','sent','paid')),
  sent_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_payslips_emp ON payslips(org_id, employee_id, period_from DESC);

CREATE TABLE IF NOT EXISTS payslip_earnings (
  id TEXT PRIMARY KEY,
  payslip_id TEXT NOT NULL REFERENCES payslips(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  hours REAL,
  rate REAL,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS payslip_deductions (
  id TEXT PRIMARY KEY,
  payslip_id TEXT NOT NULL REFERENCES payslips(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  sort_order INTEGER DEFAULT 0
);
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string | Yes | - | Tenant organization ID |
| payrollRunId | string | Yes | - | Reference to the parent PayrollRun |
| employeeId | string | Yes | - | Reference to the Employee |
| period | object | Yes | - | Pay period range (flattened to `period_from`/`period_to` in SQLite) |
| period.from | Date | Yes | - | Period start date |
| period.to | Date | Yes | - | Period end date |
| earnings | IPayslipEarning[] | Yes | `[]` | Child table `payslip_earnings` in SQLite |
| earnings[].id | string | No | auto | Earning row ID |
| earnings[].type | string | Yes | - | Earning type (e.g. base, overtime, bonus) |
| earnings[].description | string | Yes | - | Description of the earning |
| earnings[].amount | number | Yes | - | Earning amount |
| earnings[].hours | number | No | - | Hours worked (for hourly earnings) |
| earnings[].rate | number | No | - | Hourly/unit rate |
| deductions | IPayslipDeduction[] | Yes | `[]` | Child table `payslip_deductions` in SQLite |
| deductions[].id | string | No | auto | Deduction row ID |
| deductions[].type | string | Yes | - | Deduction type |
| deductions[].description | string | Yes | - | Description of the deduction |
| deductions[].amount | number | Yes | - | Deduction amount |
| grossPay | number | Yes | - | Total gross pay |
| totalDeductions | number | Yes | 0 | Total deductions |
| netPay | number | Yes | - | Net pay (grossPay - totalDeductions) |
| yearToDate | IPayslipYearToDate | Yes | `{}` | Year-to-date accumulations (JSON column in SQLite) |
| yearToDate.grossPay | number | Yes | - | YTD gross pay |
| yearToDate.totalDeductions | number | Yes | - | YTD total deductions |
| yearToDate.netPay | number | Yes | - | YTD net pay |
| paymentMethod | string | Yes | - | `bank_transfer`, `cash`, `check` |
| paymentReference | string | No | - | Payment reference/transaction ID |
| status | string | Yes | `generated` | `generated`, `sent`, `paid` |
| sentAt | Date | No | - | Timestamp when payslip was sent to employee |
| paidAt | Date | No | - | Timestamp when payment was made |
| createdAt | Date | Yes | now | Record creation timestamp |
| updatedAt | Date | Yes | now | Record last-update timestamp |

## Relationships

- **Org** -- `orgId` references the tenant organization
- **PayrollRun** -- `payrollRunId` references the parent payroll run
- **Employee** -- `employeeId` references the employee
- **PayslipEarning (child)** -- embedded array; child table `payslip_earnings` in SQLite (CASCADE delete)
- **PayslipDeduction (child)** -- embedded array; child table `payslip_deductions` in SQLite (CASCADE delete)

## API Endpoints (prefix: `/api/org/:orgId/payroll/payslip`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | isSignIn | List payslips. Pagination: `page`, `size`, `sortBy`, `sortOrder`. Returns `{ payslips, total, page, size, totalPages }` |
| POST | `/` | isSignIn | Create payslip |
| GET | `/:id` | isSignIn | Get single payslip by ID |
| PUT | `/:id` | isSignIn | Update payslip |
| DELETE | `/:id` | isSignIn | Delete payslip |
