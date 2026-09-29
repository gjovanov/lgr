# Employee

## Entity Interface

```typescript
export interface IEmployeeAddress {
  street: string
  city: string
  state?: string
  postalCode: string
  country: string
}

export interface IEmployeeSalary {
  baseSalary: number
  currency: string
  frequency: string
  hourlyRate?: number
  bankAccountNumber?: string
  bankName?: string
  iban?: string
}

export interface IEmployeeDeduction {
  id?: string
  type: string
  name: string
  amount?: number
  percentage?: number
  accountId?: string
}

export interface IEmployeeBenefit {
  id?: string
  type: string
  name: string
  value: number
}

export interface IEmergencyContact {
  name: string
  relationship: string
  phone: string
}

export interface IEmployee extends TenantEntity {
  userId?: string
  employeeNumber: string
  firstName: string
  lastName: string
  email?: string
  phone?: string
  dateOfBirth?: Date
  gender?: string
  nationalId?: string
  taxId?: string
  address?: IEmployeeAddress
  department: string
  position: string
  managerId?: string
  employmentType: string
  contractStartDate: Date
  contractEndDate?: Date
  probationEndDate?: Date
  status: string
  terminationDate?: Date
  terminationReason?: string
  salary: IEmployeeSalary
  deductions: IEmployeeDeduction[]
  benefits: IEmployeeBenefit[]
  documents: string[]
  emergencyContact?: IEmergencyContact
  notes?: string
  tags?: string[]
}
```

## Field Reference

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| id | string | Yes | auto | Primary key |
| orgId | string | Yes | - | Tenant organization ID |
| userId | string | No | - | Linked user account ID |
| employeeNumber | string | Yes | - | Unique employee identifier within the org |
| firstName | string | Yes | - | First name |
| lastName | string | Yes | - | Last name |
| email | string | No | - | Email address (format: email) |
| phone | string | No | - | Phone number |
| dateOfBirth | Date | No | - | Date of birth |
| gender | string | No | - | Gender (`male`, `female`, `other`) |
| nationalId | string | No | - | National identification number |
| taxId | string | No | - | Tax identification number |
| address | IEmployeeAddress | No | - | Home address (JSON column in SQLite) |
| address.street | string | Yes | - | Street address |
| address.city | string | Yes | - | City |
| address.state | string | No | - | State/province |
| address.postalCode | string | Yes | - | Postal/ZIP code |
| address.country | string | Yes | - | Country |
| department | string | Yes | - | Department name |
| position | string | Yes | - | Job position/title |
| managerId | string | No | - | ID of the reporting manager (Employee) |
| employmentType | string | Yes | - | `full_time`, `part_time`, `contract`, `intern` |
| contractStartDate | Date | Yes | - | Employment contract start date |
| contractEndDate | Date | No | - | Employment contract end date |
| probationEndDate | Date | No | - | Probation period end date |
| status | string | Yes | `active` | `active`, `on_leave`, `terminated`, `suspended` |
| terminationDate | Date | No | - | Date of termination |
| terminationReason | string | No | - | Reason for termination |
| salary | IEmployeeSalary | Yes | `{}` | Salary details (JSON column in SQLite) |
| salary.baseSalary | number | Yes | - | Base salary amount |
| salary.currency | string | Yes | - | Currency code (e.g. EUR) |
| salary.frequency | string | Yes | - | Pay frequency (`monthly`, `biweekly`, `weekly`, `hourly`) |
| salary.hourlyRate | number | No | - | Hourly rate (if applicable) |
| salary.bankAccountNumber | string | No | - | Bank account number for payment |
| salary.bankName | string | No | - | Bank name |
| salary.iban | string | No | - | IBAN |
| deductions | IEmployeeDeduction[] | Yes | `[]` | Child table `employee_deductions` in SQLite |
| deductions[].id | string | No | auto | Deduction row ID |
| deductions[].type | string | Yes | - | Deduction type |
| deductions[].name | string | Yes | - | Deduction name |
| deductions[].amount | number | No | - | Fixed amount deduction |
| deductions[].percentage | number | No | - | Percentage-based deduction |
| deductions[].accountId | string | No | - | Linked accounting account ID |
| benefits | IEmployeeBenefit[] | Yes | `[]` | Child table `employee_benefits` in SQLite |
| benefits[].id | string | No | auto | Benefit row ID |
| benefits[].type | string | Yes | - | Benefit type |
| benefits[].name | string | Yes | - | Benefit name |
| benefits[].value | number | Yes | - | Benefit monetary value |
| documents | string[] | Yes | `[]` | Array of document/file IDs (JSON column in SQLite) |
| emergencyContact | IEmergencyContact | No | - | Emergency contact (JSON column in SQLite) |
| emergencyContact.name | string | Yes | - | Contact name |
| emergencyContact.relationship | string | Yes | - | Relationship to employee |
| emergencyContact.phone | string | Yes | - | Contact phone number |
| notes | string | No | - | Free-text notes |
| tags | string[] | No | `[]` | Arbitrary tags (JSON column in SQLite) |
| createdAt | Date | Yes | now | Record creation timestamp |
| updatedAt | Date | Yes | now | Record last-update timestamp |

## Relationships

- **Org** -- `orgId` references the tenant organization
- **User** -- `userId` optionally links to a User account
- **Employee (self)** -- `managerId` references the reporting manager
- **EmployeeDeduction (child)** -- embedded array; child table `employee_deductions` in SQLite (CASCADE delete)
- **EmployeeBenefit (child)** -- embedded array; child table `employee_benefits` in SQLite (CASCADE delete)

## API Endpoints (prefix: `/api/org/:orgId/payroll/employee`)

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/` | isSignIn | List employees. Filters: `status`, `department`, `tags`. Pagination: `page`, `size`, `sortBy`, `sortOrder`. Returns `{ employees, total, page, size, totalPages }` |
| POST | `/` | isSignIn | Create employee. Body validates `employeeNumber`, `firstName`, `lastName`, `department`, `position`, `employmentType`, `contractStartDate`, `salary` as required. Also upserts tags. |
| GET | `/:id` | isSignIn | Get single employee by ID |
| PUT | `/:id` | isSignIn | Update employee. Role restricted: `admin` or `hr_manager`. Only editable on existing record. |
| DELETE | `/:id` | isSignIn | Soft-delete: sets `status` to `terminated` and `terminationDate` to now. Role restricted: `admin` or `hr_manager`. |
