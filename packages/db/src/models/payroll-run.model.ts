import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

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
  employeeId: Types.ObjectId
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

export interface IPayrollRun extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  period: { from: Date; to: Date }
  status: string
  currency: string
  items: IPayrollRunItem[]
  totals: IPayrollRunTotals
  journalEntryId?: Types.ObjectId
  approvedBy?: Types.ObjectId
  approvedAt?: Date
  paidAt?: Date
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const payrollRunDeductionSchema = new Schema<IPayrollRunDeduction>(
  {
    type: { type: String, required: true },
    name: { type: String, required: true },
    amount: { type: Number, required: true },
  },
  { _id: false },
)

const payrollRunEmployerContributionSchema = new Schema<IPayrollRunEmployerContribution>(
  {
    type: { type: String, required: true },
    name: { type: String, required: true },
    amount: { type: Number, required: true },
  },
  { _id: false },
)

const payrollRunItemSchema = new Schema<IPayrollRunItem>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    baseSalary: { type: Number, required: true },
    overtimeHours: { type: Number, default: 0 },
    overtimePay: { type: Number, default: 0 },
    bonuses: { type: Number, default: 0 },
    allowances: { type: Number, default: 0 },
    grossPay: { type: Number, required: true },
    deductions: [payrollRunDeductionSchema],
    totalDeductions: { type: Number, required: true, default: 0 },
    netPay: { type: Number, required: true },
    employerContributions: [payrollRunEmployerContributionSchema],
    totalEmployerCost: { type: Number, required: true, default: 0 },
  },
  { _id: false },
)

const payrollRunSchema = new Schema<IPayrollRun>(
  {
    name: { type: String, required: true },
    period: {
      from: { type: Date, required: true },
      to: { type: Date, required: true },
    },
    status: {
      type: String,
      required: true,
      default: 'draft',
      enum: ['draft', 'calculated', 'approved', 'paid', 'cancelled'],
    },
    currency: { type: String, required: true },
    items: [payrollRunItemSchema],
    totals: {
      grossPay: { type: Number, required: true, default: 0 },
      totalDeductions: { type: Number, required: true, default: 0 },
      netPay: { type: Number, required: true, default: 0 },
      totalEmployerCost: { type: Number, required: true, default: 0 },
      employeeCount: { type: Number, required: true, default: 0 },
    },
    journalEntryId: { type: Schema.Types.ObjectId, ref: 'JournalEntry' },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    paidAt: Date,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

payrollRunSchema.plugin(tenantPlugin)
payrollRunSchema.index({ orgId: 1, 'period.from': -1 })
payrollRunSchema.index({ orgId: 1, status: 1 })

export const PayrollRun = model<IPayrollRun>('PayrollRun', payrollRunSchema)
