import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface ISLATarget {
  firstResponseHours?: number
  resolutionHours?: number
}

export interface ISLAPolicy extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  teamId?: Types.ObjectId
  priority: string
  targets: ISLATarget
  escalateTo?: Types.ObjectId     // Manager user
  businessHoursOnly: boolean
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

const slaPolicySchema = new Schema<ISLAPolicy>(
  {
    name: { type: String, required: true },
    teamId: { type: Schema.Types.ObjectId, ref: 'HelpdeskTeam' },
    priority: {
      type: String,
      required: true,
      enum: ['low', 'normal', 'high', 'urgent'],
    },
    targets: {
      firstResponseHours: Number,
      resolutionHours: Number,
    },
    escalateTo: { type: Schema.Types.ObjectId, ref: 'User' },
    businessHoursOnly: { type: Boolean, default: true },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
)

slaPolicySchema.plugin(tenantPlugin)
slaPolicySchema.index({ orgId: 1, priority: 1, isActive: 1 })
slaPolicySchema.index({ orgId: 1, teamId: 1, isActive: 1 })

export const SLAPolicy = model<ISLAPolicy>('SLAPolicy', slaPolicySchema)
