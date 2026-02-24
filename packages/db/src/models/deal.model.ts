import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IDealProduct {
  productId: Types.ObjectId
  quantity: number
  unitPrice: number
  discount?: number
  total: number
}

export interface IDeal extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  contactId: Types.ObjectId
  stage: string
  pipelineId: Types.ObjectId
  value: number
  currency: string
  probability: number
  expectedCloseDate?: Date
  actualCloseDate?: Date
  status: string
  lostReason?: string
  assignedTo: Types.ObjectId
  products?: IDealProduct[]
  notes?: string
  tags?: string[]
  customFields?: Map<string, any>
  createdAt: Date
  updatedAt: Date
}

const dealProductSchema = new Schema<IDealProduct>(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    quantity: { type: Number, required: true },
    unitPrice: { type: Number, required: true },
    discount: Number,
    total: { type: Number, required: true },
  },
  { _id: false },
)

const dealSchema = new Schema<IDeal>(
  {
    name: { type: String, required: true },
    contactId: { type: Schema.Types.ObjectId, ref: 'Contact', required: true },
    stage: { type: String, required: true },
    pipelineId: { type: Schema.Types.ObjectId, ref: 'Pipeline', required: true },
    value: { type: Number, required: true },
    currency: { type: String, default: 'EUR' },
    probability: { type: Number, required: true },
    expectedCloseDate: Date,
    actualCloseDate: Date,
    status: {
      type: String,
      required: true,
      default: 'open',
      enum: ['open', 'won', 'lost'],
    },
    lostReason: String,
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    products: [dealProductSchema],
    notes: String,
    tags: [String],
    customFields: { type: Map, of: Schema.Types.Mixed },
  },
  { timestamps: true },
)

dealSchema.plugin(tenantPlugin)
dealSchema.index({ orgId: 1, pipelineId: 1, stage: 1 })
dealSchema.index({ orgId: 1, contactId: 1 })
dealSchema.index({ orgId: 1, assignedTo: 1 })
dealSchema.index({ orgId: 1, status: 1, expectedCloseDate: 1 })

export const Deal = model<IDeal>('Deal', dealSchema)
