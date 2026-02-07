import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface ILeaveRequest extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  employeeId: Types.ObjectId
  leaveTypeId: Types.ObjectId
  startDate: Date
  endDate: Date
  days: number
  halfDay: boolean
  reason?: string
  status: string
  approvedBy?: Types.ObjectId
  approvedAt?: Date
  rejectionReason?: string
  attachments: Types.ObjectId[]
  createdAt: Date
  updatedAt: Date
}

const leaveRequestSchema = new Schema<ILeaveRequest>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    leaveTypeId: { type: Schema.Types.ObjectId, ref: 'LeaveType', required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    days: { type: Number, required: true },
    halfDay: { type: Boolean, default: false },
    reason: String,
    status: {
      type: String,
      required: true,
      default: 'pending',
      enum: ['pending', 'approved', 'rejected', 'cancelled'],
    },
    approvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedAt: Date,
    rejectionReason: String,
    attachments: [{ type: Schema.Types.ObjectId, ref: 'File' }],
  },
  { timestamps: true },
)

leaveRequestSchema.plugin(tenantPlugin)
leaveRequestSchema.index({ orgId: 1, employeeId: 1, status: 1 })
leaveRequestSchema.index({ orgId: 1, startDate: 1, endDate: 1 })

export const LeaveRequest = model<ILeaveRequest>('LeaveRequest', leaveRequestSchema)
