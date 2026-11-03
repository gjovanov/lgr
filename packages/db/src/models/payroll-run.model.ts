import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

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
  /** FR-25: a Bulgarian run's sums, what its `ЗАП` carries. Never one person's. */
  insurableIncome?: number
  tax?: number
  contributions?: {
    doo: { employer: number; employee: number }
    tzpb: { employer: number; employee: number }
    dzpo: { employer: number; employee: number }
    zo: { employer: number; employee: number }
    gvrs: { employer: number; employee: number }
  }
}

/**
 * FR-25 §3.12: one person's line on a Bulgarian run. Everything about them is in `sealed`, which
 * opens only on this run, for this person and contract (`runItemPath`). Opened, it is a `BgRunItem`.
 */
export interface IPayrollRunSealedItem {
  employeeId: Types.ObjectId
  contractId?: Types.ObjectId
  sealed: string
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
  /** FR-25 §3.10. Unset on every run of an org without `settings.payroll.engine`. */
  engine?: 'bg'
  /** `YYYYMM`. */
  periodCode?: string
  kind?: 'advance' | 'salary'
  source?: 'engine' | 'imported'
  ledger?: 'shadow'
  /** The date the law's parameters were read on, `YYYY-MM-DD`. */
  parametersAsOf?: string
  sealedItems: IPayrollRunSealedItem[]
  /** The month's обр. 6 as filed, one sealed JSON: it names the person who files it. */
  filed?: string
  /** What the imported files were, by name and date, so that a re-import can say what it replaced. */
  fileVersion?: string
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

const payrollRunSealedItemSchema = new Schema<IPayrollRunSealedItem>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    contractId: { type: Schema.Types.ObjectId, ref: 'EmploymentContract' },
    sealed: { type: String, required: true },
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
      enum: ['draft', 'calculated', 'approved', 'paid', 'cancelled', 'imported', 'posted'],
    },
    currency: { type: String, default: 'EUR' },
    items: [payrollRunItemSchema],
    totals: {
      grossPay: { type: Number, required: true, default: 0 },
      totalDeductions: { type: Number, required: true, default: 0 },
      netPay: { type: Number, required: true, default: 0 },
      totalEmployerCost: { type: Number, required: true, default: 0 },
      employeeCount: { type: Number, required: true, default: 0 },
      insurableIncome: Number,
      tax: Number,
      contributions: {
        _id: false,
        doo: { _id: false, employer: Number, employee: Number },
        tzpb: { _id: false, employer: Number, employee: Number },
        dzpo: { _id: false, employer: Number, employee: Number },
        zo: { _id: false, employer: Number, employee: Number },
        gvrs: { _id: false, employer: Number, employee: Number },
      },
    },
    engine: { type: String, enum: ['bg'] },
    periodCode: { type: String, match: /^\d{6}$/ },
    kind: { type: String, enum: ['advance', 'salary'] },
    source: { type: String, enum: ['engine', 'imported'] },
    ledger: { type: String, enum: ['shadow'] },
    parametersAsOf: String,
    sealedItems: [payrollRunSealedItemSchema],
    filed: String,
    fileVersion: String,
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
// A filed month has one imported run: two would count its people twice. A correction is an engine run.
payrollRunSchema.index(
  { orgId: 1, periodCode: 1, kind: 1 },
  { unique: true, partialFilterExpression: { source: 'imported' } },
)

replicate(payrollRunSchema, { class: 'R' })

export const PayrollRun = model<IPayrollRun>('PayrollRun', payrollRunSchema)
