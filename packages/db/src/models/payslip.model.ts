import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IPayslipEarning {
  type: string
  description: string
  amount: number
  hours?: number
  rate?: number
}

export interface IPayslipDeduction {
  type: string
  description: string
  amount: number
}

export interface IPayslipYearToDate {
  grossPay: number
  totalDeductions: number
  netPay: number
}

export interface IPayslip extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  payrollRunId: Types.ObjectId
  employeeId: Types.ObjectId
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
  createdAt: Date
  updatedAt: Date
}

const payslipEarningSchema = new Schema<IPayslipEarning>(
  {
    type: { type: String, required: true },
    description: { type: String, required: true },
    amount: { type: Number, required: true },
    hours: Number,
    rate: Number,
  },
  { _id: false },
)

const payslipDeductionSchema = new Schema<IPayslipDeduction>(
  {
    type: { type: String, required: true },
    description: { type: String, required: true },
    amount: { type: Number, required: true },
  },
  { _id: false },
)

const payslipSchema = new Schema<IPayslip>(
  {
    payrollRunId: { type: Schema.Types.ObjectId, ref: 'PayrollRun', required: true },
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    period: {
      from: { type: Date, required: true },
      to: { type: Date, required: true },
    },
    earnings: [payslipEarningSchema],
    deductions: [payslipDeductionSchema],
    grossPay: { type: Number, required: true },
    totalDeductions: { type: Number, required: true, default: 0 },
    netPay: { type: Number, required: true },
    yearToDate: {
      grossPay: { type: Number, required: true, default: 0 },
      totalDeductions: { type: Number, required: true, default: 0 },
      netPay: { type: Number, required: true, default: 0 },
    },
    paymentMethod: {
      type: String,
      required: true,
      enum: ['bank_transfer', 'cash', 'check'],
    },
    paymentReference: String,
    status: {
      type: String,
      required: true,
      default: 'generated',
      enum: ['generated', 'sent', 'paid'],
    },
    sentAt: Date,
    paidAt: Date,
  },
  { timestamps: true },
)

payslipSchema.plugin(tenantPlugin)
payslipSchema.index({ orgId: 1, employeeId: 1, 'period.from': -1 })

export const Payslip = model<IPayslip>('Payslip', payslipSchema)
