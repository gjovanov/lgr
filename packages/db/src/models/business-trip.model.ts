import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IBusinessTripExpense {
  date: Date
  category: string
  description: string
  amount: number
  currency: string
  receipt?: Types.ObjectId
}

export interface IBusinessTrip extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  employeeId: Types.ObjectId
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
  approvedBy?: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const businessTripExpenseSchema = new Schema<IBusinessTripExpense>(
  {
    date: { type: Date, required: true },
    category: {
      type: String,
      required: true,
      enum: ['transport', 'accommodation', 'meals', 'other'],
    },
    description: { type: String, required: true },
    amount: { type: Number, required: true },
    currency: { type: String, required: true },
    receipt: { type: Schema.Types.ObjectId, ref: 'File' },
  },
  { _id: false },
)

const businessTripSchema = new Schema<IBusinessTrip>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    destination: { type: String, required: true },
    purpose: { type: String, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    status: {
      type: String,
      required: true,
      default: 'requested',
      enum: ['requested', 'approved', 'completed', 'cancelled'],
    },
    expenses: [businessTripExpenseSchema],
    totalExpenses: { type: Number, required: true, default: 0 },
    perDiem: Number,
    advanceAmount: Number,
    settlementAmount: Number,
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
)

businessTripSchema.plugin(tenantPlugin)
businessTripSchema.index({ orgId: 1, employeeId: 1, startDate: -1 })

export const BusinessTrip = model<IBusinessTrip>('BusinessTrip', businessTripSchema)
