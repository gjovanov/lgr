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

## SQLite Schema

```sql
CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs(id),
  user_id TEXT,
  employee_number TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  date_of_birth TEXT,
  gender TEXT CHECK(gender IN ('male','female','other')),
  national_id TEXT,
  tax_id TEXT,
  address TEXT,
  department TEXT NOT NULL,
  position TEXT NOT NULL,
  manager_id TEXT,
  employment_type TEXT NOT NULL CHECK(employment_type IN ('full_time','part_time','contract','intern')),
  contract_start_date TEXT NOT NULL,
  contract_end_date TEXT,
  probation_end_date TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','on_leave','terminated','suspended')),
  termination_date TEXT,
  termination_reason TEXT,
  salary TEXT NOT NULL DEFAULT '{}',
  documents TEXT DEFAULT '[]',
  emergency_contact TEXT,
  notes TEXT,
  tags TEXT DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, employee_number)
);
CREATE INDEX IF NOT EXISTS idx_employees_org_dept ON employees(org_id, department);
CREATE INDEX IF NOT EXISTS idx_employees_org_status ON employees(org_id, status);
CREATE INDEX IF NOT EXISTS idx_employees_org_manager ON employees(org_id, manager_id);

CREATE TABLE IF NOT EXISTS employee_deductions (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  amount REAL,
  percentage REAL,
  account_id TEXT,
  sort_order INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS employee_benefits (
  id TEXT PRIMARY KEY,
  employee_id TEXT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  value REAL NOT NULL,
  sort_order INTEGER DEFAULT 0
);
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
