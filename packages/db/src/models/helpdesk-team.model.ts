import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IHelpdeskTeam extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  memberIds: Types.ObjectId[]
  leaderId: Types.ObjectId
  assignmentMethod: string        // manual, round_robin, least_busy
  emailAlias?: string
  description?: string
  isActive: boolean
  createdAt: Date
  updatedAt: Date
}

const helpdeskTeamSchema = new Schema<IHelpdeskTeam>(
  {
    name: { type: String, required: true },
    memberIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    leaderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    assignmentMethod: {
      type: String,
      default: 'manual',
      enum: ['manual', 'round_robin', 'least_busy'],
    },
    emailAlias: String,
    description: String,
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true },
)

helpdeskTeamSchema.plugin(tenantPlugin)
helpdeskTeamSchema.index({ orgId: 1, name: 1 }, { unique: true })
helpdeskTeamSchema.index({ orgId: 1, isActive: 1 })

export const HelpdeskTeam = model<IHelpdeskTeam>('HelpdeskTeam', helpdeskTeamSchema)
