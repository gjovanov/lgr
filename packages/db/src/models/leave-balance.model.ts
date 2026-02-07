import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface ILeaveBalance extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  employeeId: Types.ObjectId
  leaveTypeId: Types.ObjectId
  year: number
  entitled: number
  taken: number
  pending: number
  remaining: number
  carriedOver: number
  createdAt: Date
  updatedAt: Date
}

const leaveBalanceSchema = new Schema<ILeaveBalance>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    leaveTypeId: { type: Schema.Types.ObjectId, ref: 'LeaveType', required: true },
    year: { type: Number, required: true },
    entitled: { type: Number, required: true },
    taken: { type: Number, required: true, default: 0 },
    pending: { type: Number, required: true, default: 0 },
    remaining: { type: Number, required: true },
    carriedOver: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
)

leaveBalanceSchema.plugin(tenantPlugin)
leaveBalanceSchema.index({ orgId: 1, employeeId: 1, leaveTypeId: 1, year: 1 }, { unique: true })

export const LeaveBalance = model<ILeaveBalance>('LeaveBalance', leaveBalanceSchema)
