import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IMaintenanceRequest extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  equipmentId: Types.ObjectId
  type: string
  priority: string
  state: string
  assigneeId?: Types.ObjectId
  scheduledDate: Date
  completedDate?: Date
  duration?: number
  description?: string
  notes?: string
  isRecurring: boolean
  recurringDays?: number
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const maintenanceRequestSchema = new Schema<IMaintenanceRequest>(
  {
    name: { type: String, required: true },
    equipmentId: { type: Schema.Types.ObjectId, ref: 'Equipment', required: true },
    type: {
      type: String,
      required: true,
      enum: ['preventive', 'corrective', 'predictive', 'condition_based'],
    },
    priority: {
      type: String,
      required: true,
      default: 'normal',
      enum: ['low', 'normal', 'high', 'urgent'],
    },
    state: {
      type: String,
      required: true,
      default: 'draft',
      enum: ['draft', 'confirmed', 'in_progress', 'done', 'cancelled'],
    },
    assigneeId: { type: Schema.Types.ObjectId, ref: 'Employee' },
    scheduledDate: { type: Date, required: true },
    completedDate: Date,
    duration: Number,
    description: String,
    notes: String,
    isRecurring: { type: Boolean, default: false },
    recurringDays: Number,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

maintenanceRequestSchema.plugin(tenantPlugin)
maintenanceRequestSchema.index({ orgId: 1, equipmentId: 1 })
maintenanceRequestSchema.index({ orgId: 1, state: 1 })
maintenanceRequestSchema.index({ orgId: 1, scheduledDate: 1 })

export const MaintenanceRequest = model<IMaintenanceRequest>('MaintenanceRequest', maintenanceRequestSchema)
