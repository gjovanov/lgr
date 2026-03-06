import type { TenantEntity } from '../types.js'

// ── Department ──

export interface IDepartment extends TenantEntity {
  name: string
  code: string
  parentId?: string
  headId?: string
  description?: string
  isActive: boolean
}

// ── LeaveType ──

export interface ILeaveType extends TenantEntity {
  name: string
  code: string
  defaultDays: number
  isPaid: boolean
  requiresApproval: boolean
  color: string
  isActive: boolean
}

// ── LeaveRequest ──

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

// ── LeaveBalance ──

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

// ── BusinessTrip ──

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

// ── EmployeeDocument ──

export interface IEmployeeDocument extends TenantEntity {
  employeeId: string
  type: string
  title: string
  description?: string
  fileId: string
  validFrom?: Date
  validTo?: Date
  isConfidential: boolean
  createdBy: string
}
