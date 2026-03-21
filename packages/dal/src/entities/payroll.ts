import type { TenantEntity } from '../types.js'

// ── Employee ──

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
  middleName?: string
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

// ── PayrollRun ──

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

// ── Payslip ──

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

// ── Timesheet ──

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
