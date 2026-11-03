import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'
import { replicate } from '../replication/declare.js'

/** FR-25 §3.10: one person's paid leave for one year. About one person, so `payroll.personal` to read. */
export interface ILeaveBalance extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  employeeId: Types.ObjectId
  year: number
  entitled: number
  carried: number
  taken: number
  createdAt: Date
  updatedAt: Date
}

const leaveBalanceSchema = new Schema<ILeaveBalance>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee', required: true },
    year: { type: Number, required: true },
    entitled: { type: Number, required: true, default: 0 },
    carried: { type: Number, required: true, default: 0 },
    taken: { type: Number, required: true, default: 0 },
  },
  { timestamps: true },
)

leaveBalanceSchema.plugin(tenantPlugin)
leaveBalanceSchema.index({ orgId: 1, employeeId: 1, year: 1 }, { unique: true })

replicate(leaveBalanceSchema, { class: 'R' })

export const LeaveBalance = model<ILeaveBalance>('LeaveBalance', leaveBalanceSchema)
