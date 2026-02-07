import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface ILead extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  source: string
  status: string
  companyName?: string
  contactName: string
  email?: string
  phone?: string
  website?: string
  industry?: string
  estimatedValue?: number
  currency?: string
  notes?: string
  assignedTo?: Types.ObjectId
  convertedToContactId?: Types.ObjectId
  convertedToDealId?: Types.ObjectId
  convertedAt?: Date
  tags?: string[]
  customFields?: Map<string, any>
  createdAt: Date
  updatedAt: Date
}

const leadSchema = new Schema<ILead>(
  {
    source: {
      type: String,
      required: true,
      enum: ['website', 'referral', 'cold_call', 'email', 'social', 'event', 'other'],
    },
    status: {
      type: String,
      required: true,
      default: 'new',
      enum: ['new', 'contacted', 'qualified', 'unqualified', 'converted'],
    },
    companyName: String,
    contactName: { type: String, required: true },
    email: String,
    phone: String,
    website: String,
    industry: String,
    estimatedValue: Number,
    currency: String,
    notes: String,
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    convertedToContactId: { type: Schema.Types.ObjectId, ref: 'Contact' },
    convertedToDealId: { type: Schema.Types.ObjectId, ref: 'Deal' },
    convertedAt: Date,
    tags: [String],
    customFields: { type: Map, of: Schema.Types.Mixed },
  },
  { timestamps: true },
)

leadSchema.plugin(tenantPlugin)
leadSchema.index({ orgId: 1, status: 1 })
leadSchema.index({ orgId: 1, assignedTo: 1 })
leadSchema.index({ orgId: 1, source: 1 })

export const Lead = model<ILead>('Lead', leadSchema)
