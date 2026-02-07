import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface ILeaveType extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  code: string
  defaultDays: number
  isPaid: boolean
  requiresApproval: boolean
  color: string
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

const leaveTypeSchema = new Schema<ILeaveType>(
  {
    name: { type: String, required: true },
    code: { type: String, required: true },
    defaultDays: { type: Number, required: true },
    isPaid: { type: Boolean, required: true },
    requiresApproval: { type: Boolean, default: true },
    color: { type: String, required: true },
    isActive: { type: Boolean, required: true },
  },
  { timestamps: true },
)

leaveTypeSchema.plugin(tenantPlugin)
leaveTypeSchema.index({ orgId: 1, code: 1 }, { unique: true })

export const LeaveType = model<ILeaveType>('LeaveType', leaveTypeSchema)
