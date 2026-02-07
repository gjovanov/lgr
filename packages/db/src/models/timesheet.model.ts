import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface ITimesheet extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  employeeId: Types.ObjectId
  date: Date
  hoursWorked: number
  overtimeHours: number
  type: string
  projectId?: Types.ObjectId
  description?: string
  status: string
  approvedBy?: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const timesheetSchema = new Schema<ITimesheet>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    date: { type: Date, required: true },
    hoursWorked: { type: Number, required: true },
    overtimeHours: { type: Number, default: 0 },
    type: {
      type: String,
      required: true,
      enum: ['regular', 'overtime', 'holiday', 'sick', 'vacation'],
    },
    projectId: { type: Schema.Types.ObjectId, ref: 'ConstructionProject' },
    description: String,
    status: {
      type: String,
      required: true,
      default: 'submitted',
      enum: ['submitted', 'approved', 'rejected'],
    },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
)

timesheetSchema.plugin(tenantPlugin)
timesheetSchema.index({ orgId: 1, employeeId: 1, date: -1 })

export const Timesheet = model<ITimesheet>('Timesheet', timesheetSchema)
