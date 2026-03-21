import { Schema, model, type Document, type Types } from 'mongoose'
import { tenantPlugin } from '../plugins/tenant.plugin.js'

export interface IECOChange {
  field: string
  oldValue: string
  newValue: string
}

export interface IECO extends Document {
  _id: Types.ObjectId
  orgId: Types.ObjectId
  name: string
  productId: Types.ObjectId
  bomId?: Types.ObjectId
  state: string                   // draft, in_review, approved, applied, rejected
  type: string                    // bom_change, routing_change, product_change
  description: string
  changes: IECOChange[]
  requesterId: Types.ObjectId
  reviewerId?: Types.ObjectId
  approvedDate?: Date
  appliedDate?: Date
  notes?: string
  createdBy: Types.ObjectId
  createdAt: Date
  updatedAt: Date
}

const ecoChangeSchema = new Schema({ field: { type: String, required: true }, oldValue: { type: String, default: '' }, newValue: { type: String, default: '' } }, { _id: false })

const ecoSchema = new Schema<IECO>(
  {
    name: { type: String, required: true },
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    bomId: { type: Schema.Types.ObjectId, ref: 'BillOfMaterials' },
    state: { type: String, default: 'draft', enum: ['draft', 'in_review', 'approved', 'applied', 'rejected'] },
    type: { type: String, required: true, enum: ['bom_change', 'routing_change', 'product_change'] },
    description: { type: String, default: '' },
    changes: [ecoChangeSchema],
    requesterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reviewerId: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedDate: Date,
    appliedDate: Date,
    notes: String,
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
)

ecoSchema.plugin(tenantPlugin)
ecoSchema.index({ orgId: 1, productId: 1 })
ecoSchema.index({ orgId: 1, state: 1 })
ecoSchema.index({ orgId: 1, bomId: 1 })
ecoSchema.index({ name: 'text', description: 'text' })

export const ECO = model<IECO>('ECO', ecoSchema)
