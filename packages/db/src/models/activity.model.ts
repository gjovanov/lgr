import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IActivity extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  type: string
  subject: string
  description?: string
  contactId?: Types.ObjectId
  dealId?: Types.ObjectId
  leadId?: Types.ObjectId
  assignedTo: Types.ObjectId
  dueDate?: Date
  completedAt?: Date
  status: string
  priority: string
  duration?: number
  outcome?: string
  createdAt: Date
  updatedAt: Date
}

const activitySchema = new Schema<IActivity>(
  {
    type: {
      type: String,
      required: true,
      enum: ['call', 'email', 'meeting', 'task', 'note', 'follow_up'],
    },
    subject: { type: String, required: true },
    description: String,
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    dealId: { type: Schema.Types.ObjectId, ref: 'Deal' },
    leadId: { type: Schema.Types.ObjectId, ref: 'Lead' },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    dueDate: Date,
    completedAt: Date,
    status: {
      type: String,
      required: true,
      default: 'pending',
      enum: ['pending', 'completed', 'cancelled'],
    },
    priority: {
      type: String,
      required: true,
      default: 'medium',
      enum: ['low', 'medium', 'high'],
    },
    duration: Number,
    outcome: String,
  },
  { timestamps: true },
)

activitySchema.plugin(tenantPlugin)
activitySchema.index({ orgId: 1, assignedTo: 1, status: 1, dueDate: 1 })
activitySchema.index({ orgId: 1, contactId: 1 })
activitySchema.index({ orgId: 1, dealId: 1 })

export const Activity = model<IActivity>('Activity', activitySchema)
