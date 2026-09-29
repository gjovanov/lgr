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
