import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IShift extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  employeeId?: Types.ObjectId
  roleId?: Types.ObjectId
  projectId?: Types.ObjectId
  taskId?: Types.ObjectId
  dateStart: Date
  dateEnd: Date
  hours: number
  state: string
  isRecurring: boolean
  recurringTemplateId?: Types.ObjectId
  notes?: string
  color?: string
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const shiftSchema = new Schema<IShift>(
  {
    employeeId: { type: Schema.Types.ObjectId, ref: 'Employee' },
    roleId: { type: Schema.Types.ObjectId },
    projectId: { type: Schema.Types.ObjectId, ref: 'Project' },
    taskId: { type: Schema.Types.ObjectId, ref: 'ProjectTask' },
    dateStart: { type: Date, required: true },
    dateEnd: { type: Date, required: true },
    hours: { type: Number, required: true, min: 0 },
    state: {
      type: String,
      required: true,
      default: 'draft',
      enum: ['draft', 'published', 'confirmed', 'completed', 'cancelled'],
    },
    isRecurring: { type: Boolean, default: false },
    recurringTemplateId: { type: Schema.Types.ObjectId, ref: 'ShiftTemplate' },
    notes: String,
    color: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

shiftSchema.plugin(tenantPlugin)
shiftSchema.index({ orgId: 1, employeeId: 1, dateStart: 1 })
shiftSchema.index({ orgId: 1, state: 1, dateStart: 1 })
shiftSchema.index({ orgId: 1, projectId: 1, dateStart: 1 })
shiftSchema.index({ orgId: 1, dateStart: 1, dateEnd: 1 })

export const Shift = model<IShift>('Shift', shiftSchema)
