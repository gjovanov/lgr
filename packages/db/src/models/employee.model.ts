import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

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

export interface IEmergencyContact {
  name: string
  relationship: string
  phone: string
}

export interface IEmployee extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  userId?: Types.ObjectId
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
  emergencyContact?: IEmergencyContact
  notes?: string
  createdAt: Date
  updatedAt: Date
}

const employeeSchema = new Schema<IEmployee>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    employeeNumber: { type: String, required: true },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    email: String,
    phone: String,
    dateOfBirth: Date,
    gender: { type: String, enum: ['male', 'female', 'other'] },
    nationalId: String,
    taxId: String,
    address: {
      type: new Schema(
        {
          street: { type: String, required: true },
          city: { type: String, required: true },
          state: String,
          postalCode: { type: String, required: true },
          country: { type: String, required: true },
        },
        { _id: false },
      ),
      required: false,
    },
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
      currency: { type: String, required: true },
      frequency: {
        type: String,
        required: true,
        enum: ['monthly', 'biweekly', 'weekly', 'hourly'],
      },
      hourlyRate: Number,
      bankAccountNumber: String,
      bankName: String,
      iban: String,
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
    emergencyContact: {
      name: String,
      relationship: String,
      phone: String,
    },
    notes: String,
  },
  { timestamps: true },
)

employeeSchema.plugin(tenantPlugin)
employeeSchema.index({ orgId: 1, employeeNumber: 1 }, { unique: true })
employeeSchema.index({ orgId: 1, department: 1 })
employeeSchema.index({ orgId: 1, status: 1 })
employeeSchema.index({ orgId: 1, managerId: 1 })

export const Employee = model<IEmployee>('Employee', employeeSchema)
