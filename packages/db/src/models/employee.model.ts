import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

export interface IEmployeeSalary {
  baseSalary: number
  currency: string
  frequency: string
  hourlyRate?: number
}

export interface IEmployeeDeduction {
  type: string
  name: string
  amount?: number
  percentage?: number
  accountId?: Types.ObjectId
}

export interface IEmployeeBenefit {
  type: string
  name: string
  value: number
}

export interface IEmployee extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  userId?: Types.ObjectId
  employeeNumber: string
  firstName: string
  middleName?: string
  lastName: string
  email?: string
  phone?: string
  gender?: string
  /**
   * FR-25 §3.12: one sealed JSON holding everything sensitive about this person (`EMPLOYEE_PERSONAL_KEYS`
   * in `services/biz/personal-data/employee-personal.ts`). Opens only on this document.
   */
  personal?: string
  /** The last digits of the ЕГН, for lists. */
  nationalIdMask?: string
  /** Lookup by ЕГН, without opening anything. */
  nationalIdHmac?: string
  department: string
  position: string
  managerId?: Types.ObjectId
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
  documents: Types.ObjectId[]
  notes?: string
  tags?: string[]
  createdAt: Date
  updatedAt: Date
}

const employeeSchema = new Schema<IEmployee>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    employeeNumber: { type: String, required: true },
    firstName: { type: String, required: true },
    middleName: { type: String },
    lastName: { type: String, required: true },
    email: String,
    phone: String,
    gender: { type: String, enum: ['male', 'female', 'other'] },
    personal: String,
    nationalIdMask: String,
    nationalIdHmac: String,
    department: { type: String, required: true },
    position: { type: String, required: true },
    managerId: { type: Schema.Types.ObjectId, ref: 'Employee' },
    employmentType: {
      type: String,
      required: true,
      enum: ['full_time', 'part_time', 'contract', 'intern'],
    },
    contractStartDate: { type: Date, required: true },
    contractEndDate: Date,
    probationEndDate: Date,
    status: {
      type: String,
      required: true,
      default: 'active',
      enum: ['active', 'on_leave', 'terminated', 'suspended'],
    },
    terminationDate: Date,
    terminationReason: String,
    salary: {
      baseSalary: { type: Number, required: true },
      currency: { type: String, default: 'EUR' },
      frequency: {
        type: String,
        required: true,
        enum: ['monthly', 'biweekly', 'weekly', 'hourly'],
      },
      hourlyRate: Number,
    },
    deductions: [
      {
        type: { type: String, required: true },
        name: { type: String, required: true },
        amount: Number,
        percentage: Number,
        accountId: { type: Schema.Types.ObjectId, ref: 'Account' },
      },
    ],
    benefits: [
      {
        type: { type: String, required: true },
        name: { type: String, required: true },
        value: { type: Number, required: true },
      },
    ],
    documents: [{ type: Schema.Types.ObjectId, ref: 'File' }],
    notes: String,
    tags: [String],
  },
  { timestamps: true },
)

employeeSchema.plugin(tenantPlugin)
employeeSchema.index({ orgId: 1, employeeNumber: 1 }, { unique: true })
employeeSchema.index({ orgId: 1, department: 1 })
employeeSchema.index({ orgId: 1, status: 1 })
employeeSchema.index({ orgId: 1, managerId: 1 })
employeeSchema.index({ orgId: 1, tags: 1 })
employeeSchema.index({ orgId: 1, nationalIdHmac: 1 }, { sparse: true })
employeeSchema.index({ firstName: 'text', middleName: 'text', lastName: 'text', email: 'text' })

replicate(employeeSchema, { class: 'R' })

export const Employee = model<IEmployee>('Employee', employeeSchema)
